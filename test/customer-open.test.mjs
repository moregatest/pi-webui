// test/customer-open.test.mjs
// Task 3: isCustomerOpenMode 單元測試
// Task 4: customer-open 整合測試（PI_WEBUI_SKILLS_OPEN=1 放寬技能鎖）

import { test } from "node:test";
import assert from "node:assert/strict";
import { isCustomerOpenMode } from "../dist/server/customer-policy.js";

// ─── Task 3：單元測試 ────────────────────────────────────────────────────────

test("open: customer + SKILLS_OPEN=1 → true", () => {
  assert.equal(isCustomerOpenMode("customer", { PI_WEBUI_SKILLS_OPEN: "1" }), true);
});
test("open: customer 無 flag → false（維持鎖死）", () => {
  assert.equal(isCustomerOpenMode("customer", {}), false);
});
test("open: 非 customer → false", () => {
  assert.equal(isCustomerOpenMode("staff", { PI_WEBUI_SKILLS_OPEN: "1" }), false);
});
