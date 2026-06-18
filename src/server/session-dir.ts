// session 儲存目錄解析。比照 watch.ts:只放可單元測試的純函式。
//
// 優先序 CLI > env > 預設(<cwd>/.pi/sessions),對齊本專案「CLI 優先」慣例。
// override(CLI/env)為絕對路徑、跨 cwd 共用;預設隨 cwd 重算。
import { dirname, join, resolve } from "node:path";

export interface SessionDirInputs {
  cliSessionDir?: string;
  envSessionDir?: string;
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
