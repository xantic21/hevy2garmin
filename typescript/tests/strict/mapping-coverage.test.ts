/**
 * Contract item 5 ("check exercise mappings, units, weights, reps, warm-ups
 * and special cases") as pinned invariants, so drift in the mapping tables or
 * the encoder shows up as a failing test rather than on someone's activity.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HEVY_TO_GARMIN, TEMPLATE_TO_GARMIN } from "../../src/exercise-map";
import { categoryToString } from "../../src/exercise-sets";
import { fitExerciseStrings } from "../../src/exercise-strings";
import { UNKNOWN_CATEGORY } from "../../src/mapper";
import { blockingIssues, buildStrictIntent, encodeStrictPayload } from "../../src/strict";

const tables = { HEVY_TO_GARMIN, TEMPLATE_TO_GARMIN } as Record<string, Record<string, [number, number]>>;

describe("built-in mapping tables", () => {
  it.each(Object.keys(tables))("%s: the set API name and the FIT profile name agree for every mapped category", (name) => {
    for (const [key, [cat, sub]] of Object.entries(tables[name])) {
      if (cat === UNKNOWN_CATEGORY) continue;
      const api = categoryToString(cat);
      const [fit] = fitExerciseStrings(cat, sub);
      expect(api, `${key} → ${cat}/${sub}`).not.toBe("UNKNOWN");
      expect(fit, `${key} → ${cat}/${sub}`).toBe(api);
    }
  });

  it("names exactly the exercises Garmin has no category for, so strict mode asks for a mapping", () => {
    const unknown = Object.entries(HEVY_TO_GARMIN).filter(([, [c]]) => c === UNKNOWN_CATEGORY).map(([k]) => k).sort();
    expect(unknown).toEqual(["Lying Neck Curls", "Lying Neck Curls (Weighted)", "Lying Neck Extension", "Lying Neck Extension (Weighted)"]);
    const w = { id: "x", start_time: "2026-01-01T10:00:00Z", end_time: "2026-01-01T11:00:00Z", exercises: [{ title: unknown[0], sets: [{ type: "normal", reps: 10 }] }] };
    expect(blockingIssues(buildStrictIntent(w)).map((i) => i.code)).toEqual(["unmapped_exercise"]);
  });
});

describe("units and numbers", () => {
  const frame = { activityId: 1, startTimeGMT: "2026-01-01 10:00:00", durationS: 3600 };
  const one = (set: Record<string, unknown>) => {
    const intent = buildStrictIntent({
      id: "u",
      start_time: "2026-01-01T10:00:00Z",
      end_time: "2026-01-01T11:00:00Z",
      exercises: [{ title: "Bench Press (Barbell)", sets: [set] }],
    });
    return encodeStrictPayload(intent, frame, null).payload.exerciseSets[0];
  };

  it.each([
    [100, 100000],
    [22.5, 22500],
    [45.359237, 45359], // 100 lb as Hevy reports it: kilograms, never pounds
    [2.267962, 2268], // 5 lb plate
    [0.5, 500],
    [0, 0],
  ])("%f kg is written as %i g", (kg, grams) => {
    expect(one({ type: "normal", weight_kg: kg, reps: 5 }).weight).toBe(grams);
  });

  it("keeps a recorded zero apart from a missing value, for weight and reps", () => {
    expect(one({ type: "normal", weight_kg: null, reps: 0 })).toMatchObject({ weight: null, repetitionCount: 0 });
    expect(one({ type: "normal", weight_kg: 0, reps: null })).toMatchObject({ weight: 0, repetitionCount: null });
  });

  it("uses a timed set's own duration (plank, carries)", () => {
    expect(one({ type: "normal", duration_seconds: 75 }).duration).toBeGreaterThan(0);
  });
});

describe("the anonymised real-workout fixture through the strict model", () => {
  const workouts = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "tests", "fixtures", "real_workouts.json"), "utf8")) as Array<Record<string, unknown>>;

  it("every workout either validates or names exactly what blocks it", () => {
    const report = workouts.map((w) => {
      const intent = buildStrictIntent({ ...w, end_time: w.end_time ?? w.start_time });
      return { id: w.id, block: blockingIssues(intent).map((i) => i.code) };
    });
    for (const r of report) {
      for (const code of r.block) expect(["unmapped_exercise", "invalid_interval"]).toContain(code);
    }
    // The fixture is a regression baseline: most real sessions must be writable.
    expect(report.filter((r) => r.block.length === 0).length).toBeGreaterThanOrEqual(Math.ceil(workouts.length * 0.8));
  });
});
