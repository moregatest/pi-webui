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
  brand: {
    name: string | null;
    logoPath: string | null;
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
  uiProfile?: string;
  brandName?: string;
  brandLogo?: string;
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
    brand: {
      name: null,
      logoPath: null,
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
  }

  if (profileFile?.brand) {
    const b = profileFile.brand;
    if (b.name !== undefined) profile.brand.name = b.name;
    if (b.logo !== undefined) profile.brand.logoPath = b.logo;
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

  // message_update:過濾 message.content 陣列中的 thinking / tool_* block
  // SDK 內部 block type 用 camelCase(toolCall / toolResult),早期 client 端
  // normalize 後是 snake_case;兩種都接受,避免漏過濾
  if (event.type === "message_update") {
    if (!profile.hideThinking && !profile.hideToolCalls)
      return { kind: "event", event };
    const content = event.message?.content;
    if (!Array.isArray(content)) return { kind: "event", event };
    const filtered = content.filter((b: any) => {
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
    if (filtered.length === content.length) return { kind: "event", event };
    return {
      kind: "event",
      event: { ...event, message: { ...event.message, content: filtered } },
    };
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
