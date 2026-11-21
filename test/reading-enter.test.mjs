// W13-02:客戶閱讀版面(reading_layout)、Enter 送出(enter_sends)、輸入框提示(input_placeholder)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadProfile } from "../dist/server/profile-loader.js";
import { parseUiProfile } from "../dist/server/ui-profile.js";
import { decideEnterKey, decideBeforeInput } from "../public/enter-send.mjs";
import { normalizeWelcome, welcomePlaceholder } from "../public/welcome.mjs";

function cwdWithToml(t, name, toml) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "readyai-webui-reading-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, ".pi", "profiles"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".pi", "profiles", `${name}.toml`), toml);
  return tmp;
}

//
// profile 驗證
//

test("[ui].reading_layout 只接受 default / comfortable", (t) => {
  for (const v of ["default", "comfortable"]) {
    const p = loadProfile("staff", cwdWithToml(t, "staff", `[ui]\nreading_layout = "${v}"\n`));
    assert.equal(p.ui.reading_layout, v);
  }
  const bad = cwdWithToml(t, "staff", `[ui]\nreading_layout = "wide"\n`);
  assert.throws(() => loadProfile("staff", bad), /\[ui\]\.reading_layout: 必須是 "default" 或 "comfortable"/);
});

test("[ui].enter_sends 必須是布林", (t) => {
  const ok = loadProfile("staff", cwdWithToml(t, "staff", `[ui]\nenter_sends = true\n`));
  assert.equal(ok.ui.enter_sends, true);
  const bad = cwdWithToml(t, "staff", `[ui]\nenter_sends = "yes"\n`);
  assert.throws(() => loadProfile("staff", bad), /\[ui\]\.enter_sends: 必須是 true 或 false/);
});

test("[welcome].input_placeholder 字串、單行、≤ 60 字", (t) => {
  const ok = loadProfile("staff", cwdWithToml(t, "staff", `[welcome]\ninput_placeholder = "輸入訊息，按 Enter 送出"\n`));
  assert.equal(ok.welcome.input_placeholder, "輸入訊息，按 Enter 送出");
  for (const [toml, re] of [
    [`[welcome]\ninput_placeholder = 1\n`, /\[welcome\]\.input_placeholder: 必須是字串/],
    [`[welcome]\ninput_placeholder = "a\\nb"\n`, /\[welcome\]\.input_placeholder: 不可換行/],
    [`[welcome]\ninput_placeholder = "${"字".repeat(61)}"\n`, /\[welcome\]\.input_placeholder: 上限 60 字/],
  ]) {
    assert.throws(() => loadProfile("staff", cwdWithToml(t, "staff", toml)), re);
  }
});

//
// parseUiProfile
//

test("parseUiProfile: 預設 readingLayout=default、enterSends=false(現行行為不變)", () => {
  const p = parseUiProfile({}, {});
  assert.equal(p.readingLayout, "default");
  assert.equal(p.enterSends, false);
  const c = parseUiProfile({ uiProfile: "customer" }, {});
  assert.equal(c.readingLayout, "default");
  assert.equal(c.enterSends, false);
});

test("parseUiProfile: profile 設定帶入", () => {
  const p = parseUiProfile({}, {}, { ui: { reading_layout: "comfortable", enter_sends: true } });
  assert.equal(p.readingLayout, "comfortable");
  assert.equal(p.enterSends, true);
});

test("parseUiProfile: 只設 input_placeholder 也帶入 welcome", () => {
  const p = parseUiProfile({}, {}, { welcome: { input_placeholder: " 請輸入 " } });
  assert.deepEqual(p.welcome, { title: "", body: "", starters: [], inputPlaceholder: "請輸入" });
  const q = parseUiProfile({}, {}, { welcome: { title: "T" } });
  assert.equal(q.welcome.inputPlaceholder, "");
});

//
// 前端:開場卡片與輸入框提示分開判斷
//

test("normalizeWelcome: 只有 input_placeholder 時沒有卡片;welcomePlaceholder 取得提示", () => {
  assert.equal(normalizeWelcome({ inputPlaceholder: "提示" }), null);
  assert.equal(welcomePlaceholder({ inputPlaceholder: " 提示 " }), "提示");
  assert.equal(welcomePlaceholder({ inputPlaceholder: "x".repeat(80) }).length, 60);
  assert.equal(welcomePlaceholder(null), "");
  assert.equal(welcomePlaceholder({ inputPlaceholder: 3 }), "");
});

//
// 前端:Enter 送出判斷
//

const key = (o) => ({ enterSends: true, key: "Enter", keyCode: 13, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, composing: false, ...o });

test("decideEnterKey: enter_sends 關閉 → 一律交給瀏覽器(換行)", () => {
  assert.equal(decideEnterKey(key({ enterSends: false })), "default");
});

test("decideEnterKey: Enter 送出;Shift+Enter 換行", () => {
  assert.equal(decideEnterKey(key({})), "submit");
  assert.equal(decideEnterKey(key({ shiftKey: true })), "default");
});

test("decideEnterKey: 輸入法組字中的 Enter 不送出(isComposing / keyCode 229 / composition 事件旗標)", () => {
  assert.equal(decideEnterKey(key({ isComposing: true })), "default");
  assert.equal(decideEnterKey(key({ keyCode: 229 })), "default");
  assert.equal(decideEnterKey(key({ composing: true })), "default");
});

test("decideEnterKey: 修飾鍵與其他鍵不送出", () => {
  for (const m of ["altKey", "ctrlKey", "metaKey"]) assert.equal(decideEnterKey(key({ [m]: true })), "default", m);
  assert.equal(decideEnterKey(key({ key: "a", keyCode: 65 })), "default");
});

const bi = (o) => ({ enterSends: true, inputType: "insertLineBreak", isComposing: false, composing: false, shiftEnter: false, ...o });

test("decideBeforeInput: 手機虛擬鍵盤(keydown 拿不到 Enter)靠 beforeinput 換行事件送出", () => {
  assert.equal(decideBeforeInput(bi({})), "submit");
  assert.equal(decideBeforeInput(bi({ inputType: "insertParagraph" })), "submit");
});

test("decideBeforeInput: Shift+Enter、組字中、一般輸入、功能關閉 → 不攔", () => {
  assert.equal(decideBeforeInput(bi({ shiftEnter: true })), "default");
  assert.equal(decideBeforeInput(bi({ isComposing: true })), "default");
  assert.equal(decideBeforeInput(bi({ composing: true })), "default");
  assert.equal(decideBeforeInput(bi({ inputType: "insertText" })), "default");
  assert.equal(decideBeforeInput(bi({ inputType: "insertCompositionText" })), "default");
  assert.equal(decideBeforeInput(bi({ enterSends: false })), "default");
});
