import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatMessage,
  sdkContentToBlocks,
  hasVisibleContent,
  isToolResultVisible,
} from "../public/format-message.mjs";

test("toolResult message preserves details (e.g. edit-tool diff)", () => {
  // Shape mirrors the JSONL written by pi-coding-agent for the "edit" tool:
  // top-level toolResult with a sibling `details.diff` alongside `content`.
  const message = {
    role: "toolResult",
    toolName: "edit",
    content: [{ type: "text", text: "Successfully replaced 1 block(s)." }],
    details: { diff: "@@ -1,3 +1,3 @@\n-old\n+new", firstChangedLine: 26 },
  };
  const formatted = formatMessage(message);
  const block = formatted.blocks[0];
  assert.equal(block.type, "tool_result");
  assert.equal(block.name, "edit");
  // The renderer needs both content and details to build the diff toggle.
  // Whatever shape `result` takes, extractResultParts must be able to pull
  // both back out — assert details survives by name.
  assert.ok(block.result, "result must be present");
  assert.deepStrictEqual(block.result.details, {
    diff: "@@ -1,3 +1,3 @@\n-old\n+new",
    firstChangedLine: 26,
  });
});

test("sdkContentToBlocks preserves base64 data on image blocks", () => {
  // Pasted images flow through chat-state and back as canonical user messages;
  // the renderer needs `data` to draw an <img> rather than a placeholder.
  const blocks = sdkContentToBlocks([
    { type: "image", mimeType: "image/png", data: "AAAA" },
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "image");
  assert.equal(blocks[0].mimeType, "image/png");
  assert.equal(blocks[0].data, "AAAA");
});

test("sdkContentToBlocks preserves details on embedded toolResult blocks", () => {
  // Some transports emit toolResult as a block inside an assistant message's
  // content array rather than as a top-level message.
  const content = [
    {
      type: "toolResult",
      toolName: "edit",
      content: [{ type: "text", text: "Successfully replaced." }],
      details: { diff: "@@ ..." },
    },
  ];
  const blocks = sdkContentToBlocks(content);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "tool_result");
  assert.ok(blocks[0].result);
  assert.deepStrictEqual(blocks[0].result.details, { diff: "@@ ..." });
});

// ── Failed turn (stopReason error) → red error block, not a blank assistant ──
// issue #2 P1 / 留言 A:金鑰失效(401)的失敗 turn 在 jsonl 裡是
//   { role:"assistant", content:[], stopReason:"error", errorMessage:"401 User not found." }
// 前端原本只渲染空白「Assistant」header,errorMessage 被吞掉。

test("assistant turn with stopReason 'error' renders as an error block carrying the errorMessage", () => {
  const message = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "401 User not found.",
  };
  const formatted = formatMessage(message);
  assert.equal(formatted.kind, "error", "failed turn must render as error kind (red), not assistant");
  const text = formatted.blocks.map((b) => b.text || "").join("\n");
  assert.match(text, /401 User not found\./);
});

test("assistant turn with empty content + errorMessage (no stopReason) still surfaces the error", () => {
  const message = { role: "assistant", content: [], errorMessage: "503 upstream timeout" };
  const formatted = formatMessage(message);
  assert.equal(formatted.kind, "error");
  assert.match(formatted.blocks.map((b) => b.text || "").join("\n"), /503 upstream timeout/);
});

test("assistant turn with stopReason 'error' but no errorMessage shows a non-empty failure note", () => {
  const message = { role: "assistant", content: [], stopReason: "error" };
  const formatted = formatMessage(message);
  assert.equal(formatted.kind, "error");
  assert.ok(
    formatted.blocks.some((b) => b.type === "text" && (b.text || "").length > 0),
    "must show some failure text even when errorMessage is absent",
  );
});

test("failed turn keeps any partial content it did produce, then appends the error", () => {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "partial answer" }],
    stopReason: "error",
    errorMessage: "connection reset",
  };
  const formatted = formatMessage(message);
  assert.equal(formatted.kind, "error");
  const texts = formatted.blocks.filter((b) => b.type === "text").map((b) => b.text);
  assert.ok(texts.includes("partial answer"), "partial content must be retained");
  assert.ok(texts.some((t) => /connection reset/.test(t)), "error message must be appended");
});

test("successful assistant turn (stopReason 'stop') stays assistant kind", () => {
  const message = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" };
  const formatted = formatMessage(message);
  assert.equal(formatted.kind, "assistant");
  assert.equal(formatted.blocks[0].text, "done");
});

test("plain assistant turn with no stopReason field is unaffected", () => {
  const message = { role: "assistant", content: [{ type: "text", text: "hello" }] };
  const formatted = formatMessage(message);
  assert.equal(formatted.kind, "assistant");
  assert.equal(formatted.blocks[0].text, "hello");
});

