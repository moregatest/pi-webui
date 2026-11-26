// W60-01：信任上游身分（PI_WEBUI_TRUST_UPSTREAM_HEADER）與回到專案清單（PI_WEBUI_HOME_URL）整合測試。
// 每個 server 用獨立的暫存 agentDir／cwd，不碰本機 ~/.pi。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const HEADER = "X-ReadyAI-User";
const USER = "owner@example.com";

function isolatedEnv(extra = {}) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "webui-upstream-agent-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "webui-upstream-cwd-"));
  const env = { ...process.env, PI_AGENT_DIR: agentDir, PI_PROJECT_CWD: cwd };
  for (const k of ["PI_WEBUI_PASSWORD", "PI_WEBUI_TUNNEL", "PI_WEBUI_TRUST_UPSTREAM_HEADER", "PI_WEBUI_HOME_URL",
    "PI_WEBUI_HOST", "PI_WEBUI_UI_PROFILE"]) delete env[k];
  return { env: { ...env, ...extra }, cwd };
}

function startServer(extra, listen = "127.0.0.1:0") {
  const { env, cwd } = isolatedEnv(extra);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/server/index.js", "--listen", listen], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let resolved = false;
    const onChunk = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/url=(http:\/\/127\.0\.0\.1:\d+)/);
      if (m && !resolved) { resolved = true; resolve({ child, url: m[1], cwd }); }
    };
    child.stderr.on("data", onChunk);
    child.stdout.on("data", onChunk);
    child.on("exit", (code) => { if (!resolved) reject(Object.assign(new Error(`exit ${code}`), { code, output: buf })); });
    setTimeout(() => {
      if (!resolved) { try { child.kill("SIGKILL"); } catch {} reject(new Error(`start timeout: ${buf.slice(-800)}`)); }
    }, 15000);
  });
}

/** 預期啟動失敗：回傳結束碼與輸出；若竟然開始聽就判失敗。 */
function expectStartFailure(extra, listen = "127.0.0.1:0") {
  const { env } = isolatedEnv(extra);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/server/index.js", "--listen", listen], {
      env, stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    const onChunk = (chunk) => {
      buf += chunk.toString();
      if (/url=http:/.test(buf)) { try { child.kill("SIGKILL"); } catch {} reject(new Error(`should not listen: ${buf}`)); }
    };
    child.stderr.on("data", onChunk);
    child.stdout.on("data", onChunk);
    child.on("exit", (code) => resolve({ code, output: buf }));
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} reject(new Error("no exit")); }, 15000);
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

function wsUpgradeStatus(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http:/, "ws:") + "/ws", { headers });
    const t = setTimeout(() => reject(new Error("WS timeout")), 8000);
    ws.on("unexpected-response", (_req, res) => { clearTimeout(t); resolve(res.statusCode); });
    ws.on("open", () => { clearTimeout(t); ws.close(); resolve(101); });
    ws.on("error", () => {});
  });
}

function connectedPayload(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http:/, "ws:") + "/ws", { headers });
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("connected timeout")); }, 15000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "ready", lastSeq: null, sessionFile: null })));
    ws.on("message", (d) => {
      const pkt = JSON.parse(String(d));
      if (pkt.type === "connected") { clearTimeout(t); ws.close(); resolve(pkt.payload); }
    });
    ws.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

// ── 啟動檢查 ────────────────────────────────────────────────────────────

test("信任上游：綁定 0.0.0.0 時啟動失敗、不開始聽", async () => {
  const r = await expectStartFailure({ PI_WEBUI_TRUST_UPSTREAM_HEADER: HEADER }, "0.0.0.0:0");
  assert.notEqual(r.code, 0);
  assert.match(r.output, /PI_WEBUI_TRUST_UPSTREAM_HEADER 只能在綁定 127\.0\.0\.1 或 ::1/);
});

test("信任上游：PI_WEBUI_HOST=0.0.0.0（無 --listen 時）也啟動失敗", async () => {
  const { env } = isolatedEnv({ PI_WEBUI_TRUST_UPSTREAM_HEADER: HEADER, PI_WEBUI_HOST: "0.0.0.0", PI_WEBUI_PORT: "0" });
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/server/index.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    child.stderr.on("data", (c) => { buf += c; });
    child.stdout.on("data", (c) => { buf += c; });
    child.on("exit", (code) => resolve({ code, output: buf }));
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 15000);
  });
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.output, /url=http:/);
  assert.match(r.output, /只能在綁定/);
});

test("信任上游：與 tunnel 或密碼同時設定時啟動失敗", async () => {
  const t = await expectStartFailure({ PI_WEBUI_TRUST_UPSTREAM_HEADER: HEADER, PI_WEBUI_TUNNEL: "1",
    PI_WEBUI_CLOUDFLARED: "/nonexistent/cloudflared" });
  assert.notEqual(t.code, 0);
  assert.match(t.output, /不可與 --tunnel 同時開啟/);
  const p = await expectStartFailure({ PI_WEBUI_TRUST_UPSTREAM_HEADER: HEADER, PI_WEBUI_PASSWORD: "pw" });
  assert.notEqual(p.code, 0);
  assert.match(p.output, /二選一/);
});

test("信任上游：標頭名稱不合格、回到專案清單網址不合格都啟動失敗", async () => {
  const h = await expectStartFailure({ PI_WEBUI_TRUST_UPSTREAM_HEADER: "Cookie" });
  assert.notEqual(h.code, 0);
  assert.match(h.output, /PI_WEBUI_TRUST_UPSTREAM_HEADER/);
  const u = await expectStartFailure({ PI_WEBUI_HOME_URL: "javascript:alert(1)" });
  assert.notEqual(u.code, 0);
  assert.match(u.output, /PI_WEBUI_HOME_URL/);
});

