# pi 對 Claude Code skill 的相容性驗證 + Chrome MCP 缺口

日期：2026-05-25
驗證者：tung
模型：`openrouter/deepseek/deepseek-v4-pro`
測試目錄：`/tmp/nine9-pi-test`（隔離環境，customer_data 用 symlink 連回原專案）

## 背景與目標

pi-webui 的產品定位：

> 工程師用 Claude Code 把困難的設計與初版實作做完(skill 內含完整規則、決策樹、產出規格)，後勤人員透過 pi-webui 接手做微調與重跑，讓 AI 紅利在團隊內分配。

要達成此分工，pi 必須跟 Claude Code **對 skill 的理解一致**：
- 一級指令文件，整檔讀進 context
- 規則編號 / Step 順序 / 區塊產出格式都照規範跑
- 互動 checkpoint 該停就停

本次驗證取 readyaiJobs 客戶專案 `nine9.jic-tools.com.tw` 的真實流程做 1:1 重跑比對。

## 驗證 1：`/onboard-skeleton`（已完成的 skill 重跑）

### 對照原 Claude Code session

| 面向 | Claude Code (Opus 4.7) | pi + deepseek-v4-pro |
|---|---|---|
| Step 0 偵測 `skeleton.status=completed` | ✅ | ✅ |
| 走 `--force` 確認分支 | ✅ | ✅ |
| 跳過 readyai-website-outline 用既有 raw | ✅ | ✅ |
| 規則 K 幻覺 URL 偵測 | 161/161 | 161/161 |
| 規則 J 產品實例剝除 | 139 筆 | ~140 筆 |
| 規則 L 失能頁偵測 | **第二輪才補**（5 筆） | **一輪即套用**（5 筆）|
| 規則 H Profile 覆蓋 | 10/10 | 10/10 |
| 規則 I 買家可讀性改名 | 3 個 | 3 個 |
| NC Helix Drill 漏掛 critical | ✅ | ✅ |
| Super Drill 漏掛 | ✅ | ✅ |
| 規則 G 重複 URL | ❌ 漏掉 certificate-patents | ✅ 抓到 4 筆共用 |
| 四區塊輸出格式 | ✅ | ✅ |

結論：pi 把 SKILL.md 視為一級指令文件，完整載入 frontmatter + 全文進 `<available_skills>` 與 context、依規則 A~L 順序執行、產出規範格式。沒有「把 skill 當 prompt template」或「只讀 description 不讀內文」的退化行為。

某些項目（G-1 重複偵測、L 規則立即套用）品質**優於**原 Opus 4.7 session（後者是用戶反饋後才補規則 L）。

## 驗證 2：`/onboard-init`（從 0 跑完整 pipeline）

### 環境設置（必要前置）

pi 預設只掃 `~/.agents/skills/`，**不會** auto-discover Claude Code 的 `.claude/skills/`。專案要被 pi 看到必須建 symlink：

```
.agents/skills -> ../.claude/skills
```

`readyai-project create` template 已自動建立此 symlink ✅

### 跑完整 pipeline 結果

| 階段 | 完成時間 | 產出 | 狀態 |
|---|---|---|---|
| Step 0-A 客戶資料盤點 | 15:29 | `customer_data_index.yaml` (3KB) | ✅ |
| Step 0-B baseline profile from PDF | 15:31 | `.profile.from_customer` (10KB) | ✅ |
| Step 1 onboard pipeline 啟動 | 15:31–15:41 | `.onboard-status.yaml` 三段 completed | ✅ |
| - profile (web-only) | 15:33 | `.profile` (4.5KB) | ✅ |
| - crawl (416 pages) | 15:41 | `documents.xml` (161MB) | ✅ |
| - profile_enrichment | 15:41 | cache.json | ✅ |
| Step 1-C AI-driven merge | 15:43 | `.profile.merge_report.md` + `.profile` (15KB) | ✅ |
| Step 2-6 Chrome 補抓 | 15:46 | `customer/atts/.discovered.txt` | ⚠️ **降級執行** |

### 合併品質驗證（Step 1-C）

pi 自動發起 3 項衝突並按客戶 ground truth 解決：

- `businessType`：客戶選 Agent/Exporter，web AI 誤判 OBM → 採客戶值
- `productServiceOffering`：客戶選 MassManufacturing，web 說 FinishedProducts → 採客戶值
- `targetAudience`：客戶選 DistributorDealer/Importers，web 泛標 B2B → 採客戶值

