// test/customer-injection.test.mjs
// Task 4：publish_confirmed 接進 customer tool 注入 + LocalPublishConfig 解析。
// 對應 spec 2026-08-18-pgc-preview-local-minimal-design §3、plan Task 4。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCustomerInjection,
  parseOnboardStatusConfig,
  subdomainOfHost,
  resolveLocalPublishConfig,
} from "../dist/server/customer-injection.js";

const SHA = "sha256:" + "ab".repeat(32);

function fakePublishDeps() {
  return {
    fetchOriginVersion: async () => ({ source_lng: "en", content_sha256: SHA }),
    readOnboardOriginVersion: async () => null,
    pushBack: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    pushDb: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
}

// ─── subdomainOfHost ───────────────────────────────────────────────────────

test("subdomainOfHost: 取第一段 label", () => {
  assert.equal(subdomainOfHost("https://my-app.fly.dev"), "my-app");
  assert.equal(subdomainOfHost("http://foo.example.com:4001"), "foo");
  assert.equal(subdomainOfHost("my-app.fly.dev"), "my-app");
});

test("subdomainOfHost: IP / localhost / www / undefined → null", () => {
  assert.equal(subdomainOfHost("http://127.0.0.1:4001"), null);
  assert.equal(subdomainOfHost("http://localhost:9999"), null);
  assert.equal(subdomainOfHost("https://www.example.com"), null);
  assert.equal(subdomainOfHost(undefined), null);
  assert.equal(subdomainOfHost(""), null);
});

// ─── parseOnboardStatusConfig ──────────────────────────────────────────────

test("parseOnboardStatusConfig: 解析 fly_app / lng / languages / origin_source_version.source_lng", () => {
  const yaml = [
    "version: 2",
    "lng: en",
    "languages:",
    "- en",
    "- zh-TW",
    "stages:",
    "  preview:",
    "    fly_app: my-app-preview",
    "origin_source_version:",
    "  source_lng: en",
    "  content_sha256: sha256:abc",
  ].join("\n");
  const c = parseOnboardStatusConfig(yaml);
  assert.equal(c.flyApp, "my-app-preview");
  assert.equal(c.sourceLng, "en"); // origin_source_version.source_lng 優先
  assert.deepEqual(c.languages, ["en", "zh-TW"]);
});

test("parseOnboardStatusConfig: 無檔案 → 空物件", () => {
  assert.deepEqual(parseOnboardStatusConfig(null), {});
  assert.deepEqual(parseOnboardStatusConfig(""), {});
});

test("parseOnboardStatusConfig: 無 origin_source_version → 用頂層 lng", () => {
  const c = parseOnboardStatusConfig("lng: zh-TW\nstages:\n  preview:\n    fly_app: x-preview\n");
  assert.equal(c.sourceLng, "zh-TW");
  assert.equal(c.flyApp, "x-preview");
});

// ─── resolveLocalPublishConfig ─────────────────────────────────────────────

test("resolveLocalPublishConfig: 完整解析", () => {
  const config = resolveLocalPublishConfig(
    {
      PC2_SERVICE_HOST_ORIGINAL: "https://demo.example.com/",
      PC2_API_TOKEN: "tok1234567890",
      PC2_SERVICE_HOST: "https://my-app.fly.dev",
    },
    { flyApp: "my-app-preview", sourceLng: "en", languages: ["en", "zh-TW"] },
    "/workspace/proj",
  );
  assert.equal(config.originBaseUrl, "https://demo.example.com/");
  assert.equal(config.siteToken, "tok1234567890");
  assert.equal(config.appName, "my-app-preview");
  assert.deepEqual(config.languages, ["en", "zh-TW"]);
  assert.equal(config.cwd, "/workspace/proj");
});

test("resolveLocalPublishConfig: fly_app 缺 → subdomain fallback", () => {
  const config = resolveLocalPublishConfig(
    {
      PC2_SERVICE_HOST_ORIGINAL: "https://demo",
      PC2_API_TOKEN: "t",
      PC2_SERVICE_HOST: "https://my-app.fly.dev",
    },
    { sourceLng: "en" },
    "/w",
  );
  assert.equal(config.appName, "my-app");
});

test("resolveLocalPublishConfig: 缺 originBaseUrl 或 token → null", () => {
  assert.equal(resolveLocalPublishConfig({}, { sourceLng: "en" }, "/w"), null);
  assert.equal(
    resolveLocalPublishConfig({ PC2_SERVICE_HOST_ORIGINAL: "https://x" }, { sourceLng: "en" }, "/w"),
    null,
  );
});

test("resolveLocalPublishConfig: 翻譯語系去重（含來源）＋來源語系缺省 en", () => {
  const config = resolveLocalPublishConfig(
    { PC2_SERVICE_HOST_ORIGINAL: "https://x", PC2_API_TOKEN: "t" },
    { languages: ["en", "en", "zh-TW"] },
    "/w",
  );
  assert.deepEqual(config.languages, ["en", "zh-TW"]);
});

// ─── resolveCustomerInjection：publish_confirmed 注入 ───────────────────────

test("injection: plain customer 有 publish deps → upload_image + publish_confirmed", () => {
  const r = resolveCustomerInjection({
    isCustomer: true,
    customerOpen: false,
    publishDeps: fakePublishDeps(),
  });
  assert.equal(r.noExtensions, true);
  assert.equal(r.noSkills, true);
  assert.equal(r.noTools, "builtin");
  assert.deepEqual(r.tools, ["upload_image", "publish_confirmed"]);
  assert.ok(Array.isArray(r.customTools));
  assert.equal(r.customTools.length, 2);
  assert.equal(r.customTools[0].name, "upload_image");
  assert.equal(r.customTools[1].name, "publish_confirmed");
});

test("injection: plain customer 無 publish deps（null）→ 只有 upload_image", () => {
  const r = resolveCustomerInjection({
    isCustomer: true,
    customerOpen: false,
    publishDeps: null,
  });
  assert.deepEqual(r.tools, ["upload_image"]);
  assert.equal(r.customTools.length, 1);
  assert.equal(r.customTools[0].name, "upload_image");
});

test("injection: customer-open 不注入 publish（維持 read/bash）", () => {
  const r = resolveCustomerInjection({
    isCustomer: true,
    customerOpen: true,
    publishDeps: fakePublishDeps(),
  });
  assert.deepEqual(r.tools, ["read", "bash"]);
  assert.equal(r.customTools, undefined);
});

test("injection: 非 customer 不注入 publish", () => {
  const r = resolveCustomerInjection({
    isCustomer: false,
    customerOpen: false,
    publishDeps: fakePublishDeps(),
  });
  assert.equal(r.customTools, undefined);
});
