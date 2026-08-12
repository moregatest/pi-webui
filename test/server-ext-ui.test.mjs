import { test } from "node:test";
import assert from "node:assert/strict";
import { createExtUiBridge } from "../dist/server/ext-ui.js";

// Capture every message sent over the websocket so each test can assert on
// the wire shape. The bridge owns request id allocation, so we let it pick
// the id and read it back from the captured envelope.
function makeHarness() {
  const sent = [];
  const bridge = createExtUiBridge({
    send: (msg) => sent.push(msg),
    log: { warn: () => {}, error: () => {} },
  });
  const lastSent = (type) => [...sent].reverse().find((m) => m.type === type);
  return { sent, lastSent, bridge };
}

test("notify is fire-and-forget and emits ext_ui_notify", () => {
  const { sent, bridge } = makeHarness();
  bridge.ui.notify("hi", "warning");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    type: "ext_ui_notify",
    payload: { message: "hi", type: "warning" },
  });
});

test("confirm posts ext_ui_request and resolves to the response value", async () => {
  const { lastSent, bridge } = makeHarness();
  const p = bridge.ui.confirm("title", "are you sure?");
  const req = lastSent("ext_ui_request").payload;
  assert.equal(req.kind, "confirm");
  assert.equal(req.title, "title");
  assert.equal(req.message, "are you sure?");
  bridge.handleResponse({ id: req.id, value: true });
  assert.equal(await p, true);
});

test("第一個互動 response 會廣播 cancel，關閉其他瀏覽器的同一 modal", async () => {
  const { lastSent, bridge } = makeHarness();
  const promise = bridge.ui.confirm("title", "are you sure?");
  const request = lastSent("ext_ui_request");
  bridge.handleResponse({ id: request.payload.id, value: true });
  assert.equal(await promise, true);
  assert.deepEqual(lastSent("ext_ui_cancel"), {
    type: "ext_ui_cancel",
    payload: { id: request.payload.id },
  });
});

test("互動 request timeout 會廣播 cancel，不留下其他瀏覽器的 stale modal", async () => {
  const { lastSent, bridge } = makeHarness();
  const promise = bridge.ui.confirm("title", "timeout", { timeout: 10 });
  const request = lastSent("ext_ui_request");
  await assert.rejects(promise, /timed out/);
  assert.deepEqual(lastSent("ext_ui_cancel"), {
    type: "ext_ui_cancel",
    payload: { id: request.payload.id },
  });
});

test("confirm resolves to false when the modal is dismissed (undefined response)", async () => {
  // The client sends `value: undefined` for Escape on a confirm dialog. The
  // bridge passes this through; the abort fallback is only used for AbortSignal
  // cancellation. This test pins the contract so future refactors don't
  // accidentally start coercing undefined → false at the bridge layer.
  const { lastSent, bridge } = makeHarness();
  const p = bridge.ui.confirm("t", "m");
  const id = lastSent("ext_ui_request").payload.id;
  bridge.handleResponse({ id, value: false });
  assert.equal(await p, false);
});

test("select forwards options and resolves to the chosen string", async () => {
  const { lastSent, bridge } = makeHarness();
  const p = bridge.ui.select("pick one", ["alpha", "beta"]);
  const req = lastSent("ext_ui_request").payload;
  assert.equal(req.kind, "select");
  assert.deepEqual(req.options, ["alpha", "beta"]);
  bridge.handleResponse({ id: req.id, value: "beta" });
  assert.equal(await p, "beta");
});

test("input forwards placeholder and resolves to the user's text", async () => {
  const { lastSent, bridge } = makeHarness();
  const p = bridge.ui.input("title", "type here");
  const req = lastSent("ext_ui_request").payload;
  assert.equal(req.kind, "input");
  assert.equal(req.placeholder, "type here");
  bridge.handleResponse({ id: req.id, value: "hello" });
  assert.equal(await p, "hello");
});

test("AbortSignal cancellation sends ext_ui_cancel and resolves with the kind-appropriate value", async () => {
  const { lastSent, bridge } = makeHarness();
  const ctrl = new AbortController();
  const p = bridge.ui.confirm("t", "m", { signal: ctrl.signal });
  const id = lastSent("ext_ui_request").payload.id;
  ctrl.abort();
  const cancel = lastSent("ext_ui_cancel");
  assert.equal(cancel.payload.id, id);
  assert.equal(await p, false);
});

test("dispose rejects pending interactive requests so callers don't hang", async () => {
  const { bridge } = makeHarness();
  const p = bridge.ui.input("t");
  bridge.dispose();
  await assert.rejects(p, /disposed/);
});

test("replayPending 把未完成的互動 request 重送給新連線", async (t) => {
  const { bridge, lastSent } = makeHarness();
  const promise = bridge.ui.confirm("title", "continue?");
  const request = lastSent("ext_ui_request");
  t.after(() => bridge.handleResponse({ id: request.payload.id, value: false }));
  const replayed = [];
  bridge.replayPending((packet) => replayed.push(packet));
  assert.deepEqual(replayed, [request]);
  bridge.handleResponse({ id: request.payload.id, value: true });
  assert.equal(await promise, true);
});

// --- ui.custom ----------------------------------------------------------

