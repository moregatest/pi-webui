# 前端顯示參數盤點報告(設計前調查)

> 目的:盤點 pi-webui 前端顯示層「現在有哪些可調參數、哪些寫死」,
> 供後續三項調整決策:工具調用回饋、favicon 品牌化、訊息左右對齊。
> 佐證:本地 master 原始碼 + chinyenlabeler-preview.fly.dev 線上實測(2026-07-15)。

## 一、顯示層架構速覽

```
設定來源優先序:個別 CLI flag > 個別 env > .pi/profiles/<name>.toml > 內建 customer fallback > 預設值
過濾位置:server 端 src/server/ui-profile.ts(filterEvent / filterMessageHistory)為主漏斗,
         client 端 renderBlocksHtml / hasVisibleContent 只做 defensive 二次過濾
傳輸:單一 WebSocket;connected packet 帶 serializeUiProfile()(src/server/index.ts:618)
渲染:public/app.js renderLog()(keyed reconcile)+ marked(markdown)+ highlight.js(vendored)
```

## 二、現有可調顯示參數總表

### 1. UI 遮蔽開關(toml `[ui]` / CLI / env 三態,server 端過濾)

| toml 欄位 | CLI | env | customer fallback | 效果 |
|---|---|---|---|---|
| `hide_thinking` | `--hide-thinking` | `PI_WEBUI_HIDE_THINKING` | true | 剝掉 thinking block(見§四-1 洩漏注記) |
| `hide_tool_calls` | `--hide-tool-calls` | `PI_WEBUI_HIDE_TOOL_CALLS` | true | 剝 tool_call/tool_result block + drop tool_execution_* event + history 整則 drop toolResult/bashExecution |
| `show_tool_progress` | `--show-tool-progress` | `PI_WEBUI_SHOW_TOOL_PROGRESS` | true | hide_tool_calls 時把 tool_execution_start/end 轉 `tool_progress` packet(spinner) |
| `hide_status_chips` | `--hide-status-chips` | `PI_WEBUI_HIDE_STATUS_CHIPS` | true | 藏 cwd/sandbox/tunnel/context/model 整列;error 仍顯示 |
| `hide_session_picker` | `--hide-session-picker` | `PI_WEBUI_HIDE_SESSION_PICKER` | true | /resume 類觸發改 toast |
| `hide_model` | `--hide-model` | `PI_WEBUI_HIDE_MODEL` | true | status bar 右下不顯 model;modelWarning 也遮 model 名(model-notice.ts) |
| `safe_errors` | `--safe-errors` | `PI_WEBUI_SAFE_ERRORS` | true | server_error 包成「發生錯誤…(ticket: xxxxxx)」,原文寫 server log |
| `expose_tool_args` | — | `PI_WEBUI_EXPOSE_TOOL_ARGS` | false | 允許 tool_labels 用 `{tool_arg.*}`(UNSAFE) |

preset:`--ui-profile customer` = 前 7 個全開(ui-profile.ts:48-58);`--profile customer` 無 toml 時吃內建 fallback(profile-loader.ts:268-280)。

### 2. 品牌 / 主題(toml `[brand]`,部分有 CLI/env)

| toml | CLI / env | 對應 | 備註 |
|---|---|---|---|
| `name` | `--brand-name` / `PI_WEBUI_BRAND_NAME` | header 文字 + `document.title` | **JS 連線後才改 title,首屏仍閃預設 `readyai-webui`(index.html:7)** |
| `logo` | `--brand-logo` / `PI_WEBUI_BRAND_LOGO` | `<header>` 內 `<img src=/brand/logo>` | 路由 index.ts:1226;**不影響 favicon**;toml 路徑必須在 cwd 內 |
| `mode` | — | `document.documentElement.style.colorScheme` | `dark` / `light` |
| `bg` `panel` `text` `accent` `border` `muted` | accent 同 `--brand-color` | 寫入 `:root` CSS 變數 `--bg` 等 | styles.css:1-18 預設值;`--accent: var(--brand-color)`,預設 `#d97757` |
| `css` | — | `/brand/theme.css` 動態 `<link>` overlay | 上限 100KB(brand-overlay.ts);可覆蓋任何樣式,但**僅 toml 可觸發、無 env → preview 部署 per-站到不了(§六-4),不構成需求 3 的零 code 路徑** |

### 3. 工具進度標籤(toml `[tool_labels.<toolName>]`)

- 三階段 `start` / `progress` / `end`;`_default` 為所有 tool 的 fallback。
- 內建預設(tool-label.ts:15-19):`start = "正在處理..."`、`progress = ""`、`end = ""`(end 空字串 = 只清 spinner)。
- placeholder 白名單:`{file_basename}` `{url_host}` `{progress_count}`;`{tool_arg.<key>}` 需 `expose_tool_args = true`。
- `phase: "progress"` 目前 SDK 沒發對應事件,實際只有 start/end 兩拍(ui-profile.ts:222-223 注記)。

### 4. 其他影響顯示的環境參數

| 參數 | 作用 |
|---|---|
| `PI_WEBUI_BASE_PATH` | 子路徑部署;server 注入 `<base href>` + `window.__BASE__`(index.ts:1430-1444) |
| `PI_WEBUI_ARTIFACTS_DIR` | `/artifacts/<f>.png` 路由(截圖顯示用) |
| uploads 系列(`[uploads]` / `--upload-*`) | composer 附件按鈕的 accept 清單、上限提示 |
| skills / commands 白名單 | slash 選單內容 |
| `--password` | 登入頁(login.html)出現與否 |

