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
