import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as progress from '../public/render-progress.mjs';

test('歷史依內容順序重建，前置說明不算最後回答', () => {
  const p = progress.progressFromHistory([
    { role: 'assistant', content: [{ type: 'text', text: '查看中' }, { type: 'step_summary', stepId: 'a', category: '查看資料', status: 'ok' }] },
    { role: 'assistant', content: [{ type: 'step_summary', stepId: 'b', category: '修改內容', status: 'error' }], stopReason: 'length' },
  ]);
  assert.deepEqual(p.timeline.map(b => b.type), ['text', 'step_summary', 'step_summary']);
  assert.deepEqual(p.steps.map(b => b.n), [1, 2]);
  assert.match(p.notice.message, /沒有產生答案/);
  assert.equal(p.finished, true);
});

test('沒有文字的歷史仍有提示，思考不算回答', () => {
  for (const [stopReason, kind] of [['length', 'truncated'], ['aborted', 'aborted'], ['stop', 'no_answer']]) {
    const p = progress.progressFromHistory([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }], stopReason }]);
    assert.equal(p.notice.kind, kind);
  }
});

test('計時與續跑按鈕條件', () => {
  const p = { steps: [{ n: 1 }], startedAt: 1000, phase: 'thinking', phaseSince: 2000, finished: false };
  assert.equal(progress.progressHeading(p, 65000), '處理中 · 第 1 步 · 已 1 分 04 秒');
  assert.equal(progress.thinkingLabel(p, 65000), '正在分析（已 63 秒）');
  assert.equal(progress.canContinue({ kind: 'truncated', retrying: true }), false);
  assert.equal(progress.canContinue({ kind: 'no_answer' }), true);
});

test('歷史白名單工具結果保留供客戶渲染，工作人員仍附於步驟', () => {
  const p = progress.progressFromHistory([
    { role: 'assistant', content: [{ type: 'step_summary', stepId: 'p', category: '發布網站' }] },
    { role: 'toolResult', toolCallId: 'p', toolName: 'publish_confirmed', content: [{ type: 'text', text: '發布成功 https://example.com' }] },
  ]);
  assert.equal(p.steps[0].result.content[0].text, '發布成功 https://example.com');
  assert.equal(p.timeline.at(-1).type, 'tool_result');
  assert.equal(p.timeline.at(-1).name, 'publish_confirmed');
});

// 僅代替 DOM 容器；所有更新、計時與續跑邏輯仍執行正式模組。
function testDocument() {
  return { createElement(tag) {
    return { tag, childNodes: [], handlers: {}, classList: { toggle() {} },
      setAttribute() {}, addEventListener(name, fn) { this.handlers[name] = fn; },
      append(...nodes) { this.childNodes.push(...nodes); },
      get lastChild() { return this.childNodes.at(-1); },
      removeChild(node) { this.childNodes.splice(this.childNodes.indexOf(node), 1); },
      insertBefore(node, ref) { const old = this.childNodes.indexOf(node); if (old >= 0) this.childNodes.splice(old, 1); const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length; this.childNodes.splice(i, 0, node); },
    };
  } };
}

test('重繪與心跳保留步驟節點、手動展開，續跑按鈕送固定句且重試不帶按鈕', () => {
  const document = testDocument();
  let sent;
  const view = progress.createProgressView({ document, renderBlock: b => ({ textContent: b.text }), onContinue: text => { sent = text; } });
  const step = { type: 'step_summary', stepId: 'a', n: 1, phase: 'start', category: '查看資料' };
  const p = { steps: [step], timeline: [step], startedAt: 1000, phase: 'thinking', phaseSince: 2000, finished: false };
  view.update(p, { hideToolCalls: true });
  const [details, , notice] = view.el.childNodes[1].childNodes;
  const [summary, list, heartbeat] = details.childNodes;
  const row = list.childNodes[0];
  assert.equal(details.open, true);
  view.tick(65000);
  assert.equal(heartbeat.textContent, '正在分析（已 63 秒）');
  assert.equal(summary.textContent, '處理中 · 第 1 步 · 已 1 分 04 秒');
  step.phase = 'end'; step.status = 'error'; p.finished = true;
  p.notice = { kind: 'truncated', message: '回覆可能不完整', detail: 'private-model' };
  view.update(p, { hideToolCalls: true });
  assert.equal(details.open, false);
  assert.equal(list.childNodes[0], row);
  assert.match(row.childNodes[0].textContent, /✗/);
  assert.equal(notice.childNodes[1].textContent, '');
  details.open = true; details.handlers.toggle();
  view.update(p, { hideToolCalls: true });
  assert.equal(details.open, true);
  notice.childNodes[2].handlers.click();
  assert.equal(sent, '請根據剛才查到的資料，直接給出結論');
  p.notice.retrying = true; view.update(p);
  assert.equal(notice.childNodes[2].hidden, true);
});

