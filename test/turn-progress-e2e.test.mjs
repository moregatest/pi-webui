// 隔離假模型與暫存工作區，驗證完整 SDK → WebSocket → 重連歷史。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createChatState, applyTurnProgress } from "../public/chat-state.mjs";
import { dispatchSessionEvent } from "../public/session-dispatch.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "dist", "server", "index.js");
const PASSWORD = "e2e-progress-pw";
const THINK_MARKER = "THINKING_SECRET_MARKER";
const N = 5;
const COMMAND = "printf PX_PROGRESS_COMMAND_MARKER";

function writeAgentDir(baseUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webui-e2e-progress-agentdir-"));
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

// 五輪工具含一次前置說明；第六輪純推理以 length 結束，驗證說明不阻止續跑。
function startMock(cwd, succeed = false, guard = false) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const n = requests.length;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${n}`, object: "chat.completion.chunk", model: "probe-model",
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      emit({ role: "assistant", reasoning_content: THINK_MARKER });
      if (n <= N) {
        if (n === 2) emit({content:"先查閱資料再整理結論。"});
        const name = n % 2 ? "bash" : "read";
        const args = name === "bash" ? { command: COMMAND } : { path: path.join(cwd, "fixture.txt") };
        emit({ tool_calls: [{ index: 0, id: `step-${n}`, type: "function",
          function: { name, arguments: JSON.stringify(args) } }] });
        emit({}, "tool_calls");
      } else if (guard && n === N + 1) { emit({content:"已经发布了。"}); emit({}, "length"); }
      else if (succeed && n > N + 1) { emit({content:"整理完成。"}); emit({}, "stop"); }
      else emit({}, "length");
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve({ srv, requests,
      url: `http://127.0.0.1:${srv.address().port}` }));
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
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => { clearTimeout(timer); if (!resolved) reject(new Error(`server exited ${code}: ${buf.slice(-500)}`)); });
    const timer = setTimeout(() => { if (!resolved) { try { child.kill("SIGKILL"); } catch {} reject(new Error(`start timeout: ${buf.slice(-500)}`)); } }, 15000);
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

// 從開線前就收集封包，包含 connected 與重連 bootstrap，避免漏掉敏感欄位。
async function connectReady(url, cookie, sessionFile = null) {
  const ws = new WebSocket(url.replace(/^http:/, "ws:") + "/ws", { headers: { cookie } });
  const packets = [];
  ws.on("message", (d) => packets.push(JSON.parse(String(d))));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("連線逾時")), 10000);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    ws.send(JSON.stringify({ type: "ready", lastSeq: null, sessionFile }));
    await waitFor(() => packets.some((p) => p.type === "message_history"), "初始歷史");
    return { ws, packets };
  } catch (error) {
    ws.terminate();
    throw error;
  }
}

