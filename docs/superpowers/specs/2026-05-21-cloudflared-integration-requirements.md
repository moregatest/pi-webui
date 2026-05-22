# pi-webui × cloudflared tunnel 整合需求

> 狀態:**需求草稿**(未經 brainstorming 釐清,直接由本次事故 + 使用者訴求彙整)
> 用途:作為下一輪對話的 brainstorming 輸入,目標產出 design doc + implementation plan
> 起源事故:2026-05-21 手動串接 pi-webui + cloudflared 過程中遇到的兩起 silent failure

---

## 1. 背景與動機

### 1.1 使用者訴求

讓 pi-webui 啟動時可選地**自動拉起 cloudflared tunnel**,把 listening URL 暴露到外網,以便:

- 工程師在外 / 行動裝置上連回家中或公司機器的 pi-webui
- 臨時對客戶 / 後勤同仁展示 webui
- 不必每次手動 spawn cloudflared、抄密碼、抄 URL

### 1.2 為什麼不留給使用者手動串

手動串了一次的代價是 30 分鐘 debug 兩個 silent failure:

1. **既有 `~/.cloudflared/config.yml` 接管 quick tunnel** → 預設 ingress 規則把所有 hostname 導向 `http_status:404`,沒有 `--config /dev/null` 就會中
2. **寫死 `--url http://127.0.0.1:4097`** → pi-webui 自己有 port fallback(`port..port+49`),若 port 被佔跳到 4098,cloudflared 還指 4097 → 又是 silent 404,連 metrics 都救不了(因為是 connection refused,不是 404)

這兩個錯誤本質一樣:**串接時用了 declared intent 而不是 effective state**。把整段邏輯收進 server 內部、由 server 親自抓自己印出的 actual URL 餵給 cloudflared,就能根除這類錯誤。

### 1.3 預期收益

- **UX**:`pi-webui --tunnel` 一個旗標解決,印一個完整 URL + 密碼塊,可以掃 QR
- **正確性**:由 server 抓自己的 actual port,杜絕跳號 silent breakage;強制 `--config /dev/null` 杜絕舊 config 干擾
- **安全預設值**:`--tunnel` 啟用時自動強制 `--password`(或自動生成)+ `--trust-proxy`,避免 public URL 裸奔

---

## 2. 使用情境

| 情境 | 主要需求 | 適用 tunnel 類型 |
|---|---|---|
| 工程師家裡 / 通勤 → 自己的機器 | 一行旗標、自動產生密碼、可拋棄式 URL | Quick tunnel (trycloudflare.com) |
| 後勤 / 同事臨時 demo | 固定可記憶的域名、密碼可共享 | Named tunnel(需 Cloudflare 帳號) |
| 客戶展示 / 長期暴露 | 固定域名 + Cloudflare Access 第二層認證 | Named tunnel + Access policy(可能超出 pi-webui 範圍) |

---

## 3. 目標(Goals)

- 使用者只要加一個 CLI flag(例如 `--tunnel`)就能拉起 cloudflared 並印出可用 URL
- Server 拿自己 `listening url=...` 印的 actual URL 餵給 cloudflared,**絕對不准用 declared port**
- Tunnel 啟用時強制 / 預設啟用 `--password` 與 `--trust-proxy`,避免裸跑
- cloudflared 子 process 跟著 pi-webui server lifecycle 走(SIGINT/SIGTERM 一起收掉,不留 orphan)
- 啟動時強制 `--config /dev/null` 或同義機制,**完全繞過 `~/.cloudflared/` 既有 config**
- WebUI status bar 顯示 tunnel 狀態(active / error / disabled),hover 看 URL,點擊複製
- 在 extension 端對應 `--webui-tunnel` flag forward

---

## 4. 非目標(Non-Goals)

- **不自動安裝 cloudflared** — 偵測不到 binary 就 fail-fast + 給安裝指引,不 brew install / 下載 binary
- **不做 Cloudflare Access 整合** — 那是 Cloudflare 帳號層級的設定,留給使用者自己在 dashboard 配置
- **不做 rate limit / IP allowlist** — 認證靠 `--password`,進階流控不在這個 scope
- **不持久化 tunnel state** — quick tunnel URL 拋棄式;named tunnel 由 cloudflared 自己的 credentials 管
- **不取代手動 cloudflared** — 進階使用者要自己跑 `cloudflared tunnel` 還是可以,pi-webui 只是提供 convenience wrapper

---

## 5. 核心設計取捨(待 brainstorming 釐清)

### 5.1 Tunnel 類型支援範圍

