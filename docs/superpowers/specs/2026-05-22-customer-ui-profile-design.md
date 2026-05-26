# pi-webui — 客戶導向 UI profile

日期 2026-05-22
狀態 superseded by `2026-05-26-profile-system-design.md`(2026-05-26;profile system 把這份的所有 hide-* / brand-* / safe-errors 旗標重新組合進 `.pi/profiles/<name>.toml` 模板,本份保留為歷史紀錄)

## 動機

pi-webui 目前所有 session 事件、tool call 細節、status bar 技術 chip(model / sandbox / tunnel / session id)、stack trace 級錯誤訊息都直接秀給 client。對面向**最終客戶**的部署(客服機器人、PoC demo、引導工具)來說,這些細節:

1. 太吵 — 客戶不需要看到 `bash` / `read` 等內部工具細節
2. 降低信任 — 看到 AI thinking 過程可能反而困惑
3. 漏資訊 — error 帶 stack 文字會洩漏實作細節與檔案路徑
4. 沒品牌感 — logo / 名稱 / 主色無法客製

現有 lockdown 機制(`commands-allow.txt` / `skills-allow.txt` / `--sandbox` / `--hide-model`)已解決「**能不能做**」;這份規格解決「**能不能看**」並把品牌化納入,形成完整的「客戶部署套件」。

## 設計原則

- **切片旗標獨立可組合**,`--ui-profile customer` 只是 preset。不同情境(技術型客戶 vs 純客服)想露的細節不一樣,單一 monolithic mode 太死
- **server 端做過濾**(主要),不是 client 隱藏。client 改不掉 devtools 看不到原始 payload。client 端僅做 defensive secondary filter(防呆,不負責安全)
- **tool 細節隱藏配 user-friendly 進度標籤**,維持信任感(避免客戶看到「沉默十秒」以為當機)
- **沿用既有 CLI > env > preset > 預設行為** 優先順序,不發明新慣例

## CLI 介面 / 環境變數

### 切片旗標

| 旗標 | env var | 說明 |
| --- | --- | --- |
| `--hide-thinking` | `PI_WEBUI_HIDE_THINKING` | 過濾 `message_update` 中的 thinking block,完全不送 client |
| `--hide-tool-calls` | `PI_WEBUI_HIDE_TOOL_CALLS` | 過濾 `tool_execution_start` / `tool_execution_end` event,以及 `message_update` 中的 `tool_call` / `tool_result` block |
| `--show-tool-progress` | `PI_WEBUI_SHOW_TOOL_PROGRESS` | 隱藏 tool 細節時改送 `tool_progress` packet(內含 user-friendly 標籤);無 `--hide-tool-calls` 時忽略 |
| `--hide-status-chips` | `PI_WEBUI_HIDE_STATUS_CHIPS` | 隱藏 status bar 的 sandbox / tunnel / session id chip(保留 connection state 與品牌名稱) |
| `--hide-session-picker` | `PI_WEBUI_HIDE_SESSION_PICKER` | 隱藏 session 列表 / 切換 UI 入口(`/sessions` 等指令搭配 `commands-allow.txt` 一起擋) |
| `--brand-name <text>` | `PI_WEBUI_BRAND_NAME` | 注入 `<title>` 與狀態列文字 |
| `--brand-logo <path>` | `PI_WEBUI_BRAND_LOGO` | 替換 `/brand/logo` 路由內容;client 用此 URL 顯示 logo |
| `--brand-color <hex>` | `PI_WEBUI_BRAND_COLOR` | 主色;注入 CSS custom property `--brand-color` |
| `--safe-errors` | `PI_WEBUI_SAFE_ERRORS` | server 端把 `server_error` payload 包裝成 generic 訊息 + 隨機 ticket id;原始細節寫進 server log |

### Preset

| 旗標 | env var | 等同於 |
| --- | --- | --- |
| `--ui-profile customer` | `PI_WEBUI_UI_PROFILE=customer` | `--hide-thinking --hide-tool-calls --show-tool-progress --hide-status-chips --hide-session-picker --hide-model --safe-errors` |

