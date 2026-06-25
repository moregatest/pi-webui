// src/tools/customer-api-tools.ts
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

const MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

/** customer 可用的受控 API tools（A1 只含 upload_image；全集見子專案 B）。 */
export function buildCustomerApiTools(): ToolDefinition[] {
  return [uploadImageTool()];
}

function uploadImageTool(): ToolDefinition {
  return defineTool({
    name: "upload_image",
    label: "上傳圖片",
    description: "上傳一張圖片到客戶網站的圖庫，回傳系統檔名。只接受 jpg/png/gif/webp。",
    parameters: Type.Object({
      image_url: Type.String({ description: "圖片的 https URL" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      // 從 pathname 取副檔名，避免 query string 注入假副檔名（如 abc.php?foo=x.jpg）
      let pathname: string;
      try {
        pathname = new URL(params.image_url).pathname;
      } catch {
        pathname = "";
      }
      const ext = (pathname.split(".").pop() ?? "").toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        return { content: [{ type: "text" as const, text: "不支援的圖片格式" }], details: { error: "bad_ext" } };
      }
      const host = process.env.PC2_SERVICE_HOST;
      const token = process.env.PC2_API_TOKEN;
      if (!host || !token) {
        return { content: [{ type: "text" as const, text: "服務未設定" }], details: { error: "no_service" } };
      }
      const url = `${host.replace(/\/$/, "")}/readyscript/capps/pc2-p/service/?m=template&a=upload-image`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ image_url: params.image_url, max_bytes: MAX_BYTES }),
      });
      if (resp.status !== 200) {
        return { content: [{ type: "text" as const, text: `上傳失敗 (${resp.status})` }], details: { error: `http_${resp.status}` } };
      }
      const data = await resp.json();
      const filename = data?.name ?? data?.filename;
      return { content: [{ type: "text" as const, text: JSON.stringify({ ok: true, filename }) }], details: { filename } };
    },
  });
}
