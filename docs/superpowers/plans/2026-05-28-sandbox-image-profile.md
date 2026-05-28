# sandbox image profile 接入 readyai-sandbox image — 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 pi-webui sandbox 支援指定 gondolin image (`readyai-sandbox:0.1.0-3.23.0-bba981` 等),並注入 VM-wide 環境變數(`READYAI_SANDBOX_MODE=1` 等),透過 `.pi/profiles/<name>.toml` 的 `[sandbox]` 區塊宣告,或以 CLI 旗標 override。

**Architecture:** `gondolin@0.12` SDK 的 `VM.create({ sandbox: { imagePath }, env, vfs })` 已支援所需參數。改造分三層:(1) `Sandbox` class 接收 `image` / `env`,defaultVmFactory 透傳給 `VM.create`;(2) `profile-loader` schema 加 `[sandbox]` 區塊,通過 unknown-field strict validation;(3) `server/index.ts` 啟動序列把 profile + CLI override 合併,傳到 `new Sandbox(...)`。CLI 旗標 `--sandbox-image` / `--sandbox-env KEY=VAL`(可重複)+ env `PI_WEBUI_SANDBOX_IMAGE` 作為 profile fallback。

**Tech Stack:** TypeScript (server) / vanilla JS (client 無變動) / `@earendil-works/gondolin@0.12` / `@iarna/toml` / `node:test`。

---

## 範圍與非範圍

**範圍**
- `src/server/sandbox.ts` — `SandboxOptions.image?` / `SandboxOptions.env?`,defaultVmFactory 把它們塞進 `VM.create`
- `src/server/profile-loader.ts` — `[sandbox] { image?, env? }` schema + 驗證
- `src/server/index.ts` — `--sandbox-image` / `--sandbox-env` CLI、`PI_WEBUI_SANDBOX_IMAGE` env、優先級合併、help / env table 更新
- `src/extension/index.ts` — forward `--webui-sandbox-image` / `--webui-sandbox-env`
- `test/sandbox.test.mjs` — 補 image/env 透傳 + factory 收到參數的單元測試
- `test/profile-loader.test.mjs` — 補 `[sandbox]` schema 測試
- `README.md` / `ROADMAP.md` / `CHANGELOG.md` — 同步
- E2E:`~/Codes/readyaiJobs/www.chinyenlabeler.com/.pi/profiles/readyai.toml` + 啟 server 跑 `readyai-db tables --lng en`

**非範圍**
- 把 `--sandbox` enable/disable 移進 profile toml(維持「安全旗標只走 CLI/env」原則 — 不會在 toml 內無預警把 sandbox 關掉)
- gondolin image 派發/下載機制變更(image 由 operator 在外部 `gondolin image import` 預備好,pi-webui 不做 image pull)
- 多 image 同時啟用 / 動態切 image(一個 server 一個 image,要換重啟)
- 把 readyai 字串 hardcode 進 pi-webui(profile/CLI 通用,readyAI 端只是其中一個 use case)
- 自動下載 / build readyai-sandbox image

---

## File Structure

```
src/server/
  sandbox.ts                ← 加 image/env 到 SandboxOptions + defaultVmFactory
  profile-loader.ts         ← schema 加 [sandbox]
  index.ts                  ← CLI parse + 啟動序列 + help/env table

src/extension/
  index.ts                  ← forward --webui-sandbox-image / --webui-sandbox-env

test/
  sandbox.test.mjs          ← 補 image/env 透傳測試
  profile-loader.test.mjs   ← 補 [sandbox] schema 測試

docs/superpowers/plans/
  2026-05-28-sandbox-image-profile.md  ← 本檔

README.md                   ← [sandbox] 段 + readyAI 範例
ROADMAP.md                  ← done 加項
CHANGELOG.md                ← 加 2026-05-28 區塊
```

職責:
- `sandbox.ts` 仍是「唯一 import gondolin 的檔」,所有 VM 啟動參數的注入點集中在此
- `profile-loader.ts` 只負責「toml → 已驗證物件」,不知道 sandbox 怎麼用
- `server/index.ts` 是 wiring 層,負責 CLI/env/profile 優先級合併

---

## 優先級規則(共識)

```
image:  --sandbox-image (CLI)
        > PI_WEBUI_SANDBOX_IMAGE (env)
        > profile.sandbox.image (toml)
        > (none → gondolin builtin alpine-base:latest)

env:    profile.sandbox.env (toml base)
        + --sandbox-env KEY=VAL (CLI,逐 key override / merge)
```

