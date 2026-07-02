// base-path 核心純函式：single source of truth。
// 比照 session-dir.ts / session-guard.ts，只放可單元測的純函式，IO 留在 caller。
// 設計見 docs/superpowers/specs/2026-07-02-base-path-parametrize-design.md §1。

/**
 * 正規化 base：去多餘斜線、保證單一前導斜線、去尾斜線；空或 "/" → ""（root）。
 *   undefined / null / "" / "/"                     → ""
 *   "/webui" / "webui" / "/webui/" / "//webui//"    → "/webui"
 *   "/foo/bar" / "foo/bar/" / "//foo//bar//"        → "/foo/bar"（巢狀）
 * 中段連續斜線一律 collapse 成單一，避免下游比對出錯。
 */
export function normalizeBasePath(raw: string | null | undefined): string {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (s === "" || s === "/") return "";
  s = s.replace(/\/{2,}/g, "/"); // collapse 連續斜線
  if (!s.startsWith("/")) s = "/" + s; // 保證單一前導斜線
  s = s.replace(/\/+$/, ""); // 去尾斜線
  return s === "" || s === "/" ? "" : s;
}

/**
 * 入口 strip：把 ingress pathname 轉成 server 內部無前綴路徑。
 *   base === ""                → pathname（原樣）
 *   pathname === base          → "/"
 *   pathname 以 base + "/" 開頭 → pathname.slice(base.length)   // "/webui/x" → "/x"
 *   其他（如 "/webuixyz"、不匹配）→ pathname（原樣，交下游 404）
 * 刻意用 base + "/" 判斷（而非 startsWith(base)），避免把 "/webuixyz" 誤 strip 成 "/xyz"。
 * base 必須是已 normalize 的值（無尾斜線）。
 */
export function stripBasePrefix(pathname: string, base: string): string {
  if (!base) return pathname;
  if (pathname === base) return "/";
  if (pathname.startsWith(base + "/")) return pathname.slice(base.length);
  return pathname;
}
