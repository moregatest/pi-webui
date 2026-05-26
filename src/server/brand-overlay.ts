import fs from "node:fs";

const MAX_SIZE = 100 * 1024;

/**
 * 載入品牌 CSS overlay 檔案,並驗證存在性與大小上限(100KB)。
 * 若 filePath 為 symlink,statSync 會 follow 到實際檔案。
 * @param filePath CSS 檔案絕對路徑,傳 null 代表未設定品牌覆蓋
 * @returns 檔案內容 Buffer,或 null(未設定時)
 */
export function loadBrandCss(filePath: string | null): Buffer | null {
  if (!filePath) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`brand.css: file not found: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`brand.css: not a regular file: ${filePath}`);
  }
  if (stat.size > MAX_SIZE) {
    throw new Error(`brand.css: file size ${stat.size} > 100KB limit (${filePath})`);
  }
  return fs.readFileSync(filePath);
}
