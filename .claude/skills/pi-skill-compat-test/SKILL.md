---
name: pi-skill-compat-test
description: Use when verifying pi runs Claude Code skills equivalently to Claude Code, regression-testing after pi SDK or pi-coding-agent dist upgrades, evaluating a new LLM (deepseek/qwen/etc.) for skill compliance, or investigating reports that pi behaves differently from Claude Code on a specific skill
---

# pi 對 Claude Code skill 相容性測試

## Overview

readyai-webui 的產品定位是「工程師用 Claude Code 把困難的設計與初版實作做完(skill 內含完整規則 / 決策樹 / 產出規格),後勤人員用 readyai-webui 接手做微調與重跑」。要讓這分工成立,pi 必須把 SKILL.md 當**一級指令文件**:

- 整檔讀進 context(不是只讀 frontmatter / description)
- 規則編號 / Step 順序 / 區塊產出格式照規範跑
- 互動 checkpoint 該停就停

**核心原則**:不能退化成「把 skill 當 prompt template」或「只讀 description 不讀內文」。退化 = 後勤接手不了 = 產品定位破功。

驗證方法:**1:1 重跑比對** — 取一個 Claude Code 已跑過、產出可信的真實 session,在隔離環境用 pi 跑同一份 skill、同一份輸入,逐 Step / 逐規則比對輸出。

## When to Use

- 升級 `@earendil-works/pi-coding-agent` dist
- readyai-webui server runtime 改了 `createAgentSessionServices` / `createAgentSessionRuntime` / `SessionManager` 的呼叫
- 換新 model(例如從 `openrouter/deepseek/deepseek-v4-pro` 換到下一代)
- 反饋說「pi 跑 skill 跟 Claude Code 不一樣」
- 評估某個 skill 是否能放心交給後勤人員用 readyai-webui 重跑
- 新增 skill 後想確認 pi / Claude Code 兩邊一致

**不適用**:
- 純 public/ 前端 UI 改動,沒動到 runtime / skill loading → 跑 client 端 `node:test` 就好
- skill 本身的設計階段 → 用 `superpowers:writing-skills` + `superpowers:brainstorming`
- 一般 readyai-webui server bug → 一般 debug 流程

## Prerequisites

開跑前先過這個 checklist,任何一項失敗 → 停下來修,不要繞過:

1. **隔離測試目錄**

   ```bash
   mkdir -p /tmp/<test-name>-pi-test
   cd /tmp/<test-name>-pi-test
   ```

   不要在原專案目錄跑,避免污染 `.onboard-status.yaml` / `.profile` 等檔。

2. **customer_data 用 symlink 連回原專案**

   ```bash
   ln -s /path/to/real/customer_data customer_data
   ```

   不要 copy(可能幾 GB)。symlink 確保跑出來的是真實資料。

3. **`.agents/skills -> .claude/skills` symlink 存在**

   pi 預設只掃 `~/.agents/skills/`,**不會** auto-discover Claude Code 的 `.claude/skills/`。專案層級必須建 symlink:

   ```bash
   # 在 customer 專案根目錄
   ls -la .agents/skills  # 應該 → ../.claude/skills
   ```

   `readyai-project create` template 已自動建好。沒建就手動補:

   ```bash
   mkdir -p .agents
   ln -s ../.claude/skills .agents/skills
   ```

4. **清掉全域 broken extension**

   ```bash
   pi --help 2>&1 | grep -i "failed to load"   # 看有沒有 broken extension
   pi remove /tmp/<broken-extension-path>       # 清掉
   ```

   全域 broken extension 會污染 session,把它清乾淨再跑。

5. **確認 pi binary 與 model**

   ```bash
   which pi && pi --version
   # 把要測的 model 記下來,例如 openrouter/deepseek/deepseek-v4-pro
   ```

## 標準測試流程

### Step 1:選定 baseline session

