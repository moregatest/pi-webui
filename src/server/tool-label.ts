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
    const file = args.file;
    if (typeof file !== "string") {
      log.warn(`tool-label: {file_basename} args.file missing for ${toolName}.${phase}`);
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
