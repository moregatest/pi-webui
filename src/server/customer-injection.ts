// src/server/customer-injection.ts
// 把 customer / customer-open 的注入邏輯從 index.ts 抽成純函式，方便單元測試。

import { buildCustomerApiTools } from "../tools/customer-api-tools.js";

export interface CustomerInjectionInput {
  isCustomer: boolean;
  customerOpen: boolean;
  sandboxTools?: unknown; // undefined = 無 sandbox
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

export function resolveCustomerInjection({
  isCustomer,
  customerOpen,
  sandboxTools,
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

  // customer（非 open）：A1 鎖死——關 skills / extensions，工具面只暴露 upload_image。
  // 重點（spec 2026-07-01 修正）：即使 L2 強制了 sandbox（sandboxTools 有值），也*不*把 VM
  // read/bash 塞進來——否則 tools:["upload_image"] 白名單會篩掉 customTools 裡的 read/bash，
  // 反而讓 customer 變成零工具。customer 的工具面就是 upload_image；sandbox 在此純作隔離兜底。
  if (isCustomer) {
    return {
      noExtensions: true,
      noSkills: true,
      noTools: "builtin",
      tools: ["upload_image"],
      customTools: buildCustomerApiTools(),
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
