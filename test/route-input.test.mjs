import { test } from "node:test";
import assert from "node:assert/strict";
import { routeInput } from "../public/route-input.mjs";

test("bash mode: routes to bash without optimistic bubble or running state", () => {
  const r = routeInput({ message: "ls", bashMode: true });
  assert.equal(r.kind, "bash");
  assert.equal(r.command, "ls");
  assert.equal(r.optimistic, false, "bash must not append a user bubble");
  assert.equal(r.setRunning, false, "bash must not flip the running/typing state");
});

test("leading '!' without bash mode: routes to bash", () => {
  const r = routeInput({ message: "!ls", bashMode: false });
  assert.equal(r.kind, "bash");
  assert.equal(r.command, "ls");
  assert.equal(r.optimistic, false);
  assert.equal(r.setRunning, false);
});

test("slash command: parsed name and arg", () => {
  const r = routeInput({ message: "/name foo bar", bashMode: false });
  assert.equal(r.kind, "slash");
  assert.equal(r.name, "name");
  assert.equal(r.arg, "foo bar");
});

test("plain prompt: appends optimistic bubble and sets running", () => {
  const r = routeInput({ message: "hi", bashMode: false });
  assert.equal(r.kind, "prompt");
  assert.equal(r.message, "hi");
  assert.equal(r.optimistic, true);
  assert.equal(r.setRunning, true);
});

test("empty input: routed as empty", () => {
  assert.equal(routeInput({ message: "   ", bashMode: false }).kind, "empty");
  assert.equal(routeInput({ message: "!  ", bashMode: false }).kind, "empty");
});

test("forcePrompt(點建議句):命令模式或 / ! 開頭都強制送成對話", () => {
  for (const [message, bashMode] of [["echo safe", true], ["!ls", false], ["/new", false]]) {
    const r = routeInput({ message, bashMode, forcePrompt: true });
    assert.equal(r.kind, "prompt", message);
    assert.equal(r.message, message);
  }
});
