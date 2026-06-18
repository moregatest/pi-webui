# 對話 session 預設儲存到專案目錄

- 狀態:設計定案(已過一輪 code review 補洞),待寫 implementation plan
- 日期:2026-06-18
- 範圍:server (`src/server/`) + extension (`src/extension/`) + 文件,小型收斂改動

## 1. 背景與問題

pi-webui 的對話 session **早已持久化**,由 pi SDK 的 `SessionManager` 負責:每個 session 是一個 append-only 的 `.jsonl` 檔,server 不自行寫檔。

現況儲存位置是 home 目錄:`~/.pi/agent/sessions/<encoded-cwd>/*.jsonl`(`<encoded-cwd>` 是把 cwd 路徑編碼成安全目錄名)。`PI_SESSION_DIR` env 可完全覆寫,但目前沒有「依專案目錄自動落地」的機制。

需求:把**預設**儲存位置改到專案目錄下,跟 `.pi/profiles`、`.pi/skills-allow.txt` 同一個慣例位置。

關鍵事實(已核對 SDK dist 與本專案 source):

- `SessionManager.create(cwd, sessionDir)` → `dir = sessionDir ?? getDefaultSessionDir(cwd)`;傳入自訂 `sessionDir` 時 SDK 直接用該路徑,**並在 constructor 自動 `mkdirSync(dir, { recursive: true })`**(`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:445`),不需我們手動建目錄。
- `SessionManager.list(cwd, sessionDir)` 同樣吃自訂 `sessionDir`(同檔 `:1055`);**它列出該目錄下全部 session,不依 header `cwd` 過濾**。
- `SessionManager.listAll()` 只掃 home `~/.pi/agent/sessions/`,**無法**列出專案目錄下的 session(SDK 端,本專案不改它)。
- `runtime.switchSession(path)` → `SessionManager.open(path, undefined, cwdOverride)`,未給 `sessionDir` 時取**檔案父目錄**為 dir(`agent-session-runtime.js:130`);`runtime.newSession()` → `sessionDir = 當前 manager.getSessionDir()`(`agent-session-runtime.js:148`)。⇒ resume 一個外部目錄的 session 後,其 `/new` 後代會繼續寫回該外部目錄。
- `handleReady()` 在 client `ready` 帶 `sessionFile` 時會 auto-resume(`switchSession`,`src/server/index.ts:2071`),已有 sandbox 跨 workspace 擋阻先例;且已有同步讀 session header cwd 的工具 `readSessionCwdSync(sessionFile)`(`:844`,sandbox guard `:2056` 已用)。
- client 每次 `session_state` 都把 `sessionFile` 存進 localStorage(`public/app.js:859`),重連 `ready` 帶回(`:90`)。⇒ reconnect guard **必須依 session 自身 header cwd** 判定,不能用「啟動 cwd」,否則 `/cwd` 切換後重連會把合法的他專案 project-local session 誤判為外部。

## 2. 決策(brainstorming + code review 已定)

1. **啟用模式**:改成預設專案目錄(不是 opt-in,不是匯出)。
2. **退路旗標**:不做 `--global-sessions`。要回 home 自己用 `--session-dir` / `PI_SESSION_DIR` 指路徑。
3. **picker 範圍**:只顯示專案目錄的 session;拿掉跨專案 `listAll()` 合併。
4. **`/cwd` 最近清單**:接受 legacy home-only(`collectRecentCwds()` 不改),文件註明專案目錄 session 不進此清單;`/cwd` 仍可手動瀏覽目錄切換。
5. **resume 目錄黏性**:reconnect 只接受「貨真價實的 project-local(或 override 目錄)session」。`handleReady` 依 stored `sessionFile` 的 **header cwd** 算出該 session 應在的目錄,檔案不在該目錄內就忽略,改用啟動時建好的專案目錄 session。
   - 既有 home 舊 session(在 `~/.pi/agent/sessions/...`)→ 一律被擋,既有使用者一重連即吃到專案目錄預設。
   - `/cwd` A→B 後 B 的 project-local session(header cwd=B,落 `B/.pi/sessions`)→ 通過,重連保留 B(修正 P1)。
   - **統一規則取代「explicit /resume 跨 reload 維持黏性」的舊說法**:reload 後是否續接,只看「它是不是自身 cwd 的 project-local/override session」,與當初經 auto-resume 還是 explicit `/resume` 進 localStorage 無關。explicit `/resume <path>` 在當前 runtime 內照樣可載入任意外部 session,只是若該 session 非 project-local,reload 不會續接(解 P2 語義衝突)。