從 Claude Code(Opus 4.7 或當代最強 model)已跑過、產出可信的 session 挑一個。建議優先用 readyaiJobs 流程的真實客戶 case,因為:

- skill 規則最完整(`/onboard-skeleton` / `/onboard-init` 都有 10+ 規則 + 多階段 pipeline)
- 有真實 ground truth 可比對(客戶資料、profile 答案)
- 涵蓋互動 / 自動 / Chrome MCP 三類能力

把 baseline session 的關鍵產出記下來:每個 Step 的時間戳、每條規則的命中數 / 產出筆數、最終區塊輸出。

### Step 2:在 pi 跑同一份 skill

```bash
cd /tmp/<test-name>-pi-test
pi -c                # 互動模式,reproduce 客戶互動
# 或
pi --print "/<slash-command> <args>"   # 一次性 print 模式
```

⚠️ **`pi --print` 模式下,互動式 skill 會自行裁決而非問操作者**。如果 skill 規定「衝突一定發起討論」,`--print` 會自己選,雖然裁決邏輯可能對齊規則,但**不能驗證互動 checkpoint 是否被尊重**。要驗證互動行為必須用 `pi -c` 多輪。

### Step 3:逐項對照,寫成表格

照這個格式產出對照表(直接寫進 `docs/superpowers/specs/<date>-pi-skill-compat-validation-<context>.md`):

```markdown
| 面向 | Claude Code (Opus 4.7) | pi + <model-id> |
|---|---|---|
| Step 0 偵測 `<status-field>` | ✅ | ✅ |
| 規則 A xxx | <count> | <count> |
| 規則 B xxx | <count> | <count> |
| ...(每條規則一行) |  |  |
| 互動 checkpoint X | 停下問人 | 停下問人 / 自行裁決 |
| 區塊輸出格式 | ✅ | ✅ / ❌ |
```

每一行打 ✅(完全對齊)、❌(明確退化)、⚠️(降級或部分對齊)。

### Step 4:標出退化 / 缺口 / 優於原 session 的點

退化 = 違反 skill 規範(必須處理)。
缺口 = 環境 / 工具差異(例如 Chrome MCP 不可用)。
優於原 session = pi 跑得比 baseline 好(例如更早套用某規則),記下來當 model 評估證據。

### Step 5:寫結論

最後一段必須回答:**「這個 skill 在當前 pi + model 組合下,是否可以放心交給後勤人員用 readyai-webui 重跑?」**

- 全綠 → 可以,直接收斂 use case
- 有退化但可繞 → 列出 workaround(例如「用 `pi -c` 不用 `--print`」)
- 有阻擋級缺口 → 開 follow-up spec,在 ROADMAP 列出

## 必須驗證的已知退化點

每次跑都至少看這幾項,確認沒回退也沒新增:

### Chrome MCP 不可用時 pi 的行為

`onboard-init` Step 2-6 規範:「若 `mcp__claude-in-chrome__tabs_context_mcp` 不可用 → **停止並提示**,不要繼續」。

pi 目前**會降級成 curl 掃靜態 HTML**,違反 skill 規範(curl 看不到 JS 動態載入的附件 / 影片,而補抓本意就是補 spider 漏掉的動態內容)。

驗證方式:故意不啟動 Chrome / 不註冊 chrome bridge,看 pi 是停下還是降級。若還是降級 → 這條缺口仍在,記進對照表 ❌ 欄。

### `pi --print` 對互動 checkpoint 的處理

互動 skill 在 `--print` 模式下 pi 會自行裁決。驗證互動行為要用 `pi -c`,不要用 `--print` 跑互動 skill 然後抱怨它不問人。

### skill 規則順序與編號

逐條規則(A / B / C ... 或 Step 1 / 2 / 3)看 pi 是否照原順序執行、產出的編號註記是否完整。若 pi 跳號 / 合併規則 / 改順序 → ❌。

### 區塊產出格式

skill 規範的最終區塊(例如 `/onboard-skeleton` 的四區塊輸出)pi 是否照規格產出。文字數、區塊標題、順序都要一致。

