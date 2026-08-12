// issue #9：customer profile 的 active session 由 server process 掌權，瀏覽器
// localStorage 只能是重連提示，不能把 customer 拉回舊對話。staff 則維持明確 resume。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "dist", "server", "index.js");
const PASSWORD = "customer-session-authority-test";
const THINKING_MARKER = "ISSUE9_REPLAY_THINKING_SECRET";

function writeAgentDir(baseUrl = "http://127.0.0.1:1") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-issue9-agent-"));
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({
    providers: {
      probe: {
        baseUrl,
        apiKey: "sk-probe",
        api: "openai-completions",
        models: [{ id: "probe-model", name: "Probe Model", contextWindow: 8000, maxTokens: 512 }],
      },
    },
  }));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  return dir;
}

function startDelayedModel() {
  return new Promise((resolve) => {
    let requestCount = 0;
    let activeRequests = 0;
    let maxActiveRequests = 0;
    let releaseFirst;
    const firstGate = new Promise((release) => { releaseFirst = release; });
    const waiters = [];
    const notify = () => {
      for (const waiter of [...waiters]) {
        if (requestCount >= waiter.count) {
          waiters.splice(waiters.indexOf(waiter), 1);
          clearTimeout(waiter.timer);
          waiter.resolve();
        }
      }
    };
    const server = http.createServer(async (req, res) => {
      requestCount++;
      const current = requestCount;
      activeRequests++;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      req.resume();
      await new Promise((done) => req.on("end", done));
      notify();
      const chunk = (delta, finish_reason = null) => ({
        id: `chatcmpl-issue9-${current}`,
        object: "chat.completion.chunk",
        model: "probe-model",
        choices: [{ index: 0, delta, finish_reason }],
      });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (current === 1) {
        res.write(`data: ${JSON.stringify(chunk({ role: "assistant", reasoning_content: THINKING_MARKER }))}\n\n`);
        await firstGate;
      }
      res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: `answer-${current}` }))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
      res.end("data: [DONE]\n\n");
      activeRequests--;
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}`,
        releaseFirst,
        waitForRequests(count) {
          if (requestCount >= count) return Promise.resolve();
          return new Promise((waitResolve, reject) => {
            const waiter = { count, resolve: waitResolve, timer: null };
            waiters.push(waiter);
            waiter.timer = setTimeout(() => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
              reject(new Error(`model request timeout: expected ${count}, got ${requestCount}`));
            }, 10000);
            waiter.timer.unref();
          });
        },
        stats: () => ({ requestCount, maxActiveRequests }),
      });
    });
  });
}

function writeSession(sessionDir, cwd, { id, timestamp, text }) {
  const file = path.join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
  const entries = [
    { type: "session", version: 3, id, timestamp, cwd },
    {
      type: "message",
      id: `${id}-user`,
      parentId: null,
      timestamp,
      message: { role: "user", content: text, timestamp: Date.parse(timestamp) },
    },
  ];
  fs.writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const time = new Date(timestamp);
  fs.utimesSync(file, time, time);
  return file;
}

function startServer({ cwd, agentDir, profile }) {
  return new Promise((resolve, reject) => {
    const args = [SERVER, "--listen", "127.0.0.1:0"];
    if (profile === "customer") args.push("--profile", "customer", "--allow-unsafe-customer");
    const child = spawn(process.execPath, args, {
      cwd,
      env: {
        ...process.env,
        PI_AGENT_DIR: agentDir,
        PI_WEBUI_PORT: "0",
        PI_WEBUI_PASSWORD: PASSWORD,
        PI_WEBUI_MODEL: "probe/probe-model",
        PI_PROJECT_CWD: cwd,
        LITELLM_BASE_URL: "http://litellm.invalid",
        LITELLM_API_KEY: "test-litellm-key",
        PC2_SERVICE_HOST: "http://pc2.invalid",
        PC2_API_TOKEN: "test-pc2-token",
        PI_WEBUI_BASE_PATH: profile === "customer" ? "/agent" : "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    let timer;
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/url=(http:\/\/127\.0\.0\.1:\d+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, url: match[1] });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (!settled) reject(new Error(`server exited ${code}: ${output.slice(-1000)}`));
    });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`server start timeout: ${output.slice(-1000)}`));
    }, 15000);
    timer.unref();
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    try { child.kill("SIGTERM"); } catch {}
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
    timer.unref();
  });
}

async function login(url) {
  const response = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  return (response.headers.get("set-cookie") || "").split(";")[0];
}

function connectAndReadState(url, cookie, sessionFile, lastSeq = null) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http:/, "ws:") + "/ws", { headers: { cookie } });
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("session_state timeout"));
    }, 10000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "ready", lastSeq, sessionFile }));
    });
    ws.on("message", (data) => {
      const packet = JSON.parse(String(data));
      if (packet.type !== "session_state") return;
      clearTimeout(timer);
      resolve({ ws, state: packet.payload });
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function connectWithoutReady(url, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http:/, "ws:") + "/ws", { headers: { cookie } });
    const packets = [];
    const timer = setTimeout(() => reject(new Error("paused websocket open timeout")), 5000);
    ws.on("message", (data) => packets.push(JSON.parse(String(data))));
    ws.on("open", () => {
      clearTimeout(timer);
      resolve({
        ws,
        packets,
        ready(sessionFile, lastSeq) {
          return new Promise((readyResolve, readyReject) => {
            const readyTimer = setTimeout(() => readyReject(new Error("paused websocket replay timeout")), 5000);
            const onMessage = (data) => {
              const packet = JSON.parse(String(data));
              if (packet.type !== "replay_done") return;
              clearTimeout(readyTimer);
              ws.off("message", onMessage);
              readyResolve();
            };
            ws.on("message", onMessage);
            ws.send(JSON.stringify({ type: "ready", sessionFile, lastSeq }));
          });
        },
      });
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForClose(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    const timer = setTimeout(() => reject(new Error("websocket close timeout")), timeoutMs);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function fixture() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-issue9-project-")));
  const sessionDir = path.join(cwd, ".pi", "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const oldSession = writeSession(sessionDir, cwd, {
    id: "old-customer-session",
    timestamp: "2026-08-11T08:00:00.000Z",
    text: "舊對話",
  });
  const newestSession = writeSession(sessionDir, cwd, {
    id: "new-customer-session",
    timestamp: "2026-08-12T08:00:00.000Z",
    text: "最新對話",
  });
  return { cwd, oldSession, newestSession, agentDir: writeAgentDir() };
}

test("issue #9: customer 的舊指標、新裝置與重連都附著同一個 server active session", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.cwd, { recursive: true, force: true }));
  t.after(() => fs.rmSync(f.agentDir, { recursive: true, force: true }));
  const { child, url } = await startServer({ ...f, profile: "customer" });
  t.after(() => stopServer(child));
  const cookie = await login(url);

  const browserA = await connectAndReadState(url, cookie, null);
  t.after(() => { try { browserA.ws.close(); } catch {} });
  assert.equal(browserA.state.sessionFile, f.newestSession, "新裝置應載入 server 選定的最新 session");

  const browserB = await connectAndReadState(url, cookie, f.oldSession);
  assert.equal(browserB.state.sessionFile, f.newestSession, "舊 localStorage 不得覆蓋 customer authority");
  assert.equal(browserB.state.sessionId, browserA.state.sessionId, "兩個瀏覽器必須共用同一 runtime session");
  browserB.ws.close();

  const reopenedB = await connectAndReadState(url, cookie, f.oldSession, 0);
  t.after(() => { try { reopenedB.ws.close(); } catch {} });
  assert.equal(reopenedB.state.sessionFile, f.newestSession, "關閉再開仍應回到 server active session");
  assert.equal(reopenedB.state.sessionId, browserA.state.sessionId);
});

test("issue #9 對照: staff 仍可用瀏覽器指標明確 resume 舊 session", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.cwd, { recursive: true, force: true }));
  t.after(() => fs.rmSync(f.agentDir, { recursive: true, force: true }));
  const { child, url } = await startServer({ ...f, profile: "staff" });
  t.after(() => stopServer(child));
  const cookie = await login(url);

  const browser = await connectAndReadState(url, cookie, f.oldSession);
  t.after(() => { try { browser.ws.close(); } catch {} });
  assert.equal(browser.state.sessionFile, f.oldSession);
  assert.equal(browser.state.sessionId, "old-customer-session");
});

test("issue #9: active turn 期間第二個 customer prompt 排入同一 runtime，不建立並行分叉", async (t) => {
  const model = await startDelayedModel();
  t.after(() => {
    model.releaseFirst();
    return new Promise((resolve) => model.server.close(resolve));
  });
  const f = fixture();
  fs.rmSync(f.agentDir, { recursive: true, force: true });
  f.agentDir = writeAgentDir(model.url);
  t.after(() => fs.rmSync(f.cwd, { recursive: true, force: true }));
  t.after(() => fs.rmSync(f.agentDir, { recursive: true, force: true }));
  const { child, url } = await startServer({ ...f, profile: "customer" });
  t.after(() => stopServer(child));
  const cookie = await login(url);

  const browserA = await connectAndReadState(url, cookie, null);
  t.after(() => { try { browserA.ws.close(); } catch {} });
  const replayClient = await connectWithoutReady(url, cookie);
  t.after(() => { try { replayClient.ws.close(); } catch {} });
  browserA.ws.send(JSON.stringify({ type: "prompt", message: "first turn" }));
  await model.waitForRequests(1);
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.equal(
    replayClient.packets.some((packet) => packet.type === "session_event" || packet.type === "tool_progress"),
    false,
    "尚未 ready 的 B 不得先收到 shared runtime live event",
  );
  await replayClient.ready(f.newestSession, 0);
  assert.doesNotMatch(JSON.stringify(replayClient.packets), new RegExp(THINKING_MARKER), "replay 不得繞過 customer 過濾");
  assert.equal(
    replayClient.packets.some((packet) => String(packet.payload?.assistantMessageEvent?.type || "").startsWith("thinking")),
    false,
    "replay 不得送出 thinking event",
  );
  const replaySeqs = replayClient.packets
    .filter((packet) => packet.type === "session_event" && typeof packet.seq === "number")
    .map((packet) => packet.seq);
  assert.equal(new Set(replaySeqs).size, replaySeqs.length, "ready 前後不得重複投遞同一 seq");

  const browserB = await connectAndReadState(url, cookie, f.oldSession);
  t.after(() => { try { browserB.ws.close(); } catch {} });
  assert.equal(browserB.state.sessionId, browserA.state.sessionId);
  assert.equal(browserB.state.sessionFile, f.newestSession);
  assert.equal(browserB.state.isStreaming, true, "B 應附著到 A 正在串流的同一 session");

  browserB.ws.send(JSON.stringify({ type: "prompt", message: "queued second turn" }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(model.stats(), { requestCount: 1, maxActiveRequests: 1 }, "第二則 prompt 不得另開並行 turn");

  model.releaseFirst();
  await model.waitForRequests(2);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(model.stats().maxActiveRequests, 1, "兩個瀏覽器的模型請求必須序列化在同一 runtime");
  assert.equal(
    fs.readdirSync(path.dirname(f.newestSession)).filter((name) => name.endsWith(".jsonl")).length,
    2,
    "active turn 期間不得建立第三個分叉 session 檔",
  );
});

test("issue #9: /quit 只關閉發送者，不終止 shared customer runtime 或其他瀏覽器", async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.cwd, { recursive: true, force: true }));
  t.after(() => fs.rmSync(f.agentDir, { recursive: true, force: true }));
  const { child, url } = await startServer({ ...f, profile: "customer" });
  t.after(() => stopServer(child));
  const cookie = await login(url);
  const browserA = await connectAndReadState(url, cookie, null);
  const browserB = await connectAndReadState(url, cookie, null);
  t.after(() => { try { browserA.ws.close(); } catch {} });
  t.after(() => { try { browserB.ws.close(); } catch {} });

  const closed = waitForClose(browserA.ws);
  browserA.ws.send(JSON.stringify({ type: "slash_command", name: "quit", arg: "" }));
  await closed;
  assert.equal(browserB.ws.readyState, WebSocket.OPEN, "B 不應被 A 的 /quit 關閉");
  const response = await fetch(`${url}/login`, { redirect: "manual" });
  assert.notEqual(response.status, 0, "server process 應仍存活");
});