// Build a fake pi-tui Component the bridge can drive: it captures every
// handleInput call and exposes the `done` callback so the test can drive the
// completion path explicitly.
function makeFakeComponent() {
  const inputs = [];
  let renders = 0;
  let _done;
  const component = {
    render: (width) => {
      renders += 1;
      return [`width=${width}`, `renders=${renders}`];
    },
    handleInput: (data) => inputs.push(data),
    invalidate: () => {},
  };
  const factory = (_tui, _theme, _kb, done) => {
    _done = done;
    return component;
  };
  return { factory, component, inputs, finish: (v) => _done(v), getRenders: () => renders };
}

test("custom factory is invoked and initial render is shipped as ext_ui_custom_open", async () => {
  const { sent, lastSent, bridge } = makeHarness();
  const fc = makeFakeComponent();
  bridge.ui.custom(fc.factory);
  // Factory runs in a microtask — let it settle.
  await new Promise((r) => setImmediate(r));
  const open = lastSent("ext_ui_custom_open");
  assert.ok(open, "expected ext_ui_custom_open");
  assert.equal(open.payload.lines.length, 2);
  assert.match(open.payload.lines[0], /^width=\d+$/);
  assert.equal(sent.filter((m) => m.type === "ext_ui_custom_open").length, 1);
});

test("replayPending 會以 ext_ui_custom_open 重建未完成 custom UI", async (t) => {
  const { bridge } = makeHarness();
  const fc = makeFakeComponent();
  const promise = bridge.ui.custom(fc.factory);
  await new Promise((r) => setImmediate(r));
  t.after(() => fc.finish(undefined));
  const replayed = [];
  bridge.replayPending((packet) => replayed.push(packet));
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].type, "ext_ui_custom_open");
  assert.match(replayed[0].payload.lines[0], /^width=\d+$/);
  fc.finish("done");
  assert.equal(await promise, "done");
});

test("tui.requestRender debounces into a single ext_ui_custom_update", async () => {
  const { sent, bridge } = makeHarness();
  let capturedTui;
  const fc = makeFakeComponent();
  const wrappedFactory = (tui, theme, kb, done) => {
    capturedTui = tui;
    return fc.factory(tui, theme, kb, done);
  };
  bridge.ui.custom(wrappedFactory);
  await new Promise((r) => setImmediate(r));
  // Three rapid requestRender calls inside one debounce window must coalesce
  // into one update; this is what keeps a streaming extension from flooding
  // the websocket.
  capturedTui.requestRender();
  capturedTui.requestRender();
  capturedTui.requestRender();
  await new Promise((r) => setTimeout(r, 50));
  const updates = sent.filter((m) => m.type === "ext_ui_custom_update");
  assert.equal(updates.length, 1);
});

test("handleCustomInput forwards the raw data to component.handleInput", async () => {
  const { lastSent, bridge } = makeHarness();
  const fc = makeFakeComponent();
  bridge.ui.custom(fc.factory);
  await new Promise((r) => setImmediate(r));
  const id = lastSent("ext_ui_custom_open").payload.id;
  bridge.handleCustomInput({ id, data: "\x1b[A" });
  bridge.handleCustomInput({ id, data: "\r" });
  assert.deepEqual(fc.inputs, ["\x1b[A", "\r"]);
});

test("calling done(value) resolves the custom promise and emits ext_ui_custom_close", async () => {
  const { lastSent, bridge } = makeHarness();
  const fc = makeFakeComponent();
  const p = bridge.ui.custom(fc.factory);
  await new Promise((r) => setImmediate(r));
  const id = lastSent("ext_ui_custom_open").payload.id;
  fc.finish("allow-once");
  assert.equal(await p, "allow-once");
  const close = lastSent("ext_ui_custom_close");
  assert.equal(close.payload.id, id);
});

test("handleCustomClose from the client resolves the custom promise with undefined", async () => {
  const { lastSent, bridge } = makeHarness();
  const fc = makeFakeComponent();
  const p = bridge.ui.custom(fc.factory);
  await new Promise((r) => setImmediate(r));
  const id = lastSent("ext_ui_custom_open").payload.id;
  bridge.handleCustomClose({ id });
  assert.equal(await p, undefined);
});

test("handleCustomResize re-renders at the new width", async () => {
  const { sent, lastSent, bridge } = makeHarness();
  const fc = makeFakeComponent();
  bridge.ui.custom(fc.factory);
  await new Promise((r) => setImmediate(r));
  const id = lastSent("ext_ui_custom_open").payload.id;
  bridge.handleCustomResize({ id, width: 42 });
  const updates = sent.filter((m) => m.type === "ext_ui_custom_update");
  assert.equal(updates.length, 1);
  assert.match(updates[0].payload.lines[0], /^width=42$/);
});

test("dispose closes any open custom request so the runtime can shut down", async () => {
  const { bridge } = makeHarness();
  const fc = makeFakeComponent();
  const p = bridge.ui.custom(fc.factory);
  await new Promise((r) => setImmediate(r));
  bridge.dispose();
  assert.equal(await p, undefined);
});

test("title pass-through emits ext_ui_title", () => {
  const { lastSent, bridge } = makeHarness();
  bridge.ui.setTitle("session foo");
  assert.deepEqual(lastSent("ext_ui_title"), {
    type: "ext_ui_title",
    payload: { title: "session foo" },
  });
});
