// test/customer-publish-tools.test.mjs
// PGC publish_confirmed 本地流程：origin 版本比對 → push-back → push-db，
// drift 時需客戶原因（force）。對應 spec 2026-08-18-pgc-preview-local-minimal-design §3。
import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCustomerPublishTools,
  runPublishFlow,
  sourceVersionMatches,
  parseOnboardOriginVersion,
  createLocalPublishDeps,
  buildOriginVersionUrl,
  buildPushBackArgs,
  buildPushDbArgs,
} from "../dist/tools/customer-publish-tools.js";

const SHA = "sha256:" + "ab".repeat(32);
const OTHER_SHA = "sha256:" + "cd".repeat(32);
const ORIGIN = { schema: "pgc-source-version-v1", source_lng: "en", content_sha256: SHA };
const RECORD = { source_lng: "en", content_sha256: SHA, recorded_at: "2026-08-18T10:00:00+08:00" };

function makeDeps(overrides = {}) {
  const calls = { fetch: 0, pushBack: [], pushDb: [] };
  const deps = {
    fetchOriginVersion: async () => {
      calls.fetch++;
      return ORIGIN;
    },
    readOnboardOriginVersion: async () => RECORD,
    pushBack: async (opts) => {
      calls.pushBack.push(opts);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    pushDb: async (opts) => {
      calls.pushDb.push(opts);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("runPublishFlow（核心決策邏輯）", () => {
  it("相符：觸發 push-back → push-db（無 force）", async () => {
    const { deps, calls } = makeDeps();
    const result = await runPublishFlow(deps, undefined);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.forced, false);
    assert.deepStrictEqual(calls.pushBack, [{ force: false }]);
    assert.deepStrictEqual(calls.pushDb, [{ force: false }]);
  });

  it("drift 且無原因：拒絕，不觸發 CLI", async () => {
    const { deps, calls } = makeDeps({
      readOnboardOriginVersion: async () => ({ ...RECORD, content_sha256: OTHER_SHA }),
    });
    const result = await runPublishFlow(deps, undefined);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.details.code, "drift_requires_reason");
    assert.strictEqual(result.details.current.content_sha256, SHA);
    assert.strictEqual(result.details.recorded.content_sha256, OTHER_SHA);
    assert.strictEqual(calls.pushBack.length, 0);
    assert.strictEqual(calls.pushDb.length, 0);
  });

  it("drift 且有原因：帶 --force --reason 觸發", async () => {
    const { deps, calls } = makeDeps({
      readOnboardOriginVersion: async () => ({ ...RECORD, content_sha256: OTHER_SHA }),
    });
    const result = await runPublishFlow(deps, "客戶要求立即上線");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.forced, true);
    assert.deepStrictEqual(calls.pushBack, [{ force: true, reason: "客戶要求立即上線" }]);
    assert.deepStrictEqual(calls.pushDb, [{ force: true, reason: "客戶要求立即上線" }]);
  });

  it("無記錄（null）：視為 drift，需原因", async () => {
    const { deps, calls } = makeDeps({ readOnboardOriginVersion: async () => null });
    const result = await runPublishFlow(deps, undefined);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.details.code, "drift_requires_reason");
    assert.strictEqual(result.details.recorded, null);
    assert.strictEqual(calls.pushBack.length, 0);
    assert.strictEqual(calls.pushDb.length, 0);
  });

  it("source_lng 不符：drift", async () => {
    const { deps } = makeDeps({
      readOnboardOriginVersion: async () => ({ ...RECORD, source_lng: "zh-TW" }),
    });
    const result = await runPublishFlow(deps, undefined);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.details.code, "drift_requires_reason");
  });

  it("origin 版本讀取失敗：拒絕", async () => {
    const { deps } = makeDeps({
      fetchOriginVersion: async () => { throw new Error("boom"); },
    });
    const result = await runPublishFlow(deps, undefined);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.details.code, "origin_version_error");
  });

  it("push-back 失敗：拒絕，不觸發 push-db", async () => {
    const { deps, calls } = makeDeps({
      pushBack: async () => ({ exitCode: 1, stdout: "", stderr: "fail" }),
    });
    const result = await runPublishFlow(deps, undefined);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.details.code, "push_back_failed");
    assert.strictEqual(calls.pushDb.length, 0);
  });

  it("push-db 失敗：拒絕", async () => {
    const { deps } = makeDeps({
      pushDb: async () => ({ exitCode: 1, stdout: "", stderr: "fail" }),
    });
    const result = await runPublishFlow(deps, undefined);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.details.code, "push_db_failed");
  });

  it("force_reason 超長：invalid_input，且不觸發 fetch", async () => {
    const { deps, calls } = makeDeps();
    const result = await runPublishFlow(deps, "x".repeat(600));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.details.code, "invalid_input");
    assert.strictEqual(calls.fetch, 0);
  });
});

