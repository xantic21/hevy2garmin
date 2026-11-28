import { describe, expect, it } from "vitest";
import { describeVault } from "./strict-panel";

const base = { configured: true, currentKid: "0123456789abcdef", rows: 2, encryptedCurrent: 2, encryptedPrevious: 0, plaintext: 0, unreadable: [] as string[] };

describe("strict panel: stored-credentials line (counts only)", () => {
  it("is ok only when every row is sealed with the current key", () => {
    expect(describeVault(base)).toMatchObject({ label: "Encrypted", tone: "ok", problem: null });
    expect(describeVault({ ...base, rows: 0, encryptedCurrent: 0 })).toMatchObject({ label: "None stored", tone: "ok" });
  });
  it.each([
    [{ ...base, configured: false, currentKid: null }, "bad", /H2G_CREDENTIALS_KEY is not set/],
    [{ ...base, plaintext: 1, encryptedCurrent: 1 }, "bad", /still plaintext/],
    [{ ...base, encryptedPrevious: 1, encryptedCurrent: 1 }, "warn", /previous key/],
    [{ ...base, unreadable: ["hevy"] }, "bad", /cannot be opened/],
  ])("reports %o as %s", (c, tone, problem) => {
    const v = describeVault(c);
    expect(v.tone).toBe(tone);
    expect(v.problem).toMatch(problem);
  });
  it("never shows a value, only counts and platform names", () => {
    expect(JSON.stringify(describeVault({ ...base, unreadable: ["garmin_tokens"] }))).not.toMatch(/di_token|api_key|h2g_enc/);
  });
});
