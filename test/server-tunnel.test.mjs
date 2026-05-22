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

async function waitFor(predicate, timeoutMs, describe) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor timeout: ${describe?.() || ""}`);
}

// startServer 收完整的 spawn args(不含 binary 路徑),caller 自己決定要不要加 --tunnel。
// 預設加 --listen 127.0.0.1:<freePort>。
async function startServer(extraArgs = []) {
  const port = takeFreePort();
  const agentDir = mkdtempSync(resolve(tmpdir(), "pi-webui-tunnel-"));
  const child = spawn(
    "node",
    [
      SERVER_PATH,
      "--listen",
      `127.0.0.1:${port}`,
      ...extraArgs,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_AGENT_DIR: agentDir },
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

  // 等 server 印 listening(structured log 走 stdout,warn/error 走 stderr)
  await waitFor(
    () => stderr.includes("listening") || stdout.includes("listening"),
    5000,
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

test("server --tunnel: tunnel chip / connected payload / WS broadcast / shutdown", async () => {
  const srv = await startServer(["--tunnel", "--tunnel-cloudflared", FAKE_CLOUDFLARED]);
  try {
    // 等 fake cloudflared 印 URL 到 server stdout
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

    // 用 cookie auth 登入後連 WS
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

    // 等 tunnel_state phase=active。
    // 若 fake cloudflared 跑得夠快,server 在 WS open 前就 emit "state" 事件;
    // 此時 connected payload 已帶 phase=active,之後不會再廣播 tunnel_state。
    // 因此先檢查 connected payload,再看是否有額外的 tunnel_state packet。
    await waitFor(
      () =>
        (packets.find((p) => p.type === "connected")?.payload?.tunnel?.phase === "active") ||
        packets.some((p) => p.type === "tunnel_state" && p.payload.phase === "active"),
      3000,
      () => `no tunnel active in ${JSON.stringify(packets)}`,
    );
    // 優先從最新的 tunnel_state 取 URL,回退到 connected payload
    const tunnelStateActive = [...packets]
      .reverse()
      .find((p) => p.type === "tunnel_state" && p.payload.phase === "active");
    const activeUrl = tunnelStateActive
      ? tunnelStateActive.payload.url
      : packets.find((p) => p.type === "connected")?.payload?.tunnel?.url;
    assert.equal(activeUrl, "https://fake-test-id.trycloudflare.com");

    ws.close();
  } finally {
    await srv.cleanup();
  }
});

test("server --tunnel + --listen 0.0.0.0: 印 LAN 警告", async () => {
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
  let stdout = "";
  child.stdout.on("data", (c) => {
    stdout += c.toString();
  });
  try {
    await waitFor(
      () => stderr.includes("listening") || stdout.includes("listening"),
      5000,
      () => `stderr=${stderr} stdout=${stdout}`,
    );
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
