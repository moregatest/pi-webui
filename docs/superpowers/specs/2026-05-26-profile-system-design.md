# pi-webui — 接口模板系統(`.pi/profiles/<name>.toml`)

日期 2026-05-26
狀態 brainstormed,待 review

## 動機

pi-webui 目前的「客戶接口」靠 `--ui-profile customer` 把 7 個 hide-* 旗標一次打開,搭配 `--brand-*` 三個欄位品牌化、`.pi/skills-allow.txt` / `.pi/commands-allow.txt` 做 skill 與 slash command 閘。對「工程師完成專案後交給後勤 / 客戶接手」這個情境,**機制都在,但都是片段化**:

1. 工程師交付給後勤時必須口頭/文件交代「啟動要帶哪些 CLI 旗標、要建哪些 allow 檔、brand 色要寫 hex 多少」,沒有「一個專案模板包」的概念
2. brand 機制只動一個 `--brand-color` CSS var(實際 `public/styles.css` 有 13 個 design tokens),完全做不出 light theme、自訂背景、調整文字色
3. tool 進度標籤硬編在 `src/server/ui-profile.ts`,跨專案沒辦法客製成 business 用語(例如 `read` 對應「正在讀取 nine9 客戶資料」)、也沒有 `progress` 中間階段
4. 「客服接口」(後勤可手動跑 skill / 重跑 pipeline 但 UI 仍乾淨)目前完全沒有覆蓋,只能裸 pi-webui

這份規格把「角色 = 啟動模式」做成一個 `.pi/profiles/<name>.toml` 模板系統,工程師寫好 toml + push git 後,後勤 / 客戶端只要一個 `--profile <name>` 旗標就接手,**對外的「移交動作」收斂成「啟一個 `--tunnel` URL 給對方連」**。

## 設計原則

- **角色 = 啟動模式**,一個 server 實例 = 一個 profile,啟動時鎖定。要換接口重啟。不做 multi-user / per-login authz
- **模板跟著專案 cwd 走**,放 `<cwd>/.pi/profiles/<name>.toml`,git 跟著走。**不**內建 staff preset(staff 內容太專案相依,無合理 default);**保留** customer 內建 fallback 確保 `--ui-profile customer` 既有行為向後相容
- **片段化機制保留** — `--hide-*` 個別旗標、`.pi/skills-allow.txt` / `.pi/commands-allow.txt` 都不動;profile 只是「在 toml 內把它們組合起來命名」的封裝
- **個別 CLI flag > profile**,profile 不剝奪臨時 override 能力
- **toml 內可設定的不包含安全旗標**(sandbox / tunnel / password / allow-unsafe-tunnel),避免「toml 設錯把 unsafe-tunnel 打開」這種風險
- **brand 機制走「toml 白名單 + css overlay 二者並用」**,80% 案例填 toml 欄位就夠,20% 設計師需求用 css 檔
- **tool 標籤系統三階段(start / progress / end)+ placeholder 白名單**,placeholder 不開放隨便寫(避免 leak args)

## CLI 介面

| 旗標 | env var | 說明 |
| --- | --- | --- |
| `--profile <name>` | `PI_WEBUI_PROFILE` | 讀 `<cwd>/.pi/profiles/<name>.toml`;`name === "customer"` 且檔不存在 → 內建 fallback;其他名稱檔不存在 → fail-fast |

pi extension forward:

| pi flag | 對應 |
| --- | --- |
| `--webui-profile <name>` | `--profile` |

優先順序(高到低):

```
個別 CLI flag (--hide-thinking / --brand-name / ...)
  → 個別 env var (PI_WEBUI_HIDE_THINKING / ...)
  → profile 檔
  → 內建 customer fallback(僅 --profile customer 無檔時)
  → default(全不藏 / dark theme / anthropic 橘)
```

`--ui-profile customer`(既有旗標)保留,等同 `--profile customer`,僅作向後相容別名;README 範例改用 `--profile`。

