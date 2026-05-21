# Gondolin micro-VM Sandbox 整合設計文件

date: 2026-05-21
status: draft (待 review)

## 目標

為 pi-webui 加上可選的 micro-VM sandbox,把內建 read/write/edit/bash/ls/find/grep
工具的執行環境從 host 隔離到 Gondolin (`@earendil-works/gondolin`) 提供的 QEMU
micro-VM 內,以支援以下三種部署情境的安全需求:

1. **工程師本機**:預設不啟用,沿用現況直接跑 host
2. **後勤**:啟用 sandbox,把代理人能動到的檔案 / 指令圈在指定 workspace 內
3. **客戶**:啟用 sandbox,同上;為日後限制網路 egress 預留擴充點

啟用方式採 opt-in flag (`--sandbox`),與 `--password` 等既有旗標同風格,預設關閉。
未啟用時行為與今日 100% 一致,完全不 import gondolin、不檢查 QEMU。

## 非目標

- **網路 egress 控制**:MVP 維持 gondolin 預設「全開」,不接 httpHooks。未來可作擴充
- **secret 注入 / 加密交換**:不做 pi-chat 那套 `chat_request_secret` 流程
- **每個 session 一個 VM**:單 process 共用一個 VM
- **多 user runtime isolation**:每個 pi-webui 進程仍服務單 user(三種場景各自獨立部署)
- **VM 主動 restart**:不暴露 `/sandbox-restart` 之類指令;裝完 apk 套件想重置就重啟 server
- **`--cwd` 切換到 workspace 外的能力**:sandbox 模式下強制限制
- **動態 unmount/remount**:VM 啟動時 mount 一次,直到 server 結束
- **Windows 支援**:gondolin 不支援
- **CI 跑實機 VM 測試**:需要 QEMU、200MB image,留給本機/nightly
- **預先下載 guest image**:lazy boot,首次 tool call 才下載

## 架構

```
┌─────────────────────────────────────────────────────────────────┐
│ pi-webui 進程                                                    │
│                                                                  │
│  ┌──────────────────┐    ┌─────────────────────────────────┐    │
│  │ src/server/      │    │ src/server/sandbox.ts (新增)    │    │
│  │   index.ts       │    │                                 │    │
│  │                  │───▶│   class Sandbox                 │    │
│  │ createRuntime()  │    │     - ensureQemuInstalled()     │    │
│  │   if (--sandbox) │    │     - ensure() → VM (lazy)      │    │
│  │     tools=       │    │     - buildCustomTools(cwd)     │    │
│  │       sandbox    │    │     - close()                   │    │
│  │       .build...  │    │     - workspaceRoot (host)      │    │
│  │                  │    │     - guestPath(hostPath)       │    │
│  └──────────────────┘    │     - isInsideWorkspace(p)      │    │
│         │                │                                 │    │
│         │ customTools    │   uses @earendil-works/gondolin │    │
│         ▼                │     VM + RealFSProvider         │    │
│  pi SDK Session          └─────────────────────────────────┘    │
│  (createAgentSession                                            │
│   FromServices)                                                  │
└─────────────────────────────────────────────────────────────────┘
              │ vm.fs / vm.exec
              ▼
         QEMU micro-VM (Alpine)
              /workspace  ←──  host: <workspaceRoot>
```

### 組件

- **`src/server/sandbox.ts`** (新增):唯一引用 `@earendil-works/gondolin` 的檔案。
  封裝 VM lifecycle、host↔guest path 轉換、tool factory 注入。對外暴露 `Sandbox` class。
- **`src/server/index.ts`** (改):flag 解析 + `createRuntime` 內條件注入 +
  `/cwd` 守門 + server shutdown hook
- **`src/extension/index.ts`** (改):forward `--webui-sandbox`、
  `--webui-sandbox-workspace` 到對應 server flag
- **`test/sandbox.test.mjs`** (新增):純單元(無 QEMU)
- **`test/sandbox-vm.test.mjs`** (新增):整合,`SANDBOX_VM=1` opt-in

## CLI Flag / 環境變數

新增兩個 server flag,與既有風格一致:

| Flag | Env var | 預設 | 說明 |
|---|---|---|---|
| `--sandbox` | `PI_WEBUI_SANDBOX=1` | off | 啟用 Gondolin VM sandbox。內建 read/write/edit/bash/ls/find/grep 改走 VM |
| `--sandbox-workspace <dir>` | `PI_WEBUI_SANDBOX_WORKSPACE` | `<cwd>` | host 端要掛進 VM `/workspace` 的根目錄;必須是已存在的目錄;啟動時 resolve 成絕對路徑 |

extension 端 forward(仿 `--webui-password`):

- `--webui-sandbox` → server `--sandbox`
- `--webui-sandbox-workspace <dir>` → server `--sandbox-workspace <dir>`

env var 接受 `1` / `true` / `yes`(不分大小寫),其餘 falsy。

未開 `--sandbox` 時:

- 行為與今日完全一致
- 不檢查 QEMU、不 import gondolin、不增加冷啟動成本

## `Sandbox` 模組公開介面

