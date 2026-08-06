// src/server/pgc-config.ts
// PGC (Preview Git Control) publish control-plane 執行期設定解析。
//
// 僅在 PGC_PUBLISH_ENABLED=1 時啟用；部分設定立即 fail startup 並只指出缺的 key。
// 既有 preview 若無此 flag 行為不變。

export interface PgcConfig {
  hubBaseUrl: string;
  projectId: string;
  siteToken: string;
  snapshotExportToken: string;
}

const PROJECT_ID_RE = /^[a-zA-Z][-a-zA-Z0-9_.]{0,127}$/;
const MIN_TOKEN_LENGTH = 32;

export function parsePgcConfig(
  env: NodeJS.ProcessEnv,
): PgcConfig | null {
  const enabled = env.PGC_PUBLISH_ENABLED;
  if (enabled !== "1") {
    // 未啟用：任何 PGC credential 都是 orphan
    const orphanKeys = [
      "TICKET_HUB_BASE_URL",
      "TICKET_HUB_PROJECT_ID",
      "TICKET_HUB_SITE_TOKEN",
      "PGC_SNAPSHOT_EXPORT_TOKEN",
    ].filter((k) => env[k] !== undefined);
    if (orphanKeys.length > 0) {
      throw new Error(
        `PGC_PUBLISH_ENABLED is not set to '1' but PGC credentials are present: `
        + orphanKeys.join(", ") + ". Remove them or set PGC_PUBLISH_ENABLED=1.",
      );
    }
    return null;
  }

  const missing: string[] = [];
  const required: Record<string, string | undefined> = {
    TICKET_HUB_BASE_URL: env.TICKET_HUB_BASE_URL,
    TICKET_HUB_PROJECT_ID: env.TICKET_HUB_PROJECT_ID,
    TICKET_HUB_SITE_TOKEN: env.TICKET_HUB_SITE_TOKEN,
    PGC_SNAPSHOT_EXPORT_TOKEN: env.PGC_SNAPSHOT_EXPORT_TOKEN,
  };

  for (const [key, val] of Object.entries(required)) {
    if (!val) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(
      `PGC_PUBLISH_ENABLED=1 but missing: ${missing.join(", ")}`,
    );
  }

  // Validate TICKET_HUB_BASE_URL
  let hubBaseUrl = env.TICKET_HUB_BASE_URL!;
  try {
    const url = new URL(hubBaseUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost"
        && url.hostname !== "127.0.0.1") {
      throw new Error(
        `TICKET_HUB_BASE_URL must use HTTPS: ${hubBaseUrl}`,
      );
    }
  } catch (e: any) {
    if (e.message?.includes("TICKET_HUB_BASE_URL")) throw e;
    throw new Error(`Invalid TICKET_HUB_BASE_URL: ${hubBaseUrl}`);
  }

  // Validate project ID
  const projectId = env.TICKET_HUB_PROJECT_ID!;
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new Error(`Invalid TICKET_HUB_PROJECT_ID: ${projectId}`);
  }

  // Validate tokens
  const siteToken = env.TICKET_HUB_SITE_TOKEN!;
  const snapshotExportToken = env.PGC_SNAPSHOT_EXPORT_TOKEN!;

  if (siteToken.length < MIN_TOKEN_LENGTH) {
    throw new Error("TICKET_HUB_SITE_TOKEN too short (min 32 bytes)");
  }
  if (snapshotExportToken.length < MIN_TOKEN_LENGTH) {
    throw new Error("PGC_SNAPSHOT_EXPORT_TOKEN too short (min 32 bytes)");
  }
  if (siteToken === snapshotExportToken) {
    throw new Error(
      "TICKET_HUB_SITE_TOKEN and PGC_SNAPSHOT_EXPORT_TOKEN must be different",
    );
  }

  return { hubBaseUrl, projectId, siteToken, snapshotExportToken };
}