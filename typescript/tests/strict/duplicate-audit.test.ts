import { describe, expect, it, vi } from "vitest";
import { auditDuplicates, gatherActivities, type AuditActivity } from "../../src/strict";

const W = (id: string, start: string, end: string, title = id) => ({ id, title, start_time: start, end_time: end });
const A = (activityId: number, startTimeGMT: string, duration: number, manufacturer: string, typeKey = "strength_training"): AuditActivity => ({
  activityId,
  startTimeGMT,
  duration,
  manufacturer,
  activityType: { typeKey },
});
const window = { start: "2026-03-01", end: "2026-03-31" };

describe("auditDuplicates", () => {
  const workouts = [
    W("legs", "2026-03-02T17:00:00Z", "2026-03-02T18:00:00Z"),
    W("push", "2026-03-04T17:00:00Z", "2026-03-04T18:00:00Z"),
    W("pull", "2026-03-06T17:00:00Z", "2026-03-06T18:00:00Z"),
    W("clean", "2026-03-08T17:00:00Z", "2026-03-08T18:00:00Z"),
  ];
  const activities = [
    A(1, "2026-03-02 17:01:00", 3500, "GARMIN"),
    A(2, "2026-03-02 17:00:00", 3600, "DEVELOPMENT"), // upload beside the watch recording
    A(3, "2026-03-04 17:00:00", 3600, "DEVELOPMENT"),
    A(4, "2026-03-04 17:00:30", 3600, "DEVELOPMENT"), // second upload
    A(5, "2026-03-06 17:00:00", 1800, "GARMIN"),
    A(6, "2026-03-06 17:30:00", 1800, "GARMIN"), // watch started twice
    A(7, "2026-03-08 17:02:00", 3400, "GARMIN"),
    A(8, "2026-03-20 09:00:00", 1200, "DEVELOPMENT"), // orphan
  ];
  const ledger = [
    { hevyId: "legs", garminActivityId: "2", syncMethod: "upload", status: "success" },
    { hevyId: "push", garminActivityId: "4", syncMethod: "upload", status: "success" },
    { hevyId: "pull", garminActivityId: "999", syncMethod: "upload", status: "success" },
    { hevyId: "old", garminActivityId: "4", syncMethod: "match", status: "success" },
  ];
  const bindings = [{ hevyId: "clean", garminActivityId: 7, state: "verified" as const }, { hevyId: "legs", garminActivityId: 1, state: "verified" as const }];
  const report = auditDuplicates({ window, workouts, activities, ledger, bindings, now: new Date("2026-04-01T00:00:00Z") });

  it("is read-only by construction and says so", () => {
    expect(report.mode).toBe("read-only");
    expect(report.deleted).toBe(0);
  });

  it("finds every kind with exact ids", () => {
    expect(report.summary).toEqual({
      native_and_upload: 1,
      multiple_uploads: 1,
      multiple_native: 1,
      ledger_missing_activity: 1,
      ledger_shared_activity: 1,
      binding_ledger_mismatch: 1,
      orphan_upload: 1,
    });
    expect(report.findings.find((f) => f.kind === "native_and_upload")).toMatchObject({ hevyIds: ["legs"], activityIds: [1, 2] });
    expect(report.findings.find((f) => f.kind === "binding_ledger_mismatch")).toMatchObject({ activityIds: [1, 2] });
  });

  it("names cleanup candidates only where the one to keep is unambiguous", () => {
    expect(report.cleanupCandidates).toEqual([
      { activityId: 2, keepActivityId: 1, hevyId: "legs", reason: "uploaded copy of a session the watch recorded" },
      { activityId: 3, keepActivityId: 4, hevyId: "push", reason: "second upload of the same workout" },
    ]);
    // The twice-started watch is never a deletion candidate.
    expect(report.cleanupCandidates.some((c) => c.activityId === 5 || c.activityId === 6)).toBe(false);
  });

  it("does not conclude 'missing' from a possibly truncated day", () => {
    const r = auditDuplicates({ window, workouts, activities, ledger, bindings, truncatedDays: ["2026-03-06"] });
    expect(r.summary.ledger_missing_activity).toBe(0);
  });

  it("hashes the report so an approval can name exactly it", () => {
    const again = auditDuplicates({ window, workouts, activities, ledger, bindings, now: new Date("2027-01-01T00:00:00Z") });
    expect(again.reportSha256).toBe(report.reportSha256);
    expect(report.reportSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("gatherActivities", () => {
  it("splits a full chunk into days and reports a still-full day as truncated", async () => {
    const list = vi.fn(async (s: string, e: string) => {
      if (s !== e) return Array.from({ length: 50 }, (_, i) => A(1000 + i, `${s} 10:00:00`, 600, "GARMIN"));
      if (s === "2026-03-02") return Array.from({ length: 50 }, (_, i) => A(2000 + i, `${s} 10:00:00`, 600, "GARMIN"));
      return [A(Number(s.replace(/-/g, "")), `${s} 10:00:00`, 600, "GARMIN")];
    });
    const r = await gatherActivities(list, { start: "2026-03-01", end: "2026-03-03" }, 50);
    expect(r.truncatedDays).toEqual(["2026-03-02"]);
    expect(r.activities.length).toBe(52);
  });
});
