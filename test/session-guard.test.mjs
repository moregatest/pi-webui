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

// ---- #5 已知洞(characterization,非期望行為)----
// sandbox 下 client 帶 stale/missing session 檔時 readSessionCwdSync 回 null,
// 使「跨 workspace」檢查因 `sessionCwd &&` 短路而被跳過;只要 stale 檔路徑仍落在
// session 目錄內(例:rm 掉 <ws>/.pi/sessions/*.jsonl 後路徑前綴仍在該目錄),就會
// resume=true → switchSession(missing) → cwd 掉回 process.cwd()(見 GitHub issue #5)。
// 這裡固定「現況」以防意外變動;#5 修正後(resume 前補 existsSync gate)應改為 false。
test("shouldResumeStoredSession: [#5 現況] sandbox + sessionCwd=null(missing 檔)+ 路徑在目錄內 → 目前仍 resume=true", () => {
  const d = shouldResumeStoredSession(
    input({
      sandboxEnabled: true,
      sandboxWorkspaceRoot: "/ws",
      sessionCwd: null,
      requestedSessionFile: IN_DIR,
    }),
  );
  assert.deepEqual(d, { resume: true, reason: "ok" });
});
