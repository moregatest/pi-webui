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
  // 檔案是否存在且可讀(caller 以 existsSync 判)。false 代表 client 帶的是 stale/missing
  // 檔(localStorage 指向已 rm / 換過 session-dir 的舊 session)—— issue #5。
  sessionFileExists: boolean;
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
  | "missing-file"
  | "sandbox-cross-workspace"
  | "sandbox-unverifiable-cwd"
  | "outside-session-dir"
  | "ok";

export interface ResumeGuardDecision {
  resume: boolean;
  reason: ResumeGuardReason;
}

// 回 { resume:true } 才應 switchSession;resume:false 一律「不切、改走 bootstrap reset」。
export function shouldResumeStoredSession(input: ResumeGuardInput): ResumeGuardDecision {
  const { requestedSessionFile, sessionFileExists, sessionCwd, resolvedSessionDir, sandboxEnabled, sandboxWorkspaceRoot } = input;
  if (!requestedSessionFile) return { resume: false, reason: "no-session-file" };
  // issue #5:client 帶的 stale/missing 檔一律不 resume。switchSession 對不存在的檔會把
  // session cwd fallback 到 server 的 process.cwd()(啟動目錄),sandbox 下 bash tool 的
  // cwd 因此落在 mount workspace 外,每個指令都回 "Path outside workspace"。這道 gate
  // 先於 sandbox / 目錄判定,涵蓋「檔不存在」的所有情境。
  if (!sessionFileExists) return { resume: false, reason: "missing-file" };
  // sandbox:workspace 被 mount 鎖死,必須能確認 session 屬於該 workspace 才 resume。
  if (sandboxEnabled && sandboxWorkspaceRoot) {
    // sessionCwd 讀不到(檔在但 header 壞/無 cwd):無法確認 workspace 歸屬 → 拒絕
    // (期望3;否則走 resolvedSessionDir=fallback cwd 的目錄判定,可能誤放行)。
    if (!sessionCwd) return { resume: false, reason: "sandbox-unverifiable-cwd" };
    // 跨 workspace:read/write/bash 會踩到 workspace 邊界被擋 → 拒絕。
    if (resolve(sessionCwd) !== resolve(sandboxWorkspaceRoot)) {
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
