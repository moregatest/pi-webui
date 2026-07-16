// 客戶導向 UI profile 解析與運用。
//
// 設計原則:
//   - server 是主要過濾漏斗(message_update content / tool_execution_*);
//     client 端僅做 defensive secondary filter
//   - tool 細節隱藏時可選 --show-tool-progress 改送 user-friendly 標籤,
//     避免客戶以為 AI 當機
//   - --safe-errors 把 server_error 包成 generic 訊息 + 6-hex ticket,
//     原始訊息寫進 server log 配對
//
// 對應規格:docs/superpowers/specs/2026-05-22-customer-ui-profile-design.md

import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";

import type { ProfileFile, ToolLabelEntry } from "./profile-loader.js";
import { resolveLabel } from "./tool-label.js";
import { redactBlocks } from "./secret-guard.js";

export interface UiProfile {
  hideThinking: boolean;
  hideToolCalls: boolean;
  showToolProgress: boolean;
  hideStatusChips: boolean;
  hideSessionPicker: boolean;
  hideModel: boolean;
  safeErrors: boolean;
  exposeToolArgs: boolean;
  // 對話版型:bubble(Claude 式左右氣泡)/ log(工程師視圖,預設)。
  chatLayout: "bubble" | "log";
  brand: {
    name: string | null;
    logoPath: string | null;
    faviconPath: string | null;
    mode: "dark" | "light" | null;
    tokens: {
      bg?: string;
      panel?: string;
      text?: string;
      accent?: string;
      border?: string;
      muted?: string;
    };
    cssPath: string | null;
  };
  // profileFile.tool_labels 讀入後放置於此;resolveLabel 依此覆蓋 built-in 標籤
  toolLabels: Record<string, ToolLabelEntry>;
}

// preset 名 → 展開後的 boolean 預設(brand 維持 null)。
const PRESETS: Record<string, Partial<Omit<UiProfile, "brand">>> = {
  customer: {
    hideThinking: true,
    hideToolCalls: true,
    showToolProgress: true,
    hideStatusChips: true,
    hideSessionPicker: true,
    hideModel: true,
    safeErrors: true,
    chatLayout: "bubble",
  },
};

const COLOR_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

export interface ParseUiProfileInput {
  hideThinking?: boolean;
  hideToolCalls?: boolean;
  showToolProgress?: boolean;
  hideStatusChips?: boolean;
  hideSessionPicker?: boolean;
  hideModel?: boolean;
  safeErrors?: boolean;
  exposeToolArgs?: boolean;
  chatLayout?: string;
  uiProfile?: string;
  brandName?: string;
  brandLogo?: string;
  brandFavicon?: string;
  brandColor?: string;
}

function envBool(env: NodeJS.ProcessEnv, key: string): boolean {
  return env[key] === "1";
}

