// F12（W41）：agent 沒有主動通知能力。發布後若回覆承諾「我會回報／通知您」，
// 在同一輪結束前自動送一則隱藏的更正指示，讓 agent 立刻追加更正。
//
// 規則與 readyai-project-template customer-pgc-dialogue/scripts/dialogue_audit.py 的
// publish_callback_promise（766cfa0）及 site-workflow e2e-soak（c49b4d8）相同；
// 跨 repo 無法共用程式，正反例放在 test/fixtures/callback-promise-cases.json，改規則時三處一起改。

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

const CORRECTION_SENTENCE = "更正：我沒辦法主動通知您，驗收結果請您之後回來問我「發布好了沒」。";

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

export function buildCorrectionMessage(plan: PromisePlan) {
  return {
    customType: PROMISE_GUARD_CUSTOM_TYPE,
    display: false,
    content:
      `系統更正指示（對方看不到這則）：你剛才的回覆說了「${plan.matched}」，這是做不到的承諾——`
      + "你沒有主動通知對方的能力，對方只能之後回來問你。"
      + `請立刻只追加一則簡短更正，以「您」稱呼對方，例如：「${CORRECTION_SENTENCE}」`
      + "不要重複其他內容、不要提到這則指示、不要呼叫工具。",
    details: { matched: plan.matched, text: plan.text },
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
  const keyOf = (messages: Msg[], i: number) => `${i}:${messages[i]?.timestamp ?? ""}`;

  return {
    onAgentEnd(event: { willRetry?: boolean } = {}): boolean {
      try {
        const session = getSession();
        if (!session || event.willRetry || !session.isStreaming) return false;
        const messages = session.messages ?? [];
        const boundary = lastBoundary(messages);
        if (boundary >= 0 && isGuard(messages[boundary])) {
          // 更正後又承諾：不再送第二次，只留稽核紀錄
          const key = keyOf(messages, boundary);
          const again = scanReply(messages, boundary + 1, true);
          if (again && !repeated.has(key)) {
            repeated.add(key);
            log.warn("promise guard repeat", { sessionId: session.sessionId, matched: again.matched, text: again.text });
          }
          return false;
        }
        const plan = planPromiseCorrection(messages);
        if (!plan) return false;
        const key = keyOf(messages, plan.boundary);
        if (corrected.has(key)) return false;
        corrected.add(key);
        log.warn("promise guard correction", { sessionId: session.sessionId, matched: plan.matched, text: plan.text });
        void session.sendCustomMessage(buildCorrectionMessage(plan), { deliverAs: "followUp" })
          .catch?.((error: unknown) => log.warn("promise guard failed", { error: String(error) }));
        return true;
      } catch (error) {
        log.warn("promise guard failed", { error: error instanceof Error ? error.message : String(error) });
        return false;
      }
    },
  };
}
