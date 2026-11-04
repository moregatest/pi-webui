// F12（W41）：agent 沒有主動通知能力。發布後若回覆承諾「我會回報／通知您」，
// 在同一輪結束前自動送一則隱藏的更正指示，讓 agent 立刻追加更正。
//
// 規則與 readyai-project-template customer-pgc-dialogue/scripts/dialogue_audit.py 的
// publish_callback_promise（766cfa0）及 site-workflow e2e-soak（c49b4d8）相同；
// 跨 repo 無法共用程式，正反例放在 test/fixtures/callback-promise-cases.json，改規則時三處一起改。
//
// 同一則隱藏指示也合併 W43 F14（一對多簡體字，「更正用字：」）與 W45 F17（程式識別字，
// 「更正用語：」，規則見 jargon.ts）與 W75（逐筆片段照原文列，「更正逐筆：」）；同一回覆最多更正一次。

import { countConvertible, findAmbiguousSimplified } from "./customer-text.js";
import { findJargon } from "./jargon.js";
import { hunkText, type RecordHunkText } from "../tools/record-text.js";

const CALLBACK_VERBS = "(?:回報|通知|通報|告訴|告知|聯絡|聯繫|回覆|回電)";
const CALLBACK_PROMISE_RES: RegExp[] = [
  // 我／我們 ……（未來）回報、通知……；中間不得出現否定或已完成語氣
  new RegExp("我們?[^，。；！!?？\\n不無沒已別]{0,12}?" + CALLBACK_VERBS),
  // 「有結果我會說」「我再跟您說」
  new RegExp("我們?(?:會|再|就)[^，。；！!?？\\n不無沒已]{0,6}說(?!明)"),
  // 無主詞：「完成後告訴您」「稍後回覆您」
  new RegExp(
    "(?:完成|好了|結束|有結果|有狀況|有消息|有進度|之後|稍後|晚點|待會|再)"
      + "[^，。；！!?？\\n不無沒已]{0,8}?" + CALLBACK_VERBS + "(?:您|你)",
  ),
];

/** 回傳命中的片段；沒有承諾回 null。 */
export function findCallbackPromise(text: string | undefined | null): string | null {
  if (!text) return null;
  for (const re of CALLBACK_PROMISE_RES) {
    const m = re.exec(text);
    if (m) return m[0];
  }
  return null;
}

/** 不帶 readyai_customer_ 前綴：customer 出口會整則濾掉，客戶看不到指示本身（ui-profile #102）。 */
export const PROMISE_GUARD_CUSTOM_TYPE = "readyai_promise_guard";

const CORRECTION_SENTENCE = "更正：我沒辦法主動通知您，驗收結果請您之後回來問我『發布好了沒』。";

type Part = { type?: string; text?: string; name?: string };
type Msg = { role?: string; customType?: string; content?: unknown; timestamp?: number };

const parts = (m: Msg): Part[] => (Array.isArray(m.content) ? (m.content as Part[]) : []);
const isPublishCall = (p: Part) => p?.type === "toolCall" && p.name === "publish_confirmed";
const isGuard = (m: Msg) => m?.role === "custom" && m.customType === PROMISE_GUARD_CUSTOM_TYPE;

/** 本次回覆的起點：最後一則客戶訊息或更正指示。 */
function lastBoundary(messages: Msg[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user" || isGuard(messages[i])) return i;
  }
  return -1;
}

/** 從 start 往後依序掃 assistant 訊息，找 publish_confirmed 之後的第一句承諾。 */
function scanReply(messages: Msg[], start: number, seenBefore: boolean): { matched: string; text: string } | null {
  let seen = seenBefore;
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    for (const p of parts(m)) {
      if (isPublishCall(p)) seen = true;
      else if (seen && p?.type === "text") {
        const matched = findCallbackPromise(p.text);
        if (matched) return { matched, text: p.text as string };
      }
    }
  }
  return null;
}

const publishSeenBefore = (messages: Msg[], end: number) =>
  messages.slice(0, end).some(m => m?.role === "assistant" && parts(m).some(isPublishCall));

export type PromisePlan = { boundary: number; matched: string; text: string };

/**
 * 判斷本次回覆是否需要更正。範圍與 dialogue_audit 一致：只看 publish_confirmed 呼叫之後的
 * assistant 文字；回覆對象已是更正指示時回 null（同一回覆最多更正一次）。
 */
export function planPromiseCorrection(messages: Msg[]): PromisePlan | null {
  if (!Array.isArray(messages)) return null;
  const boundary = lastBoundary(messages);
  if (boundary >= 0 && isGuard(messages[boundary])) return null;
  const hit = scanReply(messages, boundary + 1, publishSeenBefore(messages, boundary + 1));
  return hit ? { boundary, ...hit } : null;
}

