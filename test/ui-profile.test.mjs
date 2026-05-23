import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseUiProfile,
  filterEvent,
  filterMessageHistory,
  safeError,
  toolLabel,
} from "../dist/server/ui-profile.js";

function makeTmp() {
  return mkdtempSync(join(tmpdir(), "pi-webui-ui-profile-"));
}

//
// toolLabel
//

test("toolLabel: 內建工具對應正確", () => {
  assert.equal(toolLabel("read"), "正在讀取檔案...");
  assert.equal(toolLabel("write"), "正在寫入檔案...");
  assert.equal(toolLabel("edit"), "正在修改檔案...");
  assert.equal(toolLabel("bash"), "正在執行指令...");
  assert.equal(toolLabel("WebSearch"), "正在搜尋網路...");
  assert.equal(toolLabel("WebFetch"), "正在抓取網頁...");
  assert.equal(toolLabel("Task"), "正在思考...");
  assert.equal(toolLabel("Skill"), "正在準備工具...");
});

test("toolLabel: 未知工具 fallback 為「正在處理...」", () => {
  assert.equal(toolLabel("unknown-tool"), "正在處理...");
  assert.equal(toolLabel(""), "正在處理...");
});

//
// parseUiProfile - boolean flag
//

test("parseUiProfile: 全部空 → 全 false + brand 全 null", () => {
  const p = parseUiProfile({}, {});
  assert.equal(p.hideThinking, false);
  assert.equal(p.hideToolCalls, false);
  assert.equal(p.showToolProgress, false);
  assert.equal(p.hideStatusChips, false);
  assert.equal(p.hideSessionPicker, false);
  assert.equal(p.hideModel, false);
  assert.equal(p.safeErrors, false);
  assert.deepEqual(p.brand, { name: null, logoPath: null, color: null });
});

test("parseUiProfile: --ui-profile customer 展開 7 個 boolean", () => {
  const p = parseUiProfile({ uiProfile: "customer" }, {});
  assert.equal(p.hideThinking, true);
  assert.equal(p.hideToolCalls, true);
  assert.equal(p.showToolProgress, true);
  assert.equal(p.hideStatusChips, true);
  assert.equal(p.hideSessionPicker, true);
  assert.equal(p.hideModel, true);
  assert.equal(p.safeErrors, true);
});

test("parseUiProfile: PI_WEBUI_UI_PROFILE env 等效 CLI", () => {
  const p = parseUiProfile({}, { PI_WEBUI_UI_PROFILE: "customer" });
  assert.equal(p.hideThinking, true);
  assert.equal(p.safeErrors, true);
});

test("parseUiProfile: 個別 flag 啟用,其餘維持 false", () => {
  const p = parseUiProfile({ hideThinking: true }, {});
  assert.equal(p.hideThinking, true);
  assert.equal(p.hideToolCalls, false);
  assert.equal(p.safeErrors, false);
});

test("parseUiProfile: env var 啟用個別 flag", () => {
  const p = parseUiProfile({}, { PI_WEBUI_HIDE_THINKING: "1" });
  assert.equal(p.hideThinking, true);
  assert.equal(p.hideToolCalls, false);
});

test("parseUiProfile: env var 非 '1' 不啟用", () => {
  const p = parseUiProfile({}, { PI_WEBUI_HIDE_THINKING: "true" });
  assert.equal(p.hideThinking, false);
});

test("parseUiProfile: CLI flag 與 env var 同時啟用 → 仍為 true(OR 邏輯)", () => {
  const p = parseUiProfile(
    { hideThinking: true },
    { PI_WEBUI_HIDE_THINKING: "1" },
  );
  assert.equal(p.hideThinking, true);
});

test("parseUiProfile: --ui-profile unknown → throw", () => {
  assert.throws(() => parseUiProfile({ uiProfile: "foo" }, {}), /unknown preset 'foo'/);
});

//
// parseUiProfile - brand
//

test("parseUiProfile: --brand-name 設定 brand.name", () => {
  const p = parseUiProfile({ brandName: "Acme Bot" }, {});
  assert.equal(p.brand.name, "Acme Bot");
});

test("parseUiProfile: PI_WEBUI_BRAND_NAME env 等效", () => {
  const p = parseUiProfile({}, { PI_WEBUI_BRAND_NAME: "Acme" });
  assert.equal(p.brand.name, "Acme");
});

test("parseUiProfile: CLI brand-name 勝過 env", () => {
  const p = parseUiProfile(
    { brandName: "CLI" },
    { PI_WEBUI_BRAND_NAME: "ENV" },
  );
  assert.equal(p.brand.name, "CLI");
});

test("parseUiProfile: 空白 brand-name 視同未設定", () => {
  const p = parseUiProfile({ brandName: "  " }, {});
  assert.equal(p.brand.name, null);
});

