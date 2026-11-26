# ROADMAP

## backlog

```
[ ] tree navigation for branches within a session
[ ] tools panel with enable/disable toggles
[ ] prompt/template and skill launcher
[ ] richer rendering for thinking and tool calls
[ ] multi-user runtime isolation
```

## done

- [x] W60-01 信任上游身分與回到專案清單:`PI_WEBUI_TRUST_UPSTREAM_HEADER=<標頭名>` 以閘道送來的標頭當登入身分、略過密碼(只限綁定 127.0.0.1／::1,與 tunnel、密碼互斥,啟動時檢查;缺標頭或重複一律 401,不退回密碼頁;WebSocket 同規則;登入／登出 API 回 400;`/login` 轉回 next)。`PI_WEBUI_HOME_URL` 設定時顯示「回到專案清單」連結。主要控制項補 aria-label。修訂（RV60-01）：每實例閘道密鑰（`PI_WEBUI_TRUST_UPSTREAM_SECRET_FILE`＋`X-ReadyAI-Gateway-Secret`，讀一次即刪、不進環境、常數時間比對）與 Origin 檢查（`PI_WEBUI_TRUSTED_ORIGIN`，WS 與非 GET，不符 403）。測試 `test/upstream-identity.test.mjs`、`test/server-upstream-identity.test.mjs`、`test/home-link.test.mjs`。
- [x] W32-02 對話延續直達參數:`?session=<id>` 在本頁第一次連線時續接該段對話(伺服器只在目前 session 目錄找 `<時間>_<id>.jsonl`／`<id>.jsonl`,id 嚴格驗證不含「.」與分隔字元、只收一般檔、標頭 id 必須相符,之後仍走既有續接防線);不合法或找不到時跳警告、行為不變;customer 模式與 `--ws-deny switch_session` 時忽略。反向代理路徑前綴 `/c/<instance_id>/` 下 HTTP、WebSocket、上傳、登入 cookie 端到端驗證。測試 `test/session-param*.test.mjs`。
- [x] W18-01 鑲嵌模式與連線保活:`?embed=1` 精簡版面(含登入頁,server 首屏寫 `data-embed`)、`GET /api/session`、與父頁 postMessage(`readyai:ready`／`auth`／`turn-start`／`turn-end`／`content-changed`)、頁面感知(契約第 9 點:`page_view` 依對話保存最近 10 頁、目前頁面記在每條連線、每則訊息附「頁面資訊」區塊並寫進對話紀錄、`current_page` 工具、客戶系統提示)、WebSocket 每 25 秒 ping、斷線橫幅延遲約 5 秒。全螢幕版外觀與基準版像素一致。測試 `test/embed-*.test.mjs`。
- [x] W21-01 鑲嵌模式對話裡的站內連結在原頁開啟(契約第 11 點):同源、非 `/agent`／`/agent-embed`／`/_review`、非下載、無修飾鍵的左鍵點擊改送 `readyai:navigate` 給父頁;其餘照舊開新分頁。測試 `test/embed-client.test.mjs`。
- [x] W14-01 審查修正:(F1)點開場建議句一律送成對話,先退出命令模式、送出時強制路由為對話;有草稿或附件時只接在草稿後面、不送出(`public/composer-input.mjs`)。(F5)keydown 與 beforeinput 共用同一份狀態(slash 選單、組字、組字剛結束的 229、本次按鍵已處理、修飾鍵),手機換行在選單開啟時先完成選項,同次按鍵只送一次。(F4)步驟標籤保守原則:只有能證明是單純讀取的單一指令才標「查看資料」;複合指令、命令替換、解析不了的 heredoc、`date -s` 等改狀態參數不標查看,任一段寫入即「修改內容」(`scanShell`)。(F3/F8)`PI_WEBUI_PROFILE_DEFAULTS_DIR` 唯讀預設 profile 目錄:工作區自訂優先,再找預設目錄(一般檔、不跟隨符號連結),再用內建 fallback。
- [x] 客戶閱讀版面與 Enter 送出:`[ui].reading_layout = "comfortable"`(置中閱讀欄約 72ch、無襯線 16px、行高 1.7、灰字對比 ≥ AA、開場引導與登入頁放大;server 在 `<html>` 首屏寫 `data-reading`);`[ui].enter_sends`(Enter 送出、Shift+Enter 換行;`isComposing`／keyCode 229／composition 旗標組字中不送出;手機鍵盤拿不到 keydown 時改由 `beforeinput` 換行事件判斷,`enterkeyhint="send"`;執行中 Enter 不會變成停止);`[welcome].input_placeholder`。沒設時行為不變。測試 `test/reading-enter.test.mjs`。
- [x] 開場引導:profile `[welcome]`(`title`／`body`／`starters`)在還沒有對話時顯示說明與可點選的建議句,點了等於送出該句;有對話後消失。文案不寫死在 pi-webui,純文字輸出、有長度上限;沒設時畫面不變。登入頁文字由 profile `[login]`(`hint`／`password_placeholder`／`button`／`error`)提供,注入時 `<` 轉 `\u003c`。客戶步驟標籤修正:`publish_confirmed` 的 `check_only` 與 `publication_status` 標成「查看發布狀態」、heredoc 內文的 `>` 不再誤判成改檔、`echo`/`printenv`/`pwd` 等歸「查看資料」、開頭 `cd <dir> &&` 依後段指令分類。測試 `test/welcome.test.mjs`、`test/step-labels.test.mjs`、`test/server-profile.test.mjs`。
- [x] 補齊工具結果白名單、舊進度標籤與重試錯誤遮蔽；撤銷過期續跑、錯誤重試保持進度、自訂標籤歷史一致，依最後助理訊息判定最終答案。