/** 本次回覆（boundary 之後）對客戶顯示的 assistant 文字；thinking、工具參數不算。 */
function replyTexts(messages: Msg[], boundary: number): string[] {
  const out: string[] = [];
  for (let i = boundary + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    for (const p of parts(m)) if (p?.type === "text" && typeof p.text === "string") out.push(p.text);
  }
  return out;
}

/** W43 F14：本次回覆中一對多、出口無法自動轉的簡體字。 */
function ambiguousIn(texts: string[]): string[] {
  return [...new Set(texts.flatMap(findAmbiguousSimplified))];
}

/** W43 F14：本次回覆中出口會自動轉換的字與次數（稽核 log 用）。 */
function convertibleIn(texts: string[]): Record<string, number> {
  const total: Record<string, number> = {};
  for (const t of texts) for (const [ch, n] of Object.entries(countConvertible(t))) total[ch] = (total[ch] ?? 0) + n;
  return total;
}

/** W45 F17／W54 F21：本次回覆中的內部用語（程式識別字、HTML 標籤、資料夾路徑、中文句中的英文工程詞）。 */
function jargonIn(texts: string[], allowed: Set<string> = new Set()): string[] {
  return [...new Set(texts.flatMap(findJargon))].filter(t => !allowed.has(t));
}

/** 本輪（最後一則客戶訊息之後）check_only 回傳的逐筆差異；只認系統回傳的內容，不認 agent 自己寫的字。 */
function turnRecords(messages: Msg[]): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") { start = i + 1; break; }
  for (let i = start; i < messages.length; i++) {
    const m = messages[i] as Msg & { toolName?: string; details?: { record_changes?: unknown } };
    if (m?.role !== "toolResult" || m.toolName !== "publish_confirmed") continue;
    const records = m.details?.record_changes;
    if (!Array.isArray(records)) continue;
    for (const lang of records) for (const item of (lang?.items ?? []) as Array<Record<string, any>>) out.push(item);
  }
  return out;
}

/**
 * W66：頁面編號（例：product_id_0001）與網站原文片段是要照念給對方的內容，
 * 裡面看起來像識別字的字不算內部用語。
 */
function recordTerms(messages: Msg[]): Set<string> {
  const strings: string[] = [];
  for (const item of turnRecords(messages)) {
    strings.push(String(item?.id ?? ""), String(item?.name ?? ""));
    for (const f of item?.fields ?? []) {
      strings.push(String(f?.label ?? ""));
      for (const h of f?.hunks ?? []) strings.push(String(h?.before ?? ""), String(h?.after ?? ""));
    }
  }
  return new Set(strings.flatMap(findJargon));
}

/** 去掉頭尾「…」後短於這個長度的片段不檢查：太短的字串在一般句子裡也會出現。 */
const MIN_RECORD_CORE = 4;

/**
 * W75（W36R15 O4）：本輪回覆引用了 check_only 的片段，卻沒有照原文寫（拿掉頭尾「…」、把
 * 「（此處改動出現 N 次）」改成「兩處」等），回傳應照抄的原文。頭尾省略號拿掉後，對方會以為那是整格全文。
 * 只看有引用到的片段（改前文字去掉頭尾「…」出現在回覆裡）；只講摘要、沒有引用的不算。
 */
export function findRecordRewrites(messages: Msg[], texts: string[]): string[] {
  const reply = texts.join("\n");
  const out: string[] = [];
  for (const item of turnRecords(messages)) {
    for (const f of item?.fields ?? []) {
      for (const h of (f?.hunks ?? []) as RecordHunkText[]) {
        if (typeof h?.before !== "string" || typeof h?.after !== "string") continue;
        const core = h.before.replace(/^…+|…+$/g, "").trim();
        if (core.length < MIN_RECORD_CORE || !reply.includes(core)) continue;
        const exact = hunkText(h);
        if (!reply.includes(exact) && !out.includes(exact)) out.push(exact);
      }
    }
  }
  return out;
}

