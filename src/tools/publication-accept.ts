// readyai#162 C3：發布 triggered 後在背景跑 `preview publication accept`，並把結果分類成客戶用語。
// 結果檔、log、鎖檔都放在 <ws>/data/customer-publications/，0600；目錄 0700。
// content_verified 只採信 CLI（publication status／accept 輸出），本模組不自行判斷內容是否正確。
import { spawn } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface AcceptTarget { publication_id: string; candidate_digest: string }
export interface AcceptConfig { cwd: string; appName: string; originBaseUrl: string }
/** 可替換邊界：測試用替身取代真的 detached spawn 與 pid 檢查。 */
export interface AcceptDeps {
  /** 啟動背景 runner，回傳 pid；undefined＝啟動失敗。 */
  spawnRunner?: (runnerArgs: string[], cwd: string) => number | undefined;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  /** 測試或停用背景驗收時設 true。 */
  disabled?: boolean;
}
export type AcceptLaunch = "started" | "running" | "finished" | "disabled" | "unavailable";
export type PublicationState = "verified" | "running" | "expired_unverified" | "failed" | "unknown";

/** C3 對客戶用語；不得出現「已通知」任何人。 */
export const ACCEPT_WORDING: Record<PublicationState, string> = {
  verified: "已完成上線驗收",
  running: "正在做上線驗收",
  expired_unverified: "內容已更新到網站，但沒來得及完成完整驗收，已記錄由後勤追蹤",
  failed: "上線驗收沒有通過，已記錄由後勤追蹤",
  unknown: "目前還查不到最終結果，請稍後再問我",
};
export const TRIGGERED_WORDING = "發布已送出，系統正在做上線驗收，完成後您問我就能看到結果";

/** 可以（重新）啟動 accept 的 stage：已 triggered、尚待 raw／normal 驗收。 */
export const ACCEPT_ELIGIBLE_STAGE = /^awaiting_(raw|normal)_(verification|browser)$/;
/** 鎖檔超過此時間仍標示執行中，視為 pid 被重用的殘留（accept 同步跑完，lease 900 秒）。 */
export const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

export function acceptPaths(cwd: string, id: string) {
  if (!ID.test(id)) throw new Error("invalid publication id");
  const dir = join(realpathSync(cwd), "data/customer-publications");
  return { dir, result: join(dir, `${id}.accept.json`), log: join(dir, `${id}.accept.log`), lock: join(dir, `${id}.accept.lock`) };
}

function ensureDir(cwd: string): void {
  const root = realpathSync(cwd);
  for (const dir of [join(root, "data"), join(root, "data/customer-publications")]) {
    try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe publication directory");
  }
}

/** 讀本機 0600 檔；不存在回 undefined；權限、連結或擁有者不符直接 throw。 */
function readPrivate(path: string, limit = 16 * 1024 * 1024): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) { if (e.code === "ENOENT") return undefined; throw e; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > limit
      || (process.getuid && stat.uid !== process.getuid())) throw new Error("unsafe publication file");
    return readFileSync(fd, "utf-8");
  } finally { closeSync(fd); }
}

const defaultIsAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

function defaultSpawnRunner(runnerArgs: string[], cwd: string): number | undefined {
  const runner = fileURLToPath(new URL("./accept-runner.js", import.meta.url));
  // 與 pi-webui 相同身分與環境；detached＋unref，pi-webui 重啟不會帶走 runner。
  const child = spawn(process.execPath, [runner, ...runnerArgs], { cwd, detached: true, stdio: "ignore", env: process.env });
  child.on("error", () => {});
  child.unref();
  return child.pid;
}

/** 鎖檔仍代表一個活著的 runner？ */
function lockHeld(lockPath: string, deps: AcceptDeps): boolean {
  const now = (deps.now ?? Date.now)();
  let fd: number;
  try { fd = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) { if (e.code === "ENOENT") return false; throw e; }
  try {
    const stat = fstatSync(fd);
    const age = now - stat.mtimeMs;
    let pid: unknown;
    try { pid = JSON.parse(readFileSync(fd, "utf-8")).pid; } catch { pid = undefined; }
    // 剛建立、pid 尚未寫入：視為啟動中。
    if (!Number.isInteger(pid)) return age < 60_000;
    if (age > LOCK_MAX_AGE_MS) return false;
    return (deps.isAlive ?? defaultIsAlive)(pid as number);
  } finally { closeSync(fd); }
}

