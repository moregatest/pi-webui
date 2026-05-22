# pi-webui × cloudflared quick tunnel 整合設計

date: 2026-05-22
status: draft (待 review)
requirements: `docs/superpowers/specs/2026-05-21-cloudflared-integration-requirements.md`

## 目標

為 pi-webui 加上可選的 cloudflared quick tunnel 整合,讓使用者用一個旗標
(`--tunnel`)就把 server 暴露到 trycloudflare.com,而不必手動 spawn
cloudflared、抄密碼、抄 URL。

啟用方式 opt-in,預設關閉;未啟用時行為與今日 100% 一致,完全不會嘗試
spawn cloudflared、不會檢查 binary 是否存在。

設計重點(從 2026-05-21 手動串接事故學到的鐵則):

1. **不准用 declared port** — cloudflared 餵的 URL 必須來自 `listenWithFallback`
   回傳的 actual port,絕對不能來自 args.listen
2. **不准吃機器層級 config** — cloudflared 啟動寫死 `--config /dev/null`,
   徹底繞 `~/.cloudflared/config.yml` 的舊 ingress 規則
3. **啟動時印 effective state** — banner 印的「local URL / tunnel URL / password」
   都是 actual 值
4. **失敗顯式** — cloudflared 未安裝 fail-fast;30 秒沒拿到 URL 標 error
   並停子 process

## 非目標

- **Named tunnel(固定域名)**:MVP 只做 quick tunnel(trycloudflare.com)。
  Named tunnel 涉及 Cloudflare account / credentials,複雜度高,留待真實需求出現
- **Cloudflare Access 第二層認證**:那是 Cloudflare dashboard 層的事,pi-webui 不碰
- **自動安裝 cloudflared**:偵測不到 binary 就 fail-fast,不 `brew install` / 下載 binary
- **自動 restart**:cloudflared 中途 crash 不 retry(quick tunnel URL 拋棄式,
  retry 也是換新 URL,反而會掩蓋根本問題)
- **QR code 印出**:scrollback 自己拿 URL 貼手機就行,不拉 dep
- **`--tunnel-ttl <duration>` 自動關閉**:後續再考慮
- **Windows 支援**:跟 sandbox 一致,先以 macOS / Linux 為主
- **rate limit / IP allowlist**:認證靠 `--password`,進階流控不在 scope

## 架構

```
┌───────────────────────────────────────────────────────────────────┐
│ pi-webui 進程                                                       │
│                                                                    │
│  ┌──────────────────┐    ┌─────────────────────────────────────┐  │
│  │ src/server/      │    │ src/server/tunnel.ts (新增)         │  │
│  │   index.ts       │    │                                     │  │
│  │                  │───▶│   class TunnelManager               │  │
│  │ listenWithFallback│    │     extends EventEmitter           │  │
│  │  → actualUrl      │   │     - start(actualUrl)              │  │
│  │                  │    │     - stop()                        │  │
│  │ new TunnelManager│    │     - getState()                    │  │
│  │   .start(url)    │    │                                     │  │
│  │   on 'state'     │◀───│   events:                           │  │
│  │   on 'url'       │    │     'state'  { phase, url?, error? }│  │
│  │   on 'error'     │    │     'url'    string                 │  │
│  │                  │    │     'error'  Error                  │  │
│  │ gracefulShutdown │    │                                     │  │
│  │   tunnel.stop()  │    │   spawn('cloudflared', [            │  │
│  │                  │    │     '--no-autoupdate',              │  │
│  │ broadcastTunnel  │    │     '--config', '/dev/null',        │  │
│  │   State(s) →     │    │     'tunnel', '--url', actualUrl,   │  │
│  │   sendJson(...)  │    │   ])                                │  │
│  └──────────────────┘    └─────────────────────────────────────┘  │
│         │                              │                          │
│         │ ws broadcast                 │ stdout/stderr parse       │
│         ▼                              ▼                          │
│  All connected WSs            cloudflared child process            │
│  { type: 'tunnel_state' }                                          │
└───────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
                              trycloudflare.com edge
                              https://xxx-yyy-zz.trycloudflare.com
```

