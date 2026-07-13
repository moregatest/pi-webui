# pi-webui 防 agent 洩漏主機機密：分模式防禦深度（env 白名單 ＋ read 圍欄 ＋ customer 強制 Gondolin ＋ 輸出遮蔽）

> **狀態**：設計 v3.1。v3 收三輪 code review（PC2 三層分類、fail-closed effective sandbox、sandbox bash 第二條 env 路徑、L3 三接點分工〔送 model／送 client／session log〕、ZYTE 拍板）。**v3.1（2026-07-06）補 Fly 無 nested KVM 現實**：L2 effective Gondolin 在 Fly Firecracker 不可用，改「部署隔離＋in-process 縱深」承擔，殘餘風險（共用 LLM key）誠實記錄——見文末〈Fly 無 nested KVM：L2 缺席下的實際防線〉。
> **範圍**：防止 coding agent 在對話中洩漏 pi-webui 主機的敏感環境變數與機密檔案。分「開發者模式（防 AI 誤觸）」與「customer 模式（防不信任客戶）」兩層強度。
> **不在範圍**：出站網路流量過濾、Gondolin/QEMU 逃逸漏洞、customer 之間隔離（single-tenant 已天然隔離）、登入 auth 強化、readyAI/readyscript 端機密治理。見文末 Out of Scope。
> **關聯 spec**：延伸 `2026-05-21-gondolin-sandbox-design.md`（沙盒）與 `2026-05-22-customer-ui-profile-design.md`（customer profile）；L3 遮蔽清單與 readyAI `2026-06-30-env-secret-sanitize-on-sync-design.md`（`SECRET_KEY_PATTERN`）同源。

## 背景

pi-webui 是把 `@earendil-works/pi-coding-agent`（`^0.74.x`）包成 web server 的產品，會開放給客戶／團隊使用。coding agent 具備 `bash`、`read` 等工具，執行在**與 web server 同一個 Node.js process、同一台主機**上。

主機上有 Ready Market 的 production 機密以 `process.env` 形式存在。agent 的 bash 子行程**預設繼承整個 `process.env`**（`getShellEnv()` 回 `{ ...process.env }`），一行 `printenv` 就能把全部機密傾印進對話——而對話會送往雲端 LLM、寫進 session log。這是本 spec 要封住的事故面。

這條防線與 readyAI 近期「`.env` secret 不落 R2」是同一主題（機密不外洩）的另一面向。

## 威脅模型

### 資產三層分類（本 spec 骨幹）

機密**不是一視同仁**，按「洩漏損害」與「customer 是否有正當使用需求」分三層：

| 層 | 例 | 對 customer/VM 的政策 | 理由 |
|----|----|--------------------|------|
| **L-甲 共用主機/origin 機密** | `OPENROUTER_API_KEY`、`PI_WEBUI_PASSWORD`、`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`、**`PC2_SERVICE_PWS`**；主機檔 `~/.ssh`、`~/.aws`、`~/readyai.key`、server 目錄 `.env` | **完全禁止**進 bash env、VM env、workspace `.env`、VM 掛載、任何白名單。僅存在於 L3 遮蔽清單 | 跨站/跨租戶共用，洩漏＝全體淪陷。customer 無正當需求 |
| **L-乙 per-preview scoped workspace 憑證** | `PC2_API_TOKEN`（**必須 scoped**）、`PC2_SERVICE_HOST`、`PI_PREVIEW_PUBLIC_URL` | 走 **workspace `.env`**（CLI 設 `READYAI_SANDBOX_MODE=1` 讀檔），**不進** process.env 白名單。VM 內可讀＝正常工作範圍 | 綁單一 preview/customer，洩漏侷限該站。customer 技能正當需要 |
| **L-丙 接受的殘餘風險例外** | `ZYTE_API_KEY` | 進 **bash env 白名單**（VM/bash 內可見） | 使用者拍板（見下）。共用但損害限於 Zyte 額度、可 rotate |

**關鍵分級（review 修正）**：
- **`PC2_SERVICE_PWS` 屬 L-甲**（origin 服務 master 密碼／hourly SC，`md5(pwd+'_'+ts)`，跨站）——**絕不**進 customer 任何可觸及範圍（含 workspace `.env`）。customer 技能走 **Bearer token（`PC2_API_TOKEN`）認證即可**，本就不需要 PWS。
- **`PC2_API_TOKEN` 屬 L-乙，且必須是 scoped**（該 preview/customer 的 token，**非** Ready Market 共用 master token）。**只允許 scoped token 走 workspace `.env`；共用 token 一律不得進 env/VM/workspace**。
- **`ZYTE_API_KEY` 屬 L-丙**：使用者拍板「共用金鑰接受進 VM（最快）」。**殘餘風險已接受並記錄**：共用 key 對半信任 customer 可見、外洩波及所有 preview；損害限於 Zyte 服務額度、可 rotate。與 L-甲 的差異：PWS 洩漏＝origin 主機淪陷（不可接受），ZYTE 洩漏＝第三方額度損耗（可控）。

