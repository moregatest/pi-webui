# 密碼登入 + Port 自動偵測 設計文件

date: 2026-05-21
status: draft (待 review)

## 目標

為 pi-webui 加上兩項既互相獨立、又會在同一個進入點被使用的能力:

1. **密碼登入**：透過 CLI flag 或環境變數設定密碼,啟用後 webui 才能進入;
   未設則維持現狀(無認證,直接進 SPA),向後相容
2. **Port 自動偵測**：指定的 port 已被佔用時,線性 +1 搜尋下一個可用 port(上限 50)
   找不到才報錯。失敗 fallback 過程印在 log/stdout 讓使用者知道實際 port

兩者都要同步暴露在:
- 獨立啟動 (`pi-webui --password ... --listen 4096`)
- 環境變數 (`PI_WEBUI_PASSWORD=... pi-webui`)
- pi extension 啟動 (`pi --webui-password ...` 或 `/webui start --password ...`)

## 非目標

- 多帳號 / 帳號名稱:只有單一密碼
- 密碼 hash 儲存:server 端記憶體比對,密碼來源是 CLI/env,本來就是 plain text
- IP 鎖 / 失敗次數鎖:本期不做
- token 跨 server 重啟保存:重啟即失效,使用者重登
- WebAuthn / OAuth / SSO:不在範圍內
- CSRF token:仰賴 `SameSite=Lax` + 純 JSON POST 提供保護

## 架構

```
CLI / env  ─▶  parseArgs ─▶  { password, port, host, trustProxy }
                                │
                                ▼
                       listenWithFallback(host, port)
                                │
                          binds 真實 port
                                │
                                ▼
              HTTP server  ──── auth middleware ──── routes
                  │                  │                  │
                  │            cookie 比對         /login (HTML)
                  │            (僅當設密碼)        /api/login (POST)
                  │                                /api/logout (POST)
                  │                                / (SPA)
                  ▼
              WebSocket Server ──── 升級時讀 cookie ──── /ws
```

### 新增模組

| 路徑 | 職責 |
|---|---|
| `src/server/auth.ts` | 密碼解析、token 產生/驗證/撤銷、cookie 屬性、login/logout handler、auth middleware factory |
| `src/server/listen.ts` | `listenWithFallback(server, opts)`:port 自動偵測 |
| `public/login.html` | 登入表單,inline JS 打 `/api/login`、成功後 `location.href = "/"` |
| `test/auth.test.mjs` | auth 單元測試 |
| `test/listen.test.mjs` | listen 單元測試 |
| `test/server-auth-integration.test.mjs` | 真實 HTTP/WS 整合測試 |

### 既有檔案改動

| 路徑 | 改動 |
|---|---|
| `src/server/index.ts` | (1) parseArgs 加 `--password` / `--trust-proxy` (2) 環境變數讀取 (3) `serveStatic` 前掛 auth middleware (4) `server.listen(...)` 換成 `listenWithFallback` (5) WebSocket upgrade handler 加 cookie 驗證 |
| `src/extension/index.ts` | 加 `--webui-password` / `--webui-trust-proxy` 兩個 flag,並在 `StartOptions` 與 `parseStartFlags`、`runStart` forward |
| `README.md` | 旗標表與環境變數表新增三列,加安全注意章節 |
| `ROADMAP.md` | done 區新增三條 |

## 資料流

### 登入流程

```
browser  ──GET /─▶  server
                    auth gate: 無 cookie 或 token 失效
                    302 → /login

browser  ──GET /login─▶  server  (放行,回 login.html)

browser  ──POST /api/login {password: "xxx"}─▶  server
                    比對 password 與啟動時設定的密碼
                    成功: 產 32-byte random hex token,存 Map<token, {expiresAt}>
                          Set-Cookie: pi_webui_auth=<token>;
                                      HttpOnly; SameSite=Lax;
                                      Max-Age=604800; Path=/;
                                      [Secure 視 trust-proxy 與 X-Forwarded-Proto 決定]
                          回 {ok: true}
                    失敗: 250ms delay → 401 {ok: false, error: "Invalid password"}

browser  ──GET /─▶  server  (cookie 有效, 放行 SPA)

browser  ──Upgrade WS /ws (帶 Cookie header)─▶  server
                    upgrade handler 讀 cookie 比對 token
                    無效: socket.destroy() 不允許升級
                    有效: 進入 NativePiSessionController 流程
```

### 登出流程

```
browser  ──POST /api/logout (帶 cookie)─▶  server
                    從 Map 移除 token
                    Set-Cookie: pi_webui_auth=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax
                    回 {ok: true}
```

### Auth middleware 放行清單

無需 cookie 即可存取:
- `GET /login`
- `POST /api/login`
- `POST /api/logout` (登出本就要求有 cookie 才有東西可清,但允許不帶 cookie 也回 200)
- `GET /favicon.svg`

其餘任何路徑/method:
- `/api/*` 或 `/ws` → 401 JSON
- 其他 → 302 redirect 到 `/login`

