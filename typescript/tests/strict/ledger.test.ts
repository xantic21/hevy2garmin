import { describe, expect, it } from "vitest";
import { memoryStrictLedger, STRICT_LEDGER_CONTRACT } from "../../src/strict";

describe("memoryStrictLedger satisfies the strict ledger contract", () => {
  for (const c of STRICT_LEDGER_CONTRACT) {
    it(c.name, () => c.run(async () => memoryStrictLedger()));
  }

  it("backups are immutable objects in memory too", async () => {
    const l = memoryStrictLedger();
    const b = await l.saveBackup({ garminActivityId: 1, hevyId: "h", kind: "pre_write", payload: { sets: [1] }, sha256: "s" });
    (b.payload as { sets: number[] }).sets.push(2); // a caller mutating its copy...
    expect((await l.getBackup(b.id))?.payload).toEqual({ sets: [1] }); // ...cannot reach the stored one
  });
});
