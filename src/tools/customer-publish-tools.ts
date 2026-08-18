// src/tools/customer-publish-tools.ts
// PGC publish_confirmed agent tool — 客戶明確確認後走「本地流程」：
//   origin 來源語系版本比對 → preview push-back → push-db。
//   內容 drift 時需客戶原因（force）；無原因 = 拒絕。
// Phase 4 凍結契約：baseline 落點 data/preview-meta.json 的 origin_source_version；
//   輸出對齊 {ok:true,status:"succeeded",...} / {ok:false,status:"origin_drift",recorded_sha,current_sha}。

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

// data/preview-meta.json 的 origin_source_version（{source_lng, content_sha256, recorded_at}）。
// Phase 4 凍結契約：baseline 落點（preview up 時 deploy 前 fetch origin 寫入，隨 image 上機）。
export interface RecordedOriginVersion {
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

// 強制發布審計輸入（m=log&a=pgc-force-publish 的兩 hash + 客戶原因）。
export interface ForcePublishAuditInput {
  recorded: RecordedOriginVersion | null;
  current: OriginSourceVersion;
  reason: string;
}

// 本地流程相依（可注入，供 TDD）。
export interface PublishLocalDeps {
  fetchOriginVersion: () => Promise<OriginSourceVersion>;
  readRecordedOriginVersion: () => Promise<RecordedOriginVersion | null>;
  writeForcePublishAudit: (input: ForcePublishAuditInput) => Promise<void>;
  pushBack: (opts: { force: boolean; reason?: string }) => Promise<CliRunResult>;
  pushDb: (opts: { force: boolean; reason?: string }) => Promise<CliRunResult>;
}

// 工具執行結果（回給 model / client 的結構化結果）。
// Phase 4 凍結契約輸出：成功 → {ok:true,status:"succeeded",source_lng,content_sha256}；
// drift 無原因 → {ok:false,status:"origin_drift",recorded_sha,current_sha}。
export interface PublishResult {
  ok: boolean;
  /** 凍結契約狀態：succeeded（含強制發布）｜origin_drift（drift 且無原因）。 */
  status?: "succeeded" | "origin_drift";
  message?: string;
  error?: string;
  forced?: boolean;
  /** succeeded：origin 當前來源語系。 */
  source_lng?: string;
  /** succeeded：origin 當前來源語系內容 hash。 */
  content_sha256?: string;
  /** origin_drift：建置記錄的來源語系內容 hash（無記錄為 null）。 */
  recorded_sha?: string | null;
  /** origin_drift：origin 當前來源語系內容 hash。 */
  current_sha?: string;
  details?: Record<string, unknown>;
}

const FORCE_REASON_MAX_BYTES = 512;

/** origin 內容版本相符：source_lng 一致 且 content_sha256 相等（凍結契約）。 */
export function sourceVersionMatches(
  origin: OriginSourceVersion,
  record: RecordedOriginVersion | null,
): boolean {
  return !!record
    && record.source_lng === origin.source_lng
    && record.content_sha256 === origin.content_sha256;
}

/**
 * 從 data/preview-meta.json 文字解析 origin_source_version（JSON 物件：
 * {source_lng, content_sha256, recorded_at}）。缺必填欄位／非物件／非 JSON 回 null。
 */
export function parsePreviewMetaOriginVersion(text: string): RecordedOriginVersion | null {
  if (!text) return null;
  let meta: unknown;
  try {
    meta = JSON.parse(text);
  } catch {
    return null;
  }
  if (!meta || typeof meta !== "object") return null;
  const ov = (meta as Record<string, unknown>).origin_source_version;
  if (!ov || typeof ov !== "object") return null;
  const o = ov as Record<string, unknown>;
  const source_lng = typeof o.source_lng === "string" ? o.source_lng : "";
  const content_sha256 = typeof o.content_sha256 === "string" ? o.content_sha256 : "";
  const recorded_at = typeof o.recorded_at === "string" ? o.recorded_at : undefined;
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

  // 3. 讀建置記錄（data/preview-meta.json 的 origin_source_version；無記錄 / 讀取失敗
  //    一律視為 drift，fail-closed）
  let record: RecordedOriginVersion | null = null;
  try {
    record = await deps.readRecordedOriginVersion();
  } catch {
    record = null;
  }

  const match = sourceVersionMatches(origin, record);

  // 4. drift → 需客戶原因；無原因 = 拒絕（凍結契約輸出 origin_drift）
  if (!match && !reason) {
    return {
      ok: false,
      status: "origin_drift",
      error:
        "偵測到內容 drift：origin 來源語系內容在建置後已變更。若仍要發布，請客戶提供強制發布原因（force_reason）。",
      recorded_sha: record?.content_sha256 ?? null,
      current_sha: origin.content_sha256,
      details: {
        code: "drift_requires_reason",
        recorded: record
          ? { source_lng: record.source_lng, content_sha256: record.content_sha256 }
          : null,
        current: { source_lng: origin.source_lng, content_sha256: origin.content_sha256 },
      },
    };
  }

  // 4b. drift 且有 reason → 先在 tool 端寫強制發布審計（凍結契約 step 5：
  //     m=log&a=pgc-force-publish，who=confirmation_id, desc=reason, params=兩 hash）。
  //     機上 CLI 無 .onboard-status.yaml 不會寫 audit，故權威在 tool；寫失敗即中止。
  if (!match) {
    try {
      await deps.writeForcePublishAudit({
        recorded: record,
        current: origin,
        reason,
      });
    } catch {
      return {
        ok: false,
        error: "寫入強制發布審計失敗，已中止發布",
        details: { code: "force_audit_failed" },
      };
    }
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
    status: "succeeded",
    message: match ? "發布已觸發（無 drift）" : "已依客戶原因強制發布",
    forced: !match,
    source_lng: origin.source_lng,
    content_sha256: origin.content_sha256,
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

// ── 本地流程的實際 I/O（fetch origin + 讀 data/preview-meta.json + spawn CLI）──

export function buildOriginVersionUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/readyscript/capps/pc2-p/service/?m=source&a=version`;
}

/** m=log&a=pgc-force-publish 審計 URL（who/desc/params 走 URL 查詢參數）。 */
export function buildForcePublishAuditUrl(
  baseUrl: string,
  query: { who: string; desc: string; params: string },
): string {
  const sp = new URLSearchParams({
    m: "log",
    a: "pgc-force-publish",
    who: query.who,
    desc: query.desc,
    params: query.params,
  });
  return `${baseUrl.replace(/\/$/, "")}/readyscript/capps/pc2-p/service/?${sp.toString()}`;
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
  /** 專案目錄（data/preview-meta.json 所在、CLI 執行處）。 */
  cwd: string;
  /** origin 站 base_url（PC2_SERVICE_HOST_ORIGINAL）。 */
  originBaseUrl: string;
  /** Bearer 站台 token（PC2_API_TOKEN）。 */
  siteToken: string;
  /** Fly app 名 → push-back / push-db 的 --name。 */
  appName: string;
  /** push-db 的語系清單（--lng 逗號串接）。 */
  languages: string[];
  /** 強制發布審計 who 欄位（PGC_CONFIRMATION_ID），缺省 "cli"。 */
  confirmationId?: string;
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

  async function readRecordedOriginVersion(): Promise<RecordedOriginVersion | null> {
    try {
      const text = await readFile(`${config.cwd}/data/preview-meta.json`, "utf-8");
      return parsePreviewMetaOriginVersion(text);
    } catch {
      return null;
    }
  }

  async function writeForcePublishAudit(input: ForcePublishAuditInput): Promise<void> {
    const url = buildForcePublishAuditUrl(config.originBaseUrl, {
      who: config.confirmationId ?? "cli",
      desc: input.reason,
      params: JSON.stringify({
        recorded: input.recorded
          ? {
              source_lng: input.recorded.source_lng,
              content_sha256: input.recorded.content_sha256,
            }
          : null,
        current: {
          source_lng: input.current.source_lng,
          content_sha256: input.current.content_sha256,
        },
      }),
    });
    const resp = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${config.siteToken}` },
    });
    if (!resp.ok) throw new Error(`force publish audit HTTP ${resp.status}`);
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
    readRecordedOriginVersion,
    writeForcePublishAudit,
    pushBack: (opts) =>
      runCli(buildPushBackArgs(config.appName, opts), opts),
    pushDb: (opts) =>
      runCli(buildPushDbArgs(config.appName, config.languages, opts), opts),
  };
}
