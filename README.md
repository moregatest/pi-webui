# readyai-webui

a simple, standalone webui for [pi.dev](https://pi.dev)

![screencast](docs/screencast.gif)

> Profile 角色介面三段 GIF 截圖 → [docs/screencast/profiles/](docs/screencast/profiles/README.md)
> (對照 customer 內建 fallback、staff 自訂、brand 完整接口模板)

## getting started

prerequisites:

- node.js 20+
- a working pi installation

install as a pi extension (this is a private fork — install from source, not the npm registry):

```bash
git clone https://github.com/moregatest/pi-webui
cd pi-webui
make            # install deps + build (tsc)
npm link        # expose the `readyai-webui` bin + register as a pi extension globally
```

control from the pi tui:

```bash
> /webui start    # start the server
> /webui status   # view server status
> /webui open     # open webui in browser
> /webui stop     # stop the server
```

or auto-start when pi launches (server is terminated when pi exits):

```bash
pi --webui                              # start with defaults
pi --webui-listen 0.0.0.0:3000          # start with a custom bind address
```

after `npm link`, run the bin directly:

```bash
readyai-webui
```

then open <http://127.0.0.1:4096>.

### from a source checkout

```bash
make            # install deps + build (tsc)
make start      # run the server
make test       # build + run tests
```

## configuration

command-line flags:

| flag | purpose |
| --- | --- |
| `--listen <host:port>` | http bind address; takes precedence over `HOST`/`PORT`. use `:port` for default host, or `[::1]:port` for ipv6. |
| `--model <provider/id>` | default model for new sessions (e.g. `anthropic/claude-opus-4-7`). bare `id` is resolved against the model registry. |
| `--skill <path>` | additional skill source (file or directory). repeatable, or use `:` / `,` to combine. |
| `--skill-allow <names>` | comma-separated skill name whitelist; only these skills are loaded. |
| `--skill-allow-file <path>` | whitelist file (one name per line, `#` for comments). missing file behaves as if unset. when neither this flag nor `PI_WEBUI_SKILL_ALLOW_FILE` is set, `<cwd>/.pi/skills-allow.txt` is auto-detected if present. |
| `--command-allow <names>` | comma-separated slash command whitelist (names like `new`, `cwd`, `skill:foo`). only these commands appear in the slash menu and may be executed. |
| `--command-allow-file <path>` | slash command whitelist file (one name per line, `#` for comments). missing file behaves as if unset. when neither this flag nor `PI_WEBUI_COMMAND_ALLOW_FILE` is set, `<cwd>/.pi/commands-allow.txt` is auto-detected if present. |
| `--session-dir <path>` | session storage directory. overrides the default `<cwd>/.pi/sessions/`. this is a *full* override and may be shared across cwds (sessions from different cwds land in one dir). alias: `PI_SESSION_DIR` env var (CLI wins). |
| `--password <pw>` | enable login; require this password to access the webui. alias: `PI_WEBUI_PASSWORD` env var. |
| `--trust-proxy` | honor `X-Forwarded-Proto` when deciding cookie `Secure` flag; useful behind cloudflare tunnel / reverse proxy. alias: `PI_WEBUI_TRUST_PROXY=1`. |
| `--sandbox` | run `read` / `write` / `edit` / `bash` inside a [Gondolin](https://github.com/earendil-works/gondolin) micro-VM. workspace path is locked to the launch cwd (or `--sandbox-workspace`); `/cwd` is disabled. requires QEMU. alias: `PI_WEBUI_SANDBOX=1`. |
| `--sandbox-workspace <path>` | host directory mounted as `/workspace` inside the VM. defaults to the launch cwd. alias: `PI_WEBUI_SANDBOX_WORKSPACE`. |
| `--sandbox-image <ref>` | gondolin image selector(`name:tag` 或 buildId)。e.g. `readyai-sandbox:0.1.0-3.23.0-bba981`。alias: `PI_WEBUI_SANDBOX_IMAGE`;profile `[sandbox].image` 為 fallback。 |
| `--sandbox-env KEY=VAL` | 注入 VM-wide env(可重複)。與 profile `[sandbox.env]` merge,CLI 優先。 |
| `--allow-unsafe-customer` | bypass the `customer` profile's **effective-sandbox** requirement（見下方 "agent secret isolation" 段）。隔離降級為 in-process only。僅供無 QEMU 的本地 dev / CI；**不可用於 production**。alias: `PI_WEBUI_ALLOW_UNSAFE_CUSTOMER=1`。 |
| `--hide-model` | hide the model name shown in the status bar. |
| `--hide-thinking` | drop `thinking` blocks before they reach the browser (server-side filter, not just css). |
| `--hide-tool-calls` | drop `tool_call` / `tool_result` blocks before they reach the browser. |
| `--show-tool-progress` | when tool calls are hidden, send a compact "doing X…" spinner so the user knows the agent is working. no-op if `--hide-tool-calls` is off. |
| `--hide-status-chips` | hide the status bar (cwd / sandbox / tunnel / context / model). errors still surface. |
| `--hide-session-picker` | disable the session picker; `/resume` style triggers show a toast instead. |
| `--safe-errors` | wrap `server_error` payloads as a generic message with a 6-hex ticket; raw message is written to server log keyed by the same ticket. |
| `--brand-name <text>` | inject into `<title>` and the header. |
| `--brand-color <#hex>` | accent color; sets the `--brand-color` CSS variable. `#rgb` or `#rrggbb`. |
| `--brand-logo <path>` | replace `/brand/logo` route with this file (svg / png / jpg / gif / webp). path must exist or boot fails. |
| `--brand-favicon <path>` | replace the built-in pi favicon served at `/favicon.svg` (svg / png / ico / gif / jpg / webp). path must exist or boot fails. alias: `PI_WEBUI_BRAND_FAVICON`; profile `[brand].favicon` as fallback. |
| `--chat-layout <mode>` | message layout: `bubble` (Claude-style: user right / assistant left, role labels hidden) or `log` (engineer view with titles, default). alias: `PI_WEBUI_CHAT_LAYOUT`; profile `[ui].chat_layout` as fallback. `customer` fallback defaults to `bubble`. |
| `--ui-profile <preset>` | preset that expands to a set of the above flags. currently supported: `customer` (= `--hide-thinking --hide-tool-calls --show-tool-progress --hide-status-chips --hide-session-picker --hide-model --safe-errors`). individual flags can still be set alongside; they only ever flip in the same direction (no "un-hide"). |
| `--upload-ext <list>` | 取代預設一般檔案上傳白名單(逗號分隔,不帶點)。預設清單:`jpg,jpeg,png,gif,webp,svg,pdf,rar,zip,flv,txt,doc,docx,xls,xlsx,dwg`。alias: `PI_WEBUI_UPLOAD_EXT`;profile `[uploads].allowed_extensions` 為 fallback。 |
| `--upload-ext-add <list>` | 在現有清單之上加增副檔名(預設 + profile + `--upload-ext`)。alias: `PI_WEBUI_UPLOAD_EXT_ADD`。 |
| `--upload-subdir <name>` | 上傳檔案落地子目錄(`<cwd>/uploads/<subdir>/`)。預設取 `--profile` 名,沒設時為 `default`。只允許 `[A-Za-z0-9_-]`。alias: `PI_WEBUI_UPLOAD_SUBDIR`;profile `[uploads].subdir` 為 fallback。 |
| `--upload-max-bytes <n>` | 單檔位元組上限。預設 `52428800`(50 MiB)。alias: `PI_WEBUI_UPLOAD_MAX_BYTES`。 |
| `--upload-max-files <n>` | 單一 prompt 最多附幾個檔(僅限非圖片)。預設 `20`。alias: `PI_WEBUI_UPLOAD_MAX_FILES`。 |

environment variables:

| variable | default | purpose |
| --- | --- | --- |
| `PI_WEBUI_HOST` | `127.0.0.1` | http bind address |
| `PI_WEBUI_PORT` | `4096` | http port |
| `PI_WEBUI_MODEL` | (unset) | default model, same syntax as `--model` |
| `PI_WEBUI_SKILLS` | (unset) | extra skill paths, `:` or `,` separated |
| `PI_WEBUI_SKILL_ALLOW` | (unset) | skill name whitelist (comma-separated) |
| `PI_WEBUI_SKILL_ALLOW_FILE` | (unset) | skill whitelist file path |
| `PI_WEBUI_SKILLS_OPEN` | `0` | `1`（限 `customer` profile）放寬技能鎖，放行 skills + read/bash。**未配 `PI_WEBUI_SKILL_ALLOW` 時 cwd 全部技能會載入、客戶可見，啟動會印警告**。 |
| `PI_WEBUI_COMMAND_ALLOW` | (unset) | slash command name whitelist (comma-separated) |
| `PI_WEBUI_COMMAND_ALLOW_FILE` | (unset) | slash command whitelist file path |
| `PI_WEBUI_PASSWORD` | (unset) | enable login with this password (same as `--password`) |
| `PI_WEBUI_TRUST_PROXY` | `0` | `1` to honor `X-Forwarded-Proto` for cookie `Secure` flag |
| `PI_WEBUI_SANDBOX` | `0` | `1` to run tools inside a Gondolin micro-VM (same as `--sandbox`) |
| `PI_WEBUI_SANDBOX_WORKSPACE` | (launch cwd) | host directory mounted as `/workspace` (same as `--sandbox-workspace`) |
| `PI_WEBUI_SANDBOX_IMAGE` | (unset) | gondolin image selector(same as `--sandbox-image`) |
| `PI_WEBUI_ALLOW_UNSAFE_CUSTOMER` | `0` | `1` bypasses the customer effective-sandbox requirement (UNSAFE; local/CI only; same as `--allow-unsafe-customer`) |
| `PI_WEBUI_BASH_ENV_ALLOW` | (unset) | 額外放行進 bash 的非機密 env key（逗號/空白分隔），疊在內建 allowlist 之上（見 agent secret isolation） |
| `PI_WEBUI_HIDE_MODEL` | `0` | `1` hides the model name in the status bar |
| `PI_WEBUI_HIDE_THINKING` | `0` | `1` drops thinking blocks server-side (same as `--hide-thinking`) |
| `PI_WEBUI_HIDE_TOOL_CALLS` | `0` | `1` drops tool_call / tool_result blocks server-side (same as `--hide-tool-calls`) |
| `PI_WEBUI_SHOW_TOOL_PROGRESS` | `0` | `1` enables tool progress spinner when tool calls are hidden (same as `--show-tool-progress`) |
| `PI_WEBUI_HIDE_STATUS_CHIPS` | `0` | `1` hides the status bar (same as `--hide-status-chips`) |
| `PI_WEBUI_HIDE_SESSION_PICKER` | `0` | `1` disables the session picker (same as `--hide-session-picker`) |
| `PI_WEBUI_SAFE_ERRORS` | `0` | `1` wraps server errors as generic message + ticket (same as `--safe-errors`) |
| `PI_WEBUI_BRAND_NAME` | (unset) | brand name injected into title / header (same as `--brand-name`) |
| `PI_WEBUI_BRAND_COLOR` | (unset) | accent color hex (same as `--brand-color`) |
| `PI_WEBUI_BRAND_LOGO` | (unset) | logo file path served at `/brand/logo` (same as `--brand-logo`) |
| `PI_WEBUI_BRAND_FAVICON` | (unset) | favicon file path served at `/favicon.svg` (same as `--brand-favicon`) |
| `PI_WEBUI_CHAT_LAYOUT` | (unset) | message layout `bubble` / `log` (same as `--chat-layout`) |
| `PI_WEBUI_UI_PROFILE` | (unset) | preset name (`customer`); same as `--ui-profile` |
| `PI_WEBUI_PROFILE` | (unset) | profile name (loads `.pi/profiles/<name>.toml`); same as `--profile` |
| `PI_WEBUI_UPLOAD_EXT` | (unset) | 取代預設上傳副檔名白名單(逗號分隔) |
| `PI_WEBUI_UPLOAD_EXT_ADD` | (unset) | 在現有清單上加增副檔名(逗號分隔) |
| `PI_WEBUI_UPLOAD_SUBDIR` | (`--profile` 名 or `default`) | `<cwd>/uploads/<subdir>/` 子目錄 |
| `PI_WEBUI_UPLOAD_MAX_BYTES` | `52428800` | 單檔位元組上限 |
| `PI_WEBUI_UPLOAD_MAX_FILES` | `20` | 單一 prompt 最多附幾個非圖片檔 |
| `PI_PROJECT_CWD` | `process.cwd()` | project directory used for sessions |
| `PI_AGENT_DIR` | pi default (`~/.pi/agent`) | pi agent config directory |
| `PI_SESSION_DIR` | `<cwd>/.pi/sessions/` | session storage directory; full override of the default. same as `--session-dir` (CLI wins). |
| `PI_WEBUI_CWD_ALLOW_ANY` | `0` | allow `/cwd` to switch to paths outside `$HOME` |
| `PI_WEBUI_ARTIFACTS_DIR` | `<cwd>/.artifacts` | 目錄供 `/artifacts/<file>.png` route 服務（截圖等）；設為截圖實際輸出目錄。命中不存在時 404 會帶引導 hint。 |

examples:

```bash
readyai-webui --listen 0.0.0.0:3000
readyai-webui --model anthropic/claude-opus-4-7 --hide-model
readyai-webui --skill ~/.claude/skills --skill-allow brainstorming,verify
HOST=0.0.0.0 PORT=3000 PI_PROJECT_CWD=/path/to/project npm start
PI_WEBUI_PASSWORD=hunter2 readyai-webui --listen 0.0.0.0:3000 --trust-proxy
readyai-webui --ui-profile customer --brand-name "Acme Bot" --brand-color "#0066cc" --brand-logo ./logo.svg
```

when launched via the pi extension, equivalent pi flags are available:
`--webui-model`, `--webui-skill`, `--webui-skill-allow`,
`--webui-skill-allow-file`, `--webui-command-allow`,
`--webui-command-allow-file`, `--webui-session-dir`, `--webui-hide-model`,
`--webui-password`, `--webui-trust-proxy`,
`--webui-sandbox`, `--webui-sandbox-workspace`,
`--webui-hide-thinking`, `--webui-hide-tool-calls`,
`--webui-show-tool-progress`, `--webui-hide-status-chips`,
`--webui-hide-session-picker`, `--webui-safe-errors`,
`--webui-brand-name`, `--webui-brand-color`, `--webui-brand-logo`,
`--webui-brand-favicon`, `--webui-chat-layout`,
`--webui-ui-profile`, `--webui-profile`,
`--webui-upload-ext`, `--webui-upload-ext-add`, `--webui-upload-subdir`,
`--webui-upload-max-bytes`, `--webui-upload-max-files`.

to lock down the slash command menu for a deployment, drop a
`.pi/commands-allow.txt` in the project root with one command name per line
(no leading `/`). missing file means all commands stay available; an empty
file (or all-comments) means no commands are reachable.

```
# .pi/commands-allow.txt — bare minimum for support/customer deployments
new
quit
help
hotkeys
skill:brainstorming
```

### `skills-allow.txt` vs `commands-allow.txt`

these two files gate at different layers — they are independent and can be
used alone or together:

- `skills-allow.txt` is a **load gate**. a skill not in the list is never
  loaded into the pi runtime. the agent can't see it, can't invoke it via
  the `Skill` tool, and it doesn't take up context.
- `commands-allow.txt` is a **surface gate**. the skill is still loaded,
  but it's hidden from the slash menu and manual `/skill:<name>` is
  blocked. the agent can still invoke it on its own.

rule of thumb:

- hide from users but keep available to the agent →
  `commands-allow.txt` only.
- remove from the session entirely (sandboxing, destructive skills,
  context savings) → also use `skills-allow.txt`.

## authentication

set `--password <pw>` or `PI_WEBUI_PASSWORD` to require login. when set,
all requests outside `/login`, `/api/login`, `/api/logout` and `/favicon.svg`
are redirected to the login page or rejected with 401.

session cookies are kept in memory and revoked on server restart — users
have to log in again after every restart. cookie lifetime is 7 days.

**behind a reverse proxy (cloudflare tunnel, nginx, etc.):** add `--trust-proxy`
so the cookie's `Secure` flag is set when `X-Forwarded-Proto: https` is forwarded.
without `--trust-proxy`, the cookie has no `Secure` flag and works in both plain
HTTP and tunneled HTTPS.

**port note:** if the requested port is in use, readyai-webui linearly searches
`port..port+49` for the first free one and prints the actual port in the
listening log line.

passing the password on the command line exposes it in `ps aux`. prefer
`PI_WEBUI_PASSWORD` env var or a wrapper script.

## sandbox

`--sandbox` (or `PI_WEBUI_SANDBOX=1`) boots a [Gondolin](https://github.com/earendil-works/gondolin)
QEMU micro-VM and routes every tool that touches the filesystem or shell
(`read`, `write`, `edit`, `bash`) through it. Other host operations
(slash commands, session storage, network egress from the server itself)
still run in the host process.

- **Mount layout.** The host directory passed via `--sandbox-workspace`
  (default: the launch cwd) is mounted as `/workspace` inside the VM.
  All host paths that resolve inside the workspace are mapped to the
  corresponding `/workspace/...` path; anything outside is rejected.
  Symlink escapes are blocked via `realpath` checks.
- **Locked cwd.** Inside the sandbox the `/cwd` command is disabled —
  switching cwd would point at a directory the VM never mounted.
- **Lazy boot.** The VM starts on first tool call, not at server start.
  The first boot downloads ~150 MB of QEMU assets into the gondolin
  cache; subsequent boots are fast.
- **Requirements.** QEMU must be installed (`brew install qemu` on
  macOS; your distro's `qemu-system-<arch>` package on Linux). The
  server fails fast at startup if the binaries are missing.
- **Status bar.** A `sandbox` chip appears in the status bar when the
  VM is active, or `sandbox: error` when init failed (hover the chip
  for the workspace path or error message).

```bash
# engineer use — sandbox the current project
readyai-webui --sandbox

# back-office / customer — bind to LAN with a fixed workspace
readyai-webui --sandbox --sandbox-workspace /srv/projects/demo --listen 0.0.0.0:3000
```

Real-VM integration tests are opt-in (`make test-sandbox`) so the
default `make test` does not require QEMU.

### custom image profile

要在 sandbox 內預裝特定 CLI / 套件,可以走「自製 gondolin image + profile toml」:

1. 用 `gondolin` build 一個 OCI image(rootfs 含你的 CLI 與依賴)
2. `gondolin image import <dir> --tag <name>:<tag>` 註冊到本機(`gondolin image ls` 確認)
3. 在 `.pi/profiles/<name>.toml` 宣告:

```toml
[sandbox]
image = "readyai-sandbox:0.1.0-3.23.0-bba981"

[sandbox.env]
READYAI_SANDBOX_MODE = "1"
```

4. 啟動:`readyai-webui --sandbox --profile <name>`

或不走 profile,直接 CLI:

```bash
readyai-webui --sandbox \
  --sandbox-image readyai-sandbox:0.1.0-3.23.0-bba981 \
  --sandbox-env READYAI_SANDBOX_MODE=1
```

注意事項:

- image 必須是 host 本機 `gondolin image ls` 已註冊的;readyai-webui **不會**自動下載/build。
- image 內若有 `/etc/profile.d/*.sh`(常見做法注入 `PATH=/usr/local/bin:...`),
  bash 工具走 `bash -lc`(login shell)會自動 source。
- `--sandbox-env KEY=VAL` 是 VM-wide 預設 env(所有 `vm.exec` 都看得到),非單一指令層 env。
- 優先級:`--sandbox-image` (CLI) > `PI_WEBUI_SANDBOX_IMAGE` (env) > profile `[sandbox].image`。
  env 則為 merge:profile 為基底,CLI `--sandbox-env` 蓋寫個別 key。

### sandbox 身份提示(自動注入)

sandbox 啟用時,readyai-webui 會在 model system prompt 末段 append 一段身份提示:

- 「你在 readyai-webui Gondolin micro-VM,不是 Fly.io / Docker / 遠端 SSH」
- cwd `/workspace` 對映到 host 端的具體路徑
- host 路徑(`/Users/*` / `/home/*` / `/root/*`)在 VM 內不存在
- 沒 `flyctl` / host SSH / `~/.ssh/` / `~/.readyai/` / `~/.claude/`
- 若 doc 提到 host-only 工作流要繞道、請 operator 在 host 端跑

目的:LLM 在 sandbox 內看不到「自己在哪」,容易誤判 cwd 是 Fly.io 容器、套上 host-only 工作流跑出
`command not found`。這段提示提供 mental model 錨點。

要追加 image-specific 提示(例如「本 image 預裝哪些 CLI」)可在 profile toml 寫:

```toml
[sandbox]
image = "readyai-sandbox:0.1.0-3.23.0-bba981"
system_prompt = """
本 image 預裝 readyai-* 11 個 CLI(readyai-db、readyai-menu、readyai-uploadpage 等)。
完整清單見 image 內 /opt/readyai/README.md。
"""
```

`[sandbox].system_prompt` 上限 16KB,append 在 built-in 提示之後。

## agent secret isolation（防 agent 洩漏主機機密）

agent 的 `bash` / `read` 與 web server 跑在同一台主機、同一個 Node.js process。若不設防,
一行 `printenv` 就能把主機上的 production 機密(`OPENROUTER_API_KEY`、`R2_*`、`PC2_SERVICE_PWS` …)
傾印進對話——而對話會送往雲端 LLM、寫進 session log。分四層防禦深度(spec
`docs/superpowers/specs/2026-07-01-agent-secret-isolation-design.md`):

- **L0 bash env allowlist.** bash 子行程不再繼承整個 `process.env`,改為正面表列白名單
  (`PATH`/`HOME`/`LANG`/`LC_*`/`ZYTE_API_KEY`/`PI_PROJECT_CWD` 等非機密)。機密天然被擋。
  host bash 與 sandbox bash 的 per-exec env 兩條路徑共用同一 hook。要額外放行非機密 key 用
  `PI_WEBUI_BASH_ENV_ALLOW`(逗號/空白分隔;**不要**拿來放機密)。sandbox bash 另注入
  `READYAI_SANDBOX_MODE=1`,讓 readyAI CLI 從 mounted workspace `.env` 讀 scoped 憑證。
- **L1 read workspace 圍欄.** `read` 目標經 `realpath`(解 `../` 與 symlink)後必須落在
  workspace 內才放行;`/proc/*/environ` 與 workspace 外主機機密(`~/.ssh`、server `.env`)一律擋。
- **L2 customer 強制 effective sandbox.** `customer` profile **必須**跑在真的 boot 起來的
  Gondolin VM 上(不只是 `--sandbox` 旗標;init 失敗 `sandbox=null` 會落回 host bash)。
  啟動時 eager boot VM,失敗即 **fail-closed**(拒啟)。要在無 QEMU/無 KVM 環境跑須顯式
  `--allow-unsafe-customer` 繞過 —— **繞過後仍保留 in-process L0+L1+L3**(customer-open 的
  read/bash 改走 guarded 版:env 白名單 + read 圍欄 + 遮蔽),只是少了 VM 硬邊界,配單租戶隔離。
  **Fly Firecracker 無 nested `/dev/kvm`,Gondolin 只能 TCG(不可用),故 Fly preview 走此
  in-process 路徑**(見 issue #4)。
- **L3 機密值遮蔽.** tool 輸出(送 model 與送 client/streaming 兩路)掃描已知 L-甲共用機密
  「值」換成 `«REDACTED»` 兜底。L-乙 scoped 憑證(`PC2_API_TOKEN` 等)走 workspace `.env`、
  不在 `process.env`,不在遮蔽範圍(半信任下 customer 本就能讀自己 workspace `.env`)。

分模式強度:開發者 L0+L1+L3(純 in-process,防手滑);`customer`/`customer-open` 另加 L2 強制 VM
硬邊界(防不信任客戶主動撈)。`ZYTE_API_KEY` 為使用者拍板接受的殘餘風險例外(進 VM/env 白名單)。

## tunnel

`--tunnel` (or `PI_WEBUI_TUNNEL=1`) spawns a [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
quick tunnel and exposes the server on a public `trycloudflare.com` URL — no
Cloudflare account required.

security defaults applied automatically when `--tunnel` is active:

- **`--sandbox` required.** `--tunnel` without `--sandbox` would let anyone with
  the public URL + password execute `read` / `write` / `edit` / `bash` against
  the host filesystem. the server **refuses to start** unless either `--sandbox`
  or `--allow-unsafe-tunnel` is also set.
- **auto-generated password.** if `--password` is not provided, a 32-character
  base64url random password is generated, printed to console, and written to
  `<agentDir>/tunnel-password.txt` (mode `0600`; default location: `~/.pi/agent/`).
- **`--trust-proxy` implied.** `X-Forwarded-Proto` from the cloudflared edge is
  trusted so the session cookie carries the `Secure` flag correctly.
- **cloudflared must be in `PATH`.** the server fails fast at startup if the
  binary is missing. install with `brew install cloudflared` (macOS), your
  distro's package manager, or `cargo install cloudflared`.

flags and env vars:

| flag | env var | description |
|------|---------|-------------|
| `--tunnel` | `PI_WEBUI_TUNNEL=1` | enable quick tunnel |
| `--tunnel-cloudflared <path>` | `PI_WEBUI_CLOUDFLARED` | custom cloudflared binary path |
| `--allow-unsafe-tunnel` | `PI_WEBUI_ALLOW_UNSAFE_TUNNEL=1` | bypass the `--sandbox` requirement (UNSAFE — full host access) |

```bash
# recommended — public URL + sandboxed filesystem access
readyai-webui --tunnel --sandbox

# UNSAFE — only when you fully trust everyone with the URL
readyai-webui --tunnel --allow-unsafe-tunnel
```

**security notes:**

- without `--sandbox`, `--tunnel` is refused unless you pass
  `--allow-unsafe-tunnel`. that flag lets remote callers execute tools with
  full host filesystem access; only set it on a fully trusted host.
- combining `--listen 0.0.0.0:*` and `--tunnel` exposes the port on both LAN
  and the public internet simultaneously. the server prints a `stderr` warning
  at startup.
- the quick tunnel URL changes on every restart; it is not a stable hostname.

**running multiple tunnels in parallel** (e.g. one per project): keep
`PI_AGENT_DIR` unset (or pointing at the default `~/.pi/agent`) so all
servers share the same OAuth credential, but give each instance its own
`--listen <port>` and `--password <pw>`. setting `PI_AGENT_DIR` to a fresh
empty directory will break model auth — the server prints a `hint` to
`stderr` when it detects this case.

**status bar.** a `tunnel` chip appears while the tunnel is active — yellow
while starting, green when the URL is ready, red on error, grey when stopped.
click the chip (active state) to copy the public URL to the clipboard.

Real-tunnel integration tests are opt-in (`make test-tunnel`) so the
default `make test` does not require a network connection or cloudflared.

## profiles

readyai-webui supports a `.pi/profiles/<name>.toml` template system that packages
UI flags, branding, skill/command allowlists, and tool progress labels into
named startup interfaces. typical use case: engineer writes the toml files
once per project, then customer/back-office staff can launch the right
interface with a single `--profile <name>` flag.

### startup

```bash
readyai-webui                                     # engineer use — bare default
readyai-webui --profile staff                     # back-office interface
readyai-webui --profile customer --tunnel \
  --password "$(cat .secret)"                # customer interface, public URL
```

### `.pi/profiles/<name>.toml` schema

```toml
[meta]
description = "..."                # human-readable; server ignores

[ui]
hide_thinking       = true         # drop thinking blocks
hide_tool_calls     = true         # drop tool_call / tool_result blocks
show_tool_progress  = true         # send tool_progress spinner instead
hide_status_chips   = true         # hide cwd/sandbox/tunnel/model chips
hide_session_picker = true         # disable session picker
hide_model          = true         # hide model name
safe_errors         = true         # wrap server_error as generic + ticket
expose_tool_args    = false        # allow {tool_arg.*} placeholders (UNSAFE)
chat_layout         = "bubble"     # bubble (Claude-style) | log (engineer view, default)

[brand]
name   = "Acme Bot"
logo   = "./assets/logo.svg"       # path relative to cwd
favicon = "./assets/favicon.svg"   # browser tab icon; replaces built-in pi favicon (path relative to cwd)
mode   = "light"                   # dark | light
bg     = "#fafafa"                 # CSS --bg
panel  = "#ffffff"                 # CSS --panel
text   = "#1a1a1a"                 # CSS --text
accent = "#0066cc"                 # CSS --accent / --brand-color
border = "#e0e0e0"                 # CSS --border
muted  = "#707070"                 # CSS --muted
css    = "./assets/theme.css"      # optional CSS overlay (max 100KB)

[skills]
allow = ["brainstorming"]          # overrides .pi/skills-allow.txt

[commands]
allow = ["new", "quit", "help"]    # overrides .pi/commands-allow.txt

[defaults]
model = "anthropic/claude-opus-4-7"

[tool_labels.read]
start = "正在讀取 {file_basename}"
end   = "讀取完成"

[tool_labels.WebFetch]
start = "正在抓取 {url_host} 的網頁..."
end   = "網頁抓取完成"

[tool_labels._default]
start = "正在處理..."
end   = ""                          # empty = clear spinner only
```

### resolution priority

individual CLI flags > individual env vars > profile file > built-in customer
fallback (only when `--profile customer` and no file present) > defaults.

### placeholders (tool_labels only)

| placeholder | source | safety |
|---|---|---|
| `{file_basename}` | `path.basename(args.file_path \|\| args.path \|\| args.file)` | filename only, safe |
| `{url_host}` | `new URL(args.url).hostname` | host only, safe |
| `{progress_count}` | SDK progress callback | server-controlled |
| `{tool_arg.<key>}` | full arg value | requires `expose_tool_args = true` |

### fail-fast at startup

- profile file not found (and name !== `customer`)
- toml syntax error
- `[brand].mode` not `dark` / `light`
- `[brand].bg/panel/text/accent/border/muted` invalid hex
- `[brand].logo` or `[brand].css` path missing
- `[brand].css` > 100KB
- `[tool_labels.<name>].<phase>` contains unknown placeholder
- unknown toml field (strict mode catches typos like `hide_thiking`)

### backwards compatibility

- `--ui-profile customer` still works as alias for `--profile customer`
- if `.pi/profiles/customer.toml` exists, it overrides the built-in fallback
- if both `[skills].allow` (profile) and `.pi/skills-allow.txt` exist, profile
  wins and server prints a startup warning
- same for `[commands].allow` and `.pi/commands-allow.txt`

### customer deployment example

```bash
readyai-webui \
  --profile customer \
  --sandbox \
  --tunnel \
  --password "$(cat .password)" \
  --trust-proxy
```

### individual flags (no profile file)

if you don't want to maintain a toml file, the legacy individual flags
still work and can be combined freely:

- `--hide-thinking`, `--hide-tool-calls`, `--show-tool-progress`,
  `--hide-status-chips`, `--hide-session-picker`, `--hide-model`,
  `--safe-errors`
- `--brand-name`, `--brand-color`, `--brand-logo`
- `--ui-profile customer` (preset shortcut, expands the seven hide/show flags)

filtering happens server-side (`src/server/ui-profile.ts`), so devtools
cannot recover what was hidden. invalid input rejects at startup, not
request time: `--brand-color` must match `#rgb` / `#rrggbb`; `--brand-logo`
must point to an existing file; `--profile <name>` and `--ui-profile <name>`
must resolve.

pair this with `.pi/commands-allow.txt` (or `[commands].allow` in the
profile) to also trim the slash menu.

## attachments

paste images into the composer (Ctrl/Cmd+V) or drag and drop them onto the
window. thumbnails appear above the input and ride along with the next
prompt. up to 8 images per turn, 10 MB each. PNG, JPEG, GIF, and WebP are
accepted.

## sessions

conversations are persisted as append-only `.jsonl` files. by default they
land in **`<cwd>/.pi/sessions/`** (the same `.pi/` convention as
`profiles` / `skills-allow.txt`), so a project's history travels with the
project directory rather than your home directory.

- **override location:** `--session-dir <path>` (or `PI_SESSION_DIR`, CLI
  wins). this is a *full* override and may be shared across cwds — sessions
  from different cwds then land in one dir.
- **resolution priority:** `--session-dir` > `PI_SESSION_DIR` > default
  `<cwd>/.pi/sessions/`.
- **session picker** (`/resume`) lists only the current project's sessions.
  to load a session stored elsewhere (e.g. a legacy
  `~/.pi/agent/sessions/...` one from before this change), pass an explicit
  path: `/resume <absolute-path>`.
- **reconnect:** a browser reload only auto-resumes a stored session if it
  is a genuine project-local (or override-dir) session of its own cwd;
  otherwise it starts fresh in the project-local default.
- **`/cwd` recent list** is sourced from the legacy home-dir index, so
  project-local-only projects do not appear there; use the directory
  browser to switch instead.
- **gitignore:** sessions can contain sensitive conversation content. this
  repo ignores `.pi/sessions/`; downstream projects should do the same.

## roadmap

see [ROADMAP.md](ROADMAP.md) for implemented and planned features.

## architecture

```
src/
  extension/   pi extension entry (slash command + auto-start flag)
  server/      http + websocket server hosting the pi sdk runtime
                 index.ts, event-log.ts, log.ts, watch.ts, ext-ui.ts,
                 command-allow.ts
public/        browser client (vanilla js, no build step)
test/          node --test files
```

## development

```bash
make             # install deps + build (tsc)
make start       # run the server
make install     # install readyai-webui globally from this checkout
make update      # update dependencies (npm update)
make test        # build + run tests
make test-sandbox# build + run real-VM sandbox tests (opt-in, needs QEMU)
make lint        # tsc --noEmit + node --check on .mjs sources
make precommit   # lint + test
make vendor      # refresh public/vendor (marked, highlight.js)
make clean       # rm -rf dist build
```
