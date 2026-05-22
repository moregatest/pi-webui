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
