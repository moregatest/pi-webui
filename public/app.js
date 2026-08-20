const BASE = (window.__BASE__ || "");
const composer = document.getElementById("composer");
const input = document.getElementById("input");
const sendButton = document.getElementById("send");
const log = document.getElementById("log");
const toastLayer = document.getElementById("toast-layer");
const slashMenu = document.getElementById("slash-menu");
const modal = document.getElementById("modal");
const modalSearch = document.getElementById("modal-search");
const modalBody = document.getElementById("modal-body");
const modalTitle = document.getElementById("modal-title");
const modalDialog = modal.querySelector(".modal");
const statusLeft = document.getElementById("status-left");
const statusRight = document.getElementById("status-right");
const statusCwd = document.getElementById("status-cwd");
const statusSandbox = document.getElementById("status-sandbox");
const statusTunnel = document.getElementById("status-tunnel");
const statusError = document.getElementById("status-error");
const brandHeader = document.getElementById("brand-header");
const brandLogo = document.getElementById("brand-logo");
const brandName = document.getElementById("brand-name");

import {
  createChatState,
  submitUser as csSubmitUser,
  setHistory as csSetHistory,
  resetHistory as csResetHistory,
  setError as csSetError,
  selectItems as csSelectItems,
} from "./chat-state.mjs";
import { dispatchSessionEvent } from "./session-dispatch.mjs";
import { createModalController } from "./modal-controller.mjs";
import { decideExtraItemRender } from "./render-decision.mjs";
import {
  extractTextFromResult,
  extractResultParts,
  stripCatNLinePrefixes,
} from "./tool-result.mjs";
import { ACTIVE_SESSION_KEY, extractSessionFileFromState } from "./storage.mjs";
import {
  formatMessage,
  sdkContentToBlocks,
  hasVisibleContent,
  isToolResultVisible,
} from "./format-message.mjs";
import { shouldHighlightCodeBlock } from "./highlight.mjs";
import { planBlockRenders, reconcileChildrenInPlace } from "./render-blocks.mjs";
import { createFollowState, onScrollEvent, shouldAutoScroll } from "./scroll-follow.mjs";
import { log as logger } from "./log.mjs";
import { createCustomOverlayHost } from "./ext-custom.mjs";
import { routeInput } from "./route-input.mjs";

let socket;
let currentSessionState = null;
const chatState = createChatState();
let slashCommands = [];
let homeDir = "";
let hideModel = false;
let sandboxInfo = null;
let tunnelInfo = null;
// 客戶導向 UI profile;預設全 false + brand 全 null,跟 server 端 parseUiProfile 對齊
let uiProfile = {
  hideThinking: false,
  hideToolCalls: false,
  showToolProgress: false,
  hideStatusChips: false,
  hideSessionPicker: false,
  hideModel: false,
  safeErrors: false,
  showToolResultsFor: [],
  brand: { name: null, logoUrl: null, color: null, tokens: {}, mode: null, css: false },
};
// tool_progress packet 對應的 DOM 區塊。Map<id, HTMLElement>。
const toolProgressNodes = new Map();
let slashFiltered = [];
let slashIndex = 0;
// Cursor into the server's session-event log. The server tags each
// session_event with a seq; we send our latest one back on (re)connect via
// `ready` so the server can replay missed events without a full reset.
let lastSeq = null;

// Track the visual viewport so the app shell shrinks when the mobile virtual
// keyboard opens. Without this, `100vh` stays the full screen and the top of
// the chat log scrolls behind the keyboard.
function syncAppHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${h}px`);
}
syncAppHeight();
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", syncAppHeight);
  window.visualViewport.addEventListener("scroll", syncAppHeight);
} else {
  window.addEventListener("resize", syncAppHeight);
}

function loadStoredSessionFile() {
  try {
    return localStorage.getItem(ACTIVE_SESSION_KEY) || null;
  } catch {
    return null;
  }
}

function saveStoredSessionFile(file) {
  try {
    if (file) localStorage.setItem(ACTIVE_SESSION_KEY, file);
    else localStorage.removeItem(ACTIVE_SESSION_KEY);
  } catch {
    /* storage unavailable */
  }
}

const INPUT_HISTORY_KEY = "pi-webui:input-history";
const INPUT_HISTORY_LIMIT = 200;

// matches server.mjs sanitizePromptImages — keep in sync
const MAX_PASTED_IMAGES = 8;
const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024;
// Anthropic ImageContent 支援的 mime;命中這條的圖檔走 in-band base64 path,
// 讓 LLM 直接「看見」內容(不必先 Read 路徑)。命中不到的圖(svg)以及所有
// 其他副檔名,走 /api/upload + path,LLM 用 Read/Bash 自行取。
// 命中的圖檔**同時**再走一次 /api/upload 落地(見 ingestFiles):光有 base64
// 時 LLM 看得到圖卻沒有檔案可操作,任何吃檔案路徑的工具(如 readyai-image-uploader
// --local-file)都無從執行,只能回頭跟使用者要「路徑」——那是死路。
const ALLOWED_PASTED_IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/i;
// in-memory list of images attached to the next prompt:
// {data, mimeType, url, originalName, ext, attachPath, uploadStatus}
// uploadStatus: "uploading" | "ready" | "error" | "skipped"(無副檔名/白名單外/過大)
const pendingImages = [];


// 一般檔案附件(上傳完成的):{id, originalName, attachPath, size, ext, status}
// status: "uploading" | "ready" | "error"
const pendingFiles = [];
let nextPendingFileId = 1;

// 上傳設定:從 connected packet 拿;先給 defaults 避免 connected 之前 paste
// 觸發到 undefined。預設清單與 server 端 DEFAULT_ALLOWED_EXTENSIONS 對齊。
const DEFAULT_UPLOAD_EXTENSIONS = [
  "jpg", "jpeg", "png", "gif", "webp", "svg",
  "pdf", "rar", "zip", "flv", "txt",
  "doc", "docx", "xls", "xlsx", "dwg",
];
let uploadConfig = {
  allowedExtensions: new Set(DEFAULT_UPLOAD_EXTENSIONS),
  maxBytes: 50 * 1024 * 1024,
  maxFiles: 20,
  subdir: "default",
};
let inputHistory = loadInputHistory();
let inputHistoryIndex = inputHistory.length;
let inputHistoryDraft = "";

function loadInputHistory() {
  try {
    const raw = localStorage.getItem(INPUT_HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function saveInputHistory() {
  try {
    localStorage.setItem(INPUT_HISTORY_KEY, JSON.stringify(inputHistory));
  } catch {
    /* ignore quota */
  }
}

function pushInputHistory(text) {
  if (!text) return;
  if (inputHistory[inputHistory.length - 1] === text) {
    inputHistoryIndex = inputHistory.length;
    return;
  }
  inputHistory.push(text);
  if (inputHistory.length > INPUT_HISTORY_LIMIT) {
    inputHistory.splice(0, inputHistory.length - INPUT_HISTORY_LIMIT);
  }
  inputHistoryIndex = inputHistory.length;
  saveInputHistory();
}

function resizeInput() {
  input.style.height = "36px";
  input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
}

// rows to jump per Page Up / Page Down inside a modal picker.
const MODAL_PAGE_SIZE = 10;
let modalItems = [];
let modalFiltered = [];
let modalIndex = 0;
let modalOnSelect = null;
let modalOnCommit = null;
let modalMulti = false;
let modalSelected = new Set();
// Owns the cancel handler used by the ext_ui bridge to reply on dismissal
// (Escape, backdrop click). closeModal() routes through dismiss(); commit
// paths call modalCtrl.commit() to suppress the cancel before teardown.
const modalCtrl = createModalController();
// Hooks used by dynamic pickers (currently the cwd picker) to take over
// the modal search input/Enter/Tab without rewriting the modal infra.
let modalInputOverride = null;
let modalCommitOverride = null;
let modalTabHandler = null;
let cwdPickerState = null;

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function displayPath(path) {
  if (!path || !homeDir) return path;
  if (path === homeDir) return "~/";
  if (path.startsWith(homeDir + "/")) return "~/" + path.slice(homeDir.length + 1);
  return path;
}

// Replace every occurrence of $HOME in a string with `~/`. Used to prettify
// absolute paths shown in tool-call inputs and tool-result bodies.
function prettifyHomePaths(text) {
  if (!text || !homeDir) return text;
  return String(text).split(homeDir + "/").join("~/").split(homeDir).join("~");
}

function prettifyHomePathsDeep(value) {
  if (typeof value === "string") return prettifyHomePaths(value);
  if (Array.isArray(value)) return value.map(prettifyHomePathsDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = prettifyHomePathsDeep(v);
    return out;
  }
  return value;
}

function renderMarkdown(text) {
  if (typeof marked === "undefined") return escapeHtml(text);
  try {
    return openLinksInNewTab(marked.parse(text, { gfm: true, breaks: true }));
  } catch {
    return escapeHtml(text);
  }
}

function openLinksInNewTab(html) {
  // Inject target="_blank" + rel for any <a> that doesn't already have target.
  return html.replace(
    /<a\b(?![^>]*\btarget=)([^>]*)>/gi,
    '<a$1 target="_blank" rel="noopener noreferrer">',
  );
}

function highlightCodeBlocks(root) {
  if (typeof hljs === "undefined" || !root) return;
  for (const block of root.querySelectorAll("pre code")) {
    if (!shouldHighlightCodeBlock(block)) continue;
    try {
      hljs.highlightElement(block);
      block.dataset.highlighted = "yes";
    } catch {
      /* ignore */
    }
  }
}

/* ── Block renderers ─────────────────────────────── */

function renderTextBlockHtml(text) {
  return renderMarkdown(text);
}

function renderThinkingBlockHtml(text) {
  return `<div class="thinking-block">${escapeHtml(text)}</div>`;
}

function renderToolCallBlockHtml(name, input) {
  const json = JSON.stringify(prettifyHomePathsDeep(input ?? {}), null, 2);
  return `<details class="tool-block" open><summary class="tool-label">${escapeHtml(name)}</summary><pre><code class="language-json">${escapeHtml(json)}</code></pre></details>`;
}

function formatDiffHtml(diff) {
  // Render each diff line as its own block element so per-line backgrounds
  // fill the line. When hljs is available we also syntax-highlight each
  // line — language is detected once across the whole body so per-line calls
  // share a consistent grammar.
  const lines = diff.split("\n");
  let lang = null;
  if (typeof hljs !== "undefined") {
    const sample = lines.filter((l) => l.length > 0).join("\n");
    try {
      if (sample) lang = hljs.highlightAuto(sample).language || null;
    } catch {
      lang = null;
    }
  }
  return lines
    .map((line) => {
      const kind = line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : "diff-ctx";
      let body;
      if (line.length === 0) {
        body = "&nbsp;";
      } else if (lang) {
        try {
          body = hljs.highlight(line, { language: lang, ignoreIllegals: true }).value;
        } catch {
          body = escapeHtml(line);
        }
      } else {
        body = escapeHtml(line);
      }
      return `<div class="diff-line ${kind}">${body}</div>`;
    })
    .join("");
}

function renderToolResultBlockHtml(name, result) {
  if (result === null || result === undefined) {
    // Pending placeholder — keep the entry empty until tool_execution_end fills
    // it in. The surrounding section's <h3> still shows so the user sees the
    // tool was invoked.
    return "";
  }

  // For the "edit" tool, extract details (which may contain a diff) so we can
  // offer a toggle between the text output and the diff view.
  const { text: rawText, details } = extractResultParts(result);
  const isEdit = name === "edit";
  const diff = isEdit && details && details.diff ? prettifyHomePaths(details.diff) : null;

  const text = isEdit
    ? prettifyHomePaths(rawText)
    : rawText !== null
      ? prettifyHomePaths(name === "Read" ? stripCatNLinePrefixes(rawText) : rawText)
      : null;

  let toggleBtns = "";
  let contentHtml;
  let dataAttrs = "";

  if (isEdit && text && diff) {
    // Default to the diff view — that's the useful one for an edit result.
    toggleBtns = `<span class="tool-result-toggles">`
      + `<button type="button" class="toggle-btn active" data-view="diff" title="Show diff output">diff</button>`
      + `<button type="button" class="toggle-btn" data-view="text" title="Show text output">text</button>`
      + `</span>`;
    contentHtml = `<code class="diff-content">${formatDiffHtml(diff)}</code>`;
    dataAttrs = ` data-view="diff" data-has-diff="1"`;
  } else {
    if (text) {
      contentHtml = `<code>${escapeHtml(text)}</code>`;
    } else if (typeof result === "string") {
      contentHtml = `<code>${escapeHtml(prettifyHomePaths(result))}</code>`;
    } else {
      contentHtml = `<code class="language-json">${escapeHtml(JSON.stringify(prettifyHomePathsDeep(result), null, 2))}</code>`;
    }
    dataAttrs = ` data-view="single" data-has-diff="0"`;
  }

  // Store raw text/diff in data attributes so the toggle handler can swap
  // between the two views without re-rendering the whole block.
  const dataTextAttr = text
    ? ` data-text="${text.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`
    : "";
  const dataDiffAttr = diff
    ? ` data-diff="${diff.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`
    : "";
  const body = `<pre${dataAttrs}${dataTextAttr}${dataDiffAttr}>${toggleBtns}<button type="button" class="copy-btn" title="Copy">copy</button>${contentHtml}</pre>`;
  return `<details class="tool-result-block" open><summary class="tool-result-label">${escapeHtml(name)}</summary>${body}</details>`;
}

