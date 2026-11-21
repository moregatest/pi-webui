// 開場引導(welcome):profile [welcome] 驗證、uiProfile 解析、前端模組行為
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadProfile } from "../dist/server/profile-loader.js";
import { parseUiProfile } from "../dist/server/ui-profile.js";
import { normalizeWelcome, shouldShowWelcome, createWelcomeView } from "../public/welcome.mjs";

function cwdWithToml(t, name, toml) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "readyai-webui-welcome-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, ".pi", "profiles"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".pi", "profiles", `${name}.toml`), toml);
  return tmp;
}

const VALID = [
  `[welcome]`,
  `title = "這裡可以確認這次的網站修改"`,
  `body = "我是您的網站 AI 助理。"`,
  `starters = ["請告訴我這次改了什麼", "我想再調整一些地方", "內容沒問題，我同意上線"]`,
  ``,
].join("\n");

//
// profile-loader
//

test("loadProfile [welcome] 合法 → 原樣解析", (t) => {
  const p = loadProfile("customer", cwdWithToml(t, "customer", VALID));
  assert.equal(p.welcome.title, "這裡可以確認這次的網站修改");
  assert.equal(p.welcome.body, "我是您的網站 AI 助理。");
  assert.deepEqual(p.welcome.starters, ["請告訴我這次改了什麼", "我想再調整一些地方", "內容沒問題，我同意上線"]);
});

test("loadProfile 沒有 [welcome] → profile.welcome 為 undefined", (t) => {
  const p = loadProfile("staff", cwdWithToml(t, "staff", `[ui]\nhide_model = true\n`));
  assert.equal(p.welcome, undefined);
});

test("loadProfile [welcome] 未知欄位 → throw", (t) => {
  const cwd = cwdWithToml(t, "staff", `[welcome]\ntitle = "a"\nhtml = "<b>x</b>"\n`);
  assert.throws(() => loadProfile("staff", cwd), /unknown field \[welcome\]\.html/);
});

test("loadProfile [welcome] 型別錯誤 → throw", (t) => {
  for (const [toml, re] of [
    [`[welcome]\ntitle = 1\n`, /\[welcome\]\.title: 必須是字串/],
    [`[welcome]\nbody = true\n`, /\[welcome\]\.body: 必須是字串/],
    [`[welcome]\nstarters = "x"\n`, /\[welcome\]\.starters: 必須是字串陣列/],
    [`[welcome]\nstarters = [1]\n`, /\[welcome\]\.starters: 陣列項目必須是非空字串/],
    [`[welcome]\nstarters = ["  "]\n`, /\[welcome\]\.starters: 陣列項目必須是非空字串/],
  ]) {
    const cwd = cwdWithToml(t, "staff", toml);
    assert.throws(() => loadProfile("staff", cwd), re, toml);
  }
});

test("loadProfile [welcome] 超過長度/數量上限 → throw", (t) => {
  const long = (n) => "字".repeat(n);
  for (const [toml, re] of [
    [`[welcome]\ntitle = "${long(61)}"\n`, /\[welcome\]\.title: 上限 60 字/],
    [`[welcome]\nbody = "${long(401)}"\n`, /\[welcome\]\.body: 上限 400 字/],
    [`[welcome]\nstarters = ["${long(61)}"]\n`, /\[welcome\]\.starters: 每句上限 60 字/],
    [`[welcome]\nstarters = ["a","b","c","d","e","f","g"]\n`, /\[welcome\]\.starters: 最多 6 句/],
  ]) {
    const cwd = cwdWithToml(t, "staff", toml);
    assert.throws(() => loadProfile("staff", cwd), re);
  }
  // 剛好上限可以
  const ok = cwdWithToml(t, "customer", `[welcome]\ntitle = "${long(60)}"\nbody = "${long(400)}"\nstarters = ["${long(60)}"]\n`);
  assert.doesNotThrow(() => loadProfile("customer", ok));
});