async function waitFor(condition, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`等待逾時：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const history = (packets) => packets.filter((p) => p.type === "message_history").at(-1)?.payload ?? [];
const steps = (packets) => history(packets).flatMap((m) => m.content ?? []).filter((b) => b.type === "step_summary");
const packetName = (p) => p.type === "session_event" ? `${p.type}:${p.payload.type}`
  : p.type === "tool_progress" ? `${p.type}:${p.payload.phase}` : p.type;

for (const {succeed, extension = false, guard = false} of [
  {succeed:false}, {succeed:true}, {succeed:false,extension:true}, {succeed:true,extension:true},
  {succeed:true,guard:true},
]) test(`bf-c8f：${extension ? "預覽擴充" : guard ? "更正指示" : "內建續跑"} ${succeed ? "成功" : "仍截斷"}與重連`, { timeout: 60000 }, async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "webui-e2e-progress-cwd-"));
  fs.writeFileSync(path.join(cwd, "fixture.txt"), "測試資料\n");
  let mock, agentDir, child;
  const connections = [];
  try {
    mock = await startMock(cwd, succeed, guard);
    agentDir = writeAgentDir(mock.url);
    if (extension) {
      fs.mkdirSync(path.join(agentDir, "extensions"));
      // readyAI v0.7.91 封存的 preview_fly/readyai-provider-errors.js，原樣複製。
      // SHA256: 1253d3c8d6a9fecc33134b362c660ef20e2e0c84e04a3f30184ca596947d26b1
      fs.copyFileSync(path.join(REPO,"test/fixtures/readyai-provider-errors.js"), path.join(agentDir,"extensions/readyai-provider-errors.js"));
    }
    const server = await startServer({ cwd, env: {
      PI_AGENT_DIR: agentDir, PI_PROJECT_CWD: cwd, PI_WEBUI_MODEL: "probe/probe-model",
      // 客戶模式啟動必填值全部使用測試假資料，不讀取真實憑證。
      LITELLM_BASE_URL: mock.url, LITELLM_API_KEY: "dummy-progress-key",
      PC2_SERVICE_HOST: mock.url, PC2_API_TOKEN: "dummy-progress-token",
      PI_WEBUI_BASE_PATH: "/webui",
      // customer-open 才提供 read/bash；限暫存工作目錄與固定無副作用指令。
      PI_WEBUI_SKILLS_OPEN: "1",
    } });
    child = server.child;
    const cookie = await login(server.url);
    const live = await connectReady(server.url, cookie);
    connections.push(live.ws);
    const offset = live.packets.length;
    live.ws.send(JSON.stringify({ type: "prompt", message: "請整理測試資料" }));
    await waitFor(() => live.packets.some((p) => p.type === "command_result" && p.payload?.command === "prompt"), "回合完成");
    const packets = live.packets.slice(offset);
    t.diagnostic(`封包 ${packets.length} 個；工具 ${N} 步；續跑${succeed ? "成功" : "仍截斷"}`);
    assert.equal(packets.find((p) => p.type === "command_result" && p.payload?.command === "prompt")?.payload.ok, true);
    assert.ok(JSON.stringify(mock.requests[0].messages).includes("每次呼叫工具前，先用一句話告訴客戶"), "客戶系統提示須實際送入模型");
    assert.equal(mock.requests.length, N + 2, "必須走完工具、截斷與一次續跑");
    const results = mock.requests.at(-1).messages.filter((m) => m.role === "tool");
    assert.equal(results.length, N, "每次工具結果必須送回模型");
    assert.ok(results.every((m) => /PX_PROGRESS_COMMAND_MARKER|測試資料/.test(JSON.stringify(m.content))), "工具必須實際成功執行");
    assert.equal(history(packets).filter((m) => m.role === "assistant").at(-1)?.stopReason, succeed ? "stop" : extension ? "error" : "length");
    assert.ok(packets.some((p) => p.type === "session_event" && p.payload.type === "agent_end"));
    assert.equal(packets.filter((p) => p.type === "tool_progress" && p.payload.phase === "start").length, N);
    assert.equal(packets.filter((p) => p.type === "tool_progress" && p.payload.phase === "end").length, N);
    assert.equal(packets.filter((p) => p.type === "turn_notice").length, guard ? 0 : succeed ? 1 : 2);
    assert.equal(packets.filter((p) => p.type === "server_error").length, 0);
    if (succeed) assert.ok(history(packets).some(m => m.content?.some(b => b.text === "整理完成。")));
    assert.equal(history(packets).filter(m => m.role === "user").length, 1, "自動續跑不產生客戶泡泡");
    const ids = new Set(packets.filter(p => p.type.startsWith("turn_")).map(p => p.payload.turnId));
    assert.equal(ids.size, 1, "階段、步驟及兩次結束應屬同一回合");

    const sessionFile = packets.filter((p) => p.type === "session_state").at(-1)?.payload?.sessionFile;
    assert.ok(sessionFile, "必須取得同一會話路徑才能驗證重連");
    if (extension && !succeed) {
      assert.ok(fs.readFileSync(sessionFile,"utf8").includes("AI_OUTPUT_TRUNCATED"),"確實載入擴充且第二次截斷已改寫持久化訊息");
    }
    live.ws.close();
    const resumed = await connectReady(server.url, cookie, sessionFile);
    connections.push(resumed.ws);
    await waitFor(() => steps(resumed.packets).length === N, "重連同一回合");
    assert.equal(steps(resumed.packets).length, N);
    assert.equal(history(resumed.packets).filter(m => m.role === "user").length, 1, "持久化標記必須在重連後生效");

    await t.test("規格：五個 turn_step start/end 且順序與識別一致", () => {
      for (const phase of ["start", "end"]) {
        const actual = packets.filter((p) => p.type === "turn_step" && p.payload.phase === phase).map((p) => p.payload);
        assert.equal(actual.length, N);
        assert.deepEqual(actual.map((s) => s.stepId), Array.from({ length: N }, (_, i) => `step-${i + 1}`));
        assert.deepEqual(actual.map((s) => s.n), [1, 2, 3, 4, 5]);
      }
    });
    await t.test("規格：一次續跑提示，失敗才補最終提示", () => {
      const notices = packets.filter((p) => p.type === "turn_notice");
      assert.equal(notices.length, guard ? 0 : succeed ? 1 : 2);
      if (guard) return;
      assert.equal(notices[0].payload.retrying, true);
      if (!succeed) assert.equal(notices[1].payload.retrying, undefined);
      assert.equal(notices[0].payload.kind, "truncated");
      assert.ok(notices[0].payload.message?.trim());
    });
    await t.test("規格：所有連線封包不洩漏指令、完整路徑、模型或推理", () => {
      // sessionFile 是既有重連協定的必要欄位；規格明定另案處理。
      const serialized = JSON.stringify([...live.packets, ...resumed.packets], (key, value) => key === "sessionFile" ? undefined : value);
      for (const marker of ["PX_PROGRESS_COMMAND_MARKER", COMMAND, cwd, fs.realpathSync(cwd), agentDir, "probe-model", "Probe Model", THINK_MARKER]) {
        assert.equal(serialized.includes(marker), false, `不應含 ${marker}`);
      }
    });
    await t.test("規格：重連歷史五個 step_summary 保留原順序", () => {
      const summaries = steps(resumed.packets);
      assert.equal(summaries.length, N);
      assert.deepEqual(summaries.map((s) => s.stepId), Array.from({ length: N }, (_, i) => `step-${i + 1}`));
      assert.ok(summaries.every((s) => s.status === "ok"));
    });
    const state = createChatState();
    for (const p of packets) {
      if (p.type.startsWith("turn_")) applyTurnProgress(state,p.type,p.payload);
      if (p.type === "session_event") {
        dispatchSessionEvent(state,p.payload);
        if (p.payload.type === "agent_end" && p.payload.willRetry) {
          assert.equal(state.progress.finished,false,"更正尚未完成不可收合");
          assert.equal(state.isRunning,true);
        }
      }
    }
    assert.equal(state.progress.finished,true);
    assert.equal(state.progress.notice?.retrying,undefined,"完成後不可殘留續跑中提示");
    if (guard) {
      assert.ok(packets.some(p=>p.type === "session_event" && p.payload.type === "agent_end" && p.payload.willRetry));
      assert.ok(JSON.stringify(mock.requests.at(-1)).includes("系統更正指示"));
    }
    if (extension && !succeed) assert.equal(state.progress.notice.kind,"error");
    t.diagnostic(JSON.stringify(packets.filter(p=>p.type === "turn_notice" || (p.type === "session_event" && ["agent_start","agent_end"].includes(p.payload.type))).map(p=>({type:packetName(p),...p.type === "turn_notice" ? {notice:p.payload} : {willRetry:p.payload.willRetry}}))));
    const before = mock.requests.length;
    resumed.ws.send(JSON.stringify({type:"prompt",message:"請根據剛才查到的資料，直接給出結論"}));
    await waitFor(() => resumed.packets.some(p => p.type === "command_result" && p.payload.command === "prompt"), "再次提問完成");
    assert.equal(mock.requests.length - before, succeed ? 1 : 2, "新使用者提問重置續跑額度");
    assert.equal(history(resumed.packets).filter(m => m.role === "user").length, 2, "相同文字的手動提問不能被隱藏");
  } finally {
    for (const ws of connections) ws.terminate();
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(killTimer);
    }
    if (mock) await new Promise((resolve) => mock.srv.close(resolve));
    fs.rmSync(cwd, { recursive: true, force: true });
    if (agentDir) fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
