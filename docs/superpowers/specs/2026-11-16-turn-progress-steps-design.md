# 長回合進度顯示與異常結束提示（設計）

日期：2026-11-16｜團隊：px（主控長歌行）｜狀態：owner 已批准（2026-11-16）
來源：owner 原話「我是希望能顯示處理進度摘要 要類似（截圖：每一步顯示「指令執行」＋網址／動作，步驟之間有一段說明文字）」；緣起 bf-c8f 報告；現況調查 px-d1 報告（`~/.local/state/herdr-team/px/team/px-d1/px-d1-report.md`）。

## 1. 問題

bf-c8f（11-14 biocrown /agent）：一回合 6 分 20 秒、31 次工具呼叫、模型完全沒有可見文字，最後一次純推理撞 `maxTokens`，`stopReason: length`，回合靜默結束。

現況（px-d1 讀程式重現）：

| 時段 | 客戶畫面（customer preset） |
|---|---|
| 模型思考（每輪 4～96 秒） | 只有三個跳動圓點 |
| 工具執行（10～320 毫秒） | 圓點下閃一下「正在處理...」就消失（spinner 不在 chat-state，工具結束即刪） |
| 最後 length、沒有文字 | 圓點消失，什麼都沒有；`hasVisibleContent` 為 false 整則跳過，沒有任何提示 |

另外：`error` 會把 `errorMessage` 原文直接顯示給客戶（`format-message.mjs:86`、`app.js:694`），沒有經 `safeErrors`；`aborted` 也沒有提示。

## 2. 目標與不做

目標
1. 長回合中客戶**一直看得到系統在做什麼**：每一步一列（動作＋對象），步驟之間插一句說明，思考中顯示經過秒數。
2. 回合結束後步驟留在對話裡，收成「已執行 N 個步驟」，可以展開；重新整理或重連後仍在。
3. 回合異常結束（`length`、`error`、`aborted`、回合內完全沒有可見回答）**一定告訴客戶**，文字不含 model、供應商、內部主機或路徑。
4. staff 模式同樣受惠：步驟列取代預設全展開的工具卡片堆疊（卡片仍可展開看原文），並標出 `stopReason`。

不做
- 不顯示 thinking 內容，也不另呼叫模型摘要 thinking（成本、延遲、洩漏面）。
- 不碰 Bifrost／litellm 設定（逾時、推理上限屬另案）。
- 不改 pi SDK。

## 3. 畫面原型

客戶（bubble 版型），回合進行中：

```
┌ 你 ─────────────────────────────────────────┐
│ 幫我把首頁的產品介紹改成新版文案             │
└─────────────────────────────────────────────┘
┌ 助理 ───────────────────────────────────────┐
│ ▾ 處理中 · 第 7 步 · 已 2 分 14 秒           │
│   我先看一下目前首頁的內容。                 │  ← 模型可見文字（有才顯示）
│   ✓ 查看資料　index.html                     │
│   ✓ 查看資料　products.json                  │
│   ✓ 查詢網站　www.example.com                │
│   接著比對新舊文案的差異。                   │
│   ✓ 處理資料                                 │
│   ✗ 執行操作（失敗，已改用其他方式）         │
│   ✓ 查看資料　about.html                     │
│   ◌ 正在分析（已 45 秒）                     │  ← 思考心跳，client 計時
└─────────────────────────────────────────────┘
```

回合結束（正常）：步驟區收合成一列，最終回答在下面。

```
┌ 助理 ───────────────────────────────────────┐
│ ▸ 已執行 12 個步驟 · 4 分 02 秒              │  ← 點開回到上面的清單
│                                             │
│ 首頁產品介紹已改好，差異如下……               │
└─────────────────────────────────────────────┘
```

回合異常結束（bf-c8f 情境）：

