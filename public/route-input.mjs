// Decides how a submitted composer message is routed: bash, slash, or
// prompt. Pure so it can be unit-tested without DOM/socket plumbing.
//
// Bash commands must NOT show an optimistic "You: !cmd" user bubble or
// flip the running/typing state — the assistant is not invoked, and the
// bash output renders on its own once the server replies.
//
// forcePrompt:點開場建議句時強制送成對話,不看命令模式、也不看 / ! 開頭。
export function routeInput({ message, bashMode, forcePrompt = false }) {
  const text = String(message ?? "").trim();
  if (!text) return { kind: "empty" };
  if (forcePrompt) return { kind: "prompt", message: text, optimistic: true, setRunning: true };

  const bashCommand = bashMode
    ? text
    : (text.startsWith("!") ? text.slice(1).trim() : null);
  if (bashCommand !== null) {
    if (!bashCommand) return { kind: "empty" };
    return { kind: "bash", command: bashCommand, optimistic: false, setRunning: false };
  }

  const slashMatch = text.match(/^\/([^\s]*)(?:\s+(.*))?$/);
  if (slashMatch) {
    return { kind: "slash", name: slashMatch[1] || "", arg: slashMatch[2] ?? "" };
  }

  return { kind: "prompt", message: text, optimistic: true, setRunning: true };
}