function renderBlocksHtml(blocks) {
  if (!Array.isArray(blocks)) return "";
  const parts = [];
  for (const b of blocks) {
    if (!b) continue;
    // defensive secondary filter:server 已過濾,client 再防一手(非安全機制)
    if (uiProfile?.hideThinking && b.type === "thinking") continue;
    if (uiProfile?.hideToolCalls && b.type === "tool_call") continue;
    // tool_result:白名單命中者不隱藏(server 已放行,這裡不可二次過濾掉)
    if (
      uiProfile?.hideToolCalls &&
      b.type === "tool_result" &&
      !isToolResultVisible(b, uiProfile)
    ) {
      continue;
    }
    switch (b.type) {
      case "text":
        parts.push(renderTextBlockHtml(b.text || ""));
        break;
      case "thinking":
        parts.push(renderThinkingBlockHtml(b.text || ""));
        break;
      case "tool_call":
        parts.push(renderToolCallBlockHtml(b.name, b.input));
        break;
      case "tool_result":
        parts.push(renderToolResultBlockHtml(b.name, b.result));
        break;
      case "image": {
        const mime = b.mimeType || "image/png";
        if (b.data) {
          parts.push(`<img class="message-image" alt="image" src="data:${escapeHtml(mime)};base64,${escapeHtml(b.data)}" />`);
        } else {
          parts.push(escapeHtml(`[image ${mime}]`));
        }
        break;
      }
      default:
        parts.push(`<pre><code class="language-json">${escapeHtml(JSON.stringify(b, null, 2))}</code></pre>`);
    }
  }
  return parts.join("");
}

function showToast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  toastLayer.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function syncRunningButton() {
  const running = chatState.isRunning;
  sendButton.classList.toggle("is-running", running);
  sendButton.setAttribute("aria-label", running ? "Stop" : "Send");
}

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function isLogAtBottom() {
  return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
}

