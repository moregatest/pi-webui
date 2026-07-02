# pi-webui base-path 全鏈路參數化：single source of truth ＋ 入口 strip（方案 A）

> **狀態**：設計 v2，待使用者 review → writing-plans。v2 收使用者 spec review：P1 入口 strip 資料流（改 `req.url` 而非 local url）、cookie 傳參避 circular、browser-facing URL 盤點（logoUrl／login fallback）、測試補 prefixed login 與 branding。
> **範圍**：讓 webui 的 base path 真正參數化，`PI_WEBUI_BASE_PATH` 設任意值（含空＝root、含非 `/webui` 前綴）都能在「直連（無反代）」與「apache 反代 strip 前綴」兩種部署下正確運作。收斂 GitHub issue #3 的三個子問題。
> **不在範圍**：多 base 同時掛載、runtime 動態改 base、反代設定本身（apache/nginx conf）、auth 強化、技能輸出內容裡的 artifact URL（由技能產生，非 pi-webui 送出；見 §4）。
> **關聯**：GitHub issue #3；前身 commit `7d7ad23`（server redirect 加前綴，只補了 apache 情境）；發現於 `2026-07-01-agent-secret-isolation-design.md` 的 customer-open + sandbox 實地驗收（本機需自架 path-stripping proxy 才能用瀏覽器）。

## 背景

webui 的 base path **名義上**由 `PI_WEBUI_BASE_PATH` 控制，實際上是一套**只做了一半的「apache-strip 契約」**：server 內部一律處理「已被反代 strip 掉前綴」的無前綴路徑（`isAuthPublic`、`serveStatic`、WS upgrade、`LOGIN_PATH` 都是無前綴），只有「發給瀏覽器的東西」需要把前綴加回去。問題出在「發給瀏覽器」這側沒有統一用同一個正規化 base，且 server 完全不能處理「沒有反代、pathname 仍含前綴」的直連場景。

現況三個洞（對應 issue #3）：

| # | 洞 | 現況 code | 後果 |
|---|----|-----------|------|
| 3-1 | `<base>` 寫死 | `public/index.html:4`、`public/login.html:4` 都是 `<base href="/webui/" />` | 所有相對 asset 永遠解析到 `/webui/*`，webui 實質只能掛 `/webui` 且只能走 apache |
| 3-2 | `__BASE__` 未正規化 | `index.ts:1429` 用原始 `PI_WEBUI_BASE_PATH` 注入（非 `:650` 已去尾斜線的 `SERVER_BASE_PATH`） | `PI_WEBUI_BASE_PATH=/` → `__BASE__="/"` → login `fetch("//api/login")` 被當 protocol-relative → `Failed to fetch` |
| 3-3 | 直連時前綴累加迴圈 | `index.ts:1208` redirect 對「已含 `/webui`」的 pathname 再加 `SERVER_BASE_PATH` | 直連 `:4096/webui/`（無反代 strip）→ `/webui/webui/login`，`next` 每跳累加一層 → `ERR_TOO_MANY_REDIRECTS` |

**根因統一描述**：（a）egress（發給瀏覽器的前綴）沒有 single source of truth；（b）ingress（server 收進來）只能吃「無前綴」路徑，直連（含前綴）無路可走。

已經做對、僅需微調的部分：cookie Path。`auth.ts:60 cookiePath()` 已把 base 正規化，cookie 在 subpath 能正確送出；本 spec 僅把它的來源從「直接讀 env」改為「由 caller 傳入正規化 base」（見 §3，避 circular import），Path 結果不變。

## 目標 / 非目標

**目標**
1. `PI_WEBUI_BASE_PATH` 為 `""`、`/`、`/webui`、`/foo/bar` 等任意值都能正確運作。
2. 同一套 code 同時支援三種部署：直連 root、直連帶前綴（免自架 proxy）、apache 反代 strip 前綴（現行 production，不可破壞）。
3. base、`__BASE__`、`<base href>`、redirect location、cookie Path、branding URL 全部由**單一正規化 base** 推導。
4. issue #3 的三個 curl 重現全部通過。

**非目標（YAGNI）**：多 base、runtime 動態改 base、支援直接以 `file://` 開 HTML（asset 一律經 server 注入 `<base>`）、技能輸出內容內的 artifact URL 前綴化。

## 決策：方案 A（server 入口 strip，自適應）

使用者已拍板方案 A（不選只補正規化＋文件化的方案 B）。理由：issue #3 明確要求「直連可用（本機／CI／其他反代）」與「base="" root」，方案 A 一次滿足且一勞永逸；方案 B 會放棄「直連＋非空 base」——正是本機驗收踩到、要自架 proxy 的痛點。

**核心手法**：ingress 端在**所有 HTTP handler 之前就地改寫 `req.url`**（strip 掉 base 前綴、保留 query string），讓所有既有 `new URL(req.url)` 自動拿到內部無前綴路徑，下游邏輯零改動；egress 端把「發給瀏覽器」的每一處（`__BASE__`、`<base href>`、redirect location、cookie Path、branding URL）用同一正規化 base 加回前綴。