### 半信任 customer 決策（使用者拍板）

workspace（＝客戶專案目錄）內客戶專案**自身**的 `.env`（僅含 L-乙 scoped 憑證）屬該 session 正常工作範圍，**刻意不隔離**。pi-webui 的 customer 為半信任（Ready Market 內部代操作或信任客戶）。此決策形塑 L1（workspace 邊界圍欄）與 L2（VM 掛整個 workspace）。**注意：workspace `.env` 只該有 L-乙，L-甲（尤其 PC2_SERVICE_PWS）不得寫入。**

### 對手與情境（對應「兩者都要」）

| 情境 | 對手 | 觸發 | 強度 |
|------|------|------|------|
| **防 AI 誤觸** | 信任開發者用 pi-webui，AI 手滑把機密吐進對話 | 開發者模式 | in-process 攔截即足 |
| **防不信任客戶** | 客戶／被 prompt injection 誘導的 agent **主動**撈機密 | customer / customer-open | in-process 會被繞過，**必須 VM 硬邊界** |

### 攻擊面三分（根本解不同，不可混談）

| 攻擊面 | 手法 | 根治 |
|--------|------|------|
| **env 面** | `printenv`／`$KEY`／`/proc/self/environ` | 子行程 spawn 時給白名單 env（機密不繼承）——in-process 可根治 |
| **檔案面** | `read` tool 或 `bash: cat` 讀 workspace 外主機機密 | read 圍欄擋 read tool、擋不住 bash cat；根治要 VM 不掛主機路徑 |
| **輸出面** | 機密值以其他形式出現在 tool 輸出/串流回對話 | L3 遮蔽兜底 |

**single-tenant 收窄威脅**：每個 Fly machine ＝ 一個客戶專案，客戶間天然隔離。威脅聚焦「客戶／被誘導的 agent 撈 **Ready Market 共用（L-甲）** 機密」。

### 關鍵事實（查證後，附接點）

- **agent in-process、bash 繼承整個 `process.env`**：`src/server/index.ts` `createAgentSessionFromServices()`；SDK `getShellEnv()` 回 `{ ...process.env }`。
- **readyAI CLI 已為 sandbox 設計「憑證走 workspace `.env`」**：`load_env_with_fallback()`（`readyAI/src/readyai/utils.py:20`）在 `READYAI_SANDBOX_MODE=1` 時**跳過 host home**、強制從 `/workspace/.env`（cwd）讀 `PC2_API_TOKEN` 等，找不到 raise。create/preview 已寫 `PC2_API_TOKEN`（scoped）／`PC2_SERVICE_HOST`／`PI_PREVIEW_PUBLIC_URL` 進 workspace `.env`（`project_manager.py:4711`/`4814`）。
- **既有防護（站在其上）**：`customer-policy.ts:5-10`/`45-50`（`isCustomerMode`/`isCustomerOpenMode`）、`customer-injection.ts:12-19`、`scrubForCustomer()`、`--safe-errors`、白名單、`index.ts:850-863` `--tunnel` 強制 `--sandbox`（`exit(2)`）。
- **sandbox lazy boot／fail-closed 缺口**：`index.ts:795-830` `let sandbox=null; if(sandboxEnabled){ try{ Sandbox.ensureQemuInstalled(); sandbox=new Sandbox(...) }catch{ sandboxInitError=...; /* 不退出 */ } }`。`new Sandbox()` 只是 constructor，**VM lazy boot 於首次 `sandbox.ensure()`**（`sandbox.ts:153`）。init 失敗後 `sandbox=null` 但 `sandboxEnabled` 仍 true。`index.ts:1021` `sandboxEnabled && sandbox ? buildSandboxCustomTools : undefined` → `sandbox=null` 時落 `undefined` → **保留 host bash、繼承完整 env**。`index.ts:1037` 已有正解 `sandboxEnabled && !!sandbox`。
- **sandbox bash 有第二條 env 路徑（review 修正）**：sandbox bash 的 `exec`（`sandbox.ts:337-350`）把 `options.env` 傳進 `vm.exec(env)`；`options.env` 來自 SDK `resolveSpawnContext`（`bash.js:98`）的 `{ ...getShellEnv() }`＝完整 host env。**與 `VM.create({env})` 是兩條獨立路徑**，兩條都要堵。此路徑走 `spawnHook`，故同一個 `filterBashEnv` 可堵。
- **`tool_result.content` 是 content blocks 陣列**：`types.d.ts:629-634`/`726-730` `content: (TextContent | ImageContent)[]`。streaming 走 `tool_execution_update.partialResult`（`bash.js` `onUpdate`，content 同為 blocks）。
- **event 轉送鏈（L3 接點）**：`onSessionEvent`（`index.ts:1844`）→ `eventLog.append`(原始) → `filterEvent`（`ui-profile.ts:237`）→ `sendJson`。`filterEvent` 回傳修改後 event **會被採用**（非只 drop，`message_update` 分支為實例）。`tool_result` 另有「送 model」路徑 `afterToolCall`→`emitToolResult`（採用 extension `on("tool_result")` 回傳）。`tool_execution_update` 為 SDK emit-only。
- **hook API `0.74.0` 相容 `0.64.0`**：`spawnHook`、`tool_call`、`tool_result`、`tool_execution_update`、`before_agent_start`、`setActiveTools`、`customTools` override 皆在。

