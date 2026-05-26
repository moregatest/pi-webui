# pi-webui Profile System 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把零散的 `--ui-profile customer` / `--brand-*` / `.pi/skills-allow.txt` / `.pi/commands-allow.txt` / hardcode tool 標籤組合成 `.pi/profiles/<name>.toml` 接口模板系統,工程師寫好 toml + push git 後,後勤 / 客戶端 `pi-webui --profile <name>` 一鍵接手。

**Architecture:** 三個獨立 milestone:M1 載入器(`profile-loader.ts` + `parseUiProfile` 接 profileFile);M2 brand 擴充(toml 白名單 tokens + css overlay route);M3 tool 標籤三階段(`tool-label.ts` resolver + `tool_progress` packet 加 progress phase)。每個 M 各自有測試,可獨立 merge。

**Tech Stack:** Node 20+,TypeScript(寬鬆模式),`@iarna/toml` 新增 dep,`node:test`(單元 + 整合),既有 `ws` / `@earendil-works/pi-coding-agent`。

**Spec:** `docs/superpowers/specs/2026-05-26-profile-system-design.md`

---

## File Structure

**Create:**
- `src/server/profile-loader.ts` — 讀 toml + schema 驗證 + customer 內建 fallback
- `src/server/tool-label.ts` — label resolver + placeholder 白名單解析
- `src/server/brand-overlay.ts` — css overlay 檔載入 + size limit
- `test/profile-loader.test.mjs` — profile-loader 單元測試
- `test/tool-label.test.mjs` — tool-label 單元測試
- `test/brand-overlay.test.mjs` — brand-overlay 單元測試
- `test/server-profile.test.mjs` — 整合測試(spawn 真 server)
- `test/fixtures/profiles/staff.toml` — fixture
- `test/fixtures/profiles/customer.toml` — fixture
- `test/fixtures/profiles/broken-mode.toml` — fixture
- `test/fixtures/profiles/broken-placeholder.toml` — fixture
- `test/fixtures/brand/theme.css` — fixture css
- `test/fixtures/brand/logo.svg` — fixture logo
- `test/fixtures/brand/huge.css` — fixture 超過 100KB

**Modify:**
- `package.json` — 加 `@iarna/toml` dep
- `src/server/ui-profile.ts` — `UiProfile` 加 `exposeToolArgs`、brand 結構擴充、`parseUiProfile` 接 `profileFile` 參數、`filterEvent` tool_progress 改三階段
- `src/server/index.ts` — `parseArgs` 加 `--profile`、啟動串接 `loadProfile` / `loadBrandCss` / `/brand/theme.css` route、`printHelp` 新增段、`sendBootstrap` payload 擴充
- `src/extension/index.ts` — `StartOptions` 加 `profile`、`webui-profile` flag forward
- `test/ui-profile.test.mjs` — 既有測試 + profileFile merge 行為
- `public/app.js` — `connected` 處理 brand.tokens / brand.mode / brand.css、`tool_progress` packet 處理 progress phase
- `public/styles.css` — line 9 註解修正、line 527 / 623 兩處 hex 改 var
- `README.md` — 改寫 `## customer profile` 為 `## profiles`
- `ROADMAP.md` — done 區塊 +1
- `CHANGELOG.md` — 加 2026-05-26 區塊

---

## Milestone 1 — Profile Loader + 模組整合

### Task 1.1: 加 `@iarna/toml` 依賴

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 安裝依賴**

```bash
npm install @iarna/toml@^2.2.5 --save
```

- [ ] **Step 2: 驗證 package.json 內 dependencies 多了一行**

```bash
grep '"@iarna/toml"' package.json
```

Expected:
```
    "@iarna/toml": "^2.2.5",
```

- [ ] **Step 3: 確認 build 通過**

```bash
make
```