- `image` 不在則沿用 gondolin 預設 → 維持向後相容(既有 `--sandbox` 不帶 profile 的人不受影響)
- `env` 是 merge 而非 replace:profile 給基底,CLI 加減個別 key

---

## Task 1: 擴 Sandbox 接收 image / env(TDD 起點)

**Files:**
- Modify: `src/server/sandbox.ts:59-65` (SandboxOptions interface), `:113-125` (constructor), `:367-394` (defaultVmFactory)
- Test: `test/sandbox.test.mjs` (append new tests)

- [ ] **Step 1: 寫失敗測試 — Sandbox 把 image / env 傳給 vmFactory**

在 `test/sandbox.test.mjs` 結尾(最後一個 test 之後)加:

```js
test("vmFactory 預設值會把 sandboxImage / sandboxEnv 透傳到 VM.create options", async () => {
  // 我們不能直接驗 defaultVmFactory 內部呼叫(會 import gondolin),
  // 但可以驗:當 caller 沒提供 vmFactory 時,Sandbox 仍然儲存 image/env,
  // 並且使用者注入的 vmFactory 收得到 options(此處驗自定 factory 拿到 image/env)。
  const ws = mkWorkspace();
  try {
    let received;
    const { vm } = makeFakeVm();
    const sb = new Sandbox({
      workspaceRoot: ws,
      image: "readyai-sandbox:0.1.0-3.23.0-bba981",
      env: { READYAI_SANDBOX_MODE: "1", FOO: "bar" },
      vmFactory: async (opts) => {
        received = opts;
        return vm;
      },
    });
    await sb.ensure();
    assert.deepEqual(received, {
      image: "readyai-sandbox:0.1.0-3.23.0-bba981",
      env: { READYAI_SANDBOX_MODE: "1", FOO: "bar" },
    });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("Sandbox 預設 image/env 都是 undefined", async () => {
  const ws = mkWorkspace();
  try {
    let received;
    const { vm } = makeFakeVm();
    const sb = new Sandbox({
      workspaceRoot: ws,
      vmFactory: async (opts) => {
        received = opts;
        return vm;
      },
    });
    await sb.ensure();
    assert.deepEqual(received, { image: undefined, env: undefined });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
```

注意:既有 `vmFactory: () => Promise<GondolinVM>` 不收參數,本 task 要把它改成 `(options) => Promise<GondolinVM>`,所以既有測試裡 `vmFactory: async () => vm` 仍合法(忽略 options),不需要動。

- [ ] **Step 2: 跑測試確認新測試 fail**

```
make build && node --test test/sandbox.test.mjs 2>&1 | tail -40
```

預期:
- 新加的兩個 test fail(因 `image` / `env` option 還沒接到 vmFactory)
- 既有測試保持 pass

- [ ] **Step 3: 實作 SandboxOptions + constructor + defaultVmFactory**

改 `src/server/sandbox.ts`:

(a) `SandboxOptions` 介面(行 59-65)加兩個 optional 欄位:

```ts
export interface SandboxOptions {
  // host 端要 mount 進 guest /workspace 的目錄。會經 realpathSync canonical。
  workspaceRoot: string;
  // 指定 gondolin image selector(`name:tag` 或 buildId)。
  // 沒設 → 走 gondolin 預設 alpine-base:latest。
  image?: string;
  // VM 啟動時注入的預設環境變數,所有 vm.exec 都看得到。
  env?: Record<string, string>;
  logger?: SandboxLogger;
  // 給測試用的 hook;production 走 dynamic import gondolin。
  vmFactory?: (options: { image?: string; env?: Record<string, string> }) => Promise<GondolinVM>;
}
```

(b) Sandbox class 新增 private fields + constructor 儲存(行 105-125 區域):

```ts
export class Sandbox {
  readonly workspaceRoot: string;
  private readonly logger: SandboxLogger;
  private readonly vmFactory: (options: { image?: string; env?: Record<string, string> }) => Promise<GondolinVM>;
  private readonly image: string | undefined;
  private readonly env: Record<string, string> | undefined;
  private vm: GondolinVM | undefined;
  private starting: Promise<GondolinVM> | undefined;
  private closed = false;

  constructor(options: SandboxOptions) {
    if (!options || !options.workspaceRoot) {
      throw new Error("Sandbox requires workspaceRoot");
    }
    const absolute = path.resolve(options.workspaceRoot);
    if (!existsSync(absolute)) {
      throw new Error(`Sandbox workspace does not exist: ${absolute}`);
    }
    this.workspaceRoot = realpathSync(absolute);
    this.logger = options.logger ?? log;
    this.image = options.image;
    this.env = options.env;
    this.vmFactory = options.vmFactory ?? defaultVmFactory(this.workspaceRoot);
  }
```