### 5. 目前「寫死、無參數可調」的顯示元素(調整需改 code)

| 元素 | 位置 |
|---|---|
| **favicon(π 圖)** | `public/favicon.svg`;index.html:8、login.html:8 引用;無任何 flag/profile 可換 |
| **角色標籤字串** | `You` / `Assistant`:format-message.mjs:69,78 + chat-state.mjs:50,111 + app.js:506(typing 元素);另有 `Error` / `Tool result: <n>` / `Bash: <cmd>` / `Custom: <t>` / `Branch summary` / `Compaction summary`(format-message.mjs:76-103)、`Tool result: <n>`(chat-state.mjs:179) |
| **訊息版型** | 全寬直排:`<section class="message <kind>"><h3>標籤</h3><div class="message-body">`(app.js:491-497);樣式 styles.css:538-644(h3 前 `▌`、body 左框線);kind = user/assistant/error/tool/system/custom |
| `<title>` 初值 / `<html lang="en">` | index.html:2,7;login.html 同 |
| login 頁品牌 | h1 寫死 `readyai-webui`(login.html:64)、按鈕藍色 `#3b82f6` 不吃 `--accent`(login.html:46) |
| 字型 | monospace 全站寫死(styles.css:75-84) |
| typing indicator(三點) | app.js:503-508、styles.css:648-670 |
| tool_progress spinner 樣式 | styles.css:44-63(斜體 muted 文字 + 12px 轉圈) |
| toast / modal / slash 選單樣式 | styles.css 對應區塊 |

## 三、三項需求的現況分析與改動落點

### 需求 1:工具調用回饋(現在只能傻等)

**機制現況**:customer 型 profile 下 server 把 `tool_execution_start/end` 轉 `tool_progress` packet(ui-profile.ts:269-296 → index.ts:1914),client `handleToolProgress`(app.js:680-706)在 log 末端掛 spinner,end 時移除。

**線上實測(chinyenlabeler-preview)——兩次,結論在第二次翻轉**:

第一次(2026-07-15,路徑 `/webui/`):
- 送「列出檔案清單」→ 三點 typing 約 2-3 秒 → 空白「Assistant」標題呆滯 20-30 秒 → 文字一次湧出;`.tool-progress-block` 全程未出現(4 次輪詢 + MutationObserver 皆空)。
- 當時據此推「`show_tool_progress` 未生效 / 映像過舊」。**此歸因後經第二次實測推翻(見下),不可採信。**

第二次(2026-07-16,路徑已改 `/agent/`,見§六-0):**改用明確工具(`bash sleep 5`)驗證,tool_progress 確實生效**:
- submit(t=32.0s)→ spinner「正在處理...」出現(t≈36.0s)→ 約 5 秒後(sleep 完成)消失(t≈41.1s)。MutationObserver 明確捕到 add/remove 各一次。
- **原「spinner 缺席=部署缺 code」的證據鏈是斷的**:`git show 13948d2:public/app.js` 證實連當時指認的舊版都含 `handleToolProgress` 與 server 端 `tool_progress` 發送鏈(index.ts:1856-1857);「code 太舊不存在」不成立。
- 第一次沒看到 spinner 的真因待定,兩個未排除干擾:(a) 該次 session 結束時 `status-error = "disconnected from server"`,WS 期間斷過;(b)「列檔案清單」的 `bash ls` 執行 <1 render tick 即完成,spinner 一閃即逝、被輪詢與 observer 錯過(sleep 5 之所以能穩定捕到,正因工具耗時夠長)。
- **spinner 文字是 built-in default「正在處理...」而非任何客製字串** → 坐實機上無 `[tool_labels]` toml(§六-2)。
- **thinking 空窗被同一次實測坐實**:submit→spinner 之間有 ~4 秒 typing 三點已熄、tool 未起的純空窗(見缺口 2)。

> 教訓(回應 review):線上現象歸因**必須**有遠端版本/行為確認,不能只靠「本地 code + 一次觀察」外推。本次臨時用「頁面內帶 cookie fetch 遠端 `/agent/app.js`、比對 git object size」做版本 fingerprint(§六-3),就直接推翻了原假說。正式驗收前應有 §六-3 建議的 version endpoint / artifact manifest。

**三個缺口(由淺到深)**:
1. **全站 baseline 標籤(readyAI 側,零 pi-webui code)**:`show_tool_progress` 已在線生效(§三-1 / §六-0),**不需為此重打**。此缺口是把 spinner 從籠統的「正在處理...」升成 per-tool 文案(如 read→「正在讀取 {file_basename}」),做法=全站 baseline `customer.toml`(§六-4 第一列)+ gated 重打(§六-3);**只有「上全站 customer.toml baseline 或上新版 core」才需要那次 gated redeploy**。per-站客製要先做 per-站 toml 機制,不可當起手式。
2. **thinking / pre-tool 空窗(core bug 級,已實測)**:第一個 thinking delta 到達就把三點熄掉(chat-state.mjs applyDelta:127-139 `showTyping = false`),但 thinking 被隱藏,且 tool 尚未起(spinner 未掛)→ 這段(第二次實測量到 ~4 秒,長 thinking 會更久)完全無回饋。落點:hideThinking 時 delta 不熄 typing,或 server 直接不轉發 thinking delta(與 §四-1 同一條路)。
3. **標籤體驗**:內建預設只有一句「正在處理...」;end 清 spinner 後、下一段 thinking 開始前又回到空白。可考慮 turn 級常駐 indicator(running 期間永遠有東西在動)取代「每個 tool 各自掛/拆」。