Expected: 不報錯,`dist/` 出來。

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: 加 @iarna/toml 解析 .pi/profiles/*.toml"
```

---

### Task 1.2: `profile-loader.ts` skeleton + 第一個測試(讀檔 + 基本欄位)

**Files:**
- Create: `src/server/profile-loader.ts`
- Create: `test/profile-loader.test.mjs`
- Create: `test/fixtures/profiles/staff.toml`

- [ ] **Step 1: 寫 fixture toml**

`test/fixtures/profiles/staff.toml`:

```toml
[meta]
description = "fixture staff profile"

[ui]
hide_thinking       = true
hide_tool_calls     = true
show_tool_progress  = true
hide_status_chips   = false
hide_session_picker = false
hide_model          = true
safe_errors         = true
expose_tool_args    = false

[brand]
name = "Fixture Staff"

[skills]
allow = ["brainstorming"]

[commands]
allow = ["new", "quit", "help"]

[defaults]
model = "anthropic/claude-opus-4-7"
```

- [ ] **Step 2: 寫 failing test**

`test/profile-loader.test.mjs`:

```javascript
// profile-loader 純單元測試:讀 toml + schema 驗證
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadProfile } from "../dist/server/profile-loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures", "profiles");

// 把 fixtures/profiles/staff.toml 對應的 cwd 算出來(./.pi/profiles/ 結構)
// loadProfile(name, cwd) 預期讀 <cwd>/.pi/profiles/<name>.toml
// 我們在 fixtures 下建一層 .pi/profiles -> ../<name>.toml 的 symlink 太麻煩;
// 改寫 cwd 為一個 tmp dir,複製 fixture 進去。
import fs from "node:fs";
import os from "node:os";

function makeCwdWithProfile(name, fixtureFile) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES, fixtureFile),
    path.join(profilesDir, `${name}.toml`),
  );
  return tmp;
}

test("loadProfile 讀 staff fixture 並解析欄位", () => {
  const cwd = makeCwdWithProfile("staff", "staff.toml");
  const profile = loadProfile("staff", cwd);

  assert.equal(profile.meta?.description, "fixture staff profile");
  assert.equal(profile.ui?.hide_thinking, true);
  assert.equal(profile.ui?.hide_status_chips, false);
  assert.equal(profile.brand?.name, "Fixture Staff");
  assert.deepEqual(profile.skills?.allow, ["brainstorming"]);
  assert.deepEqual(profile.commands?.allow, ["new", "quit", "help"]);
  assert.equal(profile.defaults?.model, "anthropic/claude-opus-4-7");
});
```

- [ ] **Step 3: 寫 minimal `profile-loader.ts`**

`src/server/profile-loader.ts`:

```typescript
import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";

export interface ToolLabelEntry {
  start?: string;
  progress?: string;
  end?: string;
}

export interface BrandConfig {
  name?: string;
  logo?: string;
  mode?: "dark" | "light";
  bg?: string;
  panel?: string;
  text?: string;
  accent?: string;
  border?: string;
  muted?: string;
  css?: string;
}

export interface UiFlags {
  hide_thinking?: boolean;
  hide_tool_calls?: boolean;
  show_tool_progress?: boolean;
  hide_status_chips?: boolean;
  hide_session_picker?: boolean;
  hide_model?: boolean;
  safe_errors?: boolean;
  expose_tool_args?: boolean;
}

export interface ProfileFile {
  meta?: { description?: string };
  ui?: UiFlags;
  brand?: BrandConfig;
  skills?: { allow?: string[] };
  commands?: { allow?: string[] };
  defaults?: { model?: string };
  tool_labels?: Record<string, ToolLabelEntry>;
}

export function loadProfile(name: string, cwd: string): ProfileFile {
  const filePath = path.join(cwd, ".pi", "profiles", `${name}.toml`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`profile not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed;
  try {
    parsed = TOML.parse(raw);
  } catch (e) {
    throw new Error(`profile syntax error: ${e.message}`);
  }
  return parsed as ProfileFile;
}
```

- [ ] **Step 4: build + 跑測試**

```bash
make && node --test test/profile-loader.test.mjs
```

Expected: 1 pass。

- [ ] **Step 5: Commit**

```bash
git add src/server/profile-loader.ts test/profile-loader.test.mjs test/fixtures/profiles/staff.toml
git commit -m "server: profile-loader skeleton + 基本 toml 解析"
```

---

### Task 1.3: customer 內建 fallback(檔不存在)

**Files:**
- Modify: `src/server/profile-loader.ts`
- Modify: `test/profile-loader.test.mjs`

- [ ] **Step 1: 加 failing test**

在 `test/profile-loader.test.mjs` 末尾加:

```javascript
test("loadProfile name=customer 檔不存在回內建 fallback", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  const profile = loadProfile("customer", tmp);

  // 內建 fallback 對齊既有 --ui-profile customer 解析結果
  assert.equal(profile.ui?.hide_thinking, true);
  assert.equal(profile.ui?.hide_tool_calls, true);
  assert.equal(profile.ui?.show_tool_progress, true);
  assert.equal(profile.ui?.hide_status_chips, true);
  assert.equal(profile.ui?.hide_session_picker, true);
  assert.equal(profile.ui?.hide_model, true);
  assert.equal(profile.ui?.safe_errors, true);
});

test("loadProfile name=staff 檔不存在 throw", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  assert.throws(
    () => loadProfile("staff", tmp),
    /profile not found/,
  );
});
```

- [ ] **Step 2: 跑測試確認 fail**

```bash
make && node --test test/profile-loader.test.mjs
```

Expected: 兩個 customer test fail(因 customer 也 throw)。

- [ ] **Step 3: 加 customer fallback 邏輯**

`src/server/profile-loader.ts` 內 `loadProfile` 前加常數,並修改 `loadProfile`:

```typescript
const CUSTOMER_FALLBACK: ProfileFile = {
  meta: { description: "built-in customer preset fallback" },
  ui: {
    hide_thinking: true,
    hide_tool_calls: true,
    show_tool_progress: true,
    hide_status_chips: true,
    hide_session_picker: true,
    hide_model: true,
    safe_errors: true,
    expose_tool_args: false,
  },
};

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
  return parsed as ProfileFile;
}
```

- [ ] **Step 4: 跑測試確認 pass**

```bash
make && node --test test/profile-loader.test.mjs
```

Expected: 3 pass。

- [ ] **Step 5: Commit**

```bash
git add src/server/profile-loader.ts test/profile-loader.test.mjs
git commit -m "server: profile-loader 加 customer 內建 fallback"
```

---

### Task 1.4: brand schema 驗證(mode / hex / 路徑)

**Files:**
- Modify: `src/server/profile-loader.ts`
- Modify: `test/profile-loader.test.mjs`
- Create: `test/fixtures/profiles/broken-mode.toml`
- Create: `test/fixtures/brand/logo.svg`

- [ ] **Step 1: 建立 fixture**

`test/fixtures/profiles/broken-mode.toml`:

```toml
[brand]
mode = "weird"
```

`test/fixtures/brand/logo.svg`:

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#0066cc"/></svg>
```

- [ ] **Step 2: 加 failing tests**

在 `test/profile-loader.test.mjs` 末尾加:

```javascript
test("loadProfile [brand].mode 非 dark/light → throw", () => {
  const cwd = makeCwdWithProfile("broken", "broken-mode.toml");
  assert.throws(
    () => loadProfile("broken", cwd),
    /\[brand\]\.mode/,
  );
});

test("loadProfile [brand].bg 不是 hex → throw", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "x.toml"),
    `[brand]\nbg = "not-hex"\n`,
  );
  assert.throws(() => loadProfile("x", tmp), /\[brand\]\.bg/);
});

test("loadProfile [brand].bg 合法 hex 短長兩種", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "a.toml"),
    `[brand]\nbg = "#fafafa"\naccent = "#06c"\n`,
  );
  const profile = loadProfile("a", tmp);
  assert.equal(profile.brand?.bg, "#fafafa");
  assert.equal(profile.brand?.accent, "#06c");
});

test("loadProfile [brand].logo 路徑不存在 → throw", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "x.toml"),
    `[brand]\nlogo = "./nope.svg"\n`,
  );
  assert.throws(() => loadProfile("x", tmp), /\[brand\]\.logo/);
});

test("loadProfile [brand].logo 路徑存在 OK", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES, "..", "brand", "logo.svg"),
    path.join(tmp, "logo.svg"),
  );
  fs.writeFileSync(
    path.join(profilesDir, "a.toml"),
    `[brand]\nlogo = "./logo.svg"\n`,
  );
  const profile = loadProfile("a", tmp);
  assert.equal(profile.brand?.logo, "./logo.svg");
});

test("loadProfile [brand].color 自動 alias 到 accent", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "a.toml"),
    `[brand]\ncolor = "#06c"\n`,
  );
  const profile = loadProfile("a", tmp);
  assert.equal(profile.brand?.accent, "#06c");
});

test("loadProfile [brand].color + accent 同時設 → throw", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "a.toml"),
    `[brand]\ncolor = "#06c"\naccent = "#fff"\n`,
  );
  assert.throws(() => loadProfile("a", tmp), /color.*accent|accent.*color/);
});
```

- [ ] **Step 3: 跑測試確認全 fail**

```bash
make && node --test test/profile-loader.test.mjs
```

Expected: 多個新測試 fail。

- [ ] **Step 4: 加 validation 邏輯**

在 `src/server/profile-loader.ts` 內 `loadProfile` 之前加 helper:

```typescript
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
const HEX_FIELDS: (keyof BrandConfig)[] = ["bg", "panel", "text", "accent", "border", "muted"];

function validateBrand(brand: BrandConfig | undefined, cwd: string): void {
  if (!brand) return;

  // color → accent alias
  const brandWithColor = brand as BrandConfig & { color?: string };
  if (brandWithColor.color !== undefined) {
    if (brand.accent !== undefined) {
      throw new Error(`[brand]: 不可同時設 color 與 accent(color 是 accent 的 alias)`);
    }
    brand.accent = brandWithColor.color;
    delete brandWithColor.color;
  }

  if (brand.mode !== undefined && brand.mode !== "dark" && brand.mode !== "light") {
    throw new Error(`[brand].mode: 必須是 "dark" 或 "light",收到 "${brand.mode}"`);
  }

  for (const field of HEX_FIELDS) {
    const value = brand[field];
    if (value !== undefined && !HEX_COLOR_RE.test(value as string)) {
      throw new Error(`[brand].${field}: 不是合法 hex(#rgb / #rrggbb),收到 "${value}"`);
    }
  }

  for (const field of ["logo", "css"] as const) {
    const rel = brand[field];
    if (rel !== undefined) {
      const abs = path.resolve(cwd, rel);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        throw new Error(`[brand].${field}: 路徑不存在或非檔案: ${rel}`);
      }
    }
  }
}
```

並在 `loadProfile` 內 parse 完成後呼叫:

```typescript
  const profile = parsed as ProfileFile;
  validateBrand(profile.brand, cwd);
  return profile;
```

- [ ] **Step 5: 跑測試確認 pass**

```bash
make && node --test test/profile-loader.test.mjs
```

Expected: 全 pass。

- [ ] **Step 6: Commit**

```bash
git add src/server/profile-loader.ts test/profile-loader.test.mjs test/fixtures/
git commit -m "server: profile-loader brand schema 驗證(mode/hex/路徑/color-accent alias)"
```

---

### Task 1.5: 未知 toml 欄位 strict mode

**Files:**
- Modify: `src/server/profile-loader.ts`
- Modify: `test/profile-loader.test.mjs`

- [ ] **Step 1: 加 failing test**

在 `test/profile-loader.test.mjs` 末尾加:

```javascript
test("loadProfile 未知 top-level table → throw", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "x.toml"),
    `[wat]\nfoo = 1\n`,
  );
  assert.throws(() => loadProfile("x", tmp), /unknown.*\[wat\]/);
});

test("loadProfile 未知 [ui] 欄位 → throw(catch typo)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "x.toml"),
    `[ui]\nhide_thiking = true\n`,
  );
  assert.throws(() => loadProfile("x", tmp), /unknown.*ui.*hide_thiking/);
});
```

- [ ] **Step 2: 跑測試確認 fail**

```bash
make && node --test test/profile-loader.test.mjs
```

- [ ] **Step 3: 加 strict 欄位檢查**

在 `src/server/profile-loader.ts` 內加:

```typescript
const ALLOWED_TOP = new Set(["meta", "ui", "brand", "skills", "commands", "defaults", "tool_labels"]);
const ALLOWED_UI = new Set([
  "hide_thinking", "hide_tool_calls", "show_tool_progress",
  "hide_status_chips", "hide_session_picker", "hide_model",
  "safe_errors", "expose_tool_args",
]);
const ALLOWED_BRAND = new Set([
  "name", "logo", "mode", "bg", "panel", "text",
  "accent", "border", "muted", "css", "color",
]);

function validateUnknown(parsed: Record<string, unknown>): void {
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_TOP.has(key)) {
      throw new Error(`unknown top-level table: [${key}]`);
    }
  }
  const ui = parsed.ui as Record<string, unknown> | undefined;
  if (ui) {
    for (const key of Object.keys(ui)) {
      if (!ALLOWED_UI.has(key)) {
        throw new Error(`unknown field [ui].${key}`);
      }
    }
  }
  const brand = parsed.brand as Record<string, unknown> | undefined;
  if (brand) {
    for (const key of Object.keys(brand)) {
      if (!ALLOWED_BRAND.has(key)) {
        throw new Error(`unknown field [brand].${key}`);
      }
    }
  }
}
```

並在 `loadProfile` 內 parse 後、validateBrand 前呼叫:

```typescript
  const profile = parsed as ProfileFile;
  validateUnknown(parsed as Record<string, unknown>);
  validateBrand(profile.brand, cwd);
  return profile;
```

- [ ] **Step 4: 跑測試確認 pass**

```bash
make && node --test test/profile-loader.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add src/server/profile-loader.ts test/profile-loader.test.mjs
git commit -m "server: profile-loader 未知欄位 strict mode(catch toml typo)"
```

---

### Task 1.6: tool_labels placeholder 白名單驗證

**Files:**
- Modify: `src/server/profile-loader.ts`
- Modify: `test/profile-loader.test.mjs`
- Create: `test/fixtures/profiles/broken-placeholder.toml`

- [ ] **Step 1: 建 fixture**

`test/fixtures/profiles/broken-placeholder.toml`:

```toml
[tool_labels.read]
start = "正在 {wat} 處理"
end   = "完成"
```

- [ ] **Step 2: 加 failing tests**

在 `test/profile-loader.test.mjs` 末尾加:

```javascript
test("loadProfile tool_labels 未知 placeholder → throw 並指明 tool/phase", () => {
  const cwd = makeCwdWithProfile("p", "broken-placeholder.toml");
  assert.throws(
    () => loadProfile("p", cwd),
    /tool_labels\.read\.start.*\{wat\}/,
  );
});

test("loadProfile tool_labels 合法 placeholder OK", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "a.toml"),
    `[tool_labels.read]\nstart = "正在讀取 {file_basename}"\n` +
    `[tool_labels.WebFetch]\nstart = "正在抓取 {url_host}"\n` +
    `[tool_labels.bash]\nprogress = "處理中 {progress_count} 項"\n` +
    `[tool_labels.x]\nstart = "x = {tool_arg.x}"\n`,
  );
  const profile = loadProfile("a", tmp);
  assert.equal(profile.tool_labels?.read?.start, "正在讀取 {file_basename}");
});

test("loadProfile tool_labels 空 placeholder key → throw", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "a.toml"),
    `[tool_labels.read]\nstart = "x = {tool_arg.}"\n`,
  );
  assert.throws(() => loadProfile("a", tmp), /tool_labels\.read\.start.*tool_arg\./);
});
```

- [ ] **Step 3: 跑測試確認 fail**

```bash
make && node --test test/profile-loader.test.mjs
```

- [ ] **Step 4: 加 placeholder 白名單檢查**

在 `src/server/profile-loader.ts` 內加:

```typescript
const PLACEHOLDER_RE = /\{([^}]+)\}/g;
const ALLOWED_PLACEHOLDERS = new Set(["file_basename", "url_host", "progress_count"]);

function validatePlaceholders(toolLabels: ProfileFile["tool_labels"]): void {
  if (!toolLabels) return;
  for (const [toolName, entry] of Object.entries(toolLabels)) {
    for (const phase of ["start", "progress", "end"] as const) {
      const tpl = entry[phase];
      if (typeof tpl !== "string") continue;
      let m;
      const re = new RegExp(PLACEHOLDER_RE);
      while ((m = re.exec(tpl)) !== null) {
        const ph = m[1];
        if (ph.startsWith("tool_arg.")) {
          const key = ph.slice("tool_arg.".length);
          if (key.length === 0) {
            throw new Error(`tool_labels.${toolName}.${phase}: 無效 placeholder {tool_arg.}(key 為空)`);
          }
          continue;
        }
        if (!ALLOWED_PLACEHOLDERS.has(ph)) {
          throw new Error(`tool_labels.${toolName}.${phase}: 未知 placeholder {${ph}}`);
        }
      }
    }
  }
}
```

並在 `loadProfile` 內 validateBrand 後呼叫:

```typescript
  validateUnknown(parsed as Record<string, unknown>);
  validateBrand(profile.brand, cwd);
  validatePlaceholders(profile.tool_labels);
  return profile;
```

- [ ] **Step 5: 跑測試確認 pass**

```bash
make && node --test test/profile-loader.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add src/server/profile-loader.ts test/profile-loader.test.mjs test/fixtures/profiles/broken-placeholder.toml
git commit -m "server: profile-loader placeholder 白名單驗證"
```

---

### Task 1.7: `ui-profile.ts` 加 `exposeToolArgs` + brand 結構擴充

**Files:**
- Modify: `src/server/ui-profile.ts`
- Modify: `test/ui-profile.test.mjs`

- [ ] **Step 1: 讀現況**

```bash
sed -n '1,40p' src/server/ui-profile.ts
```

確認 `UiProfile` interface 與 `brand` 結構長相。

- [ ] **Step 2: 修改 `UiProfile` interface 與 default**

修改 `src/server/ui-profile.ts` 內的 `UiProfile`:

```typescript
export interface UiProfile {
  hideThinking: boolean;
  hideToolCalls: boolean;
  showToolProgress: boolean;
  hideStatusChips: boolean;
  hideSessionPicker: boolean;
  hideModel: boolean;
  safeErrors: boolean;
  exposeToolArgs: boolean;
  brand: {
    name: string | null;
    logoPath: string | null;
    mode: "dark" | "light" | null;
    tokens: {
      bg?: string;
      panel?: string;
      text?: string;
      accent?: string;
      border?: string;
      muted?: string;
    };
    cssPath: string | null;
  };
}
```

- [ ] **Step 3: 既有 `parseUiProfile` default 補新欄位**

`parseUiProfile` 回傳的 default object 內加 `exposeToolArgs: false`,brand 改成新結構(`tokens: {}`、`mode: null`、`cssPath: null`)。

- [ ] **Step 4: 既有 `parseUiProfile` 既有測試補對應 assertion**

`test/ui-profile.test.mjs` 內既有「default 全 false / brand 全 null」測試補:

```javascript
assert.equal(profile.exposeToolArgs, false);
assert.equal(profile.brand.mode, null);
assert.deepEqual(profile.brand.tokens, {});
assert.equal(profile.brand.cssPath, null);
```

- [ ] **Step 5: build + 測試**

```bash
make && node --test test/ui-profile.test.mjs
```

Expected: 全 pass。

- [ ] **Step 6: Commit**

```bash
git add src/server/ui-profile.ts test/ui-profile.test.mjs
git commit -m "server: UiProfile 加 exposeToolArgs + brand tokens/mode/css 結構"
```

---

### Task 1.8: `parseUiProfile` 接 `profileFile` 參數,merge 順序

**Files:**
- Modify: `src/server/ui-profile.ts`
- Modify: `test/ui-profile.test.mjs`

- [ ] **Step 1: 寫 failing test**

在 `test/ui-profile.test.mjs` 末尾加:

```javascript
test("parseUiProfile 接 profileFile 套用 ui 旗標", () => {
  const profile = parseUiProfile({}, {}, {
    ui: {
      hide_thinking: true,
      hide_tool_calls: true,
      show_tool_progress: true,
    },
  });
  assert.equal(profile.hideThinking, true);
  assert.equal(profile.hideToolCalls, true);
  assert.equal(profile.showToolProgress, true);
  assert.equal(profile.hideStatusChips, false);
});

test("parseUiProfile 個別 CLI flag override profileFile", () => {
  const profile = parseUiProfile(
    { "hide-thinking": false },
    {},
    { ui: { hide_thinking: true } },
  );
  assert.equal(profile.hideThinking, false);
});

test("parseUiProfile profileFile.brand 對應到 UiProfile.brand 結構", () => {
  const profile = parseUiProfile({}, {}, {
    brand: {
      name: "X",
      logo: "./logo.svg",
      mode: "light",
      bg: "#fafafa",
      accent: "#06c",
      css: "./theme.css",
    },
  });
  assert.equal(profile.brand.name, "X");
  assert.equal(profile.brand.mode, "light");
  assert.equal(profile.brand.tokens.bg, "#fafafa");
  assert.equal(profile.brand.tokens.accent, "#06c");
  assert.equal(profile.brand.logoPath, "./logo.svg");
  assert.equal(profile.brand.cssPath, "./theme.css");
});
```

- [ ] **Step 2: 跑測試確認 fail**

```bash
make && node --test test/ui-profile.test.mjs
```

- [ ] **Step 3: 改 `parseUiProfile` 簽名與 merge 邏輯**

`src/server/ui-profile.ts` 內 `parseUiProfile`:

```typescript
import type { ProfileFile } from "./profile-loader.js";

export function parseUiProfile(
  cliArgs: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  profileFile?: ProfileFile,
): UiProfile {
  // 既有 default
  const defaults: UiProfile = { /* 既有結構 */ };

  // 1. 套 customer preset(若 --ui-profile=customer 或 env)— 既有行為
  // 2. 套 profileFile(若有)
  //    - ui flags 對應(snake_case → camelCase)
  //    - brand 對應(logo → logoPath、css → cssPath、bg/panel/.../accent → tokens.*)
  // 3. 套個別 CLI / env override

  if (profileFile?.ui) {
    const ui = profileFile.ui;
    if (ui.hide_thinking !== undefined) defaults.hideThinking = ui.hide_thinking;
    if (ui.hide_tool_calls !== undefined) defaults.hideToolCalls = ui.hide_tool_calls;
    if (ui.show_tool_progress !== undefined) defaults.showToolProgress = ui.show_tool_progress;
    if (ui.hide_status_chips !== undefined) defaults.hideStatusChips = ui.hide_status_chips;
    if (ui.hide_session_picker !== undefined) defaults.hideSessionPicker = ui.hide_session_picker;
    if (ui.hide_model !== undefined) defaults.hideModel = ui.hide_model;
    if (ui.safe_errors !== undefined) defaults.safeErrors = ui.safe_errors;
    if (ui.expose_tool_args !== undefined) defaults.exposeToolArgs = ui.expose_tool_args;
  }

  if (profileFile?.brand) {
    const b = profileFile.brand;
    if (b.name !== undefined) defaults.brand.name = b.name;
    if (b.logo !== undefined) defaults.brand.logoPath = b.logo;
    if (b.mode !== undefined) defaults.brand.mode = b.mode;
    if (b.css !== undefined) defaults.brand.cssPath = b.css;
    for (const k of ["bg", "panel", "text", "accent", "border", "muted"] as const) {
      if (b[k] !== undefined) defaults.brand.tokens[k] = b[k];
    }
  }

  // 既有 CLI / env override 邏輯不動,但要 override 上面 merge 完的 defaults
  // ... (既有 code)
}
```

注意:既有 code 內 CLI / env 處理用的是「if 設定就覆寫 default」,把 profileFile 的 merge 放在 CLI / env 處理**之前**即可達成「CLI > env > profileFile」。

- [ ] **Step 4: 跑測試確認 pass**

```bash
make && node --test test/ui-profile.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add src/server/ui-profile.ts test/ui-profile.test.mjs
git commit -m "server: parseUiProfile 接 profileFile 參數,merge 順序 CLI > env > profile"
```

---

### Task 1.9: `index.ts` 加 `--profile` 解析 + 串接 loadProfile + printHelp

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: 在 `parseArgs`(約 line 226)加 --profile 解析**

`src/server/index.ts` 內 `parseArgs` 加分支(找到既有 `--ui-profile` 旁邊):

```javascript
} else if (a === "--profile") {
  out.profile = argv[++i];
}
```

- [ ] **Step 2: 在啟動序列載入 profile**

在 `effectiveUiProfile = parseUiProfile(args, process.env);`(約 line 381)之前加:

```javascript
import { loadProfile } from "./profile-loader.js";