## `.pi/profiles/<name>.toml` Schema

完整範例:

```toml
[meta]
description = "nine9 客戶自助介面"

[ui]
hide_thinking       = true
hide_tool_calls     = true
show_tool_progress  = true
hide_status_chips   = true
hide_session_picker = true
hide_model          = true
safe_errors         = true
expose_tool_args    = false   # placeholder {tool_arg.*} 是否生效;預設 false

[brand]
name   = "Nine9 Assistant"
logo   = "./assets/nine9-logo.svg"        # 相對 cwd
mode   = "light"                          # dark | light
bg     = "#fafafa"
panel  = "#ffffff"
text   = "#1a1a1a"
accent = "#0066cc"
border = "#e0e0e0"
muted  = "#707070"
css    = "./assets/nine9-theme.css"       # 可選,在 toml 欄位之後注入

[skills]
allow = ["brainstorming"]                 # override <cwd>/.pi/skills-allow.txt

[commands]
allow = ["new", "quit", "help"]           # override <cwd>/.pi/commands-allow.txt

[defaults]
model = "anthropic/claude-opus-4-7"

[tool_labels.read]
start = "正在讀取 nine9 客戶資料..."
end   = "資料讀取完成"

[tool_labels.bash]
start    = "正在執行客戶資料盤點..."
progress = "處理中,已掃描 {progress_count} 項"
end      = "盤點完成"

[tool_labels.WebFetch]
start = "正在抓取 {url_host} 的網頁..."
end   = "網頁抓取完成"

[tool_labels._default]
start = "正在處理..."
end   = ""    # 空字串 = end 不送 label,只清 spinner
```

### 欄位語意

- `[meta]` 純註解區,server 不消費
- `[ui]` 對應既有 7 個 hide-* / safe-* 旗標;`expose_tool_args` 為新增旗標(下面 tool 標籤系統說明)
- `[brand]`
  - `name` / `logo` — 既有,語意不變(logo 路徑相對 cwd)
  - `mode` — 新增,`dark` / `light`;影響 `:root` `color-scheme` 與一組 default token 值
  - `bg` / `panel` / `text` / `accent` / `border` / `muted` — 新增,對應 `public/styles.css` 既有 CSS variables,選填,空值走 `mode` default
  - `accent` 取代既有 `[brand].color`;若 toml 內仍寫 `color`,server 解析時自動視為 `accent` 別名(向後相容)。**同時寫 `color` 與 `accent` → fail-fast**,避免歧義
  - `css` — 新增,可選;指向一份 CSS overlay 檔,server 啟動讀檔到記憶體
  - 不開放的 token:`--user` / `--tool` / `--thinking` / `--success` / `--warning` / `--error`(語意色,動了破壞訊息類別讀者認知;要改走 css overlay)
- `[skills].allow` — 等同 `<cwd>/.pi/skills-allow.txt`;profile 內定義會 override 同 cwd 的 allow 檔(後者忽略,server 啟動時印一行 log)
- `[commands].allow` — 同上,對 `<cwd>/.pi/commands-allow.txt`
- `[defaults].model` — 等同 `--model`
- `[tool_labels.<name>]` — 見下節

### tool 標籤系統

每個 `tool_labels.<tool_name>` 表內 3 個欄位都可選:

```toml
[tool_labels.read]
start    = "..."   # tool 開始執行時送
progress = "..."   # 中間 progress callback(若 SDK 支援)送;不寫 = 不送 progress packet
end      = "..."   # tool 結束時送;空字串 = 只清 spinner 不顯示 label
```

label resolution 順序(對某個 tool call):

```
profile.tool_labels.<tool_name>.<phase>
  → profile.tool_labels._default.<phase>
  → built-in fallback("正在處理..." / "")
```

#### Placeholder 白名單

只在 toml 內可用,server 端 hardcode:

