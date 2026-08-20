// test/secret-guard-sandbox-vm.test.mjs
// 真實 Gondolin VM 的機密隔離整合測試（對應 spec 2026-07-01 測試策略 #2/#5/#6、E2E A 組紅線）。
// 直接呼叫 production 工廠 buildSandboxGuardedTools（server 用的同一份），boot 真 VM，
// 透過 sandbox bash / read 工具實測 env 隔離與 workspace .env 禁讀邊界。
//
// 預設不跑（需 QEMU + Gondolin，~1s 開機）。要跑：SANDBOX_VM=1 node --test test/secret-guard-sandbox-vm.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const RUN = process.env.SANDBOX_VM === "1";

// 假機密（模擬主機 process.env 上的 production 機密）。在 import 前設好。
const L_JIA = {
  OPENROUTER_API_KEY: "VMCANARY_openrouter_abcdef123456",
  PI_WEBUI_PASSWORD: "VMCANARY_password_998877665544",
  PC2_SERVICE_PWS: "VMCANARY_pc2pws_master_00112233",
  R2_ACCESS_KEY_ID: "VMCANARY_r2akid_00001111222233",
  R2_SECRET_ACCESS_KEY: "VMCANARY_r2secret_4444555566667",
};
const L_YI_TOKEN = "VMCANARY_scoped_pc2token_7788990"; // L-乙：走 workspace .env，不該在 env
const L_BING_ZYTE = "VMCANARY_zyte_key_should_pass_00"; // L-丙：白名單放行
for (const [k, v] of Object.entries(L_JIA)) process.env[k] = v;
process.env.PC2_API_TOKEN = L_YI_TOKEN;
process.env.ZYTE_API_KEY = L_BING_ZYTE;

const { Sandbox } = await import("../dist/server/sandbox.js");
const { buildSandboxGuardedTools } = await import("../dist/server/guarded-tools.js");

const toolContext = {
  sessionManager: {
    getSessionId: () => "secret-guard-sandbox-vm",
    getSessionFile: () => undefined,
  },
  model: undefined,
  thinkingLevel: undefined,
};

function byName(tools, name) {
  const t = tools.find((x) => x && x.name === name);
  if (!t) throw new Error(`tool ${name} not found in [${tools.map((x) => x?.name).join(",")}]`);
  return t;
}

// 跑一個工具、收集最終 + 串流輸出文字。
async function runTool(tool, params) {
  let streamed = "";
  const res = await tool.execute(
    "tc",
    params,
    undefined,
    (p) => {
      if (Array.isArray(p?.content)) for (const b of p.content) if (b?.text) streamed += b.text;
    },
    toolContext,
  );
  const finalText = (res?.content || []).map((b) => b?.text || "").join("\n");
  return { text: finalText + "\n" + streamed, isError: !!res?.isError };
}

