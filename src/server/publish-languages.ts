// src/server/publish-languages.ts
// B 路發布語系選擇：主語系中，預覽站 DB 與 baseline（origin_source_version.sources）不同者才發布。
// 契約：source-version v2（owner 2026-10-29）。預覽站 DB 一律以 sha256(檔案 bytes) 比對，
// 與原站 m=source&a=version 的 content_sha256 演算法相同。

import { createHash } from "node:crypto";

export interface SourceBaseline {
  /** 主語系 → baseline content_sha256（純 hex，小寫）；null＝原站該語系 DB 不存在（error:missing）。 */
  sources: Record<string, string | null>;
  /** 主語系書寫順序；用來決定輸出順序。 */
  order: string[];
}

const HEX = /^[a-f0-9]{64}$/;
const LNG = /^[a-zA-Z0-9-]+$/;

/** 把 `sha256:<hex>` 或純 hex 正規化成小寫 hex；格式不符回 undefined。 */
export function normalizeSha256(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hex = value.trim().toLowerCase().replace(/^sha256:/, "");
  return HEX.test(hex) ? hex : undefined;
}

/**
 * 解析 preview-meta.json 的 origin_source_version（v2 欄位）。
 * 讀不到 sources 或沒有任何合法語系時回 undefined，呼叫端退回 v1 行為（[source_lng]）。
 */
export function parseSourceBaseline(ov: unknown): SourceBaseline | undefined {
  if (!ov || typeof ov !== "object") return undefined;
  const o = ov as Record<string, unknown>;
  const raw = o.sources;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const sources: Record<string, string | null> = {};
  for (const [lng, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!LNG.test(lng) || !entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const hex = normalizeSha256(e.content_sha256);
    if (hex) sources[lng] = hex;
    else if (e.error === "missing") sources[lng] = null;
  }
  const keys = Object.keys(sources);
  if (keys.length === 0) return undefined;

  // sources_order 優先；不在 order 裡的語系依 key 順序補在後面
  const order: string[] = [];
  if (Array.isArray(o.sources_order)) {
    for (const lng of o.sources_order) {
      if (typeof lng === "string" && lng in sources && !order.includes(lng)) order.push(lng);
    }
  }
  for (const lng of keys) if (!order.includes(lng)) order.push(lng);
  return { sources, order };
}

/** 預覽站 DB 指紋讀取：回 hex；DB 不存在回 null；無法判斷要 throw。 */
export type PreviewDbHasher = (lng: string) => Promise<string | null>;

/**
 * 選出要發布的主語系（保持書寫順序）。
 * - baseline 有 hash：預覽站 hash 不同才發布；預覽站沒有該 DB 則略過（發布無法刪除原站 DB）
 * - baseline 為 missing：預覽站有 DB 就發布（原站新增該語系）
 */
export async function selectChangedLanguages(baseline: SourceBaseline, previewHash: PreviewDbHasher): Promise<string[]> {
  const out: string[] = [];
  for (const lng of baseline.order) {
    const current = await previewHash(lng);
    if (current === null) continue;
    if (current !== baseline.sources[lng]) out.push(lng);
  }
  return out;
}

/**
 * 以 pc2-p API 下載預覽站 db_<lng>.sqlite3 並算 sha256。
 * 與 readyAI publication 取候選 DB 的端點相同（m=db&a=download-db），確保比對的就是要發布的 bytes。
 */
export function createPreviewDbHasher(
  host: string,
  token: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): PreviewDbHasher {
  const base = host.replace(/\/+$/, "");
  return async (lng) => {
    const url = `${base}/readyscript/capps/pc2-p/service/?m=db&a=download-db&lng=${encodeURIComponent(lng)}`;
    const resp = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, redirect: "error" });
    if (resp.status === 404) return null;
    if (resp.status !== 200) throw new Error(`preview db http ${resp.status}`);
    const bytes = Buffer.from(await resp.arrayBuffer());
    if (!bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0", "latin1"))) throw new Error("preview db invalid");
    return createHash("sha256").update(bytes).digest("hex");
  };
}
