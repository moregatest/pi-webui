// readyai#162 C3 背景 runner：由 publication-accept.ts 以 detached 方式啟動。
// 用法：node accept-runner.js <ws-root> <publication_id> <cli-args-json>
// 跑 readyai-project（同步到結束）→ stdout 原子寫入 <id>.accept.json、stderr 寫入 <id>.accept.log（皆 0600）→ 移除自己的鎖檔。
import { spawn } from "node:child_process";
import { closeSync, constants, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const [root, id, argsJson] = process.argv.slice(2);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
if (!root || !ID.test(id ?? "")) process.exit(64);
const cliArgs: string[] = JSON.parse(argsJson);
const dir = join(root, "data/customer-publications");
const resultPath = join(dir, `${id}.accept.json`);
const lockPath = join(dir, `${id}.accept.lock`);
const logFd = openSync(join(dir, `${id}.accept.log`), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
const log = (line: string) => { try { writeSync(logFd, `[accept-runner ${new Date().toISOString()}] ${line}\n`); } catch { /* 忽略 */ } };

let done = false;
function finish(stdout: string, exitCode: number): void {
  if (done) return;
  done = true;
  const temporary = join(dir, `.${id}.accept.${process.pid}.tmp`);
  writeFileSync(temporary, stdout, { mode: 0o600, flag: "wx" });
  renameSync(temporary, resultPath);
  log(`exit=${exitCode}`);
  try {
    // 只刪自己的鎖，避免誤刪後來者的。
    if (JSON.parse(readFileSync(lockPath, "utf-8")).pid === process.pid) unlinkSync(lockPath);
  } catch { /* 鎖不在或非本程序 */ }
  closeSync(logFd);
}

log(`start pid=${process.pid}`);
let stdout = "";
let bytes = 0;
const child = spawn("readyai-project", cliArgs, {
  cwd: root, env: { ...process.env, READYAI_SKIP_GLOBAL_SKILL_SYNC: "1" }, stdio: ["ignore", "pipe", logFd],
});
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d: string) => {
  bytes += Buffer.byteLength(d, "utf8");
  if (bytes <= 16 * 1024 * 1024) stdout += d;
});
child.on("error", e => {
  log(`spawn error: ${e.message}`);
  // CLI 無法啟動也要留下結果，讓狀態查詢分類為 failed、不會無限補跑。
  finish(JSON.stringify({ ok: false, source: "accept-runner", error: { code: "runner_spawn_failed", message: "readyai-project 無法啟動" } }) + "\n", -1);
  process.exit(1);
});
child.on("close", code => {
  if (bytes > 16 * 1024 * 1024) stdout = JSON.stringify({ ok: false, source: "accept-runner", error: { code: "output_too_large", message: "accept 輸出超過上限" } }) + "\n";
  finish(stdout, code ?? -1);
});
