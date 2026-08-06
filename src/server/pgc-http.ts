// src/server/pgc-http.ts
// PGC snapshot export endpoint + deployment status proxy。
//
// /api/pgc/snapshots/export — POST，bearer 認證，回傳 tar.gz 或 409 stale
// /api/pgc/deployments/:id — GET，cookie 認證後 proxy Ticket Hub status

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

import type { PgcConfig } from "./pgc-config.js";
import type { PgcClient } from "./pgc-client.js";

export interface SnapshotExportResult {
  status: "ok";
  fingerprint: `sha256:${string}`;
  bundle_sha256: `sha256:${string}`;
  bundle_size: number;
}

export interface SnapshotExportContext {
  config: PgcConfig;
  appCwd: string;
}

interface StaleResult {
  status: "stale";
  actual_fingerprint: `sha256:${string}`;
}

type ExportResult = SnapshotExportResult | StaleResult;

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = 64 * 1024;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function runSnapshotExport(
  appCwd: string,
  expectedFingerprint: string,
  outputPath: string,
): Promise<ExportResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "readyai-project",
      [
        "preview", "snapshot-export",
        "--expected-fingerprint", expectedFingerprint,
        "--output", outputPath,
        "--json",
      ],
      {
        cwd: appCwd,
        env: {
          ...process.env,
          READYAI_SKIP_GLOBAL_SKILL_SYNC: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 3) {
        // Stale: parse actual fingerprint from stdout
        try {
          const parsed = JSON.parse(stdout);
          resolve({
            status: "stale",
            actual_fingerprint: parsed.actual_fingerprint,
          });
        } catch {
          reject(new Error("stale response parse error"));
        }
        return;
      }
      if (code !== 0) {
        reject(new Error(`snapshot-export exited ${code}: ${stderr}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve({
          status: "ok",
          fingerprint: parsed.fingerprint,
          bundle_sha256: parsed.bundle_sha256,
          bundle_size: parsed.bundle_size,
        });
      } catch {
        reject(new Error("snapshot-export parse error"));
      }
    });
  });
}

// ── POST /api/pgc/snapshots/export ──────────────────────────────────────

export async function handlePgcSnapshotExport(
  req: IncomingMessage,
  res: ServerResponse,
  context: SnapshotExportContext,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method !== "POST" || url.pathname !== "/api/pgc/snapshots/export") {
    return false;
  }

  // Auth
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    sendJson(res, 401, { error: { code: "unauthorized" } });
    return true;
  }
  const token = auth.slice(7);
  if (!constantTimeEqual(token, context.config.snapshotExportToken)) {
    sendJson(res, 401, { error: { code: "unauthorized" } });
    return true;
  }

  // Parse body
  let body: string;
  try {
    body = await parseBody(req);
  } catch {
    sendJson(res, 400, { error: { code: "invalid_snapshot_request" } });
    return true;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: { code: "invalid_snapshot_request" } });
    return true;
  }

  // Validate: only allowed keys
  const allowed = new Set(["fingerprint_schema", "expected_fingerprint"]);
  const keys = Object.keys(parsed);
  if (keys.some((k) => !allowed.has(k))) {
    sendJson(res, 400, { error: { code: "invalid_snapshot_request" } });
    return true;
  }

  if (parsed.fingerprint_schema !== 1) {
    sendJson(res, 422, { error: { code: "unsupported_fingerprint_schema" } });
    return true;
  }

  const expectedFingerprint = String(parsed.expected_fingerprint ?? "");
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedFingerprint)) {
    sendJson(res, 400, { error: { code: "invalid_snapshot_request" } });
    return true;
  }

  // Create temp directory
  const tmpDir = await mkdtemp(path.join(tmpdir(), "pgc-snapshot-"));
  const outputPath = path.join(tmpDir, "bundle.tar.gz");

  try {
    const result = await runSnapshotExport(
      context.appCwd,
      expectedFingerprint,
      outputPath,
    );

    if (result.status === "stale") {
      sendJson(res, 409, {
        error: { code: "stale" },
        actual_fingerprint: result.actual_fingerprint,
      });
      return true;
    }

    // Success: stream the bundle
    const bundleSha256 = createHash("sha256");
    const stream = createReadStream(outputPath);
    let bundleSize = 0;

    stream.on("data", (chunk: Buffer) => {
      bundleSha256.update(chunk);
      bundleSize += chunk.length;
    });

    res.writeHead(200, {
      "Content-Type": "application/vnd.readyai.snapshot.v1+tar+gzip",
      "X-ReadyAI-Fingerprint": result.fingerprint,
      "X-ReadyAI-Bundle-SHA256": result.bundle_sha256,
      "Content-Length": String(result.bundle_size),
      "Cache-Control": "no-store",
    });

    await pipeline(stream, res);
    return true;
  } finally {
    // Cleanup temp directory
    rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── GET /api/pgc/deployments/:deploymentId ──────────────────────────────

const DEPLOYMENT_ID_RE = /^\/api\/pgc\/deployments\/([a-f0-9-]{36})$/;

export async function handlePgcStatusProxy(
  req: IncomingMessage,
  res: ServerResponse,
  client: PgcClient,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method !== "GET") return false;

  const match = url.pathname.match(DEPLOYMENT_ID_RE);
  if (!match) return false;

  const deploymentId = match[1];

  try {
    const status = await client.getDeployment(deploymentId);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(status));
  } catch (err: any) {
    if (err.message.includes("404")) {
      sendJson(res, 404, { error: { code: "not_found" } });
    } else if (err.message.includes("401") || err.message.includes("403")) {
      sendJson(res, 502, { error: { code: "upstream_error" } });
    } else {
      sendJson(res, 502, { error: { code: "upstream_error" } });
    }
  }

  return true;
}