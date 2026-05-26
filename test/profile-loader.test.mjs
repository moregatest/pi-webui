// profile-loader 純單元測試:讀 toml + schema 驗證
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadProfile } from "../dist/server/profile-loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures", "profiles");

// 把 fixtures/profiles/staff.toml 對應的 cwd 算出來(./.pi/profiles/ 結構)
// loadProfile(name, cwd) 預期讀 <cwd>/.pi/profiles/<name>.toml
// 我們在 fixtures 下建一層 .pi/profiles -> ../<name>.toml 的 symlink 太麻煩;
// 改寫 cwd 為一個 tmp dir,複製 fixture 進去。
import fs from "node:fs";
import os from "node:os";

function makeCwdWithProfile(name, fixtureFile) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES, fixtureFile),
    path.join(profilesDir, `${name}.toml`),
  );
  return tmp;
}

test("loadProfile name=customer 檔不存在回內建 fallback", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const profile = loadProfile("customer", tmp);

  // 內建 fallback 對齊既有 --ui-profile customer 解析結果
  assert.equal(profile.ui?.hide_thinking, true);
  assert.equal(profile.ui?.hide_tool_calls, true);
  assert.equal(profile.ui?.show_tool_progress, true);
  assert.equal(profile.ui?.hide_status_chips, true);
  assert.equal(profile.ui?.hide_session_picker, true);
  assert.equal(profile.ui?.hide_model, true);
  assert.equal(profile.ui?.safe_errors, true);
  assert.equal(profile.ui?.expose_tool_args, false);
});

test("loadProfile name=staff 檔不存在 throw", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  assert.throws(
    () => loadProfile("staff", tmp),
    /profile not found/,
  );
});

test("loadProfile 讀 staff fixture 並解析欄位", (t) => {
  const cwd = makeCwdWithProfile("staff", "staff.toml");
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const profile = loadProfile("staff", cwd);

  assert.equal(profile.meta?.description, "fixture staff profile");
  assert.equal(profile.ui?.hide_thinking, true);
  assert.equal(profile.ui?.hide_status_chips, false);
  assert.equal(profile.brand?.name, "Fixture Staff");
  assert.deepEqual(profile.skills?.allow, ["brainstorming"]);
  assert.deepEqual(profile.commands?.allow, ["new", "quit", "help"]);
  assert.equal(profile.defaults?.model, "anthropic/claude-opus-4-7");
});

test("loadProfile [brand].mode 非 dark/light → throw", (t) => {
  const cwd = makeCwdWithProfile("broken", "broken-mode.toml");
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  assert.throws(
    () => loadProfile("broken", cwd),
    /\[brand\]\.mode/,
  );
});

test("loadProfile [brand].bg 不是 hex → throw", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "x.toml"),
    `[brand]\nbg = "not-hex"\n`,
  );
  assert.throws(() => loadProfile("x", tmp), /\[brand\]\.bg/);
});

test("loadProfile [brand].bg 合法 hex 短長兩種", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "a.toml"),
    `[brand]\nbg = "#fafafa"\naccent = "#06c"\n`,
  );
  const profile = loadProfile("a", tmp);
  assert.equal(profile.brand?.bg, "#fafafa");
  assert.equal(profile.brand?.accent, "#06c");
});

test("loadProfile [brand].logo 路徑不存在 → throw", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "x.toml"),
    `[brand]\nlogo = "./nope.svg"\n`,
  );
  assert.throws(() => loadProfile("x", tmp), /\[brand\]\.logo/);
});

test("loadProfile [brand].logo 路徑存在 OK", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURES, "..", "brand", "logo.svg"),
    path.join(tmp, "logo.svg"),
  );
  fs.writeFileSync(
    path.join(profilesDir, "a.toml"),
    `[brand]\nlogo = "./logo.svg"\n`,
  );
  const profile = loadProfile("a", tmp);
  assert.equal(profile.brand?.logo, "./logo.svg");
});

test("loadProfile [brand].color 自動 alias 到 accent", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "a.toml"),
    `[brand]\ncolor = "#06c"\n`,
  );
  const profile = loadProfile("a", tmp);
  assert.equal(profile.brand?.accent, "#06c");
});

test("loadProfile [brand].color + accent 同時設 → throw", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-webui-profile-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const profilesDir = path.join(tmp, ".pi", "profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "a.toml"),
    `[brand]\ncolor = "#06c"\naccent = "#fff"\n`,
  );
  assert.throws(() => loadProfile("a", tmp), /color.*accent|accent.*color/);
});
