import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveLabel } from "../dist/server/tool-label.js";

const FAKE_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeProfile(overrides = {}) {
  return {
    exposeToolArgs: false,
    ...overrides,
    toolLabels: overrides.toolLabels || {},
  };
}

test("resolveLabel profile 內列出 tool/phase → 用 profile", () => {
  const profile = makeProfile({
    toolLabels: {
      read: { start: "正在讀取 nine9 資料", end: "讀取完成" },
    },
  });
  assert.equal(
    resolveLabel(profile, "read", "start", {}, FAKE_LOGGER),
    "正在讀取 nine9 資料",
  );
  assert.equal(
    resolveLabel(profile, "read", "end", {}, FAKE_LOGGER),
    "讀取完成",
  );
});

test("resolveLabel profile 未列 tool → 走 _default", () => {
  const profile = makeProfile({
    toolLabels: { _default: { start: "自訂 default", end: "" } },
  });
  assert.equal(
    resolveLabel(profile, "ReadFile", "start", {}, FAKE_LOGGER),
    "自訂 default",
  );
});

test("resolveLabel profile 未列 + 無 _default → built-in", () => {
  const profile = makeProfile();
  assert.equal(
    resolveLabel(profile, "ReadFile", "start", {}, FAKE_LOGGER),
    "正在處理...",
  );
  assert.equal(
    resolveLabel(profile, "ReadFile", "end", {}, FAKE_LOGGER),
    "",
  );
});

test("resolveLabel {file_basename} 解出 basename", () => {
  const profile = makeProfile({
    toolLabels: { read: { start: "正在讀 {file_basename}" } },
  });
  assert.equal(
    resolveLabel(profile, "read", "start", { file: "/path/to/foo.txt" }, FAKE_LOGGER),
    "正在讀 foo.txt",
  );
});

test("resolveLabel {url_host} 解出 hostname", () => {
  const profile = makeProfile({
    toolLabels: { WebFetch: { start: "抓 {url_host}" } },
  });
  assert.equal(
    resolveLabel(profile, "WebFetch", "start", { url: "https://nine9.com.tw/foo" }, FAKE_LOGGER),
    "抓 nine9.com.tw",
  );
});

test("resolveLabel {tool_arg.url} + expose_tool_args=false → 空字串", () => {
  const profile = makeProfile({
    toolLabels: { WebFetch: { start: "抓 {tool_arg.url}" } },
  });
  assert.equal(
    resolveLabel(profile, "WebFetch", "start", { url: "https://nine9.com.tw" }, FAKE_LOGGER),
    "抓 ",
  );
});

test("resolveLabel {tool_arg.url} + expose_tool_args=true → 帶入完整", () => {
  const profile = makeProfile({
    exposeToolArgs: true,
    toolLabels: { WebFetch: { start: "抓 {tool_arg.url}" } },
  });
  assert.equal(
    resolveLabel(profile, "WebFetch", "start", { url: "https://nine9.com.tw" }, FAKE_LOGGER),
    "抓 https://nine9.com.tw",
  );
});

test("resolveLabel runtime args 缺 placeholder 對應 → 空字串", () => {
  const profile = makeProfile({
    toolLabels: { read: { start: "讀 {file_basename}" } },
  });
  assert.equal(
    resolveLabel(profile, "read", "start", {}, FAKE_LOGGER),
    "讀 ",
  );
});

test("resolveLabel end label 空字串 pass through(client 自處理)", () => {
  const profile = makeProfile({
    toolLabels: { read: { end: "" } },
  });
  assert.equal(
    resolveLabel(profile, "read", "end", {}, FAKE_LOGGER),
    "",
  );
});

test("resolveLabel {progress_count} 從 progressContext 帶入", () => {
  const profile = makeProfile({
    toolLabels: { bash: { progress: "已掃 {progress_count} 項" } },
  });
  assert.equal(
    resolveLabel(profile, "bash", "progress", { progress_count: 42 }, FAKE_LOGGER),
    "已掃 42 項",
  );
});