### 組件

- **`src/server/tunnel.ts`**(新增):唯一 spawn cloudflared 的檔案。
  封裝 child lifecycle、stdout/stderr URL parse、event emit。
- **`src/server/index.ts`**(改):
  - flag 解析(`--tunnel` / `--tunnel-cloudflared`)
  - 啟動時偵測 cloudflared binary、自動產生密碼、自動 `trust-proxy`、印 warning
  - `listenWithFallback` 之後 `new TunnelManager().start(actualUrl)`
  - tunnel events broadcast 到所有 WS
  - `gracefulShutdown` 串 `tunnel.stop()`
  - `connected` packet 多帶 `tunnel` 欄位
- **`src/extension/index.ts`**(改):forward `--webui-tunnel` /
  `--webui-tunnel-cloudflared` 到對應 server flag
- **`public/app.js`**(改):
  - `connected` payload 的 `tunnel` 欄位渲染 status bar chip
  - 新增 `tunnel_state` packet handler
- **`public/styles.css`**(改):tunnel chip 顏色狀態
- **`test/tunnel.test.mjs`**(新增):純單元,stub `child_process.spawn`
- **`test/server-tunnel.test.mjs`**(新增):server 整合,假 cloudflared
- **`Makefile`**(改):新增 `test-tunnel`(opt-in 真實 cloudflared)

## CLI Flag / 環境變數

新增兩個 server flag,風格對齊既有 `--sandbox` / `--password`:

| Flag | Env var | 預設 | 說明 |
|---|---|---|---|
| `--tunnel` | `PI_WEBUI_TUNNEL=1` | off | 啟用 quick tunnel(trycloudflare.com)。會自動產生 password、自動 trust-proxy |
| `--tunnel-cloudflared <path>` | `PI_WEBUI_CLOUDFLARED` | `cloudflared`(走 PATH) | 自訂 cloudflared binary 路徑 |

Extension 端對應(沿用既有 `--webui-*` forward pattern):

| Extension flag | 對應 server flag |
|---|---|
| `--webui-tunnel` | `--tunnel` |
| `--webui-tunnel-cloudflared <path>` | `--tunnel-cloudflared <path>` |

## 安全預設與檢查

`--tunnel` 啟用時,在 `listen` 之前依序檢查:

1. **cloudflared binary**:`which <tunnelCloudflared>` 找不到 → exit(2),stderr 印:
   ```
   error: --tunnel requires cloudflared binary on PATH.
   install:
     macOS:  brew install cloudflared
     Linux:  https://pkg.cloudflare.com/index.html
     cargo:  cargo install cloudflared
   ```
2. **password 必備**:`args.password` / `PI_WEBUI_PASSWORD` 都沒給 → 自動產生
   32 字元 base64url 亂數,設成 `authPassword`,並在 banner 印出 + 寫
   `<agentDir>/tunnel-password.txt`(mode 600)
3. **trust-proxy 必備**:`!trustProxy` → 自動 set `trustProxy = true`(否則
   cloudflared edge → 127.0.0.1 走 plain http,cookie 不會帶 Secure)
4. **0.0.0.0 警告**:`host === '0.0.0.0'` → stderr 印 warning(允許,但提醒
   LAN 額外暴露不是 tunnel 加的)
5. **sandbox 警告**:`!sandboxEnabled` → stderr 印 warning「tunnel exposed
   without sandbox; tools have full host access. add --sandbox to restrict.」

順序很重要:1 在 listen 前 fail-fast;2~5 在 listen 前完成,確保 banner 印出
時 password / trust-proxy 已經是 effective 值。

## TunnelManager 介面

