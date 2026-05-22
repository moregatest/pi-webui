# pi-webui × cloudflared quick tunnel 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 為 pi-webui 加上 `--tunnel` 旗標,啟用後自動 spawn cloudflared quick tunnel,把 server 暴露到 trycloudflare.com,並強制密碼 / trust-proxy 等安全預設。

**Architecture:** 新增 `src/server/tunnel.ts`(`TunnelManager extends EventEmitter`),在 `listenWithFallback` 拿到 actual port 之後 `new TunnelManager().start(actualUrl)`。失敗顯式、不 restart、SIGINT 一起收。Server 透過 WS `tunnel_state` packet broadcast 狀態給所有 client。

**Tech Stack:** Node 20+,TypeScript(寬鬆模式),`node:child_process`(spawn cloudflared),`node:test`(單元 + 整合),既有 `ws` / `@earendil-works/pi-coding-agent`。

**Spec:** `docs/superpowers/specs/2026-05-22-cloudflared-integration-design.md`

---

## File Structure

**Create:**
- `src/server/tunnel.ts` — `TunnelManager` 模組
- `test/tunnel.test.mjs` — TunnelManager 純單元測試(stub spawn)
- `test/server-tunnel.test.mjs` — server 整合測試(假 cloudflared fixture)
- `test/fixtures/fake-cloudflared.mjs` — fixture node script,模擬 cloudflared 輸出
- `test/tunnel-real.test.mjs` — opt-in 真 cloudflared e2e

**Modify:**
- `src/server/index.ts` — 加 `--tunnel` / `--tunnel-cloudflared` 解析、binary 偵測、自動密碼 / trust-proxy、warning、串接 `TunnelManager`、broadcast、shutdown、`connected` payload
- `src/extension/index.ts` — forward `--webui-tunnel` / `--webui-tunnel-cloudflared`
- `public/app.js` — `tunnel_state` packet 處理 + status bar chip 渲染
- `public/styles.css` — tunnel chip 顏色狀態
- `Makefile` — 新增 `test-tunnel` target
- `README.md` — 加 tunnel 說明
- `ROADMAP.md` — done 區塊 +1
- `CHANGELOG.md` — 加 2026-05-22 區塊

---

## Phase 1: TunnelManager 模組(`src/server/tunnel.ts`)

走 TDD:test 先,impl 後,每個 sub-step commit。

### Task 1.1: Skeleton 模組 + 第一個測試(基本 getState)

**Files:**
- Create: `src/server/tunnel.ts`
- Create: `test/tunnel.test.mjs`

- [ ] **Step 1: 寫 failing test**

`test/tunnel.test.mjs`:

```javascript
// pi-webui TunnelManager 純單元測試
// stub child_process.spawn 注入 fake child,不啟動真的 cloudflared。
// 真實 cloudflared e2e 測試走 test/tunnel-real.test.mjs (TUNNEL_REAL=1 opt-in)。

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { TunnelManager } from "../dist/server/tunnel.js";

// 製造一個可控的 fake child process:
// - stdout / stderr 是 EventEmitter,測試可以推 data
// - kill() 記錄被呼叫
// - emit('exit', code, signal) 模擬退出
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.killSignals = [];
  child.kill = (sig = "SIGTERM") => {
    child.killSignals.push(sig);
    child.killed = true;
    return true;
  };
  return child;
}

function makeFakeSpawn() {
  const calls = [];
  const children = [];
  const spawn = (cmd, args, opts) => {
    const child = makeFakeChild();
    calls.push({ cmd, args, opts });
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

test("TunnelManager: 初始 state 是 idle", () => {
  const { spawn } = makeFakeSpawn();
  const mgr = new TunnelManager({ cloudflaredBin: "cloudflared", spawn });
  assert.deepEqual(mgr.getState(), { phase: "idle" });
});
```

- [ ] **Step 2: 跑測試確認 fail**

```bash
make build
node --test test/tunnel.test.mjs
```

Expected: FAIL,`Cannot find module '../dist/server/tunnel.js'` 或 `TunnelManager is not a constructor`。

- [ ] **Step 3: 寫最小 impl 讓 test pass**

`src/server/tunnel.ts`:

```typescript
// pi-webui × cloudflared quick tunnel 整合
//
// 對外只暴露 TunnelManager class,所有 cloudflared 子 process lifecycle
// 都在這裡處理,不外洩 spawn 細節給 src/server/index.ts。
//
// 設計鐵則(2026-05-21 事故學到的):
//   1. cloudflared spawn args 必須含 --config /dev/null,不接受 override
//   2. 必須含 --no-autoupdate,避免子 process 卡在 update 流程
//   3. start(actualUrl) 收的是 main 從 listenWithFallback 拿到的 actual URL,
//      絕對不准內部去算 port

import { EventEmitter } from "node:events";
import { spawn as defaultSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export type TunnelPhase = "idle" | "starting" | "active" | "error" | "stopped";

export interface TunnelState {
  phase: TunnelPhase;
  url?: string;
  error?: string;
}

export interface TunnelLogger {
  info?: (msg: string, fields?: Record<string, unknown>) => void;
  warn?: (msg: string, fields?: Record<string, unknown>) => void;
  error?: (msg: string, fields?: Record<string, unknown>) => void;
  debug?: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface TunnelManagerOptions {
  cloudflaredBin: string;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  logger?: TunnelLogger;
  // 注入點:測試用 stub。預設用 node:child_process 的 spawn。
  spawn?: typeof defaultSpawn;
}

export class TunnelManager extends EventEmitter {
  private readonly bin: string;
  private readonly startupTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly logger: TunnelLogger;
  private readonly spawn: typeof defaultSpawn;
  private state: TunnelState = { phase: "idle" };

  constructor(opts: TunnelManagerOptions) {
    super();
    this.bin = opts.cloudflaredBin;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 30_000;
    this.stopTimeoutMs = opts.stopTimeoutMs ?? 5_000;
    this.logger = opts.logger ?? {};
    this.spawn = opts.spawn ?? defaultSpawn;
  }

  getState(): TunnelState {
    return { ...this.state };
  }
}
```

- [ ] **Step 4: 跑測試確認 pass**

```bash
make build
node --test test/tunnel.test.mjs
```

Expected: PASS,1/1 test。

- [ ] **Step 5: Commit**

```bash
git add src/server/tunnel.ts test/tunnel.test.mjs
git commit -m "tunnel: 新增 TunnelManager skeleton + getState 單元測試"
```

### Task 1.2: start() spawn cloudflared 跟 args 鐵則測試

**Files:**
- Modify: `src/server/tunnel.ts`
- Modify: `test/tunnel.test.mjs`

- [ ] **Step 1: 加 failing test**

在 `test/tunnel.test.mjs` 末尾追加:

```javascript
test("TunnelManager.start: spawn cloudflared 用寫死的 args(鐵則)", () => {
  const { spawn, calls } = makeFakeSpawn();
  const mgr = new TunnelManager({ cloudflaredBin: "cloudflared", spawn });

  mgr.start("http://127.0.0.1:4098");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "cloudflared");
  assert.deepEqual(calls[0].args, [
    "--no-autoupdate",
    "--config",
    "/dev/null",
    "tunnel",
    "--url",
    "http://127.0.0.1:4098",
  ]);
  assert.equal(mgr.getState().phase, "starting");
});

test("TunnelManager.start: 自訂 binary 路徑會傳給 spawn", () => {
  const { spawn, calls } = makeFakeSpawn();
  const mgr = new TunnelManager({ cloudflaredBin: "/opt/bin/cloudflared", spawn });
  mgr.start("http://127.0.0.1:4096");
  assert.equal(calls[0].cmd, "/opt/bin/cloudflared");
});

test("TunnelManager.start: 重複 start 不會再 spawn", () => {
  const { spawn, calls } = makeFakeSpawn();
  const mgr = new TunnelManager({ cloudflaredBin: "cloudflared", spawn });
  mgr.start("http://127.0.0.1:4096");
  mgr.start("http://127.0.0.1:4096");
  assert.equal(calls.length, 1);
});
```

- [ ] **Step 2: 跑 fail**

```bash
make build && node --test test/tunnel.test.mjs
```

