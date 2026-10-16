// 客戶確認的 PGC 發布入口。CLI session 主持 scope、drift guard、audit 與內容驗證。
// 工具僅保存確認／候選對應，恢復時先查 status；不改寫 origin drift baseline。
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, link, unlink, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface CliRunResult { exitCode: number; stdout: string; stderr: string }
export interface PublishResult {
  ok: boolean;
  status?: "triggered" | "origin_drift" | "verified";
  publication_id?: string;
  stage?: string;
  candidate_digest?: string;
  scope?: "pgc";
  app?: string;
  origin?: string;
  languages?: string[];
  content_verified: boolean;
  confirmation_id?: string;
  tool_call_id?: string;
  version?: string;
  manifest_digest?: string;
  publication_evidence?: Record<string, unknown>;
  message?: string;
  error?: string;
  changed_records?: "unknown";
  details?: Record<string, unknown>;
}
interface PublishInput { reason?: string; confirmation_id?: string; publication_id?: string }
export interface PublishExecutionContext { toolCallId: string }
export interface PublishLocalDeps { publish: (input: PublishInput, context?: PublishExecutionContext) => Promise<PublishResult> }
/** 可替換的檔案開啟邊界；預設使用真實 FileHandle，包含每個必要 fsync。 */
export interface PublicationFileIO { open: typeof open }
export interface LocalPublishConfig {
  cwd: string;
  originBaseUrl: string;
  siteToken: string;
  appName: string;
  languages: string[];
  /** PGC_CONFIRMATION_ID；缺省 cli 不構成客戶確認的唯一身分。 */
  confirmationId?: string;
  /** 保留既有 config 相容；工具不自行連 origin 或寫 audit。 */
  fetch?: typeof globalThis.fetch;
}
interface PublicationData {
  publication_id?: string;
  stage: string;
  content_verified: boolean;
  candidate_digest: string;
  scope: "pgc";
  app: string;
  origin: string;
  languages: string[];
}
interface Mapping {
  schema: 1;
  confirmation_hash: string;
  publication_id: string;
  candidate_digest: string;
  scope: "pgc";
  app: string;
  origin: string;
  languages: string[];
}
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const isDigest = (value: unknown): value is string => typeof value === "string" && DIGEST.test(value);
const EXIT = { fatal: 1, needs_review: 2, reconcile: 3, retryable: 4 };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const failure = (code: string, error: string, id?: string): PublishResult => ({
  ok: false, content_verified: false, ...(id ? { publication_id: id } : {}), error, details: { code },
});
function originIdentity(raw: string): string {
  const u = new URL(raw);
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error("invalid origin");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}
function sameLanguages(a: unknown, b: string[]): boolean {
  return Array.isArray(a) && a.every(x => typeof x === "string")
    && new Set(a).size === a.length && a.length === b.length
    && [...a].sort().join(",") === [...b].sort().join(",");
}