- **A. 只做 quick tunnel(MVP)** — 最快上線,涵蓋情境 1。Named tunnel 後續加
- **B. 一開始就同時支援 quick + named** — 涵蓋情境 1+2,複雜度高一倍
- **C. 先 quick,named 留架構但不實作** — 折衷

**問題**:後勤 / 客戶展示頻率有多高?是否真的需要 named?

### 5.2 cloudflared binary 來源策略

- 偵測 `$(command -v cloudflared)`,沒裝 → fail-fast + 印安裝指引(`brew install cloudflared` / apt / cargo)
- 是否支援指定路徑?`--cloudflared-bin <path>` 給有客製化安裝的人
- 版本要求?cloudflared 2024+ 應該都 OK,要不要設下限?

### 5.3 lifecycle 與失敗處理

| 階段 | 處理方式 |
|---|---|
| cloudflared 未安裝 | fail-fast,server 不啟動,印安裝指引 |
| pi-webui server 起來但 cloudflared 起不來 | server 繼續跑(本機可用),tunnel 標 error,WS 推 toast |
| cloudflared 30 秒沒 `Registered tunnel connection` | kill + 標 error,不阻塞 server |
| cloudflared 跑中途 crash | log + 不自動 restart(避免 retry storm),status bar 標 error |
| pi-webui server SIGINT/SIGTERM | 確保 cloudflared child 一起收掉(`process.kill(child.pid, 'SIGTERM')`) |

### 5.4 認證強制 / 預設

- `--tunnel` 啟用時:
  - 沒給 `--password`:**自動產生 32 字元亂數**,印在 console + 寫 `<sessionDir>/tunnel-password.txt`(mode 600)
  - 自動 set `--trust-proxy = true`(否則 Secure cookie 不會標)
  - 拒絕 `--listen 0.0.0.0:...`?(避免同時 LAN + tunnel 雙重暴露)還是讓使用者自己負責?

### 5.5 actual URL 抓取機制

實作上有兩條路:

- **A. 抓 log**:start server in-process → 等 listener 觸發 → 拿 `server.address()` 取 actual port → 起 cloudflared(乾淨)
- **B. 同檔案 module 內共用**:tunnel manager 拿到 server 物件,監聽 `listening` event,在 callback 內 spawn cloudflared
- **C. 主動傳遞**:讓 `startListening()` 回傳 actual url,main 拿到後再呼 `startTunnel(url)`

建議 **C** — 把這個邏輯顯式化,測試也容易。

### 5.6 cloudflared 端 config 隔離

- 強制傳 `--config /dev/null`(或對等的 noop config 檔)
- named tunnel 模式下用 `--credentials-file <path>` 顯式指定,避免吃 `~/.cloudflared/<uuid>.json`
- 在 server log 印 `cloudflared launched with config=isolated workspace=...`,留 audit trail

### 5.7 tunnel URL 取得機制

cloudflared 沒有直接的 stdout API 講「我的 URL 是什麼」,要從 stdout/stderr parse:

```
INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
INF |  https://xxx-yyy-zzz.trycloudflare.com                                                       |
```

- 用 regex `/https:\/\/[a-z0-9-]+\.trycloudflare\.com/` 匹配
- 30 秒 timeout
- 拿到後立刻:
  - WS push `tunnel_state` packet 給所有 client
  - 寫進 connected payload(新 client 連上直接拿到)
  - 印在 server console

### 5.8 UX 輸出

啟動完 console 印:

```
================================================================
  pi-webui ready
================================================================
  local:    http://127.0.0.1:4098            (actual port,可能跳號)
  tunnel:   https://blue-fish-xx.trycloudflare.com
  password: A8d2k9Hf7q...  (寫入 ~/.pi/agent/tunnel-password.txt)
  sandbox:  enabled (workspace=/Users/.../lv-tool.com.tw)
================================================================
```

可選:`--tunnel-print-qr` 印 QR code(行動裝置掃),用 `qrcode-terminal` 之類純 JS 套件,不增加 native deps。

### 5.9 WebUI status bar 整合

- 新增 `tunnel` chip:
  - 隱藏:沒開 tunnel
  - 綠色:active,顯示 hostname(`xxx.trycloudflare.com`)
  - 紅色:error,hover 看訊息
- 點擊複製完整 URL 到剪貼簿
- `connected` packet payload 新增 `tunnel: { enabled, url, error } | null`

### 5.10 CLI / env 介面草案

```
--tunnel                          啟用 quick tunnel(預設,trycloudflare.com)
--tunnel-name <name>              named tunnel,指定 tunnel name 或 UUID
--tunnel-credentials <path>       named tunnel 的 credentials JSON
--tunnel-cloudflared <path>       自訂 cloudflared binary 路徑
--tunnel-print-qr                 console 印 QR code

env:
  PI_WEBUI_TUNNEL=1
  PI_WEBUI_TUNNEL_NAME=...
  PI_WEBUI_TUNNEL_CREDENTIALS=...
```

