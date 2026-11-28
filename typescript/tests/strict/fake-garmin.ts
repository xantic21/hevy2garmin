/**
 * A scripted Garmin for strict-mode tests. It keeps real state (sets, name,
 * description, metrics per activity) so read-back is honest, and every write
 * is counted. Behaviours model the failure modes contract item 8 lists.
 */
import type { StrictGarminPort, StrictSetsPayload } from "../../src/strict";
import type { CandidateActivity } from "../../src/merge-match";

export type PutBehaviour =
  | "apply" // 2xx, stored as sent
  | "reject" // 4xx, nothing stored
  | "timeout_applied" // stored, but the response is lost
  | "timeout_not_applied" // nothing stored, the request timed out
  | "apply_dropping_names" // stored with every exercise name removed
  | "apply_changing_calories"; // stored, and Garmin recomputes calories

export interface FakeActivity {
  activityId: number;
  startTimeGMT: string;
  duration: number;
  manufacturer?: string;
  typeKey?: string;
  activityName?: string;
  description?: string | null;
  calories?: number;
  averageHR?: number;
  sets?: Array<Record<string, unknown>>;
}

export function nativeActivity(over: Partial<FakeActivity> = {}): FakeActivity {
  return {
    activityId: 9001,
    startTimeGMT: "2026-03-10 17:00:00",
    duration: 3600,
    manufacturer: "GARMIN",
    typeKey: "strength_training",
    activityName: "Strength",
    description: null,
    calories: 412,
    averageHR: 118,
    sets: [],
    ...over,
  };
}

export function createFakeGarmin(activities: FakeActivity[]) {
  const state = new Map<number, FakeActivity>(activities.map((a) => [a.activityId, structuredClone(a)]));
  const calls = { list: 0, detail: 0, sets: 0, putSets: 0, putMeta: 0 };
  const behaviour = {
    list: "ok" as "ok" | "throw" | "truncated",
    put: "apply" as PutBehaviour,
    meta: "apply" as PutBehaviour,
    readback: "ok" as "ok" | "throw_after_put",
  };
  let putCount = 0;

  const detailOf = (a: FakeActivity) => ({
    activityId: a.activityId,
    activityName: a.activityName,
    description: a.description,
    activityTypeDTO: { typeKey: a.typeKey },
    metadataDTO: { manufacturer: a.manufacturer, deviceMetaDataDTO: { deviceId: 3_400_000_001 } },
    summaryDTO: {
      startTimeGMT: a.startTimeGMT,
      duration: a.duration,
      averageHR: a.averageHR,
      maxHR: 162,
      calories: a.calories,
      trainingEffect: 2.4,
    },
  });

  const port: StrictGarminPort = {
    async activitiesByDate() {
      calls.list += 1;
      if (behaviour.list === "throw") throw new Error("connectapi /activitylist-service → 429");
      const list = [...state.values()].map(
        (a): CandidateActivity => ({
          activityId: a.activityId,
          startTimeGMT: a.startTimeGMT,
          duration: a.duration,
          manufacturer: a.manufacturer,
          activityType: { typeKey: a.typeKey },
          activityName: a.activityName,
        }),
      );
      if (behaviour.list === "truncated") return Array.from({ length: 50 }, (_, i) => ({ ...list[0], activityId: 70000 + i }));
      return list;
    },
    async activityDetail(id) {
      calls.detail += 1;
      if (behaviour.readback === "throw_after_put" && putCount > 0) throw new Error("connectapi → 503");
      const a = state.get(id);
      return a ? detailOf(a) : null;
    },
    async exerciseSets(id) {
      calls.sets += 1;
      if (behaviour.readback === "throw_after_put" && putCount > 0) throw new Error("connectapi → 503");
      const a = state.get(id);
      return { activityId: id, exerciseSets: structuredClone(a?.sets ?? []) };
    },
    async putExerciseSets(id, payload: StrictSetsPayload) {
      calls.putSets += 1;
      putCount += 1;
      const a = state.get(id)!;
      const store = (sets: Array<Record<string, unknown>>) => {
        a.sets = structuredClone(sets);
      };
      switch (behaviour.put) {
        case "apply":
          store(payload.exerciseSets as unknown as Array<Record<string, unknown>>);
          return;
        case "reject":
          throw new Error(`PUT exerciseSets ${id} → 400: invalid sub-category`);
        case "timeout_applied":
          store(payload.exerciseSets as unknown as Array<Record<string, unknown>>);
          throw new Error("The operation was aborted due to timeout");
        case "timeout_not_applied":
          throw new Error("The operation was aborted due to timeout");
        case "apply_dropping_names":
          store(
            (payload.exerciseSets as unknown as Array<Record<string, unknown>>).map((s) => ({
              ...s,
              exercises: (s.exercises as Array<Record<string, unknown>>).map((e) => ({ ...e, name: null })),
            })),
          );
          return;
        case "apply_changing_calories":
          store(payload.exerciseSets as unknown as Array<Record<string, unknown>>);
          a.calories = (a.calories ?? 0) + 37;
          return;
      }
    },
    async updateActivityMetadata(id, fields) {
      calls.putMeta += 1;
      putCount += 1;
      const a = state.get(id)!;
      if (behaviour.meta === "reject") throw new Error(`POST /activity-service/activity/${id} → 400`);
      if (behaviour.meta === "timeout_not_applied") throw new Error("timeout");
      if (fields.activityName !== undefined) a.activityName = fields.activityName;
      if (fields.description !== undefined) a.description = fields.description;
      if (behaviour.meta === "timeout_applied") throw new Error("timeout");
    },
  };

  return { port, state, calls, behaviour, writes: () => calls.putSets + calls.putMeta };
}

/** A minimal legacy SyncStore. */
export function fakeLegacy(synced: string[] = [], pending: string[] = []) {
  const marked: Array<{ hevyId: string; opts: Record<string, unknown> }> = [];
  return {
    marked,
    store: {
      loadSyncedIds: async () => new Set(synced),
      loadPendingIds: async () => new Set(pending),
      markSynced: async (hevyId: string, opts: Record<string, unknown>) => {
        marked.push({ hevyId, opts });
      },
    },
  };
}

export function hevyWorkout(over: Record<string, unknown> = {}) {
  return {
    id: "hevy-1",
    title: "Push Day",
    start_time: "2026-03-10T17:02:00+00:00",
    end_time: "2026-03-10T17:58:00+00:00",
    updated_at: "2026-03-10T18:00:00+00:00",
    exercises: [
      {
        title: "Bench Press (Barbell)",
        exercise_template_id: "79D0BB3A",
        sets: [
          { type: "warmup", weight_kg: 40, reps: 10 },
          { type: "normal", weight_kg: 80, reps: 8 },
          { type: "failure", weight_kg: 80, reps: 6 },
        ],
      },
      {
        title: "Pull Up",
        sets: [
          { type: "normal", weight_kg: null, reps: 10 },
          { type: "dropset", weight_kg: 0, reps: 5 },
        ],
      },
    ],
    ...over,
  };
}

export const NOW = new Date("2026-03-10T20:00:00Z");
