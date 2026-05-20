# pi-webui — slash command 白名單

日期 2026-05-20
狀態 approved (由 session goal 授權)

## 動機

pi-webui 目前會把 builtin、webui、prompt template、extension、skill 五種來源的 slash command 全部塞進選單(現場實測 85 項)。對面向後勤 / 客戶的部署來說,這份清單太大且部分指令具安全風險(例如 `/cwd` 可換工作目錄)。需要一個沿用 `skills-allow.txt` 設計風格的白名單機制,讓部署者一份檔案決定可見可執行的 slash command。

`skill:<name>` 條目仍由既有 `.pi/skills-allow.txt` 管;新機制只負責「白名單之外的指令在選單與執行端都看不到、跑不了」。

## CLI 介面

| 旗標 | 對應環境變數 | 說明 |
| --- | --- | --- |
| `--command-allow <names>` | `PI_WEBUI_COMMAND_ALLOW` | 逗號分隔的指令白名單。比對對象是 `collectSlashCommands()` 算出的 `name`(例如 `new`、`cwd`、`skill:brainstorming`)。 |
| `--command-allow-file <path>` | `PI_WEBUI_COMMAND_ALLOW_FILE` | 一行一個指令名稱的白名單檔。`#` 開頭與行末視為註解,空行忽略。**檔案不存在 → 視同未設定(全部允許)**。 |

自動偵測:CLI 與 env 皆未指定 `--command-allow-file` 時,若 `<cwd>/.pi/commands-allow.txt` 存在則自動採用。

優先順序:`--command-allow` > `PI_WEBUI_COMMAND_ALLOW` > `--command-allow-file` > `PI_WEBUI_COMMAND_ALLOW_FILE` > 自動偵測 `.pi/commands-allow.txt` > 無(全部允許)。

`pi-webui --help` 與 README 對應更新。

## 檔案格式

```
# .pi/commands-allow.txt
# 一行一個指令名稱,不要加 `/` 前綴
# `#` 之後到行尾是註解

new
quit
help
hotkeys
skill:brainstorming
```

預設行為:

- 完全沒設(`null`):全部允許,等同現況。
- 設定後條目為空陣列(空檔、全註解、CLI 給空白):全部拒絕,選單空、所有 `/cmd` 一律回 disabled 錯誤。
- 設定後條目非空:僅這些名稱可見可執行。

## 實作要點

### `src/server/index.ts`

1. `parseArgs` 擴充
   - `--command-allow` / `--command-allow=`
   - `--command-allow-file` / `--command-allow-file=`

2. 環境變數 fallback,沿用 `PI_WEBUI_SKILL_ALLOW*` 模式。

3. 新增解析函式(對稱 `resolveSkillAllowFile` / `readSkillAllowFile` / `computeSkillAllow`):
   - `resolveCommandAllowFile(cliValue, envValue, cwd)`:回傳最終要讀的路徑;缺檔自動偵測 `<cwd>/.pi/commands-allow.txt`。
   - `readCommandAllowFile(path)`:讀檔、剝註解、trim、過濾空行,回傳 `string[]`;路徑空字串或檔不存在回傳 `null`。
   - `computeCommandAllow(cliValue, filePath)`:CLI 字串有值 → split;否則 → 讀檔。

4. 模組層級算出
   - `effectiveCommandAllowFile: string`
   - `cliCommandAllow: string[] | null`
   - `cliCommandAllowSet: Set<string> | null`(`null` = 全部允許)

5. **閘門 1**(`NativePiSessionController.collectSlashCommands()`):彙整完五種來源後,最末端統一過濾。

   ```js
   if (!cliCommandAllowSet) return commands;
   return commands.filter((c) => cliCommandAllowSet.has(c.name));
   ```

6. **閘門 2**(`handle(payload)` 的 `case "slash_command":`):查 handler 之前先比對白名單。

   ```js
   if (cliCommandAllowSet && !cliCommandAllowSet.has(name)) {
     sendJson(this.ws, {
       type: "command_result",
       payload: {
         command: `slash:${name}`,
         ok: false,
         error: `/${name} is disabled by the command whitelist`,
       },
     });
     return;
   }
   ```

   `cliCommandAllowSet` 為 `null`(未設定白名單)時短路跳過,維持現況。命中拒絕時直接 return,後續 `SLASH_HANDLERS` / extension / template / skill / unsupported 全部不會跑到。

7. 啟動 log 多一行
   ```
   logger.info("commands allowlist", {
     count: cliCommandAllow?.length ?? null,
     whitelist: cliCommandAllow ?? null,
     whitelistSource: effectiveCommandAllowFile || null,
   });
   ```

8. `printHelp()` 補上新參數說明與 env var 段落。

### `src/extension/index.ts`

- `StartOptions` 加 `commandAllow?: string`、`commandAllowFile?: string`。
- 註冊 pi flags:`webui-command-allow`、`webui-command-allow-file`(均字串)。
- `runStart` 把對應參數推進 `serverArgs`(`--command-allow`、`--command-allow-file`)。
- `parseStartFlags` 加四個分支,沿 `--skill-allow*` 寫法處理 `--command-allow[=]` 與 `--command-allow-file[=]`。
- `setImmediate` 區塊讀兩個 flag,加入 `want` 條件(隱含 `--webui`),帶進 `runStart`。
- **自動偵測不在 extension 重做** — server 啟動時會自然 fallback 到 `<cwd>/.pi/commands-allow.txt`,避免兩端各自實作不一致。

## 錯誤處理

- `--command-allow-file` 路徑存在但讀取失敗 → 與 skill-allow 一樣由 `readFileSync` 直接拋,啟動失敗。屬於部署設定錯誤,fail-fast 比靜默 fallback 安全。
- 條目命名打錯(例如 `News` 而非 `new`)→ 不會被任何來源命中,等同未列入,該指令完全消失。啟動 log 的 `whitelist` 欄位讓部署者人工核對。
- `slash_command` 命中閘門 2 時,client 收到一致格式的 error,既有 toast 流可直接渲染。

## YAGNI 排除

- 不支援萬用字元 / 群組前綴(例如 `extension:*`)— 沿用 skills-allow 風格,純名單。
- 不提供 deny list 模式 — 後勤 / 客戶場景白名單通常很短,allow 已足夠。
- 不在 UI 端再做過濾 — server push 出去的 `slashCommands` 已經是過濾後結果,client 無需感知。
- 不對既有 `.pi/skills-allow.txt` 動手 — skill 仍由 ResourceLoader 階段過濾,語意分層。

## 驗證計畫

1. `make` build 通過。
2. `make test` 通過,新增 `test/server-command-allow.test.mjs` 涵蓋:
   - `computeCommandAllow`:CLI 字串、逗號 / 空白分隔、空字串 → 走檔案。
   - `readCommandAllowFile`:檔不存在 → `null`;檔存在但空 → `[]`;註解 + 空行過濾;行末註解。
   - `resolveCommandAllowFile`:CLI > env > 自動偵測 `<cwd>/.pi/commands-allow.txt` > 空字串。
3. `pi-webui --help` 顯示新參數。
4. 啟動帶 `--command-allow new,quit,help` 的 pi-webui:
   - WS `connected` 訊息的 `slashCommands` 只剩三項。
   - 打 `/cwd` 拿到 `disabled by the command whitelist`。
   - 打 `/new` 正常運作。
5. 在 `.pi/commands-allow.txt` 放白名單檔(不帶任何 CLI flag)再啟動,效果同上。
6. README + ROADMAP 對應更新。