test("parseUiProfile: --brand-color #rgb 合法", () => {
  const p = parseUiProfile({ brandColor: "#06c" }, {});
  assert.equal(p.brand.color, "#06c");
});

test("parseUiProfile: --brand-color #rrggbb 合法", () => {
  const p = parseUiProfile({ brandColor: "#0066cc" }, {});
  assert.equal(p.brand.color, "#0066cc");
});

test("parseUiProfile: --brand-color 非法字串 → throw", () => {
  assert.throws(
    () => parseUiProfile({ brandColor: "foo" }, {}),
    /must be #rgb or #rrggbb/,
  );
});

test("parseUiProfile: --brand-color 缺 # → throw", () => {
  assert.throws(
    () => parseUiProfile({ brandColor: "0066cc" }, {}),
    /must be #rgb or #rrggbb/,
  );
});

test("parseUiProfile: --brand-logo 檔案存在 → 設定 logoPath", () => {
  const tmp = makeTmp();
  try {
    const logo = join(tmp, "logo.svg");
    writeFileSync(logo, "<svg/>");
    const p = parseUiProfile({ brandLogo: logo }, {});
    assert.equal(p.brand.logoPath, logo);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseUiProfile: --brand-logo 檔案不存在 → throw", () => {
  assert.throws(
    () => parseUiProfile({ brandLogo: "/tmp/definitely-not-a-real-file.svg" }, {}),
    /file not found/,
  );
});

test("parseUiProfile: --brand-logo 指向目錄 → throw", () => {
  const tmp = makeTmp();
  try {
    assert.throws(
      () => parseUiProfile({ brandLogo: tmp }, {}),
      /not a file/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

//
// filterEvent - 非客戶模式 pass-through
//

test("filterEvent: 全 false profile,任何 event pass-through", () => {
  const p = parseUiProfile({}, {});
  const events = [
    { type: "tool_execution_start", toolCallId: "tc-1", toolName: "read", args: {} },
    { type: "tool_execution_end", toolCallId: "tc-1", toolName: "read", result: "x", isError: false },
    { type: "message_update", message: { content: [{ type: "thinking", text: "x" }, { type: "text", text: "y" }] } },
    { type: "agent_start" },
    { type: "compaction_start" },
  ];
  for (const e of events) {
    const r = filterEvent(e, p);
    assert.deepEqual(r, { kind: "event", event: e });
  }
});

//
// filterEvent - tool_execution_*
//

test("filterEvent: hideToolCalls 啟用,tool_execution_start → drop", () => {
  const p = parseUiProfile({ hideToolCalls: true }, {});
  const e = { type: "tool_execution_start", toolCallId: "tc-1", toolName: "read", args: {} };
  assert.equal(filterEvent(e, p), null);
});

test("filterEvent: hideToolCalls 啟用,tool_execution_end → drop", () => {
  const p = parseUiProfile({ hideToolCalls: true }, {});
  const e = { type: "tool_execution_end", toolCallId: "tc-1", toolName: "read", result: "x", isError: false };
  assert.equal(filterEvent(e, p), null);
});

test("filterEvent: hideToolCalls 啟用,tool_execution_update → drop", () => {
  const p = parseUiProfile({ hideToolCalls: true }, {});
  const e = { type: "tool_execution_update", toolCallId: "tc-1", toolName: "read", args: {}, partialResult: {} };
  assert.equal(filterEvent(e, p), null);
});

test("filterEvent: hideToolCalls + showToolProgress + start → 轉 progress packet", () => {
  const p = parseUiProfile({ hideToolCalls: true, showToolProgress: true }, {});
  const e = { type: "tool_execution_start", toolCallId: "tc-1", toolName: "read", args: {} };
  const r = filterEvent(e, p);
  assert.deepEqual(r, {
    kind: "tool_progress",
    payload: { id: "tc-1", label: "正在讀取檔案...", phase: "start" },
  });
});

test("filterEvent: hideToolCalls + showToolProgress + end → 轉 progress end", () => {
  const p = parseUiProfile({ hideToolCalls: true, showToolProgress: true }, {});
  const e = { type: "tool_execution_end", toolCallId: "tc-1", toolName: "bash", result: "x", isError: false };
  const r = filterEvent(e, p);
  assert.deepEqual(r, {
    kind: "tool_progress",
    payload: { id: "tc-1", label: "正在執行指令...", phase: "end" },
  });
});

test("filterEvent: hideToolCalls + showToolProgress + update → 仍 drop(不發 progress)", () => {
  const p = parseUiProfile({ hideToolCalls: true, showToolProgress: true }, {});
  const e = { type: "tool_execution_update", toolCallId: "tc-1", toolName: "read", args: {}, partialResult: {} };
  assert.equal(filterEvent(e, p), null);
});

test("filterEvent: showToolProgress 但沒 hideToolCalls → event pass-through(progress 無效)", () => {
  const p = parseUiProfile({ showToolProgress: true }, {});
  const e = { type: "tool_execution_start", toolCallId: "tc-1", toolName: "read", args: {} };
  assert.deepEqual(filterEvent(e, p), { kind: "event", event: e });
});

test("filterEvent: 未知 tool 用 fallback label", () => {
  const p = parseUiProfile({ hideToolCalls: true, showToolProgress: true }, {});
  const e = { type: "tool_execution_start", toolCallId: "tc-x", toolName: "MysteryTool", args: {} };
  const r = filterEvent(e, p);
  assert.equal(r.kind, "tool_progress");
  assert.equal(r.payload.label, "正在處理...");
});

//
// filterEvent - message_update
//

test("filterEvent: hideThinking 啟用,thinking block 從 message_update 剝掉", () => {
  const p = parseUiProfile({ hideThinking: true }, {});
  const e = {
    type: "message_update",
    message: {
      content: [
        { type: "thinking", text: "internal" },
        { type: "text", text: "visible" },
      ],
    },
  };
  const r = filterEvent(e, p);
  assert.equal(r.kind, "event");
  assert.deepEqual(r.event.message.content, [{ type: "text", text: "visible" }]);
  // 原物件不被改動
  assert.equal(e.message.content.length, 2);
});

test("filterEvent: hideToolCalls 啟用,tool_call / tool_result block 從 message_update 剝掉", () => {
  const p = parseUiProfile({ hideToolCalls: true }, {});
  const e = {
    type: "message_update",
    message: {
      content: [
        { type: "text", text: "visible" },
        { type: "tool_call", id: "x" },
        { type: "tool_result", id: "x" },
      ],
    },
  };
  const r = filterEvent(e, p);
  assert.deepEqual(r.event.message.content, [{ type: "text", text: "visible" }]);
});

test("filterEvent: hideToolCalls 啟用,toolCall / toolResult (SDK camelCase) block 從 message_update 剝掉", () => {
  const p = parseUiProfile({ hideToolCalls: true }, {});
  const e = {
    type: "message_update",
    message: {
      content: [
        { type: "text", text: "visible" },
        { type: "toolCall", id: "x", name: "bash" },
        { type: "toolResult", toolName: "bash", content: "out" },
      ],
    },
  };
  const r = filterEvent(e, p);
  assert.deepEqual(r.event.message.content, [{ type: "text", text: "visible" }]);
});

test("filterEvent: hide flag 沒命中任何 block → pass-through 原 event reference", () => {
  const p = parseUiProfile({ hideThinking: true }, {});
  const e = {
    type: "message_update",
    message: { content: [{ type: "text", text: "x" }] },
  };
  const r = filterEvent(e, p);
  assert.equal(r.event, e);
});

test("filterEvent: message_update 但 content 不是陣列 → pass-through", () => {
  const p = parseUiProfile({ hideThinking: true }, {});
  const e = { type: "message_update", message: {} };
  const r = filterEvent(e, p);
  assert.deepEqual(r, { kind: "event", event: e });
});

test("filterEvent: agent_start / compaction_* / extension_error / auto_retry_start 全 pass-through", () => {
  const p = parseUiProfile({ uiProfile: "customer" }, {});
  const events = [
    { type: "agent_start" },
    { type: "agent_end" },
    { type: "compaction_start" },
    { type: "compaction_end" },
    { type: "extension_error", message: "x" },
    { type: "auto_retry_start" },
  ];
  for (const e of events) {
    assert.deepEqual(filterEvent(e, p), { kind: "event", event: e });
  }
});

test("filterEvent: null / 非物件 → pass-through", () => {
  const p = parseUiProfile({}, {});
  assert.deepEqual(filterEvent(null, p), { kind: "event", event: null });
  assert.deepEqual(filterEvent("x", p), { kind: "event", event: "x" });
});

//
// filterMessageHistory
//

test("filterMessageHistory: 沒 hide flag → 原陣列直接回(不複製)", () => {
  const p = parseUiProfile({}, {});
  const msgs = [{ content: [{ type: "thinking" }] }];
  assert.equal(filterMessageHistory(msgs, p), msgs);
});

test("filterMessageHistory: hideThinking 過濾每則 message 的 thinking block", () => {
  const p = parseUiProfile({ hideThinking: true }, {});
  const msgs = [
    { content: [{ type: "thinking" }, { type: "text", text: "a" }] },
    { content: [{ type: "text", text: "b" }] },
  ];
  const out = filterMessageHistory(msgs, p);
  assert.deepEqual(out[0].content, [{ type: "text", text: "a" }]);
  assert.deepEqual(out[1].content, [{ type: "text", text: "b" }]);
});

test("filterMessageHistory: 非陣列輸入 → 原樣回", () => {
  const p = parseUiProfile({ hideThinking: true }, {});
  assert.equal(filterMessageHistory(null, p), null);
});

test("filterMessageHistory: hideToolCalls 啟用,SDK camelCase toolCall / toolResult content block 剝掉", () => {
  const p = parseUiProfile({ hideToolCalls: true }, {});
  const msgs = [
    {
      role: "assistant",
      content: [
        { type: "text", text: "before" },
        { type: "toolCall", id: "tc-1", name: "bash", arguments: {} },
      ],
    },
  ];
  const out = filterMessageHistory(msgs, p);
  assert.deepEqual(out[0].content, [{ type: "text", text: "before" }]);
});

test("filterMessageHistory: hideToolCalls 啟用,role='toolResult' / 'bashExecution' 整則 message drop", () => {
  const p = parseUiProfile({ hideToolCalls: true }, {});
  const msgs = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "running" }] },
    { role: "toolResult", toolName: "bash", content: "result-body" },
    { role: "bashExecution", command: "ls", output: "a\nb", exitCode: 0 },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  const out = filterMessageHistory(msgs, p);
  assert.equal(out.length, 3, "tool result + bash execution message should be removed");
  assert.equal(out[0].role, "user");
  assert.equal(out[1].role, "assistant");
  assert.equal(out[2].role, "assistant");
  assert.equal(out[2].content[0].text, "done");
});

test("filterMessageHistory: 只啟 hideThinking,role='toolResult' 不該被 drop", () => {
  const p = parseUiProfile({ hideThinking: true }, {});
  const msgs = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "toolResult", toolName: "bash", content: "result-body" },
  ];
  const out = filterMessageHistory(msgs, p);
  assert.equal(out.length, 2);
  assert.equal(out[1].role, "toolResult");
});

