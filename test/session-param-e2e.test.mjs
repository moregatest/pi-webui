// 端到端:?session=<id> 直達 + 反向代理路徑前綴 /c/<instance_id>/(設計 W31-01 §4.4、§4.6)。
//
// 拓撲:測試 → 反向代理(保留路徑前綴,轉 HTTP 與 WebSocket 升級)→ pi-webui
//       (PI_WEBUI_BASE_PATH=/c/inst1、PI_SESSION_DIR=還原目錄、PI_PROJECT_CWD=工作目錄)
// 模型:本機假 OpenAI 相容端點(只回「好的。」並記下收到的 messages),用來驗證續問一輪
//       送進模型的上下文含還原的歷史。
// 前置:make build(server 讀 dist/server/index.js)。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "dist", "server", "index.js");
const PASSWORD = "e2e-session-param-pw";
const BASE = "/c/inst1";
const SID = "019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b";
const TS = "2026-11-20T00:00:00.000Z";

function writeAgentDir(baseUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webui-e2e-sp-agentdir-"));
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

function startMock() {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      requests.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${requests.length}`, object: "chat.completion.chunk", model: "probe-model",
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      emit({ role: "assistant" });
      emit({ content: "好的。" });
      emit({}, "stop");
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () =>
    resolve({ srv, requests, url: `http://127.0.0.1:${srv.address().port}` })));
}

// 最小反向代理:只轉 /c/inst1/ 開頭的請求,路徑原樣保留(與設計的延續閘道相同);
// WebSocket 升級以原始 TCP 管線轉送。
function startProxy(targetPort) {
  const srv = http.createServer((req, res) => {
    if (!req.url.startsWith(`${BASE}/`) && req.url !== BASE) { res.writeHead(404); res.end(); return; }
    const up = http.request({ host: "127.0.0.1", port: targetPort, method: req.method, path: req.url,
      headers: { ...req.headers, "x-forwarded-proto": "http" } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  srv.on("upgrade", (req, socket, head) => {
    if (!req.url.startsWith(`${BASE}/`)) { socket.destroy(); return; }
    const up = net.connect(targetPort, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head?.length) up.write(head);
      up.pipe(socket); socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () =>
    resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

function startServer({ cwd, env, extraArgs = [] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, "--listen", "127.0.0.1:0", ...extraArgs], {
      cwd, env: { ...process.env, PI_WEBUI_PASSWORD: PASSWORD, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "", resolved = false;
    const onChunk = (c) => {
      buf += c.toString();
      const m = buf.match(/url=http:\/\/127\.0\.0\.1:(\d+)/);
      if (m && !resolved) { clearTimeout(timer); resolved = true; resolve({ child, port: Number(m[1]), log: () => buf }); }
    };
    child.stderr.on("data", onChunk);
    child.stdout.on("data", onChunk);
    child.on("exit", (code) => { clearTimeout(timer); if (!resolved) reject(new Error(`server exited ${code}: ${buf.slice(-800)}`)); });
    const timer = setTimeout(() => { if (!resolved) { try { child.kill("SIGKILL"); } catch {} reject(new Error(`start timeout: ${buf.slice(-800)}`)); } }, 15000);
  });
}

async function waitFor(cond, label, ms = 20000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`等待逾時:${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// 合成的「還原後 session」:標頭 cwd 已改寫成工作目錄、parentSession 是非路徑描述;
// 中間夾一行未知型別(有 id)與一行沒有 id 的未知型別,模擬還原程式漏網的行。
function line(o) { return JSON.stringify(o); }
function writeRestoredSession(dir, cwd, id = SID, { headerId = id, extraTail = [] } = {}) {
  const file = path.join(dir, `2026-11-20T00-00-00-000Z_${id}.jsonl`);
  const lines = [
    line({ type: "session", version: 3, id: headerId, timestamp: TS, cwd, parentSession: "preview:site-123/0199aaaa@g3" }),
    line({ type: "message", id: "u1", parentId: null, timestamp: TS, message: { role: "user", content: [{ type: "text", text: "還原問題一" }], timestamp: 1 } }),
    line({ type: "readyai_future_type", id: "x1", parentId: "u1", timestamp: TS, data: "未知型別" }),
    line({ type: "readyai_archive_raw", timestamp: TS, data: "沒有 id 的行" }),
    line({ type: "message", id: "a1", parentId: "u1", timestamp: TS, message: { role: "assistant", content: [{ type: "text", text: "還原答案一" }],
      provider: "probe", model: "probe-model", api: "openai-completions",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: 2 } }),
    ...extraTail,
  ];
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

let env = {};
before(async () => {
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "webui-e2e-sp-work-")));
  const sessDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "webui-e2e-sp-sess-")));
  const startDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "webui-e2e-sp-start-")));
  const mock = await startMock();
  const agentDir = writeAgentDir(mock.url);
  const restored = writeRestoredSession(sessDir, workDir);
  // header id 與檔名 id 不符的檔(不可被直達採用)
  const MISMATCH = "019a1b2c-0000-7000-8000-000000000bad";
  writeRestoredSession(sessDir, workDir, MISMATCH, { headerId: "someone-else" });
  // 另一段合法 session(模擬 localStorage 記住的舊對話)
  const OTHER = "019a1b2c-1111-7111-8111-111111111111";
  const otherFile = writeRestoredSession(sessDir, workDir, OTHER);
  const server = await startServer({ cwd: startDir, env: {
    PI_AGENT_DIR: agentDir, PI_PROJECT_CWD: workDir, PI_SESSION_DIR: sessDir,
    PI_WEBUI_MODEL: "probe/probe-model", PI_WEBUI_BASE_PATH: BASE,
  }, extraArgs: ["--trust-proxy"] });
  const proxy = await startProxy(server.port);
  env = { workDir, sessDir, startDir, mock, agentDir, restored, server, proxy, MISMATCH, OTHER, otherFile };
});

after(async () => {
  try { env.server?.child.kill("SIGTERM"); } catch {}
  try { env.proxy?.srv.close(); } catch {}
  try { env.mock?.srv.close(); } catch {}
  for (const d of [env.workDir, env.sessDir, env.startDir, env.agentDir]) if (d) fs.rmSync(d, { recursive: true, force: true });
});

async function login() {
  const res = await fetch(`${env.proxy.url}${BASE}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get("set-cookie") || "";
  return { setCookie, cookie: setCookie.split(";")[0] };
}

async function connect(cookie, ready) {
  const ws = new WebSocket(`${env.proxy.url.replace(/^http:/, "ws:")}${BASE}/ws`, { headers: { cookie } });
  const packets = [];
  ws.on("message", (d) => packets.push(JSON.parse(String(d))));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify({ type: "ready", lastSeq: null, ...ready }));
  await waitFor(() => packets.some((p) => p.type === "message_history"), "初始歷史");
  await new Promise((r) => setTimeout(r, 200));
  const state = packets.filter((p) => p.type === "session_state").at(-1)?.payload;
  return { ws, packets, state };
}

const historyText = (packets) => JSON.stringify(packets.filter((p) => p.type === "message_history").at(-1));
const warnings = (packets) => packets.filter((p) => p.type === "ext_ui_notify" && p.payload?.type === "warning").map((p) => p.payload.message);

test("代理前綴:未登入帶 ?session= → 302 到 /c/inst1/login,next 保留前綴與參數", async () => {
  const res = await fetch(`${env.proxy.url}${BASE}/?session=${SID}`, { redirect: "manual" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `${BASE}/login?next=${encodeURIComponent(`${BASE}/?session=${SID}`)}`);
});

test("代理前綴:登入 cookie Path=/c/inst1、非 https 不加 Secure;登入後首頁 <base href> 帶前綴", async () => {
  const { setCookie, cookie } = await login();
  assert.match(setCookie, /Path=\/c\/inst1(;|$)/);
  assert.doesNotMatch(setCookie, /Secure/);
  const res = await fetch(`${env.proxy.url}${BASE}/?session=${SID}`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<base href="\/c\/inst1\/">/);
});

test("代理前綴:上傳 PUT /c/inst1/api/upload 成功,檔案落在工作目錄 uploads", async () => {
  const { cookie } = await login();
  const res = await fetch(`${env.proxy.url}${BASE}/api/upload?name=note.txt`, {
    method: "PUT", headers: { cookie, "content-type": "application/octet-stream" }, body: "hello-upload",
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  // 無沙盒時 attachPath 就是宿主路徑:<工作目錄>/uploads/<subdir>/<存檔名>
  assert.ok(json.file.attachPath.startsWith(path.join(env.workDir, "uploads") + path.sep), json.file.attachPath);
  assert.equal(fs.readFileSync(json.file.attachPath, "utf8"), "hello-upload");
  // 未登入上傳 → 401
  const anon = await fetch(`${env.proxy.url}${BASE}/api/upload?name=x.txt`, { method: "PUT", body: "x" });
  assert.equal(anon.status, 401);
});

test("代理前綴:未登入 WebSocket 升級被拒", async () => {
  const ws = new WebSocket(`${env.proxy.url.replace(/^http:/, "ws:")}${BASE}/ws`);
  const err = await new Promise((resolve) => { ws.once("unexpected-response", (_req, res) => resolve(res.statusCode)); ws.once("error", () => resolve("error")); ws.once("open", () => resolve("open")); });
  assert.notEqual(err, "open");
});

test("直達:sessionId 對到還原的 session,歷史帶出;續問一輪送進模型的上下文含還原歷史", async () => {
  const { cookie } = await login();
  // localStorage 指向另一段合法對話,網址參數要優先
  const c = await connect(cookie, { sessionFile: env.otherFile, sessionId: SID });
  try {
    assert.equal(c.state?.sessionId, SID);
    assert.equal(fs.realpathSync(c.state.sessionFile), fs.realpathSync(env.restored));
    assert.equal(fs.realpathSync(c.state.cwd), env.workDir, "cwd 取還原標頭的工作目錄");
    assert.match(historyText(c.packets), /還原問題一/);
    assert.match(historyText(c.packets), /還原答案一/);
    assert.deepEqual(warnings(c.packets), []);

    const before = env.mock.requests.length;
    c.ws.send(JSON.stringify({ type: "prompt", message: "續問一輪" }));
    await waitFor(() => c.packets.some((p) => p.type === "command_result" && p.payload?.command === "prompt"), "續問完成");
    await waitFor(() => env.mock.requests.length > before, "模型收到請求");
    const sent = JSON.stringify(env.mock.requests.at(-1).messages);
    assert.match(sent, /還原問題一/);
    assert.match(sent, /還原答案一/);
    assert.match(sent, /續問一輪/);
    assert.doesNotMatch(sent, /沒有 id 的行|未知型別/, "未知型別的行不進模型上下文");
    // 續問寫回同一個 session 檔,接在 a1 後面
    await waitFor(() => fs.readFileSync(env.restored, "utf8").includes("續問一輪"), "寫回 session 檔");
    // 續問之前 SDK 可能先補寫 model_change 等紀錄,所以沿 parentId 往回走,必須接回還原的 a1
    const entries = fs.readFileSync(env.restored, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
    let cur = entries.find((e) => e.type === "message" && JSON.stringify(e.message.content).includes("續問一輪"));
    const chain = [];
    while (cur) { chain.push(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    assert.ok(chain.includes("a1") && chain.at(-1) === "u1", `父鏈應接回 a1→u1:${chain.join("←")}`);
  } finally { c.ws.close(); }
});

test("直達:不合法 id(路徑穿越等)不切換、提示警告,行為等同沒帶參數", async () => {
  const { cookie } = await login();
  for (const bad of ["../x", "a/b", "..", "a.b", `${SID}/../${SID}`]) {
    const c = await connect(cookie, { sessionFile: null, sessionId: bad });
    try {
      assert.notEqual(c.state?.sessionId, SID, `不可切到還原檔:${bad}`);
      assert.equal(warnings(c.packets).length, 1, `應有一則警告:${bad}`);
    } finally { c.ws.close(); }
  }
});

test("直達:找不到的 id、標頭 id 與檔名不符 → 不切換、提示警告;localStorage 的檔照舊續接", async () => {
  const { cookie } = await login();
  const missing = await connect(cookie, { sessionFile: env.otherFile, sessionId: "019a1b2c-9999-7999-8999-999999999999" });
  try {
    assert.equal(missing.state?.sessionId, env.OTHER, "找不到 id 時退回原有的 localStorage 續接");
    assert.equal(warnings(missing.packets).length, 1);
  } finally { missing.ws.close(); }
  const mismatch = await connect(cookie, { sessionFile: null, sessionId: env.MISMATCH });
  try {
    assert.notEqual(mismatch.state?.sessionId, "someone-else");
    assert.equal(warnings(mismatch.packets).length, 1);
  } finally { mismatch.ws.close(); }
});

test("沒帶 sessionId:行為不變(sessionFile 照舊續接、無警告)", async () => {
  const { cookie } = await login();
  const c = await connect(cookie, { sessionFile: env.otherFile });
  try {
    assert.equal(c.state?.sessionId, env.OTHER);
    assert.deepEqual(warnings(c.packets), []);
  } finally { c.ws.close(); }
});

test("customer 模式:sessionId 一律忽略(客戶 session 權限不變)", async () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "webui-e2e-sp-cust-")));
  const sess = path.join(work, ".pi", "sessions");
  fs.mkdirSync(sess, { recursive: true });
  writeRestoredSession(sess, work);
  const srv = await startServer({ cwd: work, env: {
    PI_AGENT_DIR: env.agentDir, PI_PROJECT_CWD: work, PI_WEBUI_MODEL: "probe/probe-model",
    LITELLM_BASE_URL: env.mock.url, LITELLM_API_KEY: "dummy", PC2_SERVICE_HOST: env.mock.url, PC2_API_TOKEN: "dummy",
    PI_WEBUI_BASE_PATH: "/agent", PI_SESSION_DIR: "",
  }, extraArgs: ["--profile", "customer", "--allow-unsafe-customer"] });
  try {
    const base = `http://127.0.0.1:${srv.port}/agent`;
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const ws = new WebSocket(`${base.replace(/^http:/, "ws:")}/ws`, { headers: { cookie } });
    const packets = [];
    ws.on("message", (d) => packets.push(JSON.parse(String(d))));
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "ready", lastSeq: null, sessionFile: null, sessionId: SID }));
    await waitFor(() => packets.some((p) => p.type === "message_history"), "初始歷史");
    await new Promise((r) => setTimeout(r, 200));
    assert.doesNotMatch(historyText(packets), /還原問題一/, "客戶模式不可經網址參數切到其他 session");
    ws.close();
  } finally {
    try { srv.child.kill("SIGTERM"); } catch {}
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test("直達:最後一行是沒有 id 的未知型別 → 不壞(可續接、無 server_error)", async () => {
  const TAIL = "019a1b2c-2222-7222-8222-222222222222";
  writeRestoredSession(env.sessDir, env.workDir, TAIL, {
    extraTail: [line({ type: "readyai_archive_continued", timestamp: TS })],
  });
  const { cookie } = await login();
  const c = await connect(cookie, { sessionFile: null, sessionId: TAIL });
  try {
    assert.equal(c.state?.sessionId, TAIL);
    assert.deepEqual(c.packets.filter((p) => p.type === "server_error"), []);
    assert.deepEqual(warnings(c.packets), []);
  } finally { c.ws.close(); }
});
