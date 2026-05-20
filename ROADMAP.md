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
[x] published as `@khimaros/pi-webui` with `pi-webui` bin
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
```