## 已知的 readyai-project 兩大 use case

跑 regression 時這兩個都過 = 高機率全綠:

### `/onboard-skeleton`(skeleton 重跑)

- 規則 A~L 完整覆蓋(幻覺 URL 偵測、產品實例剝除、失能頁偵測、Profile 覆蓋、買家可讀性改名、Drill 漏掛、重複 URL 等)
- 四區塊輸出格式
- `--force` 確認分支
- baseline:從 readyaiJobs 取一個 skeleton 已 completed 的客戶案

### `/onboard-init`(從 0 跑完整 pipeline)

- Step 0-A 客戶資料盤點 → `customer_data_index.yaml`
- Step 0-B baseline profile from PDF → `.profile.from_customer`
- Step 1 pipeline(profile / crawl / profile_enrichment)→ `.onboard-status.yaml`
- Step 1-C AI-driven merge → `.profile.merge_report.md` + `.profile`
- Step 2-6 Chrome 補抓 → `customer/atts/.discovered.txt`(這步會踩 Chrome MCP 缺口)
- baseline:從 readyaiJobs 取一個 init 跑完的客戶案

## 對照表寫進哪裡

產出檔放在 `docs/superpowers/specs/<YYYY-MM-DD>-pi-skill-compat-validation-<context>.md`,例如:

- `2026-05-25-pi-skill-compat-validation.md`(首次驗證,deepseek-v4-pro)
- `2026-08-01-pi-skill-compat-validation-qwen3.md`(換 model 後)
- `2026-09-15-pi-skill-compat-validation-sdk-0.42.md`(SDK 升級後)

header 一定要記:**日期 / 驗證者 / 模型 / 測試目錄**。後續 regression 才能 diff 對照。

## Common Mistakes

| 情況 | 為什麼錯 |
|---|---|
| 直接在原客戶專案目錄跑 | 污染 `.onboard-status.yaml` / `.profile`,baseline 被覆寫就再也回不去 |
| 沒設 `.agents/skills -> .claude/skills` symlink | pi 根本載不到 skill,測出來都是 ❌,但根因是環境 |
| 用 `pi --print` 跑互動 skill 然後說 pi 不問人 | `--print` 不互動是設計,不是退化。要驗互動用 `pi -c` |
| 沒先清全域 broken extension | session 啟動就一堆 warning,污染對照 |
| 對照表只記「過 / 不過」,沒記 count | 規則 J 抓 139 vs 140 跟 0 vs 140 差很多,要寫具體數字 |
| 拿不同客戶 case 對 Claude Code / pi 兩邊 | baseline 不一致,比對毫無意義。一定要同一份輸入 |
| Chrome MCP 不可用就跳過該步而非記退化 | 這正是要驗的缺口,跳過就漏了 |

## Red Flags(看到這幾個立刻記退化)

- pi 完全沒提到 skill 裡的規則編號(代表沒讀內文)
- pi 把規則 A~L 整段壓縮成一句總結(代表只讀 description / frontmatter)
- 互動 skill 的 checkpoint 完全沒觸發(且不是 `--print` 模式)
- Chrome MCP / 任何 MCP 不可用時 pi 「自動降級」而非停止
- 規則順序錯亂、或某條規則完全沒執行卻沒解釋
- 區塊輸出標題、順序與 skill 規範不一致

## 與其他 skill 的關係

- 設計新 skill:`superpowers:writing-skills` + `superpowers:brainstorming`
- 跑完發現 pi 端要修:`superpowers:writing-plans` 開 spec
- 修完要驗:回到這份 skill 重跑 regression

## 歷史驗證紀錄

首次驗證:`docs/superpowers/specs/2026-05-25-pi-skill-compat-validation.md`(pi + deepseek-v4-pro 對 Opus 4.7 baseline,結論「對等、部分項目品質更好,唯一阻擋是 Chrome MCP 缺口」)。
