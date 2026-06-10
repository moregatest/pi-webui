// sandbox-prompt 純單元測試:驗證 system prompt 內容含關鍵錨點訊息
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSandboxSystemPrompt } from "../dist/server/sandbox-prompt.js";

test("含 Gondolin / readyai-webui 身份字串(避免被誤認 Fly.io / Docker)", () => {
  const out = buildSandboxSystemPrompt({ workspaceRoot: "/Users/tung/foo" });
  assert.match(out, /readyai-webui sandbox/);
  assert.match(out, /Gondolin/);
  assert.match(out, /micro-VM/);
  assert.match(out, /不是.*Fly\.io/);
  assert.match(out, /不是.*Docker/);
});

test("含 workspaceRoot 對映訊息", () => {
  const out = buildSandboxSystemPrompt({ workspaceRoot: "/Users/tung/Codes/customer" });
  assert.match(out, /\/workspace.*\/Users\/tung\/Codes\/customer/);
});

test("有 image 時列出 image tag 與 /etc/profile.d 提示", () => {
  const out = buildSandboxSystemPrompt({
    workspaceRoot: "/tmp/ws",
    image: "readyai-sandbox:0.1.0-3.23.0-bba981",
  });
  assert.match(out, /readyai-sandbox:0\.1\.0-3\.23\.0-bba981/);
  assert.match(out, /\/etc\/profile\.d/);
});

test("沒 image 時提示走 gondolin 預設 alpine-base", () => {
  const out = buildSandboxSystemPrompt({ workspaceRoot: "/tmp/ws" });
  assert.match(out, /alpine-base/);
  assert.doesNotMatch(out, /readyai-sandbox/);
});

test("host-only 工作流警告(flyctl / ~/.readyai/)", () => {
  const out = buildSandboxSystemPrompt({ workspaceRoot: "/tmp/ws" });
  assert.match(out, /flyctl/);
  assert.match(out, /~\/\.readyai\//);
  assert.match(out, /command not found/);
});

test("extra 段附加在 built-in 後", () => {
  const out = buildSandboxSystemPrompt({
    workspaceRoot: "/tmp/ws",
    extra: "本部署只允許讀寫 /workspace/data 子目錄。",
  });
  assert.match(out, /本部署額外提示/);
  assert.match(out, /\/workspace\/data 子目錄/);
});

test("extra 為空字串時不出現「額外提示」 heading", () => {
  const out = buildSandboxSystemPrompt({ workspaceRoot: "/tmp/ws", extra: "   " });
  assert.doesNotMatch(out, /本部署額外提示/);
});

test("輸出是純 string,可直接接到 appendSystemPrompt array", () => {
  const out = buildSandboxSystemPrompt({ workspaceRoot: "/tmp/ws" });
  assert.equal(typeof out, "string");
  assert.ok(out.length > 100);
});
