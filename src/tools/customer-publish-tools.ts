// src/tools/customer-publish-tools.ts
// PGC publish_confirmed agent tool — 客戶明確確認後走「本地流程」：
//   origin 來源語系版本比對 → preview push-back → push-db。
//   內容 drift 時需客戶原因（force）；無原因 = 拒絕。
// 對應 spec 2026-08-18-pgc-preview-local-minimal-design §3（極簡客戶確認）。

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

// ── 凍結契約型別 ──

// origin GET ?m=source&a=version 回應（schema pgc-source-version-v1）。
export interface OriginSourceVersion {
  schema?: string;
  source_lng: string;
  content_sha256: string; // "sha256:<64hex>"
}

// .onboard-status.yaml 記錄的 origin_source_version（{source_lng, content_sha256, recorded_at}）。
export interface OnboardOriginRecord {
  source_lng: string;
  content_sha256: string;
  recorded_at?: string;
}

// 本地 CLI 執行結果。
export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// 本地流程相依（可注入，供 TDD）。
export interface PublishLocalDeps {
  fetchOriginVersion: () => Promise<OriginSourceVersion>;
  readOnboardOriginVersion: () => Promise<OnboardOriginRecord | null>;
  pushBack: (opts: { force: boolean; reason?: string }) => Promise<CliRunResult>;
  pushDb: (opts: { force: boolean; reason?: string }) => Promise<CliRunResult>;
}

// 工具執行結果（回給 model / client 的結構化結果）。
export interface PublishResult {
  ok: boolean;
  message?: string;
  error?: string;
  forced?: boolean;
  details?: Record<string, unknown>;
}

const FORCE_REASON_MAX_BYTES = 512;

/** origin 內容版本相符：source_lng 一致 且 content_sha256 相等（凍結契約）。 */
export function sourceVersionMatches(
  origin: OriginSourceVersion,
  record: OnboardOriginRecord | null,
): boolean {
  return !!record
    && record.source_lng === origin.source_lng
    && record.content_sha256 === origin.content_sha256;
}

/**
 * 從 .onboard-status.yaml 文字解析 origin_source_version 區塊（最小 YAML 子集，
 * 只認頂層 origin_source_version 下縮排的 source_lng / content_sha256 / recorded_at）。
 * 無區塊或缺必填欄位回 null。
 */
