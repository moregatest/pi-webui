// W43：customer 出口的自然語言文字處理。
//   - F14：簡體專用字 → 台灣繁體（只收一對一的字；一對多的字交給 reply guard 請 agent 重寫）
//   - F13：客戶訊息的附件區塊只留檔名，不露伺服器路徑
// 只在送往客戶端的出口套用；session 原文保留不改。

import { ONE_TO_ONE_PAIRS, AMBIGUOUS, TAIWAN_IN_USE } from "./simplified-map.js";

const ONE_TO_ONE = new Map<string, string>();
for (let i = 0; i + 1 < ONE_TO_ONE_PAIRS.length; i += 2) {
  // 防呆：重新產生字表時若又帶進台灣也在用的字，這裡仍不轉（W60）
  if (!TAIWAN_IN_USE.includes(ONE_TO_ONE_PAIRS[i])) ONE_TO_ONE.set(ONE_TO_ONE_PAIRS[i], ONE_TO_ONE_PAIRS[i + 1]);
}

// W60：么 在台灣也用（老么），只在前一字是這些字時當成簡體的「麼」轉換。
const ME_PREFIX = "什怎那这這多要";

/** 位置 i 要顯示的字；程式碼內與不轉的字回 undefined。 */
function convertAt(text: string, i: number, mask: Uint8Array): string | undefined {
  if (mask[i]) return undefined;
  const ch = text[i];
  if (ch === "么") return i > 0 && !mask[i - 1] && ME_PREFIX.includes(text[i - 1]) ? "麼" : undefined;
  return ONE_TO_ONE.get(ch);
}

/**
 * 每個位置是否在程式碼內（行首 ``` 圍起的區塊，或單行內的 `…`）。
 * 只依前文判斷，所以串流時用「累積全文」算出的結果與最終全文一致。
 */
function codeMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length);
  let fenced = false;
  let inline = false;
  let lineStart = true;
  for (let i = 0; i < text.length; i++) {
    if (lineStart && text.startsWith("```", i)) {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      mask.fill(1, i, stop);
      fenced = !fenced;
      i = stop - 1;
      lineStart = false;
      continue;
    }
    const ch = text[i];
    if (ch === "\n") {
      inline = false;
      lineStart = true;
      if (fenced) mask[i] = 1;
      continue;
    }
    lineStart = false;
    if (fenced) { mask[i] = 1; continue; }
    if (ch === "`") { mask[i] = 1; inline = !inline; continue; }
    if (inline) mask[i] = 1;
  }
  return mask;
}

function convertRange(text: string, start: number, mask: Uint8Array): string {
  let out = "";
  for (let i = start; i < text.length; i++) {
    out += convertAt(text, i, mask) ?? text[i];
  }
  return out;
}

/** 整段文字轉換（程式碼內不動）。 */
export function convertSimplified(text: string): string {
  if (typeof text !== "string" || !text) return text;
  return convertRange(text, 0, codeMask(text));
}

/**
 * 串流增量轉換：full 是含本次 delta 的累積全文（SDK partial），用來判斷 delta 是否在程式碼內。
 * 拿不到 full 或對不上時，退回以 delta 自身判斷。
 */
export function convertSimplifiedDelta(full: string | undefined, delta: string): string {
  if (typeof delta !== "string" || !delta) return delta;
  if (typeof full !== "string" || !full.endsWith(delta)) return convertSimplified(delta);
  return convertRange(full, full.length - delta.length, codeMask(full));
}

/** 程式碼以外、一對多而無法自動轉的簡體字（依出現順序、不重複）。 */
export function findAmbiguousSimplified(text: string): string[] {
  if (typeof text !== "string" || !text) return [];
  const mask = codeMask(text);
  const found: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!mask[i] && AMBIGUOUS[ch] && !found.includes(ch)) found.push(ch);
  }
  return found;
}

/** 程式碼以外、會被自動轉換的字與次數（稽核 log 用）。 */
export function countConvertible(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  if (typeof text !== "string" || !text) return counts;
  const mask = codeMask(text);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (convertAt(text, i, mask) !== undefined) counts[ch] = (counts[ch] ?? 0) + 1;
  }
  return counts;
}

// server 附加給 agent 的附件區塊（index.ts appendAttachmentNotice）：
//   [Attached files]
//   - <原檔名> -> <伺服器路徑>
const ATTACHMENT_BLOCK = /(^|\n)\[Attached files\]((?:\n- [^\n]* -> [^\n]*)+)/g;

/** F13：客戶畫面只顯示附件檔名；給 agent 的內容（session 原文）維持完整路徑。 */
export function scrubAttachmentNotice(text: string): string {
  if (typeof text !== "string" || !text.includes("[Attached files]")) return text;
  return text.replace(ATTACHMENT_BLOCK, (_m, lead: string, lines: string) => {
    const names = lines.split("\n").filter(Boolean).map((line) => {
      const body = line.slice(2);
      const cut = body.lastIndexOf(" -> ");
      return `- ${cut === -1 ? body : body.slice(0, cut)}`;
    });
    return `${lead}附件：\n${names.join("\n")}`;
  });
}
