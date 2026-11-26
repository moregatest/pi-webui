// 信任上游身分（W60-01，cm-piui 改一）：中心閘道核過 Tailscale 身分後，以固定標頭把登入身分送進來，
// pi-webui 以該標頭的值當登入身分、略過密碼。
//
// 安全前提（缺一不可，啟動時檢查，不符就拒絕啟動）：
// - 只聽本機（127.0.0.1／::1）：外部無法直接連到實例的埠，只有同機的閘道送得進來；
// - 不可與 --tunnel 同時開：cloudflared 從本機連進來，「只聽本機」擋不住隧道外的人；
// - 不可與密碼同時開：兩種登入方式並存時，行為不明確。
// 閘道必須在轉發時移除外部送來的同名標頭（閘道的責任，本模組只信任本機來的請求）。
//
// 預覽站預設不開（環境變數沒設），客戶的密碼登入完全不變。

import type { IncomingHttpHeaders } from "node:http";

export const TRUST_UPSTREAM_ENV = "PI_WEBUI_TRUST_UPSTREAM_HEADER";
export const HOME_URL_ENV = "PI_WEBUI_HOME_URL";

const HEADER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// 這些標頭由瀏覽器、HTTP 協定或代理自己設定，拿來當身分會被偽造或撞名
const FORBIDDEN_HEADER_NAMES = new Set([
  "host", "cookie", "authorization", "proxy-authorization", "connection", "upgrade",
  "content-length", "content-type", "transfer-encoding", "origin", "referer", "user-agent",
  "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded",
  "sec-websocket-key", "sec-websocket-protocol", "sec-websocket-version", "sec-websocket-extensions",
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
}): void {
  if (!opts.header) return;
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
