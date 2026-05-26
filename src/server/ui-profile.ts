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

import { toolLabel } from "./tool-labels.js";
export { toolLabel } from "./tool-labels.js";

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
  };

  // preset 展開(CLI > env)。個別 flag 後面再覆蓋(只能往「啟用」方向推,
  // 沒有 --no-hide-* 反向旗標,沿用既有 boolean flag 慣例)。
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

  if (cli.hideThinking || envBool(env, "PI_WEBUI_HIDE_THINKING"))
    profile.hideThinking = true;
  if (cli.hideToolCalls || envBool(env, "PI_WEBUI_HIDE_TOOL_CALLS"))
    profile.hideToolCalls = true;
  if (cli.showToolProgress || envBool(env, "PI_WEBUI_SHOW_TOOL_PROGRESS"))
    profile.showToolProgress = true;
  if (cli.hideStatusChips || envBool(env, "PI_WEBUI_HIDE_STATUS_CHIPS"))
    profile.hideStatusChips = true;
  if (cli.hideSessionPicker || envBool(env, "PI_WEBUI_HIDE_SESSION_PICKER"))
    profile.hideSessionPicker = true;
  if (cli.hideModel || envBool(env, "PI_WEBUI_HIDE_MODEL"))
    profile.hideModel = true;
  if (cli.safeErrors || envBool(env, "PI_WEBUI_SAFE_ERRORS"))
    profile.safeErrors = true;
  if (cli.exposeToolArgs || envBool(env, "PI_WEBUI_EXPOSE_TOOL_ARGS"))
    profile.exposeToolArgs = true;

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
export type FilterResult =
  | null
  | { kind: "event"; event: any }
  | {
      kind: "tool_progress";
      payload: { id: string; label: string; phase: "start" | "end" };
    };

export function filterEvent(event: any, profile: UiProfile): FilterResult {
  if (!event || typeof event !== "object") return { kind: "event", event };

  // tool_execution_*:整個 event drop 或轉 tool_progress
  if (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_end" ||
    event.type === "tool_execution_update"
  ) {
    if (!profile.hideToolCalls) return { kind: "event", event };
    // update 是 streaming 中間結果,不轉 progress(避免閃);整個 drop
    if (event.type === "tool_execution_update") return null;
    if (!profile.showToolProgress) return null;
    return {
      kind: "tool_progress",
      payload: {
        id: String(event.toolCallId ?? ""),
        label: toolLabel(String(event.toolName ?? "")),
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