(c) `ensure()` 方法呼叫 vmFactory 時帶入 image/env(行 151-167 區域):

```ts
    this.starting = (async () => {
      const t0 = Date.now();
      this.logger.info("sandbox: booting", {
        workspace: this.workspaceRoot,
        image: this.image,
      });
      const vm = await this.vmFactory({ image: this.image, env: this.env });
      this.vm = vm;
      this.logger.info("sandbox: ready", { id: vm.id, elapsedMs: Date.now() - t0 });
      return vm;
    })();
```

(d) `defaultVmFactory` 改簽章 + 透傳到 `VM.create`(行 367-394):

```ts
function defaultVmFactory(
  workspaceRoot: string,
): (options: { image?: string; env?: Record<string, string> }) => Promise<GondolinVM> {
  return async ({ image, env }) => {
    const mod = await import("@earendil-works/gondolin");
    const { VM, RealFSProvider } = mod as unknown as {
      VM: { create(options: object): Promise<GondolinVM> };
      RealFSProvider: new (root: string) => unknown;
    };
    const createOptions: Record<string, unknown> = {
      sessionLabel: `pi-webui ${path.basename(workspaceRoot)}`,
      vfs: {
        mounts: {
          [GUEST_WORKSPACE]: new RealFSProvider(workspaceRoot),
        },
      },
    };
    if (image) {
      createOptions.sandbox = { imagePath: image };
    }
    if (env && Object.keys(env).length > 0) {
      createOptions.env = env;
    }
    const vm = await VM.create(createOptions);
    // Alpine 預設沒有 bash,且 SDK 的 bash tool 直接呼叫 /bin/bash;
    // 沒有 bash 時 ash 也能跑大多數指令,但 SDK 明確要求 /bin/bash。
    // 這裡盡力安裝,失敗也不阻擋 (跑 ash-friendly 指令還是會通)。
    try {
      await vm.exec(
        "command -v bash > /dev/null 2>&1 || apk add --no-cache bash > /dev/null 2>&1 || true",
      );
    } catch {
      // 不阻擋啟動;呼叫端使用 bash 失敗時自然會收到錯誤訊息。
    }
    return vm;
  };
}
```

注意:`apk add` 在 readyai-sandbox image 內**會 fail**(spec E2 拔掉 apk),不過 readyai-sandbox 已預裝 bash(rootfsPackages 含 `bash`),`command -v bash` 直接 true,`apk add` 那段根本不會跑 → 沒問題。

- [ ] **Step 4: 跑測試**

```
make build && node --test test/sandbox.test.mjs 2>&1 | tail -20
```

預期:新加兩個 test 通過 + 既有全綠。

- [ ] **Step 5: Commit**

```bash
git add src/server/sandbox.ts test/sandbox.test.mjs
git commit -m "feat(sandbox): 支援指定 image 與注入 VM-wide env

SandboxOptions 加 image?: string 與 env?: Record<string,string>;
defaultVmFactory 在收到 image 時把 sandbox.imagePath 塞進 VM.create,
env 非空時塞進 VM.create.env(gondolin SDK defaultEnv)。
vmFactory hook 簽章改為收 options,測試 stub 仍可忽略。"
```

---

## Task 2: 擴 profile-loader 支援 `[sandbox]` 區塊

**Files:**
- Modify: `src/server/profile-loader.ts:36-44` (ProfileFile interface), `:87` (ALLOWED_TOP), 同檔新增 validate 函式
- Test: `test/profile-loader.test.mjs` (append new tests)
- Fixture: `test/fixtures/profiles/sandbox-readyai.toml`(新檔)

- [ ] **Step 1: 寫失敗測試 — 載入 sandbox fixture + 各種錯誤情境**

先建 fixture `test/fixtures/profiles/sandbox-readyai.toml`:

```bash
mkdir -p test/fixtures/profiles
```

`test/fixtures/profiles/sandbox-readyai.toml` 內容:

```toml
[meta]
description = "fixture for sandbox image/env"

[sandbox]
image = "readyai-sandbox:0.1.0-3.23.0-bba981"

[sandbox.env]
READYAI_SANDBOX_MODE = "1"
LOG_LEVEL = "info"
```

在 `test/profile-loader.test.mjs` 結尾加:

