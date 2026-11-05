// WebSocket 用戶端訊息的守門：
// 1. --ws-deny：非 customer 模式也能停用指定的 WS 訊息型別（customer 模式另有 customer-policy.ts 的固定清單）
// 2. WS bash 的執行位置：啟用 --sandbox 時必須進 Gondolin VM；沙盒要求了卻不可用時拒絕執行，不退回宿主 shell

/** dispatcher（index.ts NativePiSessionController.handle）會處理的用戶端訊息型別 */
export const WS_CLIENT_TYPES: ReadonlySet<string> = new Set([
  "ready", "refresh", "prompt", "abort",
  "new_session", "switch_session", "set_session_name", "cycle_model",
  "bash", "list_dir", "slash_command",
  "ext_ui_response", "ext_ui_custom_input", "ext_ui_custom_resize", "ext_ui_custom_close",
]);

/** 停用 ready 會讓連線無法初始化，視為設定錯誤 */
const UNDENIABLE = new Set(["ready"]);

/** 解析 --ws-deny／PI_WEBUI_WS_DENY；未知型別或不可停用的型別直接丟錯，避免打錯字卻以為已經擋住 */
export function parseWsDeny(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const name of String(raw ?? "").split(/[\s,]+/)) {
    if (!name) continue;
    if (UNDENIABLE.has(name)) throw new Error(`--ws-deny 不可包含 "${name}"（連線無法初始化）`);
    if (!WS_CLIENT_TYPES.has(name)) {
      throw new Error(`--ws-deny: 未知的訊息型別 "${name}"；可用：${[...WS_CLIENT_TYPES].filter((t) => !UNDENIABLE.has(t)).join(", ")}`);
    }
    out.add(name);
  }
  return out;
}

export function isDeniedWsMessage(payload: any, deny: ReadonlySet<string>): boolean {
  const type = payload?.type;
  return typeof type === "string" && deny.has(type);
}

interface SandboxBashLike {
  createBashOperations(): unknown;
}

/**
 * WS bash 要傳給 session.executeBash 的 operations。
 * - 未啟用沙盒：undefined，沿用 SDK 預設（宿主 shell）
 * - 沙盒可用：VM 內的 bash operations（與模型的 bash 工具同一個 VM）
 * - 要求沙盒但初始化失敗：丟錯（fail closed）
 */
export function resolveWsBashOperations(opts: {
  sandboxEnabled: boolean;
  sandbox: SandboxBashLike | null | undefined;
  sandboxInitError: string | null | undefined;
}): unknown {
  if (!opts.sandboxEnabled) return undefined;
  if (!opts.sandbox) {
    throw new Error(`sandbox unavailable, bash refused: ${opts.sandboxInitError ?? "not initialized"}`);
  }
  return opts.sandbox.createBashOperations();
}
