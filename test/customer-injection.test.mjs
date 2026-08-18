// test/customer-injection.test.mjs
// Task 4 + Phase 4 契約：publish_confirmed 接進 customer tool 注入 + LocalPublishConfig 解析。
// baseline 落點改 data/preview-meta.json（origin_source_version），不讀 .onboard-status.yaml。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveCustomerInjection,
  parsePreviewMetaConfig,
  subdomainOfHost,
  resolveLocalPublishConfig,
  mergeInjectedTools,
} from "../dist/server/customer-injection.js";

const SHA = "sha256:" + "ab".repeat(32);

function fakePublishDeps() {
  return {
    fetchOriginVersion: async () => ({ source_lng: "en", content_sha256: SHA }),
    readRecordedOriginVersion: async () => null,
    writeForcePublishAudit: async () => {},
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

// ─── parsePreviewMetaConfig ────────────────────────────────────────────────

test("parsePreviewMetaConfig: 解析 app_name / origin_source_version.source_lng", () => {
  const json = JSON.stringify({
    preview_url: "https://my-app-preview.fly.dev/",
    app_name: "my-app-preview",
    domain: "www.example.com",
    origin_source_version: {
      source_lng: "en",
      content_sha256: "sha256:abc",
      recorded_at: "2026-08-18T10:00:00+08:00",
    },
  });
  const c = parsePreviewMetaConfig(json);
  assert.equal(c.appName, "my-app-preview");
  assert.equal(c.sourceLng, "en");
});

test("parsePreviewMetaConfig: 無檔案 / 空 → 空物件", () => {
  assert.deepEqual(parsePreviewMetaConfig(null), {});
  assert.deepEqual(parsePreviewMetaConfig(""), {});
});

test("parsePreviewMetaConfig: 無 origin_source_version → 只有 appName", () => {
  const c = parsePreviewMetaConfig(JSON.stringify({ app_name: "x-preview" }));
  assert.equal(c.appName, "x-preview");
  assert.equal(c.sourceLng, undefined);
});

test("parsePreviewMetaConfig: 非 JSON → 空物件", () => {
  assert.deepEqual(parsePreviewMetaConfig("not-json"), {});
});

// ─── resolveLocalPublishConfig ─────────────────────────────────────────────

test("resolveLocalPublishConfig: 完整解析（app_name + source_lng）", () => {
  const config = resolveLocalPublishConfig(
    {
      PC2_SERVICE_HOST_ORIGINAL: "https://demo.example.com/",
      PC2_API_TOKEN: "tok1234567890",
      PC2_SERVICE_HOST: "https://my-app.fly.dev",
    },
    { appName: "my-app-preview", sourceLng: "en" },
    "/workspace/proj",
  );
  assert.equal(config.originBaseUrl, "https://demo.example.com/");
  assert.equal(config.siteToken, "tok1234567890");
  assert.equal(config.appName, "my-app-preview");
  assert.deepEqual(config.languages, ["en"]);
  assert.equal(config.cwd, "/workspace/proj");
});

test("resolveLocalPublishConfig: app_name 缺 → subdomain fallback", () => {
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

test("resolveLocalPublishConfig: 來源語系缺省 en", () => {
  const config = resolveLocalPublishConfig(
    { PC2_SERVICE_HOST_ORIGINAL: "https://x", PC2_API_TOKEN: "t" },
    {},
    "/w",
  );
  assert.deepEqual(config.languages, ["en"]);
});

test("resolveLocalPublishConfig: confirmationId 取 PGC_CONFIRMATION_ID（缺省 cli）", () => {
  const a = resolveLocalPublishConfig(
    { PC2_SERVICE_HOST_ORIGINAL: "https://x", PC2_API_TOKEN: "t", PGC_CONFIRMATION_ID: "conf-9" },
    { sourceLng: "en" },
    "/w",
  );
  assert.equal(a.confirmationId, "conf-9");

  const b = resolveLocalPublishConfig(
    { PC2_SERVICE_HOST_ORIGINAL: "https://x", PC2_API_TOKEN: "t" },
    { sourceLng: "en" },
    "/w",
  );
  assert.equal(b.confirmationId, "cli");
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

test("injection: customer-open 有 publish deps → read/bash + publish_confirmed（走 extraTools）", () => {
  const r = resolveCustomerInjection({
    isCustomer: true,
    customerOpen: true,
    publishDeps: fakePublishDeps(),
  });
  assert.deepEqual(r.tools, ["read", "bash", "publish_confirmed"]);
  // customTools 必須維持 undefined：index.ts 走 `customTools ?? hostGuardTools`，
  // 一旦這裡有值就會把 in-process L0/L1/L3 guarded read/bash 整組蓋掉。
  assert.equal(r.customTools, undefined);
  assert.equal(r.extraTools.length, 1);
  assert.equal(r.extraTools[0].name, "publish_confirmed");
});

test("injection: customer-open 無 publish deps（null）→ 維持 read/bash", () => {
  const r = resolveCustomerInjection({
    isCustomer: true,
    customerOpen: true,
    publishDeps: null,
  });
  assert.deepEqual(r.tools, ["read", "bash"]);
  assert.equal(r.customTools, undefined);
  assert.equal(r.extraTools, undefined);
});

test("mergeInjectedTools: extraTools 附加在 base 之後，不覆蓋 base", () => {
  const base = [{ name: "read" }, { name: "bash" }];
  const extra = [{ name: "publish_confirmed" }];
  assert.deepEqual(mergeInjectedTools(base, extra).map((t) => t.name), [
    "read",
    "bash",
    "publish_confirmed",
  ]);
  // base 為 undefined（無 sandbox、無 hostGuard）時只回 extra
  assert.deepEqual(mergeInjectedTools(undefined, extra).map((t) => t.name), ["publish_confirmed"]);
  // 無 extra 時原樣回傳 base（維持 index.ts 既有 `?? hostGuardTools` 語義）
  assert.equal(mergeInjectedTools(base, undefined), base);
  assert.equal(mergeInjectedTools(undefined, []), undefined);
});

test("injection: 非 customer 不注入 publish", () => {
  const r = resolveCustomerInjection({
    isCustomer: false,
    customerOpen: false,
    publishDeps: fakePublishDeps(),
  });
  assert.equal(r.customTools, undefined);
});