## 設計

### 1. 核心純函式 — `src/server/base-path.ts`（新增）

比照 `session-dir.ts` / `session-guard.ts`：只放可單元測的純函式，IO 留在 caller。

```ts
// 正規化 base：single source of truth。去尾斜線、保證單一前導斜線；空或 "/" → ""（root）。
export function normalizeBasePath(raw: string | null | undefined): string;
//  undefined / "" / "/"                         → ""
//  "/webui" / "webui" / "/webui/" / "//webui//" → "/webui"

// 入口 strip：把 ingress pathname 轉成 server 內部無前綴路徑。
export function stripBasePrefix(pathname: string, base: string): string;
//  base === ""              → pathname（原樣）
//  pathname === base        → "/"
//  pathname 以 base+"/" 開頭 → pathname.slice(base.length)   // "/webui/x" → "/x"
//  其他（如 "/webuixyz"、不匹配）→ pathname（原樣，交下游 404）
```

`stripBasePrefix` 刻意用 `base + "/"`（而非 `startsWith(base)`）判斷，避免把 `/webuixyz` 誤 strip 成 `/xyz`。

### 2. Ingress — 改寫 `req.url`（P1，本次 review 重點）

**為何不能只改某個 local `url`**：主 request handler（`index.ts:2528`）**第一行就呼叫 `handleAuth(req, res)`（:2530）**，而 `handleAuth`（:1186）、`serveStatic`（:1399）、dispatcher（:2534）、upload/artifact、WS upgrade（:2559）**各自 `new URL(req.url, ...)`** 重新 parse。改 dispatcher 裡的 local `url.pathname` 影響不到 `handleAuth`（它更早跑、且讀自己的 URL），redirect 迴圈照舊。

**做法**：唯一的 single choke point 是 `req.url`。在 `createServer` handler 最前面、`handleAuth` 之前 strip：

```js
const origin = `http://${req.headers.host || "localhost"}`;
if (SERVER_BASE_PATH) {
  const u = new URL(req.url || "/", origin);
  const stripped = stripBasePrefix(u.pathname, SERVER_BASE_PATH);
  if (stripped !== u.pathname) req.url = stripped + u.search; // 保留 query string
}
// ↓ 之後 handleAuth / dispatcher / serveStatic 的 new URL(req.url) 全部拿到內部路徑
const handled = await handleAuth(req, res);
```

**WS upgrade**（`server.on("upgrade")`，:2556）：同一手法，在該 handler 內 `new URL` 後 `url.pathname = stripBasePrefix(url.pathname, SERVER_BASE_PATH)` 再比對 `=== "/ws"`（此處不需回寫 `req.url`，`handleUpgrade` 不看 pathname）。

改寫後 `req.url` 語意＝「內部無前綴路徑」，需在 strip 處註解講明。

### 3. Egress — 由單一正規化 base 推導（發給瀏覽器）

| 位置 | 現況 | 改為 |
|------|------|------|
| `:650` `SERVER_BASE_PATH` | `(env \|\| "").replace(/\/+$/, "")` | `normalizeBasePath(env)` |
| `__BASE__` 注入 `:1429` | 原始 env | `SERVER_BASE_PATH`（正規化） |
| `<base>` 注入（`serveStatic` HTML 分支 :1428） | HTML 寫死 | 注入 `<base href="${baseHref}">`，`baseHref = SERVER_BASE_PATH ? SERVER_BASE_PATH + "/" : "/"` |
| redirect `:1208`/`:1227` | 加 `SERVER_BASE_PATH` | **維持不變**——`req.url` 已 strip，`handleAuth` 讀到的 `pathname` 是內部路徑，`SERVER_BASE_PATH + pathname` 不再累加；`next` 同理正確 |
| cookie `auth.ts buildSetCookie`/`buildClearCookie` | 讀 `process.env.PI_WEBUI_BASE_PATH`（circular 風險） | **改傳參**：`buildSetCookie(value, { secure, maxAge, basePath })`、`buildClearCookie({ secure, basePath })`，由 `index.ts`（:1171/:1179）傳入 `SERVER_BASE_PATH`。行為（`cookiePath` 邏輯）不變 |
| branding `serializeUiProfile` `:627` | `logoUrl: "/brand/logo"`（絕對，client `app.js:763` 設 `img.src`，不經 `<base>`） | `logoUrl: \`${SERVER_BASE_PATH}/brand/logo\``（`serializeUiProfile` 呼叫時 `SERVER_BASE_PATH` 已初始化） |

### 4. 前端 — `public/`

