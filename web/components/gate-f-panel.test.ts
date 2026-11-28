import { describe, expect, it } from "vitest";
import { restoreTarget } from "./gate-f-panel";

const sets = (id: string, phase: string) => ({ id, step: "exercise_sets", phase });

describe("gate F panel: the owner's restore of the original", () => {
  it("offers the latest sets write that reached Garmin, with a confirmation naming it", () => {
    expect(restoreTarget([sets("j1", "verified"), { id: "m1", step: "metadata", phase: "verified" }])).toEqual({ journalId: "j1", confirmation: "RESTORE j1" });
    expect(restoreTarget([sets("j1", "needs_review")])).toEqual({ journalId: "j1", confirmation: "RESTORE j1" });
  });
  it.each([
    ["nothing journaled", []],
    ["no status field", undefined],
    ["only metadata", [{ id: "m1", step: "metadata", phase: "verified" }]],
    ["already restored", [sets("j1", "restored")]],
    ["not yet sent", [sets("j1", "intent")]],
  ])("offers nothing when %s", (_label, journal) => {
    expect(restoreTarget(journal as never)).toBeNull();
  });
});