```ts
// src/server/sandbox.ts

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface SandboxOptions {
  workspaceRoot: string;
  logger?: { info(...args): void; warn(...args): void; error(...args): void };
  // 測試用 DI:注入後 ensure() 不會動態 import gondolin、直接用 factory 產生 VM
  vmFactory?: () => Promise<unknown>;   // 回傳值需符合 gondolin VM 的 fs/exec/close 介面
}

export const GUEST_WORKSPACE = "/workspace";

export class Sandbox {
  readonly workspaceRoot: string;
  constructor(options: SandboxOptions);

  static ensureQemuInstalled(): void;

  ensure(): Promise<void>;
  buildCustomTools(hostCwd: string): Promise<ToolDefinition[]>;

  guestPath(hostPath: string): string;
  isInsideWorkspace(hostPath: string): boolean;

  close(): Promise<void>;
}
```

### 行為細節

- `constructor`:對 `workspaceRoot` 立刻 `realpathSync`,並驗證為已存在目錄。
  失敗就 throw(在 server 啟動期被攔住,印錯誤 + `exit(1)`)
- `static ensureQemuInstalled()`:同步 spawn `qemu-img --version` 與
  `qemu-system-{aarch64|x86_64}`(視 `process.arch`);任何一個缺就 throw,
  error message 帶平台對應的安裝提示 (mac: `brew install qemu`;
  linux: `sudo apt install qemu-system-arm qemu-utils`;
  其他: `Windows 目前不支援 sandbox`)
- `ensure()`:lazy boot,動態 `await import("@earendil-works/gondolin")`,
  呼叫 `VM.create({ vfs: { mounts: { "/workspace": new RealFSProvider(workspaceRoot) } } })`;
  並發呼叫用 `starting: Promise | undefined` field dedup
- `buildCustomTools(hostCwd)`:
  - 先 `ensure()`
  - 把 hostCwd 透過 `guestPath()` 轉成 `/workspace/<rel>`(不在 workspace 內就 throw)
  - 為每個 builtin tool 用 SDK 的 `createReadTool / createBashTool / createEditTool /
    createWriteTool / createLsTool / createFindTool / createGrepTool` 工廠包出
    `ToolDefinition`,operations 來自 vm.fs / vm.exec(實作參考 pi-chat 的
    `createReadOperations` 等)
  - 回傳完整 7 個 tool 的陣列
- `guestPath(hostPath)`:`realpathSync` 後比對 `workspaceRoot`,防 symlink 逃逸
- `isInsideWorkspace(hostPath)`:對外暴露給 `/cwd` 守門用,內部用 `path.relative`
  邊界檢查(注意 `/foo` vs `/foobar` 這種 prefix-not-subdir)
- `close()`:冪等;若 VM 已啟動就 `vm.close()`;starting 中就 await + close

### 安全邊界

- 所有 host path 轉換前都 `realpathSync`
- gondolin 動態 import — `--sandbox` 不開時整個套件不會被 require

### Tool 重啟 / 自動恢復

- VM 跑壞後,下一次 `ensure()` 偵測 stale 自動 reboot 一次
- 若 gondolin 提供 health check API 就用;否則靠 operations 包一層
  try/catch + dirty flag 觸發 reboot
- **二次失敗不再 retry** — 回 error 給使用者,由使用者操作觸發

## 整合 `createRuntime`

`src/server/index.ts` 改動位置(摘要):

```js
// 1. flag 解析
const cliSandbox = parseSandboxFlag(argv, process.env.PI_WEBUI_SANDBOX);
const cliSandboxWorkspace = parseSandboxWorkspace(
  argv, process.env.PI_WEBUI_SANDBOX_WORKSPACE, appCwd,
);

// 2. 啟動期預檢
let sandbox;
if (cliSandbox) {
  const { Sandbox } = await import("./sandbox.js");
  Sandbox.ensureQemuInstalled();    // 缺 qemu → throw → process exit
  sandbox = new Sandbox({ workspaceRoot: cliSandboxWorkspace, logger });
}

// 3. createRuntime 內注入
const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ /* ... */ });
  const customTools = sandbox ? await sandbox.buildCustomTools(cwd) : undefined;
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: cliModel,
      scopedModels,
      noTools: sandbox ? "builtin" : undefined,
      customTools,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

// 4. shutdown hook
async function shutdown() {
  if (sandbox) await sandbox.close().catch(() => {});
  // ... existing cleanup
}
```

## `/cwd` Slash Command 限制

守門邏輯放在 server-side(`src/server/index.ts` 的 `cwd` slash command handler),
client 端不需要新增任何檢查。失敗時 server 透過既有 slash command 回傳通道送
error string 給 client,client 用既有的錯誤渲染顯示在 chat。

```js
cwd: async (ctrl, arg) => {
  const resolved = resolveCwdInput(arg, ctrl.cwd);
  if (sandbox && !sandbox.isInsideWorkspace(resolved)) {
    return {
      error: `Sandbox mode: /cwd 只能切換到 ${sandbox.workspaceRoot} 之下的子路徑`,
    };
  }
  // ... 原有邏輯
}
```

