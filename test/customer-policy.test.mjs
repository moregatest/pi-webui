// test/customer-policy.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCustomerMode, isBlockedCustomerMessage, scrubForCustomer, customerOpenSkillGuardWarning } from "../dist/server/customer-policy.js";

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

// ── P0 防呆：customer-open 無 skill-allow 白名單警告 ─────────────────────────
// issue #2 P0:容器 customer-open（PI_WEBUI_SKILLS_OPEN=1）放行 skills，但漏設
// --skill-allow，cwd 的 operator 技能（onboard-*/readyai-publish…）全數載入，
// 客戶可見。啟動時應印明確警告。

test("guard: customer-open 且無 skill-allow（undefined）→ 回警告字串", () => {
  const w = customerOpenSkillGuardWarning("customer", { PI_WEBUI_SKILLS_OPEN: "1" }, undefined);
  assert.ok(w, "應回非空警告");
  assert.match(w, /skill-allow|白名單/);
});
test("guard: customer-open 且白名單為空陣列 → 回警告", () => {
  assert.ok(customerOpenSkillGuardWarning("customer", { PI_WEBUI_SKILLS_OPEN: "1" }, []));
});
test("guard: customer-open 已設白名單 → null（不警告）", () => {
  assert.equal(
    customerOpenSkillGuardWarning("customer", { PI_WEBUI_SKILLS_OPEN: "1" }, ["customer-pgc-dialogue"]),
    null,
  );
});
test("guard: plain customer 無 SKILLS_OPEN → null（非 open，skills 本來就鎖死）", () => {
  assert.equal(customerOpenSkillGuardWarning("customer", {}, undefined), null);
});
test("guard: 非 customer profile → null", () => {
  assert.equal(customerOpenSkillGuardWarning("staff", { PI_WEBUI_SKILLS_OPEN: "1" }, undefined), null);
});
