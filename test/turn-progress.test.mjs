import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as progress from '../dist/server/turn-progress.js';
import { filterMessageHistory, filterEvent, parseUiProfile } from '../dist/server/ui-profile.js';

const customer = parseUiProfile({ uiProfile: 'customer' }, {});
test('分類與敏感對象不外洩', () => {
  assert.equal(progress.describeStep('read', {path:'/site/index.html'}).detail, 'index.html');
  assert.equal(progress.describeStep('bash', {command:'curl https://www.example.com/a'}).detail, 'www.example.com');
  assert.equal(progress.describeStep('bash', {command:'python script.py'}).category, '處理資料');
  for (const path of ['/a/.env', '/a/.pi/config.json', '/a/skills/demo/a.md', '/a/AGENTS.md', '/a/CLAUDE.md']) {
    assert.equal(progress.describeStep('read', {path}).detail, undefined);
  }
  for (const url of ['http://localhost/a','http://127.0.0.1/a','http://[::1]/a','http://pc2.example.com/a','http://bifrost.example.com/a','http://service.internal/a']) {
    assert.equal(progress.describeStep('bash', {command:`curl ${url}`}).detail, undefined);
  }
  assert.deepEqual(progress.describeStep('mcp__private__fetch', {url:'https://example.com'}), {category:'執行操作',label:'執行操作'});
});
test('步驟編號、耗時、錯誤與階段去重', () => {
  const state = progress.createTurnProgress('t');
  assert.equal(progress.trackTurnEvent(state, {type:'agent_start'}, customer, 100)[0].payload.phase,'thinking');
  assert.equal(progress.trackTurnEvent(state, {type:'message_update',assistantMessageEvent:{type:'thinking_start'}},customer,101).length,0);
  const start = progress.trackTurnEvent(state,{type:'tool_execution_start',toolCallId:'a',toolName:'read',args:{path:'/x/index.html'}},customer,110).find(p=>p.type==='turn_step');
  const end = progress.trackTurnEvent(state,{type:'tool_execution_end',toolCallId:'a',toolName:'read',isError:true},customer,130).find(p=>p.type==='turn_step');
  assert.equal(start.payload.n,1); assert.equal(start.payload.toolName,undefined);
  assert.equal(end.payload.n,1); assert.equal(end.payload.status,'error'); assert.equal(end.payload.elapsedMs,20);
});
test('截斷續跑最多一次；部分回答不續跑', () => {
  const state = progress.createTurnProgress('t');
  const event = {type:'agent_end',messages:[{role:'assistant',stopReason:'length',content:[]}]};
  assert.equal(progress.trackTurnEvent(state,event,customer)[0].payload.retrying,true);
  assert.equal(progress.trackTurnEvent(state,event,customer)[0].payload.retrying,undefined);
  const partial = progress.createTurnProgress('p');
  const packets = progress.trackTurnEvent(partial,{...event,messages:[{role:'assistant',stopReason:'length',content:[{type:'text',text:'答案'}]}]},customer);
  assert.equal(packets[0].payload.retrying,undefined);
});
test('歷史摘要維持交錯順序與工具失敗；只隱藏有標記的續跑訊息', () => {
  const user = {role:'user',content:[{type:'text',text:progress.CONTINUE_PROMPT}]};
  const messages = [user,{...user,readyaiAutoContinue:true},{role:'assistant',model:'secret',provider:'secret',api:'secret',content:[{type:'text',text:'先看資料'},{type:'toolCall',id:'a',name:'read',arguments:{path:'/x/index.html'}},{type:'text',text:'接著整理'}]},{role:'toolResult',toolCallId:'a',toolName:'read',isError:true,content:[]}];
  const out = filterMessageHistory(messages,customer);
  assert.equal(out.length,2); assert.equal(out[0],user);
  assert.deepEqual(out[1].content.map(b=>b.type),['text','step_summary','text']);
  assert.equal(out[1].content[1].status,'error');
  assert.equal(JSON.stringify(out).includes('secret'),false);
});
test('hideModel 單獨啟用也遮蔽訊息各快照，客戶錯誤不帶原文', () => {
  const p = {...customer,hideToolCalls:false,hideThinking:false,restrictCustomMessages:false};
  const message = {role:'assistant',model:'secret',provider:'secret',api:'secret',responseModel:'secret',responseId:'secret',diagnostics:[{message:'secret'}],content:[]};
  const event = {type:'message_update',message,assistantMessageEvent:{type:'error',error:message,partial:message}};
  assert.equal(JSON.stringify(filterEvent(event,p)).includes('secret'),false);
  const failed = filterEvent({type:'message_end',message:{...message,errorMessage:'secret stack',stopReason:'error'}},customer);
  assert.equal(JSON.stringify(failed).includes('secret'),false);
  assert.equal(JSON.stringify(filterEvent({type:'auto_retry_start',attempt:2,errorMessage:'secret'},customer)).includes('secret'),false);
});
test('turn_end 的工具結果快照同樣經過客戶白名單', () => {
  const event = {type:'turn_end',toolResults:[{role:'toolResult',toolName:'bash',content:[{type:'text',text:'PRIVATE_RESULT'}]},{role:'toolResult',toolName:'publish_confirmed',content:[{type:'text',text:'已發布'}]}]};
  const out = filterEvent(event, customer).event;
  assert.equal(out.toolResults.length,1);
  assert.equal(out.toolResults[0].toolName,'publish_confirmed');
  assert.equal(JSON.stringify(out).includes('PRIVATE_RESULT'),false);
});
test('正常、錯誤、停止與無回答的提示判定不混用', () => {
  for (const [stopReason,text,kind] of [['stop','答案',null],['error','', 'error'],['aborted','', 'aborted'],['stop','', 'no_answer'],['length','部分答案','truncated']]) {
    const state = progress.createTurnProgress('t');
    const packets = progress.trackTurnEvent(state,{type:'agent_end',messages:[{role:'assistant',stopReason,errorMessage:'PRIVATE',content:[{type:'text',text}]}]},customer);
    assert.equal(packets[0]?.payload.kind ?? null,kind);
    assert.equal(JSON.stringify(packets).includes('PRIVATE'),false);
    assert.equal(state.retryPending,false);
  }
  const state = progress.createTurnProgress('t');
  assert.deepEqual(progress.trackTurnEvent(state,{type:'agent_end',willRetry:true,messages:[{role:'assistant',stopReason:'error',content:[]}]},customer),[]);
});
test('寫入類 bash 僅顯示安全目標檔名；profile 占位符不繞過排除規則', () => {
  assert.equal(progress.describeStep('bash',{command:'printf hi > /site/index.html'}).detail,'index.html');
  assert.equal(progress.describeStep('bash',{command:"sed -i 's/a/b/' /site/index.html"}).detail,'index.html');
  const profile = {...customer,toolLabels:{read:{start:'查看 {file_basename}'},fetch:{start:'查詢 {url_host}'}}};
  assert.equal(progress.describeStep('read',{path:'/private/.pi/secret.json'},profile).label,'查看 ');
  assert.equal(progress.describeStep('fetch',{url:'http://localhost/secrets'},profile).label,'查詢 ');
  assert.equal(progress.describeStep('read',{path:'/site/index.html'},profile).label,'查看 index.html');
});

