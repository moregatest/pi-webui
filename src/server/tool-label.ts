import path from "node:path";
import type { ToolLabelEntry } from "./profile-loader.js";

interface ResolverProfile {
  exposeToolArgs: boolean;
  toolLabels: Record<string, ToolLabelEntry>;
}

interface Logger {
  warn: (msg: string, ctx?: unknown) => void;
}

const PLACEHOLDER_RE = /\{([^}]+)\}/g;

const BUILTIN_DEFAULTS: ToolLabelEntry = {
  start: "正在處理...",
  progress: "",
  end: "",
};

// 內建的工具專屬標籤（W43 F13）：customer 不顯示工具原始結果，改顯示這些簡短狀態。
// profile 的 tool_labels 指定該工具時以 profile 為準；優先於 _default。
const BUILTIN_TOOL_LABELS: Record<string, ToolLabelEntry> = {
  publish_confirmed: { start: "正在處理發布…", progress: "", end: "" },
  publication_status: { start: "正在查詢發布狀態…", progress: "", end: "" },
};

export function resolveLabel(
  profile: ResolverProfile,
  toolName: string,
  phase: "start" | "progress" | "end",
  args: Record<string, unknown>,
  log: Logger,
): string {
  const labels = profile.toolLabels || {};
  let template: string | undefined;
  if (labels[toolName] && labels[toolName][phase] !== undefined) {
    template = labels[toolName][phase];
  } else if (BUILTIN_TOOL_LABELS[toolName]) {
    template = BUILTIN_TOOL_LABELS[toolName][phase];
  } else if (labels._default && labels._default[phase] !== undefined) {
    template = labels._default[phase];
  } else {
    template = BUILTIN_DEFAULTS[phase];
  }
  if (template === undefined || template === "") return template || "";

  return template.replace(PLACEHOLDER_RE, (_match, ph) => {
    return resolvePlaceholder(ph, args, profile.exposeToolArgs, toolName, phase, log);
  });
}

function resolvePlaceholder(
  ph: string,
  args: Record<string, unknown>,
  exposeToolArgs: boolean,
  toolName: string,
  phase: string,
  log: Logger,
): string {
  if (ph === "file_basename") {
    // SDK read/edit/write tool 的 path key 不統一,canonical schema 是 "path"
    // 但實際 dispatch 接受 file_path 也接受 path(read.js line 34)。
    // 候選順序:file_path → path → file(file 是早期 placeholder 設計,保留兼容)
    const file = args.file_path ?? args.path ?? args.file;
    if (typeof file !== "string") {
      log.warn(`tool-label: {file_basename} args.{file_path,path,file} missing for ${toolName}.${phase}`);
      return "";
    }
    return path.basename(file);
  }
  if (ph === "url_host") {
    const url = args.url;
    if (typeof url !== "string") {
      log.warn(`tool-label: {url_host} args.url missing for ${toolName}.${phase}`);
      return "";
    }
    try {
      return new URL(url).hostname;
    } catch {
      log.warn(`tool-label: {url_host} 解析失敗 ${url} (${toolName}.${phase})`);
      return "";
    }
  }
  if (ph === "progress_count") {
    const v = args.progress_count;
    return v === undefined || v === null ? "" : String(v);
  }
  if (ph.startsWith("tool_arg.")) {
    if (!exposeToolArgs) {
      log.warn(`tool-label: {${ph}} expose_tool_args=false (${toolName}.${phase})`);
      return "";
    }
    const key = ph.slice("tool_arg.".length);
    const v = args[key];
    if (v === undefined || v === null) {
      log.warn(`tool-label: {${ph}} args.${key} missing (${toolName}.${phase})`);
      return "";
    }
    return String(v);
  }
  // 不應走到這裡(profile-loader 已驗白名單),但 runtime 防呆
  log.warn(`tool-label: 未知 placeholder {${ph}} (${toolName}.${phase})`);
  return "";
}
