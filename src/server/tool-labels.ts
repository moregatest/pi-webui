// tool 名稱對應到客戶導向繁中標籤。
// 用於 --hide-tool-calls + --show-tool-progress 時,把內部 tool 名稱替換成
// user-friendly 進度文字。未知 tool 回 fallback「正在處理...」。
//
// MVP 階段硬編,不開使用者自訂表(YAGNI)。

const TOOL_LABELS: Record<string, string> = {
  read: "正在讀取檔案...",
  write: "正在寫入檔案...",
  edit: "正在修改檔案...",
  bash: "正在執行指令...",
  WebSearch: "正在搜尋網路...",
  WebFetch: "正在抓取網頁...",
  Task: "正在思考...",
  Skill: "正在準備工具...",
};

export const TOOL_LABEL_FALLBACK = "正在處理...";

export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? TOOL_LABEL_FALLBACK;
}