// sticky follow flag: once the user scrolls away from the bottom we stop
// auto-scrolling until they return. We distinguish user-initiated scrolls
// (wheel / key / touch) from layout-induced ones (DOM mutation clamping
// scrollTop) — only the former reflect intent. Layout-induced events fire
// from the browser when scrollHeight shrinks past scrollTop and would
// otherwise mistake mid-render heights for "user scrolled away".
const followState = createFollowState();
let lastUserInputAt = 0;
const USER_INPUT_WINDOW_MS = 250;
function markUserInput() { lastUserInputAt = performance.now(); }
log.addEventListener("wheel", markUserInput, { passive: true });
log.addEventListener("touchstart", markUserInput, { passive: true });
log.addEventListener("touchmove", markUserInput, { passive: true });
window.addEventListener("keydown", (e) => {
  if (["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " "].includes(e.key)) {
    markUserInput();
  }
});
log.addEventListener("scroll", () => {
  const isUser = performance.now() - lastUserInputAt < USER_INPUT_WINDOW_MS;
  onScrollEvent(followState, {
    distanceFromBottom: log.scrollHeight - log.scrollTop - log.clientHeight,
    origin: isUser ? "user" : "layout",
  });
});

function scrollLogToBottom() {
  requestAnimationFrame(() => {
    if (!shouldAutoScroll(followState)) return;
    log.scrollTop = log.scrollHeight;
  });
}

function buildBlockNode(block, { highlightText }) {
  const wrap = document.createElement("div");
  wrap.className = "block";
  wrap.innerHTML = renderBlocksHtml([block]);
  // tool_call / tool_result are complete at build time and stable thereafter
  // (planBlockRenders will keep them on subsequent ticks), so highlight them
  // synchronously now — this is the only chance. Text/thinking blocks may
  // still be streaming; defer highlighting until they freeze.
  const isToolBlock = block?.type === "tool_call" || block?.type === "tool_result";
  if (isToolBlock || highlightText) highlightCodeBlocks(wrap);
  return wrap;
}

function reconcileBlocks(body, blocks, prevBlocks, { highlightText }) {
  const plan = planBlockRenders(blocks, prevBlocks);
  const existing = Array.from(body.children);
  const desired = plan.map((entry, i) => {
    if (entry.action === "keep" && existing[i]) return existing[i];
    return buildBlockNode(entry.block, { highlightText });
  });
  reconcileChildrenInPlace(body, desired);
}

function buildMessageElement(kind, title, blocks, { highlight = true } = {}) {
  const el = document.createElement("section");
  el.className = `message ${kind}`;
  // a11y:bubble 版型下 h3 角色標題被 CSS 視覺隱藏,靠 section 的 role/aria-label
  // 保留「誰說的」給螢幕閱讀器(需求3 V5)。
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", title);
  el.innerHTML = `<h3>${escapeHtml(title)}</h3><div class="message-body"></div>`;
  reconcileBlocks(el.querySelector(".message-body"), blocks, null, { highlightText: highlight });
  return el;
}

function updateMessageBody(el, blocks, prevBlocks, { highlight = true } = {}) {
  reconcileBlocks(el.querySelector(".message-body"), blocks, prevBlocks, { highlightText: highlight });
}

function buildTypingElement() {
  const el = document.createElement("section");
  el.className = "message assistant";
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", "Assistant");
  el.innerHTML = `<h3>Assistant</h3><div class="message-body"><span class="thinking-indicator"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span></div>`;
  return el;
}

// ── Keyed incremental rendering ───────────────────────────────────────────
// Per render we compute a desired array of DOM nodes and reconcile log's
// children against it. Element identity is preserved across renders so:
//   - <details> open/closed state survives mutations elsewhere in the log,
//   - text selection inside frozen messages is not blown away on each delta,
//   - syntax highlighting is not redone on every keystroke.

const extraEls = new WeakMap(); // chat-state extra item -> { el, blocks }
let canonicalEls = [];          // index-aligned [{ el, message }, ...]
let typingEl = null;

function reconcileChildren(parent, desired) {
  // Walk desired list; ensure each element sits at the matching index.
  // insertBefore moves an existing child rather than cloning.
  for (let i = 0; i < desired.length; i++) {
    const want = desired[i];
    const cur = parent.childNodes[i];
    if (cur === want) continue;
    parent.insertBefore(want, cur || null);
  }
  while (parent.childNodes.length > desired.length) {
    parent.removeChild(parent.lastChild);
  }
}

function renderLog() {
  const items = csSelectItems(chatState);

  // Items whose blocks may still mutate in place — we always re-render them
  // and skip syntax highlighting (partial code/JSON) until they freeze.
  // Today this is just the live assistant entry; tool_call and tool_result
  // are nested blocks inside it rather than separate items.
  const liveItems = new Set();
  if (chatState.liveAssistant) liveItems.add(chatState.liveAssistant);

  const newCanonicalEls = [];
  let canonicalIdx = 0;
  const desired = [];

  for (const it of items) {
    let el;
    if (it.source === "canonical") {
      const r = formatMessage(it.message);
      // issue #2 B:渲染後無可見內容的 assistant 不掛裸 header
      // (thinking/tool 在 customer 模式摺疊後會留下空殼「Assistant」)。
      if (r.kind === "assistant" && !hasVisibleContent(r.blocks, uiProfile)) continue;
      const prev = canonicalEls[canonicalIdx];
      if (prev && prev.message === it.message) {
        // Same SDK message reference — reuse the DOM node as-is. The SDK
        // replaces the messages array wholesale on each snapshot, so this
        // path is taken only when selectItems is called twice without an
        // intervening setHistory (cheap re-render).
        el = prev.el;
      } else {
        el = buildMessageElement(r.kind, r.title, r.blocks);
      }
      newCanonicalEls.push({ el, message: it.message });
      canonicalIdx += 1;
    } else if (it.source === "extra") {
      const item = it.item;
      const isLive = liveItems.has(item);
      // issue #2 B + §四-2:渲染後無可見內容的 assistant 不掛裸 header / 空 bubble,
      // 含 streaming 中的 live assistant。§四-1 讓 hideThinking/hideToolCalls 下
      // thinking/tool delta 不再建立 liveAssistant(改由 server drop),空窗期間 typing
      // indicator 頂著,故空 live 直接跳過不會造成「無回饋」,反而消掉 bubble 版型下
      // 的空殼氣泡。有文字時(text_delta)才建 live,一律有可見內容。
      if (item.kind === "assistant" && !hasVisibleContent(item.blocks, uiProfile)) continue;
      const cached = extraEls.get(item);
      if (!cached) {
        el = buildMessageElement(item.kind, item.title, item.blocks, { highlight: !isLive });
        extraEls.set(item, {
          el,
          blocks: item.blocks,
          // Snapshot per-block refs so planBlockRenders can detect which
          // positions are stable across deltas (chat-state mutates the
          // blocks array in place, so the array reference alone is
          // useless for change detection).
          blocksSnapshot: item.blocks.slice(),
          wasLive: isLive,
        });
      } else {
        el = cached.el;
        const { rerender, highlight } = decideExtraItemRender(cached, item, isLive);
        if (rerender) {
          updateMessageBody(el, item.blocks, cached.blocksSnapshot, { highlight });
          cached.blocks = item.blocks;
          cached.blocksSnapshot = item.blocks.slice();
        }
        cached.wasLive = isLive;
      }
    } else { // typing
      if (!typingEl) typingEl = buildTypingElement();
      el = typingEl;
    }
    desired.push(el);
  }

  canonicalEls = newCanonicalEls;
  reconcileChildren(log, desired);
  syncRunningButton();
  scrollLogToBottom();
}

function handleSessionEvent(event) {
  // Side-effect-free chat-state mutations go through the dispatcher so they
  // can be unit-tested without DOM. UI-only effects (toasts, status bar,
  // ad-hoc error entries) stay here.
  switch (event?.type) {
    case "agent_start":
      logger.info("turn start");
      dispatchSessionEvent(chatState, event);
      renderLog();
      return;
    case "agent_end":
      logger.info("turn end");
      dispatchSessionEvent(chatState, event);
      renderLog();
      return;
    case "tool_execution_start":
      logger.info("tool start", { tool: event.toolName || event.name });
      dispatchSessionEvent(chatState, event);
      renderLog();
      return;
    case "tool_execution_end":
      logger.info("tool end", {
        tool: event.toolName || event.name,
        ok: !event.error,
        error: event.error?.message,
      });
      // 白名單 tool 在 hideToolCalls 下由 server 放行成 session_event,不會再送
      // tool_progress end packet;start 建立的 spinner 要在這裡自己收掉,
      // 否則會永遠轉下去。非白名單情境本來就沒有對應節點,呼叫是 no-op。
      handleToolProgress({ id: event.toolCallId, phase: "end" });
      dispatchSessionEvent(chatState, event);
      renderLog();
      return;
    case "message_update":
      logger.debug("message update");
      dispatchSessionEvent(chatState, event);
      renderLog();
      return;
    case "compaction_start":
      logger.info("compaction start");
      showToast("Compaction started", "info");
      return;
    case "compaction_end":
      logger.info("compaction end");
      showToast("Compaction complete", "info");
      return;
    case "extension_error": {
      const msg = event.error?.message || JSON.stringify(event, null, 2);
      logger.error("extension error", { error: event.error?.message });
      csSetError(chatState, event.error?.message || "Extension error");
      chatState.streamExtras.push({
        kind: "error",
        title: "Extension error",
        blocks: [{ type: "text", text: msg }],
      });
      renderLog();
      renderStatusBar();
      return;
    }
    case "auto_retry_start":
      logger.warn("auto retry", { attempt: event.attempt, error: event.error?.message });
      csSetError(chatState, `retrying (attempt ${event.attempt ?? "?"}): ${event.error?.message || "model error"}`);
      renderStatusBar();
      return;
    default:
      logger.debug(`event ${event?.type}`);
      return;
  }
}

// tool_progress packet 對應 UI:start 時把帶 spinner 的 block 插到 log 末尾,
// progress 更新同一個 block 內的 label text,end 時拿掉。
// client 不嘗試在 chat-state 內維護它(它不參與 message 結構);
// 純粹是 ephemeral 提示,server reset / 切 session 時整批清掉。
function handleToolProgress(payload) {
  if (!payload || typeof payload !== "object") return;
  const id = String(payload.id ?? "");
  if (!id) return;
  if (payload.phase === "start") {
    if (toolProgressNodes.has(id)) return;
    const el = document.createElement("div");
    el.className = "tool-progress-block";
    el.innerHTML = `<span class="spinner"></span><span class="tool-progress-label"></span>`;
    el.querySelector(".tool-progress-label").textContent = String(payload.label ?? "");
    log.appendChild(el);
    toolProgressNodes.set(id, el);
    scrollLogToBottom();
  } else if (payload.phase === "progress") {
    // 已存在 block 才更新;沒有對應 start 的 progress 直接 ignore(不主動建)
    const el = toolProgressNodes.get(id);
    if (!el) return;
    const labelEl = el.querySelector(".tool-progress-label");
    if (labelEl) labelEl.textContent = String(payload.label ?? "");
  } else if (payload.phase === "end") {
    const el = toolProgressNodes.get(id);
    if (el) {
      el.remove();
      toolProgressNodes.delete(id);
    }
  }
}

// 把 server 告知的 brand 套到頁面:CSS var、header DOM、document.title。
// brand.color 為 backward-compat shim,新版以 brand.tokens.accent 為準。其他欄位(name / logoUrl)任一為 null/空 都當「未設定」處理。
// Task 2.4:額外支援 brand.tokens(多個 CSS var)、brand.mode(colorScheme)、brand.css(動態 link)。
function applyBranding(brand) {
  if (!brand) return;

  // brand.tokens:把 profile 傳來的 token map 全寫進 :root CSS var
  // 格式: { accent: "#ff0000", ... } → --accent: #ff0000
  if (brand.tokens && typeof brand.tokens === "object") {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(brand.tokens)) {
      root.style.setProperty(`--${k}`, v);
    }
    // tokens.accent 同時對應舊欄位 --brand-color,讓既有 CSS 樣式不需改動
    if (brand.tokens.accent) {
      root.style.setProperty("--brand-color", brand.tokens.accent);
    }
  }

  // brand.color:backward-compat shim(server 仍會送 tokens.accent ?? null)
  // 若 tokens.accent 已寫入就跳過,避免重複 setProperty
  if (brand.color && !(brand.tokens && brand.tokens.accent)) {
    document.documentElement.style.setProperty("--brand-color", brand.color);
  }

  // brand.mode:套用 colorScheme("light" | "dark" | null)
  // 空字串讓瀏覽器回到 auto,確保熱重載移除 mode 時能正確重置
  document.documentElement.style.colorScheme = brand.mode || "";

  // brand.css:動態載入 /brand/theme.css 覆蓋層
  // 避免重複插入:先確認 head 裡是否已有相同 href
  if (brand.css === true) {
    const existing = document.head.querySelector(`link[href="${BASE}/brand/theme.css"]`);
    if (!existing) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `${BASE}/brand/theme.css`;
      document.head.appendChild(link);
    }
  }

  // 以下為既有 DOM 邏輯:brandHeader 可見性、brandName/brandLogo 顯示
  const hasName = !!brand.name;
  const hasLogo = !!brand.logoUrl;
  if (hasName || hasLogo) {
    brandHeader.classList.add("is-visible");
    if (hasName) {
      brandName.textContent = brand.name;
      brandName.hidden = false;
      document.title = brand.name;
    } else {
      brandName.textContent = "";
      brandName.hidden = true;
    }
    if (hasLogo) {
      brandLogo.src = brand.logoUrl;
      brandLogo.hidden = false;
    } else {
      brandLogo.removeAttribute("src");
      brandLogo.hidden = true;
    }
  } else {
    brandHeader.classList.remove("is-visible");
    brandName.textContent = "";
    brandName.hidden = true;
    brandLogo.removeAttribute("src");
    brandLogo.hidden = true;
  }
}

