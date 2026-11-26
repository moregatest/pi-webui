// W60-01：信任上游身分（PI_WEBUI_TRUST_UPSTREAM_HEADER）與回到專案清單（PI_WEBUI_HOME_URL）整合測試。
// RV60-01：信任模式另外要求每實例的閘道密鑰（PI_WEBUI_TRUST_UPSTREAM_SECRET_FILE＋X-ReadyAI-Gateway-Secret）
// 與 Origin 檢查（PI_WEBUI_TRUSTED_ORIGIN 或由 PI_WEBUI_HOME_URL 推得）。
// 每個 server 用獨立的暫存 agentDir／cwd，不碰本機 ~/.pi。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const HEADER = "X-ReadyAI-User";
const SECRET_HEADER = "X-ReadyAI-Gateway-Secret";
const USER = "owner@example.com";
const GATEWAY = "http://gw.example.test:8790";
// 密鑰前綴固定，方便在 bash 輸出裡只用前綴搜尋（指令本身不含完整密鑰）
const SECRET_MARK = "W60SECRETMARK";

function newSecretFile(mode = 0o600, value = SECRET_MARK + randomBytes(24).toString("hex")) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webui-upstream-secret-"));
  const file = path.join(dir, "gateway.secret");
  fs.writeFileSync(file, value + "\n", { mode });
  fs.chmodSync(file, mode);
  return { file, value };
}

/** 信任模式的完整設定：身分標頭名、密鑰檔、閘道來源。回傳環境變數與請求要帶的標頭。 */
function trustSetup(extra = {}) {
  const secret = newSecretFile();
  const env = {
    PI_WEBUI_TRUST_UPSTREAM_HEADER: HEADER,
    PI_WEBUI_TRUST_UPSTREAM_SECRET_FILE: secret.file,
    PI_WEBUI_TRUSTED_ORIGIN: GATEWAY,
    ...extra,
  };
  const headers = { [HEADER]: USER, [SECRET_HEADER]: secret.value };
  return { env, headers, secret };
}

function isolatedEnv(extra = {}) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "webui-upstream-agent-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "webui-upstream-cwd-"));
  const env = { ...process.env, PI_AGENT_DIR: agentDir, PI_PROJECT_CWD: cwd };
  for (const k of ["PI_WEBUI_PASSWORD", "PI_WEBUI_TUNNEL", "PI_WEBUI_TRUST_UPSTREAM_HEADER", "PI_WEBUI_HOME_URL",
    "PI_WEBUI_HOST", "PI_WEBUI_UI_PROFILE", "PI_WEBUI_TRUST_UPSTREAM_SECRET_FILE", "PI_WEBUI_TRUSTED_ORIGIN",
    "PI_WEBUI_BASH_ENV_ALLOW"]) delete env[k];
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return { env, cwd };
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
      if (m && !resolved) { resolved = true; resolve({ child, url: m[1], cwd, output: () => buf }); }
    };
    child.stderr.on("data", onChunk);
    child.stdout.on("data", onChunk);
    child.on("exit", (code) => { if (!resolved) reject(Object.assign(new Error(`exit ${code}: ${buf.slice(-800)}`), { code, output: buf })); });
    setTimeout(() => {
      if (!resolved) { try { child.kill("SIGKILL"); } catch {} reject(new Error(`start timeout: ${buf.slice(-800)}`)); }
    }, 15000);
  });
}

/** 預期啟動失敗：回傳結束碼與輸出；若竟然開始聽就判失敗。 */
function expectStartFailure(extra, listen = "127.0.0.1:0", args = null) {
  const { env } = isolatedEnv(extra);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args ?? ["dist/server/index.js", "--listen", listen], {
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

function openReady(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http:/, "ws:") + "/ws", { headers });
    const packets = [];
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("connected timeout")); }, 15000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "ready", lastSeq: null, sessionFile: null })));
    ws.on("message", (d) => {
      const s = String(d);
      packets.push(s);
      const pkt = JSON.parse(s);
      if (pkt.type === "connected") { clearTimeout(t); resolve({ ws, payload: pkt.payload, packets }); }
    });
    ws.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

async function connectedPayload(url, headers) {
  const { ws, payload } = await openReady(url, headers);
  ws.close();
  return payload;
}

// ── 啟動檢查 ────────────────────────────────────────────────────────────

