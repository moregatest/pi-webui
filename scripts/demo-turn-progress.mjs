#!/usr/bin/env node
// 本機示範：隔離設定與工作目錄，絕不繼承真實憑證或擴充套件。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createChatState } from '../public/chat-state.mjs';
import { dispatchSessionEvent } from '../public/session-dispatch.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCENARIOS = ['truncated-retry-ok', 'truncated-twice', 'normal', 'error'];
const scenario = process.argv.find(a => a.startsWith('--scenario='))?.split('=')[1]
  ?? process.env.DEMO_SCENARIO ?? 'truncated-retry-ok';
const selfTest = process.argv.includes('--self-test');
const visiblePreambles = true;
if (!SCENARIOS.includes(scenario)) throw new Error(`未知情境：${scenario}`);
if (process.argv.includes('--help')) {
  console.log('node scripts/demo-turn-progress.mjs [--scenario=truncated-retry-ok|truncated-twice|normal|error] [--visible-preambles] [--self-test]\n--visible-preambles：所有情境預設先說兩句，保留此參數供相容。\n--self-test：以相同延遲驗證全部情境、兩種介面後自動清理。');
  process.exit(0);
}
const PASSWORD = 'demo-progress-local';
const FINAL = '資料整理完成：已執行八個步驟，包含一次預期的失敗；其餘資料已完成核對。';
const CONTINUE = '請根據剛才查到的資料，直接給出結論';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'px-turn-demo-'));
const children = [];
const sockets = new Set();
const requests = { customer: [], staff: [] };
let currentScenario = scenario;
let stopping = false;
let mock;
const workspaces = {};

async function cleanup() {
  if (stopping) return;
  stopping = true;
  for (const ws of sockets) ws.terminate();
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
  }));
  if (mock) {
    mock.closeAllConnections();
    await new Promise(resolve => mock.close(resolve));
  }
  fs.rmSync(root, { recursive: true, force: true });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void cleanup().then(() => process.exit(0));
});

