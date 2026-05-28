#!/usr/bin/env node
// @ts-nocheck
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { createReadStream, chmodSync, existsSync, readdirSync, readFileSync, statSync, watch as fsWatch, writeFileSync } from "node:fs";
import { extname, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
// 這幾個 factory 沒在 index 包裝;走 dist 直接拿。
const piToolsIndexUrl = pathToFileURL(
  resolve(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")), "..", "core/tools/index.js"),
).href;
const {
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  createBashToolDefinition,
} = await import(piToolsIndexUrl);

// The package's `exports` field doesn't expose the slash-commands list.
// Resolve the package's `import` entry via import.meta.resolve and load the
// sibling file by URL — dynamic file-URL imports bypass exports validation.
const piIndexUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const piDistDir = dirname(fileURLToPath(piIndexUrl));
const { BUILTIN_SLASH_COMMANDS } = await import(
  pathToFileURL(resolve(piDistDir, "core/slash-commands.js")).href
);

let piChangelog = "";
try {
  piChangelog = readFileSync(resolve(piDistDir, "..", "CHANGELOG.md"), "utf8");
} catch {
  /* changelog not available */
}

import {
  SELF_WRITE_WINDOW_MS,
  EXTERNAL_REFRESH_DEBOUNCE_MS,
  isSelfEcho,
  canRefreshNow,
} from "./watch.js";
import { createEventLog } from "./event-log.js";
import { log as logger } from "./log.js";
import { createExtUiBridge } from "./ext-ui.js";
import {
  computeCommandAllow,
  resolveCommandAllowFile,
} from "./command-allow.js";
import { listenWithFallback } from "./listen.js";
import {
  COOKIE_NAME,
  buildClearCookie,
  buildSetCookie,
  comparePassword,
  createAuthStore,
  readAuthCookie,
  shouldSetSecure,
} from "./auth.js";
import { Sandbox, GUEST_WORKSPACE } from "./sandbox.js";
import { TunnelManager } from "./tunnel.js";
import type { TunnelState } from "./tunnel.js";
import {
  filterEvent,
  filterMessageHistory,
  parseUiProfile,
  safeError,
} from "./ui-profile.js";
import type { UiProfile } from "./ui-profile.js";
import { loadProfile } from "./profile-loader.js";
import type { ProfileFile } from "./profile-loader.js";
import { loadBrandCss } from "./brand-overlay.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4096;

// limits for client-supplied image attachments on prompt messages
const MAX_PROMPT_IMAGES = 8;
const MAX_PROMPT_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/i;

// validate/normalize an array of {data, mimeType} from the client into the
// ImageContent shape expected by session.prompt(). drops anything malformed
// rather than failing the whole prompt — paste UX should be lenient.
function sanitizePromptImages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (out.length >= MAX_PROMPT_IMAGES) break;
    if (!item || typeof item !== "object") continue;
    const mimeType = String(item.mimeType || "");
    const data = String(item.data || "");
    if (!ALLOWED_IMAGE_MIME.test(mimeType)) continue;
    if (!data || data.length > Math.ceil(MAX_PROMPT_IMAGE_BYTES * 4 / 3)) continue;
    out.push({ type: "image", data, mimeType });
  }
  return out;
}

// parses "host:port", ":port", or "port"; ipv6 hosts must be bracketed: "[::1]:4096"
function parseListen(spec) {
  const s = String(spec).trim();
  if (!s) throw new Error("--listen requires host:port");
  const m = s.startsWith("[")
    ? s.match(/^\[([^\]]+)\]:(\d+)$/)
    : s.match(/^([^:]*):(\d+)$/);
  if (m) return { host: m[1] || DEFAULT_HOST, port: Number(m[2]) };
  if (/^\d+$/.test(s)) return { host: DEFAULT_HOST, port: Number(s) };
  throw new Error(`invalid --listen value: ${spec}`);
}