/** 最後一個非空 stdout 行才是 adapter_output；進度文字和 stderr 不是證據。 */
function decode(result: CliRunResult): Record<string, any> {
  const last = result.stdout.trim().split(/\r?\n/).filter(line => line.trim()).at(-1);
  const envelope = JSON.parse(last || "null");
  if (!object(envelope) || typeof envelope.ok !== "boolean") throw new Error("invalid envelope");
  if (envelope.ok) {
    // 目前 adapter_output 使用 result；publication 契約使用 data。拒絕雙重權威。
    if (result.exitCode !== 0 || ("data" in envelope && "result" in envelope)) throw new Error("invalid success");
    const data = envelope.data ?? envelope.result;
    if (!object(data)) throw new Error("missing data");
    return { ok: true, data };
  }
  const error = envelope.error;
  if (!object(error) || !Object.hasOwn(EXIT, error.error_class)
    || result.exitCode !== EXIT[error.error_class] || typeof error.message !== "string"
    || typeof error.hint !== "string" || typeof error.retryable !== "boolean"
    || error.retryable !== (error.error_class === "retryable")) throw new Error("invalid failure");
  return { ok: false, error };
}
type CandidateData = Pick<PublicationData, "scope" | "app" | "origin" | "languages" | "candidate_digest">;
function validateCandidate(data: unknown, config: LocalPublishConfig): CandidateData {
  if (!object(data) || data.scope !== "pgc" || data.app !== config.appName
    || typeof data.origin !== "string" || originIdentity(data.origin) !== originIdentity(config.originBaseUrl)
    || !sameLanguages(data.languages, config.languages) || !isDigest(data.candidate_digest)) throw new Error("invalid candidate identity");
  return data as CandidateData;
}
function validateData(data: unknown, config: LocalPublishConfig, id?: string, digest?: string): PublicationData {
  validateCandidate(data, config);
  if (!object(data) || typeof data.stage !== "string" || !data.stage.trim() || typeof data.content_verified !== "boolean"
    || (id !== undefined && data.publication_id !== id)
    || (digest !== undefined && data.candidate_digest !== digest)) throw new Error("invalid identity/evidence");
  return data as PublicationData;
}
function fromEnvelope(envelope: Record<string, any>, config: LocalPublishConfig, id: string, digest: string): PublishResult {
  if (envelope.ok) {
    const data = validateData(envelope.data, config, id, digest);
    return {
      ok: true, status: "triggered", publication_id: id, stage: data.stage, candidate_digest: digest,
      scope: "pgc", app: data.app, origin: originIdentity(data.origin), languages: data.languages,
      // 本工具尚未接收 public/raw/normal/browser 證據；不能只升格 CLI 的布林值。
      content_verified: false, changed_records: "unknown",
      message: "發布命令已接受；尚無完整公開頁面與瀏覽器驗證，不可宣稱已完成上線。",
    };
  }
  const error = envelope.error;
  const details = object(error.details) ? error.details : {};
  const partial = object(details.publication) ? details.publication : details;
  let data: PublicationData | undefined;
  if ("publication_id" in partial) data = validateData(partial, config, id, digest);
  return {
    ok: false, publication_id: id, ...(data ? { stage: data.stage } : {}), candidate_digest: digest,
    ...(data ? { scope: data.scope, app: data.app, origin: originIdentity(data.origin), languages: data.languages } : {}),
    content_verified: false, error: error.message,
    ...(details.code === "source_drift" || (object(details.drift_gate) && details.drift_gate.result === "blocked")
      ? { status: "origin_drift" as const } : {}),
    details: {
      error_class: error.error_class, retryable: error.retryable, hint: error.hint,
      ...(typeof details.code === "string" ? { code: details.code } : {}),
    },
  };
}

function runCli(config: LocalPublishConfig, args: string[]): Promise<CliRunResult> {
  return new Promise(resolve => {
    const child = spawn("readyai-project", args, {
      cwd: config.cwd, env: { ...process.env, READYAI_SKIP_GLOBAL_SKILL_SYNC: "1" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let outputBytes = 0, oversized = false;
    // 不把上游 stderr、參數或 exception 暴露給 model。
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      outputBytes += Buffer.byteLength(d, "utf8");
      if (outputBytes > 16 * 1024 * 1024) { oversized = true; stdout = ""; child.kill(); return; }
      if (!oversized) stdout += d;
    });
    child.stderr?.resume();
    child.on("error", () => resolve({ exitCode: -1, stdout: "", stderr: "" }));
    child.on("close", code => resolve({ exitCode: oversized ? -1 : code ?? -1, stdout, stderr: "" }));
  });
}
function command(config: LocalPublishConfig, action: string, id?: string, reason?: string, expectedCandidateDigest?: string): string[] {
  const args = ["preview", "publication", action, "--name", config.appName, "--expected-origin", originIdentity(config.originBaseUrl)];
  if (action === "start" || action === "candidate") args.push("--scope", "pgc", "--lng", config.languages.join(","));
  if (id) args.push("--publication-id", id);
  if (id && (action === "start" || action === "resume" || action === "export-evidence")) {
    if (!isDigest(expectedCandidateDigest)) throw new Error("missing expected candidate digest");
    args.push("--expected-candidate-digest", expectedCandidateDigest);
  }
  if (reason) args.push("--force", "--reason", reason);
  args.push("--json");
  return args;
}

async function syncDirectory(path: string, io: PublicationFileIO): Promise<void> {
  const directory = await io.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

/** 原子建立唯讀 mapping，不存 token／原因／原始確認文字；既有紀錄絕不覆蓋。 */
async function mappingFile(config: LocalPublishConfig, mapping: Mapping, io: PublicationFileIO): Promise<{ existing: boolean; value: Mapping }> {
  const root = await realpath(config.cwd);
  for (const dir of [join(root, "data"), join(root, "data/customer-publications")]) {
    await mkdir(dir, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe mapping directory");
    // 既有 entry 也重做，修復前一次 mkdir 成功但 parent fsync 失敗的恢復路徑。
    await syncDirectory(dirname(dir), io);
  }
  const dir = join(root, "data/customer-publications");
  const path = join(dir, `${mapping.confirmation_hash}.json`);
  const temporary = join(dir, `.pending-${randomUUID()}`);
  let existing = false;
  try {
    const file = await io.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify(mapping)); await file.sync(); } finally { await file.close(); }
    try { await link(temporary, path); } catch (e) { if (e.code === "EEXIST") existing = true; else throw e; }
  } finally { await unlink(temporary).catch(e => { if (e.code !== "ENOENT") throw e; }); }
  const file = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077)) throw new Error("unsafe mapping file");
    const value = JSON.parse(await file.readFile("utf-8"));
    if (!object(value) || value.schema !== 1 || !ID.test(value.publication_id) || !isDigest(value.candidate_digest)
      || value.confirmation_hash !== mapping.confirmation_hash || value.scope !== "pgc"
      || value.app !== mapping.app || value.origin !== mapping.origin
      || !sameLanguages(value.languages, mapping.languages)
      || value.publication_id !== `pgc-${hash([mapping.confirmation_hash, value.candidate_digest])}`) throw new Error("invalid mapping");
    await syncDirectory(dir, io);
    return { existing, value: value as Mapping };
  } finally { await file.close(); }
}

