import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PASSWORD = "secret-pw";

function startServer(env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/server/index.js", "--listen", "127.0.0.1:0"], {
      env: { ...process.env, ...env, PI_WEBUI_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let resolved = false;
    const onChunk = (chunk) => {
      stderr += chunk.toString();
      const m = stderr.match(/url=(http:\/\/127\.0\.0\.1:\d+)/);
      if (m && !resolved) {
        resolved = true;
        resolve({ child, url: m[1] });
      }
    };
    child.stderr.on("data", onChunk);
    child.stdout.on("data", onChunk);
    child.on("exit", (code) => {
      if (!resolved) reject(new Error(`server exited code=${code}: ${stderr}`));
    });
    setTimeout(() => {
      if (!resolved) {
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error(`server start timeout: ${stderr.slice(-1000)}`));
      }
    }, 15000);
  });
}

function stopServer(child) {
  return new Promise((res) => {
    if (!child || child.exitCode !== null) return res();
    child.once("exit", () => res());
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, 2000);
  });
}

async function loginCookie(url) {
  const login = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  return (login.headers.get("set-cookie") || "").split(";")[0];
}

test("GET /api/session：未登入 401，不回 token", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: PASSWORD });
  try {
    const res = await fetch(`${url}/api/session`, { redirect: "manual" });
    assert.equal(res.status, 401);
  } finally {
    await stopServer(child);
  }
});

test("GET /api/session：已登入 200 {authenticated:true}，只有這個欄位、不快取", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: PASSWORD });
  try {
    const cookie = await loginCookie(url);
    const res = await fetch(`${url}/api/session`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { authenticated: true });
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("set-cookie"), null);
  } finally {
    await stopServer(child);
  }
});

test("GET /api/session：沒設密碼（不需登入）也回 200", async () => {
  const { child, url } = await startServer({});
  try {
    const res = await fetch(`${url}/api/session`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { authenticated: true });
  } finally {
    await stopServer(child);
  }
});

test("base path 下 /agent/api/session 可用", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: PASSWORD, PI_WEBUI_BASE_PATH: "/agent" });
  try {
    const unauth = await fetch(`${url}/agent/api/session`, { redirect: "manual" });
    assert.equal(unauth.status, 401);
    const login = await fetch(`${url}/agent/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const res = await fetch(`${url}/agent/api/session`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { authenticated: true });
  } finally {
    await stopServer(child);
  }
});

test("embed=1：未登入導向登入頁時 next 保留 embed=1，登入頁首屏就是 embed 版面", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: PASSWORD, PI_WEBUI_BASE_PATH: "/agent" });
  try {
    const res = await fetch(`${url}/agent/?embed=1`, { redirect: "manual" });
    assert.equal(res.status, 302);
    const loc = res.headers.get("location");
    assert.equal(new URLSearchParams(loc.split("?")[1]).get("next"), "/agent/?embed=1");
    const login = await fetch(`${url}${loc}`);
    assert.match(await login.text(), /<html[^>]*data-embed="1"/);
  } finally {
    await stopServer(child);
  }
});

test("embed=1：主畫面首屏帶 data-embed；沒帶就不加（全螢幕版不變）", async () => {
  const { child, url } = await startServer({});
  try {
    const embed = await (await fetch(`${url}/?embed=1`)).text();
    assert.match(embed, /<html[^>]*data-embed="1"/);
    const full = await (await fetch(`${url}/`)).text();
    assert.doesNotMatch(full, /<html[^>]*data-embed/);
    const login = await (await fetch(`${url}/login`)).text();
    assert.doesNotMatch(login, /<html[^>]*data-embed/);
  } finally {
    await stopServer(child);
  }
});
