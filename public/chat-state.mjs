import { isToolResultVisible } from './format-message.mjs';
import { progressFromHistory } from './render-progress.mjs';

// pure state management for the chat log. no DOM.
// app.js renders selectItems(state) to the DOM after each mutation.
//
// Streaming is modeled to match the canonical SDK shape: a single live
// assistant entry whose blocks[] interleaves text, thinking, tool_call, and
// tool_result blocks. This keeps the visual layout stable when the canonical
// snapshot lands at agent_end — nothing "snaps" between top-level sections.
//
// Block shapes:
//   { type: "text", text }
//   { type: "thinking", text }
//   { type: "tool_call", name, input }
//   { type: "tool_result", name, result }   // result is null while pending
//   { type: "image", mimeType }

export function createChatState() {
  return {
    progress: null,
    historyProgress: new Map(),
    canonical: [],         // server-snapshot messages (each is a raw SDK message)
    pendingUser: null,     // optimistic user entry; cleared once canonical contains it
    streamExtras: [],      // streaming-derived items (live assistant only, today)
    showTyping: false,
    isRunning: false,
    liveAssistant: null,   // pointer into streamExtras for current streaming entry
    liveTextBlocks: null,  // Map<contentIndex, block> for text/thinking dedup
    lastError: null,
    // Map<key, placeholder>. Key is toolCallId when available, else a unique
    // Symbol. A Map (not a single pointer) is required because pi runs tools
    // in parallel — multiple placeholders may be in flight at once, and each
    // tool_execution_end must land on the placeholder with the matching id.
    pendingToolResults: new Map(),
  };
}

export function setError(state, message) {
  state.lastError = message ? String(message) : null;
}

export function clearError(state) {
  state.lastError = null;
}

export function submitUser(state, text, images) {
  const blocks = [];
  if (text) blocks.push({ type: "text", text });
  if (Array.isArray(images)) {
    for (const img of images) {
      if (img && img.data) blocks.push({ type: "image", mimeType: img.mimeType, data: img.data });
    }
  }
  state.progress = null;
  state.pendingUser = { kind: "user", title: "You", blocks };
  state.showTyping = true;
  state.isRunning = true;
  resetLiveAssistant(state);
  state.streamExtras = [];
}

// Routine snapshot from the server. Preserves streamed extras — they own
// the visible tail of the conversation since the last user message, and
// selectItems hides any canonical messages past that point to avoid
// duplicates. Use resetHistory for cold start / session switch / replay miss.
export function setHistory(state, messages) {
  state.canonical = Array.isArray(messages) ? messages.slice() : [];
  if (state.pendingUser) {
    const pendingTextBlock = state.pendingUser.blocks.find((b) => b.type === "text");
    const pendingText = pendingTextBlock ? pendingTextBlock.text : "";
    const pendingHasImage = state.pendingUser.blocks.some((b) => b.type === "image");
    const lastUser = lastUserMessage(state.canonical);
    if (lastUser && sameUserText(lastUserText(state.canonical) ?? "", pendingText)) {
      // an image-only pending user matches if canonical's last user has any
      // image block too — text alone may be empty in both, so the image
      // presence acts as the signal that the server received our turn.
      if (!pendingHasImage || lastUserHasImage(lastUser)) {
        state.pendingUser = null;
      }
    }
  }
  if (!state.isRunning) state.showTyping = false;
}

// W45 F16：送出含附件時，server 會在客戶文字尾附加附件區塊（index.ts appendAttachmentNotice：
// "[Attached files]\n- 名稱 -> 路徑"；customer 出口再改成 "附件：\n- 名稱"，見 customer-text.ts）。
// 只比完全相等會一直對不上，pendingUser 清不掉，整輪就重複顯示。兩種格式改一處要一起改。
const ATTACHMENT_TAIL = /(?:^|\n\n)(?:\[Attached files\]|附件：)(?:\n- [^\n]*)+$/;

