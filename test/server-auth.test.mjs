import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COOKIE_NAME,
  COOKIE_MAX_AGE_SECONDS,
  comparePassword,
  parseCookieHeader,
  readAuthCookie,
  shouldSetSecure,
  buildSetCookie,
  buildClearCookie,
  createAuthStore,
} from "../dist/server/auth.js";

test("comparePassword: 相同回 true、不同回 false、空字串回 false", () => {
  assert.equal(comparePassword("hunter2", "hunter2"), true);
  assert.equal(comparePassword("hunter2", "hunter3"), false);
  assert.equal(comparePassword("", ""), false);
  assert.equal(comparePassword("a", "ab"), false);
  assert.equal(comparePassword(null, "a"), false);
  assert.equal(comparePassword("a", null), false);
});

test("parseCookieHeader: 解析單一與多個 cookie", () => {
  assert.deepEqual(parseCookieHeader(""), {});
  assert.deepEqual(parseCookieHeader("a=1"), { a: "1" });
  assert.deepEqual(parseCookieHeader("a=1; b=2"), { a: "1", b: "2" });
  assert.deepEqual(parseCookieHeader("a=1; b=2; a=3"), { a: "3", b: "2" });
  assert.deepEqual(parseCookieHeader("a=hello%20world"), { a: "hello world" });
});

test("readAuthCookie: 從 headers.cookie 抓 pi_webui_auth", () => {
  assert.equal(readAuthCookie({ cookie: "pi_webui_auth=abc; other=1" }), "abc");
  assert.equal(readAuthCookie({ cookie: "other=1" }), "");
  assert.equal(readAuthCookie({}), "");
});

test("shouldSetSecure: trust-proxy off 永遠 false", () => {
  assert.equal(
    shouldSetSecure({ trustProxy: false, headers: { "x-forwarded-proto": "https" } }),
    false,
  );
});

test("shouldSetSecure: trust-proxy on 且 proto=https 才 true", () => {
  assert.equal(
    shouldSetSecure({ trustProxy: true, headers: { "x-forwarded-proto": "https" } }),
    true,
  );
  assert.equal(
    shouldSetSecure({ trustProxy: true, headers: { "x-forwarded-proto": "http" } }),
    false,
  );
  assert.equal(
    shouldSetSecure({ trustProxy: true, headers: {} }),
    false,
  );
});

test("buildSetCookie: 預設帶 HttpOnly/SameSite=Lax/Path/Max-Age,不帶 Secure", () => {
  const c = buildSetCookie("tok", { secure: false });
  assert.match(c, /^pi_webui_auth=tok/);
  assert.ok(c.includes("HttpOnly"));
  assert.ok(c.includes("SameSite=Lax"));
  assert.ok(c.includes("Path=/"));
  assert.ok(c.includes(`Max-Age=${COOKIE_MAX_AGE_SECONDS}`));
  assert.equal(c.includes("Secure"), false);
});

test("buildSetCookie: secure=true 時帶 Secure", () => {
  const c = buildSetCookie("tok", { secure: true });
  assert.ok(c.includes("Secure"));
});

test("buildClearCookie: value 空,Max-Age=0", () => {
  const c = buildClearCookie({ secure: false });
  assert.match(c, /^pi_webui_auth=;/);
  assert.ok(c.includes("Max-Age=0"));
  assert.equal(c.includes("Secure"), false);
});

test("buildSetCookie: basePath=/webui → Path=/webui", () => {
  const c = buildSetCookie("tok", { secure: false, basePath: "/webui" });
  assert.ok(c.includes("Path=/webui"));
});

test("buildSetCookie: 未帶 basePath → Path=/（cookiePath(undefined) 預設，維持相容）", () => {
  const c = buildSetCookie("tok", { secure: false });
  assert.ok(c.includes("Path=/"));
  assert.equal(c.includes("Path=/webui"), false);
});

test("buildClearCookie: basePath=/webui → Path=/webui（logout 才清得掉 subpath cookie）", () => {
  const c = buildClearCookie({ secure: false, basePath: "/webui" });
  assert.ok(c.includes("Path=/webui"));
  assert.ok(c.includes("Max-Age=0"));
});

test("createAuthStore.issue/verify/revoke 基本流程", () => {
  const store = createAuthStore();
  const t1 = store.issue();
  assert.equal(typeof t1, "string");
  assert.equal(t1.length, 64); // 32 bytes hex
  assert.match(t1, /^[0-9a-f]{64}$/);
  assert.equal(store.verify(t1), true);

  const t2 = store.issue();
  assert.notEqual(t1, t2);
  assert.equal(store.size(), 2);

  store.revoke(t1);
  assert.equal(store.verify(t1), false);
  assert.equal(store.verify(t2), true);
  assert.equal(store.size(), 1);
});

test("createAuthStore.verify: 過期 token 視為失效並 lazy 刪除", () => {
  let now = 1000;
  const store = createAuthStore({ ttlMs: 100, now: () => now });
  const t = store.issue();
  assert.equal(store.verify(t), true);
  assert.equal(store.size(), 1);

  now = 1101;
  assert.equal(store.verify(t), false);
  assert.equal(store.size(), 0);
});

test("createAuthStore.verify: 空字串或 unknown 回 false", () => {
  const store = createAuthStore();
  assert.equal(store.verify(""), false);
  assert.equal(store.verify("nope"), false);
});

test("COOKIE_NAME 與 COOKIE_MAX_AGE_SECONDS 常數", () => {
  assert.equal(COOKIE_NAME, "pi_webui_auth");
  assert.equal(COOKIE_MAX_AGE_SECONDS, 7 * 24 * 60 * 60);
});
