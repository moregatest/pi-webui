// test/pgc-config.test.mjs
import { describe, it } from "node:test";
import assert from "node:assert";
import { parsePgcConfig } from "../dist/server/pgc-config.js";

describe("parsePgcConfig", () => {
  it("returns null when PGC_PUBLISH_ENABLED is unset", () => {
    assert.strictEqual(parsePgcConfig({}), null);
  });

  it("returns null when PGC_PUBLISH_ENABLED is not '1'", () => {
    assert.strictEqual(parsePgcConfig({ PGC_PUBLISH_ENABLED: "0" }), null);
  });

  it("throws on orphan PGC credential when disabled", () => {
    assert.throws(
      () => parsePgcConfig({ TICKET_HUB_SITE_TOKEN: "x".repeat(32) }),
      /PGC_PUBLISH_ENABLED/,
    );
  });

  it("parses complete enabled config", () => {
    const cfg = parsePgcConfig({
      PGC_PUBLISH_ENABLED: "1",
      TICKET_HUB_BASE_URL: "https://ticket.example.com",
      TICKET_HUB_PROJECT_ID: "my-project",
      TICKET_HUB_SITE_TOKEN: "s".repeat(32),
      PGC_SNAPSHOT_EXPORT_TOKEN: "e".repeat(32),
    });
    assert.ok(cfg);
    assert.strictEqual(cfg.hubBaseUrl, "https://ticket.example.com");
    assert.strictEqual(cfg.projectId, "my-project");
    assert.strictEqual(cfg.siteToken, "s".repeat(32));
    assert.strictEqual(cfg.snapshotExportToken, "e".repeat(32));
  });

  it("fails on partial config", () => {
    assert.throws(
      () => parsePgcConfig({
        PGC_PUBLISH_ENABLED: "1",
        TICKET_HUB_BASE_URL: "https://x.com",
      }),
      /missing: TICKET_HUB_PROJECT_ID, TICKET_HUB_SITE_TOKEN, PGC_SNAPSHOT_EXPORT_TOKEN/,
    );
  });

  it("fails on invalid URL", () => {
    assert.throws(
      () => parsePgcConfig({
        PGC_PUBLISH_ENABLED: "1",
        TICKET_HUB_BASE_URL: "not-a-url",
        TICKET_HUB_PROJECT_ID: "p",
        TICKET_HUB_SITE_TOKEN: "s".repeat(32),
        PGC_SNAPSHOT_EXPORT_TOKEN: "e".repeat(32),
      }),
      /TICKET_HUB_BASE_URL/,
    );
  });

  it("fails on short token", () => {
    assert.throws(
      () => parsePgcConfig({
        PGC_PUBLISH_ENABLED: "1",
        TICKET_HUB_BASE_URL: "https://x.com",
        TICKET_HUB_PROJECT_ID: "p",
        TICKET_HUB_SITE_TOKEN: "short",
        PGC_SNAPSHOT_EXPORT_TOKEN: "e".repeat(32),
      }),
      /too short/,
    );
  });

  it("fails on equal tokens", () => {
    const tok = "x".repeat(32);
    assert.throws(
      () => parsePgcConfig({
        PGC_PUBLISH_ENABLED: "1",
        TICKET_HUB_BASE_URL: "https://x.com",
        TICKET_HUB_PROJECT_ID: "p",
        TICKET_HUB_SITE_TOKEN: tok,
        PGC_SNAPSHOT_EXPORT_TOKEN: tok,
      }),
      /must be different/,
    );
  });

  it("allows localhost without HTTPS", () => {
    const cfg = parsePgcConfig({
      PGC_PUBLISH_ENABLED: "1",
      TICKET_HUB_BASE_URL: "http://localhost:3000",
      TICKET_HUB_PROJECT_ID: "p",
      TICKET_HUB_SITE_TOKEN: "s".repeat(32),
      PGC_SNAPSHOT_EXPORT_TOKEN: "e".repeat(32),
    });
    assert.ok(cfg);
  });
});