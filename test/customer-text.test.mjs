// W43 F14／F13：customer 出口的簡體字轉換與附件區塊去路徑。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  convertSimplified,
  convertSimplifiedDelta,
  findAmbiguousSimplified,
  countConvertible,
  scrubAttachmentNotice,
} from "../dist/server/customer-text.js";
import { parseUiProfile, filterEvent, filterMessageHistory } from "../dist/server/ui-profile.js";
import { enforceCustomerUiProfile } from "../dist/server/customer-policy.js";

const cases = JSON.parse(readFileSync(new URL("./fixtures/simplified-cases.json", import.meta.url), "utf-8"));

for (const [input, expected] of [...cases.convert, ...cases.code]) {
  test(`convertSimplified：${JSON.stringify(input).slice(0, 30)}`, () => {
    assert.equal(convertSimplified(input), expected);
  });
}
for (const input of cases.unchanged) {
  test(`convertSimplified 不動繁體也會用的字：${input.slice(0, 16)}`, () => {
    assert.equal(convertSimplified(input), input);
    assert.deepEqual(findAmbiguousSimplified(input), []);
  });
}
for (const [input, expected, ambiguous] of cases.ambiguous) {
  test(`一對多不自動轉、回報給重寫：${input}`, () => {
    assert.equal(convertSimplified(input), expected);
    assert.deepEqual(findAmbiguousSimplified(input), ambiguous);
  });
}

test("findAmbiguousSimplified：程式碼內不算", () => {
  assert.deepEqual(findAmbiguousSimplified("指令 `git 发布`"), []);
});

test("countConvertible：回傳字與次數（稽核用），程式碼內不算", () => {
  assert.deepEqual(countConvertible("满满的 `满` 机"), { 满: 2, 机: 1 });
  assert.deepEqual(countConvertible("全部繁體"), {});
});

test("convertSimplifiedDelta：依累積全文判斷程式碼範圍，串流與最終結果一致", () => {
  const full = "看 `满` 后满意";
  const chunks = ["看 `", "满` 后", "满意"];
  let acc = "";
  let streamed = "";
  for (const c of chunks) {
    acc += c;
    streamed += convertSimplifiedDelta(acc, c);
  }
  assert.equal(streamed, convertSimplified(full));
  assert.equal(streamed, "看 `满` 后滿意");
});

test("convertSimplifiedDelta：沒有累積全文時以 delta 本身轉換", () => {
  assert.equal(convertSimplifiedDelta(undefined, "满意"), "滿意");
});

test("scrubAttachmentNotice：只留檔名，不露伺服器路徑", () => {
  const text = "請放這張圖\n\n[Attached files]\n- a.png -> /var/www/html/customer-project/x/uploads/customer/a.png\n- b c.pdf -> /var/www/html/u/b c.pdf";
  assert.equal(scrubAttachmentNotice(text), "請放這張圖\n\n附件：\n- a.png\n- b c.pdf");
  assert.equal(scrubAttachmentNotice("[Attached files]\n- a.png -> /x/a.png"), "附件：\n- a.png");
  assert.equal(scrubAttachmentNotice("沒有附件 -> 也不動"), "沒有附件 -> 也不動");
});

const customer = () => enforceCustomerUiProfile(parseUiProfile({ uiProfile: "customer" }, {}), true);
const staff = () => parseUiProfile({}, {});

test("customer：assistant text_delta 與 partial 快照都轉成繁體", () => {
  const partial = { role: "assistant", content: [{ type: "text", text: "看起來满意" }] };
  const ev = { type: "message_update", message: partial,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "满意", partial } };
  const out = filterEvent(ev, customer());
  assert.equal(out.event.assistantMessageEvent.delta, "滿意");
  assert.equal(out.event.assistantMessageEvent.partial.content[0].text, "看起來滿意");
  assert.equal(out.event.message.content[0].text, "看起來滿意");
  // 原 event 不被改（session 原文保留）
  assert.equal(ev.assistantMessageEvent.delta, "满意");
  assert.equal(partial.content[0].text, "看起來满意");
});

test("customer：text_end 的 content 與 message_end 也轉", () => {
  const msg = { role: "assistant", content: [{ type: "text", text: "满意" }] };
  const end = filterEvent({ type: "message_update", message: msg,
    assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "满意", partial: msg } }, customer());
  assert.equal(end.event.assistantMessageEvent.content, "滿意");
  const me = filterEvent({ type: "message_end", message: msg }, customer());
  assert.equal(me.event.message.content[0].text, "滿意");
});

test("customer：歷史訊息的 assistant 文字轉繁、客戶附件區塊去路徑；工具參數不碰", () => {
  const history = [
    { role: "user", content: "放圖\n\n[Attached files]\n- a.png -> /var/www/html/up/a.png" },
    { role: "user", content: [{ type: "text", text: "[Attached files]\n- b.png -> /srv/b.png" }] },
    { role: "assistant", content: [{ type: "text", text: "满意" }, { type: "toolCall", name: "bash", arguments: { cmd: "echo 满" } }] },
  ];
  const out = filterMessageHistory(history, customer());
  assert.equal(out[0].content, "放圖\n\n附件：\n- a.png");
  assert.equal(out[1].content[0].text, "附件：\n- b.png");
  assert.deepEqual(out[2].content, [{ type: "text", text: "滿意" }]);
  assert.equal(history[0].content.includes("/var/www/html"), true, "session 原文保留");
});

test("customer：user message_start／message_end 事件的附件區塊去路徑", () => {
  const ev = { type: "message_start", message: { role: "user", content: "x\n\n[Attached files]\n- a.png -> /var/www/a.png" } };
  assert.equal(filterEvent(ev, customer()).event.message.content, "x\n\n附件：\n- a.png");
});

test("customer：publish_confirmed／publication_status 原始結果不送客戶，改送進度標籤", () => {
  const p = customer();
  assert.deepEqual(p.showToolResultsFor, []);
  for (const toolName of ["publish_confirmed", "publication_status"]) {
    const end = filterEvent({ type: "tool_execution_end", toolCallId: "t1", toolName,
      result: { content: [{ type: "text", text: "{\"candidate_digest\":\"abc\",\"path\":\"Templates/pic/a.png\"}" }] } }, p);
    assert.equal(end.kind, "tool_progress");
    assert.doesNotMatch(JSON.stringify(end), /candidate_digest|Templates\//);
    const start = filterEvent({ type: "tool_execution_start", toolCallId: "t1", toolName, args: {} }, p);
    assert.match(start.payload.label, toolName === "publish_confirmed" ? /發布/ : /查詢發布狀態/);
  }
  const hist = filterMessageHistory([{ role: "toolResult", toolName: "publish_confirmed", content: [{ type: "text", text: "{}" }] }], p);
  assert.deepEqual(hist, []);
});

test("staff：不轉換、不去路徑、工具結果白名單照舊", () => {
  const p = staff();
  assert.deepEqual(p.showToolResultsFor, ["publish_confirmed", "publication_status"]);
  const ev = { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "满" }] },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "满" } };
  assert.equal(filterEvent(ev, p).event.assistantMessageEvent.delta, "满");
  const hist = [{ role: "user", content: "[Attached files]\n- a.png -> /x/a.png" }];
  assert.equal(filterMessageHistory(hist, p)[0].content, "[Attached files]\n- a.png -> /x/a.png");
});
