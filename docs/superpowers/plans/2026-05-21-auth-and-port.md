# 密碼登入 + Port 自動偵測 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 為 pi-webui 加密碼登入 (CLI flag + env var, cookie session) 與 port 自動偵測 (被佔用就 +1 找下一個),不打破現有零認證使用流程。

**Architecture:** 兩個獨立純函式模組 (`src/server/listen.ts` 與 `src/server/auth.ts`) 各自單元測試,再由 `src/server/index.ts` 串接;新增獨立 `/login` HTML + `/api/login` / `/api/logout` API;WebSocket 升級時讀同一個 cookie 把關。extension 端對應加兩個 `--webui-*` flag forward 給 server。

**Tech Stack:** Node.js 20+, TypeScript (寬鬆), ws, node:test, node:crypto.timingSafeEqual。前端純 vanilla JS 無 build step。

**Spec:** `docs/superpowers/specs/2026-05-21-auth-and-port-design.md`

---

## 檔案結構

```
src/server/
  listen.ts          (新) port 自動偵測 listenWithFallback
  auth.ts            (新) password/token/cookie helpers + auth middleware
  index.ts           (改) parseArgs +password/+trust-proxy、串 listen 與 auth、WS upgrade gate

public/
  login.html         (新) 登入頁(內嵌 fetch JS)

src/extension/
  index.ts           (改) +webui-password / +webui-trust-proxy flag 並 forward

test/
  server-listen.test.mjs               (新) listen 單元
  server-auth.test.mjs                 (新) auth 單元
  server-auth-integration.test.mjs     (新) HTTP/WS 整合

README.md            (改) 加入新 flag、env var、安全注意
ROADMAP.md           (改) done 區加 3 條
```

每個檔案職責:

- `listen.ts`:純函式,只負責 retry-bind。不知道 auth、HTTP 路由。
- `auth.ts`:純函式 + factory,提供 cookie/token/middleware 邏輯。不直接呼叫 `http.createServer`。
- `public/login.html`:獨立頁面,只負責收使用者輸入後 POST `/api/login` 並 redirect。
- `index.ts`:把上面三者串到 HTTP server / WS upgrade 流程。
- `extension/index.ts`:flag 解析與 spawn arg 組裝。

---

## Task 1: `src/server/listen.ts` — port 自動偵測 (純函式)

**Files:**
- Create: `src/server/listen.ts`
- Test: `test/server-listen.test.mjs`

- [ ] **Step 1.1:寫測試骨架**

`test/server-listen.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { listenWithFallback } from "../dist/server/listen.js";

function takePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      resolve({ server: s, port: s.address().port });
    });
  });
}

function closeP(server) {
  return new Promise((res) => server.close(() => res()));
}

test("listenWithFallback: 給定可用 port 立即綁,回傳該 port", async () => {
  const blocker = await takePort();
  await closeP(blocker.server);
  const target = createServer();
  try {
    const actual = await listenWithFallback(target, {
      host: "127.0.0.1",
      port: blocker.port,
    });
    assert.equal(actual, blocker.port);
  } finally {
    await closeP(target);
  }
});

test("listenWithFallback: 已被佔用時 +1 綁到下一個", async () => {
  const blocker = await takePort();
  const target = createServer();
  try {
    const actual = await listenWithFallback(target, {
      host: "127.0.0.1",
      port: blocker.port,
    });
    assert.equal(actual, blocker.port + 1);
  } finally {
    await closeP(target);
    await closeP(blocker.server);
  }
});

test("listenWithFallback: 達上限 throw", async () => {
  let attempt = 0;
  const fakeServer = {
    once(event, fn) { this[`_${event}`] = fn; },
    removeListener() {},
    listen() {
      attempt++;
      setImmediate(() => {
        const err = new Error("EADDRINUSE");
        err.code = "EADDRINUSE";
        this._error(err);
      });
    },
  };
  await assert.rejects(
    () =>
      listenWithFallback(fakeServer, {
        host: "127.0.0.1",
        port: 60000,
        maxAttempts: 3,
      }),
    /No free port in range 60000\.\.60002/,
  );
  assert.equal(attempt, 3);
});

test("listenWithFallback: 非 EADDRINUSE 不重試", async () => {
  let attempt = 0;
  const fakeServer = {
    once(event, fn) { this[`_${event}`] = fn; },
    removeListener() {},
    listen() {
      attempt++;
      setImmediate(() => {
        const err = new Error("EACCES");
        err.code = "EACCES";
        this._error(err);
      });
    },
  };
  await assert.rejects(
    () =>
      listenWithFallback(fakeServer, {
        host: "127.0.0.1",
        port: 50,
        maxAttempts: 5,
      }),
    /EACCES/,
  );
  assert.equal(attempt, 1);
});

test("listenWithFallback: fallback 時呼叫 logger.warn", async () => {
  const blocker = await takePort();
  const target = createServer();
  const warnings = [];
  try {
    await listenWithFallback(target, {
      host: "127.0.0.1",
      port: blocker.port,
      logger: { warn: (msg, fields) => warnings.push({ msg, fields }) },
    });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].msg, "port fallback");
    assert.equal(warnings[0].fields.requested, blocker.port);
    assert.equal(warnings[0].fields.actual, blocker.port + 1);
  } finally {
    await closeP(target);
    await closeP(blocker.server);
  }
});
```

- [ ] **Step 1.2:跑測試,確認失敗**

```bash
cd /Users/tung/Codes/pi-webui
make build && node --test test/server-listen.test.mjs
```

預期:`Cannot find module '../dist/server/listen.js'` 或類似錯誤,五個 test 全失敗。

- [ ] **Step 1.3:寫 `src/server/listen.ts`**

