// src/server/customer-policy.ts
import type { ProfileFile } from "./profile-loader.js";

/** customer 安全模式判斷：以 profile 名為準（明確、不靠 UI 旗標推斷）。 */
export function isCustomerMode(
  profileName: string | undefined,
  _profileFile: ProfileFile | undefined,
): boolean {
  return profileName === "customer";
}

/** customer 模式下，WS message type 黑名單（繞過 agent 的直接操作通道）。 */
const BLOCKED_TYPES = new Set<string>([
  "bash", "list_dir", "cycle_model", "set_session_name",
  "new_session", "switch_session",
]);

/** customer 模式下封鎖的 slash command 名稱。 */
const BLOCKED_SLASH = new Set<string>([
  "login", "logout", "model", "scoped-models",
  "settings", "export", "import", "cwd",
  "session", "resume", "fork", "clone", "tree",
]);

export function isBlockedCustomerMessage(payload: any, isCustomer: boolean): boolean {
  if (!isCustomer) return false;
  const type = payload?.type;
  if (BLOCKED_TYPES.has(type)) return true;
  if (type === "slash_command" && BLOCKED_SLASH.has(String(payload?.name))) return true;
  return false;
}

const SCRUB_KEYS = ["model", "agentDir", "sessionDir", "homeDir", "cwd", "activeTools", "models", "scopedModels"];

/** customer 模式下，從送往 client 的 payload 移除會洩漏 host/model/tool 內情的欄位（server-side）。 */
export function scrubForCustomer<T extends Record<string, any>>(payload: T, isCustomer: boolean): T {
  if (!isCustomer || payload == null || typeof payload !== "object") return payload;
  const out: Record<string, any> = Array.isArray(payload) ? [...payload] : { ...payload };
  for (const k of SCRUB_KEYS) if (k in out) delete out[k];
  return out as T;
}

const REQUIRED_CUSTOMER_ENV = [
  "PI_WEBUI_PASSWORD", "PI_WEBUI_MODEL", "OPENROUTER_API_KEY",
  "PC2_SERVICE_HOST", "PC2_API_TOKEN", "PI_WEBUI_BASE_PATH", "PI_PROJECT_CWD",
];
/** customer 模式啟動前必備 env；回缺漏清單（非 customer 回空，不強制）。 */
export function missingCustomerSecrets(isCustomer: boolean, env: Record<string, string | undefined>): string[] {
  if (!isCustomer) return [];
  return REQUIRED_CUSTOMER_ENV.filter((k) => !env[k]);
}
