// 一般檔案上傳的設定解析。
//
// 設計原則(沿用 ui-profile 模組的層級觀念):
//   - 預設清單寫死在這裡(DEFAULT_ALLOWED_EXTENSIONS);使用者可以全替換或加增。
//   - 來源優先順序:CLI > env > profileFile > 預設值。
//   - extensions 有兩個入口:
//       (a) "替換"(allowed_extensions / --upload-ext / PI_WEBUI_UPLOAD_EXT)
//           整個取代預設清單。
//       (b) "加增"(extensions_add / --upload-ext-add / PI_WEBUI_UPLOAD_EXT_ADD)
//           在現有清單上追加(不重複)。
//     兩者可同時使用,先 replace 再 add。
//   - subdir 未指定時 fallback 到 profile 名;profile 名也沒有時為 "default"。

import type { ProfileFile } from "./profile-loader.js";

// 預設副檔名清單(全部小寫,不含開頭的點)。
// 與 README/ROADMAP 對齊,改這裡也要同步改文件。
export const DEFAULT_ALLOWED_EXTENSIONS: ReadonlyArray<string> = Object.freeze([
  // webp 與 ALLOWED_PASTED_IMAGE_MIME 對齊:圖檔會同時走 in-band base64 與落地,
  // 少了 webp 會出現「看得到卻沒檔案」的落差。
  "jpg", "jpeg", "png", "gif", "webp", "svg",
  "pdf",
  "rar", "zip",
  "flv",
  "txt",
  "doc", "docx", "xls", "xlsx",
  "dwg",
]);

// 預設大小/數量限制。50 MB / 20 檔對應使用者拍板的數字。
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_FILES = 20;

// subdir 命名只允許 [a-zA-Z0-9_-];擋掉 /、..、空白等可能造成路徑逃逸的字元。
// "default" 是 fallback 名稱,使用者不該主動帶這個。
const SUBDIR_RE = /^[A-Za-z0-9_-]+$/;
// 副檔名只允許 ASCII 字母+數字,長度 1~16;svg / docx / dwg 都在範圍內,
// 排除 .tar.gz 這類複合副檔名(我們只看最後一段)。
const EXT_RE = /^[A-Za-z0-9]{1,16}$/;

export interface UploadProfileSection {
  allowed_extensions?: string[];
  extensions_add?: string[];
  subdir?: string;
  max_bytes?: number;
  max_files?: number;
}

export interface ResolveUploadInput {
  cliExt?: string;          // --upload-ext (comma-separated; 空字串視同未設)
  cliExtAdd?: string;       // --upload-ext-add (comma-separated)
  cliSubdir?: string;       // --upload-subdir
  cliMaxBytes?: number;     // --upload-max-bytes (bytes)
  cliMaxFiles?: number;     // --upload-max-files
  env?: NodeJS.ProcessEnv;
  profile?: UploadProfileSection;
  // profile 名稱;subdir 未指定時用它做 fallback。
  profileName?: string;
}

export interface EffectiveUploadConfig {
  // 全小寫、不含開頭的點;查找時用 .has()
  allowedExtensions: Set<string>;
  // 不含開頭斜線/結尾斜線;最終寫到 <cwd>/uploads/<subdir>/<filename>
  subdir: string;
  maxBytes: number;
  maxFiles: number;
}

// 把 "a,b,.c, D" 這類字串切成 ["a","b","c","d"];丟掉空白與不合規。
// throw 是 unhealthy 條目,讓上層在啟動時 fail-fast 而不是 runtime 才發現。
function parseExtList(raw: string | string[] | undefined, source: string): string[] {
  if (raw === undefined || raw === null) return [];
  const items = Array.isArray(raw)
    ? raw
    : String(raw).split(",");
  const out: string[] = [];
  for (const item of items) {
    const cleaned = String(item || "").trim().replace(/^\./, "").toLowerCase();
    if (!cleaned) continue;
    if (!EXT_RE.test(cleaned)) {
      throw new Error(`${source}: 不合法的副檔名 "${cleaned}"(只允許 1~16 個英數字)`);
    }
    if (!out.includes(cleaned)) out.push(cleaned);
  }
  return out;
}

