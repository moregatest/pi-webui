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
// 正反例：test/fixtures/jargon-cases.json（與 site-workflow scripts/tests/fixtures/ 共用），改規則時兩處一起改。
//
// W54 F21：findJargon 另外偵測 HTML 標籤（<div>、</p>、<img …>）、資料夾路徑（uploads/customer/、
// Templates/pic/、/var/www/…）與中文句中的英文工程詞（sanity check、regex、DOM…），守門用它。

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

const URL_RE = /(?:https?:\/\/|(?<![A-Za-z0-9])www\.)[^\s「」『』（）()<>"'，。；、]+/g;
const EMAIL_RE = /[A-Za-z0-9_.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

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
  return identifiersIn(stripFencedBlocks(text).replace(URL_RE, " ").replace(EMAIL_RE, " "));
}

function identifiersIn(scan: string): string[] {
  const found: string[] = [];
  for (const raw of scan.match(/[A-Za-z0-9_.-]+/g) ?? []) {
    const token = raw.replace(/^[.-]+|[.-]+$/g, "");
    if (token && isIdentifier(token) && !found.includes(token)) found.push(token);
  }
  return found;
}

// ── W54 F21 ──

// 只認已知 HTML 標籤名：英文信件的「Dear <Name>」佔位寫法不算
const HTML_TAGS = new Set((
  "a abbr article aside audio b blockquote body br button caption code col dd div dl dt em embed fieldset "
  + "figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hr html i iframe img input label legend li link "
  + "main meta nav ol optgroup option p picture pre script section select small source span strong style sub sup "
  + "svg table tbody td textarea tfoot th thead title tr u ul video").split(" "));
const TAG_RE = /<(\/?)([A-Za-z][A-Za-z0-9]*)(?:\s[^<>]*)?\/?>/g;

// 資料夾路徑：以這些內部根目錄開頭的一律算（不分大小寫）
const INTERNAL_ROOTS = new Set(["templates", "uploads", "var", "www", "tmp", "home", "data", "cache", "pc2-template",
  "readyscript", "capps", "node_modules", "src", ".claude", ".pi", "public_html", "html"]);
const PATH_RE = /\/?(?:[A-Za-z0-9_.~-]+\/)+[A-Za-z0-9_.~-]*/g;
// 網站語系目錄（/en/product/、/zh-TW/…）：客戶看得到的頁面網址，不算資料夾路徑
const LANG_SEG = new Set(("en zh-TW zh-CN zh-HK ja ko es pt fr it de ru ar hi id th vi ms nl no sv tl tr pl cs da fi "
  + "el he hu ro sk uk bg hr sr sl lt lv et fa bn ur sw").split(" "));
const PAGE_TAIL = /\.(?:html?|php)$/i;
const FILE_TAIL = /\.[A-Za-z0-9]{1,5}$/;

function isFolderPath(path: string): boolean {
  const lead = path.startsWith("/");
  const trail = path.endsWith("/");
  const segs = path.split("/").filter(Boolean);
  if (!segs.length) return false;
  if (INTERNAL_ROOTS.has(segs[0].toLowerCase())) return true;
  if (LANG_SEG.has(segs[0]) || PAGE_TAIL.test(segs[segs.length - 1])) return false; // 網站頁面路徑
  if (!segs.every(x => /[A-Za-z]/.test(x))) return false; // 日期、24/7
  if (lead && segs.length >= 2) return true;
  if (trail && segs.length >= 2) return true;
  // and/or、Black/White/Red、S/M/L、TCP/IP 不算：三段以上且結尾是檔名才算
  return segs.length >= 3 && FILE_TAIL.test(segs[segs.length - 1]) && segs.filter(x => x.length >= 2).length >= 2;
}

/** 中文句中偵測的英文工程詞（與 fixture engineering_terms 一致；全大寫的縮寫區分大小寫）。 */
export const ENGINEERING_TERMS: readonly string[] = [
  "sanity check", "regex", "payload", "commit", "deploy", "DOM", "session", "debug", "cache", "token", "endpoint",
  "API", "CLI", "JSON", "SQL", "script", "parser", "schema", "query", "render", "timestamp", "hash", "diff", "grep",
  "merge", "repo", "overlay", "fallback", "timeout", "stack trace", "backend", "frontend", "selector",
];
const TERM_RES = ENGINEERING_TERMS.map(t => [t, new RegExp(
  `(?<![A-Za-z0-9_])${t.replace(/ /g, "\\s+")}(?![A-Za-z0-9_])`, t === t.toUpperCase() ? "g" : "gi")] as const);

/** 中文為主的句子：中文字至少 4 個，且不少於英文字母數的一半（英文客戶對話不算）。 */
function chineseSentences(text: string): string[] {
  return text.split(/[。！？!?；;\n]/).filter((s) => {
    const cjk = (s.match(/[\u4e00-\u9fff]/g) ?? []).length;
    const latin = (s.match(/[A-Za-z]/g) ?? []).length;
    return cjk >= 4 && cjk * 2 >= latin;
  });
}

/**
 * 客戶回覆中的內部用語（``` 程式碼區塊以外；行內程式碼照算）。
 * 順序：HTML 標籤、資料夾路徑、程式識別字、英文工程詞；各自依出現順序、不重複。
 */
export function findJargon(text: string | undefined | null): string[] {
  if (typeof text !== "string" || !text) return [];
  let scan = stripFencedBlocks(text);
  const tags: string[] = [];
  scan = scan.replace(TAG_RE, (m, slash: string, name: string) => {
    if (!HTML_TAGS.has(name.toLowerCase())) return m;
    const tag = `<${slash}${name.toLowerCase()}>`;
    if (!tags.includes(tag)) tags.push(tag);
    return " ";
  });
  scan = scan.replace(URL_RE, " ").replace(EMAIL_RE, " ");
  const paths: string[] = [];
  scan = scan.replace(PATH_RE, (m) => {
    const p = m.replace(/[.-]+$/, "");
    if (!isFolderPath(p)) return m;
    if (!paths.includes(p)) paths.push(p);
    return " ";
  });
  const idents = identifiersIn(scan);
  const terms: string[] = [];
  const hits: Array<[number, string]> = [];
  for (const sentence of chineseSentences(scan)) {
    const base = scan.indexOf(sentence);
    for (const [term, re] of TERM_RES) {
      re.lastIndex = 0;
      const m = re.exec(sentence);
      if (m) hits.push([base + m.index, term]);
    }
  }
  for (const [, term] of hits.sort((a, b) => a[0] - b[0])) if (!terms.includes(term)) terms.push(term);
  return [...tags, ...paths, ...idents, ...terms];
}
