// e2e stub：冒充 preview 機 NODE_OPTIONS preload 的 @sentry/node（見 preview_fly/sentry-init.cjs
// 設 globalThis.__glitchtip_sentry）。把 captureException 的每次呼叫寫進探針檔，讓 e2e 能斷言
// 「turn-error 真的上報了」——不只 stopReason:error（條件層），還有上報動作層。
//
// 用法：spawn server 時 env 帶
//   NODE_OPTIONS="--import <此檔絕對路徑>"
//   SENTRY_PROBE_FILE=<探針檔路徑>
// server 進程內 reportFailedTurn() 的 globalThis.__glitchtip_sentry.captureException 一被呼叫，
// 就 append 一行 JSON 到探針檔；測試進程讀該檔即知上報是否發生、tags/訊息是否正確遮蔽。

import { appendFileSync } from "node:fs";

const probe = process.env.SENTRY_PROBE_FILE;
globalThis.__glitchtip_sentry = {
  captureException(err, ctx) {
    if (!probe) return;
    try {
      appendFileSync(probe, JSON.stringify({
        message: err?.message ?? String(err),
        tags: ctx?.tags ?? null,
        extra: ctx?.extra ?? null,
      }) + "\n");
    } catch {}
  },
};