test('進度區沿用訊息主體結構，泡泡版型與工具樣式才能套用', () => {
  const document = testDocument();
  const view = progress.createProgressView({ document, renderBlock: () => ({}), onContinue() {} });
  assert.equal(view.el.childNodes[0].tag, 'h3');
  assert.equal(view.el.childNodes[1].className, 'message-body');
});

test('系統續跑說明不算模型可見答案', () => {
  const p = progress.progressFromHistory([
    { role: 'assistant', content: [], stopReason: 'length' },
    { role: 'user', readyaiAutoContinue: true, content: '系統自動續跑' },
    { role: 'assistant', content: [], stopReason: 'length' },
  ]);
  assert.match(p.notice.message, /沒有產生答案/);
});

test('F6：即時與歷史重建顯示同一個自訂標籤', async () => {
  const {describeStep} = await import('../dist/server/turn-progress.js');
  const {filterMessageHistory,parseUiProfile} = await import('../dist/server/ui-profile.js');
  const profile = {...parseUiProfile({uiProfile:'customer'},{}),toolLabels:{read:{start:'檢視網站 {file_basename}'}}};
  const liveStep = {type:'step_summary',stepId:'a',phase:'end',status:'ok',...describeStep('read',{path:'/site/index.html'},profile)};
  const history = filterMessageHistory([{role:'assistant',content:[{type:'toolCall',id:'a',name:'read',arguments:{path:'/site/index.html'}}]}],profile);
  const rendered = [];
  for (const p of [{steps:[liveStep],timeline:[liveStep],finished:true},progress.progressFromHistory(history)]) {
    const view = progress.createProgressView({document:testDocument(),renderBlock:()=>({}),onContinue(){}});
    view.update(p,profile);
    rendered.push(view.el.childNodes[1].childNodes[0].childNodes[1].childNodes[0].childNodes[0].textContent);
  }
  assert.match(rendered[0],/檢視網站 index.html/);
  assert.equal(rendered[1],rendered[0]);
});

for (const [stopReason,text,kind] of [['stop','','no_answer'],['length','部分結論','truncated'],['stop','結論',null]]) test(`F7：歷史末則 ${stopReason}/${text || '空白'} 決定提示`, () => {
  const p = progress.progressFromHistory([{role:'assistant',content:[{type:'text',text:'先查資料。'}]}, {role:'assistant',stopReason,content:text ? [{type:'text',text}] : []}]);
  assert.equal(p.notice?.kind ?? null,kind);
  if (stopReason === 'length') assert.equal(p.notice.message,'回覆可能不完整（內容太長被中斷）');
});

test('B1：工具結束封包到畫面立即恢復心跳，首個模型事件前已計秒', async () => {
  const {createTurnProgress,trackTurnEvent} = await import('../dist/server/turn-progress.js');
  const {createChatState,applyTurnProgress,onAgentStart} = await import('../public/chat-state.mjs');
  const state = createChatState(), tracker = createTurnProgress('t');
  onAgentStart(state);
  const view = progress.createProgressView({document:testDocument(),renderBlock:()=>({}),onContinue(){}});
  for (const [type, now] of [['tool_execution_start',1000],['tool_execution_end',2000]]) {
    for (const p of trackTurnEvent(tracker,{type,toolCallId:'a',toolName:'read',args:{}},{hideToolCalls:true},now)) applyTurnProgress(state,p.type,p.payload);
  }
  view.update(state.progress,{hideToolCalls:true}); view.tick(5000);
  const heartbeat = view.el.childNodes[1].childNodes[0].childNodes[2];
  assert.equal(heartbeat.hidden,false);
  assert.equal(heartbeat.textContent,'正在分析（已 3 秒）');
});