```
┌ 助理 ───────────────────────────────────────┐
│ ▸ 已執行 31 個步驟 · 6 分 20 秒              │
│ ⚠ 這次整理的內容太長，回覆被中斷，沒有產生   │
│   答案。請再問一次，或把問題拆小一點。       │
│   [ 請繼續 ]                                 │  ← 按下等於送出「請直接給出結論」
└─────────────────────────────────────────────┘
```

staff 模式：同一個步驟清單，每列可展開成現有的工具卡片（參數 JSON＋結果原文）；思考區塊預設收合並限高；異常結束列加上 `stopReason: length` 原文標記。

## 4. 設計

### 4.1 server：三個新 packet（`src/server/` 新模組 `turn-progress.ts`，`index.ts` 只接線）

| packet | 欄位 | 何時送 |
|---|---|---|
| `turn_step` | `turnId, stepId, n, phase: "start"\|"end", category, label, detail?, status?: "ok"\|"error", elapsedMs?` | `tool_execution_start`／`_end`（取代客戶模式的 `tool_progress`；staff 也送） |
| `turn_phase` | `turnId, phase: "thinking"\|"tool"\|"writing", since` | 階段切換時送一次，不帶任何內容 |
| `turn_notice` | `turnId, kind: "truncated"\|"error"\|"aborted"\|"no_answer", message, detail?` | `agent_end` 時依最後一則 assistant 的 `stopReason` 與「最後一則 assistant 有沒有可見文字」決定 |

- `category`／`label`／`detail` 由 server 依工具名稱與參數產生（下節）；**客戶模式永遠不帶工具原名、bash 指令原文、完整路徑**。staff 模式另帶 `toolName`，原文照舊走既有 `session_event`。
- `status` 讀 SDK 的 `isError`（順手修掉 `index.ts:2088`、`app.js:655` 讀錯欄位 `event.error` 的問題）。
- `turn_notice.message` 一律是固定中文句；`detail`（原始 `stopReason`／錯誤摘要）只在 staff 模式帶。
- 編號：`stepId` 用 SDK 的 `toolCallId`；`n` 依 `tool_execution_start` 到達順序遞增（平行工具各自一個 n，依發起順序）；`end` 以 `stepId` 對回同一列。
- `turn_phase` 觸發：`message_update` 的 `thinking_start`（或沒有 thinking 事件、但 `start` 後尚無文字）→ `thinking`；`tool_execution_start` → `tool`；`text_start` → `writing`。同一階段不重送。
- 既有 `tool_progress` 保留一個版本相容（profile 自訂 `tool_labels` 仍作用在 `label`），之後移除。

### 4.2 步驟文字：模板保底＋模型說明加分

**模板（一定有）**：`turn-progress.ts` 的分類規則

| 工具／參數 | category | detail |
|---|---|---|
| `read`／`ls`／`grep`／`find`，bash 的 `cat/grep/ls/head/sed -n/jq` | 查看資料 | 檔名 basename |
| bash 的 `curl/wget`、網址類工具 | 查詢網站 | 網址主機名 |
| `edit`／`write`，bash 的寫入類 | 修改內容 | 檔名 basename |
| bash 的 `python/node/uv run` | 處理資料 | — |
| 白名單工具（`publish_confirmed` 等） | 依工具自訂（例：發布網站） | — |
| MCP 工具與其他未列名工具 | 執行操作 | 不帶 detail（MCP 名稱任意，一律不顯示 server 或工具名；profile `[tool_labels]` 可個別覆寫） |

- detail 排除規則：隱藏檔、`.pi/`、技能目錄、`AGENTS.md`／`CLAUDE.md`、內部網域（`.internal`、`localhost`、IP、PC2／Bifrost 主機），符合就不帶 detail。
- profile `[tool_labels]` 仍可覆寫 label（既有 placeholder 白名單不變）。

