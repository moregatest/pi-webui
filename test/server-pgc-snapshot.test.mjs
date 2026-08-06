// test/server-pgc-snapshot.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert";
import { handlePgcSnapshotExport, handlePgcStatusProxy } from "../dist/server/pgc-http.js";

function mockReq({ method = "POST", path = "/api/pgc/snapshots/export", auth, body } = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  let ended = false;
  let _onData, _onEnd, _onError;

  const req = {
    method,
    url: path,
    headers: auth ? { authorization: auth } : {},
    on(event, cb) {
      if (event === "data") _onData = cb;
      if (event === "end") _onEnd = cb;
      if (event === "error") _onError = cb;
      return this;
    },
    destroy() { ended = true; },
  };

  // Start data flow
  if (body !== undefined) {
    setImmediate(() => {
      for (const chunk of chunks) _onData?.(chunk);
      _onEnd?.();
    });
  }

  return req;
}

function mockRes() {
  const res = {
    _status: 0,
    _headers: {},
    _body: "",
    writeHead(status, headers) {
      this._status = status;
      this._headers = { ...this._headers, ...headers };
    },
    end(data) {
      this._body = data ?? "";
    },
    write() {},
  };
  return res;
}

const config = {
  hubBaseUrl: "https://ticket.example.com",
  projectId: "test",
  siteToken: "s".repeat(32),
  snapshotExportToken: "e".repeat(32),
};

describe("handlePgcSnapshotExport", () => {
  it("rejects wrong method", async () => {
    const req = mockReq({ method: "GET" });
    const res = mockRes();
    const handled = await handlePgcSnapshotExport(req, res, { config, appCwd: "/tmp" });
    assert.strictEqual(handled, false);
  });

  it("rejects missing auth", async () => {
    const req = mockReq({ auth: undefined });
    const res = mockRes();
    const handled = await handlePgcSnapshotExport(req, res, { config, appCwd: "/tmp" });
    assert.strictEqual(handled, true);
    assert.strictEqual(res._status, 401);
  });

  it("rejects wrong token", async () => {
    const req = mockReq({ auth: "Bearer wrong-token" });
    const res = mockRes();
    const handled = await handlePgcSnapshotExport(req, res, { config, appCwd: "/tmp" });
    assert.strictEqual(handled, true);
    assert.strictEqual(res._status, 401);
  });

  it("rejects unsupported schema", async () => {
    const req = mockReq({
      auth: `Bearer ${config.snapshotExportToken}`,
      body: JSON.stringify({ fingerprint_schema: 99, expected_fingerprint: "sha256:" + "ab".repeat(32) }),
    });
    const res = mockRes();
    const handled = await handlePgcSnapshotExport(req, res, { config, appCwd: "/tmp" });
    assert.strictEqual(handled, true);
    assert.strictEqual(res._status, 422);
  });

  it("rejects unknown body keys", async () => {
    const req = mockReq({
      auth: `Bearer ${config.snapshotExportToken}`,
      body: JSON.stringify({ fingerprint_schema: 1, expected_fingerprint: "sha256:" + "ab".repeat(32), project: "hack" }),
    });
    const res = mockRes();
    const handled = await handlePgcSnapshotExport(req, res, { config, appCwd: "/tmp" });
    assert.strictEqual(handled, true);
    assert.strictEqual(res._status, 400);
  });

  it("rejects malformed JSON body", async () => {
    const req = mockReq({
      auth: `Bearer ${config.snapshotExportToken}`,
      body: "not json",
    });
    const res = mockRes();
    const handled = await handlePgcSnapshotExport(req, res, { config, appCwd: "/tmp" });
    assert.strictEqual(handled, true);
    assert.strictEqual(res._status, 400);
  });
});

describe("handlePgcStatusProxy", () => {
  it("ignores non-status routes", async () => {
    const req = mockReq({ method: "GET", path: "/other" });
    const res = mockRes();
    const handled = await handlePgcStatusProxy(req, res, {
      getDeployment: async () => ({}),
    });
    assert.strictEqual(handled, false);
  });

  it("proxies status for valid deployment ID", async () => {
    const req = mockReq({ method: "GET", path: "/api/pgc/deployments/12345678-1234-1234-1234-123456789abc" });
    const res = mockRes();
    const handled = await handlePgcStatusProxy(req, res, {
      getDeployment: async () => ({ status: "live" }),
    });
    assert.strictEqual(handled, true);
    assert.strictEqual(res._status, 200);
    const body = JSON.parse(res._body);
    assert.strictEqual(body.status, "live");
  });

  it("maps upstream 404 to 404", async () => {
    const req = mockReq({ method: "GET", path: "/api/pgc/deployments/12345678-1234-1234-1234-123456789abc" });
    const res = mockRes();
    const handled = await handlePgcStatusProxy(req, res, {
      getDeployment: async () => { throw new Error("HTTP 404"); },
    });
    assert.strictEqual(handled, true);
    assert.strictEqual(res._status, 404);
  });
});