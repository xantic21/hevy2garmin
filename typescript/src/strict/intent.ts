/**
 * The canonical, validated description of what a strict in-place merge is
 * about to write, built from one Hevy workout BEFORE anything touches Garmin.
 *
 * Contract item 3: "persist and verify ... validated exercise mapping/units"
 * and "distinguish zero/missing and warmups/failure/drop/cardio sets". The
 * upstream payload builder folds those distinctions away (a missing weight
 * becomes 0, a warm-up is an ordinary ACTIVE set, an unmapped exercise is sent
 * as TOTAL_BODY). Strict mode keeps them in this model, refuses anything it
 * cannot represent faithfully, and records the model in its journal.
 *
 * Units: Hevy's public API always reports weight in kilograms and distance in
 * metres, whatever unit the user displays; Garmin's exerciseSets take weight in
 * grams. Nothing here converts from pounds, and a test pins that.
 */
import { lookupExercise, UNKNOWN_CATEGORY, type CustomMappings, type MappingSource } from "../mapper";
import { categoryToString } from "../exercise-sets";
import { fitExerciseStrings } from "../exercise-strings";

export type HevySetType = "normal" | "warmup" | "failure" | "dropset";
const SET_TYPES: ReadonlySet<string> = new Set(["normal", "warmup", "failure", "dropset"]);

/** Plausibility limits. Outside them the value is a data error, not a lift. */
export const STRICT_LIMITS = Object.freeze({
  maxWeightKg: 1000,
  maxReps: 1000,
  maxDurationS: 24 * 3600,
  maxDistanceM: 1_000_000,
  maxSets: 300,
});

export interface StrictSetIntent {
  /** Position within its exercise, from 0. */
  index: number;
  type: HevySetType;
  /** null = not recorded; 0 = recorded as zero. Never conflated. */
  reps: number | null;
  weightKg: number | null;
  durationS: number | null;
  distanceM: number | null;
}

export interface StrictExerciseIntent {
  index: number;
  title: string;
  templateId: string | null;
  category: number;
  categoryName: string;
  subcategory: number;
  /** Garmin's exercise name string, or null for the category's generic label. */
  subName: string | null;
  mappingSource: MappingSource;
  supersetId: number | null;
  sets: StrictSetIntent[];
}

export interface StrictIntentIssue {
  code: string;
  /** `block` refuses the write; `warn` is recorded and shown, nothing is lost silently. */
  severity: "block" | "warn";
  message: string;
  exerciseIndex?: number;
  setIndex?: number;
}

export interface StrictIntent {
  hevyId: string;
  title: string;
  startTime: string | null;
  endTime: string | null;
  updatedAt: string | null;
  exercises: StrictExerciseIntent[];
  issues: StrictIntentIssue[];
  /** Sets that become ACTIVE sets on Garmin, in order. */
  activeSetCount: number;
}

export interface StrictIntentOptions {
  customMappings?: CustomMappings;
  /**
   * Warm-up sets are written as ACTIVE sets by default: Garmin's set model has
   * no warm-up flag, and the watch records warm-ups as sets too, so keeping
   * them is what lets the watch's own timing be preserved. Set false to leave
   * them out; that is recorded as a warning, never silent.
   */
  includeWarmups?: boolean;
}

const EXPLICIT_INSTANT = /(?:Z|[+-]\d{2}:\d{2})$/i;

function nullableNumber(v: unknown): number | null | "invalid" {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return "invalid";
}