function sameUserText(canonicalText, pendingText) {
  if (canonicalText === pendingText) return true;
  return canonicalText.replace(ATTACHMENT_TAIL, "") === pendingText;
}

function lastUserMessage(canonical) {
  for (let i = canonical.length - 1; i >= 0; i--) {
    if (canonical[i]?.role === "user") return canonical[i];
  }
  return null;
}

function lastUserHasImage(message) {
  if (!Array.isArray(message?.content)) return false;
  return message.content.some((c) => c && c.type === "image");
}

// Authoritative snapshot. Throws away any streamed UI state — used on
// initial connect, session switch, and reconnect when the server's event
// log can't cover the gap (replay miss).
export function resetHistory(state, messages) {
  state.canonical = Array.isArray(messages) ? messages.slice() : [];
  state.streamExtras = [];
  state.progress = null;
  state.historyProgress.clear();
  state.pendingUser = null;
  resetLiveAssistant(state);
  state.showTyping = false;
}

function resetLiveAssistant(state) {
  state.liveAssistant = null;
  state.liveTextBlocks = null;
  state.pendingToolResults = new Map();
}

function ensureLiveAssistant(state) {
  if (state.liveAssistant) return state.liveAssistant;
  const live = { kind: "assistant", title: "Assistant", blocks: [] };
  state.liveAssistant = live;
  state.liveTextBlocks = new Map();
  state.streamExtras.push(live);
  return live;
}

function lastUserText(canonical) {
  for (let i = canonical.length - 1; i >= 0; i--) {
    const m = canonical[i];
    if (m && m.role === "user") return userMessageText(m);
  }
  return null;
}

export function applyDelta(state, delta) {
  if (delta.type === "text_delta" || delta.type === "thinking_delta") {
    state.showTyping = false;
    const live = ensureLiveAssistant(state);
    const kind = delta.type === "thinking_delta" ? "thinking" : "text";
    const idx = delta.contentIndex;
    let block = idx !== undefined ? state.liveTextBlocks.get(idx) : null;
    if (!block || block.type !== kind) {
      block = { type: kind, text: "" };
      live.blocks.push(block);
      if (state.progress) state.progress.timeline.push(block);
      if (idx !== undefined) state.liveTextBlocks.set(idx, block);
    }
    block.text += delta.delta || "";
    return;
  }
  if (delta.type === "toolcall_end") {
    // The LLM has finished generating a tool_use block. Render it now —
    // before pi fires tool_execution_start — so users see the call (and its
    // arguments) as soon as the model decides them, not after pi runs it.
    const tc = delta.toolCall;
    if (!tc) return;
    state.showTyping = false;
    const live = ensureLiveAssistant(state);
    live.blocks.push({ type: "tool_call", id: tc.id, name: tc.name, input: tc.arguments });
    // Following text/thinking is a fresh block, even if contentIndex is reused.
    state.liveTextBlocks = new Map();
    return;
  }
  // toolcall_start / toolcall_delta carry no name and only partial JSON, so
  // they're not useful to render — wait for toolcall_end.
}

export function onToolStart(state, name, input, id) {
  // tool_call nests in the assistant that emitted it. tool_result, however,
  // is its own top-level entry — that mirrors the canonical SDK shape after
  // reload (an assistant message containing tool_use, then a separate
  // toolResult message).
  state.showTyping = false;
  // Dedup: if the LLM-side toolcall_end already added this tool_call to ANY
  // assistant entry in streamExtras (matched by SDK toolCallId), skip the
  // tool_call push entirely — and don't create a phantom empty assistant
  // just to hold it.
  const alreadyInExtras = id && findAssistantWithToolCallId(state, id);
  if (!alreadyInExtras) {
    // Fallback path: tool_execution_start arrived without a preceding
    // toolcall_end (e.g. on reconnect or for tools that bypass the LLM
    // streaming layer). Append the tool_call to the live assistant,
    // creating one if necessary.
    const live = ensureLiveAssistant(state);
    live.blocks.push({ type: "tool_call", id, name, input });
  }
  const placeholder = {
    kind: "tool",
    title: `Tool result: ${name}`,
    blocks: [{ type: "tool_result", id, name, result: null }],
  };
  state.streamExtras.push(placeholder);
  // Key by id so onToolEnd can find this exact placeholder when tools run
  // in parallel. Fall back to a unique Symbol when id is missing so each
  // placeholder still has its own slot.
  const key = id || Symbol("anon-tool");
  state.pendingToolResults.set(key, placeholder);
  // Following text/thinking deltas are a new content block — the preceding
  // text was terminated by the tool_use. Clear the contentIndex map so the
  // next delta creates a fresh block.
  state.liveTextBlocks = new Map();
}

