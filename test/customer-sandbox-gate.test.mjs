// test/customer-sandbox-gate.test.mjs
// L2 fail-closed（spec 2026-07-01 測試策略 #4）：customer profile 無 effective sandbox 時
// 必須拒啟（exit 2），不得落回 host bash。--allow-unsafe-customer 才放行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "dist", "server", "index.js");

function makeTmpCwd() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-l2gate-"));
}

const BASE_ENV = {
  PI_WEBUI_PORT: "0",
  PI_WEBUI_PASSWORD: "l2-gate-pw",
  PI_WEBUI_MODEL: "dummy-model",
  OPENROUTER_API_KEY: "dummy-openrouter-key",
  PC2_SERVICE_HOST: "http://localhost:9999",
  PC2_API_TOKEN: "dummy-token",
  PI_WEBUI_BASE_PATH: "/webui",
};

// spawn 後等 process 自己 exit，回傳 { code, stderr }。
function spawnAndWaitExit(cwd, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER, "--listen", "127.0.0.1:0", ...args], {
      cwd,
      env: { ...process.env, ...BASE_ENV, PI_PROJECT_CWD: cwd, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      try { child.kill("SIGKILL"); } catch {}
      resolve({ code, out });
    };
    const onData = (c) => {
      out += c.toString();
      // boot 成功（開始監聽）→ 以 -1 代表「未 fail-closed、成功啟動」，立即收工。
      if (/url=http:\/\/127\.0\.0\.1:\d+/.test(out)) finish(-1);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => finish(code));
    setTimeout(() => finish(-2), 15000);
  });
}

test("L2: customer 無 --sandbox 且無 --allow-unsafe-customer → exit 2 且不啟動", async (t) => {
  const cwd = makeTmpCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { code, out } = await spawnAndWaitExit(cwd, ["--profile", "customer"]);
  assert.equal(code, 2, `應 fail-closed exit 2，實際 code=${code}\n${out.slice(-600)}`);
  assert.match(out, /EFFECTIVE sandbox/, "錯誤訊息應點名 effective sandbox 要求");
  assert.doesNotMatch(out, /url=http:\/\/127\.0\.0\.1:\d+/, "不得成功監聽（不落回 host）");
});

test("L2: customer + --allow-unsafe-customer（無 sandbox）→ 繞過閘門、可啟動", async (t) => {
  const cwd = makeTmpCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { code, out } = await spawnAndWaitExit(cwd, ["--profile", "customer", "--allow-unsafe-customer"]);
  // 繞過後應正常監聽（url= 出現）；本測試以 -1 代表 boot 成功。
  assert.equal(code, -1, `allow-unsafe 應可啟動（boot 成功），實際 code=${code}\n${out.slice(-600)}`);
  assert.match(out, /url=http:\/\/127\.0\.0\.1:\d+/);
});

test("L2: env PI_WEBUI_ALLOW_UNSAFE_CUSTOMER=1 亦可繞過", async (t) => {
  const cwd = makeTmpCwd();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { code } = await spawnAndWaitExit(cwd, ["--profile", "customer"], {
    PI_WEBUI_ALLOW_UNSAFE_CUSTOMER: "1",
  });
  assert.equal(code, -1, `env 繞過應可啟動，實際 code=${code}`);
});