## 決策：方案 C 「分模式防禦深度」

| 層 | 防護 | 治哪一面 | 開發者 | customer |
|----|------|---------|:------:|:--------:|
| **L0** | bash `spawnHook` env allowlist（host + sandbox 兩條路徑同套） | env 面**根治** | ✓ | ✓ |
| **L1** | `read` workspace 邊界圍欄（realpath） | 檔案面緩解 | ✓ | ✓ |
| **L3** | 機密值遮蔽：`on("tool_result")`（送 model）＋ `filterEvent`（送 client／streaming） | 輸出面兜底 | ✓ | ✓ |
| **L2** | **強制 Gondolin VM（effective）** | env+檔案**雙根治** | — | ✓ 強制 |

**為何分模式**：開發者信任、無主動繞過者，L0+L1+L3（純 in-process）足以防手滑；customer 不信任、in-process 皆可被繞過，**只有 VM 邊界是硬的**。

### 否決的替代方案

- **純 in-process**：`bash: cat` 繞過 read 圍欄、in-process 攔截與 agent 同信任域。不滿足「防不信任客戶」。
- **VM 常開（開發者也強制）**：浪費 QEMU 成本、拖慢迭代。YAGNI。
- **外部 permission 引擎**：pi 無內建、社群 extension；pi-webui 既有 `customer-policy`/`customer-injection` 更貼合。

## 設計 L0：bash `spawnHook` env allowlist（env 面根治）

把 bash 子行程 env 從「繼承整個 `process.env`」改為**正面表列白名單**。allowlist 對「未來新增機密」天然免疫，比 denylist pattern fail-safe。

**白名單（精確集合，新增需 code review）**：

```ts
// 示意
const ENV_ALLOWLIST = new Set([
  // 系統必需（非機密）
  "PATH", "HOME", "TERM", "TMPDIR", "LANG",
  // pi-webui 非機密設定
  "PI_PROJECT_CWD", "PI_WEBUI_BASE_PATH", "PI_WEBUI_SANDBOX_WORKSPACE",
  // L-丙 接受的殘餘風險例外（使用者拍板；screenshot 需要）
  "ZYTE_API_KEY",
]);
const ENV_ALLOWLIST_PREFIX = ["LC_"];

function filterBashEnv(env: NodeJS.ProcessEnv, opts?: { sandbox?: boolean }): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (ENV_ALLOWLIST.has(k) || ENV_ALLOWLIST_PREFIX.some(p => k.startsWith(p))) out[k] = v;
  }
  if (opts?.sandbox) out.READYAI_SANDBOX_MODE = "1";  // 僅 sandbox bash：CLI 走 workspace .env、跳過 host home
  return out;
}

const spawnHook: BashSpawnHook = (ctx) => ({ ...ctx, env: filterBashEnv(ctx.env, { sandbox: /* 依 tool 建立情境 */ }) });
```

**L-乙 憑證不進白名單、走 workspace `.env`**：`PC2_API_TOKEN`（scoped）、`PC2_SERVICE_HOST`、`PI_PREVIEW_PUBLIC_URL` 全**不列白名單**。sandbox bash 注入 `READYAI_SANDBOX_MODE=1`，readyAI CLI（`readyai-db`/`readyai-screenshot`/uploader）自 mounted workspace `.env` 讀。故 `printenv` **看不到** PC2_*（走檔案），CLI 仍能認證。

**L-甲 一律不進白名單**：`PC2_SERVICE_PWS`、`OPENROUTER_API_KEY`、`PI_WEBUI_PASSWORD`、`R2_*` 被 allowlist 天然擋掉。

**兩條 env 路徑都要掛（review P0-3）**：
- **host bash**（開發者非 sandbox）：`buildBashWithEnvFilter(cwd)` 用 `createBashToolDefinition(cwd, { spawnHook })`（`spawnHook` 不注入 SANDBOX_MODE——開發者有 host home，走正常 fallback）。
- **sandbox bash**（customer）：`buildSandboxCustomTools` 內建 sandbox bash 時**同樣掛 `spawnHook`**（`{ sandbox: true }`）。此舉堵住 `sandbox.ts:337-350` 的 per-exec 路徑（`options.env`＝`getShellEnv()` 灌進 `vm.exec`）——**不能只靠 `VM.create({env})`**。