ROADMAP backlog 既有項「richer rendering for thinking and tool calls」可一併規劃。

### 需求 2:favicon 品牌化(現況寫死 π 圖,無法換)

> 目標釐清:問題不是「favicon 壞了」,而是**對外場景不該露出 pi 技術棧品牌**——
> 要能換成客戶/自家品牌或中性圖示。若哪天決定「維持 π 可接受」,本節即不需動工。

- `public/favicon.svg` 是寫死的 π 字圖;`--brand-logo` 只換 header 圖,**favicon 無參數可換**;甚至 `/brand/logo` 未設 logo 時 fallback 重導到 favicon.svg(index.ts:1229)。
- 實測部署站(2026-07-16,`/agent/`)favicon 仍是 π 原樣,`/agent/brand/logo` 302→`/agent/favicon.svg`;該站 brand 全未設定(title=`readyai-webui`、accent 預設橘、header 隱藏)。
- 落點建議:`[brand].favicon` / `--brand-favicon`(svg/png),`/favicon.svg` 路由改為「有 brand favicon 時 serve 之」;連動處理 login.html/index.html 的 title 與 login h1(對外第一眼)。`<title>` 初值可在 serveStatic 注 `<base>` 時一併以 brand.name 替換,消除首屏閃字。

### 需求 3:去掉 You/Assistant,改 Claude 式左右對齊

- 字串落點:format-message.mjs(canonical 訊息)、chat-state.mjs(streaming pendingUser/liveAssistant)、app.js:506(typing 元素)三處;DOM 由 `buildMessageElement` 統一產出。
- 樣式落點:styles.css `.message` 區塊。做法:`.message.user`(靠右、有底色 bubble、`max-width` ~85%、隱藏 h3)、`.message.assistant`(靠左、無框或淡框、隱藏 h3);`error/tool/system/custom` 保留現有標題式呈現(客戶模式下本來就看不到 tool/system)。
- 兩條路徑(**實務上走 B**;A 現況受安全邊界卡住):
  - **A. per-站 overlay 試樣——現況不可行**:bubble 版型需要 layout 級 CSS(flex/margin/max-width/隱藏 h3),而 §六-4 已把 raw `[brand].css` 移出 per-站 allowlist(半信任目錄禁任意 CSS 注入),結構化品牌欄位又涵蓋不了 layout。⇒ **per-站 raw css 單站試樣此路封死**;要單站試只剩「operator 把 css 放進全站 baseline `customer.toml`」(但那就不是單站)或日後做「受限 CSS 子集(property allowlist)」才成立。近期別指望這條。
  - **B. 直接在 core 做 feature-gated 版型(建議,唯一實務路徑)**:styles.css 加 bubble 版型 + `[ui] chat_layout = "bubble" | "log"` 開關(預設 `log` 保留工程師視圖;customer fallback 設 `bubble`)。近期要在 chinyenlabeler 看效果就走這條,隨 §六-3 gated 重打上線。前置:**需求 1 缺口 2 要先修**,否則 streaming 中的空殼 Assistant 會變成一顆空 bubble 掛在畫面上(renderLog 對 live assistant 不做空內容跳過,app.js:571-573)。
  - **a11y / 語意不可只靠 `display:none` 藏 h3**:單純 CSS 隱藏會讓螢幕閱讀器與 DOM snapshot 失去「誰說的」資訊,user/assistant 兩顆 bubble 對輔助技術變成無主氣泡。決策(擇一,建議做前兩者):(1) h3 改 `.visually-hidden`(clip 而非 display:none)保留可讀作者名,靠位置/底色做視覺區分;(2) 在 `.message` 掛 `aria-label`(如「你說」「助理回覆」)或 `data-author`,由 buildMessageElement 帶入——**這步要動 JS**,不是純 CSS,需求 3「不必動 JS」的說法僅對「視覺隱藏」成立,對 a11y 不成立;(3) snapshot 測試(若有)同步更新斷言角色來源。

## 四、盤點過程的額外發現