function validateSubdir(value: string, source: string): string {
  if (!SUBDIR_RE.test(value)) {
    throw new Error(`${source}: 子目錄名稱只允許 [A-Za-z0-9_-],收到 "${value}"`);
  }
  return value;
}

export function resolveUploadConfig(input: ResolveUploadInput = {}): EffectiveUploadConfig {
  const env = input.env ?? process.env;
  const profile = input.profile;

  // --- 副檔名清單 ---
  // 1. 起點:預設清單
  let allowed: string[] = [...DEFAULT_ALLOWED_EXTENSIONS];

  // 2. profile.allowed_extensions 取代起點
  if (profile?.allowed_extensions !== undefined) {
    allowed = parseExtList(profile.allowed_extensions, "[uploads].allowed_extensions");
  }
  // 3. env PI_WEBUI_UPLOAD_EXT 取代
  if (env.PI_WEBUI_UPLOAD_EXT && env.PI_WEBUI_UPLOAD_EXT.trim()) {
    allowed = parseExtList(env.PI_WEBUI_UPLOAD_EXT, "PI_WEBUI_UPLOAD_EXT");
  }
  // 4. CLI --upload-ext 取代(最高優先)
  if (input.cliExt !== undefined && String(input.cliExt).trim()) {
    allowed = parseExtList(input.cliExt, "--upload-ext");
  }

  // 5. extensions_add(profile)→ env add → CLI add,逐層追加
  if (profile?.extensions_add !== undefined) {
    for (const ext of parseExtList(profile.extensions_add, "[uploads].extensions_add")) {
      if (!allowed.includes(ext)) allowed.push(ext);
    }
  }
  if (env.PI_WEBUI_UPLOAD_EXT_ADD && env.PI_WEBUI_UPLOAD_EXT_ADD.trim()) {
    for (const ext of parseExtList(env.PI_WEBUI_UPLOAD_EXT_ADD, "PI_WEBUI_UPLOAD_EXT_ADD")) {
      if (!allowed.includes(ext)) allowed.push(ext);
    }
  }
  if (input.cliExtAdd !== undefined && String(input.cliExtAdd).trim()) {
    for (const ext of parseExtList(input.cliExtAdd, "--upload-ext-add")) {
      if (!allowed.includes(ext)) allowed.push(ext);
    }
  }

  if (allowed.length === 0) {
    throw new Error("uploads: allowed_extensions 不可為空(把所有來源加起來都沒留下任何副檔名)");
  }

  // --- subdir ---
  // 預設 fallback 順序:CLI > env > profile.subdir > profileName > "default"
  let subdir = "default";
  if (input.profileName && input.profileName.trim()) {
    subdir = validateSubdir(input.profileName.trim(), "--profile name");
  }
  if (profile?.subdir !== undefined && String(profile.subdir).trim()) {
    subdir = validateSubdir(String(profile.subdir).trim(), "[uploads].subdir");
  }
  if (env.PI_WEBUI_UPLOAD_SUBDIR && env.PI_WEBUI_UPLOAD_SUBDIR.trim()) {
    subdir = validateSubdir(env.PI_WEBUI_UPLOAD_SUBDIR.trim(), "PI_WEBUI_UPLOAD_SUBDIR");
  }
  if (input.cliSubdir !== undefined && String(input.cliSubdir).trim()) {
    subdir = validateSubdir(String(input.cliSubdir).trim(), "--upload-subdir");
  }

  // --- size / count ---
  let maxBytes = DEFAULT_MAX_BYTES;
  if (profile?.max_bytes !== undefined) {
    maxBytes = parsePositiveInt(profile.max_bytes, "[uploads].max_bytes");
  }
  if (env.PI_WEBUI_UPLOAD_MAX_BYTES) {
    maxBytes = parsePositiveInt(env.PI_WEBUI_UPLOAD_MAX_BYTES, "PI_WEBUI_UPLOAD_MAX_BYTES");
  }
  if (input.cliMaxBytes !== undefined) {
    maxBytes = parsePositiveInt(input.cliMaxBytes, "--upload-max-bytes");
  }

  let maxFiles = DEFAULT_MAX_FILES;
  if (profile?.max_files !== undefined) {
    maxFiles = parsePositiveInt(profile.max_files, "[uploads].max_files");
  }
  if (env.PI_WEBUI_UPLOAD_MAX_FILES) {
    maxFiles = parsePositiveInt(env.PI_WEBUI_UPLOAD_MAX_FILES, "PI_WEBUI_UPLOAD_MAX_FILES");
  }
  if (input.cliMaxFiles !== undefined) {
    maxFiles = parsePositiveInt(input.cliMaxFiles, "--upload-max-files");
  }

  return {
    allowedExtensions: new Set(allowed),
    subdir,
    maxBytes,
    maxFiles,
  };
}

