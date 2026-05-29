// upload-config 純單元測試:預設清單、CLI/env/profile 合併、subdir 規則、
// sanitizeFilename / buildStoredFilename 行為。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ALLOWED_EXTENSIONS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  resolveUploadConfig,
  extractExtension,
  buildStoredFilename,
  sanitizeFilename,
} from "../dist/server/upload-config.js";

test("預設清單包含使用者要求的副檔名", () => {
  const cfg = resolveUploadConfig({ env: {} });
  const must = ["jpg", "jpeg", "png", "gif", "svg", "pdf", "rar", "zip", "flv", "txt", "doc", "docx", "xls", "xlsx", "dwg"];
  for (const ext of must) {
    assert.ok(cfg.allowedExtensions.has(ext), `預設清單應含 ${ext}`);
  }
});

test("預設值 max_bytes / max_files / subdir", () => {
  const cfg = resolveUploadConfig({ env: {} });
  assert.equal(cfg.maxBytes, DEFAULT_MAX_BYTES);
  assert.equal(cfg.maxFiles, DEFAULT_MAX_FILES);
  assert.equal(cfg.subdir, "default");
  assert.equal(DEFAULT_ALLOWED_EXTENSIONS.length, 15);
});

test("profileName 帶入時 subdir 採 profile 名", () => {
  const cfg = resolveUploadConfig({ env: {}, profileName: "staff" });
  assert.equal(cfg.subdir, "staff");
});

test("--upload-subdir 覆寫 profileName", () => {
  const cfg = resolveUploadConfig({
    env: {},
    profileName: "staff",
    cliSubdir: "field-team",
  });
  assert.equal(cfg.subdir, "field-team");
});

test("env PI_WEBUI_UPLOAD_SUBDIR 覆寫 profileName,但被 CLI 蓋過", () => {
  const env = { PI_WEBUI_UPLOAD_SUBDIR: "from-env" };
  let cfg = resolveUploadConfig({ env, profileName: "staff" });
  assert.equal(cfg.subdir, "from-env");
  cfg = resolveUploadConfig({ env, profileName: "staff", cliSubdir: "from-cli" });
  assert.equal(cfg.subdir, "from-cli");
});

test("subdir 非法字元 throw", () => {
  assert.throws(
    () => resolveUploadConfig({ env: {}, cliSubdir: "../escape" }),
    /子目錄名稱/,
  );
  assert.throws(
    () => resolveUploadConfig({ env: {}, profile: { subdir: "has space" } }),
    /子目錄名稱/,
  );
});

test("--upload-ext 完全取代預設清單", () => {
  const cfg = resolveUploadConfig({
    env: {},
    cliExt: "csv,json",
  });
  assert.equal(cfg.allowedExtensions.size, 2);
  assert.ok(cfg.allowedExtensions.has("csv"));
  assert.ok(cfg.allowedExtensions.has("json"));
  assert.ok(!cfg.allowedExtensions.has("pdf"));
});

test("--upload-ext-add 在現有清單上追加", () => {
  const cfg = resolveUploadConfig({
    env: {},
    cliExtAdd: "csv,json,pdf", // pdf 本就有不重複加
  });
  assert.ok(cfg.allowedExtensions.has("csv"));
  assert.ok(cfg.allowedExtensions.has("json"));
  assert.ok(cfg.allowedExtensions.has("pdf"));
  assert.ok(cfg.allowedExtensions.has("dwg")); // 預設仍在
});

test("profile [uploads].allowed_extensions 取代,CLI --upload-ext 再蓋", () => {
  const cfg = resolveUploadConfig({
    env: {},
    profile: { allowed_extensions: ["doc", "docx"] },
    cliExt: "csv",
  });
  // CLI 蓋掉 profile,只剩 csv
  assert.deepEqual([...cfg.allowedExtensions].sort(), ["csv"]);
});