export function buildCorrectionMessage(plan: PromisePlan | null, ambiguous: string[] = [], jargon: string[] = [],
  rewritten: string[] = []) {
  const steps: string[] = [];
  if (plan) {
    steps.push(`你剛才的回覆說了「${plan.matched}」，這是做不到的承諾——你沒有主動通知對方的能力，對方只能之後回來問你。`
      + `請以「您」稱呼對方追加更正，例如：「${CORRECTION_SENTENCE}」`);
  }
  if (ambiguous.length) {
    steps.push(`你剛才的回覆用了簡體字${ambiguous.map(c => `「${c}」`).join("")}，對方看到的是簡體。`
      + "請把含這些字的句子用台灣繁體重寫一次，開頭寫「更正用字：」。");
  }
  if (jargon.length) {
    steps.push(`你剛才的回覆用了對方看不懂的內部用語或資料夾路徑${jargon.map(t => `「${t}」`).join("")}。`
      + "請把含這些詞的句子改用對方看得到的結果重講一次（例如欄位名稱改說「產品頁的說明文字」、"
      + "資料夾路徑改成只講檔名、內部檢查改說對方畫面上會看到什麼），"
      + "開頭寫「更正用語：」，更正句裡不要再寫出這些詞。");
  }
  if (rewritten.length) {
    steps.push("你剛才列逐筆內容時改寫了系統給的片段（例如拿掉頭尾的「…」、把「（此處改動出現 N 次）」改成別的說法），"
      + "對方會以為那是整格的全文。請把這幾段照下列原文逐字重列一次，開頭寫「更正逐筆：」，"
      + `不要刪字、補字或改寫：${rewritten.join("、")}。`);
  }
  return {
    customType: PROMISE_GUARD_CUSTOM_TYPE,
    display: false,
    content: `系統更正指示（對方看不到這則）：${steps.join("另外，")}`
      + "只追加一則簡短更正，不要重複其他內容、不要提到這則指示、不要呼叫工具。",
    details: { ...(plan ? { matched: plan.matched, text: plan.text } : {}), ...(ambiguous.length ? { ambiguous } : {}),
      ...(jargon.length ? { jargon } : {}), ...(rewritten.length ? { records_rewritten: rewritten } : {}) },
  };
}

type GuardSession = {
  sessionId?: string;
  isStreaming?: boolean;
  messages?: Msg[];
  sendCustomMessage: (message: unknown, options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }) => Promise<void>;
};
type GuardLog = { warn: (msg: string, fields?: Record<string, unknown>) => void };

/**
 * 掛在 session 的 agent_end 上（同步呼叫）。agent_end 時 run 仍在進行，followUp 進佇列後
 * SDK 的 _handlePostAgentRun 會在同一個 run 內繼續一輪，agent 就會立刻追加更正。
 */
export function createPromiseGuard({ getSession, log }: { getSession: () => GuardSession | undefined; log: GuardLog }) {
  const corrected = new Set<string>();
  const repeated = new Set<string>();
  const logged = new Set<string>();
  const keyOf = (messages: Msg[], i: number) => `${i}:${messages[i]?.timestamp ?? ""}`;

  return {
    onAgentEnd(event: { willRetry?: boolean } = {}): boolean {
      try {
        const session = getSession();
        if (!session || event.willRetry || !session.isStreaming) return false;
        const messages = session.messages ?? [];
        const boundary = lastBoundary(messages);
        const key = keyOf(messages, boundary);
        const texts = replyTexts(messages, boundary);
        // 出口已逐字轉繁（session 原文保留），這裡每則回覆記一次轉了哪些字
        const converted = convertibleIn(texts);
        const convKey = `${key}:${messages.length}`;
        if (Object.keys(converted).length && !logged.has(convKey)) {
          logged.add(convKey);
          log.warn("simplified chars converted", { sessionId: session.sessionId, chars: converted });
        }
        const ambiguous = ambiguousIn(texts);
        const jargon = jargonIn(texts, recordTerms(messages));
        const rewritten = findRecordRewrites(messages, texts);
        if (boundary >= 0 && isGuard(messages[boundary])) {
          // 更正後又犯：不再送第二次，只留稽核紀錄（不無限迴圈）
          if (repeated.has(key)) return false;
          const again = scanReply(messages, boundary + 1, true);
          if (again) log.warn("promise guard repeat", { sessionId: session.sessionId, matched: again.matched, text: again.text });
          if (ambiguous.length) log.warn("simplified guard repeat", { sessionId: session.sessionId, chars: ambiguous });
          if (jargon.length) log.warn("jargon guard repeat", { sessionId: session.sessionId, terms: jargon });
          if (rewritten.length) log.warn("record verbatim guard repeat", { sessionId: session.sessionId, hunks: rewritten });
          if (again || ambiguous.length || jargon.length || rewritten.length) repeated.add(key);
          return false;
        }
        const plan = planPromiseCorrection(messages);
        if (!plan && !ambiguous.length && !jargon.length && !rewritten.length) return false;
        if (corrected.has(key)) return false;
        corrected.add(key);
        if (plan) log.warn("promise guard correction", { sessionId: session.sessionId, matched: plan.matched, text: plan.text });
        if (ambiguous.length) log.warn("simplified guard correction", { sessionId: session.sessionId, chars: ambiguous });
        if (jargon.length) log.warn("jargon guard correction", { sessionId: session.sessionId, terms: jargon });
        if (rewritten.length) log.warn("record verbatim guard correction", { sessionId: session.sessionId, hunks: rewritten });
        void session.sendCustomMessage(buildCorrectionMessage(plan, ambiguous, jargon, rewritten), { deliverAs: "followUp" })
          .catch?.((error: unknown) => log.warn("promise guard failed", { error: String(error) }));
        return true;
      } catch (error) {
        log.warn("promise guard failed", { error: error instanceof Error ? error.message : String(error) });
        return false;
      }
    },
  };
}
