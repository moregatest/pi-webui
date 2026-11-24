// ?session=<id> 直達:id 格式驗證與「id → session 檔名」對應(純函式;讀目錄、讀標頭留在 caller)。
// 設計見 W31-01 §4.4:伺服器把 id 對到 session 目錄裡的檔案,再走既有續接防線
// (session-guard.ts 的 shouldResumeStoredSession)。
//
// id 規則刻意比 SDK 的 assertValidSessionId 更嚴:不允許「.」,所以 id 本身不可能組出
// 「..」或副檔名,也不含任何路徑分隔字元;長度上限 128。SDK 產生的 id 是 uuidv7(十六進位＋連字號),
// 延續還原程式也照這個產生,不受影響。
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/;

export function isValidSessionIdParam(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

/**
 * 從 session 目錄的檔名清單挑出 id 對應的檔:
 *   <時間>_<id>.jsonl(SDK 命名)或 <id>.jsonl。
 * 多個符合時取字典序最後一個(SDK 時間前綴是 ISO 格式,字典序＝時間序)。
 * id 不合法、或檔名含路徑分隔字元一律不採用。找不到回 null。
 */
export function pickSessionFileName(names: readonly string[], id: unknown): string | null {
  if (!isValidSessionIdParam(id)) return null;
  const suffix = `_${id}.jsonl`;
  const exact = `${id}.jsonl`;
  const hits = names.filter((n) =>
    typeof n === "string" && !n.includes("/") && !n.includes("\\")
    && (n === exact || (n.endsWith(suffix) && n.length > suffix.length)));
  if (hits.length === 0) return null;
  return [...hits].sort().at(-1) ?? null;
}
