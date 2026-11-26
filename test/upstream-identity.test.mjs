// W60-01：信任上游身分與「回到專案清單」網址的純函式測試
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTrustUpstreamHeader,
  isLoopbackHost,
  isLoopbackAddress,
  assertTrustUpstreamAllowed,
  readUpstreamIdentity,
  parseHomeUrl,
} from "../dist/server/upstream-identity.js";

test("parseTrustUpstreamHeader：沒設回 null、名稱轉小寫", () => {
  assert.equal(parseTrustUpstreamHeader(undefined), null);
  assert.equal(parseTrustUpstreamHeader(""), null);
  assert.equal(parseTrustUpstreamHeader("  "), null);
  assert.equal(parseTrustUpstreamHeader("X-ReadyAI-User"), "x-readyai-user");
  assert.equal(parseTrustUpstreamHeader("tailscale-user-login"), "tailscale-user-login");
});

test("parseTrustUpstreamHeader：格式錯或協定自用的標頭拒絕", () => {
  for (const bad of ["x user", "x_user", "-x", "x:y", "x".repeat(65), "Cookie", "Host", "Authorization",
    "X-Forwarded-For", "Origin", "sec-websocket-protocol"]) {
    assert.throws(() => parseTrustUpstreamHeader(bad), /PI_WEBUI_TRUST_UPSTREAM_HEADER/, bad);
  }
});

test("isLoopbackHost：只接受字面的 127.0.0.1／::1", () => {
  for (const ok of ["127.0.0.1", "::1", "[::1]"]) assert.equal(isLoopbackHost(ok), true, ok);
  for (const bad of ["0.0.0.0", "::", "localhost", "192.168.1.2", "127.0.0.2", "", undefined]) {
    assert.equal(isLoopbackHost(bad), false, String(bad));
  }
});

test("isLoopbackAddress：IPv4、IPv6 與 IPv4-mapped", () => {
  for (const ok of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(isLoopbackAddress(ok), true, ok);
  for (const bad of ["10.0.0.1", "::ffff:10.0.0.1", "", null, undefined]) assert.equal(isLoopbackAddress(bad), false);
});

test("assertTrustUpstreamAllowed：非本機綁定、隧道、密碼並存都拒絕", () => {
  const base = { header: "x-readyai-user", host: "127.0.0.1", tunnelEnabled: false, passwordSet: false };
  assert.doesNotThrow(() => assertTrustUpstreamAllowed(base));
  assert.doesNotThrow(() => assertTrustUpstreamAllowed({ ...base, host: "::1" }));
  assert.doesNotThrow(() => assertTrustUpstreamAllowed({ ...base, header: null, host: "0.0.0.0", tunnelEnabled: true }));
  assert.throws(() => assertTrustUpstreamAllowed({ ...base, host: "0.0.0.0" }), /只能在綁定 127\.0\.0\.1 或 ::1/);
  assert.throws(() => assertTrustUpstreamAllowed({ ...base, host: "localhost" }), /只能在綁定/);
  assert.throws(() => assertTrustUpstreamAllowed({ ...base, tunnelEnabled: true }), /--tunnel/);
  assert.throws(() => assertTrustUpstreamAllowed({ ...base, passwordSet: true }), /二選一/);
});

test("readUpstreamIdentity：合法值、缺標頭、重複、控制字元、逗號、過長", () => {
  const n = "x-readyai-user";
  assert.equal(readUpstreamIdentity({ [n]: "tung@example.com" }, n), "tung@example.com");
  assert.equal(readUpstreamIdentity({ [n]: "  owner one  " }, n), "owner one");
  assert.equal(readUpstreamIdentity({}, n), null);
  assert.equal(readUpstreamIdentity({ [n]: "" }, n), null);
  assert.equal(readUpstreamIdentity({ [n]: ["a", "b"] }, n), null);
  assert.equal(readUpstreamIdentity({ [n]: "a, b" }, n), null);
  assert.equal(readUpstreamIdentity({ [n]: "a\tb" }, n), null);
  assert.equal(readUpstreamIdentity({ [n]: "使用者" }, n), null);
  assert.equal(readUpstreamIdentity({ [n]: "a".repeat(257) }, n), null);
  assert.equal(readUpstreamIdentity({ [n]: "a".repeat(256) }, n), "a".repeat(256));
});

test("parseHomeUrl：只收 http(s) 絕對網址或站內路徑", () => {
  assert.equal(parseHomeUrl(undefined), null);
  assert.equal(parseHomeUrl(""), null);
  assert.equal(parseHomeUrl("/"), "/");
  assert.equal(parseHomeUrl("/continue/"), "/continue/");
  assert.equal(parseHomeUrl("https://center.example.ts.net/continue/"), "https://center.example.ts.net/continue/");
  for (const bad of ["javascript:alert(1)", "//evil.example", "/\\evil", "continue", "ftp://x/",
    "https://u:p@center.example/", "data:text/html,x"]) {
    assert.throws(() => parseHomeUrl(bad), /PI_WEBUI_HOME_URL/, bad);
  }
});