**接點**：`index.ts:20-28`（import `createBashToolDefinition`）→ 新建 `buildBashWithEnvFilter(cwd)`；`buildSandboxCustomTools`（`:944`）建 sandbox bash 時帶入同一 `spawnHook`；於 `:1021-1033` 注入 `customTools`（配 `noTools:"builtin"`）。

## 設計 L1：`read` workspace 邊界圍欄（檔案面緩解）

override `read`，realpath 正規化後**必須落在 `workspaceRoot` 內**才放行，否則 `block`。workspace 內全放行（含專案 `.env` 的 L-乙 憑證，對齊半信任）、workspace 外全擋（L-甲 主機機密 `~/.ssh`/`~/readyai.key`/server `.env`）。比黑名單 fail-safe。

```ts
// 示意
function guardRead(cwd: string, workspaceRoot: string, path: string): { block: boolean; reason?: string } {
  const real = fs.realpathSync(resolve(cwd, path));            // 解 ../ 與 symlink
  if (/^\/proc\/(\d+|self)\/environ$/.test(real)) return { block: true, reason: "proc environ" };
  const root = fs.realpathSync(workspaceRoot);
  const inside = real === root || real.startsWith(root + "/");
  const allowExtra = process.env.TMPDIR && real.startsWith(fs.realpathSync(process.env.TMPDIR) + "/");
  return inside || allowExtra ? { block: false } : { block: true, reason: "outside workspace" };
}
```

**接點**：`noTools:"builtin"` ＋ `src/tools/customer-api-tools.ts` 旁 `buildGuardedReadTool(cwd, workspaceRoot)`，帶進 `customer-injection.ts:18` 的 `customTools`。**所有模式**都套。

**誠實記代價**：只擋 `read` tool；`bash: cat ~/.ssh/*`（workspace 外）繞得過。主機檔案面對不信任客戶的根治靠 L2。

## 設計 L2：customer 模式強制 effective Gondolin（檔案＋env 硬根治）

**強制邏輯（review P0-2：檢查 effective sandbox，非 flag）**，沿用 `--tunnel` pattern（`index.ts:850-863` 之後）：

```ts
// 示意
const allowUnsafeCustomer = !!args.allowUnsafeCustomer || process.env.PI_WEBUI_ALLOW_UNSAFE_CUSTOMER === "1";
// sandbox 物件已於 :795-830 建好（成功則非 null，QEMU/init 失敗則為 null）
if (isCustomer && !(sandboxEnabled && sandbox) && !allowUnsafeCustomer) {
  process.stderr.write(
    "error: customer profile requires an EFFECTIVE sandbox (QEMU init must succeed).\n" +
    "       sandboxEnabled flag alone is insufficient; sandbox object is null on init failure.\n" +
    "       fix QEMU/image, or pass --allow-unsafe-customer to bypass (NOT recommended).\n",
  );
  process.exit(2);   // fail-closed
}
```

**eager boot 確認（因 lazy boot）**：`new Sandbox()` 不啟動 VM。customer session 建立前應 **eager `await sandbox.ensure()`**（觸發實際 boot），boot 失敗一律 fail-closed（拒開 session），**不得**落回 host bash。這堵住「flag 開、constructor 成功、但 VM 實際起不來」的殘餘破口。

**VM env 白名單 ＋ per-exec 過濾（呼應 L0）**：`VM.create({ env })`（`sandbox.ts:387-404`）只給白名單；**且** sandbox bash 的 per-exec 路徑（`options.env`）經同一 `filterBashEnv`（見 L0）。兩條都堵，VM 內 `printenv` 只見白名單（＋ ZYTE）＋ workspace `.env`（L-乙）。

**掛載邊界**：VM 僅掛 `workspaceRoot`。L-甲 主機機密在 workspace 外、**不進 VM**。workspace `.env`（僅 L-乙）VM 內可讀＝半信任預期。

## 設計 L3：機密值遮蔽（輸出面兜底，三接點分工）

對輸出掃描已知機密**值**遮蔽。清單**只含 L-甲共用機密**（這些在 `process.env`，L3 讀得到；L-乙 走 workspace `.env`、不在 `process.env`，見承諾範圍）：

```ts
// 示意
const SECRET_ENV_KEYS = [                        // 僅 L-甲（在 process.env、customer 不該見）
  "OPENROUTER_API_KEY", "PI_WEBUI_PASSWORD", "PC2_SERVICE_PWS",
  "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
];
function redactBlocks(content) {                 // content: (TextContent | ImageContent)[]
  if (!Array.isArray(content)) return content;
  return content.map(b => {
    if (b?.type !== "text" || typeof b.text !== "string") return b;
    let t = b.text;
    for (const k of SECRET_ENV_KEYS) { const v = process.env[k]; if (v && v.length >= 8) t = t.split(v).join("«REDACTED»"); }
    return { ...b, text: t };
  });
}
```

**三接點分工（review P1-1：`tool_execution_update` 是 SDK emit-only，extension return 無效）**：

