// WS 程式化 e2e:issue #5 —— client 帶 stale/missing session 檔 resume 時,
// cwd 不可掉回 server 的 process.cwd()(啟動目錄),須維持 appCwd(PI_PROJECT_CWD)。
//
// 注入層(不需 model turn,純 WS handshake):讓 server 的 process.cwd()(WORKDIR)
// 與 appCwd(PI_PROJECT_CWD=PROJDIR)刻意不同 —— 舊 code missing 檔 resume 會把
// session cwd fallback 到 WORKDIR;修正後 missing 檔走 bootstrap reset,cwd=PROJDIR。
//
// harness 改編自 .claude/skills/webui-e2e-testing/turn-error-e2e-example.mjs。
// 前置:make build(server 讀 dist/server/index.js)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(REPO, "dist", "server", "index.js");
const PASSWORD = "e2e-resume-pw";

// PI_AGENT_DIR:給 probe model 滿足 model resolve(不跑 turn,baseUrl 無所謂);關 retry。
function writeAgentDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webui-e2e-resume-agentdir-"));
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({
    providers: { probe: {
      baseUrl: "http://127.0.0.1:1", apiKey: "sk-probe", api: "openai-completions",
      models: [{ id: "probe-model", name: "Probe Model", contextWindow: 8000, maxTokens: 512 }],
    }},
  }));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
    retry: { enabled: false, provider: { maxRetries: 0 } },
  }));
  return dir;
}

function startServer({ cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, "--listen", "127.0.0.1:0"], {
      cwd,
      env: { ...process.env, PI_WEBUI_PASSWORD: PASSWORD, ...env },
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

// 送 ready(帶指定 sessionFile),收 bootstrap 封包直到 session_state(或 timeout)。
// 回 { reset, cwd, types }:reset= 是否收到 session_reset;cwd= session_state.payload.cwd。
function readyWithSessionFile(url, cookie, sessionFile) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http:/, "ws:") + "/ws", { headers: { cookie } });
    const types = [];
    let reset = false, cwd = null;
    const hard = setTimeout(() => { try { ws.close(); } catch {} resolve({ reset, cwd, types }); }, 8000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "ready", lastSeq: null, sessionFile })));
    ws.on("message", (d) => {
      const pkt = JSON.parse(String(d));
      types.push(pkt.type);
      if (pkt.type === "session_reset") reset = true;
      if (pkt.type === "session_state") {
        cwd = pkt.payload?.cwd ?? null;
        // session_state 帶 cwd 即可判定;settle 一下讓其餘 bootstrap 封包進來
        setTimeout(() => { clearTimeout(hard); try { ws.close(); } catch {} resolve({ reset, cwd, types }); }, 400);
      }
    });
    ws.on("error", (e) => { clearTimeout(hard); reject(e); });
  });
}

test("issue #5: stale/missing session 檔 → session_reset,cwd 維持 appCwd 不掉回 process.cwd()", async () => {
  // PROJDIR(appCwd)與 WORKDIR(process.cwd())刻意不同,且都先 realpath 消 macOS /tmp symlink。
  const projDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "webui-e2e-proj-")));
  fs.mkdirSync(path.join(projDir, ".pi", "sessions"), { recursive: true });
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "webui-e2e-work-")));
  const agentDir = writeAgentDir();

  const { child, url } = await startServer({
    cwd: workDir,
    env: { PI_AGENT_DIR: agentDir, PI_PROJECT_CWD: projDir, PI_WEBUI_MODEL: "probe/probe-model" },
  });
  try {
    const cookie = await login(url);
    // 路徑落在 PROJDIR 的 session 目錄內、但檔案不存在(＝ localStorage 指向已 rm 的舊 session)。
    const stale = path.join(projDir, ".pi", "sessions", "stale_nonexistent.jsonl");
    const r = await readyWithSessionFile(url, cookie, stale);

    assert.equal(r.reset, true, `missing 檔應觸發 session_reset;實收封包=${r.types.join(",")}`);
    assert.ok(r.cwd, "應收到帶 cwd 的 session_state");
    assert.equal(fs.realpathSync(r.cwd), projDir, "resume cwd 應為 appCwd(PROJDIR)");
    assert.notEqual(fs.realpathSync(r.cwd), workDir, "resume cwd 不可掉回 process.cwd()(WORKDIR)");
  } finally {
    try { child?.kill("SIGTERM"); } catch {}
    fs.rmSync(projDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("issue #5 對照:sessionFile=null(全新連線)cwd 亦為 appCwd(PROJDIR)", async () => {
  const projDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "webui-e2e-proj2-")));
  fs.mkdirSync(path.join(projDir, ".pi", "sessions"), { recursive: true });
  const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "webui-e2e-work2-")));
  const agentDir = writeAgentDir();

  const { child, url } = await startServer({
    cwd: workDir,
    env: { PI_AGENT_DIR: agentDir, PI_PROJECT_CWD: projDir, PI_WEBUI_MODEL: "probe/probe-model" },
  });
  try {
    const cookie = await login(url);
    const r = await readyWithSessionFile(url, cookie, null);
    assert.ok(r.cwd, "應收到帶 cwd 的 session_state");
    assert.equal(fs.realpathSync(r.cwd), projDir, "全新連線 cwd 應為 appCwd(PROJDIR)");
  } finally {
    try { child?.kill("SIGTERM"); } catch {}
    fs.rmSync(projDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
