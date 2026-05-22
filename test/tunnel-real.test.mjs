// 真實 cloudflared 整合測試。預設不跑;TUNNEL_REAL=1 才執行。
// 需要本機有 cloudflared binary + 網路連通。
//
// 用 make test-tunnel 跑。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const enabled = process.env.TUNNEL_REAL === "1";
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "..", "dist", "server", "index.js");

test("real cloudflared: spawn server, wait for URL, fetch /login, shutdown", { skip: !enabled }, async () => {
  const port = 4300;
  const agentDir = mkdtempSync(resolve(tmpdir(), "pi-webui-tunnel-real-"));
  const child = spawn(
    "node",
    [SERVER_PATH, "--listen", `127.0.0.1:${port}`, "--tunnel"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PI_AGENT_DIR: agentDir },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c.toString()));
  child.stderr.on("data", (c) => (stderr += c.toString()));

  try {
    // 等 trycloudflare URL,30s timeout
    const url = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout waiting URL\nstderr:${stderr}`)), 30_000);
      const interval = setInterval(() => {
        const m = stdout.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) {
          clearTimeout(t);
          clearInterval(interval);
          res(m[0]);
        }
      }, 200);
    });

    console.log("tunnel URL:", url);

    // edge 拿 login 頁(server 自動產生密碼,login 頁應該回 200)
    // edge 同步可能需要幾秒,給 retry
    let ok = false;
    for (let i = 0; i < 10 && !ok; i++) {
      const r = await fetch(`${url}/login`).catch(() => null);
      if (r && r.status === 200) {
        ok = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    assert.ok(ok, "edge did not return 200 for /login within 10s");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    rmSync(agentDir, { recursive: true, force: true });
  }
});
