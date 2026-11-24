// ?session=<id> 直達:id 格式驗證與「id → session 檔名」對應(純函式;讀目錄、讀標頭留在 caller)。
// 設計見 W31-01 §4.4:伺服器把 id 對到 session 目錄裡的檔案,再走既有續接防線
// (session-guard.ts 的 shouldResumeStoredSession)。
//
// id 規則刻意比 SDK 的 assertValidSessionId 更嚴:不允許「.」,所以 id 本身不可能組出
// 「..」或副檔名,也不含任何路徑分隔字元;長度上限 128。SDK 產生的 id 是 uuidv7(十六進位＋連字號),
// 延續還原程式也照這個產生,不受影響。
import { closeSync, openSync, readSync } from "node:fs";

const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/;

export function isValidSessionIdParam(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

/**
 * 從 session 目錄的檔名清單挑出 id 對應的檔:
 *   <時間>_<id>.jsonl(SDK 命名)或 <id>.jsonl。
 * 候選順序:帶時間前綴的依字典序由新到舊(SDK 時間前綴是 ISO 格式,字典序＝時間序),<id>.jsonl 排最後。
 * 有給 accept(例如「標頭 id 等於參數」)時,回第一個通過的候選:後綴碰撞(另一段 id 以 _<id> 結尾,
 * 如 x_abc)的檔會被標頭比對略過,不會擋住真正的檔(RV32-02 低-1)。
 * id 不合法、或檔名含路徑分隔字元一律不採用。找不到回 null。
 */
export function pickSessionFileName(
  names: readonly string[],
  id: unknown,
  accept?: (name: string) => boolean,
): string | null {
  if (!isValidSessionIdParam(id)) return null;
  const suffix = `_${id}.jsonl`;
  const exact = `${id}.jsonl`;
  const ok = (n: unknown): n is string => typeof n === "string" && !n.includes("/") && !n.includes("\\");
  const stamped = names.filter((n) => ok(n) && n.endsWith(suffix) && n.length > suffix.length);
  const candidates = [...stamped].sort().reverse();
  if (names.some((n) => ok(n) && n === exact)) candidates.push(exact);
  for (const name of candidates) {
    if (!accept || accept(name)) return name;
  }
  return null;
}

/** 讀標頭時最多讀的位元組數:標頭一行很小,不必把整個(可能數十 MB 的)session 檔讀進來。 */
export const SESSION_HEADER_MAX_BYTES = 64 * 1024;

/**
 * 讀 session 檔第一行(標頭)的 id;只讀開頭 maxBytes(RV32-02 低-2)。
 * 第一行在上限內沒結束、不是 session 標頭、讀不到 → null。
 */
export function readSessionHeaderId(file: string, maxBytes = SESSION_HEADER_MAX_BYTES): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    const chunk = buf.subarray(0, n);
    const nl = chunk.indexOf(0x0a);
    // 讀滿上限仍沒換行:標頭異常大,不往後讀,當作不是這段對話
    if (nl < 0 && n >= maxBytes) return null;
    const head = chunk.subarray(0, nl < 0 ? n : nl).toString("utf8").replace(/\r$/, "");
    if (!head) return null;
    const parsed = JSON.parse(head);
    return parsed?.type === "session" && typeof parsed?.id === "string" ? parsed.id : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* 忽略 */ }
    }
  }
}