export function parseUiProfile(
  cli: ParseUiProfileInput,
  env: NodeJS.ProcessEnv,
  profileFile?: ProfileFile,
): UiProfile {
  const profile: UiProfile = {
    hideThinking: false,
    hideToolCalls: false,
    showToolProgress: false,
    hideStatusChips: false,
    hideSessionPicker: false,
    hideModel: false,
    safeErrors: false,
    exposeToolArgs: false,
    chatLayout: "log",
    brand: {
      name: null,
      logoPath: null,
      faviconPath: null,
      mode: null,
      tokens: {},
      cssPath: null,
    },
    toolLabels: {},
  };

  // profileFile 套用(precedence 在 default 之上、preset / CLI / env 之下)
  if (profileFile?.ui) {
    const ui = profileFile.ui;
    if (ui.hide_thinking !== undefined) profile.hideThinking = ui.hide_thinking;
    if (ui.hide_tool_calls !== undefined) profile.hideToolCalls = ui.hide_tool_calls;
    if (ui.show_tool_progress !== undefined) profile.showToolProgress = ui.show_tool_progress;
    if (ui.hide_status_chips !== undefined) profile.hideStatusChips = ui.hide_status_chips;
    if (ui.hide_session_picker !== undefined) profile.hideSessionPicker = ui.hide_session_picker;
    if (ui.hide_model !== undefined) profile.hideModel = ui.hide_model;
    if (ui.safe_errors !== undefined) profile.safeErrors = ui.safe_errors;
    if (ui.expose_tool_args !== undefined) profile.exposeToolArgs = ui.expose_tool_args;
    if (ui.chat_layout !== undefined) profile.chatLayout = ui.chat_layout;
  }

  if (profileFile?.brand) {
    const b = profileFile.brand;
    if (b.name !== undefined) profile.brand.name = b.name;
    if (b.logo !== undefined) profile.brand.logoPath = b.logo;
    if (b.favicon !== undefined) profile.brand.faviconPath = b.favicon;
    if (b.mode !== undefined) profile.brand.mode = b.mode;
    if (b.css !== undefined) profile.brand.cssPath = b.css;
    for (const k of ["bg", "panel", "text", "accent", "border", "muted"] as const) {
      const v = b[k];
      if (v !== undefined) profile.brand.tokens[k] = v;
    }
  }

  // profileFile.tool_labels → 覆蓋 toolLabels(shallow copy)
  if (profileFile?.tool_labels) {
    profile.toolLabels = { ...profileFile.tool_labels };
  }

  // preset 展開(CLI > env)。個別 flag 後面再覆蓋。
  const presetName = cli.uiProfile ?? env.PI_WEBUI_UI_PROFILE;
  if (presetName) {
    const preset = PRESETS[presetName];
    if (!preset) {
      const supported = Object.keys(PRESETS).join(", ");
      throw new Error(
        `ui-profile: unknown preset '${presetName}' (supported: ${supported})`,
      );
    }
    Object.assign(profile, preset);
  }

  if (cli.hideThinking !== undefined) {
    profile.hideThinking = !!cli.hideThinking;
  } else if (envBool(env, "PI_WEBUI_HIDE_THINKING")) {
    profile.hideThinking = true;
  }
  if (cli.hideToolCalls !== undefined) {
    profile.hideToolCalls = !!cli.hideToolCalls;
  } else if (envBool(env, "PI_WEBUI_HIDE_TOOL_CALLS")) {
    profile.hideToolCalls = true;
  }
  if (cli.showToolProgress !== undefined) {
    profile.showToolProgress = !!cli.showToolProgress;
  } else if (envBool(env, "PI_WEBUI_SHOW_TOOL_PROGRESS")) {
    profile.showToolProgress = true;
  }
  if (cli.hideStatusChips !== undefined) {
    profile.hideStatusChips = !!cli.hideStatusChips;
  } else if (envBool(env, "PI_WEBUI_HIDE_STATUS_CHIPS")) {
    profile.hideStatusChips = true;
  }
  if (cli.hideSessionPicker !== undefined) {
    profile.hideSessionPicker = !!cli.hideSessionPicker;
  } else if (envBool(env, "PI_WEBUI_HIDE_SESSION_PICKER")) {
    profile.hideSessionPicker = true;
  }
  if (cli.hideModel !== undefined) {
    profile.hideModel = !!cli.hideModel;
  } else if (envBool(env, "PI_WEBUI_HIDE_MODEL")) {
    profile.hideModel = true;
  }
  if (cli.safeErrors !== undefined) {
    profile.safeErrors = !!cli.safeErrors;
  } else if (envBool(env, "PI_WEBUI_SAFE_ERRORS")) {
    profile.safeErrors = true;
  }
  if (cli.exposeToolArgs !== undefined) {
    profile.exposeToolArgs = !!cli.exposeToolArgs;
  } else if (envBool(env, "PI_WEBUI_EXPOSE_TOOL_ARGS")) {
    profile.exposeToolArgs = true;
  }

  // chat_layout:enum 旗標(非 bool);CLI > env > profile。空字串視同未設定。
  const chatLayout = cli.chatLayout ?? env.PI_WEBUI_CHAT_LAYOUT ?? null;
  if (chatLayout && chatLayout.trim()) {
    if (chatLayout !== "bubble" && chatLayout !== "log") {
      throw new Error(`chat-layout: must be "bubble" or "log", got: ${chatLayout}`);
    }
    profile.chatLayout = chatLayout;
  }

  // brand string-value 旗標:CLI > env;空字串視同未設定。
  const name = cli.brandName ?? env.PI_WEBUI_BRAND_NAME ?? null;
  if (name && name.trim()) profile.brand.name = name;

  const color = cli.brandColor ?? env.PI_WEBUI_BRAND_COLOR ?? null;
  if (color && color.trim()) {
    if (!COLOR_RE.test(color)) {
      throw new Error(`brand-color: must be #rgb or #rrggbb, got: ${color}`);
    }
    profile.brand.tokens.accent = color;
  }

  const logo = cli.brandLogo ?? env.PI_WEBUI_BRAND_LOGO ?? null;
  if (logo && logo.trim()) {
    if (!existsSync(logo)) {
      throw new Error(`brand-logo: file not found: ${logo}`);
    }
    if (!statSync(logo).isFile()) {
      throw new Error(`brand-logo: not a file: ${logo}`);
    }
    profile.brand.logoPath = logo;
  }

  const favicon = cli.brandFavicon ?? env.PI_WEBUI_BRAND_FAVICON ?? null;
  if (favicon && favicon.trim()) {
    if (!existsSync(favicon)) {
      throw new Error(`brand-favicon: file not found: ${favicon}`);
    }
    if (!statSync(favicon).isFile()) {
      throw new Error(`brand-favicon: not a file: ${favicon}`);
    }
    profile.brand.faviconPath = favicon;
  }

  return profile;
}

