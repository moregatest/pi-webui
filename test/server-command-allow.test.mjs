import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeCommandAllow,
  readCommandAllowFile,
  resolveCommandAllowFile,
} from "../dist/server/command-allow.js";

function makeCwd() {
  return mkdtempSync(join(tmpdir(), "pi-webui-cmd-allow-"));
}

test("readCommandAllowFile: empty path returns null", () => {
  assert.equal(readCommandAllowFile("", "/tmp", "/home/u"), null);
});

test("readCommandAllowFile: missing file returns null (no error)", () => {
  const cwd = makeCwd();
  try {
    assert.equal(readCommandAllowFile("does-not-exist.txt", cwd, ""), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("readCommandAllowFile: parses one-per-line, strips comments and blank lines", () => {
  const cwd = makeCwd();
  try {
    const path = join(cwd, "allow.txt");
    writeFileSync(
      path,
      [
        "# header comment",
        "new",
        "",
        "  quit   # trailing comment",
        "skill:brainstorming",
        "# full-line comment",
        "",
        "help#no space",
      ].join("\n"),
    );
    assert.deepEqual(
      readCommandAllowFile("allow.txt", cwd, ""),
      ["new", "quit", "skill:brainstorming", "help"],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("readCommandAllowFile: empty file returns empty array (allow nothing)", () => {
  const cwd = makeCwd();
  try {
    const path = join(cwd, "empty.txt");
    writeFileSync(path, "");
    assert.deepEqual(readCommandAllowFile("empty.txt", cwd, ""), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("readCommandAllowFile: all-comments file returns empty array", () => {
  const cwd = makeCwd();
  try {
    const path = join(cwd, "comments.txt");
    writeFileSync(path, "# only\n# comments\n\n");
    assert.deepEqual(readCommandAllowFile("comments.txt", cwd, ""), []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("computeCommandAllow: CLI value takes priority over file", () => {
  const cwd = makeCwd();
  try {
    const path = join(cwd, "f.txt");
    writeFileSync(path, "fromfile\n");
    assert.deepEqual(
      computeCommandAllow("a,b, c", "f.txt", cwd, ""),
      ["a", "b", "c"],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("computeCommandAllow: CLI value supports whitespace separator", () => {
  assert.deepEqual(
    computeCommandAllow("new quit  help", "", "/tmp", ""),
    ["new", "quit", "help"],
  );
});

test("computeCommandAllow: empty CLI falls back to file", () => {
  const cwd = makeCwd();
  try {
    const path = join(cwd, "f.txt");
    writeFileSync(path, "x\ny\n");
    assert.deepEqual(
      computeCommandAllow("", "f.txt", cwd, ""),
      ["x", "y"],
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("computeCommandAllow: nothing set returns null (= no whitelist)", () => {
  assert.equal(computeCommandAllow("", "", "/tmp", ""), null);
});

test("computeCommandAllow: whitespace-only CLI counts as empty", () => {
  assert.equal(computeCommandAllow("   ", "", "/tmp", ""), null);
});

test("resolveCommandAllowFile: CLI value wins", () => {
  const cwd = makeCwd();
  try {
    // even if the auto-detect file exists, CLI takes priority
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "commands-allow.txt"), "auto\n");
    assert.equal(
      resolveCommandAllowFile("/explicit/path.txt", "/from/env.txt", cwd),
      "/explicit/path.txt",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resolveCommandAllowFile: env value used when CLI absent", () => {
  assert.equal(
    resolveCommandAllowFile("", "/from/env.txt", "/tmp"),
    "/from/env.txt",
  );
  assert.equal(
    resolveCommandAllowFile(null, "/from/env.txt", "/tmp"),
    "/from/env.txt",
  );
});

test("resolveCommandAllowFile: auto-detects <cwd>/.pi/commands-allow.txt", () => {
  const cwd = makeCwd();
  try {
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "commands-allow.txt"), "x\n");
    assert.equal(
      resolveCommandAllowFile("", "", cwd),
      join(cwd, ".pi", "commands-allow.txt"),
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resolveCommandAllowFile: returns empty string when nothing exists", () => {
  const cwd = makeCwd();
  try {
    assert.equal(resolveCommandAllowFile("", "", cwd), "");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
