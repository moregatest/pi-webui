// 信任上游身分（W60-01，cm-piui 改一）：中心閘道核過 Tailscale 身分後，以固定標頭把登入身分送進來，
// pi-webui 以該標頭的值當登入身分、略過密碼。
//
// 安全前提（缺一不可，啟動時檢查，不符就拒絕啟動）：
// - 只聽本機（127.0.0.1／::1）：外部無法直接連到實例的埠；
// - 每個實例一把共享密鑰（RV60-01 高 1）：同機的其他程序（例如另一個實例裡的 agent）也連得到本機埠，
//   只看身分標頭等於誰都能冒充。閘道每次轉發都要帶 X-ReadyAI-Gateway-Secret，常數時間比對。
//   密鑰從 PI_WEBUI_TRUST_UPSTREAM_SECRET_FILE 讀一次就刪檔，不進行程環境（bash 也就拿不到）；
// - 瀏覽器來的 WebSocket 升級與非 GET 請求，Origin 必須是閘道的來源（RV60-01 中 1）：
//   身分由閘道依來源 IP 加上，屬「環境身分」，跨站網頁也能讓瀏覽器連進來；
// - 不可與 --tunnel 同時開：cloudflared 從本機連進來，「只聽本機」擋不住隧道外的人；
// - 不可與密碼同時開：兩種登入方式並存時，行為不明確。
// 閘道必須在轉發時移除外部送來的同名身分標頭與密鑰標頭（閘道的責任）。
//
// 預覽站預設不開（環境變數沒設），客戶的密碼登入完全不變。

import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, unlinkSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";

export const TRUST_UPSTREAM_ENV = "PI_WEBUI_TRUST_UPSTREAM_HEADER";
export const HOME_URL_ENV = "PI_WEBUI_HOME_URL";
export const SECRET_FILE_ENV = "PI_WEBUI_TRUST_UPSTREAM_SECRET_FILE";
export const TRUSTED_ORIGIN_ENV = "PI_WEBUI_TRUSTED_ORIGIN";
/** 閘道每次轉發都要帶的密鑰標頭（小寫，Node headers 物件的鍵）。 */
export const GATEWAY_SECRET_HEADER = "x-readyai-gateway-secret";
export const SECRET_MIN_LENGTH = 32;
export const SECRET_MAX_LENGTH = 1024;

const HEADER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// 這些標頭由瀏覽器、HTTP 協定或代理自己設定，拿來當身分會被偽造或撞名
const FORBIDDEN_HEADER_NAMES = new Set([
  "host", "cookie", "authorization", "proxy-authorization", "connection", "upgrade",
  "content-length", "content-type", "transfer-encoding", "origin", "referer", "user-agent",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded",
  "sec-websocket-key", "sec-websocket-protocol", "sec-websocket-version", "sec-websocket-extensions",
  GATEWAY_SECRET_HEADER,
]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]"]);
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export const IDENTITY_MAX_LENGTH = 256;

/** 解析標頭名稱；沒設（undefined／空字串）回 null；格式不合或在禁用清單丟錯。回傳小寫（Node 的 headers 物件鍵是小寫）。 */
export function parseTrustUpstreamHeader(raw: string | undefined): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const name = value.toLowerCase();
  if (!HEADER_NAME_RE.test(name)) {
    throw new Error(`${TRUST_UPSTREAM_ENV}: 標頭名稱只能是英數字與「-」（1～64 字）：${JSON.stringify(value)}`);
  }
  if (FORBIDDEN_HEADER_NAMES.has(name)) {
    throw new Error(`${TRUST_UPSTREAM_ENV}: 不可使用協定或代理自己會設的標頭 ${name}`);
  }
  return name;
}

/** 綁定位址是否為本機（只接受字面位址，不接受 localhost 這類要解析的名稱）。 */
export function isLoopbackHost(host: string | undefined): boolean {
  return LOOPBACK_HOSTS.has(String(host ?? "").trim());
}