// session event 過濾。
//
// 回傳:
//   - null:整個 event drop(不送 client)
//   - { kind: "event", event }:event 原樣(或 message_update.message.content 被剝)
//   - { kind: "tool_progress", payload }:tool 細節隱藏 + showToolProgress 開啟時,
//     轉成 progress packet 給 client 顯示 spinner
// phase "progress" 預留給 SDK tool_execution_progress 事件;
// 目前 SDK dist 內未送此事件,filterEvent 暫無對應分支。
export type FilterResult =
  | null
  | { kind: "event"; event: any }
  | {
      kind: "tool_progress";
      payload: { id: string; label: string; phase: "start" | "progress" | "end" };
    };

// 刻意靜默:placeholder schema 在 profile-loader 階段已驗過白名單,
// runtime 進到 resolveLabel 只可能因 SDK args 沒帶到指定 key(例如
// {file_basename} 但 args.file 不存在);這在每個 tool call 都會踩,
// console.warn 會 spam log。要追蹤時改注入有 throttle 的 logger。
const silentLogger = { warn: (_msg: string, _ctx?: unknown) => {} };

// L3 送 client 兜底（spec 2026-07-01）:對 tool 輸出事件遮蔽 L-甲 機密「值」。
// tool_execution_update 的 partialResult 是 streaming 中間結果,SDK emit-only、extension
// 回傳無效,只能在 pi-webui 自己的出口（本函式）遮;tool_execution_end 的 result 一併遮
// （涵蓋未被 execute() 源頭包裝的 builtin 工具在開發者模式的輸出）。
// 已被源頭遮過的（wrapped bash/read）在此為 no-op（redactBlocks 找不到值即回原陣列）。
function redactToolEventForClient(event: any): any {
  if (
    event.type === "tool_execution_update" &&
    event.partialResult &&
    Array.isArray(event.partialResult.content)
  ) {
    const red = redactBlocks(event.partialResult.content);
    if (red !== event.partialResult.content) {
      return { ...event, partialResult: { ...event.partialResult, content: red } };
    }
    return event;
  }
  if (
    event.type === "tool_execution_end" &&
    event.result &&
    Array.isArray(event.result.content)
  ) {
    const red = redactBlocks(event.result.content);
    if (red !== event.result.content) {
      return { ...event, result: { ...event.result, content: red } };
    }
    return event;
  }
  return event;
}