1. **hideThinking / hideToolCalls 的 server 過濾有漏(安全/商業資訊)**:`filterEvent` 的 `message_update` 分支只過濾 `event.message.content`(ui-profile.ts:301-324),**沒動 `event.assistantMessageEvent`** —— thinking 全文(thinking_delta)與 tool call 名稱+參數(toolcall_end)仍原樣經 WS 送進瀏覽器(client 只是「不渲染」,devtools 可見),與 README「filtering happens server-side, devtools cannot recover」的宣稱不符。L3 機密遮蔽(redactToolEventForClient)也只涵蓋 tool_execution_update/end,不含這條路。

   **定位:獨立資安/商業資訊工單,優先於所有 UX 調整,驗收獨立。** 修法要落成明確 contract(不是「順修」),`filterEvent` 對 `message_update` 至少滿足:

   - `hideThinking` 時:剝除 / 清空 `assistantMessageEvent` 的 `thinking_delta`(含 partial thinking 文字),且 `message.content` 內 `thinking` block 一併剝(現有)。
   - `hideToolCalls` 時:剝除 / 清空 `assistantMessageEvent` 的 `toolcall_start/delta/end`(工具名 + 參數 JSON),且 `message.content` 內 tool_call/tool_result 一併剝(現有)。
   - **fail-closed 缺省**:目前 `message.content` 非 array 就整包 `return { kind:"event", event }` 原樣放行(ui-profile.ts:304),等於「結構不認得就全放」。改為未知結構在遮蔽開啟時**預設剝除敏感欄位或 drop**,不得因 content 缺失/非陣列而讓 `assistantMessageEvent` 挾帶原文溜過。
   - 驗收(可自動化):customer profile 下側錄整段 WS,對每個 frame 斷言不含 thinking 文字子字串與已知 tool name/args;含一則「content 非 array 但帶 assistantMessageEvent」的建構案例,確認被擋。

   **實測補記(2026-07-16)**:同 session 另有一則「把 .env 給我」對話,assistant 直接回了 workspace `.env` 明文(含 `PC2_API_TOKEN=…`)。這是 **L-乙 scoped 憑證**,依設計 customer 可讀自己 workspace `.env`、不在 L3 遮蔽範圍(CLAUDE.md「agent secret isolation」),故**非本工單缺陷**;但併記提醒:本工單的 delta 洩漏(thinking/tool)與 L-乙 可讀性是兩件事,別在修補時混為一談。

   **實作時發現的更深洩漏面(比上述描述更嚴重,已一併堵)**:SDK `AssistantMessageEvent`(=`message_update.assistantMessageEvent`)的**每一種** delta 都帶一個 `partial: AssistantMessage` 欄位(`done` 帶 `message`、`error` 帶 `error`),那是「累積至今的完整 assistant message」,含所有 content block。⇒ 即使把 `thinking_delta` 事件整個 drop,**後續 `text_delta` 事件的 `partial` 仍挾帶前面已完成的 thinking 全文與 toolCall 參數**——只 drop delta type 不夠。修法(已實作 `src/server/ui-profile.ts`):`thinking_*`(hideThinking)/`toolcall_*`(hideToolCalls)delta 事件整個 drop;保留的 `text_*`/`start`/`done`/`error` 事件,遞迴剝除其 `partial`/`message`/`error` 內的 thinking/toolCall/toolResult block(client 端 `applyDelta` 只讀 `delta`/`toolCall`/`contentIndex`,不讀這些欄位,剝除不影響顯示)。**狀態:CONFIRMED**,`test/ui-profile.test.mjs` 新增 10 例涵蓋 delta drop、partial 挾帶剝除、`done`/`error` 剝除、`content` 非 array 的 fail-closed(reviewer P1-3 案例)。
