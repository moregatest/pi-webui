// src/server/customer-injection.ts
// 把 customer / customer-open 的注入邏輯從 index.ts 抽成純函式，方便單元測試。

import { readFileSync } from "node:fs";
import { resolve as resolvePath, join } from "node:path";
import { buildCustomerApiTools } from "../tools/customer-api-tools.js";
import {
  buildCustomerPublishTools,
  createLocalPublishDeps,
  type LocalPublishConfig,
  type PublishLocalDeps,
} from "../tools/customer-publish-tools.js";

export interface CustomerInjectionInput {
  isCustomer: boolean;
  customerOpen: boolean;
  sandboxTools?: unknown; // undefined = 無 sandbox
  /** 供測試注入 publish deps；undefined＝從 env＋.onboard-status.yaml 解析；null＝不注入 publish tool。 */
  publishDeps?: PublishLocalDeps | null;
}

export interface CustomerInjectionResult {
  noExtensions: boolean;
  noSkills: boolean;
  noTools: "builtin" | undefined;
  tools: string[] | undefined;
  customTools: unknown;
}

/**
 * 無 effective sandbox 時,是否要注入 in-process guarded host read/bash（L0 env 白名單
 * + L1 read 圍欄 + L3 遮蔽,覆蓋 builtin）。
 *   - 有 sandboxTools（effective sandbox）：不需,已走 VM 版。
 *   - plain customer（isCustomer && !customerOpen）：只暴露 upload_image,不開 bash/read,不需。
 *   - 其餘（非 customer 開發者 / staff；customer-open 走 --allow-unsafe-customer 繞過 L2,
 *     如 Fly 無 KVM）：需要,用 in-process 三層補上 VM 拿掉後的防線。
 */
export function shouldInjectHostGuards(input: {
  hasSandboxTools: boolean;
  isCustomer: boolean;
  customerOpen: boolean;
}): boolean {
  return !input.hasSandboxTools && !(input.isCustomer && !input.customerOpen);
}

// ── publish_confirmed 的 LocalPublishConfig 解析 ──

export interface OnboardStatusConfig {
  flyApp?: string | null;
  sourceLng?: string | null;
  languages?: string[] | null;
}