- [x] 前端回合步驟區、思考心跳、異常提示與請繼續、續跑累計及歷史重建；工具與思考原文預設收合。

- [x] 回合進度與主線自動更正、預覽截斷擴充共存；一次續跑額度與同回合收合測試。
- [x] 伺服器回合進度封包、安全步驟摘要、截斷單次自動續跑、歷史重建與事件出口遮蔽。

```
[x] 啟用 `--sandbox` 時 WS `bash` 訊息改在 Gondolin VM 內執行（沙盒初始化失敗則拒絕，不退回宿主 shell）
[x] `--ws-deny` / `PI_WEBUI_WS_DENY` / `--webui-ws-deny`：非 customer 模式也能停用指定的 WS 訊息型別（未知型別中止啟動）
[x] customer publish_confirmed uses one PGC publication session with durable confirmation/candidate mapping, status-before-resume, classified JSON errors and honest triggered/content_verified=false evidence; CLI owns drift/audit/baseline (Issue 144 companion required)
[x] publish_confirmed 依 source-version v2 只發布有變動的主語系（預覽站 `db_<lng>` sha256 對 baseline `sources.<lng>`；舊 meta 退回 `[source_lng]`；都沒變回 `no_changes`；`check_only` 先列出將發布語系供客戶確認）
[x] publish_confirmed `check_only` 回傳各語系逐表記錄數（新增／修改／刪除）摘要 `changes`，來源為 readyAI 唯讀 `preview publication summary`；只含表名與計數，讀不到時 `changes_available=false` 照舊列語系（readyai#160）
[x] publish_confirmed triggered 後以 detached runner 背景執行 `preview publication accept`（結果／log／鎖檔 0600，同一 publication 不重複啟動，runner 死掉且無結果時由 `publication_status` 補跑）；新工具 `publication_status` 讀 CLI status＋accept 結果，回 C3 客戶用語（readyai#162）
[x] continue most recent pi session on startup
[x] list sessions in the current project
[x] sessions default to project-local `<cwd>/.pi/sessions/` (`--session-dir` / `PI_SESSION_DIR` override; legacy cross-project picker removed)
[x] switch between persisted sessions
[x] start new sessions
[x] rename sessions
[x] live streaming of assistant output over websocket
[x] tool execution event display
[x] tool result rendering
[x] markdown rendering (marked)
[x] syntax highlighting (highlight.js)
[x] scroll-follow behavior
[x] cycle models
[x] model picker (and scoped-models picker)
[x] `/export` to jsonl or html
[x] `/import` from jsonl
[x] auth storage management (api keys per provider)
[x] branch summary rendering in session view
[x] built-in slash command surfacing
[x] `--listen <host:port>` cli flag
[x] ipv6 bind support
[x] `HOST` / `PORT` env vars
[x] `PI_PROJECT_CWD` / `PI_AGENT_DIR` / `PI_SESSION_DIR` overrides (plus `--session-dir` CLI flag)
[x] session file watching for external changes
[x] event log for replay and debugging
[x] static asset vendoring via `make vendor`
[x] private fork renamed to `@moregatest/readyai-webui` (decoupled from upstream `@khimaros/pi-webui` update stream) with `readyai-webui` bin
[x] `make pack` and `make publish` targets
[x] suppress slash popup when navigating input history
[x] extension UI bridge — `ExtensionUIContext` notify/select/confirm/input rendered as webui modals (proof of concept; custom/widget/header/footer no-op)
[x] extension UI bridge — `ui.custom()` proxied as ANSI-streamed pi-tui Component overlay with browser key forwarding (covers guardrails path-access + permission-gate)
[x] `--help` / `-h` cli flag with usage output
[x] `/cwd` slash command + picker modal to switch the working directory at runtime
[x] shrink viewport on mobile when virtual keyboard opens (visualViewport)
[x] paste or drag/drop images into the composer as attachments
[x] `--model <provider/id>` cli flag for default model selection
[x] Pi 0.83 runtime migration + OpenRouter `deepseek/deepseek-v4-pro` model selector; Node 22.19+ baseline
[x] project trust fail-closed:unknown repo 的 `.pi` / `.agents` 可執行資源預設不載入，`--approve` / `--no-approve`（含 extension forward）只對本次執行表態
[x] npm supply-chain baseline:dependencies 固定精確版本、lockfile integrity、預設 `ignore-scripts`、Makefile 改用 `npm ci --ignore-scripts`
[x] `--skill <path>` cli flag for additional skill sources (repeatable)
[x] `--skill-allow` / `--skill-allow-file` cli flags for skill whitelist
[x] `--hide-model` cli flag to hide the model name in the status bar
[x] auto-detect `<cwd>/.pi/skills-allow.txt` when no skill whitelist is given
[x] surface loaded skills as `/skill:<name>` slash commands in the webui
[x] `/webui start <flags>` forwards server flags inline from the pi extension
[x] `--command-allow` / `--command-allow-file` slash command whitelist with auto-detect of `<cwd>/.pi/commands-allow.txt`
[x] `--password` / `PI_WEBUI_PASSWORD` 啟用 cookie 登入認證
[x] `--trust-proxy` / `PI_WEBUI_TRUST_PROXY` 控制 cookie `Secure` flag
[x] 啟動 port 被佔用時自動 +1 找下一個可用 port (上限 50)
[x] `--sandbox` / `--sandbox-workspace` 把 read/write/edit/bash 路由到 Gondolin micro-VM
[x] `--tunnel` / `PI_WEBUI_TUNNEL` 啟動 cloudflared quick tunnel(trycloudflare.com)
[x] `--ui-profile customer` + `--brand-name` / `--brand-color` / `--brand-logo` + `--safe-errors` + 個別 hide-* 旗標(客戶導向 UI:thinking / tool 細節 / status chip / session picker / model 名稱可獨立隱藏;tool 細節隱藏後可用 `--show-tool-progress` 換 user-friendly 標籤;`--safe-errors` 把 server_error 包成 generic 訊息 + ticket 對應 log)
[x] `.pi/profiles/<name>.toml` 接口模板系統(brand tokens 全套 + css overlay + tool 標籤三階段 + placeholder 白名單;`--profile <name>` 啟動;個別 CLI flag 仍可 override)
[x] `--sandbox-image <ref>` + `--sandbox-env KEY=VAL` 與 profile `[sandbox]` 區塊:gondolin image selector 與 VM-wide env 注入(readyai-sandbox image 整合);extension forward `--webui-sandbox-image`
[x] 一般檔案上傳:composer 加 + 附件按鈕,支援 paste / drag-drop / 檔案選取。圖片(png/jpeg/gif/webp)走 ImageContent 走 in-band base64 讓 LLM 直接看,**同時**再落地一份取得 attachPath(否則吃檔案路徑的工具無從執行);其他副檔名(預設 jpg/jpeg/png/gif/webp/svg/pdf/rar/zip/flv/txt/doc/docx/xls/xlsx/dwg,可由 `[uploads].allowed_extensions` / `--upload-ext` / `--upload-ext-add` 擴充)走 `PUT /api/upload` 寫入 `<cwd>/uploads/<subdir>/`(sandbox 啟用時對應 VM 內 `/workspace/uploads/<subdir>/`),檔名加 timestamp 後綴防覆蓋。預設單檔 50 MiB、單一 prompt 20 個附件,可由 `--upload-max-bytes` / `--upload-max-files` 調。subdir 預設取 `--profile` 名,可獨立由 `--upload-subdir` 覆寫。extension forward `--webui-upload-*`
[x] issue #2:失敗 turn(`stopReason=error` / 金鑰失效)改渲染紅色錯誤條顯示 `errorMessage`(reload 與即時兩條路徑),不再留白塊;渲染後無可見內容的 assistant 不掛裸 header(customer 模式 thinking/tool 摺疊後的空殼);模型在 registry 找不到時 `connected` 帶 `modelWarning`、UI 明確報錯(`hideModel` 下不洩漏 model 名);`/artifacts/` 命中不存在的 404 帶引導 hint 指向 `PI_WEBUI_ARTIFACTS_DIR`;customer-open 未設 skill 白名單時啟動印警告
[x] agent secret isolation(spec 2026-07-01):L0 bash env allowlist(host + sandbox per-exec 兩條路徑共用 spawnHook,`PI_WEBUI_BASH_ENV_ALLOW` 可加非機密 key,sandbox 注入 `READYAI_SANDBOX_MODE=1`);L1 `read` workspace realpath 圍欄(擋 `/proc/*/environ` 與 workspace 外主機機密);L2 `customer` profile 強制 effective Gondolin(eager boot + fail-closed,`--allow-unsafe-customer` / `PI_WEBUI_ALLOW_UNSAFE_CUSTOMER` 才繞過);L3 L-甲機密值遮蔽(tool `execute()` 源頭遮送 model + `filterEvent` 遮送 client/streaming);`resolveCustomerInjection` 修正:強制 sandbox 下 customer 仍僅 `upload_image`。無 effective sandbox 時(如 Fly Firecracker 無 nested `/dev/kvm`,Gondolin 只能 TCG 不可用)以 `--allow-unsafe-customer` 繞過 L2,`shouldInjectHostGuards` 讓 customer-open 仍套 in-process L0+L1+L3(guarded host read/bash),配單租戶邊界。新模組 `src/server/secret-guard.ts` + `guarded-tools.ts` + `test/secret-guard*.test.mjs`(含真 VM `secret-guard-sandbox-vm`) / `ui-profile-redact` / `customer-sandbox-gate`。實地驗收:本機 webui(我的碼)對真 kyangyhe-preview 後端跑 customer 技能 B2/B3/B4 round-trip 通過;Fly `/dev/kvm` 實測不存在(issue #4)
[x] 前端顯示調整(spec `docs/superpowers/specs/2026-07-15-frontend-display-audit.md`):(1) **§四-1 WS delta 洩漏過濾(資安)**:`filterEvent` 的 `message_update` 補濾 `assistantMessageEvent` —— `hideThinking` 時 `thinking_*` delta / `hideToolCalls` 時 `toolcall_*` delta 整個 drop;保留的 `text_*`/`done`/`error` 事件其 `partial`/`message`/`error`(累積的完整 `AssistantMessage`,會挾帶前段 thinking 全文 + toolCall 參數)一併剝除;`content` 非 array 也 fail-closed(reviewer P1-3)。順帶消除 thinking 階段 typing 空窗(client 收不到被 drop 的 delta → `showTyping` 保持)。(2) **favicon/title/login 品牌化**:`[brand].favicon` / `--brand-favicon` / `PI_WEBUI_BRAND_FAVICON` 取代內建 π favicon;`serveStatic` 注入 `<title>=brand.name`(消首屏閃字)+ `__BRAND_NAME__` 給 login h1;login 按鈕吃 `--accent`。(3) **bubble 對話版型**:`[ui].chat_layout = "bubble"|"log"` / `--chat-layout` / `PI_WEBUI_CHAT_LAYOUT`(customer fallback=bubble);user 右氣泡 / assistant 左純文字 / h3 視覺隱藏(`.visually-hidden`)+ section `aria-label` 保 a11y;§四-2 空殼 assistant 不掛裸 header/空 bubble。(4) **`GET /version` 部署版本探針**:build 時埋 commit SHA + dirty(`scripts/gen-build-info.mjs`)。新測試 `test/ui-profile.test.mjs`(delta 過濾 + partial 剝除 + fail-closed 10 例)/ `profile-loader.test.mjs`(favicon + chat_layout 驗證);extension forward `--webui-brand-favicon` / `--webui-chat-layout`
```
