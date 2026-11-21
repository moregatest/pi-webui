// W14-01:輸入框控制器(public/composer-input.mjs)的整段事件序列測試。
// F1:點建議句一律送成對話,不沿用命令模式、不覆寫草稿與附件。
// F5:keydown 與 beforeinput 共用同一份狀態(slash 選單、組字、229、已處理、修飾鍵)。
import { test } from "node:test";
import assert from "node:assert/strict";

import { createComposerController } from "../public/composer-input.mjs";

// 建一個控制器與記錄器;menu 物件模擬 slash 選單是否開啟。
function setup({ enterSends = true, running = false } = {}) {
  const calls = { submit: 0, applySlash: 0, bashMode: [] };
  const menu = { open: false };
  const ctl = createComposerController({
    getEnterSends: () => enterSends,
    isRunning: () => running,
    isSlashMenuOpen: () => menu.open,
    applySlash: () => { calls.applySlash++; menu.open = false; },
    submit: () => { calls.submit++; },
    onBashModeChange: (on) => calls.bashMode.push(on),
  });
  return { ctl, calls, menu };
}

const kd = (o = {}) => ({ key: "Enter", keyCode: 13, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...o });
const bi = (o = {}) => ({ inputType: "insertLineBreak", isComposing: false, ...o });

//
// F1:建議句
//

test("F1 整合:先按 ! 進命令模式,再點建議句 → 退出命令模式並送成對話(不是 bash)", () => {
  const { ctl, calls } = setup();
  // 空輸入框按 !:進入命令模式、不放入字元
  assert.equal(ctl.keydown(kd({ key: "!", keyCode: 49 }), ""), true);
  assert.equal(ctl.bashMode, true);
  // 點建議句(合法自訂句也可能長得像命令)
  const pick = ctl.pickStarter({ text: "echo safe", draft: "", hasAttachments: false });
  assert.equal(pick.action, "send");
  assert.equal(pick.value, "echo safe");
  assert.equal(ctl.bashMode, false, "點建議句前必須退出命令模式");
  assert.deepEqual(calls.bashMode, [true, false]);
  // 接著走正常送出流程:路由必須是對話
  const route = ctl.routeSubmit({ message: pick.value, hasAttachments: false });
  assert.equal(route.kind, "prompt");
  assert.equal(route.message, "echo safe");
});

test("F1:建議句送出時強制當對話,即使文字以 / 或 ! 開頭也不走命令", () => {
  const { ctl } = setup();
  for (const text of ["/new", "!ls"]) {
    const pick = ctl.pickStarter({ text, draft: "", hasAttachments: false });
    assert.equal(pick.action, "send");
    assert.equal(ctl.routeSubmit({ message: text, hasAttachments: false }).kind, "prompt", text);
  }
});

test("F1:強制對話只作用一次,下一次一般送出照常路由", () => {
  const { ctl } = setup();
  ctl.pickStarter({ text: "你好", draft: "", hasAttachments: false });
  assert.equal(ctl.routeSubmit({ message: "你好", hasAttachments: false }).kind, "prompt");
  assert.equal(ctl.routeSubmit({ message: "!ls", hasAttachments: false }).kind, "bash");
});

test("F1:有未送出的草稿時,點建議句只接在草稿後面、不送出、不覆寫", () => {
  const { ctl } = setup();
  const pick = ctl.pickStarter({ text: "幫我看首頁", draft: "我想改電話", hasAttachments: false });
  assert.equal(pick.action, "fill");
  assert.equal(pick.value, "我想改電話\n幫我看首頁");
});

test("F1:有附件(沒有文字)時,點建議句只填入、不自動送出", () => {
  const { ctl } = setup();
  const pick = ctl.pickStarter({ text: "幫我看首頁", draft: "  ", hasAttachments: true });
  assert.equal(pick.action, "fill");
  assert.equal(pick.value, "幫我看首頁");
  // 填入不會留下強制對話旗標以外的副作用;使用者自己按送出時帶附件就是一般對話
  assert.equal(ctl.routeSubmit({ message: pick.value, hasAttachments: true }).kind, "prompt");
});

test("F1:命令模式且有草稿時點建議句 → 退出命令模式、只填入不送出", () => {
  const { ctl } = setup();
  ctl.keydown(kd({ key: "!", keyCode: 49 }), "");
  const pick = ctl.pickStarter({ text: "幫我看首頁", draft: "ls", hasAttachments: false });
  assert.equal(pick.action, "fill");
  assert.equal(ctl.bashMode, false);
});

test("F1:執行中點建議句一律忽略", () => {
  const { ctl } = setup({ running: true });
  assert.equal(ctl.pickStarter({ text: "你好", draft: "", hasAttachments: false }).action, "ignore");
});

//
// F5:keydown 與 beforeinput 共用狀態
//

test("F5:組字結束 → 229 keydown → 換行 beforeinput,不送出", () => {
  const { ctl, calls } = setup();
  ctl.compositionStart();
  ctl.compositionEnd();
  assert.equal(ctl.keydown(kd({ keyCode: 229, key: "Enter" }), "你好"), false);
  assert.equal(ctl.beforeInput(bi()), false);
  assert.equal(calls.submit, 0);
});

test("F5:組字結束後(沒有 keydown)直接來換行 beforeinput,也不送出", () => {
  const { ctl, calls } = setup();
  ctl.compositionStart();
  ctl.compositionEnd();
  assert.equal(ctl.beforeInput(bi()), false);
  assert.equal(calls.submit, 0);
});

