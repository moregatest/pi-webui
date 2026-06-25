// test/customer-failclosed.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { missingCustomerSecrets } from "../dist/server/customer-policy.js";

test("missing: customer 缺 password → 列出", () => {
  const miss = missingCustomerSecrets(true, { PI_WEBUI_MODEL: "m", OPENROUTER_API_KEY: "k",
    PC2_SERVICE_HOST: "h", PC2_API_TOKEN: "t", PI_WEBUI_BASE_PATH: "/webui", PI_PROJECT_CWD: "/workspace" });
  assert.deepEqual(miss, ["PI_WEBUI_PASSWORD"]);
});
test("missing: customer 全備 → 空", () => {
  assert.deepEqual(missingCustomerSecrets(true, {
    PI_WEBUI_PASSWORD: "p", PI_WEBUI_MODEL: "m", OPENROUTER_API_KEY: "k",
    PC2_SERVICE_HOST: "h", PC2_API_TOKEN: "t", PI_WEBUI_BASE_PATH: "/webui", PI_PROJECT_CWD: "/workspace" }), []);
});
test("missing: 非 customer → 空（不強制）", () => {
  assert.deepEqual(missingCustomerSecrets(false, {}), []);
});
