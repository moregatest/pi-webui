// readyai-webui 的 Gondolin micro-VM sandbox。
//
// 啟用 sandbox 時,所有 read/write/edit/bash 動作改走一個獨立的 Alpine VM,
// host workspace 透過 RealFSProvider mount 到 guest 的 /workspace。
//
// 設計重點:
// - VM 是 lazy boot:首次 ensure() 才會下載 / 啟動,單一 in-flight Promise dedup。
// - workspaceRoot 在 constructor 內以 realpathSync canonical 一次後就不再變,
//   避免後續 host 路徑檢查被 symlink 繞過。
// - guestPath(hostPath) 對輸入做 realpath + 邊界檢查;不存在的檔案 fall back
//   到 parent realpath + basename (write 新檔案會走這路徑)。
// - operations 只覆寫 SDK 對應 ToolOperations 介面的最小子集;由 server 端
//   用 createXxxToolDefinition + customTools 注入。
//
// 注意:gondolin 用 dynamic import,讓沒開 sandbox 的場景完全不需要載入。

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { log } from "./log.js";

export const GUEST_WORKSPACE = "/workspace";

// gondolin 0.12 的 VM 型別,只取我們會用到的方法。runtime 透過 dynamic import
// 拿到,所以這裡只用 type-only import,不會在執行期載入。
type GondolinVM = {
  readonly id: string;
  readonly fs: {
    access(p: string, opts?: object): Promise<void>;
    mkdir(p: string, opts?: object): Promise<void>;
    listDir(p: string, opts?: object): Promise<string[]>;
    stat(p: string, opts?: object): Promise<{ isDirectory(): boolean; isFile(): boolean; size: number; mtime: Date }>;
    readFile(p: string, opts?: { encoding?: BufferEncoding | null }): Promise<Buffer | string>;
    writeFile(p: string, data: string | Buffer | Uint8Array, opts?: object): Promise<void>;
  };
  exec(command: string | string[], options?: {
    cwd?: string;
    signal?: AbortSignal;
    stdout?: "buffer" | "pipe" | "ignore" | "inherit";
    stderr?: "buffer" | "pipe" | "ignore" | "inherit";
    env?: string[] | Record<string, string>;
  }): {
    output(): AsyncIterable<{ stream: "stdout" | "stderr"; data: Buffer; text: string }>;
    then<T>(
      onfulfilled?: (value: { exitCode: number; signal?: number }) => T | PromiseLike<T>,
      onrejected?: (reason: unknown) => T | PromiseLike<T>,
    ): Promise<T>;
  };
  close(): Promise<void>;
};

export interface SandboxLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface SandboxOptions {
  // host 端要 mount 進 guest /workspace 的目錄。會經 realpathSync canonical。
  workspaceRoot: string;
  // 指定 gondolin image selector(`name:tag` 或 buildId)。
  // 沒設 → 走 gondolin 預設 alpine-base:latest。
  image?: string;
  // VM 啟動時注入的預設環境變數,所有 vm.exec 都看得到。
  env?: Record<string, string>;
  logger?: SandboxLogger;
  // 給測試用的 hook;production 走 dynamic import gondolin。
  vmFactory?: (options: { image?: string; env?: Record<string, string> }) => Promise<GondolinVM>;
}

// 對應 pi SDK 的 ReadOperations
export interface ReadOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  access: (absolutePath: string) => Promise<void>;
  detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

// 對應 pi SDK 的 WriteOperations
export interface WriteOperations {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}

// 對應 pi SDK 的 EditOperations
export interface EditOperations {
  readFile: (absolutePath: string) => Promise<Buffer>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}

// 對應 pi SDK 的 BashOperations
export interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}

function toPosixRelative(rel: string): string {
  return rel.split(path.sep).join(path.posix.sep);
}

export class Sandbox {
  readonly workspaceRoot: string;
  private readonly logger: SandboxLogger;
  private readonly vmFactory: (options: { image?: string; env?: Record<string, string> }) => Promise<GondolinVM>;
  private readonly image: string | undefined;
  private readonly env: Record<string, string> | undefined;
  private vm: GondolinVM | undefined;
  private starting: Promise<GondolinVM> | undefined;
  private closed = false;

  constructor(options: SandboxOptions) {
    if (!options || !options.workspaceRoot) {
      throw new Error("Sandbox requires workspaceRoot");
    }
    const absolute = path.resolve(options.workspaceRoot);
    if (!existsSync(absolute)) {
      throw new Error(`Sandbox workspace does not exist: ${absolute}`);
    }
    // canonical 一次,後續所有邊界檢查都基於這個路徑。
    this.workspaceRoot = realpathSync(absolute);
    this.logger = options.logger ?? log;
    this.image = options.image;
    this.env = options.env;
    this.vmFactory = options.vmFactory ?? defaultVmFactory(this.workspaceRoot);
  }