/** 連線的對端位址是否為本機（IPv4、IPv6、IPv4-mapped IPv6）。 */
export function isLoopbackAddress(addr: string | undefined | null): boolean {
  return LOOPBACK_ADDRESSES.has(String(addr ?? ""));
}

/** 啟動前檢查；不符合安全前提就丟錯（呼叫端印錯誤並以非零結束）。 */
export function assertTrustUpstreamAllowed(opts: {
  header: string | null;
  host: string;
  tunnelEnabled: boolean;
  passwordSet: boolean;
  secretFile?: string | undefined;
  trustedOrigin?: string | null;
}): void {
  if (!opts.header) return;
  if (!String(opts.secretFile ?? "").trim()) {
    throw new Error(
      `${TRUST_UPSTREAM_ENV} 需要同時設定 ${SECRET_FILE_ENV}（每個實例一把的閘道密鑰檔）；` +
        "只靠身分標頭時，同機任何程序都能冒充",
    );
  }
  if (!opts.trustedOrigin) {
    throw new Error(
      `${TRUST_UPSTREAM_ENV} 需要閘道的來源：設定 ${TRUSTED_ORIGIN_ENV}（例如 http://100.64.0.1:8790），` +
        `或把 ${HOME_URL_ENV} 設成閘道上的絕對網址`,
    );
  }
  if (!isLoopbackHost(opts.host)) {
    throw new Error(
      `${TRUST_UPSTREAM_ENV} 只能在綁定 127.0.0.1 或 ::1 時開啟（目前綁定 ${opts.host}）；` +
        "對外綁定時任何人都能自己送這個標頭冒充身分",
    );
  }
  if (opts.tunnelEnabled) {
    throw new Error(`${TRUST_UPSTREAM_ENV} 不可與 --tunnel 同時開啟：隧道從本機連進來，只聽本機擋不住外部的人`);
  }
  if (opts.passwordSet) {
    throw new Error(`${TRUST_UPSTREAM_ENV} 不可與 --password／PI_WEBUI_PASSWORD 同時設定：兩種登入方式二選一`);
  }
}

/**
 * 從請求標頭讀上游身分；不合格回 null（呼叫端回 401）。
 * - 同名標頭出現多次（Node 會合併成「, 」或陣列）一律拒絕：閘道只該送一個；
 * - 只收可見 ASCII 與中間的空白，最長 256 字，不可含逗號與控制字元。
 */
export function readUpstreamIdentity(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const raw = (headers as any)?.[name];
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > IDENTITY_MAX_LENGTH) return null;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c > 0x7e || c === 0x2c) return null;
  }
  return value;
}

/**
 * 「回到專案清單」連結的網址；沒設回 null。只接受 http(s) 絕對網址，或以單一「/」開頭的站內路徑，
 * 其他（javascript:、//host、相對路徑、帶帳密的網址）丟錯。
 */
