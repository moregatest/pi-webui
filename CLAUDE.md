# CLAUDE.md

pi.dev 的獨立 webui。可以單獨啟動 (`readyai-webui`) 也可以當 pi extension(在 pi 內以 `/webui` 控制或 `pi --webui` 自動啟動)。

## 官方文件優先

當涉及 pi SDK / extension / slash command / resource loader / skills / model registry / runtime / session 任何 API 行為時,**優先參考官方文件**:

- 文件根目錄:<https://pi.dev/docs/latest>
- Extension 相關:<https://pi.dev/docs/latest/extensions>
- 用 WebFetch 抓對應頁;若文件未覆蓋,再讀 `node_modules/@earendil-works/pi-coding-agent/dist/` 對應的編譯後 source

順序是 **官方文件 → SDK dist 原始碼 → 本專案既有用法**。不要憑印象寫 API call 名稱、參數順序或行為,先查再寫,把幻覺降到最低。

## 開發指令

```
make            # = npm install + npm run build (tsc)
make start      # 啟動 server (預設 127.0.0.1:4096)
make test       # build 後跑 node:test (test/*.test.mjs)
make lint       # tsc --noEmit + node --check public/test 的 .mjs
make precommit  # lint + test,送 commit 前跑一次
make vendor     # 重抓 public/vendor/(marked、highlight.js)
make clean      # rm -rf dist build
```

build 唯一產出在 `dist/`。pack/publish 用 `make pack` / `make publish`。

## 程式碼分層

```
src/extension/index.ts   pi extension 進入點:註冊 /webui、--webui flag、轉發 server flags
src/server/              http + ws server,host pi sdk runtime
  index.ts               主要 dispatcher;@ts-nocheck(歷史遺留,不要新加)
  event-log.ts           cross-WS replay 用的 ring buffer
  ext-ui.ts              pi ExtensionUIContext 橋接(notify/select/confirm/input/custom)
  watch.ts               session 檔案外部變更偵測
  log.ts                 結構化 logger
public/                  瀏覽器端,vanilla JS,**無 build step**
  app.js                 主腳本(單檔大塊邏輯)
  *.mjs                  小型 ES module(chat-state、route-input、render-* 等)
  vendor/                marked + highlight.js,由 `make vendor` 抓取
  index.html / styles.css
test/                    node:test;client 模組各自 .test.mjs;server 也有對應 .test.mjs
docs/superpowers/specs/  brainstorming 產出的設計文件
```

server `src/server/index.ts` 主要用 `@earendil-works/pi-coding-agent` 的:
- `createAgentSessionServices({ cwd, agentDir, resourceLoaderOptions })`
- `createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager })`
- `createAgentSessionFromServices(services, { ... })`
- `SessionManager` / `getAgentDir`
- 直接從 dist 載入未在 exports 暴露的 `BUILTIN_SLASH_COMMANDS`(import.meta.resolve + 動態 file URL 繞 exports)

client 透過單一 WebSocket 與 server 來回,packet 型別在 server `sendJson` 與 `app.js` 的 dispatcher 對應。

## 慣例

- 程式碼註解預設用繁體中文(看現有檔案);commit message 也用繁體中文
- public 下不要引入打包工具,新增模組就加 `.mjs` 並用 `<script type="module">` 或 `import`
- 新增 server 模組:`src/server/<name>.ts` 並在編譯後以 `./<name>.js` import(`moduleResolution: "Bundler"` 允許 `.js` 指向 .ts 來源)
- TypeScript 設定刻意寬鬆(`strict: false`、`noImplicitAny: false`);新模組可以開始寫好型別,但別硬把 `src/server/index.ts` 改 strict — 它頂著 `@ts-nocheck`
- 測試:`test/<name>.test.mjs` + `node --test`,別引入 Jest/Vitest
- CLI flag 與 env var 同時支援時,CLI 優先;新加旗標時 server 與 extension 兩邊都要 forward(extension 透過 `--webui-<flag>` 對應到 server `--<flag>`)
- 加新功能優先改 `README.md` 的旗標表與 `ROADMAP.md` 的 done 區塊

## 重要實作點

- skill 白名單:CLI > env > 自動偵測 `<cwd>/.pi/skills-allow.txt`(`resolveSkillAllowFile`)
- slash 選單來源:builtin + WEBUI_SLASH_COMMANDS + prompt templates + extension commands + skills(以 `skill:<name>` 形式)
- `/skill:<name> args` 由 server 直接丟給 `session.prompt()`,由 pi 內建 `_expandSkillCommand` 展開
- `/webui start` 在 extension 端做了 shell-like tokenize + flag parse,把同樣的 server 旗標 inline forward 給 spawn 的 server

## 對外場景必須隱藏 model 名稱

**只要該場景會被「非開發人員」看到(內部員工、客戶、demo、截圖、GIF、外發影片),都必須隱藏 model 名稱。**

模型選擇是商業資訊,洩漏會影響成本結構與供應商談判,內部員工跟客戶都一視同仁。

實作方式(三選一,profile / CLI / env 任一個 truthy 就生效):

- profile toml `[ui] hide_model = true`
- CLI `--hide-model`
- env `PI_WEBUI_HIDE_MODEL=1`

**內建 customer fallback 已預設 `hide_model = true`**;新寫的 staff / brand / demo / 任何客製 profile,只要會被外人看到,toml 必須含 `hide_model = true`。

**寫 doc / 錄 screencast / 截圖前先檢查**:status bar 右下角不可出現 `openrouter/...`、`anthropic/...` 之類字串。若已錄製含 model 的 GIF,必須重錄不可上版。

## 測試 pi 對 Claude Code skill 的相容性

升級 pi-coding-agent dist / 換 model / 改 server runtime / 反饋說「pi 跟 Claude Code 跑同一 skill 不一樣」,**必須**跑這套 regression。

完整流程、prerequisites、對照表格式、已知退化點(Chrome MCP、`pi --print` 互動)都寫在 `.claude/skills/pi-skill-compat-test/SKILL.md`。讀那份 skill 再開跑,不要憑印象重新發明流程。

歷史驗證紀錄存在 `docs/superpowers/specs/<date>-pi-skill-compat-validation*.md`。

## 不要

- 不要把 server `index.ts` 拆成 strict TS,或移除 `@ts-nocheck` — pi SDK 對 type 很寬鬆,會拖累節奏
- 不要在 `public/` 引入打包步驟或 TS 編譯
- 不要在 README/ROADMAP 之外另開新 doc 紀錄已實作功能;設計階段才寫進 `docs/superpowers/specs/`
