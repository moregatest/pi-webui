import type { Server } from "node:http";
import type { EventEmitter } from "node:events";

export interface ListenOptions {
  host: string;
  port: number;
  maxAttempts?: number;
  logger?: {
    warn?: (msg: string, fields?: Record<string, unknown>) => void;
  };
  /**
   * 額外的 EventEmitter（例如 WebSocketServer），它也會 re-emit server 的 error。
   * 傳入後,每次嘗試 listen 時會暫時掛一個 no-op error handler,
   * 防止 EADDRINUSE 因無 listener 而 crash。
   */
  relayEmitter?: EventEmitter;
}

// 對 server 嘗試從 opts.port 開始綁定;若 port 被佔用 (EADDRINUSE)
// 則 +1 重試,上限 maxAttempts 次。回傳實際綁定的 port。
// 非 EADDRINUSE 錯誤立刻 throw,不重試。
export async function listenWithFallback(
  server: Server,
  opts: ListenOptions,
): Promise<number> {
  const { host, port, maxAttempts = 50, logger, relayEmitter } = opts;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tryPort = port + attempt;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener("listening", onListening);
          // 若 relayEmitter 存在,移除暫時的 no-op handler
          if (relayEmitter) relayEmitter.removeListener("error", onRelayError);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          if (relayEmitter) relayEmitter.removeListener("error", onRelayError);
          resolve();
        };
        // ws 套件的 WebSocketServer 會把 server 的 'error' 轉發到自己的 emit('error')。
        // 若沒有 listener,node.js 會在 relayEmitter 拋出未處理的 error 而 crash。
        // 暫時掛一個 no-op handler 讓錯誤能被 server 端的 onError 接管。
        const onRelayError = (_err: Error) => { /* 由 server 的 onError 處理 */ };
        if (relayEmitter) relayEmitter.once("error", onRelayError);
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(tryPort, host);
      });
      // port=0 時 OS 會派 ephemeral port,從 server.address() 取得實際綁定的 port
      const addr = server.address();
      const actualPort = addr && typeof addr === "object" ? addr.port : tryPort;
      if (attempt > 0) {
        logger?.warn?.("port fallback", { requested: port, actual: actualPort });
      }
      return actualPort;
    } catch (err: any) {
      if (err?.code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(
    `No free port in range ${port}..${port + maxAttempts - 1}; try --listen with a different port`,
  );
}
