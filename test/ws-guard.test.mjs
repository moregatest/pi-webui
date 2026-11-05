// test/ws-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWsDeny, isDeniedWsMessage, resolveWsBashOperations, WS_CLIENT_TYPES } from "../dist/server/ws-guard.js";

test("parseWsDeny: 空字串 → 空集合", () => {
  assert.equal(parseWsDeny("").size, 0);
  assert.equal(parseWsDeny(undefined).size, 0);
});

test("parseWsDeny: 逗號或空白分隔、去除空白與重複", () => {
  const s = parseWsDeny(" bash, list_dir  cycle_model,bash ");
  assert.deepEqual([...s].sort(), ["bash", "cycle_model", "list_dir"]);
});

test("parseWsDeny: 未知型別直接丟錯（避免打錯字以為有擋）", () => {
  assert.throws(() => parseWsDeny("bash,lsit_dir"), /lsit_dir/);
});

test("parseWsDeny: 不允許擋 ready（連線無法初始化）", () => {
  assert.throws(() => parseWsDeny("ready"), /ready/);
});

test("WS_CLIENT_TYPES 涵蓋 dispatcher 會處理的型別", () => {
  for (const t of ["prompt", "abort", "bash", "list_dir", "cycle_model", "new_session", "switch_session", "set_session_name", "slash_command"]) {
    assert.ok(WS_CLIENT_TYPES.has(t), t);
  }
});

test("isDeniedWsMessage: 命中集合才擋", () => {
  const deny = parseWsDeny("bash,list_dir");
  assert.equal(isDeniedWsMessage({ type: "bash", command: "id" }, deny), true);
  assert.equal(isDeniedWsMessage({ type: "list_dir", path: "/" }, deny), true);
  assert.equal(isDeniedWsMessage({ type: "prompt", message: "hi" }, deny), false);
  assert.equal(isDeniedWsMessage(null, deny), false);
});

test("resolveWsBashOperations: 未啟用沙盒 → undefined（沿用 SDK 預設的宿主 shell）", () => {
  assert.equal(resolveWsBashOperations({ sandboxEnabled: false, sandbox: null, sandboxInitError: null }), undefined);
});

test("resolveWsBashOperations: 沙盒可用 → 回傳 VM 的 bash operations", () => {
  const ops = { exec: async () => ({ exitCode: 0 }) };
  const sandbox = { createBashOperations: () => ops };
  assert.equal(resolveWsBashOperations({ sandboxEnabled: true, sandbox, sandboxInitError: null }), ops);
});

test("resolveWsBashOperations: 要求沙盒但初始化失敗 → 丟錯，不退回宿主", () => {
  assert.throws(
    () => resolveWsBashOperations({ sandboxEnabled: true, sandbox: null, sandboxInitError: "qemu not found" }),
    /sandbox.*qemu not found/,
  );
});
