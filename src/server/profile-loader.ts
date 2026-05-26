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

const HEX_COLOR_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
const HEX_FIELDS: (keyof BrandConfig)[] = ["bg", "panel", "text", "accent", "border", "muted"];

function validateBrand(brand: BrandConfig | undefined, cwd: string): void {
  if (!brand) return;

  // color → accent alias
  if (brand.color !== undefined) {
    if (brand.accent !== undefined) {
      throw new Error(`[brand]: 不可同時設 color 與 accent(color 是 accent 的 alias)`);
    }
    brand.accent = brand.color;
    delete brand.color;
  }

  if (brand.mode !== undefined && brand.mode !== "dark" && brand.mode !== "light") {
    throw new Error(`[brand].mode: 必須是 "dark" 或 "light",收到 "${brand.mode}"`);
  }

  for (const field of HEX_FIELDS) {
    const value = brand[field];
    if (value !== undefined && !HEX_COLOR_RE.test(value as string)) {
      throw new Error(`[brand].${field}: 不是合法 hex(#rgb / #rrggbb),收到 "${value}"`);
    }
  }

  for (const field of ["logo", "css"] as const) {
    const rel = brand[field];
    if (rel !== undefined) {
      const abs = path.resolve(cwd, rel);
      const cwdWithSep = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
      if (!abs.startsWith(cwdWithSep)) {
        throw new Error(`[brand].${field}: 路徑必須在 cwd 內(不可絕對路徑或 .. 逃出): ${rel}`);
      }
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        throw new Error(`[brand].${field}: 路徑不存在或非檔案: ${rel}`);
      }
    }
  }
}

const CUSTOMER_FALLBACK: ProfileFile = Object.freeze({
  meta: Object.freeze({ description: "built-in customer preset fallback" }),
  ui: Object.freeze({
    hide_thinking: true,
    hide_tool_calls: true,
    show_tool_progress: true,
    hide_status_chips: true,
    hide_session_picker: true,
    hide_model: true,
    safe_errors: true,
    expose_tool_args: false,
  }),
}) as ProfileFile;

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
  const profile = parsed as ProfileFile;
  validateBrand(profile.brand, cwd);
  return profile;
}
