// @ts-nocheck
// Bridges pi's `ExtensionUIContext` to the webui over a websocket so
// extensions like @aliou/pi-guardrails can prompt the user from the browser
// instead of a TTY. Interactive surfaces (notify/select/confirm/input) round-
// trip to the client; everything else degrades to a no-op so the runtime
// still treats UI as available (`hasUI()` checks identity, not contents).

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const piIndexUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const piDistDir = dirname(fileURLToPath(piIndexUrl));
const themeMod = await import(
  pathToFileURL(resolve(piDistDir, "modes/interactive/theme/theme.js")).href
);
// `theme` is a Proxy that reads a globalThis slot populated by initTheme().
// Pi's interactive CLI calls this at startup; readyai-webui never enters that
// codepath, so we initialize it ourselves before any extension touches the
// proxy (otherwise the first `.fg/.bg/.bold` access throws).
themeMod.initTheme?.();
const piTheme = themeMod.theme;

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

// A pi-tui Component renders ANSI strings sized to a terminal width. We have
// no terminal, so we ship the rendered lines to the browser, which paints
// them in a modal and forwards keystrokes back as raw escape sequences.
const DEFAULT_CUSTOM_WIDTH = 100;
const DEFAULT_CUSTOM_HEIGHT = 30;
const RENDER_FLUSH_MS = 16;

// One bridge per ws controller. Tracks pending request ids so responses can
// be matched to their awaiting promise.
export function createExtUiBridge({ send, log }) {
  const pending = new Map();
  const custom = new Map(); // id -> { component, width, flush, settled }
  let nextId = 1;

  function request(kind, payload, opts = {}) {
    const id = `eu-${nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`ext_ui_request timed out: ${kind}`));
      }, opts.timeoutMs ?? REQUEST_TIMEOUT_MS);
      const onAbort = () => {
        if (!pending.has(id)) return;
        pending.delete(id);
        clearTimeout(timer);
        send({ type: "ext_ui_cancel", payload: { id } });
        resolve(opts.abortValue);
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          clearTimeout(timer);
          resolve(opts.abortValue);
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
      });
      send({ type: "ext_ui_request", payload: { id, kind, ...payload } });
    });
  }

  function handleResponse(payload) {
    const id = payload?.id;
    const entry = id && pending.get(id);
    if (!entry) {
      log?.warn?.("ext_ui_response with no pending request", { id });
      return;
    }
    pending.delete(id);
    entry.resolve(payload.value);
  }

  // Build the (tui, theme, keybindings, done) shim a `ui.custom` factory expects.
  // Pi-tui's overlay machinery isn't available, so we expose just enough surface
  // for the component: a fake terminal sized to the client's reported width and
  // a `requestRender` that triggers a debounced re-render → ws update.
  function customRequest(factory, _opts = {}) {
    const id = `eu-${nextId++}`;
    return new Promise((resolve, reject) => {
      const entry = {
        component: null,
        width: DEFAULT_CUSTOM_WIDTH,
        height: DEFAULT_CUSTOM_HEIGHT,
        renderTimer: null,
        settled: false,
        resolve,
        reject,
      };
      custom.set(id, entry);

      const flush = () => {
        if (entry.settled || !entry.component) return;
        entry.renderTimer = null;
        try {
          const lines = entry.component.render(entry.width);
          send({ type: "ext_ui_custom_update", payload: { id, lines } });
        } catch (err) {
          log?.error?.("ext_ui custom render failed", { error: String(err) });
          finish(undefined);
        }
      };
      const requestRender = () => {
        if (entry.settled) return;
        if (entry.renderTimer) return;
        entry.renderTimer = setTimeout(flush, RENDER_FLUSH_MS);
      };
      const tui = {
        terminal: {
          get rows() { return entry.height; },
          get columns() { return entry.width; },
        },
        requestRender,
      };
      const finish = (value) => {
        if (entry.settled) return;
        entry.settled = true;
        if (entry.renderTimer) clearTimeout(entry.renderTimer);
        try { entry.component?.dispose?.(); } catch { /* ignore */ }
        custom.delete(id);
        send({ type: "ext_ui_custom_close", payload: { id } });
        resolve(value);
      };
      entry.finish = finish;

      const done = (value) => finish(value);
      Promise.resolve()
        .then(() => factory(tui, piTheme, noopKeybindings, done))
        .then((component) => {
          if (entry.settled) {
            try { component?.dispose?.(); } catch { /* ignore */ }
            return;
          }
          entry.component = component;
          let lines = [];
          try {
            lines = component.render(entry.width);
          } catch (err) {
            log?.error?.("ext_ui custom initial render failed", { error: String(err) });
            finish(undefined);
            return;
          }
          send({ type: "ext_ui_custom_open", payload: { id, lines, width: entry.width } });
        })
        .catch((err) => {
          log?.error?.("ext_ui custom factory threw", { error: String(err) });
          if (custom.has(id)) custom.delete(id);
          send({ type: "ext_ui_custom_close", payload: { id } });
          reject(err);
        });
    });
  }

  function handleCustomInput({ id, data }) {
    const entry = custom.get(id);
    if (!entry || !entry.component) return;
    try {
      entry.component.handleInput?.(String(data));
    } catch (err) {
      log?.error?.("ext_ui custom handleInput failed", { error: String(err) });
    }
  }

  function handleCustomResize({ id, width, height }) {
    const entry = custom.get(id);
    if (!entry) return;
    if (typeof width === "number" && width > 0) entry.width = Math.floor(width);
    if (typeof height === "number" && height > 0) entry.height = Math.floor(height);
    try { entry.component?.invalidate?.(); } catch { /* ignore */ }
    if (entry.component) {
      const lines = entry.component.render(entry.width);
      send({ type: "ext_ui_custom_update", payload: { id, lines } });
    }
  }

  function handleCustomClose({ id }) {
    const entry = custom.get(id);
    if (!entry) return;
    entry.finish?.(undefined);
  }

  function dispose() {
    for (const { reject } of pending.values()) {
      reject(new Error("ext_ui bridge disposed"));
    }
    pending.clear();
    for (const entry of custom.values()) {
      entry.finish?.(undefined);
    }
    custom.clear();
  }

  const ui = {
    select: (title, options, opts) =>
      request("select", { title, options }, { signal: opts?.signal, timeoutMs: opts?.timeout, abortValue: undefined }),
    confirm: (title, message, opts) =>
      request("confirm", { title, message }, { signal: opts?.signal, timeoutMs: opts?.timeout, abortValue: false }),
    input: (title, placeholder, opts) =>
      request("input", { title, placeholder }, { signal: opts?.signal, timeoutMs: opts?.timeout, abortValue: undefined }),
    notify: (message, type = "info") => {
      send({ type: "ext_ui_notify", payload: { message, type } });
    },
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: (title) => {
      send({ type: "ext_ui_title", payload: { title } });
    },
    custom: (factory, opts) => customRequest(factory, opts),
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    get theme() {
      return piTheme;
    },
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "theme switching not supported in webui" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };

  return { ui, handleResponse, handleCustomInput, handleCustomResize, handleCustomClose, dispose };
}

// Some extensions read `keybindings.get*` etc., but neither path-access nor
// permission-gate touches it; provide a no-op shim that returns undefined for
// any access so future extensions don't crash on simple field reads.
const noopKeybindings = new Proxy({}, {
  get: () => () => undefined,
});
