import { describe, expect, it } from "vitest";
import {
  BLOCK_END,
  BLOCK_START,
  blockingIssues,
  buildStrictIntent,
  canonicalJson,
  compareActiveSets,
  comparePreservedMetrics,
  encodeStrictPayload,
  extractPreservedMetrics,
  mergeDescription,
  sha256Canonical,
  strictDescriptionBlock,
  userNotesOf,
} from "../../src/strict";
import { hevyWorkout } from "./fake-garmin";

const frame = { activityId: 9001, startTimeGMT: "2026-03-10 17:00:00", durationS: 3600 };

describe("buildStrictIntent: units, zero vs missing, set types", () => {
  it("keeps every set type, kilograms as kilograms, and null apart from 0", () => {
    const intent = buildStrictIntent(hevyWorkout());
    expect(blockingIssues(intent)).toEqual([]);
    const [bench, pull] = intent.exercises;
    expect(bench.sets.map((s) => s.type)).toEqual(["warmup", "normal", "failure"]);
    expect(bench.sets[1]).toMatchObject({ reps: 8, weightKg: 80 });
    expect(pull.sets[0]).toMatchObject({ type: "normal", reps: 10, weightKg: null });
    expect(pull.sets[1]).toMatchObject({ type: "dropset", reps: 5, weightKg: 0 });
    expect(bench).toMatchObject({ categoryName: "BENCH_PRESS", subName: "BARBELL_BENCH_PRESS", mappingSource: "builtin" });
    expect(intent.activeSetCount).toBe(5);
  });

  it("refuses an unmapped exercise instead of guessing TOTAL_BODY", () => {
    const w = hevyWorkout({ exercises: [{ title: "Totally Made Up Exercise", sets: [{ type: "normal", reps: 5 }] }] });
    expect(blockingIssues(buildStrictIntent(w)).map((i) => i.code)).toEqual(["unmapped_exercise"]);
  });

  it("refuses a custom mapping onto a category Garmin's set API does not know", () => {
    const w = hevyWorkout({ exercises: [{ title: "Odd", sets: [{ type: "normal", reps: 5 }] }] });
    const codes = blockingIssues(buildStrictIntent(w, { customMappings: { Odd: [999, 1] } })).map((i) => i.code);
    expect(codes).toContain("invalid_mapping");
  });

  it.each([
    [{ type: "normal", reps: 7.5 }, "invalid_reps"],
    [{ type: "normal", reps: -1 }, "invalid_reps"],
    [{ type: "normal", weight_kg: -5, reps: 1 }, "invalid_weight"],
    [{ type: "normal", weight_kg: 1200, reps: 1 }, "invalid_weight"],
    [{ type: "normal", weight_kg: "abc", reps: 1 }, "invalid_weight"],
    [{ type: "normal", duration_seconds: -3 }, "invalid_duration"],
    [{ type: "superset", reps: 3 }, "unknown_set_type"],
  ])("blocks implausible set %j", (set, code) => {
    const w = hevyWorkout({ exercises: [{ title: "Bench Press (Barbell)", sets: [set] }] });
    expect(blockingIssues(buildStrictIntent(w)).map((i) => i.code)).toContain(code);
  });

  it("warns, never silently drops, for cardio distance and empty sets", () => {
    const w = hevyWorkout({
      exercises: [{ title: "Running", sets: [{ type: "normal", distance_meters: 1600, duration_seconds: 420 }, { type: "normal" }] }],
    });
    const intent = buildStrictIntent(w);
    expect(blockingIssues(intent)).toEqual([]);
    expect(intent.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["distance_not_representable", "empty_set"]));
    expect(intent.exercises[0].sets[0]).toMatchObject({ distanceM: 1600, durationS: 420, reps: null, weightKg: null });
  });

  it("excluding warm-ups is a recorded choice", () => {
    const intent = buildStrictIntent(hevyWorkout(), { includeWarmups: false });
    expect(intent.activeSetCount).toBe(4);
    expect(intent.issues.map((i) => i.code)).toContain("warmup_excluded");
  });

  it("never guesses a timezone", () => {
    for (const bad of [
      { start_time: "2026-03-10T17:02:00", end_time: "2026-03-10T17:58:00" },
      { start_time: "2026-03-10T17:58:00Z", end_time: "2026-03-10T17:02:00Z" },
    ]) {
      expect(blockingIssues(buildStrictIntent(hevyWorkout(bad))).map((i) => i.code)).toContain("invalid_interval");
    }
  });
});

