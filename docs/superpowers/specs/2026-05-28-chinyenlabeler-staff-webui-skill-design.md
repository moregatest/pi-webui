# chinyenlabeler — readyai-staff-webui skill 設計

日期 2026-05-28
狀態 brainstormed,完成,待實作

## 動機

`www.chinyenlabeler.com` 專案要在 2026-05-29 會議上 demo pi-webui sandbox 機制,搭配「後勤(staff)接口」呈現。

現況:

- 專案已有 `.pi/profiles/readyai.toml`,但**僅設了 `[sandbox]` image**(`readyai-sandbox:0.1.0-3.23.0-bba981`),沒有 UI / brand / tool_labels
- 沒有專屬 logo
- 沒有「召喚 webui」的標準動作 — 每次 demo 都得手動回想啟動旗標、自動 password、tunnel 與否

設計目標把上面收斂成一個 skill:**召喚 → 詢問 tunnel → 背景啟動 → 回報 URL/password**,讓 demo 與後勤日常使用一致、agent(Claude Code / pi)都能跑。

## 非目標

- **客戶接口(customer profile)**:此 skill 只啟員工接口;客戶介面留給後續另一個 skill(或直接用 pi-webui 內建 `--profile customer` fallback)
- **多 instance / 多 port 並行**:單一 instance、固定 4096 port,衝突時 fail-fast 由人決定 kill 哪個
- **自動開 chrome**:skill 預設只回報 URL,使用者自行打開瀏覽器。「測試 / 驗收」階段由 agent 跑 chrome MCP,但不寫進 skill 步驟
- **自動 fallback(沒 cloudflared → 退 LAN)**:fail-fast,讓使用者決定要不要裝
- **R2 sync 自動觸發**:skill / profile / logo 三檔寫入後不主動 `readyai-project sync-up`,由使用者顯式執行
- **skill 自我升級 / 版本檢查**:skill 文字寫死,不檢查 pi-webui 版本

## 整體架構

```
┌──────────────────────────────────────────────────────────────────┐
│ Agent (Claude Code / pi)                                          │
│                                                                   │
│  讀 .claude/skills/readyai-staff-webui/SKILL.md                   │
│         │                                                         │
│         ▼                                                         │
│  Step 1 入口檢查 (cwd / pi-webui CLI / logo)                       │
│  Step 2 詢問 tunnel (Yes / No)                                    │
│  Step 3 組指令 + 背景 spawn pi-webui                               │
│  Step 4 輪詢輸出 → 抓 URL → 回報使用者                              │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
          │
          │  Bash run_in_background
          ▼
┌──────────────────────────────────────────────────────────────────┐
│ pi-webui server (背景 process)                                    │
│   --profile readyai  → 讀 .pi/profiles/readyai.toml               │
│       └ [sandbox]    image=readyai-sandbox:...                    │
│       └ [ui]         hide_model=true,其他保留細節                 │
│       └ [brand]      name=ReadyAI 後勤,logo,accent=#ff8c42        │
│       └ [tool_labels.*]  中文化 spinner                            │
│                                                                   │
│   --tunnel  (Yes) → cloudflared quick tunnel                      │
│      或                                                            │
│   --listen 0.0.0.0:4096 --password <rand-hex-8>  (No)             │
└──────────────────────────────────────────────────────────────────┘
```

## 檔案改動

### chinyenlabeler 專案(無 git,靠 R2 sync)

| 檔 | 動作 | 說明 |
| --- | --- | --- |
| `.claude/skills/readyai-staff-webui/SKILL.md` | 新增 | agent runbook,frontmatter + 步驟 |
| `.pi/profiles/readyai.toml` | 擴充 | 加 `[ui]` / `[brand]` / `[tool_labels.*]`;`[sandbox]` 既有不動 |
| `.pi/assets/staff-logo.png` | 新增 | 從 `https://www.ready-market.com/apple-touch-icon.png` 抓;退 favicon.ico 用 magick 轉 |

`.agents/skills` 已是 `../.claude/skills` symlink,pi 與 Claude Code 兩邊自動可見,不需額外處理。

### pi-webui repo (git 管控)

