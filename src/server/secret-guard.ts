// src/server/secret-guard.ts
//
// 防 agent 洩漏主機機密的核心純函式（對應 spec 2026-07-01-agent-secret-isolation-design）：
//   - L0 env allowlist：filterBashEnv / buildBashSpawnHook —— bash 子行程只帶正面表列白名單，
//     機密（OPENROUTER_API_KEY / PC2_SERVICE_PWS / R2_* …）不繼承。
//   - L1 read 圍欄：guardReadPath / wrapReadWithGuard —— read tool 目標須落在 workspaceRoot 內。
//   - L3 值遮蔽：SECRET_ENV_KEYS / redactBlocks / wrapToolWithRedaction —— tool 輸出把 L-甲 機密
//     「值」換成 «REDACTED»（送 model 與送 client 兩路都遮）。
//
// 刻意不 import pi SDK：本檔全部是可脫離 SDK 單元測試的純邏輯 + 對「tool 定義形狀」的薄包裝，
// SDK 的 createXxxToolDefinition 留在 index.ts 呼叫後再交給這裡包。

import { realpathSync } from "node:fs";
import path from "node:path";

// ───────────────────────── L0：bash env allowlist ─────────────────────────

/** 系統必需（非機密）＋ pi-webui 非機密設定 ＋ L-丙 拍板例外（ZYTE）。新增需 code review。 */
export const ENV_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // 系統必需（非機密）
  "PATH", "HOME", "TERM", "TMPDIR", "LANG", "SHELL", "USER", "LOGNAME", "PWD", "TZ",
  // pi-webui 非機密設定
  "PI_PROJECT_CWD", "PI_WEBUI_BASE_PATH", "PI_WEBUI_SANDBOX_WORKSPACE",
  // L-丙 接受的殘餘風險例外（使用者拍板；screenshot 需要）
  "ZYTE_API_KEY",
]);

/** 前綴白名單（locale 類）。 */
export const ENV_ALLOWLIST_PREFIX: readonly string[] = ["LC_"];

export interface EnvFilterOptions {
  /** sandbox bash：額外注入 READYAI_SANDBOX_MODE=1，讓 readyAI CLI 走 workspace .env、跳過 host home。 */
  sandbox?: boolean;
  /** 營運端在白名單之外額外放行的 key（非機密；來自 PI_WEBUI_BASH_ENV_ALLOW）。 */
  extraAllow?: Iterable<string>;
}

/**
 * 把 bash 子行程 env 從「繼承整個 process.env」改為正面表列白名單。
 * 白名單對「未來新增機密」天然免疫，比 denylist pattern fail-safe。
 */
export function filterBashEnv(
  env: NodeJS.ProcessEnv,
  opts: EnvFilterOptions = {},
): NodeJS.ProcessEnv {
  const extra = opts.extraAllow ? new Set(opts.extraAllow) : null;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (
      ENV_ALLOWLIST.has(k) ||
      ENV_ALLOWLIST_PREFIX.some((p) => k.startsWith(p)) ||
      (extra ? extra.has(k) : false)
    ) {
      out[k] = v;
    }
  }
  // 僅 sandbox bash 注入；host bash（開發者）有 host home，走 CLI 正常 fallback，不注入。
  if (opts.sandbox) out.READYAI_SANDBOX_MODE = "1";
  return out;
}

