# pi-webui — CLI 模型與技能參數支援

日期 2026-05-20
狀態 approved (由 session goal 授權)

## 動機

pi-webui 啟動時目前只能從 settings 推測預設模型,也無法在啟動命令上控制要載入哪些技能 (skills)。對於需要在不同專案、不同模型/技能組合間切換的使用者,缺乏 CLI 等價物。本 spec 補齊三個能力:

1. 啟動時以 CLI 參數指定模型
2. 啟動時匯入額外技能來源
3. 啟動時以白名單限制要載入哪些技能;白名單未提供 → 載入全部

## CLI 介面

| 旗標 | 對應環境變數 | 說明 |
| --- | --- | --- |
| `--model <provider/id>` | `PI_WEBUI_MODEL` | 啟動時的 session 預設模型。可只寫 id (registry 自動匹配),亦可加 `provider/` 前綴。 |
| `--skill <path>` (可重複) | `PI_WEBUI_SKILLS` (以 `:` 或 `,` 分隔) | 額外的技能來源目錄或檔案。逐一附加到 `resourceLoaderOptions.additionalSkillPaths`。 |
| `--skill-allow <names>` | `PI_WEBUI_SKILL_ALLOW` | 逗號分隔的技能白名單,以 `Skill.name` 比對。設定後僅載入名單內的技能。 |
| `--skill-allow-file <path>` | `PI_WEBUI_SKILL_ALLOW_FILE` | 一行一個技能名稱的白名單檔。`#` 開頭視為註解,空行忽略。**檔案不存在 → 視同未設定 (全部載入)**。 |

優先順序:`--skill-allow` (CLI) > `--skill-allow-file` > 無 (全部載入)。

`pi-webui --help` 與 README 對應更新。

## 實作要點

### `src/server/index.ts`

1. `parseArgs` 擴充
   - `--model`、`--model=`
   - `--skill`、`--skill=` (可重複,推入陣列)
   - `--skill-allow`、`--skill-allow=`
   - `--skill-allow-file`、`--skill-allow-file=`

2. 環境變數 fallback,語意比照 `--listen` / `PI_WEBUI_HOST` 既有模式。

3. 白名單解析
   - 若 `--skill-allow` 有值 → 直接以逗號 split
   - 否則若 `--skill-allow-file` 有值且檔案存在 → 讀檔逐行解析,跳過 `#` 註解與空行
   - 否則 → `null` (= 不過濾,全部載入)

4. `createRuntime` 帶入 `resourceLoaderOptions`
   - `additionalSkillPaths`: 解析後的絕對路徑陣列
   - `skillsOverride`: 若白名單非 `null`,過濾 `skills` 為僅保留名單內項目;`diagnostics` 維持。

5. `services` 建立後,若 `--model` 有值,從 `services.modelRegistry` 找模型 (先用 `provider/id` 直接比對,再用 `id` 寬鬆匹配)。找不到 → 印警告到 stderr 並 fallback 預設 (與既有 `modelFallbackMessage` 風格一致)。把找到的 model 傳給 `createAgentSessionFromServices({ model })`。

6. `printHelp()` 補上新參數說明。

### `src/extension/index.ts`

- `StartOptions` 加 `model`、`skills?: string[]`、`skillAllow?: string`、`skillAllowFile?: string`。
- 註冊 pi flags:`--webui-model`、`--webui-skill`、`--webui-skill-allow`、`--webui-skill-allow-file`。
- spawn 時把對應參數加進 `serverArgs`。`--webui-skill` pi flag 是字串型,允許 `:` 或 `,` 分隔多個路徑。

## 錯誤處理

- `--model` 找不到模型 → stderr 警告,繼續啟動使用預設。
- `--skill` 路徑不存在 → 由 `loadSkills` 自帶的 diagnostics 處理,沿 `services.diagnostics` 流回 webui `connected` 訊息。
- `--skill-allow-file` 檔案存在但無有效項目 → 「白名單為空」,合理用法,所有技能都會被過濾掉。
- `--skill-allow-file` 檔案不存在 → 視同未設定,載入全部技能。

## YAGNI 排除

- 不做 model alias、不做 skill alias、不做 wildcard 白名單比對。
- 不做執行階段切換的 slash command (`/skills` 之類);白名單僅啟動時生效。
- 不修改前端 UI。

## 驗證計畫

1. `make` build 通過。
2. `pi-webui --help` 列出新參數。
3. 於 `/Users/tung/Codes/readyaiJobs/nine9.jic-tools.com.tw` 啟動帶 `--model` 與 `--skill-allow` 的 pi-webui。
4. 用 Chrome MCP 開啟 webui,確認:
   - `connected` 後預設模型反映 `--model`
   - skill diagnostics 無錯誤,白名單外的技能不被注入 prompt
5. 不傳白名單時技能全部載入。
