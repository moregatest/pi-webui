import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isEmbedSearch,
  createParentBridge,
  sanitizePage,
  viewportKind,
  readParentPage,
  turnEndMessages,
  createDisconnectNotice,
  DISCONNECT_NOTICE_DELAY_MS,
  createEmbedTurnState,
  embedLinkNavigateUrl,
  installEmbedLinkHandler,
} from "../public/embed.mjs";

const ORIGIN = "https://site.fly.dev";

function fakeWindows({ framed = true } = {}) {
  const parent = { sent: [], postMessage(msg, origin) { this.sent.push({ msg, origin }); } };
  const win = { location: { origin: ORIGIN } };
  win.parent = framed ? parent : win;
  return { win, parent };
}

test("isEmbedSearch：只認 embed=1；登入頁的 next 帶 embed=1 也算", () => {
  assert.equal(isEmbedSearch("?embed=1"), true);
  assert.equal(isEmbedSearch(""), false);
  assert.equal(isEmbedSearch("?embed=0"), false);
  assert.equal(isEmbedSearch(`?next=${encodeURIComponent("/agent/?embed=1")}`), true);
  assert.equal(isEmbedSearch("?next=%zz"), false);
});

test("createParentBridge.post：embed 且在框內才送，目標 origin 固定同源", () => {
  const { win, parent } = fakeWindows();
  const bridge = createParentBridge({ win, embed: true });
  bridge.post({ type: "readyai:ready" });
  assert.deepEqual(parent.sent, [{ msg: { type: "readyai:ready" }, origin: ORIGIN }]);
});

test("createParentBridge.post：非 embed 或沒有父頁都不送", () => {
  const a = fakeWindows();
  createParentBridge({ win: a.win, embed: false }).post({ type: "readyai:ready" });
  assert.equal(a.parent.sent.length, 0);
  const b = fakeWindows({ framed: false });
  assert.doesNotThrow(() => createParentBridge({ win: b.win, embed: true }).post({ type: "readyai:ready" }));
  assert.equal(b.parent.sent.length, 0);
});

test("createParentBridge.accept：只收同源、來源是父頁、type 為 readyai:page", () => {
  const { win, parent } = fakeWindows();
  const bridge = createParentBridge({ win, embed: true });
  const page = { type: "readyai:page", url: `${ORIGIN}/a.html`, title: "A", lang: "en" };
  assert.equal(bridge.accept({ origin: ORIGIN, source: parent, data: page }).url, `${ORIGIN}/a.html`);
  assert.equal(bridge.accept({ origin: ORIGIN, source: parent, data: { ...page, url: "https://evil.example/a" } }), null);
  assert.equal(bridge.accept({ origin: "https://evil.example", source: parent, data: page }), null);
  assert.equal(bridge.accept({ origin: ORIGIN, source: {}, data: page }), null);
  assert.equal(bridge.accept({ origin: ORIGIN, source: parent, data: { type: "readyai:unknown" } }), null);
  assert.equal(bridge.accept({ origin: ORIGIN, source: parent, data: "readyai:page" }), null);
});

test("createParentBridge.accept：非 embed 一律不收", () => {
  const { win, parent } = fakeWindows();
  const bridge = createParentBridge({ win, embed: false });
  assert.equal(bridge.accept({ origin: ORIGIN, source: parent, data: { type: "readyai:page", url: `${ORIGIN}/` } }), null);
});

test("sanitizePage：只留契約第 9 點欄位、字串截長；url 必須 http(s) 且同源", () => {
  const p = sanitizePage({ url: `${ORIGIN}/a`, title: 5, lang: "zh-TW", extra: 1, h1: "x".repeat(999) }, ORIGIN);
  assert.deepEqual(Object.keys(p).sort(), ["canonical", "description", "dir", "h1", "lang", "path", "referrer_path", "title", "url", "viewport"]);
  assert.equal(p.title, "");
  assert.equal(p.h1.length, 200);
  assert.equal(sanitizePage({ url: "javascript:void 0" }, ORIGIN), null);
  assert.equal(sanitizePage({ url: "https://evil.example/" }, ORIGIN), null);
  assert.equal(sanitizePage({}, ORIGIN), null);
});

test("viewportKind：依契約斷點分桌面／平板／手機", () => {
  assert.equal(viewportKind(1280), "desktop");
  assert.equal(viewportKind(1025), "desktop");
  assert.equal(viewportKind(1024), "tablet");
  assert.equal(viewportKind(601), "tablet");
  assert.equal(viewportKind(600), "mobile");
});

test("readParentPage：同源備援讀父頁欄位", () => {
  const els = {
    h1: { textContent: "  公司  簡介 " },
    'link[rel="canonical"]': { getAttribute: () => `${ORIGIN}/about` },
    'meta[name="description"]': { getAttribute: () => "說明" },
  };
  const parentWin = {
    innerWidth: 390,
    location: { href: `${ORIGIN}/about?x=1`, pathname: "/about", origin: ORIGIN },
    document: { title: "關於", referrer: `${ORIGIN}/`, documentElement: { lang: "zh-TW", dir: "" }, querySelector: (s) => els[s] || null },
  };
  assert.deepEqual(readParentPage(parentWin), {
    url: `${ORIGIN}/about?x=1`, path: "/about", title: "關於", lang: "zh-TW", dir: "", h1: "公司 簡介",
    canonical: `${ORIGIN}/about`, description: "說明", referrer_path: "/", viewport: "mobile",
  });
});

