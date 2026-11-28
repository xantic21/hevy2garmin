import { describe, expect, it } from "vitest";
import { ENGINE_PACKAGE_VERSION, ENGINE_VARIANT } from "hevy2garmin";

describe("dashboard engine", () => {
  it("is the fork-local strict engine, not a registry release", () => {
    expect(ENGINE_VARIANT).toBe("xantform-strict-inplace");
    expect(ENGINE_PACKAGE_VERSION).toMatch(/-xantform\.strict\.\d+$/);
  });
});
