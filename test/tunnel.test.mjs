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

test("TunnelManager.start: spawn cloudflared 用寫死的 args(鐵則)", async () => {
  const { spawn, calls } = makeFakeSpawn();
  // startupTimeoutMs=1 讓 timer 快速結束;掛 error listener 避免 unhandled
  const mgr = new TunnelManager({ cloudflaredBin: "cloudflared", spawn, startupTimeoutMs: 1 });
  mgr.on("error", () => {});

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
  // 等 timer 過期,避免 timer 洩漏到 test harness
  await new Promise((r) => setTimeout(r, 10));
});

test("TunnelManager.start: 自訂 binary 路徑會傳給 spawn", async () => {
  const { spawn, calls } = makeFakeSpawn();
  const mgr = new TunnelManager({ cloudflaredBin: "/opt/bin/cloudflared", spawn, startupTimeoutMs: 1 });
  mgr.on("error", () => {});
  mgr.start("http://127.0.0.1:4096");
  assert.equal(calls[0].cmd, "/opt/bin/cloudflared");
  await new Promise((r) => setTimeout(r, 10));
});

test("TunnelManager.start: 重複 start 不會再 spawn", async () => {
  const { spawn, calls } = makeFakeSpawn();
  const mgr = new TunnelManager({ cloudflaredBin: "cloudflared", spawn, startupTimeoutMs: 1 });
  mgr.on("error", () => {});
  mgr.start("http://127.0.0.1:4096");
  mgr.start("http://127.0.0.1:4096");
  assert.equal(calls.length, 1);
  await new Promise((r) => setTimeout(r, 10));
});

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
  // URL 拿到後 startupTimer 已被 clearTimeout,不需要額外清理
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
  // URL 拿到後 startupTimer 已被 clearTimeout
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