// ── hasVisibleContent:當前 uiProfile 下是否有可見內容 ──────────────────────
// issue #2 留言 B(b):thinking+tool、無 text 的 assistant,在 customer 模式
// (hideThinking + hideToolCalls)摺疊後變成裸的空白「Assistant」header。
// renderLog 用此函式判斷,空的 assistant 就不掛 header。

test("hasVisibleContent: empty blocks → false", () => {
  assert.equal(hasVisibleContent([], {}), false);
  assert.equal(hasVisibleContent(null, {}), false);
});

test("hasVisibleContent: a text block with content → true", () => {
  assert.equal(hasVisibleContent([{ type: "text", text: "hi" }], {}), true);
});

test("hasVisibleContent: a blank/whitespace text block → false", () => {
  assert.equal(hasVisibleContent([{ type: "text", text: "" }], {}), false);
  assert.equal(hasVisibleContent([{ type: "text", text: "   \n" }], {}), false);
});

test("hasVisibleContent: thinking-only is visible when thinking is shown", () => {
  assert.equal(hasVisibleContent([{ type: "thinking", text: "hmm" }], {}), true);
});

test("hasVisibleContent: thinking-only is NOT visible when hideThinking", () => {
  assert.equal(hasVisibleContent([{ type: "thinking", text: "hmm" }], { hideThinking: true }), false);
});

test("hasVisibleContent: tool_call is visible by default but hidden under hideToolCalls", () => {
  const blocks = [{ type: "tool_call", name: "Read", input: {} }];
  assert.equal(hasVisibleContent(blocks, {}), true);
  assert.equal(hasVisibleContent(blocks, { hideToolCalls: true }), false);
});

test("hasVisibleContent: pending tool_result (result null) does not count as visible", () => {
  assert.equal(hasVisibleContent([{ type: "tool_result", name: "Read", result: null }], {}), false);
});

test("hasVisibleContent: filled tool_result counts as visible (unless hidden)", () => {
  const blocks = [{ type: "tool_result", name: "Read", result: [{ type: "text", text: "x" }] }];
  assert.equal(hasVisibleContent(blocks, {}), true);
  assert.equal(hasVisibleContent(blocks, { hideToolCalls: true }), false);
});

test("hasVisibleContent: the issue's L10 case — thinking + tool_calls under customer profile → false", () => {
  const blocks = [
    { type: "thinking", text: "planning" },
    { type: "tool_call", name: "Read", input: {} },
    { type: "tool_call", name: "Bash", input: {} },
  ];
  assert.equal(hasVisibleContent(blocks, { hideThinking: true, hideToolCalls: true }), false);
});

test("hasVisibleContent: text alongside hidden thinking is still visible", () => {
  const blocks = [
    { type: "thinking", text: "planning" },
    { type: "text", text: "the answer" },
  ];
  assert.equal(hasVisibleContent(blocks, { hideThinking: true }), true);
});

test("hasVisibleContent: an image block counts as visible", () => {
  assert.equal(hasVisibleContent([{ type: "image", mimeType: "image/png", data: "AAAA" }], {}), true);
});

//
// showToolResultsFor 白名單(P2-1)client 端 secondary filter
//

test("isToolResultVisible: 白名單命中(snake_case name / SDK toolName 都認)", () => {
  const ui = { hideToolCalls: true, showToolResultsFor: ["publish_confirmed"] };
  assert.equal(isToolResultVisible({ type: "tool_result", name: "publish_confirmed" }, ui), true);
  assert.equal(isToolResultVisible({ type: "toolResult", toolName: "publish_confirmed" }, ui), true);
  assert.equal(isToolResultVisible({ type: "tool_result", name: "bash" }, ui), false);
});

test("isToolResultVisible: 沒有白名單 / 沒有 tool 名 → fail-closed", () => {
  assert.equal(isToolResultVisible({ type: "tool_result", name: "publish_confirmed" }, {}), false);
  assert.equal(isToolResultVisible({ type: "tool_result" }, { showToolResultsFor: ["publish_confirmed"] }), false);
});

test("hasVisibleContent: hideToolCalls 下白名單 tool_result 仍算可見", () => {
  const ui = { hideToolCalls: true, showToolResultsFor: ["publish_confirmed"] };
  const blocks = [{ type: "tool_result", name: "publish_confirmed", result: { content: [] } }];
  assert.equal(hasVisibleContent(blocks, ui), true);
});

test("hasVisibleContent: hideToolCalls 下非白名單 tool_result 仍不可見", () => {
  const ui = { hideToolCalls: true, showToolResultsFor: ["publish_confirmed"] };
  const blocks = [{ type: "tool_result", name: "bash", result: { content: [] } }];
  assert.equal(hasVisibleContent(blocks, ui), false);
});

test("hasVisibleContent: 白名單命中但 result 仍 pending(null)→ 不可見", () => {
  const ui = { hideToolCalls: true, showToolResultsFor: ["publish_confirmed"] };
  const blocks = [{ type: "tool_result", name: "publish_confirmed", result: null }];
  assert.equal(hasVisibleContent(blocks, ui), false);
});
