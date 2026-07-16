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
} from "../dist/server/ui-profile.js";

function makeTmp() {
  return mkdtempSync(join(tmpdir(), "readyai-webui-ui-profile-"));
}

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
  assert.equal(p.exposeToolArgs, false);
  assert.equal(p.brand.name, null);
  assert.equal(p.brand.logoPath, null);
  assert.equal(p.brand.mode, null);
  assert.deepEqual(p.brand.tokens, {});
  assert.equal(p.brand.cssPath, null);
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
  assert.equal(p.brand.tokens.accent, "#06c");
});

test("parseUiProfile: --brand-color #rrggbb 合法", () => {
  const p = parseUiProfile({ brandColor: "#0066cc" }, {});
  assert.equal(p.brand.tokens.accent, "#0066cc");
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
// parseUiProfile - brand favicon(需求2)
//

test("parseUiProfile: 預設 faviconPath 為 null", () => {
  const p = parseUiProfile({}, {});
  assert.equal(p.brand.faviconPath, null);
});

test("parseUiProfile: --brand-favicon 檔案存在 → 設定 faviconPath", () => {
  const tmp = makeTmp();
  try {
    const fav = join(tmp, "fav.svg");
    writeFileSync(fav, "<svg/>");
    const p = parseUiProfile({ brandFavicon: fav }, {});
    assert.equal(p.brand.faviconPath, fav);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseUiProfile: PI_WEBUI_BRAND_FAVICON env 等效", () => {
  const tmp = makeTmp();
  try {
    const fav = join(tmp, "fav.png");
    writeFileSync(fav, "x");
    const p = parseUiProfile({}, { PI_WEBUI_BRAND_FAVICON: fav });
    assert.equal(p.brand.faviconPath, fav);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseUiProfile: --brand-favicon 檔案不存在 → throw", () => {
  assert.throws(
    () => parseUiProfile({ brandFavicon: "/tmp/definitely-not-real-favicon.svg" }, {}),
    /file not found/,
  );
});

test("parseUiProfile: profileFile.brand.favicon → faviconPath", () => {
  const p = parseUiProfile({}, {}, { brand: { favicon: "./assets/fav.svg" } });
  assert.equal(p.brand.faviconPath, "./assets/fav.svg");
});

//
// parseUiProfile - chat_layout(需求3)
//

test("parseUiProfile: 預設 chatLayout 為 'log'", () => {
  const p = parseUiProfile({}, {});
  assert.equal(p.chatLayout, "log");
});

test("parseUiProfile: customer preset → chatLayout 'bubble'", () => {
  const p = parseUiProfile({ uiProfile: "customer" }, {});
  assert.equal(p.chatLayout, "bubble");
});

test("parseUiProfile: profileFile.ui.chat_layout 套用", () => {
  const p = parseUiProfile({}, {}, { ui: { chat_layout: "bubble" } });
  assert.equal(p.chatLayout, "bubble");
});

test("parseUiProfile: --chat-layout CLI 勝過 profileFile", () => {
  const p = parseUiProfile({ chatLayout: "log" }, {}, { ui: { chat_layout: "bubble" } });
  assert.equal(p.chatLayout, "log");
});

test("parseUiProfile: PI_WEBUI_CHAT_LAYOUT env 套用", () => {
  const p = parseUiProfile({}, { PI_WEBUI_CHAT_LAYOUT: "bubble" });
  assert.equal(p.chatLayout, "bubble");
});

test("parseUiProfile: --chat-layout 非法值 → throw", () => {
  assert.throws(
    () => parseUiProfile({ chatLayout: "fancy" }, {}),
    /must be "bubble" or "log"/,
  );
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

test("filterEvent: hideToolCalls + showToolProgress + start → 轉 progress packet(無 profile.toolLabels 用 fallback)", () => {
  const p = parseUiProfile({ hideToolCalls: true, showToolProgress: true }, {});
  const e = { type: "tool_execution_start", toolCallId: "tc-1", toolName: "read", args: {} };
  const r = filterEvent(e, p);
  assert.deepEqual(r, {
    kind: "tool_progress",
    payload: { id: "tc-1", label: "正在處理...", phase: "start" },
  });
});

test("filterEvent: hideToolCalls + showToolProgress + end → 轉 progress end(無 profile.toolLabels 用 fallback 空字串)", () => {
  const p = parseUiProfile({ hideToolCalls: true, showToolProgress: true }, {});
  const e = { type: "tool_execution_end", toolCallId: "tc-1", toolName: "bash", result: "x", isError: false };
  const r = filterEvent(e, p);
  assert.equal(r.kind, "tool_progress");
  assert.equal(r.payload.phase, "end");
  assert.equal(r.payload.id, "tc-1");
  // 無 toolLabels 時 end phase BUILTIN_DEFAULTS.end = "",resolveLabel 回空字串
  assert.equal(r.payload.label, "");
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

//
// filterEvent - message_update.assistantMessageEvent(SDK streaming delta;§四-1)
//

test("filterEvent: hideThinking → thinking_delta 事件整個 drop(不外洩 + 保持 typing)", () => {
  const p = parseUiProfile({ hideThinking: true }, {});
  const e = {
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "internal reasoning",
      partial: { content: [{ type: "thinking", thinking: "internal reasoning" }] },
    },
    message: { content: [{ type: "thinking", thinking: "internal reasoning" }] },
  };
  assert.equal(filterEvent(e, p), null);
});

test("filterEvent: hideThinking → thinking_start / thinking_end 也 drop", () => {
  const p = parseUiProfile({ hideThinking: true }, {});
  for (const type of ["thinking_start", "thinking_end"]) {
    const e = { type: "message_update", assistantMessageEvent: { type, contentIndex: 0, partial: {} } };
    assert.equal(filterEvent(e, p), null, `${type} should drop`);
  }
});

test("filterEvent: hideToolCalls → toolcall_start/delta/end 事件 drop", () => {
  const p = parseUiProfile({ hideToolCalls: true }, {});
  const cases = [
    { type: "toolcall_start", contentIndex: 1, partial: {} },
    { type: "toolcall_delta", contentIndex: 1, delta: '{"path":"/etc/passwd"}', partial: {} },
    { type: "toolcall_end", contentIndex: 1, toolCall: { type: "toolCall", name: "bash", arguments: { cmd: "printenv" } }, partial: {} },
  ];
  for (const ame of cases) {
    const e = { type: "message_update", assistantMessageEvent: ame };
    assert.equal(filterEvent(e, p), null, `${ame.type} should drop`);
  }
});

test("filterEvent: text_delta 保留,但 partial 內 thinking 全文被剝(partial 挾帶洩漏)", () => {
  const p = parseUiProfile({ hideThinking: true }, {});
  const e = {
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 1,
      delta: "答案是",
      // partial 累積:含前面已完成的 thinking 全文
      partial: {
        content: [
          { type: "thinking", thinking: "使用者其實想問 X,我推理如下…" },
          { type: "text", text: "答案是" },
        ],
      },
    },
    message: { content: [{ type: "text", text: "答案是" }] },
  };
  const r = filterEvent(e, p);
  assert.equal(r.kind, "event");
  // delta 本體保留(文字要出得來)
  assert.equal(r.event.assistantMessageEvent.delta, "答案是");
  // partial 內 thinking 已被剝除,只剩 text
  assert.deepEqual(r.event.assistantMessageEvent.partial.content, [{ type: "text", text: "答案是" }]);
  // 原物件不被改動
  assert.equal(e.assistantMessageEvent.partial.content.length, 2);
});

test("filterEvent: text_delta partial 內 toolCall 被剝(hideToolCalls)", () => {
  const p = parseUiProfile({ hideToolCalls: true }, {});
  const e = {
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 2,
      delta: "done",
      partial: {
        content: [
          { type: "toolCall", name: "bash", arguments: { cmd: "cat .env" } },
          { type: "toolResult", toolName: "bash", content: "SECRET=xxx" },
          { type: "text", text: "done" },
        ],
      },
    },
  };
  const r = filterEvent(e, p);
  assert.deepEqual(r.event.assistantMessageEvent.partial.content, [{ type: "text", text: "done" }]);
});

test("filterEvent: done 事件的 message(完整訊息)被剝 thinking + toolCall", () => {
  const p = parseUiProfile({ uiProfile: "customer" }, {});
  const e = {
    type: "message_update",
    assistantMessageEvent: {
      type: "done",
      reason: "stop",
      message: {
        content: [
          { type: "thinking", thinking: "secret reasoning" },
          { type: "toolCall", name: "bash", arguments: {} },
          { type: "text", text: "回覆" },
        ],
      },
    },
  };
  const r = filterEvent(e, p);
  assert.deepEqual(r.event.assistantMessageEvent.message.content, [{ type: "text", text: "回覆" }]);
});

test("filterEvent: error 事件的 error(AssistantMessage)被剝 thinking", () => {
  const p = parseUiProfile({ hideThinking: true }, {});
  const e = {
    type: "message_update",
    assistantMessageEvent: {
      type: "error",
      reason: "error",
      error: { content: [{ type: "thinking", thinking: "leak" }, { type: "text", text: "boom" }] },
    },
  };
  const r = filterEvent(e, p);
  assert.deepEqual(r.event.assistantMessageEvent.error.content, [{ type: "text", text: "boom" }]);
});

test("filterEvent: fail-closed — content 非 array 但帶 thinking_delta 仍 drop(reviewer P1-3)", () => {
  const p = parseUiProfile({ hideThinking: true }, {});
  const e = {
    type: "message_update",
    message: {}, // content 非 array,舊碼會在此 pass-through 原 event
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "leak", partial: {} },
  };
  assert.equal(filterEvent(e, p), null);
});

test("filterEvent: 只 hideThinking 時 toolcall_delta 不 drop,但其 partial thinking 仍被剝", () => {
  const p = parseUiProfile({ hideThinking: true }, {}); // 只 hideThinking
  const e = {
    type: "message_update",
    assistantMessageEvent: {
      type: "toolcall_delta",
      contentIndex: 1,
      delta: '{"x":1}',
      partial: { content: [{ type: "thinking", thinking: "leak" }, { type: "toolCall", name: "bash" }] },
    },
  };
  const r = filterEvent(e, p);
  // toolcall_delta 在只 hideThinking 下不 drop(tool 細節本就可見)
  assert.equal(r.kind, "event");
  // 但 partial 內 thinking 被剝,toolCall 保留(hideToolCalls=false)
  assert.deepEqual(r.event.assistantMessageEvent.partial.content, [{ type: "toolCall", name: "bash" }]);
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

//
// parseUiProfile - profileFile 第三參數
//

test("parseUiProfile 接 profileFile 套用 ui 旗標", (t) => {
  const profile = parseUiProfile({}, {}, {
    ui: {
      hide_thinking: true,
      hide_tool_calls: true,
      show_tool_progress: true,
    },
  });
  assert.equal(profile.hideThinking, true);
  assert.equal(profile.hideToolCalls, true);
  assert.equal(profile.showToolProgress, true);
  assert.equal(profile.hideStatusChips, false);
});

test("parseUiProfile 個別 CLI flag override profileFile", (t) => {
  const profile = parseUiProfile(
    { hideThinking: false },
    {},
    { ui: { hide_thinking: true } },
  );
  assert.equal(profile.hideThinking, false);
});

test("parseUiProfile profileFile.brand 對應到 UiProfile.brand 結構", (t) => {
  const profile = parseUiProfile({}, {}, {
    brand: {
      name: "X",
      logo: "./logo.svg",
      mode: "light",
      bg: "#fafafa",
      accent: "#06c",
      css: "./theme.css",
    },
  });
  assert.equal(profile.brand.name, "X");
  assert.equal(profile.brand.mode, "light");
  assert.equal(profile.brand.tokens.bg, "#fafafa");
  assert.equal(profile.brand.tokens.accent, "#06c");
  assert.equal(profile.brand.logoPath, "./logo.svg");
  assert.equal(profile.brand.cssPath, "./theme.css");
});

test("parseUiProfile profileFile.tool_labels 對應到 UiProfile.toolLabels", () => {
  const profile = parseUiProfile({}, {}, {
    tool_labels: {
      read: { start: "讀 {file_basename}", end: "" },
      _default: { start: "處理中..." },
    },
  });
  assert.equal(profile.toolLabels?.read?.start, "讀 {file_basename}");
  assert.equal(profile.toolLabels?._default?.start, "處理中...");
});

test("parseUiProfile 無 profileFile → toolLabels 為 {}", () => {
  const profile = parseUiProfile({}, {}, undefined);
  assert.deepEqual(profile.toolLabels, {});
});

//
// filterEvent - resolveLabel 串接驗證
//

test("filterEvent hideToolCalls+showToolProgress tool_execution_start → 走 resolveLabel", () => {
  const profile = parseUiProfile({}, {}, {
    ui: { hide_tool_calls: true, show_tool_progress: true },
    tool_labels: { read: { start: "正在讀檔" } },
  });
  const event = {
    type: "tool_execution_start",
    toolCallId: "tc-1",
    toolName: "read",
    args: {},
  };
  const result = filterEvent(event, profile);
  assert.equal(result?.kind, "tool_progress");
  assert.equal(result?.payload?.phase, "start");
  assert.equal(result?.payload?.label, "正在讀檔");
  assert.equal(result?.payload?.id, "tc-1");
});

test("filterEvent tool_execution_end phase=end 走 resolveLabel", () => {
  const profile = parseUiProfile({}, {}, {
    ui: { hide_tool_calls: true, show_tool_progress: true },
    tool_labels: { read: { end: "讀檔完成" } },
  });
  const event = {
    type: "tool_execution_end",
    toolCallId: "tc-1",
    toolName: "read",
    args: {},
  };
  const result = filterEvent(event, profile);
  assert.equal(result?.payload?.phase, "end");
  assert.equal(result?.payload?.label, "讀檔完成");
});