// 對話版型:server 送 uiProfile.chatLayout("bubble" | "log")。寫成 <html> 的
// data-chat-layout 屬性,由 styles.css 依此切 bubble(左右氣泡)/ log(工程師視圖)。
// 舊版 server 沒送就維持預設 log。
function applyChatLayout() {
  const layout = uiProfile?.chatLayout === "bubble" ? "bubble" : "log";
  document.documentElement.setAttribute("data-chat-layout", layout);
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const url = `${protocol}://${location.host}${BASE}/ws`;
  logger.info("ws connecting", { url });
  socket = new WebSocket(url);

  socket.addEventListener("open", () => {
    logger.info("ws open", { lastSeq });
    const banner = document.getElementById("disconnected-banner");
    if (banner) banner.style.display = "none";
    // Tell the server where our event-log cursor is. If it can replay missed
    // events, we keep all streamed UI state. Otherwise it'll send a
    // session_reset followed by a fresh bootstrap.
    send({ type: "ready", lastSeq, sessionFile: loadStoredSessionFile() });
  });

  socket.addEventListener("message", (message) => {
    const packet = JSON.parse(message.data);

    switch (packet.type) {
      case "connected":
        slashCommands = packet.payload.slashCommands || [];
        homeDir = packet.payload.homeDir || "";
        sandboxInfo = packet.payload.sandbox || null;
        tunnelInfo = packet.payload.tunnel || null;
        // 客戶導向 UI profile;server 沒送(舊版相容)就保留模組層級的全 false 預設。
        if (packet.payload.uiProfile) {
          uiProfile = packet.payload.uiProfile;
        }
        // 一般檔案上傳設定:server 沒送(舊版相容)時保留 module-level defaults。
        if (packet.payload.uploads) {
          const u = packet.payload.uploads;
          uploadConfig = {
            allowedExtensions: new Set(
              Array.isArray(u.allowedExtensions)
                ? u.allowedExtensions.map((s) => String(s).toLowerCase())
                : DEFAULT_UPLOAD_EXTENSIONS,
            ),
            maxBytes: Number(u.maxBytes) || uploadConfig.maxBytes,
            maxFiles: Number(u.maxFiles) || uploadConfig.maxFiles,
            subdir: typeof u.subdir === "string" && u.subdir ? u.subdir : uploadConfig.subdir,
          };
          // 讓 file picker 預設只看允許的副檔名;不阻擋使用者點 "All files"
          const accept = [...uploadConfig.allowedExtensions].map((e) => `.${e}`).join(",");
          const picker = document.getElementById("file-picker");
          if (picker) picker.setAttribute("accept", accept);
        }
        // hideModel 沿用既有變數;優先取 uiProfile.hideModel,fallback 到舊欄位。
        hideModel = !!(uiProfile?.hideModel ?? packet.payload.hideModel);
        applyBranding(uiProfile.brand);
        applyChatLayout();
        renderSandboxChip();
        renderTunnelChip();
        logger.info("connected", {
          appCwd: packet.payload.appCwd,
          agentDir: packet.payload.agentDir,
          slashCommandCount: slashCommands.length,
          hideModel,
          sandbox: sandboxInfo,
          uiProfile,
        });
        if (sandboxInfo) {
          if (sandboxInfo.error) {
            showToast(`Sandbox init failed: ${sandboxInfo.error}`, "error");
          } else if (sandboxInfo.enabled) {
            const ws = sandboxInfo.workspace || "(unknown)";
            showToast(`Sandbox 模式已啟用 (workspace: ${ws})`, "info");
          }
        }
        if (packet.payload.diagnostics?.length) {
          for (const d of packet.payload.diagnostics) {
            logger.warn("startup diagnostic", { diagnostic: d });
          }
          showToast(`${packet.payload.diagnostics.length} startup diagnostic(s)`, "warning");
        }
        // issue #2 P1:模型 registry 找不到時 server 主動帶警告,UI 明確報錯
        // (不再靜默 fallback)。訊息已在 server 端依 hideModel 決定是否含 model 名。
        if (packet.payload.modelWarning) {
          logger.warn("model resolve warning", { warning: packet.payload.modelWarning });
          showToast(packet.payload.modelWarning, "error");
          csSetError(chatState, packet.payload.modelWarning);
          renderStatusBar();
        }
        return;
      case "session_state": {
        const prev = currentSessionState;
        const next = packet.payload;
        const prevModel = prev?.model ? `${prev.model.provider}/${prev.model.id}` : null;
        const nextModel = next?.model ? `${next.model.provider}/${next.model.id}` : null;
        if (prevModel !== nextModel) {
          logger.info("model changed", { from: prevModel, to: nextModel });
        }
        if (prev?.sessionId !== next?.sessionId) {
          logger.info("session changed", {
            sessionId: next?.sessionId,
            sessionFile: next?.sessionFile || null,
          });
        }
        currentSessionState = next;
        saveStoredSessionFile(extractSessionFileFromState(next));
        renderStatusBar();
        return;
      }
      case "message_history":
        csSetHistory(chatState, packet.payload || []);
        renderLog();
        return;
      case "session_reset":
        // Server is telling us to drop streamed UI state — cold start,
        // session switch, or replay miss.
        logger.info("session reset", { currentSeq: packet.payload?.currentSeq ?? null });
        csResetHistory(chatState, []);
        // 把進行中的 tool_progress 也整批清掉(切 session / cold start)。
        for (const el of toolProgressNodes.values()) el.remove();
        toolProgressNodes.clear();
        if (typeof packet.payload?.currentSeq === "number") {
          lastSeq = packet.payload.currentSeq;
        } else {
          lastSeq = null;
        }
        renderLog();
        return;
      case "replay_done":
        logger.info("replay done", { currentSeq: packet.payload?.currentSeq ?? null });
        if (typeof packet.payload?.currentSeq === "number") {
          lastSeq = packet.payload.currentSeq;
        }
        return;
      case "session_event":
        if (typeof packet.seq === "number") lastSeq = packet.seq;
        handleSessionEvent(packet.payload);
        return;
      case "tool_progress":
        // server 在 hideToolCalls + showToolProgress 時轉 tool_execution_* 為 progress packet。
        // start:插入帶 spinner 的 progress block;progress:更新 label;end:移掉對應 block。
        handleToolProgress(packet.payload);
        return;
      case "list_dir_result":
        handleListDirResult(packet.payload);
        return;
      case "command_result":
        if (!packet.payload.ok) {
          const msg = packet.payload.error || `${packet.payload.command} failed`;
          logger.warn("command failed", { command: packet.payload.command, error: msg });
          showToast(msg, "error");
          csSetError(chatState, msg);
          renderStatusBar();
        } else {
          handleSlashResult(packet.payload.data);
        }
        return;
      case "prompt_preflight":
        if (!packet.payload.success) {
          showToast("Prompt was rejected before execution", "warning");
        }
        return;
      case "server_error":
        logger.error("server error", { message: String(packet.payload) });
        showToast(packet.payload, "error");
        csSetError(chatState, String(packet.payload));
        renderStatusBar();
        return;
      case "ext_ui_request":
        handleExtUiRequest(packet.payload);
        return;
      case "ext_ui_notify":
        showToast(packet.payload?.message || "", packet.payload?.type || "info");
        return;
      case "ext_ui_title":
        if (packet.payload?.title) document.title = String(packet.payload.title);
        return;
      case "ext_ui_cancel":
        if (activeExtUiRequestId === packet.payload?.id) closeModal();
        return;
      case "ext_ui_custom_open":
        customOverlay.open(packet.payload || {});
        return;
      case "ext_ui_custom_update":
        customOverlay.update(packet.payload || {});
        return;
      case "ext_ui_custom_close":
        customOverlay.close(packet.payload || {});
        return;
      case "tunnel_state":
        tunnelInfo = { enabled: true, ...packet.payload };
        renderTunnelChip();
        return;
      default:
        return;
    }
  });

  socket.addEventListener("close", (event) => {
    logger.warn("ws close", { code: event.code, reason: event.reason || undefined });
    csSetError(chatState, "disconnected from server");
    dispatchSessionEvent(chatState, { type: "agent_end" });
    renderLog();
    renderStatusBar();
    const banner = document.getElementById("disconnected-banner");
    if (banner) banner.style.display = "block";
    // Auto-reconnect after a short delay
    logger.info("ws reconnect scheduled", { delayMs: 1000 });
    setTimeout(connect, 1000);
  });

  socket.addEventListener("error", () => {
    logger.error("ws error");
    csSetError(chatState, "websocket error");
    dispatchSessionEvent(chatState, { type: "agent_end" });
    renderLog();
    renderStatusBar();
  });
}

function openModal(items, opts = {}) {
  if (typeof opts === "function") opts = { onSelect: opts };
  modalItems = items;
  modalMulti = !!opts.multi;
  modalOnSelect = opts.onSelect || null;
  modalOnCommit = opts.onCommit || null;
  modalSelected = new Set(opts.initiallySelected || []);
  modalSearch.value = "";
  modalIndex = 0;
  filterModal();
  modal.hidden = false;
  modalSearch.focus();
}

function closeModal() {
  modal.hidden = true;
  modalDialog.classList.remove("text-mode");
  modalDialog.classList.remove("prompt-mode");
  modalDialog.classList.remove("confirm-mode");
  modalTitle.textContent = "";
  modalItems = [];
  modalFiltered = [];
  modalOnSelect = null;
  modalOnCommit = null;
  modalMulti = false;
  modalSelected = new Set();
  modalInputOverride = null;
  modalCommitOverride = null;
  modalTabHandler = null;
  cwdPickerState = null;
  input.focus();
  modalCtrl.dismiss();
}

function filterModal() {
  if (modalInputOverride) {
    modalInputOverride(modalSearch.value);
    return;
  }
  const q = modalSearch.value.trim().toLowerCase();
  modalFiltered = q
    ? modalItems.filter((it) => it.search.toLowerCase().includes(q))
    : modalItems.slice();
  if (modalIndex >= modalFiltered.length) modalIndex = 0;
  renderModal();
}

function renderModal() {
  modalBody.innerHTML = "";
  if (modalFiltered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "modal-empty";
    empty.textContent = "No matches";
    modalBody.appendChild(empty);
    return;
  }
  let activeEl = null;
  modalFiltered.forEach((item, i) => {
    const row = document.createElement("div");
    const isSelected = modalMulti && modalSelected.has(item.target);
    const cls = [
      "session-row",
      i === modalIndex ? "active" : "",
      item.current ? "current" : "",
      isSelected ? "selected" : "",
    ].filter(Boolean).join(" ");
    row.className = cls;
    const checkbox = modalMulti ? `<span class="modal-check">${isSelected ? "[x]" : "[ ]"}</span>` : "";
    row.innerHTML = checkbox + item.html;
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      modalIndex = i;
      if (modalMulti) {
        toggleSelected();
      } else {
        commitModal();
      }
    });
    modalBody.appendChild(row);
    if (i === modalIndex) activeEl = row;
  });
  activeEl?.scrollIntoView({ block: "nearest" });
}

function toggleSelected() {
  const item = modalFiltered[modalIndex];
  if (!item) return;
  if (modalSelected.has(item.target)) modalSelected.delete(item.target);
  else modalSelected.add(item.target);
  renderModal();
}

function commitModal() {
  if (modalCommitOverride) {
    modalCommitOverride();
    return;
  }
  if (modalMulti) {
    const cb = modalOnCommit;
    const selected = [...modalSelected];
    modalCtrl.commit();
    closeModal();
    cb?.(selected);
    return;
  }
  const item = modalFiltered[modalIndex];
  if (!item) return;
  const cb = modalOnSelect;
  modalCtrl.commit();
  closeModal();
  cb?.(item);
}

modalSearch.addEventListener("input", filterModal);

modalSearch.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (modalFiltered.length > 0) {
      modalIndex = (modalIndex + 1) % modalFiltered.length;
      renderModal();
    }
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (modalFiltered.length > 0) {
      modalIndex = (modalIndex - 1 + modalFiltered.length) % modalFiltered.length;
      renderModal();
    }
  } else if (event.key === "PageDown") {
    event.preventDefault();
    if (modalFiltered.length > 0) {
      modalIndex = Math.min(modalFiltered.length - 1, modalIndex + MODAL_PAGE_SIZE);
      renderModal();
    }
  } else if (event.key === "PageUp") {
    event.preventDefault();
    if (modalFiltered.length > 0) {
      modalIndex = Math.max(0, modalIndex - MODAL_PAGE_SIZE);
      renderModal();
    }
  } else if (event.key === " " && modalMulti) {
    event.preventDefault();
    toggleSelected();
  } else if (event.key === "Enter") {
    event.preventDefault();
    commitModal();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeModal();
  }
});

