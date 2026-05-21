// pi-webui Sandbox 純單元測試:
// - 不啟動真的 QEMU,透過注入 stub vmFactory 驗證路徑轉換、ops 行為、生命週期。
// - 真實 VM 整合測試走 test/sandbox-vm.test.mjs (SANDBOX_VM=1 opt-in)。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Sandbox, GUEST_WORKSPACE } from "../dist/server/sandbox.js";

function makeFakeVm() {
  const state = {
    closed: false,
    files: new Map(),
    execCalls: [],
  };
  const vm = {
    id: "fake-vm",
    fs: {
      async access(p) {
        if (!state.files.has(p)) {
          const err = new Error(`ENOENT: ${p}`);
          err.code = "ENOENT";
          throw err;
        }
      },
      async mkdir() {
        /* no-op */
      },
      async listDir() {
        return [];
      },
      async stat(p) {
        if (!state.files.has(p)) {
          const err = new Error(`ENOENT: ${p}`);
          err.code = "ENOENT";
          throw err;
        }
        const data = state.files.get(p);
        return {
          isDirectory: () => false,
          isFile: () => true,
          size: data.length,
          mtime: new Date(),
        };
      },
      async readFile(p) {
        const data = state.files.get(p);
        if (!data) {
          const err = new Error(`ENOENT: ${p}`);
          err.code = "ENOENT";
          throw err;
        }
        return Buffer.from(data);
      },
      async writeFile(p, data) {
        state.files.set(p, typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
      },
    },
    exec(command, options) {
      state.execCalls.push({ command, options });
      const stdoutText = `ran:${Array.isArray(command) ? command.join(" ") : command}`;
      const stdout = Buffer.from(stdoutText);
      let exitCode = 0;
      const aborted = options?.signal?.aborted;
      const proc = {
        async *output() {
          if (aborted) return;
          yield { stream: "stdout", data: stdout, text: stdoutText };
        },
        then(onfulfilled, onrejected) {
          if (aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            return Promise.reject(err).then(onfulfilled, onrejected);
          }
          return Promise.resolve({ exitCode }).then(onfulfilled, onrejected);
        },
      };
      return proc;
    },
    async close() {
      state.closed = true;
    },
  };
  return { vm, state };
}

function mkWorkspace() {
  return mkdtempSync(path.join(tmpdir(), "pi-webui-sandbox-"));
}

test("constructor 拒絕不存在的 workspace", () => {
  assert.throws(() => new Sandbox({ workspaceRoot: "/definitely/not/here/pi-webui" }), /does not exist/);
});

test("constructor 把 workspaceRoot canonicalise (resolve symlink)", () => {
  const real = mkWorkspace();
  const link = path.join(tmpdir(), `pi-webui-sandbox-link-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  symlinkSync(real, link);
  try {
    const sb = new Sandbox({ workspaceRoot: link });
    // canonical 後應該指向真實目錄,而非 symlink 本身。
    assert.equal(sb.workspaceRoot, realpathSync(real));
    assert.notEqual(sb.workspaceRoot, link);
  } finally {
    try {
      unlinkSync(link);
    } catch {
      /* ignore */
    }
    rmSync(real, { recursive: true, force: true });
  }
});

test("guestPath 把 workspace 內絕對路徑轉成 /workspace/<rel>", () => {
  const ws = mkWorkspace();
  try {
    const sb = new Sandbox({ workspaceRoot: ws });
    writeFileSync(path.join(ws, "a.txt"), "hello");
    mkdirSync(path.join(ws, "sub"));
    writeFileSync(path.join(ws, "sub", "b.txt"), "world");
    assert.equal(sb.guestPath(path.join(ws, "a.txt")), `${GUEST_WORKSPACE}/a.txt`);
    assert.equal(sb.guestPath(path.join(ws, "sub", "b.txt")), `${GUEST_WORKSPACE}/sub/b.txt`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("guestPath 對 workspace root 本身回傳 /workspace", () => {
  const ws = mkWorkspace();
  try {
    const sb = new Sandbox({ workspaceRoot: ws });
    assert.equal(sb.guestPath(ws), GUEST_WORKSPACE);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("guestPath 對 workspace 外路徑丟錯", () => {
  const ws = mkWorkspace();
  const outsideDir = mkWorkspace();
  try {
    const sb = new Sandbox({ workspaceRoot: ws });
    assert.throws(() => sb.guestPath(path.join(outsideDir, "secret.txt")), /outside workspace/);
    assert.throws(() => sb.guestPath("/etc/passwd"), /outside workspace/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("guestPath 對不存在檔案 fall back 到 parent realpath", () => {
  const ws = mkWorkspace();
  try {
    const sb = new Sandbox({ workspaceRoot: ws });
    // 不存在但 parent 存在 → write 新檔案會走這條路
    const newFile = path.join(ws, "new.txt");
    assert.equal(sb.guestPath(newFile), `${GUEST_WORKSPACE}/new.txt`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("guestPath 阻擋 symlink 逃逸 workspace", () => {
  const ws = mkWorkspace();
  const secret = mkWorkspace();
  try {
    writeFileSync(path.join(secret, "leak.txt"), "secret");
    symlinkSync(path.join(secret, "leak.txt"), path.join(ws, "leak.txt"));
    const sb = new Sandbox({ workspaceRoot: ws });
    assert.throws(() => sb.guestPath(path.join(ws, "leak.txt")), /outside workspace/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(secret, { recursive: true, force: true });
  }
});

test("isInsideWorkspace 不丟錯,回傳 boolean", () => {
  const ws = mkWorkspace();
  try {
    const sb = new Sandbox({ workspaceRoot: ws });
    assert.equal(sb.isInsideWorkspace(path.join(ws, "x.txt")), true);
    assert.equal(sb.isInsideWorkspace("/etc/passwd"), false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("ensure 並發只會呼叫 vmFactory 一次", async () => {
  const ws = mkWorkspace();
  try {
    let calls = 0;
    const { vm } = makeFakeVm();
    const sb = new Sandbox({
      workspaceRoot: ws,
      vmFactory: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        return vm;
      },
    });
    await Promise.all([sb.ensure(), sb.ensure(), sb.ensure()]);
    assert.equal(calls, 1);
    // 第二輪也不應該再呼叫
    await sb.ensure();
    assert.equal(calls, 1);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("ensure 失敗會重置 starting 讓下一次重試", async () => {
  const ws = mkWorkspace();
  try {
    let calls = 0;
    const { vm } = makeFakeVm();
    const sb = new Sandbox({
      workspaceRoot: ws,
      vmFactory: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return vm;
      },
    });
    await assert.rejects(sb.ensure(), /boom/);
    await sb.ensure();
    assert.equal(calls, 2);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("close 是冪等的", async () => {
  const ws = mkWorkspace();
  try {
    const { vm, state } = makeFakeVm();
    const sb = new Sandbox({ workspaceRoot: ws, vmFactory: async () => vm });
    await sb.ensure();
    await sb.close();
    await sb.close();
    assert.equal(state.closed, true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("close 後 ensure 應該丟錯", async () => {
  const ws = mkWorkspace();
  try {
    const { vm } = makeFakeVm();
    const sb = new Sandbox({ workspaceRoot: ws, vmFactory: async () => vm });
    await sb.close();
    await assert.rejects(sb.ensure(), /closed/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("createReadOperations.readFile 走 guestPath + vm.fs.readFile", async () => {
  const ws = mkWorkspace();
  try {
    const { vm, state } = makeFakeVm();
    state.files.set(`${GUEST_WORKSPACE}/a.txt`, "hello");
    writeFileSync(path.join(ws, "a.txt"), "hello");
    const sb = new Sandbox({ workspaceRoot: ws, vmFactory: async () => vm });
    const ops = sb.createReadOperations();
    const buf = await ops.readFile(path.join(ws, "a.txt"));
    assert.equal(buf.toString("utf8"), "hello");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("createReadOperations.access 對缺檔案丟 ENOENT", async () => {
  const ws = mkWorkspace();
  try {
    const { vm } = makeFakeVm();
    const sb = new Sandbox({ workspaceRoot: ws, vmFactory: async () => vm });
    const ops = sb.createReadOperations();
    await assert.rejects(ops.access(path.join(ws, "missing.txt")), /ENOENT/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("createReadOperations.detectImageMimeType 依副檔名判定", async () => {
  const ws = mkWorkspace();
  try {
    const { vm } = makeFakeVm();
    const sb = new Sandbox({ workspaceRoot: ws, vmFactory: async () => vm });
    const ops = sb.createReadOperations();
    assert.equal(await ops.detectImageMimeType("/workspace/x.png"), "image/png");
    assert.equal(await ops.detectImageMimeType("/workspace/x.jpg"), "image/jpeg");
    assert.equal(await ops.detectImageMimeType("/workspace/x.webp"), "image/webp");
    assert.equal(await ops.detectImageMimeType("/workspace/x.txt"), null);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("createWriteOperations.writeFile 把 host path 轉成 guest path", async () => {
  const ws = mkWorkspace();
  try {
    const { vm, state } = makeFakeVm();
    const sb = new Sandbox({ workspaceRoot: ws, vmFactory: async () => vm });
    const ops = sb.createWriteOperations();
    await ops.writeFile(path.join(ws, "out.txt"), "payload");
    assert.equal(state.files.get(`${GUEST_WORKSPACE}/out.txt`), "payload");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("createWriteOperations 拒絕 workspace 外的寫入", async () => {
  const ws = mkWorkspace();
  try {
    const { vm } = makeFakeVm();
    const sb = new Sandbox({ workspaceRoot: ws, vmFactory: async () => vm });
    const ops = sb.createWriteOperations();
    await assert.rejects(ops.writeFile("/etc/passwd", "bad"), /outside workspace/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("createEditOperations 讀寫往返一致", async () => {
  const ws = mkWorkspace();
  try {
    const { vm, state } = makeFakeVm();
    state.files.set(`${GUEST_WORKSPACE}/note.md`, "v1");
    writeFileSync(path.join(ws, "note.md"), "v1");
    const sb = new Sandbox({ workspaceRoot: ws, vmFactory: async () => vm });
    const ops = sb.createEditOperations();
    const before = await ops.readFile(path.join(ws, "note.md"));
    assert.equal(before.toString("utf8"), "v1");
    await ops.writeFile(path.join(ws, "note.md"), "v2");
    assert.equal(state.files.get(`${GUEST_WORKSPACE}/note.md`), "v2");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("createBashOperations.exec 把 host cwd 轉成 guest cwd 並回傳 exitCode", async () => {
  const ws = mkWorkspace();
  try {
    const { vm, state } = makeFakeVm();
    const sb = new Sandbox({ workspaceRoot: ws, vmFactory: async () => vm });
    const ops = sb.createBashOperations();
    let out = "";
    const res = await ops.exec("echo hi", ws, {
      onData: (data) => {
        out += data.toString();
      },
    });
    assert.equal(res.exitCode, 0);
    assert.match(out, /ran:\/bin\/bash -lc echo hi/);
    assert.equal(state.execCalls[0].options.cwd, GUEST_WORKSPACE);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("createBashOperations.exec 拒絕 workspace 外的 cwd", async () => {
  const ws = mkWorkspace();
  try {
    const { vm } = makeFakeVm();
    const sb = new Sandbox({ workspaceRoot: ws, vmFactory: async () => vm });
    const ops = sb.createBashOperations();
    await assert.rejects(
      ops.exec("echo hi", "/etc", { onData: () => {} }),
      /outside workspace/,
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("createBashOperations.exec 把 env 轉成 KEY=VALUE 字串陣列", async () => {
  const ws = mkWorkspace();
  try {
    const { vm, state } = makeFakeVm();
    const sb = new Sandbox({ workspaceRoot: ws, vmFactory: async () => vm });
    const ops = sb.createBashOperations();
    await ops.exec("env", ws, {
      onData: () => {},
      env: { FOO: "bar", EMPTY: "" },
    });
    const envArg = state.execCalls[0].options.env;
    assert.ok(Array.isArray(envArg));
    assert.ok(envArg.includes("FOO=bar"));
    assert.ok(envArg.includes("EMPTY="));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("createBashOperations.exec 預先 abort 的 signal 立即拋 AbortError", async () => {
  const ws = mkWorkspace();
  try {
    const { vm } = makeFakeVm();
    const sb = new Sandbox({ workspaceRoot: ws, vmFactory: async () => vm });
    const ops = sb.createBashOperations();
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      ops.exec("sleep 1", ws, { onData: () => {}, signal: ac.signal }),
      (err) => err.name === "AbortError",
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
