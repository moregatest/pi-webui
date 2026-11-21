// W14-01 F3+F8:唯讀的預設 profile 目錄(PI_WEBUI_PROFILE_DEFAULTS_DIR)
// 查找順序:工作區 <cwd>/.pi/profiles/<name>.toml(站台自訂優先)→ 預設目錄 <name>.toml → 內建 fallback。
// 預設目錄的檔案:必須是一般檔、不跟隨符號連結。沒設這個變數時行為與現在完全相同。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadProfile, PROFILE_DEFAULTS_DIR_ENV } from "../dist/server/profile-loader.js";

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function workspace(t, files = {}) {
  const cwd = tmpDir(t, "readyai-webui-ws-");
  if (Object.keys(files).length) fs.mkdirSync(path.join(cwd, ".pi", "profiles"), { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(cwd, ".pi", "profiles", `${name}.toml`), body);
  return cwd;
}
function defaults(t, files = {}) {
  const dir = tmpDir(t, "readyai-webui-defaults-");
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${name}.toml`), body);
  return dir;
}
const DEFAULT_TOML = `[meta]\ndescription = "image default"\n[ui]\nhide_model = true\nenter_sends = true\n`;
const SITE_TOML = `[meta]\ndescription = "site custom"\n[ui]\nhide_model = true\n`;

test("能力旗標:匯出預設目錄環境變數名稱", () => {
  assert.equal(PROFILE_DEFAULTS_DIR_ENV, "PI_WEBUI_PROFILE_DEFAULTS_DIR");
});

test("工作區沒有 profile 時讀預設目錄", (t) => {
  const p = loadProfile("customer", workspace(t), { defaultsDir: defaults(t, { customer: DEFAULT_TOML }) });
  assert.equal(p.meta.description, "image default");
  assert.equal(p.ui.enter_sends, true);
});

test("F8:工作區已有自己的 profile 時優先(站台自訂不被覆蓋)", (t) => {
  const p = loadProfile("customer", workspace(t, { customer: SITE_TOML }), { defaultsDir: defaults(t, { customer: DEFAULT_TOML }) });
  assert.equal(p.meta.description, "site custom");
});

test("兩邊都沒有:customer 用內建 fallback,其他名稱照舊報找不到", (t) => {
  const dir = defaults(t);
  assert.equal(loadProfile("customer", workspace(t), { defaultsDir: dir }).meta.description, "built-in customer preset fallback");
  assert.throws(() => loadProfile("staff", workspace(t), { defaultsDir: dir }), /profile not found/);
});

test("沒設預設目錄時行為與現在完全相同(環境變數也沒設)", (t) => {
  const saved = process.env[PROFILE_DEFAULTS_DIR_ENV];
  delete process.env[PROFILE_DEFAULTS_DIR_ENV];
  t.after(() => { if (saved !== undefined) process.env[PROFILE_DEFAULTS_DIR_ENV] = saved; });
  assert.equal(loadProfile("customer", workspace(t)).meta.description, "built-in customer preset fallback");
  assert.equal(loadProfile("customer", workspace(t, { customer: SITE_TOML })).meta.description, "site custom");
  assert.equal(loadProfile("customer", workspace(t), {}).meta.description, "built-in customer preset fallback");
});

test("未傳 opts 時讀環境變數 PI_WEBUI_PROFILE_DEFAULTS_DIR", (t) => {
  const saved = process.env[PROFILE_DEFAULTS_DIR_ENV];
  process.env[PROFILE_DEFAULTS_DIR_ENV] = defaults(t, { customer: DEFAULT_TOML });
  t.after(() => { if (saved === undefined) delete process.env[PROFILE_DEFAULTS_DIR_ENV]; else process.env[PROFILE_DEFAULTS_DIR_ENV] = saved; });
  assert.equal(loadProfile("customer", workspace(t)).meta.description, "image default");
});

test("預設目錄的 profile 是符號連結 → 拒絕(不跟隨)", (t) => {
  const dir = defaults(t);
  const target = path.join(tmpDir(t, "readyai-webui-outside-"), "x.toml");
  fs.writeFileSync(target, DEFAULT_TOML);
  fs.symlinkSync(target, path.join(dir, "customer.toml"));
  assert.throws(() => loadProfile("customer", workspace(t), { defaultsDir: dir }), /不可是符號連結|symlink/);
});

test("預設目錄的 profile 不是一般檔(目錄)→ 拒絕", (t) => {
  const dir = defaults(t);
  fs.mkdirSync(path.join(dir, "customer.toml"));
  assert.throws(() => loadProfile("customer", workspace(t), { defaultsDir: dir }), /必須是一般檔/);
});

test("預設目錄必須是絕對路徑", (t) => {
  assert.throws(() => loadProfile("customer", workspace(t), { defaultsDir: "relative/dir" }), /必須是絕對路徑/);
});

test("profile 名稱含路徑字元時不到預設目錄找(避免跳出目錄)", (t) => {
  const dir = defaults(t);
  fs.writeFileSync(path.join(path.dirname(dir), "escape.toml"), DEFAULT_TOML);
  t.after(() => fs.rmSync(path.join(path.dirname(dir), "escape.toml"), { force: true }));
  const name = `../${path.basename(path.dirname(dir)) === "" ? "x" : "escape"}`;
  assert.throws(() => loadProfile(name, workspace(t), { defaultsDir: dir }), /profile 名稱/);
});

test("預設目錄的 profile 同樣經過 schema 驗證", (t) => {
  const dir = defaults(t, { customer: `[ui]\nenter_sends = "yes"\n` });
  assert.throws(() => loadProfile("customer", workspace(t), { defaultsDir: dir }), /enter_sends/);
});