export function parseHomeUrl(raw: string | undefined): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (value.startsWith("/")) {
    if (value.startsWith("//") || value.startsWith("/\\")) {
      throw new Error(`${HOME_URL_ENV}: 站內路徑不可以「//」開頭：${JSON.stringify(value)}`);
    }
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${HOME_URL_ENV}: 不是合法網址：${JSON.stringify(value)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${HOME_URL_ENV}: 只接受 http 或 https 網址：${JSON.stringify(value)}`);
  }
  if (url.username || url.password) {
    throw new Error(`${HOME_URL_ENV}: 網址不可帶帳號密碼`);
  }
  return url.toString();
}

/**
 * 讀閘道密鑰檔（RV60-01 高 1）：必須是自己擁有的一般檔、不是符號連結、群組與其他人沒有任何權限；
 * 內容去掉頭尾空白後 32～1024 個可見 ASCII 字元。讀完立刻刪檔（刪不掉就丟錯：密鑰可能還留在磁碟上）。
 * 回傳值只留在記憶體，呼叫端不可寫進 process.env 或紀錄。
 */
export function loadGatewaySecret(
  path: string,
  fsOps: {
    lstat?: typeof lstatSync;
    read?: (p: string) => string;
    unlink?: (p: string) => void;
    uid?: number;
  } = {},
): string {
  const lstat = fsOps.lstat ?? lstatSync;
  const read = fsOps.read ?? ((p) => readFileSync(p, "utf8"));
  const unlink = fsOps.unlink ?? unlinkSync;
  const uid = fsOps.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  let st;
  try {
    st = lstat(path);
  } catch {
    throw new Error(`${SECRET_FILE_ENV}: 讀不到密鑰檔 ${path}`);
  }
  if (st.isSymbolicLink()) throw new Error(`${SECRET_FILE_ENV}: 密鑰檔不可是符號連結`);
  if (!st.isFile()) throw new Error(`${SECRET_FILE_ENV}: 密鑰檔必須是一般檔案`);
  if (uid >= 0 && st.uid !== uid) throw new Error(`${SECRET_FILE_ENV}: 密鑰檔的擁有者必須是執行 pi-webui 的使用者`);
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`${SECRET_FILE_ENV}: 密鑰檔權限必須是 0600 或 0400（群組與其他人不可讀寫）`);
  }
  const value = read(path).trim();
  try {
    unlink(path);
  } catch {
    throw new Error(`${SECRET_FILE_ENV}: 讀完後刪不掉密鑰檔 ${path}，為免密鑰留在磁碟上，停止啟動`);
  }
  if (value.length < SECRET_MIN_LENGTH || value.length > SECRET_MAX_LENGTH) {
    throw new Error(`${SECRET_FILE_ENV}: 密鑰長度必須是 ${SECRET_MIN_LENGTH}～${SECRET_MAX_LENGTH} 字元`);
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) throw new Error(`${SECRET_FILE_ENV}: 密鑰只能是可見 ASCII 字元（不含空白）`);
  }
  return value;
}

const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest();

/** 請求帶的密鑰標頭是否等於設定的密鑰；兩邊先雜湊成等長再常數時間比對，長度不同也不提早結束。 */
export function gatewaySecretMatches(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  secret: string | null,
): boolean {
  if (!secret) return false;
  const raw = (headers as any)?.[GATEWAY_SECRET_HEADER];
  if (typeof raw !== "string" || !raw) return false;
  return timingSafeEqual(sha256(raw), sha256(secret));
}

/**
 * 閘道的來源（scheme://host[:port]）：先看 PI_WEBUI_TRUSTED_ORIGIN（只能是來源，不可帶路徑、查詢、帳密），
 * 沒設時由 http(s) 絕對的 PI_WEBUI_HOME_URL 推得；都沒有回 null。
 */
export function parseTrustedOrigin(raw: string | undefined, homeUrl: string | null): string | null {
  const value = String(raw ?? "").trim();
  if (value) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${TRUSTED_ORIGIN_ENV}: 不是合法網址：${JSON.stringify(value)}`);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`${TRUSTED_ORIGIN_ENV}: 只接受 http 或 https`);
    }
    if (url.username || url.password || (url.pathname && url.pathname !== "/") || url.search || url.hash) {
      throw new Error(`${TRUSTED_ORIGIN_ENV}: 只能是來源（scheme://host[:port]），不可帶路徑、查詢或帳密`);
    }
    return url.origin;
  }
  if (homeUrl && /^https?:\/\//i.test(homeUrl)) return new URL(homeUrl).origin;
  return null;
}

/**
 * Origin 檢查（RV60-01 中 1）：沒有 Origin 標頭（curl 等非瀏覽器用戶端）放行；
 * 有的話必須正規化後等於閘道來源（"null"、格式錯、重複都不符）。
 */
export function originAllowed(
  headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>,
  trustedOrigin: string | null,
): boolean {
  const raw = (headers as any)?.origin;
  if (raw === undefined) return true;
  if (typeof raw !== "string" || !trustedOrigin) return false;
  try {
    const url = new URL(raw);
    return url.origin !== "null" && url.origin === trustedOrigin;
  } catch {
    return false;
  }
}
