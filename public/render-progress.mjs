import { sdkContentToBlocks, isToolResultVisible } from './format-message.mjs';
import { reconcileChildrenInPlace } from './render-blocks.mjs';

export const CONTINUE_PROMPT = '請根據剛才查到的資料，直接給出結論';
export const SAFE_ERROR = '處理時發生問題，沒有完成。請稍後再試一次。';

export function noticeForEnd(message, hasText) {
  const reason = message?.stopReason;
  if (reason === 'length') return { kind: 'truncated', message: hasText ? '回覆可能不完整（內容太長被中斷）' : '這次整理的內容太長，回覆被中斷，沒有產生答案。請再問一次，或把問題拆小一點。', detail: 'stopReason: length' };
  if (reason === 'error') return { kind: 'error', message: SAFE_ERROR, detail: message.errorMessage || 'stopReason: error' };
  if (reason === 'aborted') return { kind: 'aborted', message: '已停止。', detail: 'stopReason: aborted' };
  if (!hasText) return { kind: 'no_answer', message: '這次沒有產生回答，請再問一次。' };
  return null;
}

export function progressFromHistory(messages) {
  const p = { steps: [], timeline: [], phase: null, phaseSince: null, startedAt: null, finished: true, notice: null };
  let last;
  for (const m of messages) {
    if (m.readyaiAutoContinue) { p.timeline.push({ type: 'text', text: '系統自動續跑', system: true }); continue; }
    if (m.role === 'toolResult') {
      const step = p.steps.find(s => s.stepId === m.toolCallId);
      if (step) { step.result = { content: m.content, details: m.details }; step.status = m.isError ? 'error' : 'ok'; }
      p.timeline.push({ type: 'tool_result', name: m.toolName, result: { content: m.content, details: m.details }, standaloneResult: true });
      continue;
    }
    if (m.role !== 'assistant') continue;
    last = m;
    for (const b of sdkContentToBlocks(m.content)) {
      if (b.type === 'step_summary' || b.type === 'tool_call') {
        const step = { ...b, type: 'step_summary', stepId: b.stepId || b.id, n: p.steps.length + 1, category: b.category || '執行操作', status: b.status || 'ok', phase: 'end' };
        if (b.type === 'tool_call') step.tool = b;
        p.steps.push(step);
        p.timeline.push(step);
      } else p.timeline.push(b);
    }
  }
  p.notice = last ? noticeForEnd(last, sdkContentToBlocks(last.content).some(b => b.type === 'text' && b.text?.trim())) : null;
  return p;
}

