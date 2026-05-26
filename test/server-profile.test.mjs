// 整合測試:驗證 --profile 旗標載入 .pi/profiles/<name>.toml 的行為。
// 涵蓋:不存在 profile exit 非 0、customer 內建 fallback、fixture 套用、CLI flag override。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "dist", "server", "index.js");
const FIXTURES = path.join(__dirname, "fixtures", "profiles");

// 建立暫時工作目錄,並選擇性複製 fixture 進 .pi/profiles/<profileName>.toml
function makeCwd(profileName, fixtureFile) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  if (fixtureFile) {
    const dir = path.join(tmp, ".pi", "profiles");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(
      path.join(FIXTURES, fixtureFile),
      path.join(dir, `${profileName}.toml`),
    );
  }
  return tmp;
}

// spawn server,等到 log 出現 url=http://127.0.0.1:<port> 後 resolve。
function startServer(cwd, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SERVER, "--listen", "127.0.0.1:0", ...args],
      {
        cwd,
        env: { ...process.env, PI_WEBUI_PORT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    let stdout = "";
    let resolved = false;
    const onChunk = (chunk, sink) => {
      const text = chunk.toString();
      if (sink === "err") stderr += text;
      else stdout += text;
      const m = (stderr + stdout).match(/url=(http:\/\/127\.0\.0\.1:\d+)/);
      if (m && !resolved) {
        resolved = true;
        resolve({ child, url: m[1], getStderr: () => stderr });
      }
    };
    child.stderr.on("data", (c) => onChunk(c, "err"));
    child.stdout.on("data", (c) => onChunk(c, "out"));
    child.on("exit", (code) => {
      if (!resolved)
        reject(new Error(`server exited code=${code}\nstderr: ${stderr}\nstdout: ${stdout}`));
    });
    setTimeout(() => {
      if (!resolved) {
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error(`server start timeout\nstderr: ${stderr.slice(-500)}\nstdout: ${stdout.slice(-500)}`));
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

// 連 WS 收 connected packet,回傳 payload。
function getConnected(url) {
  return new Promise((resolve, reject) => {
    const wsUrl = url.replace(/^http:/, "ws:") + "/ws";
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("connected packet timeout"));
    }, 8000);
    ws.on("open", () => {
      // server 須收到 ready packet 才會送 connected;此為必要握手步驟
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

// spawn 後等 process 自己 exit,用於 fail-fast 測試。
function spawnAndWaitExit(cwd, args = []) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [SERVER, "--listen", "127.0.0.1:0", ...args],
      {
        cwd,
        env: { ...process.env, PI_WEBUI_PORT: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    const t = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, 8000);
    child.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code, stderr });
    });
  });
}

test("--profile <不存在> exit 非 0", async (t) => {
  const cwd = makeCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { code, stderr } = await spawnAndWaitExit(cwd, ["--profile", "nope"]);
  assert.notEqual(code, 0, `expected non-zero exit, got ${code}`);
  assert.match(stderr, /profile not found/);
});

test("--profile customer 無檔走內建 fallback", async (t) => {
  const cwd = makeCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { child, url } = await startServer(cwd, ["--profile", "customer"]);
  try {
    const payload = await getConnected(url);
    assert.equal(payload.uiProfile.hideThinking, true);
    assert.equal(payload.uiProfile.hideToolCalls, true);
    assert.equal(payload.uiProfile.safeErrors, true);
  } finally {
    await stopServer(child);
  }
});

test("--profile staff 套用 fixture 內容", async (t) => {
  const cwd = makeCwd("staff", "integration-staff.toml");
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { child, url } = await startServer(cwd, ["--profile", "staff"]);
  try {
    const payload = await getConnected(url);
    assert.equal(payload.uiProfile.hideThinking, true);
    assert.equal(payload.uiProfile.hideToolCalls, true);
    assert.equal(payload.uiProfile.showToolProgress, true);
    assert.equal(payload.uiProfile.hideModel, true);
    assert.equal(payload.uiProfile.brand.name, "Integration Staff");
    // serializeUiProfile 把 tokens.accent 轉為 brand.color
    assert.equal(payload.uiProfile.brand.color, "#0066cc");
  } finally {
    await stopServer(child);
  }
});

