import { test } from "node:test";
import assert from "node:assert/strict";
import { cookiePath } from "../dist/server/auth.js";

test("cookiePath: 預設 /", () => { assert.equal(cookiePath(undefined), "/"); });
test("cookiePath: base /webui", () => { assert.equal(cookiePath("/webui"), "/webui"); });
test("cookiePath: 去尾斜線", () => { assert.equal(cookiePath("/webui/"), "/webui"); });
