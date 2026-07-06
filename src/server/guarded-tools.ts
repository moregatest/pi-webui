// src/server/guarded-tools.ts
// 把「掛了 L0/L1/L3 的 read/bash 工具組」從 index.ts 抽出成可匯出的工廠，
// 讓 server 與整合測試共用同一份 production 程式（避免測試複製組裝邏輯而 drift）。
//
// SDK 的 create*ToolDefinition 由 package root 直接匯出（見 index.d.ts），可直接 import。

import {
  createBashToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  buildBashSpawnHook,
  wrapReadWithGuard,
  wrapToolWithRedaction,
  wrapBashWithCommandGuard,
} from "./secret-guard.js";

// Sandbox 只取我們會用到的 operations 工廠（避免硬相依 sandbox.ts 型別）。
interface SandboxOpsLike {
  createReadOperations(): unknown;
  createWriteOperations(): unknown;
  createEditOperations(): unknown;
  createBashOperations(): unknown;
}

/**
 * sandbox 模式（customer / customer-open / 開發者+sandbox）的 read/write/edit/bash：
 *   L0 sandbox bash spawnHook 過 env 白名單（堵 per-exec options.env）＋注入 READYAI_SANDBOX_MODE=1；
 *   L0 縱深 bash 命令圍欄（擋 printenv/env 列舉、/proc/<pid>/environ 讀取）；
 *   L1 read 邊界圍欄；L3 read/bash 輸出遮蔽。write/edit 走 VM operations（不需遮）。
 */
export function buildSandboxGuardedTools(
  sandbox: SandboxOpsLike,
  cwd: string,
  workspaceRoot: string,
): unknown[] {
  const spawnHook = buildBashSpawnHook({ sandbox: true });
  return [
    wrapToolWithRedaction(
      wrapReadWithGuard(
        createReadToolDefinition(cwd, { operations: sandbox.createReadOperations() as any }) as any,
        cwd,
        workspaceRoot,
        // sandbox：read 走 VM，host TMPDIR 不在 VM mount 內，嚴格只認 workspace 邊界
        // （否則 TMPDIR 例外放行後 sandbox op 會對 VM 外路徑丟未捕捉例外）。
        { tmpDir: null },
      ),
    ),
    createWriteToolDefinition(cwd, { operations: sandbox.createWriteOperations() as any }),
    createEditToolDefinition(cwd, { operations: sandbox.createEditOperations() as any }),
    wrapBashWithCommandGuard(
      wrapToolWithRedaction(
        createBashToolDefinition(cwd, {
          operations: sandbox.createBashOperations() as any,
          spawnHook: spawnHook as any,
        }) as any,
      ),
    ),
  ];
}

/**
 * 開發者 / staff / brand 等非 sandbox、非 customer 模式，及 Fly 無 KVM 下 customer-open 走
 * --allow-unsafe-customer 繞過 L2 時：用同名 custom tool 覆蓋 builtin read/bash（SDK: customTools
 * 同名覆蓋 builtin），掛 in-process L0（env 白名單＋縱深命令圍欄）+L1+L3。write/edit 維持 builtin。
 */
export function buildHostGuardedTools(cwd: string, workspaceRoot: string): unknown[] {
  const spawnHook = buildBashSpawnHook({ sandbox: false });
  return [
    wrapToolWithRedaction(wrapReadWithGuard(createReadToolDefinition(cwd) as any, cwd, workspaceRoot)),
    wrapBashWithCommandGuard(
      wrapToolWithRedaction(createBashToolDefinition(cwd, { spawnHook: spawnHook as any }) as any),
    ),
  ];
}