### Token 儲存結構

```js
// in-memory only, server 重啟即失效
const tokens = new Map();   // tokenHex -> { expiresAt: number }
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days

// 不開背景 GC 計時器;每次 verifyToken 時順手判斷
// expiresAt < Date.now() 就 delete 並當作無效
```

### Port 自動偵測

```js
async function listenWithFallback(server, { host, port, maxAttempts = 50, logger }) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tryPort = port + attempt;
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(tryPort, host);
      });
      if (attempt > 0) {
        logger?.warn?.("port fallback", { requested: port, actual: tryPort });
      }
      return tryPort;
    } catch (err) {
      if (err.code !== "EADDRINUSE") throw err;   // 不是被佔,立刻丟
    }
  }
  throw new Error(
    `No free port in range ${port}..${port + maxAttempts - 1}; try --listen with a different port`
  );
}
```

啟動 log:
```
listening on http://127.0.0.1:4099 (requested 4096; +3)
```

## Cookie 屬性決策

| 屬性 | 值 | 理由 |
|---|---|---|
| `HttpOnly` | 永遠 | 防 XSS 偷 cookie |
| `SameSite` | `Lax` | 平衡安全與可用性;支援 top-level 導航 |
| `Path` | `/` | 整站共用 |
| `Max-Age` | `604800` (7 day) | 既不要每天重登,也不要永久 |
| `Secure` | 動態 | `--trust-proxy && req.headers["x-forwarded-proto"] === "https"` → `true`;否則 `false` |

### `--trust-proxy` 的意義

- 預設 `false`,cookie 不帶 `Secure`,在 plain `http://127.0.0.1` 與 cloudflare tunnel HTTPS 都可動
- 設為 `true` 時讀 `X-Forwarded-Proto`,若為 `https` 才加 `Secure`,給走信任 reverse proxy 的部署多一層保護
- 沒帶 `X-Forwarded-Proto` 或值不是 `https` 時仍不加 `Secure`,確保不會在本機 plain HTTP 模式壞掉

## 錯誤處理

| 情境 | 行為 |
|---|---|
| password 為空字串(`--password=""`) | parseArgs 階段擋下,exit 2,印 `password cannot be empty` |
| 既有 CLI flag 又有 env var | CLI 優先(沿用既有慣例) |
| `/api/login` body 非 JSON 或缺 password 欄位 | 400 `{ok:false, error:"Invalid request"}` |
| `/api/login` password 不符 | 250ms delay → 401 `{ok:false, error:"Invalid password"}` |
| 受保護 API 路徑 cookie 缺失/失效 | 401 JSON `{ok:false, error:"Unauthorized"}` |
| 受保護 WS 升級 cookie 缺失/失效 | `socket.destroy()`,連線被拒 |
| 受保護一般路徑 cookie 缺失/失效 | 302 → `/login` |
| token 過期 | verify 時 lazy delete 並當失效處理 |
| port 自動偵測連 50 個都被佔 | exit 1,印 `no free port in range 4096..4145, try --listen with a different port` |
| `EACCES`(例如 bind <1024 沒權限) | 不重試,立即丟原錯誤 |
| 其他非 EADDRINUSE listen 錯誤 | 不重試,丟原錯誤 |
| `--trust-proxy` 開但沒 `X-Forwarded-Proto` | cookie 不加 `Secure`,正常運作 |

## CLI / env 表 (新增與微調)

| flag | env | 預設 | 說明 |
|---|---|---|---|
| `--password <pw>` | `PI_WEBUI_PASSWORD` | (未設) | 啟用 cookie 登入認證;未設時不啟用,維持向後相容 |
| `--trust-proxy` | `PI_WEBUI_TRUST_PROXY=1` | off | 信任 `X-Forwarded-Proto` header 決定 cookie `Secure` flag |
| `--listen <host:port>` 行為微調 | (沿用 `PI_WEBUI_PORT`) | 4096 | port 被佔時自動 +1 找下一個,上限 50 |

extension 對應旗標:
- `--webui-password` (string)
- `--webui-trust-proxy` (boolean)

`/webui start` inline 也支援同名 flag。

## 與 Cloudflare Tunnel 的相容性

- WebSocket:`public/app.js:619` 已依 `location.protocol` 自動切 `ws`/`wss`,tunnel HTTPS 終止後本機 HTTP 場景可動
- Cookie:browser 對 tunnel 網域設的 cookie 會透通 forward 到本機 server,完全一致
- Host header:tunnel 會改成 cloudflare 網域;設計沒有 Host/Origin 白名單,所以不會擋
- 建議搭配 cloudflare 自身的 Rate Limiting / WAF 防 brute force
- 建議啟動時加 `--trust-proxy`,讓 cookie 在 HTTPS 模式下有 `Secure` flag

## 安全注意 (寫進 README)