| 檔 | 動作 | 說明 |
| --- | --- | --- |
| `docs/superpowers/specs/2026-05-28-chinyenlabeler-staff-webui-skill-design.md` | 新增 | 本份 spec |

## Skill runbook 內容

### Frontmatter

```yaml
---
name: readyai-staff-webui
description: 啟動 chinyenlabeler 專屬的後勤 pi-webui(員工接口 + sandbox)。
  當使用者說「開後勤 webui / 啟 webui 給後勤 / 給同事連 pi-webui /
  demo pi-webui 沙盒」等等時觸發。會先問是否要開 cloudflare tunnel,
  然後背景啟動 pi-webui 並回傳 URL + password。
---
```

### 步驟

1. **入口檢查**(任一失敗即停)
   1. cwd = chinyenlabeler 根(看 `.pi/profiles/readyai.toml` 是否存在)
   2. `which pi-webui` 找得到
   3. `.pi/assets/staff-logo.png` 不存在 → 嘗試抓:
      ```bash
      mkdir -p .pi/assets
      curl -sSL -f -o .pi/assets/staff-logo.png \
        https://www.ready-market.com/apple-touch-icon.png || \
      { curl -sSL -o /tmp/rm.ico https://www.ready-market.com/favicon.ico && \
        magick /tmp/rm.ico[0] -resize 128x128 .pi/assets/staff-logo.png; }
      ```
2. **詢問 tunnel** — 對使用者一題:「要不要開 cloudflare tunnel?(外網訪客可連)」
3. **組指令**
   - Yes:確認 `which cloudflared`,找不到 fail-fast。指令:`pi-webui --profile readyai --tunnel`
   - No:`PW=$(openssl rand -hex 8)`;指令:`pi-webui --profile readyai --listen 0.0.0.0:4096 --password "$PW"`
4. **背景啟動 + 輪詢 URL**(平台對應工具,Claude Code 用 Bash `run_in_background=true`,pi 用同等機制)
   - 最多輪詢 90 秒
   - 抓 `Local URL: http://...` 或 `Tunnel URL: https://....trycloudflare.com`
   - 超時 → 印目前 log,停止
5. **回報** — 給使用者:
   - 連線 URL(tunnel → trycloudflare.com;LAN → `http://<LAN-IP>:4096` 或 `http://localhost:4096`)
   - Password(兩種模式都有)
   - 「Sandbox 首次啟動會 lazy-boot QEMU image,首次 tool 調用會慢 1–2 分鐘」
   - 「結束時叫我關掉,或自行 `kill <pid>`」

### 失敗處理

- spawn 立刻 exit → 把 stderr 完整貼給使用者,常見原因:port 4096 被占用 / cloudflared 未裝 / sandbox image 拉不到
- URL 輪詢超時 → 不 retry,把現有 log 貼出來等使用者判斷

### 禁止

- 不把 `--password` 寫到 log / commit / 任何檔案(只 echo 給使用者一次)
- 不自動開 chrome(除非使用者明說「順便開瀏覽器」)
- 不 fork 新 profile,只用 `readyai`

## Profile 擴充內容(`.pi/profiles/readyai.toml`)

```toml
[meta]
description = "ReadyAI 後勤 — chinyenlabeler 員工接口(sandbox + brand)"

[sandbox]
image = "readyai-sandbox:0.1.0-3.23.0-bba981"

[sandbox.env]
READYAI_SANDBOX_MODE = "1"

[ui]
# 員工模式:技術細節保留(tool args / result / cwd 都看得到),只藏 model
hide_thinking       = false
hide_tool_calls     = false
show_tool_progress  = true
hide_status_chips   = false
hide_session_picker = false
hide_model          = true   # CLAUDE.md 鐵則:對外/內部都隱藏 model
safe_errors         = false  # 員工要看完整 stack debug
expose_tool_args    = false  # tool 進度標籤不引用 args(安全保守)

[brand]
name   = "ReadyAI 後勤"
logo   = "./.pi/assets/staff-logo.png"
mode   = "dark"
accent = "#ff8c42"

# 不設 [skills].allow / [commands].allow → 員工全權限
# 不設 [defaults].model → 沿用 pi 預設或啟動旗標

[tool_labels.read]
start = "讀取 {file_basename}"
end   = "讀取完成"

[tool_labels.bash]
start = "執行指令..."
end   = ""

[tool_labels.grep]
start = "搜尋..."
end   = ""

[tool_labels.edit]
start = "編輯 {file_basename}"
end   = "編輯完成"

[tool_labels.write]
start = "寫入 {file_basename}"
end   = "寫入完成"

[tool_labels.WebFetch]
start = "抓取 {url_host}"
end   = "抓取完成"

[tool_labels._default]
start = "處理中..."
end   = ""
```

