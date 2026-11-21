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

//
// W14-01 F4:保守原則——只有能證明是單純讀取的單一指令才標「查看資料」
//

test("F4 審查反例:複合指令後段有寫入 → 修改內容", () => {
  assert.equal(cat("bash", { command: "echo ready && rm site.html" }), "修改內容");
  assert.equal(cat("bash", { command: "printf x | tee site.html" }), "修改內容");
});

test("F4 審查反例:未加引號 heredoc 內的命令替換不可標查看", () => {
  const c = cat("bash", { command: "cat <<EOF\n$(touch site.html)\nEOF" });
  assert.notEqual(c, "查看資料");
  assert.equal(c, "執行操作");
  assert.equal(cat("bash", { command: "cat <<EOF\n`touch site.html`\nEOF" }), "執行操作");
});

test("F4 審查反例:引號內的 <<EOF 不是 heredoc,後面的 rm 是另一行指令 → 修改內容", () => {
  assert.equal(cat("bash", { command: "echo '<<EOF'\nrm site.html\nEOF" }), "修改內容");
  assert.equal(cat("bash", { command: 'echo "<<EOF"\nrm site.html\nEOF' }), "修改內容");
});

test("F4:加引號的 heredoc 內文不展開,$( ) 只是文字 → 依外層指令分類", () => {
  assert.equal(cat("bash", { command: "cat <<'EOF'\n$(touch site.html)\nEOF" }), "查看資料");
});

test("F4:解析不了的 heredoc(找不到結束標記)不可標查看", () => {
  assert.equal(cat("bash", { command: "cat <<EOF\nhello" }), "執行操作");
});

test("F4:複合的唯讀指令也不標查看(無法證明單純讀取)", () => {
  for (const c of ["cat a.txt | grep x", "ls; pwd", "echo a && echo b", "ls || true", "cat a &", "echo a\necho b"]) {
    assert.equal(cat("bash", { command: c }), "執行操作", c);
  }
});

test("F4:命令替換、行程替換不標查看", () => {
  for (const c of ["echo $(rm site.html)", 'echo "$(rm site.html)"', "echo `rm site.html`", "cat <(rm x)", "wc -l $(ls)"]) {
    assert.equal(cat("bash", { command: c }), "執行操作", c);
  }
  // 單引號內的 $( ) 只是文字
  assert.equal(cat("bash", { command: "echo '$(rm site.html)'" }), "查看資料");
});

test("F4:帶會改狀態參數的唯讀動詞不標查看(date -s、date 設時、sed w、file -C)", () => {
  for (const c of ["date -s 2020-01-01", "date --set=2020-01-01", "date 010112002020", "sed -n 'w out.txt' a.txt", "sed -n '1p;w out' a.txt", "file -C -m magic"]) {
    assert.notEqual(cat("bash", { command: c }), "查看資料", c);
  }
  for (const c of ["date", "date +%Y-%m-%d", "date -u", "date -u +%s", "sed -n '1,80p' a.txt", "sed -n '/x/p' a.txt"]) {
    assert.equal(cat("bash", { command: c }), "查看資料", c);
  }
});

test("F4:導向到 /dev/null、標準串流的單一唯讀指令仍是查看", () => {
  for (const c of ["printf x >/dev/null", "cat a.txt 2>/dev/null", "cat a.txt 2>&1", "echo x >> /dev/null", "echo x > '/dev/null'", "echo 'x > out.txt'"]) {
    assert.equal(cat("bash", { command: c }), "查看資料", c);
  }
});
