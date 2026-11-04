// W75：逐筆片段的固定寫法。check_only 給 agent 的清單與 promise-guard 檢查「有沒有照原文列」共用同一份，
// 兩邊才不會各寫各的而對不上。
export interface RecordHunkText { before: string; after: string; count?: number }

/** 「改前」→「改後」，重複的片段加「（此處改動出現 N 次）」；頭尾的「…」是片段原文的一部分。 */
export function hunkText(h: RecordHunkText): string {
  return `「${h.before}」→「${h.after}」${h.count && h.count > 1 ? `（此處改動出現 ${h.count} 次）` : ""}`;
}