設計理由摘要:

- 所有 `hide_*` 預設 false → 員工身份要看完整細節(技術 debug 用)
- `hide_model = true` 唯一例外 — `CLAUDE.md` 鐵則「對外場景必須隱藏 model」內部員工也適用
- 不設 `[skills].allow` → 員工全權限,跟 `nine9 staff` 範例對齊
- `accent = "#ff8c42"` 同 `pi-webui` 既有 staff 範例橘色,demo 視覺一致(對外品牌掛 ReadyAI,不需 chinyenlabeler 自己的紅)
- `expose_tool_args = false` 保守 — `{tool_arg.<key>}` placeholder 不開,避免無意 leak
- `tool_labels._default` 兜底任何未列名 tool

## 啟動指令對照表

| 場景 | 指令 |
| --- | --- |
| 員工本機 demo(LAN) | `pi-webui --profile readyai --listen 0.0.0.0:4096 --password <rand>` |
| 員工本機 demo(tunnel) | `pi-webui --profile readyai --tunnel` |
| 員工 + 自訂 model | 上述任一加 `--model openrouter/<...>` |

`--profile readyai` 已含 sandbox image 注入,不需另加 `--sandbox`(profile.sandbox 自動觸發)。

## 測試 / 驗收

實作完成後,以 `pi` 在 chinyenlabeler 專案內跑 `/readyai-staff-webui` skill(LAN 模式,避開 cloudflared 安裝依賴),然後:

1. chrome MCP `tabs_create_mcp` 開回報的 URL
2. login(輸入 password)
3. 截圖檢查:
   - 左上 brand chip 顯示「ReadyAI 後勤」
   - logo 圖片載入(/brand/logo 不是 404)
   - accent 橘色生效(送訊息按鈕 / focus border)
   - 右下角無 model 名稱
4. 送一個簡單 prompt(如「列出當前目錄」),確認 `bash` tool spinner 顯示「執行指令...」中文
5. 截圖存到 `docs/screencast/staff-webui-chinyenlabeler.png`(pi-webui repo)作為 demo 備援素材

驗收失敗條件:

- brand name 不對 / logo 是預設 favicon → profile 載入錯
- 右下角看到 `openrouter/...` / `anthropic/...` → `hide_model = true` 沒生效
- tool spinner 是英文 → `[tool_labels.*]` 沒被讀

## 風險與緩解

| 風險 | 緩解 |
| --- | --- |
| ImageMagick 未裝(macOS 不預設) → favicon 轉 png 失敗 | apple-touch-icon 是 PNG,作為首選路徑;ImageMagick 是 fallback |
| port 4096 被既有 pi-webui 占用 | spawn fail-fast,使用者 `lsof -i:4096` 自行決定 kill 哪個;不另開 port |
| Sandbox image 首次 pull 慢(QEMU image ~200MB) | skill 回報訊息預先警告「首次 tool 調用會慢 1–2 分鐘」 |
| LAN 模式 password leak(口頭傳/截圖) | 不寫到任何檔案,使用者責任 |
| skill 寫到 chinyenlabeler 後沒 R2 sync,其他機器看不到 | spec 文件記載「使用者後續執行 `readyai-project sync-up` 推 R2」;skill 不主動 sync |

## ROADMAP / 後續

- **客戶介面 skill**(`readyai-customer-webui`):類似結構但走 `--profile customer` + 強制 tunnel,本份不做
- **多 instance 切換**(同時跑 staff + customer 對照 demo):暫不需要,人工 kill 重啟即可
- **skill 自動 sync R2**:等使用者實際痛點再加,避免無意 push 到雲端