function findAssistantWithToolCallId(state, id) {
  for (const item of state.streamExtras) {
    if (item.kind !== "assistant") continue;
    for (const b of item.blocks) {
      if (b.type === "tool_call" && b.id === id) return item;
    }
  }
  return null;
}

export function onToolEnd(state, name, result, id) {
  const map = state.pendingToolResults;
  let key = null;
  let pending = null;
  // Prefer exact id match — required when parallel tools share a name.
  if (id && map.has(id)) {
    key = id;
    pending = map.get(id);
  } else {
    // Fallback for callers that don't pass an id (legacy/no-id flows): take
    // the first pending placeholder with the same name, in insertion order.
    for (const [k, p] of map) {
      if (p.blocks[0]?.name === name) { key = k; pending = p; break; }
    }
  }
  if (pending) {
    // Replace the blocks array (not just the inner block) so the renderer's
    // identity-based cache check (`cached.blocks !== item.blocks`) triggers
    // an update on this otherwise-frozen item.
    pending.blocks = [{ type: "tool_result", id, name, result }];
    map.delete(key);
  } else {
    // Orphan result — append a fresh top-level entry.
    state.streamExtras.push({
      kind: "tool",
      title: `Tool result: ${name}`,
      blocks: [{ type: "tool_result", name, result }],
    });
  }
  // Any assistant text that follows belongs to a new top-level section
  // below the tool result, matching canonical layout.
  state.liveAssistant = null;
  state.liveTextBlocks = null;
  if (state.isRunning) state.showTyping = true;
}

export function onAgentStart(state) {
  if (state.progress && (state.isRunning || state.progress.notice?.retrying)) {
    // 續跑提示跨 agent_start 保留，直到這次續跑真正結束。
    state.progress.retryActive = Boolean(state.progress.notice?.retrying);
    if (!state.progress.retryActive) state.progress.notice = null;
    state.progress.finished = false;
    delete state.progress.endedAt;
  }
  state.isRunning = true;
  state.lastError = null;
}

export function onAgentEnd(state, event = {}) {
  if (state.progress) {
    if (state.progress.retryActive && !event.willRetry) {
      if (state.progress.notice?.retrying) state.progress.notice = null;
      delete state.progress.retryActive;
    }
    state.progress.finished = !event.willRetry && !state.progress.notice?.retrying;
    if (state.progress.finished) state.progress.endedAt = Date.now();
  }
  state.isRunning = Boolean(event.willRetry || state.progress?.notice?.retrying);
  state.showTyping = false;
  // Clear the streaming pointers but KEEP pendingToolResults — the LLM turn
  // ended, but pi runs tools AFTER the assistant message is done. A
  // tool_execution_end may still arrive and needs to find its placeholder.
  state.liveAssistant = null;
  state.liveTextBlocks = null;
}