效果:

- 沒開 sandbox → 行為與今日一致
- 開了 sandbox → `/cwd` 只能在 `workspaceRoot` 內子路徑切換;切到外面回錯,
  前端把 error 訊息顯示在 chat,不重建 runtime
- 想換根目錄 → 重啟 server 改 `--sandbox-workspace`

## Guest Image 下載 UX

Gondolin 首次 `VM.create()` 自動下載 ~200MB+ guest assets,本機 cache。

- **不做預下載**:server 啟動加 `--sandbox` 不會卡 200MB 下載
- **下載期間**:
  - server log: `[sandbox] downloading guest image (first run, ~200MB)...`
  - WebSocket: 送 `{ type: "sandbox_status", status: "preparing", message }`
  - client `app.js` 加 dispatcher case,在 chat 上方顯示 banner
    「正在準備 sandbox VM,首次需下載 ~200MB...」+ close 按鈕
  - 首次 tool call hang 數十秒到數分鐘是預期行為
- **下載完成**:`{ type: "sandbox_status", status: "ready" }`,client 移除 banner
- **下載失敗**:`{ type: "sandbox_status", status: "error", message }`,
  banner 顯示錯誤;server 不退出,下次 tool call 再 retry

## 錯誤處理

### 啟動期(process exit)

| 場景 | 行為 |
|---|---|
| `--sandbox` + 缺 QEMU | stderr 印安裝提示 + `exit(1)` |
| `--sandbox-workspace` 路徑不存在 / 不是目錄 / 無權限讀 | stderr 印錯 + `exit(1)` |

### 運行期(server 存活)

| 場景 | 行為 |
|---|---|
| 首次下載 guest image 失敗 | `buildCustomTools` throw → createRuntime 失敗 → WS `sandbox_status: error` + 原始訊息 |
| VM boot 失敗 | 同上 |
| Tool 執行中 VM crash | tool result 帶 error;下一次 tool call 觸發 reboot 一次 |
| 二次 reboot 失敗 | 不再 retry,使用者操作觸發 |
| `sandbox.close()` 失敗 | catch + log warn,不影響 shutdown |
| `/cwd` 切到 workspace 外 | slash command 回 error string,不 mutate runtime |

### 訊息可見性

- server log:所有 sandbox 事件用 `[sandbox]` prefix
- WebSocket:新型別 `sandbox_status` 是唯一 sandbox 對 client 的 channel
- Tool 失敗:走原本的 tool result error 路徑

### 明確排除

- 不做 retry 限速 / 指數退避
- 不做 health check polling
- 不暴露使用者主動觸發的 reboot UI

## 測試策略

### 純單元(無 QEMU,`make test` 預設跑)

`test/sandbox.test.mjs`:

| 測試 | 驗證 |
|---|---|
| Sandbox constructor | workspaceRoot 不存在 → throw;非目錄 → throw |
| `guestPath()` | 內 → 正確轉換;外 → throw;symlink 逃逸 → throw |
| `isInsideWorkspace()` | 邊界(`/foo` vs `/foobar`) |
| `ensureQemuInstalled` | 透過 mock 注入,測 throw + 各平台 hint |
| flag 解析 | `--sandbox` / env var 大小寫 / yes / true / 0;workspace 相對路徑 |

`test/server-cwd-sandbox.test.mjs`(或擴充現有 cwd 測試):

| 測試 | 驗證 |
|---|---|
| `/cwd` + 守門 | 內可切;外 → error string;不 mutate runtime |

DI 手法:`Sandbox` constructor 接可選 `vmFactory: () => Promise<VM>`,
測試用 fake VM(fake `vm.fs.*` / `vm.exec`)。

### 整合(實機 VM,opt-in)

`test/sandbox-vm.test.mjs`,`SANDBOX_VM=1` skip 控制:

- `ensure()` 真的 boot 一個 VM
- bash tool 跑 `echo hello` 得到正確 stdout
- write tool 寫檔,host workspaceRoot 看得到
- `close()` 把 VM 關掉

Makefile:

```makefile
test-sandbox: build
	SANDBOX_VM=1 node --test test/sandbox-vm.test.mjs
```

**不在 CI 跑** — 需要 QEMU、200MB,留給本機 / nightly。

### 不做

- 端到端(browser → WS → 真 VM)測試
- gondolin 套件本身的測試(信任上游)

## 向後相容

- `--sandbox` 未指定 → server 行為與今日完全一致,包括 import 圖、tool 集合、`/cwd` 行為
- 既有測試不受影響(都不開 sandbox)
- 既有 CLI flag、env var、extension flag 都不變

## 文件更新範圍

- `README.md`:新增 `--sandbox` / `--sandbox-workspace` / `PI_WEBUI_SANDBOX*` 表格列;
  新增「Sandbox 模式」一節說明三場景與 `/cwd` 限制、QEMU 安裝門檻、首次下載
- `ROADMAP.md`:`done` 區加 `[x] --sandbox / Gondolin micro-VM 整合`
- `CHANGELOG.md`:新版本紀錄