```js
test("loadProfile 解析 [sandbox] image + env", (t) => {
  const cwd = makeCwdWithProfile("sandbox-readyai", "sandbox-readyai.toml");
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const profile = loadProfile("sandbox-readyai", cwd);
  assert.equal(profile.sandbox?.image, "readyai-sandbox:0.1.0-3.23.0-bba981");
  assert.deepEqual(profile.sandbox?.env, {
    READYAI_SANDBOX_MODE: "1",
    LOG_LEVEL: "info",
  });
});

test("loadProfile [sandbox].image 非字串 → throw", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "x.toml"),
    `[sandbox]\nimage = 42\n`,
  );
  assert.throws(() => loadProfile("x", tmp), /\[sandbox\]\.image/);
});

test("loadProfile [sandbox].image 不是 name:tag 格式 → throw", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "x.toml"),
    `[sandbox]\nimage = "with space"\n`,
  );
  assert.throws(() => loadProfile("x", tmp), /\[sandbox\]\.image/);
});

test("loadProfile [sandbox.env] value 非字串 → throw", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "x.toml"),
    `[sandbox.env]\nFOO = 1\n`,
  );
  assert.throws(() => loadProfile("x", tmp), /\[sandbox\.env\]\.FOO/);
});

test("loadProfile [sandbox.env] key 不合法 → throw", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "x.toml"),
    `[sandbox.env]\n"bad key" = "v"\n`,
  );
  assert.throws(() => loadProfile("x", tmp), /\[sandbox\.env\]/);
});

test("loadProfile [sandbox] 內未知欄位 → throw", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "x.toml"),
    `[sandbox]\nimage = "x:y"\nmemory = "2G"\n`,
  );
  assert.throws(() => loadProfile("x", tmp), /\[sandbox\]\.memory/);
});

test("loadProfile [sandbox] 沒設 image 也合法(env-only)", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "x.toml"),
    `[sandbox.env]\nFOO = "bar"\n`,
  );
  const profile = loadProfile("x", tmp);
  assert.equal(profile.sandbox?.image, undefined);
  assert.deepEqual(profile.sandbox?.env, { FOO: "bar" });
});
```

- [ ] **Step 2: 跑測試確認新測試 fail**

```
make build && node --test test/profile-loader.test.mjs 2>&1 | tail -30
```

預期:新加 7 個 test 全 fail(`unknown top-level table: [sandbox]` 或讀不到 sandbox 欄位)。既有測試保持 pass。

- [ ] **Step 3: 實作 schema + validator**

改 `src/server/profile-loader.ts`:

(a) ProfileFile 介面(行 36-44)加:

```ts
export interface SandboxConfig {
  image?: string;
  env?: Record<string, string>;
}

export interface ProfileFile {
  meta?: { description?: string };
  ui?: UiFlags;
  brand?: BrandConfig;
  skills?: { allow?: string[] };
  commands?: { allow?: string[] };
  defaults?: { model?: string };
  tool_labels?: Record<string, ToolLabelEntry>;
  sandbox?: SandboxConfig;
}
```

(b) ALLOWED_TOP(行 87)加 `"sandbox"`:

```ts
const ALLOWED_TOP = new Set([
  "meta", "ui", "brand", "skills", "commands",
  "defaults", "tool_labels", "sandbox",
]);
```

(c) 同檔加新常量 + validator(在既有 `validateUnknown` 之後):

```ts
const ALLOWED_SANDBOX = new Set(["image", "env"]);
// gondolin image selector 語法寬鬆:repo[/name][:tag] 或 buildId(uuid-like)。
// 我們只 reject 明顯壞掉的(空白、控制字元),其他交給 gondolin runtime 驗。
const IMAGE_RE = /^[A-Za-z0-9._:/@-]+$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateSandbox(sandbox: SandboxConfig | undefined): void {
  if (!sandbox) return;
  for (const key of Object.keys(sandbox)) {
    if (!ALLOWED_SANDBOX.has(key)) {
      throw new Error(`unknown field [sandbox].${key}`);
    }
  }
  if (sandbox.image !== undefined) {
    if (typeof sandbox.image !== "string") {
      throw new Error(`[sandbox].image: 必須是字串,收到 ${typeof sandbox.image}`);
    }
    if (!IMAGE_RE.test(sandbox.image)) {
      throw new Error(`[sandbox].image: 不是合法 image selector(只允許 [A-Za-z0-9._:/@-]),收到 "${sandbox.image}"`);
    }
  }
  if (sandbox.env !== undefined) {
    if (sandbox.env === null || typeof sandbox.env !== "object" || Array.isArray(sandbox.env)) {
      throw new Error(`[sandbox.env]: 必須是 table(key=value),收到 ${Array.isArray(sandbox.env) ? "array" : typeof sandbox.env}`);
    }
    for (const [k, v] of Object.entries(sandbox.env)) {
      if (!ENV_KEY_RE.test(k)) {
        throw new Error(`[sandbox.env]: env key 必須符合 [A-Za-z_][A-Za-z0-9_]*,收到 "${k}"`);
      }
      if (typeof v !== "string") {
        throw new Error(`[sandbox.env].${k}: 必須是字串,收到 ${typeof v}`);
      }
    }
  }
}
```

