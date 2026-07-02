# pi-webui base-path 全鏈路參數化：single source of truth ＋ 入口 strip（方案 A）

> **狀態**：設計 v1，待使用者 review → writing-plans。
> **範圍**：讓 webui 的 base path 真正參數化，`PI_WEBUI_BASE_PATH` 設任意值（含空＝root、含非 `/webui` 前綴）都能在「直連（無反代）」與「apache 反代 strip 前綴」兩種部署下正確運作。收斂 GitHub issue #3 的三個子問題。
> **不在範圍**：多 base 同時掛載、runtime 動態改 base、反代設定本身（apache/nginx conf）、auth 強化、非 `PI_WEBUI_BASE_PATH` 的路由改動。
> **關聯**：GitHub issue #3；前身 commit `7d7ad23`（server redirect 加前綴，只補了 apache 情境）；發現於 `2026-07-01-agent-secret-isolation-design.md` 的 customer-open + sandbox 實地驗收（本機需自架 path-stripping proxy 才能用瀏覽器）。

## 背景

webui 的 base path **名義上**由 `PI_WEBUI_BASE_PATH` 控制，實際上是一套**只做了一半的「apache-strip 契約」**：server 內部一律處理「已被反代 strip 掉前綴」的無前綴路徑（`isAuthPublic`、`serveStatic`、WS upgrade、`LOGIN_PATH` 都是無前綴），只有「發給瀏覽器的東西」需要把前綴加回去。問題出在「發給瀏覽器」這側沒有統一用同一個正規化 base，且 server 完全不能處理「沒有反代、pathname 仍含前綴」的直連場景。

現況三個洞（對應 issue #3）：

| # | 洞 | 現況 code | 後果 |
|---|----|-----------|------|
| 3-1 | `<base>` 寫死 | `public/index.html:4`、`public/login.html:4` 都是 `<base href="/webui/" />` | 所有相對 asset 永遠解析到 `/webui/*`，webui 實質只能掛 `/webui` 且只能走 apache |
| 3-2 | `__BASE__` 未正規化 | `index.ts:1429` 用原始 `PI_WEBUI_BASE_PATH` 注入（非 `:650` 已去尾斜線的 `SERVER_BASE_PATH`） | `PI_WEBUI_BASE_PATH=/` → `__BASE__="/"` → login `fetch("//api/login")` 被當 protocol-relative → `Failed to fetch` |
| 3-3 | 直連時前綴累加迴圈 | `index.ts:1208` redirect 對「已含 `/webui`」的 pathname 再加 `SERVER_BASE_PATH` | 直連 `:4096/webui/`（無反代 strip）→ `/webui/webui/login`，`next` 每跳累加一層 → `ERR_TOO_MANY_REDIRECTS` |

**根因統一描述**：（a）「發給瀏覽器的前綴」沒有 single source of truth；（b）server 只能吃「無前綴」的內部路徑，直連（含前綴）無路可走。

已經做對、**不需再改**的部分：cookie Path。`auth.ts:60 cookiePath()` 已把 base 正規化（空/`"/"` → `"/"`，否則去尾斜線），cookie 在 subpath 能正確送出；本 spec 僅把它的來源統一到 `SERVER_BASE_PATH`（行為不變）。

## 目標 / 非目標

**目標**
1. `PI_WEBUI_BASE_PATH` 為 `""`、`/`、`/webui`、`/foo/bar` 等任意值都能正確運作。
2. 同一套 code 同時支援三種部署：直連 root、直連帶前綴（免自架 proxy）、apache 反代 strip 前綴（現行 production，不可破壞）。
3. base、`__BASE__`、`<base href>`、redirect location、cookie Path 全部由**單一正規化 base** 推導。
4. issue #3 的三個 curl 重現全部通過。

**非目標（YAGNI）**：多 base、runtime 動態改 base、支援直接以 `file://` 開 HTML（asset 一律經 server 注入 `<base>`）。

## 決策：方案 A（server 入口 strip，自適應）

使用者已拍板方案 A（不選只補正規化＋文件化的方案 B）。理由：issue #3 明確要求「直連可用（本機／CI／其他反代）」與「base="" root」，方案 A 一次滿足且一勞永逸；方案 B 會放棄「直連＋非空 base」——正是本機驗收踩到、要自架 proxy 的痛點。

**核心手法**：server 在 HTTP／WS 入口把「可能含前綴」的 pathname strip 成內部無前綴路徑，下游邏輯完全不動；發給瀏覽器的三處（`__BASE__`、`<base href>`、redirect location）用同一正規化 base 加回前綴。

## 設計

### 1. 核心純函式 — `src/server/base-path.ts`（新增）

比照 `session-dir.ts` / `session-guard.ts`：只放可單元測的純函式，IO 留在 caller。

```ts
// 正規化 base：single source of truth。去尾斜線、保證單一前導斜線；空或 "/" → ""（root）。
export function normalizeBasePath(raw: string | null | undefined): string;
//  undefined / "" / "/"                    → ""
//  "/webui" / "webui" / "/webui/" / "//webui//" → "/webui"

// 入口 strip：把 ingress pathname 轉成 server 內部無前綴路徑。
export function stripBasePrefix(pathname: string, base: string): string;
//  base === ""            → pathname（原樣）
//  pathname === base      → "/"
//  pathname 以 base+"/" 開頭 → pathname.slice(base.length)   // "/webui/x" → "/x"
//  其他（如 "/webuixyz"、不匹配）→ pathname（原樣，交下游 404）
```

