// 讀網址的 ?session=<id>(延續直達用)。格式與伺服器 src/server/session-param.ts 相同;
// 不合法就當沒帶,伺服器仍會再驗一次。
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,126}[A-Za-z0-9])?$/;

export function readSessionParam(search) {
  let id = null;
  try {
    id = new URLSearchParams(search || "").get("session");
  } catch {
    return null;
  }
  return typeof id === "string" && SESSION_ID_RE.test(id) ? id : null;
}