describe("buildCustomerPublishTools（SDK 工具形狀）", () => {
  it("回傳 publish_confirmed SDK 工具，execute 以 content blocks 包裝結果", async () => {
    const { deps } = makeDeps();
    const tools = buildCustomerPublishTools(deps);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, "publish_confirmed");
    assert.ok(tools[0].label);

    const res = await tools[0].execute("id-1", { force_reason: undefined }, undefined, undefined, {});
    assert.ok(Array.isArray(res.content));
    assert.strictEqual(res.content[0].type, "text");
    const parsed = JSON.parse(res.content[0].text);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.forced, false);
    assert.deepStrictEqual(res.details, parsed);
  });

  it("drift 無原因 → execute 回傳 content 含 drift 錯誤", async () => {
    const { deps } = makeDeps({
      readOnboardOriginVersion: async () => ({ ...RECORD, content_sha256: OTHER_SHA }),
    });
    const tools = buildCustomerPublishTools(deps);
    const res = await tools[0].execute("id-2", {}, undefined, undefined, {});
    const parsed = JSON.parse(res.content[0].text);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.details.code, "drift_requires_reason");
  });
});

describe("sourceVersionMatches", () => {
  it("相符：source_lng 與 content_sha256 皆一致", () => {
    assert.strictEqual(sourceVersionMatches(ORIGIN, RECORD), true);
  });
  it("content_sha256 不同", () => {
    assert.strictEqual(sourceVersionMatches(ORIGIN, { ...RECORD, content_sha256: OTHER_SHA }), false);
  });
  it("source_lng 不同", () => {
    assert.strictEqual(sourceVersionMatches(ORIGIN, { ...RECORD, source_lng: "zh-TW" }), false);
  });
  it("record 為 null", () => {
    assert.strictEqual(sourceVersionMatches(ORIGIN, null), false);
  });
});

describe("parseOnboardOriginVersion", () => {
  it("解析出 origin_source_version", () => {
    const yaml = [
      "version: 2",
      "lng: en",
      "domains:",
      "- www.example.com",
      "origin_source_version:",
      "  source_lng: en",
      `  content_sha256: ${SHA}`,
      "  recorded_at: '2026-08-18T10:00:00+08:00'",
    ].join("\n");
    const r = parseOnboardOriginVersion(yaml);
    assert.deepStrictEqual(r, {
      source_lng: "en",
      content_sha256: SHA,
      recorded_at: "2026-08-18T10:00:00+08:00",
    });
  });

  it("無 origin_source_version 區塊 → null", () => {
    assert.strictEqual(parseOnboardOriginVersion("version: 2\nlng: en\n"), null);
  });

  it("區塊缺 content_sha256 → null", () => {
    assert.strictEqual(
      parseOnboardOriginVersion("origin_source_version:\n  source_lng: en\n"),
      null,
    );
  });

  it("帶引號的值也解析", () => {
    const r = parseOnboardOriginVersion(
      `origin_source_version:\n  source_lng: 'en'\n  content_sha256: '${SHA}'\n`,
    );
    assert.strictEqual(r.source_lng, "en");
    assert.strictEqual(r.content_sha256, SHA);
  });

  it("區塊後接其他頂層 key 時停止", () => {
    const r = parseOnboardOriginVersion(
      `origin_source_version:\n  source_lng: en\n  content_sha256: ${SHA}\nother_key: x\n`,
    );
    assert.strictEqual(r.content_sha256, SHA);
  });
});

