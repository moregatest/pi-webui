// 鑲嵌模式（/agent/?embed=1）的瀏覽器端純邏輯，依 W18 契約：
// - 對父頁 postMessage（readyai:ready／auth／turn-end／content-changed）
// - 收父頁的 readyai:page（客戶目前在看的頁面，契約第 9 點），轉成 page_view 送 server 保存
// - 斷線橫幅延遲顯示：先靜默重連，連續失敗超過約 5 秒才顯示
// - 對話裡的站內連結改送 readyai:navigate，由父頁在原分頁換頁（契約第 11 點）

/** 自身網址 embed=1，或登入頁 next 指向的網址帶 embed=1 */
export function isEmbedSearch(search) {
  let params;
  try {
    params = new URLSearchParams(search || "");
  } catch {
    return false;
  }
  if (params.get("embed") === "1") return true;
  const next = params.get("next");
  if (!next) return false;
  const q = next.indexOf("?");
  if (q < 0) return false;
  try {
    return new URLSearchParams(next.slice(q + 1)).get("embed") === "1";
  } catch {
    return false;
  }
}

// 契約第 9 點的頁面欄位與長度上限（server 端 page-awareness.ts 會再完整檢查一次）
const PAGE_FIELDS = {
  url: 2000, path: 500, title: 300, lang: 35, dir: 3, h1: 200,
  canonical: 2000, description: 300, referrer_path: 500, viewport: 7,
};

