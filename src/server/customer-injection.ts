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
  /** 供測試注入 publish deps；undefined＝從 env＋data/preview-meta.json 解析；null＝不注入 publish tool。 */
  publishDeps?: PublishLocalDeps | null;
}

export interface CustomerInjectionResult {
  noExtensions: boolean;
  noSkills: boolean;
  noTools: "builtin" | undefined;
  tools: string[] | undefined;
  customTools: unknown;
  /**
   * 需與 index.ts 的 hostGuardTools / sandboxTools *併存* 的附加 custom tools。
   * 不塞進 customTools 的理由：index.ts 走 `customTools ?? hostGuardTools`，
   * customTools 一旦有值就會把 in-process L0/L1/L3 guarded read/bash 整組蓋掉。
   */
  extraTools?: unknown[];
}

/**
 * 合併 base custom tools（sandboxTools / hostGuardTools）與 extraTools。
 * 無 extraTools 時原樣回傳 base，維持 index.ts 既有 `?? hostGuardTools` 語義。
 */
export function mergeInjectedTools(base: unknown, extra: unknown[] | undefined): unknown {
  if (!extra || extra.length === 0) return base;
  const baseArr = Array.isArray(base) ? base : base == null ? [] : [base];
  return [...baseArr, ...extra];
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

export interface PreviewMetaConfig {
  appName?: string | null;
  sourceLng?: string | null;
}

/**
 * 從 data/preview-meta.json 文字解析 publish 所需欄位：
 *   - app_name（Fly app 名）
 *   - origin_source_version.source_lng（來源語系）
 * Phase 4 凍結契約：baseline 落點 preview-meta.json，不再讀 .onboard-status.yaml。
 */
export function parsePreviewMetaConfig(text: string | null): PreviewMetaConfig {
  const out: PreviewMetaConfig = {};
  if (!text) return out;

  let meta: unknown;
  try {
    meta = JSON.parse(text);
  } catch {
    return out;
  }
  if (!meta || typeof meta !== "object") return out;
  const m = meta as Record<string, unknown>;

  if (typeof m.app_name === "string" && m.app_name) out.appName = m.app_name;

  const ov = m.origin_source_version;
  if (ov && typeof ov === "object") {
    const o = ov as Record<string, unknown>;
    if (typeof o.source_lng === "string" && o.source_lng) out.sourceLng = o.source_lng;
  }
  return out;
}

/** 從 PC2_SERVICE_HOST 取 hostname 第一段 label 當 Fly app 名（缺 app_name 時的 fallback）。 */
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
  meta: PreviewMetaConfig,
  appCwd: string,
): LocalPublishConfig | null {
  const originBaseUrl = (env.PC2_SERVICE_HOST_ORIGINAL ?? "").trim();
  const siteToken = (env.PC2_API_TOKEN ?? "").trim();
  if (!originBaseUrl || !siteToken) return null;

  const sourceLng = (meta.sourceLng ?? "").trim() || "en";
  // preview-meta.json 無 languages 清單（Phase 4 契約：僅來源語系參與 drift 比對）
  const languages = [sourceLng];

  const appName = (meta.appName ?? "").trim()
    || subdomainOfHost(env.PC2_SERVICE_HOST)
    || "";

  const confirmationId = (env.PGC_CONFIRMATION_ID ?? "").trim() || "cli";

  return { cwd: appCwd, originBaseUrl, siteToken, appName, languages, confirmationId };
}

/** 預設 deps 解析：從 process.env + <appCwd>/data/preview-meta.json 建 publish deps。 */
function resolvePublishDepsFromEnv(): PublishLocalDeps | null {
  const appCwd = resolvePath(process.env.PI_PROJECT_CWD || process.cwd());
  let metaText: string | null = null;
  try {
    metaText = readFileSync(join(appCwd, "data", "preview-meta.json"), "utf-8");
  } catch {
    metaText = null;
  }
  const config = resolveLocalPublishConfig(
    process.env as Record<string, string | undefined>,
    parsePreviewMetaConfig(metaText),
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
  // publish_confirmed 也必須在這條分支注入：Fly preview 機的 ecosystem.config.cjs 固定
  // PI_WEBUI_SKILLS_OPEN=1，客戶端一律落在 customer-open，只在 plain customer 注入等於永不生效。
  if (isCustomer && customerOpen) {
    const deps = publishDeps === undefined ? resolvePublishDepsFromEnv() : publishDeps;
    const publishTools = deps ? buildCustomerPublishTools(deps) : [];
    return {
      noExtensions: false,
      noSkills: false,
      noTools: undefined,
      tools: publishTools.length > 0 ? ["read", "bash", "publish_confirmed"] : ["read", "bash"],
      customTools: sandboxTools ?? undefined,
      extraTools: publishTools.length > 0 ? publishTools : undefined,
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
