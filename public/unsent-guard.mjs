// 斷線時送出的處理(readyai#163)。
//
// 原則:斷線期間按送出,訊息一律不送、輸入框保留,並明確告知「尚未送出」;
// 重新連線後只提醒,由使用者自己決定是否再按送出。**絕不自動重送**——
// 「確認發布」這類有副作用的訊息若在使用者不知情下補送,可能意外觸發發布。

export const UNSENT_NOTICE =
  "連線中斷，訊息尚未送出。內容已保留在輸入框，恢復連線後請確認再按送出。";
export const RECONNECTED_NOTICE =
  "已重新連線。剛才的訊息尚未送出，仍保留在輸入框，請確認後自行按送出。";

// 重新連線按鈕會 reload 頁面;草稿暫存在 sessionStorage,載入後還原。
export const UNSENT_DRAFT_KEY = "pi-webui:unsent-draft";

// 送出前判斷。socketOpen=false(CLOSED / CONNECTING / CLOSING)一律擋下。
export function decideSubmit({ socketOpen, hasContent }) {
  if (!hasContent) return "empty";
  if (!socketOpen) return "blocked_disconnected";
  return "send";
}

// 追蹤「有一則被擋下的訊息還沒處理」。只決定要顯示哪段提示,不持有訊息內容、
// 不提供重送介面,從結構上排除自動重送。
export function createUnsentTracker() {
  let pending = false;
  return {
    // 斷線時按送出被擋下
    markBlocked() {
      pending = true;
      return UNSENT_NOTICE;
    },
    // 連線恢復:有被擋下的訊息才回傳提醒文字,否則 null
    onReconnect() {
      return pending ? RECONNECTED_NOTICE : null;
    },
    // 使用者成功送出或清空輸入框後解除
    clear() {
      pending = false;
    },
    get pending() {
      return pending;
    },
  };
}

// sessionStorage 可能被封鎖(隱私模式等),讀寫失敗一律當沒有草稿。
export function saveDraft(storage, text) {
  try {
    if (text && text.trim()) storage?.setItem(UNSENT_DRAFT_KEY, text);
    else storage?.removeItem(UNSENT_DRAFT_KEY);
  } catch {
    /* 忽略 */
  }
}

export function takeDraft(storage) {
  try {
    const text = storage?.getItem(UNSENT_DRAFT_KEY) || "";
    storage?.removeItem(UNSENT_DRAFT_KEY);
    return text;
  } catch {
    return "";
  }
}
