// build 時產生 dist/build-info.json,供 GET <base>/version 回吐(§六-3 / V6)。
// 埋 commit SHA + dirty 狀態,讓 redeploy 後能核對遠端映像版本(preview 機無 .git,
// 只能靠這個埋入值)。git 不可用時 commit=unknown、dirty=false。
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function git(cmd) {
  try {
    return execSync(`git ${cmd}`, { cwd: root, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

let version = "0.0.0";
try {
  version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version || version;
} catch {
  /* ignore */
}

const commit = git("rev-parse HEAD") || "unknown";
const dirty = git("status --porcelain").length > 0;
const info = {
  name: "readyai-webui",
  version,
  commit,
  dirty,
  // 注意:此為 build 當下時間;ISO 字串。GEN 在 tsc 之後跑,寫進 dist。
  builtAt: new Date().toISOString(),
};

mkdirSync(resolve(root, "dist"), { recursive: true });
writeFileSync(resolve(root, "dist", "build-info.json"), JSON.stringify(info, null, 2) + "\n");
process.stderr.write(`[build-info] commit=${commit.slice(0, 8)} dirty=${dirty} v${version}\n`);
