// W45 F17：客戶回覆裡的程式識別字（資料庫欄位、程式變數、欄位路徑）。
//
// 規則與 site-workflow e2e-soak.py 的 SNAKE_IDENT_RE（9dbbc7c）一致：
//   文字切成 [A-Za-z0-9_.-]+ 的片段，整段是小寫 snake_case（desc_html、check_only）就算。
// 此處另外補兩點（site-workflow 待同步，見 W45 報告）：
//   - 片段尾端的英文句點不算（"the desc_html." 也要命中）
//   - 點號連接的小寫欄位路徑（product.desc_html、publication.status）也算
// 不算：帶副檔名的檔名、網址、email、``` 程式碼區塊內、大寫片語（OEM_ODM）、單字表名
// （product 等；controller 決定由技能端處理，英文客戶對話會誤判）。
// 行內程式碼 `desc_html` 仍算：W36R5 I3 的實際案例就是行內程式碼。
// 正反例：test/fixtures/jargon-cases.json，改規則時兩處一起改。

const SNAKE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const DOTTED = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

// 點號片段最後一段是這些時視為檔名或網域，不算識別字
const FILE_OR_DOMAIN_TAIL = new Set([
  // 檔案
  "html", "htm", "php", "js", "mjs", "cjs", "ts", "css", "scss", "json", "xml", "yaml", "yml", "md", "txt",
  "pdf", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "bmp", "ico", "tif", "tiff", "heic",
  "csv", "xls", "xlsx", "doc", "docx", "ppt", "pptx", "odt", "rtf", "ai", "psd", "eps", "indd",
  "zip", "gz", "tgz", "tar", "rar", "7z", "mp3", "mp4", "mov", "wav", "webm", "avi", "m4a",
  "sql", "sqlite", "sqlite3", "py", "sh", "log", "ini", "toml", "env", "conf", "tpl", "woff", "woff2", "ttf", "otf",
  // 網域
  "com", "net", "org", "io", "tw", "cn", "jp", "hk", "kr", "sg", "my", "uk", "us", "eu", "de", "fr", "it", "es",
  "co", "edu", "gov", "info", "biz", "me", "app", "dev", "cc", "tv", "asia", "shop", "store", "site", "online",
]);

function stripFencedBlocks(text: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) { fenced = !fenced; continue; }
    if (!fenced) out.push(line);
  }
  return out.join("\n");
}

function isIdentifier(token: string): boolean {
  if (SNAKE.test(token)) return true;
  if (!DOTTED.test(token)) return false;
  const segs = token.split(".");
  if (FILE_OR_DOMAIN_TAIL.has(segs[segs.length - 1])) return false;
  // e.g、a.m 這類縮寫：每段至少兩個字元，或含底線
  return token.includes("_") || segs.every(s => s.length >= 2);
}

/** 程式碼區塊以外的程式識別字（依出現順序、不重複）。 */
export function findInternalIdentifiers(text: string | undefined | null): string[] {
  if (typeof text !== "string" || !text) return [];
  const scan = stripFencedBlocks(text)
    .replace(/(?:https?:\/\/|(?<![A-Za-z0-9])www\.)[^\s「」『』（）()<>"'，。；、]+/g, " ")
    .replace(/[A-Za-z0-9_.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, " ");
  const found: string[] = [];
  for (const raw of scan.match(/[A-Za-z0-9_.-]+/g) ?? []) {
    const token = raw.replace(/^[.-]+|[.-]+$/g, "");
    if (token && isIdentifier(token) && !found.includes(token)) found.push(token);
  }
  return found;
}