/** 解析 PI_WEBUI_BASH_ENV_ALLOW（逗號／空白分隔）為額外白名單 key 陣列。 */
export function parseEnvAllowList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return String(raw)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// bash spawn context 的最小形狀（對應 SDK BashSpawnContext）。
export interface BashSpawnContextLike {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface BuildSpawnHookOptions {
  sandbox?: boolean;
  /** 省略時自 process.env.PI_WEBUI_BASH_ENV_ALLOW 讀。 */
  extraAllow?: Iterable<string>;
  env?: NodeJS.ProcessEnv;
}

/**
 * 建 bash spawnHook：在 SDK spawn（host 或 sandbox 兩條路徑）前，把 ctx.env 過白名單。
 * SDK 的 resolveSpawnContext 會把 spawnHook 回傳的 env 交給 ops.exec（含 sandbox 的 per-exec
 * vm.exec）——故同一個 hook 能同時堵住 host local shell 與 sandbox per-exec 兩條 env 路徑。
 */
export function buildBashSpawnHook(
  opts: BuildSpawnHookOptions = {},
): (ctx: BashSpawnContextLike) => BashSpawnContextLike {
  const sourceEnv = opts.env ?? process.env;
  const extraAllow =
    opts.extraAllow ?? parseEnvAllowList(sourceEnv.PI_WEBUI_BASH_ENV_ALLOW);
  return (ctx) => ({
    ...ctx,
    env: filterBashEnv(ctx.env, { sandbox: opts.sandbox, extraAllow }),
  });
}

// ─────────────── L0 縱深：bash 命令圍欄（deny env 偵察）───────────────
//
// 定位：L2（Gondolin VM 硬邊界）在 Fly 無 nested KVM 缺席下的 in-process 縱深補強。
// filterBashEnv 只讓 bash「子行程繼承的 env」不含機密，擋不住 bash 去讀「主行程」的
// /proc/<pid>/environ，或用 printenv/env/declare 列舉。本圍欄補這一面：deny 已知 env
// 偵察手法，抬高被 prompt injection 誘導撈 L-甲 機密的門檻。
//
// ⚠️ deny-list 本質：可被變數拼接（p=printenv; $p）、字元插入（prin''tenv）、動態路徑
// （c=/proc/1/environ; cat $c）繞過。此為「抬高門檻」非「根治」——根治靠部署隔離
// （L-甲 共用機密不進 preview 機）與 L2（VM）。

// 讀行程 env/cmdline：任何命令含此路徑字面即擋（涵蓋 cat/strings/head/grep/od/重導向讀）。
const PROC_RECON_RE = /\/proc\/(\d+|self|thread-self)\/(environ|cmdline)\b/;
// 讀 workspace .env（含 PC2_API_TOKEN）：命令含 .env / .env.<x> 字面即擋（縱深，主防線在 L1 read 圍欄）。
// 排除範例檔（.env.example/.sample/.tpl/.dist）——慣例為假值、正當操作可能參照。
const DOTENV_RECON_RE = /(^|[\s'"/=(])\.env(\.(?!example|sample|tpl|dist|md)[A-Za-z0-9_]+)?(?![\w.])/;
// printenv 列舉。
const PRINTENV_RE = /\bprintenv\b/;
// 印所有變數含值/名的 builtin。
const DUMP_BUILTIN_RE = /\b(export\s+-p|declare\s+-p|typeset\s+-p|compgen\s+-v)\b/;

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** 以 shell 命令分隔符切「命令段」（近似，供裸 env/set 判斷）。 */
function splitCommandSegments(command: string): string[] {
  return command
    .split(/\|\||&&|[|;&\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 命令段是否為「裸 env 列舉」（env 後無要執行的命令，僅賦值/選項）。`env FOO=b cmd` 非列舉。 */
function isBareEnvEnumeration(segment: string): boolean {
  const tokens = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && ASSIGN_RE.test(tokens[i])) i++; // 跳過前置賦值
  if (tokens[i] !== "env") return false;
  i++;
  while (i < tokens.length) {
    const t = tokens[i];
    if (ASSIGN_RE.test(t) || t.startsWith("-")) { i++; continue; } // env 的賦值/選項
    return false; // 之後仍有要執行的命令 → env <cmd>，非列舉
  }
  return true; // env 後僅賦值/選項/空 → 列印環境
}

/** 命令段是否為「裸 set 列舉」（set 後無 -/+ 選項）。`set -e`/`set -o`/`set --` 非列舉。 */
function isBareSetEnumeration(segment: string): boolean {
  const tokens = segment.split(/\s+/).filter(Boolean);
  if (tokens[0] !== "set") return false;
  if (tokens.length === 1) return true;
  return !/^[-+]/.test(tokens[1]);
}

/**
 * bash 命令偵察圍欄：偵測 env/機密偵察手法回 block。定位見上方 block 註解——縱深、非根治。
 */
export function guardBashCommand(command: unknown): GuardVerdict {
  if (typeof command !== "string" || command.length === 0) return { block: false };
  if (PROC_RECON_RE.test(command)) return { block: true, reason: "proc environ/cmdline recon" };
  if (DOTENV_RECON_RE.test(command)) return { block: true, reason: ".env recon (含 workspace token)" };
  if (PRINTENV_RE.test(command)) return { block: true, reason: "printenv enumeration" };
  if (DUMP_BUILTIN_RE.test(command)) return { block: true, reason: "env dump builtin" };
  for (const seg of splitCommandSegments(command)) {
    if (isBareEnvEnumeration(seg)) return { block: true, reason: "env enumeration" };
    if (isBareSetEnumeration(seg)) return { block: true, reason: "set enumeration" };
  }
  return { block: false };
}

// ───────────────────────── L1：read workspace 圍欄 ─────────────────────────

// /proc/<pid>/environ、/proc/self/environ、/proc/thread-self/environ 一律擋（env 面備援）。
const PROC_ENVIRON_RE = /^\/proc\/(\d+|self|thread-self)\/environ$/;

// workspace 內 .env 家族一律擋（含 PC2_API_TOKEN，客戶取得＝繞過協作介面直打站台 API）。
// 排除範例檔（.env.example/.sample/.tpl/.dist——慣例假值）。basename 比對。
const DOTENV_BASENAME_RE = /^\.env(\.(?!example$|sample$|tpl$|dist$)[A-Za-z0-9_]+)?$/;

export interface GuardReadOptions {
  /** 額外放行的暫存目錄（預設 process.env.TMPDIR）；傳 null 明確關閉。 */
  tmpDir?: string | null;
}

export interface GuardVerdict {
  block: boolean;
  reason?: string;
}

// 盡力把 target 正規化成 realpath；目標不存在時對 parent realpath + basename（對齊
// sandbox.guestPath 的行為，讓「即將建立的新檔」也能判斷邊界）。失敗回 null。
function resolveRealForGuard(cwd: string, target: string): string | null {
  const abs = path.resolve(cwd, target);
  try {
    return realpathSync(abs);
  } catch {
    try {
      const realParent = realpathSync(path.dirname(abs));
      return path.join(realParent, path.basename(abs));
    } catch {
      return null;
    }
  }
}

/**
 * read tool 邊界判斷：realpath 正規化（解 ../ 與 symlink）後必須落在 workspaceRoot 內。
 * workspace 內全放行（含專案自身 .env 的 L-乙 憑證，對齊半信任）；workspace 外全擋
 * （L-甲 主機機密 ~/.ssh / ~/readyai.key / server .env）。比黑名單 fail-safe。
 */
export function guardReadPath(
  cwd: string,
  workspaceRoot: string,
  target: unknown,
  opts: GuardReadOptions = {},
): GuardVerdict {
  if (typeof target !== "string" || target.length === 0) {
    return { block: true, reason: "empty path" };
  }
  const abs = path.resolve(cwd, target);
  // 先擋 /proc/*/environ（即便 realpath 解不到也擋掉字面路徑）
  if (PROC_ENVIRON_RE.test(abs)) return { block: true, reason: "proc environ" };

  const real = resolveRealForGuard(cwd, target);
  if (real === null) return { block: true, reason: "unresolvable path" };
  if (PROC_ENVIRON_RE.test(real)) return { block: true, reason: "proc environ" };
  // .env 家族即使落在 workspace 內也擋（token 外洩缺口）——放在 workspace 邊界放行之前。
  if (DOTENV_BASENAME_RE.test(path.basename(real))) return { block: true, reason: ".env（含 workspace token）" };

  let root: string;
  try {
    root = realpathSync(workspaceRoot);
  } catch {
    root = path.resolve(workspaceRoot);
  }
  if (real === root || real.startsWith(root + path.sep)) return { block: false };

  // 可選：放行暫存目錄（暫存檔、staged 上傳）。
  const tmp = opts.tmpDir === undefined ? process.env.TMPDIR : opts.tmpDir;
  if (tmp) {
    let realTmp: string;
    try {
      realTmp = realpathSync(tmp);
    } catch {
      realTmp = path.resolve(tmp);
    }
    if (real === realTmp || real.startsWith(realTmp + path.sep)) return { block: false };
  }

  return { block: true, reason: "outside workspace" };
}

// ───────────────────────── L3：機密值遮蔽 ─────────────────────────

/**
 * 遮蔽清單只含 L-甲共用機密（這些在 process.env、customer 不該見）。
 * L-乙（PC2_API_TOKEN 等）走 workspace .env、不在 process.env，process.env[k] 拿不到值故不列入
 * （半信任下 customer 本就能 cat 自己 workspace .env，遮之無安全意義）。
 * 例外：LITELLM_API_KEY 雖屬 L-乙（per-preview virtual key），但啟動時走 process.env（見
 * customer-policy.ts REQUIRED_CUSTOMER_ENV），process.env[k] 拿得到值，故仍列入遮蔽。
 * 與 readyAI SECRET_KEY_PATTERN 同源；readyAI 新增機密 pattern 時同步這裡。
 */
export const SECRET_ENV_KEYS: readonly string[] = [
  "OPENROUTER_API_KEY",   // 過渡期：未遷移舊 preview 仍有，保留遮蔽
  "LITELLM_API_KEY",      // L-乙 per-preview virtual key，但走 process.env，L3 遮得到（PRD #1 story 12）
  "PI_WEBUI_PASSWORD",
  "PC2_SERVICE_PWS",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
];

export const REDACTION_PLACEHOLDER = "«REDACTED»";

// 內容 block 最小形狀（對應 SDK TextContent / ImageContent）。
export interface ContentBlockLike {
  type?: string;
  text?: string;
  [k: string]: unknown;
}

/**
 * 從 env 蒐集要遮蔽的機密「值」。只取長度 >= 8 的值（避免短值誤傷正常文字）；
 * 依長度遞減排序，長值先替換，避免短值是長值子字串時先破壞長值。
 */
export function collectSecretValues(
  env: NodeJS.ProcessEnv = process.env,
  keys: readonly string[] = SECRET_ENV_KEYS,
): string[] {
  const vals: string[] = [];
  for (const k of keys) {
    const v = env[k];
    if (typeof v === "string" && v.length >= 8) vals.push(v);
  }
  return vals.sort((a, b) => b.length - a.length);
}

/**
 * 把單一機密值展開成要遮蔽的變體：原值 ＋ base64 ＋ base64url ＋ hex。
 * 擋「取得單一機密值後編碼」的繞過（如 echo $VALUE | base64）。
 * ⚠️ 不擋「整段 /proc/environ 一次 base64」——整段編碼的位元組對齊使單值 base64 未必為其子字串；
 * 那條靠 guardBashCommand 擋 /proc/<pid>/environ 讀取源頭（兩者互補）。
 */
export function secretValueVariants(value: string): string[] {
  if (typeof value !== "string" || value.length === 0) return [value];
  const buf = Buffer.from(value, "utf8");
  const b64 = buf.toString("base64");
  const b64url = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const variants = [value, b64, buf.toString("hex")];
  if (b64url !== b64) variants.push(b64url);
  return variants;
}

/**
 * 蒐集所有要遮蔽的字串：L-甲 值 ＋ 其編碼變體，去重、長度>=8、長值優先
 * （避免短值是長值子字串時先破壞長值）。
 */
function collectRedactionTargets(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): string[] {
  const seen = new Set<string>();
  for (const v of collectSecretValues(env, keys)) {
    for (const variant of secretValueVariants(v)) {
      if (variant.length >= 8) seen.add(variant);
    }
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

/** 對單一字串做機密值替換（含編碼變體）。 */
export function redactText(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  keys: readonly string[] = SECRET_ENV_KEYS,
): string {
  if (typeof text !== "string" || text.length === 0) return text;
  let t = text;
  for (const v of collectRedactionTargets(env, keys)) {
    if (t.includes(v)) t = t.split(v).join(REDACTION_PLACEHOLDER);
  }
  return t;
}

/**
 * 對 content blocks 陣列（tool 輸出）遮蔽機密值。只動 text block；無機密或無變更時回原陣列
 * （不做無謂複製）。base64／編碼可繞過——L3 是兜底，源頭仍是 L0（拿不到 env）＋ L2（VM 隔離）。
 */
export function redactBlocks<T extends ContentBlockLike>(
  content: T[] | unknown,
  env: NodeJS.ProcessEnv = process.env,
  keys: readonly string[] = SECRET_ENV_KEYS,
): T[] | unknown {
  if (!Array.isArray(content)) return content;
  const secrets = collectRedactionTargets(env, keys);
  if (secrets.length === 0) return content;
  let changed = false;
  const out = content.map((b) => {
    if (!b || typeof b !== "object" || (b as ContentBlockLike).type !== "text") return b;
    const block = b as ContentBlockLike;
    if (typeof block.text !== "string") return b;
    let t = block.text;
    for (const v of secrets) {
      if (t.includes(v)) t = t.split(v).join(REDACTION_PLACEHOLDER);
    }
    if (t === block.text) return b;
    changed = true;
    return { ...block, text: t };
  });
  return changed ? out : content;
}

// ───────────────────────── tool 定義薄包裝 ─────────────────────────

// tool 定義的最小可包裝形狀（對應 SDK ToolDefinition，只取我們會動到的欄位）。
export interface ToolDefinitionLike {
  name: string;
  execute: (
    toolCallId: string,
    params: any,
    signal: any,
    onUpdate: ((partial: any) => void) | undefined,
    ctx: any,
  ) => Promise<any>;
  [k: string]: unknown;
}

/**
 * 包 read tool：execute 前先跑 guardReadPath，越界回 block 訊息（isError），否則轉呼原 execute。
 * 對所有模式套用（開發者 host fs、sandbox 走 VM 都掛同一層邊界語意）。
 */
export function wrapReadWithGuard<T extends ToolDefinitionLike>(
  def: T,
  cwd: string,
  workspaceRoot: string,
  opts: GuardReadOptions = {},
): T {
  return {
    ...def,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const target = params ? (params as { path?: unknown }).path : undefined;
      const verdict = guardReadPath(cwd, workspaceRoot, target, opts);
      if (verdict.block) {
        return {
          content: [
            {
              type: "text",
              text: `讀取遭拒:目標在 workspace 邊界之外 (${verdict.reason})`,
            },
          ],
          isError: true,
        };
      }
      return def.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

export interface RedactionOptions {
  env?: NodeJS.ProcessEnv;
  keys?: readonly string[];
}

/**
 * 包 tool：把 execute 的最終 content 與 onUpdate 的串流 content 都過 redactBlocks。
 * execute 回傳值即「送 model 那份」，故此包裝同時遮住送 model 與非串流的送 client 路徑；
 * 串流（tool_execution_update）另在 ui-profile.filterEvent 兜底。
 */
export function wrapToolWithRedaction<T extends ToolDefinitionLike>(
  def: T,
  opts: RedactionOptions = {},
): T {
  const env = opts.env ?? process.env;
  const keys = opts.keys ?? SECRET_ENV_KEYS;
  return {
    ...def,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const wrappedOnUpdate =
        typeof onUpdate === "function"
          ? (partial: any) =>
              onUpdate(
                partial && Array.isArray(partial.content)
                  ? { ...partial, content: redactBlocks(partial.content, env, keys) }
                  : partial,
              )
          : onUpdate;
      const result = await def.execute(toolCallId, params, signal, wrappedOnUpdate, ctx);
      if (result && Array.isArray(result.content)) {
        return { ...result, content: redactBlocks(result.content, env, keys) };
      }
      return result;
    },
  };
}

/**
 * 包 bash tool：execute 前先跑 guardBashCommand，偵察類命令回 block 訊息（isError）、不執行；
 * 否則轉呼原 execute。定位為 L0 縱深（見 guardBashCommand 上方註解）——非根治、抬高門檻。
 */
export function wrapBashWithCommandGuard<T extends ToolDefinitionLike>(def: T): T {
  return {
    ...def,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const command = params ? (params as { command?: unknown }).command : undefined;
      const verdict = guardBashCommand(command);
      if (verdict.block) {
        return {
          content: [
            {
              type: "text",
              text: `命令遭拒:疑似環境/機密偵察 (${verdict.reason})。客戶協作只需 readyai-* 工具，不需列舉環境變數或讀取機密檔。`,
            },
          ],
          isError: true,
        };
      }
      return def.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}