// ...

let profileFile = undefined;
const profileName = args.profile || process.env.PI_WEBUI_PROFILE;
if (profileName) {
  try {
    profileFile = loadProfile(profileName, cwd);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}

effectiveUiProfile = parseUiProfile(args, process.env, profileFile);
```

- [ ] **Step 3: `printHelp` 加 `--profile` 段**

在 `printHelp`(line 116)既有 `--ui-profile` 段附近加:

```javascript
"  --profile <name>            load .pi/profiles/<name>.toml(name=customer 無檔則用內建 fallback)",
```

env 表也加:

```javascript
"  PI_WEBUI_PROFILE            profile name(same as --profile)",
```

- [ ] **Step 4: build 通過**

```bash
make
```

Expected: 無 type error。

- [ ] **Step 5: 手測 — 啟動不存在的 profile 應 fail-fast**

```bash
node dist/server/index.js --profile no-such-profile
```

Expected: exit 非 0,stderr 帶 `profile not found:` 訊息。

- [ ] **Step 6: 手測 — 啟動 customer profile(無檔)應走 fallback**

```bash
node dist/server/index.js --profile customer &
SERVER_PID=$!
sleep 1
curl -s http://127.0.0.1:4096 > /dev/null && echo OK
kill $SERVER_PID
```

Expected: 啟動成功,curl 200。

- [ ] **Step 7: Commit**

```bash
git add src/server/index.ts
git commit -m "server: --profile 解析 + 啟動串接 loadProfile + printHelp"
```

---

### Task 1.10: extension forward `--webui-profile`

**Files:**
- Modify: `src/extension/index.ts`

- [ ] **Step 1: 加 `profile` 欄位**

`src/extension/index.ts` 內 `StartOptions`(line 84)加:

```typescript
profile?: string;
```

- [ ] **Step 2: forward 邏輯**

在 `runStart` 內 serverArgs push 區塊(line 126 附近)加:

```typescript
if (opts.profile) serverArgs.push("--profile", opts.profile);
```

- [ ] **Step 3: 註冊 pi flag**

找到既有 `webui-ui-profile` 或類似的 flag 註冊處,加一個 `webui-profile`(查既有 `registerFlags` / `meta` 等慣例,沿用)。

- [ ] **Step 4: build 通過**

```bash
make
```

- [ ] **Step 5: Commit**

```bash
git add src/extension/index.ts
git commit -m "extension: forward --webui-profile 給 spawn 的 server"
```

---

### Task 1.11: 整合測試第一波(profile 載入 / fallback / 不存在)

**Files:**
- Create: `test/server-profile.test.mjs`
- Create: `test/fixtures/profiles/integration-staff.toml`

- [ ] **Step 1: 建 fixture**

`test/fixtures/profiles/integration-staff.toml`:

```toml
[ui]
hide_thinking      = true
hide_tool_calls    = true
show_tool_progress = true
hide_model         = true

[brand]
name   = "Integration Staff"
accent = "#0066cc"
```

- [ ] **Step 2: 寫 integration test**

`test/server-profile.test.mjs`:

```javascript
// 整合測試:spawn 真 server,驗證 --profile 行為
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "dist", "server", "index.js");
const FIXTURES = path.join(__dirname, "fixtures", "profiles");