test("profile + CLI add 累加", () => {
  const cfg = resolveUploadConfig({
    env: {},
    profile: { extensions_add: ["csv"] },
    cliExtAdd: "json",
  });
  assert.ok(cfg.allowedExtensions.has("csv"));
  assert.ok(cfg.allowedExtensions.has("json"));
  assert.ok(cfg.allowedExtensions.has("pdf"));
});

test("副檔名輸入有 . 與大小寫 都被 normalize", () => {
  const cfg = resolveUploadConfig({ env: {}, cliExt: ".PDF,.Csv, JSON " });
  assert.deepEqual([...cfg.allowedExtensions].sort(), ["csv", "json", "pdf"]);
});

test("不合法副檔名 throw", () => {
  assert.throws(
    () => resolveUploadConfig({ env: {}, cliExt: "csv,/etc/passwd" }),
    /不合法的副檔名/,
  );
});

test("max_bytes / max_files 預設與覆寫", () => {
  let cfg = resolveUploadConfig({ env: {}, cliMaxBytes: 1234, cliMaxFiles: 5 });
  assert.equal(cfg.maxBytes, 1234);
  assert.equal(cfg.maxFiles, 5);
  // env 蓋 profile,CLI 蓋 env
  cfg = resolveUploadConfig({
    env: { PI_WEBUI_UPLOAD_MAX_BYTES: "999", PI_WEBUI_UPLOAD_MAX_FILES: "7" },
    profile: { max_bytes: 111, max_files: 2 },
  });
  assert.equal(cfg.maxBytes, 999);
  assert.equal(cfg.maxFiles, 7);
});

test("max_bytes 非正整數 throw", () => {
  assert.throws(
    () => resolveUploadConfig({ env: {}, cliMaxBytes: -1 }),
    /必須是正整數/,
  );
  assert.throws(
    () => resolveUploadConfig({ env: { PI_WEBUI_UPLOAD_MAX_FILES: "abc" } }),
    /必須是正整數/,
  );
});

test("extractExtension 行為", () => {
  assert.equal(extractExtension("report.pdf"), "pdf");
  assert.equal(extractExtension("REPORT.PDF"), "pdf");
  assert.equal(extractExtension("a.b.tar.gz"), "gz");
  assert.equal(extractExtension("noext"), "");
  assert.equal(extractExtension("trailing."), "");
  assert.equal(extractExtension(""), "");
  assert.equal(extractExtension(".hidden"), "hidden");
});

test("buildStoredFilename 加 timestamp 後綴並保留副檔名", () => {
  const stored = buildStoredFilename("report.pdf", new Date("2026-05-29T15:30:45.127Z"));
  assert.ok(stored.endsWith(".pdf"));
  assert.match(stored, /^report-\d{8}-\d{6}-\d{3}\.pdf$/);
});

test("buildStoredFilename 無副檔名也能寫", () => {
  const stored = buildStoredFilename("plain", new Date("2026-05-29T00:00:00Z"));
  assert.match(stored, /^plain-\d{8}-\d{6}-\d{3}$/);
});

test("sanitizeFilename 拆掉路徑與危險字元", () => {
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("C:\\Users\\admin\\file.txt"), "file.txt");
  assert.equal(sanitizeFilename(""), "file");
  assert.equal(sanitizeFilename("..."), "file"); // 三個點全被縮成 . 再拿掉開頭點
  assert.equal(sanitizeFilename("中文 報告.pdf"), "中文_報告.pdf");
});

test("sanitizeFilename 200 字元上限,保留副檔名", () => {
  const long = "a".repeat(500) + ".pdf";
  const out = sanitizeFilename(long);
  assert.ok(out.length <= 200);
  assert.ok(out.endsWith(".pdf"));
});

test("allowed_extensions 全空 throw", () => {
  assert.throws(
    () => resolveUploadConfig({ env: {}, cliExt: " , , " }),
    /不可為空/,
  );
});
