// pi-webui sandbox 身份提示產生器。
//
// 為什麼存在:sandbox 內的 LLM 看不到「自己在 pi-webui sandbox VM」這層事實,
// 容易把 cwd=/workspace 解讀成 Fly.io / Docker 容器,套上 host-only 工作流(flyctl、
// ~/.ssh/、~/.readyai/ 等)做出錯誤判斷。
//
// 注入時機:server 啟動 sandbox 時,build 一段 markdown 透過 SDK 的
// resourceLoaderOptions.appendSystemPrompt 接到 model system prompt 末段。
//
// 這個檔故意做成純 string builder,沒有 IO / 動態依賴,讓測試容易寫、
// 多 profile 共用時也只是 string concat。

export interface SandboxPromptInput {
  // host 端被 mount 到 /workspace 的真實絕對路徑。
  // 給 LLM 看是好的:host 文件提到 <project>/data/foo.json 時 LLM 可對映到 /workspace/data/foo.json。
  workspaceRoot: string;
  // gondolin image selector(若有)。pi-webui 預設 alpine-base 時為 undefined。
  // 給 LLM 看可以協助它判斷「哪些 CLI 預期存在」(image 本身有 README / motd 時更好,
  // 但 LLM 不一定會主動讀)。
  image?: string;
  // profile toml [sandbox].system_prompt 帶入的客製段;append 到 built-in 之後。
  // 通常用來補「本 image 內有哪些 CLI」「本部署的特殊限制」等 image-specific 資訊。
  extra?: string;
}

const BUILTIN_HEADER = "## pi-webui sandbox(Gondolin micro-VM)身份提示";

export function buildSandboxSystemPrompt(input: SandboxPromptInput): string {
  const { workspaceRoot, image, extra } = input;
  const lines: string[] = [];
  lines.push(BUILTIN_HEADER);
  lines.push("");
  lines.push(
    "你現在跑在 **pi-webui sandbox** 內 — 由 Gondolin (QEMU + Alpine Linux) 啟動的本機 micro-VM。"
      + "**不是** Fly.io 機器、**不是** Docker 容器、**不是** 遠端 SSH session。",
  );
  lines.push("");
  lines.push("### Path 對映");
  lines.push("");
  lines.push(`- 你的 cwd \`/workspace\` 對應 host 端目錄 \`${workspaceRoot}\`(被 mount 進 VM)。`);
  lines.push(
    "- host 端任何 `/workspace` 以外的路徑(`/Users/*` / `/home/*` / `/root/*` 之類)在這個 VM 內**不存在、不可讀**。不要嘗試 `cd` 或 `ls` 它們。",
  );
  lines.push("- 若 doc / spec 提到 host 絕對路徑,把它對映到 `/workspace/<rel>` 再操作。");
  lines.push("");
  lines.push("### 工具與環境");
  lines.push("");
  lines.push(
    "- `read` / `write` / `edit` / `bash` 四個工具都跑在這個 VM 裡。VM 內只有 image 預裝的 binary,**沒有** `flyctl` / `docker` / host SSH agent / `~/.ssh/` / `~/.claude/` / `~/.readyai/` / `~/.config/`。",
  );
  if (image) {
    lines.push(`- 本 VM 用 image \`${image}\`。若有預裝專用 CLI,通常放在 \`/usr/local/bin\` 並透過 \`/etc/profile.d/*.sh\` 注入 PATH;\`bash\`(login shell)會自動 source。`);
  } else {
    lines.push("- 本 VM 用 gondolin 預設 alpine-base image,僅含 alpine 基本套件。沒有額外 CLI。");
  }
  lines.push(
    "- shell command 預設 `bash -lc`(login shell),會 source `/etc/profile.d/*.sh`,所以 PATH 含 `/usr/local/bin` 等 image 注入的目錄。",
  );
  lines.push("");
  lines.push("### Host-only 工作流要繞道");
  lines.push("");
  lines.push(
    "若 `/workspace/AGENTS.md` / `/workspace/CLAUDE.md` 提到 host-only 工作流(`flyctl ssh`、`readyai-project preview`、`~/.readyai/ticket-hub.toml`、`flyctl machine restart`、git push 到客戶 GitHub 等),**那些步驟你不能執行**。應該:",
  );
  lines.push("");
  lines.push("1. 把要做的事整理成清單");
  lines.push("2. 用 chat 回給 operator,請對方在 host 端執行");
  lines.push("3. operator 完成後再繼續你能做的部分");
  lines.push("");
  lines.push("**不要**因為 doc 寫了就硬跑會 `command not found` 的指令。");

  if (extra && extra.trim().length > 0) {
    lines.push("");
    lines.push("### 本部署額外提示");
    lines.push("");
    lines.push(extra.trim());
  }

  return lines.join("\n");
}
