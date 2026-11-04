// W75（W36R15 O4）：check_only 逐筆片段要照工具原文列給對方（含頭尾「…」與「（此處改動出現 N 次）」）。
// agent 引用了片段卻改寫（拿掉省略號、把次數改成「兩處」）時，同一輪請它以「更正逐筆：」照原文重列（最多一次）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPromiseGuard, findRecordRewrites } from "../dist/server/promise-guard.js";

const user = (text, timestamp = 1) => ({ role: "user", content: text, timestamp });
const say = (text, timestamp = 10) => ({ role: "assistant", content: [{ type: "text", text }], timestamp });
const checkOnlyCall = () => ({ role: "assistant", content: [{ type: "toolCall", id: "c2", name: "publish_confirmed", arguments: { check_only: true } }], timestamp: 5 });
const recordResult = (records) => ({ role: "toolResult", toolCallId: "c2", toolName: "publish_confirmed",
  content: [{ type: "text", text: JSON.stringify({ ok: true, record_changes: records }) }],
  details: { ok: true, status: "pending_confirmation", record_changes: records }, timestamp: 6 });

// W36R15 實際的 check_only 結果
const RECORDS = [{ lng: "en", total: 1, listed: 1, truncated: false, items: [{ table_label: "產品", id: "a010205",
  name: "Blackhead Peel Off Mask Manufacturing", action: "update", fields: [{ label: "詳細說明", hunks: [
    { before: "…1st step ／ 2nd step…", after: "…1st Step ／ 2nd Step…" },
    { before: "…Cold Facial Musk or Gel for…", after: "…Cold Facial Mask or Gel for…", count: 2 }] }] }] }];
const EXACT_1 = "「…1st step ／ 2nd step…」→「…1st Step ／ 2nd Step…」";
const EXACT_2 = "「…Cold Facial Musk or Gel for…」→「…Cold Facial Mask or Gel for…」（此處改動出現 2 次）";

// W36R15 確認畫面上 agent 實際的寫法
const REWRITTEN = "產品頁 a010205〈Blackhead Peel Off Mask Manufacturing〉——詳細說明：\n"
  + "「1st step ／ 2nd step」→「1st Step ／ 2nd Step」\n"
  + "「Cold Facial Musk or Gel for…」→「Cold Facial Mask or Gel for…」（兩處）\n請您回覆「確認發布」。";
const VERBATIM = `產品頁 a010205〈Blackhead Peel Off Mask Manufacturing〉——詳細說明：\n${EXACT_1}\n${EXACT_2}\n請您回覆「確認發布」。`;

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
  return { session, guard, logs };
}

test("W36R15 拿掉省略號、次數改成「兩處」→ 列出應照抄的原文", () => {
  const messages = [user("發布前先讓我看"), checkOnlyCall(), recordResult(RECORDS), say(REWRITTEN)];
  assert.deepEqual(findRecordRewrites(messages, [REWRITTEN]), [EXACT_1, EXACT_2]);
});

test("照原文列出（含省略號與次數說明）→ 不更正", () => {
  const { session, guard } = setup([user("發布前先讓我看"), checkOnlyCall(), recordResult(RECORDS), say(VERBATIM)]);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), false);
  assert.equal(session.sent.length, 0);
});

test("只拿掉次數說明也算改寫", () => {
  const text = `${EXACT_1}\n「…Cold Facial Musk or Gel for…」→「…Cold Facial Mask or Gel for…」`;
  assert.deepEqual(findRecordRewrites([user("看"), checkOnlyCall(), recordResult(RECORDS), say(text)], [text]), [EXACT_2]);
});

test("改寫時同一輪送一次更正，附上應照抄的原文", () => {
  const { session, guard, logs } = setup([user("發布前先讓我看"), checkOnlyCall(), recordResult(RECORDS), say(REWRITTEN)]);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), true);
  const { message, options } = session.sent[0];
  assert.equal(options.deliverAs, "followUp");
  assert.equal(message.display, false);
  assert.match(message.content, /更正逐筆：/);
  assert.ok(message.content.includes(EXACT_1) && message.content.includes(EXACT_2));
  assert.deepEqual(message.details.records_rewritten, [EXACT_1, EXACT_2]);
  assert.ok(logs.some(l => l[0] === "record verbatim guard correction"));
  // 更正後又改寫：不送第二次，只留紀錄
  session.messages.push(say("更正逐筆：「1st step ／ 2nd step」→「1st Step ／ 2nd Step」", 200));
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), false);
  assert.equal(session.sent.length, 1);
  assert.ok(logs.some(l => l[0] === "record verbatim guard repeat"));
});

test("沒有引用片段（只講摘要）→ 不更正", () => {
  const text = "這次只改了這頁詳細說明的兩處文字（Mask 錯字、Step 大寫），請您回覆「確認發布」。";
  const { session, guard } = setup([user("發布前先讓我看"), checkOnlyCall(), recordResult(RECORDS), say(text)]);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), false);
  assert.equal(session.sent.length, 0);
});

test("上一輪的 check_only 結果不算：之後的對話引用片段不檢查", () => {
  const messages = [user("先讓我看", 0), checkOnlyCall(), recordResult(RECORDS), say(VERBATIM),
    user("剛剛 1st step 那格是什麼", 20), say("那格原本是「1st step ／ 2nd step」那兩格的表頭。", 30)];
  const { session, guard } = setup(messages);
  assert.equal(guard.onAgentEnd({ type: "agent_end" }), false);
  assert.equal(session.sent.length, 0);
});

test("很短的片段不檢查，避免把一般用字當成引用", () => {
  const records = [{ lng: "zh-TW", total: 1, listed: 1, truncated: false, items: [{ table_label: "產品", id: "a1", name: "眼罩",
    action: "update", fields: [{ label: "名稱", hunks: [{ before: "眼", after: "目" }] }] }] }];
  const text = "產品 a1〈眼罩〉的名稱改了一個字。";
  assert.deepEqual(findRecordRewrites([user("看"), checkOnlyCall(), recordResult(records), say(text)], [text]), []);
});
