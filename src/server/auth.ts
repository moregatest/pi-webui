import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const COOKIE_NAME = "pi_webui_auth";
export const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

// 等長 constant-time 字串比對,避免 timing attack。
// 任一方非字串或長度不同直接 false。
export function comparePassword(input: unknown, expected: unknown): boolean {
  if (typeof input !== "string" || typeof expected !== "string") return false;
  if (input.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(input, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// 解析 Cookie header 成物件;同名 cookie 後者覆寫前者(與 browser 一致行為)。
export function parseCookieHeader(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of String(raw).split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export function readAuthCookie(headers: IncomingHttpHeaders | Record<string, string>): string {
  const raw = (headers as any)?.cookie || "";
  const cookies = parseCookieHeader(raw);
  return cookies[COOKIE_NAME] || "";
}

// trust-proxy 關閉時永遠回 false (不依賴 client 提供的 header)。
// 開啟時讀 X-Forwarded-Proto,僅 "https" 算數;陣列情況取第一個。
export function shouldSetSecure(opts: {
  trustProxy: boolean;
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>;
}): boolean {
  if (!opts.trustProxy) return false;
  const raw = opts.headers?.["x-forwarded-proto"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "https";
}

export function buildSetCookie(
  value: string,
  opts: { secure: boolean; maxAge?: number } = { secure: false },
): string {
  const maxAge = opts.maxAge ?? COOKIE_MAX_AGE_SECONDS;
  const parts = [
    `${COOKIE_NAME}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearCookie(opts: { secure: boolean }): string {
  return buildSetCookie("", { secure: opts.secure, maxAge: 0 });
}

export interface AuthStore {
  issue(): string;
  verify(token: string | undefined | null): boolean;
  revoke(token: string | undefined | null): void;
  size(): number;
}

// 記憶體 token 儲存。issue 產 32 byte hex,verify 時 lazy GC 過期。
// now 與 ttlMs 可注入,便於測試。
export function createAuthStore(
  opts: { ttlMs?: number; now?: () => number } = {},
): AuthStore {
  const ttlMs = opts.ttlMs ?? COOKIE_MAX_AGE_SECONDS * 1000;
  const now = opts.now ?? Date.now;
  const tokens = new Map<string, { expiresAt: number }>();
  return {
    issue() {
      const token = randomBytes(32).toString("hex");
      tokens.set(token, { expiresAt: now() + ttlMs });
      return token;
    },
    verify(token) {
      if (!token || typeof token !== "string") return false;
      const entry = tokens.get(token);
      if (!entry) return false;
      if (entry.expiresAt < now()) {
        tokens.delete(token);
        return false;
      }
      return true;
    },
    revoke(token) {
      if (token && typeof token === "string") tokens.delete(token);
    },
    size() {
      return tokens.size;
    },
  };
}