- `pi --webui-password xxx` 啟動時,密碼會出現在 `ps aux` 的 process list。建議改用 `PI_WEBUI_PASSWORD` 環境變數,或包進 wrapper script
- 預設 `Secure=false`,只在 plain HTTP 與走信任 proxy 時才適用;直接 expose 到公網建議搭配 cloudflare tunnel / reverse proxy + `--trust-proxy`
- 沒有 brute force 鎖,公開暴露建議靠 cloudflare WAF / rate limit

## 測試策略

### `test/auth.test.mjs` (單元)

- `verifyPassword`:正確、錯誤、空字串
- `issueToken`:回 hex token、寫進 Map、有過期時間
- `verifyToken`:有效、過期(時間操控)、不存在
- `revokeToken`:從 Map 移除
- `parseCookie` helper:單 cookie、多 cookie、無此 cookie
- `cookieAttrs`:
  - trust-proxy off → 不帶 Secure
  - trust-proxy on 且 `X-Forwarded-Proto: https` → 帶 Secure
  - trust-proxy on 但 proto = http → 不帶 Secure

### `test/listen.test.mjs` (單元)

- port 可用 → 直接綁
- port 被佔(先用 `net.createServer` 卡一個 port)→ 自動 +1 綁到下一個,回傳實際 port
- 連續 50 個 port 都被佔(mock)→ throw
- 非 EADDRINUSE 錯誤(mock 丟 EACCES)→ 立刻 throw 不重試

### `test/server-auth-integration.test.mjs` (整合,用 http client + ws client 打真實 server)

- 沒設 password 啟動 → GET `/` → 200(向後相容)
- 設了 password 啟動 → GET `/` → 302 → `/login`
- POST `/api/login` 對 → 200 + Set-Cookie;帶 cookie 再 GET `/` → 200
- POST `/api/login` 錯 → 401(且耗時 ≥ 250ms)
- 帶過期 cookie GET `/` → 302
- POST `/api/logout` → cookie 被清,再 GET `/` → 302
- WS upgrade 沒 cookie → 連線被拒
- WS upgrade 有有效 cookie → 連線成功

## 實作順序

每步可獨立通過 lint + test 再進下一步:

1. `src/server/listen.ts` + `test/listen.test.mjs` (純粹模組,可獨立驗證)
2. `src/server/index.ts` 的 `server.listen(...)` 改用 `listenWithFallback`
3. `src/server/auth.ts` + `test/auth.test.mjs` (密碼/token/cookie helpers,純粹)
4. `public/login.html` + 內嵌 fetch POST 邏輯
5. `src/server/index.ts` 接入 auth middleware + WS upgrade gate
6. `test/server-auth-integration.test.mjs`
7. `src/extension/index.ts` 加 `--webui-password` / `--webui-trust-proxy`
8. README + ROADMAP 更新
9. 在 `~/Codes/readyaiJobs/` 子目錄做端到端手動驗證

## 端到端手動驗證 (在 ~/Codes/readyaiJobs/ 子目錄)

選一個子目錄(例如 `~/Codes/readyaiJobs/biocrown-v2`)做測試場景:

```bash
cd ~/Codes/readyaiJobs/biocrown-v2

# 場景 A: 不設密碼(向後相容)
pi-webui                                    # 應直接看到 SPA, 沒登入頁

# 場景 B: 設密碼
pi-webui --password hunter2 &
curl -i http://127.0.0.1:4096/              # 預期 302 → /login
curl -i http://127.0.0.1:4096/login         # 預期 200 + login.html
# browser: 打開 → 跳 login → 輸入錯 → 401 → 輸入對 → 進 SPA

# 場景 C: port 衝突
pi-webui --password a --listen :4096 &      # 第一個佔 4096
pi-webui --password a --listen :4096        # 第二個應自動到 4097
PORT=4096 PI_WEBUI_PASSWORD=a pi-webui      # 同樣 +1

# 場景 D: 環境變數
PI_WEBUI_PASSWORD=secret pi-webui

# 場景 E: trust-proxy
pi-webui --password a --trust-proxy &
curl -i -H "X-Forwarded-Proto: https" \
  -H "Content-Type: application/json" \
  -d '{"password":"a"}' \
  http://127.0.0.1:4096/api/login           # 預期 Set-Cookie 含 Secure
```

## 風險與緩解

| 風險 | 緩解 |
|---|---|
| password 出現在 process list | README 推薦改用 env var;不另做 secret file 載入,YAGNI |
| 沒 brute force 鎖,public expose 有風險 | 文件指引搭 cloudflare WAF;設計面預留 250ms delay |
| token 全在記憶體,規模膨脹 | 上限 7 day TTL + lazy GC;對 dev 工具規模足夠 |
| port +1 線性搜尋的 TOCTOU(找到後 race) | listen 失敗仍然會 throw,fallback 已涵蓋 EADDRINUSE retry 自我癒合 |
| cookie 在 cloudflare tunnel 下 Secure 行為複雜 | 動態 cookie 屬性 + `--trust-proxy` 明確開關 |
