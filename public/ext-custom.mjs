// Renders a pi-tui Component (proxied from the server) as a webui modal,
// converts its ANSI output to HTML, and forwards browser keystrokes back as
// terminal escape sequences so the component's `handleInput(data)` sees the
// same input it would on a real TTY.
//
// Only legacy escape sequences are emitted (no Kitty CSI-u). The components
// readyai-webui currently needs to support (guardrails permission-gate, path-
// access) recognise these in their `matchesKey` calls. If we later need
// modifier-rich keys we'll layer on Kitty encoding.

import { ansiToHtml } from "./ansi.mjs";

export function createCustomOverlayHost({ root, send }) {
  let backdrop = null;
  let pre = null;
  let activeId = null;

  function ensureDom() {
    if (backdrop) return;
    backdrop = document.createElement("div");
    backdrop.className = "ext-custom-backdrop";
    backdrop.tabIndex = -1;
    const surface = document.createElement("div");
    surface.className = "ext-custom-surface";
    pre = document.createElement("pre");
    pre.className = "ext-custom-output";
    surface.appendChild(pre);
    backdrop.appendChild(surface);
    backdrop.hidden = true;
    backdrop.addEventListener("keydown", onKey);
    root.appendChild(backdrop);
  }

  function open({ id, lines }) {
    ensureDom();
    activeId = id;
    setLines(lines);
    backdrop.hidden = false;
    backdrop.focus();
  }

  function update({ id, lines }) {
    if (id !== activeId) return;
    setLines(lines);
  }

  function close({ id }) {
    if (id !== activeId) return;
    activeId = null;
    if (backdrop) backdrop.hidden = true;
  }

  function setLines(lines) {
    if (!Array.isArray(lines)) lines = [];
    const html = lines.map((l) => ansiToHtml(l) || "&nbsp;").join("\n");
    pre.innerHTML = html;
  }

  function onKey(event) {
    if (activeId === null) return;
    const data = encodeKey(event);
    if (data === null) return;
    event.preventDefault();
    event.stopPropagation();
    send({ type: "ext_ui_custom_input", payload: { id: activeId, data } });
  }

  return { open, update, close };
}

// Translate a browser KeyboardEvent into a terminal escape sequence. Returns
// null when the event shouldn't be forwarded (modifier-only presses, IME
// composition, etc.).
function encodeKey(event) {
  if (event.isComposing) return null;
  const key = event.key;
  if (!key || key === "Dead" || key === "Unidentified") return null;
  if (key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") return null;

  const SPECIAL = {
    Enter: "\r",
    Escape: "\x1b",
    Tab: event.shiftKey ? "\x1b[Z" : "\t",
    Backspace: "\x7f",
    Delete: "\x1b[3~",
    ArrowUp: "\x1b[A",
    ArrowDown: "\x1b[B",
    ArrowRight: "\x1b[C",
    ArrowLeft: "\x1b[D",
    Home: "\x1b[H",
    End: "\x1b[F",
    PageUp: "\x1b[5~",
    PageDown: "\x1b[6~",
  };
  if (SPECIAL[key] !== undefined) return SPECIAL[key];

  if (key.length === 1) {
    // Ctrl+letter → C0 control byte; preserve case for Ctrl+Shift+letter.
    if (event.ctrlKey && !event.metaKey) {
      const code = key.toLowerCase().charCodeAt(0);
      if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
      if (key === " ") return "\x00";
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey) return "\x1b" + key;
    return key;
  }

  return null;
}