test('F1：單則工具結果與歷史共用白名單，所有訊息事件均不得繞過', () => {
  for (const type of ['message_start', 'message_end', 'message_update']) {
    for (const content of [[{type:'text',text:'PRIVATE_RESULT'}], 'PRIVATE_RESULT']) {
      assert.equal(filterEvent({type,message:{role:'toolResult',toolName:'bash',content}},customer),null);
      const allowed = filterEvent({type,message:{role:'toolResult',toolName:'publish_confirmed',content}},customer);
      assert.equal(allowed.event.message.toolName,'publish_confirmed');
    }
  }
});
test('F2：舊開始與結束標籤同樣排除敏感對象', () => {
  for (const [toolName,args,template,want] of [
    ['read',{path:'/private/.pi/secret.json'},'查看 {file_basename}','查看 '],
    ['fetch',{url:'http://bifrost.internal/admin'},'查詢 {url_host}','查詢 '],
    ['read',{path:'/site/index.html'},'查看 {file_basename}','查看 index.html'],
  ]) {
    const profile = {...customer,toolLabels:{[toolName]:{start:template,end:template}}};
    for (const type of ['tool_execution_start','tool_execution_end']) {
      assert.equal(filterEvent({type,toolName,args,toolCallId:'x'},profile).payload.label,want);
    }
  }
});
test('F3：重試結束錯誤只在允許原文的設定保留', () => {
  const event = {type:'auto_retry_end',success:false,finalError:'provider-secret /private/config https://bifrost.internal'};
  assert.equal(filterEvent(event,customer).event.finalError,progress.TURN_MESSAGES.error);
  assert.equal(filterEvent(event,{...customer,safeErrors:false}).event.finalError,event.finalError);
  assert.equal(filterEvent({...event,success:true,finalError:undefined},customer).event.finalError,undefined);
});
test('F6：歷史摘要保留安全自訂標籤，重建後仍優先顯示', async () => {
  const {progressFromHistory} = await import('../public/render-progress.mjs');
  const profile = {...customer,toolLabels:{read:{start:'查看 {file_basename}'}}};
  for (const [path,want] of [['/site/index.html','查看 index.html'],['/private/.pi/secret.json','查看 ']]) {
    const history = filterMessageHistory([{role:'assistant',content:[{type:'toolCall',id:'a',name:'read',arguments:{path}}]}],profile);
    assert.equal(history[0].content[0].label,want);
    assert.equal(progressFromHistory(history).steps[0].label,want);
  }
});