## 3. 設計

### 3.1 預設儲存路徑

新建/切換的 session `.jsonl` 預設寫到:

```
<cwd>/.pi/sessions/<timestamp>_<sessionId>.jsonl
```

因為已經是 per-project 目錄,**不再需要** `<encoded-cwd>` 子層。

### 3.2 純函式模組 `src/server/session-dir.ts`

比照 `watch.ts` 只匯出可測試純函式的模式,放兩個純函式:

```ts
import { dirname, join, resolve } from "node:path";

// CLI > env > 預設(<cwd>/.pi/sessions)。
// override(CLI/env)為絕對路徑、跨 cwd 共用;預設隨 cwd 重算。
export function resolveSessionDir(
  cwd: string,
  opts: { cliSessionDir?: string; envSessionDir?: string } = {},
): string {
  const override = (opts.cliSessionDir || "").trim() || (opts.envSessionDir || "").trim();
  if (override) return resolve(override);
  return join(cwd, ".pi", "sessions");
}

// reconnect guard 用:session 檔是否落在指定目錄(SDK 扁平存放,比對父目錄即可)。
export function isWithinSessionDir(sessionFile: string, sessionDir: string): boolean {
  return dirname(resolve(sessionFile)) === resolve(sessionDir);
}
```

- 優先序對齊本專案慣例 **CLI > env > 預設**。
- override 一律 `resolve()` 成絕對路徑,避免 `/cwd` 切換後相對路徑語意飄移。
- 預設值依 `cwd` 計算 → 每次 `/cwd` 切換要重算。

| 順位 | 來源 | 值 |
|---|---|---|
| 1 | CLI `--session-dir <path>`(新增) | `resolve(path)` |
| 2 | env `PI_SESSION_DIR`(既有) | `resolve(path)` |
| 3 | 預設 | `join(cwd, ".pi", "sessions")` |

### 3.3 server 接線(`src/server/index.ts`)

import:`import { resolveSessionDir, isWithinSessionDir } from "./session-dir.js";`

**(a) parseArgs 加旗標(雙形式)** —— 既有字串旗標都有 `--x value` 與 `--x=value` 兩種(`:307-320`),必須一致:

```js
else if (a === "--session-dir") out.sessionDir = argv[++i];
else if (a.startsWith("--session-dir=")) out.sessionDir = a.slice("--session-dir=".length);
```

**(b) module 層級輸入** —— 移除舊的 `const sessionDir = process.env.PI_SESSION_DIR;`(`:701`),改保留兩個來源:

```js
const cliSessionDir = args.sessionDir;
const envSessionDir = process.env.PI_SESSION_DIR;
```

**(c) `init()`(`:1668`)**:
`sessionManager: SessionManager.create(this.cwd, resolveSessionDir(this.cwd, { cliSessionDir, envSessionDir }))`

**(d) `switchCwd()`(`:1720`)**:
`SessionManager.create(newCwd, resolveSessionDir(newCwd, { cliSessionDir, envSessionDir }))`

**(e) 啟動 logger 編譯點(`:2462`)** —— 舊 `sessionDir` 常數移除後 `sessionDir: sessionDir || undefined` 會編譯失敗。改成啟動時的解析值(`appCwd` 此時在 scope):

```js
const initialSessionDir = resolveSessionDir(appCwd, { cliSessionDir, envSessionDir });
// ...
sessionDir: initialSessionDir,
```

(此為**啟動 cwd** 的值;`/cwd` 切換後每個 cwd 的預設會各自重算。)

### 3.4 picker 只顯示專案目錄

`/resume` handler(`:1594`)與 `sendSessions()`(`:1952`)目前都 `Promise.all([list(cwd, sessionDir), listAll()])`。改成只列當前專案目錄:

```js
const dir = resolveSessionDir(cwd, { cliSessionDir, envSessionDir });
const currentProject = await SessionManager.list(cwd, dir);
// allProjects 拿掉 listAll();picker 不再跨專案
```