// 一個 AssistantMessage content block 在當前 profile 下是否保留(false = 剝除)。
// thinking(hideThinking)、tool_call/tool_result(含 SDK camelCase)(hideToolCalls)
// 為敏感 block。message_update 的 message.content 與 assistantMessageEvent.partial
// 共用同一判斷。
function keepContentBlock(b: any, profile: UiProfile): boolean {
  if (!b || typeof b !== "object") return true;
  if (b.type === "thinking" && profile.hideThinking) return false;
  if (
    (b.type === "tool_call" ||
      b.type === "tool_result" ||
      b.type === "toolCall" ||
      b.type === "toolResult") &&
    profile.hideToolCalls
  )
    return false;
  return true;
}

// 剝一個 AssistantMessage(帶 content 陣列)內的敏感 block;無變動時回原物件
// (供上游做 identity 比較,避免無謂複製)。
function redactAssistantMessage(msg: any, profile: UiProfile): any {
  if (!msg || typeof msg !== "object" || !Array.isArray(msg.content)) return msg;
  const filtered = msg.content.filter((b: any) => keepContentBlock(b, profile));
  if (filtered.length === msg.content.length) return msg;
  return { ...msg, content: filtered };
}

// AssistantMessageEvent 的 partial / message / error 三個欄位都是「累積至今的完整
// AssistantMessage」,會挾帶前面已產生的 thinking 全文與 toolCall 參數 —— 即使該 delta
// 本身是安全的 text_delta,partial 仍會把 thinking 帶出去。client 端 applyDelta 只讀
// delta / toolCall / contentIndex,不讀這三個欄位,故一律剝除其中的敏感 block。
// 無變動時回原物件。
function redactAssistantMessageEvent(ame: any, profile: UiProfile): any {
  let out = ame;
  for (const key of ["partial", "message", "error"] as const) {
    const v = out[key];
    if (v && typeof v === "object") {
      const red = redactAssistantMessage(v, profile);
      if (red !== v) out = { ...out, [key]: red };
    }
  }
  return out;
}

// message_update 以外、仍挾帶完整訊息的 event(message_start/message_end/turn_end/
// agent_end…):它們的 event.message.content(單則)/ event.messages[](陣列快照)同樣含
// thinking / tool block。只過濾 message_update 會漏(e2e 實測 message_end/turn_end/agent_end
// 三種都洩漏 thinking 全文)。單則走 redactAssistantMessage 剝 block;陣列走 filterMessageHistory
// (drop toolResult/bashExecution role + 剝 block)。無變動時回原 event。
function redactEventMessages(event: any, profile: UiProfile): any {
  let out = event;
  if (out.message && typeof out.message === "object" && Array.isArray(out.message.content)) {
    const red = redactAssistantMessage(out.message, profile);
    if (red !== out.message) out = { ...out, message: red };
  }
  if (Array.isArray(out.messages)) {
    const red = filterMessageHistory(out.messages, profile);
    if (red !== out.messages) out = { ...out, messages: red };
  }
  return out;
}