async function startMock() {
  mock = http.createServer(async (req, res) => {
    if (req.url === '/fixture') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('公開網頁樣式的本機示範資料\n');
      return;
    }
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      const profile = req.url.split('/')[1];
      if (!requests[profile]) { res.writeHead(404); res.end(); return; }
      // 從本次提問後的工具結果推導輪數，兩介面與重複提問互不干擾。
      const messages = input.messages;
      const textOf = m => typeof m.content === 'string' ? m.content : (m.content ?? []).map(b => b.text ?? '').join('');
      const start = messages.findLastIndex(m => m.role === 'user' && textOf(m) !== CONTINUE);
      const tail = messages.slice(start + 1);
      const n = tail.filter(m => m.role === 'tool').length + 1;
      const continuing = tail.some(m => m.role === 'user' && textOf(m) === CONTINUE);
      requests[profile].push({ n, continuing });
      console.log(`${profile} / ${currentScenario}：第 ${n} 輪${continuing ? '（續跑）' : ''}`);
      const ms = 3000 + ((n - 1) % 4) * 1000;
      await delay(ms);
      if (res.destroyed) return;
      if (n > 8 && currentScenario === 'error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '本機示範上游故意失敗', type: 'server_error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
        id: `demo-${n}`, object: 'chat.completion.chunk', model: 'probe-model',
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`);
      emit({ role: 'assistant', reasoning_content: 'DEMO_PRIVATE_REASONING：正在分析示範資料。' });
      if (n <= 8) {
        if ((visiblePreambles || !currentScenario.startsWith('truncated')) && (n === 3 || n === 6)) emit({ content: n === 3 ? '接下來查閱公開資料並比對內容。' : '已取得主要資料，接著核對剩餘項目。' });
        const name = n % 2 ? 'bash' : 'read';
        let args = { path: path.join(workspaces[profile], 'fixture.txt') };
        if (name === 'bash') args = { command: n === 3
          ? `curl --noproxy '*' --connect-to example.com:80:127.0.0.1:${mock.address().port} --max-time 5 http://example.com/fixture`
          : n === 5 ? "printf '預期失敗：示範工具錯誤\\n' >&2; exit 1" : "printf '示範步驟完成\\n'" };
        emit({ tool_calls: [{ index: 0, id: `step-${n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
        emit({}, 'tool_calls');
      } else if (currentScenario === 'normal' || (currentScenario === 'truncated-retry-ok' && continuing)) {
        emit({ content: FINAL }); emit({}, 'stop');
      } else emit({}, 'length');
      res.end('data: [DONE]\n\n');
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end('本機假上游請求格式錯誤');
      console.error(error.message);
    }
  });
  await new Promise((resolve, reject) => {
    mock.once('error', reject);
    mock.listen(0, '127.0.0.1', resolve);
  });
}

async function startServer(profile, port) {
  const base = path.join(root, profile);
  const agentDir = path.join(base, 'agent');
  const cwd = path.join(base, 'work');
  const home = path.join(base, 'home');
  for (const dir of [agentDir, cwd, home]) fs.mkdirSync(dir, { recursive: true });
  workspaces[profile] = cwd;
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), '本機示範資料：核對產品、網址與處理進度。\n');
  const url = `http://127.0.0.1:${mock.address().port}`;
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { probe: {
    baseUrl: `${url}/${profile}`, apiKey: 'dummy-local-key', api: 'openai-completions',
    models: [{ id: 'probe-model', name: 'Demo Model', contextWindow: 32000, maxTokens: 512 }],
  } } }));
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }));
  const args = [path.join(REPO, 'dist/server/index.js'), '--listen', `127.0.0.1:${port}`, '--hide-model'];
  if (profile === 'customer') args.push('--profile', 'customer', '--allow-unsafe-customer');
  // 白名單環境：不展開 process.env，避免憑證、NODE_OPTIONS、代理或使用者設定流入。
  const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, TMPDIR: root, LANG: 'en_US.UTF-8',
    PI_AGENT_DIR: agentDir, PI_PROJECT_CWD: cwd, PI_WEBUI_MODEL: 'probe/probe-model',
    PI_WEBUI_PASSWORD: PASSWORD, PI_WEBUI_HIDE_MODEL: '1', PI_WEBUI_BASE_PATH: '/webui',
    PI_WEBUI_SKILLS_OPEN: '1', LITELLM_BASE_URL: url, LITELLM_API_KEY: 'dummy-local-key',
    PC2_SERVICE_HOST: url, PC2_API_TOKEN: 'dummy-local-token',
  } });
  children.push(child);
  return await new Promise((resolve, reject) => {
    let output = '', ready = false;
    const timer = setTimeout(() => reject(new Error(`啟動逾時：${profile}\n${output.slice(-2000)}`)), 20000);
    const read = chunk => {
      output += chunk;
      const match = output.match(/url=(http:\/\/127\.0\.0\.1:\d+)/);
      if (match && !ready) { ready = true; clearTimeout(timer); resolve({ profile, url: match[1] }); }
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (!ready) reject(new Error(`啟動失敗：${profile} (${code})\n${output.slice(-2000)}`));
      else if (!stopping) { console.error(`${profile} 服務意外結束 (${code})`); void cleanup().then(() => process.exit(1)); }
    });
  });
}
async function waitFor(check, label) {
  const until = Date.now() + 100000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`等待逾時：${label}`);
    await delay(30);
  }
}
async function verify(server) {
  const response = await fetch(`${server.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(response.status, 200);
  const ws = new WebSocket(`${server.url.replace('http:', 'ws:')}/ws`, { headers: { cookie: response.headers.get('set-cookie').split(';')[0] } });
  sockets.add(ws);
  const packets = [];
  ws.on('message', data => packets.push(JSON.parse(String(data))));
  try {
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'ready', lastSeq: null, sessionFile: null }));
    await waitFor(() => packets.some(p => p.type === 'message_history'), '初始歷史');
    ws.send(JSON.stringify({ type: 'prompt', message: `請整理本機示範資料：${currentScenario}` }));
    await waitFor(() => packets.some(p => p.type === 'command_result' && p.payload?.command === 'prompt'), '回合完成');
    const ends = packets.filter(p => p.type === 'turn_step' && p.payload.phase === 'end');
    assert.equal(ends.length, 8);
    assert.equal(ends.filter(p => p.payload.status === 'error').length, 1);
    for (const end of ends) {
      const index = packets.indexOf(end);
      // 每步完成立即恢復思考，不依賴下一輪首個模型事件。
      assert.equal(packets[index + 1]?.type, 'turn_phase');
      assert.equal(packets[index + 1]?.payload.phase, 'thinking');
    }
    const state = createChatState();
    let continuation = false, checkedContinuation = false;
    for (const packet of packets) {
      const event = packet.type === 'session_event' ? packet.payload
        : ['turn_step','turn_phase','turn_notice'].includes(packet.type) ? {...packet.payload,type:packet.type} : null;
      if (!event) continue;
      if (event.type === 'agent_start' && state.progress?.notice?.retrying) continuation = true;
      dispatchSessionEvent(state,event);
      if (continuation && event.type !== 'agent_end' && !(event.type === 'turn_notice' && !event.retrying)) {
        assert.equal(state.progress.notice?.retrying,true,'續跑期間提示必須保留');
        checkedContinuation = true;
      }
      if (event.type === 'agent_end' && continuation) continuation = false;
    }
    if (currentScenario.startsWith('truncated')) assert.equal(checkedContinuation,true);
    assert.equal(state.isRunning,false);
    if (currentScenario === 'truncated-retry-ok') assert.equal(state.progress.notice,null);
    if (currentScenario === 'truncated-twice') {
      assert.equal(state.progress.notice.kind,'truncated');
      assert.equal(Boolean(state.progress.notice.retrying),false);
    }
    const history = packets.filter(p => p.type === 'message_history').at(-1).payload;
    const last = history.filter(m => m.role === 'assistant').at(-1);
    assert.equal(last.stopReason, currentScenario === 'error' ? 'error' : currentScenario === 'truncated-twice' ? 'length' : 'stop');
    const notices = packets.filter(p => p.type === 'turn_notice');
    assert.equal(notices.length, currentScenario === 'normal' ? 0 : currentScenario === 'truncated-twice' ? 2 : 1);
    const count = requests[server.profile].length;
    assert.equal(count, currentScenario.startsWith('truncated') ? 10 : 9);
    if (last.stopReason === 'stop') assert.ok(JSON.stringify(last).includes(FINAL));
    console.log(`通過 ${server.profile} / ${currentScenario}：${count} 次上游請求、8 步、1 次預期工具失敗、${notices.length} 則提示、結束=${last.stopReason}`);
  } finally { ws.terminate(); sockets.delete(ws); }
}
try {
  await startMock();
  const servers = [await startServer('customer', 4196), await startServer('staff', 4197)];
  console.log(`客戶：http://127.0.0.1:4196/webui/\n員工：http://127.0.0.1:4197/webui/\n本機示範密碼：${PASSWORD}\n情境：${scenario}；工具前文字：${visiblePreambles || !scenario.startsWith('truncated') ? '兩輪可見' : '關閉'}；每輪等待 3～6 秒。輸入任意問題開始。\n停止：Ctrl-C（清除子程序與暫存目錄）。`);
  if (selfTest) {
    for (const item of SCENARIOS) {
      currentScenario = item;
      requests.customer.length = requests.staff.length = 0;
      await Promise.all(servers.map(verify));
    }
    await cleanup();
    console.log('全部驗證通過；服務與暫存目錄已清除。');
  }
} catch (error) {
  console.error(error);
  await cleanup();
  process.exitCode = 1;
}