function stripQuotes(s: string): string {
  return s.trim().replace(/^(['"])(.*)\1$/, "$2");
}

/**
 * 從 .onboard-status.yaml 文字解析 publish 所需欄位（最小 YAML 子集）：
 *   - stages.preview.fly_app（縮排 fly_app）
 *   - origin_source_version.source_lng（縮排 source_lng，優先）或頂層 lng
 *   - 頂層 languages 清單（若存在）
 */
export function parseOnboardStatusConfig(text: string | null): OnboardStatusConfig {
  const out: OnboardStatusConfig = {};
  if (!text) return out;

  const lines = text.split(/\r?\n/);
  let topLng: string | undefined;
  let originSourceLng: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const topLngMatch = line.match(/^lng:\s*(.*)$/);
    if (topLngMatch) topLng = stripQuotes(topLngMatch[1]);

    const srcLngMatch = line.match(/^\s+source_lng:\s*(.*)$/);
    if (srcLngMatch) originSourceLng = stripQuotes(srcLngMatch[1]);

    const flyAppMatch = line.match(/^\s+fly_app:\s*(.*)$/);
    if (flyAppMatch) out.flyApp = stripQuotes(flyAppMatch[1]);

    if (/^languages:\s*$/.test(line)) {
      const langs: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const li = lines[j];
        if (li.trim() === "") continue;
        const m = li.match(/^\s*-\s*(.+)$/);
        if (!m) break;
        langs.push(stripQuotes(m[1]));
      }
      if (langs.length > 0) out.languages = langs;
    }
  }

  if (originSourceLng) out.sourceLng = originSourceLng;
  else if (topLng) out.sourceLng = topLng;
  return out;
}

/** 從 PC2_SERVICE_HOST 取 hostname 第一段 label 當 Fly app 名（缺 fly_app 時的 fallback）。 */
export function subdomainOfHost(host: string | undefined): string | null {
  if (!host) return null;
  try {
    const url = new URL(host.includes("://") ? host : `https://${host}`);
    const h = url.hostname;
    if (h === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return null;
    const first = h.split(".")[0];
    return first && first !== "www" ? first : null;
  } catch {
    return null;
  }
}

/** 解析 LocalPublishConfig；缺 originBaseUrl / token 時回 null（不注入 publish tool）。 */
export function resolveLocalPublishConfig(
  env: Record<string, string | undefined>,
  onboard: OnboardStatusConfig,
  appCwd: string,
): LocalPublishConfig | null {
  const originBaseUrl = (env.PC2_SERVICE_HOST_ORIGINAL ?? "").trim();
  const siteToken = (env.PC2_API_TOKEN ?? "").trim();
  if (!originBaseUrl || !siteToken) return null;

  const sourceLng = (onboard.sourceLng ?? "").trim() || "en";
  const translations = (onboard.languages ?? [])
    .map((s) => s.trim())
    .filter((s) => s && s !== sourceLng);
  const languages = [sourceLng, ...translations];

  const appName = (onboard.flyApp ?? "").trim()
    || subdomainOfHost(env.PC2_SERVICE_HOST)
    || "";

  return { cwd: appCwd, originBaseUrl, siteToken, appName, languages };
}

/** 預設 deps 解析：從 process.env + <appCwd>/.onboard-status.yaml 建 publish deps。 */
function resolvePublishDepsFromEnv(): PublishLocalDeps | null {
  const appCwd = resolvePath(process.env.PI_PROJECT_CWD || process.cwd());
  let onboardText: string | null = null;
  try {
    onboardText = readFileSync(join(appCwd, ".onboard-status.yaml"), "utf-8");
  } catch {
    onboardText = null;
  }
  const config = resolveLocalPublishConfig(
    process.env as Record<string, string | undefined>,
    parseOnboardStatusConfig(onboardText),
    appCwd,
  );
  return config ? createLocalPublishDeps(config) : null;
}

export function resolveCustomerInjection({
  isCustomer,
  customerOpen,
  sandboxTools,
  publishDeps,
}: CustomerInjectionInput): CustomerInjectionResult {
  // customer-open：放行 skills + extensions，工具面 read/bash（走 sandbox=VM 版，同名覆蓋 builtin）。
  // 全開期靠 Fly 單客戶邊界 + 強制 effective sandbox（L2）；env/檔案隔離由 L0/L1/VM 兜底。
  if (isCustomer && customerOpen) {
    return {
      noExtensions: false,
      noSkills: false,
      noTools: undefined,
      tools: ["read", "bash"],
      customTools: sandboxTools ?? undefined,
    };
  }

  // customer（非 open）：A1 鎖死——關 skills / extensions，工具面暴露 upload_image + publish_confirmed。
  // 重點（spec 2026-07-01 修正）：即使 L2 強制了 sandbox（sandboxTools 有值），也*不*把 VM
  // read/bash 塞進來——否則 tools 白名單會篩掉 customTools 裡的 read/bash，反而讓 customer 零工具。
  if (isCustomer) {
    const apiTools = buildCustomerApiTools();
    const deps = publishDeps === undefined ? resolvePublishDepsFromEnv() : publishDeps;
    if (deps) {
      apiTools.push(...buildCustomerPublishTools(deps));
    }
    return {
      noExtensions: true,
      noSkills: true,
      noTools: "builtin",
      tools: deps ? ["upload_image", "publish_confirmed"] : ["upload_image"],
      customTools: apiTools,
    };
  }

  // 非 customer（開發者 / staff / brand …）：
  //   - 有 sandbox：走 VM 全套（noTools:"builtin" + sandboxTools 重註冊 read/write/edit/bash）。
  //   - 無 sandbox：customTools 回 undefined，由 index.ts 以 devGuardTools（同名覆蓋 read/bash）
  //     補上 in-process L0/L1/L3。
  return {
    noExtensions: false,
    noSkills: false,
    noTools: sandboxTools ? "builtin" : undefined,
    tools: undefined,
    customTools: sandboxTools ?? undefined,
  };
}