Expected: 3 FAIL("mgr.start is not a function" / state 沒變 / spawn 被叫第二次)。

- [ ] **Step 3: 加 start() 實作**

在 `TunnelManager` class 內加:

```typescript
  private child: ChildProcess | null = null;

  start(actualUrl: string): void {
    if (this.state.phase !== "idle" && this.state.phase !== "stopped") {
      this.logger.debug?.("tunnel: start ignored (already running)", {
        phase: this.state.phase,
      });
      return;
    }
    this.setState({ phase: "starting" });

    const args = [
      "--no-autoupdate",
      "--config",
      "/dev/null",
      "tunnel",
      "--url",
      actualUrl,
    ];

    this.logger.info?.("tunnel: spawning cloudflared", { bin: this.bin, args });

    this.child = this.spawn(this.bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  private setState(next: TunnelState): void {
    this.state = next;
    this.emit("state", { ...next });
  }
```

- [ ] **Step 4: 跑 pass**

```bash
make build && node --test test/tunnel.test.mjs
```

Expected: 4/4 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/tunnel.ts test/tunnel.test.mjs
git commit -m "tunnel: start() spawn cloudflared 並寫死 args 鐵則"
```

### Task 1.3: URL parse + 'url' / 'state' 事件

**Files:**
- Modify: `src/server/tunnel.ts`
- Modify: `test/tunnel.test.mjs`

- [ ] **Step 1: 加 failing test**

追加到 `test/tunnel.test.mjs`:

```javascript
test("TunnelManager: 從 stderr parse 出 trycloudflare.com URL,emit 'url' + state active", () => {
  const { spawn, children } = makeFakeSpawn();
  const mgr = new TunnelManager({ cloudflaredBin: "cloudflared", spawn });
  const urls = [];
  const states = [];
  mgr.on("url", (u) => urls.push(u));
  mgr.on("state", (s) => states.push(s));

  mgr.start("http://127.0.0.1:4098");

  const child = children[0];
  child.stderr.emit(
    "data",
    Buffer.from(
      "INF |  Your quick Tunnel has been created! Visit it at  |\n" +
        "INF |  https://blue-fish-xx.trycloudflare.com  |\n",
    ),
  );

  assert.deepEqual(urls, ["https://blue-fish-xx.trycloudflare.com"]);
  assert.equal(mgr.getState().phase, "active");
  assert.equal(mgr.getState().url, "https://blue-fish-xx.trycloudflare.com");
  // state event 順序:starting 然後 active
  assert.equal(states.length, 2);
  assert.equal(states[0].phase, "starting");
  assert.equal(states[1].phase, "active");
  assert.equal(states[1].url, "https://blue-fish-xx.trycloudflare.com");
});

test("TunnelManager: stdout 出現 URL 也能 parse(防保險)", () => {
  const { spawn, children } = makeFakeSpawn();
  const mgr = new TunnelManager({ cloudflaredBin: "cloudflared", spawn });
  const urls = [];
  mgr.on("url", (u) => urls.push(u));

  mgr.start("http://127.0.0.1:4096");
  children[0].stdout.emit(
    "data",
    Buffer.from("https://abc-def-ghi.trycloudflare.com\n"),
  );

  assert.deepEqual(urls, ["https://abc-def-ghi.trycloudflare.com"]);
});