| placeholder | 來源 | 安全性 |
| --- | --- | --- |
| `{tool_arg.<key>}` | tool args 對應 key(非 string 自動 stringify) | 預設**關閉**,要 `[ui] expose_tool_args = true` 才生效 |
| `{file_basename}` | `path.basename(tool_arg.file)` | 只洩漏檔名,安全 |
| `{url_host}` | `new URL(tool_arg.url).hostname` | 只洩漏 host,安全 |
| `{progress_count}` | SDK progress callback 帶入,沒有 → 空字串 | server 控制,安全 |

placeholder 解析:

- **toml 解析階段**:檢查所有 template 字串內的 `{...}` 是否在白名單(`tool_arg.*` 視為合法);未知 → fail-fast,訊息指明 `[tool_labels.<name>].<phase>: unknown placeholder '<x>'`
- **runtime 階段**:placeholder 對應的 args key 不存在、值為 null / undefined、或 `expose_tool_args = false` 但 template 用了 `{tool_arg.<key>}` → 該 placeholder 換成空字串 + log warn,不 throw(避免 server 在 customer mode 跑某 tool 時崩)。template 內其他文字保留,例如 `"正在抓取 {url_host} 的網頁..."` 解不到 host 時變 `"正在抓取  的網頁..."`(視覺有點怪但不致命)

#### packet 變動

`tool_progress` packet 從原 2 階段擴成 3 階段:

```json
{ "type": "tool_progress", "payload": { "id": "tc-123", "phase": "start",    "label": "正在讀取 nine9 客戶資料..." } }
{ "type": "tool_progress", "payload": { "id": "tc-123", "phase": "progress", "label": "處理中,已掃描 87 項" } }
{ "type": "tool_progress", "payload": { "id": "tc-123", "phase": "end",      "label": "資料讀取完成" } }
```

`end.label === ""` 時 client 純粹清掉 spinner,不留 trace。

#### Skill 內部 sub-tool 顯示(本次不做)

skill 呼叫(`Skill` tool)在 SDK 內部會跑多 step,目前 SDK 從外部只看得到「一個 Skill tool call」,跑長 skill(如 onboard-init 跑 5 分鐘)全程一個 spinner 會讓後勤以為當機。

本次採「**Skill 視為一般 tool**」做法 — `tool_labels.Skill` 跟其他 tool 一樣可在 toml 定義 start / progress / end,並倚賴若 SDK 在 skill 執行期間有送 `agent_thinking` event(需 server 端讀 SDK source 驗證),客服 / 客戶 profile 對該 event 仍 pass-through,讓使用者看到「正在思考」的進度感。

**進階做法**(把 SDK 內部 sub-tool 事件穿透到 progress packet)需 pi SDK 開放 hook,**本次不做**,記入 ROADMAP。

## Brand CSS Overlay

當 `[brand].css` 設定時:

1. server 啟動讀檔到記憶體(避免 file IO racing 與後續竄改)
2. 註冊 `GET /brand/theme.css` route,Content-Type 固定 `text/css`,回 buffer
3. `connected` packet `brand.css: true`
4. client 收到 `brand.css === true` 後,**在內建 `styles.css` 之後**插 `<link rel="stylesheet" href="/brand/theme.css">`(覆寫優先級正確)

overlay css 不限制內容(除了 size limit),允許覆寫任何 CSS variable / 任何 selector。典型用途:

```css
/* nine9-theme.css */
:root {
  --tool: #b87333;    /* 改 tool 訊息色 */
}
.brand-header { background: linear-gradient(...); }
```

size limit:server 啟動時若 css 檔 > 100KB → fail-fast。理由:客戶主題不應該這麼大,大檔通常代表誤指錯檔(node_modules / 全 reset.css)。

## `connected` Packet 變動