test("loadProfile [welcome].starters 以 / 或 ! 開頭 → throw(點了會變指令)", (t) => {
  for (const s of ["/model", "!ls", " /x"]) {
    const cwd = cwdWithToml(t, "staff", `[welcome]\nstarters = ["${s}"]\n`);
    assert.throws(() => loadProfile("staff", cwd), /不可以 \/ 或 ! 開頭/, s);
  }
});

test("loadProfile [welcome] 標題與建議句不可換行", (t) => {
  const cwd1 = cwdWithToml(t, "staff", `[welcome]\ntitle = "a\\nb"\n`);
  assert.throws(() => loadProfile("staff", cwd1), /\[welcome\]\.title: 不可換行/);
  const cwd2 = cwdWithToml(t, "staff", `[welcome]\nstarters = ["a\\nb"]\n`);
  assert.throws(() => loadProfile("staff", cwd2), /\[welcome\]\.starters: 不可換行/);
  // body 可以換行
  const cwd3 = cwdWithToml(t, "staff", `[welcome]\nbody = "a\\nb"\n`);
  assert.doesNotThrow(() => loadProfile("staff", cwd3));
});

//
// parseUiProfile
//

test("parseUiProfile: 沒有 [welcome] → welcome 為 null", () => {
  assert.equal(parseUiProfile({}, {}).welcome, null);
  assert.equal(parseUiProfile({ uiProfile: "customer" }, {}).welcome, null);
});

test("parseUiProfile: [welcome] → 去頭尾空白後帶入", () => {
  const p = parseUiProfile({}, {}, { welcome: { title: " 標題 ", body: "說明", starters: [" 甲 ", "乙"] } });
  assert.deepEqual(p.welcome, { title: "標題", body: "說明", starters: ["甲", "乙"] });
});

test("parseUiProfile: [welcome] 全空 → null(畫面與沒設相同)", () => {
  assert.equal(parseUiProfile({}, {}, { welcome: {} }).welcome, null);
  assert.equal(parseUiProfile({}, {}, { welcome: { title: " ", starters: [] } }).welcome, null);
});

//
// 前端模組 public/welcome.mjs
//

test("normalizeWelcome: 非物件 / 全空 → null;多餘欄位丟掉、截斷保護", () => {
  assert.equal(normalizeWelcome(null), null);
  assert.equal(normalizeWelcome("x"), null);
  assert.equal(normalizeWelcome({ title: "", body: "", starters: [] }), null);
  const w = normalizeWelcome({ title: "T", body: "B", starters: ["a", 3, "", "b"], extra: 1 });
  assert.deepEqual(w, { title: "T", body: "B", starters: ["a", "b"] });
  const many = normalizeWelcome({ starters: ["1", "2", "3", "4", "5", "6", "7", "8"] });
  assert.equal(many.starters.length, 6);
});

test("shouldShowWelcome: 有設定、歷史已載入、沒有任何可見項目才顯示", () => {
  const w = { title: "T", body: "", starters: [] };
  assert.equal(shouldShowWelcome(w, { historyReady: true, visibleCount: 0 }), true);
  assert.equal(shouldShowWelcome(w, { historyReady: true, visibleCount: 1 }), false);
  assert.equal(shouldShowWelcome(w, { historyReady: false, visibleCount: 0 }), false);
  assert.equal(shouldShowWelcome(null, { historyReady: true, visibleCount: 0 }), false);
});

// 最小 DOM 替身:記錄 textContent、屬性與事件;沒有 innerHTML setter 以外的解析能力。
function fakeDocument() {
  const created = [];
  return {
    created,
    createElement(tag) {
      const el = {
        tag, children: [], attrs: {}, handlers: {}, className: "", textContent: "",
        set innerHTML(v) { throw new Error("welcome 不可使用 innerHTML"); },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        append(...nodes) { this.children.push(...nodes); },
        addEventListener(name, fn) { this.handlers[name] = fn; },
      };
      created.push(el);
      return el;
    },
  };
}

