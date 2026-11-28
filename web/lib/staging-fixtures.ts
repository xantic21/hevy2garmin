/**
 * Synthetic staging data: Hevy workouts and the watch recordings Garmin holds
 * for them, built relative to "now" so they fall inside the dashboard's recent
 * window. Every id is synthetic (`syn-…`, activity ids 9100001–9100099).
 *
 * The scenarios cover what an operator should rehearse before a real activity
 * (gate F): a clean merge, a read-back mismatch and its restore, a lost
 * response and its reconcile, a rejected write, an ambiguous match (deferred),
 * a missing recording, a historical duplicate for the audit, warm-ups, a timed
 * plank and bodyweight sets.
 */
import type { getDb } from "./db";
import { stagingMode, STAGING_MARKER_KEY, StagingIsolationError } from "./staging-mode";

type Sql = ReturnType<typeof getDb>;

interface HevySet {
  type: "normal" | "warmup";
  weight_kg?: number | null;
  reps?: number | null;
  duration_seconds?: number | null;
}
interface Exercise {
  title: string;
  sets: HevySet[];
}
export interface StagingScenario {
  key: string;
  hevyId: string;
  title: string;
  dayOffset: number;
  exercises: Exercise[];
  /** Watch recordings: none (missing), one, or two (ambiguous / duplicate). */
  activities: Array<{ id: number; minutesAfter: number; quirk?: "drop_names" | "lose_response" | "blackout" | "reject"; manufacturer?: string; description?: string | null; nativeSets?: number }>;
  /** A historical (legacy) ledger row, for the duplicate audit. */
  legacy?: { garminActivityId: number; syncMethod: string };
  expect: string;
}

const strength = (title: string, kg: number | null, reps: number, n: number, warmup?: [number, number]): Exercise => ({
  title,
  sets: [
    ...(warmup ? [{ type: "warmup" as const, weight_kg: warmup[0], reps: warmup[1] }] : []),
    ...Array.from({ length: n }, () => ({ type: "normal" as const, weight_kg: kg, reps })),
  ],
});

