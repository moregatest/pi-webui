// turn error 偵測：SDK 把「模型錯/金鑰 401/turn 失敗」吞成 assistant message 的
// stopReason:"error"（不拋例外），preload 層抓不到——agent_end 時檢查最新 assistant。
// 佐證形狀見 test/chat-state.test.mjs「live 401 failure …」案例。

type AnyMessage = {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
};

export function findFailedTurn(messages: unknown[]): { message: string } | null {
  if (!Array.isArray(messages)) return null;
  let last: AnyMessage | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as AnyMessage;
    if (m && m.role === "assistant") { last = m; break; }
  }
  if (!last) return null;
  const content = Array.isArray(last.content) ? last.content : [];
  const failed = last.stopReason === "error" || (!!last.errorMessage && content.length === 0);
  if (!failed) return null;
  return { message: String(last.errorMessage || "turn failed (stopReason=error)") };
}

export function scrubTurnError(text: string): string {
  return String(text)
    .replace(/\bsk-\S+/g, "[token]")
    .replace(/\bBearer\s+\S+/gi, "[token]");
}
