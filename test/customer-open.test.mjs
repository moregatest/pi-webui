// test/customer-open.test.mjs
// Task 3: isCustomerOpenMode 單元測試
// Task 4: customer-open 整合測試（PI_WEBUI_SKILLS_OPEN=1 放寬技能鎖）

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import { WebSocket } from "ws";
import { isCustomerOpenMode } from "../dist/server/customer-policy.js";
import { resolveCustomerInjection, shouldInjectHostGuards } from "../dist/server/customer-injection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "dist", "server", "index.js");
const SKILLS_DIR = path.join(__dirname, "fixtures", "skills");

const CUSTOMER_PW = "customer-open-test-pw";

function makeTmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-customer-open-"));
}

function startServer(cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      // --allow-unsafe-customer：CI 無 QEMU，customer profile 的 effective-sandbox 要求
      // （L2, spec 2026-07-01）需顯式表態繞過，才能在無 VM 環境測 customer-open 注入/技能可達性。
      [SERVER, "--listen", "127.0.0.1:0", "--profile", "customer", "--allow-unsafe-customer"],
      {
        cwd,
        env: {
          ...process.env,
          PI_WEBUI_PORT: "0",
          PI_WEBUI_PASSWORD: CUSTOMER_PW,
          PI_WEBUI_MODEL: "dummy-model",
          LITELLM_BASE_URL: "http://litellm.test.internal:4001",
          LITELLM_API_KEY: "dummy-litellm-virtual-key",
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

async function login(url) {
  const res = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: CUSTOMER_PW }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

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
    ws.on("close", () => {});
  });
}

