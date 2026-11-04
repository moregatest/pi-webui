// W45 F17：客戶回覆出現程式識別字（snake_case、含點號的欄位路徑）時，同一輪請 agent
// 以「更正用語：」改用客戶聽得懂的說法重講（最多一次）。單字表名（product 等）不偵測，
// 由技能端處理（controller 決定）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findInternalIdentifiers } from "../dist/server/jargon.js";
import { createPromiseGuard, PROMISE_GUARD_CUSTOM_TYPE } from "../dist/server/promise-guard.js";

const cases = JSON.parse(readFileSync(new URL("./fixtures/jargon-cases.json", import.meta.url), "utf-8"));

for (const [text, expected] of cases.hit) {
  test(`命中內部識別字：${text.slice(0, 24)}`, () => {
    assert.deepEqual(findInternalIdentifiers(text), expected);
  });
}
for (const text of cases.clean) {
  test(`不誤判：${text.slice(0, 24).replace(/\n/g, " ")}`, () => {
    assert.deepEqual(findInternalIdentifiers(text), []);
  });
}

test("單字表名不偵測（技能端處理）", () => {
  assert.deepEqual(findInternalIdentifiers("這段在 product 表、product_category 是分類表"), ["product_category"]);
  assert.deepEqual(findInternalIdentifiers("這段存在 product 表"), []);
});

const user = (text, timestamp = 1) => ({ role: "user", content: text, timestamp });
const say = (text, timestamp = 10) => ({ role: "assistant", content: [{ type: "text", text }], timestamp });
const callPublish = () => ({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "publish_confirmed", arguments: {} }], timestamp: 5 });

function setup(messages) {
  const sent = [];
  const session = {
    sent, sessionId: "s-1", isStreaming: true, messages,
    sendCustomMessage(message, options) {
      sent.push({ message, options });
      messages.push({ role: "custom", ...message, timestamp: 100 + sent.length });
      return Promise.resolve();
    },
  };
  const logs = [];
  const guard = createPromiseGuard({ getSession: () => session, log: { warn: (m, f) => logs.push([m, f]) } });
  return { session, logs, guard };
}

test("回覆出現 desc_html → 送隱藏更正指示（更正用語：），記 log", () => {
  const { session, logs, guard } = setup([user("把圖放進說明"), say("產品說明內文在 `desc_html` 欄位，我放好了。")]);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), true);
  assert.equal(session.sent.length, 1);
  const { message, options } = session.sent[0];
  assert.equal(message.customType, PROMISE_GUARD_CUSTOM_TYPE);
  assert.equal(message.display, false);
  assert.match(message.content, /「desc_html」/);
  assert.match(message.content, /更正用語：/);
  assert.deepEqual(message.details.jargon, ["desc_html"]);
  assert.equal(options.deliverAs, "followUp");
  const hit = logs.find(l => l[0] === "jargon guard correction");
  assert.ok(hit);
  assert.deepEqual(hit[1].terms, ["desc_html"]);
});

test("承諾、一對多簡體字、內部識別字同時出現 → 合併成一則，只送一次", () => {
  const { session, logs, guard } = setup([user("確認發布"), callPublish(),
    say("已发出 candidate_digest 比對過了，等驗收完成，我會回報結果給您。")]);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), true);
  assert.equal(session.sent.length, 1);
  const { message } = session.sent[0];
  assert.match(message.content, /我會回報/);
  assert.match(message.content, /「发」/);
  assert.match(message.content, /「candidate_digest」/);
  assert.deepEqual(message.details.jargon, ["candidate_digest"]);
  const names = logs.map(l => l[0]);
  for (const n of ["promise guard correction", "simplified guard correction", "jargon guard correction"]) assert.ok(names.includes(n), n);
});

test("更正後仍出現識別字 → 不送第二次，只記一次 jargon guard repeat", () => {
  const messages = [user("改說明"), say("改好了 desc_html。")];
  const { session, logs, guard } = setup(messages);
  guard.onAgentEnd({ type: "agent_end" });
  messages.push(say("更正用語：我是說 desc_html 那段。", 200));
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), false);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), false);
  assert.equal(session.sent.length, 1);
  assert.equal(logs.filter(l => l[0] === "jargon guard repeat").length, 1);
});

test("thinking、工具參數、程式碼區塊內的識別字不算", () => {
  const msg = { role: "assistant", timestamp: 9, content: [
    { type: "thinking", thinking: "要改 desc_html" },
    { type: "toolCall", name: "bash", arguments: { cmd: "update desc_html" } },
    { type: "text", text: "已更新說明文字。\n```\ndesc_html\n```" },
  ] };
  const { session, guard } = setup([user("改說明"), msg]);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), false);
  assert.equal(session.sent.length, 0);
});

test("沒有識別字 → 不多跑一輪", () => {
  const { session, logs, guard } = setup([user("改說明"), say("產品頁的說明文字已更新，圖片 shape_of_masks.jpg 也放好了。")]);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), false);
  assert.equal(session.sent.length, 0);
  assert.deepEqual(logs, []);
});

// W54 F21：HTML 標籤、資料夾路徑、中文句中的英文工程詞（正反例與 site-workflow 共用）
import { findJargon, ENGINEERING_TERMS } from "../dist/server/jargon.js";

test("工程詞表與共用 fixture 一致", () => {
  assert.deepEqual([...ENGINEERING_TERMS], cases.engineering_terms);
});
for (const [text, expected] of cases.jargon.hit) {
  test(`findJargon 命中：${text.slice(0, 24)}`, () => {
    assert.deepEqual(findJargon(text), expected);
  });
}
for (const text of cases.jargon.clean) {
  test(`findJargon 不誤判：${text.slice(0, 24).replace(/\n/g, " ")}`, () => {
    assert.deepEqual(findJargon(text), []);
  });
}

test("W36R10 原句 → 合併指示「更正用語：」，列出 <div> 與 sanity check", () => {
  const { session, logs, guard } = setup([user("刪除 SVG"),
    say("我的處理流程中有一個 sanity check 寫得太嚴格了（預期整體 `<div>` 的數量應保持不變……）")]);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), true);
  const { message } = session.sent[0];
  assert.match(message.content, /「<div>」「sanity check」/);
  assert.match(message.content, /更正用語：/);
  assert.deepEqual(message.details.jargon, ["<div>", "sanity check"]);
  assert.deepEqual(logs.find(l => l[0] === "jargon guard correction")[1].terms, ["<div>", "sanity check"]);
});

test("回覆出現資料夾路徑 → 同一輪更正", () => {
  const { session, guard } = setup([user("刪掉上傳的檔案"), say("已刪除 `uploads/customer/` 底下的 11 個檔案。")]);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), true);
  assert.deepEqual(session.sent[0].message.details.jargon, ["uploads/customer/"]);
});