for (const failure of [false,true]) test(`B2：續跑期間提示可見，完成後${failure ? '換最終提示' : '清除提示'}`, async () => {
  const {createChatState,applyTurnProgress,onAgentStart,onAgentEnd} = await import('../public/chat-state.mjs');
  const state = createChatState(); onAgentStart(state);
  const view = progress.createProgressView({document:testDocument(),renderBlock:()=>({}),onContinue(){}});
  const retry = {turnId:'t',kind:'truncated',retrying:true,message:'內容太長被中斷，正在重新整理答案…'};
  applyTurnProgress(state,'turn_notice',retry); onAgentEnd(state);
  onAgentStart(state);
  applyTurnProgress(state,'turn_phase',{turnId:'t',phase:'thinking',since:1000});
  view.update(state.progress,{hideToolCalls:true},state.isRunning);
  const notice = view.el.childNodes[1].childNodes[2];
  assert.equal(notice.hidden,false);
  assert.equal(notice.childNodes[0].textContent,retry.message);
  assert.equal(notice.childNodes[2].hidden,true);
  if (failure) applyTurnProgress(state,'turn_notice',{turnId:'t',kind:'truncated',message:'回覆可能不完整'});
  onAgentEnd(state); view.update(state.progress,{hideToolCalls:true},state.isRunning);
  assert.equal(state.isRunning,false);
  assert.equal(state.progress.finished,true);
  assert.equal(notice.hidden,!failure);
  if (failure) assert.equal(notice.childNodes[2].hidden,false);
});

for (const history of [false, true]) test(`零步驟${history ? '歷史' : '即時'}結束只保留回答與提示`, () => {
  const p = history ? progress.progressFromHistory([{ role: 'assistant', content: [{ type: 'text', text: '部分答案' }], stopReason: 'length' }]) : { steps: [], timeline: [{ type: 'text', text: '部分答案' }], finished: true, notice: { kind: 'truncated', message: '回覆可能不完整' } };
  const view = progress.createProgressView({ document: testDocument(), renderBlock: b => ({ textContent: b.text }), onContinue() {} });
  view.update(p);
  const [details, answer, notice] = view.el.childNodes[1].childNodes;
  assert.equal(details.hidden, true);
  assert.equal(answer.childNodes[0].childNodes[0].textContent, '部分答案');
  assert.equal(notice.hidden, false);
});

test('零步驟進行中不顯示步驟列，仍持續顯示分析心跳', () => {
  const view = progress.createProgressView({ document: testDocument(), renderBlock: () => ({}), onContinue() {} });
  view.update({ steps: [], timeline: [], finished: false, phase: 'thinking', phaseSince: 1000 });
  view.tick(7000);
  const details = view.el.childNodes[1].childNodes[0];
  assert.equal(details.hidden, false);
  assert.equal(details.open, true);
  assert.equal(details.childNodes[0].hidden, true);
  assert.equal(details.childNodes[2].hidden, false);
  assert.equal(details.childNodes[2].textContent, '正在分析（已 6 秒）');
});

test('舊回合隱藏續跑按鈕但保留提示文字', () => {
  const view = progress.createProgressView({ document: testDocument(), renderBlock: () => ({}), onContinue() {} });
  const p = { steps: [], timeline: [], finished: true, notice: { kind: 'no_answer', message: '請再問一次' } };
  view.update(p);
  const notice = view.el.childNodes[1].childNodes[2];
  assert.equal(notice.childNodes[2].hidden, false);
  p.superseded = true;
  view.update(p);
  assert.equal(notice.childNodes[2].hidden, true);
  assert.equal(notice.hidden, false);
  assert.equal(notice.childNodes[0].textContent, '請再問一次');
});