- packet 形狀**不變**(`{ currentProject, allProjects }`,`allProjects: []`),降低 client 改動面。
- `resume` handler 用 `ctrl.runtime.cwd`;`sendSessions()` 用 `this.runtime.cwd`。

取捨(已接受):picker 不再列其他專案的 session。替代路徑:`/resume <絕對路徑>` 仍可載入任意位置;localStorage 記住的上次 `sessionFile` 受 §3.6 reconnect guard 約束。

**注意**:若使用者設了 `--session-dir` / `PI_SESSION_DIR` 為跨 cwd 共用目錄,`SessionManager.list(cwd, dir)` 會列出該目錄全部 session(不依 header `cwd` 過濾)。文件需註明 override 是完全覆寫、可能跨 cwd 共用。

### 3.5 client(`public/app.js`)—— 不需改

`showSessionPicker()`(`:1153`)是把 `currentProject + allProjects` 去重合併、無分組標題(`:1159-1168`)。`allProjects` 恆為 `[]` 時自然不顯示任何多餘內容,**毋須改動**。

### 3.6 reconnect guard(#5,`handleReady`,`:2050`)

在既有 sandbox 跨 workspace 擋阻之後、`switchSession` 之前插入。**依 session 自身 header cwd**(不是 `this.cwd`)算出它應在的目錄,檔案不在該目錄就忽略,fall through 用當前 session:

```js
if (sessionFile) {
  const sessionCwd = readSessionCwdSync(sessionFile);            // 既有工具(:844)
  const dir = resolveSessionDir(sessionCwd || this.cwd, { cliSessionDir, envSessionDir });
  if (!isWithinSessionDir(sessionFile, dir)) {
    logger.info("ignoring stored session outside its project session dir", { sessionFile, sessionCwd, dir });
    sessionFile = null; // 落入既有 else 分支:sendBootstrap reset,用當前 session
  }
}
```

`switchSession()` 成功後同步 `this.cwd = this.runtime.cwd`(P1):resume 一個 `/cwd` 切換後的 B session 時,讓 controller 的 `this.cwd` 跟上,避免 `/cwd` picker「current」與後續 `resolveSessionDir(this.cwd)` 還停在啟動 cwd。

- **P1 修正**:`/cwd` A→B 後 B 的 session(header cwd=B,落 `B/.pi/sessions`)→ `resolveSessionDir(B)` = `B/.pi/sessions` → 通過,重連保留 B。若用 `this.cwd`(=A)會誤擋。
- **#5 目標**:home 舊 session(header cwd=X,但檔案在 `~/.pi/agent/sessions/...` 而非 `X/.pi/sessions`)→ 不通過 → 丟棄 → 用 `this.cwd` 的專案目錄預設。
- **P2 解法**:接受與否只看「是不是自身 cwd 的 project-local/override session」,不分當初怎麼進 localStorage。explicit `/resume` 外部 session 在當前 runtime 可用,但 reload 不續接(除非它本身就是 project-local)。
- 自我修復:client 開始新對話後 `session_state` 更新 localStorage 成專案目錄路徑,下次重連即一致。
- 邊界:正常重連同一 session 時 `sessionFile === current`,整段 skip。sandbox guard 仍先跑(sandbox 模式 `sessionCwd !== workspaceRoot` 早一步被擋)。

### 3.7 `/cwd` 最近清單(#4)—— 接受 legacy home-only

`collectRecentCwds()`(`:685`)仍用 `SessionManager.listAll()`,**不改**。專案目錄 session 不會進 `/cwd` 的最近清單;`/cwd` 的目錄瀏覽(`listDirectories`)不受影響,使用者仍可手動切換。文件註明此限制。

### 3.8 extension 對齊(`src/extension/index.ts`)

逐旗標 explicit forward(比照既有 `--webui-skill-allow-file`):

- RunOpts/StartOptions 型別(`~:90`)加 `sessionDir?: string;`
- `registerFlag("webui-session-dir", { ... })`(`~:377` 區塊)
- `getFlag`:`sessionDir = String(pi.getFlag?.("webui-session-dir") || "").trim();`(`~:660` 區塊)
- **`want` 條件(`:667-700`)加** `sessionDir.length > 0` —— 否則只設 `--webui-session-dir` 不會 implied 啟動。
- `runStart` opts(`:711` 區塊)加 `sessionDir: sessionDir || undefined,`
- forward(`:142` 區塊):`if (opts.sessionDir) serverArgs.push("--session-dir", opts.sessionDir);`
- `/webui start` 的 `parseStartFlags()`(`:259`)加**雙形式**:
  ```ts
  else if (t === "--session-dir") opts.sessionDir = valueOf(++i, t);
  else if (t.startsWith("--session-dir=")) opts.sessionDir = t.slice("--session-dir=".length);
  ```

