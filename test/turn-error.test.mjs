import { test } from "node:test";
import assert from "node:assert/strict";
import { findFailedTurn, scrubTurnError } from "../dist/server/turn-error.js";

test("findFailedTurn: stopReason error on latest assistant → hit", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [], stopReason: "error", errorMessage: "401 User not found." },
  ];
  const hit = findFailedTurn(messages);
  assert.ok(hit);
  assert.match(hit.message, /401 User not found/);
});

test("findFailedTurn: errorMessage with empty content (no stopReason) → hit", () => {
  const messages = [{ role: "assistant", content: [], errorMessage: "boom" }];
  assert.ok(findFailedTurn(messages));
});

test("findFailedTurn: healthy turn → null", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
  ];
  assert.equal(findFailedTurn(messages), null);
});

test("findFailedTurn: latest assistant healthy, older failed → null (只看最新)", () => {
  const messages = [
    { role: "assistant", content: [], stopReason: "error", errorMessage: "old fail" },
    { role: "user", content: "retry" },
    { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
  ];
  assert.equal(findFailedTurn(messages), null);
});

test("findFailedTurn: empty/no assistant → null", () => {
  assert.equal(findFailedTurn([]), null);
  assert.equal(findFailedTurn([{ role: "user", content: "hi" }]), null);
});

test("scrubTurnError masks sk- and Bearer tokens", () => {
  assert.equal(scrubTurnError("bad key sk-litellm-abc123"), "bad key [token]");
  assert.equal(scrubTurnError("auth Bearer eyJx.y.z failed"), "auth [token] failed");
});
