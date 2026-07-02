// 整合測試：base-path 全鏈路（ingress strip req.url + egress 前綴 + <base> 注入位置）。
// 對應 spec docs/superpowers/specs/2026-07-02-base-path-parametrize-design.md §A server 整合。
// 真實 spawn dist/server/index.js，用 fetch / ws 驗證行為。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

function startServer(env, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      ["dist/server/index.js", "--listen", "127.0.0.1:0", ...args],
      { env: { ...process.env, ...env, PI_WEBUI_PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let resolved = false;
    const onChunk = (chunk) => {
      out += chunk.toString();
      const m = out.match(/url=(http:\/\/127\.0\.0\.1:\d+)/);
      if (m && !resolved) { resolved = true; resolve({ child, url: m[1] }); }
    };
    child.stderr.on("data", onChunk);
    child.stdout.on("data", onChunk);
    child.on("exit", (code) => { if (!resolved) reject(new Error(`server exited code=${code}: ${out}`)); });
    setTimeout(() => {
      if (!resolved) { try { child.kill("SIGKILL"); } catch {} reject(new Error(`start timeout: ${out.slice(-800)}`)); }
    }, 15000);
  });
}

function stopServer(child) {
  return new Promise((res) => {
    if (!child || child.exitCode !== null) return res();
    child.once("exit", () => res());
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} res(); }, 2000);
  });
}

// P1-a：斷言注入的 <base href="expected"> 出現在「第一個相對 href=/src=」之前。
// 相對＝不以 http(s):、// 、/ 開頭（<base> 自身的 href="/webui/" 以 / 開頭，被排除，不會誤判為 asset）。
function assertBaseBeforeAssets(html, expectedHref) {
  const baseIdx = html.search(/<base\s+href=/i);
  assert.ok(baseIdx >= 0, "應注入 <base>");
  assert.ok(html.includes(`<base href="${expectedHref}">`),
    `<base href> 應為 ${expectedHref}；實得: ${html.slice(baseIdx, baseIdx + 48)}`);
  const m = html.match(/(?:href|src)="(?!https?:|\/\/|\/)[^"]*"/i);
  assert.ok(m, "HTML 應有相對 asset 供位置驗證");
  const assetIdx = html.indexOf(m[0]);
  assert.ok(baseIdx < assetIdx,
    `<base>(idx=${baseIdx}) 必須在第一個相對 asset(idx=${assetIdx} ${m[0]}) 之前`);
}

test("base=/webui: 未登入 /webui/ → 302 /webui/login?next=/webui/（不迴圈、不累加前綴）", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: "pw", PI_WEBUI_BASE_PATH: "/webui" });
  try {
    const res = await fetch(`${url}/webui/`, { redirect: "manual" });
    assert.equal(res.status, 302);
    const loc = res.headers.get("location") || "";
    assert.ok(loc.startsWith("/webui/login?next="), `location=${loc}`);
    assert.ok(loc.includes("next=%2Fwebui%2F") || loc.includes("next=/webui/"), `next 應是 /webui/，得 ${loc}`);
    assert.ok(!loc.includes("/webui/webui"), `不可累加前綴: ${loc}`);
  } finally { await stopServer(child); }
});

test("base=/webui: 未登入 /webui/foo → 302 next=/webui/foo", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: "pw", PI_WEBUI_BASE_PATH: "/webui" });
  try {
    const res = await fetch(`${url}/webui/foo`, { redirect: "manual" });
    assert.equal(res.status, 302);
    const loc = res.headers.get("location") || "";
    assert.ok(loc.startsWith("/webui/login?next="), `location=${loc}`);
    assert.ok(loc.includes("next=%2Fwebui%2Ffoo") || loc.includes("next=/webui/foo"), `得 ${loc}`);
    assert.ok(!loc.includes("/webui/webui"), `不可累加前綴: ${loc}`);
  } finally { await stopServer(child); }
});

