// readyai-provider-errors：把 LLM 閘道的「預算用完」錯誤換成客戶看得懂的繁中提示（bf-ux402）。
//
// 背景：Bifrost／litellm 的預算錯誤經 pi SDK 變成 assistant 訊息的
//   { stopReason: "error", errorMessage: '402: {"message":"Budget exceeded: vk_model_config * ..."}' }
// pi-webui 把 errorMessage 原樣顯示在 /agent 的紅色錯誤框，客戶看不懂。
//
// 作法：獨立 pi extension（不改 pi-webui、不改第三方 pi-provider-litellm），
// 在 message_end 改寫 errorMessage。SDK 會就地替換訊息，之後的 agent_end 快照、
// session 紀錄、pi-webui 的 GlitchTip 回報都看到改寫後的文字。
// 只動「預算用完」這一類；其他錯誤與正常回覆一律不碰。
//
// 附帶效果：SDK 依 errorMessage 判斷是否自動重試，原文的金額（例 0.0500）會誤中 "500"
// 而白白重送；繁中提示不含這類字樣，預算用完就直接停。
//
// 第二件事（bf-trunc）：輸出撞到 maxTokens 被截斷、而且只有思考沒有文字也沒有工具呼叫時
//   { stopReason: "length", content: [{ type: "thinking", … }] }
// SDK 會當成正常結束，turn 靜默收掉，客戶畫面什麼都沒有（biocrown 2026-11-12 實例）。
// 作法：同一則客戶提問內，第一次發生就以 followUp 送一則隱藏的 custom 訊息（customType
// 非 readyai_customer_ 前綴，pi-webui 客戶出口會整則丟掉）要模型直接給結論，自動續跑一次；
// 第二次再發生就把該則改寫成 stopReason "error"＋繁中 errorMessage，pi-webui 顯示紅色錯誤框。
// 每則客戶提問（user 訊息）重新計次，只重試一次，不會無限迴圈。

export const BUDGET_EXCEEDED_TEXT =
  "AI 助理的使用額度已用完，暫時無法回覆。請聯絡 Ready Market 客服協助處理。（代碼：AI_BUDGET_EXCEEDED）";

// Bifrost：「Budget exceeded: vk_model_config * budget exceeded: …」／type "budget_exceeded"
// litellm：「Budget has been exceeded!」「ExceededBudget: … over budget」「exceeded budget for model=…」
const BUDGET_PATTERN = /budget\s+(?:has\s+been\s+)?exceeded|exceeded\s*budget|budget_exceeded/i;
// 閘道的預算錯誤一定以 HTTP 狀態碼開頭（Bifrost 402、litellm 400）；
// 要求這個前綴，避免「reasoning token budget exceeded」這類非額度錯誤被誤改。
const STATUS_PREFIX = /^\s*(?:402|400)\b/;

// 寫進 pm2 log 前遮掉可能的金鑰：sk-／sk_（前面不可是英數字，避免誤遮 task_／disk-；底線可，token_sk- 照遮）、Bearer、JWT、
// api-key／x-api-key／authorization 欄位值（含 JSON 寫法）
export function redactSecrets(text) {
  return String(text)
    .replace(/\bBearer\s+[^\s"',}]+/gi, "Bearer [token]")
    .replace(/eyJ[\w-]*\.[\w-]+\.[\w-]+/g, "[token]")
    .replace(/(?<![A-Za-z0-9])sk[-_][A-Za-z0-9_-]+/g, "[token]")
    .replace(/((?:x-)?api[-_]?key|authorization)(["']?\s*[:=]\s*["']?)(?!Bearer \[token\])[^\s"',}]+/gi,
      "$1$2[token]");
}

// 預算錯誤 → 回傳改寫後的訊息；其他 → undefined（不動）
export function translateProviderError(message) {
  if (!message || message.role !== "assistant" || message.stopReason !== "error") return undefined;
  const raw = message.errorMessage;
  if (typeof raw !== "string" || !STATUS_PREFIX.test(raw) || !BUDGET_PATTERN.test(raw)) return undefined;
  return { ...message, errorMessage: BUDGET_EXCEEDED_TEXT };
}

export const TRUNCATED_TEXT =
  "這題思考太久，回覆被截斷了，沒有產生內容。請再說一次，或把問題拆小一點再問。（代碼：AI_OUTPUT_TRUNCATED）";

export const TRUNCATION_RETRY_TYPE = "readyai_truncation_retry";
export const TRUNCATION_RETRY_HINT =
  "（系統提示）上一次回覆因長度上限被截斷，沒有產生任何內容。請不要再長篇思考，" +
  "直接用繁體中文給出結論；需要工具就直接呼叫。";

function hasVisibleText(content) {
  if (typeof content === "string") return content.trim() !== "";
  if (!Array.isArray(content)) return false;
  return content.some((b) => b && b.type === "text" && typeof b.text === "string" && b.text.trim() !== "");
}

function hasToolCall(content) {
  return Array.isArray(content) && content.some((b) => b && (b.type === "toolCall" || b.type === "tool_call"));
}

// 截斷且沒有任何可見輸出 → true。
// 排除 SDK 認定的「輸入塞滿 context」（output 0 且 input 佔滿視窗）：那由 SDK 自動壓縮後重試，這裡不插手。
export function isSilentTruncation(message, contextWindow) {
  if (!message || message.role !== "assistant" || message.stopReason !== "length") return false;
  if (hasVisibleText(message.content) || hasToolCall(message.content)) return false;
  const u = message.usage;
  if (u && u.output === 0 && contextWindow && (u.input ?? 0) + (u.cacheRead ?? 0) >= contextWindow * 0.99) {
    return false;
  }
  return true;
}

export function truncationFailureMessage(message) {
  return { ...message, stopReason: "error", errorMessage: TRUNCATED_TEXT };
}

export default function (pi) {
  // 本則客戶提問內是否已自動重試過（每個 session runtime 各自一份）
  let truncationRetried = false;

  pi.on("message_end", (event, ctx) => {
    const original = event?.message;
    if (original?.role === "user") {
      truncationRetried = false;
      return undefined;
    }
    if (isSilentTruncation(original, ctx?.model?.contextWindow)) {
      const out = original.usage?.output;
      if (!truncationRetried && typeof pi.sendMessage === "function") {
        truncationRetried = true;
        try {
          pi.sendMessage(
            { customType: TRUNCATION_RETRY_TYPE, content: TRUNCATION_RETRY_HINT, display: false },
            { deliverAs: "followUp", triggerTurn: true },
          );
          process.stderr.write(`[readyai-provider-errors] 輸出被截斷且無內容（output=${out}），自動續跑一次\n`);
          return undefined;
        } catch (err) {
          // 排不進續跑就別靜默：直接走下方的繁中提示
          process.stderr.write(`[readyai-provider-errors] 截斷續跑排程失敗：${redactSecrets(err?.message ?? err).slice(0, 200)}\n`);
        }
      }
      process.stderr.write(`[readyai-provider-errors] 重試後仍被截斷且無內容（output=${out}），改顯示繁中提示\n`);
      return { message: truncationFailureMessage(original) };
    }
    const message = translateProviderError(original);
    if (!message) return undefined;
    // 原文只進 pm2 log 供維運查；保險起見遮掉可能的金鑰
    const raw = redactSecrets(event.message.errorMessage).slice(0, 500);
    process.stderr.write(`[readyai-provider-errors] 預算用完，已改寫為繁中提示；原文：${raw}\n`);
    return { message };
  });
}
