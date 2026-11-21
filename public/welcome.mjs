// 開場引導:客戶還沒有任何對話時,在對話區顯示說明與可直接點選的建議句。
// 內容來自 server connected packet 的 uiProfile.welcome(profile [welcome]),
// pi-webui 本身不寫死任何文案。一律用 textContent 輸出,不當 HTML 解析。

const MAX_STARTERS = 6;
const MAX_TITLE = 60;
const MAX_BODY = 400;
const MAX_STARTER = 60;

function clip(s, max) {
  const chars = [...s];
  return chars.length > max ? chars.slice(0, max).join("") : s;
}

// server 已驗證;client 端再做一次防禦性整理(舊版 / 異常 payload 不出錯)。
export function normalizeWelcome(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const title = typeof raw.title === "string" ? clip(raw.title.trim(), MAX_TITLE) : "";
  const body = typeof raw.body === "string" ? clip(raw.body.trim(), MAX_BODY) : "";
  const starters = Array.isArray(raw.starters)
    ? raw.starters
        .filter((s) => typeof s === "string" && s.trim())
        .map((s) => clip(s.trim(), MAX_STARTER))
        .slice(0, MAX_STARTERS)
    : [];
  if (!title && !body && starters.length === 0) return null;
  return { title, body, starters };
}

const MAX_PLACEHOLDER = 60;

// 輸入框提示(profile [welcome].input_placeholder);與開場卡片分開判斷。
export function welcomePlaceholder(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.inputPlaceholder !== "string") return "";
  return clip(raw.inputPlaceholder.trim(), MAX_PLACEHOLDER);
}

// historyReady:已收到這次連線的 message_history,避免有歷史的對話在載入前閃一下引導。
export function shouldShowWelcome(welcome, { historyReady, visibleCount }) {
  return !!welcome && !!historyReady && visibleCount === 0;
}

export function createWelcomeView({ document, welcome, onPick }) {
  const root = document.createElement("div");
  root.className = "welcome";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", welcome.title || "開始對話");
  if (welcome.title) {
    const h = document.createElement("h2");
    h.className = "welcome-title";
    h.textContent = welcome.title;
    root.append(h);
  }
  if (welcome.body) {
    const p = document.createElement("p");
    p.className = "welcome-body";
    p.textContent = welcome.body;
    root.append(p);
  }
  if (welcome.starters.length) {
    const list = document.createElement("div");
    list.className = "welcome-starters";
    for (const text of welcome.starters) {
      const btn = document.createElement("button");
      btn.setAttribute("type", "button");
      btn.className = "welcome-starter";
      btn.textContent = text;
      btn.addEventListener("click", () => onPick(text));
      list.append(btn);
    }
    root.append(list);
  }
  return root;
}