test("信任上游：綁定 0.0.0.0 時啟動失敗、不開始聽，也不吃掉密鑰檔", async () => {
  const { env, secret } = trustSetup();
  const r = await expectStartFailure(env, "0.0.0.0:0");
  assert.notEqual(r.code, 0);
  assert.match(r.output, /PI_WEBUI_TRUST_UPSTREAM_HEADER 只能在綁定 127\.0\.0\.1 或 ::1/);
  // 其他檢查沒過就不讀密鑰：閘道剛寫的檔不會被白白刪掉
  assert.equal(fs.existsSync(secret.file), true);
});

test("信任上游：PI_WEBUI_HOST=0.0.0.0（無 --listen 時）也啟動失敗", async () => {
  const { env } = trustSetup({ PI_WEBUI_HOST: "0.0.0.0", PI_WEBUI_PORT: "0" });
  const r = await expectStartFailure(env, null, ["dist/server/index.js"]);
  assert.notEqual(r.code, 0);
  assert.match(r.output, /只能在綁定/);
});

test("信任上游：與 tunnel 或密碼同時設定時啟動失敗", async () => {
  const t = await expectStartFailure(trustSetup({ PI_WEBUI_TUNNEL: "1",
    PI_WEBUI_CLOUDFLARED: "/nonexistent/cloudflared" }).env);
  assert.notEqual(t.code, 0);
  assert.match(t.output, /不可與 --tunnel 同時開啟/);
  const p = await expectStartFailure(trustSetup({ PI_WEBUI_PASSWORD: "pw" }).env);
  assert.notEqual(p.code, 0);
  assert.match(p.output, /二選一/);
});

test("信任上游：標頭名稱不合格、回到專案清單網址不合格都啟動失敗", async () => {
  const h = await expectStartFailure(trustSetup({ PI_WEBUI_TRUST_UPSTREAM_HEADER: "Cookie" }).env);
  assert.notEqual(h.code, 0);
  assert.match(h.output, /PI_WEBUI_TRUST_UPSTREAM_HEADER/);
  const s = await expectStartFailure(trustSetup({ PI_WEBUI_TRUST_UPSTREAM_HEADER: SECRET_HEADER }).env);
  assert.notEqual(s.code, 0);
  assert.match(s.output, /不可使用協定或代理自己會設的標頭/);
  const u = await expectStartFailure({ PI_WEBUI_HOME_URL: "javascript:alert(1)" });
  assert.notEqual(u.code, 0);
  assert.match(u.output, /PI_WEBUI_HOME_URL/);
});

test("信任上游：沒有密鑰檔、密鑰檔不合格都啟動失敗（RV60-01 高 1）", async () => {
  const none = await expectStartFailure(trustSetup({ PI_WEBUI_TRUST_UPSTREAM_SECRET_FILE: undefined }).env);
  assert.notEqual(none.code, 0);
  assert.match(none.output, /需要同時設定 PI_WEBUI_TRUST_UPSTREAM_SECRET_FILE/);
  const missing = await expectStartFailure(trustSetup({ PI_WEBUI_TRUST_UPSTREAM_SECRET_FILE: "/nonexistent/secret" }).env);
  assert.notEqual(missing.code, 0);
  assert.match(missing.output, /讀不到密鑰檔/);
  const loose = newSecretFile(0o644);
  const l = await expectStartFailure(trustSetup({ PI_WEBUI_TRUST_UPSTREAM_SECRET_FILE: loose.file }).env);
  assert.notEqual(l.code, 0);
  assert.match(l.output, /權限必須是 0600 或 0400/);
  const short = newSecretFile(0o600, "short");
  const sh = await expectStartFailure(trustSetup({ PI_WEBUI_TRUST_UPSTREAM_SECRET_FILE: short.file }).env);
  assert.notEqual(sh.code, 0);
  assert.match(sh.output, /密鑰長度/);
  const target = newSecretFile();
  const link = path.join(path.dirname(target.file), "link.secret");
  fs.symlinkSync(target.file, link);
  const ln = await expectStartFailure(trustSetup({ PI_WEBUI_TRUST_UPSTREAM_SECRET_FILE: link }).env);
  assert.notEqual(ln.code, 0);
  assert.match(ln.output, /不可是符號連結/);
  // 錯誤訊息不含密鑰內容
  for (const r of [none, missing, l, sh, ln]) assert.doesNotMatch(r.output, new RegExp(SECRET_MARK));
});