| 目標 | 接點 | 機制（查證） |
|------|------|------|
| 防機密進 **LLM context**（送 model） | extension `on("tool_result")` return `{content}` | `afterToolCall`→`emitToolResult` 採用回傳（`agent-session.js:191`／`runner.js:546`）。**唯一能改「送 model 那份」的點** |
| 防機密送 **client 顯示**（含 streaming） | pi-webui **`filterEvent`**（`ui-profile.ts:237`）改 event 後 return | `onSessionEvent`（`index.ts:1852`）採用回傳的 event。**`tool_execution_update` 只能在此遮**——SDK `emit()`（`runner.js:476`）丟棄其 handler 回傳 |
| **session log** | `eventLog.append` 在 `filterEvent` **之前**（`index.ts:1849`）存原始 | **L3 不涵蓋**（見承諾範圍） |

```ts
// 送 model：extension（SDK 採用回傳）
pi.on("tool_result", (e) => ({ content: redactBlocks(e.content) }));

// 送 client／streaming：改 pi-webui filterEvent 的 tool_execution_update 分支
//   現況 ui-profile.ts:248 只在 hideToolCalls 時 drop；改為 hideToolCalls=false 時 redact 再送：
if (event.type === "tool_execution_update") {
  if (!profile.hideToolCalls)
    return { kind: "event", event: { ...event,
      partialResult: { ...event.partialResult, content: redactBlocks(event.partialResult?.content) } } };
  return null;  // hideToolCalls 維持 drop
}
```

**L3 承諾範圍（review P1-2）**：
- **遮**：`process.env` 的 **L-甲共用機密**（兜底：萬一 L0/L2 有漏，機密不至於進 LLM／client）。
- **不承諾遮 L-乙 workspace 憑證**（`PC2_API_TOKEN` 等）：不在 `process.env`（走 workspace `.env`），`process.env[k]` 拿不到值故無法遮；且半信任下 customer 本就能 `cat` 自己 workspace `.env`，遮之無安全意義。**故從清單移除**。
- **session log 存原始**：`eventLog` 在 `filterEvent` **前** append、未遮蔽。log 屬主機本地、customer 觸及不到（L1／L2 擋 workspace 外）；但**若 log 外送**（同步／上傳雲端）需另 sanitize——歸 readyAI 機密治理線（見 Out of Scope）。若要 log 也遮，於 `eventLog.append`（`index.ts:1849`）前套同一 `redactBlocks`。

**代價**：只遮已知值；base64／編碼可繞過。故 L3 是兜底，源頭仍是 L0（拿不到 env）＋ L2（VM 隔離）。ZYTE（L-丙）已接受在 env 可見，不強制遮。

## 分模式切換總表

| | 開發者 | customer | customer-open |
|---|:---:|:---:|:---:|
| 開放 tool | 全部 | 僅 `upload_image` | `read`+`bash` |
| L0 env allowlist（host bash） | ✓ | —（不開 bash） | —（bash 走 sandbox 版） |
| L0 env allowlist（sandbox bash per-exec） | 選用 | —（不開 bash） | ✓ |
| L1 read workspace 圍欄 | ✓ | ✓ | ✓ |
| L3 輸出＋串流遮蔽 | ✓ | ✓ | ✓ |
| **L2 強制 effective Gondolin** | 否 | **強制** | **強制** |

判定沿用 `customer-policy.ts` 的 `isCustomerMode`/`isCustomerOpenMode`（`index.ts:970-971`）。

## 測試策略（守紅線）

1. **L0 env 根治**：注入假 `PC2_SERVICE_PWS`/`OPENROUTER_API_KEY`/`PC2_API_TOKEN` 到 `process.env` → bash `printenv`/`echo $X`/`cat /proc/self/environ` → **不含**任一值。白名單（`PATH`、`ZYTE_API_KEY`）在。
2. **L0 sandbox bash per-exec**：sandbox bash（非只 VM.create）`printenv` 同樣不含 L-甲/L-乙 值——證第二條路徑已堵。
3. **L1 圍欄**：`read` workspace 外 `~/.ssh/id_rsa`/`~/readyai.key`/`../../etc/passwd`/`/proc/1/environ` → `block`；workspace 內專案檔（含 `.env`）放行。
4. **L2 fail-closed（flag 開但 init 失敗）**：模擬 `sandboxEnabled=true, sandbox=null` → customer session **拒絕**（`exit(2)` 或拒開），**不落回 host bash**。
5. **L2 VM 隔離**：customer+effective sandbox 下 `printenv` 無 L-甲/L-乙；`cat ~/.ssh/*`/`~/readyai.key` 在 VM 不存在。
6. **workspace `.env` 內容紅線**：workspace `.env` **有** `PC2_API_TOKEN`(scoped)（功能）、**無** `PC2_SERVICE_PWS`（L-甲 不得寫入）。
7. **L3 兩接點遮蔽**：注入 L-甲 值 → (a) `on("tool_result")` return 後**送 model** 的 content 被遮；(b) `filterEvent` 對 `tool_execution_update`（`hideToolCalls=false`）與 tool 輸出 text block 遮。**L-乙 `PC2_API_TOKEN` 不在遮蔽範圍**（走 workspace `.env`、不在 `process.env`）。註記：session log（`eventLog`）存原始，非本紅線範圍。