`stripBasePrefix` 刻意用 `base + "/"`（而非 `startsWith(base)`）判斷，避免把 `/webuixyz` 誤 strip 成 `/xyz`。

### 2. server 接線 — `src/server/index.ts`

| 位置 | 現況 | 改為 |
|------|------|------|
| `:650` `SERVER_BASE_PATH` | `(env \|\| "").replace(/\/+$/, "")` | `normalizeBasePath(env)` |
| HTTP dispatcher 入口 | 直接用 `url.pathname` | 最前面 `url.pathname = stripBasePrefix(url.pathname, SERVER_BASE_PATH)`，下游全部沿用改寫後的內部路徑 |
| WS upgrade `:2564` | `if (url.pathname !== "/ws")` | 先 `stripBasePrefix` 再比對 `=== "/ws"` |
| `__BASE__` 注入 `:1429` | 原始 env | `SERVER_BASE_PATH`（正規化） |
| `<base>` 注入 | HTML 寫死 | `serveStatic` 對 index/login `html.replace("<head>", \`<head><base href="${baseHref}">\`)`，`baseHref = SERVER_BASE_PATH ? SERVER_BASE_PATH + "/" : "/"` |
| redirect `:1208`/`:1227` | 加 `SERVER_BASE_PATH` | **維持不變**——pathname 已 strip 成內部路徑，`SERVER_BASE_PATH + internalPath` 不再累加；`next` 同理正確 |
| cookie（`auth.ts` `buildSetCookie`） | 讀 `process.env.PI_WEBUI_BASE_PATH` | 改吃 `SERVER_BASE_PATH`（行為不變，僅統一 source） |

**入口改寫 `url.pathname` 的取捨**（使用者已同意）：改寫後 `url.pathname` 之後一律代表內部路徑，下游零改動、最少侵入；代價是「`url.pathname` 語意＝內部路徑」需在入口處註解講明。

### 3. 前端 — `public/`

- `index.html:4`、`login.html:4`：**移除**寫死的 `<base href="/webui/" />`，改由 server 於回應時注入。
- 其餘**不動**：`app.js:1 BASE`、`app.js:780 ${BASE}/ws`、`app.js:2183 ${BASE}/api/upload`、`login.html:87 ${__BASE__}/api/login` 在 `__BASE__` 正規化後自然正確。

### 4. 三種部署 × 一套 code

| 場景 | `PI_WEBUI_BASE_PATH` | server 收到 pathname | strip 後（內部） | `<base href>` / `__BASE__` | 結果 |
|------|------|------|------|------|------|
| 直連 root | `""` | `/`、`/ws` | `/`、`/ws`（no-op） | `/` / `""` | ✓ |
| 直連帶前綴 | `/webui` | `/webui/`、`/webui/ws` | `/`、`/ws` | `/webui/` / `/webui` | ✓ 免 proxy |
| apache 反代 | `/webui`（apache strip） | `/`、`/ws` | `/`、`/ws`（no-op） | `/webui/` / `/webui` | ✓ 不破壞現行 |

## 相容性與風險

- **現行 apache 部署（jihsin、kyangyhe-preview）不受影響**：apache strip 後 server 收到無前綴路徑，`stripBasePrefix` 為 no-op，行為與現況一致。
- **cookie**：來源改為 `SERVER_BASE_PATH`，`cookiePath` 邏輯不變，結果與現況一致。
- **風險點**：`stripBasePrefix` 的邊界（`pathname === base` 無尾斜線、非 base 開頭）須測試覆蓋，避免誤 strip 或漏 strip。已於 §1 明確定義四條分支。

## 測試與驗收（TDD）

**單元** `test/base-path.test.mjs`：
- `normalizeBasePath`：`undefined` / `""` / `"/"` → `""`；`"/webui"` / `"webui"` / `"/webui/"` / `"//webui//"` → `"/webui"`。
- `stripBasePrefix`：base `""` 原樣；`pathname===base` → `"/"`；`base+"/x"` → `"/x"`；`"/webuixyz"`（不匹配）原樣。

**server 整合**（擴充現有 server 測試風格）：
- `base=/webui` 直連 `/webui/` → 200 index（不迴圈）。
- `base=/webui` 直連 `/webui/ws` → WS upgrade 成功。
- `base=/webui` 未登入直連 `/webui/foo` → 302 `location: /webui/login?next=/webui/foo`（不變 `/webui/webui/...`）。
- `base=/`（或 `""`）→ 注入 `__BASE__=""` → login fetch 打到 `/api/login`（非 `//api/login`）。
- `base=""` 直連 `/` → 200 root。

**驗收**：issue #3 的兩段 curl 重現（`base=/webui` 直連不再 302 迴圈；`base=/` 直連 `__BASE__` 不再產生 `//api/login`）全部通過。

## 改動檔案清單

- 新增：`src/server/base-path.ts`、`test/base-path.test.mjs`
- 修改：`src/server/index.ts`（`SERVER_BASE_PATH`、入口 strip、WS upgrade strip、`__BASE__` / `<base>` 注入）、`src/server/auth.ts`（cookie source 統一）、`public/index.html`、`public/login.html`（移除寫死 `<base>`）
- 文件：`README.md` 的 `PI_WEBUI_BASE_PATH` 說明補「支援直連帶前綴／root／apache 三模式」
