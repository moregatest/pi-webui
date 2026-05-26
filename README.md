# pi-webui

a simple, standalone webui for [pi.dev](https://pi.dev)

![screencast](docs/screencast.gif)

## getting started

prerequisites:

- node.js 20+
- a working pi installation

install as a pi extension:

```bash
pi install npm:@khimaros/pi-webui
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

run without installing:

```bash
npx @khimaros/pi-webui
```

or install globally:

```bash
npm install -g @khimaros/pi-webui
pi-webui
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
| `--password <pw>` | enable login; require this password to access the webui. alias: `PI_WEBUI_PASSWORD` env var. |
| `--trust-proxy` | honor `X-Forwarded-Proto` when deciding cookie `Secure` flag; useful behind cloudflare tunnel / reverse proxy. alias: `PI_WEBUI_TRUST_PROXY=1`. |
| `--sandbox` | run `read` / `write` / `edit` / `bash` inside a [Gondolin](https://github.com/earendil-works/gondolin) micro-VM. workspace path is locked to the launch cwd (or `--sandbox-workspace`); `/cwd` is disabled. requires QEMU. alias: `PI_WEBUI_SANDBOX=1`. |
| `--sandbox-workspace <path>` | host directory mounted as `/workspace` inside the VM. defaults to the launch cwd. alias: `PI_WEBUI_SANDBOX_WORKSPACE`. |
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
| `--ui-profile <preset>` | preset that expands to a set of the above flags. currently supported: `customer` (= `--hide-thinking --hide-tool-calls --show-tool-progress --hide-status-chips --hide-session-picker --hide-model --safe-errors`). individual flags can still be set alongside; they only ever flip in the same direction (no "un-hide"). |

environment variables:

| variable | default | purpose |
| --- | --- | --- |
| `PI_WEBUI_HOST` | `127.0.0.1` | http bind address |
| `PI_WEBUI_PORT` | `4096` | http port |
| `PI_WEBUI_MODEL` | (unset) | default model, same syntax as `--model` |
| `PI_WEBUI_SKILLS` | (unset) | extra skill paths, `:` or `,` separated |
| `PI_WEBUI_SKILL_ALLOW` | (unset) | skill name whitelist (comma-separated) |
| `PI_WEBUI_SKILL_ALLOW_FILE` | (unset) | skill whitelist file path |
| `PI_WEBUI_COMMAND_ALLOW` | (unset) | slash command name whitelist (comma-separated) |
| `PI_WEBUI_COMMAND_ALLOW_FILE` | (unset) | slash command whitelist file path |
| `PI_WEBUI_PASSWORD` | (unset) | enable login with this password (same as `--password`) |
| `PI_WEBUI_TRUST_PROXY` | `0` | `1` to honor `X-Forwarded-Proto` for cookie `Secure` flag |
| `PI_WEBUI_SANDBOX` | `0` | `1` to run tools inside a Gondolin micro-VM (same as `--sandbox`) |
| `PI_WEBUI_SANDBOX_WORKSPACE` | (launch cwd) | host directory mounted as `/workspace` (same as `--sandbox-workspace`) |
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
| `PI_WEBUI_UI_PROFILE` | (unset) | preset name (`customer`); same as `--ui-profile` |
| `PI_WEBUI_PROFILE` | (unset) | profile name (loads `.pi/profiles/<name>.toml`); same as `--profile` |
| `PI_PROJECT_CWD` | `process.cwd()` | project directory used for sessions |
| `PI_AGENT_DIR` | pi default (`~/.pi/agent`) | pi agent config directory |
| `PI_SESSION_DIR` | pi default | session storage directory |
| `PI_WEBUI_CWD_ALLOW_ANY` | `0` | allow `/cwd` to switch to paths outside `$HOME` |

examples:

```bash
pi-webui --listen 0.0.0.0:3000
pi-webui --model anthropic/claude-opus-4-7 --hide-model
pi-webui --skill ~/.claude/skills --skill-allow brainstorming,verify
HOST=0.0.0.0 PORT=3000 PI_PROJECT_CWD=/path/to/project npm start
PI_WEBUI_PASSWORD=hunter2 pi-webui --listen 0.0.0.0:3000 --trust-proxy
pi-webui --ui-profile customer --brand-name "Acme Bot" --brand-color "#0066cc" --brand-logo ./logo.svg
```

when launched via the pi extension, equivalent pi flags are available:
`--webui-model`, `--webui-skill`, `--webui-skill-allow`,
`--webui-skill-allow-file`, `--webui-command-allow`,
`--webui-command-allow-file`, `--webui-hide-model`,
`--webui-password`, `--webui-trust-proxy`,
`--webui-sandbox`, `--webui-sandbox-workspace`,
`--webui-hide-thinking`, `--webui-hide-tool-calls`,
`--webui-show-tool-progress`, `--webui-hide-status-chips`,
`--webui-hide-session-picker`, `--webui-safe-errors`,
`--webui-brand-name`, `--webui-brand-color`, `--webui-brand-logo`,
`--webui-ui-profile`, `--webui-profile`.

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

**port note:** if the requested port is in use, pi-webui linearly searches
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
pi-webui --sandbox

# back-office / customer — bind to LAN with a fixed workspace
pi-webui --sandbox --sandbox-workspace /srv/projects/demo --listen 0.0.0.0:3000
```

Real-VM integration tests are opt-in (`make test-sandbox`) so the
default `make test` does not require QEMU.

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
pi-webui --tunnel --sandbox

# UNSAFE — only when you fully trust everyone with the URL
pi-webui --tunnel --allow-unsafe-tunnel
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

pi-webui supports a `.pi/profiles/<name>.toml` template system that packages
UI flags, branding, skill/command allowlists, and tool progress labels into
named startup interfaces. typical use case: engineer writes the toml files
once per project, then customer/back-office staff can launch the right
interface with a single `--profile <name>` flag.

### startup

```bash
pi-webui                                     # engineer use — bare default
pi-webui --profile staff                     # back-office interface
pi-webui --profile customer --tunnel \
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

[brand]
name   = "Acme Bot"
logo   = "./assets/logo.svg"       # path relative to cwd
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
pi-webui \
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
make install     # install pi-webui globally from this checkout
make update      # update dependencies (npm update)
make test        # build + run tests
make test-sandbox# build + run real-VM sandbox tests (opt-in, needs QEMU)
make lint        # tsc --noEmit + node --check on .mjs sources
make precommit   # lint + test
make vendor      # refresh public/vendor (marked, highlight.js)
make clean       # rm -rf dist build
```
