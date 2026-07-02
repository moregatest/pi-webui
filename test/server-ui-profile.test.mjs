// 整合測試:真實 spawn dist/server/index.js,驗證 ui-profile 相關行為。
// 對應 spec docs/superpowers/specs/2026-05-22-customer-ui-profile-design.md 內
// 「整合測試」與「啟動 fail-fast」清單。
//
// unit-level(parseUiProfile / filterEvent / safeError 行為)在 ui-profile.test.mjs 內,
// 這裡只覆蓋 server boot + WS connected payload + /brand/logo route 真正需要 spawn 才能驗證的部分。

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
      {
        env: { ...process.env, ...env, PI_WEBUI_PORT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    let stdout = "";
    let resolved = false;
    const onChunk = (chunk, sink) => {
      const text = chunk.toString();
      if (sink === "stderr") stderr += text;
      else stdout += text;
      const m = (stderr + stdout).match(/url=(http:\/\/127\.0\.0\.1:\d+)/);
      if (m && !resolved) {
        resolved = true;
        resolve({ child, url: m[1], getStderr: () => stderr, getStdout: () => stdout });
      }
    };
    child.stderr.on("data", (c) => onChunk(c, "stderr"));
    child.stdout.on("data", (c) => onChunk(c, "stdout"));
    child.on("exit", (code) => {
      if (!resolved) reject(new Error(`server exited code=${code}\nstderr: ${stderr}\nstdout: ${stdout}`));
    });
    setTimeout(() => {
      if (!resolved) {
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error(`server start timeout\nstderr: ${stderr.slice(-1000)}\nstdout: ${stdout.slice(-1000)}`));
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

// 連 WS 收第一個 connected packet,回傳 payload。沒 password 模式可直連。
function getConnectedPayload(url) {
  const wsUrl = url.replace(/^http:/, "ws:") + "/ws";
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("connected packet timeout"));
    }, 8000);
    ws.on("open", () => {
      // 模擬 client 的 ready handshake
      ws.send(JSON.stringify({ type: "ready", lastSeq: null, sessionFile: null }));
    });
    ws.on("message", (data) => {
      try {
        const packet = JSON.parse(String(data));
        if (packet.type === "connected") {
          clearTimeout(timer);
          ws.close();
          resolve(packet.payload);
        }
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// spawn 後等 process 自己 exit,回傳 exit code 與 stderr。用在 fail-fast 測試。
function spawnAndWaitExit(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      ["dist/server/index.js", "--listen", "127.0.0.1:0", ...args],
      {
        env: { ...process.env, ...env, PI_WEBUI_PORT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    const t = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, 8000);
    child.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code, stderr, stdout });
    });
  });
}

test("沒帶任何旗標 → connected payload 的 uiProfile 全 false + brand 全 null", async () => {
  const { child, url } = await startServer({});
  try {
    const payload = await getConnectedPayload(url);
    assert.ok(payload.uiProfile, "uiProfile should be present");
    assert.equal(payload.uiProfile.hideThinking, false);
    assert.equal(payload.uiProfile.hideToolCalls, false);
    assert.equal(payload.uiProfile.showToolProgress, false);
    assert.equal(payload.uiProfile.hideStatusChips, false);
    assert.equal(payload.uiProfile.hideSessionPicker, false);
    assert.equal(payload.uiProfile.hideModel, false);
    assert.equal(payload.uiProfile.safeErrors, false);
    assert.deepEqual(payload.uiProfile.brand, {
      name: null,
      logoUrl: null,
      color: null,
      mode: null,
      tokens: {},
      css: false,
    });
  } finally {
    await stopServer(child);
  }
});

test("--ui-profile customer → 7 個 boolean 全 true + brand 全 null", async () => {
  const { child, url } = await startServer({}, ["--ui-profile", "customer"]);
  try {
    const payload = await getConnectedPayload(url);
    const p = payload.uiProfile;
    assert.equal(p.hideThinking, true);
    assert.equal(p.hideToolCalls, true);
    assert.equal(p.showToolProgress, true);
    assert.equal(p.hideStatusChips, true);
    assert.equal(p.hideSessionPicker, true);
    assert.equal(p.hideModel, true);
    assert.equal(p.safeErrors, true);
    assert.deepEqual(p.brand, {
      name: null,
      logoUrl: null,
      color: null,
      mode: null,
      tokens: {},
      css: false,
    });
  } finally {
    await stopServer(child);
  }
});

test("--brand-name --brand-color --brand-logo → connected brand 三欄都帶值,logoUrl 為 /brand/logo", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "readyai-webui-brand-"));
  const logoPath = path.join(dir, "logo.svg");
  writeFileSync(logoPath, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4" /></svg>');

  const { child, url } = await startServer({}, [
    "--brand-name", "Acme Bot",
    "--brand-color", "#0066cc",
    "--brand-logo", logoPath,
  ]);
  try {
    const payload = await getConnectedPayload(url);
    assert.equal(payload.uiProfile.brand.name, "Acme Bot");
    assert.equal(payload.uiProfile.brand.color, "#0066cc");
    // server 把 file path 換成統一 /brand/logo URL(避免洩漏 host 路徑)
    assert.equal(payload.uiProfile.brand.logoUrl, "/brand/logo");
  } finally {
    await stopServer(child);
  }
});

