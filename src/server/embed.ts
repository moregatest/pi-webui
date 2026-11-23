// 鑲嵌模式（/agent/?embed=1）的 server 端純函式：
// - 首屏判斷 embed 版面（含登入頁靠 next 參數辨識）
// - 頁面感知（客戶目前在看哪一頁）見 page-awareness.ts
// - 一輪結束時判斷本輪是否有寫入類工具成功（給父頁顯示「網站已更新」提示）
// - WebSocket 心跳，避免反向代理（預覽機 Apache 閒置 300 秒）切斷閒置連線
// 介面依 W18 契約（.auto-team/AUTO/W18-CONTRACT.md）。

import { PAGE_TOOL_NAME } from "./page-awareness.js";

/** 自身網址 embed=1，或登入頁 next 指向的網址帶 embed=1 */
export function isEmbedRequest(search: string): boolean {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search || "");
  } catch {
    return false;
  }
  if (params.get("embed") === "1") return true;
  const next = params.get("next");
  if (!next) return false;
  const q = next.indexOf("?");
  if (q < 0) return false;
  try {
    return new URLSearchParams(next.slice(q + 1)).get("embed") === "1";
  } catch {
    return false;
  }
}

// 確定不會改動網站內容的工具；其餘工具不論成功或失敗一律當作可能有寫入（判斷不出來寧可多送）。
// 失敗也算：一行 bash 串多個動作時，前面的寫入成功、最後一步失敗，整個工具仍標 isError。
// bash 也算寫入：readyai-db update/import、readyai-template write 都經由 bash。
const READ_ONLY_TOOLS = new Set(["read", "ls", "grep", "find", "glob", "publication_status", PAGE_TOOL_NAME]);

export function createTurnWriteTracker() {
  let wrote = false;
  return {
    /** 回傳非 null 表示一輪真正結束（willRetry 的 agent_end 不算） */
    observe(event: any): { contentChanged: boolean } | null {
      if (event?.type === "tool_execution_end") {
        if (!READ_ONLY_TOOLS.has(String(event.toolName ?? ""))) wrote = true;
        return null;
      }
      if (event?.type === "agent_end" && !event.willRetry) {
        const result = { contentChanged: wrote };
        wrote = false;
        return result;
      }
      return null;
    },
  };
}

/** 25 秒：遠小於預覽機 Apache 代理的 300 秒閒置逾時，也低於多數 LB 的 60 秒 */
export const HEARTBEAT_INTERVAL_MS = 25_000;

type HeartbeatSocket = {
  ping(): void;
  terminate(): void;
  on(event: string, fn: (...args: any[]) => void): unknown;
};

/**
 * WebSocket 協定層 ping；瀏覽器自動回 pong（不經 JS），代理看得到流量就不會判定閒置。
 * 上一個間隔送出的 ping 沒收到 pong → 連線已死，terminate 讓雙方走正常 close 流程。
 */
export function createWsHeartbeat(opts: {
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => any;
  clearInterval?: (h: any) => void;
} = {}) {
  const intervalMs = opts.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const setI = opts.setInterval ?? ((fn, ms) => {
    const h = setInterval(fn, ms);
    (h as any).unref?.();
    return h;
  });
  const clearI = opts.clearInterval ?? ((h) => clearInterval(h));
  const alive = new Map<HeartbeatSocket, boolean>();
  const handle = setI(() => {
    for (const [ws, ok] of [...alive]) {
      if (!ok) {
        alive.delete(ws);
        try { ws.terminate(); } catch { /* 已關閉 */ }
        continue;
      }
      alive.set(ws, false);
      try { ws.ping(); } catch { /* 下一輪仍無 pong 就會被切掉 */ }
    }
  }, intervalMs);
  return {
    track(ws: HeartbeatSocket) {
      alive.set(ws, true);
      ws.on("pong", () => { if (alive.has(ws)) alive.set(ws, true); });
      ws.on("close", () => { alive.delete(ws); });
    },
    size() {
      return alive.size;
    },
    stop() {
      clearI(handle);
      alive.clear();
    },
  };
}