function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`;
}
export function progressHeading(p, now = Date.now()) {
  const elapsed = p.startedAt == null ? '' : duration((p.endedAt ?? now) - p.startedAt);
  return p.finished ? `已執行 ${p.steps.length} 個步驟${elapsed ? ` · ${elapsed}` : ''}` : `處理中 · 第 ${p.steps.length} 步${elapsed ? ` · 已 ${elapsed}` : ''}`;
}
export function thinkingLabel(p, now = Date.now()) {
  return !p.finished && p.phase === 'thinking' ? `正在分析（已 ${Math.max(0, Math.floor((now - p.phaseSince) / 1000))} 秒）` : '';
}
export function canContinue(notice) {
  return Boolean(notice && !notice.retrying && ['truncated', 'no_answer'].includes(notice.kind));
}

// 建立一次、逐列更新；計時器只改文字，手動展開狀態保存在原節點。
export function createProgressView({ document, renderBlock, onContinue }) {
  const el = document.createElement('section');
  el.className = 'message assistant turn-progress';
  el.setAttribute('aria-label', '助理處理進度');
  el.setAttribute('role', 'group');
  const title = document.createElement('h3'); title.textContent = '助理';
  const body = document.createElement('div'); body.className = 'message-body';
  el.append(title, body);
  const details = document.createElement('details');
  details.className = 'progress-details';
  const summary = document.createElement('summary');
  const list = document.createElement('div');
  list.className = 'progress-list';
  const heartbeat = document.createElement('div');
  heartbeat.className = 'progress-heartbeat';
  const answer = document.createElement('div');
  answer.className = 'progress-answer';
  const notice = document.createElement('div');
  notice.className = 'progress-notice';
  notice.setAttribute('role', 'status');
  const noticeText = document.createElement('div');
  const diagnostic = document.createElement('pre');
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = '請繼續';
  button.addEventListener('click', () => onContinue(CONTINUE_PROMPT));
  notice.append(noticeText, diagnostic, button);
  details.append(summary, list, heartbeat);
  body.append(details, answer, notice);
  const nodes = new Map();
  let current;
  let manual = false;
  let automaticOpen = false;
  let wasFinished;
  // 原生 toggle 包含程式設定；用目標值區別，不把自動收合當成人工選擇。
  details.addEventListener('toggle', () => { if (details.open !== automaticOpen) manual = true; });
  function tick(now = Date.now()) {
    if (!current) return;
    summary.textContent = progressHeading(current, now);
    heartbeat.textContent = thinkingLabel(current, now);
    heartbeat.hidden = !heartbeat.textContent;
  }
  function update(p, profile = {}, running = false) {
    current = p;
    // 沒有工具步驟時只留進行中的內容與心跳，結束後不留空收合列。
    details.hidden = p.finished && p.steps.length === 0;
    summary.hidden = p.steps.length === 0;
    if (wasFinished !== p.finished && !manual) { automaticOpen = !p.finished; details.open = automaticOpen; }
    wasFinished = p.finished;
    const lastStep = p.timeline.reduce((last, b, i) => b.type === 'step_summary' ? i : last, -1);
    const inside = [], outside = [];
    for (const [i, b] of p.timeline.entries()) {
      if (profile.hideThinking && b.type === 'thinking') continue;
      if (b.standaloneResult && (!profile.hideToolCalls || !isToolResultVisible(b, profile))) continue;
      let record = nodes.get(b);
      if (b.type === 'step_summary') {
        if (!record) {
          const row = document.createElement('details'); row.className = 'progress-step';
          const label = document.createElement('summary'); row.append(label);
          const body = document.createElement('div'); row.append(body);
          record = { el: row, label, body }; nodes.set(b, record);
        }
        record.label.textContent = `${b.phase === 'start' ? '◌ 進行中' : b.status === 'error' ? '✗' : '✓'} ${b.label || b.category || '執行操作'}${b.detail ? `　${b.detail}` : ''}`;
        record.el.classList.toggle('progress-step-error', b.status === 'error');
        record.el.classList.toggle('progress-step-safe', Boolean(profile.hideToolCalls));
        record.body.hidden = Boolean(profile.hideToolCalls);
        if (!profile.hideToolCalls && (record.tool !== b.tool || record.result !== b.result)) {
          const children = [];
          if (b.tool) children.push(renderBlock(b.tool));
          if (b.result) children.push(renderBlock({ type: 'tool_result', name: b.tool?.name || b.toolName, result: b.result }));
          reconcileChildrenInPlace(record.body, children);
          record.tool = b.tool; record.result = b.result;
        }
      } else {
        const signature = JSON.stringify(b);
        if (!record) { record = { el: document.createElement('div') }; nodes.set(b, record); }
        if (record.signature !== signature) {
          reconcileChildrenInPlace(record.el, [renderBlock(b)]); record.signature = signature;
        }
      }
      // 最後一步後的回答放在區塊外；前面的說明留在步驟之間。
      (p.finished && i > lastStep && b.type !== 'step_summary' ? outside : inside).push(record.el);
    }
    reconcileChildrenInPlace(list, inside);
    reconcileChildrenInPlace(answer, outside);
    notice.hidden = !p.notice;
    noticeText.textContent = p.notice?.message || '';
    diagnostic.textContent = profile.safeErrors || profile.hideToolCalls ? '' : p.notice?.detail || '';
    diagnostic.hidden = !diagnostic.textContent;
    button.hidden = Boolean(p.superseded) || !canContinue(p.notice);
    button.disabled = running;
    tick();
  }
  return { el, update, tick };
}
