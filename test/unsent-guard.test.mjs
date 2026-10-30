import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideSubmit,
  createUnsentTracker,
  saveDraft,
  takeDraft,
  UNSENT_NOTICE,
  RECONNECTED_NOTICE,
  UNSENT_DRAFT_KEY,
} from "../public/unsent-guard.mjs";

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

test("連線中送出:send", () => {
  assert.equal(decideSubmit({ socketOpen: true, hasContent: true }), "send");
});

test("斷線時送出:擋下,不送", () => {
  assert.equal(decideSubmit({ socketOpen: false, hasContent: true }), "blocked_disconnected");
});

test("空內容:empty 優先於斷線(不顯示未送達提示)", () => {
  assert.equal(decideSubmit({ socketOpen: false, hasContent: false }), "empty");
});

test("擋下後回傳明確的未送出提示", () => {
  const t = createUnsentTracker();
  const notice = t.markBlocked();
  assert.equal(notice, UNSENT_NOTICE);
  assert.match(notice, /尚未送出/);
  assert.equal(t.pending, true);
});

test("重連後只提醒、不自動重送:tracker 不持有訊息內容", () => {
  const t = createUnsentTracker();
  t.markBlocked();
  const notice = t.onReconnect();
  assert.equal(notice, RECONNECTED_NOTICE);
  assert.match(notice, /自行按送出/);
  // 結構保證:tracker 沒有任何可拿來重送的訊息內容或 resend 方法
  assert.equal(typeof t.resend, "undefined");
  assert.ok(!Object.values(t).some((v) => typeof v === "string"));
  // 提醒後仍維持 pending,直到使用者自己送出
  assert.equal(t.pending, true);
});

test("沒有被擋下的訊息時,重連不提示", () => {
  const t = createUnsentTracker();
  assert.equal(t.onReconnect(), null);
});

test("使用者自行送出後解除提醒", () => {
  const t = createUnsentTracker();
  t.markBlocked();
  t.clear();
  assert.equal(t.pending, false);
  assert.equal(t.onReconnect(), null);
});

test("草稿:reload 前存、載入後取出一次即清除", () => {
  const s = memStorage();
  saveDraft(s, "確認發布");
  assert.equal(s._map.get(UNSENT_DRAFT_KEY), "確認發布");
  assert.equal(takeDraft(s), "確認發布");
  assert.equal(takeDraft(s), "");
});

test("草稿:空白內容不存,並清掉舊草稿", () => {
  const s = memStorage();
  saveDraft(s, "舊的");
  saveDraft(s, "   ");
  assert.equal(takeDraft(s), "");
});

test("草稿:storage 例外或不存在時不炸", () => {
  const broken = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.doesNotThrow(() => saveDraft(broken, "x"));
  assert.equal(takeDraft(broken), "");
  assert.equal(takeDraft(undefined), "");
});