test("F5:slash 選單開啟時的 beforeinput 不送出,改成完成選項", () => {
  const { ctl, calls, menu } = setup();
  menu.open = true;
  assert.equal(ctl.beforeInput(bi()), true, "要攔下換行");
  assert.equal(calls.submit, 0);
  assert.equal(calls.applySlash, 1);
});

test("F5:slash 選單開啟時桌機 Enter 也只完成選項(不論 enter_sends)", () => {
  for (const enterSends of [true, false]) {
    const { ctl, calls, menu } = setup({ enterSends });
    menu.open = true;
    assert.equal(ctl.keydown(kd(), "/ne"), true);
    assert.equal(calls.applySlash, 1);
    assert.equal(calls.submit, 0);
  }
});

test("F5:一般手機換行 beforeinput(keydown 是 229 Unidentified)送出一次且只一次", () => {
  const { ctl, calls } = setup();
  assert.equal(ctl.keydown(kd({ key: "Unidentified", keyCode: 229 }), "你好"), false);
  assert.equal(ctl.beforeInput(bi()), true);
  assert.equal(calls.submit, 1);
  // 同一次按鍵若又來一個換行 beforeinput,不可再送
  assert.equal(ctl.beforeInput(bi({ inputType: "insertParagraph" })), true);
  assert.equal(calls.submit, 1);
});

test("F5:完全沒有 keydown 的手機換行 beforeinput 仍送出(保留手機送出支援)", () => {
  const { ctl, calls } = setup();
  assert.equal(ctl.beforeInput(bi()), true);
  assert.equal(calls.submit, 1);
});

test("F5:桌機 Enter keydown 已送出,之後同次按鍵的 beforeinput 不再送", () => {
  const { ctl, calls } = setup();
  assert.equal(ctl.keydown(kd(), "你好"), true);
  assert.equal(calls.submit, 1);
  assert.equal(ctl.beforeInput(bi()), true);
  assert.equal(calls.submit, 1);
});

test("F5:Alt/Ctrl/Meta/Shift+Enter 的 beforeinput 交給瀏覽器換行", () => {
  for (const m of ["shiftKey", "altKey", "ctrlKey", "metaKey"]) {
    const { ctl, calls } = setup();
    assert.equal(ctl.keydown(kd({ [m]: true }), "你好"), false, m);
    assert.equal(ctl.beforeInput(bi()), false, m);
    assert.equal(calls.submit, 0, m);
  }
});

test("F5:組字中(isComposing)的 beforeinput 不送出", () => {
  const { ctl, calls } = setup();
  ctl.compositionStart();
  assert.equal(ctl.beforeInput(bi({ isComposing: true })), false);
  assert.equal(calls.submit, 0);
});

test("F5:組字結束後再打一般字,之後的手機換行仍可送出", () => {
  const { ctl, calls } = setup();
  ctl.compositionStart();
  ctl.compositionEnd();
  ctl.keydown(kd({ key: "a", keyCode: 65 }), "你好a");
  ctl.beforeInput(bi({ inputType: "insertText" }));
  ctl.keydown(kd({ key: "Unidentified", keyCode: 229 }), "你好a");
  assert.equal(ctl.beforeInput(bi()), true);
  assert.equal(calls.submit, 1);
});

test("F5:功能關閉(enter_sends=false)時 keydown/beforeinput 都不送出", () => {
  const { ctl, calls } = setup({ enterSends: false });
  assert.equal(ctl.keydown(kd(), "你好"), false);
  assert.equal(ctl.beforeInput(bi()), false);
  assert.equal(calls.submit, 0);
});

test("F5:執行中按 Enter 不送出(不可變成停止)", () => {
  const { ctl, calls } = setup({ running: true });
  assert.equal(ctl.keydown(kd(), "你好"), true, "仍攔下換行");
  assert.equal(ctl.beforeInput(bi()), true);
  assert.equal(calls.submit, 0);
});

test("命令模式:空輸入框 Backspace 退出命令模式", () => {
  const { ctl } = setup();
  ctl.keydown(kd({ key: "!", keyCode: 49 }), "");
  assert.equal(ctl.keydown(kd({ key: "Backspace", keyCode: 8 }), ""), true);
  assert.equal(ctl.bashMode, false);
});

test("命令模式:輸入框有字時按 ! 不切換", () => {
  const { ctl } = setup();
  assert.equal(ctl.keydown(kd({ key: "!", keyCode: 49 }), "a"), false);
  assert.equal(ctl.bashMode, false);
});

test("routeSubmit:命令模式送出 bash 後退出命令模式", () => {
  const { ctl } = setup();
  ctl.keydown(kd({ key: "!", keyCode: 49 }), "");
  const r = ctl.routeSubmit({ message: "ls", hasAttachments: false });
  assert.equal(r.kind, "bash");
  assert.equal(ctl.bashMode, false);
});

test("F1:送出流程開頭取出強制旗標後,routeSubmit 仍照該旗標送成對話", () => {
  const { ctl } = setup();
  ctl.keydown(kd({ key: "!", keyCode: 49 }), "");
  const pick = ctl.pickStarter({ text: "echo safe", draft: "", hasAttachments: false });
  const force = ctl.takeForcePrompt();
  assert.equal(force, true);
  assert.equal(ctl.takeForcePrompt(), false, "只取一次");
  assert.equal(ctl.routeSubmit({ message: pick.value, force }).kind, "prompt");
});