test("filterMessageHistory: customer preset 下,SDK 混合 fixture 整段過濾後乾淨", () => {
  const p = parseUiProfile({ uiProfile: "customer" }, {});
  const msgs = [
    { role: "user", content: [{ type: "text", text: "請列出檔案" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "我該叫 bash" },
        { type: "text", text: "好" },
        { type: "toolCall", id: "tc-1", name: "bash", arguments: { cmd: "ls" } },
      ],
    },
    { role: "toolResult", toolName: "bash", content: "file1\nfile2" },
    {
      role: "assistant",
      content: [{ type: "text", text: "這裡是檔案" }],
    },
  ];
  const out = filterMessageHistory(msgs, p);
  assert.equal(out.length, 3, "tool result message removed");
  // assistant 第一則只剩 text,thinking + toolCall 被剝掉
  assert.deepEqual(out[1].content, [{ type: "text", text: "好" }]);
});

//
// safeError
//

test("safeError: 非 safeErrors mode → pass-through 原訊息,不寫 log", () => {
  const p = parseUiProfile({}, {});
  const log = { calls: [], error(m, f) { this.calls.push([m, f]); } };
  const out = safeError(p, "raw stack trace here", log);
  assert.equal(out, "raw stack trace here");
  assert.equal(log.calls.length, 0);
});

