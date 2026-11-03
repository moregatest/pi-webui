// W43 F14：一對多的簡體字無法在出口自動轉，沿用 W41 reply guard 同一輪請 agent 以繁體重寫（最多一次）；
// 會自動轉換的字記 log「simplified chars converted」（字與次數）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPromiseGuard, PROMISE_GUARD_CUSTOM_TYPE } from "../dist/server/promise-guard.js";

const user = (text, timestamp = 1) => ({ role: "user", content: text, timestamp });
const say = (text, timestamp = 10) => ({ role: "assistant", content: [{ type: "text", text }], timestamp });
const callPublish = () => ({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "publish_confirmed", arguments: {} }], timestamp: 5 });

function fakeSession(messages) {
  const sent = [];
  return {
    sent, sessionId: "s-1", isStreaming: true, messages,
    sendCustomMessage(message, options) {
      sent.push({ message, options });
      messages.push({ role: "custom", ...message, timestamp: 100 + sent.length });
      return Promise.resolve();
    },
  };
}
const setup = (messages) => {
  const session = fakeSession(messages);
  const logs = [];
  const guard = createPromiseGuard({ getSession: () => session, log: { warn: (m, f) => logs.push([m, f]) } });
  return { session, logs, guard };
};

test("一對多簡體字（不需發布情境）→ 送隱藏重寫指示", () => {
  const { session, logs, guard } = setup([user("幫我改文案"), say("已经发布了，您看一下。")]);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), true);
  assert.equal(session.sent.length, 1);
  const { message, options } = session.sent[0];
  assert.equal(message.customType, PROMISE_GUARD_CUSTOM_TYPE);
  assert.equal(message.display, false);
  assert.match(message.content, /「发」/);
  assert.match(message.content, /台灣繁體/);
  assert.deepEqual(message.details.ambiguous, ["发"]);
  assert.equal(options.deliverAs, "followUp");
  const names = logs.map(l => l[0]);
  assert.ok(names.includes("simplified guard correction"));
  assert.ok(names.includes("simplified chars converted"));
  const conv = logs.find(l => l[0] === "simplified chars converted")[1];
  assert.deepEqual(conv.chars, { 经: 1 });
});

test("承諾與一對多簡體字同時出現 → 合併成一則指示，只送一次", () => {
  const { session, guard } = setup([user("確認發布"), callPublish(), say("已发出，等驗收完成，我會回報結果給您。")]);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), true);
  assert.equal(session.sent.length, 1);
  const { message } = session.sent[0];
  assert.match(message.content, /我會回報/);
  assert.match(message.content, /「发」/);
  assert.equal(message.details.matched, "我會回報");
  assert.deepEqual(message.details.ambiguous, ["发"]);
});

test("重寫後仍有一對多簡體字 → 不再送第二次，只記 log", () => {
  const messages = [user("改文案"), say("已经发布了")];
  const { session, logs, guard } = setup(messages);
  guard.onAgentEnd({ type: "agent_end" });
  messages.push(say("更正用字：已发布。", 200));
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), false);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), false);
  assert.equal(session.sent.length, 1);
  assert.equal(logs.filter(l => l[0] === "simplified guard repeat").length, 1);
});

test("只有一對一的字 → 出口已轉，不要求重寫，只記一次轉換 log", () => {
  const { session, logs, guard } = setup([user("改文案"), say("看起來满意吗？")]);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), false);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), false);
  assert.equal(session.sent.length, 0);
  const conv = logs.filter(l => l[0] === "simplified chars converted");
  assert.equal(conv.length, 1);
  assert.deepEqual(conv[0][1].chars, { 满: 1, 吗: 1 });
});

test("程式碼區塊與 thinking 內的簡體字不算", () => {
  const thinking = { role: "assistant", content: [{ type: "thinking", thinking: "发" }, { type: "text", text: "指令是 `git 发布`。" }], timestamp: 9 };
  const { session, logs, guard } = setup([user("改文案"), thinking]);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), false);
  assert.equal(session.sent.length, 0);
  assert.deepEqual(logs, []);
});