```ts
// src/server/tunnel.ts
import { EventEmitter } from "node:events";
import { spawn, ChildProcess } from "node:child_process";

export type TunnelPhase = "idle" | "starting" | "active" | "error" | "stopped";

export interface TunnelState {
  phase: TunnelPhase;
  url?: string;        // 只在 phase === 'active' 有值
  error?: string;      // 只在 phase === 'error' 有值
}

export interface TunnelManagerOptions {
  cloudflaredBin: string;     // 例如 'cloudflared' 或絕對路徑
  startupTimeoutMs?: number;  // 預設 30000
  logger?: { info; warn; error; debug };
}

export class TunnelManager extends EventEmitter {
  constructor(opts: TunnelManagerOptions);
  start(actualUrl: string): void;     // fire-and-forget;結果走 events
  stop(): Promise<void>;              // SIGTERM child,等 exit;idempotent
  getState(): TunnelState;
  // events:
  //   'state' (s: TunnelState)
  //   'url'   (u: string)
  //   'error' (e: Error)
}
```

內部行為:

- `start()` spawn:
  ```
  spawn(cloudflaredBin, [
    '--no-autoupdate',
    '--config', '/dev/null',
    'tunnel', '--url', actualUrl,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  ```
- 同時掛 stdout / stderr line reader,正規式比對:
  ```
  /https:\/\/[a-z0-9-]+\.trycloudflare\.com/
  ```
  (cloudflared 把 URL 印在 stderr,但保險起見兩邊都掛)
- 30 秒 startup timer:沒拿到 URL → `_fail(new Error('cloudflared did not report URL within 30s'))`
  → 內部呼 `stop()` 收掉子 process
- child exit:
  - 已在 `active` 狀態突然 exit → `_fail(new Error('cloudflared exited unexpectedly'))`
  - 已在 `stopping`(`stop()` 呼出去過)→ phase = 'stopped',不算 error
- `stop()`:`kill('SIGTERM')`,等 exit;5 秒未死 `kill('SIGKILL')`;phase = 'stopped'
- `_fail()`:emit 'error' + emit 'state' phase='error',子 process 還活著就 kill
- `getState()`:純讀目前內部 state,給 `connected` packet 用

## 啟動流程(`src/server/index.ts` 末段)

對照現況(`actualPort` 拿到後直接印 listening log),改動如下:

```
const actualPort = await listenWithFallback(server, { host, port, logger, relayEmitter: wss });
const actualUrl = `http://${host}:${actualPort}`;

let tunnel: TunnelManager | null = null;
if (tunnelEnabled) {
  // 已在前段 fail-fast 過 binary 偵測,這邊直接 spawn
  tunnel = new TunnelManager({
    cloudflaredBin: effectiveTunnelBin,
    logger,
  });
  tunnel.on('state', (s) => broadcastTunnelState(s));
  tunnel.on('url', (u) => {
    logger.info('tunnel active', { url: u });
    process.stdout.write(`  tunnel:   ${u}\n`);
  });
  tunnel.on('error', (e) => {
    logger.error('tunnel error', { error: e.message });
  });
  tunnel.start(actualUrl);
}

printBanner({ actualUrl, tunnelEnabled, authPassword, sandboxEnabled, ... });

// gracefulShutdown:
async function gracefulShutdown(signal) {
  ...
  if (tunnel) {
    try { await tunnel.stop(); }
    catch (e) { logger.warn('shutdown: tunnel stop failed', { error: ... }); }
  }
  if (sandbox) { ... }
  ...
}
```

`broadcastTunnelState` 需要拿到所有目前的 WS clients。新增模組層級
`activeControllers: Set<NativePiSessionController>`(目前 codebase 沒這個),
WS connect 時 add、close 時 remove,broadcast 時遍歷呼
`sendJson(ctrl.ws, { type: 'tunnel_state', payload: s })`。

`effectiveTunnelBin` 解析優先序:`args.tunnelCloudflared ?? process.env.PI_WEBUI_CLOUDFLARED ?? "cloudflared"`(同既有 CLI 旗標 > env > default 的慣例)。

`connected` packet payload 改成:

```js
{
  type: "connected",
  payload: {
    ...,
    tunnel: tunnelEnabled
      ? { enabled: true, ...tunnel.getState() }
      : null,
  },
}
```

## Banner

```
================================================================
  pi-webui ready
