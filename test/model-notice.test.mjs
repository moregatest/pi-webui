// test/model-notice.test.mjs
// issue #2 P1:模型在 registry 找不到時，server 靜默 fallback、UI 完全沒提示。
// modelNotFoundNotice 組出給使用者的提示；對外場景（hideModel）不得洩漏 model 名。
import { test } from "node:test";
import assert from "node:assert/strict";
import { modelNotFoundNotice } from "../dist/server/model-notice.js";

test("hideModel=false：訊息含 model pattern，方便 staff 排查", () => {
  const msg = modelNotFoundNotice("openrouter/foo-model", false);
  assert.match(msg, /openrouter\/foo-model/);
  assert.match(msg, /預設|回退/);
});

test("hideModel=true：訊息不得洩漏 model 名稱（對外場景商業資訊）", () => {
  const msg = modelNotFoundNotice("openrouter/secret-model", true);
  assert.doesNotMatch(msg, /openrouter\/secret-model/, "hideModel 下不可出現 model 名稱");
  assert.ok(msg.length > 0, "仍須給使用者一個非空提示");
});

test("pattern 未指定也不爆且回非空字串", () => {
  const msg = modelNotFoundNotice(undefined, false);
  assert.ok(typeof msg === "string" && msg.length > 0);
});