modalSearch.addEventListener("keydown", (event) => {
  if (event.key === "Tab" && modalTabHandler) {
    event.preventDefault();
    event.stopImmediatePropagation();
    modalTabHandler(event.shiftKey);
  }
});

modal.addEventListener("click", (event) => {
  if (event.target === modal) {
    closeModal();
    input.focus();
  }
});

function formatRelativeTime(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch {
    return iso;
  }
}

function showSessionPicker(payload) {
  // 客戶導向 profile:session picker 整個禁用
  if (uiProfile?.hideSessionPicker) {
    showToast("Session picker disabled by UI profile", "info");
    return;
  }
  const merged = [];
  const seen = new Set();
  const lists = [payload.sessions?.currentProject || [], payload.sessions?.allProjects || []];
  for (const list of lists) {
    for (const s of list) {
      if (seen.has(s.path)) continue;
      seen.add(s.path);
      merged.push(s);
    }
  }
  merged.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));

  const items = merged.map((s) => {
    const title = s.name || s.firstMessage || `${(s.id || "").slice(0, 8)}…`;
    const time = formatRelativeTime(s.modified);
    return {
      path: s.path,
      current: s.path === payload.currentSessionFile,
      search: `${title} ${s.cwd || ""} ${s.id || ""}`,
      html: `
        <div>
          <div class="session-title">${escapeHtml(title)}</div>
          <div class="session-cwd">${escapeHtml(displayPath(s.cwd || ""))}</div>
        </div>
        <div class="session-meta">${escapeHtml(time)} · ${escapeHtml(String(s.messageCount ?? 0))} msg</div>
      `,
    };
  });

  if (items.length === 0) {
    showToast("No sessions to resume", "info");
    return;
  }

  openModal(items, (item) => {
    send({ type: "slash_command", name: "resume", arg: item.path });
  });
}

function renderSandboxChip() {
  if (!statusSandbox) return;
  // 客戶導向 profile:status chip 整組隱藏
  if (uiProfile?.hideStatusChips) {
    statusSandbox.hidden = true;
    statusSandbox.textContent = "";
    statusSandbox.title = "";
    statusSandbox.classList.remove("error");
    return;
  }
  if (!sandboxInfo) {
    statusSandbox.hidden = true;
    statusSandbox.textContent = "";
    statusSandbox.title = "";
    statusSandbox.classList.remove("error");
    return;
  }
  if (sandboxInfo.error) {
    statusSandbox.hidden = false;
    statusSandbox.textContent = "sandbox: error";
    statusSandbox.title = `Sandbox init failed: ${sandboxInfo.error}`;
    statusSandbox.classList.add("error");
    return;
  }
  if (sandboxInfo.enabled) {
    statusSandbox.hidden = false;
    statusSandbox.textContent = "sandbox";
    statusSandbox.title = `workspace: ${sandboxInfo.workspace || "(unknown)"} → ${sandboxInfo.guestPath || "/workspace"}`;
    statusSandbox.classList.remove("error");
    return;
  }
  statusSandbox.hidden = true;
}

function renderTunnelChip() {
  if (!statusTunnel) return;
  // 客戶導向 profile:status chip 整組隱藏
  if (uiProfile?.hideStatusChips) {
    statusTunnel.hidden = true;
    statusTunnel.textContent = "";
    statusTunnel.title = "";
    statusTunnel.removeAttribute("data-phase");
    statusTunnel.onclick = null;
    return;
  }
  if (!tunnelInfo || !tunnelInfo.enabled) {
    statusTunnel.hidden = true;
    statusTunnel.textContent = "";
    statusTunnel.title = "";
    statusTunnel.removeAttribute("data-phase");
    statusTunnel.onclick = null;
    return;
  }
  statusTunnel.hidden = false;
  const phase = tunnelInfo.phase || "starting";
  statusTunnel.dataset.phase = phase;
  let label = "tunnel: ?";
  let tooltip = "";
  let clickHandler = null;
  switch (phase) {
    case "starting":
      label = "tunnel: connecting...";
      tooltip = "Waiting for cloudflared to report URL";
      break;
    case "active": {
      const url = tunnelInfo.url || "";
      let host = url;
      try {
        host = new URL(url).host;
      } catch {
        /* keep url as host */
      }
      label = `tunnel: ${host}`;
      tooltip = `${url}\n(click to copy)`;
      clickHandler = async () => {
        try {
          await navigator.clipboard.writeText(url);
          showToast?.("tunnel URL copied", "info");
        } catch {
          /* clipboard denied */
        }
      };
      break;
    }
    case "stopping":
      label = "tunnel: stopping...";
      tooltip = "";
      break;
    case "error":
      label = "tunnel: error";
      tooltip = tunnelInfo.error || "Tunnel error";
      break;
    case "stopped":
      label = "tunnel: stopped";
      tooltip = "Tunnel was stopped";
      break;
  }
  statusTunnel.textContent = label;
  statusTunnel.title = tooltip;
  statusTunnel.onclick = clickHandler;
}

function renderStatusBar() {
  statusError.textContent = chatState.lastError || "";
  statusError.title = chatState.lastError || "";
  // 客戶導向 profile:整列 cwd / left / right 都藏,但 error 還是顯示
  if (uiProfile?.hideStatusChips) {
    statusLeft.textContent = "";
    statusRight.textContent = "";
    statusCwd.textContent = "";
    return;
  }
  const s = currentSessionState;
  if (!s) {
    statusLeft.textContent = "";
    statusRight.textContent = "";
    statusCwd.textContent = "";
    return;
  }
  statusCwd.textContent = displayPath(s.cwd || "");
  const ctx = s.contextUsage;
  const pct = ctx?.percent ?? 0;
  const window = ctx?.contextWindow || s.model?.contextWindow || 0;
  const windowK = window ? `${Math.round(window / 1000)}k` : "?";
  const mode = s.autoCompactionEnabled ? "auto" : "off";
  const pctClass = pct >= 90 ? "danger" : pct >= 70 ? "warn" : "";
  statusLeft.innerHTML =
    `<span class="status-pct ${pctClass}">${pct.toFixed(1)}%</span>` +
    `<span class="status-mode">/${windowK} (${escapeHtml(mode)})</span>`;

  const name = s.sessionName ? `(${s.sessionName})` : "";
  const model = s.model ? `${s.model.provider}/${s.model.id}` : "(no model)";
  const think = s.thinkingLevel || "off";
  const modelSpan = hideModel
    ? ""
    : `<span class="status-model">${escapeHtml(model)}</span> `;
  statusRight.innerHTML =
    `<span class="status-name">${escapeHtml(name)}</span> ` +
    modelSpan +
    `<span class="status-mode">•</span> ` +
    `<span class="status-thinking">${escapeHtml(think)}</span>`;
}

