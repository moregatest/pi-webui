// test/customer-security-integration.test.mjs
// Layer 2 安全閘實際 WS 流量整合測試：
// 驗證 customer 模式下的 WS message 黑名單封鎖、payload scrub 與未認證拒絕。
// 自含（不引用 test/helpers/）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "dist", "server", "index.js");

// OPENROUTER_API_KEY 哨兵值：用於偵測 key 是否洩漏給 client
const SENTINEL_API_KEY = "SENTINEL_LEAK_CANARY_abc123";
const CUSTOMER_PW = "customer-sec-test-pw";

// 建立暫時工作目錄
function makeTmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-customer-sec-"));
}

// 啟動 --profile customer server，等到 url= 出現後 resolve
function startServer(cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      // --allow-unsafe-customer：CI 無 QEMU，customer profile 的 effective-sandbox 要求
      // （L2, spec 2026-07-01）需顯式表態繞過，才能在無 VM 環境測 WS 閘門本身。
      [SERVER, "--listen", "127.0.0.1:0", "--profile", "customer", "--allow-unsafe-customer"],
      {
        cwd,
        env: {
          ...process.env,
          PI_WEBUI_PORT: "0",
          PI_WEBUI_PASSWORD: CUSTOMER_PW,
          PI_WEBUI_MODEL: "dummy-model",
          OPENROUTER_API_KEY: SENTINEL_API_KEY,
          PC2_SERVICE_HOST: "http://localhost:9999",
          PC2_API_TOKEN: "dummy-token",
          PI_WEBUI_BASE_PATH: "/webui",
          PI_PROJECT_CWD: cwd,
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let buf = "";
    let resolved = false;
    const onChunk = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/url=(http:\/\/127\.0\.0\.1:\d+)/);
      if (m && !resolved) {
        resolved = true;
        resolve({ child, url: m[1] });
      }
    };
    child.stderr.on("data", onChunk);
    child.stdout.on("data", onChunk);
    child.on("exit", (code) => {
      if (!resolved) reject(new Error(`server exited code=${code}: ${buf.slice(-500)}`));
    });
    setTimeout(() => {
      if (!resolved) {
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error(`server start timeout:\n${buf.slice(-500)}`));
      }
    }, 15000);
  });
}

function stopServer(child) {
  return new Promise((res) => {
    if (!child || child.exitCode !== null) return res();
    child.once("exit", () => res());
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
  });
}

// POST /api/login → cookie 字串（"pi_webui_auth=..."）
async function login(url) {
  const res = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: CUSTOMER_PW }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

// 開 WS（帶 cookie），送 ready 握手，等到 connected packet 後回傳 {ws, connectedPayload}。
// ws 仍保持 OPEN，供後續測試繼續送訊息。
function connectAndReady(url, cookie) {
  return new Promise((resolve, reject) => {
    const wsUrl = url.replace(/^http:/, "ws:") + "/ws";
    const ws = new WebSocket(wsUrl, { headers: { cookie } });
    const collected = [];
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`connected packet timeout; received: ${JSON.stringify(collected)}`));
    }, 10000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "ready", lastSeq: null, sessionFile: null }));
    });
    ws.on("message", (data) => {
      try {
        const pkt = JSON.parse(String(data));
        collected.push(pkt);
        if (pkt.type === "connected") {
          clearTimeout(timer);
          resolve({ ws, connectedPayload: pkt.payload });
        }
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
    ws.on("close", () => {
      // connected 已在 resolve 前回傳；close 在 reject 後無影響
    });
  });
}

// 送一個訊息並等待第一個非 connected / session_event / session_state / session_reset
// / replay_done / message_history / sessions 的「回應包」（error 或 command_result）。
// 最多等 timeout ms。回傳收到的 packet（含所有中間包以供洩漏掃描）。
function sendAndCollect(ws, message, { timeout = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const packets = [];
    const timer = setTimeout(() => {
      resolve({ packets, response: null });
    }, timeout);

    const onMsg = (data) => {
      const pkt = JSON.parse(String(data));
      packets.push(pkt);
      // 閘門回的 error packet 或 command_result 是終態
      if (pkt.type === "error" || pkt.type === "command_result") {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve({ packets, response: pkt });
      }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify(message));
  });
}

// ─── 測試 1：WS bash 封鎖且 sentinel key 不洩漏 ───────────────────────────