/**
 * 啟動背景驗收；同一 publication 只會有一個 runner。判準：
 * - 已有結果檔 → finished，不重跑（pi-webui 重啟後也一樣）
 * - 鎖檔中的 pid 還活著 → running
 * - 沒有結果、鎖檔不存在或 pid 已死（runner 被殺、機器重開）→ 清掉殘留鎖並補跑
 */
export function ensureAcceptStarted(config: AcceptConfig, target: AcceptTarget, deps: AcceptDeps = {}): AcceptLaunch {
  if (deps.disabled) return "disabled";
  if (!ID.test(target.publication_id) || !DIGEST.test(target.candidate_digest)) return "unavailable";
  try {
    ensureDir(config.cwd);
    const paths = acceptPaths(config.cwd, target.publication_id);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (readPrivate(paths.result) !== undefined) return "finished";
      let fd: number;
      try { fd = openSync(paths.lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (e) {
        if (e.code !== "EEXIST") throw e;
        if (lockHeld(paths.lock, deps)) return "running";
        try { unlinkSync(paths.lock); } catch (u) { if (u.code !== "ENOENT") throw u; }
        continue;
      }
      try {
        const cli = ["preview", "publication", "accept", "--name", config.appName, "--expected-origin", config.originBaseUrl,
          "--publication-id", target.publication_id, "--expected-candidate-digest", target.candidate_digest, "--json"];
        const pid = (deps.spawnRunner ?? defaultSpawnRunner)([realpathSync(config.cwd), target.publication_id, JSON.stringify(cli)], realpathSync(config.cwd));
        if (!Number.isInteger(pid)) { closeSync(fd); fd = -1; unlinkSync(paths.lock); return "unavailable"; }
        writeSync(fd, JSON.stringify({ pid, started_at: new Date((deps.now ?? Date.now)()).toISOString() }));
        return "started";
      } finally { if (fd >= 0) closeSync(fd); }
    }
    return "running";
  } catch { return "unavailable"; }
}

export interface AcceptSnapshot { running: boolean; result?: Record<string, any>; resultInvalid?: boolean }

/** 讀取背景驗收現況（不啟動任何程序）。 */
export function readAcceptSnapshot(cwd: string, id: string, deps: AcceptDeps = {}): AcceptSnapshot {
  const paths = acceptPaths(cwd, id);
  const raw = readPrivate(paths.result);
  if (raw === undefined) return { running: lockHeld(paths.lock, deps) };
  const last = raw.trim().split(/\r?\n/).filter(l => l.trim()).at(-1);
  try {
    const parsed = JSON.parse(last ?? "null");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { running: false, result: parsed };
  } catch { /* 落到 invalid */ }
  return { running: false, resultInvalid: true };
}

export interface CliStatus { ok: boolean; stage?: string; content_verified?: boolean }

/**
 * 依 CLI status 與 accept 結果分類。優先序：
 * status verified（content_verified=true）＞ status expired_unverified ＞ 執行中 ＞ accept 結果 ＞ unknown。
 */
export function classifyPublication(status: CliStatus, accept: AcceptSnapshot): PublicationState {
  if (status.ok && status.stage === "verified" && status.content_verified === true) return "verified";
  if (status.ok && status.stage === "expired_unverified") return "expired_unverified";
  if (accept.running) return "running";
  if (accept.resultInvalid) return "failed";
  const r = accept.result;
  if (r) {
    const data = r.ok === true && r.data && typeof r.data === "object" ? r.data : r;
    if (r.ok !== true) return "failed";
    if (data.result === "verified" && data.content_verified === true) {
      // status 查不到時採信 accept；status 查得到卻不是 verified＝前後不一致，交後勤。
      return status.ok ? "failed" : "verified";
    }
    if (data.result === "expired_unverified") return "expired_unverified";
    return "failed";
  }
  return "unknown";
}
