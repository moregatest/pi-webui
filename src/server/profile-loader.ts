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

export interface SandboxConfig {
  image?: string;
  env?: Record<string, string>;
}

export interface ProfileFile {
  meta?: { description?: string };
  ui?: UiFlags;
  brand?: BrandConfig;
  skills?: { allow?: string[] };
  commands?: { allow?: string[] };
  defaults?: { model?: string };
  tool_labels?: Record<string, ToolLabelEntry>;
  sandbox?: SandboxConfig;
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

const ALLOWED_TOP = new Set(["meta", "ui", "brand", "skills", "commands", "defaults", "tool_labels", "sandbox"]);
const ALLOWED_UI = new Set([
  "hide_thinking", "hide_tool_calls", "show_tool_progress",
  "hide_status_chips", "hide_session_picker", "hide_model",
  "safe_errors", "expose_tool_args",
]);
const ALLOWED_BRAND = new Set([
  "name", "logo", "mode", "bg", "panel", "text",
  "accent", "border", "muted", "css", "color",
]);

function validateUnknown(parsed: Record<string, unknown>): void {
  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_TOP.has(key)) {
      throw new Error(`unknown top-level table: [${key}]`);
    }
  }
  const ui = parsed.ui as Record<string, unknown> | undefined;
  if (ui) {
    for (const key of Object.keys(ui)) {
      if (!ALLOWED_UI.has(key)) {
        throw new Error(`unknown field [ui].${key}`);
      }
    }
  }
  const brand = parsed.brand as Record<string, unknown> | undefined;
  if (brand) {
    for (const key of Object.keys(brand)) {
      if (!ALLOWED_BRAND.has(key)) {
        throw new Error(`unknown field [brand].${key}`);
      }
    }
  }
}

const ALLOWED_SANDBOX = new Set(["image", "env"]);
// gondolin image selector 語法寬鬆:repo[/name][:tag] 或 buildId(uuid-like)。
// 只 reject 明顯壞掉的(空白、控制字元),其他交給 gondolin runtime 驗。
const IMAGE_RE = /^[A-Za-z0-9._:/@-]+$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateSandbox(sandbox: SandboxConfig | undefined): void {
  if (!sandbox) return;
  for (const key of Object.keys(sandbox)) {
    if (!ALLOWED_SANDBOX.has(key)) {
      throw new Error(`unknown field [sandbox].${key}`);
    }
  }
  if (sandbox.image !== undefined) {
    if (typeof sandbox.image !== "string") {
      throw new Error(`[sandbox].image: 必須是字串,收到 ${typeof sandbox.image}`);
    }
    if (!IMAGE_RE.test(sandbox.image)) {
      throw new Error(`[sandbox].image: 不是合法 image selector(只允許 [A-Za-z0-9._:/@-]),收到 "${sandbox.image}"`);
    }
  }
  if (sandbox.env !== undefined) {
    if (sandbox.env === null || typeof sandbox.env !== "object" || Array.isArray(sandbox.env)) {
      throw new Error(`[sandbox.env]: 必須是 table(key=value),收到 ${Array.isArray(sandbox.env) ? "array" : typeof sandbox.env}`);
    }
    for (const [k, v] of Object.entries(sandbox.env)) {
      if (!ENV_KEY_RE.test(k)) {
        throw new Error(`[sandbox.env]: env key 必須符合 [A-Za-z_][A-Za-z0-9_]*,收到 "${k}"`);
      }
      if (typeof v !== "string") {
        throw new Error(`[sandbox.env].${k}: 必須是字串,收到 ${typeof v}`);
      }
    }
  }
}

const PLACEHOLDER_RE = /\{([^}]+)\}/g;
const ALLOWED_PLACEHOLDERS = new Set(["file_basename", "url_host", "progress_count"]);

function validatePlaceholders(toolLabels: ProfileFile["tool_labels"]): void {
  if (!toolLabels) return;
  for (const [toolName, entry] of Object.entries(toolLabels)) {
    for (const phase of ["start", "progress", "end"] as const) {
      const tpl = entry[phase];
      if (typeof tpl !== "string") continue;
      let m;
      const re = new RegExp(PLACEHOLDER_RE);
      while ((m = re.exec(tpl)) !== null) {
        const ph = m[1];
        if (ph.startsWith("tool_arg.")) {
          const key = ph.slice("tool_arg.".length);
          if (key.length === 0) {
            throw new Error(`tool_labels.${toolName}.${phase}: 無效 placeholder {tool_arg.}(key 為空)`);
          }
          if (!/^[a-zA-Z0-9_]+$/.test(key) || key.startsWith("__")) {
            throw new Error(`tool_labels.${toolName}.${phase}: tool_arg key 只允許 [a-zA-Z0-9_] 且不可以 __ 開頭: "${key}"`);
          }
          continue;
        }
        if (!ALLOWED_PLACEHOLDERS.has(ph)) {
          throw new Error(`tool_labels.${toolName}.${phase}: 未知 placeholder {${ph}}`);
        }
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
  validateUnknown(parsed as Record<string, unknown>);
  const profile = parsed as ProfileFile;
  validateBrand(profile.brand, cwd);
  validatePlaceholders(profile.tool_labels);
  validateSandbox(profile.sandbox);
  return profile;
}