function printHelp() {
  const lines = [
    "usage: pi-webui [options]",
    "",
    "a native web app for pi, backed by the pi sdk runtime and your",
    "existing persisted pi sessions.",
    "",
    "options:",
    "  --listen <host:port>        http bind address; takes precedence over PI_WEBUI_HOST/PI_WEBUI_PORT.",
    "                              use ':port' for default host, or '[::1]:port' for ipv6.",
    "  --model <provider/id>       default model for new sessions (e.g. anthropic/claude-opus-4-7).",
    "                              may be a bare id; the model registry resolves the match.",
    "  --skill <path>              additional skill path (file or directory). repeatable;",
    "                              or use ':' / ',' to combine in one value.",
    "  --skill-allow <names>       comma-separated skill name whitelist; only these skills load.",
    "  --skill-allow-file <path>   whitelist file (one name per line; '#' for comments).",
    "                              file missing => behaves as if not set (all skills load).",
    "  --command-allow <names>     comma-separated slash command whitelist (names like 'new',",
    "                              'cwd', 'skill:foo'). only these commands appear in the slash",
    "                              menu and may be executed.",
    "  --command-allow-file <path> whitelist file (one name per line; '#' for comments).",
    "                              file missing => behaves as if not set (all commands allowed).",
    "                              when neither flag nor env var is set, <cwd>/.pi/commands-allow.txt",
    "                              is auto-detected if present.",
    "  --password <pw>             enable login; require this password to access the webui.",
    "                              alias: PI_WEBUI_PASSWORD env var.",
    "  --trust-proxy               honor X-Forwarded-Proto when deciding cookie Secure flag.",
    "                              alias: PI_WEBUI_TRUST_PROXY=1 env var.",
    "  --hide-model                hide the model name shown in the status bar.",
    "  --hide-thinking             drop assistant thinking blocks from session events.",
    "                              alias: PI_WEBUI_HIDE_THINKING=1.",
    "  --hide-tool-calls           drop tool_execution_* events and tool_call/tool_result",
    "                              blocks. alias: PI_WEBUI_HIDE_TOOL_CALLS=1.",
    "  --show-tool-progress        with --hide-tool-calls, send user-friendly tool_progress",
    "                              packets so the UI shows a spinner with Chinese labels",
    "                              (read → 正在讀取檔案... etc).",
    "                              alias: PI_WEBUI_SHOW_TOOL_PROGRESS=1.",
    "  --hide-status-chips         hide sandbox/tunnel/session chips in the status bar.",
    "                              alias: PI_WEBUI_HIDE_STATUS_CHIPS=1.",
    "  --hide-session-picker       hide the session picker / switcher entry points.",
    "                              alias: PI_WEBUI_HIDE_SESSION_PICKER=1.",
    "  --safe-errors               wrap server_error payloads as generic + 6-hex ticket;",
    "                              the raw message is logged with the same ticket id.",
    "                              alias: PI_WEBUI_SAFE_ERRORS=1.",
    "  --brand-name <text>         override the title and header label shown to the client.",
    "                              alias: PI_WEBUI_BRAND_NAME env var.",
    "  --brand-logo <path>         file served at GET /brand/logo (svg/png/jpg by ext).",
    "                              alias: PI_WEBUI_BRAND_LOGO env var.",
    "  --brand-color <hex>         #rgb or #rrggbb; sets CSS --brand-color custom property.",
    "                              alias: PI_WEBUI_BRAND_COLOR env var.",
    "  --profile <name>            load .pi/profiles/<name>.toml (name=customer with no file uses builtin fallback).",
    "                              alias: PI_WEBUI_PROFILE env var.",
    "  --ui-profile <name>         apply a preset bundle. supported: customer (= hide-thinking",
    "                              + hide-tool-calls + show-tool-progress + hide-status-chips",
    "                              + hide-session-picker + hide-model + safe-errors).",
    "                              alias: PI_WEBUI_UI_PROFILE env var.",
    "  --sandbox                   run read/write/edit/bash inside a Gondolin micro-VM.",
    "                              requires qemu; alias: PI_WEBUI_SANDBOX=1.",
    "  --sandbox-workspace <path>  host directory mounted as /workspace in the VM.",
    "                              defaults to the project cwd. /cwd is disabled in sandbox mode.",
    "  --sandbox-image <ref>       gondolin image selector (e.g. readyai-sandbox:0.1.0-3.23.0-bba981).",
    "                              alias: PI_WEBUI_SANDBOX_IMAGE; profile [sandbox] image 為 fallback.",
    "  --sandbox-env KEY=VAL       inject VM-wide env (repeatable); merge 進 profile [sandbox.env],",
    "                              CLI 覆寫個別 key.",
    "  --tunnel                    expose the webui via a cloudflared quick tunnel (trycloudflare.com).",
    "                              forces --password (auto-generated if not given) and --trust-proxy.",
    "                              REQUIRES --sandbox unless --allow-unsafe-tunnel is also set.",
    "                              alias: PI_WEBUI_TUNNEL=1.",
    "  --tunnel-cloudflared <path> cloudflared binary path (defaults to PATH lookup).",
    "                              alias: PI_WEBUI_CLOUDFLARED env var.",
    "  --allow-unsafe-tunnel       bypass the --sandbox requirement of --tunnel.",
    "                              tools will run with full host access; only set this if you",
    "                              fully trust everyone who can reach the tunnel URL.",
    "                              alias: PI_WEBUI_ALLOW_UNSAFE_TUNNEL=1.",
    "  -h, --help                  show this help and exit",
    "",
    "environment variables:",
    `  PI_WEBUI_HOST              http bind host (default ${DEFAULT_HOST})`,
    `  PI_WEBUI_PORT              http bind port (default ${DEFAULT_PORT})`,
    "  PI_WEBUI_MODEL             default model (same syntax as --model)",
    "  PI_WEBUI_SKILLS            extra skill paths, ':' or ',' separated",
    "  PI_WEBUI_SKILL_ALLOW       skill whitelist names (comma-separated)",
    "  PI_WEBUI_SKILL_ALLOW_FILE  skill whitelist file path",
    "  PI_WEBUI_COMMAND_ALLOW     slash command whitelist names (comma-separated)",
    "  PI_WEBUI_COMMAND_ALLOW_FILE slash command whitelist file path",
    "  PI_WEBUI_PASSWORD          enable login with this password (same as --password)",
    "  PI_WEBUI_TRUST_PROXY       '1' to honor X-Forwarded-Proto for cookie Secure flag",
    "  PI_WEBUI_HIDE_MODEL        '1' to hide the model name in the status bar",
    "  PI_WEBUI_HIDE_THINKING     '1' to drop assistant thinking blocks",
    "  PI_WEBUI_HIDE_TOOL_CALLS   '1' to drop tool_execution_* events / tool_call blocks",
    "  PI_WEBUI_SHOW_TOOL_PROGRESS '1' to send tool_progress packets when tool calls hidden",
    "  PI_WEBUI_HIDE_STATUS_CHIPS '1' to hide sandbox/tunnel/session chips",
    "  PI_WEBUI_HIDE_SESSION_PICKER '1' to hide the session picker UI",
    "  PI_WEBUI_SAFE_ERRORS       '1' to wrap server_error payloads with a ticket id",
    "  PI_WEBUI_BRAND_NAME        override webui title / header label",
    "  PI_WEBUI_BRAND_LOGO        path to a file served at /brand/logo",
    "  PI_WEBUI_BRAND_COLOR       brand accent color (#rgb or #rrggbb)",
    "  PI_WEBUI_PROFILE           profile name (same as --profile)",
    "  PI_WEBUI_UI_PROFILE        preset name (currently: customer)",
    "  PI_WEBUI_SANDBOX           '1' to enable the Gondolin VM sandbox (same as --sandbox)",
    "  PI_WEBUI_SANDBOX_WORKSPACE host directory used as the VM workspace mount",
    "  PI_WEBUI_SANDBOX_IMAGE     gondolin image selector (same as --sandbox-image)",
    "  PI_WEBUI_TUNNEL            '1' to expose the webui via a cloudflared quick tunnel",
    "  PI_WEBUI_CLOUDFLARED       cloudflared binary path",
    "  PI_WEBUI_ALLOW_UNSAFE_TUNNEL '1' to skip the --sandbox requirement of --tunnel (UNSAFE)",
    "  PI_PROJECT_CWD             project directory used for sessions (default cwd)",
    "  PI_AGENT_DIR               pi agent config directory (default ~/.pi/agent)",
    "  PI_SESSION_DIR             session storage directory (default pi default)",
    "",
    "examples:",
    "  pi-webui --listen 0.0.0.0:3000",
    "  pi-webui --model anthropic/claude-opus-4-7",
    "  pi-webui --skill ~/.claude/skills --skill-allow brainstorming,verify",
    "  PI_WEBUI_HOST=0.0.0.0 PI_WEBUI_PORT=3000 pi-webui",
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

function parseArgs(argv) {
  const out = { skill: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--listen") out.listen = argv[++i];
    else if (a.startsWith("--listen=")) out.listen = a.slice("--listen=".length);
    else if (a === "--model") out.model = argv[++i];
    else if (a.startsWith("--model=")) out.model = a.slice("--model=".length);
    else if (a === "--skill") out.skill.push(argv[++i]);
    else if (a.startsWith("--skill=")) out.skill.push(a.slice("--skill=".length));
    else if (a === "--skill-allow") out.skillAllow = argv[++i];
    else if (a.startsWith("--skill-allow=")) out.skillAllow = a.slice("--skill-allow=".length);
    else if (a === "--skill-allow-file") out.skillAllowFile = argv[++i];
    else if (a.startsWith("--skill-allow-file=")) out.skillAllowFile = a.slice("--skill-allow-file=".length);
    else if (a === "--command-allow") out.commandAllow = argv[++i];
    else if (a.startsWith("--command-allow=")) out.commandAllow = a.slice("--command-allow=".length);
    else if (a === "--command-allow-file") out.commandAllowFile = argv[++i];
    else if (a.startsWith("--command-allow-file=")) out.commandAllowFile = a.slice("--command-allow-file=".length);
    else if (a === "--hide-model") out.hideModel = true;
    else if (a === "--hide-thinking") out.hideThinking = true;
    else if (a === "--hide-tool-calls") out.hideToolCalls = true;
    else if (a === "--show-tool-progress") out.showToolProgress = true;
    else if (a === "--hide-status-chips") out.hideStatusChips = true;
    else if (a === "--hide-session-picker") out.hideSessionPicker = true;
    else if (a === "--safe-errors") out.safeErrors = true;
    else if (a === "--ui-profile") out.uiProfile = argv[++i];
    else if (a.startsWith("--ui-profile=")) out.uiProfile = a.slice("--ui-profile=".length);
    else if (a === "--profile") out.profile = argv[++i];
    else if (a.startsWith("--profile=")) out.profile = a.slice("--profile=".length);
    else if (a === "--brand-name") out.brandName = argv[++i];
    else if (a.startsWith("--brand-name=")) out.brandName = a.slice("--brand-name=".length);
    else if (a === "--brand-logo") out.brandLogo = argv[++i];
    else if (a.startsWith("--brand-logo=")) out.brandLogo = a.slice("--brand-logo=".length);
    else if (a === "--brand-color") out.brandColor = argv[++i];
    else if (a.startsWith("--brand-color=")) out.brandColor = a.slice("--brand-color=".length);
    else if (a === "--password") out.password = argv[++i];
    else if (a.startsWith("--password=")) out.password = a.slice("--password=".length);
    else if (a === "--trust-proxy") out.trustProxy = true;
    else if (a === "--sandbox") out.sandbox = true;
    else if (a === "--sandbox-workspace") out.sandboxWorkspace = argv[++i];
    else if (a.startsWith("--sandbox-workspace=")) out.sandboxWorkspace = a.slice("--sandbox-workspace=".length);
    else if (a === "--sandbox-image") out.sandboxImage = argv[++i];
    else if (a.startsWith("--sandbox-image=")) out.sandboxImage = a.slice("--sandbox-image=".length);
    else if (a === "--sandbox-env") {
      const kv = argv[++i];
      if (typeof kv !== "string" || !kv.includes("=")) {
        throw new Error(`--sandbox-env 需要 KEY=VAL 格式`);
      }
      const eq = kv.indexOf("=");
      const k = kv.slice(0, eq);
      const v = kv.slice(eq + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        throw new Error(`--sandbox-env: env key 不合法: "${k}"`);
      }
      out.sandboxEnv ??= {};
      out.sandboxEnv[k] = v;
    }
    else if (a.startsWith("--sandbox-env=")) {
      const kv = a.slice("--sandbox-env=".length);
      if (!kv.includes("=")) {
        throw new Error(`--sandbox-env 需要 KEY=VAL 格式`);
      }
      const eq = kv.indexOf("=");
      const k = kv.slice(0, eq);
      const v = kv.slice(eq + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        throw new Error(`--sandbox-env: env key 不合法: "${k}"`);
      }
      out.sandboxEnv ??= {};
      out.sandboxEnv[k] = v;
    }
    else if (a === "--tunnel") out.tunnel = true;
    else if (a === "--tunnel-cloudflared") out.tunnelCloudflared = argv[++i];
    else if (a.startsWith("--tunnel-cloudflared=")) out.tunnelCloudflared = a.slice("--tunnel-cloudflared=".length);
    else if (a === "--allow-unsafe-tunnel") out.allowUnsafeTunnel = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (out.password !== undefined && String(out.password).length === 0) {
    throw new Error("--password cannot be empty");
  }
  return out;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n\n`);
  printHelp();
  process.exit(2);
}
if (args.help) {
  printHelp();
  process.exit(0);
}
const listenFromArg = args.listen ? parseListen(args.listen) : null;
const host = listenFromArg?.host ?? process.env.PI_WEBUI_HOST ?? DEFAULT_HOST;
const port = listenFromArg?.port ?? Number(process.env.PI_WEBUI_PORT || DEFAULT_PORT);
// after build the script lives at dist/server/index.js; public/ stays at the
// package root, so walk up two levels from import.meta.url.
const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const appCwd = resolve(process.env.PI_PROJECT_CWD || process.cwd());

// 載入 profile 檔（--profile 或 PI_WEBUI_PROFILE 環境變數）
// 必須在 cliModelPattern / skill allow / command allow 計算前完成,
// 因為 profile 會作為 fallback 或 override 參與這些計算。
let profileFile: ProfileFile | undefined;
const profileName = args.profile || process.env.PI_WEBUI_PROFILE;
if (profileName) {
  try {
    profileFile = loadProfile(profileName, appCwd);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

// 模型 pattern 優先順序:CLI > env > profile [defaults].model
const cliModelPattern = (
  args.model ||
  process.env.PI_WEBUI_MODEL ||
  profileFile?.defaults?.model ||
  ""
).trim() || null;

// 收集所有技能路徑:--skill (可重複) 加上 PI_WEBUI_SKILLS (`:` 或 `,` 分隔)。
// 解析為絕對路徑,沿用 appCwd 與 ~ 展開,確保切換 cwd 後仍指向同一處。
function splitPathList(s) {
  return String(s || "")
    .split(/[:,]/)
    .map((v) => v.trim())
    .filter(Boolean);
}
function expandHome(p) {
  if (!p) return p;
  if (p === "~") return process.env.HOME || p;
  if (p.startsWith("~/")) return resolve(process.env.HOME || "", p.slice(2));
  return p;
}
const cliSkillPaths = [
  ...(args.skill || []),
  ...splitPathList(process.env.PI_WEBUI_SKILLS),
]
  .map((p) => resolve(appCwd, expandHome(p)))
  .filter((p, i, arr) => arr.indexOf(p) === i);

// 解析技能白名單:CLI flag > 檔案 > null (= 全部載入)。
// 檔案不存在視同未設定。空檔(或全註解)會回傳空陣列,代表「白名單為空」=> 全部過濾掉。
function readSkillAllowFile(path) {
  if (!path) return null;
  const resolved = resolve(appCwd, expandHome(path));
  if (!existsSync(resolved)) return null;
  const text = readFileSync(resolved, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);
}
function computeSkillAllow(cliValue, filePath) {
  if (cliValue && cliValue.trim()) {
    return cliValue
      .split(/[,\s]+/)
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return readSkillAllowFile(filePath);
}
// 若 CLI 與 env 都未指定 skill-allow-file,且 cwd 下有 .pi/skills-allow.txt,
// 自動採用以省去每次 /webui start 都得帶完整路徑。
function resolveSkillAllowFile(cliValue, envValue, cwd) {
  if (cliValue) return cliValue;
  if (envValue) return envValue;
  const auto = resolve(cwd, ".pi/skills-allow.txt");
  return existsSync(auto) ? auto : "";
}
const effectiveSkillAllowFile = resolveSkillAllowFile(
  args.skillAllowFile,
  process.env.PI_WEBUI_SKILL_ALLOW_FILE,
  appCwd,
);
let cliSkillAllow = computeSkillAllow(
  args.skillAllow || process.env.PI_WEBUI_SKILL_ALLOW || "",
  effectiveSkillAllowFile,
);
// profile [skills].allow 直接 override CLI/env/檔案;若有 skills-allow.txt 同存,印警告
if (profileFile?.skills?.allow) {
  if (effectiveSkillAllowFile) {
    logger.warn("profile [skills].allow override", { profile: profileName, file: effectiveSkillAllowFile });
  }
  cliSkillAllow = [...profileFile.skills.allow];
}

// slash command 白名單。對稱 skills-allow 機制,但比對 collectSlashCommands()
// 出口的指令 name(builtin/webui/template/extension 純名;skill 為 "skill:<name>")。
// 模組層級算出後在閘門 1 (collectSlashCommands) 與閘門 2 (slash_command handler) 共用。
const effectiveCommandAllowFile = resolveCommandAllowFile(
  args.commandAllowFile,
  process.env.PI_WEBUI_COMMAND_ALLOW_FILE,
  appCwd,
);
let cliCommandAllow = computeCommandAllow(
  args.commandAllow || process.env.PI_WEBUI_COMMAND_ALLOW || "",
  effectiveCommandAllowFile,
  appCwd,
  process.env.HOME || "",
);
// profile [commands].allow 直接 override CLI/env/檔案;若有 command-allow 檔同存,印警告
if (profileFile?.commands?.allow) {
  if (effectiveCommandAllowFile) {
    logger.warn("profile [commands].allow override", { profile: profileName, file: effectiveCommandAllowFile });
  }
  cliCommandAllow = [...profileFile.commands.allow];
}
let cliCommandAllowSet = cliCommandAllow ? new Set(cliCommandAllow) : null;

// 客戶導向 UI profile:整合 hide-* / show-* / brand-* / --ui-profile preset。
// 失敗(brand-logo 不存在 / brand-color 不合法 / unknown preset)直接 fail-fast。

let effectiveUiProfile: UiProfile;
try {
  effectiveUiProfile = parseUiProfile(args, process.env, profileFile);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
// 載入 brand css overlay 檔案(若 profile 有指定);失敗 fail-fast。
// cssPath 來自 profile-loader.validateBrand,已驗過 cwd containment;
// 這裡再 assert 一次防未來新增 CLI/env 入口時繞過 — defense in depth。
// 注意:server 啟動時固定,目前無熱重載機制,改 css 須重啟。
let brandCssBuffer: Buffer | null = null;
if (effectiveUiProfile.brand.cssPath) {
  try {
    const abs = resolve(appCwd, effectiveUiProfile.brand.cssPath);
    const cwdPrefix = appCwd.endsWith(sep) ? appCwd : appCwd + sep;
    if (!abs.startsWith(cwdPrefix)) {
      throw new Error(`brand.css: path escapes cwd: ${effectiveUiProfile.brand.cssPath}`);
    }
    brandCssBuffer = loadBrandCss(abs);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
}
// hideModel 沿用既有變數名避免大改;effectiveUiProfile.hideModel 是 single source of truth。
const hideModel = effectiveUiProfile.hideModel;

// connected packet / 前端 render 要的 client-friendly view:把 brand.logoPath 換成
// 統一的 /brand/logo URL(避免洩漏 host 路徑);沒設 logo 時保 null。
function serializeUiProfile(profile: UiProfile) {
  return {
    hideThinking: profile.hideThinking,
    hideToolCalls: profile.hideToolCalls,
    showToolProgress: profile.showToolProgress,
    hideStatusChips: profile.hideStatusChips,
    hideSessionPicker: profile.hideSessionPicker,
    hideModel: profile.hideModel,
    safeErrors: profile.safeErrors,
    brand: {
      name: profile.brand.name,
      logoUrl: profile.brand.logoPath ? "/brand/logo" : null,
      // backward-compat shim:Task 2.4 client 切換到 brand.tokens 後可移除
      color: profile.brand.tokens.accent ?? null,
      mode: profile.brand.mode,
      tokens: profile.brand.tokens,
      css: brandCssBuffer !== null,
    },
  };
}
// tunnel 啟用條件:CLI --tunnel 或 PI_WEBUI_TUNNEL=1。
// effective binary path:CLI > env > "cloudflared"(走 PATH)
const tunnelEnabled = !!args.tunnel || process.env.PI_WEBUI_TUNNEL === "1";
const tunnelCloudflared =
  args.tunnelCloudflared || process.env.PI_WEBUI_CLOUDFLARED || "cloudflared";
let authPassword = (args.password ?? process.env.PI_WEBUI_PASSWORD ?? "") || "";
let tunnelPasswordPath: string | null = null;
let tunnelPasswordGenerated = false;
let trustProxy = !!args.trustProxy || process.env.PI_WEBUI_TRUST_PROXY === "1";
if (tunnelEnabled && !trustProxy) {
  trustProxy = true;
}
// authEnabled / authStore 在 agentDir 確定後才算(tunnel 可能自動產生密碼)
// ↓ 見下方 agentDir 之後的 block
const LOGIN_PATH = "/login";
const HOME_DIR = process.env.HOME || "";
const ALLOW_ANY_CWD = process.env.PI_WEBUI_CWD_ALLOW_ANY === "1";

function expandTilde(p) {
  if (!p) return p;
  if (p === "~") return HOME_DIR;
  if (p.startsWith("~/")) return resolve(HOME_DIR, p.slice(2));
  return p;
}

function validateCwdTarget(target) {
  if (!target) throw new Error("path is required");
  const expanded = expandTilde(target);
  if (!isAbsolute(expanded)) throw new Error("path must be absolute");
  const resolved = resolve(expanded);
  if (!existsSync(resolved)) throw new Error(`path does not exist: ${resolved}`);
  if (!statSync(resolved).isDirectory()) throw new Error(`not a directory: ${resolved}`);
  if (!ALLOW_ANY_CWD && HOME_DIR && resolved !== HOME_DIR && !resolved.startsWith(HOME_DIR + "/")) {
    throw new Error(`path must be inside ${HOME_DIR} (set PI_WEBUI_CWD_ALLOW_ANY=1 to override)`);
  }
  return resolved;
}

function isCwdReachable(resolved) {
  if (ALLOW_ANY_CWD) return true;
  if (!HOME_DIR) return true;
  if (resolved === HOME_DIR) return true;
  if (resolved.startsWith(HOME_DIR + "/")) return true;
  // also allow listing ancestors of $HOME so the picker can navigate toward it.
  return HOME_DIR === resolved || HOME_DIR.startsWith(resolved + "/");
}

function listDirectories(target) {
  const expanded = expandTilde(target);
  if (!isAbsolute(expanded)) throw new Error("path must be absolute");
  const resolved = resolve(expanded);
  if (!existsSync(resolved)) throw new Error(`path does not exist: ${resolved}`);
  if (!statSync(resolved).isDirectory()) throw new Error(`not a directory: ${resolved}`);
  if (!isCwdReachable(resolved)) {
    throw new Error(`path must be inside ${HOME_DIR} (set PI_WEBUI_CWD_ALLOW_ANY=1 to override)`);
  }
  const entries = readdirSync(resolved, { withFileTypes: true })
    .filter((d) => {
      if (!d.isDirectory()) return false;
      if (d.name.startsWith(".")) return false;
      return true;
    })
    .map((d) => ({ name: d.name, path: resolve(resolved, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { path: resolved, entries };
}

async function collectRecentCwds() {
  const sessions = await SessionManager.listAll();
  const seen = new Map();
  for (const s of sessions) {
    if (!s?.cwd) continue;
    const existing = seen.get(s.cwd);
    const modified = s.modified instanceof Date ? s.modified.getTime() : Date.parse(s.modified || "") || 0;
    if (!existing || modified > existing.modified) {
      seen.set(s.cwd, { cwd: s.cwd, modified, count: (existing?.count || 0) + 1 });
    } else {
      existing.count += 1;
    }
  }
  return [...seen.values()].sort((a, b) => b.modified - a.modified);
}
const agentDir = process.env.PI_AGENT_DIR || getAgentDir();
const sessionDir = process.env.PI_SESSION_DIR;

// 偵測使用者顯式設了 PI_AGENT_DIR 但該目錄沒有 auth.json,而預設 ~/.pi/agent 有。
// 這通常表示使用者想隔離 session 但忘了把 OAuth credential 帶過去,會導致 AI 對接失敗。
if (process.env.PI_AGENT_DIR) {
  const defaultDir = getAgentDir();
  if (resolve(agentDir) !== resolve(defaultDir)) {
    let customHasAuth = false;
    let defaultHasAuth = false;
    try { customHasAuth = statSync(resolve(agentDir, "auth.json")).size > 0; } catch { /* missing */ }
    try { defaultHasAuth = statSync(resolve(defaultDir, "auth.json")).size > 0; } catch { /* missing */ }
    if (!customHasAuth && defaultHasAuth) {
      process.stderr.write(
        `hint: PI_AGENT_DIR=${agentDir} has no auth.json, but ${defaultDir} does.\n` +
        `      to share OAuth credential: unset PI_AGENT_DIR, or copy ${defaultDir}/auth.json into ${agentDir}.\n`,
      );
    }
  }
}

// tunnel 啟用且未帶 --password:自動產生 32 字元亂數並寫檔
if (tunnelEnabled && !authPassword) {
  authPassword = generateTunnelPassword();
  tunnelPasswordPath = writeTunnelPasswordFile(agentDir, authPassword);
  tunnelPasswordGenerated = true;
}
const authEnabled = authPassword.length > 0;
const authStore = authEnabled ? createAuthStore() : null;

function generateTunnelPassword(): string {
  // 24 bytes → 32 字元 base64url(取掉 padding)
  return randomBytes(24).toString("base64url");
}

function writeTunnelPasswordFile(agentDir: string, password: string): string {
  const path = resolve(agentDir, "tunnel-password.txt");
  writeFileSync(path, password + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* mode 已對,忽略 */
  }
  return path;
}

function isCloudflaredAvailable(bin: string): boolean {
  if (!bin) return false;
  // 絕對路徑直接 fs 檢查
  if (bin.startsWith("/")) {
    try {
      return statSync(bin).isFile();
    } catch {
      return false;
    }
  }
  // 走 PATH 偵測
  try {
    execSync(`command -v ${JSON.stringify(bin)}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// sandbox 啟用條件:CLI --sandbox 或 PI_WEBUI_SANDBOX=1。
// workspace 預設取 appCwd;CLI / env 可指定別的目錄,但路徑必須存在且為 directory。
const sandboxEnabled = !!args.sandbox || process.env.PI_WEBUI_SANDBOX === "1";
const sandboxWorkspaceRaw =
  args.sandboxWorkspace ||
  process.env.PI_WEBUI_SANDBOX_WORKSPACE ||
  appCwd;
let sandbox = null;
let sandboxInitError = null;
if (sandboxEnabled) {
  try {
    Sandbox.ensureQemuInstalled();
    const workspace = resolve(appCwd, expandHome(sandboxWorkspaceRaw));
    // image 優先級:CLI > env > profile
    const sandboxImage =
      args.sandboxImage ||
      process.env.PI_WEBUI_SANDBOX_IMAGE ||
      profileFile?.sandbox?.image ||
      undefined;
    // env merge:profile 為基底,CLI 覆寫個別 key
    const sandboxEnv = {
      ...(profileFile?.sandbox?.env ?? {}),
      ...(args.sandboxEnv ?? {}),
    };
    sandbox = new Sandbox({
      workspaceRoot: workspace,
      image: sandboxImage,
      env: Object.keys(sandboxEnv).length > 0 ? sandboxEnv : undefined,
      logger,
    });
    logger.info("sandbox enabled", {
      workspace: sandbox.workspaceRoot,
      guestPath: GUEST_WORKSPACE,
      image: sandboxImage ?? "(gondolin default)",
      env: Object.keys(sandboxEnv),
    });
  } catch (error) {
    sandboxInitError = error instanceof Error ? error.message : String(error);
    logger.error("sandbox init failed", { error: sandboxInitError });
    // 不立即退出:fail-fast 體驗對 extension 使用者太硬,把錯誤帶到第一個
    // WS connection 後再 surface。
  }
}

if (tunnelEnabled && !isCloudflaredAvailable(tunnelCloudflared)) {
  process.stderr.write(
    `error: --tunnel requires cloudflared binary, not found: ${tunnelCloudflared}\n` +
      "install:\n" +
      "  macOS:  brew install cloudflared\n" +
      "  Linux:  https://pkg.cloudflare.com/index.html\n" +
      "  cargo:  cargo install cloudflared\n",
  );
  process.exit(2);
}

if (tunnelEnabled && host === "0.0.0.0") {
  process.stderr.write(
    "warning: --tunnel with --listen 0.0.0.0:* exposes LAN and public concurrently.\n",
  );
}
// security gate:--tunnel 對外曝露時 *必須* 配 --sandbox,否則任何人拿到 URL + 密碼
// 都能透過 read/write/edit/bash 操作整個 host。要繞請顯式 --allow-unsafe-tunnel 表態。
const allowUnsafeTunnel = !!args.allowUnsafeTunnel || process.env.PI_WEBUI_ALLOW_UNSAFE_TUNNEL === "1";
if (tunnelEnabled && !sandboxEnabled && !allowUnsafeTunnel) {
  process.stderr.write(
    "error: --tunnel exposes the webui to the public internet.\n" +
    "       running without --sandbox lets remote users execute tools with full host access.\n" +
    "       add --sandbox (recommended) or pass --allow-unsafe-tunnel to bypass this check.\n",
  );
  process.exit(2);
}
if (tunnelEnabled && !sandboxEnabled && allowUnsafeTunnel) {
  process.stderr.write(
    "warning: --allow-unsafe-tunnel set; tunnel exposed without sandbox, tools have full host access.\n",
  );
}

// 讀 session jsonl 的第一行 header,拿 cwd 欄位。sandbox guard 用來判斷
// client request 的 session 是否屬於目前 mount 的 workspace。
function readSessionCwdSync(sessionFile) {
  try {
    const head = readFileSync(sessionFile, "utf8").split("\n", 2)[0] || "";
    if (!head) return null;
    const parsed = JSON.parse(head);
    return typeof parsed?.cwd === "string" ? parsed.cwd : null;
  } catch {
    return null;
  }
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

// Mirrors the TUI's /scoped-models selection persisted via SettingsManager.
// The TUI saves enabled model IDs as "provider/id" strings, so exact matching
// against the registry is sufficient.
function resolveScopedModelsFromSettings(services) {
  const patterns = services.settingsManager.getEnabledModels();
  if (!patterns || patterns.length === 0) return [];
  const available = services.modelRegistry.getAvailable();
  const matched = [];
  for (const pattern of patterns) {
    const found = available.find(
      (m) => `${m.provider}/${m.id}` === pattern || m.id === pattern,
    );
    if (found && !matched.find((sm) => sm.model === found)) {
      matched.push({ model: found });
    }
  }
  return matched;
}

// 依 CLI 白名單把 ResourceLoader 解析出的 skills 過濾掉名單外項目;
// 不影響 diagnostics 流回前端。
function buildSkillsOverride(allow) {
  if (!allow) return undefined;
  const allowSet = new Set(allow);
  return (base) => ({
    skills: base.skills.filter((s) => allowSet.has(s.name)),
    diagnostics: base.diagnostics,
  });
}

// 從 modelRegistry 把 "provider/id" 或單獨 id 解析成 Model 物件。
// 找不到時印警告,讓 SDK 回退到預設模型。
function resolveCliModel(services, pattern) {
  if (!pattern) return undefined;
  const available = services.modelRegistry.getAvailable();
  const found =
    available.find((m) => `${m.provider}/${m.id}` === pattern) ||
    available.find((m) => m.id === pattern);
  if (!found) {
    process.stderr.write(
      `[pi-webui] warning: model not found in registry: ${pattern}\n`,
    );
    return undefined;
  }
  return found;
}

// sandbox 模式下用 host cwd 當 tool cwd:user 給 relative path 由 host cwd
// 解析,operations 內部再 host→guest 轉。這樣 system prompt 看到的 cwd 一致,
// 不需要拼裝額外的 mount-prompt。
function buildSandboxCustomTools(cwd) {
  if (!sandbox) return undefined;
  return [
    createReadToolDefinition(cwd, { operations: sandbox.createReadOperations() }),
    createWriteToolDefinition(cwd, { operations: sandbox.createWriteOperations() }),
    createEditToolDefinition(cwd, { operations: sandbox.createEditOperations() }),
    createBashToolDefinition(cwd, { operations: sandbox.createBashOperations() }),
  ];
}

const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    resourceLoaderOptions: {
      additionalSkillPaths: cliSkillPaths.length > 0 ? cliSkillPaths : undefined,
      skillsOverride: buildSkillsOverride(cliSkillAllow),
    },
  });
  const scopedModels = resolveScopedModelsFromSettings(services);
  const cliModel = resolveCliModel(services, cliModelPattern);

  // 啟動時 log 一次,方便確認 --skill / --skill-allow 是否生效
  try {
    const { skills, diagnostics: skillDiags } = services.resourceLoader.getSkills();
    logger.info("skills loaded", {
      cwd,
      count: skills.length,
      names: skills.map((s) => s.name),
      whitelist: cliSkillAllow ?? null,
      whitelistSource: effectiveSkillAllowFile || null,
      diagnostics: skillDiags.length,
    });
  } catch (error) {
    logger.warn("skills introspection failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logger.info("commands allowlist", {
    count: cliCommandAllow?.length ?? null,
    whitelist: cliCommandAllow ?? null,
    whitelistSource: effectiveCommandAllowFile || null,
  });

  // sandbox 啟用時,把 read/write/edit/bash 從預設 builtin 改為走 VM 的版本。
  // noTools="builtin" 會關掉 SDK 的內建 read/bash/edit/write,再用 customTools
  // 重新註冊同名工具。
  const sandboxTools = sandboxEnabled && sandbox ? buildSandboxCustomTools(cwd) : undefined;

  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: cliModel,
      scopedModels,
      noTools: sandboxTools ? "builtin" : undefined,
      customTools: sandboxTools,
    })),
    services,
    diagnostics: services.diagnostics,
    sandboxEnabled: sandboxEnabled && !!sandbox,
    sandboxError: sandboxInitError,
  };
};

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendFile(res, filePath) {
  const type = mimeTypes[extname(filePath)] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "cache-control": "no-cache, no-store, must-revalidate",
  });
  createReadStream(filePath).pipe(res);
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    let destroyed = false;
    const chunks = [];
    req.on("data", (chunk) => {
      if (destroyed) return;
      total += chunk.length;
      if (total > limit) {
        destroyed = true;
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (destroyed) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

// HTTP 回應用的 sendJson(注意與 WebSocket 版 sendJson 不同)
function sendJsonHttp(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function isAuthPublic(pathname, method) {
  if (pathname === LOGIN_PATH && method === "GET") return true;
  if (pathname === "/api/login" && method === "POST") return true;
  if (pathname === "/api/logout" && method === "POST") return true;
  if (pathname === "/favicon.svg" && method === "GET") return true;
  // brand logo 要在 login 頁面也能顯示
  if (pathname === "/brand/logo" && method === "GET") return true;
  if (pathname === "/brand/theme.css" && method === "GET") return true;
  return false;
}

async function handleLogin(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJsonHttp(res, 400, { ok: false, error: "Invalid request" }); }
  const submitted = typeof body?.password === "string" ? body.password : "";
  if (!comparePassword(submitted, authPassword)) {
    // 250 ms 延遲:降低暴力破解速率,並讓錯密碼/對密碼的耗時差距變小,
    // 不影響正常登入體感
    await sleep(250);
    return sendJsonHttp(res, 401, { ok: false, error: "Invalid password" });
  }
  const token = authStore.issue();
  const secure = shouldSetSecure({ trustProxy, headers: req.headers });
  res.setHeader("Set-Cookie", buildSetCookie(token, { secure }));
  return sendJsonHttp(res, 200, { ok: true });
}

function handleLogout(req, res) {
  const token = readAuthCookie(req.headers);
  if (token) authStore.revoke(token);
  const secure = shouldSetSecure({ trustProxy, headers: req.headers });
  res.setHeader("Set-Cookie", buildClearCookie({ secure }));
  return sendJsonHttp(res, 200, { ok: true });
}

// 回 true 表示已處理(放行 / login / logout / reject);
// 回 false 表示需要繼續 serveStatic。
async function handleAuth(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  if (!authEnabled) return false;

  if (pathname === "/api/login" && method === "POST") {
    await handleLogin(req, res);
    return true;
  }
  if (pathname === "/api/logout" && method === "POST") {
    handleLogout(req, res);
    return true;
  }
  if (isAuthPublic(pathname, method)) return false;

  if (authStore.verify(readAuthCookie(req.headers))) return false;

  if (pathname.startsWith("/api/") || pathname === "/ws") {
    sendJsonHttp(res, 401, { ok: false, error: "Unauthorized" });
    return true;
  }
  res.writeHead(302, { location: `${LOGIN_PATH}?next=${encodeURIComponent(pathname + url.search)}` });
  res.end();
  return true;
}

// --brand-logo 指定的檔走這條路由,Content-Type 由副檔名推。
// 未指定 logo 時 fallback redirect 到 /favicon.svg,讓 client 端 <img src="/brand/logo"> 永遠有東西。
const BRAND_LOGO_MIME: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function serveBrandLogo(req, res) {
  const logoPath = effectiveUiProfile.brand.logoPath;
  if (!logoPath) {
    res.writeHead(302, { location: "/favicon.svg" });
    res.end();
    return;
  }
  const type = BRAND_LOGO_MIME[extname(logoPath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "cache-control": "no-cache, no-store, must-revalidate",
  });
  createReadStream(logoPath).pipe(res);
}

function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  let pathname = url.pathname;
  if (pathname === "/brand/logo") {
    serveBrandLogo(req, res);
    return;
  }
  if (pathname === "/brand/theme.css") {
    if (brandCssBuffer) {
      res.writeHead(200, {
        "content-type": "text/css; charset=utf-8",
        "content-length": String(brandCssBuffer.length),
        "cache-control": "no-store",
      });
      res.end(brandCssBuffer);
    } else {
      res.writeHead(404).end();
    }
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  else if (pathname === "/login") pathname = "/login.html";
  const filePath = resolve(join(publicDir, pathname));

  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  sendFile(res, filePath);
}

// Built-in slash commands that map cleanly to SDK calls. Commands that require
// interactive UI (settings, login, model selector, fork picker, etc.) are not
// here — the client handles them with a "not supported" toast.
// Slash commands implemented by pi-webui itself (not in pi's BUILTIN list).
// Surfaced in the client's `/` autocomplete via collectSlashCommands().
const WEBUI_SLASH_COMMANDS = {
  cwd: {
    description: "switch the working directory",
    argumentHint: "[path]",
  },
};

const SLASH_HANDLERS = {
  new: async (ctrl) => {
    const result = await ctrl.runtime.newSession();
    if (!result?.cancelled) {
      await ctrl.bindSession();
      await ctrl.sendBootstrap();
    }
    return result;
  },
  compact: async (ctrl, arg) => {
    const result = await ctrl.session.compact(arg || undefined);
    await ctrl.sendState();
    await ctrl.sendMessages();
    return result;
  },
  name: async (ctrl, arg) => {
    ctrl.session.setSessionName(String(arg || "").trim());
    await ctrl.sendState();
    await ctrl.sendSessions();
    return { name: ctrl.session.sessionName };
  },
  reload: async (ctrl) => {
    await ctrl.session.reload();
    await ctrl.sendState();
    return { reloaded: true };
  },
  session: async (ctrl) => {
    await ctrl.sendState();
    const s = ctrl.serializeState();
    const stats = ctrl.session.getSessionStats?.() || {};
    const lines = [
      `id:        ${s.sessionId}`,
      `name:      ${s.sessionName || "(unnamed)"}`,
      `file:      ${s.sessionFile || "(ephemeral)"}`,
      `cwd:       ${s.cwd}`,
      `model:     ${s.model ? `${s.model.provider}/${s.model.id}` : "(none)"}`,
      `thinking:  ${s.thinkingLevel}`,
      `streaming: ${s.isStreaming ? "yes" : "no"}`,
      `compact:   ${s.autoCompactionEnabled ? "auto" : "off"}`,
      `messages:  ${s.messageCount}`,
      `tools:     ${s.activeTools.length} active / ${s.toolCount} total`,
    ];
    if (stats.tokens) {
      lines.push(
        `tokens:    in ${stats.tokens.input} · out ${stats.tokens.output} · cache r/w ${stats.tokens.cacheRead}/${stats.tokens.cacheWrite}`,
      );
    }
    if (typeof stats.cost === "number") lines.push(`cost:      $${stats.cost.toFixed(4)}`);
    return { showText: { title: "Session", body: lines.join("\n") } };
  },
  settings: async (ctrl) => {
    const sm = ctrl.session.settingsManager;
    const enabledModels = sm.getEnabledModels?.() ?? null;
    const lines = [
      `auto-compaction:   ${ctrl.session.autoCompactionEnabled ? "on" : "off"}`,
      `thinking level:    ${ctrl.session.thinkingLevel}`,
      `enabled models:    ${enabledModels && enabledModels.length > 0 ? enabledModels.join(", ") : "(all)"}`,
      `default model:     ${sm.getDefaultProvider?.() || "?"}/${sm.getDefaultModelId?.() || "?"}`,
      `agent dir:         ${agentDir}`,
      `cwd:               ${ctrl.runtime.cwd}`,
    ];
    return {
      showText: {
        title: "Settings",
        body: lines.join("\n") + "\n\nManage settings with /scoped-models, /model, etc., or via the CLI.",
      },
    };
  },
  login: async (ctrl, arg) => {
    const parts = String(arg || "").trim().split(/\s+/);
    const [provider, apiKey] = parts;
    if (!provider || !apiKey) {
      throw new Error("Usage: /login <provider> <api-key>");
    }
    ctrl.runtime.services.authStorage.set(provider, { type: "api_key", key: apiKey });
    ctrl.runtime.services.modelRegistry.refresh?.();
    await ctrl.sendState();
    return { provider };
  },
  logout: async (ctrl, arg) => {
    const target = String(arg || "").trim();
    const auth = ctrl.runtime.services.authStorage;
    if (target) {
      auth.remove(target);
      ctrl.runtime.services.modelRegistry.refresh?.();
      await ctrl.sendState();
      return { provider: target };
    }
    const providers = auth.list();
    if (providers.length === 0) throw new Error("No providers configured");
    return {
      needsPicker: "logout",
      providers,
    };
  },
  share: async () => {
    throw new Error("/share is not supported in the web UI; use the CLI");
  },
  copy: async (ctrl) => {
    const text = ctrl.session.getLastAssistantText?.() || "";
    if (!text) throw new Error("No assistant message to copy");
    return { copyText: text };
  },
  quit: async (ctrl) => {
    setTimeout(() => ctrl.ws.close(), 100);
    return { closed: true };
  },
  hotkeys: async () => ({ showHotkeys: true }),
  changelog: async () => ({
    showText: { title: "Changelog", body: piChangelog || "No changelog available" },
  }),
  export: async (ctrl, arg) => {
    const target = String(arg || "").trim();
    const isJsonl = target.toLowerCase().endsWith(".jsonl");
    const path = isJsonl
      ? ctrl.session.exportToJsonl(target || undefined)
      : await ctrl.session.exportToHtml(target || undefined);
    return { exportedTo: path, format: isJsonl ? "jsonl" : "html" };
  },
  import: async (ctrl, arg) => {
    const path = String(arg || "").trim();
    if (!path) throw new Error("Usage: /import <path-to-jsonl>");
    const result = await ctrl.runtime.importFromJsonl(path);
    if (!result?.cancelled) {
      await ctrl.bindSession();
      await ctrl.sendBootstrap();
    }
    return result;
  },
  clone: async (ctrl) => {
    const leafId = ctrl.session.sessionManager.getLeafId();
    if (!leafId) throw new Error("Nothing to clone yet");
    const result = await ctrl.runtime.fork(leafId, { position: "at" });
    if (!result?.cancelled) {
      await ctrl.bindSession();
      await ctrl.sendBootstrap();
    }
    return result;
  },
  fork: async (ctrl, arg) => {
    const entryId = String(arg || "").trim();
    if (entryId) {
      const result = await ctrl.runtime.fork(entryId, { position: "before" });
      if (!result?.cancelled) {
        await ctrl.bindSession();
        await ctrl.sendBootstrap();
      }
      return result;
    }
    const messages = ctrl.session.getUserMessagesForForking();
    if (messages.length === 0) throw new Error("No user messages to fork from");
    return {
      needsPicker: "fork",
      messages: messages.map((m) => ({ entryId: m.entryId, text: m.text })),
    };
  },
  tree: async (ctrl, arg) => {
    const targetId = String(arg || "").trim();
    if (targetId) {
      const result = await ctrl.session.navigateTree(targetId);
      await ctrl.sendBootstrap();
      return result;
    }
    const tree = ctrl.session.sessionManager.getTree();
    const leafId = ctrl.session.sessionManager.getLeafId();

    const flattened = [];
    const walk = (nodes) => {
      for (const node of nodes || []) {
        if (!node) continue;
        const entry = node.entry || {};
        const id = node.id || entry.id || entry.entryId || "";
        const msg = entry.message || {};
        let summary = node.label || entry.text || "";
        if (!summary) {
          const content = entry.content || msg.content;
          if (Array.isArray(content)) {
            summary = content.find((c) => c && c.type === "text")?.text || "";
          } else if (typeof content === "string") {
            summary = content;
          }
        }
        if (!summary && entry.type === "compaction") summary = entry.summary || "";
        if (!summary && entry.type === "branch_summary") summary = entry.summary || "";
        flattened.push({
          id,
          summary: String(summary || entry.type || msg.role || entry.role || id || "Unknown")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200),
          role: msg.role || entry.role,
          kind: entry.type,
        });
        if (node.children) walk(node.children);
      }
    };
    walk(Array.isArray(tree) ? tree : tree ? [tree] : []);

    return { needsPicker: "tree", tree: flattened, leafId };
  },
  "scoped-models": async (ctrl, arg) => {
    const target = String(arg || "").trim();
    const all = ctrl.session.modelRegistry.getAvailable();
    if (target) {
      const patterns = target.split(/[,\s]+/).filter(Boolean);
      ctrl.session.settingsManager.setEnabledModels(patterns.length > 0 ? patterns : undefined);
      const scoped = resolveScopedModelsFromSettings(ctrl.runtime.services);
      ctrl.session.setScopedModels(scoped);
      await ctrl.sendState();
      return { saved: patterns };
    }
    const enabled = ctrl.session.settingsManager.getEnabledModels() || [];
    return {
      needsPicker: "scoped-models",
      models: all.map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name || m.id,
      })),
      enabled,
    };
  },
  model: async (ctrl, arg) => {
    const target = String(arg || "").trim();
    const scoped = ctrl.session.scopedModels;
    const available = scoped.length > 0
      ? scoped.map((s) => s.model)
      : ctrl.session.modelRegistry.getAvailable();
    if (target) {
      const match = available.find(
        (m) => `${m.provider}/${m.id}` === target || m.id === target,
      );
      if (!match) throw new Error(`Model not found: ${target}`);
      await ctrl.session.setModel(match);
      await ctrl.sendState();
      return { provider: match.provider, id: match.id };
    }
    const current = ctrl.session.model;
    return {
      needsPicker: "model",
      currentModel: current ? `${current.provider}/${current.id}` : null,
      models: available.map((m) => ({
        provider: m.provider,
        id: m.id,
        name: m.name || m.id,
        contextWindow: m.contextWindow,
      })),
    };
  },
  cwd: async (ctrl, arg) => {
    // sandbox 模式下 workspace 已 mount,切 cwd 會讓 VM 拿不到新目錄。
    // 改成只回報固定 workspace,讓前端 picker 直接 disable 切換。
    if (sandboxEnabled && sandbox) {
      const target = String(arg || "").trim();
      if (target) {
        throw new Error("cwd is locked in sandbox mode");
      }
      return {
        needsPicker: "cwd",
        currentCwd: ctrl.cwd,
        homeDir: HOME_DIR,
        cwds: [{ cwd: ctrl.cwd, modified: Date.now(), count: 0 }],
        locked: true,
        lockReason: "sandbox",
      };
    }
    const target = String(arg || "").trim();
    if (target) {
      const resolved = validateCwdTarget(target);
      if (resolved === ctrl.cwd) return { cwd: resolved, unchanged: true };
      await ctrl.switchCwd(resolved);
      return { cwd: resolved };
    }
    return {
      needsPicker: "cwd",
      currentCwd: ctrl.cwd,
      homeDir: HOME_DIR,
      cwds: await collectRecentCwds(),
    };
  },
  resume: async (ctrl, arg) => {
    const path = String(arg || "").trim();
    if (path) {
      const result = await ctrl.runtime.switchSession(path);
      if (!result?.cancelled) {
        await ctrl.bindSession();
        await ctrl.sendBootstrap();
      }
      return result;
    }
    const [currentProject, allProjects] = await Promise.all([
      SessionManager.list(ctrl.runtime.cwd, sessionDir),
      SessionManager.listAll(),
    ]);
    return {
      needsPicker: "session",
      currentSessionFile: ctrl.session.sessionFile || null,
      sessions: {
        currentProject: currentProject.map(serializeSessionInfo),
        allProjects: allProjects.map(serializeSessionInfo),
      },
    };
  },
};