test("base=/webui: /webui/login → 200，<base href='/webui/'> 在第一個相對 asset 前，__BASE__='/webui'", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: "pw", PI_WEBUI_BASE_PATH: "/webui" });
  try {
    const res = await fetch(`${url}/webui/login`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assertBaseBeforeAssets(html, "/webui/");
    assert.ok(html.includes('window.__BASE__="/webui"'), "login __BASE__ 應為 /webui");
  } finally { await stopServer(child); }
});

test("base=/webui: POST /webui/api/login 正確密碼 → 200 + Set-Cookie Path=/webui；登入後 /webui/ → 200 index（<base> 位置正確）", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: "pw", PI_WEBUI_BASE_PATH: "/webui" });
  try {
    const login = await fetch(`${url}/webui/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "pw" }),
    });
    assert.equal(login.status, 200); // strip 發生在 handleAuth 之前才認得 /api/login
    const setCookie = login.headers.get("set-cookie") || "";
    assert.ok(setCookie.includes("Path=/webui"), `Set-Cookie 應帶 Path=/webui: ${setCookie}`);
    const cookie = setCookie.split(";")[0];
    const home = await fetch(`${url}/webui/`, { headers: { cookie }, redirect: "manual" });
    assert.equal(home.status, 200);
    const html = await home.text();
    assertBaseBeforeAssets(html, "/webui/");
    assert.ok(html.includes('window.__BASE__="/webui"'));
  } finally { await stopServer(child); }
});

test("base=/webui: WS /webui/ws 帶 cookie upgrade 成功；未登入 401", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: "pw", PI_WEBUI_BASE_PATH: "/webui" });
  try {
    const login = await fetch(`${url}/webui/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "pw" }),
    });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const wsBase = url.replace("http://", "ws://");
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/webui/ws`, { headers: { cookie } });
      const t = setTimeout(() => { try { ws.terminate(); } catch {} reject(new Error("ws open timeout")); }, 5000);
      ws.on("open", () => { clearTimeout(t); ws.close(); resolve(); });
      ws.on("error", (e) => { clearTimeout(t); reject(e); });
    });
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/webui/ws`); // 未帶 cookie
      const t = setTimeout(() => { try { ws.terminate(); } catch {} resolve(); }, 5000);
      ws.on("open", () => { clearTimeout(t); ws.close(); reject(new Error("未登入不該 upgrade 成功")); });
      ws.on("unexpected-response", (_req, res) => { clearTimeout(t); assert.equal(res.statusCode, 401); resolve(); });
      ws.on("error", () => { clearTimeout(t); resolve(); });
    });
  } finally { await stopServer(child); }
});

test("base=/webui: 有設 logo → GET /webui/brand/logo 固定 200（public，不需登入）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bp-logo-"));
  const logoPath = path.join(dir, "logo.svg");
  writeFileSync(logoPath, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4"/></svg>');
  const { child, url } = await startServer({ PI_WEBUI_BASE_PATH: "/webui" }, ["--brand-logo", logoPath]);
  try {
    const res = await fetch(`${url}/webui/brand/logo`, { redirect: "manual" });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /svg/);
  } finally { await stopServer(child); }
});

test("base=/webui: 未設 logo → GET /webui/brand/logo 302 /webui/favicon.svg（fallback 也帶前綴）", async () => {
  const { child, url } = await startServer({ PI_WEBUI_BASE_PATH: "/webui" });
  try {
    const res = await fetch(`${url}/webui/brand/logo`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/webui/favicon.svg");
  } finally { await stopServer(child); }
});

test("base='' (root 回歸): GET / → 200，__BASE__='' 且 <base href='/'>", async () => {
  const { child, url } = await startServer({}); // 不設 base、不設密碼
  try {
    const res = await fetch(`${url}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('window.__BASE__=""'), "root __BASE__ 應為空字串（避免 //api/login）");
    assert.ok(html.includes('<base href="/">'), "root baseHref 應為 /");
  } finally { await stopServer(child); }
});
