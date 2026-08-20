// test/secret-guard-bash-e2e.test.mjs
// 端到端（不需 model / QEMU）：用真正的 SDK createBashToolDefinition + 本專案 spawnHook/redaction
// 包裝，實跑 local shell，驗 L0（env 白名單根治）與 L3（輸出遮蔽）在真實 bash tool 上生效。
// 對應 spec 2026-07-01 測試策略 #1（L0 env 根治）與 #7（L3 遮蔽）。
import { test } from "node:test";
import assert from "node:assert/strict";

// 先注入假機密到 process.env（bash 子行程預設會繼承——若沒 L0 就會外洩）。
process.env.OPENROUTER_API_KEY = "CANARY_or_secret_abcdef123456";
process.env.PC2_SERVICE_PWS = "CANARY_pc2pws_secret_000000";
process.env.PC2_API_TOKEN = "CANARY_scoped_token_lmnop999"; // L-乙：env 也不該有（走 workspace .env）
process.env.ZYTE_API_KEY = "CANARY_zyte_key_should_pass1"; // L-丙：白名單放行

const { createBashToolDefinition } = await import("@earendil-works/pi-coding-agent");
const { buildBashSpawnHook, wrapToolWithRedaction } = await import("../dist/server/secret-guard.js");
const { buildHostGuardedTools } = await import("../dist/server/guarded-tools.js");

// Pi 0.83 的 bash tool 會從第 5 個參數讀取 session context，注入非機密的
// PI_SESSION_* / PI_MODEL 資訊。fixture 必須模擬真實 runtime，不可再傳空物件。
const toolContext = {
  sessionManager: {
    getSessionId: () => "security-e2e-session",
    getSessionFile: () => undefined,
  },
  model: undefined,
  thinkingLevel: undefined,
};

// 跑一個 bash 指令、收集最終 + 串流輸出。
async function runBash(command) {
  const def = wrapToolWithRedaction(
    createBashToolDefinition(process.cwd(), { spawnHook: buildBashSpawnHook() }),
  );
  let streamed = "";
  const res = await def.execute(
    "t",
    { command },
    undefined,
    (p) => {
      if (Array.isArray(p?.content)) for (const b of p.content) if (b?.text) streamed += b.text;
    },
    toolContext,
  );
  const finalText = (res?.content || []).map((b) => b?.text || "").join("\n");
  return finalText + "\n" + streamed;
}

test("L0 端到端：host bash `env` 只見白名單，L-甲/L-乙 值與 key 名皆不在", async () => {
  const out = await runBash("env");
  // 白名單在
  assert.match(out, /(^|\n)PATH=/, "PATH（白名單）應在");
  assert.match(out, /ZYTE_API_KEY=CANARY_zyte_key_should_pass1/, "ZYTE_API_KEY（L-丙白名單）應放行");
  // L-甲 值不在（根治：連 key 都不繼承）
  assert.ok(!out.includes("CANARY_or_secret_abcdef123456"), "OPENROUTER 值不得外洩");
  assert.ok(!out.includes("CANARY_pc2pws_secret_000000"), "PC2_SERVICE_PWS 值不得外洩");
  assert.ok(!/(^|\n)OPENROUTER_API_KEY=/.test(out), "OPENROUTER key 名不該出現在 env");
  assert.ok(!/(^|\n)PC2_SERVICE_PWS=/.test(out), "PC2_SERVICE_PWS key 名不該出現在 env");
  // L-乙 也不在 env（走 workspace .env）
  assert.ok(!out.includes("CANARY_scoped_token_lmnop999"), "PC2_API_TOKEN 值不該在 bash env");
});

test("L0 端到端：`echo $OPENROUTER_API_KEY` 展開為空（env 中根本沒有）", async () => {
  const out = await runBash('echo "[$OPENROUTER_API_KEY]"');
  assert.match(out, /\[\]/, "變數展開應為空字串");
  assert.ok(!out.includes("CANARY_or_secret_abcdef123456"));
});

test("L3 端到端：bash 輸出若含 L-甲 機密『值』（非 env 來源）→ 被遮成 «REDACTED»", async () => {
  // 直接 echo 一個字面值，剛好等於 process.env.OPENROUTER_API_KEY → L3 redactBlocks 應遮。
  const out = await runBash('echo "leak=CANARY_or_secret_abcdef123456"');
  assert.ok(out.includes("«REDACTED»"), "L-甲 值應被遮");
  assert.ok(!out.includes("CANARY_or_secret_abcdef123456"), "原始機密值不得留在輸出");
});

test("L3 端到端：L-乙 值不在遮蔽範圍（PC2_API_TOKEN 走 workspace .env）", async () => {
  const out = await runBash('echo "token=CANARY_scoped_token_lmnop999"');
  assert.ok(out.includes("CANARY_scoped_token_lmnop999"), "L-乙 值不在 SECRET_ENV_KEYS，不遮");
});

// ── L0 縱深：命令圍欄已掛進 production 工廠 buildHostGuardedTools（非測試自組）──
function hostBash() {
  const tools = buildHostGuardedTools(process.cwd(), process.cwd());
  const bash = tools.find((t) => t?.name === "bash");
  assert.ok(bash, "buildHostGuardedTools 應含 bash 工具");
  return bash;
}
const textOf = (res) => (res?.content || []).map((b) => b?.text || "").join("\n");

test("L0 縱深 端到端：buildHostGuardedTools 的 bash 擋 env 偵察（圍欄已掛進組裝鏈）", async () => {
  const blocked = await hostBash().execute("t", { command: "cat /proc/1/environ" }, undefined, undefined, toolContext);
  assert.equal(blocked.isError, true);
  assert.match(textOf(blocked), /偵察/, "應回偵察 block 訊息、不實際執行");
});

test("L0 縱深 端到端：buildHostGuardedTools 的 bash 放行正當命令（不誤傷）", async () => {
  const out = await hostBash().execute("t", { command: "echo hello-world-ok" }, undefined, undefined, toolContext);
  assert.ok(!out.isError, "正當命令不該被擋");
  assert.match(textOf(out), /hello-world-ok/);
});
