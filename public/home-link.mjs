// W60-01：「回到專案清單」連結。server 只在設了 PI_WEBUI_HOME_URL 時於 connected 送 homeUrl
// （已在 server 驗證）；前端再擋一次，只收 http(s) 絕對網址或以單一「/」開頭的站內路徑。

export function isSafeHomeUrl(value) {
  if (typeof value !== "string" || !value) return false;
  if (/^https?:\/\//i.test(value)) return true;
  return value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\");
}

/** 依 homeUrl 顯示或隱藏 #home-nav；回傳是否顯示。 */
export function applyHomeLink(doc, homeUrl) {
  const nav = doc?.getElementById?.("home-nav");
  const link = doc?.getElementById?.("home-link");
  if (!nav || !link) return false;
  if (!isSafeHomeUrl(homeUrl)) {
    nav.hidden = true;
    link.removeAttribute("href");
    return false;
  }
  link.setAttribute("href", homeUrl);
  nav.hidden = false;
  return true;
}