### 優先順序

個別 flag > 個別 env > preset 展開後預設 > 既有預設值(全部顯示)。

意思:同時設 `--ui-profile customer` 與 `--hide-thinking=false` 之類的反向旗標**不支援**(YAGNI,見下);要 override 就用既有「不在 preset 列表的個別 flag 預設」這個機制 — preset 不會碰它沒列到的 flag。

### pi extension 端 forward

| pi flag | 對應 |
| --- | --- |
| `--webui-hide-thinking` | `--hide-thinking` |
| `--webui-hide-tool-calls` | `--hide-tool-calls` |
| `--webui-show-tool-progress` | `--show-tool-progress` |
| `--webui-hide-status-chips` | `--hide-status-chips` |
| `--webui-hide-session-picker` | `--hide-session-picker` |
| `--webui-brand-name <text>` | `--brand-name` |
| `--webui-brand-logo <path>` | `--brand-logo` |
| `--webui-brand-color <hex>` | `--brand-color` |
| `--webui-safe-errors` | `--safe-errors` |
| `--webui-ui-profile <name>` | `--ui-profile` |

`pi-webui --help` 與 README 對應更新。

## tool progress 標籤對應表(MVP)

server 端硬編對應表(`src/server/tool-labels.ts`),把 SDK tool 名稱對應到繁體中文短語:

| tool 名稱 | progress 文字 |
| --- | --- |
| `read` | 正在讀取檔案... |
| `write` | 正在寫入檔案... |
| `edit` | 正在修改檔案... |
| `bash` | 正在執行指令... |
| `WebSearch` | 正在搜尋網路... |
| `WebFetch` | 正在抓取網頁... |
| `Task` | 正在思考... |
| `Skill` | 正在準備工具... |
| (其他 / unknown) | 正在處理... |

MVP 不支援自訂表(YAGNI);未來若有需求再加 `--tool-labels <path>` 讀 JSON。

## 介面細節

### server → client packet 變更

1. **`connected` packet** 加 `uiProfile` 欄位:

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
       "brand": {
         "name": "Acme Bot",
         "logoUrl": "/brand/logo",
         "color": "#0066cc"
       }
     }
   }
   ```

   完全沒帶任何旗標時,`uiProfile` 仍出現但所有 boolean 為 `false`、`brand` 三欄為 `null` — 讓 client 端解析路徑單一。

2. **新增 `tool_progress` packet**(僅 `hideToolCalls && showToolProgress`):

   ```json
   { "type": "tool_progress", "payload": { "id": "tc-123", "label": "正在讀取檔案...", "phase": "start" } }
   { "type": "tool_progress", "payload": { "id": "tc-123", "phase": "end" } }
   ```

   `id` 來自原 `tool_execution_*` event 的 `toolCallId`,讓 client 能配對 start/end。

3. **`server_error` packet 包裝**(`safeErrors` 開啟時):

   ```json
   { "type": "server_error", "payload": "發生錯誤,請聯繫支援 (ticket: a8f3c2)" }
   ```

   原始 error message 完整寫進 server log(`logger.error("safe-error", { ticket, message })`),帶上 ticket id 對應。ticket 用 `randomBytes(3).toString("hex")` 產生,6 位 hex 足夠日常排錯。

### server 端過濾切點

- **`onSessionEvent`**(`src/server/index.ts:1243`):漏斗。改成:
  ```js
  const filtered = filterEvent(event, this.uiProfile);
  if (filtered === null) return;        // drop
  if (filtered.kind === "tool_progress") {
    sendJson(this.ws, { type: "tool_progress", payload: filtered.payload });
    return;
  }
  sendJson(this.ws, { type: "session_event", payload: filtered.event, seq });
  ```
  `filterEvent` 對 `message_update` 過濾 blocks 陣列;對 `tool_execution_*` 視 profile 而 drop / 轉 progress;其他 event(`agent_start` / `compaction_*` / `extension_error` / `auto_retry_start`)pass-through(這些沒洩漏細節)。
- **各 `sendJson({ type: "server_error", ... })`**:統一改走 `safeError(profile, message, log)` helper。helper 在非 customer 模式直接 pass through;customer 模式回包裝後 payload + 同步寫 log。
- **`message_history` packet**(`sendMessages()`):同樣過 profile filter(client 重連時要拿 history,不能洩漏)。

### branding 注入點

- **`<title>` / header**:`public/index.html` 的 `<title>` 預設 `pi-webui`;`connected` 收到後 `document.title = brand.name`,header DOM 同步更新
- **logo**:server 啟動時若 `--brand-logo` 指定路徑,加 route `GET /brand/logo`(讀檔 + content-type 由副檔名判定 svg/png/jpg);未指定則 fallback redirect 到既有 `/favicon.svg`。client 一律用 `<img src="/brand/logo">`
- **主色**:client 拿到後 `document.documentElement.style.setProperty('--brand-color', color)`。`public/styles.css` 既有 accent 色票改用 `var(--brand-color, <既有預設>)`。MVP 只動「accent / primary」一個變數,其他配色維持現況

## 實作要點

### `src/server/ui-profile.ts`(新檔)

集中 profile 解析、event 過濾、tool 標籤、safe error 邏輯:

```ts
export interface UiProfile {
  hideThinking: boolean;
  hideToolCalls: boolean;
  showToolProgress: boolean;
  hideStatusChips: boolean;
  hideSessionPicker: boolean;
  hideModel: boolean;
  safeErrors: boolean;
  brand: { name: string | null; logoPath: string | null; color: string | null };
}

