# Pi 0.83 / DeepSeek V4 Pro skill 相容性回歸

日期：2026-08-05  
驗證者：Codex（依 `pi-skill-compat-test` 流程）  
Pi：`@earendil-works/pi-coding-agent@0.83.0`（專案 local binary）  
模型：`openrouter/deepseek/deepseek-v4-pro`  
測試目錄：`/tmp/nine9-pi083-compat.KGswqN`  
對照基準：`2026-05-25-pi-skill-compat-validation.md`

## 範圍

本次是 SDK/runtime 升級回歸，不重做客戶已簽核骨架。`nine9.jic-tools.com.tw`
現況已是 `skeleton.status=completed` 且存在 signed ground truth；依最新版
`onboard-skeleton` 的簽核保護規則，不得為了測試解鎖重構或覆寫主檔。

因此本輪驗證：

1. Pi 0.83 是否能從 OpenRouter catalog 精確解析並實際呼叫 DeepSeek V4 Pro。
2. project-local skill 是否只有在本次明確 `--approve` 後載入。
3. 真實 `/onboard-skeleton` 是否讀到完整 Step 0 狀態與 checkpoint，並在
   `--force` 前停止。
4. 隔離回歸是否沒有修改客戶來源或 copy-on-write baseline。

規則 A～P 的完整重跑與 Chrome MCP Step 2-6 本輪未執行；其完整模型品質仍以
2026-05-25 基準為準，不能把這份 SDK-focused regression 解讀為全流程重新認證。

## 隔離與前置檢查

| 檢查 | 結果 |
|---|---|
| 獨立 `/tmp` 目錄 | ✅ `/tmp/nine9-pi083-compat.KGswqN` |
| `customer_data` | ✅ symlink 到真實客戶資料；未寫入 |
| project skills | ✅ `.agents/skills` symlink 到該客戶案 `.claude/skills` |
| 可寫狀態／骨架 | ✅ APFS copy-on-write 副本，不指向客戶主檔 |
| global broken extension | ✅ `pi --help` exit 0，未見 `failed to load` |
| project trust | ✅ 使用 Pi 0.83 `--approve`，未核准模式另有自動測試證明不執行 extension |

## 對照結果

| 面向 | 2026-05-25 baseline | Pi 0.83 + DeepSeek V4 Pro |
|---|---|---|
| OpenRouter catalog | ✅ 有 `deepseek-v4-pro` | ✅ `deepseek/deepseek-v4-pro`，1.0M context / 384K max output / thinking |
| WebUI selector | `openrouter/deepseek/deepseek-v4-pro` | ✅ 真實 server integration test 綁定同一 selector |
| 實際模型請求 | ✅ | ✅ SDK/WebUI runtime 回覆 `PI_WEBUI_OPENROUTER_OK` |
| project-local skill trust | 舊版無此 gate | ✅ unknown repo 預設不載入；本輪 `--approve` 才載入 |
| Step 0 讀取 completed 狀態 | ✅ | ✅ 辨識已完成 4 輪與最後一輪日期 |
| `--force` checkpoint | ✅ 停下詢問 | ✅ `--print` 仍停在「請回覆 --force」，未自行重跑 |
| 下一步提示 | `/onboard-preview` | ✅ `/onboard-preview`，並列出 demo 站＋PC2 token 前置 |
| baseline 寫入 | 無污染 | ✅ `.onboard-status.yaml`、`skeleton.yaml` 與來源逐檔 `cmp` 相同 |
| 規則 A～P / 四區塊 | ✅（完整基準） | ⚠️ 本輪未重跑；已簽核保護禁止為測試覆寫 |
| Chrome MCP unavailable 行為 | ❌ 曾降級 curl | ⚠️ 本輪未進 Step 2-6，舊缺口不得視為已解除 |

## 新發現：fresh CLI agent dir 的 env-key 差異

Pi 0.83 的 CLI 在全新 `HOME` 或 `PI_CODING_AGENT_DIR` 下，以
`OPENROUTER_API_KEY` 執行 `pi --print` 時回報 `No API key found for openrouter`；
同一版本的 SDK `ModelRuntime` 能辨識該 env credential，且本專案實際 runtime
已成功完成 DeepSeek V4 Pro 請求。使用既有 Pi credential store 時，CLI 的
`/onboard-skeleton` 也成功。

這個差異目前界定為 Pi 0.83 CLI fresh-profile 路徑的上游缺口，不阻擋
`readyai-webui` 的 OpenRouter 使用；但不能宣稱 CLI 純 env-key 路徑全綠。
CLI 使用者在上游修正前可先透過 `/login openrouter` 建立 credential store。

## 結論

在本次實測範圍內，Pi 0.83 沒有造成 skill 載入、Step 0 規則理解、`--force`
checkpoint、WebUI model selector 或 OpenRouter 實際請求的退化。後勤可以沿用
readyai-webui 執行已驗證流程，但以下邊界不變：

- Chrome MCP 缺口未重新驗證，也未解除。
- 互動式流程仍應用互動 session，不以 `--print` 取代 checkpoint 測試。
- 規則 A～P 的完整模型品質沿用 2026-05-25 基準；本輪只是 SDK/runtime 升級回歸。
- 任何客戶已簽核骨架都不能為了 regression 解鎖重構。
