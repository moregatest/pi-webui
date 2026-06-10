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
import { Resolver } from "node:dns/promises";

const enabled = process.env.TUNNEL_REAL === "1";
const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = resolve(__dirname, "..", "dist", "server", "index.js");

test("real cloudflared: spawn server, wait for URL, fetch /login, shutdown", { skip: !enabled }, async () => {
  const port = 4300;
  const agentDir = mkdtempSync(resolve(tmpdir(), "readyai-webui-tunnel-real-"));
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
    // 實測 trycloudflare edge 同步要 ~5-15 秒,DNS propagation 偶爾更久。
    // 先等 DNS 解得到再開始 HTTP retry,避免 fetch 卡在 connect timeout。
    //
    // 注意:走專屬 Resolver 直接打 1.1.1.1 / 8.8.8.8,避開 Node 預設 resolver
    // 可能被 Tailscale (100.100.100.100) / mDNSResponder 攔截導致 ENOTFOUND。
    const resolver = new Resolver();
    resolver.setServers(["1.1.1.1", "8.8.8.8"]);
    const hostname = new URL(url).hostname;
    const dnsDeadline = Date.now() + 60_000;
    let dnsReady = false;
    let lastDnsErr = "";
    while (!dnsReady && Date.now() < dnsDeadline) {
      try {
        await resolver.resolve4(hostname);
        dnsReady = true;
        break;
      } catch (e) {
        lastDnsErr = e?.code ?? e?.message ?? String(e);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    assert.ok(dnsReady, `DNS for ${hostname} did not resolve within 60s (last: ${lastDnsErr})`);

    const httpDeadline = Date.now() + 60_000;
    let lastStatus = "no response";
    let ok = false;
    while (!ok && Date.now() < httpDeadline) {
      const r = await fetch(`${url}/login`).catch((e) => {
        lastStatus = `fetch error: ${e.cause?.code ?? e.message}`;
        return null;
      });
      if (r) {
        lastStatus = `status=${r.status}`;
        if (r.status === 200) {
          ok = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!ok) {
      console.error(`[diagnostic] child.killed=${child.killed} exitCode=${child.exitCode} signalCode=${child.signalCode}`);
      console.error(`[diagnostic] stdout length=${stdout.length} stderr length=${stderr.length}`);
      console.error(`[diagnostic] server stdout FULL:\n${stdout}`);
      console.error(`[diagnostic] server stderr FULL:\n${stderr}`);
    }
    assert.ok(ok, `edge did not return 200 for /login within 60s after DNS ready (last: ${lastStatus})`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
    rmSync(agentDir, { recursive: true, force: true });
  }
});
