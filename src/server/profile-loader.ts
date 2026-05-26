import fs from "node:fs";
import path from "node:path";
import TOML from "@iarna/toml";

export interface ToolLabelEntry {
  start?: string;
  progress?: string;
  end?: string;
}

export interface BrandConfig {
  name?: string;
  logo?: string;
  mode?: "dark" | "light";
  bg?: string;
  panel?: string;
  text?: string;
  accent?: string;
  color?: string;     // accent 的 alias(向後相容);驗證時 normalize 成 accent
  border?: string;
  muted?: string;
  css?: string;
}

export interface UiFlags {
  hide_thinking?: boolean;
  hide_tool_calls?: boolean;
  show_tool_progress?: boolean;
  hide_status_chips?: boolean;
  hide_session_picker?: boolean;
  hide_model?: boolean;
  safe_errors?: boolean;
  expose_tool_args?: boolean;
}

export interface ProfileFile {
  meta?: { description?: string };
  ui?: UiFlags;
  brand?: BrandConfig;
  skills?: { allow?: string[] };
  commands?: { allow?: string[] };
  defaults?: { model?: string };
  tool_labels?: Record<string, ToolLabelEntry>;
}

const CUSTOMER_FALLBACK: ProfileFile = {
  meta: { description: "built-in customer preset fallback" },
  ui: {
    hide_thinking: true,
    hide_tool_calls: true,
    show_tool_progress: true,
    hide_status_chips: true,
    hide_session_picker: true,
    hide_model: true,
    safe_errors: true,
    expose_tool_args: false,
  },
};

export function loadProfile(name: string, cwd: string): ProfileFile {
  const filePath = path.join(cwd, ".pi", "profiles", `${name}.toml`);
  if (!fs.existsSync(filePath)) {
    if (name === "customer") return CUSTOMER_FALLBACK;
    throw new Error(`profile not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed;
  try {
    parsed = TOML.parse(raw);
  } catch (e) {
    throw new Error(`profile syntax error: ${e.message}`);
  }
  return parsed as ProfileFile;
}