/** Build and validate the intent. Pure: no IO, no clock. */
export function buildStrictIntent(
  workout: Record<string, unknown>,
  options: StrictIntentOptions = {},
): StrictIntent {
  const includeWarmups = options.includeWarmups ?? true;
  const issues: StrictIntentIssue[] = [];
  const hevyId = String(workout.id ?? "");
  const startTime = typeof workout.start_time === "string" ? workout.start_time : null;
  const endTime = typeof workout.end_time === "string" ? workout.end_time : null;
  const title = typeof workout.title === "string" && workout.title.trim() ? workout.title.trim() : "Workout";

  if (!hevyId) issues.push({ code: "missing_id", severity: "block", message: "Hevy workout has no id" });
  if (!startTime || !endTime || !EXPLICIT_INSTANT.test(startTime) || !EXPLICIT_INSTANT.test(endTime)) {
    issues.push({
      code: "invalid_interval",
      severity: "block",
      message: "Hevy start and end must be explicit UTC instants; no timezone is guessed",
    });
  } else if (!(Date.parse(endTime) > Date.parse(startTime))) {
    issues.push({ code: "invalid_interval", severity: "block", message: "Hevy end is not after its start" });
  }

  const rawExercises = Array.isArray(workout.exercises) ? (workout.exercises as Array<Record<string, unknown>>) : [];
  const exercises: StrictExerciseIntent[] = [];
  let activeSetCount = 0;
  let totalSets = 0;

  rawExercises.forEach((ex, exIdx) => {
    const exTitle = String(ex?.title ?? ex?.name ?? "").trim();
    const templateId = typeof ex?.exercise_template_id === "string" ? ex.exercise_template_id : null;
    const mapped = lookupExercise(exTitle || "Unknown", templateId, options.customMappings);
    let categoryName = categoryToString(mapped.category);
    if (!exTitle) {
      issues.push({ code: "exercise_without_title", severity: "block", message: `exercise ${exIdx + 1} has no title`, exerciseIndex: exIdx });
    }
    if (mapped.source === "unmapped" || mapped.category === UNKNOWN_CATEGORY) {
      issues.push({
        code: "unmapped_exercise",
        severity: "block",
        message: `"${exTitle}" has no Garmin mapping; add one on the Mappings page (strict mode never guesses)`,
        exerciseIndex: exIdx,
      });
    } else if (!Number.isSafeInteger(mapped.category) || !Number.isSafeInteger(mapped.subcategory) || categoryName === "UNKNOWN") {
      issues.push({
        code: "invalid_mapping",
        severity: "block",
        message: `"${exTitle}" maps to an unknown Garmin category ${mapped.category}/${mapped.subcategory}`,
        exerciseIndex: exIdx,
      });
      categoryName = "UNKNOWN";
    }
    const subName = categoryName === "UNKNOWN" ? null : fitExerciseStrings(mapped.category, mapped.subcategory)[1];
    if (categoryName !== "UNKNOWN" && subName == null) {
      issues.push({
        code: "generic_exercise_name",
        severity: "warn",
        message: `"${exTitle}" is written under ${categoryName} without a specific exercise name`,
        exerciseIndex: exIdx,
      });
    }

    const rawSets = Array.isArray(ex?.sets) ? (ex.sets as Array<Record<string, unknown>>) : [];
    const sets: StrictSetIntent[] = [];
    rawSets.forEach((s, sIdx) => {
      totalSets += 1;
      const at = { exerciseIndex: exIdx, setIndex: sIdx };
      const type = String(s?.type ?? "normal");
      if (!SET_TYPES.has(type)) {
        issues.push({ code: "unknown_set_type", severity: "block", message: `set type "${type}" is not known`, ...at });
      }
      const reps = nullableNumber(s?.reps);
      const weight = nullableNumber(s?.weight_kg);
      const duration = nullableNumber(s?.duration_seconds);
      const distance = nullableNumber(s?.distance_meters);
      if (reps === "invalid" || (reps !== null && (!Number.isInteger(reps) || reps < 0 || reps > STRICT_LIMITS.maxReps))) {
        issues.push({ code: "invalid_reps", severity: "block", message: `reps ${String(s?.reps)} is not a whole number 0..${STRICT_LIMITS.maxReps}`, ...at });
      }
      if (weight === "invalid" || (weight !== null && (weight < 0 || weight > STRICT_LIMITS.maxWeightKg))) {
        issues.push({ code: "invalid_weight", severity: "block", message: `weight ${String(s?.weight_kg)} kg is outside 0..${STRICT_LIMITS.maxWeightKg}`, ...at });
      }
      if (duration === "invalid" || (duration !== null && (duration < 0 || duration > STRICT_LIMITS.maxDurationS))) {
        issues.push({ code: "invalid_duration", severity: "block", message: `duration ${String(s?.duration_seconds)} s is invalid`, ...at });
      }
      if (distance === "invalid" || (distance !== null && (distance < 0 || distance > STRICT_LIMITS.maxDistanceM))) {
        issues.push({ code: "invalid_distance", severity: "block", message: `distance ${String(s?.distance_meters)} m is invalid`, ...at });
      }
      const clean: StrictSetIntent = {
        index: sIdx,
        type: (SET_TYPES.has(type) ? type : "normal") as HevySetType,
        reps: typeof reps === "number" ? reps : null,
        weightKg: typeof weight === "number" ? weight : null,
        durationS: typeof duration === "number" ? duration : null,
        distanceM: typeof distance === "number" ? distance : null,
      };
      if (clean.distanceM != null && clean.distanceM > 0) {
        issues.push({
          code: "distance_not_representable",
          severity: "warn",
          message: "Garmin strength sets have no distance; it is kept in the journal and description only",
          ...at,
        });
      }
      if (clean.reps == null && clean.weightKg == null && clean.durationS == null && clean.distanceM == null) {
        issues.push({ code: "empty_set", severity: "warn", message: "set has no reps, weight, duration or distance", ...at });
      }
      if (clean.type === "warmup" && !includeWarmups) {
        issues.push({ code: "warmup_excluded", severity: "warn", message: "warm-up set left out by setting", ...at });
        return;
      }
      sets.push(clean);
      activeSetCount += 1;
    });

    exercises.push({
      index: exIdx,
      title: exTitle,
      templateId,
      category: mapped.category,
      categoryName,
      subcategory: mapped.subcategory,
      subName,
      mappingSource: mapped.source,
      supersetId: Number.isSafeInteger(ex?.superset_id) ? Number(ex.superset_id) : null,
      sets,
    });
  });

  if (!exercises.length || activeSetCount === 0) {
    issues.push({ code: "no_sets", severity: "block", message: "workout has no sets to write" });
  }
  if (totalSets > STRICT_LIMITS.maxSets) {
    issues.push({ code: "too_many_sets", severity: "block", message: `more than ${STRICT_LIMITS.maxSets} sets` });
  }

  return {
    hevyId,
    title,
    startTime,
    endTime,
    updatedAt: typeof workout.updated_at === "string" ? workout.updated_at : null,
    exercises,
    issues,
    activeSetCount,
  };
}

export function blockingIssues(intent: StrictIntent): StrictIntentIssue[] {
  return intent.issues.filter((i) => i.severity === "block");
}