(d) `loadProfile`(行 167-185)加 `validateSandbox(profile.sandbox)`:

```ts
export function loadProfile(name: string, cwd: string): ProfileFile {
  const filePath = path.join(cwd, ".pi", "profiles", `${name}.toml`);
  if (!fs.existsSync(filePath)) {
    if (name === "customer") return CUSTOMER_FALLBACK;
    throw new Error(`profile not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed;
  try {
    parsed = TOML.parse(raw);
  } catch (e) {
    throw new Error(`profile syntax error: ${e.message}`);
  }
  validateUnknown(parsed as Record<string, unknown>);
  const profile = parsed as ProfileFile;
  validateBrand(profile.brand, cwd);
  validatePlaceholders(profile.tool_labels);
  validateSandbox(profile.sandbox);
  return profile;
}
```

- [ ] **Step 4: 跑測試**

```
make build && node --test test/profile-loader.test.mjs 2>&1 | tail -20
```

預期:新加測試全 pass + 既有保持 pass。

- [ ] **Step 5: Commit**

```bash
git add src/server/profile-loader.ts test/profile-loader.test.mjs test/fixtures/profiles/sandbox-readyai.toml
git commit -m "feat(profile): 加 [sandbox] image + env schema

允許 profile toml 宣告 sandbox image selector 與 VM 預設 env。
image 走寬鬆 regex(交給 gondolin runtime 驗 selector),env
key/value 嚴格驗證(合法 env var 名 + 字串值)。
[sandbox] 不允許其他欄位(YAGNI memory/cpus 等)。"
```

---

## Task 3: server/index.ts CLI 旗標 + 啟動序列串接

**Files:**
- Modify: `src/server/index.ts:265-280` (parseArgs), `:140-225` (printHelp / env table), `:617-645` (sandbox 啟動序列)
- Test: 不寫單元(CLI 解析是黏合層,靠後續 e2e 驗)

- [ ] **Step 1: parseArgs 加旗標**

在 `src/server/index.ts:270-272`(`--sandbox-workspace` 那一帶)後面插:

```ts
    else if (a === "--sandbox-image") out.sandboxImage = argv[++i];
    else if (a.startsWith("--sandbox-image=")) out.sandboxImage = a.slice("--sandbox-image=".length);
    else if (a === "--sandbox-env") {
      const kv = argv[++i];
      if (typeof kv !== "string" || !kv.includes("=")) {
        throw new Error(`--sandbox-env 需要 KEY=VAL 格式`);
      }
      const eq = kv.indexOf("=");
      const k = kv.slice(0, eq);
      const v = kv.slice(eq + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        throw new Error(`--sandbox-env: env key 不合法: "${k}"`);
      }
      out.sandboxEnv ??= {};
      out.sandboxEnv[k] = v;
    }
    else if (a.startsWith("--sandbox-env=")) {
      const kv = a.slice("--sandbox-env=".length);
      if (!kv.includes("=")) {
        throw new Error(`--sandbox-env 需要 KEY=VAL 格式`);
      }
      const eq = kv.indexOf("=");
      const k = kv.slice(0, eq);
      const v = kv.slice(eq + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        throw new Error(`--sandbox-env: env key 不合法: "${k}"`);
      }
      out.sandboxEnv ??= {};
      out.sandboxEnv[k] = v;
    }
```

- [ ] **Step 2: printHelp 加說明(`:175-179` 區域,接著 `--sandbox-workspace`)**

在 printHelp 的 sandbox 那段後面加兩行:

```ts
    "  --sandbox-image <ref>       gondolin image selector (e.g. readyai-sandbox:0.1.0-3.23.0-bba981).",
    "                              alias: PI_WEBUI_SANDBOX_IMAGE; profile [sandbox] image 為 fallback.",
    "  --sandbox-env KEY=VAL       inject VM-wide env(可重複);與 profile [sandbox.env] merge,CLI 優先.",
