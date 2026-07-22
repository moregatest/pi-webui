// #102:customer 模式 custom(extension pi.sendMessage 注入)訊息出口政策——fail-closed。
// 允許清單(readyai_customer_ 前綴)轉 assistant 泡泡;其餘(readyai_bootstrap_notice
// 等內部工程訊息)整則 drop,不落客戶介面。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseUiProfile,
  filterEvent,
  filterMessageHistory,
} from "../dist/server/ui-profile.js";

const customerProfile = () => parseUiProfile({ uiProfile: "customer" }, {});
const devProfile = () => parseUiProfile({}, {});

const notice = {
  role: "custom",
  customType: "readyai_bootstrap_notice",
  content: [{ type: "text", text: "# ReadyAI 專案啟動檢查\ngit clone …readyscript-docker" }],
  timestamp: "t1",
};
const intro = {
  role: "custom",
  customType: "readyai_customer_intro",
  content: "您好！我是網站助理",
  timestamp: "t2",
};

test("customer preset 開啟 restrictCustomMessages;預設關", () => {
  assert.equal(customerProfile().restrictCustomMessages, true);
  assert.equal(devProfile().restrictCustomMessages, false);
});

test("profile toml [ui] restrict_custom_messages 可獨立開啟", () => {
  const p = parseUiProfile({}, {}, { ui: { restrict_custom_messages: true } });
  assert.equal(p.restrictCustomMessages, true);
});

test("filterMessageHistory: customer 模式 drop bootstrap notice", () => {
  const out = filterMessageHistory(
    [notice, { role: "user", content: [{ type: "text", text: "hi" }] }],
    customerProfile(),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "user");
});

test("filterMessageHistory: readyai_customer_ 前綴轉 assistant(string content 轉 text block)", () => {
  const out = filterMessageHistory([intro], customerProfile());
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "assistant");
  assert.deepEqual(out[0].content, [{ type: "text", text: "您好！我是網站助理" }]);
});

test("filterMessageHistory: 非 customer 模式 custom 原樣保留", () => {
  const out = filterMessageHistory([notice], devProfile());
  assert.equal(out.length, 1);
  assert.equal(out[0].role, "custom");
});

test("filterEvent: message_end 挾帶 notice → 整個 event drop", () => {
  const r = filterEvent({ type: "message_end", message: notice }, customerProfile());
  assert.equal(r, null);
});

test("filterEvent: message_end 挾帶 intro → message 轉 assistant", () => {
  const r = filterEvent({ type: "message_end", message: intro }, customerProfile());
  assert.equal(r.kind, "event");
  assert.equal(r.event.message.role, "assistant");
});

test("filterEvent: messages[] 快照內 notice 剝除、intro 轉 assistant", () => {
  const r = filterEvent({ type: "agent_end", messages: [notice, intro] }, customerProfile());
  assert.equal(r.kind, "event");
  assert.equal(r.event.messages.length, 1);
  assert.equal(r.event.messages[0].role, "assistant");
});
