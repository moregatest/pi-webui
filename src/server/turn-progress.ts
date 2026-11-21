import { posix } from 'node:path';
// 回合進度只輸出固定分類與經過濾的對象；原始工具參數留在既有工程師事件。
import { isIP } from 'node:net';
import type { UiProfile } from './ui-profile.js';
import { resolveLabel } from './tool-label.js';

export const CONTINUE_PROMPT = '請根據剛才查到的資料，直接給出結論';
export const CUSTOMER_PROGRESS_PROMPT = '每次呼叫工具前，先用一句話告訴客戶你接下來要做什麼，不提檔案路徑、指令或系統名稱。';
export const TURN_MESSAGES = {
  retrying: '內容太長被中斷，正在重新整理答案…',
  truncated: '這次整理的內容太長，回覆被中斷，沒有產生答案。請再問一次，或把問題拆小一點。',
  partial: '回覆可能不完整（內容太長被中斷）',
  error: '處理時發生問題，沒有完成。請稍後再試一次。',
  aborted: '已停止。',
  no_answer: '這次沒有產生回答，請再問一次。',
};
export function isAutoContinueMessage(message: any): boolean {
  const content = message?.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(b => b.type === 'text').map(b => b.text).join('') : '';
  return message?.role === 'user' && message.readyaiAutoContinue === true && text === CONTINUE_PROMPT;
}
function safeFile(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.some(p => p.startsWith('.') || /^(skills?|AGENTS\.md|CLAUDE\.md)$/i.test(p))) return;
  const name = parts.at(-1);
  if (name && !/^(null|undefined)$/i.test(name) && /^[\p{L}\p{N}_ -]+(?:\.[\p{L}\p{N}_-]+)*$/u.test(name)) return name;
}
function safeHost(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!/^https?:$/.test(url.protocol) || !host.includes('.') || isIP(host.replace(/^\[|\]$/g, '')) || /(?:^|\.)(?:localhost|internal|local)$/.test(host) || /pc2|bifrost|litellm/i.test(host)) return;
    for (const key of ['PC2_SERVICE_HOST', 'PC2_SERVICE_HOST_ORIGINAL', 'LITELLM_BASE_URL', 'BIFROST_BASE_URL']) {
      try { if (process.env[key] && new URL(process.env[key]).hostname.toLowerCase() === host) return; } catch {}
    }
    return host;
  } catch { return; }
}
// 新舊進度封包共用同一組安全占位符參數。
export function safeLabelArgs(args: any = {}) {
  return { file: safeFile(args.file_path ?? args.path ?? args.file), url: safeHost(args.url) ? args.url : undefined, progress_count: Number.isFinite(args.progress_count) ? args.progress_count : undefined };
}
// 僅用於摘要分類，不執行 shell；略過引號內的 >，避免把文字當成導向。
function outputFiles(command: string) {
  const files: string[] = [];
  let count = 0;
  const redirects = /"(?:\\.|[^"\\])*"|'[^']*'|\\.|(>>?|>\|)\s*(&[12]\b|"(?:\\.|[^"\\])*"|'[^']*'|[^\s|;&<>]+)/g;
  for (const match of command.matchAll(redirects)) {
    if (!match[1]) continue;
    count++;
    const target = match[2].replace(/^['"]|['"]$/g, '');
    if (!/^(?:\/dev\/(?:null|stderr|stdout)|&[12])$/.test(target)) files.push(target);
  }
  return {files, count};
}
function isTemporaryFile(value: string): boolean {
  // 正規化後再判斷，/tmp/../site 不屬於暫存區；動態展開不猜目標。
  return !/[`$]/.test(value) && /^\/(?:private\/)?tmp\//.test(posix.normalize(value));
}
// 只用於摘要分類的保守 shell 掃描，不執行、也不假裝完整解析 shell。
// - 依引號狀態找出指令分隔（| ; & && || 換行），引號內的字元不算。
// - 找出命令替換 $( )、反引號、行程替換 <( ) >( )；雙引號內的 $( ) 與反引號也算（會執行）。
// - heredoc 內文是給程式的輸入，不是 shell 導向（python 的 `if n > 0` 不可被當成寫檔）：
//   內文從 text 移除；未加引號的內文若含 $( ) 或反引號視為命令替換；
//   找不到結束標記即標為 unparseable。引號內的 `<<EOF` 不是 heredoc。
export type ShellScan = {text: string; segments: string[]; hasSubst: boolean; unparseable: boolean; background: boolean};
export function scanShell(command: string): ShellScan {
  let text = '';
  const segments: string[] = [];
  let seg = '';
  let hasSubst = false, unparseable = false, background = false;
  let quote: '' | "'" | '"' = '';
  const pending: {delim: string; quoted: boolean}[] = [];
  const emit = (chunk: string) => { text += chunk; seg += chunk; };
  const split = () => { segments.push(seg); seg = ''; };
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    const next = command[i + 1];
    if (quote === "'") { emit(ch); if (ch === "'") quote = ''; i++; continue; }
    if (ch === '\\' && i + 1 < command.length) { emit(ch + next); i += 2; continue; }
    if (quote === '"') {
      if (ch === '`' || (ch === '$' && next === '(')) hasSubst = true;
      emit(ch); if (ch === '"') quote = ''; i++; continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; emit(ch); i++; continue; }
    if (ch === '`' || (ch === '$' && next === '(') || ((ch === '<' || ch === '>') && next === '(')) hasSubst = true;
    if (ch === '<' && next === '<') {
      if (command[i + 2] === '<') { emit('<<<'); i += 3; continue; }
      // heredoc 起始：<<[-] 空白 標記（可加引號）
      const m = command.slice(i).match(/^<<(-?)[ \t]*('([^'\n]*)'|"([^"\n]*)"|([^\s;&|<>()]+))/);
      if (!m) { unparseable = true; emit('<<'); i += 2; continue; }
      const word = m[5] ?? '';
      const quoted = m[3] !== undefined || m[4] !== undefined || /['"\\]/.test(word);
      const delim = m[3] ?? m[4] ?? word.replace(/['"\\]/g, '');
      if (!delim) unparseable = true;
      pending.push({delim, quoted});
      emit(m[0]); i += m[0].length; continue;
    }
    if (ch === '\n') {
      if (pending.length) {
        // 逐一吃掉 heredoc 內文，直到各自的結束標記行。
        let pos = i + 1;
        while (pending.length) {
          const {delim, quoted} = pending.shift()!;
          const body: string[] = [];
          let found = false;
          while (pos <= command.length) {
            const nl = command.indexOf('\n', pos);
            const line = command.slice(pos, nl === -1 ? command.length : nl);
            pos = nl === -1 ? command.length + 1 : nl + 1;
            if (line.replace(/^\t+/, '') === delim) { found = true; break; }
            body.push(line);
          }
          if (!found) unparseable = true;
          if (!quoted && /\$\(|`/.test(body.join('\n'))) hasSubst = true;
        }
        split(); text += '\n';
        i = Math.min(pos, command.length);
        continue;
      }
      split(); text += '\n'; i++; continue;
    }
    if (ch === '|' || ch === ';' || ch === '&') {
      const prev = command[i - 1];
      // >| >& <& &> 是導向，不是分隔
      if ((ch === '|' || ch === '&') && (prev === '>' || prev === '<')) { emit(ch); i++; continue; }
      if (ch === '&' && next === '>') { emit(ch); i++; continue; }
      if (ch === '&' && next !== '&' && prev !== '&') background = true;
      text += ch;
      if (seg) split();
      i++; continue;
    }
    emit(ch); i++;
  }
  if (quote || pending.length) unparseable = true;
  split();
  return {text, segments: segments.map(s => s.trim()).filter(Boolean), hasSubst, unparseable, background};
}
// 相容舊名稱：只保留起始行，移除 heredoc 內文。
export function stripHeredocBodies(command: string): string {
  return scanShell(command).text;
}
const WRITE_VERBS = ['touch','mkdir','cp','mv','tee','rm'];
function isWriteSegment(part: string): boolean {
  const words = part.trim().split(/\s+/);
  return WRITE_VERBS.includes(words[0]) || (words[0] === 'sed' && words.some(t => /^-i/.test(t)));
}
// 唯讀動詞帶了會改狀態的參數就不算唯讀（date -s / 設時、sed 的 w 指令、file -C）。
function readOnlyArgs(verb: string | undefined, tokens: string[]): boolean {
  const rest = tokens.slice(1);
  if (verb === 'date') {
    return rest.every(t => t.startsWith('+') || /^(?:-u|-R|--utc|--universal|--rfc-2822|--rfc-email|-I\w*|--iso-8601(?:=\w+)?)$/.test(t));
  }
  if (verb === 'sed') {
    if (!rest.includes('-n') || rest.some(t => /^-i|^--in-place/.test(t))) return false;
    const script = rest.find(t => !/^-[nEr]$/.test(t));
    // 只認常見的純印出寫法：1,80p、$p、/pattern/p
    return !!script && /^(?:(?:\d+|\$)(?:,(?:\d+|\$))?p|\/[^/]*\/p)$/.test(script);
  }
  if (verb === 'file') return !rest.some(t => /^-C|^--compile/.test(t));
  return true;
}
// 只讀取、不改檔的小指令(導向到檔案時仍由寫入判斷優先處理)。
const READ_ONLY_VERBS = ['cat','grep','ls','head','tail','jq','echo','printf','printenv','pwd','which','date','wc','stat','file'];
export function describeStep(toolName: string, args: any = {}, profile?: UiProfile) {
  let category = '執行操作';
  let detail: string | undefined;
  const file = args.file_path ?? args.path ?? args.file;
  if (['read','ls','grep','find'].includes(toolName)) { category = '查看資料'; detail = safeFile(file); }
  else if (['edit','write'].includes(toolName)) { category = '修改內容'; detail = safeFile(file); }
  else if (['fetch','web_fetch','web_search','browser','curl','wget'].includes(toolName)) { category = '查詢網站'; detail = safeHost(args.url); }
  // check_only 只呼叫唯讀 summary,不發布;只認布林 true,與工具本身判斷一致。
  else if (toolName === 'publish_confirmed') category = args.check_only === true ? '查看發布狀態' : '發布網站';
  else if (toolName === 'publication_status') category = '查看發布狀態';
  else if (toolName === 'bash') {
    // 開頭的 cd <dir> && 只是切目錄,依後段指令分類。
    const scan = scanShell(String(args.command ?? '').trim());
    let command = scan.text;
    let cdCount = 0;
    for (let m; (m = command.match(/^cd\s+(?:"[^"]*"|'[^']*'|[^\s|;&<>]+)\s*&&\s*/)); cdCount++) command = command.slice(m[0].length);
    const segments = scan.segments.slice(cdCount);
    const verb = command.match(/^([\w-]+)(?:\s|$)/)?.[1];
    // 複合指令只分類、不猜測其實際目標，避免把 shell 片段當檔名。
    const simple = !/[|;&<>`$\n]/.test(command);
    const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map(t => t.replace(/^['"]|['"]$/g, '')) ?? [];
    const {files: outputs, count: redirectCount} = outputFiles(command);
    // 任一段是寫入動詞就算寫入（echo ready && rm x、printf x | tee y）。
    const laterWrite = segments.slice(1).some(isWriteSegment);
    const writes = WRITE_VERBS.includes(verb) || (verb === 'sed' && tokens.some(t => /^-i/.test(t))) || laterWrite;
    // 寫入優先於讀取分類，cat input > output 也確實會改檔案。
    if (writes || outputs.length) {
      const target = simple ? tokens.at(-1) : undefined;
      // 沒有寫入動詞時只看導向目的地：全部落在暫存區就不算改內容（複合指令、2>&1 亦同）。
      // 複合指令逐段看開頭動詞，後段出現寫入動詞就不降級。
      const temporary = !laterWrite && outputs.every(isTemporaryFile) && (!writes ? outputs.length > 0 : !/[|;&`$\n]/.test(command) &&
        (simple && ((verb === 'cp' && tokens.length === 3 && !tokens[1].startsWith('-')) ||
          (verb === 'tee' && tokens.length === 2)) && target && isTemporaryFile(target)));
      category = temporary ? '處理資料' : '修改內容';
      if (!temporary) {
        if (simple) detail = safeFile(target);
        else if (redirectCount === 1 && outputs.length === 1 && !/[|;&`$\n]/.test(command)) detail = safeFile(outputs[0]);
      }
    } else if (verb === 'mktemp') category = '處理資料';
    // 只有能證明是單純讀取的單一指令才標查看：不可是複合指令、不可有命令替換、heredoc 要能解析、參數不可改狀態。
    else if ((READ_ONLY_VERBS.includes(verb) || verb === 'sed') && segments.length === 1 && !scan.background &&
      !scan.hasSubst && !scan.unparseable && readOnlyArgs(verb, tokens)) {
      // echo/printf/date 等的最後一個參數不是檔名,只對讀檔類動詞附檔名。
      category = '查看資料'; if (simple && !['echo','printf','printenv','pwd','which','date'].includes(verb)) detail = safeFile(tokens.at(-1));
    } else if (['curl','wget'].includes(verb)) {
      category = '查詢網站'; if (simple) detail = safeHost(tokens.find(t => /^https?:\/\//.test(t)));
    } else if (['python','python3','node'].includes(verb) || (verb === 'uv' && tokens[1] === 'run')) category = '處理資料';
  }
  let label = category;
  if (profile?.toolLabels?.[toolName]?.start !== undefined || profile?.toolLabels?._default?.start !== undefined) {
    // 沿用 placeholder 白名單，但新客戶摘要不容許展開原始參數或敏感對象。
    const safeArgs = profile.hideToolCalls ? safeLabelArgs(args) : args;
    label = resolveLabel({...profile, exposeToolArgs: profile.hideToolCalls ? false : profile.exposeToolArgs}, toolName, 'start', safeArgs, {warn() {}}) || category;
  }
  return {category, label, ...(detail ? {detail} : {})};
}
export function stepSummary(block: any, isError: boolean, profile: UiProfile) {
  const { category, label, detail } = describeStep(block.name ?? block.toolName ?? '', block.arguments ?? block.args ?? {}, profile);
  return {type:'step_summary', stepId:block.id ?? block.toolCallId, category, label, ...(detail ? {detail} : {}), status:isError ? 'error' : 'ok'};
}
export function createTurnProgress(turnId: string) {
  return {turnId, n:0, phase:'', retried:false, retryPending:false, steps:new Map<string, any>()};
}
export function trackTurnEvent(state: ReturnType<typeof createTurnProgress>, event: any, profile: UiProfile, now = Date.now()): any[] {
  const packets: any[] = [];
  const phase = (value: string) => {
    if (state.phase === value) return;
    state.phase = value;
    packets.push({type:'turn_phase',payload:{turnId:state.turnId,phase:value,since:now}});
  };
  if (event.type === 'agent_start') phase('thinking');
  // 預覽擴充已在 SDK 佇列送出續跑；共用本回合額度，只通知、不再排第二則。
  if (event.type === 'message_start' && event.message?.role === 'custom' &&
      event.message.customType === 'readyai_truncation_retry' && !state.retried) {
    state.retried = true;
    state.retryPending = false;
    packets.push({type:'turn_notice',payload:{turnId:state.turnId,kind:'truncated',
      message:TURN_MESSAGES.retrying,retrying:true,retryActive:true}});
  }

  if (event.type === 'message_update') {
    const ame = event.assistantMessageEvent;
    if (ame?.type === 'start' || ame?.type === 'thinking_start') phase('thinking');
    if (ame?.type === 'text_start') phase('writing');
  }
  if (event.type === 'tool_execution_start') {
    phase('tool');
    const step = {turnId:state.turnId, stepId:event.toolCallId, n:++state.n, ...describeStep(event.toolName,event.args,profile), ...(!profile.hideToolCalls ? {toolName:event.toolName} : {})};
    state.steps.set(event.toolCallId,{step, startedAt:now});
    packets.push({type:'turn_step',payload:{...step,phase:'start'}});
  }
  if (event.type === 'tool_execution_end') {
    const entry = state.steps.get(event.toolCallId);
    if (entry) {
      entry.finished = true;
      packets.push({type:'turn_step',payload:{...entry.step,phase:'end',status:event.isError ? 'error' : 'ok',elapsedMs:Math.max(0,now-entry.startedAt)}});
      // 工具全數結束即開始等待模型，不能等第一個思考事件才顯示心跳。
      if ([...state.steps.values()].every(step => step.finished)) phase('thinking');
    }
  }
  if (event.type === 'agent_end' && !event.willRetry) {
    const assistants = (event.messages ?? []).filter(m => m.role === 'assistant');
    const last = assistants.at(-1);
    const reason = last?.stopReason;
    // 工具前說明不等於最終回答；只看最後一則助理訊息。
    const hasAnswer = last?.content?.some(b => b.type === 'text' && b.text?.trim()) ?? false;
    const kind = reason === 'length' ? 'truncated' : reason === 'error' ? 'error' : reason === 'aborted' ? 'aborted' : !hasAnswer ? 'no_answer' : null;
    if (kind) {
      const retrying = kind === 'truncated' && !hasAnswer && !state.retried;
      if (retrying) {state.retried = true; state.retryPending = true;}
      packets.push({type:'turn_notice',payload:{turnId:state.turnId,kind,message:retrying ? TURN_MESSAGES.retrying : kind === 'truncated' && hasAnswer ? TURN_MESSAGES.partial : TURN_MESSAGES[kind],...(retrying ? {retrying:true} : {}),...(!profile.hideToolCalls ? {detail:reason ?? 'unknown'} : {})}});
    }
  }
  return packets;
}
