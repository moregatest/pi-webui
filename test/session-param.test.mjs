// ?session=<id> 直達:id 驗證與「id → session 檔名」對應的純函式(server 與 client 兩份)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidSessionIdParam, pickSessionFileName, readSessionHeaderId } from "../dist/server/session-param.js";
import { readSessionParam } from "../public/session-param.mjs";

const UUID = "019a1b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b";

test("isValidSessionIdParam: uuid / 英數 / 中間含 - _ → 合法", () => {
  assert.equal(isValidSessionIdParam(UUID), true);
  assert.equal(isValidSessionIdParam("abc"), true);
  assert.equal(isValidSessionIdParam("a_b-c9"), true);
  assert.equal(isValidSessionIdParam("A"), true);
});

test("isValidSessionIdParam: 路徑穿越、分隔字元、點、空白、控制字元一律不合法", () => {
  for (const bad of [
    "", " ", "..", "../x", "a/b", "a\\b", "/abs", ".hidden", "a.b", "a..b",
    "-lead", "trail-", "_x", "x_", "a b", "a\nb", "a\0b", "a%2Fb", "%2e%2e",
    "中文", "a:b", "*", "a?b",
  ]) {
    assert.equal(isValidSessionIdParam(bad), false, `應拒絕 ${JSON.stringify(bad)}`);
  }
});

test("isValidSessionIdParam: 非字串、過長一律不合法", () => {
  assert.equal(isValidSessionIdParam(null), false);
  assert.equal(isValidSessionIdParam(undefined), false);
  assert.equal(isValidSessionIdParam(123), false);
  assert.equal(isValidSessionIdParam(["abc"]), false);
  assert.equal(isValidSessionIdParam("a".repeat(128)), true);
  assert.equal(isValidSessionIdParam("a".repeat(129)), false);
});

test("pickSessionFileName: 只認 <時間>_<id>.jsonl,取時間最新的一個", () => {
  const names = [
    `2026-11-20T01-00-00-000Z_${UUID}.jsonl`,
    `2026-11-21T01-00-00-000Z_${UUID}.jsonl`,
    `2026-11-22T01-00-00-000Z_other.jsonl`,
    "notes.txt",
  ];
  assert.equal(pickSessionFileName(names, UUID), `2026-11-21T01-00-00-000Z_${UUID}.jsonl`);
});

test("pickSessionFileName: 後綴相同但 id 不同(xabc vs abc)不可誤配", () => {
  assert.equal(pickSessionFileName(["t_xabc.jsonl", "t_abc.jsonl.bak", "abc.jsonl.tmp"], "abc"), null);
  assert.equal(pickSessionFileName(["t_xabc.jsonl", "t_abc.jsonl"], "abc"), "t_abc.jsonl");
});

test("pickSessionFileName: 也接受 <id>.jsonl(無時間前綴)", () => {
  assert.equal(pickSessionFileName([`${UUID}.jsonl`], UUID), `${UUID}.jsonl`);
});

test("pickSessionFileName: 不合法 id 一律 null(不碰檔名比對)", () => {
  assert.equal(pickSessionFileName(["t_...jsonl", "..jsonl"], ".."), null);
  assert.equal(pickSessionFileName(["t_a/b.jsonl"], "a/b"), null);
});

test("pickSessionFileName: 含路徑分隔的檔名不採用", () => {
  assert.equal(pickSessionFileName([`sub/t_${UUID}.jsonl`], UUID), null);
});

test("readSessionParam(client): 取 ?session= 且驗證格式", () => {
  assert.equal(readSessionParam(`?session=${UUID}`), UUID);
  assert.equal(readSessionParam(`?embed=1&session=${UUID}`), UUID);
  assert.equal(readSessionParam(""), null);
  assert.equal(readSessionParam("?session="), null);
  assert.equal(readSessionParam("?session=..%2Fx"), null);
  assert.equal(readSessionParam("?session=a.b"), null);
  assert.equal(readSessionParam(undefined), null);
});

// RV32-02 低-1:後綴碰撞(另一段 id 以 _<id> 結尾)不可擋住真正的檔;<id>.jsonl 不可蓋過較新的帶時間檔。
test("pickSessionFileName: 後綴碰撞時,依標頭比對略過他人的檔,挑到真正的檔", () => {
  const names = ["2025-01-01T00-00-00-000Z_abc.jsonl", "2026-01-01T00-00-00-000Z_x_abc.jsonl"];
  const headerIds = { "2025-01-01T00-00-00-000Z_abc.jsonl": "abc", "2026-01-01T00-00-00-000Z_x_abc.jsonl": "x_abc" };
  assert.equal(pickSessionFileName(names, "abc", (n) => headerIds[n] === "abc"), "2025-01-01T00-00-00-000Z_abc.jsonl");
});

test("pickSessionFileName: 帶時間的檔優先於 <id>.jsonl,且取最新", () => {
  const names = ["abc.jsonl", "2025-01-01T00-00-00-000Z_abc.jsonl", "2026-01-01T00-00-00-000Z_abc.jsonl"];
  assert.equal(pickSessionFileName(names, "abc"), "2026-01-01T00-00-00-000Z_abc.jsonl");
  // 最新的那個標頭不符時,退到下一個
  assert.equal(pickSessionFileName(names, "abc", (n) => n !== "2026-01-01T00-00-00-000Z_abc.jsonl"),
    "2025-01-01T00-00-00-000Z_abc.jsonl");
  // 全部不符 → null
  assert.equal(pickSessionFileName(names, "abc", () => false), null);
});

// RV32-02 低-2:讀標頭只讀檔案開頭,不整檔讀入。
test("readSessionHeaderId: 只讀開頭;標頭正常、後面很大也能讀到 id", () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-hdr-"));
  try {
    const f = join(dir, "s.jsonl");
    writeFileSync(f, JSON.stringify({ type: "session", id: "abc" }) + "\n" + "x".repeat(300_000) + "\n");
    assert.equal(readSessionHeaderId(f), "abc");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readSessionHeaderId: 第一行超過讀取上限 → null(不往後讀);非 session、不存在 → null", () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-hdr-"));
  try {
    const big = join(dir, "big.jsonl");
    writeFileSync(big, JSON.stringify({ type: "session", id: "abc", pad: "y".repeat(2000) }) + "\n");
    assert.equal(readSessionHeaderId(big, 1024), null);
    assert.equal(readSessionHeaderId(big, 4096), "abc");
    const noNl = join(dir, "nonl.jsonl");
    writeFileSync(noNl, JSON.stringify({ type: "session", id: "abc" }));
    assert.equal(readSessionHeaderId(noNl), "abc");
    const msg = join(dir, "msg.jsonl");
    writeFileSync(msg, JSON.stringify({ type: "message", id: "abc" }) + "\n");
    assert.equal(readSessionHeaderId(msg), null);
    assert.equal(readSessionHeaderId(join(dir, "missing.jsonl")), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