## 4. 相容性

- `--sandbox`:session 儲存本就在 host 行程跑,`<cwd>/.pi/sessions/` 落 host,與 VM 內 `/workspace` mount 無衝突;sandbox 既有的跨 workspace 擋阻與 §3.6 guard 並存(先 sandbox 後 dir guard)。
- `PI_PROJECT_CWD`:預設由 cwd 推導 → 自動跟著走。
- **既有 home 舊 session 不自動搬**。檔案保留在 `~/.pi/agent/sessions/`;reconnect 不再自動續接(§3.6),要載入用 `/resume <路徑>`。
- watch(`startFileWatch`)監看當前 session 的 `.jsonl` 絕對路徑,與儲存目錄改動無關,不需改。

## 5. 測試

- 新增 `test/session-dir.test.mjs`(`node --test`,import 自 `dist/server/session-dir.js`,比照 `test/server-watch.test.mjs`):
  - `resolveSessionDir`:CLI 勝出(回 `resolve(cli)`)、env 次之、兩者皆無回 `<cwd>/.pi/sessions`、相對 override 被 `resolve()` 成絕對。
  - `isWithinSessionDir`:同目錄 `true`、外部目錄 `false`、相對/絕對混合經 `resolve()` 後正確比對。
- guard 「依 session header cwd 判定」這一層(`readSessionCwdSync` + `handleReady` 串接)屬整合行為,由 §9 案例 C/C2 手動驗收;單元測試只保純函式 `resolveSessionDir` / `isWithinSessionDir`。
- `make precommit`(`make lint` = tsc --noEmit + node --check;`make test` = build + node:test)需綠燈。

## 6. 文件 / 安全

- `README.md`:旗標表加 `--session-dir <path>`;更新 env 表 `PI_SESSION_DIR`(說明它是完全覆寫、可能跨 cwd 共用)+ 新預設說明;extension `--webui-*` 清單加 `--webui-session-dir`;補一小段 session 落地位置與覆寫優先序;註明 `/cwd` 最近清單只反映 home。
- **server `--help` 文字(`:240` 旗標段、`:292` env 段)** —— 不只改 README:旗標段加 `--session-dir`,env 段更新 `PI_SESSION_DIR` 說明。
- `ROADMAP.md`:(a) 加一條 done「session 預設存專案目錄 `.pi/sessions/`」;(b) **既有 `:18` 的 `[x] list sessions across all projects` 必須一併處理** —— picker 移除 `listAll()` 後此能力已不再,改成「legacy cross-project picker removed(sessions 改 project-local)」或移出 done 能力清單,否則文件失真。
- `.gitignore`:加 `.pi/sessions/`(對話含敏感內容不入庫;`.pi/` 其餘 committed 檔不受影響)。README 提醒下游專案比照。

## 7. 改動檔案清單

| 檔案 | 動作 |
|---|---|
| `src/server/session-dir.ts` | 新增(`resolveSessionDir` + `isWithinSessionDir`) |
| `src/server/index.ts` | parseArgs 雙形式旗標;module 層級兩個輸入;`init`/`switchCwd`/`resume`/`sendSessions` 用 `resolveSessionDir`;拿掉 `listAll()`;logger 編譯點;`handleReady` reconnect guard(依 `readSessionCwdSync` 取 header cwd + 成功後同步 `this.cwd`);`--help` 文字 |
| `src/extension/index.ts` | 型別 + registerFlag + getFlag + `want` + runStart + forward + `parseStartFlags` 雙形式 |
| `test/session-dir.test.mjs` | 新增 |
| `README.md` | 旗標/env 表 + extension 清單 + session 說明 + `/cwd` 限制 |
| `ROADMAP.md` | done 區塊 |
| `.gitignore` | 加 `.pi/sessions/` |

(`public/app.js` 經確認**不需改**,見 §3.5。`collectRecentCwds` 經決策**不改**,見 §3.7。)

## 8. 非目標(YAGNI)