```ts
import type { Server } from "node:http";

export interface ListenOptions {
  host: string;
  port: number;
  maxAttempts?: number;
  logger?: {
    warn?: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

// 對 server 嘗試從 opts.port 開始綁定;若 port 被佔用 (EADDRINUSE)
// 則 +1 重試,上限 maxAttempts 次。回傳實際綁定的 port。
// 非 EADDRINUSE 錯誤立刻 throw,不重試。
export async function listenWithFallback(
  server: Server,
  opts: ListenOptions,
): Promise<number> {
  const { host, port, maxAttempts = 50, logger } = opts;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tryPort = port + attempt;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(tryPort, host);
      });
      if (attempt > 0) {
        logger?.warn?.("port fallback", { requested: port, actual: tryPort });
      }
      return tryPort;
    } catch (err: any) {
      if (err?.code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(
    `No free port in range ${port}..${port + maxAttempts - 1}; try --listen with a different port`,
  );
}
```

- [ ] **Step 1.4:跑測試,確認通過**

```bash
make build && node --test test/server-listen.test.mjs
```

預期:5/5 pass。

- [ ] **Step 1.5:跑全套 precommit**

```bash
make precommit
```

預期:全部 pass。

- [ ] **Step 1.6:Commit**

```bash
git add src/server/listen.ts test/server-listen.test.mjs
git commit -m "新增 listen.ts:port 被佔用時自動 +1 找下一個"
```

---

## Task 2: 把 `index.ts` 的 `server.listen(...)` 換成 `listenWithFallback`

**Files:**
- Modify: `src/server/index.ts` (檔尾 `server.listen(port, host, ...)` 區塊與 import 區)

- [ ] **Step 2.1:加 import**

在 `src/server/index.ts` 的既有 `import { computeCommandAllow, resolveCommandAllowFile } from "./command-allow.js";` 之後新增一行:

```ts
import { listenWithFallback } from "./listen.js";
```

- [ ] **Step 2.2:改寫檔尾 `server.listen`**

找到檔尾:

```js
server.listen(port, host, () => {
  logger.info("listening", { url: `http://${host}:${port}`, appCwd, agentDir, sessionDir: sessionDir || undefined });
});
```

替換成:

```js
const actualPort = await listenWithFallback(server, { host, port, logger });
const url = `http://${host}:${actualPort}`;
logger.info("listening", {
  url,
  requestedPort: port,
  fallback: actualPort !== port,
  appCwd,
  agentDir,
  sessionDir: sessionDir || undefined,
});
```

(index.ts 已有 `await` 在 module top-level,沒有額外結構問題。)

- [ ] **Step 2.3:Build + 跑全套測試**

```bash
make precommit
```

預期:全部 pass。

- [ ] **Step 2.4:手動 smoke 驗證 port fallback**

```bash
# 終端 A
node dist/server/index.js --listen 127.0.0.1:5555 &
# 終端 B
node dist/server/index.js --listen 127.0.0.1:5555
# 預期: 終端 B log 顯示 "port fallback" 與 url http://127.0.0.1:5556
# 確認後 kill 兩個 process
```

- [ ] **Step 2.5:Commit**

```bash
git add src/server/index.ts
git commit -m "server: 啟動時若 port 被佔用,自動 +1 找下一個可用 port"
```

---

## Task 3: `src/server/auth.ts` — 密碼/token/cookie helpers (純函式)

**Files:**
- Create: `src/server/auth.ts`
- Test: `test/server-auth.test.mjs`

- [ ] **Step 3.1:寫測試**

`test/server-auth.test.mjs`:

```js
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