test("turnEndMessages：一律送 turn-end；有寫入再加 content-changed", () => {
  assert.deepEqual(turnEndMessages({ contentChanged: false }), [{ type: "readyai:turn-end" }]);
  assert.deepEqual(turnEndMessages({ contentChanged: true }), [
    { type: "readyai:turn-end" },
    { type: "readyai:content-changed" },
  ]);
  // 判斷不出來時寧可多送
  assert.deepEqual(turnEndMessages(undefined), [{ type: "readyai:turn-end" }, { type: "readyai:content-changed" }]);
});

function fakeTimers() {
  let now = 0;
  const timers = new Map();
  let id = 0;
  return {
    setTimer: (fn, ms) => { timers.set(++id, { fn, at: now + ms }); return id; },
    clearTimer: (h) => { timers.delete(h); },
    advance(ms) {
      now += ms;
      for (const [h, t] of [...timers]) if (t.at <= now) { timers.delete(h); t.fn(); }
    },
    pending: () => timers.size,
  };
}

test("斷線橫幅延遲約 5 秒", () => {
  assert.ok(DISCONNECT_NOTICE_DELAY_MS >= 4000 && DISCONNECT_NOTICE_DELAY_MS <= 6000);
});

test("createDisconnectNotice：短暫斷線（5 秒內重連）不顯示橫幅", () => {
  const t = fakeTimers();
  const calls = [];
  const n = createDisconnectNotice({ ...t, show: () => calls.push("show"), hide: () => calls.push("hide") });
  n.onDisconnected();
  t.advance(2000);
  n.onDisconnected(); // 重連失敗再次 close，不重設計時
  t.advance(1000);
  n.onConnected();
  t.advance(10000);
  assert.deepEqual(calls.filter((c) => c === "show"), []);
  assert.equal(n.visible, false);
});

test("createDisconnectNotice：連續失敗超過延遲才顯示；重連成功立即隱藏", () => {
  const t = fakeTimers();
  const calls = [];
  const n = createDisconnectNotice({ ...t, show: () => calls.push("show"), hide: () => calls.push("hide") });
  n.onDisconnected();
  t.advance(1000);
  n.onDisconnected();
  t.advance(DISCONNECT_NOTICE_DELAY_MS);
  assert.deepEqual(calls, ["show"]);
  assert.equal(n.visible, true);
  n.onConnected();
  assert.deepEqual(calls, ["show", "hide"]);
  assert.equal(n.visible, false);
  assert.equal(t.pending(), 0);
});

import { createChatState, setHistory, selectItems } from "../public/chat-state.mjs";

test("selectItems：頁面上下文（readyai_page_context）不顯示在對話裡", () => {
  const s = createChatState();
  setHistory(s, [
    { role: "user", content: [{ type: "text", text: "幫我改標題" }] },
    { role: "custom", customType: "readyai_page_context", display: false, content: "客戶目前在看：https://a/" },
    { role: "custom", customType: "other_custom", content: "保留" },
  ]);
  const items = selectItems(s);
  assert.equal(items.some((i) => i.message?.customType === "readyai_page_context"), false);
  assert.equal(items.some((i) => i.message?.customType === "other_custom"), true);
});

test("createEmbedTurnState：一般一輪 start → end 照常轉給父頁", () => {
  const t = createEmbedTurnState();
  assert.deepEqual(t.start(), [{ type: "readyai:turn-start" }]);
  assert.deepEqual(t.end({ contentChanged: false }), [{ type: "readyai:turn-end" }]);
  assert.deepEqual(t.end({ contentChanged: true }), [{ type: "readyai:turn-end" }, { type: "readyai:content-changed" }]);
});

test("createEmbedTurnState：重連補送的結束，只有斷線前有一輪開著才轉（父頁解除處理中並提示重整）", () => {
  const t = createEmbedTurnState();
  t.start();
  assert.deepEqual(t.end({ contentChanged: true, reconnect: true }),
    [{ type: "readyai:turn-end" }, { type: "readyai:content-changed" }]);
  // 沒有開著的一輪：網路抖動重連不提示
  assert.deepEqual(t.end({ contentChanged: true, reconnect: true }), []);
  assert.deepEqual(createEmbedTurnState().end({ contentChanged: true, reconnect: true }), []);
});

// ---------- 契約第 11 點：助理對話裡的站內連結在原頁開啟 ----------
const BASE_URL = `${ORIGIN}/agent/?embed=1`;
const click = (over = {}) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over });