export const STAGING_SCENARIOS: readonly StagingScenario[] = [
  {
    key: "clean",
    hevyId: "syn-legs",
    title: "Legs (synthetic)",
    dayOffset: 1,
    exercises: [strength("Squat (Barbell)", 100, 5, 3, [60, 8]), strength("Romanian Deadlift (Barbell)", 80, 8, 2)],
    activities: [{ id: 9100001, minutesAfter: -1, description: "Felt strong (my own note)" }],
    expect: "Sync now → synced; both journal steps verified; activity id, HR and calories unchanged; own note kept.",
  },
  {
    key: "drop_names",
    hevyId: "syn-push",
    title: "Push (synthetic)",
    dayOffset: 2,
    exercises: [strength("Bench Press (Barbell)", 80, 6, 3), strength("Overhead Press (Barbell)", 45, 8, 2)],
    activities: [{ id: 9100002, minutesAfter: -2, quirk: "drop_names" }],
    expect: "Sync now → needs review (read-back lost the exercise names) and writes freeze; then Restore backup → original → restored.",
  },
  {
    key: "lose_response",
    hevyId: "syn-pull",
    title: "Pull (synthetic)",
    dayOffset: 3,
    exercises: [strength("Lat Pulldown (Cable)", 55, 10, 3), strength("Pull Up", null, 8, 2)],
    activities: [{ id: 9100003, minutesAfter: 0, quirk: "lose_response" }],
    expect: "Sync now → Garmin's answer is lost, the read-back finds the sets applied → synced (no blind retry).",
  },
  {
    key: "blackout",
    hevyId: "syn-hinge",
    title: "Hinge (synthetic, outage)",
    dayOffset: 8,
    exercises: [strength("Hip Thrust (Barbell)", 100, 10, 3)],
    activities: [{ id: 9100010, minutesAfter: 0, quirk: "blackout" }],
    expect: "Sync now → uncertain (answer lost and Garmin unreadable for 60 s); live writes blocked; after a minute Check by read-back → verified, then Lift stop.",
  },
  {
    key: "timed",
    hevyId: "syn-core",
    title: "Core and hinge (synthetic)",
    dayOffset: 4,
    exercises: [{ title: "Plank", sets: [{ type: "normal", duration_seconds: 60 }, { type: "normal", duration_seconds: 45 }] }, strength("Deadlift (Barbell)", 120, 5, 2)],
    activities: [{ id: 9100004, minutesAfter: 1, nativeSets: 3 }],
    expect: "Preview shows synthesized timing (the watch counted 3 sets, Hevy has 4); Sync now → synced.",
  },
  {
    key: "ambiguous",
    hevyId: "syn-ambiguous",
    title: "Full body (synthetic, two recordings)",
    dayOffset: 5,
    exercises: [strength("Bench Press (Barbell)", 70, 8, 2), strength("Squat (Barbell)", 90, 6, 2)],
    activities: [{ id: 9100005, minutesAfter: -3 }, { id: 9100006, minutesAfter: 4 }],
    expect: "Preview/Sync → needs review (two possible watch recordings); nothing is written.",
  },
  {
    key: "missing",
    hevyId: "syn-missing",
    title: "Arms (synthetic, no recording)",
    dayOffset: 6,
    exercises: [strength("Bicep Curl (Dumbbell)", 14, 10, 3)],
    activities: [],
    expect: "Preview/Sync → waits for the watch recording; nothing is written.",
  },
  {
    key: "reject",
    hevyId: "syn-reject",
    title: "Shoulders (synthetic, rejected)",
    dayOffset: 7,
    exercises: [strength("Lateral Raise (Dumbbell)", 10, 12, 3)],
    activities: [{ id: 9100007, minutesAfter: 0, quirk: "reject" }],
    expect: "Sync now → Garmin refuses the sets (400): not applied, nothing changed on the activity.",
  },
  {
    key: "legacy_duplicate",
    hevyId: "syn-legacy",
    title: "Legacy upload (synthetic duplicate)",
    dayOffset: 9,
    exercises: [strength("Squat (Barbell)", 95, 5, 3)],
    activities: [{ id: 9100008, minutesAfter: 0 }, { id: 9100009, minutesAfter: 0, manufacturer: "DEVELOPMENT" }],
    legacy: { garminActivityId: 9100009, syncMethod: "upload" },
    expect: "Strict sync → needs review (synced before strict mode), nothing is written; the duplicate audit (read-only) reports the uploaded copy next to the watch recording.",
  },
];

const pad = (n: number) => String(n).padStart(2, "0");
/** Garmin's zone-less UTC format. */
const gmt = (d: Date, sep = " ") =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}${sep}${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

function workoutStart(now: Date, dayOffset: number): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dayOffset, 17, 0, 0));
  return d;
}

