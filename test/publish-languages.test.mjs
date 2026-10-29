// test/publish-languages.test.mjs
// source-version v2：B 路發布語系＝主語系中預覽站 DB 與 baseline 不同者。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  normalizeSha256,
  parseSourceBaseline,
  selectChangedLanguages,
  createPreviewDbHasher,
} from "../dist/server/publish-languages.js";
import { parsePreviewMetaConfig, resolveLocalPublishConfig } from "../dist/server/customer-injection.js";

const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64);
const v2 = (extra = {}) => ({
  schema: "pgc-source-version-v2", source_lng: "zh-TW", content_sha256: "sha256:" + A, primary_lng: "en",
  sources: { en: { content_sha256: "sha256:" + A, targets: ["es"] }, "zh-TW": { content_sha256: "sha256:" + B, targets: ["ja"] } },
  sources_order: ["zh-TW", "en"], ...extra,
});
const hasher = (map) => async (lng) => (lng in map ? map[lng] : null);

test("normalizeSha256：接受 sha256: 前綴與純 hex，其他拒絕", () => {
  assert.equal(normalizeSha256("sha256:" + A.toUpperCase()), A);
  assert.equal(normalizeSha256(B), B);
  assert.equal(normalizeSha256("sha256:xyz"), undefined);
  assert.equal(normalizeSha256(null), undefined);
});

test("parseSourceBaseline：依 sources_order 排序，missing 記為 null，無 sources 回 undefined", () => {
  const b = parseSourceBaseline(v2({ sources: { ...v2().sources, de: { error: "missing" }, "bad lng": { content_sha256: A } } }));
  assert.deepEqual(b.order, ["zh-TW", "en", "de"]);
  assert.deepEqual(b.sources, { en: A, "zh-TW": B, de: null });
  assert.equal(parseSourceBaseline({ source_lng: "en", content_sha256: A }), undefined);
  assert.equal(parseSourceBaseline({ sources: {} }), undefined);
  assert.equal(parseSourceBaseline(null), undefined);
});

test("selectChangedLanguages：只回 hash 不同的主語系，保持書寫順序", async () => {
  const b = parseSourceBaseline(v2());
  assert.deepEqual(await selectChangedLanguages(b, hasher({ en: C, "zh-TW": B })), ["en"]);
  assert.deepEqual(await selectChangedLanguages(b, hasher({ en: C, "zh-TW": C })), ["zh-TW", "en"]);
  assert.deepEqual(await selectChangedLanguages(b, hasher({ en: A, "zh-TW": B })), []);
});

test("selectChangedLanguages：原站缺 DB 而預覽站有→發布；預覽站缺 DB→略過", async () => {
  const b = parseSourceBaseline(v2({ sources: { en: { error: "missing" }, "zh-TW": { content_sha256: B } } }));
  assert.deepEqual(await selectChangedLanguages(b, hasher({ en: C })), ["en"]);
});

test("selectChangedLanguages：預覽站讀取失敗要 throw，不可當成沒變", async () => {
  const b = parseSourceBaseline(v2());
  await assert.rejects(selectChangedLanguages(b, async () => { throw new Error("boom"); }));
});

test("createPreviewDbHasher：打 download-db、帶 Bearer、算檔案 sha256", async () => {
  const bytes = Buffer.concat([Buffer.from("SQLite format 3\0", "latin1"), Buffer.from("payload")]);
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization });
    if (url.includes("lng=zh-TW")) return new Response(bytes, { status: 200 });
    if (url.includes("lng=de")) return new Response("no", { status: 404 });
    if (url.includes("lng=fr")) return new Response("html", { status: 200 });
    return new Response("err", { status: 500 });
  };
  const h = createPreviewDbHasher("https://p.example.com/", "tok", fetchImpl);
  assert.equal(await h("zh-TW"), createHash("sha256").update(bytes).digest("hex"));
  assert.equal(seen[0].url, "https://p.example.com/readyscript/capps/pc2-p/service/?m=db&a=download-db&lng=zh-TW");
  assert.equal(seen[0].auth, "Bearer tok");
  assert.equal(await h("de"), null);
  await assert.rejects(h("fr"));
  await assert.rejects(h("en"));
});

test("resolveLocalPublishConfig：v2 meta 以 resolveLanguages 動態決定語系", async () => {
  const meta = parsePreviewMetaConfig(JSON.stringify({ app_name: "x-preview", origin_source_version: v2() }));
  const env = { PC2_SERVICE_HOST_ORIGINAL: "https://origin.example.com", PC2_API_TOKEN: "t", PC2_SERVICE_HOST: "https://x-preview.fly.dev" };
  const config = resolveLocalPublishConfig(env, meta, "/w", hasher({ en: C, "zh-TW": B }));
  assert.deepEqual(config.languages, ["zh-TW", "en"]);
  assert.deepEqual(await config.resolveLanguages(), ["en"]);
});

test("resolveLocalPublishConfig：舊 meta 無 sources 退回 [source_lng]、沒有 resolveLanguages", () => {
  const meta = parsePreviewMetaConfig(JSON.stringify({ origin_source_version: { source_lng: "zh-TW", content_sha256: A } }));
  const config = resolveLocalPublishConfig({ PC2_SERVICE_HOST_ORIGINAL: "https://o", PC2_API_TOKEN: "t" }, meta, "/w");
  assert.deepEqual(config.languages, ["zh-TW"]);
  assert.equal(config.resolveLanguages, undefined);
});

test("resolveLocalPublishConfig：v2 但缺 PC2_SERVICE_HOST → resolveLanguages 失敗（不可默默發布）", async () => {
  const meta = parsePreviewMetaConfig(JSON.stringify({ origin_source_version: v2() }));
  const config = resolveLocalPublishConfig({ PC2_SERVICE_HOST_ORIGINAL: "https://o", PC2_API_TOKEN: "t" }, meta, "/w");
  await assert.rejects(config.resolveLanguages());
});