for (const [reason,text,kind,retrying] of [['length','','truncated',true],['stop','','no_answer',undefined],['length','部分結論','truncated',undefined],['stop','完成','',undefined]]) test(`F7：步驟前有說明，末則 ${reason}/${text || '空白'} 單獨決定提示`, () => {
  const state = progress.createTurnProgress('preambles');
  const preamble = {role:'assistant',content:[{type:'text',text:'我先查閱資料。'},{type:'toolCall',id:'a',name:'read',arguments:{path:'index.html'}}],stopReason:'toolUse'};
  progress.trackTurnEvent(state,{type:'message_end',message:preamble},customer);
  const packets = progress.trackTurnEvent(state,{type:'agent_end',messages:[preamble,{role:'assistant',stopReason:reason,content:text ? [{type:'text',text}] : []}]},customer);
  assert.equal(packets[0]?.payload.kind ?? '',kind);
  assert.equal(packets[0]?.payload.retrying,retrying);
  if (text && reason === 'length') assert.equal(packets[0].payload.message,progress.TURN_MESSAGES.partial);
});

test('B1：全部工具結束立即回到思考，等待首個模型事件也計時', () => {
  const state = progress.createTurnProgress('waiting');
  for (const id of ['a', 'b']) progress.trackTurnEvent(state, {type:'tool_execution_start',toolCallId:id,toolName:'read',args:{}}, customer, 100);
  const first = progress.trackTurnEvent(state, {type:'tool_execution_end',toolCallId:'a'}, customer, 200);
  assert.equal(first.some(p => p.type === 'turn_phase'), false);
  const last = progress.trackTurnEvent(state, {type:'tool_execution_end',toolCallId:'b',isError:true}, customer, 300);
  assert.deepEqual(last.map(p => p.type), ['turn_step', 'turn_phase']);
  assert.deepEqual(last[1].payload, {turnId:'waiting',phase:'thinking',since:300});
  assert.equal(progress.trackTurnEvent(state, {type:'message_update',assistantMessageEvent:{type:'thinking_start'}}, customer, 3000).length, 0);
});


test('customerText 轉繁時保留交錯的 step_summary', () => {
  const out = filterMessageHistory([{role:'assistant',content:[
    {type:'text',text:'已经完成'},
    {type:'toolCall',id:'step',name:'read',arguments:{path:'/x/index.html'}},
    {type:'text',text:'请查看资料'},
  ]}],{...customer,customerText:true});
  assert.deepEqual(out[0].content.map(b=>b.type),['text','step_summary','text']);
  assert.equal(out[0].content[0].text,'已經完成');
  assert.equal(out[0].content[1].stepId,'step');
  assert.equal(out[0].content[2].text,'請查看資料');
});

test('擴充續跑共用額度，且不排入 webui 的第二則續跑', () => {
  const state = progress.createTurnProgress('t');
  const event = {type:'message_start',message:{role:'custom',customType:'readyai_truncation_retry'}};
  assert.equal(progress.trackTurnEvent(state,event,customer)[0].payload.retryActive,true);
  assert.equal(progress.trackTurnEvent(state,event,customer).length,0);
  assert.equal(state.retryPending,false);
  const end = progress.trackTurnEvent(state,{type:'agent_end',messages:[{role:'assistant',stopReason:'length',content:[]}]},customer);
  assert.equal(end[0].payload.retrying,undefined);
  assert.equal(state.retryPending,false);
});
