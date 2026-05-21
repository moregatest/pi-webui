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
| `--hide-model` | hide the model name shown in the status bar. |

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
| `PI_WEBUI_HIDE_MODEL` | `0` | `1` hides the model name in the status bar |
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
```

when launched via the pi extension, equivalent pi flags are available:
`--webui-model`, `--webui-skill`, `--webui-skill-allow`,
`--webui-skill-allow-file`, `--webui-command-allow`,
`--webui-command-allow-file`, `--webui-hide-model`.

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
make            # install deps + build (tsc)
make start      # run the server
make install    # install pi-webui globally from this checkout
make update     # update dependencies (npm update)
make test       # build + run tests
make lint       # tsc --noEmit + node --check on .mjs sources
make precommit  # lint + test
make vendor     # refresh public/vendor (marked, highlight.js)
make clean      # rm -rf dist build
```