describe("encodeStrictPayload", () => {
  const intent = buildStrictIntent(hevyWorkout());

  it("synthesizes timing when the watch has no matching set count, with null kept null", () => {
    const { payload, timingSource } = encodeStrictPayload(intent, frame, { exerciseSets: [] });
    expect(timingSource).toBe("synthesized");
    const active = payload.exerciseSets.filter((s) => s.setType === "ACTIVE");
    expect(active).toHaveLength(5);
    expect(active[0]).toMatchObject({ weight: 40000, repetitionCount: 10, exercises: [{ category: "BENCH_PRESS", name: "BARBELL_BENCH_PRESS", probability: 100 }] });
    expect(active[3]).toMatchObject({ weight: null, repetitionCount: 10 });
    expect(active[4]).toMatchObject({ weight: 0, repetitionCount: 5 });
    expect(payload.exerciseSets[0].startTime).toBe("2026-03-10T17:00:00.0");
  });

  it("keeps the watch's own timing and rests when the ACTIVE counts agree", () => {
    const watch = {
      exerciseSets: Array.from({ length: 5 }, (_, i) => [
        { setType: "ACTIVE", duration: 31 + i, startTime: `2026-03-10T17:0${i}:00.0`, messageIndex: i * 2, exercises: [] },
        { setType: "REST", duration: 90, startTime: `2026-03-10T17:0${i}:40.0`, messageIndex: i * 2 + 1, wktStepIndex: 0, exercises: [] },
      ]).flat(),
    };
    const { payload, timingSource } = encodeStrictPayload(intent, frame, watch);
    expect(timingSource).toBe("native");
    expect(payload.exerciseSets).toHaveLength(10);
    expect(payload.exerciseSets[2]).toMatchObject({ setType: "ACTIVE", duration: 32, startTime: "2026-03-10T17:01:00.0", repetitionCount: 8, weight: 80000 });
    expect(payload.exerciseSets[1]).toMatchObject({ setType: "REST", duration: 90 });
  });

  it("is deterministic, so the journal hash identifies the exact bytes", () => {
    const a = encodeStrictPayload(intent, frame, { exerciseSets: [] }).payload;
    const b = encodeStrictPayload(buildStrictIntent(hevyWorkout()), frame, { exerciseSets: [] }).payload;
    expect(sha256Canonical(a)).toBe(sha256Canonical(b));
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe("read-back comparison", () => {
  const intent = buildStrictIntent(hevyWorkout());
  const { payload } = encodeStrictPayload(intent, frame, { exerciseSets: [] });

  it("accepts an exact read-back and a 1 g float difference", () => {
    const back = structuredClone(payload) as unknown as { exerciseSets: Array<Record<string, unknown>> };
    back.exerciseSets[0].weight = 40000.4;
    expect(compareActiveSets(payload, back)).toEqual([]);
  });

  it("reports dropped names, changed reps, missing sets and null↔0 normalisation", () => {
    const back = structuredClone(payload) as unknown as { exerciseSets: Array<Record<string, unknown>> };
    const active = back.exerciseSets.filter((s) => s.setType === "ACTIVE");
    (active[0].exercises as Array<Record<string, unknown>>)[0].name = null;
    active[1].repetitionCount = 7;
    active[3].weight = 0;
    const fields = compareActiveSets(payload, back).map((m) => `${m.index}:${m.field}`);
    expect(fields).toEqual(["0:name", "1:reps", "3:weight"]);
    back.exerciseSets.pop();
    back.exerciseSets = back.exerciseSets.filter((s) => s !== active[4]);
    expect(compareActiveSets(payload, back)[0]).toMatchObject({ field: "count", expected: 5, actual: 4 });
  });

  it("compares only native metrics that existed before the write", () => {
    const before = extractPreservedMetrics({ activityId: 1, summaryDTO: { averageHR: 120, calories: 400 } });
    expect(comparePreservedMetrics(before, { activityId: 1, summaryDTO: { averageHR: 120, calories: 400, newField: 1 } })).toEqual([]);
    expect(comparePreservedMetrics(before, { activityId: 1, summaryDTO: { averageHR: 120 } })[0]).toMatchObject({ path: "summaryDTO.calories" });
  });
});

describe("description", () => {
  const intent = buildStrictIntent(hevyWorkout());
  const block = strictDescriptionBlock(intent);

  it("lists Hevy facts with set types and never an estimated heart rate or calories", () => {
    expect(block).toContain("W 10 reps · 40 kg");
    expect(block).toContain("F 6 reps · 80 kg");
    expect(block).toContain("10 reps · bodyweight");
    expect(block).toContain("D 5 reps · 0 kg");
    expect(block).not.toMatch(/kcal|calorie|bpm|heart/i);
  });

  it("keeps the user's own notes byte for byte and replaces only its own block", () => {
    const user = "Felt strong.\nLeft shoulder a bit tight — watch it.";
    const first = mergeDescription(user, block)!;
    expect(first.startsWith(user)).toBe(true);
    const edited = first.replace("Felt strong.", "Felt strong!") + "\nPS: new note";
    const second = mergeDescription(edited, block.replace("Push Day", "Push Day v2"))!;
    expect(userNotesOf(second)).toBe(userNotesOf(edited));
    expect(second.match(new RegExp(BLOCK_START.replace(/[[\]/]/g, "\\$&"), "g"))).toHaveLength(1);
    expect(second).toContain(BLOCK_END);
    expect(second).toContain("Push Day v2");
  });

  it("refuses to truncate: an over-long result is skipped", () => {
    expect(mergeDescription("x".repeat(3990), block)).toBeNull();
  });
});