完全符合 skill 「客戶優先、衝突一定發起討論」的規範（雖然在 `--print` 模式下 pi 自行裁決而非問操作者；但裁決邏輯與規則完全對齊）。

## ⚠️ 待解：Chrome MCP 不可用 → 偏離 skill 規範

### 觀察

`onboard-init` Step 2-6 規定：

> 啟動前先呼叫 `mcp__claude-in-chrome__tabs_context_mcp` 確認 Chrome MCP 可用。**若無法連線 → 停止並提示**（Step 0/1/1-C 結果保留，只是補抓階段先跳過）。

pi 實際行為：

```
# Chrome MCP 不可用，改用 curl 掃描重點頁面
# Spider 已知: 16 PDFs + 33 YouTube videos
# 結果: 靜態掃描無新增項目。
# 限制: 未涵蓋 JS 動態渲染內容（需 Chrome MCP）
```

pi 沒停下、而是降級成 curl 掃靜態 HTML。**這違反 skill 規範**——skill 明確要求 Chrome MCP 不可用就 skip，因為 curl 看不到 JS 動態載入的附件 / 影片（onboard-init 的補抓本意就是補 spider 漏的動態內容）。

### 根本問題

pi 沒有 `mcp__claude-in-chrome__*` 這組 MCP server：

```
$ pi --help | grep -i mcp     # 無 MCP 相關設定
```

pi 的 extension / MCP 機制與 Claude Code 不同：
- Claude Code 透過 `.mcp.json` / `~/.claude/mcp_servers.json` 註冊 MCP
- pi 透過 `~/.pi/agent/settings.json` 的 `packages` 註冊 extension（npm package 或 local path）

`claude-in-chrome` 是 Anthropic 給 Claude Code 的 Chrome 擴充功能，**不是 npm package**，目前無法直接在 pi 註冊。

## 接下來要解決：tabs_context_mcp 等 Chrome 控制工具的相容

要讓後勤人員在 pi-webui 也能跑 `onboard-init` Step 2-6（這正是「設計給後勤接手」的關鍵 use case），必須讓 pi 能呼叫等價的 Chrome 控制 API。

### 候選方向（待 brainstorm）

1. **包一層 pi extension 轉接 claude-in-chrome 的 native messaging**
   - 從 Chrome extension 那端把 tabs/navigate/read_page/find/javascript_tool 等 RPC 透過 WebSocket 或 socket 暴露
   - pi 端寫 `pi-chrome-bridge` extension，把這些 API 註冊成 pi tool
   - 工具命名建議直接複用 `tabs_context_mcp` / `navigate` / `read_page` 等，skill 才不用改

2. **改用 Playwright / Puppeteer 作為 pi-side 實作**
   - 不依賴 Chrome extension，由 pi 直接驅動 headless / headful browser
   - 缺點：失去使用者已登入的 session（會員牆內容看不到，雖然 skill 規定不嘗試登入，但仍會丟失 cookie context）

3. **MCP server 標準化**
   - 把 claude-in-chrome 重構為 standalone MCP server（stdio 或 SSE）
   - pi 也支援 MCP server 註冊（目前 pi 似乎只支援自家 extension，需確認）
   - 同一份 MCP server 兩邊用，是最乾淨的長期解

### 對 skill 端的要求

skill 內呼叫 `mcp__claude-in-chrome__*` 的工具名稱應保持穩定，pi 端不論怎麼實作都對齊這個命名空間，skill 才不需要為了 pi 改一遍。

## 結論

| 項目 | 結論 |
|---|---|
| pi 對 skill 的理解 | ✅ 與 Claude Code 對等，部分項目品質更好 |
| `.agents/skills -> .claude/skills` symlink | ✅ template 已自動建立 |
| 互動式 skill 在 `pi --print` 下的表現 | ⚠️ 會自行裁決而非問操作者，需用 `pi -c` 多輪 |
| Chrome MCP（`mcp__claude-in-chrome__*`） | ❌ **缺口** — 後勤人員用 pi-webui 跑 onboard-init Step 2-6 會降級 |
| 全域 broken extension（`/tmp/pi-chat`） | 環境問題，本次以 `pi remove` 清掉 |

設計目標——「工程師用 Claude Code 把困難做完、後勤用 pi-webui 接手」——技術上幾乎成立，**唯一阻擋 use case 收斂的是 Chrome MCP 相容性**。建議下一個 sprint 開出此 spec 並落實方案 1 或 3。
