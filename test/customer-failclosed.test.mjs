// test/customer-failclosed.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { missingCustomerSecrets } from "../dist/server/customer-policy.js";

test("missing: customer 缺 litellm creds → 列出", () => {
  const miss = missingCustomerSecrets(true, { PI_WEBUI_MODEL: "m",
    PI_WEBUI_PASSWORD: "p", PC2_SERVICE_HOST: "h", PC2_API_TOKEN: "t",
    PI_WEBUI_BASE_PATH: "/webui", PI_PROJECT_CWD: "/w" });
  assert.deepEqual(miss.sort(), ["LITELLM_API_KEY", "LITELLM_BASE_URL"]);
});
test("missing: customer 全備(litellm 版)→ 空", () => {
  const ok = missingCustomerSecrets(true, {
    PI_WEBUI_PASSWORD: "p", PI_WEBUI_MODEL: "m",
    LITELLM_BASE_URL: "http://readyai-litellm-proxy.internal:4001", LITELLM_API_KEY: "k",
    PC2_SERVICE_HOST: "h", PC2_API_TOKEN: "t", PI_WEBUI_BASE_PATH: "/webui", PI_PROJECT_CWD: "/w" });
  assert.deepEqual(ok, []);
});
test("missing: 非 customer → 空（不強制）", () => {
  assert.deepEqual(missingCustomerSecrets(false, {}), []);
});
