// src/server/customer-policy.ts
import type { ProfileFile } from "./profile-loader.js";

/** customer 安全模式判斷：以 profile 名為準（明確、不靠 UI 旗標推斷）。 */
export function isCustomerMode(
  profileName: string | undefined,
  _profileFile: ProfileFile | undefined,
): boolean {
  return profileName === "customer";
}
