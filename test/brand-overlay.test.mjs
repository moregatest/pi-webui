import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
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

test("loadBrandCss > 100KB throw", () => {
  assert.throws(
    () => loadBrandCss(path.join(FIXTURES, "huge.css")),
    /> 100KB|size/,
  );
});
