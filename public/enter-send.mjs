// Enter 送出判斷(profile [ui].enter_sends)。純函式,app.js 負責接事件。
//
// 桌機:keydown 的 Enter 直接判斷;Shift+Enter 交給瀏覽器換行。
// 輸入法組字:isComposing、keyCode 229(Safari 在 compositionend 之後才送 keydown)、
//   以及 compositionstart/end 自行記錄的旗標,任一成立都不送出。
// 手機虛擬鍵盤:部分 Android 鍵盤的 keydown 一律是 keyCode 229 / key "Unidentified",
//   拿不到 Enter;改由 beforeinput 的 insertLineBreak / insertParagraph 判斷。

export function decideEnterKey({ enterSends, key, keyCode, shiftKey, altKey, ctrlKey, metaKey, isComposing, composing }) {
  if (!enterSends || key !== "Enter") return "default";
  if (shiftKey || altKey || ctrlKey || metaKey) return "default";
  if (isComposing || composing || keyCode === 229) return "default";
  return "submit";
}

export function decideBeforeInput({ enterSends, inputType, isComposing, composing, shiftEnter }) {
  if (!enterSends) return "default";
  if (inputType !== "insertLineBreak" && inputType !== "insertParagraph") return "default";
  if (isComposing || composing || shiftEnter) return "default";
  return "submit";
}
