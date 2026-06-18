import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { resolveSessionDir, isWithinSessionDir } from "../dist/server/session-dir.js";

// ---- resolveSessionDir 優先序:CLI > env > 預設 ----

test("resolveSessionDir: 無 override 回 <cwd>/.pi/sessions", () => {
  assert.equal(
    resolveSessionDir("/home/u/proj"),
    join("/home/u/proj", ".pi", "sessions"),
  );
});

test("resolveSessionDir: env 覆寫預設(回 resolve(env))", () => {
  assert.equal(
    resolveSessionDir("/home/u/proj", { envSessionDir: "/var/sess" }),
    resolve("/var/sess"),
  );
});

test("resolveSessionDir: CLI 勝過 env", () => {
  assert.equal(
    resolveSessionDir("/home/u/proj", { cliSessionDir: "/cli/sess", envSessionDir: "/env/sess" }),
    resolve("/cli/sess"),
  );
});

test("resolveSessionDir: 相對 override 會被 resolve() 成絕對", () => {
  const out = resolveSessionDir("/home/u/proj", { cliSessionDir: "rel/sess" });
  assert.equal(out, resolve("rel/sess"));
  assert.ok(out.startsWith("/"), "should be absolute");
});

test("resolveSessionDir: 空字串/空白 override 視為未設,回預設", () => {
  assert.equal(
    resolveSessionDir("/home/u/proj", { cliSessionDir: "  ", envSessionDir: "" }),
    join("/home/u/proj", ".pi", "sessions"),
  );
});

// ---- isWithinSessionDir:reconnect guard 判定 ----

test("isWithinSessionDir: 同目錄的 session 檔回 true", () => {
  assert.equal(
    isWithinSessionDir("/home/u/proj/.pi/sessions/123_abc.jsonl", "/home/u/proj/.pi/sessions"),
    true,
  );
});

test("isWithinSessionDir: home 舊目錄的 session 不在專案目錄回 false", () => {
  assert.equal(
    isWithinSessionDir("/home/u/.pi/agent/sessions/enc/123_abc.jsonl", "/home/u/proj/.pi/sessions"),
    false,
  );
});

test("isWithinSessionDir: 巢狀子目錄(非直接父)回 false", () => {
  assert.equal(
    isWithinSessionDir("/home/u/proj/.pi/sessions/sub/123_abc.jsonl", "/home/u/proj/.pi/sessions"),
    false,
  );
});

test("isWithinSessionDir: 相對/含 .. 路徑經 resolve() 後正確比對", () => {
  assert.equal(
    isWithinSessionDir("/home/u/proj/.pi/sessions/../sessions/123.jsonl", "/home/u/proj/.pi/sessions"),
    true,
  );
});