```json
{
  "uiProfile": {
    "hideThinking": true,
    "hideToolCalls": true,
    "showToolProgress": true,
    "hideStatusChips": true,
    "hideSessionPicker": true,
    "hideModel": true,
    "safeErrors": true,
    "exposeToolArgs": false,
    "brand": {
      "name": "Nine9 Assistant",
      "logoUrl": "/brand/logo",
      "mode": "light",
      "tokens": {
        "bg": "#fafafa",
        "panel": "#ffffff",
        "text": "#1a1a1a",
        "accent": "#0066cc",
        "border": "#e0e0e0",
        "muted": "#707070"
      },
      "css": true
    }
  }
}
```

完全沒帶任何 profile / 旗標時 `uiProfile` 仍出現,boolean 全 false、`brand.name / logoUrl / mode` 為 null、`brand.tokens` 為 `{}`、`brand.css` 為 false。

## 實作要點

### 新檔

`src/server/profile-loader.ts`:

```ts
export interface ProfileFile {
  meta?: { description?: string };
  ui?: Partial<UiFlags>;
  brand?: BrandConfig;
  skills?: { allow?: string[] };
  commands?: { allow?: string[] };
  defaults?: { model?: string };
  tool_labels?: Record<string, ToolLabelEntry>;
}

export interface ToolLabelEntry {
  start?: string;
  progress?: string;
  end?: string;
}

/**
 * 讀 <cwd>/.pi/profiles/<name>.toml + schema 驗證
 * - name === "customer" 且檔不存在 → 內建 fallback
 * - 其他情況檔不存在 → throw `profile not found: <path>`
 * - toml 解析 / schema 錯誤 → throw 具體訊息
 * - placeholder 白名單檢查(於此階段 fail-fast)
 */
export function loadProfile(name: string, cwd: string): ProfileFile;
```

`src/server/tool-label.ts`:

```ts
export function resolveLabel(
  profile: UiProfile,
  toolName: string,
  phase: "start" | "progress" | "end",
  args: Record<string, unknown>,
  log: Logger,
): string;
```

`src/server/brand-overlay.ts`:

```ts
/** 啟動時讀 css 檔到記憶體 + 大小檢查 */
export function loadBrandCss(path: string | null): Buffer | null;
```

### 既有檔擴充

`src/server/ui-profile.ts`:

- `UiProfile` 介面加 `exposeToolArgs` 欄位
- `parseUiProfile` 改成接收 `profileFile?: ProfileFile` 參數,merge 順序:CLI > env > profileFile > built-in fallback

`src/server/index.ts`:

- `parseArgs` 加 `--profile <name>`
- 啟動序列:`args.profile` 存在 → `loadProfile(args.profile, cwd)` → 把結果丟給 `parseUiProfile`
- `profile.brand.css` 存在 → `loadBrandCss(path)` → 註冊 `GET /brand/theme.css` route
- `profile.brand.logo` 存在 → 既有 `/brand/logo` route 邏輯沿用
- `onSessionEvent` 內既有 `filterEvent` 邏輯下 tool_progress 構造改呼 `resolveLabel`
- `printHelp` 加 `--profile` 段

`src/extension/index.ts`:

- `StartOptions` 加 `profile?: string`
- 註冊 `webui-profile` flag,forward 為 `--profile`

`public/app.js`:

- `connected` 收到後處理 brand:
  - `brand.tokens` 一次 `setProperty()` 全部
  - `brand.mode` 改 `document.documentElement.style.colorScheme`
  - `brand.css === true` → 插 `<link>`(append 到 head 最後)
- `tool_progress` packet 處理加 `progress` phase(更新既有 spinner 的 label,不新增 block)

`public/styles.css`:

- line 9 註解修「--brand-color 由 --brand-color CLI 設定」的自我參照(改為「由 `--brand-color` CLI 旗標或 profile `[brand].accent` 設定」)
- line 527 / 623 兩處寫死 hex 改 `var(--text)` / `var(--muted)`(順手修小漏洞)

### 文件

- README 改寫 `## customer profile` 為 `## profiles`,完整 schema + resolution 順序 + 三個典型部署範例(工程師裸用 / 客服內網 / 客戶 tunnel)
- ROADMAP done 加 `.pi/profiles/<name>.toml 接口模板系統(brand tokens + css overlay + tool 標籤三階段)`
- CHANGELOG 加 `2026-05-26 (profiles)` 區塊