function makeCwd(profileName, fixtureFile) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-server-"));
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

async function spawnServer(cwd, args, env = {}) {
  const proc = spawn(process.execPath, [SERVER, ...args], {
    cwd,
    env: { ...process.env, ...env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const port = await new Promise((resolve, reject) => {
    let stderr = "";
    const onData = (chunk) => {
      const s = chunk.toString();
      stderr += s;
      const m = s.match(/listening on .+:(\d+)/);
      if (m) resolve(Number(m[1]));
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("exit", (code) => reject(new Error(`server exited ${code}: ${stderr}`)));
    setTimeout(() => reject(new Error(`server timeout: ${stderr}`)), 10000);
  });
  return { proc, port };
}

async function getConnected(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "connected") {
        ws.close();
        resolve(msg);
      }
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("ws timeout")), 5000);
  });
}

test("--profile <不存在> exit 非 0", async () => {
  const cwd = makeCwd();
  const proc = spawn(process.execPath, [SERVER, "--profile", "nope"], {
    cwd,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (c) => { stderr += c.toString(); });
  const code = await new Promise((r) => proc.on("exit", r));
  assert.notEqual(code, 0);
  assert.match(stderr, /profile not found/);
});

test("--profile customer 無檔走內建 fallback", async () => {
  const cwd = makeCwd();
  const { proc, port } = await spawnServer(cwd, ["--profile", "customer"]);
  try {
    const connected = await getConnected(port);
    assert.equal(connected.uiProfile.hideThinking, true);
    assert.equal(connected.uiProfile.hideToolCalls, true);
    assert.equal(connected.uiProfile.safeErrors, true);
  } finally {
    proc.kill();
  }
});

test("--profile staff 套用 fixture 內容", async () => {
  const cwd = makeCwd("staff", "integration-staff.toml");
  const { proc, port } = await spawnServer(cwd, ["--profile", "staff"]);
  try {
    const connected = await getConnected(port);
    assert.equal(connected.uiProfile.hideThinking, true);
    assert.equal(connected.uiProfile.hideModel, true);
    assert.equal(connected.uiProfile.brand.name, "Integration Staff");
    assert.equal(connected.uiProfile.brand.tokens.accent, "#0066cc");
  } finally {
    proc.kill();
  }
});

test("個別 CLI flag override profile", async () => {
  const cwd = makeCwd("staff", "integration-staff.toml");
  const { proc, port } = await spawnServer(cwd, ["--profile", "staff", "--brand-name", "Override"]);
  try {
    const connected = await getConnected(port);
    assert.equal(connected.uiProfile.brand.name, "Override");
  } finally {
    proc.kill();
  }
});
```

- [ ] **Step 3: 跑測試**

```bash
make && node --test test/server-profile.test.mjs
```

Expected: 全 pass。

- [ ] **Step 4: Commit**

```bash
git add test/server-profile.test.mjs test/fixtures/profiles/integration-staff.toml
git commit -m "test: server-profile 整合測試第一波(載入/fallback/不存在/CLI override)"
```

---

### Task 1.12: profile 內 `[skills].allow` / `[commands].allow` / `[defaults].model` 套用 + override 警告

**Files:**
- Modify: `src/server/index.ts`
- Modify: `test/server-profile.test.mjs`

- [ ] **Step 1: 看現況既有 skill / commands allow 處理位置**

```bash
grep -nE "(resolveSkillAllowFile|commands-allow|skillAllow|commandAllow)" src/server/index.ts
```

找到既有 skill allow / commands allow / model default 解析處(都在 `parseArgs` 之後、`createServer` 之前)。

- [ ] **Step 2: 在 profileFile 載入後接過去**

在既有 `effectiveUiProfile = parseUiProfile(args, process.env, profileFile);` 後面、`createServer` 之前加:

```javascript
// profile [skills].allow override .pi/skills-allow.txt
if (profileFile?.skills?.allow) {
  const allowFilePath = path.join(cwd, ".pi", "skills-allow.txt");
  if (fs.existsSync(allowFilePath)) {
    console.log(`profile [skills].allow override ${allowFilePath}`);
  }
  // 把 allow list 寫進既有變數 — 找 grep 出來的既有變數名稱接過去
  // 例: skillAllowList = profileFile.skills.allow;
}

// profile [commands].allow override .pi/commands-allow.txt
if (profileFile?.commands?.allow) {
  const allowFilePath = path.join(cwd, ".pi", "commands-allow.txt");
  if (fs.existsSync(allowFilePath)) {
    console.log(`profile [commands].allow override ${allowFilePath}`);
  }
  // 同上,接既有 commands allow 變數
}

// profile [defaults].model — 對應 --model
// 注意 CLI > env > profile,所以這裡只在 args.model && process.env.PI_WEBUI_MODEL 都沒設時才套
if (profileFile?.defaults?.model && !args.model && !process.env.PI_WEBUI_MODEL) {
  args.model = profileFile.defaults.model;
}
```

(實際變數名稱 follow 現有 code;若 skillAllow 解析在更前面就把 profile merge 提到該位置之前)

- [ ] **Step 3: 加 failing integration test**

`test/server-profile.test.mjs` 末尾加:

```javascript
test("profile [skills].allow 與 .pi/skills-allow.txt 同存 → 印 override 警告", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-server-"));
  const dir = path.join(cwd, ".pi", "profiles");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "skills-allow.txt"), "old-skill\n");
  fs.writeFileSync(path.join(dir, "staff.toml"), `[skills]\nallow = ["new-skill"]\n`);

  // spawn 改成抓 stdout
  const proc = spawn(process.execPath, [SERVER, "--profile", "staff"], {
    cwd,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (c) => { stdout += c.toString(); });
  proc.stderr.on("data", (c) => { stderr += c.toString(); });
  await new Promise((r) => setTimeout(r, 2000));
  proc.kill();
  await new Promise((r) => proc.on("exit", r));

  const combined = stdout + stderr;
  assert.match(combined, /profile \[skills\]\.allow override/);
});

test("profile [defaults].model 啟動套用,但 --model CLI 勝", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-server-"));
  const dir = path.join(cwd, ".pi", "profiles");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "staff.toml"),
    `[defaults]\nmodel = "anthropic/claude-opus-4-7"\n`);

  // case 1: profile 套用
  const a = await spawnServer(cwd, ["--profile", "staff"]);
  try {
    const connected = await getConnected(a.port);
    assert.equal(connected.model, "anthropic/claude-opus-4-7");
  } finally { a.proc.kill(); }

  // case 2: CLI override profile
  const b = await spawnServer(cwd, ["--profile", "staff", "--model", "anthropic/claude-haiku-4-5"]);
  try {
    const connected = await getConnected(b.port);
    assert.equal(connected.model, "anthropic/claude-haiku-4-5");
  } finally { b.proc.kill(); }
});
```

(若 `connected` packet 不直接帶 `model` 欄位,改 assert 其他 model-related 欄位;先 grep 確認 connected payload 內 model 怎麼帶)

- [ ] **Step 4: build + 跑測試**

```bash
make && node --test test/server-profile.test.mjs
```

Expected: 全 pass。

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts test/server-profile.test.mjs
git commit -m "server: profile [skills/commands].allow + [defaults].model 套用與 override 警告"
```

---

## Milestone 2 — Brand 機制完整化

### Task 2.1: `brand-overlay.ts` 載入器 + size limit

**Files:**
- Create: `src/server/brand-overlay.ts`
- Create: `test/brand-overlay.test.mjs`
- Create: `test/fixtures/brand/theme.css`
- Create: `test/fixtures/brand/huge.css`

- [ ] **Step 1: 建 fixture**

`test/fixtures/brand/theme.css`:

```css
:root {
  color-scheme: light;
  --bg: #fafafa;
  --accent: #0066cc;
  --tool: #b87333;
}
```

`test/fixtures/brand/huge.css`:

```bash
# 用指令產生 > 100KB 檔案
node -e "require('fs').writeFileSync('test/fixtures/brand/huge.css', '/* '.repeat(30000) + 'X' + '*/'.repeat(30000))"
ls -la test/fixtures/brand/huge.css
```

確認 > 100000 bytes。

- [ ] **Step 2: 寫 failing test**

