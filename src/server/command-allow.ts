// slash command 白名單解析。對稱 index.ts 裡的 skill-allow 流程,
// 抽成純函式以便單元測試;index.ts 引用後即可在啟動期算出最終名單。
//
// 比對對象是 collectSlashCommands() 算出的 name:
//   - builtin / webui / template / extension:純名(例如 "new"、"cwd")
//   - skill:                                "skill:<name>"
//
// 回傳語意:
//   - null 表示「未設定」 → 不過濾(全部允許)
//   - string[](即使是空陣列)表示「有設定」 → 僅這些名稱允許

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function expandHome(home: string, p: string): string {
  if (!p) return p;
  if (p === "~") return home || p;
  if (p.startsWith("~/")) return resolve(home || "", p.slice(2));
  return p;
}

// 讀檔解析白名單檔。檔不存在回 null(視同未設定);存在則逐行剝註解、trim、濾空。
// path 可為相對路徑,以 cwd 為基準解析;支援 ~ 展開。
export function readCommandAllowFile(
  path: string,
  cwd: string,
  home: string,
): string[] | null {
  if (!path) return null;
  const resolved = resolve(cwd, expandHome(home, path));
  if (!existsSync(resolved)) return null;
  const text = readFileSync(resolved, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean);
}

// 計算最終白名單。CLI 字串有值 → split (逗號或空白);
// 否則 → 嘗試讀檔。CLI 與檔案皆無 → null(未設定)。
export function computeCommandAllow(
  cliValue: string,
  filePath: string,
  cwd: string,
  home: string,
): string[] | null {
  if (cliValue && cliValue.trim()) {
    return cliValue
      .split(/[,\s]+/)
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return readCommandAllowFile(filePath, cwd, home);
}

// 決定最終要讀的白名單檔路徑。CLI > env > 自動偵測 <cwd>/.pi/commands-allow.txt。
// 自動偵測檔不存在時回空字串,代表「未指定檔案」。
export function resolveCommandAllowFile(
  cliValue: string | undefined | null,
  envValue: string | undefined | null,
  cwd: string,
): string {
  if (cliValue) return cliValue;
  if (envValue) return envValue;
  const auto = resolve(cwd, ".pi/commands-allow.txt");
  return existsSync(auto) ? auto : "";
}