export function filterEvent(event: any, profile: UiProfile): FilterResult {
  if (!event || typeof event !== "object") return { kind: "event", event };

  // tool_execution_*:整個 event drop 或轉 tool_progress
  if (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_end" ||
    event.type === "tool_execution_update"
  ) {
    if (!profile.hideToolCalls) return { kind: "event", event: redactToolEventForClient(event) };
    // update 是 streaming 中間結果,不轉 progress(避免閃);整個 drop
    if (event.type === "tool_execution_update") return null;
    if (!profile.showToolProgress) return null;
    return {
      kind: "tool_progress",
      payload: {
        id: String(event.toolCallId ?? ""),
        label: resolveLabel(
          profile,
          String(event.toolName ?? ""),
          event.type === "tool_execution_start" ? "start" : "end",
          event.args ?? {},
          silentLogger,
        ),
        phase: event.type === "tool_execution_start" ? "start" : "end",
      },
    };
  }

  // message_update:兩路洩漏都要堵 —— (a) SDK streaming delta(assistantMessageEvent)
  // 與 (b) message.content 快照。SDK block type 用 camelCase(toolCall/toolResult),
  // 早期 client normalize 後是 snake_case;兩種都接受,避免漏過濾。
  if (event.type === "message_update") {
    if (!profile.hideThinking && !profile.hideToolCalls)
      return { kind: "event", event };

    const ame = event.assistantMessageEvent;
    const ameType = ame && typeof ame === "object" ? ame.type : undefined;

    // (a) 被隱藏類型的 delta 整個 drop:既防洩漏,又讓 client 收不到此 delta →
    //     showTyping 保持 true,消除 thinking 階段的 typing 空窗(spec §三缺口2)。
    //     content 是否為陣列都一樣 drop —— fail-closed,不因結構不認得而放行。
    const hiddenDelta =
      (profile.hideThinking &&
        (ameType === "thinking_start" ||
          ameType === "thinking_delta" ||
          ameType === "thinking_end")) ||
      (profile.hideToolCalls &&
        (ameType === "toolcall_start" ||
          ameType === "toolcall_delta" ||
          ameType === "toolcall_end"));
    if (hiddenDelta) return null;

    // (b) 保留的事件(text_*/start/done/error):剝 message.content 快照 +
    //     assistantMessageEvent.partial/message/error 內挾帶的 thinking/tool block。
    let outEvent = event;
    if (Array.isArray(event.message?.content)) {
      const redMsg = redactAssistantMessage(event.message, profile);
      if (redMsg !== event.message) outEvent = { ...outEvent, message: redMsg };
    }
    if (ame && typeof ame === "object") {
      const redAme = redactAssistantMessageEvent(ame, profile);
      if (redAme !== ame) outEvent = { ...outEvent, assistantMessageEvent: redAme };
    }
    return { kind: "event", event: outEvent };
  }

  // message_update / tool_execution_* 以外、仍帶 message / messages 的 event
  // (message_start/message_end/turn_end/agent_end…)也要剝挾帶的 thinking / tool block。
  if (profile.hideThinking || profile.hideToolCalls) {
    const red = redactEventMessages(event, profile);
    if (red !== event) return { kind: "event", event: red };
  }

  return { kind: "event", event };
}

// 過濾整段 message history(client 重連時的 message_history packet 用)。
// 兩層過濾:
//   - message-level:SDK 把 tool 結果 / bash 執行存成獨立 role(toolResult /
//     bashExecution),hideToolCalls=true 時整則 drop,否則 client 仍會渲染
//     "Tool result: bash" 區塊
//   - content-level:對 user/assistant 等帶 content 陣列的 message,剝
//     thinking / tool_* block(SDK 用 camelCase,舊路徑也可能是 snake_case)
// hide flag 都沒開時直接回原陣列(無謂複製)。
export function filterMessageHistory(messages: any[], profile: UiProfile): any[] {
  if (!profile.hideThinking && !profile.hideToolCalls) return messages;
  if (!Array.isArray(messages)) return messages;
  const out: any[] = [];
  for (const msg of messages) {
    if (!msg) {
      out.push(msg);
      continue;
    }
    if (
      profile.hideToolCalls &&
      (msg.role === "toolResult" || msg.role === "bashExecution")
    ) {
      continue;
    }
    if (!Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }
    const filtered = msg.content.filter((b: any) => {
      if (!b || typeof b !== "object") return true;
      if (b.type === "thinking" && profile.hideThinking) return false;
      if (
        (b.type === "tool_call" ||
          b.type === "tool_result" ||
          b.type === "toolCall" ||
          b.type === "toolResult") &&
        profile.hideToolCalls
      )
        return false;
      return true;
    });
    if (filtered.length === msg.content.length) {
      out.push(msg);
    } else {
      out.push({ ...msg, content: filtered });
    }
  }
  return out;
}

export interface SafeErrorLogger {
  error?: (msg: string, fields?: Record<string, unknown>) => void;
}

// safeError:--safe-errors 開啟時把 raw message 包成 generic 訊息 + 6-hex ticket,
// 原訊息寫進 logger 帶 ticket 對應;未啟用時 pass-through,不寫 log。
export function safeError(
  profile: UiProfile,
  rawMessage: string,
  log?: SafeErrorLogger,
): string {
  if (!profile.safeErrors) return rawMessage;
  const ticket = randomBytes(3).toString("hex");
  log?.error?.("safe-error", { ticket, message: rawMessage });
  return `發生錯誤,請聯繫支援 (ticket: ${ticket})`;
}