  // 檢查必要的 QEMU binary 是否存在;不在則丟出帶有安裝提示的錯誤。
  // 不真正執行 VM 啟動,讓 server 啟動時可以快速 fail-fast。
  static ensureQemuInstalled(): void {
    const required = ["qemu-img", process.arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64"];
    for (const binary of required) {
      const result = spawnSync(binary, ["--version"], { stdio: "ignore" });
      if (result.error || result.status !== 0) {
        const installHint =
          process.platform === "darwin"
            ? "brew install qemu"
            : "Install qemu via your system package manager.";
        throw new Error(`${binary} not found. ${installHint}`);
      }
    }
  }

  // Lazy boot VM:首次呼叫才啟動,並發呼叫共用同一個 Promise。
  async ensure(): Promise<void> {
    if (this.closed) throw new Error("Sandbox is closed");
    if (this.vm) return;
    if (this.starting) {
      await this.starting;
      return;
    }
    this.starting = (async () => {
      const t0 = Date.now();
      this.logger.info("sandbox: booting", {
        workspace: this.workspaceRoot,
        image: this.image,
      });
      const vm = await this.vmFactory({ image: this.image, env: this.env });
      this.vm = vm;
      this.logger.info("sandbox: ready", { id: vm.id, elapsedMs: Date.now() - t0 });
      return vm;
    })();
    try {
      await this.starting;
    } catch (error) {
      this.starting = undefined;
      this.vm = undefined;
      throw error;
    }
    this.starting = undefined;
  }

  // 關閉 VM,釋放 QEMU 程序。冪等。
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const vm = this.vm;
    this.vm = undefined;
    this.starting = undefined;
    if (vm) {
      try {
        await vm.close();
        this.logger.info("sandbox: closed");
      } catch (error) {
        this.logger.warn("sandbox: close failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // host absolute path → guest absolute path (/workspace/<rel>).
  // 邊界檢查防 symlink 逃逸,並在目標檔案不存在時 fall back 到 parent realpath。
  guestPath(hostPath: string): string {
    if (!hostPath || typeof hostPath !== "string") {
      throw new Error("guestPath requires a non-empty string");
    }
    const absolute = path.resolve(hostPath);
    let real: string;
    try {
      real = realpathSync(absolute);
    } catch {
      // write 新檔案時,目標路徑還不存在,改對 parent realpath 然後接 basename。
      const parent = path.dirname(absolute);
      try {
        const realParent = realpathSync(parent);
        real = path.join(realParent, path.basename(absolute));
      } catch {
        throw new Error(`Path resolves outside workspace: ${hostPath}`);
      }
    }
    if (!this.isInsideWorkspaceCanonical(real)) {
      throw new Error(`Path outside workspace: ${hostPath}`);
    }
    const rel = path.relative(this.workspaceRoot, real);
    if (!rel) return GUEST_WORKSPACE;
    return path.posix.join(GUEST_WORKSPACE, toPosixRelative(rel));
  }

  // 給呼叫者快速判斷 host path 是否落在 workspaceRoot 內;不會丟錯。
  isInsideWorkspace(hostPath: string): boolean {
    try {
      this.guestPath(hostPath);
      return true;
    } catch {
      return false;
    }
  }

  private isInsideWorkspaceCanonical(canonicalPath: string): boolean {
    if (canonicalPath === this.workspaceRoot) return true;
    return canonicalPath.startsWith(this.workspaceRoot + path.sep);
  }

  private async getVm(): Promise<GondolinVM> {
    await this.ensure();
    if (!this.vm) throw new Error("Sandbox VM not available");
    return this.vm;
  }

  // 以下四個 ops factory 對應 pi SDK 的 ToolOperations。
  // 每個工具收到的 absolutePath 都是 host path (因為 createXxxTool 用 host cwd
  // 解析 user input),我們在 ops 內部轉成 guest path 再交給 vm.fs。

  createReadOperations(): ReadOperations {
    return {
      readFile: async (absolutePath) => {
        const vm = await this.getVm();
        const gp = this.guestPath(absolutePath);
        const data = await vm.fs.readFile(gp, { encoding: null });
        return data as Buffer;
      },
      access: async (absolutePath) => {
        const vm = await this.getVm();
        const gp = this.guestPath(absolutePath);
        await vm.fs.access(gp);
      },
      detectImageMimeType: async (absolutePath) => {
        const ext = path.posix.extname(absolutePath).toLowerCase();
        if (ext === ".png") return "image/png";
        if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
        if (ext === ".gif") return "image/gif";
        if (ext === ".webp") return "image/webp";
        return null;
      },
    };
  }

  createWriteOperations(): WriteOperations {
    return {
      writeFile: async (absolutePath, content) => {
        const vm = await this.getVm();
        const gp = this.guestPath(absolutePath);
        await vm.fs.mkdir(path.posix.dirname(gp), { recursive: true });
        await vm.fs.writeFile(gp, content);
      },
      mkdir: async (dir) => {
        const vm = await this.getVm();
        const gp = this.guestPath(dir);
        await vm.fs.mkdir(gp, { recursive: true });
      },
    };
  }

  createEditOperations(): EditOperations {
    return {
      readFile: async (absolutePath) => {
        const vm = await this.getVm();
        const gp = this.guestPath(absolutePath);
        const data = await vm.fs.readFile(gp, { encoding: null });
        return data as Buffer;
      },
      writeFile: async (absolutePath, content) => {
        const vm = await this.getVm();
        const gp = this.guestPath(absolutePath);
        await vm.fs.writeFile(gp, content);
      },
      access: async (absolutePath) => {
        const vm = await this.getVm();
        const gp = this.guestPath(absolutePath);
        await vm.fs.access(gp);
      },
    };
  }

  createBashOperations(): BashOperations {
    return {
      exec: async (command, cwd, options) => {
        const vm = await this.getVm();
        const guestCwd = this.guestPath(cwd);

        // 把 external signal + timeout 統一到一個 controller 上,
        // VM exec 收到 abort 後會 SIGKILL guest process。
        const controller = new AbortController();
        const externalListener = () => controller.abort();
        if (options.signal) {
          if (options.signal.aborted) controller.abort();
          else options.signal.addEventListener("abort", externalListener, { once: true });
        }
        let timedOut = false;
        const timer =
          options.timeout && options.timeout > 0
            ? setTimeout(() => {
                timedOut = true;
                controller.abort();
              }, options.timeout * 1000)
            : undefined;

        const env = options.env
          ? Object.entries(options.env)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => `${k}=${v ?? ""}`)
          : undefined;

        try {
          const proc = vm.exec(["/bin/bash", "-lc", command], {
            cwd: guestCwd,
            signal: controller.signal,
            stdout: "pipe",
            stderr: "pipe",
            env,
          });
          for await (const chunk of proc.output()) {
            options.onData(chunk.data);
          }
          const result = await proc;
          return { exitCode: result.exitCode };
        } catch (error) {
          if (timedOut) {
            const err = new Error(`Command timed out after ${options.timeout}s`);
            (err as Error & { code?: string }).code = "ETIMEDOUT";
            throw err;
          }
          if (options.signal?.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          }
          throw error;
        } finally {
          if (timer) clearTimeout(timer);
          if (options.signal) options.signal.removeEventListener("abort", externalListener);
        }
      },
    };
  }
}

// 預設 vmFactory:dynamic import gondolin,以 host workspaceRoot mount 到 /workspace。
// 把這段抽出成 factory 是為了讓測試可以注入 stub VM,免去 QEMU 依賴。
function defaultVmFactory(
  workspaceRoot: string,
): (options: { image?: string; env?: Record<string, string> }) => Promise<GondolinVM> {
  return async ({ image, env }) => {
    const mod = await import("@earendil-works/gondolin");
    const { VM, RealFSProvider } = mod as unknown as {
      VM: { create(options: object): Promise<GondolinVM> };
      RealFSProvider: new (root: string) => unknown;
    };
    const createOptions: Record<string, unknown> = {
      sessionLabel: `readyai-webui ${path.basename(workspaceRoot)}`,
      vfs: {
        mounts: {
          [GUEST_WORKSPACE]: new RealFSProvider(workspaceRoot),
        },
      },
    };
    if (image) {
      createOptions.sandbox = { imagePath: image };
    }
    if (env && Object.keys(env).length > 0) {
      createOptions.env = env;
    }
    const vm = await VM.create(createOptions);
    // Alpine 預設沒有 bash,且 SDK 的 bash tool 直接呼叫 /bin/bash;
    // 沒有 bash 時 ash 也能跑大多數指令,但 SDK 明確要求 /bin/bash。
    // 這裡盡力安裝,失敗也不阻擋 (跑 ash-friendly 指令還是會通)。
    // 客製 image(如 readyai-sandbox)若已預裝 bash,`command -v` 為 true,
    // `apk add` 不會跑(image 內可能根本沒 apk,設計即如此)。
    try {
      await vm.exec(
        "command -v bash > /dev/null 2>&1 || apk add --no-cache bash > /dev/null 2>&1 || true",
      );
    } catch {
      // 不阻擋啟動;呼叫端使用 bash 失敗時自然會收到錯誤訊息。
    }
    return vm;
  };
}