test("信任上游：沒有閘道來源、來源格式錯都啟動失敗（RV60-01 中 1）", async () => {
  const none = await expectStartFailure(trustSetup({ PI_WEBUI_TRUSTED_ORIGIN: undefined }).env);
  assert.notEqual(none.code, 0);
  assert.match(none.output, /需要閘道的來源/);
  const rel = await expectStartFailure(trustSetup({ PI_WEBUI_TRUSTED_ORIGIN: undefined, PI_WEBUI_HOME_URL: "/continue/" }).env);
  assert.notEqual(rel.code, 0);
  assert.match(rel.output, /需要閘道的來源/);
  const withPath = await expectStartFailure(trustSetup({ PI_WEBUI_TRUSTED_ORIGIN: `${GATEWAY}/c/x` }).env);
  assert.notEqual(withPath.code, 0);
  assert.match(withPath.output, /只能是來源/);
});

test("信任上游：密鑰讀一次就刪檔，不進行程環境、bash 也讀不到（RV60-01 高 1）", async () => {
  const { env, headers, secret } = trustSetup();
  const { child, url } = await startServer(env);
  try {
    assert.equal(fs.existsSync(secret.file), false, "密鑰檔應在啟動時讀完刪除");
    const { ws, packets } = await openReady(url, headers);
    // 指令只含前綴、不含完整密鑰；輸出用算出來的標記，避免指令原文本身就命中斷言
    ws.send(JSON.stringify({ type: "bash",
      command: `echo ENVHITS_$(env | grep -c ${SECRET_MARK})_; echo FILE_$(test -e '${secret.file}' && echo P || echo A)_; echo W60_$((1+1))DONE` }));
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`bash timeout: ${packets.join("\n").slice(-800)}`)), 20000);
      const check = () => { if (packets.join("\n").includes("W60_2DONE")) { clearTimeout(t); resolve(); } };
      ws.on("message", check);
      check();
    });
    ws.close();
    const all = packets.join("\n");
    assert.match(all, /ENVHITS_0_/);
    assert.match(all, /FILE_A_/);
    assert.equal(all.includes(secret.value), false, "WS 封包不可出現密鑰");
  } finally {
    await stopServer(child);
  }
});

// ── 開啟時的請求行為 ─────────────────────────────────────────────────────

test("信任上游：缺身分標頭或缺／錯密鑰一律 401（頁面、API、WS），不退回密碼頁", async () => {
  const { env, headers, secret } = trustSetup();
  const { child, url, output } = await startServer(env);
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
    // 同機程序只帶身分標頭、不知道密鑰（RV60-01 高 1 的探針情境）
    const forged = { [HEADER]: "someone-else@example.test" };
    assert.equal((await fetch(`${url}/api/session`, { headers: forged })).status, 401);
    assert.equal(await wsUpgradeStatus(url, forged), 401);
    // 密鑰錯、密鑰長度不同、密鑰重複
    for (const bad of [secret.value.slice(0, -1) + "x", "short", `${secret.value}, ${secret.value}`]) {
      const h = { [HEADER]: USER, [SECRET_HEADER]: bad };
      assert.equal((await fetch(`${url}/api/session`, { headers: h })).status, 401, bad.slice(0, 8));
      assert.equal(await wsUpgradeStatus(url, h), 401);
    }
    // 有密鑰但沒有身分
    assert.equal((await fetch(`${url}/api/session`, { headers: { [SECRET_HEADER]: secret.value } })).status, 401);
    // 同名身分標頭重複（可能是外部偽造加上閘道的）一律拒絕
    const dup = { ...headers, [HEADER]: `${USER}, attacker@example.com` };
    assert.equal(await wsUpgradeStatus(url, dup), 401);
    assert.equal((await fetch(`${url}/`, { headers: dup, redirect: "manual" })).status, 401);
    // 公開探針照舊
    assert.equal((await fetch(`${url}/version`)).status, 200);
    // 紀錄不寫密鑰
    assert.equal(output().includes(secret.value), false);
  } finally {
    await stopServer(child);
  }
});

