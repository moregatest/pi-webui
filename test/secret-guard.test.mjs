// test/secret-guard.test.mjs
// 對應 spec 2026-07-01-agent-secret-isolation-design 的 L0/L1/L3 純函式與 tool 包裝。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ENV_ALLOWLIST,
  filterBashEnv,
  parseEnvAllowList,
  buildBashSpawnHook,
  guardReadPath,
  SECRET_ENV_KEYS,
  collectSecretValues,
  redactText,
  redactBlocks,
  REDACTION_PLACEHOLDER,
  wrapReadWithGuard,
  wrapToolWithRedaction,
  guardBashCommand,
  wrapBashWithCommandGuard,
} from "../dist/server/secret-guard.js";

// 一組跨層共用的假機密（模擬 process.env 中的 L-甲/L-乙）。
const FAKE_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/agent",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  ZYTE_API_KEY: "zyte-key-1234567890", // L-丙：白名單放行
  PI_PROJECT_CWD: "/workspace",
  // L-甲（禁止進 bash env）
  OPENROUTER_API_KEY: "or-secret-abcdef123456",
  PI_WEBUI_PASSWORD: "sup3rsecretpassword",
  PC2_SERVICE_PWS: "pc2-master-pw-secret-xyz",
  R2_ACCESS_KEY_ID: "R2ACCESSKEYID000001",
  R2_SECRET_ACCESS_KEY: "R2SECRETACCESSKEY0000001",
  // L-乙 但在 process.env（per-preview virtual key；PRD story 12：L3 要遮、L0 不放行）
  LITELLM_API_KEY: "sk-litellm-virtual-abcdef123456",
  LITELLM_BASE_URL: "http://readyai-litellm-proxy.internal:4001",
  // L-乙（走 workspace .env，不進 bash env）
  PC2_API_TOKEN: "scoped-token-abcdef123456",
  PC2_SERVICE_HOST: "https://pc2.example.com",
  PI_PREVIEW_PUBLIC_URL: "https://preview.example.com",
};

// ───────────────────────── L0：filterBashEnv ─────────────────────────