test("createAuthStore.issue/verify/revoke 基本流程", () => {
  const store = createAuthStore();
  const t1 = store.issue();
  assert.equal(typeof t1, "string");
  assert.equal(t1.length, 64); // 32 bytes hex
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
```

- [ ] **Step 3.2:跑測試,確認失敗**

```bash
make build && node --test test/server-auth.test.mjs
```

預期:`Cannot find module '../dist/server/auth.js'`,全失敗。

- [ ] **Step 3.3:寫 `src/server/auth.ts`**

```ts
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const COOKIE_NAME = "pi_webui_auth";
export const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

// 等長 constant-time 字串比對,避免 timing attack。
// 任一方非字串或長度不同直接 false。
export function comparePassword(input: unknown, expected: unknown): boolean {
  if (typeof input !== "string" || typeof expected !== "string") return false;
  if (input.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(input, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// 解析 Cookie header 成物件;同名 cookie 後者覆寫前者(與 browser 一致行為)。
export function parseCookieHeader(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of String(raw).split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function readAuthCookie(headers: IncomingHttpHeaders | Record<string, string>): string {
  const raw = (headers as any)?.cookie || "";
  const cookies = parseCookieHeader(raw);
  return cookies[COOKIE_NAME] || "";
}

// trust-proxy 關閉時永遠回 false (不依賴 client 提供的 header)。
// 開啟時讀 X-Forwarded-Proto,僅 "https" 算數;陣列情況取第一個。
export function shouldSetSecure(opts: {
  trustProxy: boolean;
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
}): boolean {
  if (!opts.trustProxy) return false;
  const raw = opts.headers?.["x-forwarded-proto"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "https";
}

export function buildSetCookie(
  value: string,
  opts: { secure: boolean; maxAge?: number } = { secure: false },
): string {
  const maxAge = opts.maxAge ?? COOKIE_MAX_AGE_SECONDS;
  const parts = [
    `${COOKIE_NAME}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearCookie(opts: { secure: boolean }): string {
  return buildSetCookie("", { secure: opts.secure, maxAge: 0 });
}

export interface AuthStore {
  issue(): string;
  verify(token: string | undefined | null): boolean;
  revoke(token: string | undefined | null): void;
  size(): number;
}

// 記憶體 token 儲存。issue 產 32 byte hex,verify 時 lazy GC 過期。
// now 與 ttlMs 可注入,便於測試。
export function createAuthStore(
  opts: { ttlMs?: number; now?: () => number } = {},
): AuthStore {
  const ttlMs = opts.ttlMs ?? COOKIE_MAX_AGE_SECONDS * 1000;
  const now = opts.now ?? Date.now;
  const tokens = new Map<string, { expiresAt: number }>();
  return {
    issue() {
      const token = randomBytes(32).toString("hex");
      tokens.set(token, { expiresAt: now() + ttlMs });
      return token;
    },
    verify(token) {
      if (!token || typeof token !== "string") return false;
      const entry = tokens.get(token);
      if (!entry) return false;
      if (entry.expiresAt < now()) {
        tokens.delete(token);
        return false;
      }
      return true;
    },
    revoke(token) {
      if (token && typeof token === "string") tokens.delete(token);
    },
    size() {
      return tokens.size;
    },
  };
}
```

- [ ] **Step 3.4:跑測試,確認通過**

```bash
make build && node --test test/server-auth.test.mjs
```

預期:11/11 pass。

- [ ] **Step 3.5:跑全套**

```bash
make precommit
```

預期:全 pass。

- [ ] **Step 3.6:Commit**

```bash
git add src/server/auth.ts test/server-auth.test.mjs
git commit -m "新增 auth.ts:密碼比對、token 儲存、cookie helpers"
```

---

## Task 4: `public/login.html` — 登入頁

**Files:**
- Create: `public/login.html`

- [ ] **Step 4.1:寫 HTML + 內嵌 JS**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>pi-webui · login</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="stylesheet" href="/styles.css" />
    <style>
      .login-shell {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg, #111);
      }
      .login-card {
        background: var(--panel, #1c1c1c);
        color: var(--text, #eee);
        padding: 32px;
        border-radius: 8px;
        width: min(360px, 90vw);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      }
      .login-card h1 {
        margin: 0 0 16px;
        font-size: 18px;
        font-weight: 600;
      }
      .login-card input[type="password"] {
        width: 100%;
        padding: 10px 12px;
        font-size: 14px;
        background: rgba(255, 255, 255, 0.05);
        color: inherit;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 4px;
        box-sizing: border-box;
        margin-bottom: 12px;
      }
      .login-card button {
        width: 100%;
        padding: 10px;
        font-size: 14px;
        background: #3b82f6;
        color: white;
        border: 0;
        border-radius: 4px;
        cursor: pointer;
      }
      .login-card button:disabled { opacity: 0.6; cursor: wait; }
      .login-error {
        color: #f87171;
        font-size: 13px;
        margin-top: 8px;
        min-height: 1.2em;
      }
    </style>
  </head>
  <body>
    <div class="login-shell">
      <form class="login-card" id="login-form">
        <h1>pi-webui</h1>
        <input
          type="password"
          id="password"
          placeholder="password"
          autocomplete="current-password"
          autofocus
          required
        />
        <button type="submit" id="submit">Sign in</button>
        <div class="login-error" id="error"></div>
      </form>
    </div>
    <script>
      const form = document.getElementById("login-form");
      const pw = document.getElementById("password");
      const btn = document.getElementById("submit");
      const err = document.getElementById("error");
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        err.textContent = "";
        btn.disabled = true;
        try {
          const res = await fetch("/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password: pw.value }),
            credentials: "same-origin",
          });
          if (res.ok) {
            const redirect = new URLSearchParams(location.search).get("next") || "/";
            location.href = redirect.startsWith("/") ? redirect : "/";
            return;
          }
          let msg = "Login failed";
          try {
            const body = await res.json();
            if (body && body.error) msg = body.error;
          } catch {}
          err.textContent = msg;
        } catch (ex) {
          err.textContent = String(ex && ex.message ? ex.message : ex);
        } finally {
          btn.disabled = false;
        }
      });
    </script>
  </body>
</html>
```

- [ ] **Step 4.2:Commit**

```bash
git add public/login.html
git commit -m "新增 login.html:獨立登入頁,POST /api/login 後 redirect"
```

(此 task 沒有測試;UI 行為與 server 串接在 Task 6 整合測試覆蓋。)

---

## Task 5: `src/server/index.ts` — 串 auth middleware + WS upgrade gate

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 5.1:加 import**

在既有 `import { listenWithFallback } from "./listen.js";` 之後新增:

```ts
import {
  COOKIE_NAME,
  buildClearCookie,
  buildSetCookie,
  comparePassword,
  createAuthStore,
  readAuthCookie,
  shouldSetSecure,
} from "./auth.js";
```

- [ ] **Step 5.2:parseArgs 加 `--password` 與 `--trust-proxy`**

找到 `parseArgs` 函式內最後的 `else if (a === "--hide-model") out.hideModel = true;` 之後加:

```js
    else if (a === "--password") out.password = argv[++i];
    else if (a.startsWith("--password=")) out.password = a.slice("--password=".length);
    else if (a === "--trust-proxy") out.trustProxy = true;
```

並在 parseArgs 末端 return 前加 password 空字串檢查:

```js
  if (out.password !== undefined && String(out.password).length === 0) {
    throw new Error("--password cannot be empty");
  }
```

- [ ] **Step 5.3:模組層級加環境變數合併與 store**

找到 `const hideModel = !!args.hideModel || process.env.PI_WEBUI_HIDE_MODEL === "1";` 之後新增:

```js
const authPassword = (args.password ?? process.env.PI_WEBUI_PASSWORD ?? "") || "";
const trustProxy = !!args.trustProxy || process.env.PI_WEBUI_TRUST_PROXY === "1";
const authEnabled = authPassword.length > 0;
const authStore = authEnabled ? createAuthStore() : null;
const LOGIN_PATH = "/login";
const LOGIN_HTML = resolve(publicDir, "login.html");
```

- [ ] **Step 5.4:加 helper 函式 (放在 `serveStatic` 之上)**

```js
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function isAuthPublic(pathname, method) {
  if (pathname === LOGIN_PATH && method === "GET") return true;
  if (pathname === "/api/login" && method === "POST") return true;
  if (pathname === "/api/logout" && method === "POST") return true;
  if (pathname === "/favicon.svg" && method === "GET") return true;
  return false;
}

async function handleLogin(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJson(res, 400, { ok: false, error: "Invalid request" }); }
  const submitted = typeof body?.password === "string" ? body.password : "";
  if (!comparePassword(submitted, authPassword)) {
    await sleep(250);
    return sendJson(res, 401, { ok: false, error: "Invalid password" });
  }
  const token = authStore.issue();
  const secure = shouldSetSecure({ trustProxy, headers: req.headers });
  res.setHeader("Set-Cookie", buildSetCookie(token, { secure }));
  return sendJson(res, 200, { ok: true });
}

function handleLogout(req, res) {
  const token = readAuthCookie(req.headers);
  if (token) authStore.revoke(token);
  const secure = shouldSetSecure({ trustProxy, headers: req.headers });
  res.setHeader("Set-Cookie", buildClearCookie({ secure }));
  return sendJson(res, 200, { ok: true });
}

// 回 true 表示已處理(放行 / login / logout / reject);
// 回 false 表示需要繼續 serveStatic。
async function handleAuth(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  if (!authEnabled) return false;

  if (pathname === "/api/login" && method === "POST") {
    await handleLogin(req, res);
    return true;
  }
  if (pathname === "/api/logout" && method === "POST") {
    handleLogout(req, res);
    return true;
  }
  if (isAuthPublic(pathname, method)) return false;

  if (authStore.verify(readAuthCookie(req.headers))) return false;

  if (pathname.startsWith("/api/") || pathname === "/ws") {
    sendJson(res, 401, { ok: false, error: "Unauthorized" });
    return true;
  }
  res.writeHead(302, { location: `${LOGIN_PATH}?next=${encodeURIComponent(pathname + url.search)}` });
  res.end();
  return true;
}
```

- [ ] **Step 5.5:把 `createServer` 換成 auth-aware handler**

找到:

```js
const server = createServer((req, res) => {
  serveStatic(req, res);
});
```

替換成:

```js
const server = createServer(async (req, res) => {
  try {
    const handled = await handleAuth(req, res);
    if (handled) return;
    serveStatic(req, res);
  } catch (err) {
    logger.error("request handler error", { error: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Internal error" }));
    }
  }
});
```

- [ ] **Step 5.6:把 `serveStatic` 加進 `LOGIN_PATH` 處理**

`serveStatic` 既有對 `/` 對應 `index.html`,要對 `/login` 也對應 `login.html`。改 `serveStatic` 開頭兩行:

```js
function serveStatic(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  let pathname = url.pathname;
  if (pathname === "/") pathname = "/index.html";
  else if (pathname === "/login") pathname = "/login.html";
  const filePath = resolve(join(publicDir, pathname));
  // ... 其餘不變
}
```

(原 `const pathname = url.pathname === "/" ? "/index.html" : url.pathname;` 換成上面三行,並把後續 `const pathname` 改成 `let pathname`。)

- [ ] **Step 5.7:WS upgrade gate**

找到既有:

```js
const wss = new WebSocketServer({ server, path: "/ws" });
```

替換成:

```js
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
  } catch {
    socket.destroy();
    return;
  }
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  if (authEnabled && !authStore.verify(readAuthCookie(req.headers))) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
```

- [ ] **Step 5.8:啟動 log 補一行 auth 狀態**

把 `logger.info("listening", ...)` 改為:

```js
logger.info("listening", {
  url,
  requestedPort: port,
  fallback: actualPort !== port,
  appCwd,
  agentDir,
  sessionDir: sessionDir || undefined,
  auth: authEnabled ? "enabled" : "disabled",
  trustProxy: authEnabled ? trustProxy : undefined,
});
```

- [ ] **Step 5.9:把 `--password` 與 `--trust-proxy` 加進 `printHelp`**

找到 `printHelp` 的 options 區塊,在 `"  --hide-model"` 之前加:

```js
    "  --password <pw>             enable login; require this password to access the webui.",
    "                              alias: PI_WEBUI_PASSWORD env var.",
    "  --trust-proxy               honor X-Forwarded-Proto when deciding cookie Secure flag.",
    "                              alias: PI_WEBUI_TRUST_PROXY=1 env var.",
```

並在 env vars 區塊適當位置加:

```js
    "  PI_WEBUI_PASSWORD          enable login with this password (same as --password)",
    "  PI_WEBUI_TRUST_PROXY       '1' to honor X-Forwarded-Proto for cookie Secure flag",
```

- [ ] **Step 5.10:build + 跑既有所有測試**

```bash
make precommit
```

預期:全 pass (新整合測試還沒寫,但 Task 1/3 既有測試應通過)。

- [ ] **Step 5.11:Commit**

```bash
git add src/server/index.ts
git commit -m "server: 串入 auth middleware 與 WS upgrade cookie gate"
```

---

## Task 6: HTTP / WS 整合測試

**Files:**
- Create: `test/server-auth-integration.test.mjs`

用 spawn 子進程的方式跑真實 `node dist/server/index.js`;這比 in-process 改 index.ts 結構安全。每組測試 share 同一個 server,用 `t.before / t.after`。

- [ ] **Step 6.1:寫 helper 與骨架**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PASSWORD = "secret-pw";

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/server/index.js", "--listen", "127.0.0.1:0"], {
      env: { ...process.env, ...env, PI_WEBUI_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let resolved = false;
    const onChunk = (chunk) => {
      stderr += chunk.toString();
      const m = stderr.match(/"url":"(http:\/\/127\.0\.0\.1:\d+)"/);
      if (m && !resolved) {
        resolved = true;
        resolve({ child, url: m[1] });
      }
    };
    child.stderr.on("data", onChunk);
    child.stdout.on("data", onChunk);
    child.on("exit", (code) => {
      if (!resolved) reject(new Error(`server exited code=${code}: ${stderr}`));
    });
    setTimeout(() => {
      if (!resolved) {
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error(`server start timeout: ${stderr.slice(-1000)}`));
      }
    }, 15000);
  });
}

function stopServer(child) {
  return new Promise((res) => {
    if (!child || child.exitCode !== null) return res();
    child.once("exit", () => res());
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, 2000);
  });
}

async function getJsonOrText(res) {
  const text = await res.text();
  try { return { json: JSON.parse(text), text }; }
  catch { return { json: null, text }; }
}
```

(server 起在 `--listen 127.0.0.1:0` 讓 OS 派 port,從 log 解析實際 URL。注意:`parseListen` 必須能接受 `:0`,既有 regex `/^([^:]*):(\d+)$/` 對 `0` 是 ok 的。)

- [ ] **Step 6.2:加「沒設密碼:GET / → 200」測試**

```js
test("no password: GET / returns 200 (向後相容)", async () => {
  const { child, url } = await startServer({});
  try {
    const res = await fetch(`${url}/`, { redirect: "manual" });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<title>pi-webui<\/title>/);
  } finally {
    await stopServer(child);
  }
});
```

- [ ] **Step 6.3:加「設密碼:GET / → 302 /login」測試**

```js
test("with password: GET / redirects to /login", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: PASSWORD });
  try {
    const res = await fetch(`${url}/`, { redirect: "manual" });
    assert.equal(res.status, 302);
    const loc = res.headers.get("location");
    assert.ok(loc && loc.startsWith("/login"), `location=${loc}`);
  } finally {
    await stopServer(child);
  }
});
```

- [ ] **Step 6.4:加「GET /login → 200 + login.html」測試**

```js
test("with password: GET /login returns the login page", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: PASSWORD });
  try {
    const res = await fetch(`${url}/login`, { redirect: "manual" });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /id="login-form"/);
  } finally {
    await stopServer(child);
  }
});
```

- [ ] **Step 6.5:加「POST /api/login 對 → 200 + set-cookie;帶 cookie 再 GET / → 200」測試**

```js
test("with password: correct login sets cookie and grants access", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: PASSWORD });
  try {
    const login = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie") || "";
    assert.match(setCookie, /pi_webui_auth=[0-9a-f]{64}/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.equal(setCookie.includes("Secure"), false);

    const cookie = setCookie.split(";")[0];
    const home = await fetch(`${url}/`, {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(home.status, 200);
  } finally {
    await stopServer(child);
  }
});
```

- [ ] **Step 6.6:加「POST /api/login 錯 → 401 且耗時 ≥ 200ms」測試**

```js
test("with password: wrong login returns 401 after delay", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: PASSWORD });
  try {
    const t0 = Date.now();
    const login = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(login.status, 401);
    assert.ok(elapsed >= 200, `expected delay >= 200ms, got ${elapsed}ms`);
    const { json } = await getJsonOrText(login);
    assert.equal(json?.ok, false);
  } finally {
    await stopServer(child);
  }
});
```

- [ ] **Step 6.7:加「logout 清 cookie」測試**

```js
test("with password: logout revokes the cookie", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: PASSWORD });
  try {
    const login = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

    const logout = await fetch(`${url}/api/logout`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(logout.status, 200);
    const clear = logout.headers.get("set-cookie") || "";
    assert.match(clear, /pi_webui_auth=;/);
    assert.match(clear, /Max-Age=0/);

    // 用同一個 (已 revoke) token 再打 / 應該被擋
    const home = await fetch(`${url}/`, {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(home.status, 302);
  } finally {
    await stopServer(child);
  }
});
```

- [ ] **Step 6.8:加「WS upgrade 沒 cookie → 連線被拒」測試**

```js
test("with password: WS upgrade without cookie is rejected", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: PASSWORD });
  try {
    const wsUrl = url.replace(/^http:/, "ws:") + "/ws";
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WS timeout")), 5000);
      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(t);
        assert.equal(res.statusCode, 401);
        resolve();
      });
      ws.on("error", () => { /* 連線被 destroy 也算成功;搭配 close 觸發 resolve */ });
      ws.on("close", () => {
        clearTimeout(t);
        resolve();
      });
      ws.on("open", () => {
        clearTimeout(t);
        reject(new Error("WS should NOT have opened"));
      });
    });
  } finally {
    await stopServer(child);
  }
});
```

- [ ] **Step 6.9:加「WS upgrade 有有效 cookie → 連線成功」測試**

```js
test("with password: WS upgrade with valid cookie succeeds", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: PASSWORD });
  try {
    const login = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

    const wsUrl = url.replace(/^http:/, "ws:") + "/ws";
    const ws = new WebSocket(wsUrl, { headers: { cookie } });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WS open timeout")), 10000);
      ws.on("open", () => { clearTimeout(t); ws.close(); resolve(); });
      ws.on("error", (err) => { clearTimeout(t); reject(err); });
    });
  } finally {
    await stopServer(child);
  }
});
```

- [ ] **Step 6.10:加「trust-proxy:X-Forwarded-Proto: https → cookie 含 Secure」測試**

```js
test("trust-proxy: X-Forwarded-Proto=https sets Secure flag", async () => {
  const { child, url } = await startServer({
    PI_WEBUI_PASSWORD: PASSWORD,
    PI_WEBUI_TRUST_PROXY: "1",
  });
  try {
    const login = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const setCookie = login.headers.get("set-cookie") || "";
    assert.match(setCookie, /Secure/);
  } finally {
    await stopServer(child);
  }
});

test("trust-proxy: 無 X-Forwarded-Proto 時不加 Secure", async () => {
  const { child, url } = await startServer({
    PI_WEBUI_PASSWORD: PASSWORD,
    PI_WEBUI_TRUST_PROXY: "1",
  });
  try {
    const login = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const setCookie = login.headers.get("set-cookie") || "";
    assert.equal(setCookie.includes("Secure"), false);
  } finally {
    await stopServer(child);
  }
});
```

- [ ] **Step 6.11:跑整套**

```bash
make precommit
```

預期:新增 10 個 integration test 全 pass(總耗時可能 30~60 秒,因為每個 spawn server)。

如果遇到 `parseListen` 不接 `:0`,先補一行修正:在 `parseListen` 函式內 `if (m) return { host: m[1] || DEFAULT_HOST, port: Number(m[2]) };` 已支援 0。若仍失敗,改用 OS 派 port 後 close + 重綁的策略。

- [ ] **Step 6.12:Commit**

```bash
git add test/server-auth-integration.test.mjs
git commit -m "新增 HTTP/WS auth 整合測試"
```

---

## Task 7: `src/extension/index.ts` — 加 `--webui-password` / `--webui-trust-proxy`

**Files:**
- Modify: `src/extension/index.ts`

- [ ] **Step 7.1:擴充 `StartOptions`**

找到既有 interface,加兩個欄位:

```ts
interface StartOptions {
  listen?: string;
  model?: string;
  skills?: string;
  skillAllow?: string;
  skillAllowFile?: string;
  commandAllow?: string;
  commandAllowFile?: string;
  hideModel?: boolean;
  password?: string;
  trustProxy?: boolean;
  owned?: boolean;
}
```

- [ ] **Step 7.2:`runStart` forward 兩個新參數**

在 `if (opts.hideModel) serverArgs.push("--hide-model");` 之後加:

```ts
if (opts.password) serverArgs.push("--password", opts.password);
if (opts.trustProxy) serverArgs.push("--trust-proxy");
```

- [ ] **Step 7.3:`parseStartFlags` 加兩個 case**

在 `else if (t === "--hide-model") opts.hideModel = true;` 之前加:

```ts
else if (t === "--password") opts.password = valueOf(++i, t);
else if (t.startsWith("--password=")) opts.password = t.slice("--password=".length);
else if (t === "--trust-proxy") opts.trustProxy = true;
```

- [ ] **Step 7.4:`registerFlag` 註冊兩個新 flag**

在 `pi.registerFlag?.("webui-hide-model", ...)` 之前加:

```ts
pi.registerFlag?.("webui-password", {
  description: "enable pi-webui login with this password. Implies --webui.",
  type: "string",
  default: "",
});

pi.registerFlag?.("webui-trust-proxy", {
  description: "honor X-Forwarded-Proto when deciding cookie Secure flag. Implies --webui.",
  type: "boolean",
  default: false,
});
```

- [ ] **Step 7.5:`setImmediate` block 內讀新 flag 並 forward**

找到既有讀取 flag 的區塊,加:

```ts
let password: string;
let trustProxy: boolean;
try {
  // ... existing reads ...
  password = String(pi.getFlag?.("webui-password") || "").trim();
  trustProxy = !!pi.getFlag?.("webui-trust-proxy");
  want =
    !!pi.getFlag?.("webui") ||
    listen.length > 0 ||
    model.length > 0 ||
    skills.length > 0 ||
    skillAllow.length > 0 ||
    skillAllowFile.length > 0 ||
    commandAllow.length > 0 ||
    commandAllowFile.length > 0 ||
    hideModel ||
    password.length > 0 ||
    trustProxy;
} catch {
  return;
}
```

並把 `runStart(stubCtx, { ... })` 的 options 物件加入兩欄:

```ts
password: password || undefined,
trustProxy: trustProxy || undefined,
```

- [ ] **Step 7.6:Build,確認 ts 編譯通過**

```bash
make build
```

預期:無錯誤。

- [ ] **Step 7.7:跑所有測試 (確認 server 沒被改壞)**

```bash
make precommit
```

預期:全 pass。

- [ ] **Step 7.8:Commit**

```bash
git add src/extension/index.ts
git commit -m "extension: 新增 --webui-password 與 --webui-trust-proxy 兩個 flag"
```

---

## Task 8: README + ROADMAP

**Files:**
- Modify: `README.md`
- Modify: `ROADMAP.md`

- [ ] **Step 8.1:README — command-line flag 表新增兩列**

在 `--hide-model` 之前的表格 row 插入:

```markdown
| `--password <pw>` | enable login; require this password to access the webui. alias: `PI_WEBUI_PASSWORD` env var. |
| `--trust-proxy` | honor `X-Forwarded-Proto` when deciding cookie `Secure` flag; useful behind cloudflare tunnel / reverse proxy. alias: `PI_WEBUI_TRUST_PROXY=1`. |
```

- [ ] **Step 8.2:README — environment variables 表新增兩列**

在 `PI_WEBUI_HIDE_MODEL` 之前的 row 插入:

```markdown
| `PI_WEBUI_PASSWORD` | (unset) | enable login with this password (same as `--password`) |
| `PI_WEBUI_TRUST_PROXY` | `0` | `1` to honor `X-Forwarded-Proto` for cookie `Secure` flag |
```

- [ ] **Step 8.3:README — examples 區追加**

在既有 examples 列表後加:

```bash
PI_WEBUI_PASSWORD=hunter2 pi-webui --listen 0.0.0.0:3000 --trust-proxy
```

- [ ] **Step 8.4:README — pi extension flag 段落更新**

把 "when launched via the pi extension, equivalent pi flags are available" 段落更新成包含新 flag:

```
`--webui-model`, `--webui-skill`, `--webui-skill-allow`,
`--webui-skill-allow-file`, `--webui-command-allow`,
`--webui-command-allow-file`, `--webui-hide-model`,
`--webui-password`, `--webui-trust-proxy`.
```

- [ ] **Step 8.5:README — 新增「authentication」小節**

放在 "configuration" 與 "attachments" 之間:

```markdown
## authentication

set `--password <pw>` or `PI_WEBUI_PASSWORD` to require login. when set,
all requests outside `/login`, `/api/login`, `/api/logout` and `/favicon.svg`
are redirected to the login page or rejected with 401.

session cookies are kept in memory and revoked on server restart — users
have to log in again after every restart. cookie lifetime is 7 days.

**behind a reverse proxy (cloudflare tunnel, nginx, etc.):** add `--trust-proxy`
so the cookie's `Secure` flag is set when `X-Forwarded-Proto: https` is forwarded.
without `--trust-proxy`, the cookie has no `Secure` flag and works in both plain
HTTP and tunneled HTTPS.

**port note:** if the requested port is in use, pi-webui linearly searches
`port..port+49` for the first free one and prints the actual port in the
listening log line.

passing the password on the command line exposes it in `ps aux`. prefer
`PI_WEBUI_PASSWORD` env var or a wrapper script.
```

- [ ] **Step 8.6:ROADMAP — done 區加 3 條**

在最後一行 done 之前加:

```
[x] `--password` / `PI_WEBUI_PASSWORD` 啟用 cookie 登入認證
[x] `--trust-proxy` / `PI_WEBUI_TRUST_PROXY` 控制 cookie `Secure` flag
[x] 啟動 port 被佔用時自動 +1 找下一個可用 port (上限 50)
```

- [ ] **Step 8.7:Commit**

```bash
git add README.md ROADMAP.md
git commit -m "文件:加入密碼登入、trust-proxy 與 port 自動偵測說明"
```

---

## Task 9: 端到端手動驗證 (`~/Codes/readyaiJobs/biocrown-v2`)

**Files:** (無新檔)

這是手動 smoke test,跑完後把觀察結果回報。

- [ ] **Step 9.1:確認測試目錄存在**

```bash
ls -d ~/Codes/readyaiJobs/biocrown-v2
```

預期:目錄存在(從 brainstorming 階段已確認)。若不存在,換選 `~/Codes/readyaiJobs/` 下任一其他子目錄。

- [ ] **Step 9.2:場景 A — 不設密碼 (向後相容)**

```bash
cd ~/Codes/readyaiJobs/biocrown-v2
( cd /Users/tung/Codes/pi-webui && node dist/server/index.js --listen 127.0.0.1:5560 ) &
SERVER_PID=$!
sleep 1
# 期望:200 + index.html
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5560/
kill $SERVER_PID
wait $SERVER_PID 2>/dev/null
```

預期輸出:`200`

- [ ] **Step 9.3:場景 B — 設密碼,login 全流程**

```bash
( cd /Users/tung/Codes/pi-webui && PI_WEBUI_PASSWORD=hunter2 node dist/server/index.js --listen 127.0.0.1:5560 ) &
SERVER_PID=$!
sleep 1

# 1) GET / 應 302
curl -s -o /dev/null -w "/ -> %{http_code} (loc=%{redirect_url})\n" http://127.0.0.1:5560/

# 2) GET /login 應 200
curl -s -o /dev/null -w "/login -> %{http_code}\n" http://127.0.0.1:5560/login

# 3) 錯密碼 -> 401
curl -s -o /dev/null -w "wrong pw -> %{http_code}\n" \
  -H "Content-Type: application/json" \
  -d '{"password":"nope"}' \
  http://127.0.0.1:5560/api/login

# 4) 對密碼 -> 200 + set-cookie
COOKIE=$(curl -s -i \
  -H "Content-Type: application/json" \
  -d '{"password":"hunter2"}' \
  http://127.0.0.1:5560/api/login \
  | grep -i "^set-cookie:" | sed 's/Set-Cookie: //I' | cut -d';' -f1)
echo "cookie=$COOKIE"

# 5) 帶 cookie GET / -> 200
curl -s -o /dev/null -w "auth / -> %{http_code}\n" \
  -H "Cookie: $COOKIE" \
  http://127.0.0.1:5560/

# 6) logout
curl -s -o /dev/null -w "logout -> %{http_code}\n" -X POST \
  -H "Cookie: $COOKIE" \
  http://127.0.0.1:5560/api/logout

# 7) 再 GET / 應 302
curl -s -o /dev/null -w "after logout / -> %{http_code}\n" \
  -H "Cookie: $COOKIE" \
  http://127.0.0.1:5560/

kill $SERVER_PID
wait $SERVER_PID 2>/dev/null
```

預期輸出:
```
/ -> 302 (loc=/login?next=%2F)
/login -> 200
wrong pw -> 401
cookie=pi_webui_auth=<64-hex>
auth / -> 200
logout -> 200
after logout / -> 302
```

- [ ] **Step 9.4:場景 C — port 衝突自動 +1**

```bash
( cd /Users/tung/Codes/pi-webui && PI_WEBUI_PASSWORD=a node dist/server/index.js --listen 127.0.0.1:5561 ) &
A_PID=$!
sleep 1
( cd /Users/tung/Codes/pi-webui && PI_WEBUI_PASSWORD=a node dist/server/index.js --listen 127.0.0.1:5561 ) 2>&1 &
B_PID=$!
sleep 2
# 期望 B 印出 "port fallback" 並綁到 5562
curl -s -o /dev/null -w "5561 -> %{http_code}\n" http://127.0.0.1:5561/
curl -s -o /dev/null -w "5562 -> %{http_code}\n" http://127.0.0.1:5562/
kill $A_PID $B_PID
wait $A_PID $B_PID 2>/dev/null
```

預期:
```
5561 -> 302
5562 -> 302
```

且 B server 的 stderr 含 `"port fallback"` 與 `"requestedPort":5561` 與 `"url":"http://127.0.0.1:5562"`。

- [ ] **Step 9.5:場景 D — trust-proxy + X-Forwarded-Proto**

```bash
( cd /Users/tung/Codes/pi-webui && PI_WEBUI_PASSWORD=a PI_WEBUI_TRUST_PROXY=1 node dist/server/index.js --listen 127.0.0.1:5563 ) &
P_PID=$!
sleep 1
curl -s -i \
  -H "Content-Type: application/json" \
  -H "X-Forwarded-Proto: https" \
  -d '{"password":"a"}' \
  http://127.0.0.1:5563/api/login | grep -i "^set-cookie:"
kill $P_PID
wait $P_PID 2>/dev/null
```

預期:set-cookie 中包含 `Secure`。

- [ ] **Step 9.6:Browser 端目視驗證 (請使用者操作)**

不在自動化範圍,請使用者手動:

1. `cd ~/Codes/readyaiJobs/biocrown-v2` 並啟動 `PI_WEBUI_PASSWORD=test node /Users/tung/Codes/pi-webui/dist/server/index.js`
2. browser 打開 `http://127.0.0.1:4096` → 應跳轉到 `/login`
3. 輸入錯密碼 → 紅字錯誤訊息
4. 輸入 `test` → 登入成功,進到 SPA
5. 確認原有功能正常 (新建 session、發送 prompt、收回應)
6. 開 devtools → application → cookies,確認 `pi_webui_auth` cookie 存在、HttpOnly = true、SameSite = Lax、Secure = false

- [ ] **Step 9.7:回報觀察結果**

把每個場景的實際輸出附在回覆裡,並標註 PASS/FAIL。若有 FAIL 進入除錯流程。

---

## Self-Review

### Spec coverage check

- [x] CLI flag `--password` + env `PI_WEBUI_PASSWORD` — Task 5.2、5.3、8.1、8.2
- [x] CLI flag `--trust-proxy` + env `PI_WEBUI_TRUST_PROXY` — Task 5.2、5.3、8.1、8.2
- [x] Port 自動偵測 (線性 +1,上限 50) — Task 1、2、9.4
- [x] 沒設密碼 → 不啟用 (向後相容) — Task 5.3、6.2、9.2
- [x] `/login` 頁面 — Task 4、5.6
- [x] `POST /api/login` 比對密碼,成功 set-cookie — Task 5.4、6.5
- [x] `POST /api/logout` 清 cookie — Task 5.4、6.7
- [x] Cookie 屬性 (HttpOnly/SameSite=Lax/Path=/Max-Age=7d) — Task 3 buildSetCookie + 6.5
- [x] `Secure` 動態:trust-proxy + X-Forwarded-Proto=https — Task 3 shouldSetSecure + 5.4 + 6.10
- [x] Token 記憶體儲存 + 7 day TTL + lazy GC — Task 3 createAuthStore
- [x] WS upgrade gate — Task 5.7、6.8、6.9
- [x] Auth middleware 放行清單 — Task 5.4 isAuthPublic
- [x] 錯誤路徑:錯密碼 250ms delay + 401 — Task 5.4 handleLogin + 6.6
- [x] 受保護 API/WS → 401;其他 → 302 — Task 5.4 handleAuth + 6.3、6.8
- [x] Port 連續被佔 throw — Task 1.3 throw + 1.1 test
- [x] EACCES 不重試 — Task 1.1、1.3
- [x] password 空字串擋下 — Task 5.2 末尾檢查
- [x] Extension 端 forward — Task 7
- [x] README/ROADMAP 更新 — Task 8
- [x] 端到端手動驗證 — Task 9

### Placeholder scan

無 TODO / TBD / "fill in details"。所有 code 步驟皆附完整程式碼。

### Type / API 一致性

- `comparePassword(input, expected)` — 參數順序 input, expected,Task 3 與 Task 5.4 一致
- `createAuthStore({ ttlMs, now })` — Task 3 定義,Task 5.3 用預設值,一致
- `buildSetCookie(value, { secure, maxAge? })` — Task 3 / Task 5.4 一致
- `buildClearCookie({ secure })` — 同上
- `shouldSetSecure({ trustProxy, headers })` — Task 3 / Task 5.4 一致
- `readAuthCookie(headers)` — Task 3 / Task 5.4 / Task 5.7 一致
- `authStore.verify(token)` / `authStore.revoke(token)` — Task 3 / Task 5.4 / Task 5.7 一致
- `listenWithFallback(server, { host, port, maxAttempts?, logger? })` — Task 1 / Task 2 一致
- `COOKIE_NAME = "pi_webui_auth"` — Task 3 / Task 6 cookie 比對一致

無不一致。

---

## 執行選項

Plan complete and saved to `docs/superpowers/plans/2026-05-21-auth-and-port.md`. Two execution options:

**1. Subagent-Driven (recommended)** - 每個 task dispatch 一個全新 subagent 執行,task 間 review,迭代快

**2. Inline Execution** - 用 executing-plans skill 在本對話 batch 執行,checkpoints 處 review

Which approach?
