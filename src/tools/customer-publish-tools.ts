// src/tools/customer-publish-tools.ts
// PGC publish_confirmed agent tool — 客戶明確確認後呼叫，走 Ticket Hub。

import type { PgcClient, PublishConfirmedInput } from "../server/pgc-client.js";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

const SUMMARY_MAX_BYTES = 8192;
const CONVERSATION_REF_MAX_BYTES = 512;

export function buildCustomerPublishTools(
  client: PgcClient,
): ToolDefinition[] {
  return [
    {
      name: "publish_confirmed",
      description:
        "客戶明確確認後，將當前網站內容正式發布。僅在客戶同意後呼叫。",
      parameters: {
        type: "object",
        properties: {
          agent_summary: {
            type: "string",
            description: "AI 在本次對話中完成的內容摘要（繁體中文）",
          },
          conversation_ref: {
            type: "string",
            description: "本次對話的不透明參考（使用當前 session ID）",
          },
          ticket_id: {
            type: ["integer", "null"],
            description: "關聯的 Ticket Hub 工單 ID（若無則 null）",
          },
        },
        required: ["agent_summary", "conversation_ref"],
        additionalProperties: false,
      },
      execute: async (args: Record<string, unknown>) => {
        // Validate and normalize
        const agentSummary = String(args.agent_summary ?? "");
        const conversationRef = String(args.conversation_ref ?? "");
        const ticketIdRaw = args.ticket_id;

        if (Buffer.byteLength(agentSummary, "utf-8") === 0) {
          return {
            ok: false,
            error: "agent_summary 不得為空",
            details: { code: "invalid_input" },
          };
        }
        if (Buffer.byteLength(agentSummary, "utf-8") > SUMMARY_MAX_BYTES) {
          return {
            ok: false,
            error: "agent_summary 超過 8192 bytes 上限",
            details: { code: "invalid_input" },
          };
        }
        if (Buffer.byteLength(conversationRef, "utf-8") === 0) {
          return {
            ok: false,
            error: "conversation_ref 不得為空",
            details: { code: "invalid_input" },
          };
        }
        if (Buffer.byteLength(conversationRef, "utf-8") > CONVERSATION_REF_MAX_BYTES) {
          return {
            ok: false,
            error: "conversation_ref 超過 512 bytes 上限",
            details: { code: "invalid_input" },
          };
        }

        let ticketId: number | null = null;
        if (ticketIdRaw !== null && ticketIdRaw !== undefined) {
          ticketId = Number(ticketIdRaw);
          if (!Number.isInteger(ticketId) || ticketId < 1) {
            return {
              ok: false,
              error: "ticket_id 必須是正整數或 null",
              details: { code: "invalid_input" },
            };
          }
        }

        const input: PublishConfirmedInput = {
          agent_summary: agentSummary,
          conversation_ref: conversationRef,
          ticket_id: ticketId,
        };

        try {
          const result = await client.confirmDeployment(input);
          return {
            ok: true,
            message: "發布確認已提交",
            tracking_id: result.deployment_id,
            status: result.status,
            details: {
              confirmation_id: result.confirmation_id,
              deployment_id: result.deployment_id,
              status: result.status,
            },
          };
        } catch (err: any) {
          if (err?.status === 409) {
            return {
              ok: false,
              error: "發布確認衝突：此內容已提交過，若內容有變更請重新確認",
              details: { code: "confirmation_conflict" },
            };
          }
          return {
            ok: false,
            error: "發布確認失敗，請稍後重試",
            details: { code: "hub_error" },
          };
        }
      },
    },
  ];
}