test("L0: filterBashEnv 只保留白名單，L-甲/L-乙 全被剝除", () => {
  const out = filterBashEnv(FAKE_ENV);
  // 白名單在
  assert.equal(out.PATH, "/usr/bin:/bin");
  assert.equal(out.HOME, "/home/agent");
  assert.equal(out.LANG, "en_US.UTF-8");
  assert.equal(out.LC_ALL, "en_US.UTF-8"); // LC_ 前綴
  assert.equal(out.ZYTE_API_KEY, "zyte-key-1234567890"); // L-丙 放行
  assert.equal(out.PI_PROJECT_CWD, "/workspace");
  // L-甲 全無
  for (const k of ["OPENROUTER_API_KEY", "PI_WEBUI_PASSWORD", "PC2_SERVICE_PWS", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
    assert.equal(out[k], undefined, `L-甲 ${k} 不該出現在 bash env`);
  }
  // L-乙 也不進 env（走 workspace .env）
  for (const k of ["PC2_API_TOKEN", "PC2_SERVICE_HOST", "PI_PREVIEW_PUBLIC_URL"]) {
    assert.equal(out[k], undefined, `L-乙 ${k} 不該出現在 bash env`);
  }
});

test("L0: sandbox=true 注入 READYAI_SANDBOX_MODE=1，host（預設）不注入", () => {
  assert.equal(filterBashEnv(FAKE_ENV, { sandbox: true }).READYAI_SANDBOX_MODE, "1");
  assert.equal(filterBashEnv(FAKE_ENV).READYAI_SANDBOX_MODE, undefined);
});

test("L0: extraAllow 可額外放行非機密 key（PI_WEBUI_BASH_ENV_ALLOW 用途）", () => {
  const env = { ...FAKE_ENV, MY_CUSTOM_FLAG: "yes" };
  assert.equal(filterBashEnv(env).MY_CUSTOM_FLAG, undefined);
  assert.equal(filterBashEnv(env, { extraAllow: ["MY_CUSTOM_FLAG"] }).MY_CUSTOM_FLAG, "yes");
});

test("L0: undefined 值不進 output", () => {
  const out = filterBashEnv({ PATH: "/bin", HOME: undefined });
  assert.equal(out.PATH, "/bin");
  assert.ok(!("HOME" in out));
});

test("L0: parseEnvAllowList 逗號/空白分隔", () => {
  assert.deepEqual(parseEnvAllowList("A,B , C\nD"), ["A", "B", "C", "D"]);
  assert.deepEqual(parseEnvAllowList(""), []);
  assert.deepEqual(parseEnvAllowList(undefined), []);
});

test("L0: buildBashSpawnHook 回傳過濾後的 ctx.env（host + sandbox 兩路徑共用同一核心）", () => {
  const hostHook = buildBashSpawnHook({ env: {} });
  const ctx = { command: "printenv", cwd: "/workspace", env: FAKE_ENV };
  const hostOut = hostHook(ctx);
  assert.equal(hostOut.command, "printenv");
  assert.equal(hostOut.cwd, "/workspace");
  assert.equal(hostOut.env.OPENROUTER_API_KEY, undefined);
  assert.equal(hostOut.env.PC2_SERVICE_PWS, undefined);
  assert.equal(hostOut.env.PATH, "/usr/bin:/bin");
  assert.equal(hostOut.env.READYAI_SANDBOX_MODE, undefined);

  const sbHook = buildBashSpawnHook({ sandbox: true, env: {} });
  const sbOut = sbHook(ctx);
  assert.equal(sbOut.env.OPENROUTER_API_KEY, undefined);
  assert.equal(sbOut.env.PC2_API_TOKEN, undefined);
  assert.equal(sbOut.env.READYAI_SANDBOX_MODE, "1");
});

test("L0: buildBashSpawnHook 自 PI_WEBUI_BASH_ENV_ALLOW 讀 extraAllow", () => {
  const hook = buildBashSpawnHook({ env: { PI_WEBUI_BASH_ENV_ALLOW: "FOO,BAR" } });
  const out = hook({ command: "x", cwd: "/w", env: { FOO: "1", BAR: "2", OPENROUTER_API_KEY: "s" } });
  assert.equal(out.env.FOO, "1");
  assert.equal(out.env.BAR, "2");
  assert.equal(out.env.OPENROUTER_API_KEY, undefined);
});

test("L0: ENV_ALLOWLIST 不含任何 L-甲/L-乙 key（防回歸）", () => {
  for (const k of [...SECRET_ENV_KEYS, "PC2_API_TOKEN"]) {
    assert.ok(!ENV_ALLOWLIST.has(k), `${k} 不該在 ENV_ALLOWLIST`);
  }
});

// ─────────────────── L0 縱深：guardBashCommand 命令圍欄 ───────────────────
// 定位：L2（VM 硬邊界）在 Fly 無 KVM 缺席下的 in-process 縱深補強，抬高「直接讀
// 主行程 /proc/environ + printenv/env 列舉」的門檻。deny-list 本質可被變數拼接/字元
// 插入繞過（p=printenv;$p），非根治——根治仍靠部署隔離（L-甲 不進機器）。

test("guardBashCommand: env 偵察命令一律 block（縱深、抬高門檻）", () => {
  const recon = [
    "printenv",
    "printenv OPENROUTER_API_KEY",
    "env",
    "env | grep KEY",
    "env|sort",
    "env -0",
    "cat /proc/self/environ",
    "cat /proc/1/environ",
    "cat /proc/12345/environ",
    "cat /proc/thread-self/environ",
    "strings /proc/self/environ",
    "head -c 200 /proc/1/environ",
    "grep -a OPENROUTER /proc/1/environ",
    "xargs -0 < /proc/1/environ",
    "od -c /proc/1/environ",
    "cat /proc/self/cmdline",
    "export -p",
    "declare -p",
    "typeset -p",
    "compgen -v",
    "set",
  ];
  for (const cmd of recon) {
    assert.equal(guardBashCommand(cmd).block, true, `應 block: ${cmd}`);
  }
});

test("guardBashCommand: 正當 customer 協作命令放行（不誤傷）", () => {
  const ok = [
    "ls -la",
    "cat package.json",
    "cat ./src/app.js",
    "readyai-db query --lang en",
    "readyai-screenshot https://preview.example.com",
    "env FOO=bar readyai-db query", // env 設變數執行（非列舉）
    "MYVAR=1 env node script.js", // env 執行命令（非列舉）
    "env -i node script.js", // 清空環境執行（非列舉、不印到 stdout）
    "set -e",
    "set -o pipefail",
    "set +x",
    "set -- a b c",
    "export FOO=bar",
    "declare -a arr",
    "grep environ ./notes.md", // 字面 environ、非 /proc
    "echo hello",
    "printf '%s' done",
  ];
  for (const cmd of ok) {
    assert.equal(guardBashCommand(cmd).block, false, `不該 block: ${cmd}`);
  }
});

// ───────────────────────── L1：guardReadPath ─────────────────────────

test("L1: read 圍欄 — workspace 內放行、外部/proc/symlink 擋", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-ws-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sg-out-"));
  try {
    const realRoot = fs.realpathSync(root);
    fs.writeFileSync(path.join(realRoot, "app.js"), "x");
    fs.mkdirSync(path.join(realRoot, "sub"));
    fs.writeFileSync(path.join(realRoot, "sub", "b.txt"), "y");
    fs.writeFileSync(path.join(realRoot, ".env"), "PC2_API_TOKEN=scoped"); // workspace 自身 .env 應放行
    const secret = path.join(fs.realpathSync(outside), "id_rsa");
    fs.writeFileSync(secret, "PRIVATE");

    // 註：realRoot 與 outside 都建在 os.tmpdir() 底下，guardReadPath 預設放行 TMPDIR
    // （spec 設計：staged 上傳/暫存檔可讀）。故「workspace 外」的純邊界斷言用 tmpDir:null
    // 隔離 TMPDIR 例外，只驗 workspace 邊界本身。紅線主機機密（~/.ssh、server .env、/proc）
    // 本就不在 TMPDIR，預設 tmpDir 下也一定擋（見下方 /etc/passwd 與 /proc 斷言）。
    const NO_TMP = { tmpDir: null };

    // workspace 內
    assert.equal(guardReadPath(realRoot, realRoot, "app.js").block, false);
    assert.equal(guardReadPath(realRoot, realRoot, "sub/b.txt").block, false);
    assert.equal(guardReadPath(realRoot, realRoot, ".env").block, false, "workspace 自身 .env（L-乙）放行");
    assert.equal(guardReadPath(realRoot, realRoot, realRoot).block, false);

    // workspace 外（絕對路徑；隔離 TMPDIR 例外）
    assert.equal(guardReadPath(realRoot, realRoot, secret, NO_TMP).block, true);
    // 非 TMPDIR 的主機機密（紅線）——即使預設放行 TMPDIR 也必擋
    assert.equal(guardReadPath(realRoot, realRoot, "/etc/passwd").block, true, "server 目錄外主機檔必擋");
    // ../ 逃逸
    assert.equal(guardReadPath(realRoot, realRoot, "../../etc/passwd", NO_TMP).block, true);
    // /proc/self/environ 與 /proc/1/environ（env 面備援；預設 tmpDir 下也擋）
    assert.equal(guardReadPath(realRoot, realRoot, "/proc/self/environ").block, true);
    assert.equal(guardReadPath(realRoot, realRoot, "/proc/1/environ").block, true);
    // 空路徑
    assert.equal(guardReadPath(realRoot, realRoot, "").block, true);
    assert.equal(guardReadPath(realRoot, realRoot, undefined).block, true);

    // symlink 逃逸：workspace 內放一個指向 outside secret 的 symlink，realpath 後應落在 workspace 外 → 擋
    const link = path.join(realRoot, "escape");
    try {
      fs.symlinkSync(secret, link);
      assert.equal(guardReadPath(realRoot, realRoot, "escape", NO_TMP).block, true, "symlink 逃逸必擋");
    } catch (e) {
      if (e && e.code !== "EPERM") throw e; // 某些環境不允許 symlink，跳過
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("L1: 新檔（尚不存在）依 parent 邊界判斷（write 前置檢查一致）", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-ws2-"));
  try {
    const realRoot = fs.realpathSync(root);
    // workspace 內的新檔 → 放行
    assert.equal(guardReadPath(realRoot, realRoot, "new-file.txt").block, false);
    assert.equal(guardReadPath(realRoot, realRoot, "sub/new.txt").block, true, "parent 不存在 → unresolvable → 擋");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("L1: tmpDir 放行（opts.tmpDir）、關閉（null）則擋", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-ws3-"));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sg-tmp-"));
  try {
    const realRoot = fs.realpathSync(root);
    const realTmp = fs.realpathSync(tmp);
    const f = path.join(realTmp, "staged.png");
    fs.writeFileSync(f, "x");
    assert.equal(guardReadPath(realRoot, realRoot, f, { tmpDir: realTmp }).block, false);
    assert.equal(guardReadPath(realRoot, realRoot, f, { tmpDir: null }).block, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ───────────────────────── L3：redact ─────────────────────────

test("L3: collectSecretValues 只取 L-甲 且長度>=8，長值優先", () => {
  const env = { OPENROUTER_API_KEY: "longlongsecret", PI_WEBUI_PASSWORD: "short7x", PC2_SERVICE_PWS: "midsecret1" };
  const vals = collectSecretValues(env);
  assert.ok(vals.includes("longlongsecret"));
  assert.ok(vals.includes("midsecret1"));
  assert.ok(!vals.includes("short7x"), "長度<8 不遮");
  assert.equal(vals[0], "longlongsecret", "長值排前");
});

test("L3: redactText 遮 L-甲 值，L-乙 值不遮", () => {
  const t = redactText(
    "key=or-secret-abcdef123456 token=scoped-token-abcdef123456",
    FAKE_ENV,
  );
  assert.ok(t.includes(REDACTION_PLACEHOLDER));
  assert.ok(!t.includes("or-secret-abcdef123456"), "L-甲 OPENROUTER 值被遮");
  assert.ok(t.includes("scoped-token-abcdef123456"), "L-乙 PC2_API_TOKEN 值不在遮蔽清單");
});

test("L3: redactBlocks 只動 text block、無機密回原陣列（referential no-op）", () => {
  const content = [
    { type: "text", text: "pw=sup3rsecretpassword done" },
    { type: "image", data: "..." },
  ];
  const red = redactBlocks(content, FAKE_ENV);
  assert.notEqual(red, content);
  assert.ok(red[0].text.includes(REDACTION_PLACEHOLDER));
  assert.ok(!red[0].text.includes("sup3rsecretpassword"));
  assert.equal(red[1].type, "image");

  // 無機密值 → 回同一參考
  const clean = [{ type: "text", text: "nothing secret here" }];
  assert.equal(redactBlocks(clean, FAKE_ENV), clean);
  // 非陣列 → 原樣
  assert.equal(redactBlocks("nope", FAKE_ENV), "nope");
});

test("L3: PC2_SERVICE_PWS(L-甲) 一定在遮蔽清單、PC2_API_TOKEN(L-乙) 一定不在", () => {
  assert.ok(SECRET_ENV_KEYS.includes("PC2_SERVICE_PWS"));
  assert.ok(!SECRET_ENV_KEYS.includes("PC2_API_TOKEN"));
});

test("L3: redactBlocks 也遮 L-甲 值的 base64 編碼變體（擋單值 | base64 繞過）", () => {
  const b64 = Buffer.from(FAKE_ENV.OPENROUTER_API_KEY).toString("base64");
  const red = redactBlocks([{ type: "text", text: `dump=${b64} tail` }], FAKE_ENV);
  assert.ok(!red[0].text.includes(b64), "OPENROUTER 值的 base64 形式應被遮");
  assert.ok(red[0].text.includes(REDACTION_PLACEHOLDER));
});

test("L3: redactBlocks 也遮 L-甲 值的 hex 編碼變體", () => {
  const hex = Buffer.from(FAKE_ENV.PC2_SERVICE_PWS).toString("hex");
  const red = redactBlocks([{ type: "text", text: `x ${hex} y` }], FAKE_ENV);
  assert.ok(!red[0].text.includes(hex), "PC2_SERVICE_PWS 值的 hex 形式應被遮");
  assert.ok(red[0].text.includes(REDACTION_PLACEHOLDER));
});

test("L3: 編碼變體遮蔽不誤傷 L-乙（PC2_API_TOKEN 的 base64 不遮）", () => {
  const b64 = Buffer.from(FAKE_ENV.PC2_API_TOKEN).toString("base64");
  const red = redactBlocks([{ type: "text", text: `t=${b64}` }], FAKE_ENV);
  assert.ok(red[0].text.includes(b64), "L-乙 值的編碼形式不在遮蔽範圍");
});

// ───────────────────────── tool 包裝 ─────────────────────────

test("wrapReadWithGuard: 越界 read 回 isError block，境內轉呼原 execute", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sg-wrap-"));
  try {
    const realRoot = fs.realpathSync(root);
    fs.writeFileSync(path.join(realRoot, "ok.txt"), "hi");
    let inner = 0;
    const def = {
      name: "read",
      execute: async (_id, params) => {
        inner++;
        return { content: [{ type: "text", text: `read ${params.path}` }] };
      },
    };
    const guarded = wrapReadWithGuard(def, realRoot, realRoot);
    const blocked = await guarded.execute("1", { path: "/etc/passwd" }, undefined, undefined, {});
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /workspace 邊界之外/);
    assert.equal(inner, 0, "越界不應呼叫原 execute");

    const ok = await guarded.execute("2", { path: "ok.txt" }, undefined, undefined, {});
    assert.equal(ok.content[0].text, "read ok.txt");
    assert.equal(inner, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wrapToolWithRedaction: 遮 execute 結果與 onUpdate 串流 content", async () => {
  const captured = [];
  const def = {
    name: "bash",
    execute: async (_id, _params, _sig, onUpdate) => {
      onUpdate?.({ content: [{ type: "text", text: "streaming OPENROUTER_API_KEY=or-secret-abcdef123456" }] });
      return { content: [{ type: "text", text: "final PC2_SERVICE_PWS=pc2-master-pw-secret-xyz" }] };
    },
  };
  const wrapped = wrapToolWithRedaction(def, { env: FAKE_ENV });
  const res = await wrapped.execute(
    "1",
    {},
    undefined,
    (partial) => captured.push(partial),
    {},
  );
  // 最終結果（送 model）已遮
  assert.ok(res.content[0].text.includes(REDACTION_PLACEHOLDER));
  assert.ok(!res.content[0].text.includes("pc2-master-pw-secret-xyz"));
  // 串流 partial 已遮
  assert.equal(captured.length, 1);
  assert.ok(captured[0].content[0].text.includes(REDACTION_PLACEHOLDER));
  assert.ok(!captured[0].content[0].text.includes("or-secret-abcdef123456"));
});

test("wrapBashWithCommandGuard: 偵察命令回 isError block、正當命令轉呼原 execute", async () => {
  let inner = 0;
  const def = {
    name: "bash",
    execute: async (_id, params) => {
      inner++;
      return { content: [{ type: "text", text: `ran ${params.command}` }] };
    },
  };
  const guarded = wrapBashWithCommandGuard(def);

  const blocked = await guarded.execute("1", { command: "cat /proc/1/environ" }, undefined, undefined, {});
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /偵察/);
  assert.equal(inner, 0, "偵察命令不應呼叫原 execute");

  const ok = await guarded.execute("2", { command: "readyai-db query --lang en" }, undefined, undefined, {});
  assert.equal(ok.content[0].text, "ran readyai-db query --lang en");
  assert.equal(inner, 1);
});

// ───────────────────────── LITELLM_API_KEY（per-preview virtual key）─────────────────────────

test("L0: LITELLM_API_KEY / LITELLM_BASE_URL 不在 bash env 白名單", () => {
  const out = filterBashEnv(FAKE_ENV);
  assert.equal(out.LITELLM_API_KEY, undefined);
  assert.equal(out.LITELLM_BASE_URL, undefined);
});

test("L3: SECRET_ENV_KEYS 含 LITELLM_API_KEY，值被遮", () => {
  assert.ok(SECRET_ENV_KEYS.includes("LITELLM_API_KEY"));
  const t = redactText("key=sk-litellm-virtual-abcdef123456", FAKE_ENV);
  assert.equal(t, `key=${REDACTION_PLACEHOLDER}`);
});

test("L3: LITELLM_API_KEY 的 base64 變體也被遮", () => {
  const b64 = Buffer.from(FAKE_ENV.LITELLM_API_KEY).toString("base64");
  const t = redactText(`enc=${b64}`, FAKE_ENV);
  assert.equal(t, `enc=${REDACTION_PLACEHOLDER}`);
});

// final review 缺口：上面兩組只驗過 redactText 純函式，沒走過 wrapToolWithRedaction
// 這個真接點（送 model 前的實際攔截點）。比照 :358 的 wrapToolWithRedaction 範本，
// 換 LITELLM_API_KEY 當唯一哨兵，證明 execute 回傳與 onUpdate 串流都真的被遮。
test("wrapToolWithRedaction: LITELLM_API_KEY（per-preview virtual key）經真實 tool 執行路徑（送 model）被遮", async () => {
  const captured = [];
  const def = {
    name: "bash",
    execute: async (_id, _params, _sig, onUpdate) => {
      onUpdate?.({
        content: [{ type: "text", text: `streaming key=${FAKE_ENV.LITELLM_API_KEY}` }],
      });
      return {
        content: [{ type: "text", text: `final key=${FAKE_ENV.LITELLM_API_KEY}` }],
      };
    },
  };
  const wrapped = wrapToolWithRedaction(def, { env: FAKE_ENV });
  const res = await wrapped.execute(
    "1",
    {},
    undefined,
    (partial) => captured.push(partial),
    {},
  );
  // 最終結果（送 model）已遮
  assert.ok(res.content[0].text.includes(REDACTION_PLACEHOLDER));
  assert.ok(!res.content[0].text.includes(FAKE_ENV.LITELLM_API_KEY));
  // 串流 partial 已遮
  assert.equal(captured.length, 1);
  assert.ok(captured[0].content[0].text.includes(REDACTION_PLACEHOLDER));
  assert.ok(!captured[0].content[0].text.includes(FAKE_ENV.LITELLM_API_KEY));
});
