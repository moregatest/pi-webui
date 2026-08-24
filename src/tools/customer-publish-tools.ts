// src/tools/customer-publish-tools.ts
// PGC publish_confirmed agent tool — 客戶明確確認後走「本地流程」：
//   origin 來源語系版本比對 → preview push-back → push-db。
//   來源語系資料庫指紋 drift 時需客戶原因（force）；無原因 = 拒絕。
// baseline 落點 data/preview-meta.json 的 origin_source_version；它只用於 drift 協調，
// 不是永久 audit，也不能當成本次發布已套用目標內容的證據。

import { spawn } from "node:child_process";
import { readFile, writeFile, rename } from "node:fs/promises";
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
  writeRecordedOriginVersion: (version: RecordedOriginVersion) => Promise<void>;
  writeForcePublishAudit: (input: ForcePublishAuditInput) => Promise<void>;
  pushBack: (opts: { force: boolean; reason?: string }) => Promise<CliRunResult>;
  pushDb: (opts: { force: boolean; reason?: string }) => Promise<CliRunResult>;
}

// 工具執行結果（回給 model / client 的結構化結果）。
// 本地 CLI 目前沒有回傳可對照候選內容的權威 runner receipt；exit 0 / HTTP 200
// 只證明命令與傳輸被接受，所以只能回 triggered，不能回 succeeded。
export interface PublishResult {
  ok: boolean;
  /** triggered：發布命令已執行但內容尚未獲權威證據；origin_drift：drift 且無原因。 */
  status?: "triggered" | "origin_drift";
  message?: string;
  error?: string;
  forced?: boolean;
  /** triggered：origin 當前來源語系。 */
  source_lng?: string;
  /** 發布命令執行前觀察到的 origin 指紋；不是發布後內容證據。 */
  origin_sha_before?: string;
  /** CLI 結束後再次觀察到的 origin 指紋；未與候選內容對照，仍不是套用證據。 */
  origin_sha_observed_after?: string | null;
  /** after 指紋只是整庫觀察值；未與候選內容比對，指紋變化也不是套用證據。 */
  origin_sha_observed_after_reason?: string;
  /** 只有權威 receipt 或目標內容比對才能為 true；目前本地流程固定 false。 */
  content_verified?: boolean;
  /** origin_drift：建置記錄的來源語系資料庫指紋（無記錄為 null）。 */
  recorded_sha?: string | null;
  /** origin_drift：origin 當前來源語系資料庫指紋。 */
  current_sha?: string;
  details?: Record<string, unknown>;
  /** 權威資料列變更數；目前底層 receipt 未提供，明確回 unknown，不從 stdout 猜測。 */
  changed_records?: number | "unknown";
  changed_records_reason?: string;
}

const FORCE_REASON_MAX_BYTES = 512;

/** origin 來源語系資料庫指紋相符：source_lng 一致且 content_sha256 相等。 */
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

const CHANGED_RECORDS_REASON =
  "目前 CLI/runner receipt 未提供可驗證的資料列變更數，不能從 stdout 的檔案數或 HTTP 200 推算。";
const ORIGIN_SHA_OBSERVED_AFTER_REASON =
  "origin_sha_observed_after 若有值，只是發布指令結束後觀察到的 origin 來源語系資料庫整庫指紋，"
  + "未與候選內容比對；指紋即使變化也不代表候選內容已套用。null 表示無法取得觀察值。";

