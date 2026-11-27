/**
 * Encode a validated StrictIntent as the ONE exerciseSets payload a strict
 * merge writes. Deterministic: the same intent, activity and original sets
 * always give byte-identical JSON, which is what the journal hashes.
 *
 * Differences from the upstream builder, each deliberate:
 *  - A missing weight or rep count is sent as null, never as 0 (zero/missing).
 *  - No UNKNOWN → TOTAL_BODY fallback: the intent has already refused it.
 *  - No name-stripping retries: one payload, one PUT. A rejected exercise name
 *    is a mapping error for a person to fix, not a reason to write a degraded
 *    copy over the user's activity.
 *  - The watch's own per-set timing is kept whenever its ACTIVE set count
 *    equals Hevy's (contract: "preserve native timing"). Otherwise the sets
 *    are laid out over the activity's own duration, as upstream does; the
 *    watch's original segmentation stays in the immutable backup.
 */
import { DEFAULT_SET_TIMING, type ExercisePayloadEntry, type SetTiming } from "../exercise-sets";
import { toUtcDate } from "../match";
import type { StrictIntent } from "./intent";

export interface StrictExerciseSet {
  exercises: ExercisePayloadEntry[];
  duration: number;
  setType: "ACTIVE" | "REST";
  startTime: string;
  wktStepIndex: number;
  messageIndex: number;
  repetitionCount?: number | null;
  weight?: number | null;
}

export interface StrictSetsPayload {
  activityId: number;
  exerciseSets: StrictExerciseSet[];
}

export interface StrictPayloadResult {
  payload: StrictSetsPayload;
  timingSource: "native" | "synthesized";
}

export interface StrictActivityFrame {
  activityId: number;
  startTimeGMT: string;
  durationS: number;
}

const kgToGrams = (kg: number | null): number | null => (kg == null ? null : Math.round(kg * 1000));

function synthesize(intent: StrictIntent, frame: StrictActivityFrame, timing: SetTiming): StrictExerciseSet[] {
  const start = toUtcDate(frame.startTimeGMT);
  if (!start) throw new Error("activity start is not a parseable instant");
  interface Planned { exIdx: number; setIdx: number; setDur: number; restDur: number }
  const planned: Planned[] = [];
  const exercises = intent.exercises.filter((e) => e.sets.length);
  exercises.forEach((ex, eIdx) => {
    ex.sets.forEach((s, sIdx) => {
      const setDur =
        s.durationS != null && s.durationS > 0 ? s.durationS : s.type === "warmup" ? timing.warmupSetS : timing.workingSetS;
      const lastSet = sIdx === ex.sets.length - 1;
      const lastExercise = eIdx === exercises.length - 1;
      const restDur = lastSet && lastExercise ? 0 : lastSet ? timing.restExercisesS : timing.restSetsS;
      planned.push({ exIdx: intent.exercises.indexOf(ex), setIdx: sIdx, setDur, restDur });
    });
  });
  const ideal = planned.reduce((t, p) => t + p.setDur + p.restDur, 0);
  const scale = Math.max(0.3, Math.min(2.0, ideal > 0 ? frame.durationS / ideal : 1));
  const at = (offsetS: number) => new Date(start.getTime() + Math.round(offsetS * 1000)).toISOString().replace(/\.\d+Z$/, ".0");

  const out: StrictExerciseSet[] = [];
  let cursor = 0;
  let msg = 0;
  for (const p of planned) {
    const ex = intent.exercises[p.exIdx];
    const s = ex.sets[p.setIdx];
    const dur = Math.round(p.setDur * scale * 1000) / 1000;
    out.push({
      exercises: [{ category: ex.categoryName, name: ex.subName, probability: 100 }],
      duration: dur,
      repetitionCount: s.reps,
      weight: kgToGrams(s.weightKg),
      setType: "ACTIVE",
      startTime: at(cursor),
      wktStepIndex: p.exIdx,
      messageIndex: msg++,
    });
    cursor += dur;
    if (p.restDur > 0) {
      const rest = Math.round(p.restDur * scale * 1000) / 1000;
      out.push({ exercises: [], duration: rest, setType: "REST", startTime: at(cursor), wktStepIndex: p.exIdx, messageIndex: msg++ });
      cursor += rest;
    }
  }
  return out;
}

/** Hevy's identity, reps and weight onto the watch's own set list, by ACTIVE position. */
function overlayNative(intent: StrictIntent, original: Array<Record<string, unknown>>): StrictExerciseSet[] | null {
  const flat: Array<{ exIdx: number; set: StrictIntent["exercises"][number]["sets"][number] }> = [];
  intent.exercises.forEach((ex, exIdx) => ex.sets.forEach((set) => flat.push({ exIdx, set })));
  const watchActive = original.filter((s) => s?.setType === "ACTIVE");
  if (!watchActive.length || watchActive.length !== flat.length) return null;
  for (const s of original) {
    if (!Number.isFinite(Number(s?.duration)) || typeof s?.startTime !== "string" || !Number.isFinite(Number(s?.messageIndex))) {
      return null; // the watch's own timing is unreadable, so it cannot be preserved faithfully
    }
  }
  const out: StrictExerciseSet[] = [];
  let ai = 0;
  for (const s of original) {
    if (s.setType === "ACTIVE") {
      const { exIdx, set } = flat[ai++];
      const ex = intent.exercises[exIdx];
      out.push({
        exercises: [{ category: ex.categoryName, name: ex.subName, probability: 100 }],
        duration: Number(s.duration),
        repetitionCount: set.reps,
        weight: kgToGrams(set.weightKg),
        setType: "ACTIVE",
        startTime: String(s.startTime),
        wktStepIndex: exIdx,
        messageIndex: Number(s.messageIndex),
      });
    } else {
      out.push({
        exercises: Array.isArray(s.exercises) ? (s.exercises as ExercisePayloadEntry[]) : [],
        duration: Number(s.duration),
        setType: "REST",
        startTime: String(s.startTime),
        wktStepIndex: Number(s.wktStepIndex ?? 0),
        messageIndex: Number(s.messageIndex),
      });
    }
  }
  return out;
}

export function encodeStrictPayload(
  intent: StrictIntent,
  frame: StrictActivityFrame,
  original: Record<string, unknown> | null,
  timing: Partial<SetTiming> = {},
): StrictPayloadResult {
  if (!Number.isSafeInteger(frame.activityId) || frame.activityId <= 0) throw new Error("invalid activity id");
  if (!(frame.durationS > 0)) throw new Error("activity has no duration");
  const t: SetTiming = { ...DEFAULT_SET_TIMING };
  for (const [k, v] of Object.entries(timing)) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) t[k as keyof SetTiming] = v;
  }
  const originalSets = Array.isArray(original?.exerciseSets) ? (original!.exerciseSets as Array<Record<string, unknown>>) : [];
  const native = overlayNative(intent, originalSets);
  return {
    payload: { activityId: frame.activityId, exerciseSets: native ?? synthesize(intent, frame, t) },
    timingSource: native ? "native" : "synthesized",
  };
}
