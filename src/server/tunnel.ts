// pi-webui × cloudflared quick tunnel 整合
//
// 對外只暴露 TunnelManager class,所有 cloudflared 子 process lifecycle
// 都在這裡處理,不外洩 spawn 細節給 src/server/index.ts。
//
// 設計鐵則(2026-05-21 事故學到的):
//   1. cloudflared spawn args 必須含 --config /dev/null,不接受 override
//   2. 必須含 --no-autoupdate,避免子 process 卡在 update 流程
//   3. start(actualUrl) 收的是 main 從 listenWithFallback 拿到的 actual URL,
//      絕對不准內部去算 port

import { EventEmitter } from "node:events";
import { spawn as defaultSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export type TunnelPhase =
  | "idle"
  | "starting"
  | "active"
  | "stopping"
  | "error"
  | "stopped";

export interface TunnelState {
  phase: TunnelPhase;
  url?: string;
  error?: string;
}

export interface TunnelLogger {
  info?: (msg: string, fields?: Record<string, unknown>) => void;
  warn?: (msg: string, fields?: Record<string, unknown>) => void;
  error?: (msg: string, fields?: Record<string, unknown>) => void;
  debug?: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface TunnelManagerOptions {
  cloudflaredBin: string;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  logger?: TunnelLogger;
  // 注入點:測試用 stub。預設用 node:child_process 的 spawn。
  spawn?: typeof defaultSpawn;
}

export class TunnelManager extends EventEmitter {
  private readonly bin: string;
  private readonly startupTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly logger: TunnelLogger;
  private readonly spawn: typeof defaultSpawn;
  private state: TunnelState = { phase: "idle" };
  private child: ChildProcess | null = null;
  private urlSeen = false;
  private startupTimer: NodeJS.Timeout | null = null;
  private stopPromise: Promise<void> | null = null;

  // trycloudflare.com URL 的正則,用於從 stdout/stderr 中 parse 出 URL
  private static readonly URL_RE =
    /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

  constructor(opts: TunnelManagerOptions) {
    super();
    this.bin = opts.cloudflaredBin;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 30_000;
    this.stopTimeoutMs = opts.stopTimeoutMs ?? 5_000;
    this.logger = opts.logger ?? {};
    this.spawn = opts.spawn ?? defaultSpawn;
  }

  getState(): TunnelState {
    return { ...this.state };
  }

  start(actualUrl: string): void {
    if (this.state.phase !== "idle" && this.state.phase !== "stopped") {
      this.logger.debug?.("tunnel: start ignored (already running)", {
        phase: this.state.phase,
      });
      return;
    }
    this.urlSeen = false;
    this.setState({ phase: "starting" });

    const args = [
      "--no-autoupdate",
      "--config",
      "/dev/null",
      "tunnel",
      "--url",
      actualUrl,
    ];

    this.logger.info?.("tunnel: spawning cloudflared", { bin: this.bin, args });

    this.child = this.spawn(this.bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child.stdout?.on("data", (chunk: Buffer) =>
      this.onChildOutput(chunk.toString("utf8")),
    );
    this.child.stderr?.on("data", (chunk: Buffer) =>
      this.onChildOutput(chunk.toString("utf8")),
    );

    this.child.on("exit", (code, signal) => this.onChildExit(code, signal));

    // 啟動 timeout:在 startupTimeoutMs 內沒 parse 到 URL 就標為 error
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      if (this.state.phase === "starting") {
        this.fail(
          new Error(
            `cloudflared did not report URL within ${this.startupTimeoutMs}ms`,
          ),
        );
      }
    }, this.startupTimeoutMs);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    // stop() 在 starting 階段被呼叫時清除 startupTimer,避免 timeout 後再次 fail()
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.state.phase === "idle" || this.state.phase === "stopped") {
      this.setState({ phase: "stopped" });
      return;
    }
    const child = this.child;
    if (!child || child.killed) {
      // child 已死或從未起來,直接收尾
      this.child = null;
      this.setState({ phase: "stopped" });
      return;
    }

    this.setState({ phase: "stopping" });

    this.stopPromise = new Promise<void>((resolve) => {
      const onExit = () => {
        if (sigkillTimer) clearTimeout(sigkillTimer);
        resolve();
      };
      child.once("exit", onExit);

      try {
        child.kill("SIGTERM");
      } catch {
        /* 已死,忽略 */
      }

      const sigkillTimer = setTimeout(() => {
        this.logger.warn?.("tunnel: stop timeout, sending SIGKILL");
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已死,忽略 */
        }
      }, this.stopTimeoutMs);
    });

    await this.stopPromise;
    // onChildExit 通常已把 phase 設為 stopped,這裡做 double-check
    // 用 (this.state as TunnelState).phase 繞過 TS 控制流分析的窄化
    const currentPhase = (this.state as TunnelState).phase;
    if (currentPhase !== "stopped") {
      this.setState({ phase: "stopped" });
    }
    this.child = null;
    this.stopPromise = null;
  }

  private setState(next: TunnelState): void {
    this.state = next;
    this.emit("state", { ...next });
  }

  private onChildOutput(text: string): void {
    if (this.urlSeen) return;
    const match = TunnelManager.URL_RE.exec(text);
    if (!match) return;
    this.urlSeen = true;
    // 拿到 URL,取消 startup timer
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    const url = match[0];
    this.setState({ phase: "active", url });
    this.emit("url", url);
  }

  private onChildExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    this.logger.info?.("tunnel: child exited", { code, signal });
    if (
      this.state.phase === "stopping" ||
      this.state.phase === "stopped"
    ) {
      this.setState({ phase: "stopped" });
      this.child = null;
      return;
    }
    this.fail(
      new Error(
        `cloudflared exited unexpectedly (code=${code} signal=${signal})`,
      ),
    );
    this.child = null;
  }

  private fail(error: Error): void {
    // 冪等:已經 error / stopping / stopped 不再 fail
    if (
      this.state.phase === "error" ||
      this.state.phase === "stopping" ||
      this.state.phase === "stopped"
    ) {
      return;
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    this.setState({ phase: "error", error: error.message });
    this.emit("error", error);
    if (this.child && !this.child.killed) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        /* 子 process 可能已死,忽略 */
      }
    }
  }
}