## 驗收條件（E2E：隔離啟用後 customer 技能仍須全綠）

> 補**實機 preview（Fly）**端到端驗收：L0–L3＋強制 effective Gondolin 生效後，**readyAI customer 技能必須仍能完整運作**。對應 readyAI#75、readyscript-docker E2E T8。

### 實測目標

- **customer 工作目錄／workspace**：`/Users/tung/Codes/readyaiJobs/www.kyangyhe.com`
- 該 workspace 的 `.env` 應提供本 preview 的 L-乙 scoped 憑證（`PC2_API_TOKEN`、`PC2_SERVICE_HOST`、`PI_PREVIEW_PUBLIC_URL`），供 sandbox 內 readyAI CLI 透過 `READYAI_SANDBOX_MODE=1` 讀取。
- 該 workspace 的 `.env` **不得**含 `PC2_SERVICE_PWS` 或任何 L-甲 共用主機/origin 機密。

### 重新部署方法

```bash
# 1) pi-webui：build 含本 spec 的 dist/tarball，PI_WEBUI_REF 指向該 commit
# 2) readyai-project 重新部署預覽映像（客戶 volume 不受影響）
readyai-project preview redeploy --name kyangyhe-preview \
  --readyscript-docker /Users/tung/Codes/readyscript-docker
# depot/builder 握手失敗時加 --local-only 或 --no-depot
```

部署後由人重登。啟動 log 應見 `sandbox=enabled`（且為 effective——見紅線 4）。

### customer 技能的實際 env 依賴（E2E 查證，已按三層修正）

| 技能 | bash 直呼工具 | 憑證來源（修正後） |
|------|--------------|------------------|
| customer-pgc-dialogue | `readyai-db`、`readyai-screenshot` | `PC2_API_TOKEN`(scoped)/`PC2_SERVICE_HOST`/`PI_PREVIEW_PUBLIC_URL` ← **workspace `.env`**；`ZYTE_API_KEY` ← **env 白名單（L-丙）** |
| customer-content-edit | `readyai-db` | `PC2_API_TOKEN`/`PC2_SERVICE_HOST` ← workspace `.env` |
| customer-image-upload | `readyai-image-uploader` | 同上（走 PC2、不碰 R2） |
| customer-attachment-upload | `readyai-attachment-uploader`、`readyai-filereader`、`readyai-db` | 同上 |

> **修正**：移除 `PC2_SERVICE_PWS`（L-甲，禁止）——技能以 Bearer `PC2_API_TOKEN` 認證即可。移除 `PC2_API_PATH` 之類若非必要者，一律 workspace `.env` 供給。

### 定案（原「設計缺口 解 A/B」已拍板）

readyAI customer 技能是 **bash 直呼 CLI**、走 `load_env_with_fallback()`。**定案方向**（取代原「解 A 擴白名單」）：

- **L-乙 憑證走 workspace `.env`**：sandbox bash 注入 `READYAI_SANDBOX_MODE=1`，CLI 自 mounted workspace `.env` 讀 `PC2_API_TOKEN`(scoped)/`PC2_SERVICE_HOST`/`PI_PREVIEW_PUBLIC_URL`。**不進** env 白名單。
- **`ZYTE_API_KEY`（L-丙）進 env 白名單**：使用者拍板，殘餘風險已記錄。
- **紅線**：`OPENROUTER_API_KEY`、`PI_WEBUI_PASSWORD`、`R2_*`、**`PC2_SERVICE_PWS`** 絕不進 bash/VM/workspace `.env`。
- **前提檢查**：部署時確認 workspace `.env` 的 `PC2_API_TOKEN` 為 **scoped**（該 preview token），非共用 master token。

### E2E 驗收清單（effective sandbox 開啟下實測）

**A. 隔離（紅線）**
- [ ] 啟動 log `sandbox=enabled` 且為 effective（QEMU init 成功；否則應 fail-closed 拒啟）
- [ ] **A 組必禁**：agent 跑下列，輸出**空**：
  ```
  env | grep -oE '^(OPENROUTER_API_KEY|R2_SECRET_ACCESS_KEY|R2_ACCESS_KEY_ID|PI_WEBUI_PASSWORD|PC2_SERVICE_PWS|PC2_API_TOKEN)=' | sed 's/=.*//' | sort
  ```
  （`PC2_API_TOKEN` 走檔案，env 不該有；`PC2_SERVICE_PWS` 完全禁止）
