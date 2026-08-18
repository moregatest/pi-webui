---
name: webui-e2e-testing
description: Use when 要驗證 pi-webui 的介面、技能載入或 turn 行為改動是否真能端到端運作，想對 webui 做 e2e 測試，或遇到「webui 這種東西 e2e 不了／只能單元測試／架構性做不到」的說法。涵蓋 WS 程式化、瀏覽器自動化、preview 真實三種 driver。
---

# webui e2e 測試

## Overview

pi-webui 是一個 web app（HTTP + WS server ＋ 瀏覽器前端 ＋ pi SDK runtime）——**天生完全可以端到端測試**。當你聽到「這個 e2e 不了、只能單元測試、架構性做不到」，先懷疑那是**注入層選錯了**，不是架構限制。

**核心教訓（真實踩過的坑）**：想測 turn error 時用「弄壞 LLM API key」觸發 → pi SDK 的 `hasConfiguredAuth()` 在 turn 啟動**前**就早拋 → 根本進不了 turn-error 上報鏈 → 誤判「架構性做不到」。真相：錯誤要注在 **turn 執行的那一層**（上游 LLM 回錯），不是 auth 層。注對層,turn 就走到 `stopReason:"error"`,e2e 一路暢通。

**單元測試的盲區,只有 e2e 補得到**：unit test 證明「給我 `stopReason:error` 的 message 我會處理」;它證明不了「真實上游錯誤到底會不會被 SDK 包成那個形狀」。介面渲染、技能實際載入、turn 真實行為——同理。

## 三種 driver（何時用哪個）

| driver | 驅動方式 | 適合驗 | 速度 |
|---|---|---|---|
| **WS 程式化 client**（預設） | spawn server ＋ WebSocket 送 packet | session state、turn 行為、上報鏈、技能載入斷言 | 秒級、CI 友善 |
| **瀏覽器自動化**（Codex in Chrome） | 開真 webui、點介面、讀渲染/截圖 | 介面微調：UI 呈現、互動、視覺 | 中 |
| **preview 機真實** | 對 Fly preview 機驅動真環境 | 真 litellm／apache 反代／workspace 的整合 | 慢、最真 |

三種共用同一套**錯誤注入手段**（見下），差別只在跑在哪、怎麼驅動。

## Driver 1：WS 程式化（地基已在 repo）

`test/customer-security-integration.test.mjs` 就是可複製的 harness 範本：spawn `dist/server/index.js --listen 127.0.0.1:0` → `POST /api/login` 拿 cookie → WS `/ws` 送 `{type:"ready"}` 握手等 `connected` → 送 `{type:"prompt", message}` → 收 `session_event`/`message_history`/`session_state` 封包斷言。

**完整可跑範本**：`turn-error-e2e-example.mjs`（本目錄，實跑 PASS）。複製它、改注入與斷言即可。

## turn-error 注入（實測手段，別再選錯層）

| 手段 | 結果 |
|---|---|
| ❌ 弄壞 LLM API key | auth 層 `hasConfiguredAuth()` 早拋,進不了 turn-error |
| ❌ 改 `LITELLM_BASE_URL`／`LITELLM_API_KEY` | 對 model 路由**不生效**,那只是 secret-scrub 名單 |
| ✅ `PI_AGENT_DIR/models.json` 自訂 provider | `apiKey` 給假值(如 `sk-probe`)滿足 auth,`baseUrl` 指本機 mock 或 dead port |

正確注入下,三種上游失敗**都實測產出** `stopReason:"error"`:HTTP 500、4xx＋litellm 風格 error json、connection refused(baseUrl 指 `http://127.0.0.1:1`)。任一種都可當 fixture。

**兩個非做不可的細節**（漏了會抓到暫態或空等）：
1. `PI_AGENT_DIR/settings.json` 關 retry：`{"retry":{"enabled":false,"provider":{"maxRetries":0}}}`。否則預設 exponential backoff(2+4+8s)會把失敗訊息暫時抽離再放回 → 要嘛抓到暫態、要嘛多等 14s＋。
2. 起 server **不要帶 `--profile customer`**：customer 的 ui-profile 會過濾 `message_history`,還撞 sandbox／訊息黑名單閘門。要測 customer 專屬行為才帶。
3. **斷言分兩層**（範例都做了,只做第一層是常見縫隙）：
   - **條件層**——等 `{type:"session_event",payload:{type:"agent_end"}}` → 讀最後一個 `message_history` → 倒找最新 `role:"assistant"` → `stopReason:"error"`。
   - **上報動作層**——`reportFailedTurn` 有 `if (!globalThis.__glitchtip_sentry) return`(preview 機靠 `NODE_OPTIONS` preload 注入);只斷言條件層證明不了「真的上報」。用 `NODE_OPTIONS="--import stub-sentry.mjs"`(見本目錄)preload 假 sentry,把 `captureException` 呼叫寫探針檔,斷言 `tags.source==="turn-error"` 真被呼叫、訊息已 `scrubTurnError` 遮蔽。

## Driver 2：瀏覽器自動化（介面微調）

用 Codex in Chrome 工具（見 Codex-in-chrome 能力）：開 tab → navigate 到 `<url>/agent/`（preview）或本機 `http://127.0.0.1:<port>/webui/` → 登入(密碼) → 發話／點介面 → `read_page`/截圖斷言渲染。適合 UI 呈現、互動流程、視覺回歸。turn-error 等後端行為仍建議走 Driver 1（快、可斷言 state）。

## Driver 3：preview 機真實 e2e

同一 `models.json` 注入手段在 preview 機也適用（機上設 `PI_AGENT_DIR`）。或更真的變體:litellm virtual key 的 `max_budget` 設極低→turn 執行中被 proxy 拒(**此變體尚未實測確認觸發 turn-error,首次用先驗一次**)。preview 驗的是真 litellm／apache `/agent` 反代／真 workspace 的整合,不是邏輯——邏輯用 Driver 1 就夠。

## 技能微調的 e2e

WS driver 起 server 帶不同 skill 白名單（`--skill-allow` / `.pi/skills-allow.txt` / `PI_WEBUI_SKILLS`）→ 讀 `connected` 封包的 `slashCommands`、或 server log 的 `skills loaded ... names=[...]` 斷言技能實際載入的集合。比讀設定檔可靠(驗的是 runtime 真載入,不是意圖)。

## Common Mistakes

- **注入層選錯**：把錯誤注在 auth（壞 key）而非 turn 執行（上游回錯）→ 早拋、測不到。這是 Task 8 誤判「架構性做不到」的根源。
- **忘關 retry**：抓到會被重試蓋掉的暫態,或空等 14s＋。
- **帶 `--profile customer` 卻要讀 message_history**：被 ui-profile 過濾,拿不到。
- **以為 `LITELLM_BASE_URL` 能換 model 路由**：不能,那只在 scrub 名單;真正的注入層是 `PI_AGENT_DIR/models.json`。

## 更正記錄

GlitchTip Task 8（2026-07）曾把 webui turn-error 判為「架構性 e2e 做不到」,並讓 spec 驗收留空、只靠單元測試。實為**注入層選錯**(打 auth 而非 turn 執行)。本 skill 的注入手段經實測:三種上游失敗情境全產出 `stopReason:"error"`,`turn-error-e2e-example.mjs` 實跑 PASS。webui e2e 不是做不到,是要注對層。
