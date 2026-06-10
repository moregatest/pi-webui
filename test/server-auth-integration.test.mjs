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

async function getJsonOrText(res) {
  const text = await res.text();
  try { return { json: JSON.parse(text), text }; }
  catch { return { json: null, text }; }
}

test("no password: GET / returns 200 (向後相容)", async () => {
  const { child, url } = await startServer({});
  try {
    const res = await fetch(`${url}/`, { redirect: "manual" });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<title>readyai-webui<\/title>/);
  } finally {
    await stopServer(child);
  }
});

test("with password: GET / redirects to /login", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: PASSWORD });
  try {
    const res = await fetch(`${url}/`, { redirect: "manual" });
    assert.equal(res.status, 302);
    const loc = res.headers.get("location");
    assert.ok(loc && loc.startsWith("/login"), `location=${loc}`);
  } finally {
    await stopServer(child);
  }
});

test("with password: GET /login returns the login page", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: PASSWORD });
  try {
    const res = await fetch(`${url}/login`, { redirect: "manual" });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /id="login-form"/);
  } finally {
    await stopServer(child);
  }
});

test("with password: correct login sets cookie and grants access", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: PASSWORD });
  try {
    const login = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie") || "";
    assert.match(setCookie, /pi_webui_auth=[0-9a-f]{64}/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.equal(setCookie.includes("Secure"), false);

    const cookie = setCookie.split(";")[0];
    const home = await fetch(`${url}/`, {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(home.status, 200);
  } finally {
    await stopServer(child);
  }
});

test("with password: wrong login returns 401 after delay", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: PASSWORD });
  try {
    const t0 = Date.now();
    const login = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    });
    const elapsed = Date.now() - t0;
    assert.equal(login.status, 401);
    assert.ok(elapsed >= 200, `expected delay >= 200ms, got ${elapsed}ms`);
    const { json } = await getJsonOrText(login);
    assert.equal(json?.ok, false);
  } finally {
    await stopServer(child);
  }
});

test("with password: logout revokes the cookie", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: PASSWORD });
  try {
    const login = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

    const logout = await fetch(`${url}/api/logout`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(logout.status, 200);
    const clear = logout.headers.get("set-cookie") || "";
    assert.match(clear, /pi_webui_auth=;/);
    assert.match(clear, /Max-Age=0/);

    // 用同一個 (已 revoke) token 再打 / 應該被擋
    const home = await fetch(`${url}/`, {
      headers: { cookie },
      redirect: "manual",
    });
    assert.equal(home.status, 302);
  } finally {
    await stopServer(child);
  }
});

test("with password: WS upgrade without cookie is rejected", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: PASSWORD });
  try {
    const wsUrl = url.replace(/^http:/, "ws:") + "/ws";
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WS timeout")), 5000);
      ws.on("unexpected-response", (_req, res) => {
        clearTimeout(t);
        assert.equal(res.statusCode, 401);
        resolve();
      });
      ws.on("error", () => { /* 連線被 destroy 也算成功;搭配 close 觸發 resolve */ });
      ws.on("close", () => {
        clearTimeout(t);
        resolve();
      });
      ws.on("open", () => {
        clearTimeout(t);
        reject(new Error("WS should NOT have opened"));
      });
    });
  } finally {
    await stopServer(child);
  }
});

test("with password: WS upgrade with valid cookie succeeds", async () => {
  const { child, url } = await startServer({ PI_WEBUI_PASSWORD: PASSWORD });
  try {
    const login = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];

    const wsUrl = url.replace(/^http:/, "ws:") + "/ws";
    const ws = new WebSocket(wsUrl, { headers: { cookie } });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WS open timeout")), 10000);
      ws.on("open", () => { clearTimeout(t); ws.close(); resolve(); });
      ws.on("error", (err) => { clearTimeout(t); reject(err); });
    });
  } finally {
    await stopServer(child);
  }
});

test("trust-proxy: X-Forwarded-Proto=https sets Secure flag", async () => {
  const { child, url } = await startServer({
    PI_WEBUI_PASSWORD: PASSWORD,
    PI_WEBUI_TRUST_PROXY: "1",
  });
  try {
    const login = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const setCookie = login.headers.get("set-cookie") || "";
    assert.match(setCookie, /Secure/);
  } finally {
    await stopServer(child);
  }
});

test("trust-proxy: 無 X-Forwarded-Proto 時不加 Secure", async () => {
  const { child, url } = await startServer({
    PI_WEBUI_PASSWORD: PASSWORD,
    PI_WEBUI_TRUST_PROXY: "1",
  });
  try {
    const login = await fetch(`${url}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const setCookie = login.headers.get("set-cookie") || "";
    assert.equal(setCookie.includes("Secure"), false);
  } finally {
    await stopServer(child);
  }
});
