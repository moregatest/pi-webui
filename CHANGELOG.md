# Changelog

本檔記錄重要變更。實作細節以對應 commit 為準。

## 2026-05-21

### 新增

- `--password <pw>` / `PI_WEBUI_PASSWORD` cookie 登入認證
  - `HttpOnly` + `SameSite=Lax`,7 天 TTL
  - Token 存記憶體,server 重啟自動失效
  - 比對使用 `crypto.timingSafeEqual` 防 timing attack
  - 所有非 `/login`、`/api/login`、`/api/logout`、`/favicon.svg` 請求未通過認證會 redirect 至 `/login`(瀏覽器)或回 401(API/WebSocket)
- `--trust-proxy` / `PI_WEBUI_TRUST_PROXY=1` 控制 cookie `Secure` flag
  - 啟用後讀取 `X-Forwarded-Proto`,當值為 `https` 才標 `Secure`
  - 解決 Cloudflare Tunnel / nginx 等反向代理場景下 cookie 標記的正確性
- 啟動 port 被佔用時自動 +1 找下一個可用 port,上限 50 次(`port..port+49`),實際 port 印在 listening log
- pi extension 端對應旗標:`--webui-password`、`--webui-trust-proxy`
- 獨立登入頁面 `public/login.html`(POST `/api/login` 後 redirect 回原本 next URL)

### 改動

- WebSocket upgrade 改 `noServer: true` + 手動 cookie gate,未認證請求回 401(含 `Content-Length: 0` + `Connection: close`)
- HTTP server handler 改 async + try/catch + 500 fallback
- 啟動 log 加 `auth` 與 `trustProxy` 欄位

### 測試

- 單元測試
  - `src/server/listen.ts`(port fallback、relayEmitter 分支)
  - `src/server/auth.ts`(密碼比對、token 儲存、cookie 解析、Secure 判定)
- 整合測試
  - `test/server-auth-integration.test.mjs`:spawn 真實 server 跑 HTTP / WebSocket auth 流(10 case)
- 端到端驗證(手動)
  - 本地 4 場景:無密碼 / 完整登入流 / port +1 fallback / `--trust-proxy` 開關
  - Cloudflare Tunnel 真實 HTTPS:`--trust-proxy` 啟用時 cookie 標 `Secure`,關閉時不標,對照組成立

### 相關 commits

`5680511..1d00221`(13 commits,涵蓋設計文件、實作計畫、模組實作、測試與 README/ROADMAP 文件更新)
