// W60-01：前端「回到專案清單」連結
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyHomeLink, isSafeHomeUrl } from "../public/home-link.mjs";

function fakeDoc() {
  const link = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
  const nav = { hidden: true };
  return { nav, link, getElementById: (id) => (id === "home-nav" ? nav : id === "home-link" ? link : null) };
}

test("沒有 homeUrl 就不顯示", () => {
  for (const v of [undefined, null, "", 0]) {
    const d = fakeDoc();
    assert.equal(applyHomeLink(d, v), false);
    assert.equal(d.nav.hidden, true);
    assert.equal("href" in d.link.attrs, false);
  }
});

test("http(s) 網址與站內路徑才顯示", () => {
  for (const v of ["https://center.example.ts.net/continue/", "http://127.0.0.1:8080/", "/continue/"]) {
    const d = fakeDoc();
    assert.equal(applyHomeLink(d, v), true, v);
    assert.equal(d.nav.hidden, false);
    assert.equal(d.link.attrs.href, v);
  }
  for (const v of ["javascript:alert(1)", "//evil.example/", "/\\evil", "data:text/html,x", "continue"]) {
    assert.equal(isSafeHomeUrl(v), false, v);
    const d = fakeDoc();
    d.nav.hidden = false;
    d.link.attrs.href = "stale";
    assert.equal(applyHomeLink(d, v), false, v);
    assert.equal(d.nav.hidden, true);
    assert.equal("href" in d.link.attrs, false);
  }
});

test("index.html：連結預設隱藏、主要控制項都有可讀名稱", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<nav id="home-nav"[^>]*aria-label="專案導覽"[^>]*hidden>/);
  assert.match(html, /<a id="home-link"[^>]*aria-label="回到專案清單"/);
  for (const id of ["input", "send", "attach", "modal-search", "reconnect-button"]) {
    const m = html.match(new RegExp(`id="${id}"[^>]*>`));
    assert.ok(m, id);
    assert.match(m[0], /aria-label="[^"]+"/, id);
  }
});