test("PI_WEBUI_BASE_PATH=/webui → connected logoUrl 帶 base 前綴 /webui/brand/logo", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "readyai-webui-brand-"));
  const logoPath = path.join(dir, "logo.svg");
  writeFileSync(logoPath, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4" /></svg>');

  const { child, url } = await startServer({ PI_WEBUI_BASE_PATH: "/webui" }, [
    "--brand-logo", logoPath,
  ]);
  try {
    const payload = await getConnectedPayload(url);
    // logoUrl 由 server 依 SERVER_BASE_PATH 加前綴（egress single source）
    assert.equal(payload.uiProfile.brand.logoUrl, "/webui/brand/logo");
  } finally {
    await stopServer(child);
  }
});

test("GET /brand/logo 有設 logo 時回 200 + svg content-type", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "readyai-webui-brand-"));
  const logoPath = path.join(dir, "logo.svg");
  const svgBody = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4" /></svg>';
  writeFileSync(logoPath, svgBody);

  const { child, url } = await startServer({}, ["--brand-logo", logoPath]);
  try {
    const res = await fetch(`${url}/brand/logo`, { redirect: "manual" });
    assert.equal(res.status, 200);
    const ctype = res.headers.get("content-type") || "";
    assert.match(ctype, /image\/svg\+xml/);
    const body = await res.text();
    assert.equal(body, svgBody);
  } finally {
    await stopServer(child);
  }
});

test("GET /brand/logo 沒設 logo 時 302 → /favicon.svg", async () => {
  const { child, url } = await startServer({});
  try {
    const res = await fetch(`${url}/brand/logo`, { redirect: "manual" });
    assert.equal(res.status, 302);
    const loc = res.headers.get("location");
    assert.equal(loc, "/favicon.svg");
  } finally {
    await stopServer(child);
  }
});

test("--brand-logo 路徑不存在 → exit 非 0 + stderr 帶 'brand-logo: file not found'", async () => {
  const { code, stderr } = await spawnAndWaitExit([
    "--brand-logo", "/definitely/not/exist/" + Math.random().toString(36).slice(2) + ".svg",
  ]);
  assert.notEqual(code, 0, `expected non-zero exit, got ${code}`);
  assert.match(stderr, /brand-logo: file not found/);
});

test("--brand-color 不合法 → exit 非 0 + stderr 帶 'must be #rgb or #rrggbb'", async () => {
  const { code, stderr } = await spawnAndWaitExit(["--brand-color", "foo"]);
  assert.notEqual(code, 0, `expected non-zero exit, got ${code}`);
  assert.match(stderr, /must be #rgb or #rrggbb/);
});

test("--ui-profile 不認得的名稱 → exit 非 0 + stderr 帶 'unknown preset'", async () => {
  const { code, stderr } = await spawnAndWaitExit(["--ui-profile", "nope"]);
  assert.notEqual(code, 0, `expected non-zero exit, got ${code}`);
  assert.match(stderr, /unknown preset 'nope'/);
});

test("/brand/logo 在 password 模式下不需 cookie 也可存取(避免 login 頁載入失敗)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "readyai-webui-brand-"));
  const logoPath = path.join(dir, "logo.svg");
  writeFileSync(logoPath, "<svg/>");

  const { child, url } = await startServer(
    { PI_WEBUI_PASSWORD: "secret-pw" },
    ["--brand-logo", logoPath],
  );
  try {
    // 確認其他 page 在無 cookie 時會被擋(對比參考)
    const home = await fetch(`${url}/`, { redirect: "manual" });
    assert.equal(home.status, 302);

    // /brand/logo 應該在白名單內,無 cookie 也回 200
    const logo = await fetch(`${url}/brand/logo`, { redirect: "manual" });
    assert.equal(logo.status, 200);
  } finally {
    await stopServer(child);
  }
});

// ── issue #2 P1:模型 registry 找不到 → connected.modelWarning（不再靜默）─────

test("PI_WEBUI_MODEL 在 registry 找不到 → connected payload 帶 modelWarning（含 model 名）", async () => {
  const { child, url } = await startServer({ PI_WEBUI_MODEL: "nonexistent/zzz-model-xyz" });
  try {
    const payload = await getConnectedPayload(url);
    assert.ok(payload.modelWarning, "找不到 model 時應帶 modelWarning");
    assert.match(payload.modelWarning, /zzz-model-xyz/, "非 hideModel：含 model 名便於排查");
  } finally {
    await stopServer(child);
  }
});

test("未指定 PI_WEBUI_MODEL → connected payload.modelWarning 為 null", async () => {
  const { child, url } = await startServer({});
  try {
    const payload = await getConnectedPayload(url);
    assert.equal(payload.modelWarning ?? null, null, "未指定 model 不應有 warning");
  } finally {
    await stopServer(child);
  }
});

test("--hide-model + 找不到 model → modelWarning 不洩漏 model 名稱（對外場景）", async () => {
  const { child, url } = await startServer(
    { PI_WEBUI_MODEL: "nonexistent/zzz-secret-xyz" },
    ["--hide-model"],
  );
  try {
    const payload = await getConnectedPayload(url);
    assert.ok(payload.modelWarning, "仍應有警告");
    assert.doesNotMatch(payload.modelWarning, /zzz-secret-xyz/, "hideModel 不可洩漏 model 名");
  } finally {
    await stopServer(child);
  }
});
