// src/server/customer-injection.ts
// 把 customer / customer-open 的注入邏輯從 index.ts 抽成純函式，方便單元測試。

import { buildCustomerApiTools } from "../tools/customer-api-tools.js";

export interface CustomerInjectionInput {
  isCustomer: boolean;
  customerOpen: boolean;
  sandboxTools?: unknown; // undefined = 無 sandbox
}

export function resolveCustomerInjection({ isCustomer, customerOpen, sandboxTools }: CustomerInjectionInput) {
  return {
    noExtensions: isCustomer && !customerOpen,
    noSkills:     isCustomer && !customerOpen,
    noTools:      (customerOpen ? undefined : ((sandboxTools || isCustomer) ? "builtin" : undefined)) as "builtin" | undefined,
    tools:        customerOpen ? ["read", "bash"] : (isCustomer ? ["upload_image"] : undefined),
    customTools:  sandboxTools ?? (customerOpen ? undefined : (isCustomer ? buildCustomerApiTools() : undefined)),
  };
}
