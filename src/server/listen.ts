import type { Server } from "node:http";

export interface ListenOptions {
  host: string;
  port: number;
  maxAttempts?: number;
  logger?: {
    warn?: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

// 對 server 嘗試從 opts.port 開始綁定;若 port 被佔用 (EADDRINUSE)
// 則 +1 重試,上限 maxAttempts 次。回傳實際綁定的 port。
// 非 EADDRINUSE 錯誤立刻 throw,不重試。
export async function listenWithFallback(
  server: Server,
  opts: ListenOptions,
): Promise<number> {
  const { host, port, maxAttempts = 50, logger } = opts;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tryPort = port + attempt;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(tryPort, host);
      });
      if (attempt > 0) {
        logger?.warn?.("port fallback", { requested: port, actual: tryPort });
      }
      return tryPort;
    } catch (err: any) {
      if (err?.code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(
    `No free port in range ${port}..${port + maxAttempts - 1}; try --listen with a different port`,
  );
}