- [ ] **B 組可存在**（不影響 PASS）：`ZYTE_API_KEY`（白名單）；位址類 `PC2_SERVICE_HOST`/`PI_PREVIEW_PUBLIC_URL`（通常走檔案，在 env 也無妨）
- [ ] `read`／`bash cat` workspace 外主機機密（`~/.ssh`、server `.env`、`/proc/1/environ`）取不到
- [ ] workspace `.env` **無** `PC2_SERVICE_PWS`（grep 確認）

**B. 功能（customer 技能全綠）**

| # | 技能 | 動作 | 通過標準 |
|---|------|------|---------|
| B1 | customer-pgc-dialogue | 改 DB → 截桌機+手機圖 | `readyai-db` 寫入成功；`.artifacts/` 產 PNG；artifact URL 200+圖；畫面無 `127.0.0.1` |
| B2 | customer-content-edit | `readyai-db` 改一欄位 | 寫入成功且前端預覽反映 |
| B3 | customer-image-upload | 上傳圖 | 上傳成功（PC2），頁面/DB 可見 |
| B4 | customer-attachment-upload | 上傳附件 | 上傳成功並掛上 |

### 通過定義

**PASS ＝ A（隔離紅線，含 workspace `.env` 無 PWS）全過 且 B1–B4 全過。** 任一技能在 sandbox 下跑不動 → FAIL，回定案方向調整（**不得**放行 L-甲）。

## 版本驗證（實作前必跑）

對 `node_modules` 實際 `0.74.x` 確認：

| hook/型別 | 用於 | 驗證點 |
|-----------|------|--------|
| `spawnHook` | L0（host＋sandbox 兩路徑） | `dist/core/tools/bash.d.ts` `BashToolOptions.spawnHook` |
| `customTools`＋`noTools:"builtin"` | L0/L1 | `createAgentSessionFromServices` |
| `sandbox.createBashOperations()` 的 per-exec env | L0/L2 | `src/server/sandbox.ts:337-350` `vm.exec({env})` |
| `tool_result` content 型別＋extension return 採用 | L3 送 model | `types.d.ts:726-730`；`emitToolResult`（`runner.js:546`）採用回傳 |
| `filterEvent` 回傳修改後 event 被採用；`tool_execution_update` **emit-only** | L3 送 client | `ui-profile.ts:237`／`index.ts:1852`；`runner.js:476` 丟棄 handler 回傳 |
| `sandbox` 物件於 init 失敗為 null | L2 | `index.ts:795-830`、正解 `:1037` |

## Fly 無 nested KVM：L2 缺席下的實際防線（v3.1，2026-07-06）

**現實**：Fly Firecracker 不提供 `/dev/kvm`，Gondolin 只能 TCG（純軟體模擬）、實質不可用。故 customer 在 Fly **走 `--allow-unsafe-customer` 繞過 L2**（`index.ts:867-885` gate 已載明），實際跑 customer-open：有 host `bash`／`read`，靠 in-process L0/L1/L3。對應 issue #4。

這使 Fly 生產防線**退回本 spec〈否決的替代方案〉的「純 in-process」格**。以下兩條替代共同承擔 L2 原本的 env＋檔案雙根治，並誠實記錄殘餘風險。

### 替代一：部署隔離（等價 L2 的檔案/env 面根治）

單租戶＋機密不進機器：preview 機 `process.env` **只准**含該站 scoped 憑證與該站專屬密鑰，**L-甲 共用機密一律不注入**。

| 機密 | 在 preview 機 `process.env`？ | 依據 |
|---|---|---|
| `R2_*`、`PC2_SERVICE_PWS`（L-甲） | **否**（operator 本機層級） | readyai-project `readyai-project/SKILL.md`：R2_* 走 operator `~/.env`、非客戶專案；customer 技能改走 Bearer `PC2_API_TOKEN` |
| `PC2_API_TOKEN`（L-乙 scoped）、`PC2_SERVICE_HOST=127.0.0.1` | 是（半信任本就可見） | `test_preview_deploy.py` 首次 `flyctl secrets set` |
| `PI_WEBUI_PASSWORD` | 是，**per-preview 自動產生、不共用** | 使用者拍板 |
| `OPENROUTER_API_KEY`（或 LLM 憑證，L-甲） | **是——agent 呼叫 LLM 必需** | 見殘餘風險 |

做到「L-甲 不進機器」，無 VM 即不致命：機器上可洩漏的最敏感物退化為該站自己的 L-乙 憑證（半信任可見）。**這是把 L2 的硬隔離用部署隔離等價替換的主線。**

### 替代二：in-process 縱深（本次實作，非根治）

補 `filterBashEnv` 擋不到的「讀主行程 env」面（L0 只過濾 bash 子行程繼承的 env，擋不住 bash 讀主行程 `/proc/<pid>/environ`）：

