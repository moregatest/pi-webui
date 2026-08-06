// src/server/pgc-client.ts
// Ticket Hub HTTP client with stable confirmation identity (UUIDv5).

import { createHash } from "node:crypto";
import type { PgcConfig } from "./pgc-config.js";

export interface FingerprintResult {
  schema_version: 1;
  fingerprint: `sha256:${string}`;
  source_app: string;
  workspace_domain: string;
  languages: string[];
  file_count: number;
  database_count: number;
}

export interface PublishConfirmedInput {
  agent_summary: string;
  conversation_ref: string;
  ticket_id: number | null;
}

export interface PublishConfirmedResult {
  ok: true;
  confirmation_id: string;
  deployment_id: string;
  status: "queued";
  preview_fingerprint: `sha256:${string}`;
}

export interface PgcClientDeps {
  fetch: typeof globalThis.fetch;
  runFingerprint: () => Promise<FingerprintResult>;
  uuidV5: (name: string, namespace: string) => string;
}

// Fixed namespace UUID for UUIDv5 (generated once, committed)
const CONFIRMATION_NAMESPACE = "6d6f7265-6761-7465-7374-7067632d7631"; // "moregatest-pgc-v1"

export function deriveConfirmationId(
  projectId: string,
  conversationRef: string,
  fingerprint: string,
  uuidV5: (name: string, namespace: string) => string,
): string {
  const name = `${projectId}\n${conversationRef}\n${fingerprint}`;
  return uuidV5(name, CONFIRMATION_NAMESPACE);
}

export interface PgcClient {
  confirmDeployment(
    input: PublishConfirmedInput,
  ): Promise<PublishConfirmedResult>;
  getDeployment(
    deploymentId: string,
  ): Promise<Record<string, unknown>>;
}

export function createPgcClient(
  config: PgcConfig,
  deps: PgcClientDeps,
): PgcClient {
  const authHeader = `Bearer ${config.siteToken}`;
  const baseUrl = config.hubBaseUrl.replace(/\/$/, "");

  async function confirmDeployment(
    input: PublishConfirmedInput,
  ): Promise<PublishConfirmedResult> {
    const fp = await deps.runFingerprint();
    const confirmationId = deriveConfirmationId(
      config.projectId,
      input.conversation_ref,
      fp.fingerprint,
      deps.uuidV5,
    );

    const summary = input.agent_summary.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (Buffer.byteLength(summary, "utf-8") > 8192) {
      throw new Error("agent_summary exceeds 8192 UTF-8 bytes");
    }
    if (Buffer.byteLength(input.conversation_ref, "utf-8") > 512) {
      throw new Error("conversation_ref exceeds 512 UTF-8 bytes");
    }

    const body = JSON.stringify({
      project_id: config.projectId,
      confirmation_id: confirmationId,
      fingerprint_schema: 1,
      preview_fingerprint: fp.fingerprint,
      agent_summary: summary,
      conversation_ref: input.conversation_ref,
      ticket_id: input.ticket_id,
    });

    const resp = await deps.fetch(
      `${baseUrl}/api/deployments/confirmations`,
      {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body,
      },
    );

    if (resp.status === 409) {
      const err = await resp.json().catch(() => ({}));
      throw Object.assign(
        new Error(err.error?.code ?? "confirmation_conflict"),
        { status: 409, body: err },
      );
    }

    if (!resp.ok) {
      throw new Error(`Ticket Hub returned ${resp.status}`);
    }

    return (await resp.json()) as PublishConfirmedResult;
  }

  async function getDeployment(
    deploymentId: string,
  ): Promise<Record<string, unknown>> {
    const resp = await deps.fetch(
      `${baseUrl}/api/deployments/${deploymentId}/status`,
      {
        headers: { Authorization: authHeader },
      },
    );

    if (!resp.ok) {
      throw new Error(`Ticket Hub status returned ${resp.status}`);
    }

    return (await resp.json()) as Record<string, unknown>;
  }

  return { confirmDeployment, getDeployment };
}