- 不做 `--global-sessions` 反轉旗標。
- 不自動搬移既有 home session。
- 不做跨專案 session picker(已移除 `listAll()`)。
- 不做 `/cwd` 最近清單的 project-local 索引(接受 home-only)。
- 不改 `/new` 的 SDK 繼承行為(改走 §3.6 reconnect guard 達到「預設生效」)。
- 不為「explicit `/resume` 外部 session 跨 reload 續接」另加狀態旗標;reload 一律走 §3.6 統一判定(解 P2,避免額外狀態與改動面)。
- 不改 SDK,不動 watch 機制,不動 `src/server/index.ts` 的 `@ts-nocheck`。

## 9. 實地驗收測試方案(手動,實作完成後跑)

對象專案目錄(實地):`/Users/tung/Codes/readyaiJobs/www.kingcasting.com.tw/`(以下簡稱 `$D`)。

選它的理由:目前**尚無** `.pi/sessions/`,可乾淨驗證預設會自動建出專案目錄;它**不是 git repo**,session 檔不會誤入庫;走 project-local 也**不污染** home 的 session。

前置:`cd /Users/tung/Codes/pi-webui && make`(重 build);`readyai-webui` 已在 PATH;pi auth 正常(送 prompt 需要)。測試用 `--listen 127.0.0.1:4097` 避開預設埠衝突。

| # | 案例 | 步驟 | 預期 |
|---|---|---|---|
| A | 預設落地專案目錄 | `cd $D && readyai-webui --listen 127.0.0.1:4097`;開 `http://127.0.0.1:4097`,送一句短 prompt | `$D/.pi/sessions/<ts>_<id>.jsonl` 出現;啟動 log `listening` 的 `sessionDir` = `$D/.pi/sessions`;檔案首行 header `cwd` == `$D` |
| B | picker 只列專案目錄 | 同一 server,`/new` 開第二個 session 後再送一句;觸發 `/resume` picker | 只列 `$D/.pi/sessions/` 內的 session;**不**出現 home / 其他專案的舊 session |
| C | reconnect guard 擋 home(#5) | 先 `ls ~/.pi/agent/sessions/*/*.jsonl | head -1` 取一個舊 home 路徑;DevTools console `localStorage.setItem('pi-webui:session-file','<該 home 路徑>')` 後 reload | server log 出現 `ignoring stored session outside its project session dir`;UI 用 `$D` 的專案目錄 session;接著 `/new` 寫進 `$D/.pi/sessions/`(非 home) |
| C2 | reconnect 保留 `/cwd` 後的 B(P1) | server 仍在 `$D` 啟動;UI `/cwd` 切到另一個目錄 B 並送一句(B 產生 `B/.pi/sessions/...`);reload | **不**出現 ignore log;UI 續接 B 的 session(驗證 guard 依 session header cwd 而非啟動 cwd) |
| D | override 優先序 | (1) `cd $D && PI_SESSION_DIR=/tmp/pi-sess-env readyai-webui --listen 127.0.0.1:4097` 送 prompt;(2) 再加 `--session-dir /tmp/pi-sess-cli` | (1) 落 `/tmp/pi-sess-env`;(2) CLI 勝出落 `/tmp/pi-sess-cli`,皆**不**落 `$D/.pi/sessions` |
| E | extension 路徑 | 在 pi 內 `/webui start --session-dir /tmp/pi-sess-ext`(或 `pi --webui-session-dir /tmp/pi-sess-ext`)送 prompt | session 落 `/tmp/pi-sess-ext`;驗證 server 與 extension 兩邊旗標 forward 一致 |
| F | `/cwd` 限制(已知) | `/cwd` 開最近清單 | 確認新建的 `$D` project-local session **不**出現在最近清單(§3.7 接受的 home-only 限制),目錄手動瀏覽切換仍可用 |

收尾:停 server;清測試產物 `rm -rf "$D/.pi/sessions" /tmp/pi-sess-*`(視需要保留);若要永久化,於 `$D/.gitignore` 比照 `.claude-sessions/` 加 `.pi/sessions/`(該目錄目前非 git repo,屬選配)。

備註:A/B/C/D/E 需送實際 prompt(耗 token、需 auth);F 僅 UI 操作。此為**手動驗收**,不納入 `node:test`(§5 仍是純函式自動測試)。
