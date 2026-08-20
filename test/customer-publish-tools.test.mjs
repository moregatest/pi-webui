// test/customer-publish-tools.test.mjs
// PGC publish_confirmed 本地流程：origin 版本比對 → push-back → push-db，
// drift 時需客戶原因（force）。對應 Phase 4 凍結契約：
//   baseline 落點 data/preview-meta.json 的 origin_source_version；
//   輸出對齊 {ok:true,status:"succeeded",...} / {ok:false,status:"origin_drift",recorded_sha,current_sha}。
import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCustomerPublishTools,
  runPublishFlow,
  sourceVersionMatches,
  parsePreviewMetaOriginVersion,
  createLocalPublishDeps,
  buildOriginVersionUrl,
  buildForcePublishAuditUrl,
  buildPushBackArgs,
  buildPushDbArgs,
} from "../dist/tools/customer-publish-tools.js";

const SHA = "sha256:" + "ab".repeat(32);
const OTHER_SHA = "sha256:" + "cd".repeat(32);
const ORIGIN = { schema: "pgc-source-version-v1", source_lng: "en", content_sha256: SHA };
const RECORD = { source_lng: "en", content_sha256: SHA, recorded_at: "2026-08-18T10:00:00+08:00" };

function makeDeps(overrides = {}) {
  const calls = { fetch: 0, pushBack: [], pushDb: [], writeAudit: [], writeRecorded: [] };
  const deps = {
    fetchOriginVersion: async () => {
      calls.fetch++;
      return ORIGIN;
    },
    readRecordedOriginVersion: async () => RECORD,
    writeRecordedOriginVersion: async (version) => {
      calls.writeRecorded.push(version);
    },
    writeForcePublishAudit: async (input) => {
      calls.writeAudit.push(input);
    },
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
  it("相符：觸發 push-back → push-db（無 force），回 succeeded，且回寫 baseline", async () => {
    const { deps, calls } = makeDeps();
    const result = await runPublishFlow(deps, undefined);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, "succeeded");
    assert.strictEqual(result.forced, false);
    assert.strictEqual(result.source_lng, "en");
    assert.strictEqual(result.content_sha256, SHA);
    assert.strictEqual(calls.writeAudit.length, 0);
    assert.deepStrictEqual(calls.pushBack, [{ force: false }]);
    assert.deepStrictEqual(calls.pushDb, [{ force: false }]);
    // 發布後重新 fetch origin 並回寫 recorded baseline（P0-3 修復）
    assert.strictEqual(calls.fetch, 2);
    assert.strictEqual(calls.writeRecorded.length, 1);
    assert.strictEqual(calls.writeRecorded[0].content_sha256, SHA);
    assert.strictEqual(calls.writeRecorded[0].source_lng, "en");
  });

  it("drift 且無原因：拒絕，不觸發 CLI，回 origin_drift", async () => {
    const { deps, calls } = makeDeps({
      readRecordedOriginVersion: async () => ({ ...RECORD, content_sha256: OTHER_SHA }),
    });
    const result = await runPublishFlow(deps, undefined);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, "origin_drift");
    assert.strictEqual(result.recorded_sha, OTHER_SHA);
    assert.strictEqual(result.current_sha, SHA);
    assert.strictEqual(result.details.code, "drift_requires_reason");
    assert.strictEqual(result.details.current.content_sha256, SHA);
    assert.strictEqual(result.details.recorded.content_sha256, OTHER_SHA);
    assert.strictEqual(calls.pushBack.length, 0);
    assert.strictEqual(calls.pushDb.length, 0);
  });

  it("drift 且有原因：先寫 audit 再帶 --force --reason 觸發，回 succeeded，且回寫 baseline", async () => {
    const { deps, calls } = makeDeps({
      readRecordedOriginVersion: async () => ({ ...RECORD, content_sha256: OTHER_SHA }),
    });
    const result = await runPublishFlow(deps, "客戶要求立即上線");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, "succeeded");
    assert.strictEqual(result.forced, true);
    assert.strictEqual(result.source_lng, "en");
    assert.strictEqual(result.content_sha256, SHA);
    assert.strictEqual(calls.writeAudit.length, 1);
    assert.deepStrictEqual(calls.writeAudit[0], {
      recorded: { ...RECORD, content_sha256: OTHER_SHA },
      current: ORIGIN,
      reason: "客戶要求立即上線",
    });
    assert.deepStrictEqual(calls.pushBack, [{ force: true, reason: "客戶要求立即上線" }]);
    assert.deepStrictEqual(calls.pushDb, [{ force: true, reason: "客戶要求立即上線" }]);
    // force 發布成功後回寫 recorded baseline，drift 才得以收斂（P0-3 修復）
    assert.strictEqual(calls.fetch, 2);
    assert.strictEqual(calls.writeRecorded.length, 1);
    assert.strictEqual(calls.writeRecorded[0].content_sha256, SHA);
    assert.strictEqual(calls.writeRecorded[0].source_lng, "en");
  });

  it("audit 寫失敗：拒絕，不觸發 CLI", async () => {
    const { deps, calls } = makeDeps({
      readRecordedOriginVersion: async () => ({ ...RECORD, content_sha256: OTHER_SHA }),
      writeForcePublishAudit: async () => { throw new Error("audit boom"); },
    });
    const result = await runPublishFlow(deps, "客戶要求立即上線");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.details.code, "force_audit_failed");
    assert.strictEqual(calls.pushBack.length, 0);
    assert.strictEqual(calls.pushDb.length, 0);
  });

  it("無記錄但有 reason：audit recorded=null 後強制發布", async () => {
    const { deps, calls } = makeDeps({ readRecordedOriginVersion: async () => null });
    const result = await runPublishFlow(deps, "無記錄強制");
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, "succeeded");
    assert.strictEqual(result.forced, true);
    assert.strictEqual(calls.writeAudit.length, 1);
    assert.strictEqual(calls.writeAudit[0].recorded, null);
    assert.strictEqual(calls.writeAudit[0].current, ORIGIN);
    assert.strictEqual(calls.writeAudit[0].reason, "無記錄強制");
  });

  it("無記錄（null）：視為 drift，需原因", async () => {
    const { deps, calls } = makeDeps({ readRecordedOriginVersion: async () => null });
    const result = await runPublishFlow(deps, undefined);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, "origin_drift");
    assert.strictEqual(result.recorded_sha, null);
    assert.strictEqual(result.current_sha, SHA);
    assert.strictEqual(result.details.code, "drift_requires_reason");
    assert.strictEqual(result.details.recorded, null);
    assert.strictEqual(calls.pushBack.length, 0);
    assert.strictEqual(calls.pushDb.length, 0);
  });

  it("source_lng 不符：drift", async () => {
    const { deps } = makeDeps({
      readRecordedOriginVersion: async () => ({ ...RECORD, source_lng: "zh-TW" }),
    });
    const result = await runPublishFlow(deps, undefined);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.status, "origin_drift");
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

  it("發布成功但 baseline 回寫失敗：仍回 succeeded，但帶 warning details", async () => {
    const { deps } = makeDeps({
      writeRecordedOriginVersion: async () => { throw new Error("write boom"); },
    });
    const result = await runPublishFlow(deps, undefined);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, "succeeded");
    assert.strictEqual(result.details.code, "baseline_write_failed");
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
    assert.strictEqual(parsed.status, "succeeded");
    assert.strictEqual(parsed.forced, false);
    assert.deepStrictEqual(res.details, parsed);
  });

  it("drift 無原因 → execute 回傳 content 含 drift 錯誤", async () => {
    const { deps } = makeDeps({
      readRecordedOriginVersion: async () => ({ ...RECORD, content_sha256: OTHER_SHA }),
    });
    const tools = buildCustomerPublishTools(deps);
    const res = await tools[0].execute("id-2", {}, undefined, undefined, {});
    const parsed = JSON.parse(res.content[0].text);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.status, "origin_drift");
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

describe("parsePreviewMetaOriginVersion", () => {
  it("解析出 origin_source_version", () => {
    const json = JSON.stringify({
      preview_url: "https://x-preview.fly.dev/",
      app_name: "x-preview",
      domain: "www.example.com",
      origin_source_version: {
        source_lng: "en",
        content_sha256: SHA,
        recorded_at: "2026-08-18T10:00:00+08:00",
      },
    });
    const r = parsePreviewMetaOriginVersion(json);
    assert.deepStrictEqual(r, {
      source_lng: "en",
      content_sha256: SHA,
      recorded_at: "2026-08-18T10:00:00+08:00",
    });
  });

  it("無 origin_source_version → null", () => {
    assert.strictEqual(
      parsePreviewMetaOriginVersion(JSON.stringify({ preview_url: "https://x/" })),
      null,
    );
  });

  it("origin_source_version 缺 content_sha256 → null", () => {
    assert.strictEqual(
      parsePreviewMetaOriginVersion(
        JSON.stringify({ origin_source_version: { source_lng: "en" } }),
      ),
      null,
    );
  });

  it("origin_source_version 缺 source_lng → null", () => {
    assert.strictEqual(
      parsePreviewMetaOriginVersion(
        JSON.stringify({ origin_source_version: { content_sha256: SHA } }),
      ),
      null,
    );
  });

  it("無 recorded_at 也解析", () => {
    const r = parsePreviewMetaOriginVersion(
      JSON.stringify({ origin_source_version: { source_lng: "en", content_sha256: SHA } }),
    );
    assert.deepStrictEqual(r, { source_lng: "en", content_sha256: SHA });
  });

  it("非 JSON / 空字串 → null", () => {
    assert.strictEqual(parsePreviewMetaOriginVersion("not-json"), null);
    assert.strictEqual(parsePreviewMetaOriginVersion(""), null);
  });

  it("origin_source_version 非物件 → null", () => {
    assert.strictEqual(
      parsePreviewMetaOriginVersion(JSON.stringify({ origin_source_version: "en" })),
      null,
    );
  });
});

describe("CLI args", () => {
  it("buildOriginVersionUrl 去除尾斜線", () => {
    assert.strictEqual(
      buildOriginVersionUrl("https://demo.example.com/"),
      "https://demo.example.com/readyscript/capps/pc2-p/service/?m=source&a=version",
    );
  });

  it("buildPushBackArgs 無 force：帶 --http（客戶路徑無 SSH，走 ORIGIN_HOSTNAME + 站台 token）", () => {
    assert.deepStrictEqual(
      buildPushBackArgs("my-app", { force: false }),
      ["preview", "push-back", "--http", "--name", "my-app"],
    );
  });

  it("buildPushBackArgs force + reason：--force/--reason 只出現一次", () => {
    assert.deepStrictEqual(
      buildPushBackArgs("my-app", { force: true, reason: "客戶要求" }),
      ["preview", "push-back", "--http", "--name", "my-app", "--force", "--reason", "客戶要求"],
    );
  });

  it("buildPushDbArgs 多語系 + force：不帶 --http（push-db 已 HTTP 化，CLI 無此 flag）", () => {
    const args = buildPushDbArgs("my-app", ["en", "zh-TW"], { force: true, reason: "r" });
    assert.deepStrictEqual(
      args,
      ["preview", "push-db", "--name", "my-app", "--lng", "en,zh-TW", "--force", "--reason", "r"],
    );
    assert.ok(!args.includes("--http"), "push-db 不接受 --http，帶上會被 click 拒絕");
  });

  it("buildForcePublishAuditUrl：組出 m=log&a=pgc-force-publish + 參數", () => {
    const url = buildForcePublishAuditUrl("https://demo.example.com/", {
      who: "conf-1",
      desc: "客戶要求 & 立即",
      params: '{"recorded":null,"current":{}}',
    });
    const u = new URL(url);
    assert.strictEqual(u.pathname, "/readyscript/capps/pc2-p/service/");
    assert.strictEqual(u.searchParams.get("m"), "log");
    assert.strictEqual(u.searchParams.get("a"), "pgc-force-publish");
    assert.strictEqual(u.searchParams.get("who"), "conf-1");
    assert.strictEqual(u.searchParams.get("desc"), "客戶要求 & 立即");
    assert.strictEqual(u.searchParams.get("params"), '{"recorded":null,"current":{}}');
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

  it("readRecordedOriginVersion：讀 data/preview-meta.json 的 origin_source_version", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-"));
    try {
      fs.mkdirSync(path.join(dir, "data"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "data", "preview-meta.json"),
        JSON.stringify({
          preview_url: "https://x-preview.fly.dev/",
          app_name: "x-preview",
          origin_source_version: { source_lng: "en", content_sha256: SHA },
        }),
      );
      const deps = createLocalPublishDeps({
        cwd: dir, originBaseUrl: "https://x", siteToken: "t", appName: "a", languages: ["en"],
      });
      const r = await deps.readRecordedOriginVersion();
      assert.deepStrictEqual(r, { source_lng: "en", content_sha256: SHA });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readRecordedOriginVersion：無檔 → null", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-"));
    try {
      const deps = createLocalPublishDeps({
        cwd: dir, originBaseUrl: "https://x", siteToken: "t", appName: "a", languages: ["en"],
      });
      const r = await deps.readRecordedOriginVersion();
      assert.strictEqual(r, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeRecordedOriginVersion：原子回寫 origin_source_version，保留其他 key", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-"));
    try {
      fs.mkdirSync(path.join(dir, "data"), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "data", "preview-meta.json"),
        JSON.stringify({
          preview_url: "https://x-preview.fly.dev/",
          app_name: "x-preview",
          origin_source_version: { source_lng: "en", content_sha256: SHA },
        }),
      );
      const deps = createLocalPublishDeps({
        cwd: dir, originBaseUrl: "https://x", siteToken: "t", appName: "a", languages: ["en"],
      });
      await deps.writeRecordedOriginVersion({
        source_lng: "en",
        content_sha256: OTHER_SHA,
        recorded_at: "2026-08-19T14:53:00+08:00",
      });
      const raw = JSON.parse(
        fs.readFileSync(path.join(dir, "data", "preview-meta.json"), "utf-8"),
      );
      assert.deepStrictEqual(raw.origin_source_version, {
        source_lng: "en",
        content_sha256: OTHER_SHA,
        recorded_at: "2026-08-19T14:53:00+08:00",
      });
      // 其他 key 保留
      assert.strictEqual(raw.preview_url, "https://x-preview.fly.dev/");
      assert.strictEqual(raw.app_name, "x-preview");
      // 不留 tmp 殘檔
      assert.ok(!fs.existsSync(path.join(dir, "data", "preview-meta.json.tmp")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeRecordedOriginVersion：無既有檔時從頭建立", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-"));
    try {
      fs.mkdirSync(path.join(dir, "data"), { recursive: true });
      const deps = createLocalPublishDeps({
        cwd: dir, originBaseUrl: "https://x", siteToken: "t", appName: "a", languages: ["en"],
      });
      await deps.writeRecordedOriginVersion({
        source_lng: "zh-TW",
        content_sha256: OTHER_SHA,
      });
      const raw = JSON.parse(
        fs.readFileSync(path.join(dir, "data", "preview-meta.json"), "utf-8"),
      );
      assert.strictEqual(raw.origin_source_version.content_sha256, OTHER_SHA);
      assert.strictEqual(raw.origin_source_version.source_lng, "zh-TW");
      assert.ok(raw.origin_source_version.recorded_at);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeForcePublishAudit：GET m=log&a=pgc-force-publish + Bearer header + params", async () => {
    let captured;
    const deps = createLocalPublishDeps({
      cwd: "/tmp/x",
      originBaseUrl: "https://demo.example.com/",
      siteToken: "tok1234567890",
      appName: "my-app",
      languages: ["en"],
      confirmationId: "conf-42",
      fetch: async (url, init) => {
        captured = { url, init };
        return { ok: true };
      },
    });
    await deps.writeForcePublishAudit({
      recorded: { source_lng: "en", content_sha256: OTHER_SHA },
      current: { source_lng: "en", content_sha256: SHA },
      reason: "客戶要求立即上線",
    });
    const u = new URL(captured.url);
    assert.strictEqual(u.searchParams.get("m"), "log");
    assert.strictEqual(u.searchParams.get("a"), "pgc-force-publish");
    assert.strictEqual(u.searchParams.get("who"), "conf-42");
    assert.strictEqual(u.searchParams.get("desc"), "客戶要求立即上線");
    assert.strictEqual(
      u.searchParams.get("params"),
      JSON.stringify({
        recorded: { source_lng: "en", content_sha256: OTHER_SHA },
        current: { source_lng: "en", content_sha256: SHA },
      }),
    );
    assert.strictEqual(captured.init.headers.Authorization, "Bearer tok1234567890");
  });

  it("writeForcePublishAudit：HTTP 非 2xx 抛錯", async () => {
    const deps = createLocalPublishDeps({
      cwd: "/tmp/x",
      originBaseUrl: "https://demo.example.com",
      siteToken: "t",
      appName: "a",
      languages: ["en"],
      confirmationId: "cli",
      fetch: async () => ({ ok: false, status: 500 }),
    });
    await assert.rejects(
      () => deps.writeForcePublishAudit({
        recorded: { source_lng: "en", content_sha256: OTHER_SHA },
        current: { source_lng: "en", content_sha256: SHA },
        reason: "r",
      }),
      /500/,
    );
  });

  it("writeForcePublishAudit：confirmationId 缺省 cli", async () => {
    let captured;
    const deps = createLocalPublishDeps({
      cwd: "/tmp/x",
      originBaseUrl: "https://demo.example.com",
      siteToken: "t",
      appName: "a",
      languages: ["en"],
      fetch: async (url) => {
        captured = url;
        return { ok: true };
      },
    });
    await deps.writeForcePublishAudit({
      recorded: { source_lng: "en", content_sha256: OTHER_SHA },
      current: { source_lng: "en", content_sha256: SHA },
      reason: "r",
    });
    assert.strictEqual(new URL(captured).searchParams.get("who"), "cli");
  });
});
