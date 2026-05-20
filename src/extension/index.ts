/**
 * webui extension
 *
 * provides a /webui command to control the pi-webui server.
 *
 * usage:
 * /webui            - show interactive picker
 * /webui start      - launch the server
 * /webui status     - check if the server is running
 * /webui stop       - stop the server
 * /webui open       - open the webui in the default browser
 */

import { spawn, exec, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const PID_FILE = join(homedir(), ".pi", "extensions", "webui.pid");
const WEBUI_URL = "http://127.0.0.1:4096";

// Tracks a server spawned by --webui in this pi process so we can terminate
// it on session_shutdown. /webui start spawns detached and is NOT tracked
// here — those servers intentionally outlive pi.
let ownedChild: ChildProcess | null = null;

const SUBCOMMANDS: Array<{ name: string; label: string }> = [
	{ name: "start", label:  "start  - launch the server" },
	{ name: "status", label: "status - check server status" },
	{ name: "stop", label:   "stop   - stop the server" },
	{ name: "open", label:   "open   - open webui in browser" },
];

function getPid(): number | null {
	try {
		if (existsSync(PID_FILE)) {
			return parseInt(readFileSync(PID_FILE, "utf8").trim(), 10) || null;
		}
	} catch {
		/* ignore */
	}
	return null;
}

function setPid(pid: number) {
	try {
		const dir = dirname(PID_FILE);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(PID_FILE, pid.toString());
	} catch (error) {
		console.error(`failed to write pid file: ${error}`);
	}
}

function clearPid() {
	try {
		if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
	} catch {
		/* ignore */
	}
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function openUrl(url: string) {
	const platform = process.platform;
	let command = "";
	if (platform === "darwin") command = `open "${url}"`;
	else if (platform === "win32") command = `start "" "${url}"`;
	else command = `xdg-open "${url}"`;

	exec(command);
}

interface StartOptions {
	listen?: string;
	model?: string;
	// 路徑用 ':' 或 ',' 分隔多個;會在這邊展開成多個 --skill 參數
	skills?: string;
	skillAllow?: string;
	skillAllowFile?: string;
	hideModel?: boolean;
	// When true, the spawned server is tied to this pi process (terminated on
	// session_shutdown). When false, the server is detached and survives pi exit.
	owned?: boolean;
}

function runStart(ctx: ExtensionCommandContext, opts: StartOptions = {}) {
	const pid = getPid();
	if (pid && isRunning(pid)) {
		ctx.ui.notify(`pi-webui is already running (pid: ${pid})`, "info");
		return;
	}
	try {
		const __dirname = dirname(fileURLToPath(import.meta.url));
		const serverPath = join(__dirname, "..", "server", "index.js");
		const serverArgs = [serverPath];
		if (opts.listen) serverArgs.push("--listen", opts.listen);
		if (opts.model) serverArgs.push("--model", opts.model);
		if (opts.skills) {
			for (const p of opts.skills.split(/[:,]/).map((s) => s.trim()).filter(Boolean)) {
				serverArgs.push("--skill", p);
			}
		}
		if (opts.skillAllow) serverArgs.push("--skill-allow", opts.skillAllow);
		if (opts.skillAllowFile) serverArgs.push("--skill-allow-file", opts.skillAllowFile);
		if (opts.hideModel) serverArgs.push("--hide-model");
		const detached = !opts.owned;
		// 收集 child stderr，避免 spawn 後因 MODULE_NOT_FOUND 等錯誤被吞掉
		const child = spawn("node", serverArgs, {
			detached,
			stdio: ["ignore", "ignore", "pipe"],
		});
		const newPid = child.pid!;
		setPid(newPid);
		let stderrBuf = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBuf += chunk.toString();
			if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
		});
		// 若 child 在啟動初期就退出（例如路徑錯誤），清掉 pidfile 並把 stderr 回報出來
		child.once("exit", (code, signal) => {
			if (ownedChild === child) ownedChild = null;
			const pidStillOurs = getPid() === newPid;
			if (pidStillOurs) clearPid();
			if (code && code !== 0) {
				const tail = stderrBuf.trim().split("\n").slice(-3).join(" | ");
				ctx.ui.notify(
					`pi-webui server exited (code=${code}${signal ? `, signal=${signal}` : ""})${tail ? `: ${tail}` : ""}`,
					"error",
				);
			}
		});
		if (detached) {
			child.unref();
			// stderr 內部是 Socket，型別上是 Readable 沒有 unref；用結構性 cast 跳過編譯期檢查
			(child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
		} else {
			ownedChild = child;
		}
		ctx.ui.notify(`launching pi-webui server at ${WEBUI_URL}`, "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`failed to launch pi-webui: ${message}`, "error");
	}
}

function runStatus(ctx: ExtensionCommandContext) {
	const pid = getPid();
	if (pid && isRunning(pid)) {
		ctx.ui.notify(`pi-webui is running (pid: ${pid})`, "info");
	} else {
		ctx.ui.notify("pi-webui is not running", "info");
	}
}

function runStop(ctx: ExtensionCommandContext) {
	const pid = getPid();
	if (!pid || !isRunning(pid)) {
		ctx.ui.notify("pi-webui is not running", "info");
		return;
	}
	try {
		process.kill(pid, "SIGTERM");
		clearPid();
		ctx.ui.notify(`stopped pi-webui (pid: ${pid})`, "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`failed to stop pi-webui: ${message}`, "error");
	}
}

function runOpen(ctx: ExtensionCommandContext) {
	const pid = getPid();
	if (!pid || !isRunning(pid)) {
		ctx.ui.notify("pi-webui is not running. run /webui start first.", "error");
		return;
	}
	openUrl(WEBUI_URL);
	ctx.ui.notify(`opening ${WEBUI_URL} in browser`, "info");
}

// 簡易 shell-like tokenizer:支援單/雙引號與反斜線 escape,空白以外的 token 分割。
function tokenize(s: string): string[] {
	const out: string[] = [];
	const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) {
		if (m[1] !== undefined) out.push(m[1].replace(/\\(.)/g, "$1"));
		else if (m[2] !== undefined) out.push(m[2].replace(/\\(.)/g, "$1"));
		else if (m[3] !== undefined) out.push(m[3]);
	}
	return out;
}

// 解析 `/webui start ...` 後續 tokens 成 StartOptions。
function parseStartFlags(tokens: string[]): StartOptions {
	const opts: StartOptions = {};
	const skills: string[] = [];
	const valueOf = (i: number, name: string): string => {
		const v = tokens[i];
		if (v === undefined) throw new Error(`${name} requires a value`);
		return v;
	};
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--listen") opts.listen = valueOf(++i, t);
		else if (t.startsWith("--listen=")) opts.listen = t.slice("--listen=".length);
		else if (t === "--model") opts.model = valueOf(++i, t);
		else if (t.startsWith("--model=")) opts.model = t.slice("--model=".length);
		else if (t === "--skill") skills.push(valueOf(++i, t));
		else if (t.startsWith("--skill=")) skills.push(t.slice("--skill=".length));
		else if (t === "--skill-allow") opts.skillAllow = valueOf(++i, t);
		else if (t.startsWith("--skill-allow=")) opts.skillAllow = t.slice("--skill-allow=".length);
		else if (t === "--skill-allow-file") opts.skillAllowFile = valueOf(++i, t);
		else if (t.startsWith("--skill-allow-file=")) opts.skillAllowFile = t.slice("--skill-allow-file=".length);
		else if (t === "--hide-model") opts.hideModel = true;
		else throw new Error(`unknown flag: ${t}`);
	}
	if (skills.length > 0) opts.skills = skills.join(":");
	return opts;
}

function dispatch(name: string, ctx: ExtensionCommandContext, opts?: StartOptions): boolean {
	switch (name) {
		case "start": runStart(ctx, opts); return true;
		case "status": runStatus(ctx); return true;
		case "stop": runStop(ctx); return true;
		case "open": runOpen(ctx); return true;
		default: return false;
	}
}

async function pickAndRun(ctx: ExtensionCommandContext) {
	const labels = SUBCOMMANDS.map((s) => s.label);
	const selected = await ctx.ui.select("pi-webui", labels);
	if (!selected) return;
	const sub = SUBCOMMANDS.find((s) => s.label === selected);
	if (sub) dispatch(sub.name, ctx);
}

export default function webuiExtension(pi: ExtensionAPI) {
	pi.registerFlag?.("webui", {
		description: "Start the pi-webui server on launch.",
		type: "boolean",
		default: false,
	});

	pi.registerFlag?.("webui-listen", {
		description: "pi-webui http bind address (host:port, :port, or port). Implies --webui.",
		type: "string",
		default: "",
	});

	pi.registerFlag?.("webui-model", {
		description: "default model for pi-webui sessions (provider/id, or bare id). Implies --webui.",
		type: "string",
		default: "",
	});

	pi.registerFlag?.("webui-skill", {
		description: "extra skill paths for pi-webui (':' or ',' separated). Implies --webui.",
		type: "string",
		default: "",
	});

	pi.registerFlag?.("webui-skill-allow", {
		description: "skill whitelist for pi-webui (comma-separated names). Implies --webui.",
		type: "string",
		default: "",
	});

	pi.registerFlag?.("webui-skill-allow-file", {
		description: "skill whitelist file path for pi-webui. Implies --webui.",
		type: "string",
		default: "",
	});

	pi.registerFlag?.("webui-hide-model", {
		description: "hide the model name in the pi-webui status bar. Implies --webui.",
		type: "boolean",
		default: false,
	});

	pi.on("session_shutdown", () => {
		const child = ownedChild;
		if (!child) return;
		ownedChild = null;
		try {
			child.kill("SIGTERM");
		} catch {
			/* ignore */
		}
		clearPid();
	});

	pi.registerCommand("webui", {
		description: "control the pi-webui server",
		handler: async (args, ctx) => {
			const raw = (args || "").trim();

			if (!raw || raw.toLowerCase() === "help") {
				await pickAndRun(ctx);
				return;
			}

			const tokens = tokenize(raw);
			const sub = (tokens.shift() || "").toLowerCase();

			if (sub === "start") {
				let opts: StartOptions;
				try {
					opts = parseStartFlags(tokens);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					ctx.ui.notify(`/webui start: ${msg}`, "error");
					return;
				}
				dispatch("start", ctx, opts);
				return;
			}

			if (tokens.length > 0) {
				ctx.ui.notify(`/webui ${sub}: extra arguments not allowed`, "error");
				return;
			}

			if (!dispatch(sub, ctx)) {
				ctx.ui.notify(`unknown subcommand: ${sub}`, "error");
				await pickAndRun(ctx);
			}
		},
	});

	// Defer one tick so pi has finished parsing argv before we read the flag.
	// the ctx may have been swapped out by then (e.g. when this extension is
	// loaded inside a pi-webui-spawned session that immediately switches to
	// another session) — swallow the resulting stale-ctx error since the
	// --webui flag is only meaningful for a top-level `pi --webui` invocation.
	setImmediate(() => {
		let listen: string;
		let model: string;
		let skills: string;
		let skillAllow: string;
		let skillAllowFile: string;
		let hideModel: boolean;
		let want: boolean;
		try {
			listen = String(pi.getFlag?.("webui-listen") || "").trim();
			model = String(pi.getFlag?.("webui-model") || "").trim();
			skills = String(pi.getFlag?.("webui-skill") || "").trim();
			skillAllow = String(pi.getFlag?.("webui-skill-allow") || "").trim();
			skillAllowFile = String(pi.getFlag?.("webui-skill-allow-file") || "").trim();
			hideModel = !!pi.getFlag?.("webui-hide-model");
			want =
				!!pi.getFlag?.("webui") ||
				listen.length > 0 ||
				model.length > 0 ||
				skills.length > 0 ||
				skillAllow.length > 0 ||
				skillAllowFile.length > 0 ||
				hideModel;
		} catch {
			return;
		}
		if (!want) return;
		const stubCtx = {
			ui: {
				notify: (msg: string, level?: string) =>
					process.stderr.write(`[pi-webui] ${level ?? "info"}: ${msg}\n`),
			},
		} as unknown as ExtensionCommandContext;
		runStart(stubCtx, {
			listen: listen || undefined,
			model: model || undefined,
			skills: skills || undefined,
			skillAllow: skillAllow || undefined,
			skillAllowFile: skillAllowFile || undefined,
			hideModel: hideModel || undefined,
			owned: true,
		});
	});
}
