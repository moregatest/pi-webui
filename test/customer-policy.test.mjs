// test/customer-policy.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCustomerMode, isBlockedCustomerMessage, scrubForCustomer } from "../dist/server/customer-policy.js";

test("isCustomerMode: profileName customer → true", () => {
  assert.equal(isCustomerMode("customer", undefined), true);
});
test("isCustomerMode: 其他 profile → false", () => {
  assert.equal(isCustomerMode("staff", { ui: {} }), false);
});
test("isCustomerMode: 無 profile → false", () => {
  assert.equal(isCustomerMode(undefined, undefined), false);
});

test("gate: customer 封 bash", () => {
  assert.equal(isBlockedCustomerMessage({ type: "bash", command: "printenv" }, true), true);
});
test("gate: customer 封 list_dir / cycle_model", () => {
  assert.equal(isBlockedCustomerMessage({ type: "list_dir", path: "/" }, true), true);
  assert.equal(isBlockedCustomerMessage({ type: "cycle_model" }, true), true);
});
test("gate: customer 封危險 slash（login/model/settings/export/cwd）", () => {
  for (const name of ["login", "logout", "model", "scoped-models", "settings", "export", "import", "cwd"]) {
    assert.equal(isBlockedCustomerMessage({ type: "slash_command", name }, true), true, name);
  }
});
test("gate: customer 放行 prompt / abort / ready", () => {
  assert.equal(isBlockedCustomerMessage({ type: "prompt", message: "hi" }, true), false);
  assert.equal(isBlockedCustomerMessage({ type: "abort" }, true), false);
  assert.equal(isBlockedCustomerMessage({ type: "ready" }, true), false);
});
test("gate: 非 customer 一律放行", () => {
  assert.equal(isBlockedCustomerMessage({ type: "bash", command: "x" }, false), false);
});

test("scrub: customer 移除敏感欄位", () => {
  const out = scrubForCustomer({
    type: "bootstrap", model: "openrouter/x", agentDir: "/root/.pi",
    sessionDir: "/ws/.pi", homeDir: "/root", activeTools: ["bash"], keep: "ok",
  }, true);
  assert.equal(out.model, undefined);
  assert.equal(out.agentDir, undefined);
  assert.equal(out.sessionDir, undefined);
  assert.equal(out.homeDir, undefined);
  assert.equal(out.activeTools, undefined);
  assert.equal(out.keep, "ok");
});
test("scrub: 非 customer 原樣", () => {
  const p = { model: "x", agentDir: "/r" };
  assert.deepEqual(scrubForCustomer(p, false), p);
});
