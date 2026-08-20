// 專案信任邊界整合測試：未明確核准時，repo 內的可執行 extension 不得載入。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "dist", "server", "index.js");

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-project-trust-"));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  const marker = path.join(root, "extension-loaded");
  const extensionDir = path.join(cwd, ".pi", "extensions");
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(extensionDir, "security-probe.ts"),
    [
      'import fs from "node:fs";',
      "export default function securityProbe() {",
      '  fs.writeFileSync(process.env.PI_WEBUI_PROJECT_TRUST_MARKER, "loaded");',
      "}",
      "",
    ].join("\n"),
  );
  return { root, cwd, agentDir, marker };
}

function startServer(fixture, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SERVER, "--listen", "127.0.0.1:0", ...args],
      {
        cwd: fixture.cwd,
        env: {
          ...process.env,
          PI_AGENT_DIR: fixture.agentDir,
          PI_WEBUI_PROJECT_TRUST_MARKER: fixture.marker,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    let settled = false;
    const onChunk = (chunk) => {
      output += chunk.toString();
      const match = output.match(/url=(http:\/\/127\.0\.0\.1:\d+)/);
      if (match && !settled) {
        settled = true;
        resolve({ child, url: match[1] });
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("exit", (code) => {
      if (!settled) reject(new Error(`server exited code=${code}: ${output.slice(0, 1000)}`));
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`server start timeout: ${output.slice(-1000)}`));
    }, 15000);
  });
}

function connectAndReady(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http:/, "ws:") + "/ws");
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("connected packet timeout"));
    }, 10000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "ready", lastSeq: null, sessionFile: null }));
    });
    ws.on("message", (data) => {
      const packet = JSON.parse(String(data));
      if (packet.type !== "connected") return;
      clearTimeout(timer);
      ws.close();
      resolve();
    });
    ws.on("error", reject);
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, 2000);
  });
}

test("未明確核准的 repo 不會執行 project-local extension", async () => {
  const fixture = makeFixture();
  let server;
  try {
    server = await startServer(fixture);
    await connectAndReady(server.url);
    assert.equal(
      fs.existsSync(fixture.marker),
      false,
      "未核准 repo 的 .pi/extensions 不得在 server process 執行",
    );
  } finally {
    await stopServer(server?.child);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("--approve 才會載入 project-local extension", async () => {
  const fixture = makeFixture();
  let server;
  try {
    server = await startServer(fixture, ["--approve"]);
    await connectAndReady(server.url);
    assert.equal(
      fs.readFileSync(fixture.marker, "utf8"),
      "loaded",
      "顯式核准後應載入 repo 的 .pi/extensions",
    );
  } finally {
    await stopServer(server?.child);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("--approve 與 --no-approve 互斥並 fail-fast", async () => {
  const fixture = makeFixture();
  try {
    await assert.rejects(
      startServer(fixture, ["--approve", "--no-approve"]),
      /cannot be used together/,
    );
    assert.equal(fs.existsSync(fixture.marker), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