export function parseOnboardOriginVersion(text: string): OnboardOriginRecord | null {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^origin_source_version:\s*$/.test(lines[i])) i++;
  if (i >= lines.length) return null;
  i++;

  let source_lng: string | undefined;
  let content_sha256: string | undefined;
  let recorded_at: string | undefined;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    // 回到頂層（無縮排）→ origin_source_version 區塊結束
    if (!/^\s/.test(line)) break;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (m) {
      const key = m[1];
      const raw = m[2].trim();
      const val = raw.replace(/^(['"])(.*)\1$/, "$2");
      if (key === "source_lng") source_lng = val;
      else if (key === "content_sha256") content_sha256 = val;
      else if (key === "recorded_at") recorded_at = val;
    }
    i++;
  }

  if (!source_lng || !content_sha256) return null;
  return recorded_at
    ? { source_lng, content_sha256, recorded_at }
    : { source_lng, content_sha256 };
}

/**
 * publish_confirmed 的核心決策流程（純邏輯 + 注入 deps）：
 *   驗證 force_reason → 讀 origin 版本 → 讀建置記錄 → 比對 →
 *   相符觸發 push-back→push-db；drift 需客戶原因，無原因拒絕。
 */
export async function runPublishFlow(
  deps: PublishLocalDeps,
  forceReasonRaw: unknown,
): Promise<PublishResult> {
  // 1. 驗證 force_reason（若有）
  const reason = String(forceReasonRaw ?? "").trim();
  if (reason && Buffer.byteLength(reason, "utf-8") > FORCE_REASON_MAX_BYTES) {
    return {
      ok: false,
      error: `force_reason 超過 ${FORCE_REASON_MAX_BYTES} bytes 上限`,
      details: { code: "invalid_input" },
    };
  }

  // 2. 讀 origin 當前內容版本
  let origin: OriginSourceVersion;
  try {
    origin = await deps.fetchOriginVersion();
  } catch {
    return {
      ok: false,
      error: "讀取 origin 內容版本失敗，請稍後重試",
      details: { code: "origin_version_error" },
    };
  }

  // 3. 讀建置記錄（無記錄 / 讀取失敗一律視為 drift，fail-closed）
  let record: OnboardOriginRecord | null = null;
  try {
    record = await deps.readOnboardOriginVersion();
  } catch {
    record = null;
  }

  const match = sourceVersionMatches(origin, record);

  // 4. drift → 需客戶原因；無原因 = 拒絕
  if (!match && !reason) {
    return {
      ok: false,
      error:
        "偵測到內容 drift：origin 來源語系內容在建置後已變更。若仍要發布，請客戶提供強制發布原因（force_reason）。",
      details: {
        code: "drift_requires_reason",
        recorded: record
          ? { source_lng: record.source_lng, content_sha256: record.content_sha256 }
          : null,
        current: { source_lng: origin.source_lng, content_sha256: origin.content_sha256 },
      },
    };
  }

  const opts = match ? { force: false } : { force: true, reason };

  // 5. push-back → push-db
  try {
    const back = await deps.pushBack(opts);
    if (back.exitCode !== 0) {
      return {
        ok: false,
        error: "preview push-back 失敗",
        details: { code: "push_back_failed", exitCode: back.exitCode, stderr: back.stderr },
      };
    }
  } catch {
    return {
      ok: false,
      error: "preview push-back 失敗",
      details: { code: "push_back_failed" },
    };
  }

  try {
    const db = await deps.pushDb(opts);
    if (db.exitCode !== 0) {
      return {
        ok: false,
        error: "preview push-db 失敗",
        details: { code: "push_db_failed", exitCode: db.exitCode, stderr: db.stderr },
      };
    }
  } catch {
    return {
      ok: false,
      error: "preview push-db 失敗",
      details: { code: "push_db_failed" },
    };
  }

  return {
    ok: true,
    message: match ? "發布已觸發（無 drift）" : "已依客戶原因強制發布",
    forced: !match,
    details: {
      source_lng: origin.source_lng,
      content_sha256: origin.content_sha256,
    },
  };
}

function publishConfirmedTool(deps: PublishLocalDeps): ToolDefinition {
  return defineTool({
    name: "publish_confirmed",
    label: "確認發布",
    description:
      "客戶明確確認後，將當前預覽內容發布回 demo。偵測到內容 drift 時，需客戶提供強制發布原因。",
    parameters: Type.Object({
      force_reason: Type.Optional(
        Type.String({
          description:
            "僅在偵測到內容 drift（origin 內容在建置後被改過）時需要：客戶說明為何仍要強制發布（會寫入審計 log）。",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await runPublishFlow(deps, params.force_reason);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  }) as ToolDefinition;
}

export function buildCustomerPublishTools(deps: PublishLocalDeps): ToolDefinition[] {
  return [publishConfirmedTool(deps)];
}

// ── 本地流程的實際 I/O（fetch origin + 讀 .onboard-status.yaml + spawn CLI）──

export function buildOriginVersionUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/readyscript/capps/pc2-p/service/?m=source&a=version`;
}

export function buildPushBackArgs(
  appName: string,
  opts: { force: boolean; reason?: string },
): string[] {
  const args = ["preview", "push-back", "--name", appName];
  if (opts.force) {
    args.push("--force");
    if (opts.reason) args.push("--reason", opts.reason);
  }
  return args;
}

export function buildPushDbArgs(
  appName: string,
  languages: string[],
  opts: { force: boolean; reason?: string },
): string[] {
  const args = ["preview", "push-db", "--name", appName, "--lng", languages.join(",")];
  if (opts.force) {
    args.push("--force");
    if (opts.reason) args.push("--reason", opts.reason);
  }
  return args;
}

export interface LocalPublishConfig {
  /** 專案目錄（.onboard-status.yaml 所在、CLI 執行處）。 */
  cwd: string;
  /** origin 站 base_url（PC2_SERVICE_HOST_ORIGINAL）。 */
  originBaseUrl: string;
  /** Bearer 站台 token（PC2_API_TOKEN）。 */
  siteToken: string;
  /** Fly app 名 → push-back / push-db 的 --name。 */
  appName: string;
  /** push-db 的語系清單（--lng 逗號串接）。 */
  languages: string[];
  /** 供測試替換 fetch。 */
  fetch?: typeof globalThis.fetch;
}

export function createLocalPublishDeps(config: LocalPublishConfig): PublishLocalDeps {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const originVersionUrl = buildOriginVersionUrl(config.originBaseUrl);

  async function fetchOriginVersion(): Promise<OriginSourceVersion> {
    const resp = await fetchImpl(originVersionUrl, {
      headers: { Authorization: `Bearer ${config.siteToken}` },
    });
    if (!resp.ok) throw new Error(`origin version HTTP ${resp.status}`);
    const data = (await resp.json()) as Record<string, unknown>;
    const source_lng = String(data.source_lng || "en");
    const content_sha256 = String(data.content_sha256 || "");
    if (!content_sha256) throw new Error("origin version missing content_sha256");
    return {
      schema: typeof data.schema === "string" ? data.schema : undefined,
      source_lng,
      content_sha256,
    };
  }

  async function readOnboardOriginVersion(): Promise<OnboardOriginRecord | null> {
    try {
      const text = await readFile(`${config.cwd}/.onboard-status.yaml`, "utf-8");
      return parseOnboardOriginVersion(text);
    } catch {
      return null;
    }
  }

  function runCli(
    args: string[],
    opts: { force: boolean; reason?: string },
  ): Promise<CliRunResult> {
    const full = args.slice();
    if (opts.force) {
      full.push("--force");
      if (opts.reason) full.push("--reason", opts.reason);
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: CliRunResult) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      const child = spawn("readyai-project", full, {
        cwd: config.cwd,
        env: { ...process.env, READYAI_SKIP_GLOBAL_SKILL_SYNC: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });
      child.on("error", (err) => done({ exitCode: -1, stdout, stderr: String(err) }));
      child.on("close", (code) => done({ exitCode: code ?? -1, stdout, stderr }));
    });
  }

  return {
    fetchOriginVersion,
    readOnboardOriginVersion,
    pushBack: (opts) =>
      runCli(buildPushBackArgs(config.appName, opts), opts),
    pushDb: (opts) =>
      runCli(buildPushDbArgs(config.appName, config.languages, opts), opts),
  };
}
