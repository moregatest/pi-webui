import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { loadBrandCss } from "../dist/server/brand-overlay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures", "brand");

test("loadBrandCss null 路徑回 null", () => {
  assert.equal(loadBrandCss(null), null);
});

test("loadBrandCss 讀 fixture css 回 buffer 並含內容", () => {
  const buf = loadBrandCss(path.join(FIXTURES, "theme.css"));
  assert.ok(buf instanceof Buffer);
  assert.match(buf.toString("utf8"), /--accent: #0066cc/);
});

test("loadBrandCss 不存在路徑 throw", () => {
  assert.throws(
    () => loadBrandCss(path.join(FIXTURES, "nope.css")),
    /not found/,
  );
});

test("loadBrandCss 目錄路徑 throw not a regular file", () => {
  assert.throws(
    () => loadBrandCss(FIXTURES),
    /not a regular file/,
  );
});

test("loadBrandCss > 100KB throw", (t) => {
  // 動態生成 huge.css 避免 repo 膨脹
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-brand-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const huge = path.join(tmp, "huge.css");
  fs.writeFileSync(huge, Buffer.alloc(150 * 1024, 0x20));
  assert.throws(
    () => loadBrandCss(huge),
    /> 100KB|size/,
  );
});