**模型說明（有才顯示）**：customer 注入的系統提示（`customer-injection.ts`／`sandbox-prompt.ts` 既有注入點）加一條：「每次呼叫工具前，先用一句話告訴客戶你接下來要做什麼，不提檔案路徑、指令或系統名稱」。這句是可見文字，走既有 `text_delta`，自然插在步驟之間。模型不守規矩時只剩模板，畫面仍完整。

### 4.3 異常結束判定（`agent_end`）

| 條件（最後一則 assistant） | kind | 客戶看到 |
|---|---|---|
| `stopReason: length` 且最後一則 assistant 沒有可見文字（沒有最終回答） | `truncated` | 「這次整理的內容太長，回覆被中斷，沒有產生答案。請再問一次，或把問題拆小一點。」＋〔請繼續〕 |
| `stopReason: length` 且最後一則 assistant 有部分文字 | `truncated` | 回答下方加「回覆可能不完整（內容太長被中斷）」＋〔請繼續〕 |
| `stopReason: error`（重試用盡） | `error` | 「處理時發生問題，沒有完成。請稍後再試一次。」（原文只給 staff） |
| `stopReason: aborted` | `aborted` | 「已停止。」 |
| 其他 stopReason 但最後一則 assistant 沒有可見文字 | `no_answer` | 「這次沒有產生回答，請再問一次。」 |

- 〔請繼續〕按下就送出固定 prompt「請根據剛才查到的資料，直接給出結論」。提示句與 prompt 先寫死繁體中文，集中在 `turn-progress.ts` 一處常數，日後多語系再抽出。自動續跑規則見第 7 節。
- 同時把客戶端既有兩處原文顯示（`format-message.mjs:86` 失敗回合、`app.js:694` `auto_retry_start`）改走同一套固定句；`auto_retry_start` 客戶顯示「連線不穩，正在重試（第 N 次）」。
- 回合逾時：本案不加 server 回合逾時；上游逾時會變成 `error`，由上表處理。

### 4.4 client：步驟進 chat-state

- `chat-state.mjs` 為每個回合加 `progress = { turnId, steps[], phase, phaseSince, startedAt, notice? }`；`turn_step`／`turn_phase`／`turn_notice` 由 `session-dispatch.mjs` 分派進來，不再用 `log.appendChild` 臨時節點（修掉被 `reconcileChildren` 提前刪除的問題）。
- 新的渲染模組 `public/render-progress.mjs`：進行中展開、結束收合（`<details>`，記住使用者手動展開狀態）；思考心跳用 client 計時器每秒更新，只改文字節點不重建 DOM。
- 模型的可見文字照時間順序插在步驟之間（依 `text_start` 與 `turn_step` 的到達順序）。

### 4.5 重新整理／重連後重建

- server `filterMessageHistory`（客戶模式）遇到 assistant 的 toolCall 區塊，改成在原位置轉為安全摘要區塊 `{type:"step_summary", stepId, category, label, detail, status}`（同 4.2 規則；status 取對應 toolResult 的 `isError`），不再整塊丟掉。history 的 content 陣列保持原順序，client 依陣列順序就能重建「說明文字與步驟交錯」的排列，編號重算；toolResult 仍整則丟掉（白名單除外）。
- 異常結束的提示由 history 最後一則 assistant 的 `stopReason` 在 client 重算（同 4.3 表），不需另存。
- 順手修掉 replay 路徑送未過濾原始事件的潛在洩漏（`index.ts:2404-2406` 補 `filterEvent`）。

### 4.6 既有封包的洩漏（px-i2 e2e 稽核發現，一併處理）

customer 模式實測（`test/turn-progress-e2e.test.mjs`，commit 473bdd9）現行封包已帶出：