- **L0 命令圍欄** `guardBashCommand`／`wrapBashWithCommandGuard`（`secret-guard.ts`）：擋 `printenv`／裸 `env` 列舉／`/proc/<pid>/environ|cmdline` 讀取／`export -p`／`declare -p`／`compgen -v`／裸 `set`；放行 `env FOO=bar cmd`、`set -e` 等正當用途。掛進 `buildHostGuardedTools`（Fly customer-open 實際走）與 `buildSandboxGuardedTools`。
- **L3 編碼變體遮蔽** `secretValueVariants`：L-甲 值的 base64／base64url／hex 一併遮，擋單值 `| base64` 繞過。

⚠️ **deny-list 本質**：變數拼接（`p=printenv;$p`）、字元插入、整段 environ 一次編碼可繞過。**抬高門檻、非根治。**

### 已接受殘餘風險（待選項 A 根治）

> **✅ 2026-07-13 選項 A 已落地**：preview 改走 per-preview litellm virtual key（設計見 readyai-fly-services `docs/superpowers/specs/2026-07-13-litellm-phase2-preview-landing-design.md`；readyAI `c8659e5..0af1e89` 串、pi-webui `1763a71`+`4a5e0ad`）。`OPENROUTER_API_KEY` 已撤出 preview 機（chinyenlabeler E2E 實測：machine secrets 無此鍵、agent bash 層三憑證 absent、key 綁 `models=["readyai"]`+budget 20/soft 5、R2 對話 log 按站分帳），本段殘餘鏈的「波及全體」已消解——leaked virtual key 僅單站、限額、私網才可達、可獨立作廢。以下原文保留為歷史脈絡。

`OPENROUTER_API_KEY`（或等價 LLM 憑證）**趕不出機器**（agent 要呼叫 LLM），且為**跨站共用一把**。customer 技能**會爬站外內容＋收 PDF**→ 間接 prompt injection 是**真實觸發面**（非理論）。故存殘餘鏈：injection →`cat /proc/<主行程>/environ`（變數拼接繞命令圍欄）→ 整段編碼繞 L3 → LLM key 外洩、**波及全體 preview**。損害限 LLM 額度、可 rotate。

**根治方向（選項 A，未落地）**：LLM 走 per-preview proxy token（該站額度上限、獨立 rotate），把 `OPENROUTER_API_KEY` 從 L-甲 降級為 L-乙/L-丙。做完，本殘餘鏈的「波及全體」即消解。在此之前，此為**明示接受**的殘餘風險。

### 測試補充（本次）

- L0 命令圍欄：`secret-guard.test.mjs`（deny/allow 向量）、`secret-guard-bash-e2e.test.mjs`（真 SDK bash 驗 `buildHostGuardedTools` 擋 `/proc/1/environ`、放行正當命令）。
- L3 編碼變體：`secret-guard.test.mjs`（base64/hex 遮蔽、L-乙 不誤傷）。

## 跨 repo 連動

- **readyAI 端基本不需改**：CLI 已支援 `READYAI_SANDBOX_MODE=1`＋workspace `.env`；`ZYTE_API_KEY` 走 pi-webui process.env（Fly secret）白名單放行。**唯一前提**：確認 workspace `.env` 的 `PC2_API_TOKEN` 為 scoped（create 流程 `--token` 已是該客戶 token）。
- **L3 遮蔽清單與 readyAI `SECRET_KEY_PATTERN` 同源**；readyAI 新增機密 pattern 時同步 `SECRET_ENV_KEYS`。
- 本 spec commit 引用關聯 spec 的 commit hash。

## Out of Scope／已接受殘餘風險

- **已接受殘餘風險：`ZYTE_API_KEY`（L-丙）**——共用金鑰進 VM/env，對半信任 customer 可見、外洩波及所有 preview。使用者拍板接受（損害限 Zyte 額度、可 rotate）。若日後不可接受 → 改 per-preview scoped key（走 workspace `.env`）或 server 端截圖代理。
- **出站網路外洩**：本 spec 從源頭讓 agent 拿不到 L-甲/L-乙，不做出站流量過濾。
- **session log 機密遮蔽**：`eventLog`（`index.ts:1849`）在 `filterEvent` 前存原始未遮蔽 event。log 屬主機本地、customer 觸及不到（L1/L2 擋 workspace 外）；若外送雲端需 sanitize，歸 readyAI 機密治理線（`2026-06-30-env-secret-sanitize`）。可選：append 前套 `redactBlocks`。
- **Gondolin/QEMU 逃逸**：信任 VM 邊界。
- **customer 之間隔離**：single-tenant 天然隔離。
- **登入 auth 強化**：既有 `auth.ts`。
- **workspace 內客戶專案自身機密（僅 L-乙）**：半信任決策下屬正常工作範圍，刻意不隔離。若對「不信任最終客戶」開放，需另設「嚴格 customer」profile。
- **非標準機密命名**：L0 allowlist 正面表列兜底 env 面；L3 依 `SECRET_ENV_KEYS` 明列，反常命名可能漏——已知限制。
