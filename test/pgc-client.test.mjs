// test/pgc-client.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { createPgcClient, deriveConfirmationId } from "../dist/server/pgc-client.js";

function fakeUuidV5(name, ns) {
  // Deterministic: SHA-256 of ns + name, formatted as UUID
  const h = createHash("sha256").update(ns).update("\n").update(name).digest();
  const hex = h.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "5" + hex.slice(13, 16),
    "8" + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

const config = {
  hubBaseUrl: "https://ticket.example.com",
  projectId: "test-project",
  siteToken: "s".repeat(32),
  snapshotExportToken: "e".repeat(32),
};

const fakeFingerprint = {
  schema_version: 1,
  fingerprint: "sha256:" + "ab".repeat(32),
  source_app: "test",
  workspace_domain: "example.com",
  languages: ["en"],
  file_count: 2,
  database_count: 1,
};

describe("deriveConfirmationId", () => {
  it("is stable across retries", () => {
    const a = deriveConfirmationId("p1", "conv1", "sha256:" + "ab".repeat(32), fakeUuidV5);
    const b = deriveConfirmationId("p1", "conv1", "sha256:" + "ab".repeat(32), fakeUuidV5);
    assert.strictEqual(a, b);
  });

  it("changes with different fingerprint", () => {
    const a = deriveConfirmationId("p1", "conv1", "sha256:" + "ab".repeat(32), fakeUuidV5);
    const b = deriveConfirmationId("p1", "conv1", "sha256:" + "cd".repeat(32), fakeUuidV5);
    assert.notStrictEqual(a, b);
  });

  it("changes with different conversation", () => {
    const a = deriveConfirmationId("p1", "conv1", "sha256:" + "ab".repeat(32), fakeUuidV5);
    const b = deriveConfirmationId("p1", "conv2", "sha256:" + "ab".repeat(32), fakeUuidV5);
    assert.notStrictEqual(a, b);
  });
});

describe("PgcClient.confirmDeployment", () => {
  it("calls Ticket Hub with correct auth and body", async () => {
    const calls = [];
    const fakeFetch = async (url, opts) => {
      calls.push({ url, opts });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          confirmation_id: "conf-1",
          deployment_id: "dep-1",
          status: "queued",
          preview_fingerprint: fakeFingerprint.fingerprint,
        }),
      };
    };

    const client = createPgcClient(config, {
      fetch: fakeFetch,
      runFingerprint: async () => fakeFingerprint,
      uuidV5: fakeUuidV5,
    });

    const result = await client.confirmDeployment({
      agent_summary: "完成網站首頁設計",
      conversation_ref: "session-abc123",
      ticket_id: 42,
    });

    assert.strictEqual(result.status, "queued");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(
      calls[0].opts.headers.Authorization,
      `Bearer ${config.siteToken}`,
    );
  });

  it("normalizes line endings in summary", async () => {
    let postedBody;
    const fakeFetch = async (_url, opts) => {
      postedBody = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ ok: true, confirmation_id: "c", deployment_id: "d", status: "queued", preview_fingerprint: fakeFingerprint.fingerprint }) };
    };

    const client = createPgcClient(config, {
      fetch: fakeFetch,
      runFingerprint: async () => fakeFingerprint,
      uuidV5: fakeUuidV5,
    });

    await client.confirmDeployment({
      agent_summary: "line1\r\nline2\rline3",
      conversation_ref: "ref",
      ticket_id: null,
    });

    assert.strictEqual(postedBody.agent_summary, "line1\nline2\nline3");
  });

  it("maps 409 to typed error", async () => {
    const fakeFetch = async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: "confirmation_conflict" } }),
    });

    const client = createPgcClient(config, {
      fetch: fakeFetch,
      runFingerprint: async () => fakeFingerprint,
      uuidV5: fakeUuidV5,
    });

    await assert.rejects(
      () => client.confirmDeployment({
        agent_summary: "x",
        conversation_ref: "r",
        ticket_id: null,
      }),
      { status: 409 },
    );
  });
});