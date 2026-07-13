// test/ui-profile-redact.test.mjs
// L3 送 client 兜底：filterEvent 對 tool_execution_update / tool_execution_end 遮 L-甲 機密值。
// 獨立檔（node --test 每檔獨立行程），可安全設 process.env。
import { test } from "node:test";
import assert from "node:assert/strict";

// 在 import filterEvent 前設好機密值（redactBlocks 預設讀 process.env）。
process.env.OPENROUTER_API_KEY = "or-canary-abcdef123456";
process.env.PC2_SERVICE_PWS = "pc2pws-canary-secret-000";
process.env.PC2_API_TOKEN = "scoped-token-canary-999"; // L-乙：不該被遮
process.env.LITELLM_API_KEY = "sk-litellm-sentinel-canary-abcdef123456"; // per-preview virtual key（PRD story 12）：送 client 前必遮

const { filterEvent, parseUiProfile } = await import("../dist/server/ui-profile.js");

const devProfile = parseUiProfile({}, {}); // 全 false（hideToolCalls=false）

test("L3 client: tool_execution_update.partialResult.content 遮 L-甲、留 L-乙", () => {
  const event = {
    type: "tool_execution_update",
    toolCallId: "t1",
    toolName: "bash",
    args: { command: "printenv" },
    partialResult: {
      content: [
        { type: "text", text: "OPENROUTER_API_KEY=or-canary-abcdef123456\nPC2_API_TOKEN=scoped-token-canary-999" },
      ],
    },
  };
  const r = filterEvent(event, devProfile);
  assert.equal(r.kind, "event");
  const text = r.event.partialResult.content[0].text;
  assert.ok(text.includes("«REDACTED»"), "L-甲 值應被遮");
  assert.ok(!text.includes("or-canary-abcdef123456"), "OPENROUTER 值不得外洩");
  assert.ok(text.includes("scoped-token-canary-999"), "L-乙 PC2_API_TOKEN 值不在遮蔽範圍");
});

test("L3 client: tool_execution_end.result.content 遮 L-甲", () => {
  const event = {
    type: "tool_execution_end",
    toolCallId: "t2",
    toolName: "bash",
    result: { content: [{ type: "text", text: "pws=pc2pws-canary-secret-000" }] },
    isError: false,
  };
  const r = filterEvent(event, devProfile);
  assert.equal(r.kind, "event");
  const text = r.event.result.content[0].text;
  assert.ok(text.includes("«REDACTED»"));
  assert.ok(!text.includes("pc2pws-canary-secret-000"));
});

// final review 缺口：LITELLM_API_KEY 之前只在 secret-guard.test.mjs 驗過 redactText /
// SECRET_ENV_KEYS 純函式，沒走過送 client 的真接點 filterEvent。比照 :16 的
// tool_execution_update 範本，換 LITELLM_API_KEY 當哨兵，證明串流事件送 client 前確實被遮。
test("L3 client: tool_execution_update.partialResult.content 遮 LITELLM_API_KEY（per-preview virtual key）", () => {
  const event = {
    type: "tool_execution_update",
    toolCallId: "t5",
    toolName: "bash",
    args: { command: "printenv" },
    partialResult: {
      content: [{ type: "text", text: "key=sk-litellm-sentinel-canary-abcdef123456" }],
    },
  };
  const r = filterEvent(event, devProfile);
  assert.equal(r.kind, "event");
  const text = r.event.partialResult.content[0].text;
  assert.ok(text.includes("«REDACTED»"), "LITELLM_API_KEY 值應被遮");
  assert.ok(!text.includes("sk-litellm-sentinel-canary-abcdef123456"), "LITELLM_API_KEY 值不得外洩到 client");
});

test("L3 client: 無機密內容 → event 不變（no-op）", () => {
  const event = {
    type: "tool_execution_end",
    toolCallId: "t3",
    toolName: "read",
    result: { content: [{ type: "text", text: "hello world, nothing here" }] },
    isError: false,
  };
  const r = filterEvent(event, devProfile);
  assert.equal(r.event, event, "無機密應回原 event 參考");
});

test("L3 client: hideToolCalls=true 時 update 仍 drop（維持既有行為）", () => {
  const custProfile = parseUiProfile({ hideToolCalls: true }, {});
  const event = {
    type: "tool_execution_update",
    toolCallId: "t4",
    toolName: "bash",
    args: {},
    partialResult: { content: [{ type: "text", text: "x=or-canary-abcdef123456" }] },
  };
  assert.equal(filterEvent(event, custProfile), null);
});