export function parseUiProfile(cliArgs: Record<string, unknown>, env: NodeJS.ProcessEnv): UiProfile;

export type FilterResult =
  | null
  | { kind: "event"; event: SessionEvent }
  | { kind: "tool_progress"; payload: { id: string; label: string; phase: "start" | "end" } };

export function filterEvent(event: SessionEvent, profile: UiProfile): FilterResult;

export function toolLabel(toolName: string): string;

export function safeError(
  profile: UiProfile,
  rawMessage: string,
  log: Logger,
): string;
```

`parseUiProfile`:`--ui-profile customer` 先展開成 boolean default,然後個別 flag/env 覆蓋。`--brand-color` 驗證 `^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$`,不合法 throw。`--brand-logo` 路徑 `fs.statSync` 確認存在,缺檔 throw。

### `src/server/index.ts`

1. `parseArgs` 擴充所有新旗標(boolean / string-value)
2. 啟動時呼叫 `parseUiProfile(args, process.env)` 算出 `effectiveUiProfile`(模組層級)
3. `NativePiSessionController` 建構時拿 profile 存實例欄位
4. `sendBootstrap()` / `connected` packet payload 加 `uiProfile`(boolean 都序列化,brand `null` 欄位省略 → `{ name: null }` 形式)
5. `onSessionEvent` 改用 `filterEvent` 走分流
6. `sendMessages()` 把 `messages` 陣列每筆的 blocks 過 profile 過濾後再送
7. 所有 `server_error` 出口 message 改先過 `safeError`
8. `--brand-logo` 設定時註冊 `GET /brand/logo` route(讀檔流 + `Content-Type`)
9. `printHelp()` 新參數段落

### `src/extension/index.ts`

- `StartOptions` 加對應新欄位
- 註冊 pi flags(`webui-hide-thinking` 等)
- `parseStartFlags` 加分支處理(boolean flag 與 string flag 模式)
- `runStart` 把對應參數推進 `serverArgs`
- 自動偵測不在 extension 重做(server 啟動時自然 fallback)

### `public/app.js`

- 新增模組層級 `uiProfile`,`connected` 收到後 assign
- `connected` 處理完後立即套用 branding:`document.title`、header logo `<img>` 與名稱、`--brand-color` CSS var
- session_event dispatcher 新增 defensive secondary filter(server 已濾,client 再防一手) — 但不是安全機制,僅避免 server 漏網時 client 還是不該 render
- 新增 `tool_progress` packet 的 case:start 時新增 spinner block(內含 label),end 時移除
- status bar / session picker 根據 profile 切顯示

### `public/render-blocks.mjs` / `public/format-message.mjs`

- 接收 `uiProfile` 參數(或從 module-level state 讀),thinking / tool_call / tool_result block 在 profile 開啟時跳過

### `public/styles.css`

- 既有 accent / primary 色硬編值改 `var(--brand-color, <既有值>)` — fallback 保持現況
- MVP 範圍最小:只動一個 CSS var,不全主題化

### `public/index.html`

- `<title>` 保留 `pi-webui` 預設
- header 區塊 logo placeholder 加 `<img id="brand-logo" src="/brand/logo">` 與 `<span id="brand-name">pi-webui</span>`

## YAGNI 排除

- 不支援自訂 tool 標籤對應表(MVP 用 hardcode);未來再加 `--tool-labels <path>`
- 不支援自訂完整主題(只支援單一主色 var)
- 不支援多語系(tool 標籤先寫繁中,沿用專案中文慣例)
- 不過濾 `text` block(過濾掉就沒對話了);過濾範圍僅 thinking / tool_*
- 不提供反向旗標(`--show-thinking` 等);要 override preset 直接不用 preset、改個別組合
- 不在 client 端做 secondary defense 之外的校驗(packet schema 驗證、re-derive 等)
- 不對 `safeError` 提供「保留錯誤訊息分類」開關 — 統一 generic
- 不支援動態切換 profile(必須重啟 server) — 客戶部署本就不會中途換 mode

## 錯誤處理

- `--brand-logo` 路徑不存在 / 不是檔案 → 啟動 fail-fast,印 `brand-logo: file not found: <path>`
- `--brand-color` 不是合法 hex → 啟動 fail-fast,印 `brand-color: must be #rgb or #rrggbb`
- `--ui-profile` 不認得的名稱 → 啟動 fail-fast,印 `ui-profile: unknown preset '<name>' (supported: customer)`
- `filterEvent` 遇到預期外的 event 結構(例如 `message_update.payload.blocks` missing)→ `log.warn`,fallback 為「pass through」(寧可漏濾也別崩 session)
- `tool_progress` 配對:start 沒對應 end(extension 異常 crash) → 不主動處理,client 在 spinner 顯示超時(60s)自動移除;這個邊界 case 不值得增加 server-side timeout 機制(YAGNI)