// Returns ordered render items.
//   { source: "canonical", message }
//   { source: "extra", item: { kind, title, blocks } }
//   { source: "typing" }
//
// When streamed extras exist, they own the visible tail since the last user
// message — canonical messages past that point are hidden so we don't render
// the same content twice (once via canonical, once via extras). This is the
// dedup half of the buffer+replay model.
export function selectItems(state, uiProfile = {}) {
  const items = [];
  // When pendingUser is set, the new user message lives there (not yet in
  // canonical), so canonical's lastUser still points at the previous turn —
  // clipping to it would hide the previous assistant's content during the
  // next turn's streaming. Show all of canonical in that case.
  const lastUser = lastUserMessageIndex(state.canonical);
  const canonicalEnd =
    (state.streamExtras.length > 0 || state.progress) && lastUser >= 0 && !state.pendingUser
      ? lastUser + 1
      : state.canonical.length;
  for (let i = 0; i < canonicalEnd; i++) {
    const message = state.canonical[i];
    if (message?.role === 'assistant') {
      const group = [];
      let j = i;
      while (j < canonicalEnd && (['assistant', 'toolResult'].includes(state.canonical[j]?.role) || state.canonical[j]?.readyaiAutoContinue)) group.push(state.canonical[j++]);
      const key = JSON.stringify(group);
      let progress = state.historyProgress.get(key);
      if (!progress) { progress = progressFromHistory(group); state.historyProgress.set(key, progress); }
      if (progress.steps.length || progress.notice) {
        items.push({ source: 'progress', progress }); i = j - 1; continue;
      }
    }
    items.push({ source: "canonical", message });
  }
  if (state.pendingUser) items.push({ source: "extra", item: state.pendingUser });
  if (state.progress) {
    // 原文工具卡片只附在所屬步驟，避免兩份畫面。
    for (const e of state.streamExtras) for (const b of e.blocks || []) {
      const step = state.progress.steps.find(s => s.stepId === b.id);
      if (step && b.type === 'tool_call') step.tool = b;
      if (step && b.type === 'tool_result') step.result = b.result;
    }
    items.push({ source: 'progress', progress: state.progress });
    for (const e of state.streamExtras) if (!['assistant', 'tool'].includes(e.kind) || (e.kind === 'tool' && uiProfile.hideToolCalls && e.blocks.some(b => isToolResultVisible(b, uiProfile)))) items.push({ source: 'extra', item: e });
  } else for (const e of state.streamExtras) items.push({ source: "extra", item: e });
  if (state.showTyping && !state.progress) items.push({ source: "typing" });
  return items;
}

function lastUserMessageIndex(canonical) {
  for (let i = canonical.length - 1; i >= 0; i--) {
    if (canonical[i]?.role === "user" && !canonical[i].readyaiAutoContinue) return i;
  }
  return -1;
}

export function userMessageText(message) {
  if (!message || message.role !== "user") return null;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    const t = message.content.find((c) => c && c.type === "text");
    return t ? t.text : null;
  }
  return null;
}

// 新封包持續保留同一回合物件，供畫面保存展開狀態。
export function applyTurnProgress(state, type, payload) {
  if (!payload?.turnId) return;
  if (!state.progress || state.progress.turnId !== payload.turnId) {
    state.progress = { turnId: payload.turnId, steps: [], timeline: state.streamExtras.flatMap(e => e.kind === 'assistant' ? e.blocks.filter(b => !['tool_call', 'tool_result'].includes(b.type)) : []), phase: null, phaseSince: null, startedAt: payload.since ?? Date.now(), finished: false, notice: null };
  }
  const p = state.progress;
  state.showTyping = false;
  if (type === 'turn_step') {
    let step = p.steps.find(s => s.stepId === payload.stepId);
    if (!step) {
      step = { type: 'step_summary' }; p.steps.push(step); p.timeline.push(step);
      state.liveTextBlocks = new Map();
    }
    // 重播 start 不得把已完成步驟降回進行中。
    if (!(step.phase === 'end' && payload.phase === 'start')) Object.assign(step, payload, { type: 'step_summary' });
  } else if (type === 'turn_phase') {
    p.phase = payload.phase; p.phaseSince = payload.since;
  } else if (type === 'turn_notice') {
    p.notice = { ...payload };
    if (payload.retryActive) p.retryActive = true;
    p.finished = !payload.retrying;
    if (p.finished) p.endedAt = Date.now();
  }
}
