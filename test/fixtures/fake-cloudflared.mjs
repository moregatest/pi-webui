#!/usr/bin/env node
// fake cloudflared:模擬 quick tunnel 的 startup 輸出。
//
// 行為:
//   - 立刻把 fake URL 印到 stderr
//   - SIGTERM 後 0.05s 退出 code=0
//
// 用法(由 server-tunnel.test.mjs spawn):
//   node test/fixtures/fake-cloudflared.mjs --no-autoupdate --config /dev/null tunnel --url <url>
//
// 注意:測試只關心輸出與 lifecycle,不關心 args 內容(那個已被 tunnel.test.mjs 覆蓋)。

const FAKE_URL = process.env.FAKE_TUNNEL_URL || "https://fake-test-id.trycloudflare.com";

process.stderr.write(`INF | Your quick Tunnel has been created!  |\n`);
process.stderr.write(`INF | ${FAKE_URL} |\n`);

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 50);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

// 保持 alive
setInterval(() => {}, 60_000);
