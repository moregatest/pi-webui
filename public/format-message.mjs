// Convert SDK content array to structured blocks. The SDK uses camelCase types
// (toolCall/toolResult); we normalize to snake_case for our renderer.
export function sdkContentToBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) {
    return [{ type: "text", text: JSON.stringify(content, null, 2) }];
  }
  return content.map((b) => {
    if (!b || typeof b !== "object") return { type: "text", text: String(b ?? "") };
    switch (b.type) {
      case "text":
        return { type: "text", text: b.text || "" };
      case "thinking":
        return { type: "thinking", text: b.thinking || "" };
      case "image":
        return { type: "image", mimeType: b.mimeType, data: b.data };
      case "toolCall":
        return { type: "tool_call", name: b.name, input: b.arguments };
      case "toolResult":
        return {
          type: "tool_result",
          name: b.toolName || "result",
          result: { content: b.content, details: b.details },
        };
      default:
        return b; // pass through; renderBlocksHtml has a fallback
    }
  });
}

// content 是否「沒有任何內容」(空陣列 / 空字串 / null)。失敗 turn 常見
// 形態是 content:[] 搭配 errorMessage,需要據此判斷。
function isContentEmpty(content) {
  if (content == null) return true;
  if (typeof content === "string") return content.trim() === "";
  if (Array.isArray(content)) return content.length === 0;
  return false;
}

// 一個 assistant turn 是否失敗。pi/SDK 在金鑰失效、模型錯誤等情況回
//   { stopReason:"error", errorMessage:"401 User not found." }
// 有時 stopReason 缺失但 content 為空且帶 errorMessage,也視為失敗。
function isFailedAssistantTurn(message) {
  if (message.stopReason === "error") return true;
  if (message.errorMessage && isContentEmpty(message.content)) return true;
  return false;
}

// hideToolCalls 下仍該顯示的 tool_result:server 的 showToolResultsFor 白名單
// (見 src/server/ui-profile.ts)。client 這層只是 defensive secondary filter,
// 判斷條件必須跟 server 一致,否則 server 放行的結果會在這裡被二次過濾掉。
export function isToolResultVisible(block, uiProfile) {
  const allow = uiProfile?.showToolResultsFor;
  if (!Array.isArray(allow)) return false;
  const name = block?.toolName ?? block?.name;
  return typeof name === "string" && name !== "" && allow.includes(name);
}

// 一組 blocks 在當前 uiProfile 下是否有「會渲染出可見內容」的 block。
// 對應 renderBlocksHtml 的過濾規則(hideThinking / hideToolCalls + 白名單),外加:
// 空白 text/thinking、pending(result===null)的 tool_result 都不算可見。
// renderLog 用它避免掛出渲染後為空的裸 header(issue #2 留言 B)。
export function hasVisibleContent(blocks, uiProfile) {
  if (!Array.isArray(blocks)) return false;
  for (const b of blocks) {
    if (!b) continue;
    if (uiProfile?.hideThinking && b.type === "thinking") continue;
    if (uiProfile?.hideToolCalls && b.type === "tool_call") continue;
    if (uiProfile?.hideToolCalls && b.type === "tool_result" && !isToolResultVisible(b, uiProfile)) continue;
    if (b.type === "tool_result" && (b.result === null || b.result === undefined)) continue;
    if ((b.type === "text" || b.type === "thinking") && !String(b.text || "").trim()) continue;
    return true;
  }
  return false;
}

export function formatMessage(message) {
  switch (message.role) {
    case "user":
      return { kind: "user", title: "You", blocks: sdkContentToBlocks(message.content) };
    case "assistant": {
      const blocks = sdkContentToBlocks(message.content);
      if (isFailedAssistantTurn(message)) {
        // 失敗 turn 渲染成紅色 error 區塊(kind:"error" → .message.error h3 變紅),
        // 顯示 errorMessage;沒有 errorMessage 時給一句泛用提示,避免留白塊。
        const note = message.errorMessage || "(此回合失敗,未收到回應)";
        return { kind: "error", title: "Error", blocks: [...blocks, { type: "text", text: note }] };
      }
      return { kind: "assistant", title: "Assistant", blocks };
    }
    case "toolResult": {
      const name = message.toolName || "result";
      return {
        kind: "tool",
        title: `Tool result: ${name}`,
        blocks: [
          {
            type: "tool_result",
            name,
            result: { content: message.content, details: message.details },
          },
        ],
      };
    }
    case "bashExecution": {
      const text = `${message.output || ""}${message.exitCode !== undefined ? `\n\nexitCode: ${message.exitCode}` : ""}`.trim();
      return { kind: "tool", title: `Bash: ${message.command}`, blocks: [{ type: "text", text }] };
    }
    case "custom":
      return { kind: "custom", title: `Custom: ${message.customType}`, blocks: sdkContentToBlocks(message.content) };
    case "branchSummary":
      return { kind: "system", title: "Branch summary", blocks: [{ type: "text", text: message.summary || "" }] };
    case "compactionSummary":
      return { kind: "system", title: "Compaction summary", blocks: [{ type: "text", text: message.summary || "" }] };
    default:
      return {
        kind: "system",
        title: message.role || "Message",
        blocks: [{ type: "text", text: JSON.stringify(message, null, 2) }],
      };
  }
}
