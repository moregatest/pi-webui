// 輸入框控制器:命令模式(!)、開場建議句、Enter 送出共用同一份狀態。
// 純邏輯、不碰 DOM,app.js 負責把事件轉進來並依回傳值 preventDefault。
//
// F1(建議句):點建議句一律當對話送出——先退出命令模式,送出時強制路由為對話;
//   輸入框已有草稿或附件時不覆寫也不送出,只把建議句接在草稿後面(換行分隔)。
// F5(Enter 送出):keydown 與 beforeinput 共用狀態——slash 選單是否開啟、組字中、
//   組字剛結束、keyCode 229、本次按鍵是否已處理、修飾鍵。
//   - slash 選單開啟時 Enter / 換行 beforeinput 一律先完成選項,不送出。
//   - 組字剛結束後的 Enter(Safari 會在 compositionend 後補一個 229 keydown)不送出。
//   - 沒有 Enter keydown 的手機換行 beforeinput 仍送出,且同一次按鍵只送一次。
import { routeInput } from "./route-input.mjs";
import { decideEnterKey } from "./enter-send.mjs";

const LINE_BREAK = new Set(["insertLineBreak", "insertParagraph"]);

export function createComposerController({
  getEnterSends = () => false,
  isRunning = () => false,
  isSlashMenuOpen = () => false,
  applySlash = () => {},
  submit = () => {},
  onBashModeChange = () => {},
} = {}) {
  let bashMode = false;
  let forcePrompt = false;
  let composing = false;
  // compositionend 之後、下一個 keydown/beforeinput 之前為 true。
  let imeJustCommitted = false;
  // 最近一次 keydown 的狀態,由緊接的 beforeinput 消耗。
  let pending = null;

  function setBashMode(on) {
    if (bashMode === on) return;
    bashMode = on;
    onBashModeChange(on);
  }

  function submitOnce() {
    // 執行中按 Enter 不可變成「停止」(送出鈕執行中是 abort),直接忽略。
    if (isRunning()) return;
    submit();
  }

  return {
    get bashMode() { return bashMode; },
    setBashMode,

    compositionStart() { composing = true; },
    compositionEnd() { composing = false; imeJustCommitted = true; },

    // 回傳 true 表示已處理、呼叫端要 preventDefault 並停止後續處理。
    keydown(event, value) {
      const justCommitted = imeJustCommitted;
      imeJustCommitted = false;
      const ime = !!event.isComposing || composing || event.keyCode === 229;
      pending = {
        ime,
        imeCommit: justCommitted && event.keyCode === 229,
        modifier: !!(event.shiftKey || event.altKey || event.ctrlKey || event.metaKey),
        handled: false,
      };
      if (event.key === "!" && value === "" && !event.isComposing) {
        setBashMode(!bashMode);
        return true;
      }
      if (event.key === "Backspace" && value === "" && bashMode) {
        setBashMode(false);
        return true;
      }
      if (event.key !== "Enter") return false;
      if (isSlashMenuOpen() && !event.isComposing && !composing) {
        // slash 選單開啟時 Enter 跟 Tab 一致:填入選項 + 關選單,不送出。
        pending.handled = true;
        applySlash();
        return true;
      }
      if (decideEnterKey({
        enterSends: !!getEnterSends(),
        key: event.key,
        keyCode: event.keyCode,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        isComposing: event.isComposing,
        composing,
      }) === "submit") {
        pending.handled = true;
        submitOnce();
        return true;
      }
      return false;
    },

    // 回傳 true 表示呼叫端要 preventDefault(不插入換行)。
    beforeInput(event) {
      const key = pending;
      pending = null;
      const justCommitted = imeJustCommitted;
      imeJustCommitted = false;
      if (!LINE_BREAK.has(event.inputType)) return false;
      // 同一次按鍵 keydown 已處理過(送出或完成選項):只攔換行,不再做任何事。
      if (key?.handled) return true;
      if (!getEnterSends()) return false;
      if (event.isComposing || composing) return false;
      if (justCommitted || key?.imeCommit) return false;
      if (key?.modifier) return false;
      if (isSlashMenuOpen()) {
        applySlash();
        // 同一次按鍵後續的換行事件也只攔不送。
        pending = { handled: true };
        return true;
      }
      submitOnce();
      pending = { handled: true };
      return true;
    },

    // 點開場建議句。draft:輸入框目前的文字;hasAttachments:是否已有附件。
    pickStarter({ text, draft = "", hasAttachments = false }) {
      if (isRunning()) return { action: "ignore" };
      setBashMode(false);
      const current = String(draft ?? "");
      if (current.trim() || hasAttachments) {
        return { action: "fill", value: current.trim() ? `${current.replace(/\s+$/, "")}\n${text}` : text };
      }
      forcePrompt = true;
      return { action: "send", value: text };
    },

    // 取出並清除「建議句強制對話」旗標;送出流程開頭就要呼叫,避免提早返回時殘留。
    takeForcePrompt() {
      const force = forcePrompt;
      forcePrompt = false;
      return force;
    },

    // 送出時決定路由;有附件時一律當對話(附件只能隨對話送出)。
    // force 未給時自行取出旗標。
    routeSubmit({ message, hasAttachments = false, force = this.takeForcePrompt() }) {
      if (hasAttachments) return { kind: "prompt", message: String(message ?? "").trim(), optimistic: true, setRunning: true };
      const route = routeInput({ message, bashMode, forcePrompt: force });
      if (route.kind === "bash") setBashMode(false);
      return route;
    },
  };
}
