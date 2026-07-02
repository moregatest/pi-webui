// reconnect guard 純函式:把 handleReady 內嵌的「是否接受 client 要求 resume 的 session」
// 判定抽出來。IO(readSessionCwdSync / canonicalize / resolveSessionDir)留在 caller,
// 這裡只做可單元測的純判斷。
//
// 注意:完整輸入須涵蓋原本散在 module-level closure 的變數(sandbox 狀態、session 目錄),
// 少傳任一個都會把原本的 closure-capture 行為漏掉。
import { resolve } from "node:path";
import { isWithinSessionDir } from "./session-dir.js";

export interface ResumeGuardInput {
  // client 要求 resume 的 session 檔(已由 caller canonicalize);falsy 代表沒帶。
  requestedSessionFile: string | null | undefined;
  // 從 session header 讀出的 cwd;讀不到(檔案不存在/壞檔)時為 null。
  sessionCwd: string | null;
  // 依 sessionCwd(或 fallback cwd)算出、已 canonicalize 的 session 目錄。
  resolvedSessionDir: string;
  // 是否處於「有效」sandbox(sandboxEnabled 且 sandbox 實例存在)。
  sandboxEnabled: boolean;
  // sandbox mount 的 workspace 根目錄;無 sandbox 時為 null。
  sandboxWorkspaceRoot: string | null;
}

export type ResumeGuardReason =
  | "no-session-file"
  | "sandbox-cross-workspace"
  | "outside-session-dir"
  | "ok";

export interface ResumeGuardDecision {
  resume: boolean;
  reason: ResumeGuardReason;
}

// 回 { resume:true } 才應 switchSession;resume:false 一律「不切、改走 bootstrap reset」。
export function shouldResumeStoredSession(input: ResumeGuardInput): ResumeGuardDecision {
  const { requestedSessionFile, sessionCwd, resolvedSessionDir, sandboxEnabled, sandboxWorkspaceRoot } = input;
  if (!requestedSessionFile) return { resume: false, reason: "no-session-file" };
  // sandbox:workspace 被 mount 鎖死,跨 workspace 的 session resume 一律拒絕,
  // 否則 read/write/bash 工具會踩到 workspace 邊界被擋。
  if (sandboxEnabled && sandboxWorkspaceRoot) {
    if (sessionCwd && resolve(sessionCwd) !== resolve(sandboxWorkspaceRoot)) {
      return { resume: false, reason: "sandbox-cross-workspace" };
    }
  }
  // project-local 範圍:session 檔必須落在它自身 cwd 對應的 session 目錄內,
  // 才不會在 /cwd 切換後誤擋或誤收他專案的 project-local session。
  if (!isWithinSessionDir(requestedSessionFile, resolvedSessionDir)) {
    return { resume: false, reason: "outside-session-dir" };
  }
  return { resume: true, reason: "ok" };
}