function shouldRefreshState(eventType) {
  return new Set([
    "agent_start",
    "agent_end",
    "turn_end",
    "queue_update",
    "compaction_start",
    "compaction_end",
    "auto_retry_start",
    "auto_retry_end",
    "tool_execution_end",
    "context_update",
  ]).has(eventType);
}

function shouldRefreshMessages(eventType) {
  return new Set([
    "agent_start",
    "agent_end",
    "compaction_end",
  ]).has(eventType);
}

function serializeSessionInfo(info) {
  return {
    ...info,
    created: info.created instanceof Date ? info.created.toISOString() : info.created,
    modified: info.modified instanceof Date ? info.modified.toISOString() : info.modified,
  };
}

class NativePiSessionController {
  constructor(ws) {
    this.ws = ws;
    this.cwd = appCwd;
    this.runtime = undefined;
    this.unsubscribe = undefined;
    this.fileWatcher = undefined;
    this.watchedFile = undefined;
    this.lastSelfActivity = 0;
    this.refreshTimer = undefined;
    this.refreshing = false;
    this.eventLog = createEventLog();
    this.extUi = createExtUiBridge({
      send: (msg) => sendJson(this.ws, msg),
      log: logger,
    });
    this.ready = this.init().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const safe = safeError(effectiveUiProfile, message, logger);
      sendJson(this.ws, { type: "server_error", payload: safe });
      throw error;
    });
  }

  async init() {
    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: this.cwd,
      agentDir,
      sessionManager: SessionManager.create(this.cwd, sessionDir),
    });

    await this.bindSession();

    sendJson(this.ws, {
      type: "connected",
      payload: {
        appCwd: this.cwd,
        agentDir,
        homeDir: process.env.HOME || "",
        diagnostics: this.runtime.diagnostics,
        slashCommands: this.collectSlashCommands(),
        hideModel,
        uiProfile: serializeUiProfile(effectiveUiProfile),
        sandbox: sandboxEnabled
          ? {
              enabled: !!sandbox,
              workspace: sandbox?.workspaceRoot ?? null,
              guestPath: GUEST_WORKSPACE,
              error: sandboxInitError,
            }
          : null,
        tunnel: tunnelEnabled
          ? { enabled: true, ...lastTunnelState }
          : null,
      },
    });
    // Bootstrap is now driven by the client's `ready` message — they tell us
    // their lastSeq and we either replay missed events or send a reset +
    // fresh bootstrap. This lets reconnecting clients keep their UI state
    // when the buffer covers the gap (cross-WS replay still requires the
    // shared-controller refactor; today the buffer is per-WS so a reconnect
    // always falls through to reset, but the wire protocol is in place).
  }

  async switchCwd(newCwd) {
    logger.info("switching cwd", { from: this.cwd, to: newCwd });
    this.stopFileWatch();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    try { await this.runtime?.dispose(); } catch { /* ignore */ }
    this.cwd = newCwd;
    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: newCwd,
      agentDir,
      sessionManager: SessionManager.create(newCwd, sessionDir),
    });
    await this.bindSession();
    await this.sendBootstrap();
  }

  async bindSession() {
    this.unsubscribe?.();
    const session = this.runtime.session;
    await session.bindExtensions({ uiContext: this.extUi.ui });
    this.unsubscribe = session.subscribe((event) => {
      this.onSessionEvent(event);
    });
    this.startFileWatch();
    logger.info("session bound", {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile || null,
      model: session.model ? `${session.model.provider}/${session.model.id}` : null,
    });
  }

  onSessionEvent(event) {
    // Mark self-activity so the file watcher can ignore writes we caused.
    this.lastSelfActivity = Date.now();

    // eventLog 存原始 event(替 replay 用),向 client 出口時才過 ui-profile 過濾。
    const seq = this.eventLog.append(event);
    this.logSessionEvent(event, seq);

    const filtered = filterEvent(event, effectiveUiProfile);
    if (filtered === null) {
      // event drop;但仍要走後續 sendState / sendMessages / trimSettled,
      // 因為 state 機器跟 event 出口是兩件事
    } else if (filtered.kind === "tool_progress") {
      sendJson(this.ws, { type: "tool_progress", payload: filtered.payload });
    } else {
      sendJson(this.ws, { type: "session_event", payload: filtered.event, seq });
    }

    if (shouldRefreshState(event.type)) {
      this.sendState();
    }

    if (shouldRefreshMessages(event.type)) {
      this.sendMessages();
    }

    // Once a turn has ended, the canonical snapshot we just sent encodes
    // everything before this point — we no longer need to be able to replay
    // it, so drop those events from the buffer.
    if (event.type === "agent_end") {
      this.eventLog.trimSettled();
    }
  }

  // Map noteworthy session events to log lines. Frequent/streaming events
  // (message_update, context_update, queue_update, …) only fire at debug.
  logSessionEvent(event, seq) {
    const t = event?.type;
    switch (t) {
      case "agent_start":
        logger.info("turn start", { seq, model: event.model ? `${event.model.provider}/${event.model.id}` : undefined });
        return;
      case "agent_end": {
        const stats = this.session.getSessionStats?.() || {};
        logger.info("turn end", {
          seq,
          tokensIn: stats.tokens?.input,
          tokensOut: stats.tokens?.output,
          cost: typeof stats.cost === "number" ? Number(stats.cost.toFixed(4)) : undefined,
        });
        return;
      }
      case "tool_execution_start":
        logger.info("tool start", { seq, tool: event.toolName || event.name });
        return;
      case "tool_execution_end": {
        const ok = event.error ? false : true;
        const fields = { seq, tool: event.toolName || event.name, ok };
        if (!ok) fields.error = event.error?.message || String(event.error);
        (ok ? logger.info : logger.warn)("tool end", fields);
        return;
      }
      case "compaction_start":
        logger.info("compaction start", { seq });
        return;
      case "compaction_end":
        logger.info("compaction end", { seq });
        return;
      case "auto_retry_start":
        logger.warn("auto retry", { seq, attempt: event.attempt, error: event.error?.message });
        return;
      case "auto_retry_end":
        logger.info("auto retry end", { seq });
        return;
      case "extension_error":
        logger.error("extension error", { seq, error: event.error?.message || String(event.error) });
        return;
      case "turn_end":
      case "context_update":
      case "queue_update":
      case "message_update":
        logger.debug(`event ${t}`, { seq });
        return;
      default:
        logger.debug(`event ${t}`, { seq });
    }
  }

  startFileWatch() {
    const sessionFile = this.runtime?.session?.sessionFile;
    if (this.watchedFile === sessionFile) return;
    this.stopFileWatch();
    if (!sessionFile) return;
    try {
      this.fileWatcher = fsWatch(sessionFile, () => this.onSessionFileChange());
      this.watchedFile = sessionFile;
    } catch {
      // file may not yet exist for unpersisted sessions; ignore.
    }
  }

  stopFileWatch() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    try { this.fileWatcher?.close(); } catch { /* ignore */ }
    this.fileWatcher = undefined;
    this.watchedFile = undefined;
  }

  onSessionFileChange() {
    if (isSelfEcho(Date.now(), this.lastSelfActivity)) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    logger.info("external session file change detected", { sessionFile: this.watchedFile });
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshFromFile();
    }, EXTERNAL_REFRESH_DEBOUNCE_MS);
  }

  // Reload the session JSONL from disk to pick up changes from another pi
  // instance. Skipped while we are streaming or otherwise busy — the next
  // external write will retrigger it.
  async refreshFromFile() {
    const session = this.runtime?.session;
    const sessionFile = session?.sessionFile;
    if (!sessionFile) return;
    const ok = canRefreshNow({
      now: Date.now(),
      lastSelfActivity: this.lastSelfActivity,
      isStreaming: !!session.isStreaming,
      isCompacting: !!session.isCompacting,
      isRetrying: !!session.isRetrying,
      refreshing: this.refreshing,
    });
    if (!ok) {
      logger.info("external refresh skipped (busy)", { sessionFile });
      return;
    }
    this.refreshing = true;
    logger.info("external refresh begin", { sessionFile });
    try {
      const result = await this.runtime.switchSession(sessionFile);
      if (!result?.cancelled) {
        await this.bindSession();
        await this.sendBootstrap();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("external refresh failed", { sessionFile, error: message });
      const safe = safeError(effectiveUiProfile, `External refresh failed: ${message}`, logger);
      sendJson(this.ws, { type: "server_error", payload: safe });
    } finally {
      this.refreshing = false;
    }
  }

  get session() {
    if (!this.runtime) throw new Error("Pi runtime is not initialized");
    return this.runtime.session;
  }

  serializeState() {
    const session = this.session;
    let contextUsage = null;
    try {
      contextUsage = session.getContextUsage() ?? null;
    } catch {
      contextUsage = null;
    }
    return {
      cwd: this.runtime.cwd,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      autoCompactionEnabled: session.autoCompactionEnabled,
      steeringMode: session.steeringMode,
      followUpMode: session.followUpMode,
      activeTools: session.getActiveToolNames(),
      toolCount: session.getAllTools().length,
      messageCount: session.messages.length,
      contextUsage,
      model: session.model
        ? {
            provider: session.model.provider,
            id: session.model.id,
            name: session.model.name,
            reasoning: session.model.reasoning,
            contextWindow: session.model.contextWindow,
            maxTokens: session.model.maxTokens,
          }
        : null,
    };
  }

  async sendState() {
    sendJson(this.ws, { type: "session_state", payload: this.serializeState() });
  }

  async sendMessages() {
    // 客戶 mode 下,history 也要剝 thinking / tool_call / tool_result block;
    // 否則重連 / refresh 時 client 仍會拿到細節
    const filtered = filterMessageHistory(this.session.messages, effectiveUiProfile);
    sendJson(this.ws, { type: "message_history", payload: filtered });
  }

  async sendSessions() {
    const [currentProject, allProjects] = await Promise.all([
      SessionManager.list(this.runtime.cwd, sessionDir),
      SessionManager.listAll(),
    ]);

    sendJson(this.ws, {
      type: "sessions",
      payload: {
        currentProject: currentProject.map(serializeSessionInfo),
        allProjects: allProjects.map(serializeSessionInfo),
      },
    });
  }

  collectSlashCommands() {
    const commands = BUILTIN_SLASH_COMMANDS.map((c) => ({
      name: c.name,
      description: c.description,
      source: "builtin",
      supported: SLASH_HANDLERS[c.name] !== undefined,
    }));
    const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.name));
    for (const [name, meta] of Object.entries(WEBUI_SLASH_COMMANDS)) {
      if (builtinNames.has(name)) continue;
      commands.push({
        name,
        description: meta.description,
        source: "webui",
        supported: SLASH_HANDLERS[name] !== undefined,
        argumentHint: meta.argumentHint,
      });
    }

    for (const tpl of this.session.promptTemplates ?? []) {
      commands.push({
        name: tpl.name,
        description: tpl.description || "",
        source: "template",
        supported: true,
        argumentHint: tpl.argumentHint,
      });
    }

    const runner = this.session.extensionRunner;
    if (runner?.getRegisteredCommands) {
      const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((c) => c.name));
      for (const cmd of runner.getRegisteredCommands()) {
        if (builtinNames.has(cmd.name)) continue;
        commands.push({
          name: cmd.invocationName ?? cmd.name,
          description: cmd.description || "",
          source: "extension",
          supported: true,
        });
      }
    }

    // 將載入的技能以 `skill:<name>` 形式列入(pi 的 /skill:name args 規格)
    try {
      const skills = this.runtime?.services?.resourceLoader?.getSkills?.()?.skills ?? [];
      for (const s of skills) {
        commands.push({
          name: `skill:${s.name}`,
          description: s.description || "",
          source: "skill",
          supported: true,
        });
      }
    } catch {
      /* ignore — 技能載入失敗不應阻擋指令列舉 */
    }

    // 套用 command 白名單。未設定 → 不過濾;設定後僅保留名單內。
    if (cliCommandAllowSet) {
      return commands.filter((c) => cliCommandAllowSet.has(c.name));
    }
    return commands;
  }

  // Tell the client to discard any streamed UI state. Sent before a fresh
  // bootstrap on cold start, session switch, or replay miss.
  sendSessionReset() {
    sendJson(this.ws, {
      type: "session_reset",
      payload: { currentSeq: this.eventLog.currentSeq() },
    });
  }

  async sendBootstrap({ reset = true } = {}) {
    if (reset) this.sendSessionReset();
    await this.sendState();
    await this.sendMessages();
    await this.sendSessions();
  }

  // Handle the client's resume request. If we can replay missed events,
  // do so without disturbing UI state. Otherwise fall back to a reset +
  // fresh bootstrap.
  async handleReady(lastSeq, sessionFile) {
    if (sessionFile && sessionFile !== (this.session.sessionFile || null)) {
      // sandbox 模式下 workspace 被 mount 鎖死。Client 若 request 切到別個
      // cwd 的 session,read/write/bash 工具會通通踩到 workspace 邊界被擋。
      // 直接拒絕跨 workspace 的 session switch,server 繼續用啟動時的 cwd。
      if (sandboxEnabled && sandbox) {
        const sessionCwd = readSessionCwdSync(sessionFile);
        const wsRoot = sandbox.workspaceRoot;
        if (sessionCwd && resolve(sessionCwd) !== resolve(wsRoot)) {
          logger.warn("sandbox: refused cross-workspace session switch", {
            sessionFile,
            sessionCwd,
            workspaceRoot: wsRoot,
          });
          // fall through,不 switchSession;往下走 bootstrap 用當前 session
          sessionFile = null;
        }
      }
      if (sessionFile) {
        try {
          logger.info("client requested session", { sessionFile });
          const switched = await this.runtime.switchSession(sessionFile);
          if (!switched?.cancelled) await this.bindSession();
        } catch (error) {
          logger.warn("client requested session unavailable", {
            sessionFile,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        // sandbox refused switch — 直接 reset bootstrap 讓 client 用 server 端 session
        await this.sendBootstrap({ reset: true });
        return;
      }
    }
    const result = this.eventLog.eventsAfter(lastSeq);
    if (result.miss) {
      logger.info("client resume miss, full bootstrap", { lastSeq });
      await this.sendBootstrap({ reset: true });
      return;
    }
    if (result.events.length > 0) {
      logger.info("client resume replay", { from: lastSeq, count: result.events.length });
    }
    for (const { seq, event } of result.events) {
      sendJson(this.ws, { type: "session_event", payload: event, seq });
    }
    sendJson(this.ws, {
      type: "replay_done",
      payload: { currentSeq: this.eventLog.currentSeq() },
    });
  }

  async runCommand(command, handler) {
    try {
      const data = await handler();
      sendJson(this.ws, { type: "command_result", payload: { command, ok: true, data } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("command failed", { command, error: message });
      sendJson(this.ws, { type: "command_result", payload: { command, ok: false, error: message } });
    }
  }

  async handle(payload) {
    await this.ready;

    const inboundType = payload?.type === "slash_command"
      ? `slash_command:${payload?.name || "?"}`
      : (payload?.type || "unknown");
    logger.debug("ws inbound", { type: inboundType });

    switch (payload?.type) {
      case "ready": {
        const lastSeq = typeof payload.lastSeq === "number" ? payload.lastSeq : null;
        const sessionFile = typeof payload.sessionFile === "string" && payload.sessionFile ? payload.sessionFile : null;
        await this.handleReady(lastSeq, sessionFile);
        return;
      }
      case "refresh":
        await this.runCommand("refresh", async () => {
          await this.sendBootstrap({ reset: true });
          return { refreshed: true };
        });
        return;

      case "prompt": {
        const message = String(payload.message || "").trim();
        const images = sanitizePromptImages(payload.images);
        if (!message && images.length === 0) {
          sendJson(this.ws, {
            type: "command_result",
            payload: { command: "prompt", ok: false, error: "Message cannot be empty" },
          });
          return;
        }

        const streamingBehavior = this.session.isStreaming ? payload.streamingBehavior || "followUp" : undefined;
        logger.info("prompt accepted", {
          length: message.length,
          images: images.length,
          streaming: this.session.isStreaming,
          streamingBehavior,
        });
        void this.runCommand("prompt", async () => {
          await this.session.prompt(message, {
            images: images.length ? images : undefined,
            streamingBehavior,
            preflightResult: (success) => {
              if (!success) logger.warn("prompt preflight rejected");
              sendJson(this.ws, { type: "prompt_preflight", payload: { success } });
            },
          });
          await this.sendState();
          await this.sendMessages();
          await this.sendSessions();
          return { accepted: true };
        });
        return;
      }

      case "abort":
        logger.info("abort requested");
        await this.runCommand("abort", async () => {
          await this.session.abort();
          await this.sendState();
          return { aborted: true };
        });
        return;

      case "new_session":
        logger.info("new session requested");
        await this.runCommand("new_session", async () => {
          const result = await this.runtime.newSession();
          if (!result.cancelled) {
            await this.bindSession();
            await this.sendBootstrap();
          }
          return result;
        });
        return;

      case "switch_session":
        await this.runCommand("switch_session", async () => {
          const sessionPath = String(payload.sessionPath || "").trim();
          if (!sessionPath) {
            throw new Error("sessionPath is required");
          }
          logger.info("switch session", { sessionPath });
          const result = await this.runtime.switchSession(sessionPath);
          if (!result.cancelled) {
            await this.bindSession();
            await this.sendBootstrap();
          }
          return result;
        });
        return;

      case "cycle_model":
        await this.runCommand("cycle_model", async () => {
          const result = await this.session.cycleModel();
          const m = this.session.model;
          logger.info("model cycled", { model: m ? `${m.provider}/${m.id}` : null });
          await this.sendState();
          return result || { changed: false };
        });
        return;

      case "set_session_name":
        await this.runCommand("set_session_name", async () => {
          const name = String(payload.name || "").trim();
          this.session.setSessionName(name);
          await this.sendState();
          await this.sendSessions();
          return { name };
        });
        return;

      case "bash":
        await this.runCommand("bash", async () => {
          const command = String(payload.command || "").trim();
          if (!command) throw new Error("Empty bash command");
          logger.info("bash exec", { command });
          const result = await this.session.executeBash(command);
          const exitCode = result?.exitCode ?? 0;
          (exitCode === 0 ? logger.info : logger.warn)("bash done", { exitCode });
          await this.sendState();
          await this.sendMessages();
          return { exitCode };
        });
        return;

      case "list_dir": {
        const reqPath = String(payload.path || "").trim();
        try {
          const result = listDirectories(reqPath);
          sendJson(this.ws, { type: "list_dir_result", payload: { request: reqPath, ...result } });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(this.ws, { type: "list_dir_result", payload: { request: reqPath, error: message } });
        }
        return;
      }

      case "slash_command": {
        const name = String(payload.name || "").trim();
        const arg = typeof payload.arg === "string" ? payload.arg : "";
        logger.info("slash command", { name, hasArg: arg.length > 0 });
        // 閘門 2:白名單拒絕。null = 未設定時短路跳過。
        if (cliCommandAllowSet && !cliCommandAllowSet.has(name)) {
          logger.warn("slash command blocked by allowlist", { name });
          sendJson(this.ws, {
            type: "command_result",
            payload: {
              command: `slash:${name}`,
              ok: false,
              error: `/${name} is disabled by the command whitelist`,
            },
          });
          return;
        }
        const handler = SLASH_HANDLERS[name];
        if (handler) {
          await this.runCommand(`slash:${name}`, () => handler(this, arg));
          return;
        }
        // Fall through to extension/template/skill dispatch via session.prompt —
        // it detects "/cmd ..." text and routes to the registered handler or
        // (for "/skill:name args") expands the skill body inline.
        const runner = this.session.extensionRunner;
        const isExtension = runner?.getCommand && runner.getCommand(name);
        const isTemplate = (this.session.promptTemplates ?? []).some((t) => t.name === name);
        const isSkill = name.startsWith("skill:");
        if (isExtension || isTemplate || isSkill) {
          const text = arg ? `/${name} ${arg}` : `/${name}`;
          await this.runCommand(`slash:${name}`, async () => {
            await this.session.prompt(text);
            await this.sendState();
            await this.sendMessages();
            return { dispatched: true };
          });
          return;
        }
        sendJson(this.ws, {
          type: "command_result",
          payload: {
            command: `slash:${name}`,
            ok: false,
            error: `/${name} is not supported in the web UI`,
          },
        });
        return;
      }

      case "ext_ui_response":
        this.extUi.handleResponse(payload.payload || payload);
        return;

      case "ext_ui_custom_input":
        this.extUi.handleCustomInput(payload.payload || payload);
        return;

      case "ext_ui_custom_resize":
        this.extUi.handleCustomResize(payload.payload || payload);
        return;

      case "ext_ui_custom_close":
        this.extUi.handleCustomClose(payload.payload || payload);
        return;

      default:
        sendJson(this.ws, {
          type: "command_result",
          payload: { command: payload?.type || "unknown", ok: false, error: "Unknown command" },
        });
    }
  }

  async close() {
    try {
      this.stopFileWatch();
      this.unsubscribe?.();
      this.extUi?.dispose();
      await this.runtime?.dispose();
    } catch {
      // Ignore shutdown errors.
    }
  }
}

// 追蹤所有活躍的 WS controller,用於 tunnel 狀態廣播。
const activeControllers = new Set<NativePiSessionController>();

let tunnel: TunnelManager | null = null;
let lastTunnelState: TunnelState = { phase: "idle" };

function broadcastTunnelState(state: TunnelState) {
  lastTunnelState = state;
  for (const ctrl of activeControllers) {
    sendJson(ctrl.ws, { type: "tunnel_state", payload: state });
  }
}

const server = createServer(async (req, res) => {
  try {
    const handled = await handleAuth(req, res);
    if (handled) return;
    serveStatic(req, res);
  } catch (err) {
    logger.error("request handler error", { error: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Internal error" }));
    }
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  if (authEnabled && !authStore.verify(readAuthCookie(req.headers))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  const remote = req?.socket?.remoteAddress || "unknown";
  logger.info("ws connect", { remote });
  const controller = new NativePiSessionController(ws);
  activeControllers.add(controller);

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      void controller.handle(data).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("ws handler error", { error: message });
        const safe = safeError(effectiveUiProfile, message, logger);
        sendJson(ws, { type: "server_error", payload: safe });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("ws parse error", { error: message });
      const safe = safeError(effectiveUiProfile, message, logger);
      sendJson(ws, { type: "server_error", payload: safe });
    }
  });

  ws.on("close", () => {
    logger.info("ws disconnect", { remote });
    activeControllers.delete(controller);
    void controller.close();
  });
});

const actualPort = await listenWithFallback(server, { host, port, logger });
const actualUrl = `http://${host}:${actualPort}`;

if (tunnelEnabled) {
  tunnel = new TunnelManager({
    cloudflaredBin: tunnelCloudflared,
    logger,
  });
  tunnel.on("state", (s: TunnelState) => broadcastTunnelState(s));
  tunnel.on("url", (url: string) => {
    process.stdout.write(`  tunnel:   ${url}\n`);
  });
  tunnel.on("error", (e: Error) => {
    logger.error("tunnel error", { error: e.message });
    process.stderr.write(`  tunnel:   error - ${e.message}\n`);
  });
  tunnel.start(actualUrl);
  // 廣播初始 starting 狀態(spawn 同步觸發了 state event,但
  // activeControllers 此時為空,所以這裡顯式設一次 lastTunnelState)
  lastTunnelState = tunnel.getState();
}

const url = `http://${host}:${actualPort}`;
logger.info("listening", {
  url,
  requestedPort: port,
  fallback: actualPort !== port,
  appCwd,
  agentDir,
  sessionDir: sessionDir || undefined,
  auth: authEnabled ? "enabled" : "disabled",
  trustProxy: authEnabled ? trustProxy : undefined,
  sandbox: sandboxEnabled ? (sandbox ? "enabled" : `error:${sandboxInitError}`) : "disabled",
  tunnel: tunnelEnabled ? "starting" : "disabled",
});

if (tunnelPasswordGenerated) {
  process.stdout.write(
    `  password: ${authPassword}  (written to ${tunnelPasswordPath})\n`,
  );
}

// SIGINT / SIGTERM 統一在這裡關掉 VM,避免留下 QEMU process。
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown: starting", { signal });
  try {
    server.close();
  } catch {
    // ignore
  }
  if (tunnel) {
    try {
      await tunnel.stop();
    } catch (error) {
      logger.warn("shutdown: tunnel stop failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (sandbox) {
    try {
      await sandbox.close();
    } catch (error) {
      logger.warn("shutdown: sandbox close failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.info("shutdown: done");
  process.exit(0);
}
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