test("客戶模式：bash 訊息被閘門拒絕，API key 不洩漏", async (t) => {
  const cwd = makeTmpCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { child, url } = await startServer(cwd);
  t.after(() => stopServer(child));

  const cookie = await login(url);
  const { ws, connectedPayload } = await connectAndReady(url, cookie);
  t.after(() => { try { ws.close(); } catch {} });

  // connected payload 本身不應含 sentinel（scrub 測試在 test 5，這裡只是先確認）
  const connectedStr = JSON.stringify(connectedPayload);
  assert.ok(
    !connectedStr.includes(SENTINEL_API_KEY),
    `connected payload 不應含 sentinel key，但收到：${connectedStr.slice(0, 500)}`,
  );

  // 送 bash 訊息（真實 inbound shape：type="bash", command=<指令>）
  const { packets, response } = await sendAndCollect(ws, {
    type: "bash",
    command: "printenv",
  });

  // 閘門必須回 {type:"error", message:"operation not permitted"}
  assert.ok(response, `閘門未回應任何 packet，收到：${JSON.stringify(packets)}`);
  assert.equal(response.type, "error", `expected error, got ${response.type}`);
  assert.equal(response.message, "operation not permitted");

  // 確認所有收到的 WS 訊息中沒有 sentinel key
  const allStr = JSON.stringify(packets);
  assert.ok(
    !allStr.includes(SENTINEL_API_KEY),
    `WS 訊息中出現了 sentinel API key（洩漏！）：${allStr.slice(0, 500)}`,
  );
});

// ─── 測試 2：WS slash_command login / model 封鎖 ─────────────────────────

test("客戶模式：slash_command login 與 model 被閘門拒絕", async (t) => {
  const cwd = makeTmpCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { child, url } = await startServer(cwd);
  t.after(() => stopServer(child));

  const cookie = await login(url);
  const { ws } = await connectAndReady(url, cookie);
  t.after(() => { try { ws.close(); } catch {} });

  // slash_command login
  {
    const { response } = await sendAndCollect(ws, {
      type: "slash_command",
      name: "login",
      arg: "openrouter fake-key",
    });
    assert.ok(response, "閘門未回應 login slash");
    assert.equal(response.type, "error", `expected error for /login, got ${response.type}`);
    assert.equal(response.message, "operation not permitted");
  }

  // slash_command model
  {
    const { response } = await sendAndCollect(ws, {
      type: "slash_command",
      name: "model",
      arg: "",
    });
    assert.ok(response, "閘門未回應 model slash");
    assert.equal(response.type, "error", `expected error for /model, got ${response.type}`);
    assert.equal(response.message, "operation not permitted");
  }
});

// ─── 測試 3：WS list_dir 封鎖 ────────────────────────────────────────────

test("客戶模式：list_dir 訊息被閘門拒絕", async (t) => {
  const cwd = makeTmpCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { child, url } = await startServer(cwd);
  t.after(() => stopServer(child));

  const cookie = await login(url);
  const { ws } = await connectAndReady(url, cookie);
  t.after(() => { try { ws.close(); } catch {} });

  // list_dir 真實 inbound shape：type="list_dir", path=<路徑>
  const { response } = await sendAndCollect(ws, {
    type: "list_dir",
    path: "/",
  });

  assert.ok(response, "閘門未回應 list_dir 訊息");
  assert.equal(response.type, "error", `expected error for list_dir, got ${response.type}`);
  assert.equal(response.message, "operation not permitted");
});

// ─── 測試 4：未帶 cookie 的 WS upgrade → 401 拒絕 ────────────────────────

test("客戶模式：未登入 WS upgrade 被拒（401）", async (t) => {
  const cwd = makeTmpCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { child, url } = await startServer(cwd);
  t.after(() => stopServer(child));

  const wsUrl = url.replace(/^http:/, "ws:") + "/ws";
  const ws = new WebSocket(wsUrl); // 不帶 cookie

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WS timeout")), 6000);
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      assert.equal(res.statusCode, 401, `expected 401, got ${res.statusCode}`);
      resolve();
    });
    ws.on("error", () => {
      // upgrade 被 server destroy 時 node ws 會 emit error；搭配 close 一起算成功
    });
    ws.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.on("open", () => {
      clearTimeout(timer);
      reject(new Error("WS 不應成功開啟"));
    });
  });
});

// 等待 WS 連線後的 sessions packet（在 connected 之前或之後都可能出現）
function waitForSessions(url, cookie) {
  return new Promise((resolve, reject) => {
    const wsUrl = url.replace(/^http:/, "ws:") + "/ws";
    const ws = new WebSocket(wsUrl, { headers: { cookie } });
    let connected = false;
    let sessionsPayload = null;
    const packets = [];
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`sessions packet timeout; received types: ${packets.map(p => p.type).join(",")}`));
    }, 12000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "ready", lastSeq: null, sessionFile: null }));
    });
    ws.on("message", (data) => {
      const pkt = JSON.parse(String(data));
      packets.push(pkt);
      if (pkt.type === "sessions") sessionsPayload = pkt.payload;
      if (pkt.type === "connected") connected = true;
      if (connected && sessionsPayload !== null) {
        clearTimeout(timer);
        ws.close();
        resolve(sessionsPayload);
      }
    });
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

// ─── 測試 Fix1：session / resume / fork / clone / tree slash 封鎖 ─────────