function parsePositiveInt(raw: number | string, source: string): number {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${source}: 必須是正整數,收到 "${raw}"`);
  }
  return n;
}

// 取 filename 的最後一段副檔名(小寫、不含點)。若沒有則回空字串。
// 不處理 ".tar.gz" 這類複合副檔名;.gz 就是 .gz。
export function extractExtension(filename: string): string {
  const base = String(filename || "").trim();
  if (!base) return "";
  const last = base.lastIndexOf(".");
  if (last < 0 || last === base.length - 1) return "";
  return base.slice(last + 1).toLowerCase();
}

// 把使用者原始 filename 轉成適合寫入磁碟的安全檔名,並加上 timestamp 後綴
// 防止覆蓋。回傳「stem-YYYYMMDD-HHMMSS-mmm.ext」,例如:
//   report.pdf → report-20260529-153045-127.pdf
//   無副檔名 → 仍可寫,只是 ext 為空,輸出 "name-...."
// timestamp 用 ms 級降低同秒多檔 race;若同 ms 仍碰撞由呼叫方處理(極罕見)。
export function buildStoredFilename(originalName: string, now: Date = new Date()): string {
  const safe = sanitizeFilename(originalName);
  const dot = safe.lastIndexOf(".");
  const stem = dot >= 0 ? safe.slice(0, dot) : safe;
  const ext = dot >= 0 ? safe.slice(dot) : ""; // 含點
  const yyyy = now.getFullYear().toString().padStart(4, "0");
  const mm = (now.getMonth() + 1).toString().padStart(2, "0");
  const dd = now.getDate().toString().padStart(2, "0");
  const hh = now.getHours().toString().padStart(2, "0");
  const mi = now.getMinutes().toString().padStart(2, "0");
  const ss = now.getSeconds().toString().padStart(2, "0");
  const ms = now.getMilliseconds().toString().padStart(3, "0");
  const stamp = `${yyyy}${mm}${dd}-${hh}${mi}${ss}-${ms}`;
  const finalStem = stem || "file";
  return `${finalStem}-${stamp}${ext}`;
}

// 把外來 filename 收斂成 safe basename:
// - 去除路徑分隔符(/、\)只留 basename
// - 去除控制字元、null byte
// - 連續空白合併成單一 _
// - 收緊到 [\w.\-一-鿿] 範圍(允許中文),其他字元轉 _
// - 長度上限 200 字元(防止檔名超過 OS 限制)
export function sanitizeFilename(name: string): string {
  let s = String(name || "");
  // 取最後一段(處理任何路徑)
  s = s.replace(/^.*[\\/]/, "");
  // 移除控制字元(含 null)
  s = s.replace(/[\x00-\x1f\x7f]/g, "");
  // 連續空白 → 單一底線
  s = s.replace(/\s+/g, "_");
  // 留下:英數字、底線、中橫線、點、中文字
  s = s.replace(/[^\w.\-一-鿿]/g, "_");
  // 連續底線 / 連續點 收斂(防止 "..." 之類)
  s = s.replace(/_+/g, "_").replace(/\.{2,}/g, ".");
  // 開頭的點直接拿掉(避免變成隱藏檔)
  s = s.replace(/^\.+/, "");
  if (s.length > 200) {
    // 保留副檔名,壓縮 stem
    const dot = s.lastIndexOf(".");
    if (dot > 0 && dot > s.length - 16) {
      const ext = s.slice(dot);
      s = s.slice(0, 200 - ext.length) + ext;
    } else {
      s = s.slice(0, 200);
    }
  }
  return s || "file";
}
