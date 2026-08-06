// test/customer-publish-tools.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert";
import { buildCustomerPublishTools } from "../dist/tools/customer-publish-tools.js";

function fakeClient(resultOrError) {
  return {
    confirmDeployment: async () => {
      if (resultOrError instanceof Error) throw resultOrError;
      return resultOrError;
    },
    getDeployment: async () => ({}),
  };
}

const successResult = {
  ok: true,
  confirmation_id: "conf-1",
  deployment_id: "dep-1",
  status: "queued",
  preview_fingerprint: "sha256:" + "ab".repeat(32),
};

describe("buildCustomerPublishTools", () => {
  it("returns publish_confirmed tool", () => {
    const tools = buildCustomerPublishTools(fakeClient(successResult));
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, "publish_confirmed");
  });

  it("accepts valid input", async () => {
    const tools = buildCustomerPublishTools(fakeClient(successResult));
    const result = await tools[0].execute({
      agent_summary: "完成網站首頁",
      conversation_ref: "session-123",
      ticket_id: 42,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.status, "queued");
  });

  it("rejects empty agent_summary", async () => {
    const tools = buildCustomerPublishTools(fakeClient(successResult));
    const result = await tools[0].execute({
      agent_summary: "",
      conversation_ref: "session-123",
      ticket_id: null,
    });
    assert.strictEqual(result.ok, false);
  });

  it("rejects empty conversation_ref", async () => {
    const tools = buildCustomerPublishTools(fakeClient(successResult));
    const result = await tools[0].execute({
      agent_summary: "x",
      conversation_ref: "",
      ticket_id: null,
    });
    assert.strictEqual(result.ok, false);
  });

  it("rejects non-integer ticket_id", async () => {
    const tools = buildCustomerPublishTools(fakeClient(successResult));
    const result = await tools[0].execute({
      agent_summary: "x",
      conversation_ref: "r",
      ticket_id: "not-a-number",
    });
    assert.strictEqual(result.ok, false);
  });

  it("allows null ticket_id", async () => {
    const tools = buildCustomerPublishTools(fakeClient(successResult));
    const result = await tools[0].execute({
      agent_summary: "x",
      conversation_ref: "r",
      ticket_id: null,
    });
    assert.strictEqual(result.ok, true);
  });

  it("handles 409 conflict gracefully", async () => {
    const err = new Error("conflict");
    err.status = 409;
    const tools = buildCustomerPublishTools(fakeClient(err));
    const result = await tools[0].execute({
      agent_summary: "x",
      conversation_ref: "r",
      ticket_id: null,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.details.code, "confirmation_conflict");
  });

  it("handles Hub error gracefully", async () => {
    const err = new Error("boom");
    const tools = buildCustomerPublishTools(fakeClient(err));
    const result = await tools[0].execute({
      agent_summary: "x",
      conversation_ref: "r",
      ticket_id: null,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.details.code, "hub_error");
  });
});