## 驗證計畫(本地端)

### 自動化測試

#### `make` build 通過

新檔 `src/server/ui-profile.ts` 編譯通過,無新 type error(profile 模組刻意寫好型別,不沿用 `@ts-nocheck`)。

#### `make test` 通過

新增測試檔:

**`test/ui-profile.test.mjs`** — 單元測試 `parseUiProfile` / `filterEvent` / `toolLabel` / `safeError`:

- `parseUiProfile`
  - 全部空 → 全 `false` + `brand` 全 `null`
  - `--ui-profile customer` 展開:7 個 boolean 都 `true`
  - 個別 flag 啟用 → 對應欄位 `true`,其餘 `false`
  - env var 等效 CLI flag
  - CLI flag 與 env var 同時設定 → CLI 勝
  - `--brand-color #0066cc` / `#06c` 合法
  - `--brand-color foo` throw
  - `--brand-logo /not/exist` throw(用 `fs.mkdtempSync` 做 fixture 隔離)
  - `--ui-profile unknown` throw
- `filterEvent`
  - `hideThinking` 開啟,`message_update` blocks 含 thinking → 該 block 被剝掉,其他保留
  - `hideToolCalls` 開啟,`tool_execution_start` event → 回 `null`(drop)
  - `hideToolCalls + showToolProgress` 開啟,`tool_execution_start` → 回 `tool_progress` start payload + 正確 label
  - `tool_execution_end` 對應 progress end payload
  - 非客戶 mode(全 `false`)→ event pass-through
  - `agent_start` / `compaction_*` 在客戶 mode 也 pass-through