| 封包 | 欄位 | 類別 | 處理 |
|---|---|---|---|
| `message_history` | `payload[].model` | 模型識別名稱 | 本案修：`hideModel` 時由 server 剝除（違反專案「對外場景必須隱藏 model 名稱」） |
| `session_event` | `payload.message.model`、`payload.messages[].model` | 模型識別名稱 | 同上，在 `filterEvent`／`redactEventMessages` 剝除 |
| `connected` | `payload.appCwd` | 完整工作目錄路徑 | 本案修：customer 模式不帶（client 客戶模式本來就不顯示 cwd） |
| `session_state` | `payload.sessionFile` | 完整會話檔路徑 | 本案**不改**：client 重連靠它指定會話，改成不透明代號牽動會話協定，另案評估；e2e 的不洩漏斷言對此欄位設例外並註明 |

## 5. 測試

- 單元：`test/turn-progress.test.mjs`（分類規則、detail 排除、客戶 packet 不含工具原名／bash 原文／完整路徑／model 字串）；延伸 `chat-state`、`session-dispatch`、`format-message`（length／aborted／no_answer）、`ui-profile`（history 轉 step_summary）。
- WS e2e：以 `test/hide-thinking-e2e.test.mjs` 的 mock SSE 重現 bf-c8f——N 輪只有 reasoning 的 tool_calls，最後一輪只有 reasoning 且 `finish_reason: "length"`；斷言客戶 WS 收到 N 個 `turn_step`、一個 `turn_notice truncated`、整串 packet 不含指令原文與 model 名稱。
- 重建：WS e2e 跑完後重新連線取 `message_history`，斷言步驟數、順序（與文字交錯）、status 與即時畫面一致。
- 瀏覽器：本機 `make start` 客戶 profile，用 e2e mock 跑同一情境截圖（status bar 不可出現 model 名稱）。
- 預覽站實測：佔用預覽站（`claim.sh`；他團隊的站走 xsend 協調）、換版後用大題重跑 bf-c8f 情境，全程錄影或連續截圖，確認每步可見、異常結束有提示；通過後照常發版。

## 6. 影響範圍

- 新增：`src/server/turn-progress.ts`、`public/render-progress.mjs`、對應測試。
- 修改：`src/server/index.ts`（接線、`isError`、replay 過濾）、`ui-profile.ts`（history step_summary、停送 `tool_progress` 改送 `turn_step`）、`customer-injection.ts` 或 `sandbox-prompt.ts`（一句提示）、`public/app.js`、`chat-state.mjs`、`session-dispatch.mjs`、`format-message.mjs`、`styles.css`。
- 文件：`README.md`（新 packet、行為）、`ROADMAP.md` done 區塊。
- 相容：自訂 `tool_labels` 的 profile 仍有效；舊 client 收到新 packet 會忽略（走 default）。

## 7. owner 決定（2026-11-16，原話「q1批准 q2 截斷自動續跑 Q3 好」）

1. spec 批准。
2. **length 沒有答案時自動續跑一次**：
   - `agent_end` 判定 `truncated` 且最後一則 assistant 沒有可見文字（前面的工具說明不算最終回答）、且本次使用者提問尚未自動續跑過 → server 送 `turn_notice {kind:"truncated", retrying:true, message:"內容太長被中斷，正在重新整理答案…"}`，隨即自動送出固定 prompt「請根據剛才查到的資料，直接給出結論」。
   - 每次使用者提問最多自動續跑一次（計數在 server，以使用者送出的 prompt 為界重置）。續跑後仍 `truncated`／`no_answer` → 送不帶 `retrying` 的提示＋〔請繼續〕按鈕（4.3 表）。
   - 自動送出的那則 prompt 不顯示成使用者泡泡：即時畫面不加泡泡；`filterMessageHistory`（customer）把內容等於該固定句、且由 server 標記為自動續跑的 user 訊息濾掉（staff 模式顯示成一列「系統自動續跑」）。步驟計數與計時跨續跑連續累計，同一個步驟區。
   - length 且最後一則 assistant 已有部分文字：不自動續跑，只顯示「回覆可能不完整」＋〔請繼續〕。
3. **系統提示加「每步先說一句」**：加（4.2）。
