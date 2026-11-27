import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENGINE_PACKAGE_VERSION, ENGINE_VARIANT } from "../src";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

describe("engine identity", () => {
  it("matches package.json, so the dashboard check cannot drift", () => {
    expect(pkg.version).toBe(ENGINE_PACKAGE_VERSION);
    expect(ENGINE_VARIANT).toBe("xantform-strict-inplace");
  });

  it("can never be published under the upstream npm name", () => {
    expect(pkg.private).toBe(true);
    expect(pkg.scripts.prepublishOnly).toMatch(/process\.exit\(1\)/);
    expect(pkg.publishConfig).toBeUndefined();
  });

  it("is qualified against the exact garmin-auth the dashboard runs", () => {
    const web = JSON.parse(readFileSync(join(__dirname, "..", "..", "web", "package-lock.json"), "utf8"));
    const ours = JSON.parse(readFileSync(join(__dirname, "..", "package-lock.json"), "utf8"));
    expect(ours.packages["node_modules/garmin-auth"].version).toBe(
      web.packages["node_modules/garmin-auth"].version,
    );
  });
});