================================================================
  local:    http://127.0.0.1:4098         (actual port)
  tunnel:   (starting...)                  ← tunnelEnabled 才印
  password: A8d2k9Hf7q...                  ← 自動產生時印,寫入 ~/.pi/agent/tunnel-password.txt
  sandbox:  enabled (workspace=/Users/.../lv-tool.com.tw)
================================================================
```

`(starting...)` 那行在 tunnel `'url'` event 觸發時補印(append 一行,不重畫整個
banner)。如果 30s 後仍是 starting → 換成 `tunnel:   (error: 30s timeout)`。

## WS Protocol

新 packet(incremental update,不含 `enabled` — client 已從 connected 拿到):

```js
{
  type: "tunnel_state",
  payload: {
    phase: "starting" | "active" | "error" | "stopped",
    url?: string,
    error?: string,
  },
}
```

時機:`TunnelManager` emit 'state' 時 broadcast 到所有 connected WS。

`connected` payload(對齊 sandbox 的 pattern):

```js
{
  ...,
  tunnel: tunnelEnabled
    ? { enabled: true, phase, url?, error? }
    : null,
}
```

新 client 連上立刻拿到目前狀態,不需要等下一次 state change。

## WebUI Status Bar

新增 `tunnel` chip,規格對齊 `sandbox` chip(`public/app.js` / `styles.css`):

| 狀態 | 顏色 | 文字 | hover | click |
|---|---|---|---|---|
| 未啟用 | 隱藏 | — | — | — |
| starting | 黃 | `tunnel: connecting...` | "Waiting for cloudflared to report URL" | (無作用) |
| active | 綠 | `tunnel: <hostname>` | 完整 URL | 複製 URL 到剪貼簿 |
| error | 紅 | `tunnel: error` | 錯誤訊息 | (無作用) |
| stopped | 灰 | `tunnel: stopped` | "Tunnel was stopped" | (無作用) |

## 失敗處理

| 階段 | 行為 |
|---|---|
| cloudflared 未安裝 | `which` 偵測,exit(2),stderr 印安裝指引;server 不啟動 |
| 啟動 30s 沒 parse 到 URL | TunnelManager 內部 `_fail()` → emit 'error' + 'state'(phase='error');呼 `stop()` 收子 process;server 繼續跑 |
| cloudflared 中途 crash | exit handler 偵測 → `_fail()`;server 繼續跑;chip 變紅;不自動 restart |
| stop() 5s 沒收掉 | 再送 SIGKILL;phase = 'stopped' |
| pi-webui SIGINT/SIGTERM | `gracefulShutdown` 呼 `tunnel.stop()`,等 exit 再退出 |

警告對話(stderr,不阻止啟動):

- `host === '0.0.0.0'` + `tunnel` → "warning: --tunnel with --listen 0.0.0.0:* exposes LAN and public concurrently"
- `!sandboxEnabled` + `tunnel` → "warning: tunnel exposed without sandbox; tools have full host access. add --sandbox to restrict."

## 鐵則(寫死進 code,測試覆蓋)

從事故學到的不可妥協條件:

1. **TunnelManager.start 必須收 actualUrl,不准內部去算 port** —
   `actualUrl` 由 main 從 `listenWithFallback` 回傳值構造
2. **cloudflared spawn args 必須含 `--config /dev/null`** — 寫死,不接受 override
3. **cloudflared spawn args 必須含 `--no-autoupdate`** — 避免 child 卡在 update 流程
4. **password 必備** — `tunnelEnabled && !authPassword` 不可能發生;自動產生機制保證
5. **trust-proxy 必備** — `tunnelEnabled && !trustProxy` 不可能發生;自動 imply 機制保證
6. **拒 URL 隱式 fallback** — parse 不到 URL 不能 fallback 到 declared port,直接 fail

## 測試策略

### `test/tunnel.test.mjs`(純單元,預設 `make test` 跑)

stub `child_process.spawn` 回 fake child(自己控 stdout/stderr/exit):

- 拿到合法 URL → emit 'url' + 'state' phase='active',state.url 正確
- 30 秒沒 URL → emit 'error',state.phase='error',child 被 SIGTERM
- start 後 child 突然 exit code != 0 → emit 'error',state.phase='error'
- stop() 後 child 退出 → state.phase='stopped',不算 error
- stop() 5s 沒退 → SIGKILL,phase='stopped'
- stop() 兩次冪等
- spawn args 含 `--no-autoupdate --config /dev/null --url <url>`(回歸事故鐵則)

### `test/server-tunnel.test.mjs`(server 整合,預設 `make test` 跑)

把 `tunnel-cloudflared` 指向 test fixture 的假 cloudflared script(node script
而非真的 cloudflared)。假 script 印 fake URL 到 stderr:

- spawn 真 server `--tunnel --tunnel-cloudflared <fixture>`
- 驗證 stdout banner 出現 `tunnel:` 行
- WS 連上,`connected` payload 含 `tunnel.enabled = true`
- 收到 `tunnel_state` packet,phase 從 starting → active
- 自動產生密碼有寫到 `<agentDir>/tunnel-password.txt`,mode 600
- SIGTERM server → 假 cloudflared 也收到 SIGTERM
- `--tunnel` 沒帶 binary,且 PATH 找不到 `cloudflared` → server 立刻 exit(2)
- `--tunnel` 同時 `--listen 0.0.0.0:*` → stderr 有 warning
- `--tunnel` 沒 `--sandbox` → stderr 有 warning

### `make test-tunnel`(opt-in,真實 cloudflared)

對照 `make test-sandbox`:

```Makefile
test-tunnel: build
	@echo "==> test-tunnel (opt-in real cloudflared)"
	@TUNNEL_REAL=1 node --test test/tunnel.test.mjs test/tunnel-real.test.mjs
