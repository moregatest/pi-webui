// session 儲存目錄解析。比照 watch.ts:只放可單元測試的純函式。
//
// 優先序 CLI > env > 預設(<cwd>/.pi/sessions),對齊本專案「CLI 優先」慣例。
// override(CLI/env)為絕對路徑、跨 cwd 共用;預設隨 cwd 重算。
import { dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";

export interface SessionDirInputs {
  cliSessionDir?: string;
  envSessionDir?: string;
}

// 解析 symlink 取得 canonical 真實路徑(macOS /tmp→/private/tmp 正規化不一致的根因)。
// resolveSessionDir / isWithinSessionDir 刻意保持純函式(不碰 fs)以便單元測;
// 需要解析 symlink 的副作用集中在這個 helper,由 caller(boot / handleReady)在比對前呼叫,
// 讓 reconnect guard 兩邊路徑都先 canonicalize 再比對。
// 路徑尚未建立時 realpathSync 會丟 ENOENT → fallback 回 lexical resolve()。
export function canonicalize(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

// 解析某個 cwd 的 session 儲存目錄。
export function resolveSessionDir(cwd: string, opts: SessionDirInputs = {}): string {
  const override = (opts.cliSessionDir || "").trim() || (opts.envSessionDir || "").trim();
  if (override) return resolve(override);
  return join(cwd, ".pi", "sessions");
}

// reconnect guard 用:session 檔是否落在指定目錄。
// SDK 把 session 檔扁平存在目錄下(<ts>_<id>.jsonl),比對父目錄即可。
export function isWithinSessionDir(sessionFile: string, sessionDir: string): boolean {
  return dirname(resolve(sessionFile)) === resolve(sessionDir);
}