test("客戶模式：slash_command session/resume/fork/clone/tree 被閘門拒絕", async (t) => {
  const cwd = makeTmpCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { child, url } = await startServer(cwd);
  t.after(() => stopServer(child));

  const cookie = await login(url);
  const { ws } = await connectAndReady(url, cookie);
  t.after(() => { try { ws.close(); } catch {} });

  for (const name of ["session", "resume", "fork", "clone", "tree"]) {
    const { response } = await sendAndCollect(ws, {
      type: "slash_command",
      name,
      arg: "",
    });
    assert.ok(response, `閘門未回應 /${name} slash`);
    assert.equal(response.type, "error", `expected error for /${name}, got ${response.type}`);
    assert.equal(response.message, "operation not permitted", `/${name} 應回 operation not permitted`);
  }
});

// ─── 測試 Fix2：sendSessions 不含 path / cwd ──────────────────────────────

// 建立 mock session jsonl 讓 SessionManager.list 能列出非空清單
function createMockSession(cwd) {
  const sessionDir = path.join(cwd, ".pi", "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const id = "test-session-abc123";
  const filename = `20260101T000000_${id}.jsonl`;
  const header = JSON.stringify({
    type: "session",
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd,
    version: "1",
  });
  const entry = JSON.stringify({
    type: "message",
    id: "msg1",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  });
  fs.writeFileSync(path.join(sessionDir, filename), `${header}\n${entry}\n`);
}

test("客戶模式：sessions packet 每個 entry 不含 path 與 cwd", async (t) => {
  const cwd = makeTmpCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  // 預先建立 mock session，確保 currentProject 不是空陣列
  createMockSession(cwd);
  const { child, url } = await startServer(cwd);
  t.after(() => stopServer(child));

  const cookie = await login(url);
  const sessionsPayload = await waitForSessions(url, cookie);

  assert.ok(sessionsPayload, "未收到 sessions packet");
  const allEntries = [
    ...(sessionsPayload.currentProject ?? []),
    ...(sessionsPayload.allProjects ?? []),
  ];
  // mock session 要能被列到，確保測試真的有驗到東西
  assert.ok(allEntries.length > 0, `currentProject 應有至少 1 個 session entry（mock 已建立），但拿到 ${allEntries.length} 個`);
  for (const entry of allEntries) {
    assert.equal(entry.path, undefined, `session entry 不應含 path：${JSON.stringify(entry)}`);
    assert.equal(entry.cwd, undefined, `session entry 不應含 cwd：${JSON.stringify(entry)}`);
  }
});

// ─── 測試 Fix3：upload 回應不含 hostPath ──────────────────────────────────

test("客戶模式：upload 回應不含 hostPath 欄位", async (t) => {
  const cwd = makeTmpCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { child, url } = await startServer(cwd);
  t.after(() => stopServer(child));

  const cookie = await login(url);

  // 上傳一個最小 PNG（1x1 pixel）
  const minimalPng = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
    "2e00000000c4944415478016360f8cf0000000200015e221bc30000000049454e44ae426082",
    "hex",
  );
  const res = await fetch(`${url}/api/upload?name=test.png`, {
    method: "PUT",
    headers: {
      Cookie: cookie,
      "Content-Type": "image/png",
      "Content-Length": String(minimalPng.length),
    },
    body: minimalPng,
  });
  assert.equal(res.status, 200, `upload 應回 200，實際：${res.status}`);
  const body = await res.json();
  assert.ok(body.ok, `upload 應成功：${JSON.stringify(body)}`);
  assert.ok(body.file, "upload 回應應有 file 欄位");
  assert.equal(body.file.hostPath, undefined, `upload file 不應含 hostPath，但收到：${JSON.stringify(body.file)}`);
  // 保留 attachPath / storedName / originalName / size
  assert.ok(body.file.attachPath !== undefined, "upload file 應保留 attachPath");
  assert.ok(body.file.storedName !== undefined, "upload file 應保留 storedName");
});

// ─── 測試 5：connected payload 已 scrub 敏感欄位 ─────────────────────────

test("客戶模式：connected payload scrub（model/agentDir/sessionDir/homeDir/cwd/activeTools/models/scopedModels 不出現）", async (t) => {
  const cwd = makeTmpCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { child, url } = await startServer(cwd);
  t.after(() => stopServer(child));

  const cookie = await login(url);
  const { ws, connectedPayload } = await connectAndReady(url, cookie);
  t.after(() => { try { ws.close(); } catch {} });

  // SCRUB_KEYS = ["model","agentDir","sessionDir","homeDir","cwd","activeTools","models","scopedModels"]
  const SCRUB_KEYS = ["model", "agentDir", "sessionDir", "homeDir", "cwd", "activeTools", "models", "scopedModels"];

  for (const key of SCRUB_KEYS) {
    assert.ok(
      !(key in connectedPayload),
      `connected payload 不應含被 scrub 的欄位：${key}（payload keys: ${Object.keys(connectedPayload).join(", ")}）`,
    );
  }

  // 也確認 sentinel key 未洩漏
  assert.ok(
    !JSON.stringify(connectedPayload).includes(SENTINEL_API_KEY),
    "connected payload 不應含 sentinel API key",
  );
});