function triggeredResult(
  origin: OriginSourceVersion,
  forced: boolean,
  originShaObservedAfter: string | null,
  details: Record<string, unknown>,
  warning = "",
): PublishResult {
  return {
    ok: true,
    status: "triggered",
    message:
      "發布指令已觸發，但目前沒有可證明目標內容已套用的權威 receipt；"
      + "發布後 origin 資料庫指紋即使有觀察值，也未與候選內容比對，指紋變化不代表候選內容已套用；"
      + "不可僅憑 HTTP 200 或頁面可開啟就宣稱已完成上線。"
      + warning,
    forced,
    source_lng: origin.source_lng,
    origin_sha_before: origin.content_sha256,
    origin_sha_observed_after: originShaObservedAfter,
    origin_sha_observed_after_reason: ORIGIN_SHA_OBSERVED_AFTER_REASON,
    content_verified: false,
    changed_records: "unknown",
    changed_records_reason: CHANGED_RECORDS_REASON,
    details,
  };
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

  // 2. 讀 origin 當前來源語系資料庫指紋
  let origin: OriginSourceVersion;
  try {
    origin = await deps.fetchOriginVersion();
  } catch {
    return {
      ok: false,
      error: "讀取 origin 來源語系資料庫指紋失敗，請稍後重試",
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
        "偵測到資料庫指紋 drift：origin 來源語系資料庫指紋在建置後已變更，"
        + "可能包含 _version 等系統表／檔案層差異，不等同內容被修改。"
        + "若仍要發布，請客戶提供強制發布原因（force_reason）。",
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

  // 6. CLI 結束後重新觀察 origin 並回寫 drift baseline。這個觀察未與 preview
  //    候選內容對照，且 content_sha256 可能受暫時性 _version 資料影響，所以不能把它
  //    升格成發布成功證據。
  let newOrigin: OriginSourceVersion;
  try {
    newOrigin = await deps.fetchOriginVersion();
  } catch {
    return triggeredResult(
      origin,
      !match,
      null,
      { code: "post_origin_observation_failed", content_evidence: "unavailable" },
      "（警告：無法取得發布後 origin 觀察值。）",
    );
  }

  try {
    await deps.writeRecordedOriginVersion({
      source_lng: newOrigin.source_lng,
      content_sha256: newOrigin.content_sha256,
      recorded_at: new Date().toISOString(),
    });
  } catch {
    return triggeredResult(
      origin,
      !match,
      newOrigin.content_sha256,
      { code: "baseline_write_failed", content_evidence: "unavailable" },
      "（警告：drift 基準回寫失敗，後續可能誤報 drift。）",
    );
  }

  return triggeredResult(
    origin,
    !match,
    newOrigin.content_sha256,
    { code: "content_evidence_unavailable", content_evidence: "unavailable" },
  );
}

function publishConfirmedTool(deps: PublishLocalDeps): ToolDefinition {
  return defineTool({
    name: "publish_confirmed",
    label: "觸發發布",
    description:
      "客戶明確確認後觸發預覽內容發布回 demo。工具目前只會回 status=triggered；"
      + "exit 0 或 HTTP 200 不代表內容一致，不得據此宣稱已完成上線。"
      + "只有對外站的目標內容逐項比對或權威 runner receipt 才能證明發布成功。"
      + "偵測到來源語系資料庫指紋 drift 時，需客戶提供強制發布原因。",
    promptGuidelines: [
      "publish_confirmed 回傳 ok=true 只表示發布命令被接受；若 status=triggered 或 content_verified=false，"
      + "禁止向客戶宣稱內容已上線、發布成功、套用完成或已驗證。"
      + "只有對外站目標內容逐項比對或權威 runner receipt 才能宣稱發布成功。",
    ],
    parameters: Type.Object({
      force_reason: Type.Optional(
        Type.String({
          description:
            "僅在偵測到來源語系資料庫指紋 drift（可能含 _version 等系統表或檔案層差異）時需要："
            + "客戶說明為何仍要強制發布（會寫入審計 log）。",
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
  // --http：客戶預覽機沒有 origin 的 SSH 通道（也不該有），走 R2+HTTP+站台 token。
  // 少了它 CLI 會落到 SSH 分支要 ORIGIN_SSH_HOST，publish 直接失敗。
  const args = ["preview", "push-back", "--http", "--name", appName];
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
  // 注意：push-db 不加 --http——該指令本身已 HTTP 化（--host 是 no-op），CLI 沒有這個
  // flag，帶上會被 click 以 "No such option" 拒絕。它同樣讀 .env 的 ORIGIN_HOSTNAME。
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

  // args 已由 buildPushBackArgs / buildPushDbArgs 組妥（含 --force / --reason）；
  // 這裡不再附加，否則會送出重複的 --force --reason X --force --reason X。
  function runCli(args: string[]): Promise<CliRunResult> {
    const full = args;
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

  async function writeRecordedOriginVersion(version: RecordedOriginVersion): Promise<void> {
    const metaPath = `${config.cwd}/data/preview-meta.json`;
    // 讀現有 meta，合併更新 origin_source_version（保留其他 key 不動）
    let meta: Record<string, unknown> = {};
    try {
      const text = await readFile(metaPath, "utf-8");
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      // 檔案不存在或格式異常 → 從頭建立
    }
    meta.origin_source_version = {
      source_lng: version.source_lng,
      content_sha256: version.content_sha256,
      recorded_at: version.recorded_at ?? new Date().toISOString(),
    };
    // 原子寫入：先寫 tmp，再 rename 取代
    const tmpPath = `${metaPath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(meta, null, 2), "utf-8");
    await rename(tmpPath, metaPath);
  }

  return {
    fetchOriginVersion,
    readRecordedOriginVersion,
    writeRecordedOriginVersion,
    writeForcePublishAudit,
    pushBack: (opts) =>
      runCli(buildPushBackArgs(config.appName, opts)),
    pushDb: (opts) =>
      runCli(buildPushDbArgs(config.appName, config.languages, opts)),
  };
}