function showForkPicker(payload) {
  const messages = payload.messages || [];
  if (messages.length === 0) {
    showToast("No user messages to fork from", "info");
    return;
  }
  const items = messages.map((m, i) => ({
    target: m.entryId,
    search: m.text,
    html: `
      <div>
        <div class="session-title">${escapeHtml(`#${i + 1} ${m.text.slice(0, 80)}`)}</div>
        <div class="session-cwd">${escapeHtml(m.entryId)}</div>
      </div>
      <div class="session-meta">fork before</div>
    `,
  }));
  openModal(items, (item) => {
    send({ type: "slash_command", name: "fork", arg: item.target });
  });
}

function showTreePicker(payload) {
  const tree = payload.tree || [];
  if (tree.length === 0) {
    showToast("No entries in session", "info");
    return;
  }
  const items = tree.map((node) => {
    const isLeaf = node.id === payload.leafId;
    const summary = node.summary || node.text || node.role || node.kind || node.id;
    return {
      target: node.id,
      current: isLeaf,
      search: `${node.id} ${summary || ""}`,
      html: `
        <div>
          <div class="session-title">${escapeHtml(String(summary || node.id).slice(0, 100))}</div>
          <div class="session-cwd">${escapeHtml(node.id)}</div>
        </div>
        <div class="session-meta">${escapeHtml(node.kind || node.role || "")}</div>
      `,
    };
  });
  openModal(items, (item) => {
    send({ type: "slash_command", name: "tree", arg: item.target });
  });
}

function showScopedModelsPicker(payload) {
  const models = payload.models || [];
  const enabled = payload.enabled || [];
  const items = models.map((m) => {
    const id = `${m.provider}/${m.id}`;
    return {
      target: id,
      search: `${id} ${m.name}`,
      html: `
        <div>
          <div class="session-title">${escapeHtml(m.name)}</div>
          <div class="session-cwd">${escapeHtml(id)}</div>
        </div>
      `,
    };
  });
  openModal(items, {
    multi: true,
    initiallySelected: enabled,
    onCommit: (selected) => {
      send({ type: "slash_command", name: "scoped-models", arg: selected.join(",") });
    },
  });
}

function showHotkeysModal() {
  const items = [
    { keys: "Enter", desc: "Newline in input (送出請點右下角 send 按鈕)" },
    { keys: "Tab", desc: "Complete slash command" },
    { keys: "↑ / ↓", desc: "Navigate slash menu / picker" },
    { keys: "Esc", desc: "Abort running session / close picker" },
    { keys: "/", desc: "Open slash command list" },
  ].map((h) => ({
    target: h.keys,
    search: `${h.keys} ${h.desc}`,
    html: `
      <div>
        <div class="session-title">${escapeHtml(h.desc)}</div>
      </div>
      <div class="session-meta">${escapeHtml(h.keys)}</div>
    `,
  }));
  openModal(items, () => {});
}

function showTextModal(title, body) {
  modalDialog.classList.add("text-mode");
  modalTitle.textContent = title || "";
  modalBody.innerHTML = `<pre style="margin:0;padding:0.75rem;white-space:pre-wrap;word-break:break-word;color:var(--text);">${escapeHtml(body || "")}</pre>`;
  modal.hidden = false;
  modalDialog.tabIndex = -1;
  modalDialog.focus();
}

const customOverlay = createCustomOverlayHost({
  root: document.body,
  send: (msg) => send(msg),
});

// Tracks the currently-displayed extension UI request so the server can
// cancel it (via ext_ui_cancel) and so closeModal-without-commit can send a
// cancellation response automatically.
let activeExtUiRequestId = null;

function handleExtUiRequest(payload) {
  if (!payload || !payload.id) return;
  const id = payload.id;
  let settled = false;
  const reply = (value) => {
    if (settled) return;
    settled = true;
    if (activeExtUiRequestId === id) activeExtUiRequestId = null;
    send({ type: "ext_ui_response", payload: { id, value } });
  };
  // If the modal closes for any reason without a commit (Escape, click-out),
  // resolve the request as cancelled with the kind-appropriate "no answer".
  const cancelValue = payload.kind === "confirm" ? false : undefined;
  modalCtrl.setOnCancel(() => reply(cancelValue));
  activeExtUiRequestId = id;

  switch (payload.kind) {
    case "notify":
      showToast(payload.message || "", payload.type || "info");
      reply(undefined);
      modalCtrl.setOnCancel(null);
      activeExtUiRequestId = null;
      return;
    case "confirm":
      showConfirmModal(payload.title || "", payload.message || "", (yes) => reply(!!yes));
      return;
    case "input":
      showPromptModal(payload.title || "", payload.placeholder || "", (value) => reply(value));
      return;
    case "select": {
      const items = (payload.options || []).map((opt) => ({
        target: opt,
        search: opt,
        html: escapeHtml(opt),
      }));
      modalTitle.textContent = payload.title || "";
      openModal(items, (item) => reply(item?.target));
      return;
    }
    default:
      reply(undefined);
  }
}

function showConfirmModal(title, message, onResult) {
  modalDialog.classList.add("confirm-mode");
  modalTitle.textContent = title || "";
  modalBody.innerHTML = "";
  const msg = document.createElement("div");
  msg.className = "modal-confirm-message";
  msg.textContent = message || "";
  const buttons = document.createElement("div");
  buttons.className = "modal-confirm-buttons";
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "modal-confirm-yes";
  yes.textContent = "Confirm";
  const no = document.createElement("button");
  no.type = "button";
  no.className = "modal-confirm-no";
  no.textContent = "Cancel";
  buttons.append(no, yes);
  modalBody.append(msg, buttons);
  modal.hidden = false;
  yes.focus();
  const finish = (value) => {
    closeModal();
    onResult?.(value);
  };
  yes.addEventListener("click", () => finish(true));
  no.addEventListener("click", () => finish(false));
  modalDialog.tabIndex = -1;
  modalDialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    } else if (event.key === "Enter") {
      event.preventDefault();
      finish(document.activeElement === no ? false : true);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Tab") {
      event.preventDefault();
      (document.activeElement === yes ? no : yes).focus();
    }
  });
}

function showPromptModal(title, initialValue, onSubmit) {
  modalDialog.classList.add("prompt-mode");
  modalTitle.textContent = title || "";
  modalBody.innerHTML = "";
  const field = document.createElement("input");
  field.type = "text";
  field.className = "modal-prompt-input";
  field.value = initialValue ?? "";
  modalBody.appendChild(field);
  modal.hidden = false;
  field.focus();
  field.select();
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const value = field.value;
      closeModal();
      onSubmit?.(value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
    }
  });
}

async function handleSlashResult(data) {
  if (!data) return;
  if (data.copyText) {
    try {
      await navigator.clipboard.writeText(data.copyText);
      showToast("Copied to clipboard", "info");
    } catch {
      showToast("Clipboard write blocked by browser", "error");
    }
    return;
  }
  if (data.exportedTo) {
    showToast(`Exported (${data.format}): ${data.exportedTo}`, "info");
    return;
  }
  if (data.showHotkeys) {
    showHotkeysModal();
    return;
  }
  if (data.showText) {
    showTextModal(data.showText.title, data.showText.body);
    return;
  }
  if (typeof data.editorText === "string" && data.editorText.length > 0) {
    input.value = data.editorText;
    input.style.height = "36px";
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
    input.focus();
  }
  if (data.needsPicker === "session") return showSessionPicker(data);
  if (data.needsPicker === "model") return showModelPicker(data);
  if (data.needsPicker === "fork") return showForkPicker(data);
  if (data.needsPicker === "tree") return showTreePicker(data);
  if (data.needsPicker === "scoped-models") return showScopedModelsPicker(data);
  if (data.needsPicker === "logout") return showLogoutPicker(data);
  if (data.needsPicker === "cwd") return showCwdPicker(data);
  if (typeof data.cwd === "string" && data.cwd) {
    if (data.unchanged) showToast(`cwd already ${displayPath(data.cwd)}`, "info");
    else showToast(`cwd → ${displayPath(data.cwd)}`, "info");
    return;
  }
}

function submitCwd(target) {
  const arg = String(target || "").trim();
  if (!arg) return;
  send({ type: "slash_command", name: "cwd", arg });
}

function expandTildeClient(p, home) {
  if (!p || !home) return p;
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + "/" + p.slice(2);
  return p;
}

function splitCwdInput(value, home) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const expanded = expandTildeClient(trimmed, home);
  if (!expanded.startsWith("/")) return null;
  const lastSlash = expanded.lastIndexOf("/");
  const parent = lastSlash === 0 ? "/" : expanded.slice(0, lastSlash);
  const basename = expanded.slice(lastSlash + 1);
  return { parent, basename };
}

function recentCwdItem(c, currentCwd) {
  const time = formatRelativeTime(new Date(c.modified).toISOString());
  const pretty = displayPath(c.cwd);
  return {
    target: c.cwd,
    current: c.cwd === currentCwd,
    search: `${pretty} ${c.cwd}`,
    html: `
      <div>
        <div class="session-title">${escapeHtml(pretty)}</div>
        <div class="session-cwd">${escapeHtml(c.cwd)}</div>
      </div>
      <div class="session-meta">${escapeHtml(time)} · ${escapeHtml(String(c.count))} session${c.count === 1 ? "" : "s"}</div>
    `,
  };
}

function dirEntryItem(entry, current) {
  const pretty = displayPath(entry.path);
  return {
    target: entry.path,
    current: entry.path === current,
    search: `${entry.name} ${entry.path}`,
    html: `
      <div>
        <div class="session-title">${escapeHtml(entry.name)}/</div>
        <div class="session-cwd">${escapeHtml(pretty)}</div>
      </div>
    `,
  };
}

function renderCwdRecents() {
  if (!cwdPickerState) return;
  const items = cwdPickerState.recents.map((c) => recentCwdItem(c, cwdPickerState.currentCwd));
  modalItems = items;
  modalFiltered = items;
  modalIndex = 0;
  renderModal();
}

function renderCwdListing(parentPath, entries, basenameFilter) {
  if (!cwdPickerState) return;
  const lower = (basenameFilter || "").toLowerCase();
  const filtered = lower
    ? entries.filter((e) => e.name.toLowerCase().startsWith(lower))
    : entries.slice();
  const items = filtered.map((e) => dirEntryItem(e, cwdPickerState.currentCwd));
  modalItems = items;
  modalFiltered = items;
  modalIndex = 0;
  if (items.length === 0) {
    modalBody.innerHTML = `<div class="modal-empty">${escapeHtml(`no subdirectories in ${displayPath(parentPath)}`)}</div>`;
    return;
  }
  renderModal();
}

function requestCwdListing(path) {
  if (!cwdPickerState) return;
  if (cwdPickerState.pending === path) return;
  cwdPickerState.pending = path;
  send({ type: "list_dir", path });
}

function onCwdInput(value) {
  if (!cwdPickerState) return;
  const split = splitCwdInput(value, cwdPickerState.homeDir);
  if (!split) {
    // text doesn't look like a path — filter the recents list as a fallback.
    const lower = value.trim().toLowerCase();
    const recents = cwdPickerState.recents.map((c) => recentCwdItem(c, cwdPickerState.currentCwd));
    modalItems = recents;
    modalFiltered = lower ? recents.filter((it) => it.search.toLowerCase().includes(lower)) : recents;
    modalIndex = 0;
    renderModal();
    return;
  }
  const cached = cwdPickerState.listings.get(split.parent);
  if (cached) {
    if (cached.error) {
      modalItems = [];
      modalFiltered = [];
      modalBody.innerHTML = `<div class="modal-empty">${escapeHtml(cached.error)}</div>`;
      return;
    }
    renderCwdListing(split.parent, cached.entries, split.basename);
    return;
  }
  modalItems = [];
  modalFiltered = [];
  modalBody.innerHTML = `<div class="modal-empty">loading ${escapeHtml(displayPath(split.parent))}…</div>`;
  requestCwdListing(split.parent);
}

function commitCwdSelection() {
  if (!cwdPickerState) return;
  const selected = modalFiltered[modalIndex];
  const text = modalSearch.value.trim();
  let target;
  if (selected && selected.target) {
    // If user has typed a path, prefer their explicit text over the highlighted
    // listing entry — matches shell-style "press Enter to use what I typed".
    if (text && (text.startsWith("/") || text.startsWith("~"))) target = text;
    else target = selected.target;
  } else {
    target = text;
  }
  if (!target) return;
  closeModal();
  submitCwd(target);
}

function completeCwdTab() {
  if (!cwdPickerState) return;
  const selected = modalFiltered[modalIndex];
  if (!selected || !selected.target) return;
  // Show the picked path in tilde form when applicable, with a trailing slash
  // so the next keystroke or Tab descends into it.
  const home = cwdPickerState.homeDir;
  const display = home && (selected.target === home || selected.target.startsWith(home + "/"))
    ? "~" + selected.target.slice(home.length)
    : selected.target;
  modalSearch.value = display + "/";
  onCwdInput(modalSearch.value);
}

function handleListDirResult(payload) {
  if (!cwdPickerState || !payload) return;
  const requestedParent = payload.path || payload.request;
  if (!requestedParent) return;
  if (payload.error) {
    cwdPickerState.listings.set(requestedParent, { error: payload.error });
  } else {
    cwdPickerState.listings.set(requestedParent, { entries: payload.entries || [] });
  }
  if (cwdPickerState.pending === requestedParent) cwdPickerState.pending = null;
  // Re-derive from the live input so we render the current basename filter,
  // not whatever the user typed when we kicked off the request.
  onCwdInput(modalSearch.value);
}

function showCwdPicker(payload) {
  cwdPickerState = {
    homeDir: payload.homeDir || homeDir || "",
    currentCwd: payload.currentCwd || "",
    recents: payload.cwds || [],
    listings: new Map(),
    pending: null,
  };
  modalItems = cwdPickerState.recents.map((c) => recentCwdItem(c, cwdPickerState.currentCwd));
  modalFiltered = modalItems.slice();
  modalIndex = 0;
  modalSearch.value = "";
  modalInputOverride = onCwdInput;
  modalCommitOverride = commitCwdSelection;
  modalTabHandler = completeCwdTab;
  modalOnSelect = (item) => {
    if (item?.target) submitCwd(item.target);
  };
  modal.hidden = false;
  renderModal();
  modalSearch.focus();
}

function showLogoutPicker(payload) {
  const items = (payload.providers || []).map((p) => ({
    target: p,
    search: p,
    html: `<div><div class="session-title">${escapeHtml(p)}</div></div><div class="session-meta">remove credential</div>`,
  }));
  if (items.length === 0) {
    showToast("No providers to log out", "info");
    return;
  }
  openModal(items, (item) => {
    send({ type: "slash_command", name: "logout", arg: item.target });
  });
}

function showModelPicker(payload) {
  const models = payload.models || [];
  if (models.length === 0) {
    showToast("No models available", "info");
    return;
  }
  const items = models.map((m) => {
    const id = `${m.provider}/${m.id}`;
    const ctx = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : "";
    return {
      target: id,
      current: id === payload.currentModel,
      search: `${id} ${m.name}`,
      html: `
        <div>
          <div class="session-title">${escapeHtml(m.name)}</div>
          <div class="session-cwd">${escapeHtml(id)}</div>
        </div>
        <div class="session-meta">${escapeHtml(ctx)}</div>
      `,
    };
  });
  openModal(items, (item) => {
    send({ type: "slash_command", name: "model", arg: item.target });
  });
}

function parseSlash(text) {
  const match = text.match(/^\/([^\s]*)(?:\s+(.*))?$/);
  if (!match) return null;
  return { name: match[1] || "", arg: match[2] ?? "" };
}

function renderSlashMenu() {
  slashMenu.innerHTML = "";
  let activeEl = null;
  slashFiltered.forEach((cmd, i) => {
    const el = document.createElement("div");
    el.className = `slash-item${i === slashIndex ? " active" : ""}${cmd.supported === false ? " unsupported" : ""}`;
    el.dataset.index = String(i);
    el.innerHTML = `<span class="name">/${escapeHtml(cmd.name)}</span><span class="desc">${escapeHtml(cmd.description || "")}</span>`;
    el.addEventListener("mousedown", (event) => {
      event.preventDefault();
      slashIndex = i;
      applySlashSelection();
    });
    slashMenu.appendChild(el);
    if (i === slashIndex) activeEl = el;
  });
  slashMenu.hidden = slashFiltered.length === 0;
  activeEl?.scrollIntoView({ block: "nearest" });
}

function updateSlashMenu() {
  const parsed = parseSlash(input.value);
  if (!parsed || parsed.arg) {
    slashFiltered = [];
    slashMenu.hidden = true;
    return;
  }
  const prefix = parsed.name.toLowerCase();
  slashFiltered = slashCommands.filter((c) => c.name.toLowerCase().startsWith(prefix));
  slashIndex = 0;
  renderSlashMenu();
}

// history navigation may restore an entry that begins with "/", but we don't
// want that to pop the slash command menu — only typing a "/" should.
function hideSlashMenuForHistory() {
  slashFiltered = [];
  slashIndex = 0;
  slashMenu.hidden = true;
}

function applySlashSelection() {
  const cmd = slashFiltered[slashIndex];
  if (!cmd) return;
  input.value = `/${cmd.name} `;
  slashFiltered = [];
  slashMenu.hidden = true;
  input.focus();
}

input.addEventListener("keydown", (event) => {
  if (event.key === "!" && input.value === "" && !event.isComposing) {
    event.preventDefault();
    setBashMode(!bashMode);
    return;
  }
  if (event.key === "Backspace" && input.value === "" && bashMode) {
    event.preventDefault();
    setBashMode(false);
    return;
  }
  if (!slashMenu.hidden && slashFiltered.length > 0) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      slashIndex = (slashIndex + 1) % slashFiltered.length;
      renderSlashMenu();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      slashIndex = (slashIndex - 1 + slashFiltered.length) % slashFiltered.length;
      renderSlashMenu();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      applySlashSelection();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      slashMenu.hidden = true;
      return;
    }
    if (event.key === "Enter" && !event.isComposing) {
      // slash menu 開啟時 Enter 跟 Tab 一致:填入 autocomplete + 關 menu,
      // 不送出 — 維持「Enter 永遠不送出、只能點 send 按鈕」全站規則。
      event.preventDefault();
      applySlashSelection();
      return;
    }
  }
  // Enter / Shift+Enter 一律讓 textarea 自然斷行;送出唯一入口是 send 按鈕。
  // 不在這裡 preventDefault,讓 browser default 處理換行。
  if (event.key === "ArrowUp" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
    if (input.selectionStart !== 0 || input.selectionEnd !== 0) return;
    event.preventDefault();
    if (inputHistory.length === 0 || inputHistoryIndex === 0) return;
    if (inputHistoryIndex === inputHistory.length) {
      inputHistoryDraft = input.value;
    }
    inputHistoryIndex -= 1;
    input.value = inputHistory[inputHistoryIndex] ?? "";
    resizeInput();
    input.setSelectionRange(0, 0);
    hideSlashMenuForHistory();
    return;
  }
  if (event.key === "ArrowDown" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
    if (input.selectionStart !== input.value.length || input.selectionEnd !== input.value.length) return;
    event.preventDefault();
    if (inputHistoryIndex >= inputHistory.length) return;
    inputHistoryIndex += 1;
    input.value =
      inputHistoryIndex >= inputHistory.length ? inputHistoryDraft : inputHistory[inputHistoryIndex];
    resizeInput();
    const end = input.value.length;
    input.setSelectionRange(end, end);
    hideSlashMenuForHistory();
    return;
  }
});

let bashMode = false;
function setBashMode(on) {
  bashMode = on;
  composer.classList.toggle("bash-mode", on);
}

input.addEventListener("input", () => {
  resizeInput();
  inputHistoryIndex = inputHistory.length;
  updateSlashMenu();
});

const TEXT_MODAL_SCROLL_KEYS = new Set([
  "ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " ",
]);

document.addEventListener("keydown", (event) => {
  if (!modal.hidden && modalDialog.classList.contains("text-mode")) {
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      closeModal();
      return;
    }
    if (TEXT_MODAL_SCROLL_KEYS.has(event.key)) {
      const lineHeight = parseFloat(getComputedStyle(modalBody).lineHeight) || 18;
      const page = modalBody.clientHeight - lineHeight * 2;
      let dy = 0;
      switch (event.key) {
        case "ArrowDown": dy = lineHeight; break;
        case "ArrowUp":   dy = -lineHeight; break;
        case "PageDown":
        case " ":         dy = page; break;
        case "PageUp":    dy = -page; break;
        case "Home":      modalBody.scrollTop = 0; event.preventDefault(); return;
        case "End":       modalBody.scrollTop = modalBody.scrollHeight; event.preventDefault(); return;
      }
      modalBody.scrollTop += dy;
      event.preventDefault();
      return;
    }
  }
  // Page up/down scroll the chat log even when the input has focus.
  if ((event.key === "PageUp" || event.key === "PageDown") && modal.hidden) {
    const lineHeight = parseFloat(getComputedStyle(log).lineHeight) || 18;
    const page = log.clientHeight - lineHeight * 2;
    log.scrollTop += event.key === "PageDown" ? page : -page;
    event.preventDefault();
    return;
  }
  if (event.key !== "Escape") return;
  if (!modal.hidden) return;
  if (!slashMenu.hidden) return;
  if (chatState.isRunning) {
    event.preventDefault();
    send({ type: "abort" });
  }
});

// Refocus on mouseup, never mousedown. mousedown fires before the browser
// has resolved whether this is a click or the start of a drag-select; calling
// input.focus() at that point aborts an in-progress drag. mouseup fires after
// the selection range is finalized, and refocusInputIfIdle's selection-guard
// then preserves any text the user just selected.
document.addEventListener("mouseup", () => {
  refocusInputIfIdle();
});

input.addEventListener("blur", () => {
  slashMenu.hidden = true;
});

log.addEventListener("click", async (event) => {
  // Toggle button — switch between text and diff views.
  const toggleBtn = event.target.closest?.(".toggle-btn");
  if (toggleBtn && log.contains(toggleBtn)) {
    event.preventDefault();
    event.stopPropagation();
    const pre = toggleBtn.closest?.("pre");
    if (!pre) return;
    const currentView = pre.dataset.view;
    if (currentView === "single") return;
    const newView = currentView === "text" ? "diff" : "text";
    pre.dataset.view = newView;
    // Update active button styling.
    const toggles = pre.querySelector(".tool-result-toggles");
    if (toggles) {
      for (const btn of toggles.querySelectorAll(".toggle-btn")) {
        btn.classList.toggle("active", btn.dataset.view === newView);
      }
    }
    // Swap the code content. Diff view uses HTML so per-line color spans
    // render; text view is plain text.
    const codeEl = pre.querySelector("code");
    if (!codeEl) return;
    if (newView === "diff" && pre.dataset.diff) {
      codeEl.classList.add("diff-content");
      codeEl.innerHTML = formatDiffHtml(pre.dataset.diff);
    } else if (pre.dataset.text) {
      codeEl.classList.remove("diff-content");
      codeEl.textContent = pre.dataset.text;
    }
    return;
  }

  const btn = event.target.closest?.(".copy-btn");
  if (!btn || !log.contains(btn)) return;
  event.preventDefault();
  event.stopPropagation();

  const pre = btn.parentElement;
  const code = pre?.querySelector("code");
  if (!code) return;
  // Prefer the raw text/diff stored on the pre — when in diff view the code
  // contains <div> per-line elements whose textContent loses newlines.
  const view = pre?.dataset.view;
  const raw = view === "diff" ? pre?.dataset.diff : view === "text" ? pre?.dataset.text : null;
  const payload = raw ?? code.textContent ?? "";
  try {
    await navigator.clipboard.writeText(payload);
    showToast("Copied to clipboard", "info");
  } catch {
    showToast("Clipboard write blocked by browser", "error");
  }
});

function refocusInputIfIdle() {
  if (!modal.hidden) return;
  const active = document.activeElement;
  if (active === input) return;
  if (active && active.matches?.("input, textarea, select, [contenteditable]")) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().length > 0) return;
  input.focus();
}

// renders the chip strip above the composer reflecting `pendingImages` and
// `pendingFiles`. images keep their thumbnail; files show a [ext] badge + name.
const attachmentsBar = document.getElementById("composer-attachments");
function renderAttachments() {
  attachmentsBar.replaceChildren();
  const empty = pendingImages.length === 0 && pendingFiles.length === 0;
  attachmentsBar.hidden = empty;
  pendingImages.forEach((img, i) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    // 落地中的圖沿用檔案 chip 的 pending 樣式;純 vision(skipped/error)不特別標示,
    // 因為對使用者而言圖仍然「附上去了」。
    if (img.uploadStatus === "uploading") chip.classList.add("pending");
    const thumb = document.createElement("img");
    thumb.src = img.url;
    thumb.alt = "pasted image";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.setAttribute("aria-label", "Remove attachment");
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      pendingImages.splice(i, 1);
      renderAttachments();
    });
    chip.append(thumb, remove);
    attachmentsBar.append(chip);
  });
  pendingFiles.forEach((file) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip file";
    if (file.status !== "ready") chip.classList.add("pending");
    const badge = document.createElement("span");
    badge.className = "file-badge";
    badge.textContent = file.ext || "FILE";
    const name = document.createElement("span");
    name.className = "file-name";
    name.title = file.originalName;
    let display = file.originalName;
    if (file.status === "uploading") display = `${display} (uploading…)`;
    else if (file.status === "error") display = `${display} (failed)`;
    name.textContent = display;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.setAttribute("aria-label", "Remove attachment");
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      const idx = pendingFiles.findIndex((f) => f.id === file.id);
      if (idx >= 0) pendingFiles.splice(idx, 1);
      renderAttachments();
    });
    chip.append(badge, name, remove);
    attachmentsBar.append(chip);
  });
}

// 取副檔名(全小寫、不含點)
function getFileExt(name) {
  const s = String(name || "");
  const dot = s.lastIndexOf(".");
  if (dot < 0 || dot === s.length - 1) return "";
  return s.slice(dot + 1).toLowerCase();
}

// 把單一 File 透過 PUT /api/upload 送上去,回傳 server 給的 file metadata。
// 失敗時 throw,呼叫端用 chip status / toast 呈現。
async function uploadFile(file) {
  const res = await fetch(`${BASE}/api/upload?name=${encodeURIComponent(file.name)}`, {
    method: "PUT",
    body: file,
    credentials: "same-origin",
    headers: { "content-type": "application/octet-stream" },
  });
  let body = null;
  try { body = await res.json(); } catch { /* server 沒回 JSON */ }
  if (!res.ok || !body?.ok) {
    const reason = body?.error || `upload failed (${res.status})`;
    throw new Error(reason);
  }
  return body.file;
}

// converts an ArrayBuffer to a base64 string without using FileReader so the
// callback flow stays in this paste handler.
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// shared by paste / drag-drop / file picker: dispatches each File to either the
// in-band image path (Anthropic ImageContent) or the /api/upload path (any other
// whitelisted extension). rejections surface as a toast but don't abort the rest
// of the batch.
async function ingestFiles(files) {
  if (!files || files.length === 0) return;
  for (const file of files) {
    const ext = getFileExt(file.name);
    const isImage = ALLOWED_PASTED_IMAGE_MIME.test(file.type);
    if (isImage) {
      if (pendingImages.length >= MAX_PASTED_IMAGES) {
        showToast(`max ${MAX_PASTED_IMAGES} image attachments`, "warning");
        continue;
      }
      if (file.size > MAX_PASTED_IMAGE_BYTES) {
        showToast("image too large (10 MB max)", "warning");
        continue;
      }
      const buf = await file.arrayBuffer();
      const data = arrayBufferToBase64(buf);
      const imgEntry = {
        data,
        mimeType: file.type,
        url: `data:${file.type};base64,${data}`,
        originalName: file.name || "",
        ext,
        attachPath: null,
        uploadStatus: "uploading",
      };
      pendingImages.push(imgEntry);
      // 再落地一份取 attachPath。剪貼簿貼上的圖常無檔名/副檔名,白名單外或超過
      // 上傳上限的同理——這些只能保持純 vision,標 skipped 不擋送出。
      if (!ext || !uploadConfig.allowedExtensions.has(ext) || file.size > uploadConfig.maxBytes) {
        imgEntry.uploadStatus = "skipped";
      } else {
        uploadFile(file).then(
          (meta) => {
            imgEntry.uploadStatus = "ready";
            imgEntry.attachPath = meta.attachPath;
            imgEntry.storedName = meta.storedName;
            renderAttachments();
          },
          (err) => {
            // 落地失敗只是降級回純 vision,不阻斷送出;但要讓使用者知道
            // 「這張圖 LLM 看得到、卻沒有檔案可用」。
            imgEntry.uploadStatus = "error";
            logger.info("image upload failed", { message: err.message });
            showToast(`image saved for viewing only (upload failed): ${err.message}`, "warning");
            renderAttachments();
          },
        );
      }
      continue;
    }
    // 非圖片(或 svg / 其他副檔名)走 /api/upload
    if (!ext) {
      showToast(`unsupported file (no extension): ${file.name}`, "warning");
      continue;
    }
    if (!uploadConfig.allowedExtensions.has(ext)) {
      showToast(`unsupported extension: .${ext}`, "warning");
      continue;
    }
    if (pendingFiles.length >= uploadConfig.maxFiles) {
      showToast(`max ${uploadConfig.maxFiles} file attachments`, "warning");
      break;
    }
    if (file.size > uploadConfig.maxBytes) {
      const mb = Math.round(uploadConfig.maxBytes / (1024 * 1024));
      showToast(`file too large (${mb} MB max): ${file.name}`, "warning");
      continue;
    }
    const entry = {
      id: nextPendingFileId++,
      originalName: file.name,
      ext,
      size: file.size,
      status: "uploading",
      attachPath: null,
    };
    pendingFiles.push(entry);
    renderAttachments();
    // upload 非阻塞;成功 / 失敗時更新 entry 並 re-render
    uploadFile(file).then(
      (meta) => {
        entry.status = "ready";
        entry.attachPath = meta.attachPath;
        entry.storedName = meta.storedName;
        renderAttachments();
      },
      (err) => {
        entry.status = "error";
        showToast(`upload failed: ${err.message}`, "error");
        renderAttachments();
      },
    );
  }
  renderAttachments();
}

// 舊名 alias:其他地方仍可能呼叫 ingestImageFiles(原本只處理圖)。
const ingestImageFiles = ingestFiles;

input.addEventListener("paste", (event) => {
  const items = event.clipboardData?.items;
  if (!items) return;
  // paste 同樣接圖片 + 一般檔案;ingestFiles 內部會依副檔名分流。
  // 文字 paste 不被攔(items[i].kind === "string")。
  const files = [];
  for (const item of items) {
    if (item.kind === "file") {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length === 0) return; // let normal text paste through
  event.preventDefault();
  void ingestFiles(files);
});

// + 附件按鈕:打開隱藏的 file picker。
const attachButton = document.getElementById("attach");
const filePicker = document.getElementById("file-picker");
if (attachButton && filePicker) {
  attachButton.addEventListener("click", () => filePicker.click());
  filePicker.addEventListener("change", () => {
    const list = Array.from(filePicker.files || []);
    if (list.length > 0) void ingestFiles(list);
    // 清空 value 讓同一個檔案可以再選一次(否則 change 不會 fire)
    filePicker.value = "";
  });
}

// drag and drop: accept image files dropped anywhere in the document. the
// dragover handler must call preventDefault for the drop to register at all.
// a body-level class lets the composer highlight while a drag is active.
let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  dragDepth += 1;
  document.body.classList.add("drag-active");
});
window.addEventListener("dragleave", () => {
  if (dragDepth > 0) dragDepth -= 1;
  if (dragDepth === 0) document.body.classList.remove("drag-active");
});
window.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
});
window.addEventListener("drop", (event) => {
  dragDepth = 0;
  document.body.classList.remove("drag-active");
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return;
  event.preventDefault();
  void ingestFiles(Array.from(files));
});

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  if (chatState.isRunning) {
    logger.info("abort sent");
    send({ type: "abort" });
    return;
  }
  const raw = input.value;
  const message = raw.trim();
  const hasImages = pendingImages.length > 0;
  // 只把上傳完成的(status === "ready")檔案算進送出條件;uploading / error 的
  // 排除。若還在 uploading,提示使用者稍候。
  const readyFiles = pendingFiles.filter((f) => f.status === "ready");
  const uploadingFiles = pendingFiles.filter((f) => f.status === "uploading");
  // 圖片的落地也算一份上傳,沒等完就送會漏掉 attachPath。
  const uploadingImages = pendingImages.filter((img) => img.uploadStatus === "uploading");
  const hasFiles = readyFiles.length > 0;
  const pendingUploads = uploadingFiles.length + uploadingImages.length;
  if (pendingUploads > 0) {
    showToast(`waiting for ${pendingUploads} upload(s) to finish`, "info");
    return;
  }
  if ((!message && !hasImages && !hasFiles) || socket?.readyState !== WebSocket.OPEN) return;
  if (message) pushInputHistory(message);
  inputHistoryDraft = "";
  input.value = "";
  input.style.height = "36px";
  slashMenu.hidden = true;

  // bash/slash routing applies only when there are no pasted attachments —
  // images / files can only be carried by a regular prompt message.
  if (!hasImages && !hasFiles) {
    const route = routeInput({ message, bashMode });
    if (route.kind === "empty") return;
    if (route.kind === "bash") {
      if (bashMode) setBashMode(false);
      logger.info("bash sent", { length: route.command.length });
      send({ type: "bash", command: route.command });
      return;
    }

    const slash = parseSlash(message);
    if (slash) {
      if (slash.name === "name" && !slash.arg.trim()) {
        const current = currentSessionState?.sessionName || "";
        showPromptModal("Session name", current, (value) => {
          logger.info("slash sent", { name: "name" });
          send({ type: "slash_command", name: "name", arg: value });
        });
        return;
      }
      logger.info("slash sent", { name: slash.name, hasArg: slash.arg.length > 0 });
      send({ type: "slash_command", name: slash.name, arg: slash.arg });
      return;
    }
  }

  const images = pendingImages.map((img) => ({ data: img.data, mimeType: img.mimeType }));
  // 落地成功的圖同時以附件路徑送出:base64 給 vision、attachPath 給要吃檔案的工具。
  const files = [
    ...readyFiles.map((f) => ({ originalName: f.originalName, attachPath: f.attachPath })),
    ...pendingImages
      .filter((img) => img.attachPath)
      .map((img) => ({ originalName: img.originalName, attachPath: img.attachPath })),
  ];
  pendingImages.length = 0;
  pendingFiles.length = 0;
  renderAttachments();
  logger.info("prompt sent", { length: message.length, images: images.length, files: files.length });
  appendOptimisticUserMessage(message, images);
  send({ type: "prompt", message, images, files });
});

function appendOptimisticUserMessage(text, images) {
  csSubmitUser(chatState, text, images);
  renderLog();
}

input.focus();
connect();