test("[opt-in] 真 VM：sandbox env 隔離、偵察阻擋與 workspace .env 禁讀邊界", { skip: !RUN }, async (t) => {
  Sandbox.ensureQemuInstalled();

  // host workspace：塞 .env（僅 L-乙 scoped token，無 L-甲 PWS）＋一個一般檔。
  const ws = mkdtempSync(path.join(tmpdir(), "sg-vm-ws-"));
  writeFileSync(path.join(ws, ".env"), `PC2_API_TOKEN=${L_YI_TOKEN}\nPC2_SERVICE_HOST=https://pc2.example.com\n`);
  writeFileSync(path.join(ws, "app.txt"), "hello workspace");
  // host workspace 外的機密（模擬 ~/.ssh/id_rsa），VM 不 mount → 取不到。
  const outside = mkdtempSync(path.join(tmpdir(), "sg-vm-secret-"));
  const hostSecretPath = path.join(outside, "id_rsa");
  writeFileSync(hostSecretPath, "HOSTCANARY_private_key_do_not_leak");

  const sandbox = new Sandbox({ workspaceRoot: ws });
  t.after(async () => {
    await sandbox.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  await sandbox.ensure();

  const tools = buildSandboxGuardedTools(sandbox, ws, sandbox.workspaceRoot);
  const bash = byName(tools, "bash");
  const read = byName(tools, "read");

  // 1) 不繞過 production command guard；只探測已知變數是否存在，不列舉整份 env。
  const env = await runTool(bash, {
    command: [
      "printf 'READYAI_SANDBOX_MODE=%s\\n' \"$READYAI_SANDBOX_MODE\"",
      "printf 'PATH_PRESENT=%s\\n' \"${PATH:+1}\"",
      "printf 'OPENROUTER_API_KEY_PRESENT=%s\\n' \"${OPENROUTER_API_KEY:+1}\"",
      "printf 'PI_WEBUI_PASSWORD_PRESENT=%s\\n' \"${PI_WEBUI_PASSWORD:+1}\"",
      "printf 'PC2_SERVICE_PWS_PRESENT=%s\\n' \"${PC2_SERVICE_PWS:+1}\"",
      "printf 'R2_ACCESS_KEY_ID_PRESENT=%s\\n' \"${R2_ACCESS_KEY_ID:+1}\"",
      "printf 'R2_SECRET_ACCESS_KEY_PRESENT=%s\\n' \"${R2_SECRET_ACCESS_KEY:+1}\"",
      "printf 'PC2_API_TOKEN_PRESENT=%s\\n' \"${PC2_API_TOKEN:+1}\"",
    ].join("; "),
  });
  assert.equal(env.isError, false, "單一已知變數探測不應被當成 env enumeration");
  for (const [k, v] of Object.entries(L_JIA)) {
    assert.ok(!env.text.includes(v), `L-甲 ${k} 值外洩進 VM env！`);
    assert.match(env.text, new RegExp(`(^|\\n)${k}_PRESENT=(\\n|$)`), `L-甲 ${k} 應為 unset`);
  }
  assert.ok(!env.text.includes(L_YI_TOKEN), "L-乙 PC2_API_TOKEN 值不該在 VM env（走檔案）");
  assert.match(env.text, /(^|\n)PC2_API_TOKEN_PRESENT=(\n|$)/, "PC2_API_TOKEN 應為 unset");
  // spawnHook 注入的 sandbox 模式旗標必須在（證明第二條 per-exec env 路徑走了我們的 hook）。
  assert.match(env.text, /(^|\n)READYAI_SANDBOX_MODE=1(\n|$)/, "READYAI_SANDBOX_MODE=1 應由 spawnHook 注入");
  assert.match(env.text, /(^|\n)PATH_PRESENT=1(\n|$)/, "PATH（白名單）應在");

  // 2) A 組 env grep 必禁（spec E2E A）——command guard 必須直接拒絕。
  const grep = await runTool(bash, {
    command: "env | grep -oE '^(OPENROUTER_API_KEY|R2_SECRET_ACCESS_KEY|R2_ACCESS_KEY_ID|PI_WEBUI_PASSWORD|PC2_SERVICE_PWS|PC2_API_TOKEN)=' | sed 's/=.*//' | sort",
  });
  assert.equal(grep.isError, true, "env enumeration 應被 command guard 擋下");
  assert.match(grep.text, /環境\/機密偵察|env enumeration/, "應回明確偵察拒絕訊息");

  // 3) bash 不得偵察 workspace .env；技能需要時必須走下方有 L1/L3 的 read tool。
  const envfile = await runTool(bash, { command: "cat /workspace/.env" });
  assert.equal(envfile.isError, true, "bash cat .env 應被 command guard 擋下");
  assert.match(envfile.text, /環境\/機密偵察|\.env recon/);
  assert.doesNotMatch(envfile.text, /VMCANARY_/, "拒絕訊息不得帶出任何 token 值");

  // 4) host workspace 外機密：VM 未 mount，bash cat 取不到（無 HOSTCANARY）。
  const hostcat = await runTool(bash, { command: `cat ${hostSecretPath} 2>&1 || true` });
  assert.ok(!hostcat.text.includes("HOSTCANARY_private_key_do_not_leak"), "host workspace 外機密不得在 VM 內讀到");

  // 5) read 工具（L1 圍欄）：workspace .env 與 workspace 外主機機密都必須被擋。
  const readEnv = await runTool(read, { path: ".env" });
  assert.equal(readEnv.isError, true, "read 也不得取得 workspace .env scoped token");
  assert.match(readEnv.text, /\.env（含 workspace token）/);
  assert.doesNotMatch(readEnv.text, /VMCANARY_/, "read 拒絕訊息不得帶出 token 值");

  const readOutside = await runTool(read, { path: hostSecretPath });
  assert.ok(readOutside.isError, "read workspace 外主機機密應 block（isError）");
  assert.ok(!readOutside.text.includes("HOSTCANARY_private_key_do_not_leak"), "read 圍欄不得洩漏 workspace 外內容");
});

// 真 customer image（readyai-sandbox）：驗證 B 組功能面的 env 依賴——readyAI CLI 走
// load_env_with_fallback() 從 mounted workspace .env 讀 scoped token，而 L-甲 不在 env。
// 需提供 image 名：SANDBOX_VM=1 READYAI_SANDBOX_IMAGE=readyai-sandbox:<tag> node --test ...
const READYAI_IMAGE = process.env.READYAI_SANDBOX_IMAGE;
test("[opt-in] 真 customer image：readyai CLI 從 workspace .env 讀 token、env 無 L-甲", { skip: !RUN || !READYAI_IMAGE }, async (t) => {
  Sandbox.ensureQemuInstalled();
  const ws = mkdtempSync(path.join(tmpdir(), "sg-vm-readyai-"));
  writeFileSync(path.join(ws, ".env"), `PC2_API_TOKEN=${L_YI_TOKEN}\nPC2_SERVICE_HOST=https://pc2.example.com\n`);

  const sandbox = new Sandbox({ workspaceRoot: ws, image: READYAI_IMAGE });
  t.after(async () => {
    await sandbox.close();
    rmSync(ws, { recursive: true, force: true });
  });
  await sandbox.ensure();

  const tools = buildSandboxGuardedTools(sandbox, ws, sandbox.workspaceRoot);
  const bash = byName(tools, "bash");

  // L-甲 不外洩 + spawnHook 注入 SANDBOX_MODE。
  const env = await runTool(bash, {
    command: "printf 'READYAI_SANDBOX_MODE=%s\\nOPENROUTER_API_KEY_PRESENT=%s\\nPC2_API_TOKEN_PRESENT=%s\\n' \"$READYAI_SANDBOX_MODE\" \"${OPENROUTER_API_KEY:+1}\" \"${PC2_API_TOKEN:+1}\"",
  });
  for (const [k, v] of Object.entries(L_JIA)) assert.ok(!env.text.includes(v), `L-甲 ${k} 值不得進 VM env`);
  assert.match(env.text, /(^|\n)READYAI_SANDBOX_MODE=1(\n|$)/);
  assert.match(env.text, /(^|\n)OPENROUTER_API_KEY_PRESENT=(\n|$)/);
  assert.match(env.text, /(^|\n)PC2_API_TOKEN_PRESENT=(\n|$)/);

  // 關鍵鏈：env 沒有 token（L0 剝掉），但 workspace .env 有；readyAI CLI 自檔案讀。
  const probe = await runTool(bash, {
    command:
      "cd /workspace && python3 -c \"import os; from pathlib import Path; print('ENV_TOKEN='+str(bool(os.environ.get('PC2_API_TOKEN')))); print('FILE_TOKEN='+str('PC2_API_TOKEN' in Path('.env').read_text()))\"",
  });
  assert.match(probe.text, /ENV_TOKEN=False/, "L0 應把 PC2_API_TOKEN 從 env 剝掉");
  assert.match(probe.text, /FILE_TOKEN=True/, "workspace .env 應保有 scoped token 供 CLI 讀");

  // readyai-db 存在且 load_env_with_fallback 從 /workspace/.env 載入。
  const dbHelp = await runTool(bash, { command: "cd /workspace && readyai-db --help 2>&1 | head -20" });
  assert.match(dbHelp.text, /已從 \/workspace\/\.env 載入|ReadyScript Database Manager|Usage: readyai-db/, "readyai-db 應在 image 內並讀 workspace .env");
});
