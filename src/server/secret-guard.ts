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

// ───────────────────────── L1：read workspace 圍欄 ─────────────────────────

// /proc/<pid>/environ、/proc/self/environ、/proc/thread-self/environ 一律擋（env 面備援）。
const PROC_ENVIRON_RE = /^\/proc\/(\d+|self|thread-self)\/environ$/;

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
 * 與 readyAI SECRET_KEY_PATTERN 同源；readyAI 新增機密 pattern 時同步這裡。
 */
export const SECRET_ENV_KEYS: readonly string[] = [
  "OPENROUTER_API_KEY",
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

/** 對單一字串做機密值替換。 */
export function redactText(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  keys: readonly string[] = SECRET_ENV_KEYS,
): string {
  if (typeof text !== "string" || text.length === 0) return text;
  let t = text;
  for (const v of collectSecretValues(env, keys)) {
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
  const secrets = collectSecretValues(env, keys);
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
