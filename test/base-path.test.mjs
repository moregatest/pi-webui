import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBasePath, stripBasePrefix } from "../dist/server/base-path.js";

test("normalizeBasePath: 空 / root → ''", () => {
  assert.equal(normalizeBasePath(undefined), "");
  assert.equal(normalizeBasePath(null), "");
  assert.equal(normalizeBasePath(""), "");
  assert.equal(normalizeBasePath("/"), "");
});

test("normalizeBasePath: 單段 → /webui", () => {
  assert.equal(normalizeBasePath("/webui"), "/webui");
  assert.equal(normalizeBasePath("webui"), "/webui");
  assert.equal(normalizeBasePath("/webui/"), "/webui");
  assert.equal(normalizeBasePath("//webui//"), "/webui");
});

test("normalizeBasePath: 巢狀 → /foo/bar", () => {
  assert.equal(normalizeBasePath("/foo/bar"), "/foo/bar");
  assert.equal(normalizeBasePath("foo/bar/"), "/foo/bar");
  assert.equal(normalizeBasePath("/foo/bar/"), "/foo/bar");
  assert.equal(normalizeBasePath("//foo//bar//"), "/foo/bar");
});

test("stripBasePrefix: base '' 原樣（no-op）", () => {
  assert.equal(stripBasePrefix("/", ""), "/");
  assert.equal(stripBasePrefix("/ws", ""), "/ws");
  assert.equal(stripBasePrefix("/api/login", ""), "/api/login");
});

test("stripBasePrefix: 單段 base /webui", () => {
  assert.equal(stripBasePrefix("/webui", "/webui"), "/");
  assert.equal(stripBasePrefix("/webui/", "/webui"), "/");
  assert.equal(stripBasePrefix("/webui/x", "/webui"), "/x");
  assert.equal(stripBasePrefix("/webui/api/login", "/webui"), "/api/login");
  assert.equal(stripBasePrefix("/webuixyz", "/webui"), "/webuixyz"); // 不匹配原樣
});

test("stripBasePrefix: 巢狀 base /foo/bar", () => {
  assert.equal(stripBasePrefix("/foo/bar", "/foo/bar"), "/");
  assert.equal(stripBasePrefix("/foo/bar/x", "/foo/bar"), "/x");
  assert.equal(stripBasePrefix("/foo/barxyz", "/foo/bar"), "/foo/barxyz"); // 不匹配原樣
});