```

env vars 那段(`:214-216`)加:

```ts
    "  PI_WEBUI_SANDBOX_IMAGE     gondolin image selector(same as --sandbox-image)",
```

- [ ] **Step 3: 啟動序列合併 + 傳給 Sandbox(`:617-645` 區域)**

找到既有 `if (sandboxEnabled) { ... Sandbox.ensureQemuInstalled(); ... new Sandbox(...) }`(行 627-639),整段改成:

```ts
let sandbox = null;
let sandboxInitError = null;
if (sandboxEnabled) {
  try {
    Sandbox.ensureQemuInstalled();
    const workspace = resolve(appCwd, expandHome(sandboxWorkspaceRaw));
    // image 優先級:CLI > env > profile
    const sandboxImage =
      args.sandboxImage ||
      process.env.PI_WEBUI_SANDBOX_IMAGE ||
      profileFile?.sandbox?.image ||
      undefined;
    // env merge:profile 為基底,CLI 蓋寫個別 key
    const sandboxEnv = {
      ...(profileFile?.sandbox?.env ?? {}),
      ...(args.sandboxEnv ?? {}),
    };
    sandbox = new Sandbox({
      workspaceRoot: workspace,
      image: sandboxImage,
      env: Object.keys(sandboxEnv).length > 0 ? sandboxEnv : undefined,
      logger,
    });
    logger.info("sandbox enabled", {
      workspace: sandbox.workspaceRoot,
      image: sandboxImage ?? "(gondolin default)",
      env: Object.keys(sandboxEnv),
    });
  } catch (error) {
    sandboxInitError = error instanceof Error ? error.message : String(error);
    logger.error("sandbox init failed", { error: sandboxInitError });
  }
}
```

- [ ] **Step 4: build + smoke**

```
make build
```

預期:tsc 通過(無 type error)。

跑既有測試:

```
make test 2>&1 | tail -30
```

預期全綠(尤其 sandbox.test.mjs / profile-loader.test.mjs)。

- [ ] **Step 5: smoke --help**

```
node dist/server/index.js --help 2>&1 | grep -A1 'sandbox-image\|SANDBOX_IMAGE'
```

預期看到新加的兩行 + env var 條目。

- [ ] **Step 6: Commit**

```bash
git add src/server/index.ts
git commit -m "feat(server): 串接 profile.sandbox + CLI 旗標 → Sandbox

