// 鑲嵌模式（/agent/?embed=1）的瀏覽器端純邏輯，依 W18 契約：
// - 對父頁 postMessage（readyai:ready／auth／turn-end／content-changed）
// - 收父頁的 readyai:page（客戶目前在看的頁面，契約第 9 點），轉成 page_view 送 server 保存
// - 斷線橫幅延遲顯示：先靜默重連，連續失敗超過約 5 秒才顯示

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
