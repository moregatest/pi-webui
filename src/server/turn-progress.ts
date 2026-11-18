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
export function describeStep(toolName: string, args: any = {}, profile?: UiProfile) {
  let category = '執行操作';
  let detail: string | undefined;
  const file = args.file_path ?? args.path ?? args.file;
  if (['read','ls','grep','find'].includes(toolName)) { category = '查看資料'; detail = safeFile(file); }
  else if (['edit','write'].includes(toolName)) { category = '修改內容'; detail = safeFile(file); }
  else if (['fetch','web_fetch','web_search','browser','curl','wget'].includes(toolName)) { category = '查詢網站'; detail = safeHost(args.url); }
  else if (toolName === 'publish_confirmed') category = '發布網站';
  else if (toolName === 'bash') {
    const command = String(args.command ?? '').trim();
    const verb = command.match(/^([\w-]+)(?:\s|$)/)?.[1];
    // 複合指令只分類、不猜測其實際目標，避免把 shell 片段當檔名。
    const simple = !/[|;&<>`$\n]/.test(command);
    const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g)?.map(t => t.replace(/^['"]|['"]$/g, '')) ?? [];
    const {files: outputs, count: redirectCount} = outputFiles(command);
    const writes = ['touch','mkdir','cp','mv','tee','rm'].includes(verb) || (verb === 'sed' && tokens.some(t => /^-i/.test(t)));
    // 寫入優先於讀取分類，cat input > output 也確實會改檔案。
    if (writes || outputs.length) {
      const target = simple ? tokens.at(-1) : undefined;
      // 沒有寫入動詞時只看導向目的地：全部落在暫存區就不算改內容（複合指令、2>&1 亦同）。
      // 複合指令逐段看開頭動詞，後段出現寫入動詞就不降級。
      const laterWrite = command.split(/[|;&\n]+/).slice(1).some(part => {
        const words = part.trim().split(/\s+/);
        return ['touch','mkdir','cp','mv','tee','rm'].includes(words[0]) || (words[0] === 'sed' && words.some(t => /^-i/.test(t)));
      });
      const temporary = !laterWrite && outputs.every(isTemporaryFile) && (!writes ? outputs.length > 0 : !/[|;&`$\n]/.test(command) &&
        (simple && ((verb === 'cp' && tokens.length === 3 && !tokens[1].startsWith('-')) ||
          (verb === 'tee' && tokens.length === 2)) && target && isTemporaryFile(target)));
      category = temporary ? '處理資料' : '修改內容';
      if (!temporary) {
        if (simple) detail = safeFile(target);
        else if (redirectCount === 1 && outputs.length === 1 && !/[|;&`$\n]/.test(command)) detail = safeFile(outputs[0]);
      }
    } else if (verb === 'mktemp') category = '處理資料';
    else if (['cat','grep','ls','head','jq'].includes(verb) || (verb === 'sed' && tokens.includes('-n'))) {
      category = '查看資料'; if (simple) detail = safeFile(tokens.at(-1));
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