describe("CLI args", () => {
  it("buildOriginVersionUrl 去除尾斜線", () => {
    assert.strictEqual(
      buildOriginVersionUrl("https://demo.example.com/"),
      "https://demo.example.com/readyscript/capps/pc2-p/service/?m=source&a=version",
    );
  });

  it("buildPushBackArgs 無 force", () => {
    assert.deepStrictEqual(
      buildPushBackArgs("my-app", { force: false }),
      ["preview", "push-back", "--name", "my-app"],
    );
  });

  it("buildPushBackArgs force + reason", () => {
    assert.deepStrictEqual(
      buildPushBackArgs("my-app", { force: true, reason: "客戶要求" }),
      ["preview", "push-back", "--name", "my-app", "--force", "--reason", "客戶要求"],
    );
  });

  it("buildPushDbArgs 多語系 + force", () => {
    assert.deepStrictEqual(
      buildPushDbArgs("my-app", ["en", "zh-TW"], { force: true, reason: "r" }),
      ["preview", "push-db", "--name", "my-app", "--lng", "en,zh-TW", "--force", "--reason", "r"],
    );
  });
});

describe("createLocalPublishDeps", () => {
  it("fetchOriginVersion：正確 URL + Bearer header + 解析", async () => {
    let captured;
    const deps = createLocalPublishDeps({
      cwd: "/tmp/x",
      originBaseUrl: "https://demo.example.com/",
      siteToken: "tok1234567890",
      appName: "my-app",
      languages: ["en"],
      fetch: async (url, init) => {
        captured = { url, init };
        return {
          ok: true,
          json: async () => ({ schema: "pgc-source-version-v1", source_lng: "en", content_sha256: SHA }),
        };
      },
    });
    const v = await deps.fetchOriginVersion();
    assert.strictEqual(
      captured.url,
      "https://demo.example.com/readyscript/capps/pc2-p/service/?m=source&a=version",
    );
    assert.strictEqual(captured.init.headers.Authorization, "Bearer tok1234567890");
    assert.deepStrictEqual(v, { schema: "pgc-source-version-v1", source_lng: "en", content_sha256: SHA });
  });

  it("fetchOriginVersion：source_lng 缺省 en、缺 content_sha256 抛錯", async () => {
    const deps = createLocalPublishDeps({
      cwd: "/tmp/x",
      originBaseUrl: "https://demo.example.com",
      siteToken: "t",
      appName: "a",
      languages: ["en"],
      fetch: async () => ({ ok: true, json: async () => ({ source_lng: "" }) }),
    });
    await assert.rejects(() => deps.fetchOriginVersion(), /content_sha256/);
  });

  it("readOnboardOriginVersion：讀 .onboard-status.yaml", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-"));
    try {
      fs.writeFileSync(
        path.join(dir, ".onboard-status.yaml"),
        `origin_source_version:\n  source_lng: en\n  content_sha256: ${SHA}\n`,
      );
      const deps = createLocalPublishDeps({
        cwd: dir, originBaseUrl: "https://x", siteToken: "t", appName: "a", languages: ["en"],
      });
      const r = await deps.readOnboardOriginVersion();
      assert.deepStrictEqual(r, { source_lng: "en", content_sha256: SHA });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readOnboardOriginVersion：無檔 → null", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-"));
    try {
      const deps = createLocalPublishDeps({
        cwd: dir, originBaseUrl: "https://x", siteToken: "t", appName: "a", languages: ["en"],
      });
      const r = await deps.readOnboardOriginVersion();
      assert.strictEqual(r, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