test("createWelcomeView: 純文字輸出,HTML 字串不會被解析", () => {
  const document = fakeDocument();
  const el = createWelcomeView({
    document,
    welcome: { title: "<b>標題</b>", body: "<img src=x onerror=alert(1)>", starters: ["<i>甲</i>"] },
    onPick() {},
  });
  const all = document.created;
  assert.ok(all.some((n) => n.textContent === "<b>標題</b>"));
  assert.ok(all.some((n) => n.textContent === "<img src=x onerror=alert(1)>"));
  assert.ok(all.some((n) => n.tag === "button" && n.textContent === "<i>甲</i>"));
  assert.equal(el.className, "welcome");
});

test("createWelcomeView: 點建議句 → onPick 收到該句;沒有 title/body/starters 的部分不建節點", () => {
  const document = fakeDocument();
  const picked = [];
  createWelcomeView({ document, welcome: { title: "", body: "", starters: ["甲", "乙"] }, onPick: (s) => picked.push(s) });
  const buttons = document.created.filter((n) => n.tag === "button");
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].attrs.type, "button");
  buttons[1].handlers.click();
  assert.deepEqual(picked, ["乙"]);
  assert.equal(document.created.filter((n) => n.tag === "h2" || n.tag === "p").length, 0);
});

//
// 登入頁文字(profile [login]);W13-01 補充第 1 項
//

test("loadProfile [login] 合法 → 原樣解析;parseUiProfile 帶入 login", (t) => {
  const toml = [
    `[login]`,
    `hint = "請輸入 LINE 訊息裡提供的密碼。"`,
    `password_placeholder = "密碼"`,
    `button = "登入"`,
    `error = "密碼不正確，請再試一次"`,
    ``,
  ].join("\n");
  const p = loadProfile("customer", cwdWithToml(t, "customer", toml));
  assert.equal(p.login.button, "登入");
  const ui = parseUiProfile({}, {}, p);
  assert.deepEqual(ui.login, {
    hint: "請輸入 LINE 訊息裡提供的密碼。",
    passwordPlaceholder: "密碼",
    button: "登入",
    error: "密碼不正確，請再試一次",
  });
});

test("parseUiProfile: 沒有 [login] → login 為 null", () => {
  assert.equal(parseUiProfile({}, {}).login, null);
  assert.equal(parseUiProfile({}, {}, { login: { hint: "  " } }).login, null);
});

test("loadProfile [login] 未知欄位 / 型別 / 長度 → throw", (t) => {
  const long = (n) => "字".repeat(n);
  for (const [toml, re] of [
    [`[login]\ntitle = "x"\n`, /unknown field \[login\]\.title/],
    [`[login]\nhint = 1\n`, /\[login\]\.hint: 必須是字串/],
    [`[login]\nhint = "${long(301)}"\n`, /\[login\]\.hint: 上限 300 字/],
    [`[login]\npassword_placeholder = "${long(41)}"\n`, /\[login\]\.password_placeholder: 上限 40 字/],
    [`[login]\nbutton = "${long(21)}"\n`, /\[login\]\.button: 上限 20 字/],
    [`[login]\nerror = "${long(81)}"\n`, /\[login\]\.error: 上限 80 字/],
    [`[login]\nbutton = "a\\nb"\n`, /\[login\]\.button: 不可換行/],
  ]) {
    const cwd = cwdWithToml(t, "staff", toml);
    assert.throws(() => loadProfile("staff", cwd), re, toml);
  }
});

test("login.html 只用 textContent / placeholder 屬性套用文字,不用 innerHTML", () => {
  const html = fs.readFileSync(new URL("../public/login.html", import.meta.url), "utf8");
  assert.match(html, /window\.__LOGIN__/);
  assert.doesNotMatch(html, /innerHTML/);
});
