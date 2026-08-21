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

```
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
[x] issue #9:customer profile 由 process 內單一 shared controller/runtime 掌管 active session，跨瀏覽器忽略舊 localStorage、共用 event replay 與 turn queue；staff/developer 保留 per-browser resume
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