- `index.html:4`、`login.html:4`：**移除**寫死的 `<base href="/webui/" />`，改由 server 注入（§3）。
- `login.html:94-95` 登入成功導向：現況 `next || "/"` 且 fallback `"/"` 在 base 下會跳 root。改為 base-aware 且維持 open-redirect 防護：
  ```js
  const base = window.__BASE__ || "";
  const next = new URLSearchParams(location.search).get("next") || `${base}/`;
  location.href = next.startsWith("/") ? next : `${base}/`;
  ```
  （正常流程 `next` 由 handleAuth redirect 帶、已含前綴且以 `/` 開頭；此修法只補「直接開 `/webui/login` 無 next」的 fallback。）
- **不動**：`app.js:1 BASE`、`:780 ${BASE}/ws`、`:744 ${BASE}/brand/theme.css`、`:2183 ${BASE}/api/upload`、`login.html:87 ${__BASE__}/api/login` 在 `__BASE__` 正規化後自然正確。
- **不在範圍**：技能輸出內容（markdown）內若含絕對 `/artifacts/x.png`，屬技能產生的內容 URL，本 spec 不改；但因 ingress 統一 strip，client 端帶前綴請求 `/webui/artifacts/...` 會被正確處理。

### 5. 三種部署 × 一套 code

| 場景 | `PI_WEBUI_BASE_PATH` | server 收到 pathname | strip 後（內部） | `<base href>` / `__BASE__` | 結果 |
|------|------|------|------|------|------|
| 直連 root | `""` | `/`、`/ws` | `/`、`/ws`（no-op） | `/` / `""` | ✓ |
| 直連帶前綴 | `/webui` | `/webui/`、`/webui/ws`、`/webui/api/login` | `/`、`/ws`、`/api/login` | `/webui/` / `/webui` | ✓ 免 proxy |
| apache 反代 | `/webui`（apache strip） | `/`、`/ws` | `/`、`/ws`（no-op） | `/webui/` / `/webui` | ✓ 不破壞現行 |

## 相容性與風險

- **現行 apache 部署（jihsin、kyangyhe-preview）不受影響**：apache strip 後 server 收到無前綴路徑，`stripBasePrefix` 為 no-op，行為與現況一致。
- **cookie**：來源改為傳參的 `SERVER_BASE_PATH`，`cookiePath` 邏輯不變，Path 結果與現況一致。
- **風險點**：`stripBasePrefix` 的邊界（`pathname === base` 無尾斜線、非 base 開頭）須測試覆蓋；`req.url` 改寫須保留 query string 與 percent-encoding（用 WHATWG `URL` 的 `pathname + search` 重組）。

## 測試與驗收（TDD）

**單元** `test/base-path.test.mjs`：
- `normalizeBasePath`：`undefined` / `""` / `"/"` → `""`；`"/webui"` / `"webui"` / `"/webui/"` / `"//webui//"` → `"/webui"`。
- `stripBasePrefix`：base `""` 原樣；`pathname===base` → `"/"`；`base+"/x"` → `"/x"`；`"/webuixyz"`（不匹配）原樣。

**server 整合**（擴充現有 server 測試風格）：
- `base=/webui` 直連 `/webui/` → 200 index（不迴圈）。
- `base=/webui` 直連 `/webui/ws` → WS upgrade 成功。
- `base=/webui` 未登入直連 `/webui/foo` → 302 `location: /webui/login?next=/webui/foo`（不變 `/webui/webui/...`）。
- **`base=/webui` + 正確密碼 `POST /webui/api/login` → 200 且 `Set-Cookie` 帶 `Path=/webui`**（驗證 strip 確實發生在 `handleAuth` 之前）。
- **`base=/webui` 直連 `/webui/brand/logo`（有設 logo）→ 200/302**（驗證 branding URL 前綴）。
- `base=/`（或 `""`）→ 注入 `__BASE__=""` → login fetch 打到 `/api/login`（非 `//api/login`）。
- `base=""` 直連 `/` → 200 root。

**驗收**：issue #3 的兩段 curl 重現（`base=/webui` 直連不再 302 迴圈；`base=/` 直連 `__BASE__` 不再產生 `//api/login`）全部通過。

## 改動檔案清單

- 新增：`src/server/base-path.ts`、`test/base-path.test.mjs`
- 修改：
  - `src/server/index.ts`：`SERVER_BASE_PATH` 改 `normalizeBasePath`；`createServer` handler 入口改寫 `req.url`（strip）；WS upgrade handler strip pathname；`__BASE__` / `<base>` 注入用正規化 base；`serializeUiProfile` 的 `logoUrl` 加前綴；cookie 呼叫（:1171/:1179）傳入 `basePath`。
  - `src/server/auth.ts`：`buildSetCookie` / `buildClearCookie` 改吃 `basePath` 參數（避 circular import）。
  - `public/index.html`、`public/login.html`：移除寫死 `<base>`；`login.html` 登入成功導向改 base-aware。
- 文件：`README.md` 的 `PI_WEBUI_BASE_PATH` 說明補「支援直連帶前綴／root／apache 三模式」。
