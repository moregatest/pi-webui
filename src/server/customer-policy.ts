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
]);

export function isBlockedCustomerMessage(payload: any, isCustomer: boolean): boolean {
  if (!isCustomer) return false;
  const type = payload?.type;
  if (BLOCKED_TYPES.has(type)) return true;
  if (type === "slash_command" && BLOCKED_SLASH.has(String(payload?.name))) return true;
  return false;
}