/** 父頁送來的頁面資訊：只留契約欄位、字串截長；url 必須與 iframe 同源 */
export function sanitizePage(data, origin) {
  if (!data || typeof data !== "object") return null;
  if (typeof data.url !== "string" || data.url.length > PAGE_FIELDS.url) return null;
  let u;
  try {
    u = new URL(data.url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (origin && u.origin !== origin) return null;
  const out = {};
  for (const [k, max] of Object.entries(PAGE_FIELDS)) {
    out[k] = typeof data[k] === "string" ? data[k].slice(0, max) : "";
  }
  return out;
}

/** 依視窗寬度判斷裝置（契約第 6 點的斷點） */
export function viewportKind(width) {
  if (width <= 600) return "mobile";
  if (width <= 1024) return "tablet";
  return "desktop";
}

/** 父頁沒送 readyai:page 時的備援：同源 iframe 直接讀父頁 */
export function readParentPage(parentWin) {
  const doc = parentWin.document;
  const text = (el, max) => (el?.textContent || "").replace(/\s+/g, " ").trim().slice(0, max);
  const attr = (sel, name) => doc.querySelector(sel)?.getAttribute(name) || "";
  let referrerPath = "";
  try {
    const r = doc.referrer ? new URL(doc.referrer) : null;
    if (r && r.origin === parentWin.location.origin) referrerPath = r.pathname;
  } catch {}
  return {
    url: parentWin.location.href,
    path: parentWin.location.pathname,
    title: doc.title || "",
    lang: doc.documentElement.lang || "",
    dir: doc.documentElement.dir || "",
    h1: text(doc.querySelector("h1"), 200),
    canonical: attr('link[rel="canonical"]', "href"),
    description: attr('meta[name="description"]', "content").slice(0, 300),
    referrer_path: referrerPath,
    viewport: viewportKind(parentWin.innerWidth),
  };
}

/**
 * 與父頁的通道。只在 embed 且確實在框內（parent !== self）時送；
 * 收訊檢查 origin 同源、source 是父頁、type 認得。
 */
export function createParentBridge({ win, embed }) {
  const framed = !!(win && win.parent && win.parent !== win);
  const origin = win?.location?.origin;
  return {
    active: !!embed && framed,
    post(msg) {
      if (!embed || !framed) return;
      try {
        win.parent.postMessage(msg, origin);
      } catch {
        // 父頁已離開等情況，靜默略過
      }
    },
    /** 回傳合法的 page 物件；其他一律 null（忽略） */
    accept(event) {
      if (!embed || !framed || !event) return null;
      if (event.origin !== origin) return null;
      if (event.source !== win.parent) return null;
      const data = event.data;
      if (!data || typeof data !== "object" || data.type !== "readyai:page") return null;
      return sanitizePage(data, origin);
    },
  };
}

/** server 的 embed_turn_end → 要送給父頁的訊息；判斷不出來（缺欄位）時寧可多送 content-changed */
export function turnEndMessages(result) {
  const out = [{ type: "readyai:turn-end" }];
  if (!result || typeof result.contentChanged !== "boolean" || result.contentChanged) {
    out.push({ type: "readyai:content-changed" });
  }
  return out;
}

/**
 * 父頁「處理中」狀態的 iframe 端鏡像：記得是否有一輪開著。
 * 一般的 embed_turn_end 照常轉；重連補送的（payload.reconnect）只有斷線前有一輪開著才轉，
 * 避免網路抖動重連就跳「網站已更新」。
 */
export function createEmbedTurnState() {
  let open = false;
  return {
    start() {
      open = true;
      return [{ type: "readyai:turn-start" }];
    },
    end(result) {
      if (result && result.reconnect === true && !open) return [];
      open = false;
      return turnEndMessages(result);
    },
  };
}

export const DISCONNECT_NOTICE_DELAY_MS = 5000;

/**
 * 斷線橫幅延遲：第一次斷線起算，連續斷線超過 delayMs 才 show；重連成功立即 hide。
 * 期間重複的 close（重連失敗）不重設計時。
 */
export function createDisconnectNotice({
  delayMs = DISCONNECT_NOTICE_DELAY_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
  show,
  hide,
}) {
  let timer = null;
  const state = {
    visible: false,
    onDisconnected() {
      if (state.visible || timer !== null) return;
      timer = setTimer(() => {
        timer = null;
        state.visible = true;
        show();
      }, delayMs);
    },
    onConnected() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (state.visible) {
        state.visible = false;
        hide();
      }
    },
  };
  return state;
}

// ---------- 契約第 11 點：助理對話裡的站內連結在原頁開啟 ----------

// 不在原頁換頁的路徑段：助理自身、載入碼、修改報表
const NON_PAGE_PATH = /^\/(agent|agent-embed|_review)(\/|$)/i;
// 看副檔名就知道是下載的檔案（網頁類 .html／.php 等不在此列）
const DOWNLOAD_EXT = new Set([
  "pdf", "zip", "rar", "7z", "gz", "tgz", "tar", "bz2", "xz",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf", "csv", "txt", "json", "xml",
  "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "tif", "tiff", "heic", "avif",
  "mp3", "mp4", "mov", "avi", "wmv", "webm", "wav", "ogg", "m4a",
  "dwg", "dxf", "step", "stp", "igs", "iges", "stl", "exe", "dmg", "apk", "msi",
]);

/**
 * 點擊對話裡的連結時，若應改由父頁在原分頁換頁，回傳絕對網址；否則 null（維持開新分頁或瀏覽器原本行為）。
 * 條件：左鍵且沒按 Cmd／Ctrl／Shift／Alt、沒有 download 屬性、http(s) 且與 iframe 同源、不帶帳密、
 * 路徑不是 /agent、/agent-embed、/_review 開頭、副檔名不是下載檔、不是只有 # 錨點。
 */
export function embedLinkNavigateUrl({ href, hasDownload, baseUrl, button, metaKey, ctrlKey, shiftKey, altKey }) {
  if (button !== 0 || metaKey || ctrlKey || shiftKey || altKey || hasDownload) return null;
  if (typeof href !== "string" || !href.trim() || href.trim().startsWith("#")) return null;
  let base;
  let u;
  try {
    base = new URL(baseUrl);
    u = new URL(href, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.origin !== base.origin) return null;
  // 帶帳密的網址（https://u:p@同站/…）不轉給父頁（RV21-01 低-1）
  if (u.username || u.password) return null;
  let path;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    path = u.pathname;
  }
  if (NON_PAGE_PATH.test(path)) return null;
  const last = path.split("/").pop() || "";
  const dot = last.lastIndexOf(".");
  if (dot > 0 && DOWNLOAD_EXT.has(last.slice(dot + 1).toLowerCase())) return null;
  return u.href;
}

/**
 * embed、在框內且父頁同源時，在 document 掛 click 監聽：符合條件的連結改送 readyai:navigate 給父頁。
 * 不符合的連結完全不碰（原本的 target="_blank" 照常開新分頁）。回傳是否有掛。
 */
export function installEmbedLinkHandler({ doc, bridge, win }) {
  if (!doc || !bridge || !bridge.active) return false;
  // 父頁必須同源（loader 只會在同源網站頁建立 iframe）；跨源讀 location 會丟例外，
  // 不同源就不攔，維持開新分頁，避免 preventDefault 後訊息沒人收、點了沒反應（RV21-01 低-2）
  try {
    if (win.parent.location.origin !== win.location.origin) return false;
  } catch {
    return false;
  }
  doc.addEventListener("click", (ev) => {
    if (!ev || ev.defaultPrevented) return;
    const a = ev.target && typeof ev.target.closest === "function" ? ev.target.closest("a[href]") : null;
    if (!a) return;
    const url = embedLinkNavigateUrl({
      href: a.getAttribute("href"),
      hasDownload: a.hasAttribute("download"),
      baseUrl: win.location.href,
      button: ev.button,
      metaKey: ev.metaKey,
      ctrlKey: ev.ctrlKey,
      shiftKey: ev.shiftKey,
      altKey: ev.altKey,
    });
    if (!url) return;
    ev.preventDefault();
    bridge.post({ type: "readyai:navigate", url });
  });
  return true;
}
