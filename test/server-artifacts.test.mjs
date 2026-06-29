import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 最小合法 1x1 紅色 PNG（89 bytes）
const MINIMAL_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
  "2e00000000c49444154789c6260f8cfc00000000200016b4617b0000000049454e44ae426082",
  "hex",
);

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

// 建立臨時 artifacts 目錄
const artifactsDir = join(tmpdir(), `pi-webui-artifacts-test-${Date.now()}`);
mkdirSync(artifactsDir, { recursive: true });
writeFileSync(join(artifactsDir, "screenshot.png"), MINIMAL_PNG);

after(() => {
  try { rmSync(artifactsDir, { recursive: true, force: true }); } catch {}
});

test("GET /artifacts/screenshot.png 回 200 image/png", async () => {
  const { child, url } = await startServer({ PI_WEBUI_ARTIFACTS_DIR: artifactsDir });
  try {
    const res = await fetch(`${url}/artifacts/screenshot.png`);
    assert.equal(res.status, 200);
    const ct = res.headers.get("content-type");
    assert.ok(ct && ct.includes("image/png"), `content-type=${ct}`);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(buf, MINIMAL_PNG);
  } finally {
    await stopServer(child);
  }
});

test("GET /artifacts/../../../etc/passwd 被拒（path traversal）", async () => {
  const { child, url } = await startServer({ PI_WEBUI_ARTIFACTS_DIR: artifactsDir });
  try {
    // fetch 對 .. 會先 normalize，用 %2e%2e 繞過 client-side normalization
    const res = await fetch(`${url}/artifacts/%2e%2e%2fetc%2fpasswd`);
    // 應回 403 或 404，不可回 200
    assert.ok(res.status === 403 || res.status === 404, `status=${res.status}`);
  } finally {
    await stopServer(child);
  }
});

test("GET /artifacts/nonexistent.png 回 404", async () => {
  const { child, url } = await startServer({ PI_WEBUI_ARTIFACTS_DIR: artifactsDir });
  try {
    const res = await fetch(`${url}/artifacts/nonexistent.png`);
    assert.equal(res.status, 404);
  } finally {
    await stopServer(child);
  }
});

test("GET /artifacts/malware.exe 回 404（非 .png 拒絕）", async () => {
  const { child, url } = await startServer({ PI_WEBUI_ARTIFACTS_DIR: artifactsDir });
  try {
    const res = await fetch(`${url}/artifacts/malware.exe`);
    assert.equal(res.status, 404);
  } finally {
    await stopServer(child);
  }
});