Extension 端:
```
--webui-tunnel
--webui-tunnel-name ...
--webui-tunnel-credentials ...
```

### 5.11 安全考量

- public URL 暴露的範圍由 `--sandbox` 決定 — 強烈建議 tunnel + sandbox 一起用
  - 是否 `--tunnel` 啟用時自動 imply `--sandbox`?還是只警告 + 讓使用者自己決定?
  - 建議:warning,不要強制(有些情境需要 host 全權限)
- 密碼透過 cloudflared edge 傳輸 → HTTPS 自動,沒問題
- cookie 已經 `HttpOnly + Secure + SameSite=Lax`,OK
- 是否要支援 `--tunnel-ttl <duration>`?(自動關閉避免忘了開著)— 後續考慮

---

## 6. 從本次事故學到的設計鐵則

實作時要寫死進 code:

1. **不准用 declared port** — cloudflared 餵的 URL **必須**來自 `server.address()` 或 `listening url=` log,不能來自 args.port / args.listen
2. **不准吃機器層級 config** — cloudflared 啟動**必須**帶 `--config /dev/null`(或同義),named tunnel 用 `--credentials-file` 顯式指定
3. **啟動時印「effective state」** — server console 印的「local URL / tunnel URL / password」都要是 actual 值,不是 declared 值
4. **失敗要顯式** — cloudflared 30 秒沒 register、parse 不到 URL,要 fail loud,不要 silent

---

## 7. 待釐清的問題(brainstorming 起點)

下一輪對話建議從這些問起:

1. 先做 quick only 還是 quick + named 並行?
2. cloudflared 未安裝時 fail-fast 還是讓使用者繼續跑本機?
3. `--tunnel` 是否強制 `--password`(或自動產生)?
4. 密碼自動產生時印 console 還是寫檔還是兩者?(印 console 怕 scrollback,寫檔怕忘記路徑)
5. `--tunnel` 是否自動 imply `--sandbox`?
6. cloudflared crash 後是否自動 restart?retry policy?
7. 是否做 `--tunnel-print-qr`?(對行動裝置很有用)
8. extension 端 `--webui-tunnel` 是否有額外 forward 細節?
9. 跟既有 `--listen 0.0.0.0:...` 衝突時的行為?
10. status bar 顯示 tunnel chip 的設計細節(顏色 / hover / 點擊行為)

---

## 8. 後續流程

```
本文件 (requirements)
    ↓ brainstorming 釐清第 7 節問題
docs/superpowers/specs/YYYY-MM-DD-cloudflared-integration-design.md
    ↓ writing-plans skill
implementation plan (分階段 commits)
    ↓ TDD
實作 + 測試(unit / integration / 真實 cloudflared e2e)
    ↓
README + ROADMAP + CHANGELOG 更新
```

實作切割建議(供 plan 階段參考):

1. cloudflared lifecycle manager 模組(spawn / parse URL / SIGTERM)+ unit test(用 stub child process)
2. server `--tunnel` flag 接線、`startListening` 改回傳 actual URL、串接 manager
3. `--password` 自動生成、密碼寫檔 / 印 console
4. WS `connected` payload 加 `tunnel` 欄位、client status bar chip
5. extension `--webui-tunnel` forward
6. e2e:opt-in 真實 cloudflared 整合測試(`make test-tunnel` 類似 `make test-sandbox`)
7. docs:README sandbox 段落底下加 tunnel 段落,ROADMAP / CHANGELOG 更新

---

## 9. 參考(本次手動串接過程記錄)

完整 debug 過程跟根因分析請見對話歷史。重點摘要:

- 第一次跑 `cloudflared tunnel --url http://127.0.0.1:4097`,Cloudflare edge 回 404 達 30 分鐘
- 試過 `--protocol http2`、retry loop、檢查 cf-ray,都沒用
- 看 `cloudflared` 自己的 metrics endpoint(`127.0.0.1:20241/metrics`)才發現 `tunnel_response_by_code{status_code="404"}` 是 cloudflared 自己回的,不是 origin 也不是 edge
- 查 `cat ~/.cloudflared/config.yml` 發現有舊 ingress 規則,預設導向 `http_status:404`
- 改 `--config /dev/null` 立刻通

第二起:寫死 `--listen 127.0.0.1:4097` 給 cloudflared,沒考慮 port fallback 可能跳號。這次運氣好沒中,但是潛在地雷。

兩起事故的本質相同:**串接時用 declared intent 而非 effective state**。整合進 server 內部後可以根除。