`test/brand-overlay.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadBrandCss } from "../dist/server/brand-overlay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures", "brand");

test("loadBrandCss null 路徑回 null", () => {
  assert.equal(loadBrandCss(null), null);
});

test("loadBrandCss 讀 fixture css 回 buffer 並含內容", () => {
  const buf = loadBrandCss(path.join(FIXTURES, "theme.css"));
  assert.ok(buf instanceof Buffer);
  assert.match(buf.toString("utf8"), /--accent: #0066cc/);
});

test("loadBrandCss 不存在路徑 throw", () => {
  assert.throws(
    () => loadBrandCss(path.join(FIXTURES, "nope.css")),
    /not found/,
  );
});

test("loadBrandCss > 100KB throw", () => {
  assert.throws(
    () => loadBrandCss(path.join(FIXTURES, "huge.css")),
    /> 100KB|size/,
  );
});
```

- [ ] **Step 3: 寫 implementation**

`src/server/brand-overlay.ts`:

```typescript
import fs from "node:fs";

const MAX_SIZE = 100 * 1024;

export function loadBrandCss(filePath: string | null): Buffer | null {
  if (!filePath) return null;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`brand.css: file not found: ${filePath}`);
  }
  const size = fs.statSync(filePath).size;
  if (size > MAX_SIZE) {
    throw new Error(`brand.css: file size ${size} > 100KB limit (${filePath})`);
  }
  return fs.readFileSync(filePath);
}
```

- [ ] **Step 4: 跑測試確認 pass**

```bash
make && node --test test/brand-overlay.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add src/server/brand-overlay.ts test/brand-overlay.test.mjs test/fixtures/brand/
git commit -m "server: brand-overlay 載入器(size limit 100KB)"
```

---

### Task 2.2: `index.ts` 註冊 `GET /brand/theme.css` route

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: 看現況 `/brand/logo` route 怎麼寫**

```bash
grep -n "/brand/logo" src/server/index.ts
```

找到既有 route handler 寫法。

- [ ] **Step 2: 加入 CSS overlay 載入與 route**

在 `effectiveUiProfile = parseUiProfile(...)` 之後加:

```javascript
import { loadBrandCss } from "./brand-overlay.js";

let brandCssBuffer = null;
if (effectiveUiProfile.brand.cssPath) {
  try {
    const abs = path.resolve(cwd, effectiveUiProfile.brand.cssPath);
    brandCssBuffer = loadBrandCss(abs);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
```

在既有 `/brand/logo` route 旁邊加:

```javascript
if (url.pathname === "/brand/theme.css" && req.method === "GET") {
  if (brandCssBuffer) {
    res.writeHead(200, {
      "Content-Type": "text/css; charset=utf-8",
      "Content-Length": String(brandCssBuffer.length),
      "Cache-Control": "no-store",
    });
    res.end(brandCssBuffer);
  } else {
    res.writeHead(404).end();
  }
  return;
}
```

- [ ] **Step 3: build 通過**

```bash
make
```

- [ ] **Step 4: 手測**

```bash
# 建一個 cwd 帶 css overlay
mkdir -p /tmp/pi-test/.pi/profiles /tmp/pi-test/assets
cat > /tmp/pi-test/assets/theme.css <<'EOF'
:root { --accent: #ff0066; }
EOF
cat > /tmp/pi-test/.pi/profiles/staff.toml <<'EOF'
[brand]
css = "./assets/theme.css"
EOF
node dist/server/index.js --profile staff --listen 127.0.0.1:14096 &
SERVER_PID=$!
sleep 1
curl -s -i http://127.0.0.1:14096/brand/theme.css | head -5
kill $SERVER_PID
```