test("個別 CLI flag override profile", async (t) => {
  const cwd = makeCwd("staff", "integration-staff.toml");
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { child, url } = await startServer(cwd, ["--profile", "staff", "--brand-name", "Override"]);
  try {
    const payload = await getConnected(url);
    assert.equal(payload.uiProfile.brand.name, "Override");
  } finally {
    await stopServer(child);
  }
});

test("profile [skills].allow 與 .pi/skills-allow.txt 同存 → 印 override 警告", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, ".pi", "profiles"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "skills-allow.txt"), "old-skill\n");
  fs.writeFileSync(
    path.join(cwd, ".pi", "profiles", "staff.toml"),
    `[skills]\nallow = ["new-skill"]\n`,
  );
  const { child, getStderr } = await startServer(cwd, ["--profile", "staff"]);
  try {
    // warn log 在 server listening 之前產生,startServer resolve 時已在 stderr 中
    await new Promise((r) => setTimeout(r, 500));
    assert.match(getStderr(), /profile \[skills\]\.allow override/);
  } finally {
    await stopServer(child);
  }
});

test("profile [defaults].model 啟動套用,但 --model CLI 勝", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, ".pi", "profiles"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, ".pi", "profiles", "staff.toml"),
    `[defaults]\nmodel = "anthropic/claude-opus-4-7"\n`,
  );

  // case 1: profile 套用 → cliModelPattern = "anthropic/claude-opus-4-7"
  // 驗證方法:model 若不在 registry 會印 "model not found in registry: <pattern>"
  // 此警告出現表示 profile 的 model 確實被套用為 cliModelPattern。
  {
    const { child, url, getStderr } = await startServer(cwd, ["--profile", "staff"]);
    try {
      await getConnected(url);
      // resolveCliModel 在 createRuntime 時執行,session 建立後才跑
      await new Promise((r) => setTimeout(r, 1500));
      // 若 model 在 registry 中存在,session bound 的 model 欄位會帶正確值;
      // 若不在 registry,會印 "model not found in registry: anthropic/claude-opus-4-7"。
      // 兩種情況都可驗證 cliModelPattern 被正確設定。
      const stderr = getStderr();
      const modelFromProfile = "anthropic/claude-opus-4-7";
      const modelApplied =
        // 不在 registry → 印警告
        stderr.includes(`model not found in registry: ${modelFromProfile}`) ||
        // 在 registry → session bound 帶 model 值
        /session bound.*model=anthropic\/claude-opus-4-7/.test(stderr);
      assert.ok(modelApplied, `profile model 應被套用,但 stderr 未見預期輸出:\n${stderr}`);
    } finally {
      await stopServer(child);
    }
  }

  // case 2: CLI --model 優先於 profile → cliModelPattern = "anthropic/claude-haiku-4-5"
  {
    const { child, url, getStderr } = await startServer(
      cwd,
      ["--profile", "staff", "--model", "anthropic/claude-haiku-4-5"],
    );
    try {
      await getConnected(url);
      await new Promise((r) => setTimeout(r, 1500));
      const stderr = getStderr();
      const cliModel = "anthropic/claude-haiku-4-5";
      const profileModel = "anthropic/claude-opus-4-7";
      // cliModelPattern 應為 CLI 指定的 haiku,而非 profile 的 opus
      const cliModelApplied =
        stderr.includes(`model not found in registry: ${cliModel}`) ||
        new RegExp(`session bound.*model=anthropic/claude-haiku-4-5`).test(stderr);
      const profileModelNotUsed = !stderr.includes(`model not found in registry: ${profileModel}`);
      assert.ok(cliModelApplied, `CLI model 應被套用,但 stderr 未見預期輸出:\n${stderr}`);
      assert.ok(profileModelNotUsed, `profile model 不應出現在 cliModelPattern:\n${stderr}`);
    } finally {
      await stopServer(child);
    }
  }
});