function sendAndCollect(ws, message, { timeout = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    const packets = [];
    const timer = setTimeout(() => {
      resolve({ packets, response: null });
    }, timeout);

    const onMsg = (data) => {
      const pkt = JSON.parse(String(data));
      packets.push(pkt);
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

// ─── Task 3：單元測試 ────────────────────────────────────────────────────────

test("open: customer + SKILLS_OPEN=1 → true", () => {
  assert.equal(isCustomerOpenMode("customer", { PI_WEBUI_SKILLS_OPEN: "1" }), true);
});
test("open: customer 無 flag → false（維持鎖死）", () => {
  assert.equal(isCustomerOpenMode("customer", {}), false);
});
test("open: 非 customer → false", () => {
  assert.equal(isCustomerOpenMode("staff", { PI_WEBUI_SKILLS_OPEN: "1" }), false);
});

// ─── Task 4 單元測：resolveCustomerInjection 純函式（注入邏輯寫反必紅）────────

test("injection: staff → 全放行", () => {
  const r = resolveCustomerInjection({ isCustomer: false, customerOpen: false });
  assert.equal(r.noSkills, false);
  assert.equal(r.noExtensions, false);
  assert.equal(r.noTools, undefined);
  assert.equal(r.tools, undefined);
  assert.equal(r.customTools, undefined);
});

test("injection: plain customer → A1 鎖死", () => {
  const r = resolveCustomerInjection({ isCustomer: true, customerOpen: false });
  assert.equal(r.noExtensions, true);
  assert.equal(r.noSkills, true);
  assert.equal(r.noTools, "builtin");
  assert.deepEqual(r.tools, ["upload_image"]);
  assert.ok(r.customTools != null);
});

test("injection: customer-open → 放寬 + read/bash", () => {
  const r = resolveCustomerInjection({ isCustomer: true, customerOpen: true });
  assert.equal(r.noExtensions, false);
  assert.equal(r.noSkills, false);
  assert.equal(r.noTools, undefined);
  assert.deepEqual(r.tools, ["read", "bash"]);
  assert.equal(r.customTools, undefined);
});

// shouldInjectHostGuards：無 effective sandbox 時是否套 in-process L0/L1/L3（guarded host read/bash）
test("hostGuards: 開發者無 sandbox → 套（true）", () => {
  assert.equal(shouldInjectHostGuards({ hasSandboxTools: false, isCustomer: false, customerOpen: false }), true);
});
test("hostGuards: 有 effective sandbox → 不套（走 VM 版）", () => {
  assert.equal(shouldInjectHostGuards({ hasSandboxTools: true, isCustomer: false, customerOpen: false }), false);
  assert.equal(shouldInjectHostGuards({ hasSandboxTools: true, isCustomer: true, customerOpen: true }), false);
});
test("hostGuards: customer-open 無 sandbox（Fly/allow-unsafe）→ 套（true，修正點）", () => {
  assert.equal(shouldInjectHostGuards({ hasSandboxTools: false, isCustomer: true, customerOpen: true }), true);
});
test("hostGuards: plain customer（僅 upload_image）→ 不套（false）", () => {
  assert.equal(shouldInjectHostGuards({ hasSandboxTools: false, isCustomer: true, customerOpen: false }), false);
});

// ─── Task 4：整合測試（customer-open 模式技能可達性）────────────────────────
// 注意：activeTools 被 SCRUB_KEYS 刮除，無法從 WS 直接斷言工具清單。
// 改採「非黑名單 slash 不被當未授權擋」驗證 open 路徑是否生效。

test("customer-open: 非黑名單 slash 不被當未授權擋", async (t) => {
  const cwd = makeTmpCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { child, url } = await startServer(cwd, {
    PI_WEBUI_SKILLS_OPEN: "1",
    PI_WEBUI_SKILLS: SKILLS_DIR,
  });
  t.after(() => stopServer(child));

  const cookie = await login(url);
  const { ws } = await connectAndReady(url, cookie);
  t.after(() => { try { ws.close(); } catch {} });

  // "hello" 不在 BLOCKED_SLASH，open 模式下不應回 "operation not permitted"
  const { response } = await sendAndCollect(ws, {
    type: "slash_command",
    name: "hello",
  });
  // 若收到 error + "operation not permitted" → 說明 open 路徑未生效（仍走鎖死模式）
  // open 模式下應回 command_result 或 null（技能執行中 timeout），或其他非 permission error
  if (response?.type === "error") {
    assert.notEqual(
      response.message,
      "operation not permitted",
      `customer-open 模式下 /hello 不應被閘門擋，但收到：${JSON.stringify(response)}`,
    );
  }
  // response 為 null（timeout）或 command_result 均視為通過（技能已進入執行流程）
});

// ─── P0 防呆整合測試：customer-open 無 skill-allow → 啟動印警告 ───────────────

test("customer-open 無 skill-allow：createRuntime 啟動印出 P0 收斂警告", async (t) => {
  const cwd = makeTmpCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { child, url } = await startServer(cwd, {
    PI_WEBUI_SKILLS_OPEN: "1",
    PI_WEBUI_SKILLS: SKILLS_DIR,
    // 故意不設 PI_WEBUI_SKILL_ALLOW
  });
  t.after(() => stopServer(child));

  // server 已 listening；後續 createRuntime 在 WS 連線時跑，警告隨之印出。
  let stderrTail = "";
  child.stderr.on("data", (c) => { stderrTail += c.toString(); });

  const cookie = await login(url);
  const { ws } = await connectAndReady(url, cookie);
  t.after(() => { try { ws.close(); } catch {} });

  await new Promise((r) => setTimeout(r, 800)); // 等 log flush
  assert.match(
    stderrTail,
    /customer-open skill guard|技能未收斂/,
    `應在啟動 log 出現 P0 收斂警告，但 stderr 尾段:\n${stderrTail.slice(-800)}`,
  );
});

test("customer-open 有設 skill-allow：不印 P0 警告", async (t) => {
  const cwd = makeTmpCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { child, url } = await startServer(cwd, {
    PI_WEBUI_SKILLS_OPEN: "1",
    PI_WEBUI_SKILLS: SKILLS_DIR,
    PI_WEBUI_SKILL_ALLOW: "customer-pgc-dialogue",
  });
  t.after(() => stopServer(child));

  let stderrTail = "";
  child.stderr.on("data", (c) => { stderrTail += c.toString(); });

  const cookie = await login(url);
  const { ws } = await connectAndReady(url, cookie);
  t.after(() => { try { ws.close(); } catch {} });

  await new Promise((r) => setTimeout(r, 800));
  assert.doesNotMatch(
    stderrTail,
    /customer-open skill guard/,
    `設了白名單不應出現 P0 警告，但 stderr 尾段:\n${stderrTail.slice(-800)}`,
  );
});
