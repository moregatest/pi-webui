import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldResumeStoredSession } from "../dist/server/session-guard.js";

// 共用:一個落在 session 目錄內的 session 檔 + 對應目錄。
const SESSION_DIR = "/ws/.pi/sessions";
const IN_DIR = "/ws/.pi/sessions/1700000000_abc.jsonl";
const OUT_DIR = "/other/.pi/sessions/1700000000_abc.jsonl";

// 便於各測試只覆寫關心的欄位。
function input(overrides = {}) {
  return {
    requestedSessionFile: IN_DIR,
    sessionFileExists: true,
    sessionCwd: "/ws",
    resolvedSessionDir: SESSION_DIR,
    sandboxEnabled: false,
    sandboxWorkspaceRoot: null,
    ...overrides,
  };
}

// ---- 沒帶 session 檔 ----

test("shouldResumeStoredSession: 沒帶 sessionFile → no-session-file / 不 resume", () => {
  for (const v of [null, undefined, ""]) {
    const d = shouldResumeStoredSession(input({ requestedSessionFile: v }));
    assert.deepEqual(d, { resume: false, reason: "no-session-file" });
  }
});

// ---- 非 sandbox:只看 session 目錄範圍 ----

test("shouldResumeStoredSession: 非 sandbox + 檔在 session 目錄內 → ok / resume", () => {
  const d = shouldResumeStoredSession(input({ requestedSessionFile: IN_DIR }));
  assert.deepEqual(d, { resume: true, reason: "ok" });
});

test("shouldResumeStoredSession: 非 sandbox + 檔在 session 目錄外 → outside-session-dir", () => {
  const d = shouldResumeStoredSession(input({ requestedSessionFile: OUT_DIR }));
  assert.deepEqual(d, { resume: false, reason: "outside-session-dir" });
});

// ---- sandbox:跨 workspace 一律拒絕 ----

test("shouldResumeStoredSession: sandbox + sessionCwd 不等於 workspaceRoot → sandbox-cross-workspace", () => {
  const d = shouldResumeStoredSession(
    input({
      sandboxEnabled: true,
      sandboxWorkspaceRoot: "/ws",
      sessionCwd: "/other-ws",
    }),
  );
  assert.deepEqual(d, { resume: false, reason: "sandbox-cross-workspace" });
});

test("shouldResumeStoredSession: sandbox + sessionCwd 等於 workspaceRoot + 在目錄內 → ok", () => {
  const d = shouldResumeStoredSession(
    input({
      sandboxEnabled: true,
      sandboxWorkspaceRoot: "/ws",
      sessionCwd: "/ws",
      requestedSessionFile: IN_DIR,
    }),
  );
  assert.deepEqual(d, { resume: true, reason: "ok" });
});

test("shouldResumeStoredSession: sandboxEnabled 但 workspaceRoot=null → 略過 sandbox 檢查,落到目錄判定", () => {
  const d = shouldResumeStoredSession(
    input({ sandboxEnabled: true, sandboxWorkspaceRoot: null, requestedSessionFile: OUT_DIR }),
  );
  assert.deepEqual(d, { resume: false, reason: "outside-session-dir" });
});

// ---- #5 修正:missing 檔一律不 resume(期望1) ----
// stale/missing session 檔(client localStorage 指向已 rm / 換過 session-dir 的舊檔)
// 若 resume,switchSession 會把 cwd fallback 到 process.cwd()(server 啟動目錄),
// sandbox 下 bash 全回 "Path outside workspace"。故 sessionFileExists=false 一律擋,
// 不管是否 sandbox、路徑是否在目錄內。

test("shouldResumeStoredSession: [#5] missing 檔(sessionFileExists=false) → missing-file / 不 resume(非 sandbox)", () => {
  const d = shouldResumeStoredSession(
    input({ sessionFileExists: false, sessionCwd: null, requestedSessionFile: IN_DIR }),
  );
  assert.deepEqual(d, { resume: false, reason: "missing-file" });
});

test("shouldResumeStoredSession: [#5] missing 檔 + sandbox → missing-file(先於 sandbox 判定)", () => {
  const d = shouldResumeStoredSession(
    input({
      sessionFileExists: false,
      sandboxEnabled: true,
      sandboxWorkspaceRoot: "/ws",
      sessionCwd: null,
      requestedSessionFile: IN_DIR,
    }),
  );
  assert.deepEqual(d, { resume: false, reason: "missing-file" });
});

// ---- #5 期望3:sandbox 下 sessionCwd 讀不到(檔在但 header 壞/無 cwd)也拒絕 ----
// sandbox 無法確認 session 屬於 mount 的 workspace 就不 resume,避免 cwd 誤落 workspace 外。
test("shouldResumeStoredSession: [#5] sandbox + 檔存在但 sessionCwd=null → sandbox-unverifiable-cwd", () => {
  const d = shouldResumeStoredSession(
    input({
      sessionFileExists: true,
      sandboxEnabled: true,
      sandboxWorkspaceRoot: "/ws",
      sessionCwd: null,
      requestedSessionFile: IN_DIR,
    }),
  );
  assert.deepEqual(d, { resume: false, reason: "sandbox-unverifiable-cwd" });
});

// 非 sandbox + 檔存在但 sessionCwd=null:無 workspace 限制,落到目錄判定(檔在目錄內 → ok,
// cwd 由 caller fallback 到 appCwd)。
test("shouldResumeStoredSession: 非 sandbox + 檔存在 + sessionCwd=null + 在目錄內 → ok", () => {
  const d = shouldResumeStoredSession(
    input({ sessionFileExists: true, sessionCwd: null, requestedSessionFile: IN_DIR }),
  );
  assert.deepEqual(d, { resume: true, reason: "ok" });
});
