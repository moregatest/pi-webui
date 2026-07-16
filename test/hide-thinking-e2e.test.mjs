// WS 程式化 e2e:§四-1 —— hideThinking 下 thinking 內容不可經 WS 洩漏到瀏覽器。
//
// 注入層(注對層才測得到):PI_AGENT_DIR/models.json 自訂 openai-completions provider,
// baseUrl 指向本機 mock。mock 回一段 SSE:先 reasoning_content(→ SDK emit thinking_delta),
// 再 content(→ text_delta),finish。server 開 PI_WEBUI_HIDE_THINKING=1。
//
// 驗的是單元測不到的真實鏈路:reasoning_content 真的被 SDK 包成 thinking delta/累積進
// assistantMessageEvent.partial,filterEvent 是否把「delta 本體 + partial 挾帶」兩路都堵掉。
// marker "THINKING_SECRET_MARKER" 放在 reasoning 內,斷言它「完全不出現在任何 server→client
// 封包」;同時 final text 要到(turn 成功、非空)。
//
// harness 改編自 .claude/skills/webui-e2e-testing/turn-error-e2e-example.mjs。
// 前置:make build。
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
const PASSWORD = "e2e-hide-pw";
const THINK_MARKER = "THINKING_SECRET_MARKER";
const TEXT_MARKER = "ANSWER_VISIBLE_OK";

function writeAgentDir(baseUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webui-e2e-hide-agentdir-"));
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({
    providers: { probe: {
      baseUrl, apiKey: "sk-probe", api: "openai-completions",
      models: [{ id: "probe-model", name: "Probe Model", contextWindow: 8000, maxTokens: 512 }],
    }},
  }));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
    retry: { enabled: false, provider: { maxRetries: 0 } },
  }));
  return dir;
}

// mock openai-completions:SSE 先吐 reasoning(thinking)再吐 content(text),然後 finish。
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta, finish_reason = null) => ({
        id: "chatcmpl-probe", object: "chat.completion.chunk", model: "probe-model",
        choices: [{ index: 0, delta, finish_reason }],
      });
      // reasoning 分兩段模擬 streaming;marker 在其中
      res.write(`data: ${JSON.stringify(chunk({ role: "assistant", reasoning_content: `${THINK_MARKER} ` }))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({ reasoning_content: "使用者的問題我推理如下" }))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({ content: `${TEXT_MARKER}` }))}\n\n`);
      res.write(`data: ${JSON.stringify(chunk({}, "stop"))}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

function startServer({ cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, "--listen", "127.0.0.1:0"], {
      cwd, env: { ...process.env, PI_WEBUI_PASSWORD: PASSWORD, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "", resolved = false;
    const onChunk = (c) => {
      buf += c.toString();
      const m = buf.match(/url=(http:\/\/127\.0\.0\.1:\d+)/);
      if (m && !resolved) { resolved = true; resolve({ child, url: m[1] }); }
    };
    child.stderr.on("data", onChunk);
    child.stdout.on("data", onChunk);
    child.on("exit", (code) => { if (!resolved) reject(new Error(`server exited ${code}: ${buf.slice(-500)}`)); });
    setTimeout(() => { if (!resolved) { try { child.kill("SIGKILL"); } catch {} reject(new Error(`start timeout: ${buf.slice(-500)}`)); } }, 15000);
  });
}

async function login(url) {
  const res = await fetch(`${url}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`login ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

function connectReady(url, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http:/, "ws:") + "/ws", { headers: { cookie } });
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("connected timeout")); }, 10000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "ready", lastSeq: null, sessionFile: null })));
    ws.on("message", (d) => { if (JSON.parse(String(d)).type === "connected") { clearTimeout(t); resolve(ws); } });
    ws.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

// 送 prompt,蒐集所有 raw 封包字串直到 agent_end 後 settle。
function sendPromptAndCollect(ws, message, { timeoutMs = 20000, settleMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const raw = [];
    const hard = setTimeout(() => { ws.off("message", onMsg); resolve(raw); }, timeoutMs);
    let settle = null;
    function onMsg(d) {
      const s = String(d);
      raw.push(s);
      let pkt; try { pkt = JSON.parse(s); } catch { return; }
      if (pkt.type === "session_event" && pkt.payload?.type === "agent_end") {
        if (settle) clearTimeout(settle);
        settle = setTimeout(() => { clearTimeout(hard); ws.off("message", onMsg); resolve(raw); }, settleMs);
      }
    }
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ type: "prompt", message }));
  });
}

test("§四-1 e2e: hideThinking 下 thinking 內容不經 WS 洩漏(delta + partial 兩路),final text 仍到", async () => {
  const { srv, url: mockUrl } = await startMock();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "webui-e2e-hide-cwd-"));
  const agentDir = writeAgentDir(mockUrl);
  const { child, url } = await startServer({
    cwd,
    env: {
      PI_AGENT_DIR: agentDir, PI_PROJECT_CWD: cwd, PI_WEBUI_MODEL: "probe/probe-model",
      PI_WEBUI_HIDE_THINKING: "1", // §四-1 過濾開關
    },
  });
  try {
    const cookie = await login(url);
    const ws = await connectReady(url, cookie);
    const raw = await sendPromptAndCollect(ws, "hi");
    try { ws.close(); } catch {}

    // 1) marker 完全不出現在任何 server→client 封包(涵蓋 thinking_delta drop + partial 剝除)
    const leaked = raw.filter((s) => s.includes(THINK_MARKER));
    assert.equal(leaked.length, 0,
      `thinking marker 洩漏於 ${leaked.length} 個封包:\n${leaked.map((s) => s.slice(0, 200)).join("\n")}`);

    // 2) 解析後結構檢查:message_update 不得帶 thinking_* delta,content/partial 無 thinking block
    const pkts = raw.map((s) => { try { return JSON.parse(s); } catch { return {}; } });
    let thinkingDelta = 0, thinkingBlock = 0, sawText = false;
    for (const p of pkts) {
      if (p.type !== "session_event" || p.payload?.type !== "message_update") continue;
      const ev = p.payload;
      const ame = ev.assistantMessageEvent;
      if (ame?.type && String(ame.type).startsWith("thinking")) thinkingDelta++;
      const scan = (content) => Array.isArray(content) && content.forEach((b) => {
        if (b?.type === "thinking") thinkingBlock++;
        if (b?.type === "text" && String(b.text || "").includes(TEXT_MARKER)) sawText = true;
      });
      scan(ame?.partial?.content);
      scan(ev.message?.content);
    }
    assert.equal(thinkingDelta, 0, "不應有 thinking_* delta 送到 client");
    assert.equal(thinkingBlock, 0, "partial/content 不應含 thinking block");

    // 3) turn 成功:final assistant text 有到(從 message_history 或 text delta)
    const textArrived = sawText || raw.some((s) => s.includes(TEXT_MARKER));
    assert.ok(textArrived, "final text 應送達 client(turn 成功、非空)");
  } finally {
    try { child?.kill("SIGTERM"); } catch {}
    await new Promise((r) => srv.close(r));
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