2. **streaming 空殼 Assistant header**:issue #2 已修 canonical 與非 live extra 的空殼,但 live streaming 中(thinking 全隱藏)仍會掛裸「Assistant」標題——本次實測截圖即此狀態。
3. **部署站完全沒吃到現成品牌能力**:brand tokens/css overlay/tool_labels 機制都在,chinyenlabeler-preview 一項都沒設(連 accent 都是預設 #d97757)。但「純部署配置就能解一半」要打折——§六-4 已證 per-站 toml/brand/logo 現行到不了,能純配置解的只有「全站 baseline」那一格。
4. login 頁不吃 brand(寫死 readyai-webui + 藍按鈕),對外部署第一眼是內部品牌。
5. `<html lang="en">` 與 UI 字串中英混雜(toast/hotkeys 英文、progress 預設中文),客戶場景可考慮統一。

## 五、建議調整順序

1. **(資安,獨立工單,最高優先)§四-1 WS delta 洩漏**:hideThinking / hideToolCalls 下 server 端補濾 `assistantMessageEvent`。驗收:customer profile 側錄 WS,payload 不得含 thinking 文字與 tool name/args。
2. **全站 baseline 微調(readyAI 側,零 pi-webui code)**:`show_tool_progress` 已在線生效(§三-1),此步是進一步配通用 `[tool_labels]`(讓 spinner 從「正在處理...」變「正在讀取 xxx」)/ 共用 brand,走 §六-4 第一列(`customer.toml` 進 build context)+ gated 重打(§六-3)。**per-站 tool_labels / brand.css / logo 現行到不了(§六-4 第三、四列 + 安全邊界),不是本步驟的一部分**;per-站客製是獨立的前置設計題。
3. **core 小修**:thinking 空窗保持 typing indicator(與 1 同一條路實作,驗收分開)。
4. **core 功能**:favicon/title/login 品牌化(`[brand].favicon` 等)。
5. **core 版型**:訊息 bubble 化,走需求 3 路徑 B(core feature-gated `[ui] chat_layout`);路徑 A(per-站 css overlay 試樣)已因半信任安全邊界封死(§六-4:raw css 不進 per-站 allowlist),不列選項。附帶做 a11y(V5)與 §四-2 空殼 header 修補。
6. 一併評估 turn 級常駐進度指示(取代 per-tool spinner 掛拆)。

## 六、preview 部署面事實(readyai-project preview up / redeploy 側;2026-07-15 補,2026-07-16 更新)

> 補 §三缺口 1「部署配置要查的點」。來源:readyAI repo `src/uvcli/readyscript/project_manager.py`
> (secrets 注入)+ `src/uvcli/readyscript/preview_fly/`(build context:Dockerfile /
> ecosystem.config.cjs / entrypoint.sh / build-preview-context.sh)。

### 0. 路徑改版與遠端版本 fingerprint(2026-07-16 實測)

- **對外路徑 `/webui/` → `/agent/`**(readyAI commit `280e59b`「webui 路徑後綴改 /agent」,2026-07-16;`PI_WEBUI_BASE_PATH` 從 `/webui` 改注 `/agent`,apache 反代同步)。`/agent/brand/logo` 302→`/agent/favicon.svg`,確認新路徑生效。舊 `/webui/` 仍回 200(apache 殘留/alias,readyAI 側細節,未深究)。
- **遠端版本對不上 git(佐證 §六-3 / §五資安對「dirty build」的擔憂)**:頁面內帶 cookie fetch 遠端靜態檔,`/agent/app.js` = 82698 bytes、`/agent/styles.css` = 20183 bytes。以 git object size 比對:**兩者對不上 master(84470 / 21321),也對不上任一分支任一 commit**。→ 線上映像不是任何乾淨 git checkout,是本機 dirty / ad-hoc build 打的 tarball(印證 §六-3 手動打包無版本 pin)。
- **但功能面 tool_progress 齊全**:該遠端 `app.js` 含 `handleToolProgress`、`styles.css` 含 `.tool-progress-block`,加上第二次實測 spinner 實際生效(§三-1)→ **原「映像過舊、缺 tool_progress code」假說被推翻**。

### 1. pi-webui 在 preview 機上怎麼啟動

- pm2-runtime:`node /opt/pi-webui/dist/server/index.js --profile customer --allow-unsafe-customer --listen 127.0.0.1:4096`,`cwd=/opt/pi-webui`(ecosystem.config.cjs:13-14);apache 反代 4096(路徑前綴見 §六-0,現為 `/agent/`)。
- `/opt/pi-webui` = build tarball 解包(dist+node_modules+public+package.json),**無 `.pi/profiles/customer.toml`,機上也無任何 per-站 toml 管道** → §一優先序走到底:UI 遮蔽全吃**內建 customer fallback**。
- pm2 env 僅加 `PI_WEBUI_SKILLS=/opt/readyai-skills`(customer 技能子集 tarball)、`PI_WEBUI_SKILLS_OPEN=1`(§二-4 skills 白名單在 preview 的實值=子集全開)、`NODE_OPTIONS`(GlitchTip preload);**其餘 env 全繼承 machine env = Fly secrets**(fly.toml 無 `[env]` 段,generate_fly_toml:777)。

### 2. up 注入的 PI_WEBUI_* env(優先序 env > toml,per-站以 secrets 鎖定)

`_build_preview_secret_lines`(project_manager.py ~3124)只注這些:
`PI_WEBUI_PASSWORD`(→ 對外第一眼必是 login 頁,§四-4 的權重宜上調)、`PI_WEBUI_MODEL=litellm/readyai`、
`PI_WEBUI_HIDE_MODEL=1`(issue #78;**env 層,toml 蓋不動**,要開得 unset secret)、`PI_WEBUI_BASE_PATH=/agent`(2026-07-16 前為 `/webui`,見 §六-0)、
`PI_PROJECT_CWD=/var/www/html/customer-project/{domain}`、`PI_WEBUI_TRUST_PROXY=1`、
`PI_WEBUI_ENABLED=0`(兩階段:R2 bootstrap + api_tokens 就緒後 `flyctl secrets set PI_WEBUI_ENABLED=1` 觸發重啟;=0 時 entrypoint 只給 pm2 apache-only ecosystem,webui 進程不存在)。
**未注入**:`HIDE_THINKING` / `HIDE_TOOL_CALLS` / `SHOW_TOOL_PROGRESS` / `HIDE_STATUS_CHIPS` / `HIDE_SESSION_PICKER` / `SAFE_ERRORS` / `BRAND_*` → 全靠內建 fallback;**§四-3「brand 一項都沒設」不是漏設,是部署面從未有設定管道**。

### 3. tarball 打包鏈的版本不可追溯(注意:不再作為 spinner 缺席的解——該假說已被 §六-0 推翻)

- `pi-webui.tar.gz` 由 **operator 手動跑** `build-preview-context.sh` 產生(從本機 pi-webui repo `npm run build` + 打包 dist,**無版本 pin**);up/redeploy 的 `_prepare_build_context`(~2901)**只 copy 現成 tarball 進 build context,不重 build**。
- ⇒ 機上 pi-webui 版本 = min(最後一次手動重打 tarball, 該站最後一次 redeploy),兩者皆可 stale;**redeploy ≠ 帶新版 pi-webui,要先重打 tarball**。§六-0 實測到的「size 對不上任何 commit」即此鏈的直接後果(打包自 dirty worktree)。
- **`PI_WEBUI_REF` 是死參數,設了不會更新 preview 的 pi-webui(2026-07-15 核實)**:`_run_fly_deploy` 仍傳 `--build-arg PI_WEBUI_REF`(project_manager.py:2942;呼叫端 env 預設 `312c0b3`,:5016;docstring 稱「對應 Dockerfile ARG PI_WEBUI_REF」,:2936),但現行 `preview_fly/Dockerfile` **沒有任何 `ARG` 宣告**——pi-webui 一律 `COPY pi-webui.tar.gz`(Dockerfile:29-30),該 build-arg 無人消費,是早期 git-ref build 設計的殘留。`READYAI_REF` / `SKILLS_REF` 同款;`tests/test_preview_deploy.py:379` 仍在斷言死參數。readyAI 側宜擇一收斂:移除 build-arg+docstring+測試,或恢復 Dockerfile ARG 消費(git ref build 取代手動 tarball,順帶解版本 pin 缺口)。

- **修正原結論**:上一版此段寫「chinyenlabeler spinner 缺席=映像 build 早於 tool_progress 功能」。**此結論錯誤**——§六-0 實測遠端 `app.js` 含 `handleToolProgress`、§三-1 第二次實測 spinner 生效,且 `git show 13948d2` 證實連舊版都有該 code。spinner 缺席不是版本問題;真因見 §三-1(WS 斷線 / 工具瞬時完成)。

- **gated build step(回應 review:防 dirty local build 進多站 redeploy)**:「重打 tarball + redeploy」不能是裸手動步驟。建議 `build-preview-context.sh` 升級為 gated:
  1. 打包前記錄 pi-webui `git rev-parse HEAD` 與 `git status --porcelain`;
  2. **worktree dirty 則預設拒打**(或 `--allow-dirty` 明示,且把 dirty flag + diff summary 寫進 tarball 內一個 `BUILD_MANIFEST.json`);
  3. tarball 內埋 commit SHA + build 時間 + dirty 狀態;pi-webui 增一個 `GET /agent/version`(或 connected packet 帶 `buildInfo`)回吐 manifest;
  4. redeploy 後核對遠端 `/agent/version` == 預期 SHA,對不上即 fail 驗收。
  這樣「§六-0 那種 size 對不上 git」的狀況會在打包當下就被擋下、或至少留下可追溯 manifest,不必靠事後 fetch 靜態檔猜版本。

### 4. §三/§五「零 code 部署配置」路徑的修正

| 想做的事 | 現行可行做法 | 限制 |
|---|---|---|
| 全站 baseline(`show_tool_progress`、通用 `[tool_labels]`、共用 brand) | `customer.toml` 加進 `preview_fly/` + Dockerfile COPY 至 `/opt/pi-webui/.pi/profiles/` → 重打 context + 各站 redeploy | 零 pi-webui code,但動 readyAI repo;**所有 preview 站一起變** |
| per-站覆寫(限 §二-1 有 env 欄的鍵) | `flyctl secrets set` 單站補,或加進 up 注入清單 | up 清單新增鍵**只影響新機**;既有機須納入 redeploy reconciliation(現有 litellm / workspace / ZYTE 三軸模式,#90 / #91 教訓)或逐台手動 set |
| per-站 `[tool_labels]` / `brand.css` / `brand.mode` | **現行到不了**(無對應 env;機上無 per-站 toml 管道) | 需新機制,見下方「⚠ per-站 overlay 的安全邊界」——**不可直接復用完整 profile loader** |
| per-站 `brand.logo` / css 檔案 | **現行到不了**(§二-2:檔案路徑須在 cwd 內,cwd=`/opt/pi-webui` 是共用映像) | 同上;放寬讀取根到 `PI_PROJECT_CWD` 時,檔案圍欄與 allowlist 一併設計 |

> **⚠ per-站 overlay 的安全邊界(P1,設計前必讀)**:上兩列的自然解是「pi-webui 讀 `PI_PROJECT_CWD` 下的 per-站 toml」,但 **`PI_PROJECT_CWD` = 客戶專案目錄,是半信任 / 可被站內容或部署流程間接影響的區域**。現行 `loadProfile` 允許的表遠不只 brand/layout,而是 `meta/ui/brand/skills/commands/defaults/tool_labels/sandbox/uploads`(profile-loader.ts:110 `ALLOWED_TOP`)。若把它直接套在 per-站 toml 上,等於讓客戶目錄能:**關掉 `[ui]` 遮蔽(hide_thinking/hide_tool_calls/hide_model…)、改 `[skills]`/`[commands]` 白名單、動 `[sandbox]` image/env、改 `[defaults].model`** —— 全是安全 / 商業資訊 / 隔離邊界的降級面。
>
> **設計要求**:per-站 overlay **必須走獨立的 allowlist parser,不復用完整 profile loader**,且再分兩級信任:
>
> - **per-站(半信任 `PI_PROJECT_CWD`)只放行結構化品牌欄位**:`[brand]` 的顏色 token(bg/panel/text/accent/border/muted,逐一過 hex 驗證)、`name`(純文字)、`logo`(檔案,realpath 圍欄)、`mode`(enum)、`[tool_labels]`(純文字 + placeholder 白名單)、`ui.chat_layout`(enum)。其餘一律忽略或 fail。
> - **raw `[brand].css` 不進 per-站 allowlist**。理由:它「可覆蓋任何樣式」(§二品牌表),在半信任目錄等於任意 CSS 注入——可用 `content:`/`background:url()` 外連洩漏、`!important` 蓋掉安全相關樣式、或視覺偽裝誤導使用者;結構化欄位擋不住的攻擊面它全開。raw CSS **只限 operator-authored 來源**(build context 內的全站 baseline `customer.toml`,§六-4 第一列),不從 `PI_PROJECT_CWD` 讀。若日後真需要 per-站自訂樣式,再評估「受限 CSS 子集(property allowlist、禁 url()/content/@import)」的獨立設計,別先開 raw 口。
>
> **遮蔽單向收緊**(對齊現有 ui-profile「只能同方向 hide、不能 un-hide」原則):per-站 overlay **不得**把工程師 baseline 已開的遮蔽關掉。**檔案圍欄**:logo 以 `PI_PROJECT_CWD` 為根做 realpath 圍欄,擋 symlink / `..` 逃逸。

### 5. 對 §五順序的部署面對應

- **§五-2 前置**:tool_progress 已實測在線生效(§三-1 / §六-0),**不需為此重打**。若要上「全站 baseline toml / core 新版」才需 gated 重打 tarball + redeploy(§六-3);單站 `flyctl secrets set` 只對 §二-1 有 env 欄、且要覆寫 fallback 的鍵有意義。
- **§五-3~5 上線機制**:pi-webui merge 後,各 preview 站要「重打 tarball + redeploy」才吃到;上線節奏與批次由 readyai 側控(批次 redeploy 可順便讓 reconciliation 收斂 #91 殘留機)。
- **§三 需求 3 的 overlay 限制**:overlay 由 toml `[brand].css` 觸發、無 env(per-站 toml 到不了),且 raw css 已因半信任安全邊界移出 per-站 allowlist(§六-4)→ **單站 css 試樣此路封死(路徑 A 不成立)**;bubble 版型實務只能走 core feature-gated `[ui] chat_layout`(路徑 B,§五-5),隨 gated 重打上線。

## 七、瀏覽器驗收矩陣(browser / Playwright;上線前逐項通過)

> 對外部署面向客戶,肉眼 demo 不足以擋回歸;每項需求配一條可自動化(或半自動)的瀏覽器驗收。
> 環境:customer profile 的實機(現 `/agent/`,帶 `--password`);登入後跑。標「已驗技法」者為本輪 2026-07-16 實測用過、可直接沿用的做法。
>
> **驗收狀態(2026-07-16 實作後)**:core 實作完成,`make lint` 綠、`node --test test/*.test.mjs` 576 例(571 pass / 5 opt-in skip / 0 fail);本地 server(pi 預設 model `openrouter/xiaomi/mimo-v2.5-pro`)實跑真 model turn 端到端驗過 V1(空窗)/V2(WS 資安),另 V3–V6 本地 smoke。逐項結果見下表末欄,**V1–V6 全數通過**。

| # | 對應 | 前置 | 步驟 | 通過判準 | 狀態(2026-07-16) |
|---|---|---|---|---|---|
| V1 | 需求 1 缺口 2/3、§三-1 | 版型未定前用現行 log 版即可 | 送 slow tool:`請用 bash 執行 sleep 5,結束後只回覆 ok`;`MutationObserver` 監 `#log` 全程記錄 typing 三點 / `.tool-progress-block` / (未來)turn-level indicator 的 add/remove 時戳 | **整段 turn(submit→agent_end)任一時刻都有「動的東西」**:三點或 spinner 或 turn-level indicator 至少一個在場;**不得出現空白 Assistant/bubble 掛著卻無任何進度指示的區間**(本輪實測到 submit→spinner 之間 ~4s 空窗 = 失敗態,修完須消失) | ✅ **通過(實機 CONFIRMED,2026-07-16)**:本地 server(pi 預設 model)實跑 `bash sleep 5` turn,150ms 取樣全程——t≈0.4–3.4s thinking/pre-tool 階段 typing 三點持續、t≈4.4–5.4s tool 階段 spinner+三點、t≈11.4s 完成輸出「ok」。**每個 running=true 取樣都有 (typing‖spinner)=true,零空窗**(對比舊版遠端 submit→spinner ~4s 空窗)。§四-1 drop thinking delta → `showTyping` 保持 + Task5 空 live 跳過 生效;單元另覆蓋 drop 行為 |
| V2 | §四-1 WS 資安(**最高優先**) | Playwright 攔 WebSocket(`page.on('websocket')` → `framereceived`) | 跑一段會 thinking + 呼叫工具的 prompt;蒐集所有 server→client frame,JSON parse 後遞迴掃字串 | **每個 frame 皆不得含**:thinking 文字子串、已知 tool name、tool args(尤其 `message_update.assistantMessageEvent` 的 `thinking_delta` / `toolcall_*`);另跑一則「`content` 非 array 但帶 `assistantMessageEvent`」建構案例確認被擋(fail-closed) | ✅ **通過(單元 + 實機 CONFIRMED,2026-07-16)**:單元 10 例綠(thinking/toolcall delta drop、`partial`/`message`/`error` 挾帶剝除、`content` 非 array fail-closed,reviewer P1-3 案例)。實機端到端(頁面內第二個同源 WS 側錄真 model turn,prompt 含 thinking + `bash echo HELLO_MARKER`)蒐集 36 frame:delta type 僅 `text_*`(thinking/toolcall delta 全 drop)、thinking/tool block 洩漏 **0**、原始 `tool_execution_*` 事件 **0**、history 無 toolResult/bashExecution role、**`HELLO_MARKER`(bash stdout)非 user frame 洩漏 0**、tool_progress 2 個(spinner)、答案正常;HELLO_MARKER 僅出現在 user prompt(合法)|
| V3 | 需求 2、§四-4 | 同時測未登入 + 已登入兩態 | 未登入取 `/agent/login`;已登入取 `/agent/`。各檢 `document.title`、`link[rel=icon].href` 指向的實際 bytes、`#brand-logo`/header 文字、`/agent/brand/logo` 的最終 Content-Type | **兩態皆不得露內部品牌**:title 不含 `readyai-webui`;favicon 不是 π fallback(`favicon.svg` 原檔);login 頁 h1 不是 `readyai-webui`、按鈕吃 `--accent`;brand logo 若設則命中、未設不 fallback 到 π。首屏(JS 執行前)HTML 靜態 title 也需已是品牌名(消除閃字) | **通過**:本地 server(brand-name=Acme / brand-favicon=藍底A)實測——login+app 兩態 `title`/`h1`/`favicon` 全 = Acme(無 readyai-webui / 非 π);`/favicon.svg` 回 Acme svg(`content-type: image/svg+xml`);首屏靜態 HTML `<title>Acme Labeler</title>`(server 注入,無閃字);login 按鈕 `background` 吃 `var(--accent,#3b82f6)` |
| V4 | 需求 3 版型 | 走路徑 B、`chat_layout=bubble` 後 | 桌面(1280×800)與手機(390×844)兩 viewport 各截圖:含短訊息、長段落、寬 code block、表格的對話 | user bubble 靠右、assistant 靠左;`document.body.scrollWidth <= clientWidth`(**無水平爆版**);長 code/table 於自身容器 `overflow-x` 內捲動、不撐破 viewport、不與相鄰 bubble 重疊;窄屏 bubble `max-width` 生效不貼邊 | **通過**:本地實測 `data-chat-layout=bubble` 套用;user 靠右(右距 12 / 左距 1268)、assistant 靠左、640px cap 寬螢幕生效;`body`/`log` 皆 `scrollWidth<=clientWidth`(無爆版);長 code block 自身 `overflow-x` 捲動;窄容器(360px)user 79% 不貼邊、氣泡不溢出、上下不重疊 |
| V5 | 需求 3 a11y | 同 V4 | 對 user/assistant 訊息節點檢查作者資訊的可及性 | h3 若視覺隱藏,**必須**是 `.visually-hidden`(clip,`getComputedStyle` 仍可讀文字)或節點帶 `aria-label`/`data-author`;**單純 `display:none` / 移除節點 = 失敗**。screen-reader 可辨「誰說的」 | **通過**:實測 bubble 下 h3 `getComputedStyle` = `position:absolute` + `clip`(clip 隱藏、非 display:none,SR 仍可讀);且 `buildMessageElement` 給 section 加 `role=group` + `aria-label`(user="You"/assistant="Assistant"),實測 `aria-label` 在。雙重保障 |
| V6 | §六-3 version gate | pi-webui 出 `GET /agent/version`(或 connected packet `buildInfo`)後 | redeploy 後 fetch 該端點 | 回傳 commit SHA == 本次預期發佈 SHA、`dirty=false`(或 manifest dirty flag 已知並簽核);**對不上即擋驗收**。過渡期(endpoint 未上線前)沿用本輪 fingerprint:fetch `/agent/app.js`、`/agent/styles.css` 比對 `git cat-file -s <sha>:public/…`,size 對不上即警示 | **通過(endpoint 已實作)**:`GET /version` 已上線(`scripts/gen-build-info.mjs` build 時埋 `dist/build-info.json`),本地實測回 `{commit, dirty, builtAt, version}`。**readyAI 側的 redeploy 後自動核對步驟未接**(需 readyAI CI 加 fetch+斷言),列環境受限 |

**已驗技法備忘(可直接複用)**:
- V1 的 `MutationObserver` 監 `.tool-progress-block` add/remove;slow tool 用 `bash sleep N` 拉長工具時長,避免瞬時工具讓 spinner 一閃即逝被錯過。
- V6 的頁面內帶 cookie fetch + git object size 比對,本輪即用來推翻「映像過舊」假說(§六-0)。
- V2 的 frame 側錄:未上 Playwright 前,可在頁面 console 用 `WebSocket.prototype` 包裝或 DevTools 的 WS frame 面板手動抽驗,但正式驗收應自動化斷言。

---
實測注記:
- 2026-07-15(`/webui/`):送「請用工具列出目前工作目錄的檔案清單,不用解釋」觀察 spinner——未見(後證為干擾,非缺功能)。
- 2026-07-16(`/agent/`):送「請用 bash 執行 sleep 5,結束後只回覆 ok」,穩定捕到 spinner add(t≈36s)/remove(t≈41s),tool_progress 生效;另用頁面內 fetch 遠端 `/agent/app.js`、`/agent/styles.css` 做版本 fingerprint(§六-0)。兩則測試對話留在 demo session 中。
