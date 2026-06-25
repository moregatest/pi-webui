// test/customer-policy.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCustomerMode } from "../dist/server/customer-policy.js";

test("isCustomerMode: profileName customer → true", () => {
  assert.equal(isCustomerMode("customer", undefined), true);
});
test("isCustomerMode: 其他 profile → false", () => {
  assert.equal(isCustomerMode("staff", { ui: {} }), false);
});
test("isCustomerMode: 無 profile → false", () => {
  assert.equal(isCustomerMode(undefined, undefined), false);
});
