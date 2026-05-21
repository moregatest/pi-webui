// pi-webui Sandbox 真實 VM 整合測試。
//
// 預設不跑 (依賴 QEMU + ~150MB 下載 + ~10s 開機)。要跑就設環境變數:
//
//   SANDBOX_VM=1 npm test
//
// 流程:
// 1. 在 host 建一個臨時 workspace,塞個檔案。
// 2. 用 Sandbox 真的開 VM,mount workspace,跑 ls / cat / 寫檔。
// 3. 確認 host 看得到 VM 內寫進去的內容 (RealFSProvider 是 host-mounted)。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Sandbox } from "../dist/server/sandbox.js";

const RUN = process.env.SANDBOX_VM === "1";

test("[opt-in] Sandbox 真實 VM:bash exec、檔案讀寫雙向同步", { skip: !RUN }, async (t) => {
  // 真實 VM 啟動慢,給寬一點。Node 18+ 的 test runner 接受 `timeout`。
  t.diagnostic("booting real Gondolin VM (first run downloads ~150MB)");

  // 預檢:沒裝 QEMU 直接放棄,避免讓 user 看到模糊錯誤。
  Sandbox.ensureQemuInstalled();

  const ws = mkdtempSync(path.join(tmpdir(), "pi-webui-sandbox-vm-"));
  writeFileSync(path.join(ws, "hello.txt"), "from host");

  const sb = new Sandbox({ workspaceRoot: ws });
  try {
    await sb.ensure();

    // 1) bash exec ls
    const bashOps = sb.createBashOperations();
    let lsOutput = "";
    const ls = await bashOps.exec("ls /workspace", ws, {
      onData: (d) => {
        lsOutput += d.toString();
      },
    });
    assert.equal(ls.exitCode, 0, `ls exit ${ls.exitCode}: ${lsOutput}`);
    assert.match(lsOutput, /hello\.txt/);

    // 2) read host file via VM
    const readOps = sb.createReadOperations();
    const buf = await readOps.readFile(path.join(ws, "hello.txt"));
    assert.equal(buf.toString("utf8"), "from host");

    // 3) write via VM, host 端看得到
    const writeOps = sb.createWriteOperations();
    await writeOps.writeFile(path.join(ws, "from-vm.txt"), "from vm");
    assert.ok(existsSync(path.join(ws, "from-vm.txt")));
    assert.equal(readFileSync(path.join(ws, "from-vm.txt"), "utf8"), "from vm");

    // 4) edit ops 來回寫
    const editOps = sb.createEditOperations();
    await editOps.writeFile(path.join(ws, "hello.txt"), "edited");
    const edited = await editOps.readFile(path.join(ws, "hello.txt"));
    assert.equal(edited.toString("utf8"), "edited");
  } finally {
    await sb.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("[opt-in] Sandbox 真實 VM:bash exec 阻擋 workspace 外路徑", { skip: !RUN }, async () => {
  Sandbox.ensureQemuInstalled();
  const ws = mkdtempSync(path.join(tmpdir(), "pi-webui-sandbox-vm-"));
  const sb = new Sandbox({ workspaceRoot: ws });
  try {
    const ops = sb.createBashOperations();
    await assert.rejects(
      ops.exec("ls /etc", "/etc", { onData: () => {} }),
      /outside workspace/,
    );
  } finally {
    await sb.close();
    rmSync(ws, { recursive: true, force: true });
  }
});
