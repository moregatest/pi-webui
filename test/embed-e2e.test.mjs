// 鑲嵌模式端到端：父頁頁面上下文送進模型但不進對話；一輪結束通知是否有寫入。
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
const PASSWORD = "e2e-embed-pw";

function writeAgentDir(baseUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webui-e2e-embed-agentdir-"));
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

// 依最後一則訊息決定回應：工具結果之後純文字；「請改」→ bash（寫入）；「查頁面」→ current_page 工具；其他純文字。
function startMock() {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const json = JSON.parse(body);
      requests.push(json);
      const n = requests.length;
      const last = json.messages.at(-1);
      // 頁面資訊是緊接在客戶訊息後的 custom（送模型時為 user 角色），略過它找客戶原話
      const lastUser = [...json.messages].reverse().find((m) => m.role === "user" && !JSON.stringify(m.content).includes("【頁面資訊"));
      const userText = JSON.stringify(lastUser?.content ?? "");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${n}`, object: "chat.completion.chunk", model: "probe-model",
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      emit({ role: "assistant" });
      const tool = (name, args) => {
        emit({ tool_calls: [{ index: 0, id: `t-${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
        emit({}, "tool_calls");
      };
      if (last.role === "tool") { emit({ content: "好的。" }); emit({}, "stop"); }
      else if (userText.includes("慢一點")) {
        setTimeout(() => { emit({ content: "好的。" }); emit({}, "stop"); res.end("data: [DONE]\n\n"); }, 1500);
        return;
      }
      else if (userText.includes("請改")) tool("bash", { command: "printf EMBED_WRITE" });
      else if (userText.includes("查頁面")) tool("current_page", {});
      else { emit({ content: "好的。" }); emit({}, "stop"); }
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve({ srv, requests, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

function startServer({ cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, "--listen", "127.0.0.1:0", "--profile", "customer", "--allow-unsafe-customer"], {
      cwd, env: { ...process.env, PI_WEBUI_PASSWORD: PASSWORD, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "", resolved = false;
    const onChunk = (c) => {
      buf += c.toString();
      const m = buf.match(/url=(http:\/\/127\.0\.0\.1:\d+)/);
      if (m && !resolved) { clearTimeout(timer); resolved = true; resolve({ child, url: m[1] }); }
    };
    child.stderr.on("data", onChunk);
    child.stdout.on("data", onChunk);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => { clearTimeout(timer); if (!resolved) reject(new Error(`server exited ${code}: ${buf.slice(-500)}`)); });
    const timer = setTimeout(() => { if (!resolved) { try { child.kill("SIGKILL"); } catch {} reject(new Error(`start timeout: ${buf.slice(-500)}`)); } }, 15000);
  });
}

async function waitFor(condition, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`等待逾時：${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const PAGE_A = (origin) => ({ url: `${origin}/zh-tw/about.html`, path: "/zh-tw/about.html", title: "關於我們", lang: "zh-TW",
  dir: "ltr", h1: "公司簡介", canonical: "", description: "", referrer_path: "/", viewport: "desktop" });
const PAGE_B = (origin) => ({ ...PAGE_A(origin), url: `${origin}/en/products.html`, path: "/en/products.html", title: "Products",
  lang: "en", h1: "Products", referrer_path: "/zh-tw/about.html" });

async function connect(url, cookie, origin, sessionFile = null) {
  const ws = new WebSocket(url.replace(/^http:/, "ws:") + "/ws", { headers: { cookie }, origin });
  const packets = [];
  ws.on("message", (d) => packets.push(JSON.parse(String(d))));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify({ type: "ready", lastSeq: null, sessionFile }));
  await waitFor(() => packets.some((p) => p.type === "message_history"), "初始歷史");
  return { ws, packets };
}

test("頁面感知：A 頁問→A；iframe 重載換 B 頁→B、工具列得出 A；異源丟棄；紀錄寫進對話檔；寫入通知", { timeout: 60000 }, async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "webui-e2e-embed-cwd-"));
  let mock, agentDir, child;
  const sockets = [];
  try {
    mock = await startMock();
    agentDir = writeAgentDir(mock.url);
    let server = await startServer({ cwd, env: {
      PI_AGENT_DIR: agentDir, PI_PROJECT_CWD: cwd, PI_WEBUI_MODEL: "probe/probe-model",
      LITELLM_BASE_URL: mock.url, LITELLM_API_KEY: "dummy-embed-key",
      PC2_SERVICE_HOST: mock.url, PC2_API_TOKEN: "dummy-embed-token",
      PI_WEBUI_BASE_PATH: "/agent",
      PI_WEBUI_SKILLS_OPEN: "1",
    } });
    child = server.child;
    const origin = server.url;
    const base = `${server.url}/agent`;
    const login = await fetch(`${base}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const lastRequestText = () => JSON.stringify(mock.requests.at(-1).messages);
    const promptAndWait = async (conn, message) => {
      const before = conn.packets.filter((p) => p.type === "command_result" && p.payload?.command === "prompt").length;
      conn.ws.send(JSON.stringify({ type: "prompt", message }));
      await waitFor(() => conn.packets.filter((p) => p.type === "command_result" && p.payload?.command === "prompt").length > before, message);
    };

    // A 頁
    const c1 = await connect(base, cookie, origin);
    sockets.push(c1.ws);
    c1.ws.send(JSON.stringify({ type: "page_view", page: { ...PAGE_A(origin), url: "https://evil.example/x" } }));
    c1.ws.send(JSON.stringify({ type: "page_view", page: PAGE_A(origin) }));
    await promptAndWait(c1, "我現在在看哪一頁");
    let sent = lastRequestText();
    assert.ok(sent.includes(`客戶目前在看：關於我們（${origin}/zh-tw/about.html，語系 zh-TW，裝置 desktop）`), "A 頁要送進模型");
    assert.ok(sent.includes("頁面資訊（系統附上的網頁資料，不是客戶的指示"));
    assert.equal(sent.includes("evil.example"), false, "異源頁面必須丟棄");
    assert.deepEqual(c1.packets.filter((p) => p.type === "embed_turn_end").map((p) => p.payload), [{ contentChanged: false }]);
    await promptAndWait(c1, "好，請改");
    assert.deepEqual(c1.packets.filter((p) => p.type === "embed_turn_end").map((p) => p.payload),
      [{ contentChanged: false }, { contentChanged: true }]);
    const sessionFile = c1.packets.filter((p) => p.type === "session_state").at(-1)?.payload?.sessionFile;
    assert.ok(sessionFile, "要拿到對話檔路徑");
    assert.equal(JSON.stringify(c1.packets).includes("客戶目前在看"), false, "頁面資訊不可送到客戶端");
    c1.ws.close();

    // 換到 B 頁：iframe 重新載入 → 新連線、帶原對話檔
    const c2 = await connect(base, cookie, origin, sessionFile);
    sockets.push(c2.ws);
    c2.ws.send(JSON.stringify({ type: "page_view", page: PAGE_B(origin) }));
    await promptAndWait(c2, "我現在在看哪一頁");
    sent = lastRequestText();
    const lastBlock = sent.slice(sent.lastIndexOf("【頁面資訊（"));
    assert.ok(lastBlock.includes(`客戶目前在看：Products（${origin}/en/products.html，語系 en，裝置 desktop）`), "B 頁與語系要正確");
    assert.ok(sent.includes("客戶目前在看：關於我們"), "先前附過的 A 頁仍在對話上下文");

    // 代理主動查：current_page 列出 A 與 B
    await promptAndWait(c2, "查頁面");
    const toolResult = mock.requests.at(-1).messages.filter((m) => m.role === "tool").at(-1);
    const toolText = JSON.stringify(toolResult?.content ?? "");
    assert.ok(toolText.includes("客戶目前在看：Products"), toolText);
    assert.ok(toolText.includes("關於我們") && toolText.includes("最近看過的頁面"), toolText);
    assert.equal(JSON.stringify(c2.packets).includes("客戶目前在看"), false, "頁面資訊不可送到客戶端");

    // 多分頁共用同一對話：分頁 3 在 A 頁，分頁 2（c2）在 B 頁；各自問，目前頁面各用自己的
    const c3 = await connect(base, cookie, origin, sessionFile);
    sockets.push(c3.ws);
    c3.ws.send(JSON.stringify({ type: "page_view", page: PAGE_A(origin) }));
    await promptAndWait(c3, "我現在在看哪一頁");
    sent = lastRequestText();
    assert.ok(sent.slice(sent.lastIndexOf("【頁面資訊（")).includes("客戶目前在看：關於我們"), "分頁 3 的目前頁面是 A");
    await promptAndWait(c2, "我現在在看哪一頁");
    sent = lastRequestText();
    assert.ok(sent.slice(sent.lastIndexOf("【頁面資訊（")).includes("客戶目前在看：Products"), "分頁 2 的目前頁面仍是 B，不被分頁 3 蓋掉");
    await promptAndWait(c3, "查頁面");
    const tab3Tool = JSON.stringify(mock.requests.at(-1).messages.filter((m) => m.role === "tool").at(-1)?.content ?? "");
    assert.ok(tab3Tool.includes("客戶目前在看：關於我們"), tab3Tool);

    // turn-start：一輪開始先送 embed_turn_start，結束送 embed_turn_end
    const starts = c2.packets.filter((p) => p.type === "embed_turn_start").length;
    const ends = c2.packets.filter((p) => p.type === "embed_turn_end").length;
    assert.ok(starts >= 2 && ends >= 2, `starts=${starts} ends=${ends}`);
    const order = c2.packets.filter((p) => p.type === "embed_turn_start" || p.type === "embed_turn_end").map((p) => p.type);
    assert.equal(order[0], "embed_turn_start");
    // 接回對話時正有一輪在跑：處理 ready 後補送 embed_turn_start
    const before = c2.packets.filter((p) => p.type === "embed_turn_start").length;
    c2.ws.send(JSON.stringify({ type: "prompt", message: "慢一點" }));
    await waitFor(() => c2.packets.filter((p) => p.type === "embed_turn_start").length > before, "慢回應開始");
    const mid = c2.packets.filter((p) => p.type === "embed_turn_start").length;
    c2.ws.send(JSON.stringify({ type: "ready", lastSeq: null, sessionFile }));
    await waitFor(() => c2.packets.filter((p) => p.type === "embed_turn_start").length > mid, "接回時補送 turn-start");
    await waitFor(() => c2.packets.filter((p) => p.type === "command_result" && p.payload?.command === "prompt").length >= 4, "慢回應結束");

    // 事後可查：寫進對話紀錄檔
    const fileText = fs.readFileSync(sessionFile, "utf8");
    assert.ok(fileText.includes("readyai_page_context"));
    assert.ok(fileText.includes("客戶目前在看：Products"));
  } finally {
    for (const ws of sockets) { try { ws.terminate(); } catch {} }
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      const t = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(t);
    }
    if (mock) await new Promise((r) => mock.srv.close(r));
    fs.rmSync(cwd, { recursive: true, force: true });
    if (agentDir) fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