test("TunnelManager: parse 出 URL 後再來的輸出不重複 emit", () => {
  const { spawn, children } = makeFakeSpawn();
  const mgr = new TunnelManager({ cloudflaredBin: "cloudflared", spawn });
  const urls = [];
  mgr.on("url", (u) => urls.push(u));
  mgr.start("http://127.0.0.1:4096");
  const c = children[0];
  c.stderr.emit("data", Buffer.from("https://aaa-bbb-ccc.trycloudflare.com\n"));
  c.stderr.emit("data", Buffer.from("https://xxx-yyy-zzz.trycloudflare.com\n"));
  assert.equal(urls.length, 1);
});
```

- [ ] **Step 2: 跑 fail**

```bash
make build && node --test test/tunnel.test.mjs
```

Expected: FAIL(沒 parser 沒 emit)。

- [ ] **Step 3: 加 stream parser 實作**

修改 `start()` 內 spawn 之後加 listener,並新增 private method:

```typescript
  private static readonly URL_RE =
    /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
  private urlSeen = false;

  start(actualUrl: string): void {
    if (this.state.phase !== "idle" && this.state.phase !== "stopped") {
      this.logger.debug?.("tunnel: start ignored (already running)", {
        phase: this.state.phase,
      });
      return;
    }
    this.urlSeen = false;
    this.setState({ phase: "starting" });

    const args = [
      "--no-autoupdate",
      "--config",
      "/dev/null",
      "tunnel",
      "--url",
      actualUrl,
    ];

    this.logger.info?.("tunnel: spawning cloudflared", { bin: this.bin, args });

    this.child = this.spawn(this.bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child.stdout?.on("data", (chunk: Buffer) =>
      this.onChildOutput(chunk.toString("utf8")),
    );
    this.child.stderr?.on("data", (chunk: Buffer) =>
      this.onChildOutput(chunk.toString("utf8")),
    );
  }

  private onChildOutput(text: string): void {
    if (this.urlSeen) return;
    const match = TunnelManager.URL_RE.exec(text);
    if (!match) return;
    this.urlSeen = true;
    const url = match[0];
    this.setState({ phase: "active", url });
    this.emit("url", url);
  }
```

- [ ] **Step 4: 跑 pass**

```bash
make build && node --test test/tunnel.test.mjs
```

Expected: 7/7 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/tunnel.ts test/tunnel.test.mjs
git commit -m "tunnel: 從 stdout/stderr parse 出 trycloudflare URL 並 emit 'url'"
```

### Task 1.4: 30s startup timeout

**Files:**
- Modify: `src/server/tunnel.ts`
- Modify: `test/tunnel.test.mjs`

- [ ] **Step 1: 加 failing test**

追加:

```javascript
test("TunnelManager: 啟動 timeout 內沒 URL 會 emit 'error' + state error,並 kill child", async () => {
  const { spawn, children } = makeFakeSpawn();
  const mgr = new TunnelManager({
    cloudflaredBin: "cloudflared",
    spawn,
    startupTimeoutMs: 50,
  });
  const errors = [];
  const states = [];
  mgr.on("error", (e) => errors.push(e));
  mgr.on("state", (s) => states.push(s));

  mgr.start("http://127.0.0.1:4098");

  await new Promise((r) => setTimeout(r, 80));

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /did not report URL within 50ms/);
  assert.equal(mgr.getState().phase, "error");
  assert.match(mgr.getState().error, /did not report URL/);

  // child 必須被 kill 掉
  const child = children[0];
  assert.equal(child.killed, true);
  assert.ok(child.killSignals.includes("SIGTERM"));
});

test("TunnelManager: timeout 前拿到 URL 就不會觸發 error", async () => {
  const { spawn, children } = makeFakeSpawn();
  const mgr = new TunnelManager({
    cloudflaredBin: "cloudflared",
    spawn,
    startupTimeoutMs: 60,
  });
  const errors = [];
  mgr.on("error", (e) => errors.push(e));
  mgr.start("http://127.0.0.1:4096");
  children[0].stderr.emit(
    "data",
    Buffer.from("https://aaa-bbb-ccc.trycloudflare.com\n"),
  );
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(errors.length, 0);
  assert.equal(mgr.getState().phase, "active");
});
```

- [ ] **Step 2: 跑 fail**

```bash
make build && node --test test/tunnel.test.mjs
```

Expected: 2 FAIL(沒 timeout 機制)。

- [ ] **Step 3: 加 timeout 實作**

在 `TunnelManager` class 內加 field 與 timer 邏輯:

```typescript
  private startupTimer: NodeJS.Timeout | null = null;

  start(actualUrl: string): void {
    // ... 既有 guard / setState / spawn / stream listener ...

    // 啟動 30s timeout
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (this.state.phase === "starting") {
        this.fail(
          new Error(
            `cloudflared did not report URL within ${this.startupTimeoutMs}ms`,
          ),
        );
      }
    }, this.startupTimeoutMs);
  }

  private onChildOutput(text: string): void {
    if (this.urlSeen) return;
    const match = TunnelManager.URL_RE.exec(text);
    if (!match) return;
    this.urlSeen = true;
    // 拿到 URL 取消 startup timer
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    const url = match[0];
    this.setState({ phase: "active", url });
    this.emit("url", url);
  }

  private fail(error: Error): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    this.setState({ phase: "error", error: error.message });
    this.emit("error", error);
    if (this.child && !this.child.killed) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        /* 子 process 可能已死,忽略 */
      }
    }
  }
```

- [ ] **Step 4: 跑 pass**

```bash
make build && node --test test/tunnel.test.mjs
```

Expected: 9/9 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/tunnel.ts test/tunnel.test.mjs
git commit -m "tunnel: 30s startup timeout,逾時 emit error + SIGTERM 子 process"
```

### Task 1.5: child 中途 crash 處理

**Files:**
- Modify: `src/server/tunnel.ts`
- Modify: `test/tunnel.test.mjs`

- [ ] **Step 1: 加 failing test**

```javascript
test("TunnelManager: active 後 child 突然 exit code != 0 → state error", async () => {
  const { spawn, children } = makeFakeSpawn();
  const mgr = new TunnelManager({ cloudflaredBin: "cloudflared", spawn });
  const errors = [];
  mgr.on("error", (e) => errors.push(e));
  mgr.start("http://127.0.0.1:4096");
  const c = children[0];
  c.stderr.emit(
    "data",
    Buffer.from("https://aaa-bbb-ccc.trycloudflare.com\n"),
  );
  assert.equal(mgr.getState().phase, "active");

  c.emit("exit", 137, null);
  // 給 microtask 跑
  await new Promise((r) => setImmediate(r));

  assert.equal(mgr.getState().phase, "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /exited unexpectedly/);
});

test("TunnelManager: starting 階段 child 直接 exit → state error", async () => {
  const { spawn, children } = makeFakeSpawn();
  const mgr = new TunnelManager({ cloudflaredBin: "cloudflared", spawn });
  const errors = [];
  mgr.on("error", (e) => errors.push(e));
  mgr.start("http://127.0.0.1:4096");

  children[0].emit("exit", 1, null);
  await new Promise((r) => setImmediate(r));

  assert.equal(mgr.getState().phase, "error");
  assert.equal(errors.length, 1);
});
```

- [ ] **Step 2: 跑 fail**

```bash
make build && node --test test/tunnel.test.mjs
```

Expected: 2 FAIL(沒掛 child exit handler)。

- [ ] **Step 3: 加 child exit handler**

在 `start()` 內,spawn 之後加:

```typescript
    this.child.on("exit", (code, signal) => this.onChildExit(code, signal));
```

加 private method:

```typescript
  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.logger.info?.("tunnel: child exited", { code, signal });
    if (this.state.phase === "stopping" || this.state.phase === "stopped") {
      this.setState({ phase: "stopped" });
      this.child = null;
      return;
    }
    this.fail(
      new Error(`cloudflared exited unexpectedly (code=${code} signal=${signal})`),
    );
    this.child = null;
  }
```

注意這裡 reference 了 phase `"stopping"`,要在 `TunnelPhase` 加上:

```typescript
export type TunnelPhase =
  | "idle"
  | "starting"
  | "active"
  | "stopping"
  | "error"
  | "stopped";
```

- [ ] **Step 4: 跑 pass**

```bash
make build && node --test test/tunnel.test.mjs
```

Expected: 11/11 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/tunnel.ts test/tunnel.test.mjs
git commit -m "tunnel: child 異常 exit 時 emit error 並標 state=error"
```

### Task 1.6: stop() SIGTERM + 5s fallback SIGKILL + idempotent

**Files:**
- Modify: `src/server/tunnel.ts`
- Modify: `test/tunnel.test.mjs`

- [ ] **Step 1: 加 failing test**

```javascript
test("TunnelManager.stop: SIGTERM child 並等 exit,phase=stopped", async () => {
  const { spawn, children } = makeFakeSpawn();
  const mgr = new TunnelManager({ cloudflaredBin: "cloudflared", spawn });
  mgr.start("http://127.0.0.1:4096");
  const c = children[0];
  c.stderr.emit(
    "data",
    Buffer.from("https://aaa-bbb-ccc.trycloudflare.com\n"),
  );

  const p = mgr.stop();
  assert.ok(c.killSignals.includes("SIGTERM"));
  c.emit("exit", null, "SIGTERM");
  await p;
  assert.equal(mgr.getState().phase, "stopped");
});

test("TunnelManager.stop: child 5s 沒退 → SIGKILL", async () => {
  const { spawn, children } = makeFakeSpawn();
  const mgr = new TunnelManager({
    cloudflaredBin: "cloudflared",
    spawn,
    stopTimeoutMs: 50,
  });
  mgr.start("http://127.0.0.1:4096");
  const c = children[0];
  c.stderr.emit(
    "data",
    Buffer.from("https://aaa-bbb-ccc.trycloudflare.com\n"),
  );

  const p = mgr.stop();
  // 不發 exit 模擬卡死,等 stopTimeoutMs 過
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(c.killSignals.includes("SIGKILL"));
  // SIGKILL 後 forced state
  c.emit("exit", null, "SIGKILL");
  await p;
  assert.equal(mgr.getState().phase, "stopped");
});

test("TunnelManager.stop: idle 狀態呼叫不會炸,直接 resolve", async () => {
  const { spawn } = makeFakeSpawn();
  const mgr = new TunnelManager({ cloudflaredBin: "cloudflared", spawn });
  await mgr.stop();
  assert.equal(mgr.getState().phase, "stopped");
});

test("TunnelManager.stop: 連續兩次 stop 冪等", async () => {
  const { spawn, children } = makeFakeSpawn();
  const mgr = new TunnelManager({ cloudflaredBin: "cloudflared", spawn });
  mgr.start("http://127.0.0.1:4096");
  const c = children[0];
  c.stderr.emit(
    "data",
    Buffer.from("https://aaa-bbb-ccc.trycloudflare.com\n"),
  );
  const p1 = mgr.stop();
  const p2 = mgr.stop();
  c.emit("exit", null, "SIGTERM");
  await Promise.all([p1, p2]);
  assert.equal(mgr.getState().phase, "stopped");
  // SIGTERM 只發一次
  assert.equal(
    c.killSignals.filter((s) => s === "SIGTERM").length,
    1,
  );
});
```

- [ ] **Step 2: 跑 fail**

```bash
make build && node --test test/tunnel.test.mjs
```

Expected: 4 FAIL(沒 stop() 實作)。

- [ ] **Step 3: 加 stop() 實作**

```typescript
  private stopPromise: Promise<void> | null = null;

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.state.phase === "idle" || this.state.phase === "stopped") {
      this.setState({ phase: "stopped" });
      return;
    }
    const child = this.child;
    if (!child) {
      this.setState({ phase: "stopped" });
      return;
    }

    this.setState({ phase: "stopping" });

    this.stopPromise = new Promise<void>((resolve) => {
      const onExit = () => {
        if (sigkillTimer) clearTimeout(sigkillTimer);
        resolve();
      };
      child.once("exit", onExit);

      try {
        child.kill("SIGTERM");
      } catch {
        /* 已死 */
      }

      const sigkillTimer = setTimeout(() => {
        this.logger.warn?.("tunnel: stop timeout, sending SIGKILL");
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已死 */
        }
      }, this.stopTimeoutMs);
    });

    await this.stopPromise;
    // 注意:onChildExit 已經把 phase 設為 stopped,這裡 double-check
    if (this.state.phase !== "stopped") {
      this.setState({ phase: "stopped" });
    }
    this.child = null;
    this.stopPromise = null;
  }
```

- [ ] **Step 4: 跑 pass**

```bash
make build && node --test test/tunnel.test.mjs
```

Expected: 15/15 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/tunnel.ts test/tunnel.test.mjs
git commit -m "tunnel: stop() SIGTERM + 5s fallback SIGKILL,冪等"
```

---

## Phase 2: Server 整合(`src/server/index.ts`)

### Task 2.1: CLI flag 解析 + help 文字 + env var

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: 加 flag 到 printHelp() 跟 parseArgs()**

在 `printHelp()` 的 options 區追加(放在 `--sandbox-workspace` 之後):

```typescript
    "  --tunnel                    啟用 cloudflared quick tunnel(trycloudflare.com)。",
    "                              強制 --password(沒指定會自動產生)與 --trust-proxy。",
    "                              alias: PI_WEBUI_TUNNEL=1.",
    "  --tunnel-cloudflared <path> 自訂 cloudflared binary 路徑。",
    "                              alias: PI_WEBUI_CLOUDFLARED.",
```

在 env vars 區追加:

```typescript
    "  PI_WEBUI_TUNNEL            '1' 啟用 cloudflared quick tunnel",
    "  PI_WEBUI_CLOUDFLARED       cloudflared binary path",
```

在 `parseArgs()` 末段加(放在 `--sandbox-workspace` 之後,`--help` 之前):

```typescript
    else if (a === "--tunnel") out.tunnel = true;
    else if (a === "--tunnel-cloudflared") out.tunnelCloudflared = argv[++i];
    else if (a.startsWith("--tunnel-cloudflared=")) out.tunnelCloudflared = a.slice("--tunnel-cloudflared=".length);
```

- [ ] **Step 2: 加模組層級變數**

在既有 `const sandboxEnabled = ...` 那一段附近加(`auth` 與 `sandbox` 解析之間):

```typescript
// tunnel 啟用條件:CLI --tunnel 或 PI_WEBUI_TUNNEL=1。
// effective binary path:CLI > env > "cloudflared"(走 PATH)
const tunnelEnabled = !!args.tunnel || process.env.PI_WEBUI_TUNNEL === "1";
const tunnelCloudflared =
  args.tunnelCloudflared || process.env.PI_WEBUI_CLOUDFLARED || "cloudflared";
```

- [ ] **Step 3: lint + build pass**

```bash
make lint
```

Expected: tsc 0 errors。

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts
git commit -m "server: 解析 --tunnel / --tunnel-cloudflared flag(尚未串接)"
```

### Task 2.2: cloudflared binary 偵測 + fail-fast

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: 加 binary 偵測 helper**

在檔案頂部 import 區補:

```typescript
import { execSync } from "node:child_process";
```

(`node:child_process` 之前沒被 import 過,確認一下;如果已有 import 該 module 的別處,直接合併。)

在 `tunnelEnabled` 解析之後加 helper:

```typescript
function isCloudflaredAvailable(bin: string): boolean {
  if (!bin) return false;
  // 絕對路徑直接 fs 檢查
  if (bin.startsWith("/")) {
    try {
      return statSync(bin).isFile();
    } catch {
      return false;
    }
  }
  // 走 PATH 偵測
  try {
    execSync(`command -v ${JSON.stringify(bin)}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
```

(注意 `statSync` 已在頂部 import。)

- [ ] **Step 2: 加 fail-fast 邏輯**

在 `sandbox` 初始化區塊之後、`createRuntime` 之前加:

```typescript
if (tunnelEnabled && !isCloudflaredAvailable(tunnelCloudflared)) {
  process.stderr.write(
    `error: --tunnel requires cloudflared binary, not found: ${tunnelCloudflared}\n` +
      "install:\n" +
      "  macOS:  brew install cloudflared\n" +
      "  Linux:  https://pkg.cloudflare.com/index.html\n" +
      "  cargo:  cargo install cloudflared\n",
  );
  process.exit(2);
}
```

- [ ] **Step 3: lint pass**

```bash
make lint
```

Expected: 0 errors。

- [ ] **Step 4: 手動 smoke**

```bash
make build && PATH=/usr/bin node dist/server/index.js --tunnel
```

Expected: exit code 2,stderr 印安裝指引。

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts
git commit -m "server: --tunnel 啟用時偵測 cloudflared binary,缺失 fail-fast"
```

### Task 2.3: 自動產生密碼 + 寫檔

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: 加密碼產生 helper**

在頂部 import 區追加:

```typescript
import { randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
```

(`writeFileSync` 可能已 import,合併;`fs` 已有 `readFileSync` 等,加 `writeFileSync, chmodSync`。)

加 helper(放在 `isCloudflaredAvailable` 旁):

```typescript
function generateTunnelPassword(): string {
  // 24 bytes → 32 字元 base64url(取掉 padding)
  return randomBytes(24).toString("base64url");
}

function writeTunnelPasswordFile(agentDir: string, password: string): string {
  const path = resolve(agentDir, "tunnel-password.txt");
  writeFileSync(path, password + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* mode 已對,忽略 */
  }
  return path;
}
```

- [ ] **Step 2: 在 authPassword 解析後串接**

把:

```typescript
const authPassword = (args.password ?? process.env.PI_WEBUI_PASSWORD ?? "") || "";
```

改為:

```typescript
let authPassword = (args.password ?? process.env.PI_WEBUI_PASSWORD ?? "") || "";
let tunnelPasswordPath: string | null = null;
let tunnelPasswordGenerated = false;
if (tunnelEnabled && !authPassword) {
  authPassword = generateTunnelPassword();
  tunnelPasswordPath = writeTunnelPasswordFile(agentDir, authPassword);
  tunnelPasswordGenerated = true;
}
```

注意 `agentDir` 變數在原始碼後面才解析(看 `const agentDir = process.env.PI_AGENT_DIR || getAgentDir();`),要把 `agentDir` 解析移到 `authPassword` 之前,或把以上 block 移到 `agentDir` 之後。**移密碼 block 到 `agentDir` 之後比較安全**(`agentDir` 不依賴 password)。

- [ ] **Step 3: lint pass**

```bash
make lint
```

Expected: 0 errors。

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts
git commit -m "server: --tunnel 沒帶 --password 時自動產生 32 字元亂數並寫檔"
```

### Task 2.4: 自動 trust-proxy + warnings

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: 自動 trust-proxy**

把:

```typescript
const trustProxy = !!args.trustProxy || process.env.PI_WEBUI_TRUST_PROXY === "1";
```

改成:

```typescript
let trustProxy = !!args.trustProxy || process.env.PI_WEBUI_TRUST_PROXY === "1";
if (tunnelEnabled && !trustProxy) {
  trustProxy = true;
}
```

- [ ] **Step 2: 加 warnings**

在密碼產生與 trust-proxy 之後,sandbox 初始化之前加:

```typescript
if (tunnelEnabled && host === "0.0.0.0") {
  process.stderr.write(
    "warning: --tunnel with --listen 0.0.0.0:* exposes LAN and public concurrently.\n",
  );
}
if (tunnelEnabled && !sandboxEnabled) {
  process.stderr.write(
    "warning: tunnel exposed without sandbox; tools have full host access. add --sandbox to restrict.\n",
  );
}
```

(`host` 已經是 module 層級的 const。)

- [ ] **Step 3: lint pass**

```bash
make lint
```

Expected: 0 errors。

- [ ] **Step 4: Commit**

```bash
git add src/server/index.ts
git commit -m "server: --tunnel 自動啟用 trust-proxy,並印 LAN / sandbox 警告"
```

### Task 2.5: 串接 TunnelManager + broadcast(`activeControllers`)

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: import TunnelManager**

頂部 import 加:

```typescript
import { TunnelManager } from "./tunnel.js";
import type { TunnelState } from "./tunnel.js";
```

- [ ] **Step 2: 加 activeControllers 與 broadcast helper**

在 `NativePiSessionController` 定義之後、`createServer` 之前加:

```typescript
const activeControllers = new Set<NativePiSessionController>();

let tunnel: TunnelManager | null = null;
let lastTunnelState: TunnelState = { phase: "idle" };

function broadcastTunnelState(state: TunnelState) {
  lastTunnelState = state;
  for (const ctrl of activeControllers) {
    sendJson(ctrl.ws, { type: "tunnel_state", payload: state });
  }
}
```

- [ ] **Step 3: 在 wss connection / close 註冊**

把現有的:

```typescript
wss.on("connection", (ws, req) => {
  const remote = req?.socket?.remoteAddress || "unknown";
  logger.info("ws connect", { remote });
  const controller = new NativePiSessionController(ws);

  ws.on("message", (raw) => {
    // ... 略
  });

  ws.on("close", () => {
    logger.info("ws disconnect", { remote });
    void controller.close();
  });
});
```

修改成:

```typescript
wss.on("connection", (ws, req) => {
  const remote = req?.socket?.remoteAddress || "unknown";
  logger.info("ws connect", { remote });
  const controller = new NativePiSessionController(ws);
  activeControllers.add(controller);

  ws.on("message", (raw) => {
    // ... 維持既有邏輯
  });

  ws.on("close", () => {
    logger.info("ws disconnect", { remote });
    activeControllers.delete(controller);
    void controller.close();
  });
});
```

(`ws.on("message")` 內容不變,完整保留。)

- [ ] **Step 4: listenWithFallback 之後 spawn tunnel**

在現有 `const actualPort = await listenWithFallback(...)` 之後,`logger.info("listening", ...)` 之前插入:

```typescript
const actualUrl = `http://${host}:${actualPort}`;

if (tunnelEnabled) {
  tunnel = new TunnelManager({
    cloudflaredBin: tunnelCloudflared,
    logger,
  });
  tunnel.on("state", (s: TunnelState) => broadcastTunnelState(s));
  tunnel.on("url", (url: string) => {
    process.stdout.write(`  tunnel:   ${url}\n`);
  });
  tunnel.on("error", (e: Error) => {
    logger.error("tunnel error", { error: e.message });
    process.stderr.write(`  tunnel:   error - ${e.message}\n`);
  });
  tunnel.start(actualUrl);
  // 廣播初始 starting 狀態(spawn 同步觸發了 state event,但
  // activeControllers 此時為空,所以這裡顯式設一次 lastTunnelState)
  lastTunnelState = tunnel.getState();
}
```

- [ ] **Step 5: 修 connected payload 加 tunnel**

找到既有的:

```typescript
    sendJson(this.ws, {
      type: "connected",
      payload: {
        appCwd: this.cwd,
        agentDir,
        homeDir: process.env.HOME || "",
        diagnostics: this.runtime.diagnostics,
        slashCommands: this.collectSlashCommands(),
        hideModel,
        sandbox: sandboxEnabled
          ? {
              enabled: !!sandbox,
              workspace: sandbox?.workspaceRoot ?? null,
              guestPath: GUEST_WORKSPACE,
              error: sandboxInitError,
            }
          : null,
      },
    });
```

加 `tunnel` 欄位:

```typescript
        sandbox: sandboxEnabled
          ? {
              enabled: !!sandbox,
              workspace: sandbox?.workspaceRoot ?? null,
              guestPath: GUEST_WORKSPACE,
              error: sandboxInitError,
            }
          : null,
        tunnel: tunnelEnabled
          ? { enabled: true, ...lastTunnelState }
          : null,
```

- [ ] **Step 6: lint pass**

```bash
make lint
```

Expected: 0 errors。

- [ ] **Step 7: Commit**

```bash
git add src/server/index.ts
git commit -m "server: 串接 TunnelManager,broadcast tunnel_state,connected payload 加 tunnel"
```

### Task 2.6: gracefulShutdown 串 tunnel.stop()

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: 在 sandbox.close() 之前加 tunnel.stop()**

把:

```typescript
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown: starting", { signal });
  try {
    server.close();
  } catch {
    // ignore
  }
  if (sandbox) {
    try {
      await sandbox.close();
    } catch (error) {
      logger.warn("shutdown: sandbox close failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.info("shutdown: done");
  process.exit(0);
}
```

改成(`tunnel.stop()` 放 `sandbox.close()` 前面,因為 tunnel 不依賴 sandbox):

```typescript
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown: starting", { signal });
  try {
    server.close();
  } catch {
    // ignore
  }
  if (tunnel) {
    try {
      await tunnel.stop();
    } catch (error) {
      logger.warn("shutdown: tunnel stop failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (sandbox) {
    try {
      await sandbox.close();
    } catch (error) {
      logger.warn("shutdown: sandbox close failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.info("shutdown: done");
  process.exit(0);
}
```

- [ ] **Step 2: 確認 listening log 加 tunnel 欄位**

把:

```typescript
logger.info("listening", {
  url,
  requestedPort: port,
  fallback: actualPort !== port,
  appCwd,
  agentDir,
  sessionDir: sessionDir || undefined,
  auth: authEnabled ? "enabled" : "disabled",
  trustProxy: authEnabled ? trustProxy : undefined,
  sandbox: sandboxEnabled ? (sandbox ? "enabled" : `error:${sandboxInitError}`) : "disabled",
});
```

加一行:

```typescript
  tunnel: tunnelEnabled ? "starting" : "disabled",
```

- [ ] **Step 3: lint pass**

```bash
make lint
```

Expected: 0 errors。

- [ ] **Step 4: 印 password 到 console(自動產生時)**

在 `logger.info("listening", ...)` 之後加:

```typescript
if (tunnelPasswordGenerated) {
  process.stdout.write(
    `  password: ${authPassword}  (written to ${tunnelPasswordPath})\n`,
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts
git commit -m "server: gracefulShutdown 串 tunnel.stop();listening log 加 tunnel 欄位"
```

---

## Phase 3: 整合測試(`test/server-tunnel.test.mjs`)

### Task 3.1: Fake cloudflared fixture

**Files:**
- Create: `test/fixtures/fake-cloudflared.mjs`

- [ ] **Step 1: 寫 fixture**

```javascript
#!/usr/bin/env node
// fake cloudflared:模擬 quick tunnel 的 startup 輸出。
//
// 行為:
//   - 立刻把 fake URL 印到 stderr
//   - SIGTERM 後 0.05s 退出 code=0
//
// 用法(由 server-tunnel.test.mjs spawn):
//   node test/fixtures/fake-cloudflared.mjs --no-autoupdate --config /dev/null tunnel --url <url>
//
// 注意:測試只關心輸出與 lifecycle,不關心 args 內容(那個已被 tunnel.test.mjs 覆蓋)。

const FAKE_URL = process.env.FAKE_TUNNEL_URL || "https://fake-test-id.trycloudflare.com";

process.stderr.write(`INF | Your quick Tunnel has been created!  |\n`);
process.stderr.write(`INF | ${FAKE_URL} |\n`);

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 50);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

// 保持 alive
setInterval(() => {}, 60_000);
```

- [ ] **Step 2: 給執行權限**

```bash
chmod +x test/fixtures/fake-cloudflared.mjs
```

- [ ] **Step 3: Commit**

```bash
git add test/fixtures/fake-cloudflared.mjs
git commit -m "test: 加 fake-cloudflared fixture 給整合測試用"
```

### Task 3.2: server-tunnel.test.mjs(spawn 真 server + fake cloudflared)

**Files:**
- Create: `test/server-tunnel.test.mjs`

- [ ] **Step 1: 寫整合測試**

```javascript
// server + tunnel 整合測試:spawn 真 pi-webui server,把 --tunnel-cloudflared
// 指向 fake fixture,驗證 banner / WS packet / connected payload / shutdown。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "..", "dist", "server", "index.js");
const FAKE_CLOUDFLARED = resolve(__dirname, "fixtures", "fake-cloudflared.mjs");

// 在指定 port 區間找一個沒被佔用的 port 起 server。從 4200 起,避免跟 4096 衝突。
let nextPort = 4200;
function takeFreePort() {
  return nextPort++;
}

async function startServer(extraArgs = [], extraEnv = {}) {
  const port = takeFreePort();
  const agentDir = mkdtempSync(resolve(tmpdir(), "pi-webui-tunnel-"));
  const child = spawn(
    "node",
    [
      SERVER_PATH,
      "--listen",
      `127.0.0.1:${port}`,
      "--tunnel",
      "--tunnel-cloudflared",
      // 包一層 node + fixture script
      "node",
      ...extraArgs,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_AGENT_DIR: agentDir,
        // hack:讓 --tunnel-cloudflared "node" 後續 args 包含 fixture path。
        // 實際上不行,需要改方式 — 直接把 FAKE_CLOUDFLARED 當 binary。
        // 注意:server 偵測機制走 statSync 或 command -v,需要 .mjs 有 exec bit
        ...extraEnv,
      },
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => {
    stdout += c.toString();
  });
  child.stderr.on("data", (c) => {
    stderr += c.toString();
  });

  // 等 server 印 listening
  await waitFor(
    () => stderr.includes("listening") || stdout.includes("listening"),
    3000,
    () => `stderr=${stderr} stdout=${stdout}`,
  );

  return {
    child,
    port,
    agentDir,
    getStdout: () => stdout,
    getStderr: () => stderr,
    cleanup: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate, timeoutMs, describe) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor timeout: ${describe?.() || ""}`);
}

// 因為 --tunnel-cloudflared 期待是 binary path,需要直接指向 fixture(.mjs 有 shebang)
test("server --tunnel: tunnel chip / connected payload / WS broadcast / shutdown", async () => {
  const srv = await startServer(["--tunnel-cloudflared", FAKE_CLOUDFLARED]);
  try {
    // 等 fake cloudflared 印 URL
    await waitFor(
      () => srv.getStdout().includes("fake-test-id.trycloudflare.com"),
      5000,
      () => `no tunnel URL in stdout: ${srv.getStdout()}`,
    );

    // 自動產生密碼有寫檔
    const pwPath = resolve(srv.agentDir, "tunnel-password.txt");
    const stat = statSync(pwPath);
    // mode 600(忽略 file type bits)
    assert.equal(stat.mode & 0o777, 0o600);
    const pw = readFileSync(pwPath, "utf8").trim();
    assert.match(pw, /^[A-Za-z0-9_-]{30,}$/);

    // WS 連 server。要用 Cookie auth(server 自動產生了密碼,需要先 login)
    const loginResp = await fetch(`http://127.0.0.1:${srv.port}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    assert.equal(loginResp.status, 200);
    const cookie = loginResp.headers.get("set-cookie")?.split(";")[0] ?? "";

    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, {
      headers: { Cookie: cookie },
    });
    const packets = [];
    ws.on("message", (raw) => packets.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "ready", lastSeq: 0 }));

    // 等 connected
    await waitFor(
      () => packets.some((p) => p.type === "connected"),
      3000,
      () => `no connected packet`,
    );
    const connected = packets.find((p) => p.type === "connected");
    assert.equal(connected.payload.tunnel?.enabled, true);
    assert.ok(["starting", "active"].includes(connected.payload.tunnel.phase));

    // 等 tunnel_state phase=active
    await waitFor(
      () => packets.some((p) => p.type === "tunnel_state" && p.payload.phase === "active"),
      3000,
      () => `no tunnel_state active`,
    );
    const active = [...packets]
      .reverse()
      .find((p) => p.type === "tunnel_state" && p.payload.phase === "active");
    assert.equal(active.payload.url, "https://fake-test-id.trycloudflare.com");

    ws.close();
  } finally {
    await srv.cleanup();
  }
});

test("server --tunnel + --listen 0.0.0.0: 印 LAN 警告", async () => {
  // 拿不同 port 避免衝突
  const port = takeFreePort();
  const agentDir = mkdtempSync(resolve(tmpdir(), "pi-webui-tunnel-warn-"));
  const child = spawn(
    "node",
    [
      SERVER_PATH,
      "--listen",
      `0.0.0.0:${port}`,
      "--tunnel",
      "--tunnel-cloudflared",
      FAKE_CLOUDFLARED,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_AGENT_DIR: agentDir },
    },
  );
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c.toString();
  });
  try {
    await waitFor(() => stderr.includes("listening"), 3000, () => stderr);
    assert.match(stderr, /LAN and public concurrently/);
    assert.match(stderr, /tools have full host access/);
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("server --tunnel + 找不到 cloudflared binary → exit 2", async () => {
  const port = takeFreePort();
  const child = spawn(
    "node",
    [
      SERVER_PATH,
      "--listen",
      `127.0.0.1:${port}`,
      "--tunnel",
      "--tunnel-cloudflared",
      "/nonexistent/cloudflared-deadbeef",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    },
  );
  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c.toString();
  });
  const code = await new Promise((r) => child.once("exit", r));
  assert.equal(code, 2);
  assert.match(stderr, /requires cloudflared binary/);
  assert.match(stderr, /brew install cloudflared/);
});
```

- [ ] **Step 2: 跑整合測試**

```bash
make test
```

Expected: 全部 pass(包含既有與新加的)。

- [ ] **Step 3: 若 fail,debug 並修**

常見問題:
- fake cloudflared 沒給執行權限 → `chmod +x test/fixtures/fake-cloudflared.mjs`
- statSync 在 mac 上 mode 可能含其他 bit → 已用 `mode & 0o777`
- port 衝突 → 改 takeFreePort 起始 port

- [ ] **Step 4: Commit**

```bash
git add test/server-tunnel.test.mjs
git commit -m "test: server + tunnel 整合測試(fake cloudflared / WS broadcast / fail-fast)"
```

---

## Phase 4: Extension forward(`src/extension/index.ts`)

### Task 4.1: Extension flag 註冊與 forward

**Files:**
- Modify: `src/extension/index.ts`

- [ ] **Step 1: 加 StartOptions 欄位**

把 `interface StartOptions` 內 `sandboxWorkspace?: string;` 之後追加:

```typescript
	tunnel?: boolean;
	tunnelCloudflared?: string;
```

- [ ] **Step 2: runStart 內 forward**

在既有 `if (opts.sandboxWorkspace) serverArgs.push("--sandbox-workspace", opts.sandboxWorkspace);` 之後加:

```typescript
			if (opts.tunnel) serverArgs.push("--tunnel");
			if (opts.tunnelCloudflared) serverArgs.push("--tunnel-cloudflared", opts.tunnelCloudflared);
```

- [ ] **Step 3: parseStartFlags 加解析**

在 `if (t === "--sandbox-workspace") opts.sandboxWorkspace = valueOf(++i, t);` 之後加:

```typescript
			else if (t === "--tunnel") opts.tunnel = true;
			else if (t === "--tunnel-cloudflared") opts.tunnelCloudflared = valueOf(++i, t);
			else if (t.startsWith("--tunnel-cloudflared=")) opts.tunnelCloudflared = t.slice("--tunnel-cloudflared=".length);
```

- [ ] **Step 4: registerFlag + auto-start forward**

在 `pi.registerFlag?.("webui-sandbox-workspace", ...)` 之後加:

```typescript
	pi.registerFlag?.("webui-tunnel", {
		description: "Enable cloudflared quick tunnel for pi-webui. Implies --webui.",
		type: "boolean",
		default: false,
	});

	pi.registerFlag?.("webui-tunnel-cloudflared", {
		description: "Custom cloudflared binary path. Implies --webui.",
		type: "string",
		default: "",
	});
```

在 setImmediate 內 flag 讀取區追加:

```typescript
			tunnel = !!pi.getFlag?.("webui-tunnel");
			tunnelCloudflared = String(pi.getFlag?.("webui-tunnel-cloudflared") || "").trim();
```

(需要在最上面 `let tunnel: boolean;` 跟 `let tunnelCloudflared: string;` 宣告。)

在 `want = ... || sandboxWorkspace.length > 0;` 追加 `|| tunnel || tunnelCloudflared.length > 0`。

在 `runStart(stubCtx, { ... })` 的 options object 內加:

```typescript
				tunnel: tunnel || undefined,
				tunnelCloudflared: tunnelCloudflared || undefined,
```

- [ ] **Step 5: lint pass**

```bash
make lint
```

Expected: 0 errors。

- [ ] **Step 6: Commit**

```bash
git add src/extension/index.ts
git commit -m "extension: forward --webui-tunnel / --webui-tunnel-cloudflared 到 server"
```

---

## Phase 5: WebUI status bar chip(`public/app.js` + `public/styles.css`)

### Task 5.1: tunnel chip 渲染

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: 先 grep 找 sandbox chip 處理位置**

```bash
grep -n "sandbox" public/app.js | head -20
```

預期看到 `payload.sandbox` 的處理跟 chip render。仿照寫 tunnel。

- [ ] **Step 2: 在 sandbox chip 旁邊加 tunnel chip render**

找 `connected` handler 內處理 sandbox 的程式碼,例:

```javascript
if (payload.sandbox) {
  // ... 渲染 sandbox chip
}
```

在後面加:

```javascript
if (payload.tunnel) {
  renderTunnelChip(payload.tunnel);
}
```

加一個 `renderTunnelChip` 函式:

```javascript
function renderTunnelChip(state) {
  const chip = document.getElementById("status-tunnel");
  if (!chip) return;
  if (!state || !state.enabled) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  chip.dataset.phase = state.phase || "starting";
  let label = "tunnel: ?";
  let tooltip = "";
  let clickHandler = null;
  switch (state.phase) {
    case "starting":
      label = "tunnel: connecting...";
      tooltip = "Waiting for cloudflared to report URL";
      break;
    case "active": {
      const url = state.url || "";
      const host = (() => {
        try { return new URL(url).host; }
        catch { return url; }
      })();
      label = `tunnel: ${host}`;
      tooltip = url;
      clickHandler = async () => {
        try {
          await navigator.clipboard.writeText(url);
        } catch {
          /* clipboard might be denied */
        }
      };
      break;
    }
    case "error":
      label = "tunnel: error";
      tooltip = state.error || "Tunnel error";
      break;
    case "stopped":
      label = "tunnel: stopped";
      tooltip = "Tunnel was stopped";
      break;
  }
  chip.textContent = label;
  chip.title = tooltip;
  chip.onclick = clickHandler;
}
```

- [ ] **Step 3: 加 tunnel_state packet handler**

找 server packet dispatcher(例如 `socket.on("message", ...)` 或 `handlePacket`),在處理 `sandbox` 相關 packet 旁加:

```javascript
case "tunnel_state":
  renderTunnelChip({ enabled: true, ...packet.payload });
  break;
```

- [ ] **Step 4: 加 chip DOM 元素到 HTML**

找 `public/index.html`,在 sandbox chip 附近(看現有結構)加:

```html
<span id="status-tunnel" class="status-chip" hidden></span>
```

- [ ] **Step 5: lint pass**

```bash
make lint
```

Expected: 0 errors。

- [ ] **Step 6: Commit**

```bash
git add public/app.js public/index.html
git commit -m "webui: 加 tunnel status chip,顯示連線狀態並點擊複製 URL"
```

### Task 5.2: tunnel chip styles

**Files:**
- Modify: `public/styles.css`

- [ ] **Step 1: 加 chip 顏色狀態**

找既有 `.status-chip[data-state]` 之類規則(看現況),仿照加:

```css
#status-tunnel[data-phase="starting"] {
  background: var(--color-warning-bg, #b58900);
  color: var(--color-warning-fg, #fff);
}
#status-tunnel[data-phase="active"] {
  background: var(--color-success-bg, #2aa198);
  color: var(--color-success-fg, #fff);
  cursor: pointer;
}
#status-tunnel[data-phase="error"] {
  background: var(--color-error-bg, #dc322f);
  color: var(--color-error-fg, #fff);
}
#status-tunnel[data-phase="stopped"] {
  background: var(--color-muted-bg, #586e75);
  color: var(--color-muted-fg, #fff);
}
```

(實際取色實作時看 `styles.css` 既有 CSS variables,優先沿用既有 token。)

- [ ] **Step 2: 手動 smoke**

```bash
make build && PI_AGENT_DIR=/tmp/pi-webui-smoke node dist/server/index.js \
  --tunnel \
  --tunnel-cloudflared $(pwd)/test/fixtures/fake-cloudflared.mjs \
  --listen 127.0.0.1:4200 &
SERVER_PID=$!
sleep 1
# 開瀏覽器看 chip(這步靠人眼)
open http://127.0.0.1:4200/
sleep 5
kill $SERVER_PID
```

Expected: chip 從黃變綠,hover 看到完整 URL,點擊複製。

- [ ] **Step 3: Commit**

```bash
git add public/styles.css
git commit -m "webui: tunnel chip 加顏色狀態(starting=黃 / active=綠 / error=紅)"
```

---

## Phase 6: E2E + 文件

### Task 6.1: Makefile `test-tunnel`

**Files:**
- Modify: `Makefile`

- [ ] **Step 1: 加 target**

在 `test-sandbox:` 之後追加:

```makefile
# 真實 cloudflared 整合測試。預設不跑 (要 cloudflared binary + 網路)。
# 透過 TUNNEL_REAL=1 切換 opt-in 標記。
test-tunnel: build
	@echo "==> test-tunnel (opt-in real cloudflared)"
	@TUNNEL_REAL=1 node --test test/tunnel.test.mjs test/tunnel-real.test.mjs
```

把 .PHONY 那行加:

```makefile
.PHONY: build lint test test-sandbox test-tunnel precommit start install update vendor vendor-clean pack publish clean
```

- [ ] **Step 2: Commit**

```bash
git add Makefile
git commit -m "make: 加 test-tunnel target(opt-in 真 cloudflared)"
```

### Task 6.2: tunnel-real.test.mjs(opt-in)

**Files:**
- Create: `test/tunnel-real.test.mjs`

- [ ] **Step 1: 寫 opt-in e2e**

```javascript
// 真實 cloudflared 整合測試。預設不跑;TUNNEL_REAL=1 才執行。
// 需要本機有 cloudflared binary + 網路連通。
//
// 用 make test-tunnel 跑。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const enabled = process.env.TUNNEL_REAL === "1";
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "..", "dist", "server", "index.js");

test("real cloudflared: spawn server, wait for URL, fetch /login, shutdown", { skip: !enabled }, async () => {
  const port = 4300;
  const agentDir = mkdtempSync(resolve(tmpdir(), "pi-webui-tunnel-real-"));
  const child = spawn(
    "node",
    [SERVER_PATH, "--listen", `127.0.0.1:${port}`, "--tunnel"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_AGENT_DIR: agentDir },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c.toString()));
  child.stderr.on("data", (c) => (stderr += c.toString()));

  try {
    // 等 trycloudflare URL,30s timeout
    const url = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout waiting URL\nstderr:${stderr}`)), 30_000);
      const interval = setInterval(() => {
        const m = stdout.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) {
          clearTimeout(t);
          clearInterval(interval);
          res(m[0]);
        }
      }, 200);
    });

    console.log("tunnel URL:", url);

    // edge 拿 login 頁(server 自動產生密碼,login 頁應該回 200)
    // edge 同步可能需要幾秒,給 retry
    let ok = false;
    for (let i = 0; i < 10 && !ok; i++) {
      const r = await fetch(`${url}/login`).catch(() => null);
      if (r && r.status === 200) {
        ok = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(ok, "edge did not return 200 for /login within 10s");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    rmSync(agentDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 確認預設 `make test` 不會跑這個**

```bash
make test
```

Expected: 既有 + tunnel.test.mjs + server-tunnel.test.mjs 全部 pass;tunnel-real.test.mjs 不被執行(因為 Makefile 的 `test` 是 `node --test test/*.test.mjs`,所以 tunnel-real.test.mjs 會被執行但 `{ skip: !enabled }` 會 skip)。

如果 `node --test test/*.test.mjs` glob 也跑了 tunnel-real,要確認 `{ skip: true }` 起作用。

- [ ] **Step 3: Commit**

```bash
git add test/tunnel-real.test.mjs
git commit -m "test: 加 opt-in 真 cloudflared e2e (TUNNEL_REAL=1 / make test-tunnel)"
```

### Task 6.3: 跑 precommit

**Files:** —

- [ ] **Step 1: 跑 lint + test**

```bash
make precommit
```

Expected: lint 0 errors,所有 test pass。

- [ ] **Step 2: 若有失敗,修並重跑**

- [ ] **Step 3: 跑真 e2e(目標是「實際案例測試」)**

需要 cloudflared 本機已安裝:

```bash
which cloudflared || brew install cloudflared
make test-tunnel
```

Expected: 真實連到 trycloudflare.com,fetch `/login` 回 200。如果失敗看 stderr 的 cloudflared 輸出。

### Task 6.4: README + ROADMAP + CHANGELOG

**Files:**
- Modify: `README.md`
- Modify: `ROADMAP.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: README 加 tunnel 段**

在 README 既有 sandbox 段之後加(具體位置看 README 結構;若沒 sandbox 段就放 password 段之後):

```markdown
## Cloudflare quick tunnel(`--tunnel`)

啟用後 pi-webui 會自動 spawn cloudflared 並 expose `trycloudflare.com` 公開 URL。

```bash
pi-webui --tunnel
```

啟用時自動套用:
- 若未指定 `--password` 自動產生 32 字元亂數,印在 console + 寫
  `<agentDir>/tunnel-password.txt`(mode 600,預設 `~/.pi/agent/`)
- `--trust-proxy` 自動啟用,確保 cookie `Secure` flag 正確(cloudflared 是 reverse proxy)
- cloudflared 必須在 PATH 上(`brew install cloudflared` / `apt` / `cargo`);找不到會
  fail-fast,不會自動安裝

附加旗標:
- `--tunnel-cloudflared <path>` 自訂 cloudflared binary 路徑
- 對應環境變數:`PI_WEBUI_TUNNEL=1`、`PI_WEBUI_CLOUDFLARED`

安全提醒:
- 強烈建議 `--tunnel` 與 `--sandbox` 同用,避免 public URL 直接拿到 host 全權限
- `--listen 0.0.0.0:*` 與 `--tunnel` 同開會在 LAN 與公網雙重暴露,啟動時印 warning
- Quick tunnel URL 每次重啟都會換,不是固定域名
```

- [ ] **Step 2: ROADMAP done 區塊加一行**

`ROADMAP.md` done 區塊末尾追加:

```
[x] `--tunnel` / `PI_WEBUI_TUNNEL` 啟動 cloudflared quick tunnel(trycloudflare.com)
```

- [ ] **Step 3: CHANGELOG 加 2026-05-22 區塊**

`CHANGELOG.md` 最上方追加:

```markdown
## 2026-05-22 (tunnel)

### 新增

- `--tunnel` / `PI_WEBUI_TUNNEL=1` 啟用 cloudflared quick tunnel,自動把 server expose 到 `trycloudflare.com`
  - 由 `src/server/tunnel.ts` 的 `TunnelManager` 封裝 spawn / URL parse / lifecycle
  - 啟動鐵則寫死:`--no-autoupdate --config /dev/null --url <actualUrl>`,徹底繞 `~/.cloudflared/config.yml`
  - cloudflared binary 缺失 fail-fast,印 install 指引(brew / apt / cargo)
  - `--tunnel` 沒帶 `--password` 自動產生 32 字元 base64url 亂數,印 console + 寫 `<agentDir>/tunnel-password.txt`(mode 600)
  - `--tunnel` 自動 imply `--trust-proxy`,確保 cookie `Secure` flag 在 cloudflared edge 後正確
  - `--listen 0.0.0.0:*` / `!sandbox` 與 `--tunnel` 同開時印 stderr warning
  - cloudflared 中途 crash 不自動 restart;30 秒沒拿到 URL 標 error 並 SIGTERM child
  - SIGINT/SIGTERM 走 gracefulShutdown,先 stop tunnel(SIGTERM + 5s SIGKILL fallback)再 close sandbox
- `--tunnel-cloudflared <path>` / `PI_WEBUI_CLOUDFLARED` 自訂 cloudflared binary
- pi extension 端對應旗標:`--webui-tunnel`、`--webui-tunnel-cloudflared`(forward 給 spawn 的 server)
- WebUI status bar 新增 `tunnel` chip;starting=黃 / active=綠 / error=紅 / stopped=灰;active 時點擊複製 URL
- `connected` packet 增加 `tunnel: { enabled, phase, url?, error? }` 欄位;狀態變化透過新 packet `tunnel_state` broadcast

### 測試

- 單元測試 `test/tunnel.test.mjs`:TunnelManager 完整 lifecycle(stub spawn),涵蓋 args 鐵則、URL parse、30s timeout、child crash、stop SIGTERM、5s SIGKILL fallback、idempotent
- 整合測試 `test/server-tunnel.test.mjs`:spawn 真 server + fake cloudflared fixture,驗證 banner / connected payload / WS broadcast / 自動密碼寫檔 / mode 600 / fail-fast / warnings
- 端到端 `test/tunnel-real.test.mjs`(opt-in `TUNNEL_REAL=1`,`make test-tunnel`):spawn server `--tunnel`,等真 cloudflared 報 URL,curl edge `/login` 確認回 200

### 相關 commits

設計文件:`docs/superpowers/specs/2026-05-22-cloudflared-integration-design.md`(對應 `2026-05-21-cloudflared-integration-requirements.md` 事故彙整)
```

- [ ] **Step 4: Commit**

```bash
git add README.md ROADMAP.md CHANGELOG.md
git commit -m "docs: 加 --tunnel 說明、ROADMAP done 與 CHANGELOG 2026-05-22 區塊"
```

### Task 6.5: 實際案例測試(目標達成驗證)

**Files:** —

- [ ] **Step 1: 手動跑真 server 並用手機 / 瀏覽器連 tunnel URL**

```bash
make build
node dist/server/index.js --tunnel --sandbox --listen 127.0.0.1:4096
```

Expected:
- console 印 banner 含 `local`/`tunnel`/`password`/`sandbox` 行
- tunnel URL `https://xxx-yyy-zz.trycloudflare.com` 在 ~10s 內出來
- 拿手機(或另一個瀏覽器分頁,清 cookie)開 tunnel URL → 看到 login 頁
- 輸入 `~/.pi/agent/tunnel-password.txt` 的密碼 → 登入成功 → 看到 webui
- status bar `tunnel` chip 綠色,顯示 hostname
- 點 chip → URL 複製到剪貼簿(瀏覽器 console 看 navigator.clipboard 行為)
- Ctrl-C server → 確認 cloudflared 子 process 也消失(`ps aux | grep cloudflared`)

- [ ] **Step 2: 蒐集 commit hash 範圍寫進 CHANGELOG**

`git log --oneline cf3ef95..HEAD` 拿到 commit 範圍,把 CHANGELOG 「相關 commits」段補上 range(類似既有區塊風格)。

```bash
RANGE=$(git log --oneline ca92a84..HEAD | wc -l | awk '{print $1}')
echo "commits: $RANGE"
```

Edit CHANGELOG 結尾 commits 段(若已 commit,新 commit 補 doc 就好)。

```bash
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 補 commits range"
```

---

## Self-Review 結果

### Spec 覆蓋率

- §架構 / 組件 → Phase 1-5 全部對應
- §CLI Flag / 環境變數 → Task 2.1(server)+ 4.1(extension)
- §安全預設與檢查(binary / password / trust-proxy / 0.0.0.0 / sandbox warning)→ Task 2.2 / 2.3 / 2.4
- §TunnelManager 介面 → Task 1.1-1.6 完整
- §啟動流程 → Task 2.5 / 2.6
- §Banner → Task 2.5(tunnel:url)+ 2.6(password)
- §WS Protocol → Task 2.5(broadcast)+ 3.2 驗證
- §WebUI Status Bar → Task 5.1 / 5.2
- §失敗處理 → Task 1.4 / 1.5 / 1.6 / 2.6 涵蓋
- §鐵則 → Task 1.2(args 寫死 test)+ 1.3(URL parse,不算 declared port)
- §測試策略 → Phase 1 / 3 / 6.2 對應三層
- §實作切割 → 完全對應

### Placeholder scan
- 全 task 都附 exact code 與 exact command
- 沒有 "TODO" / "TBD" / "similar to" / "add error handling" 之類
- Task 5.1 / 5.2 提到「看現況決定」是因為 `public/app.js` / `styles.css` 既有結構需要 grep 確認(實際執行時會 grep);這不算 placeholder,屬於「先讀後改」

### Type consistency
- `TunnelPhase`:Task 1.1 定 5 個 → Task 1.5 加 `"stopping"` → 後續引用一致
- `TunnelState`:`{ phase, url?, error? }` 統一
- `TunnelManagerOptions`:`{ cloudflaredBin, startupTimeoutMs?, stopTimeoutMs?, logger?, spawn? }` 統一
- WS packet:`tunnel_state` payload `{ phase, url?, error? }` 與 `connected.payload.tunnel` `{ enabled, phase, url?, error? }` 區分清楚
- Extension flag `--webui-tunnel-cloudflared` ↔ server `--tunnel-cloudflared` 對應一致

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-22-cloudflared-integration.md`.
