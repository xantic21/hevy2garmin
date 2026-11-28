import { describe, expect, it, vi } from "vitest";
import { restrictToOriginalSets, selectStrictMergeMatch } from "../src/strict-merge-policy";
import type { CandidateActivity } from "../src/merge-match";

const now = new Date("2026-01-02T18:00:00Z");
const workout = { start_time: "2026-01-02T12:00:00Z", end_time: "2026-01-02T13:00:00Z" };
const native = (overrides: Partial<CandidateActivity> = {}): CandidateActivity => ({
  activityId: 123, startTimeGMT: "2026-01-02 12:02:00", duration: 3600,
  activityType: { typeKey: "strength_training" }, manufacturer: "GARMIN", ...overrides,
});
describe("strict original activity matching", () => {
  it("accepts exactly one native strength activity", () => {
    const result = selectStrictMergeMatch(workout, [native()], now);
    expect(result.status).toBe("matched");
    if (result.status === "matched") expect(result.match.activity.activityId).toBe(123);
  });
  it("waits instead of uploading when no activity exists", () => {
    expect(selectStrictMergeMatch(workout, [], now).status).toBe("pending");
  });
  it("does not adopt a prior generated upload", () => {
    expect(selectStrictMergeMatch(workout, [native({ manufacturer: "DEVELOPMENT" })], now).status).toBe("pending");
    expect(selectStrictMergeMatch(workout, [native({ manufacturer: "DEVELOPMENT", activityId: 456 }), native()], now).status).toBe("matched");
  });
  it("holds ambiguous activity matches rather than choosing a winner", () => {
    expect(selectStrictMergeMatch(workout, [native(), native({ activityId: 456 })], now).status).toBe("needs_review");
    expect(selectStrictMergeMatch(workout, [native(), native()], now).status).toBe("needs_review");
  });
  it("holds unproven provenance and missing UTC timestamps", () => {
    expect(selectStrictMergeMatch(workout, [native({ manufacturer: undefined })], now).status).toBe("needs_review");
    expect(selectStrictMergeMatch(workout, [native({ startTimeGMT: undefined })], now).status).toBe("needs_review");
  });
  it("rejects malformed, future or timezone-free Hevy timestamps", () => {
    expect(selectStrictMergeMatch({ ...workout, start_time: "2026-01-02T12:00:00" }, [native()], now).status).toBe("needs_review");
    expect(selectStrictMergeMatch({ ...workout, end_time: "2026-01-03T13:00:00Z" }, [native()], now).status).toBe("needs_review");
  });
  it("honours explicit timezones and the overlap and drift thresholds", () => {
    expect(selectStrictMergeMatch({ start_time: "2026-01-02T13:00:00+01:00", end_time: "2026-01-02T14:00:00+01:00" }, [native()], now).status).toBe("matched");
    expect(selectStrictMergeMatch(workout, [native({ duration: 1200 })], now).status).toBe("pending");
    expect(selectStrictMergeMatch(workout, [native({ startTimeGMT: "2026-01-02 12:21:00" })], now).status).toBe("pending");
  });
  it("never chooses a non-strength session", () => {
    expect(selectStrictMergeMatch(workout, [native({ activityType: { typeKey: "running" } })], now).status).toBe("pending");
  });
});
describe("strict set-only capability", () => {
  it("exposes only the selected ID's read and write, never upload/delete", async () => {
    const gateway = {
      exerciseSets: vi.fn(async () => ({ exerciseSets: [] })),
      putExerciseSets: vi.fn(async () => {}),
      upload: vi.fn(), deleteActivity: vi.fn(), rename: vi.fn(), describe: vi.fn(),
    };
    const cap = restrictToOriginalSets(gateway, 123);
    const payload = { exerciseSets: [] };
    await cap.readSets();
    await cap.writeSets(payload);
    expect(Object.keys(cap).sort()).toEqual(["activityId", "readSets", "writeSets"]);
    expect(gateway.exerciseSets).toHaveBeenCalledWith(123);
    expect(gateway.putExerciseSets).toHaveBeenCalledWith(123, payload);
    expect(gateway.upload).not.toHaveBeenCalled();
    expect(gateway.deleteActivity).not.toHaveBeenCalled();
    expect(Object.isFrozen(cap)).toBe(true);
    expect(() => restrictToOriginalSets(gateway, 0)).toThrow();
  });
});
