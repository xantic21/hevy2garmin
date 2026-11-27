import { describe, expect, it } from "vitest";
import { assertLegacyGarminWrites, strictAutomaticEnabled, strictModeActive, syncMode } from "./strict-mode";

describe("sync mode is strict unless legacy is stated exactly", () => {
  it("defaults to strict with no variables (this project runs with none)", () => {
    expect(syncMode()).toBe("strict_inplace");
    expect(strictModeActive()).toBe(true);
  });

  it.each([
    [{ H2G_SYNC_MODE: "legacy_upstream" }],
    [{ H2G_LEGACY_UPSTREAM_ACK: "uploads-and-deletes-allowed" }],
    [{ H2G_SYNC_MODE: "legacy", H2G_LEGACY_UPSTREAM_ACK: "uploads-and-deletes-allowed" }],
    [{ H2G_SYNC_MODE: "LEGACY_UPSTREAM", H2G_LEGACY_UPSTREAM_ACK: "uploads-and-deletes-allowed" }],
    [{ H2G_SYNC_MODE: "legacy_upstream", H2G_LEGACY_UPSTREAM_ACK: "yes" }],
    [{ H2G_SYNC_MODE: " legacy_upstream", H2G_LEGACY_UPSTREAM_ACK: "uploads-and-deletes-allowed" }],
  ])("a partial or misspelled legacy configuration stays strict: %j", (env) => {
    expect(syncMode(env)).toBe("strict_inplace");
  });

  it("legacy needs both variables exactly", () => {
    expect(syncMode({ H2G_SYNC_MODE: "legacy_upstream", H2G_LEGACY_UPSTREAM_ACK: "uploads-and-deletes-allowed" })).toBe("legacy_upstream");
  });

  it("automatic strict sync needs the exact owner token", () => {
    expect(strictAutomaticEnabled({})).toBe(false);
    expect(strictAutomaticEnabled({ H2G_STRICT_AUTOMATIC: "true" })).toBe(false);
    expect(strictAutomaticEnabled({ H2G_STRICT_AUTOMATIC: "enabled-by-owner" })).toBe(true);
  });

  it("library code that would write to Garmin throws in strict mode", () => {
    expect(() => assertLegacyGarminWrites("x")).toThrow(/strict in-place mode/);
  });
});