## 錯誤處理

| 情境 | 處理 |
| --- | --- |
| `--profile <name>` 但 `.pi/profiles/<name>.toml` 不存在(且 name !== "customer") | **fail-fast**,stderr `profile not found: <path>` |
| toml 解析語法錯誤 | **fail-fast**,stderr `profile syntax error: <message>` |
| `[brand].mode` 不是 `dark` / `light` | **fail-fast** |
| `[brand].bg/panel/text/accent/border/muted` 任一不是合法 hex(`^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$`) | **fail-fast** |
| `[brand].logo` 路徑不存在 | **fail-fast** |
| `[brand].css` 路徑不存在 | **fail-fast** |
| `[brand].css` 檔 size > 100KB | **fail-fast** |
| `[tool_labels.<name>].<phase>` 內 `{xxx}` 不在 placeholder 白名單 | **fail-fast** |
| toml 內未知欄位(例如 typo `hide_thiking`)| **fail-fast**(本次採 strict mode;偏好早發現勝過寬鬆) |
| `[skills].allow` 列了不存在的 skill 名 | log warn 但繼續(沿用既有 `.pi/skills-allow.txt` 既有邏輯) |
| profile `[skills].allow` 與 `.pi/skills-allow.txt` 同時存在 | **server 啟動印 log:`profile [skills].allow override <cwd>/.pi/skills-allow.txt`** |
| profile `[commands].allow` 與 `.pi/commands-allow.txt` 同時存在 | 同上 |
| runtime placeholder 解析時 args 缺對應 key | log warn + 替換成空字串,不 throw |

啟動 fail-fast 集中在 `loadProfile`,在 `createServer()` 之前完成。

## 驗證計畫

### 自動化測試

`test/profile-loader.test.mjs`:

- 完整 toml 載入 → 各欄位回傳正確
- 檔不存在 + `name === "customer"` → 內建 fallback
- 檔不存在 + `name === "staff"` → throw `profile not found`
- toml 語法錯誤 → throw `profile syntax error`
- `[brand].mode = "weird"` → throw
- `[brand].bg = "not-hex"` → throw
- `[brand].logo = "<不存在>"` → throw
- `[brand].css = "<不存在>"` → throw
- `[brand].css` > 100KB → throw
- `{wat}`、`{tool_arg.}`(空 key) → throw 並指明 tool / phase / placeholder
- 未知 toml 欄位 → throw
- 內建 customer fallback 結果與既有 `--ui-profile customer` 解析結果完全一致

`test/tool-label.test.mjs`:

- 三階段 label 正確分流
- profile 未列 + `_default` 存在 → 走 `_default`
- profile 未列 + `_default` 不存在 → built-in `正在處理...` / 空字串
- `{file_basename}` 解 `/path/to/foo.txt` → `foo.txt`
- `{url_host}` 解 `https://nine9.com.tw/page` → `nine9.com.tw`
- `{tool_arg.url}` + `expose_tool_args = false` → 空字串 + log warn
- `{tool_arg.url}` + `expose_tool_args = true` → 帶入完整 URL
- runtime args 缺 placeholder 對應 key → 空字串 + log warn,不 throw
- end `label === ""` → packet 仍送,client 行為靠 client 處理

`test/server-profile.test.mjs`(整合測試,spawn 真 server):

- `--profile staff`(fixture toml) → `connected` packet 帶完整 brand + ui 欄位
- `--profile customer`(無檔)→ 內建 fallback 結果
- `--profile staff` + `--hide-thinking=false`(個別 CLI override profile)→ 個別 CLI 勝
- `GET /brand/theme.css` → 200 + `Content-Type: text/css` + 內容對應 fixture css
- `GET /brand/logo` → 200 + 正確 Content-Type
- `--profile <不存在>` → server exit 非 0,stderr 帶 `profile not found`
- profile `[skills].allow` 與 `.pi/skills-allow.txt` 同時存在 → server 啟動 stdout 有 override 警告
- stub session 觸發 `read` tool call → `tool_progress` packet 含正確 label(從 fixture toml)
- stub session 觸發 unknown tool call → `tool_progress` packet 走 `_default` / built-in fallback