- `toolLabel`
  - `read` / `write` / `edit` / `bash` 對應正確
  - 未知 tool → `正在處理...`
- `safeError`
  - 非 safeErrors mode → 原訊息 pass-through,不寫 log
  - safeErrors mode → 回 `發生錯誤,請聯繫支援 (ticket: xxxxxx)`,且 logger 收到帶 ticket + rawMessage 的 entry
  - ticket id 是 6 位 hex,連續呼叫應不重複(機率上)

**`test/server-ui-profile.test.mjs`** — 整合測試,spawn 真 server:

- `--ui-profile customer` 啟動 → connected packet `uiProfile` 全 `true`、brand 三欄 `null`
- `--brand-name X --brand-color #06c --brand-logo <fixture>` → connected packet brand 三欄都帶值,`brand.logoUrl === "/brand/logo"`
- `GET /brand/logo` → 200 + 對應 Content-Type
- `--brand-logo <not-exist>` → server exit 非 0,stderr 帶 `brand-logo: file not found`
- `--brand-color foo` → exit + stderr 帶 `must be #rgb or #rrggbb`
- 用 stub session 模擬 thinking + tool event,驗證 ws frame 已過濾(thinking content 不出現在 ws raw bytes)
- `safeErrors` 開啟下故意觸發 server-side error → client 收到 `ticket:` 字樣的 generic 訊息;server log 有完整原訊息

#### `make lint` 通過

`tsc --noEmit` 對 `ui-profile.ts` 無 error。

### 手動驗證(本地)

| # | 操作 | 預期 |
| --- | --- | --- |
| 1 | `pi-webui --ui-profile customer` 啟動,送 prompt 觸發 read tool | 瀏覽器:看不到 thinking;看不到 tool_call 細節;顯示「正在讀取檔案...」spinner;status bar 沒有 sandbox/tunnel/session chip;model 名稱不顯示 |
| 2 | 同上 + `--brand-name "Acme Bot" --brand-color "#0066cc" --brand-logo ./test/fixtures/logo.svg` | `<title>` 與 header 顯示 Acme Bot;accent 主色變藍;header logo 換成自訂 |
| 3 | 開 devtools network,觀察 WS frame | 確認 server 已過濾 — raw payload 不含 thinking content 或 tool 細節(不是只在 client DOM 隱藏) |
| 4 | `pi-webui --hide-thinking` (僅單一旗標) | 其他顯示維持現況,只有 thinking 不見 |
| 5 | `pi-webui --safe-errors`,人為觸發 server error(例如壞掉的 session 檔) | client 收 generic「發生錯誤,請聯繫支援 (ticket: ...)」;server log 帶完整 stack + 同 ticket |
| 6 | `pi-webui`(完全不帶旗標) | 完全現況,thinking / tool / chip / model 全顯示;`uiProfile` 在 connected payload 仍出現但全 false |
| 7 | `pi-webui --brand-logo /not/exist.svg` | 啟動 exit,stderr 印 `brand-logo: file not found` |
| 8 | `pi --webui-ui-profile customer` 走 pi extension 路徑 | 同 #1 結果,確認 extension forward 正確 |
| 9 | 開兩個瀏覽器分頁,一個先連好,另一個後連 | 兩端 branding 同步;後連的 client 從 `connected` 拿到 uiProfile 後即套用;不需要 reload |
| 10 | customer mode 下用 `/export` 匯出對話 | (`/export` 應保留可用 — 客戶可下載對話給支援);匯出檔本身是否包 thinking 屬另案,本次先以 export 內容跟 UI 一致為基線 |

### 文件

- README 加 `## customer profile` 段:列出所有 flag、preset、與 `--sandbox --tunnel --password` 串接的典型部署範例
- ROADMAP `done` 加一行:`customer-facing UI profile(--ui-profile customer + --brand-* + --safe-errors)`
- CHANGELOG 加 `2026-05-22 (customer-ui-profile)` 區塊,涵蓋新增 / 改動 / 測試 / 文件四節