Expected: 200 + Content-Type: text/css。

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts
git commit -m "server: 加 GET /brand/theme.css route(css overlay)"
```

---

### Task 2.3: `connected` packet 加 `brand.tokens` / `brand.mode` / `brand.css`

**Files:**
- Modify: `src/server/index.ts`

- [ ] **Step 1: 找 connected payload 構造處**

```bash
grep -nE "(brand|uiProfile)" src/server/index.ts | head -20
```

找到 `sendBootstrap` 或 connected packet 構造 brand 結構處。

- [ ] **Step 2: payload 擴充**

找到既有 brand 構造區段,改成:

```javascript
brand: {
  name: effectiveUiProfile.brand.name,
  logoUrl: effectiveUiProfile.brand.logoPath ? "/brand/logo" : null,
  mode: effectiveUiProfile.brand.mode,
  tokens: effectiveUiProfile.brand.tokens,
  css: brandCssBuffer !== null,
},
```

- [ ] **Step 3: build**

```bash
make
```

- [ ] **Step 4: 加整合測試**

在 `test/server-profile.test.mjs` 末尾加:

```javascript
test("connected packet 帶 brand.tokens / brand.mode / brand.css", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-server-"));
  const dir = path.join(cwd, ".pi", "profiles");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(cwd, "theme.css"), `:root { --accent: red; }`);
  fs.writeFileSync(path.join(dir, "staff.toml"), `
[brand]
mode = "light"
bg = "#fafafa"
accent = "#0066cc"
css = "./theme.css"
`);
  const { proc, port } = await spawnServer(cwd, ["--profile", "staff"]);
  try {
    const connected = await getConnected(port);
    assert.equal(connected.uiProfile.brand.mode, "light");
    assert.equal(connected.uiProfile.brand.tokens.bg, "#fafafa");
    assert.equal(connected.uiProfile.brand.tokens.accent, "#0066cc");
    assert.equal(connected.uiProfile.brand.css, true);

    // GET /brand/theme.css 拿得到
    const res = await fetch(`http://127.0.0.1:${port}/brand/theme.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/css/);
    assert.match(await res.text(), /--accent: red/);
  } finally {
    proc.kill();
  }
});
```

- [ ] **Step 5: 跑測試**

```bash
make && node --test test/server-profile.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add src/server/index.ts test/server-profile.test.mjs
git commit -m "server: connected packet 加 brand.tokens / mode / css 欄位"
```

---

### Task 2.4: `public/app.js` 套用 brand 三件(tokens / mode / css)

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: 找 client connected handler**

```bash
grep -nE "(connected|uiProfile|brand)" public/app.js | head -20
```

找到既有 connected 處理區塊內 brand 處理處。

- [ ] **Step 2: 改寫 brand 套用邏輯**

在既有 brand 套用區塊(只有 brand-color 一行)前後改成:

```javascript
function applyBrand(brand) {
  if (!brand) return;

  if (brand.name) {
    document.title = brand.name;
    const el = document.getElementById("brand-name");
    if (el) el.textContent = brand.name;
  }

  if (brand.logoUrl) {
    const el = document.getElementById("brand-logo");
    if (el) el.src = brand.logoUrl;
  }

  // 既有 --brand-color 對齊到 tokens.accent
  if (brand.tokens) {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(brand.tokens)) {
      root.style.setProperty(`--${k}`, v);
    }
    // 維持既有 --brand-color = --accent 行為
    if (brand.tokens.accent) {
      root.style.setProperty("--brand-color", brand.tokens.accent);
    }
  }

  if (brand.mode) {
    document.documentElement.style.colorScheme = brand.mode;
  }

  if (brand.css === true) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/brand/theme.css";
    document.head.appendChild(link);
  }
}
```

把既有 connected handler 內處理 brand 的程式碼改成呼叫 `applyBrand(msg.uiProfile.brand)`。

- [ ] **Step 3: build + 跑 lint(node --check public/*.mjs)**

```bash
make lint
```

Expected: 無錯。

- [ ] **Step 4: 手測**

```bash
# 啟動 server,瀏覽器開,看 light theme + 紅色 accent
node dist/server/index.js --profile staff --listen 127.0.0.1:14097 &
SERVER_PID=$!
sleep 1
echo "open http://127.0.0.1:14097 in browser; check light theme + red accent"
sleep 10
kill $SERVER_PID
```

(實際手動測試,確認看到 light theme + 自訂主色)

- [ ] **Step 5: Commit**

```bash
git add public/app.js
git commit -m "webui: 套用 brand.tokens(多個 CSS var)+ mode(colorScheme)+ css overlay link"
```

---

### Task 2.5: `public/styles.css` 修 line 9 註解與 line 527 / 623 兩處 hex

**Files:**
- Modify: `public/styles.css`

- [ ] **Step 1: 修 line 9 註解**

```bash
sed -n '9p' public/styles.css
```

當前:
```
  /* --brand-color 由 --brand-color CLI 設定;未設定時 fallback 為原本的 anthropic orange */
```

改成:
```css
  /* --brand-color 由 --brand-color CLI 旗標或 .pi/profiles/<name>.toml 內 [brand].accent 設定 */
```

- [ ] **Step 2: 修 line 527 與 623 寫死 hex**

```bash
sed -n '525,530p' public/styles.css
sed -n '620,625p' public/styles.css
```

把 `color: #ece4d8;` 改 `color: var(--text);`
把 `color: #6e6a60;` 改 `color: var(--thinking);`(如果 context 表示 thinking)或 `var(--muted);`(如果是 secondary text)— 從上下文判斷,通常 #6e6a60 是 thinking 色。

- [ ] **Step 3: 確認沒有其他寫死 hex 漏掉**

```bash
grep -nE "#[0-9a-fA-F]{3,6}" public/styles.css | grep -v "var(--"
```

Expected: 只剩 `:root` 內 13 個 token default 值。

- [ ] **Step 4: build + lint**

```bash
make lint
```

- [ ] **Step 5: Commit**

```bash
git add public/styles.css
git commit -m "webui: styles.css 修兩處寫死 hex 改 var(--text/thinking),註解修正"
```

---

### Task 2.6: 手動驗證 M2 全套

- [ ] **Step 1: 工程師裸啟動,確認現狀完全不變**

```bash
node dist/server/index.js --listen 127.0.0.1:14096 &
SERVER_PID=$!
sleep 1
echo "open http://127.0.0.1:14096 — 應該是現狀 dark theme + anthropic 橘"
sleep 15
kill $SERVER_PID
```

- [ ] **Step 2: customer 無檔(等同 --ui-profile customer)**

```bash
node dist/server/index.js --profile customer --listen 127.0.0.1:14096 &
SERVER_PID=$!
sleep 1
echo "open http://127.0.0.1:14096 — 應該是 customer profile 樣式"
sleep 15
kill $SERVER_PID
```

- [ ] **Step 3: staff 完整 toml + css overlay**

建 `/tmp/pi-test-full/.pi/profiles/staff.toml`:

```toml
[meta]
description = "M2 full test"

[ui]
hide_thinking      = true
hide_tool_calls    = true
show_tool_progress = true
hide_model         = true

[brand]
name   = "M2 Test"
mode   = "light"
bg     = "#fafafa"
panel  = "#ffffff"
text   = "#1a1a1a"
accent = "#0066cc"
border = "#e0e0e0"
muted  = "#707070"
css    = "./assets/theme.css"
```

並建 `/tmp/pi-test-full/assets/theme.css`:

```css
:root { --tool: #b87333; }
```

跑:

```bash
cd /tmp/pi-test-full && node /path/to/dist/server/index.js --profile staff --listen 127.0.0.1:14096 &
SERVER_PID=$!
sleep 1
echo "open http://127.0.0.1:14096 — 應該是 light theme + 藍色 accent + tool 訊息銅橘色"
sleep 30
kill $SERVER_PID
```

確認:
- 標題列顯示 "M2 Test"
- 背景白 + 文字黑(light theme)
- accent 是藍色(spinner / 高亮)
- 觸發一個 tool call,tool 訊息泡泡是銅橘色(來自 css overlay 覆寫 --tool)

- [ ] **Step 4: 確認沒問題後標記 milestone 2 完成**

不需 commit(只是手測);如有任何 anomaly 回頭修。

---

## Milestone 3 — tool 標籤三階段

### Task 3.1: `tool-label.ts` resolveLabel + 標準 placeholder

**Files:**
- Create: `src/server/tool-label.ts`
- Create: `test/tool-label.test.mjs`

- [ ] **Step 1: 寫 failing test**

`test/tool-label.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveLabel } from "../dist/server/tool-label.js";

const FAKE_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeProfile(overrides = {}) {
  return {
    exposeToolArgs: false,
    ...overrides,
    toolLabels: overrides.toolLabels || {},
  };
}

test("resolveLabel profile 內列出 tool/phase → 用 profile", () => {
  const profile = makeProfile({
    toolLabels: {
      read: { start: "正在讀取 nine9 資料", end: "讀取完成" },
    },
  });
  assert.equal(
    resolveLabel(profile, "read", "start", {}, FAKE_LOGGER),
    "正在讀取 nine9 資料",
  );
  assert.equal(
    resolveLabel(profile, "read", "end", {}, FAKE_LOGGER),
    "讀取完成",
  );
});

test("resolveLabel profile 未列 tool → 走 _default", () => {
  const profile = makeProfile({
    toolLabels: { _default: { start: "自訂 default", end: "" } },
  });
  assert.equal(
    resolveLabel(profile, "ReadFile", "start", {}, FAKE_LOGGER),
    "自訂 default",
  );
});

test("resolveLabel profile 未列 + 無 _default → built-in", () => {
  const profile = makeProfile();
  assert.equal(
    resolveLabel(profile, "ReadFile", "start", {}, FAKE_LOGGER),
    "正在處理...",
  );
  assert.equal(
    resolveLabel(profile, "ReadFile", "end", {}, FAKE_LOGGER),
    "",
  );
});

test("resolveLabel {file_basename} 解出 basename", () => {
  const profile = makeProfile({
    toolLabels: { read: { start: "正在讀 {file_basename}" } },
  });
  assert.equal(
    resolveLabel(profile, "read", "start", { file: "/path/to/foo.txt" }, FAKE_LOGGER),
    "正在讀 foo.txt",
  );
});

test("resolveLabel {url_host} 解出 hostname", () => {
  const profile = makeProfile({
    toolLabels: { WebFetch: { start: "抓 {url_host}" } },
  });
  assert.equal(
    resolveLabel(profile, "WebFetch", "start", { url: "https://nine9.com.tw/foo" }, FAKE_LOGGER),
    "抓 nine9.com.tw",
  );
});

test("resolveLabel {tool_arg.url} + expose_tool_args=false → 空字串", () => {
  const profile = makeProfile({
    toolLabels: { WebFetch: { start: "抓 {tool_arg.url}" } },
  });
  assert.equal(
    resolveLabel(profile, "WebFetch", "start", { url: "https://nine9.com.tw" }, FAKE_LOGGER),
    "抓 ",
  );
});

test("resolveLabel {tool_arg.url} + expose_tool_args=true → 帶入完整", () => {
  const profile = makeProfile({
    exposeToolArgs: true,
    toolLabels: { WebFetch: { start: "抓 {tool_arg.url}" } },
  });
  assert.equal(
    resolveLabel(profile, "WebFetch", "start", { url: "https://nine9.com.tw" }, FAKE_LOGGER),
    "抓 https://nine9.com.tw",
  );
});

test("resolveLabel runtime args 缺 placeholder 對應 → 空字串", () => {
  const profile = makeProfile({
    toolLabels: { read: { start: "讀 {file_basename}" } },
  });
  assert.equal(
    resolveLabel(profile, "read", "start", {}, FAKE_LOGGER),
    "讀 ",
  );
});

test("resolveLabel end label 空字串 pass through(client 自處理)", () => {
  const profile = makeProfile({
    toolLabels: { read: { end: "" } },
  });
  assert.equal(
    resolveLabel(profile, "read", "end", {}, FAKE_LOGGER),
    "",
  );
});

test("resolveLabel {progress_count} 從 progressContext 帶入", () => {
  const profile = makeProfile({
    toolLabels: { bash: { progress: "已掃 {progress_count} 項" } },
  });
  assert.equal(
    resolveLabel(profile, "bash", "progress", { progress_count: 42 }, FAKE_LOGGER),
    "已掃 42 項",
  );
});
```

- [ ] **Step 2: 跑測試確認 fail**

```bash
make && node --test test/tool-label.test.mjs
```

Expected: 找不到 module。

- [ ] **Step 3: 寫 implementation**

`src/server/tool-label.ts`:

```typescript
import path from "node:path";
import type { ToolLabelEntry } from "./profile-loader.js";

interface ResolverProfile {
  exposeToolArgs: boolean;
  toolLabels: Record<string, ToolLabelEntry>;
}

interface Logger {
  warn: (msg: string, ctx?: unknown) => void;
}

const PLACEHOLDER_RE = /\{([^}]+)\}/g;

const BUILTIN_DEFAULTS: ToolLabelEntry = {
  start: "正在處理...",
  progress: "",
  end: "",
};

export function resolveLabel(
  profile: ResolverProfile,
  toolName: string,
  phase: "start" | "progress" | "end",
  args: Record<string, unknown>,
  log: Logger,
): string {
  const labels = profile.toolLabels || {};
  let template: string | undefined;
  if (labels[toolName] && labels[toolName][phase] !== undefined) {
    template = labels[toolName][phase];
  } else if (labels._default && labels._default[phase] !== undefined) {
    template = labels._default[phase];
  } else {
    template = BUILTIN_DEFAULTS[phase];
  }
  if (template === undefined || template === "") return template || "";

  return template.replace(PLACEHOLDER_RE, (_match, ph) => {
    return resolvePlaceholder(ph, args, profile.exposeToolArgs, toolName, phase, log);
  });
}

function resolvePlaceholder(
  ph: string,
  args: Record<string, unknown>,
  exposeToolArgs: boolean,
  toolName: string,
  phase: string,
  log: Logger,
): string {
  if (ph === "file_basename") {
    const file = args.file;
    if (typeof file !== "string") {
      log.warn(`tool-label: {file_basename} args.file missing for ${toolName}.${phase}`);
      return "";
    }
    return path.basename(file);
  }
  if (ph === "url_host") {
    const url = args.url;
    if (typeof url !== "string") {
      log.warn(`tool-label: {url_host} args.url missing for ${toolName}.${phase}`);
      return "";
    }
    try {
      return new URL(url).hostname;
    } catch {
      log.warn(`tool-label: {url_host} 解析失敗 ${url} (${toolName}.${phase})`);
      return "";
    }
  }
  if (ph === "progress_count") {
    const v = args.progress_count;
    return v === undefined || v === null ? "" : String(v);
  }
  if (ph.startsWith("tool_arg.")) {
    if (!exposeToolArgs) {
      log.warn(`tool-label: {${ph}} expose_tool_args=false (${toolName}.${phase})`);
      return "";
    }
    const key = ph.slice("tool_arg.".length);
    const v = args[key];
    if (v === undefined || v === null) {
      log.warn(`tool-label: {${ph}} args.${key} missing (${toolName}.${phase})`);
      return "";
    }
    return String(v);
  }
  // 不應走到這裡(profile-loader 已驗白名單),但 runtime 防呆
  log.warn(`tool-label: 未知 placeholder {${ph}} (${toolName}.${phase})`);
  return "";
}
```

- [ ] **Step 4: 跑測試確認 pass**

```bash
make && node --test test/tool-label.test.mjs
```

- [ ] **Step 5: Commit**

```bash
git add src/server/tool-label.ts test/tool-label.test.mjs
git commit -m "server: tool-label resolveLabel + placeholder 解析(file_basename/url_host/progress_count/tool_arg)"
```

---

### Task 3.2: `UiProfile` 補 `toolLabels` 欄位 + `parseUiProfile` merge

**Files:**
- Modify: `src/server/ui-profile.ts`
- Modify: `test/ui-profile.test.mjs`

- [ ] **Step 1: 加 failing test**

`test/ui-profile.test.mjs` 末尾加:

```javascript
test("parseUiProfile profileFile.tool_labels 對應到 UiProfile.toolLabels", () => {
  const profile = parseUiProfile({}, {}, {
    tool_labels: {
      read: { start: "讀 {file_basename}", end: "" },
      _default: { start: "處理中..." },
    },
  });
  assert.equal(profile.toolLabels?.read?.start, "讀 {file_basename}");
  assert.equal(profile.toolLabels?._default?.start, "處理中...");
});

test("parseUiProfile 無 profileFile → toolLabels 為 {}", () => {
  const profile = parseUiProfile({}, {}, undefined);
  assert.deepEqual(profile.toolLabels, {});
});
```

- [ ] **Step 2: 加欄位 + merge 邏輯**

修改 `src/server/ui-profile.ts` 內 `UiProfile`:

```typescript
import type { ToolLabelEntry } from "./profile-loader.js";

export interface UiProfile {
  // ... 既有欄位
  toolLabels: Record<string, ToolLabelEntry>;
}
```

`parseUiProfile` default 加:

```typescript
toolLabels: {},
```

profileFile merge 段加:

```typescript
if (profileFile?.tool_labels) {
  defaults.toolLabels = { ...profileFile.tool_labels };
}
```

- [ ] **Step 3: 跑測試確認 pass**

```bash
make && node --test test/ui-profile.test.mjs
```

- [ ] **Step 4: Commit**

```bash
git add src/server/ui-profile.ts test/ui-profile.test.mjs
git commit -m "server: UiProfile 補 toolLabels 欄位 + profileFile merge"
```

---

### Task 3.3: `filterEvent` 改三階段 + 串 `resolveLabel`

**Files:**
- Modify: `src/server/ui-profile.ts`
- Modify: `test/ui-profile.test.mjs`

- [ ] **Step 1: 看現況 `filterEvent` 的 tool_progress 處理**

```bash
grep -nE "(tool_progress|tool_execution|FilterResult)" src/server/ui-profile.ts
```

找出 `filterEvent` 在 `hideToolCalls + showToolProgress` 模式下構造 tool_progress payload 的位置。

- [ ] **Step 2: payload 結構改三階段**

把既有 `FilterResult` 內 tool_progress payload 從 `{ id, label, phase }` 確認:既有已有 phase,只是 phase 值原來只有 "start" / "end"。要加 "progress"。

修改 `FilterResult`:

```typescript
export type FilterResult =
  | null
  | { kind: "event"; event: SessionEvent }
  | {
      kind: "tool_progress";
      payload: {
        id: string;
        label: string;
        phase: "start" | "progress" | "end";
      };
    };
```

`filterEvent` 內:
- 既有 `tool_execution_start` → 構造 `phase: "start"` 的 progress packet,label 改呼 `resolveLabel(profile, toolName, "start", args, log)`
- 既有 `tool_execution_end` → 同上,phase "end"
- 加 `tool_execution_progress` 處理(若 SDK 有送):phase "progress"

- [ ] **Step 3: 加 failing test**

`test/ui-profile.test.mjs` 末尾加:

```javascript
test("filterEvent hideToolCalls+showToolProgress tool_execution_start → 走 resolveLabel", () => {
  const profile = parseUiProfile({}, {}, {
    ui: { hide_tool_calls: true, show_tool_progress: true },
    tool_labels: { read: { start: "正在讀檔" } },
  });
  const event = {
    kind: "tool_execution_start",
    payload: { toolCallId: "tc-1", toolName: "read", args: {} },
  };
  const result = filterEvent(event, profile);
  assert.equal(result?.kind, "tool_progress");
  assert.equal(result?.payload?.phase, "start");
  assert.equal(result?.payload?.label, "正在讀檔");
  assert.equal(result?.payload?.id, "tc-1");
});

test("filterEvent tool_execution_end phase=end", () => {
  const profile = parseUiProfile({}, {}, {
    ui: { hide_tool_calls: true, show_tool_progress: true },
    tool_labels: { read: { end: "讀檔完成" } },
  });
  const event = {
    kind: "tool_execution_end",
    payload: { toolCallId: "tc-1", toolName: "read", args: {} },
  };
  const result = filterEvent(event, profile);
  assert.equal(result?.payload?.phase, "end");
  assert.equal(result?.payload?.label, "讀檔完成");
});
```

- [ ] **Step 4: 改 `filterEvent` 構造邏輯**

把既有 hardcode 標籤對應(`toolLabel(toolName)`)整段替換成 `resolveLabel(profile, toolName, phase, args, log)`。

- [ ] **Step 5: 跑測試確認 pass**

```bash
make && node --test test/ui-profile.test.mjs
```

- [ ] **Step 6: 既有 toolLabel hardcode 移除**

確認 `ui-profile.ts` 內既有 `toolLabel(toolName)` 函式已無人呼叫(`grep -n toolLabel src/`),移除函式定義。

- [ ] **Step 7: Commit**

```bash
git add src/server/ui-profile.ts test/ui-profile.test.mjs
git commit -m "server: filterEvent tool_progress 改三階段 + 串 resolveLabel(移除舊 hardcode toolLabel)"
```

---

### Task 3.4: `public/app.js` `tool_progress` packet 加 progress phase 處理

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: 找現有 tool_progress packet 處理**

```bash
grep -nE "tool_progress|spinner" public/app.js | head -20
```

找出既有 start / end 處理區塊。

- [ ] **Step 2: 加 progress phase 分支**

把既有 switch 改成:

```javascript
case "tool_progress": {
  const { id, label, phase } = msg.payload;
  if (phase === "start") {
    appendToolProgressBlock(id, label);
  } else if (phase === "progress") {
    updateToolProgressLabel(id, label);
  } else if (phase === "end") {
    removeToolProgressBlock(id);
  }
  break;
}
```

`appendToolProgressBlock` / `updateToolProgressLabel` / `removeToolProgressBlock` 對應既有 spinner DOM 操作(既有應該已有 start / end 對應的兩個 helper;`updateToolProgressLabel` 新增,只更新已存在 block 內的 label text)。

```javascript
function updateToolProgressLabel(id, label) {
  const block = document.querySelector(`[data-tool-progress-id="${id}"]`);
  if (block) {
    const labelEl = block.querySelector(".tool-progress-label");
    if (labelEl) labelEl.textContent = label;
  }
}
```

(`.tool-progress-label` selector 名稱對應既有 DOM 結構;若既有結構不一致則沿用既有 selector。)

- [ ] **Step 3: lint**

```bash
make lint
```

- [ ] **Step 4: Commit**

```bash
git add public/app.js
git commit -m "webui: tool_progress packet 加 progress phase 處理(更新既有 spinner label)"
```

---

### Task 3.5: 整合測試 — stub session 觸發 tool call,驗證 tool_progress packet

**Files:**
- Modify: `test/server-profile.test.mjs`

- [ ] **Step 1: 看既有測試怎麼 stub session**

```bash
grep -rn "stub\|fake.*session\|sessionEvent" test/ | head -10
```

找出既有 server 整合測試 stub session event 的方式。

- [ ] **Step 2: 加 integration test**

(若既有沒有 stub session 機制,跳過 client-side spinner 驗證,只驗證 server 側透過 ws 送出的 packet — 但 spawn server 不會自動觸發 tool。)

折衷:用既有「啟動 server 看 connected」當 baseline,unit-level 驗證 `filterEvent` 已在 task 3.3 完成,本任務只加一個冒煙測試:

```javascript
test("--profile 帶 tool_labels 啟動成功並 connected 帶 toolLabels echo(若 payload 設計帶)", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-server-"));
  const dir = path.join(cwd, ".pi", "profiles");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "staff.toml"), `
[ui]
hide_tool_calls = true
show_tool_progress = true

[tool_labels.read]
start = "讀 nine9 客戶資料"
end = "完成"
`);
  const { proc, port } = await spawnServer(cwd, ["--profile", "staff"]);
  try {
    const connected = await getConnected(port);
    assert.equal(connected.uiProfile.hideToolCalls, true);
    assert.equal(connected.uiProfile.showToolProgress, true);
  } finally {
    proc.kill();
  }
});
```

(完整 tool call 觸發放手動驗證 M3 + 在 task 3.3 unit test 已驗證 `filterEvent` 行為)

- [ ] **Step 3: 跑測試**

```bash
make && node --test test/server-profile.test.mjs
```

- [ ] **Step 4: Commit**

```bash
git add test/server-profile.test.mjs
git commit -m "test: server-profile 補 --profile 帶 tool_labels 的冒煙整合測試"
```

---

### Task 3.6: 手動驗證 M3 全套

- [ ] **Step 1: 寫 staff toml 帶 tool_labels**

```bash
mkdir -p /tmp/pi-test-m3/.pi/profiles
cat > /tmp/pi-test-m3/.pi/profiles/staff.toml <<'EOF'
[ui]
hide_thinking      = true
hide_tool_calls    = true
show_tool_progress = true
hide_model         = true

[tool_labels.read]
start = "正在讀 {file_basename}"
end   = "讀取完成"

[tool_labels.bash]
start = "正在執行指令..."
end   = ""

[tool_labels._default]
start = "正在處理..."
end   = ""
EOF
```

- [ ] **Step 2: 啟動 + 觸發 read tool**

```bash
cd /tmp/pi-test-m3 && node /path/to/dist/server/index.js --profile staff --listen 127.0.0.1:14096 &
SERVER_PID=$!
sleep 1
echo "open http://127.0.0.1:14096; prompt: 請讀取 README.md 的前 20 行"
sleep 60
kill $SERVER_PID
```

確認:
- read tool 觸發時 spinner 顯示「正在讀 README.md」(file_basename 解出)
- read tool 結束時 spinner 換成「讀取完成」(end label 非空)
- bash tool 觸發時顯示「正在執行指令...」,結束時 spinner 直接消失(end 為空字串)
- 未列出的 tool(例如 WebSearch)顯示「正在處理...」(走 _default)

- [ ] **Step 3: placeholder 錯誤路徑 — 故意設無法解的 placeholder**

```bash
cat >> /tmp/pi-test-m3/.pi/profiles/staff.toml <<'EOF'

[tool_labels.WebFetch]
start = "抓 {url_host}"
EOF

cd /tmp/pi-test-m3 && node /path/to/dist/server/index.js --profile staff --listen 127.0.0.1:14096 &
SERVER_PID=$!
sleep 1
echo "open http://127.0.0.1:14096; prompt: 觸發 WebFetch 但提供無效 url(若可)"
# 如果無法手動觸發 WebFetch,跳過此 step
sleep 30
kill $SERVER_PID
```

- [ ] **Step 4: 確認 OK 後標記 M3 完成**

不需 commit。

---

## Milestone 4 — 文件

### Task 4.1: README 改寫 `## customer profile` 為 `## profiles`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 看現況**

```bash
grep -n "^## " README.md
```

找出 `## customer profile` 段位置。

- [ ] **Step 2: 改寫**

把既有 `## customer profile` 整段改成 `## profiles`,內容:

````markdown
## profiles

pi-webui supports a `.pi/profiles/<name>.toml` template system that packages
UI flags, branding, skill/command allowlists, and tool progress labels into
named startup interfaces. typical use case: engineer writes the toml files
once per project, then customer/back-office staff can launch the right
interface with a single `--profile <name>` flag.

### startup

```bash
pi-webui                                     # engineer use — bare default
pi-webui --profile staff                     # back-office interface
pi-webui --profile customer --tunnel \
  --password "$(cat .secret)"                # customer interface, public URL
```

### .pi/profiles/<name>.toml schema

```toml
[meta]
description = "..."                # human-readable; server ignores

[ui]
hide_thinking       = true         # drop thinking blocks
hide_tool_calls     = true         # drop tool_call / tool_result blocks
show_tool_progress  = true         # send tool_progress spinner instead
hide_status_chips   = true         # hide cwd/sandbox/tunnel/model chips
hide_session_picker = true         # disable session picker
hide_model          = true         # hide model name
safe_errors         = true         # wrap server_error as generic + ticket
expose_tool_args    = false        # allow {tool_arg.*} placeholders (UNSAFE)

[brand]
name   = "Acme Bot"
logo   = "./assets/logo.svg"       # path relative to cwd
mode   = "light"                   # dark | light
bg     = "#fafafa"                 # CSS --bg
panel  = "#ffffff"                 # CSS --panel
text   = "#1a1a1a"                 # CSS --text
accent = "#0066cc"                 # CSS --accent / --brand-color
border = "#e0e0e0"                 # CSS --border
muted  = "#707070"                 # CSS --muted
css    = "./assets/theme.css"      # optional CSS overlay (max 100KB)

[skills]
allow = ["brainstorming"]          # overrides .pi/skills-allow.txt

[commands]
allow = ["new", "quit", "help"]    # overrides .pi/commands-allow.txt

[defaults]
model = "anthropic/claude-opus-4-7"

[tool_labels.read]
start = "正在讀取 {file_basename}"
end   = "讀取完成"

[tool_labels.WebFetch]
start = "正在抓取 {url_host} 的網頁..."
end   = "網頁抓取完成"

[tool_labels._default]
start = "正在處理..."
end   = ""                          # empty = clear spinner only
```

### resolution priority

individual CLI flags > individual env vars > profile file > built-in customer
fallback (only when `--profile customer` and no file present) > defaults.

### placeholders (tool_labels only)

| placeholder | source | safety |
|---|---|---|
| `{file_basename}` | `path.basename(tool_arg.file)` | filename only, safe |
| `{url_host}` | `new URL(tool_arg.url).hostname` | host only, safe |
| `{progress_count}` | SDK progress callback | server-controlled |
| `{tool_arg.<key>}` | full arg value | requires `expose_tool_args = true` |

### fail-fast at startup

- profile file not found (and name !== "customer")
- toml syntax error
- `[brand].mode` not "dark"/"light"
- `[brand].bg/panel/text/accent/border/muted` invalid hex
- `[brand].logo` or `[brand].css` path missing
- `[brand].css` > 100KB
- `[tool_labels.<name>].<phase>` contains unknown placeholder
- unknown toml field (strict mode catches typos like `hide_thiking`)

### backwards compatibility

- `--ui-profile customer` still works as alias for `--profile customer`
- if `.pi/profiles/customer.toml` exists, it overrides the built-in fallback
- if both `[skills].allow` (profile) and `.pi/skills-allow.txt` exist, profile
  wins and server prints a startup warning
- same for `[commands].allow` and `.pi/commands-allow.txt`

### customer deployment example

```bash
pi-webui \
  --profile customer \
  --sandbox \
  --tunnel \
  --password "$(cat .password)" \
  --trust-proxy
```
````

- [ ] **Step 3: env var 表加 `PI_WEBUI_PROFILE`**

在既有 env var 表內加:

```
| `PI_WEBUI_PROFILE` | (unset) | profile name (same as `--profile`) |
```

- [ ] **Step 4: pi extension flag 列表加**

在「when launched via the pi extension」段加 `--webui-profile`。

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: README 改寫 customer profile → profiles 完整章節"
```

---

### Task 4.2: ROADMAP + CHANGELOG

**Files:**
- Modify: `ROADMAP.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: ROADMAP done 區塊加一行**

`ROADMAP.md` done 區塊末尾(`[x] --ui-profile customer ...` 之後)加:

```
[x] .pi/profiles/<name>.toml 接口模板系統(brand tokens 全套 + css overlay + tool 標籤三階段 + placeholder 白名單;--profile <name> 啟動;個別 CLI flag 仍可 override)
```

- [ ] **Step 2: CHANGELOG 加 2026-05-26 區塊**

`CHANGELOG.md` 頂部加:

```markdown
## 2026-05-26 (profile-system)

### 新增

- `--profile <name>` / `PI_WEBUI_PROFILE` / `--webui-profile <name>`(pi extension forward):讀 `.pi/profiles/<name>.toml` 載入完整接口模板
- `.pi/profiles/<name>.toml` schema:`[meta]` / `[ui]` / `[brand]` / `[skills]` / `[commands]` / `[defaults]` / `[tool_labels.<tool>]`
- `[brand]` 擴充:`mode`(dark/light)、`bg`/`panel`/`text`/`accent`/`border`/`muted` 6 個 design token、`css` overlay(最多 100KB)
- `tool_labels` 三階段(start/progress/end)+ placeholder 白名單(`{file_basename}` / `{url_host}` / `{progress_count}` / `{tool_arg.<key>}`)
- `expose_tool_args` 旗標:允不允許 `{tool_arg.*}` 帶入 args 內容(預設 false 防 leak)
- `GET /brand/theme.css` route:供 client 載入 css overlay

### 改動

- `parseUiProfile` 接 `profileFile` 第三參數,merge 順序:CLI > env > profile > 內建 fallback
- `tool_progress` packet `phase` 從 2 階段(start/end)擴成 3 階段(+progress)
- `connected` packet `brand` 結構加 `mode` / `tokens` / `css` 三欄
- `--ui-profile customer` 變 `--profile customer` 別名(向後相容)
- `public/styles.css` 修兩處寫死 hex 改 var

### 測試

- `test/profile-loader.test.mjs`(15 cases)
- `test/tool-label.test.mjs`(10 cases)
- `test/brand-overlay.test.mjs`(4 cases)
- `test/server-profile.test.mjs` 整合(8 cases)

### 文件

- README `## profiles` 完整章節
- ROADMAP done +1
```

- [ ] **Step 3: Commit**

```bash
git add ROADMAP.md CHANGELOG.md
git commit -m "docs: ROADMAP + CHANGELOG 加 profile-system 區塊"
```

---

### Task 4.3: 既有 customer-ui-profile spec 加註

**Files:**
- Modify: `docs/superpowers/specs/2026-05-22-customer-ui-profile-design.md`

- [ ] **Step 1: 在開頭狀態行下加註**

把:

```
日期 2026-05-22
狀態 approved (由 session goal 授權)
```

改成:

```
日期 2026-05-22
狀態 superseded by `2026-05-26-profile-system-design.md`(2026-05-26;profile system 把這份的所有 hide-* / brand-* / safe-errors 旗標重新組合進 `.pi/profiles/<name>.toml` 模板,本份保留為歷史紀錄)
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-05-22-customer-ui-profile-design.md
git commit -m "docs: customer-ui-profile spec 標記為 superseded(指向 profile-system)"
```

---

## 收尾

### Task 5.1: 整體驗證

- [ ] **Step 1: make precommit 全綠**

```bash
make precommit
```

Expected: lint + test 全 pass。

- [ ] **Step 2: 從乾淨 cwd 整套驗證**

```bash
# 工程師裸用法
node dist/server/index.js --listen 127.0.0.1:14096 &
PID=$!; sleep 1; curl -s http://127.0.0.1:14096 >/dev/null && echo OK; kill $PID

# customer fallback
mkdir -p /tmp/pi-final/.pi/profiles
node dist/server/index.js --profile customer --listen 127.0.0.1:14096 &
PID=$!; sleep 1; curl -s http://127.0.0.1:14096 >/dev/null && echo OK; kill $PID

# staff 全套
cat > /tmp/pi-final/.pi/profiles/staff.toml <<'EOF'
[ui]
hide_thinking = true
hide_tool_calls = true
show_tool_progress = true
hide_model = true
[brand]
name = "Final Test"
mode = "light"
bg = "#fafafa"
accent = "#0066cc"
[tool_labels.read]
start = "讀 {file_basename}"
end = "完成"
EOF
cd /tmp/pi-final && node /path/to/dist/server/index.js --profile staff --listen 127.0.0.1:14096 &
PID=$!; sleep 1; echo "open http://127.0.0.1:14096; verify light theme + 自訂標籤"; sleep 30; kill $PID
```

- [ ] **Step 3: 確認 git log 乾淨**

```bash
git log --oneline -30
```

確認 commit 順序對齊 milestone(M1 task → M2 task → M3 task → docs),沒有半成品 commit。

- [ ] **Step 4: 標記計畫完成**

不需 commit;告知 reviewer 計畫已執行完。

---

## YAGNI 提醒(實作中若有衝動 — 不要做)

- skill 內部 sub-tool 事件穿透(本次只到 Skill 視為一般 tool)
- profile 階層繼承 / 多層 merge
- 多 profile 同時啟用
- 動態切 profile(runtime 切角色)
- 內建 staff preset
- profile 內定義 sandbox / tunnel / password
- 多語系 tool 標籤
- 跨專案 profile 共用(`~/.pi/profiles/<name>.toml`)
- 開放 user / tool / thinking / success / warning / error 成 toml token 欄位
- 自動偵測 default profile

任何 YAGNI 排除項想拉進來時,先停下來確認是否真有當下需求,沒有就維持不做。
