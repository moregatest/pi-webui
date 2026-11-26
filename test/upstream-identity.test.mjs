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
  loadGatewaySecret,
  gatewaySecretMatches,
  parseTrustedOrigin,
  originAllowed,
} from "../dist/server/upstream-identity.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("parseTrustUpstreamHeader：沒設回 null、名稱轉小寫", () => {
  assert.equal(parseTrustUpstreamHeader(undefined), null);
  assert.equal(parseTrustUpstreamHeader(""), null);
  assert.equal(parseTrustUpstreamHeader("  "), null);
  assert.equal(parseTrustUpstreamHeader("X-ReadyAI-User"), "x-readyai-user");
  assert.equal(parseTrustUpstreamHeader("tailscale-user-login"), "tailscale-user-login");
});

test("parseTrustUpstreamHeader：格式錯或協定自用的標頭拒絕", () => {
  for (const bad of ["x user", "x_user", "-x", "x:y", "x".repeat(65), "Cookie", "Host", "Authorization",
    "X-Forwarded-For", "Origin", "sec-websocket-protocol", "X-ReadyAI-Gateway-Secret"]) {
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
  const base = { header: "x-readyai-user", host: "127.0.0.1", tunnelEnabled: false, passwordSet: false,
    secretFile: "/run/gw.secret", trustedOrigin: "http://gw.example:8790" };
  assert.doesNotThrow(() => assertTrustUpstreamAllowed(base));
  assert.doesNotThrow(() => assertTrustUpstreamAllowed({ ...base, host: "::1" }));
  assert.doesNotThrow(() => assertTrustUpstreamAllowed({ ...base, header: null, host: "0.0.0.0", tunnelEnabled: true }));
  assert.throws(() => assertTrustUpstreamAllowed({ ...base, host: "0.0.0.0" }), /只能在綁定 127\.0\.0\.1 或 ::1/);
  assert.throws(() => assertTrustUpstreamAllowed({ ...base, host: "localhost" }), /只能在綁定/);
  assert.throws(() => assertTrustUpstreamAllowed({ ...base, tunnelEnabled: true }), /--tunnel/);
  assert.throws(() => assertTrustUpstreamAllowed({ ...base, passwordSet: true }), /二選一/);
  assert.throws(() => assertTrustUpstreamAllowed({ ...base, secretFile: undefined }), /PI_WEBUI_TRUST_UPSTREAM_SECRET_FILE/);
  assert.throws(() => assertTrustUpstreamAllowed({ ...base, secretFile: "  " }), /PI_WEBUI_TRUST_UPSTREAM_SECRET_FILE/);
  assert.throws(() => assertTrustUpstreamAllowed({ ...base, trustedOrigin: null }), /PI_WEBUI_TRUSTED_ORIGIN/);
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

function secretFile(value, mode = 0o600) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-secret-unit-"));
  const file = path.join(dir, "s");
  fs.writeFileSync(file, value, { mode });
  fs.chmodSync(file, mode);
  return file;
}

test("loadGatewaySecret：讀完即刪檔；權限、型別、長度、字元不合格都拒絕", () => {
  const good = "a".repeat(32);
  const f = secretFile(`${good}\n`);
  assert.equal(loadGatewaySecret(f), good);
  assert.equal(fs.existsSync(f), false);
  assert.equal(loadGatewaySecret(secretFile(good, 0o400)), good);
  assert.throws(() => loadGatewaySecret("/nonexistent/x"), /讀不到/);
  assert.throws(() => loadGatewaySecret(secretFile(good, 0o640)), /0600 或 0400/);
  assert.throws(() => loadGatewaySecret(secretFile(good, 0o604)), /0600 或 0400/);
  assert.throws(() => loadGatewaySecret(fs.mkdtempSync(path.join(os.tmpdir(), "upstream-secret-dir-"))), /一般檔案/);
  const target = secretFile(good);
  const link = target + ".lnk";
  fs.symlinkSync(target, link);
  assert.throws(() => loadGatewaySecret(link), /符號連結/);
  assert.throws(() => loadGatewaySecret(secretFile("a".repeat(31))), /長度/);
  assert.throws(() => loadGatewaySecret(secretFile("a".repeat(1025))), /長度/);
  assert.throws(() => loadGatewaySecret(secretFile("a".repeat(20) + " " + "b".repeat(20))), /可見 ASCII/);
  // 擁有者不是自己
  const other = secretFile(good);
  assert.throws(() => loadGatewaySecret(other, { uid: 999999 }), /擁有者/);
  // 刪不掉就停止（不讓密鑰留在磁碟上）
  const stuck = secretFile(good);
  assert.throws(() => loadGatewaySecret(stuck, { unlink: () => { throw new Error("EPERM"); } }), /刪不掉/);
  // 錯誤訊息不含密鑰內容
  try { loadGatewaySecret(secretFile("Z".repeat(20)), {}); } catch (e) { assert.doesNotMatch(e.message, /ZZZZ/); }
});

test("gatewaySecretMatches：相等才 true；缺、錯、長度不同、陣列都 false", () => {
  const s = "k".repeat(40);
  const h = "x-readyai-gateway-secret";
  assert.equal(gatewaySecretMatches({ [h]: s }, s), true);
  assert.equal(gatewaySecretMatches({}, s), false);
  assert.equal(gatewaySecretMatches({ [h]: "" }, s), false);
  assert.equal(gatewaySecretMatches({ [h]: s.slice(1) }, s), false);
  assert.equal(gatewaySecretMatches({ [h]: s + "k" }, s), false);
  assert.equal(gatewaySecretMatches({ [h]: [s, s] }, s), false);
  assert.equal(gatewaySecretMatches({ [h]: `${s}, ${s}` }, s), false);
  assert.equal(gatewaySecretMatches({ [h]: s }, null), false);
});

test("parseTrustedOrigin：明設只收來源；沒設時由絕對 HOME_URL 推得", () => {
  assert.equal(parseTrustedOrigin("http://100.64.0.1:8790", null), "http://100.64.0.1:8790");
  assert.equal(parseTrustedOrigin("https://Center.Example.ts.net/", null), "https://center.example.ts.net");
  assert.equal(parseTrustedOrigin(undefined, "https://center.example.ts.net/continue/"), "https://center.example.ts.net");
  assert.equal(parseTrustedOrigin("", "/continue/"), null);
  assert.equal(parseTrustedOrigin(undefined, null), null);
  for (const bad of ["ftp://x", "http://u:p@x", "http://x/path", "http://x/?q=1", "not a url", "javascript:alert(1)"]) {
    assert.throws(() => parseTrustedOrigin(bad, null), /PI_WEBUI_TRUSTED_ORIGIN/, bad);
  }
});

test("originAllowed：沒有 Origin 放行；相同來源（不分大小寫）放行；其他一律拒絕", () => {
  const o = "http://gw.example:8790";
  assert.equal(originAllowed({}, o), true);
  assert.equal(originAllowed({ origin: o }, o), true);
  assert.equal(originAllowed({ origin: "HTTP://GW.EXAMPLE:8790" }, o), true);
  for (const bad of ["https://gw.example:8790", "http://gw.example:8791", "http://evil.example", "null", "", "garbage"]) {
    assert.equal(originAllowed({ origin: bad }, o), false, bad);
  }
  assert.equal(originAllowed({ origin: [o, o] }, o), false);
  assert.equal(originAllowed({ origin: o }, null), false);
});
