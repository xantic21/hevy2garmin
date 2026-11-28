import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { DEFAULT_SSO_WORKER_URL } from "garmin-auth";

// Fork hardening: the browser sign-in never posts a Garmin ticket to a shared
// third-party Worker. It always asks this server's /api/garmin-ticket-exchange,
// which uses direct login or the owner's own Worker and otherwise refuses.
describe("Garmin browser sign-in", () => {
  const source = readFileSync(join(__dirname, "connect-garmin.tsx"), "utf8");

  it("exchanges the ticket only on this server", () => {
    expect(source).toContain('fetch(withBasePath("/api/garmin-ticket-exchange")');
  });

  it("contains no reference to the shared SSO Worker", () => {
    expect(source).not.toContain(new URL(DEFAULT_SSO_WORKER_URL).host);
    expect(source).not.toMatch(/workers\.dev/);
  });
});
