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
