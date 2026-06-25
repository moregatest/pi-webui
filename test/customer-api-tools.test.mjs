import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCustomerApiTools } from "../dist/tools/customer-api-tools.js";

test("buildCustomerApiTools: 只含 upload_image", () => {
  const tools = buildCustomerApiTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "upload_image");
  assert.ok(tools[0].parameters);
  assert.equal(typeof tools[0].execute, "function");
});

test("upload_image.execute: query string 注入假副檔名應被拒絕（不發 fetch）", async () => {
  const calls = [];
  globalThis.fetch = async (url, opt) => { calls.push({ url, opt });
    return { status: 200, async json(){ return {}; }, async text(){ return ""; } }; };
  const [tool] = buildCustomerApiTools();
  const res = await tool.execute("call_qs", { image_url: "https://cdn.evil.com/abc.php?foo=x.jpg" }, undefined, undefined, {});
  assert.equal(calls.length, 0, "fetch 不應被呼叫");
  const payload = JSON.stringify(res);
  assert.match(payload, /bad_ext|不支援/);
});

test("upload_image.execute: 打 service、回最小資訊、不洩漏 hostPath", async () => {
  process.env.PC2_SERVICE_HOST = "https://demo.example.com";
  process.env.PC2_API_TOKEN = "a".repeat(64);
  const calls = [];
  globalThis.fetch = async (url, opt) => { calls.push({ url, opt });
    return { status: 200, async json(){ return { success: true, name: "abc.jpg" }; }, async text(){ return ""; } }; };
  const [tool] = buildCustomerApiTools();
  const res = await tool.execute("call1", { image_url: "https://x/y.jpg" }, undefined, undefined, {});
  const payload = JSON.stringify(res);
  assert.match(payload, /abc\.jpg/);
  assert.doesNotMatch(payload, /\/var\/www\/html/);
  assert.ok(calls[0].url.includes("demo.example.com"));
  assert.match(String(calls[0].opt.headers.Authorization || ""), /Bearer a{64}/);
});
