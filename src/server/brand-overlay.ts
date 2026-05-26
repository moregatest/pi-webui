import fs from "node:fs";

const MAX_SIZE = 100 * 1024;

/**
 * 載入品牌 CSS 檔案，並進行存在性與大小限制檢查。
 * @param filePath CSS 檔案絕對路徑，傳 null 代表未設定品牌覆蓋
 * @returns 檔案內容 Buffer，或 null（未設定時）
 */
export function loadBrandCss(filePath: string | null): Buffer | null {
  if (!filePath) return null;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`brand.css: file not found: ${filePath}`);
  }
  const size = fs.statSync(filePath).size;
  if (size > MAX_SIZE) {
    throw new Error(`brand.css: file size ${size} > 100KB limit (${filePath})`);
  }
  return fs.readFileSync(filePath);
}
