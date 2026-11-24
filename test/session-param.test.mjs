// ?session=<id> 直達:id 驗證與「id → session 檔名」對應的純函式(server 與 client 兩份)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidSessionIdParam, pickSessionFileName } from "../dist/server/session-param.js";
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
