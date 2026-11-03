import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  findCallbackPromise,
  planPromiseCorrection,
  createPromiseGuard,
  PROMISE_GUARD_CUSTOM_TYPE,
} from "../dist/server/promise-guard.js";

const cases = JSON.parse(readFileSync(new URL("./fixtures/callback-promise-cases.json", import.meta.url), "utf-8"));

for (const text of cases.promise) {
  test(`findCallbackPromise 命中：${text.slice(0, 24)}`, () => {
    assert.ok(findCallbackPromise(text));
  });
}
for (const text of cases.allowed) {
  test(`findCallbackPromise 放行：${text.slice(0, 24)}`, () => {
    assert.equal(findCallbackPromise(text), null);
  });
}

const user = (text, timestamp = 1) => ({ role: "user", content: text, timestamp });
const say = (text, timestamp = 10) => ({ role: "assistant", content: [{ type: "text", text }], timestamp });
const callPublish = (args = {}, timestamp = 5) => ({
  role: "assistant",
  content: [{ type: "toolCall", id: "c1", name: "publish_confirmed", arguments: args }],
  timestamp,
});
const toolResult = (timestamp = 6) => ({ role: "toolResult", toolCallId: "c1", toolName: "publish_confirmed", content: [], timestamp });
const I2 = "發布已送出。等驗收完成，我會回報結果給您。";

test("planPromiseCorrection：publish_confirmed 之後的回覆含承諾 → 要更正", () => {
  const plan = planPromiseCorrection([user("確認發布"), callPublish(), toolResult(), say(I2)]);
  assert.ok(plan);
  assert.match(plan.matched, /我會回報/);
  assert.equal(plan.text, I2);
  assert.equal(plan.boundary, 0);
});

test("planPromiseCorrection：同一則訊息先呼叫 publish_confirmed 再承諾也算", () => {
  const msg = { role: "assistant", content: [
    { type: "toolCall", id: "c1", name: "publish_confirmed", arguments: {} },
    { type: "text", text: I2 },
  ], timestamp: 5 };
  assert.ok(planPromiseCorrection([user("確認發布"), msg]));
});

test("planPromiseCorrection：沒呼叫過 publish_confirmed → 不更正（與 dialogue_audit 範圍一致）", () => {
  assert.equal(planPromiseCorrection([user("改一下文案"), say("我會通知您。")]), null);
});

test("planPromiseCorrection：只看本次回覆，上一輪的承諾不重複更正", () => {
  const messages = [user("確認發布", 1), callPublish(), toolResult(), say(I2, 7), user("好", 8), say("不客氣。", 9)];
  assert.equal(planPromiseCorrection(messages), null);
});

test("planPromiseCorrection：回覆對象是更正指示 → 不再更正（同一回覆最多一次）", () => {
  const correction = { role: "custom", customType: PROMISE_GUARD_CUSTOM_TYPE, content: "x", display: false, timestamp: 11 };
  const messages = [user("確認發布"), callPublish(), toolResult(), say(I2), correction, say("我之後再通知您。", 12)];
  assert.equal(planPromiseCorrection(messages), null);
});

test("planPromiseCorrection：thinking 不算對外說的話；放行句不算", () => {
  const thinking = { role: "assistant", content: [{ type: "thinking", thinking: "我會通知您" }, { type: "text", text: "完成後您問我就能看到結果。" }], timestamp: 9 };
  assert.equal(planPromiseCorrection([user("確認發布"), callPublish(), toolResult(), thinking]), null);
});

function fakeSession(messages, { streaming = true } = {}) {
  const sent = [];
  return {
    sent,
    sessionId: "s-1",
    isStreaming: streaming,
    messages,
    sendCustomMessage(message, options) {
      sent.push({ message, options });
      if (message) messages.push({ role: "custom", ...message, timestamp: 100 + sent.length });
      return Promise.resolve();
    },
  };
}

test("createPromiseGuard：命中時以 followUp 送隱藏更正指示並寫稽核 log", () => {
  const messages = [user("確認發布"), callPublish(), toolResult(), say(I2)];
  const session = fakeSession(messages);
  const logs = [];
  const guard = createPromiseGuard({ getSession: () => session, log: { warn: (m, f) => logs.push([m, f]) } });
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), true);
  assert.equal(session.sent.length, 1);
  const { message, options } = session.sent[0];
  assert.equal(message.customType, PROMISE_GUARD_CUSTOM_TYPE);
  assert.ok(!message.customType.startsWith("readyai_customer_"), "客戶出口會濾掉，客戶看不到指示本身");
  assert.equal(message.display, false);
  assert.match(message.content, /更正：我沒辦法主動通知您/);
  assert.match(message.content, /發布好了沒/);
  assert.equal(message.details.matched, "我會回報");
  assert.equal(options.deliverAs, "followUp");
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], "promise guard correction");
  assert.equal(logs[0][1].sessionId, "s-1");
  assert.match(logs[0][1].matched, /我會回報/);
});

test("createPromiseGuard：更正後 agent 又承諾 → 不再送第二次，只記 log（不無限迴圈）", () => {
  const messages = [user("確認發布"), callPublish(), toolResult(), say(I2)];
  const session = fakeSession(messages);
  const logs = [];
  const guard = createPromiseGuard({ getSession: () => session, log: { warn: (m, f) => logs.push([m, f]) } });
  guard.onAgentEnd({ type: "agent_end" });
  messages.push(say("好的，我之後會通知您。", 200));
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), false);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), false);
  assert.equal(session.sent.length, 1);
  assert.deepEqual(logs.map(l => l[0]), ["promise guard correction", "promise guard repeat"]);
});

test("createPromiseGuard：同一回覆重複觸發 agent_end 也只更正一次", () => {
  const messages = [user("確認發布"), callPublish(), toolResult(), say(I2)];
  const session = fakeSession(messages);
  session.sendCustomMessage = (message, options) => { session.sent.push({ message, options }); return Promise.resolve(); };
  const guard = createPromiseGuard({ getSession: () => session, log: { warn() {} } });
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), true);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), false);
  assert.equal(session.sent.length, 1);
});

test("createPromiseGuard：將自動重試、沒有串流中、沒有承諾 → 不動作", () => {
  const promised = () => [user("確認發布"), callPublish(), toolResult(), say(I2)];
  const s1 = fakeSession(promised());
  const g1 = createPromiseGuard({ getSession: () => s1, log: { warn() {} } });
  assert.equal(g1.onAgentEnd({ type: "agent_end", willRetry: true }), false);
  const s2 = fakeSession(promised(), { streaming: false });
  const g2 = createPromiseGuard({ getSession: () => s2, log: { warn() {} } });
  assert.equal(g2.onAgentEnd({ type: "agent_end" }), false);
  const s3 = fakeSession([user("確認發布"), callPublish(), toolResult(), say("發布已送出，完成後您問我就能看到結果。")]);
  const g3 = createPromiseGuard({ getSession: () => s3, log: { warn() {} } });
  assert.equal(g3.onAgentEnd({ type: "agent_end" }), false);
  assert.equal(s1.sent.length + s2.sent.length + s3.sent.length, 0);
});

test("createPromiseGuard：送出失敗不影響宿主", () => {
  const session = fakeSession([user("確認發布"), callPublish(), toolResult(), say(I2)]);
  session.sendCustomMessage = () => { throw new Error("boom"); };
  const logs = [];
  const guard = createPromiseGuard({ getSession: () => session, log: { warn: (m) => logs.push(m) } });
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), false);
  assert.ok(logs.includes("promise guard failed"));
});