export function buildScenario(s: StagingScenario, now = new Date()) {
  const start = workoutStart(now, s.dayOffset);
  const setCount = s.exercises.reduce((n, e) => n + e.sets.length, 0);
  const minutes = 10 + setCount * 3;
  const end = new Date(start.getTime() + minutes * 60_000);
  const workout = {
    id: s.hevyId,
    title: s.title,
    description: "Synthetic staging workout",
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    updated_at: new Date(end.getTime() + 5 * 60_000).toISOString(),
    created_at: end.toISOString(),
    exercises: s.exercises.map((e, i) => ({
      index: i,
      title: e.title,
      notes: "",
      exercise_template_id: `SYN${i}`,
      superset_id: null,
      sets: e.sets.map((x, j) => ({ index: j, type: x.type, weight_kg: x.weight_kg ?? null, reps: x.reps ?? null, distance_meters: null, duration_seconds: x.duration_seconds ?? null, rpe: null })),
    })),
  };
  const activities = s.activities.map((a, k) => {
    const aStart = new Date(start.getTime() + a.minutesAfter * 60_000);
    const duration = minutes * 60 - 60;
    const nativeCount = a.nativeSets ?? setCount;
    const sets: Array<Record<string, unknown>> = [];
    let t = aStart.getTime() + 60_000;
    for (let i = 0; i < nativeCount; i++) {
      sets.push({
        setType: "ACTIVE",
        startTime: `${gmt(new Date(t), "T")}.0`,
        duration: 40 + i,
        repetitionCount: 8,
        weight: null,
        exercises: [{ category: "UNKNOWN", name: null, probability: 0 }],
        wktStepIndex: null,
        messageIndex: sets.length,
      });
      t += 40_000 + i * 1000;
      sets.push({ setType: "REST", startTime: `${gmt(new Date(t), "T")}.0`, duration: 120, repetitionCount: null, weight: null, exercises: [], wktStepIndex: null, messageIndex: sets.length });
      t += 120_000;
    }
    const summaryCommon = {
      startTimeGMT: gmt(aStart),
      startTimeLocal: gmt(aStart),
      duration,
      elapsedDuration: duration + 30,
      movingDuration: duration - 600,
      averageHR: 112 + k,
      maxHR: 158,
      minHR: 71,
      calories: 300 + s.dayOffset * 7,
      bmrCalories: 60,
      trainingEffect: 2.4,
      anaerobicTrainingEffect: 1.6,
      activityTrainingLoad: 48.5,
      differenceBodyBattery: -9,
    };
    const manufacturer = a.manufacturer ?? "GARMIN";
    return {
      id: a.id,
      quirk: a.quirk ?? null,
      startGmt: aStart.toISOString(),
      summary: { activityId: a.id, ...summaryCommon, manufacturer, activityType: { typeKey: "strength_training" } },
      detail: {
        activityId: a.id,
        activityName: manufacturer === "GARMIN" ? "Strength" : s.title,
        description: a.description ?? null,
        activityTypeDTO: { typeKey: "strength_training" },
        metadataDTO: { manufacturer, deviceMetaDataDTO: { deviceId: 3_900_001, deviceTypePk: 3_500 } },
        summaryDTO: summaryCommon,
      },
      sets: manufacturer === "GARMIN" ? sets : [],
    };
  });
  return { workout, activities };
}

/**
 * Empty the staging data (ledger included) and load the scenarios. Staging
 * only, on a marked staging database; the strict tables are dropped and
 * re-created because their backups are insert-only by design.
 */
export async function seedStaging(sql: Sql, rebootstrap: () => Promise<unknown>, now = new Date()): Promise<{ workouts: number; activities: number }> {
  if (!stagingMode()) throw new StagingIsolationError("seeding is only possible in synthetic staging");
  const marker = (await sql`SELECT 1 FROM app_cache WHERE key = ${STAGING_MARKER_KEY}`) as unknown[];
  if (!marker.length) throw new StagingIsolationError("this database is not marked as a staging database");
  await sql`DROP TABLE IF EXISTS strict_bindings, strict_backups, strict_journal, strict_control, strict_activity_locks, strict_gate_f CASCADE`;
  await sql`DELETE FROM synced_workouts WHERE hevy_id LIKE 'syn-%'`;
  await sql`DELETE FROM sync_log`;
  await sql`DELETE FROM hr_cache WHERE hevy_id LIKE 'syn-%'`;
  await sql`DELETE FROM staging_hevy_workouts`;
  await sql`DELETE FROM staging_garmin_activities`;
  await sql`DELETE FROM staging_requests`;
  await rebootstrap();
  let activities = 0;
  for (const s of STAGING_SCENARIOS) {
    const { workout, activities: acts } = buildScenario(s, now);
    await sql`INSERT INTO staging_hevy_workouts (id, payload, start_time) VALUES (${workout.id}, ${sql.json(workout)}, ${workout.start_time})`;
    for (const a of acts) {
      await sql`INSERT INTO staging_garmin_activities (activity_id, summary, detail, sets, quirk, start_gmt)
                VALUES (${a.id}, ${sql.json(a.summary)}, ${sql.json(a.detail)}, ${sql.json(a.sets)}, ${a.quirk}, ${a.startGmt})`;
      activities += 1;
    }
    if (s.legacy) {
      await sql`INSERT INTO synced_workouts (hevy_id, garmin_activity_id, title, status, sync_method)
                VALUES (${s.hevyId}, ${String(s.legacy.garminActivityId)}, ${s.title}, 'success', ${s.legacy.syncMethod})`;
    }
  }
  return { workouts: STAGING_SCENARIOS.length, activities };
}
