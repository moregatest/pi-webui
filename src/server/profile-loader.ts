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
  favicon?: string;   // 瀏覽器分頁 icon;未設時 fallback 到內建 public/favicon.svg
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
  // 對話版型:"bubble"=Claude 式左右氣泡(user 右/assistant 左、隱藏角色標題);
  // "log"=工程師視圖(標題 + 左框線,預設)。customer fallback 用 bubble。
  chat_layout?: "bubble" | "log";
}

export interface SandboxConfig {
  image?: string;
  env?: Record<string, string>;
  // 客製身份提示;append 到 readyai-webui built-in sandbox system prompt 之後。
  // 通常用於提示 image-specific 的 CLI 與限制(例如「本 image 預裝 readyai-db 等 N 個 CLI」)。
  system_prompt?: string;
}

export interface UploadsConfig {
  // 完整取代預設清單;副檔名不含開頭的點,大小寫不敏感。
  allowed_extensions?: string[];
  // 在現有清單之上加增。
  extensions_add?: string[];
  // <cwd>/uploads/<subdir>/<filename>;未指定時 fallback 到 profile 名。
  subdir?: string;
  // 單檔位元組上限。
  max_bytes?: number;
  // 一次最多幾個檔。
  max_files?: number;
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
  uploads?: UploadsConfig;
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

  for (const field of ["logo", "css", "favicon"] as const) {
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

function validateUi(ui: UiFlags | undefined): void {
  if (!ui) return;
  if (ui.chat_layout !== undefined && !CHAT_LAYOUTS.has(ui.chat_layout)) {
    throw new Error(`[ui].chat_layout: 必須是 "bubble" 或 "log",收到 "${ui.chat_layout}"`);
  }
}

const ALLOWED_TOP = new Set(["meta", "ui", "brand", "skills", "commands", "defaults", "tool_labels", "sandbox", "uploads"]);
const ALLOWED_UI = new Set([
  "hide_thinking", "hide_tool_calls", "show_tool_progress",
  "hide_status_chips", "hide_session_picker", "hide_model",
  "safe_errors", "expose_tool_args", "chat_layout",
]);
const ALLOWED_BRAND = new Set([
  "name", "logo", "favicon", "mode", "bg", "panel", "text",
  "accent", "border", "muted", "css", "color",
]);
const CHAT_LAYOUTS = new Set(["bubble", "log"]);

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

const ALLOWED_SANDBOX = new Set(["image", "env", "system_prompt"]);
const ALLOWED_UPLOADS = new Set([
  "allowed_extensions", "extensions_add", "subdir", "max_bytes", "max_files",
]);
// 同 upload-config 的常數;這裡只做基本字串/陣列驗證,內容由 upload-config.resolveUploadConfig 統一驗。
const UPLOADS_SUBDIR_RE = /^[A-Za-z0-9_-]+$/;
// system_prompt 上限:預防誤把整本 doc 塞進去,讓 LLM context 爆炸。
// 16KB 對「幾段 markdown 提示」綽綽有餘,真要大於這個 size 表示在亂塞。
const MAX_SANDBOX_SYSTEM_PROMPT_BYTES = 16 * 1024;
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
  if (sandbox.system_prompt !== undefined) {
    if (typeof sandbox.system_prompt !== "string") {
      throw new Error(`[sandbox].system_prompt: 必須是字串,收到 ${typeof sandbox.system_prompt}`);
    }
    const bytes = Buffer.byteLength(sandbox.system_prompt, "utf8");
    if (bytes > MAX_SANDBOX_SYSTEM_PROMPT_BYTES) {
      throw new Error(
        `[sandbox].system_prompt: 上限 ${MAX_SANDBOX_SYSTEM_PROMPT_BYTES} bytes(目前 ${bytes});`
        + ` 大段內容請放在 image 內的 doc 並由 LLM 主動讀取,不要塞進 system prompt。`,
      );
    }
  }
}

function validateUploads(uploads: UploadsConfig | undefined): void {
  if (!uploads) return;
  for (const key of Object.keys(uploads)) {
    if (!ALLOWED_UPLOADS.has(key)) {
      throw new Error(`unknown field [uploads].${key}`);
    }
  }
  for (const field of ["allowed_extensions", "extensions_add"] as const) {
    const value = uploads[field];
    if (value === undefined) continue;
    if (!Array.isArray(value)) {
      throw new Error(`[uploads].${field}: 必須是字串陣列,收到 ${typeof value}`);
    }
    for (const item of value) {
      if (typeof item !== "string") {
        throw new Error(`[uploads].${field}: 陣列項目必須是字串,收到 ${typeof item}`);
      }
    }
  }
  if (uploads.subdir !== undefined) {
    if (typeof uploads.subdir !== "string") {
      throw new Error(`[uploads].subdir: 必須是字串,收到 ${typeof uploads.subdir}`);
    }
    if (!UPLOADS_SUBDIR_RE.test(uploads.subdir)) {
      throw new Error(`[uploads].subdir: 只允許 [A-Za-z0-9_-],收到 "${uploads.subdir}"`);
    }
  }
  for (const field of ["max_bytes", "max_files"] as const) {
    const value = uploads[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      throw new Error(`[uploads].${field}: 必須是正整數,收到 ${JSON.stringify(value)}`);
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
    chat_layout: "bubble",
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
  validateUi(profile.ui);
  validatePlaceholders(profile.tool_labels);
  validateSandbox(profile.sandbox);
  validateUploads(profile.uploads);
  return profile;
}