/** Verified recovery reads an existing mapping; it never repairs/creates state. */
async function readMapping(config: LocalPublishConfig, confirmation: string, io: PublicationFileIO): Promise<Mapping | undefined> {
  if (!confirmation || confirmation === "cli") throw new Error("missing confirmation");
  const root = await realpath(config.cwd);
  const confirmationHash = hash(["pgc-confirmation-v1", config.appName, originIdentity(config.originBaseUrl), confirmation]);
  for (const dir of [join(root, "data"), join(root, "data/customer-publications")]) {
    let stat;
    try { stat = await lstat(dir); } catch (e) { if (e.code === "ENOENT") return undefined; throw e; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe mapping directory");
  }
  let file;
  try { file = await io.open(join(root, "data/customer-publications", `${confirmationHash}.json`), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) { if (e.code === "ENOENT") return undefined; throw e; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 65536
      || (process.getuid && stat.uid !== process.getuid())) throw new Error("unsafe mapping file");
    const value = JSON.parse(await file.readFile("utf-8"));
    if (!object(value) || value.schema !== 1 || value.confirmation_hash !== confirmationHash
      || value.scope !== "pgc" || value.app !== config.appName || value.origin !== originIdentity(config.originBaseUrl)
      || !sameLanguages(value.languages, config.languages) || !isDigest(value.candidate_digest)
      || value.publication_id !== `pgc-${hash([confirmationHash, value.candidate_digest])}`) throw new Error("invalid mapping");
    return value as Mapping;
  } finally { await file.close(); }
}

/** Schema validation complements producer byte checks; caller flags cannot supply proof. */
function verifiedExport(data: unknown, config: LocalPublishConfig, id: string, digest: string,
  confirmation: string, call: string): PublishResult {
  const base = validateData(data, config, id, digest);
  const d = data as Record<string, any>;
  if (d.ok !== true || d.status !== "verified" || base.stage !== "verified" || base.content_verified !== true
    || d.confirmation_id !== confirmation || d.tool_call_id !== call || !isDigest(d.manifest_digest)
    || typeof d.version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(d.version)) throw new Error("invalid export");
  const keys = ["publication_id", "confirmation_id", "candidate_digest", "app", "origin", "scope", "languages", "version", "manifest_digest"];
  const matches = (o: unknown) => object(o) && keys.every(k => JSON.stringify(o[k]) === JSON.stringify(d[k]));
  const proof = d.publication_evidence;
  if (!matches(proof) || proof.tool_call_id !== call || !["end", "ttl"].includes(proof.restored_by)
    || !Array.isArray(proof.routes) || !proof.routes.length || proof.routes.length > 16 || new Set(proof.routes).size !== proof.routes.length) throw new Error("invalid export binding");
  const languageSet = new Set<string>();
  for (const route of proof.routes) {
    if (typeof route !== "string") throw new Error("invalid route");
    const u = new URL(route);
    const lng = u.pathname.split("/")[1];
    if (u.origin !== originIdentity(config.originBaseUrl) || u.username || u.password || u.search || u.hash
      || !config.languages.includes(lng) || /[%\\]/.test(u.pathname) || u.pathname.split("/").slice(1,-1).some(p => !p || p.startsWith("."))) throw new Error("invalid route");
    languageSet.add(lng);
  }
  if (!sameLanguages([...languageSet], config.languages)) throw new Error("missing route language");
  const safePath = (p: unknown) => typeof p === "string" && p.length <= 2048
    && !/[\\:%?#\x00-\x1f\x7f]/.test(p) && p.split("/").every(s => s && !s.startsWith(".") && !/[ .]$/.test(s));
  const bareHash = (h: unknown) => typeof h === "string" && /^[a-f0-9]{64}$/.test(h);
  if (!Array.isArray(proof.manifest) || !proof.manifest.length || proof.manifest.length > 10000 || !Array.isArray(proof.readback)) throw new Error("missing manifest");
  const expected = new Map<string,string>(), actual = new Map<string,string>(), dbs: string[] = [];
  for (const row of proof.manifest) {
    if (!object(row) || !safePath(row.path) || !bareHash(row.sha256) || expected.has(row.path)) throw new Error("invalid manifest");
    if (row.kind === "db") {
      if (!config.languages.includes(row.lng) || row.path !== `db/${row.lng}`) throw new Error("invalid DB");
      dbs.push(row.lng);
    } else {
      const lower = row.path.toLowerCase();
      const ext = lower.split(".").at(-1);
      const image = row.path.startsWith("Templates/pic/") && ["jpg","jpeg","png","gif","webp","avif","bmp","ico","tif","tiff"].includes(ext);
      const attachment = row.path.startsWith("Templates/att/") && ["pdf","txt","csv","doc","docx","xls","xlsx","ppt","pptx","odt","ods","odp"].includes(ext);
      if (row.kind !== "file" || (!image && !attachment) || /(?:^|[./])(?:php\d*|phtml|phar|cgi|pl|py|sh|bash|exe|com|bat|cmd|asp|aspx|jsp|shtml|htaccess)(?:[./]|$)/i.test(row.path)
        || lower.includes(".sqlite") || /(?:^|\/)excel-last-/.test(lower)
        || (row.classification !== undefined && row.classification !== (image ? "image" : "attachment"))) throw new Error("invalid file scope");
    }
    expected.set(row.path,row.sha256);
  }
  if (!sameLanguages(dbs, config.languages)) throw new Error("missing DB coverage");
  for (const row of proof.readback) {
    if (!object(row) || actual.has(row.path) || !bareHash(row.sha256)) throw new Error("invalid readback");
    actual.set(row.path,row.sha256);
  }
  if (actual.size !== expected.size || [...expected].some(([p,h]) => actual.get(p) !== h)) throw new Error("readback mismatch");
  const cache = proof.cache;
  if (!object(cache) || !/^[a-fA-F0-9]{32}$/.test(cache.lease_id) || cache.version !== d.version || cache.effective_mode !== "normal") throw new Error("invalid cache");
  for (const a of ["begin","purge"]) {
    const op = cache[a];
    if (!object(op) || typeof op.request_id !== "string" || !ID.test(op.request_id) || op.lease_id !== cache.lease_id
      || op.version !== d.version || op.purged !== true) throw new Error("invalid cache operation");
  }
  if (cache.begin.request_id === cache.purge.request_id) throw new Error("duplicate request");
  const observations = new Set<string>(), artifacts = new Set<string>();
  for (const mode of ["raw","normal"]) {
    const batch = proof[mode];
    if (!object(batch) || !Array.isArray(batch.public) || !Array.isArray(batch.browser)
      || batch.public.length !== proof.routes.length || batch.browser.length !== proof.routes.length * 2) throw new Error("missing mode evidence");
    const pages = new Set<string>(), views = new Set<string>();
    for (const [kind, rows] of [["public",batch.public],["browser",batch.browser]] as const) for (const row of rows) {
      if (!matches(row) || row.mode !== mode || !proof.routes.includes(row.url) || typeof row.observation_id !== "string" || !row.observation_id
        || observations.has(row.observation_id) || !safePath(row.artifact) || !row.artifact.startsWith("artifacts/") || artifacts.has(row.artifact)) throw new Error("invalid observation");
      const a = row.artifact_identity;
      if (!matches(a) || a.mode !== mode || a.url !== row.url || a.observation_id !== row.observation_id || a.path !== row.artifact || !bareHash(a.sha256)) throw new Error("invalid artifact");
      observations.add(row.observation_id); artifacts.add(row.artifact);
      if (kind === "public") {
        if (row.http_status !== 200 || ["content_match","assets_match","db_match","seo_match"].some(k => row[k] !== true) || pages.has(row.url)) throw new Error("public mismatch");
        pages.add(row.url);
      } else {
        const size = row.viewport_size;
        if (row.passed !== true || row.interactions_passed !== true || !object(size) || !Number.isInteger(size.width) || !Number.isInteger(size.height)
          || size.height <= 0 || size.height > 16384 || size.width > 16384 || size.width * size.height > 32*1024*1024
          || !["desktop","mobile"].includes(row.viewport) || (row.viewport === "desktop" ? size.width < 1024 : size.width !== 390)
          || a.viewport !== row.viewport || JSON.stringify(a.viewport_size) !== JSON.stringify(size) || views.has(`${row.url}|${row.viewport}`)) throw new Error("browser mismatch");
        views.add(`${row.url}|${row.viewport}`);
      }
    }
    if (proof.routes.some(url => !pages.has(url) || !views.has(`${url}|desktop`) || !views.has(`${url}|mobile`))) throw new Error("incomplete matrix");
  }
  return { ok:true, status:"verified", publication_id:id, stage:"verified", content_verified:true,
    candidate_digest:digest, scope:"pgc", app:d.app, origin:d.origin, languages:d.languages,
    confirmation_id:confirmation, tool_call_id:call, version:d.version, manifest_digest:d.manifest_digest,
    publication_evidence:proof, changed_records:"unknown", message:"同一發布的完整實體證據已通過重新驗證。" };
}

export function createLocalPublishDeps(config: LocalPublishConfig, io: PublicationFileIO = { open }): PublishLocalDeps {
  return { async publish(input, context) {
    let id = input.publication_id;
    try {
      const origin = originIdentity(config.originBaseUrl);
      if (!config.appName || !config.languages.length || new Set(config.languages).size !== config.languages.length
        || !config.languages.every(l => /^[a-zA-Z0-9-]+$/.test(l))) return failure("invalid_config", "缺少正確的 app／語系設定", id);
      const confirmation = input.confirmation_id ?? config.confirmationId;
      if (!id && (!confirmation || confirmation === "cli")) return failure("confirmation_required", "請提供本次客戶明確確認的穩定 confirmation_id；重試沿用相同值。", id);
      // candidate 只讀本機候選內容；不能用帶 origin equality guard 的 dry-run 阻斷 own-write 後的恢復。
      const prepared = decode(await runCli(config, command(config, "candidate")));
      if (!prepared.ok) return { ...failure("candidate_unavailable", prepared.error.message, id), details: {
        code: typeof prepared.error.details?.code === "string" ? prepared.error.details.code : "candidate_unavailable",
        error_class: prepared.error.error_class, retryable: prepared.error.retryable, hint: prepared.error.hint,
      } };
      // candidate 就必須核對完整 target；內容指紋不代表已通過正式發布的 preflight。
      const candidate = validateCandidate(prepared.data, config).candidate_digest;
      let exists = !!id;
      let mappingToSync: Mapping | undefined;
      if (!id) {
        const confirmationHash = hash(["pgc-confirmation-v1", config.appName, origin, confirmation]);
        id = `pgc-${hash([confirmationHash, candidate])}`;
        const prior = await readMapping(config, confirmation, io);
        const stored = prior ? { existing: true, value: prior } : await mappingFile(config, {
          schema: 1, confirmation_hash: confirmationHash, publication_id: id, candidate_digest: candidate,
          scope: "pgc", app: config.appName, origin, languages: [...config.languages].sort(),
        }, io);
        if (prior) mappingToSync = prior;
        id = stored.value.publication_id;
        if (stored.value.candidate_digest !== candidate) return failure("candidate_changed", "同一確認的候選內容已變更，請重新取得客戶確認並使用新的 confirmation_id。", id);
        exists = stored.existing;
      }
      if (exists) {
        const status = decode(await runCli(config, command(config, "status", id)));
        if (!status.ok) {
          // 只有 CLI 明確確認 session 不存在，且有本機確認 mapping，才可同 ID start。
          if (!(input.publication_id === undefined && status.error.details?.code === "session_not_found")) {
            return fromEnvelope(status, config, id, candidate);
          }
        } else {
          const current = validateData(status.data, config, id, candidate);
          if (current.stage === "verified") {
            const mapping = confirmation && confirmation !== "cli" ? await readMapping(config, confirmation, io) : undefined;
            if (current.content_verified !== true || !mapping || mapping.publication_id !== id || mapping.candidate_digest !== candidate
              || !context || typeof context.toolCallId !== "string" || !context.toolCallId.trim()) return failure("evidence_binding_missing", "缺少同一確認與實際工具呼叫的既有對應，無法匯出驗證證據。", id);
            const args = command(config, "export-evidence", id, undefined, candidate);
            args.splice(args.length - 1, 0, "--confirmation-id", confirmation, "--tool-call-id", context.toolCallId);
            const exported = decode(await runCli(config, args));
            if (!exported.ok) return fromEnvelope(exported, config, id, candidate);
            return verifiedExport(exported.data, config, id, candidate, confirmation, context.toolCallId);
          }
          if (mappingToSync) await mappingFile(config, mappingToSync, io);
          const resumed = fromEnvelope(decode(await runCli(config, command(config, "resume", id, input.reason, candidate))), config, id, candidate);
          if (current.stage === "prepared" && !resumed.ok
            && resumed.details?.error_class === "reconcile" && resumed.details?.code === "preparation_incomplete") {
            // One exact-ID preparation repair. CLI rechecks all phases pending,
            // immutable bytes, and absence of audit/cache mutation intent.
            if (mappingToSync) await mappingFile(config, mappingToSync, io);
      return fromEnvelope(decode(await runCli(config, command(config, "start", id, input.reason, candidate))), config, id, candidate);
          }
          return resumed;
        }
      }
      if (mappingToSync) await mappingFile(config, mappingToSync, io);
      return fromEnvelope(decode(await runCli(config, command(config, "start", id, input.reason, candidate))), config, id, candidate);
    } catch {
      return failure("invalid_cli_output", "無法確認 publication 狀態或本機確認紀錄；請保留 ID 並查核後恢復，不可盲目重新發布。", id);
    }
  } };
}

export async function runPublishFlow(deps: PublishLocalDeps, reasonRaw: unknown, input: Record<string, unknown> = {}, context?: PublishExecutionContext): Promise<PublishResult> {
  if (Object.keys(input).some(k => !["force_reason", "confirmation_id", "publication_id"].includes(k))
    || (reasonRaw !== undefined && typeof reasonRaw !== "string")) return failure("invalid_input", "發布參數無效");
  const reason = (reasonRaw as string | undefined)?.trim();
  if (reason && Buffer.byteLength(reason, "utf-8") > 512) return failure("invalid_input", "force_reason 超過 512 bytes 上限");
  for (const key of ["confirmation_id", "publication_id"]) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || !(input[key] as string).trim()
      || Buffer.byteLength(input[key] as string, "utf-8") > 512)) return failure("invalid_input", `${key} 無效`);
  }
  const publication_id = (input.publication_id as string | undefined)?.trim();
  const confirmation_id = (input.confirmation_id as string | undefined)?.trim();
  if ((publication_id && !ID.test(publication_id)) || confirmation_id === "cli") return failure("invalid_input", "publication／confirmation ID 無效");
  return deps.publish({ reason, confirmation_id, publication_id }, context);
}