test("safeError: safeErrors mode → 包裝 + 寫 log 帶 ticket", () => {
  const p = parseUiProfile({ safeErrors: true }, {});
  const log = { calls: [], error(m, f) { this.calls.push([m, f]); } };
  const out = safeError(p, "raw stack trace here", log);
  assert.match(out, /^發生錯誤,請聯繫支援 \(ticket: [0-9a-f]{6}\)$/);
  assert.equal(log.calls.length, 1);
  assert.equal(log.calls[0][0], "safe-error");
  assert.match(log.calls[0][1].ticket, /^[0-9a-f]{6}$/);
  assert.equal(log.calls[0][1].message, "raw stack trace here");
  // 包裝訊息的 ticket 與 log 帶的 ticket 一致
  const ticketFromOut = out.match(/ticket: ([0-9a-f]{6})/)[1];
  assert.equal(log.calls[0][1].ticket, ticketFromOut);
});

test("safeError: 連續呼叫 ticket id 不重複(機率)", () => {
  const p = parseUiProfile({ safeErrors: true }, {});
  const tickets = new Set();
  for (let i = 0; i < 50; i++) {
    const out = safeError(p, "x");
    tickets.add(out.match(/ticket: ([0-9a-f]{6})/)[1]);
  }
  // 50 次 6-hex(16M 空間)碰撞機率極低
  assert.ok(tickets.size >= 49, `expected ≥49 unique tickets, got ${tickets.size}`);
});

test("safeError: 無 logger 也不崩", () => {
  const p = parseUiProfile({ safeErrors: true }, {});
  const out = safeError(p, "x");
  assert.match(out, /ticket:/);
});
