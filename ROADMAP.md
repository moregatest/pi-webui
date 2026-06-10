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
[x] list sessions across all projects
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
[x] `PI_PROJECT_CWD` / `PI_AGENT_DIR` / `PI_SESSION_DIR` overrides
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
[x] 一般檔案上傳:composer 加 + 附件按鈕,支援 paste / drag-drop / 檔案選取。圖片(png/jpeg/gif/webp)走 ImageContent 走 in-band base64 讓 LLM 直接看;其他副檔名(預設 jpg/jpeg/png/gif/svg/pdf/rar/zip/flv/txt/doc/docx/xls/xlsx/dwg,可由 `[uploads].allowed_extensions` / `--upload-ext` / `--upload-ext-add` 擴充)走 `PUT /api/upload` 寫入 `<cwd>/uploads/<subdir>/`(sandbox 啟用時對應 VM 內 `/workspace/uploads/<subdir>/`),檔名加 timestamp 後綴防覆蓋。預設單檔 50 MiB、單一 prompt 20 個附件,可由 `--upload-max-bytes` / `--upload-max-files` 調。subdir 預設取 `--profile` 名,可獨立由 `--upload-subdir` 覆寫。extension forward `--webui-upload-*`
```