test("embedLinkNavigateUrl：同源站內網頁 → 絕對網址（相對、絕對、帶查詢與錨點都可）", () => {
  const nav = (href) => embedLinkNavigateUrl({ href, hasDownload: false, baseUrl: BASE_URL, ...click() });
  assert.equal(nav("/en/page/translation-quality-assurance.html"), `${ORIGIN}/en/page/translation-quality-assurance.html`);
  assert.equal(nav(`${ORIGIN}/en/index.html?x=1#top`), `${ORIGIN}/en/index.html?x=1#top`);
  assert.equal(nav("/"), `${ORIGIN}/`);
  assert.equal(nav("/agents.html"), `${ORIGIN}/agents.html`); // 只擋 /agent 這一段，不擋同字首的網頁
  assert.equal(nav("/en/product/a"), `${ORIGIN}/en/product/a`);
});

test("embedLinkNavigateUrl：外部網址、助理自身、報表、下載、非 http 一律 null（維持開新分頁）", () => {
  const nav = (href, over = {}) => embedLinkNavigateUrl({ href, hasDownload: false, baseUrl: BASE_URL, ...click(), ...over });
  for (const href of [
    "https://example.com/a.html", "http://site.fly.dev/a.html", "//evil.test/a",
    "/agent", "/agent/", "/agent/?embed=1", "/AGENT/x", "/agent-embed/loader.js", "/_review/abc/index.html", "/_review",
    "/files/catalog.pdf", "/upload/a.ZIP", "/img/photo.jpg", "/x/report.xlsx", "/x/data.csv",
    "mailto:a@b.c", "tel:123", "javascript:alert(1)", "data:text/html,hi", "#sec2", "", null, undefined,
  ]) {
    assert.equal(nav(href), null, String(href));
  }
  assert.equal(nav("/en/page/a.html", { hasDownload: true }), null, "download 屬性");
});

test("embedLinkNavigateUrl：Cmd／Ctrl／Shift／Alt 或非左鍵 → null（照瀏覽器原本行為）", () => {
  const nav = (over) => embedLinkNavigateUrl({ href: "/en/page/a.html", hasDownload: false, baseUrl: BASE_URL, ...click(over) });
  for (const over of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }]) {
    assert.equal(nav(over), null, JSON.stringify(over));
  }
  assert.equal(nav({}), `${ORIGIN}/en/page/a.html`);
});

function fakeDoc() {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatch(type, ev) { for (const fn of listeners[type] || []) fn(ev); },
  };
}

function fakeAnchor(href, { download = false } = {}) {
  const a = {
    getAttribute: (n) => (n === "href" ? href : null),
    hasAttribute: (n) => (n === "download" ? download : n === "href"),
  };
  a.closest = (sel) => (sel === "a[href]" ? a : null);
  return a;
}

function fakeClick(anchor, over = {}) {
  const ev = { ...click(over), defaultPrevented: false, target: anchor };
  ev.preventDefault = () => { ev.defaultPrevented = true; };
  return ev;
}

test("installEmbedLinkHandler：embed 框內點站內連結 → 送 readyai:navigate 並 preventDefault", () => {
  const { win, parent } = fakeWindows();
  win.location.href = BASE_URL;
  const doc = fakeDoc();
  const bridge = createParentBridge({ win, embed: true });
  assert.equal(installEmbedLinkHandler({ doc, bridge, win }), true);
  const ev = fakeClick(fakeAnchor("/en/page/translation-quality-assurance.html"));
  doc.dispatch("click", ev);
  assert.equal(ev.defaultPrevented, true);
  assert.deepEqual(parent.sent, [{ msg: { type: "readyai:navigate", url: `${ORIGIN}/en/page/translation-quality-assurance.html` }, origin: ORIGIN }]);
});

test("installEmbedLinkHandler：外部、報表、下載、Cmd 點擊、已被處理的點擊都不攔不送", () => {
  const { win, parent } = fakeWindows();
  win.location.href = BASE_URL;
  const doc = fakeDoc();
  installEmbedLinkHandler({ doc, bridge: createParentBridge({ win, embed: true }), win });
  const cases = [
    fakeClick(fakeAnchor("https://example.com/")),
    fakeClick(fakeAnchor("/_review/abc/")),
    fakeClick(fakeAnchor("/en/a.html", { download: true })),
    fakeClick(fakeAnchor("/en/a.html"), { metaKey: true }),
    fakeClick(fakeAnchor("/en/a.html"), { ctrlKey: true }),
    fakeClick({ closest: () => null }),
    { ...fakeClick(fakeAnchor("/en/a.html")), defaultPrevented: true },
  ];
  for (const ev of cases) {
    const before = ev.defaultPrevented;
    doc.dispatch("click", ev);
    assert.equal(ev.defaultPrevented, before);
  }
  assert.deepEqual(parent.sent, []);
});

test("installEmbedLinkHandler：非 embed 或不在框內時不掛監聽（全螢幕版行為不變）", () => {
  for (const [embed, framed] of [[false, true], [true, false]]) {
    const { win } = fakeWindows({ framed });
    win.location.href = BASE_URL;
    const doc = fakeDoc();
    assert.equal(installEmbedLinkHandler({ doc, bridge: createParentBridge({ win, embed }), win }), false);
    assert.deepEqual(doc.listeners, {});
  }
});
