import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { listenWithFallback } from "../dist/server/listen.js";

function takePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      resolve({ server: s, port: s.address().port });
    });
  });
}

function closeP(server) {
  return new Promise((res) => server.close(() => res()));
}

test("listenWithFallback: 給定可用 port 立即綁,回傳該 port", async () => {
  const blocker = await takePort();
  await closeP(blocker.server);
  const target = createServer();
  try {
    const actual = await listenWithFallback(target, {
      host: "127.0.0.1",
      port: blocker.port,
    });
    assert.equal(actual, blocker.port);
  } finally {
    await closeP(target);
  }
});

test("listenWithFallback: 已被佔用時 +1 綁到下一個", async () => {
  const blocker = await takePort();
  const target = createServer();
  try {
    const actual = await listenWithFallback(target, {
      host: "127.0.0.1",
      port: blocker.port,
    });
    assert.equal(actual, blocker.port + 1);
  } finally {
    await closeP(target);
    await closeP(blocker.server);
  }
});

test("listenWithFallback: 達上限 throw", async () => {
  let attempt = 0;
  const fakeServer = {
    once(event, fn) { this[`_${event}`] = fn; },
    removeListener() {},
    listen() {
      attempt++;
      setImmediate(() => {
        const err = new Error("EADDRINUSE");
        err.code = "EADDRINUSE";
        this._error(err);
      });
    },
  };
  await assert.rejects(
    () =>
      listenWithFallback(fakeServer, {
        host: "127.0.0.1",
        port: 60000,
        maxAttempts: 3,
      }),
    /No free port in range 60000\.\.60002/,
  );
  assert.equal(attempt, 3);
});

test("listenWithFallback: 非 EADDRINUSE 不重試", async () => {
  let attempt = 0;
  const fakeServer = {
    once(event, fn) { this[`_${event}`] = fn; },
    removeListener() {},
    listen() {
      attempt++;
      setImmediate(() => {
        const err = new Error("EACCES");
        err.code = "EACCES";
        this._error(err);
      });
    },
  };
  await assert.rejects(
    () =>
      listenWithFallback(fakeServer, {
        host: "127.0.0.1",
        port: 50,
        maxAttempts: 5,
      }),
    /EACCES/,
  );
  assert.equal(attempt, 1);
});

test("listenWithFallback: fallback 時呼叫 logger.warn", async () => {
  const blocker = await takePort();
  const target = createServer();
  const warnings = [];
  try {
    await listenWithFallback(target, {
      host: "127.0.0.1",
      port: blocker.port,
      logger: { warn: (msg, fields) => warnings.push({ msg, fields }) },
    });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].msg, "port fallback");
    assert.equal(warnings[0].fields.requested, blocker.port);
    assert.equal(warnings[0].fields.actual, blocker.port + 1);
  } finally {
    await closeP(target);
    await closeP(blocker.server);
  }
});