`test/ui-profile.test.mjs`(既有,擴充):

- `parseUiProfile` 接 `profileFile` 參數的 merge 行為(CLI > env > profileFile > built-in)

### 手動驗證(本地)

| # | 操作 | 預期 |
| --- | --- | --- |
| 1 | `pi-webui`(無 profile)| 完全現狀,深色主題 + anthropic 橘 |
| 2 | `pi-webui --profile customer`(無 `.pi/profiles/customer.toml`)| 等同既有 `--ui-profile customer` 行為 |
| 3 | 寫 `.pi/profiles/staff.toml`,`pi-webui --profile staff`,觸發 read tool | tool spinner 顯示 toml 內定義的客製文字 |
| 4 | 同 #3 + `[brand].mode = "light"` + 設 bg/panel/text | 整個介面切到 light theme |
| 5 | 同 #3 + `[brand].css = ./theme.css`,theme.css 改 `--tool` 色 | tool 訊息泡泡顏色變(`<link>` 載入成功 + 覆寫優先級對) |
| 6 | `pi-webui --profile customer --tunnel --password $(cat .secret)`(完整客戶交付情境) | 拿到 trycloudflare URL,從另一台 / 手機開,看到完整客戶接口 |
| 7 | 故意把 toml 寫壞:`[brand].mode = "weird"` | 啟動 exit,stderr 訊息明確指出 `[brand].mode` |
| 8 | toml 內 placeholder 寫 `{wat}` | 啟動 exit,stderr 指明 tool / phase / placeholder |
| 9 | 個別 CLI flag 跟 profile 並用:`--profile customer --brand-name "Override"` | brand name 顯示 Override(CLI 勝) |
| 10 | 寫好 staff.toml + customer.toml,git push,**另一台機器** clone + `pi-webui --profile staff` | 完全一致的接口 |

## YAGNI 排除清單

本次明確**不做**:

- skill 內部 sub-tool 事件穿透(3b)— 等 pi SDK 提供 hook
- profile 階層繼承 / 多層 merge — 一個 toml 配一個 name,扁平
- 多 profile 同時啟用 — `--profile a,b` 不支援
- 動態切 profile(runtime 切角色)— 必須重啟 server
- 內建 staff preset — staff 一定要有檔
- profile 內定義 sandbox / tunnel / password / allow-unsafe-tunnel — 安全旗標仍只能 CLI
- 多語系 tool 標籤 — toml 內一個 string 就一種語言
- 跨專案 profile 共用(`~/.pi/profiles/<name>.toml`)— 後續案再加
- 開放 `--user` / `--tool` / `--thinking` / `--success` / `--warning` / `--error` 成 toml token 欄位 — 要動走 css overlay
- `pi-webui` 啟動時自動偵測 `<cwd>/.pi/profiles/` 內預設名稱(如 `default.toml`)— **必須**顯式 `--profile <name>`,避免「啟動行為依目錄內容隱式變動」這種驚喜

## 預期下一步

本 spec approved 後,進 writing-plans 產出實作 plan。預計拆三個 milestone:

1. **M1 — profile loader + 模組整合**:`profile-loader.ts` + `tool-label.ts` + ui-profile.ts 擴充 + extension forward + 既有 customer fallback 對齊
2. **M2 — brand 機制完整化**:toml 白名單 tokens + css overlay route + client 注入 + styles.css 兩處 hex 修正
3. **M3 — tool 標籤三階段**:packet schema 更動 + resolveLabel + placeholder 解析 + client spinner 更新

每個 milestone 各自有對應測試,可獨立 merge。