test("信任上游：帶身分與密鑰直接進入；登入／登出 API 停用；/login 轉回 next", async () => {
  const { env, headers: h } = trustSetup();
  const { child, url } = await startServer(env);
  try {
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

test("信任上游：Origin 檢查——WS 與非 GET 跨站 403、閘道來源與無 Origin 放行（RV60-01 中 1）", async () => {
  const { env, headers: h } = trustSetup();
  const { child, url } = await startServer(env);
  try {
    // WebSocket 升級
    assert.equal(await wsUpgradeStatus(url, { ...h, Origin: "https://evil.example" }), 403);
    assert.equal(await wsUpgradeStatus(url, { ...h, Origin: "null" }), 403);
    assert.equal(await wsUpgradeStatus(url, { ...h, Origin: "http://gw.example.test:8791" }), 403);
    assert.equal(await wsUpgradeStatus(url, { ...h, Origin: GATEWAY }), 101);
    assert.equal(await wsUpgradeStatus(url, { ...h, Origin: "HTTP://GW.EXAMPLE.TEST:8790" }), 101);
    assert.equal(await wsUpgradeStatus(url, h), 101); // 非瀏覽器用戶端（沒有 Origin）
    // 非 GET：上傳端點
    const evil = await fetch(`${url}/api/upload`, { method: "POST", headers: { ...h, Origin: "https://evil.example" } });
    assert.equal(evil.status, 403);
    assert.equal((await evil.json()).reason, "origin_not_trusted");
    const ok = await fetch(`${url}/api/upload`, { method: "POST", headers: { ...h, Origin: GATEWAY } });
    assert.notEqual(ok.status, 403);
    const noOrigin = await fetch(`${url}/api/upload`, { method: "POST", headers: h });
    assert.notEqual(noOrigin.status, 403);
    // GET 不受 Origin 影響（頁面與靜態檔）
    assert.equal((await fetch(`${url}/`, { headers: { ...h, Origin: "https://evil.example" } })).status, 200);
    // 沒有身分時先回 401，不洩漏 Origin 規則
    assert.equal(await wsUpgradeStatus(url, { Origin: "https://evil.example" }), 401);
  } finally {
    await stopServer(child);
  }
});

test("信任上游：閘道來源可由 PI_WEBUI_HOME_URL 推得", async () => {
  const { env, headers: h } = trustSetup({ PI_WEBUI_TRUSTED_ORIGIN: undefined,
    PI_WEBUI_HOME_URL: "https://center.example.ts.net/continue/" });
  const { child, url } = await startServer(env);
  try {
    assert.equal(await wsUpgradeStatus(url, { ...h, Origin: "https://center.example.ts.net" }), 101);
    assert.equal(await wsUpgradeStatus(url, { ...h, Origin: "http://center.example.ts.net" }), 403);
    const p = await connectedPayload(url, { ...h, Origin: "https://center.example.ts.net" });
    assert.equal(p.homeUrl, "https://center.example.ts.net/continue/");
  } finally {
    await stopServer(child);
  }
});

test("信任上游：沒設回到專案清單就不帶 homeUrl", async () => {
  const { env, headers: h } = trustSetup();
  const { child, url } = await startServer(env);
  try {
    const p = await connectedPayload(url, h);
    assert.equal("homeUrl" in p, false);
  } finally {
    await stopServer(child);
  }
});

// ── 預覽站模式（沒開）不受影響 ───────────────────────────────────────────

test("沒開信任上游：密碼模式照舊，送了身分與密鑰標頭也沒用", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: "secret-pw" });
  try {
    const h = { [HEADER]: USER, [SECRET_HEADER]: SECRET_MARK + "x".repeat(40) };
    const home = await fetch(`${url}/`, { headers: h, redirect: "manual" });
    assert.equal(home.status, 302);
    assert.ok(home.headers.get("location").startsWith("/login"));
    assert.equal(await wsUpgradeStatus(url, h), 401);
    const s = await fetch(`${url}/api/session`, { headers: h });
    assert.equal(s.status, 401);
    const login = await fetch(`${url}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "secret-pw" }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const s2 = await fetch(`${url}/api/session`, { headers: { cookie } });
    assert.deepEqual(await s2.json(), { authenticated: true });
    // 密碼模式不做 Origin 檢查（行為不變）
    assert.equal(await wsUpgradeStatus(url, { cookie, Origin: "https://evil.example" }), 101);
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
