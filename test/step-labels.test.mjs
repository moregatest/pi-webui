// W13-01 補充第 4 項:唯讀查詢不可被標成「發布網站」「修改內容」「執行操作」
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeStep } from "../dist/server/turn-progress.js";

const cat = (name, args) => describeStep(name, args).category;

test("publish_confirmed check_only → 查看發布狀態;真的發布仍是 發布網站", () => {
  assert.equal(cat("publish_confirmed", { check_only: true }), "查看發布狀態");
  assert.equal(cat("publish_confirmed", { check_only: false, confirmation_id: "x" }), "發布網站");
  assert.equal(cat("publish_confirmed", {}), "發布網站");
  // 字串 "true" 不算唯讀(工具本身只認布林),避免標籤說唯讀但實際發布
  assert.equal(cat("publish_confirmed", { check_only: "true" }), "發布網站");
});

test("publication_status → 查看發布狀態", () => {
  assert.equal(cat("publication_status", {}), "查看發布狀態");
});

test("heredoc 內文的 > 不算寫檔(python 比較運算)", () => {
  const cmd = "python3 - <<'EOF'\nimport urllib.request\nfor u in urls:\n    if len(u) > 0:\n        print(u)\nEOF";
  assert.equal(cat("bash", { command: cmd }), "處理資料");
  const cmd2 = "cat <<EOF\n<a href=x>link</a>\nEOF";
  assert.equal(cat("bash", { command: cmd2 }), "查看資料");
});

test("heredoc 寫進檔案仍是 修改內容", () => {
  assert.equal(cat("bash", { command: "cat > site.html <<'EOF'\n<p>x</p>\nEOF" }), "修改內容");
});

test("唯讀小指令(echo/printenv/pwd/test/which/date/wc/stat/file)→ 查看資料", () => {
  for (const c of ["echo $PI_PREVIEW_PUBLIC_URL", "printenv PI_PREVIEW_PUBLIC_URL", "pwd", "which readyai", "date", "wc -l a.txt", "stat a", "file a.png"]) {
    assert.equal(cat("bash", { command: c }), "查看資料", c);
  }
  // echo 導向到檔案仍是寫入
  assert.equal(cat("bash", { command: "echo hi > a.txt" }), "修改內容");
});

test("cd <dir> && <指令> 依後段指令分類", () => {
  assert.equal(cat("bash", { command: "cd /site && curl -sI https://www.example.com/" }), "查詢網站");
  assert.equal(cat("bash", { command: "cd /site && cat index.html" }), "查看資料");
  assert.equal(cat("bash", { command: "cd /site && sed -i s/a/b/ x.html" }), "修改內容");
  assert.equal(cat("bash", { command: "cd /site && rm -rf old" }), "修改內容");
});