export function buildCustomerPublishTools(deps: PublishLocalDeps): ToolDefinition[] {
  return [defineTool({
    name: "publish_confirmed", label: "觸發發布",
    description: "客戶明確確認後，以單一 PGC publication session 發布圖片附件與指定語系 DB。提供穩定 confirmation_id，重試不得更換；恢復可提供 publication_id。drift 與強制發布審計由 CLI 主持。",
    promptGuidelines: ["status=triggered 或 content_verified=false 時，禁止宣稱已上線、發布成功或驗證完成。相同確認的候選變更需重新取得確認；409 不一定是 drift，不可自行加入 force。"],
    parameters: Type.Object({
      confirmation_id: Type.Optional(Type.String({ description: "本次客戶明確確認的唯一身分；重試沿用，候選變更需新的確認。PGC_CONFIRMATION_ID 缺省 cli 時必填。" })),
      publication_id: Type.Optional(Type.String({ description: "既有 publication ID；先查核 status 再恢復，不建立新 lease。" })),
      force_reason: Type.Optional(Type.String({ description: "僅在 CLI 回報來源語系資料庫指紋 drift 時，由客戶提供的強制發布原因；CLI 寫入審計。不可用來繞過 schema 或 lease 衝突。" })),
    }),
    async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await runPublishFlow(deps, params.force_reason, params, { toolCallId });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  }) as ToolDefinition];
}