新加 --sandbox-image / --sandbox-env KEY=VAL(repeatable)CLI 旗標,
PI_WEBUI_SANDBOX_IMAGE env 對應。優先級 CLI > env > profile;env
為 merge(CLI 蓋寫個別 key)。help / env table 同步。"
```

---

## Task 4: extension forward 兩個新旗標

**Files:**
- Modify: `src/extension/index.ts`(原則上沿用既有 `--webui-sandbox-workspace` forward 模式)

- [ ] **Step 1: 看現有 forward 模式定位插入點**

```
grep -n 'sandbox' src/extension/index.ts
```

找 `webui-sandbox-workspace` 對應的 forward 區塊。

- [ ] **Step 2: 加 forward**

仿 `webui-sandbox-workspace` 加兩個:

```
--webui-sandbox-image <ref>  → 加進 spawn args 變 --sandbox-image <ref>
--webui-sandbox-env KEY=VAL  → 可重複,每個 forward 為 --sandbox-env KEY=VAL
```

(具體 patch 由 implementer 依現有結構填入;若 ext 用 yargs-like / 手刻 parser 可自行對齊。)

- [ ] **Step 3: build + 既有 ext 測試**

```
make build && node --test test/*.test.mjs 2>&1 | tail -30
```

預期全綠。

- [ ] **Step 4: Commit**

```bash
git add src/extension/index.ts
git commit -m "feat(extension): forward --webui-sandbox-image / --webui-sandbox-env

對齊既有 --webui-sandbox-workspace 模式。--webui-sandbox-env 可重複,
每個展開為 --sandbox-env KEY=VAL 傳給 server。"
```

---

## Task 5: 文件同步(README + ROADMAP + CHANGELOG)

**Files:**
- Modify: `README.md`(`## sandbox` 區段附近 + flag table)
- Modify: `ROADMAP.md`(done 區塊)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: README**

(a) flag table 補兩列(在既有 `--sandbox-workspace` 那列後):

```md
| `--sandbox-image <ref>` | gondolin image selector(`name:tag` 或 buildId)。e.g. `readyai-sandbox:0.1.0-3.23.0-bba981`。alias: `PI_WEBUI_SANDBOX_IMAGE`;profile `[sandbox].image` 為 fallback。 |
| `--sandbox-env KEY=VAL` | 注入 VM-wide env(可重複)。與 profile `[sandbox.env]` merge,CLI 優先。 |
```

(b) env vars 表補一列:

```md
| `PI_WEBUI_SANDBOX_IMAGE` | (unset) | gondolin image selector(same as `--sandbox-image`) |
```

(c) `## sandbox` 段尾、`## tunnel` 前加新小節:

````md
### custom image profile

當需要在 sandbox 內預裝特定 CLI / 套件,可以:

1. 用 `gondolin` 工具 build 一個 OCI image(rootfs 含你的 CLI 與依賴)
2. `gondolin image import <dir> --tag <name>:<tag>` 註冊到本機
3. 在 `.pi/profiles/<name>.toml` 宣告:

```toml
[sandbox]
image = "readyai-sandbox:0.1.0-3.23.0-bba981"

[sandbox.env]
READYAI_SANDBOX_MODE = "1"
```

4. 啟動:`pi-webui --sandbox --profile <name>`

或不走 profile,直接 CLI:

```bash
pi-webui --sandbox \
  --sandbox-image readyai-sandbox:0.1.0-3.23.0-bba981 \
  --sandbox-env READYAI_SANDBOX_MODE=1
```

注意:image 必須是 host 本機 `gondolin image ls` 已註冊的;pi-webui 不會自動下載。
image 內若有 `/etc/profile.d/*.sh`,bash 工具(走 `bash -lc` login shell)會自動 source。
````

- [ ] **Step 2: ROADMAP done 區加項**

在現有 done 最末加:

```
[x] `--sandbox-image <ref>` + `--sandbox-env KEY=VAL` 與 profile `[sandbox]` 區塊;gondolin image selector 與 VM-wide env 注入(readyai-sandbox image 整合)
```

- [ ] **Step 3: CHANGELOG**

在 `2026-05-26` 後新增:

```md
## 2026-05-28

- sandbox 支援指定 gondolin image:`--sandbox-image <ref>` / `PI_WEBUI_SANDBOX_IMAGE` env;profile toml `[sandbox] image` 為 fallback。
- sandbox 支援注入 VM-wide env:`--sandbox-env KEY=VAL`(可重複);profile toml `[sandbox.env]` 為基底,CLI 覆寫個別 key。
- 配合 readyai-sandbox image 0.1.0-3.23.0-bba981 接入後勤客戶情境。
```

- [ ] **Step 4: Commit**

```bash
git add README.md ROADMAP.md CHANGELOG.md
git commit -m "docs: 加 sandbox image profile 段(--sandbox-image / [sandbox] toml)"
```

---

## Task 6: 寫 e2e 驗證 profile + image 接通

**Files:**
- Create: `~/Codes/readyaiJobs/www.chinyenlabeler.com/.pi/profiles/readyai.toml`
- Run: 真實 pi-webui server + 真實 gondolin VM(opt-in 範圍)

注意:這是手動 / 半自動驗證,**不寫進 `node --test`**(會在 CI 跑、需要 QEMU + 200MB image)。屬於 `make test-sandbox` 那一掛的 opt-in 整合。

- [ ] **Step 1: 建 readyai profile**

寫 `~/Codes/readyaiJobs/www.chinyenlabeler.com/.pi/profiles/readyai.toml`:

```toml
[meta]
description = "readyai-sandbox image — chinyenlabeler 後勤介面"

[sandbox]
image = "readyai-sandbox:0.1.0-3.23.0-bba981"

[sandbox.env]
READYAI_SANDBOX_MODE = "1"
```

(不放 `[ui]` 也不放 `[brand]`,先單純驗證 sandbox image 接通;後續再加 customer/staff 接口 profile。)

- [ ] **Step 2: 啟 pi-webui(背景)**

從 pi-webui repo 啟動,workspace 指向 customer dir:

```bash
PI_PROJECT_CWD=~/Codes/readyaiJobs/www.chinyenlabeler.com \
node dist/server/index.js \
  --listen 127.0.0.1:4096 \
  --sandbox \
  --sandbox-workspace ~/Codes/readyaiJobs/www.chinyenlabeler.com \
  --profile readyai
```

(`PI_PROJECT_CWD` 讓 profile loader 從該目錄找 `.pi/profiles/readyai.toml`,sandbox-workspace 同 dir 才會 mount 到 `/workspace`。)

預期 stdout 含:

```
sandbox enabled workspace=... image=readyai-sandbox:0.1.0-3.23.0-bba981 env=[...]
```

- [ ] **Step 3: 開瀏覽器 / 用 WebSocket 觸發 bash**

開 `http://127.0.0.1:4096`,問 model:

> 在 sandbox 內跑 `readyai-db tables --lng en`,把輸出貼回來

預期:
- bash tool 啟動 VM(第一次會有 boot log,~10-30s)
- VM 內 `readyai-db tables --lng en` 透過 PATH 找到 `/usr/local/bin/readyai-db`(login shell + profile.d)
- `READYAI_SANDBOX_MODE=1` 透過 VM-wide env 設好
- cwd=`/workspace` 載到 `/workspace/.env` 含的 PC2_API_TOKEN
- 對 PC2 API 回傳 ReadyScript table 列表

如果 fail,排查順序:
1. `PATH=` echo:`echo $PATH` 確認含 `/usr/local/bin`
2. `which readyai-db`:確認 symlink 存在
3. `env | grep READYAI`:確認 `READYAI_SANDBOX_MODE=1`
4. `ls /workspace/.env`:確認 mount 對
5. `cat /workspace/.env`:確認 token 沒空
6. 手動 `readyai-db tables --lng en` 看 traceback

- [ ] **Step 4: 不關 server**

驗證 PASS 後:
- **不要 kill server**(使用者要進去手動測試)
- 回報 URL / port / profile path / 預期手測項目給使用者

- [ ] **Step 5: Commit(若 e2e 有需要的小修正)**

如果 e2e 過程發現需要回頭修 Task 1-5 的 code,fix-up commit:

```bash
git add <files>
git commit -m "fix(sandbox): e2e 驗證發現的 <具體問題>"
```

如果順利通過則不 commit(client 端 profile toml 屬於 customer repo,不該 commit 到 pi-webui)。

---

## Self-Review

**Spec coverage:**
- readyAI spec §12 第 1 條「接受 profile toml `[sandbox] image`」→ Task 2 ✅
- readyAI spec §12 第 2 條「注入 `READYAI_SANDBOX_MODE=1` env」→ Task 1+2(env 機制)+ Task 6(實際在 profile 內寫值)✅
- readyAI spec §12 第 3 條「對 image not found 給 helpful error」→ gondolin SDK 自己會 throw `image not found`,pi-webui 啟動序列在 try/catch 內 → sandbox 旗標掛 chip 顯示 error(既有機制 sandbox.ts:631-638 + status chip)。沒新增邏輯,但既有路徑會覆蓋。
- PATH constraint(image 內 `/etc/profile.d/readyai-path.sh`)→ sandbox.ts:332 已 `bash -lc` ✅(plan 不動)
- cwd constraint(`/workspace`)→ guestPath 已處理 ✅(plan 不動)
- gondolin 0.12 API → 已驗證 `VMOptions.sandbox.imagePath` + `VMOptions.env` 存在(vm/types.d.ts:24/51)✅

**Placeholder scan:** 各 Task code blocks 完整,無 TBD / TODO。Task 4 ext forward 部分 patch 只給「對齊既有模式」的描述沒給逐字 code — 因 implementer 開檔可一眼看出格式,不違反「不要 placeholder」原則(留給 trivial pattern-following)。

**Type consistency:** `SandboxOptions.image?: string` / `SandboxOptions.env?: Record<string, string>` 從 Task 1 開始一致;`ProfileFile.sandbox?: SandboxConfig` 在 Task 2 引入後 Task 3 直接讀取;`args.sandboxImage` / `args.sandboxEnv` 在 parseArgs(Task 3 Step 1)定義,啟動序列(Task 3 Step 3)使用一致。

**未提及但實作者要注意的事**:
- profile-loader 用 `Object.keys(sandbox.env)` 迭代 — 若 toml 解析後 `sandbox.env` 是 `null`(明確寫 `env = ` 但無值)會炸,但 `[sandbox.env]` 在 toml 內語法上不會解出 null,所以無需額外處理
- Task 1 改 `vmFactory` 簽章後,既有 `test/sandbox-vm.test.mjs`(opt-in)若注入自己的 factory 要更新;不過該檔多半呼叫 `new Sandbox({ workspaceRoot })` 走 defaultVmFactory,影響面小

---

## Execution Handoff

Plan complete。
