// F12（W41）真 SDK 整合：證明「agent_end 監聽當下送 followUp」會在同一個 run 內接著跑更正，
// 且更正只發生一次。模型用本機 openai-completions mock（同 hide-thinking-e2e 的注入方式）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Type } from "typebox";
import { createAgentSession, defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import { createPromiseGuard, PROMISE_GUARD_CUSTOM_TYPE } from "../dist/server/promise-guard.js";

const PROMISE = "發布已送出。等驗收完成，我會回報結果給您。";
const CORRECTION = "更正：我沒辦法主動通知您，驗收結果請您之後回來問我「發布好了沒」。";

function startMock(replies) {
  const bodies = [];
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        bodies.push(raw);
        const reply = replies[Math.min(bodies.length - 1, replies.length - 1)];
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({
          id: "c", object: "chat.completion.chunk", model: "probe-model", choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`;
        if (reply.tool) {
          res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function",
            function: { name: reply.tool, arguments: "{}" } }] }));
          res.write(chunk({}, "tool_calls"));
        } else {
          res.write(chunk({ role: "assistant", content: reply.text }));
          res.write(chunk({}, "stop"));
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, bodies, baseUrl: `http://127.0.0.1:${srv.address().port}/v1` }));
  });
}

async function run(replies) {
  const mock = await startMock(replies);
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "webui-promise-guard-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "webui-promise-guard-cwd-"));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { probe: {
    baseUrl: mock.baseUrl, apiKey: "sk-probe", api: "openai-completions",
    models: [{ id: "probe-model", name: "Probe", contextWindow: 8000, maxTokens: 512 }] } } }));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "probe", defaultModel: "probe-model", retry: { enabled: false },
  }));
  const publishTool = defineTool({
    name: "publish_confirmed", label: "觸發發布", description: "test", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "{\"ok\":true,\"status\":\"triggered\"}" }], details: {} }; },
  });
  const { session } = await createAgentSession({
    cwd, agentDir, sessionManager: SessionManager.inMemory(), noTools: "builtin",
    customTools: [publishTool], tools: ["publish_confirmed"],
  });
  const logs = [];
  const guard = createPromiseGuard({ getSession: () => session, log: { warn: (m, f) => logs.push([m, f]) } });
  session.subscribe((event) => { if (event.type === "agent_end") guard.onAgentEnd(event); });
  try {
    await session.prompt("確認發布");
    const texts = session.messages.filter(m => m.role === "assistant")
      .flatMap(m => m.content.filter(p => p.type === "text").map(p => p.text));
    return { session, texts, logs, bodies: mock.bodies };
  } finally {
    session.dispose?.();
    mock.srv.close();
  }
}

test("SDK：發布後承諾 → 同一輪內自動追加更正，客戶看到的最後一句是更正", async () => {
  const { session, texts, logs, bodies } = await run([{ tool: "publish_confirmed" }, { text: PROMISE }, { text: CORRECTION }]);
  assert.deepEqual(texts, [PROMISE, CORRECTION]);
  assert.equal(bodies.length, 3);
  assert.match(bodies[2], /系統更正指示/);
  const guardMsgs = session.messages.filter(m => m.role === "custom" && m.customType === PROMISE_GUARD_CUSTOM_TYPE);
  assert.equal(guardMsgs.length, 1);
  assert.equal(guardMsgs[0].display, false);
  assert.deepEqual(logs.map(l => l[0]), ["promise guard correction"]);
  assert.equal(session.isStreaming, false);
});

test("SDK：更正後又承諾 → 不再追加（不無限迴圈），只記 log", async () => {
  const { texts, logs, bodies } = await run([{ tool: "publish_confirmed" }, { text: PROMISE }, { text: "好的，我之後會通知您。" }]);
  assert.equal(bodies.length, 3);
  assert.equal(texts.length, 2);
  assert.deepEqual(logs.map(l => l[0]), ["promise guard correction", "promise guard repeat"]);
});

test("SDK：沒有承諾 → 不追加任何回合", async () => {
  const { texts, logs, bodies } = await run([{ tool: "publish_confirmed" }, { text: "發布已送出，完成後您問我就能看到結果。" }]);
  assert.equal(bodies.length, 2);
  assert.equal(texts.length, 1);
  assert.deepEqual(logs, []);
});
