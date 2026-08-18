// WS 程式化 e2e 範本：驗證一個「turn 執行中上游失敗」真的走到 stopReason:"error"
// （＝ src/server/index.ts reportFailedTurn() / turn-error 上報鏈的觸發條件）。
//
// 為什麼這樣注入（實測結論，別再走冤枉路）：
// - ❌ 弄壞 LLM API key → pi SDK hasConfiguredAuth() 在 turn 啟動「前」早拋，永遠進不了 turn-error。
// - ❌ 改 LITELLM_BASE_URL / LITELLM_API_KEY → 對 model 路由「不生效」，那只是 secret-scrub 名單。
// - ✅ 真正的注入層：PI_AGENT_DIR/models.json 自訂 provider。apiKey 給格式合法的假值滿足 auth 檢查，
//      baseUrl 指向本機 mock（回錯）或無人監聽的 port（connection refused）。錯誤發生在 turn 執行中，
//      被 pi-ai provider stream catch + pi-agent-core handleRunFailure 吞成 stopReason:"error"。
//
// 三種注入都實測產出 stopReason:"error"（擇一即可當 fixture）：
//   (a) mock 回 HTTP 500 + json     (b) mock 回 4xx + litellm 風格 error json   (c) baseUrl 指 dead port
//
// 用法：node .claude/skills/webui-e2e-testing/turn-error-e2e-example.mjs
// 前置：make build（server 讀 dist/server/index.js）

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const SERVER = path.join(REPO, "dist", "server", "index.js");
const PASSWORD = "e2e-probe-pw";

// ── PI_AGENT_DIR：models.json（注入層）＋ settings.json（關 retry，讓結果決定性）──
// 不關 retry：第一次 agent_end 已是 stopReason:"error"，但預設 exponential backoff(2+4+8s)
// 會在其後把失敗訊息暫時抽離 session.messages 再放回 → 要嘛抓到暫態、要嘛多等 14s+。關掉最乾淨。
function writeAgentDir(baseUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webui-e2e-agentdir-"));
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({
    providers: { probe: {
      baseUrl, apiKey: "sk-probe", api: "openai-completions",
      models: [{ id: "probe-model", name: "Probe Model", contextWindow: 8000, maxTokens: 512 }],
    }},
  }, null, 2));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
    retry: { enabled: false, provider: { maxRetries: 0 } },
  }, null, 2));
  return dir;
}

// ── harness：spawn server → /api/login → WS /ws 握手 → 送 prompt → 等 agent_end ──
// 改編自 test/customer-security-integration.test.mjs。刻意「不帶」--profile customer：
// customer 模式的 ui-profile 會過濾 message_history、且會撞 sandbox / 訊息黑名單閘門。
function startServer(cwd, agentDir, probeFile) {
  const STUB = path.join(path.dirname(new URL(import.meta.url).pathname), "stub-sentry.mjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, "--listen", "127.0.0.1:0"], {
      cwd,
      env: {
        ...process.env, PI_AGENT_DIR: agentDir, PI_WEBUI_PASSWORD: PASSWORD, PI_WEBUI_MODEL: "probe/probe-model",
        // 第二層斷言用：preload stub sentry，reportFailedTurn 的 captureException 會寫探針檔。
        NODE_OPTIONS: `--import ${STUB}`, SENTRY_PROBE_FILE: probeFile,
      },
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

function connectAndReady(url, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http:/, "ws:") + "/ws", { headers: { cookie } });
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("connected timeout")); }, 10000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "ready", lastSeq: null, sessionFile: null })));
    ws.on("message", (d) => {
      const pkt = JSON.parse(String(d));
      if (pkt.type === "connected") { clearTimeout(t); resolve(ws); }
    });
    ws.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

// 送 prompt，收封包到看見 agent_end 後 settle 一下讓 message_history 跟上。
function sendPromptAndWait(ws, message, { timeoutMs = 20000, settleMs = 1200 } = {}) {
  return new Promise((resolve) => {
    const packets = [];
    const hard = setTimeout(() => { ws.off("message", onMsg); resolve(packets); }, timeoutMs);
    let settle = null;
    function onMsg(d) {
      const pkt = JSON.parse(String(d));
      packets.push(pkt);
      if (pkt.type === "session_event" && pkt.payload?.type === "agent_end") {
        if (settle) clearTimeout(settle);
        settle = setTimeout(() => { clearTimeout(hard); ws.off("message", onMsg); resolve(packets); }, settleMs);
      }
    }
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ type: "prompt", message }));
  });
}

// agent_end 後最後一個 message_history 封包，倒找最新 assistant。
function lastAssistant(packets) {
  const hist = packets.filter((p) => p.type === "message_history").at(-1);
  const msgs = Array.isArray(hist?.payload) ? hist.payload : [];
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === "assistant") return msgs[i];
  return null;
}

// ── 一次 turn-error e2e：起 mock(500) → 起 server → 發 turn → 斷言 stopReason:"error" ──
async function main() {
  const mock = http.createServer((req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "mock upstream internal error", type: "server_error" } }));
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${mock.address().port}`;
  // 變體：(b) 改 writeHead(429,...) + budget json；(c) 不起 mock，baseUrl 用 "http://127.0.0.1:1"

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "webui-e2e-cwd-"));
  const agentDir = writeAgentDir(baseUrl);
  const probeFile = path.join(agentDir, "sentry-probe.jsonl");
  const { child, url } = await startServer(cwd, agentDir, probeFile);
  let pass = false;
  try {
    const cookie = await login(url);
    const ws = await connectAndReady(url, cookie);
    const packets = await sendPromptAndWait(ws, "hi");
    const asst = lastAssistant(packets);
    // 第一層（條件）：turn 落在 stopReason:error
    const conditionOk = asst?.stopReason === "error";
    console.log("最新 assistant:", JSON.stringify(
      { stopReason: asst?.stopReason, errorMessage: asst?.errorMessage, content: asst?.content }, null, 2));
    // 第二層（上報動作）：reportFailedTurn 真的呼叫了 captureException（探針檔有記錄）
    const probe = fs.existsSync(probeFile)
      ? fs.readFileSync(probeFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const reported = probe.find((r) => r.tags?.source === "turn-error");
    console.log("上報探針:", JSON.stringify(reported ?? null));
    pass = conditionOk && !!reported;
    console.log(pass
      ? "PASS — turn 走到 stopReason:error 且 captureException 真被呼叫（上報鏈完整）"
      : `FAIL — condition=${conditionOk} reported=${!!reported}（檢查注入層/retry/profile/preload）`);
    try { ws.close(); } catch {}
  } finally {
    try { child?.kill("SIGTERM"); } catch {}
    await new Promise((r) => mock.close(r));
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
