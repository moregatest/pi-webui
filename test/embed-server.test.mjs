import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  isEmbedRequest,
  createTurnWriteTracker,
  createWsHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  reconnectTurnEnd,
} from "../dist/server/embed.js";

test("isEmbedRequest：自身網址帶 embed=1", () => {
  assert.equal(isEmbedRequest("?embed=1"), true);
  assert.equal(isEmbedRequest("?a=b&embed=1"), true);
  assert.equal(isEmbedRequest(""), false);
  assert.equal(isEmbedRequest("?embed=0"), false);
  assert.equal(isEmbedRequest("?embed=true"), false);
});

test("isEmbedRequest：登入頁的 next 帶 embed=1 也算", () => {
  assert.equal(isEmbedRequest(`?next=${encodeURIComponent("/agent/?embed=1")}`), true);
  assert.equal(isEmbedRequest(`?next=${encodeURIComponent("/agent/")}`), false);
  assert.equal(isEmbedRequest("?next=%zz"), false);
});

test("createTurnWriteTracker：唯讀工具不算寫入", () => {
  const t = createTurnWriteTracker();
  t.observe({ type: "tool_execution_end", toolName: "read", isError: false });
  t.observe({ type: "tool_execution_end", toolName: "publication_status", isError: false });
  assert.deepEqual(t.observe({ type: "agent_end" }), { contentChanged: false });
});

test("createTurnWriteTracker：非唯讀工具成功或失敗都算寫入（失敗前可能已寫了一半，寧可多送）", () => {
  const t = createTurnWriteTracker();
  t.observe({ type: "tool_execution_end", toolName: "bash", isError: true });
  assert.deepEqual(t.observe({ type: "agent_end" }), { contentChanged: true });
  t.observe({ type: "tool_execution_end", toolName: "upload_image", isError: false });
  assert.deepEqual(t.observe({ type: "agent_end" }), { contentChanged: true });
  // 每輪結束後重設
  assert.deepEqual(t.observe({ type: "agent_end" }), { contentChanged: false });
  t.observe({ type: "tool_execution_end", toolName: "some_future_tool", isError: false });
  assert.deepEqual(t.observe({ type: "agent_end" }), { contentChanged: true });
});

test("createTurnWriteTracker：current_page 是唯讀工具，不算寫入", () => {
  const t = createTurnWriteTracker();
  t.observe({ type: "tool_execution_end", toolName: "current_page", isError: false });
  assert.deepEqual(t.observe({ type: "agent_end" }), { contentChanged: false });
});

test("createTurnWriteTracker：willRetry 的 agent_end 不算一輪結束，寫入延續到真正結束", () => {
  const t = createTurnWriteTracker();
  t.observe({ type: "tool_execution_end", toolName: "bash", isError: false });
  assert.equal(t.observe({ type: "agent_end", willRetry: true }), null);
  assert.deepEqual(t.observe({ type: "agent_end" }), { contentChanged: true });
  assert.equal(t.observe({ type: "message_start" }), null);
});

class FakeWs extends EventEmitter {
  constructor() { super(); this.pings = 0; this.terminated = false; this.readyState = 1; }
  ping() { this.pings++; }
  terminate() { this.terminated = true; this.emit("close"); }
}

test("心跳間隔在 25～30 秒之間（代理閒置 300 秒之內）", () => {
  assert.ok(HEARTBEAT_INTERVAL_MS >= 25000 && HEARTBEAT_INTERVAL_MS <= 30000);
});

test("createWsHeartbeat：每個間隔送 ping，有 pong 就保留連線", () => {
  let tick;
  const hb = createWsHeartbeat({ setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => {} });
  const ws = new FakeWs();
  hb.track(ws);
  tick();
  assert.equal(ws.pings, 1);
  ws.emit("pong");
  tick();
  assert.equal(ws.pings, 2);
  assert.equal(ws.terminated, false);
});

test("createWsHeartbeat：連續一個間隔沒 pong 就切掉死連線；關閉後不再追蹤", () => {
  let tick;
  const hb = createWsHeartbeat({ setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => {} });
  const dead = new FakeWs();
  const live = new FakeWs();
  hb.track(dead);
  hb.track(live);
  tick();
  live.emit("pong");
  tick();
  assert.equal(dead.terminated, true);
  assert.equal(live.terminated, false);
  assert.equal(hb.size(), 1);
});

test("createWsHeartbeat：stop 會清掉計時器", () => {
  let cleared = 0;
  const hb = createWsHeartbeat({ setInterval: () => 7, clearInterval: (id) => { if (id === 7) cleared++; } });
  hb.stop();
  assert.equal(cleared, 1);
});

test("reconnectTurnEnd：重連（lastSeq 是數字）且不在串流 → 補送一輪結束，判斷不出寫入就當有改", () => {
  assert.deepEqual(reconnectTurnEnd({ lastSeq: 12, isStreaming: false }), { contentChanged: true, reconnect: true });
  assert.deepEqual(reconnectTurnEnd({ lastSeq: 0, isStreaming: false }), { contentChanged: true, reconnect: true });
});

test("reconnectTurnEnd：iframe 剛載入（lastSeq 不是數字）不送，避免每次換頁都跳「網站已更新」", () => {
  assert.equal(reconnectTurnEnd({ lastSeq: null, isStreaming: false }), null);
  assert.equal(reconnectTurnEnd({ lastSeq: undefined, isStreaming: false }), null);
  assert.equal(reconnectTurnEnd({ lastSeq: "3", isStreaming: false }), null);
});

test("reconnectTurnEnd：仍在串流就不送（由 turn-start 接手）", () => {
  assert.equal(reconnectTurnEnd({ lastSeq: 12, isStreaming: true }), null);
});
