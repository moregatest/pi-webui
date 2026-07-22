# Changelog

本檔記錄重要變更。實作細節以對應 commit 為準。

## 2026-07-22 (customer custom 訊息出口)

### 新增

- customer 模式 custom(extension `pi.sendMessage` 注入)訊息出口 fail-closed(readyai#102):
  僅 `readyai_customer_` 前綴 customType 放行,並轉成 assistant 訊息(客戶介面渲染為一般
  助理泡泡,不露 `Custom: <type>` 內部標頭);其餘(如 `readyai_bootstrap_notice` 內部工程
  訊息)整則 drop——message_history 與 live event(message_* / agent_end 挾帶快照)兩路皆過濾
- profile toml `[ui] restrict_custom_messages`;customer preset 與內建 customer fallback 預設
  開啟;customer 模式由 server 強制(`enforceCustomerUiProfile`),不依賴存量機舊版 customer.toml

## 2026-05-29 (uploads)

### 新增

- 一般檔案上傳:composer 加 + 附件按鈕,支援 paste / drag-drop / 檔案選取
- 圖片(png/jpeg/gif/webp)維持 in-band base64 走 `ImageContent`,讓 LLM 直接看見
- 其他副檔名透過 `PUT /api/upload?name=<filename>` 寫到 `<cwd>/uploads/<subdir>/<檔名-時間戳>`,sandbox 啟用時 LLM 看到 `/workspace/uploads/<subdir>/...`;檔名加 timestamp 後綴防覆蓋
- prompt handler 自動 append `[Attached files]` 區塊把附件路徑帶進 message,LLM 用 Read/Bash 工具自取
- 預設副檔名白名單 15 個:jpg, jpeg, png, gif, svg, pdf, rar, zip, flv, txt, doc, docx, xls, xlsx, dwg
- profile toml `[uploads]`:`allowed_extensions` / `extensions_add` / `subdir` / `max_bytes` / `max_files`
- CLI / env 三條入口:
  - `--upload-ext <list>` / `PI_WEBUI_UPLOAD_EXT`(取代預設)
  - `--upload-ext-add <list>` / `PI_WEBUI_UPLOAD_EXT_ADD`(加增)
  - `--upload-subdir <name>` / `PI_WEBUI_UPLOAD_SUBDIR`(子目錄;預設取 `--profile` 名,沒設時為 `default`)
  - `--upload-max-bytes <n>` / `PI_WEBUI_UPLOAD_MAX_BYTES`(預設 50 MiB)
  - `--upload-max-files <n>` / `PI_WEBUI_UPLOAD_MAX_FILES`(預設 20)
- pi extension forward `--webui-upload-ext` / `--webui-upload-ext-add` / `--webui-upload-subdir` / `--webui-upload-max-bytes` / `--webui-upload-max-files`
- client 附件 chip 通用化:圖片走縮圖、非圖片走「副檔名 badge + 檔名 + ×」

### 改動

- composer 排版改 `auto 1fr auto` 三欄(attach / textarea / send)
- `.composer textarea` 加 `min-width: 0`、`.main` 加 `grid-template-columns: minmax(0, 1fr)`:防 textarea 與 log 內長 code block 撐爆 grid column,確保窄視窗(手機 390 / iPad portrait / 桌面 narrow window)send 按鈕不被推出 viewport
- composer 在 `@media (max-width: 480px)`:隱藏 `>` prompt 提示符、`padding-left` 縮到 0.5rem,把空間留給 attach 按鈕
- attachment chip 支援兩種型態:圖片用 56×56 縮圖、檔案用 `.attachment-chip.file` 帶 badge / 檔名 / 上傳中 / 失敗狀態
- `connected` packet payload 加 `uploads: { allowedExtensions, maxBytes, maxFiles, subdir }`,client 預先檢查副檔名 / 大小,並把白名單寫進 `<input type="file" accept>`
- Enter 行為全站一致:textarea 內 Enter 永遠斷行,送出唯一入口是 send 按鈕(跟 Slack / ChatGPT mobile 慣例一致)。slash menu 顯示時 Enter 跟 Tab 一致(填入 `/cmd ` + 關 menu),不送出
- Hotkeys modal 提示文案配合更新

### 測試

- `test/upload-config.test.mjs` 新增 19 個 case:預設清單 / profile-CLI-env 合併 / subdir fallback / 副檔名 normalize / 大小驗證 / extractExtension / buildStoredFilename / sanitizeFilename
- `test/profile-loader.test.mjs` 新增 5 個 case:`[uploads]` schema(全欄位、未知欄位、subdir 非法、max_bytes 非正整數)
- 整體 389 pass / 3 skip

### 文件

- README 加 5 個 `--upload-*` 旗標表 + 5 個 env var
- ROADMAP done 區塊加一筆
- `.gitignore` 加 `uploads/`

## 2026-05-28 (sandbox image profile)

### 新增

- `--sandbox-image <ref>` / `PI_WEBUI_SANDBOX_IMAGE`:指定 gondolin image selector(`name:tag` 或 buildId)。預設 `(gondolin builtin alpine-base:latest)`
- `--sandbox-env KEY=VAL`(repeatable):注入 VM-wide 預設 env,所有 `vm.exec` 都看得到
- profile toml `[sandbox] { image, env }` 區塊:supply chain 友善的宣告路徑,跟著專案 git 走
- pi extension forward `--webui-sandbox-image`(env 走 toml profile,避免字串切割)
- 對齊 readyai-sandbox image 0.1.0-3.23.0-bba981 接入後勤客戶情境

### 改動

- `SandboxOptions` 介面加 `image?` / `env?`,`defaultVmFactory` 把它們塞進 `VM.create({ sandbox: { imagePath }, env, vfs })`
- 啟動序列優先級:CLI > env > profile;env 為 merge,個別 key 由 CLI 蓋寫

- sandbox 啟用時自動 append 身份提示到 model system prompt:解決 LLM 把 `cwd=/workspace` 誤判 Fly.io / Docker 的認知障礙
  - 內建段:Gondolin micro-VM、path 對映、host 路徑不可用、`flyctl`/`~/.readyai/`/`~/.ssh/`/`~/.claude/` 不可用、host-only 工作流要繞道
  - profile toml `[sandbox] system_prompt = "..."` 可 append image-specific 額外提示(上限 16KB)

### 測試

- `test/sandbox.test.mjs` 加 2 個 case:`vmFactory` 拿到 image/env、預設 undefined
- `test/profile-loader.test.mjs` 加 10 個 case:`[sandbox]` schema(image/env + 5 種錯誤 + env-only + system_prompt 正向/錯型別/超 size)
- `test/sandbox-prompt.test.mjs` 新增 8 個 case:身份提示文字內容錨點(Gondolin / 非 Fly.io / path 對映 / image / extra)
- 整體 364 pass / 3 skip(opt-in 整合)

## 2026-05-26 (profile-system)

### 新增

- `--profile <name>` / `PI_WEBUI_PROFILE` / `--webui-profile <name>`(pi extension forward):讀 `.pi/profiles/<name>.toml` 載入完整接口模板
- `.pi/profiles/<name>.toml` schema:`[meta]` / `[ui]` / `[brand]` / `[skills]` / `[commands]` / `[defaults]` / `[tool_labels.<tool>]`
- `[brand]` 擴充:`mode`(dark/light)、`bg` / `panel` / `text` / `accent` / `border` / `muted` 6 個 design token、`css` overlay(最多 100KB)
- `tool_labels` 三階段(start/progress/end)+ placeholder 白名單(`{file_basename}` / `{url_host}` / `{progress_count}` / `{tool_arg.<key>}`)
- `expose_tool_args` 旗標:允不允許 `{tool_arg.*}` 帶入 args 內容(預設 false 防 leak)
- `GET /brand/theme.css` route:供 client 載入 css overlay

### 改動

- `parseUiProfile` 接 `profileFile` 第三參數,merge 順序:CLI > env > profile > 內建 fallback
- `tool_progress` packet `phase` 從 2 階段(start/end)擴成 3 階段(+ progress 預留)
- `connected` packet `brand` 結構加 `mode` / `tokens` / `css` 三欄
- `--ui-profile customer` 視為 `--profile customer` 的別名(向後相容)
- `public/styles.css` 修兩處寫死 hex 改 var
- `{file_basename}` 候選 args key 對齊 SDK 實際 schema(`file_path` / `path` / `file`)

### 測試

- `test/profile-loader.test.mjs`、`test/tool-label.test.mjs`、`test/brand-overlay.test.mjs` 新增
- `test/server-profile.test.mjs` 加 profile / brand css / tool_labels 整合 case
- 整體 341 pass / 3 skip

### 文件

- README `## customer profile` 改寫為 `## profiles` 完整章節(schema / placeholder / fail-fast / backward compat)
- ROADMAP done +1
- `docs/superpowers/specs/2026-05-22-customer-ui-profile-design.md` 標 superseded

## 2026-05-23 (customer-ui-profile fix)

### 修正

- `filterMessageHistory` / `filterEvent` 漏過濾 SDK 真實 shape 的 tool result:
  - SDK content block type 是 camelCase(`toolCall` / `toolResult`),原本只比對 snake_case → reload / external refresh 後 `Tool result: <name>` 區塊仍會出現
  - SDK 把 tool 結果 / bash 執行存成獨立 `role: "toolResult"` / `role: "bashExecution"` 的 top-level message,原本完全沒做 message-level filter
  - `filterMessageHistory` 改成兩層過濾:`hideToolCalls=true` 時 role 為 `toolResult` / `bashExecution` 整則 drop;content block 同時 match camelCase + snake_case
  - `filterEvent` 對 `message_update` 的 content filter 也同步加 camelCase
- 瀏覽器實測複現:`/tmp/pi-webui-test-customer/` spawn `--ui-profile customer` server → 送觸發 bash tool 的 prompt → reload → 確認 `.message.tool` DOM 完全消失

### 測試

- `test/ui-profile.test.mjs` 加 5 個 case(camelCase content / role-level drop / 只啟 hideThinking 不該動 toolResult / customer preset 混合 fixture)
- 共 299 tests / 296 pass / 3 skipped(原 294 + 5 新)

## 2026-05-22 (customer-ui-profile)

### 新增

- 客戶導向 UI profile:整套切片旗標 + `customer` preset + branding,把 webui 改造成可直接讓非工程客戶看的介面
- 個別切片旗標(都同時支援 CLI 與 env;CLI 優先):
  - `--hide-thinking` / `PI_WEBUI_HIDE_THINKING`:隱藏 thinking block
  - `--hide-tool-calls` / `PI_WEBUI_HIDE_TOOL_CALLS`:隱藏 tool_call / tool_result block
  - `--show-tool-progress` / `PI_WEBUI_SHOW_TOOL_PROGRESS`:hide-tool-calls 開啟時改顯示「正在讀取檔案…」spinner,避免客戶以為 AI 當機
  - `--hide-status-chips` / `PI_WEBUI_HIDE_STATUS_CHIPS`:藏 sandbox / tunnel / cwd / context / model 等 status chip
  - `--hide-session-picker` / `PI_WEBUI_HIDE_SESSION_PICKER`:session picker 完全禁用(`/resume` 之類觸發時顯示 toast)
  - `--safe-errors` / `PI_WEBUI_SAFE_ERRORS`:`server_error` 包成 generic 訊息 + 6-hex ticket,原訊息寫進 server log
  - 既有的 `--hide-model` 被歸進這組(改由 `parseUiProfile` 為 single source of truth)
- preset:`--ui-profile customer` / `PI_WEBUI_UI_PROFILE=customer` 一鍵展開上述 7 個 flag
- branding:
  - `--brand-name <text>` / `PI_WEBUI_BRAND_NAME`:注入 `<title>` 與 header
  - `--brand-color <#hex>` / `PI_WEBUI_BRAND_COLOR`:CSS `--brand-color` 變數(預設 anthropic orange);accent 色票統一改用 `var(--brand-color)`
  - `--brand-logo <path>` / `PI_WEBUI_BRAND_LOGO`:server 新增 `GET /brand/logo` route(svg / png / jpg / gif / webp,content-type 由副檔名判定);沒設時 302 → `/favicon.svg`;client 一律用 `<img src="/brand/logo">`
  - 啟動 fail-fast:`--brand-color` 不是合法 hex / `--brand-logo` 路徑不存在 / `--ui-profile` 不認得的 preset 名 都 exit 2 + stderr 提示
- server-side event filtering:
  - `src/server/ui-profile.ts` 的 `filterEvent` 三向分流:`null`(drop)/ `{kind: "event", event}` / `{kind: "tool_progress", payload}`
  - thinking / tool 細節隱藏發生在 server 出口,client devtools network 也看不到 raw bytes(不是只在 DOM 隱藏)
  - eventLog 仍存原始 event 替 replay 用;state machine 仍跑原始 event.type 維持原本行為
- pi extension 對應 forward 旗標:`--webui-hide-thinking` / `--webui-hide-tool-calls` / `--webui-show-tool-progress` / `--webui-hide-status-chips` / `--webui-hide-session-picker` / `--webui-safe-errors` / `--webui-ui-profile` / `--webui-brand-name` / `--webui-brand-color` / `--webui-brand-logo`
- `connected` packet 加 `uiProfile` 序列化欄位(7 boolean + brand 三欄);client 拿到後立刻套 branding + 各 render 函式以此為依據隱藏 status chip / session picker / model

### 改動

- `public/styles.css`:`:root` 加 `--brand-color`(預設 `#d97757`);`--accent` 改用 `var(--brand-color)`;`.main` grid `auto 1fr auto`(brand-header `display:none` 不佔位);新增 `.brand-header` / `.tool-progress-block` / `.spinner` 樣式
- `public/index.html`:`<main>` 內 log 之前加 `#brand-header` DOM(預設 hidden)
- `public/app.js`:新增 `applyBranding` / `handleToolProgress`;`renderSandboxChip` / `renderTunnelChip` / `renderStatusBar` 對 `hideStatusChips` early return;`showSessionPicker` 對 `hideSessionPicker` 顯示 toast 後 noop;`session_reset` 時清掉所有 `tool_progress` DOM

### 測試

- `test/ui-profile.test.mjs`:33 個 unit case,覆蓋 `parseUiProfile`(preset / env / CLI 優先順序 / 驗證 fail-fast)、`filterEvent`(三向分流 / message_update content 過濾)、`filterMessageHistory`、`safeError`(ticket 機率不重複 / 無 logger 也不崩)、`toolLabel` 映射
- `test/server-ui-profile.test.mjs`:9 個整合 case,spawn 真實 server 驗證 WS connected payload(全 false 預設 / customer preset / brand 三欄)、`GET /brand/logo`(有設 logo 200 + content-type / 沒設 302 → favicon / password 模式下白名單)、啟動 fail-fast(不存在 logo / 不合法 color / 未知 preset)
- 共 294 tests 全綠

### 文件

- `README.md`:`## configuration` 表加 10 個新 flag 與 env var;新增 `## customer profile` 段(preset 說明、典型部署範例)
- `ROADMAP.md`:`done` 加一行
- `docs/superpowers/specs/2026-05-22-customer-ui-profile-design.md`:設計文件(324 行,brainstorming 產出)

### 相關 commits

`2b390bc` → `edfc1fa` 區間(spec / tool-labels / ui-profile.ts / server 整合 / extension forward / client 套用 uiProfile / 整合測試)

## 2026-05-22 (sandbox-hardening)

### 改動

- `src/server/index.ts` 的 `handleReady`:sandbox 啟用時,若 client 嘗試切到不同 cwd 的 session,改成 fall through 用當前 session,不嘗試 switch
  - 解決 sandbox 把 workspace 鎖死後,client 透過 session 切換把 cwd 換到別的目錄,後續 `read` / `write` / `bash` 會踩到 workspace 邊界的問題
  - 與 sandbox 既有的「`/cwd` 鎖死」共用同一條原則:VM 內 cwd 只能是 launch 時 mount 的 workspace

### 相關 commits

`b9c7d45`

## 2026-05-22 (tunnel-hardening)

### 改動

- `--tunnel` 沒帶 `--sandbox` 從「印 warning」升級成「硬阻擋」:server 啟動直接 exit 2,提示同時需要 `--sandbox` 或 `--allow-unsafe-tunnel` 才能繞
  - 解決對外曝露時 AI 工具(`read` / `write` / `edit` / `bash`)有 full host access 的安全空窗
  - opt-out 用 `--allow-unsafe-tunnel` / `PI_WEBUI_ALLOW_UNSAFE_TUNNEL=1`;設了會印 warning 提醒風險
  - pi extension 端對應旗標:`--webui-allow-unsafe-tunnel`(forward 給 spawn 的 server)
- 多開 server 場景:`PI_AGENT_DIR` 指向「沒 `auth.json`、但預設 `~/.pi/agent` 有」時,印 hint 教使用者怎麼共用 credential
  - 解決「為了隔離 session 設了 fresh `PI_AGENT_DIR`,結果 AI 對接失敗找不到 API key」這個容易踩的坑

### 測試

- `test/server-tunnel.test.mjs` 新增 2 個 case:
  - `--tunnel` 沒 `--sandbox` 沒 `--allow-unsafe-tunnel` → exit 2 + stderr 有提示
  - `--tunnel` 沒 `--sandbox` + `PI_WEBUI_ALLOW_UNSAFE_TUNNEL=1` → 通過 + 印 warning
- 原 LAN warning test 加 `--allow-unsafe-tunnel` 通過新 gate,維持兩個 warning assertion

### 文件

- README `## tunnel` 段:`--sandbox` required 移到 security defaults 首條;新增「running multiple tunnels in parallel」最佳實踐段
- flags table 新增 `--allow-unsafe-tunnel`

## 2026-05-22 (tunnel)

### 新增

- `--tunnel` / `PI_WEBUI_TUNNEL=1` 啟用 cloudflared quick tunnel,自動把 server expose 到 `trycloudflare.com`
  - 由 `src/server/tunnel.ts` 的 `TunnelManager` 封裝 spawn / URL parse / lifecycle
  - 啟動鐵則寫死:`--no-autoupdate --config /dev/null --url <actualUrl>`,徹底繞 `~/.cloudflared/config.yml`
  - cloudflared binary 缺失 fail-fast,印 install 指引(brew / apt / cargo)
  - `--tunnel` 沒帶 `--password` 自動產生 32 字元 base64url 亂數,印 console + 寫 `<agentDir>/tunnel-password.txt`(mode 600)
  - `--tunnel` 自動 imply `--trust-proxy`,確保 cookie `Secure` flag 在 cloudflared edge 後正確
  - `--listen 0.0.0.0:*` / `!sandbox` 與 `--tunnel` 同開時印 stderr warning
  - cloudflared 中途 crash 不自動 restart;30 秒沒拿到 URL 標 error 並 SIGTERM child
  - SIGINT/SIGTERM 走 gracefulShutdown,先 stop tunnel(SIGTERM + 5s SIGKILL fallback)再 close sandbox
- `--tunnel-cloudflared <path>` / `PI_WEBUI_CLOUDFLARED` 自訂 cloudflared binary
- pi extension 端對應旗標:`--webui-tunnel`、`--webui-tunnel-cloudflared`(forward 給 spawn 的 server)
- WebUI status bar 新增 `tunnel` chip;starting=黃 / active=綠 / error=紅 / stopped=灰;active 時點擊複製 URL
- `connected` packet 增加 `tunnel: { enabled, phase, url?, error? }` 欄位;狀態變化透過新 packet `tunnel_state` broadcast

### 測試

- 單元測試 `test/tunnel.test.mjs`:TunnelManager 完整 lifecycle(stub spawn),涵蓋 args 鐵則、URL parse、30s timeout、child crash、stop SIGTERM、5s SIGKILL fallback、idempotent
- 整合測試 `test/server-tunnel.test.mjs`:spawn 真 server + fake cloudflared fixture,驗證 banner / connected payload / WS broadcast / 自動密碼寫檔 / mode 600 / fail-fast / warnings
- 端到端 `test/tunnel-real.test.mjs`(opt-in `TUNNEL_REAL=1`,`make test-tunnel`):spawn server `--tunnel`,等真 cloudflared 報 URL,curl edge `/login` 確認回 200

### 相關 commits

設計文件:`docs/superpowers/specs/2026-05-22-cloudflared-integration-design.md`(對應 `2026-05-21-cloudflared-integration-requirements.md` 事故彙整)

`ca92a84..e9aad17`(24 commits,涵蓋設計文件、實作計畫、TunnelManager 模組、server 串接、整合測試、extension forward、WebUI chip 與 README/ROADMAP/CHANGELOG 文件更新)

## 2026-05-21 (sandbox)

### 新增

- `--sandbox` / `PI_WEBUI_SANDBOX=1` 把 `read` / `write` / `edit` / `bash` 工具路由到 [Gondolin](https://github.com/earendil-works/gondolin) QEMU micro-VM
  - 由 `src/server/sandbox.ts` 封裝 lazy boot、host↔guest 路徑映射、`realpath` 邊界檢查、symlink 逃逸阻擋
  - 啟動時 fail-fast 檢查 `qemu-img` 與 `qemu-system-{aarch64|x86_64}`,缺哪一個直接報錯
  - Lazy boot:首次 tool call 才啟動 VM;並發 `ensure()` 透過 in-flight Promise dedup 確保只啟動一次
  - VM lifecycle 跟 server 一致;SIGINT/SIGTERM 走 graceful shutdown 關閉 QEMU
  - sandbox 啟用時 `/cwd` 鎖死,server 回 `lockReason: "sandbox"`(避免切到 VM 沒 mount 的目錄)
- `--sandbox-workspace <path>` / `PI_WEBUI_SANDBOX_WORKSPACE` 指定 host 端要 mount 成 `/workspace` 的目錄(預設為啟動 cwd)
- pi extension 端對應旗標:`--webui-sandbox`、`--webui-sandbox-workspace`(會 forward 給 spawn 的 server)
- WebUI status bar 新增 `sandbox` 標籤;hover 看 host workspace 路徑;init 失敗時切紅色並 toast 錯誤訊息
- `connected` packet 增加 `sandbox: { enabled, workspace, guestPath, error }` 欄位
- `make test-sandbox`:opt-in 真實 VM 整合測試(`SANDBOX_VM=1`),預設 `make test` 不依賴 QEMU

### 測試

- 單元測試 `test/sandbox.test.mjs`(22 case):workspace canonicalise、路徑映射、symlink 阻擋、ensure dedup、ensure 失敗重試、close 冪等、四種 ops factory 行為、bash env 轉換、AbortSignal 行為
- 整合測試 `test/sandbox-vm.test.mjs`(opt-in):真實 Gondolin VM 上跑 `ls`、bash exec、雙向檔案讀寫、workspace 邊界檢查

### 相關 commits

設計文件:`docs/superpowers/specs/2026-05-21-gondolin-sandbox-design.md`

## 2026-05-21

### 新增

- `--password <pw>` / `PI_WEBUI_PASSWORD` cookie 登入認證
  - `HttpOnly` + `SameSite=Lax`,7 天 TTL
  - Token 存記憶體,server 重啟自動失效
  - 比對使用 `crypto.timingSafeEqual` 防 timing attack
  - 所有非 `/login`、`/api/login`、`/api/logout`、`/favicon.svg` 請求未通過認證會 redirect 至 `/login`(瀏覽器)或回 401(API/WebSocket)
- `--trust-proxy` / `PI_WEBUI_TRUST_PROXY=1` 控制 cookie `Secure` flag
  - 啟用後讀取 `X-Forwarded-Proto`,當值為 `https` 才標 `Secure`
  - 解決 Cloudflare Tunnel / nginx 等反向代理場景下 cookie 標記的正確性
- 啟動 port 被佔用時自動 +1 找下一個可用 port,上限 50 次(`port..port+49`),實際 port 印在 listening log
- pi extension 端對應旗標:`--webui-password`、`--webui-trust-proxy`
- 獨立登入頁面 `public/login.html`(POST `/api/login` 後 redirect 回原本 next URL)

### 改動

- WebSocket upgrade 改 `noServer: true` + 手動 cookie gate,未認證請求回 401(含 `Content-Length: 0` + `Connection: close`)
- HTTP server handler 改 async + try/catch + 500 fallback
- 啟動 log 加 `auth` 與 `trustProxy` 欄位

### 測試

- 單元測試
  - `src/server/listen.ts`(port fallback、relayEmitter 分支)
  - `src/server/auth.ts`(密碼比對、token 儲存、cookie 解析、Secure 判定)
- 整合測試
  - `test/server-auth-integration.test.mjs`:spawn 真實 server 跑 HTTP / WebSocket auth 流(10 case)
- 端到端驗證(手動)
  - 本地 4 場景:無密碼 / 完整登入流 / port +1 fallback / `--trust-proxy` 開關
  - Cloudflare Tunnel 真實 HTTPS:`--trust-proxy` 啟用時 cookie 標 `Secure`,關閉時不標,對照組成立

### 相關 commits

`5680511..1d00221`(13 commits,涵蓋設計文件、實作計畫、模組實作、測試與 README/ROADMAP 文件更新)