```

`test/tunnel-real.test.mjs` 需要本機有真 cloudflared,跑 1~2 case:

- spawn server `--tunnel`,等 tunnel `'url'` event(timeout 30s)
- `curl https://<url>/login`(透過 trycloudflare edge 真實打回來),收 200 / login 頁
- server SIGTERM,確認 cloudflared 子 process 也死

預設不跑(需網路 + cloudflared 安裝)。

## 實作切割(供 plan 階段參考)

1. `src/server/tunnel.ts` + `test/tunnel.test.mjs`(stub spawn 單元測試)
2. `src/server/index.ts` 新增 `--tunnel` / `--tunnel-cloudflared` 解析、binary 偵測、
   自動密碼 / trust-proxy、warning、串 `TunnelManager`、broadcast、shutdown
3. `connected` payload 加 `tunnel`,WS `tunnel_state` packet,`test/server-tunnel.test.mjs`
4. `src/extension/index.ts` 加 `--webui-tunnel` / `--webui-tunnel-cloudflared` forward
5. `public/app.js` + `styles.css` 加 tunnel chip
6. `Makefile` 加 `test-tunnel`;`test/tunnel-real.test.mjs`(opt-in)
7. `README.md` 加 tunnel 段;`ROADMAP.md` done 區塊加一行;`CHANGELOG.md` 加 2026-05-22 區塊

## 風險與後續

- **`--config /dev/null` 在 Windows 不存在**:目前 pi-webui 整體沒明確支援 Windows,
  跟 sandbox 一致先以 macOS / Linux 為主。Windows 使用者反映再加 platform switch
  (對應的是 `NUL`)。
- **cloudflared 版本 incompatibility**:URL parsing 正規式假設 cloudflared 2024+
  的輸出格式。若使用者用很舊版本可能 parse 不到 → 走「30s timeout」分支,等於
  silent broken。可以後續加 `cloudflared --version` 預檢,目前先靠 timeout 路徑。
- **trycloudflare.com 服務變動**:URL 模式變或 trycloudflare 暫停服務,我們的
  正規式跟 e2e 測試會抓到,設計上沒辦法預防。
- **Named tunnel 需求**:確認真的有客戶展示需求再加;module shape 已預留
  EventEmitter 介面,加 `--tunnel-name` / `--tunnel-credentials` 走另一條 spawn
  args 路徑即可,不需要重構 TunnelManager 對外介面。