// ── 開啟時的請求行為 ─────────────────────────────────────────────────────

test("信任上游：缺標頭一律 401（頁面、API、WS），不退回密碼頁", async () => {
  const { child, url } = await startServer({ PI_WEBUI_TRUST_UPSTREAM_HEADER: HEADER });
  try {
    const home = await fetch(`${url}/`, { redirect: "manual" });
    assert.equal(home.status, 401);
    assert.equal(home.headers.get("location"), null);
    assert.doesNotMatch(await home.text(), /login-form/);
    const login = await fetch(`${url}/login`, { redirect: "manual" });
    assert.equal(login.status, 401);
    const api = await fetch(`${url}/api/session`);
    assert.equal(api.status, 401);
    assert.equal(await wsUpgradeStatus(url), 401);
    // 同名標頭重複（可能是外部偽造加上閘道的）一律拒絕
    assert.equal(await wsUpgradeStatus(url, { [HEADER]: `${USER}, attacker@example.com` }), 401);
    const dup = await fetch(`${url}/`, { headers: { [HEADER]: `${USER}, x@example.com` }, redirect: "manual" });
    assert.equal(dup.status, 401);
    // 公開探針照舊
    assert.equal((await fetch(`${url}/version`)).status, 200);
  } finally {
    await stopServer(child);
  }
});

test("信任上游：帶標頭直接進入、不需密碼；登入／登出 API 停用；/login 轉回首頁", async () => {
  const { child, url } = await startServer({ PI_WEBUI_TRUST_UPSTREAM_HEADER: HEADER });
  try {
    const h = { [HEADER]: USER };
    const home = await fetch(`${url}/`, { headers: h, redirect: "manual" });
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<title>readyai-webui<\/title>/);
    // session 直達參數照樣進得來（不被轉址吃掉）
    const direct = await fetch(`${url}/?session=abc`, { headers: h, redirect: "manual" });
    assert.equal(direct.status, 200);
    const s = await fetch(`${url}/api/session`, { headers: h });
    assert.deepEqual(await s.json(), { authenticated: true, mode: "upstream", user: USER });
    const login = await fetch(`${url}/api/login`, {
      method: "POST", headers: { ...h, "Content-Type": "application/json" }, body: JSON.stringify({ password: "x" }),
    });
    assert.equal(login.status, 400);
    assert.equal(login.headers.get("set-cookie"), null);
    assert.equal((await login.json()).error, "upstream_identity");
    const logout = await fetch(`${url}/api/logout`, { method: "POST", headers: h });
    assert.equal(logout.status, 400);
    // /login 在此模式沒有意義：轉回 next（站內路徑才收，保留 ?session= 直達），不合格的 next 轉首頁
    const loginPage = await fetch(`${url}/login?next=%2F%3Fsession%3Dabc`, { headers: h, redirect: "manual" });
    assert.equal(loginPage.status, 302);
    assert.equal(loginPage.headers.get("location"), "/?session=abc");
    for (const bad of ["https%3A%2F%2Fevil.example%2F", "%2F%2Fevil.example", "%2F%5Cevil"]) {
      const r = await fetch(`${url}/login?next=${bad}`, { headers: h, redirect: "manual" });
      assert.equal(r.status, 302);
      assert.equal(r.headers.get("location"), "/", bad);
    }
    assert.equal(await wsUpgradeStatus(url, h), 101);
    const mod = await fetch(`${url}/home-link.mjs`, { headers: h });
    assert.equal(mod.status, 200);
    assert.match(await mod.text(), /export function applyHomeLink/);
  } finally {
    await stopServer(child);
  }
});

test("信任上游：connected 帶回到專案清單網址；沒設就不帶", async () => {
  const withHome = await startServer({ PI_WEBUI_TRUST_UPSTREAM_HEADER: HEADER,
    PI_WEBUI_HOME_URL: "https://center.example.ts.net/continue/" });
  try {
    const p = await connectedPayload(withHome.url, { [HEADER]: USER });
    assert.equal(p.homeUrl, "https://center.example.ts.net/continue/");
  } finally {
    await stopServer(withHome.child);
  }
  const noHome = await startServer({ PI_WEBUI_TRUST_UPSTREAM_HEADER: HEADER });
  try {
    const p = await connectedPayload(noHome.url, { [HEADER]: USER });
    assert.equal("homeUrl" in p, false);
  } finally {
    await stopServer(noHome.child);
  }
});

// ── 預覽站模式（沒開）不受影響 ───────────────────────────────────────────

test("沒開信任上游：密碼模式照舊，送了身分標頭也沒用", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: "secret-pw" });
  try {
    const home = await fetch(`${url}/`, { headers: { [HEADER]: USER }, redirect: "manual" });
    assert.equal(home.status, 302);
    assert.ok(home.headers.get("location").startsWith("/login"));
    assert.equal(await wsUpgradeStatus(url, { [HEADER]: USER }), 401);
    const s = await fetch(`${url}/api/session`, { headers: { [HEADER]: USER } });
    assert.equal(s.status, 401);
    const login = await fetch(`${url}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "secret-pw" }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const s2 = await fetch(`${url}/api/session`, { headers: { cookie } });
    assert.deepEqual(await s2.json(), { authenticated: true });
  } finally {
    await stopServer(child);
  }
});

test("沒開信任上游、沒設密碼：照舊直接進入，/api/session 形狀不變", async () => {
  const { child, url } = await startServer({});
  try {
    const s = await fetch(`${url}/api/session`);
    assert.deepEqual(await s.json(), { authenticated: true });
  } finally {
    await stopServer(child);
  }
});
