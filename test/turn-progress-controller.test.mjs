import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {isDeniedWsMessage} from '../dist/server/ws-guard.js';
import {CONTINUE_PROMPT,createTurnProgress} from '../dist/server/turn-progress.js';

// 不啟動伺服器；執行原控制器類別，僅替換 SDK 與傳輸／檔案副作用。
const source = fs.readFileSync(new URL('../src/server/index.ts',import.meta.url),'utf8');
const start = source.indexOf('class NativePiSessionController {');
const end = source.indexOf('\n// 追蹤所有活躍的 WS controller',start);
const code = ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const Controller = new Function('CONTINUE_PROMPT','logger','isBlockedCustomerMessage','isCustomerMode','profileName','profileFile','isDeniedWsMessage','wsDenySet',`${code}; return NativePiSessionController;`)(CONTINUE_PROMPT,{info(){},debug(){}},()=>false,()=>false,'staff',null,isDeniedWsMessage,new Set());
function fixture() {
  const c = Object.create(Controller.prototype);
  let finish;
  const calls = [];
  const session = {isStreaming:false,prompt(message) {
    calls.push(message);
    if (calls.length === 1) return new Promise(resolve => {finish=resolve;});
    return Promise.resolve();
  },async abort(){}};
  Object.assign(c,{runtime:{session,async switchSession(){return {cancelled:true};},async newSession(){return {cancelled:true};},async dispose(){}},turnProgress:createTurnProgress('t'),ready:Promise.resolve(),runCommand:async (_name,fn)=>fn(),sendState:async()=>{},stopFileWatch(){}});
  return {c,session,calls,finish:()=>finish()};
}
for (const action of ['abort','prompt','switch_session','new_session','close']) test(`F4：延遲收尾期間 ${action} 撤銷舊續跑`, async () => {
  const f = fixture();
  const pending = f.c.promptWithProgress('原題');
  f.c.turnProgress.retryPending=true;
  if (action === 'prompt') {f.session.isStreaming=true; await f.c.promptWithProgress('新題');}
  else if (action === 'close') await f.c.close();
  else await f.c.handle({type:action,sessionPath:'/tmp/other.jsonl'});
  f.finish();
  await pending;
  assert.deepEqual(f.calls,action === 'prompt' ? ['原題','新題'] : ['原題']);
});
test('F4：同會話正常收尾仍只續跑一次', async () => {
  const f = fixture();
  const pending = f.c.promptWithProgress('原題');
  f.c.turnProgress.retryPending=true;
  f.finish(); await pending;
  assert.deepEqual(f.calls,['原題',CONTINUE_PROMPT]);
});

test('F4：取消後遲到的結束事件不得重新啟用舊續跑', async () => {
  const f = fixture();
  const pending = f.c.promptWithProgress('原題');
  await f.c.handle({type:'abort'});
  // 模擬 SDK 非同步收尾在取消之後才送達截斷通知。
  f.c.turnProgress.retryPending=true;
  f.finish(); await pending;
  assert.deepEqual(f.calls,['原題']);
});
