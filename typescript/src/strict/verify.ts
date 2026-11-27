/**
 * Read-back verification for strict writes (contract item 3): every required
 * field of every ACTIVE set, the activity id, and the native metrics that a
 * set edit must never change.
 *
 * The comparison is exact by design. Two tolerances exist, both named:
 *  - weight may differ by at most 1 g (Garmin stores grams as a float);
 *  - a REST set's contents are not compared, only that the ACTIVE sequence is.
 * A null reps/weight never equals 0: if Garmin normalises one into the other,
 * verification fails, the write is reported for review and the verified
 * backup stays available for a controlled restore. That is the fail-closed
 * answer until the owner-acceptance test proves Garmin's behaviour.
 */
import { createHash } from "node:crypto";

/** Stable JSON: object keys sorted at every depth, so equal data hashes equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortDeep(v);
    }
    return out;
  }
  return value;
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export interface CanonicalActiveSet {
  category: string | null;
  name: string | null;
  reps: number | null;
  weightG: number | null;
}

function nullableNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The ACTIVE sets of a payload or a read-back, in their stored order. */
export function canonicalActiveSets(sets: unknown): CanonicalActiveSet[] {
  const list = Array.isArray((sets as { exerciseSets?: unknown })?.exerciseSets)
    ? ((sets as { exerciseSets: unknown[] }).exerciseSets as Array<Record<string, unknown>>)
    : [];
  return list
    .filter((s) => s?.setType === "ACTIVE")
    .map((s) => {
      const ex = Array.isArray(s.exercises) ? (s.exercises[0] as Record<string, unknown> | undefined) : undefined;
      return {
        category: typeof ex?.category === "string" ? ex.category : null,
        name: typeof ex?.name === "string" ? ex.name : null,
        reps: nullableNum(s.repetitionCount),
        weightG: nullableNum(s.weight),
      };
    });
}

export interface SetMismatch {
  index: number | null;
  field:
    | "count"
    | "category"
    | "name"
    | "reps"
    | "weight"
    | "activityId"
    | "setType"
    | "startTime"
    | "duration"
    | "wktStepIndex"
    | "exercises"
    | "probability";
  expected: unknown;
  actual: unknown;
}

/** Every difference between what was meant and what Garmin holds. Empty = verified. */
export function compareActiveSets(intended: unknown, readback: unknown): SetMismatch[] {
  const a = canonicalActiveSets(intended);
  const b = canonicalActiveSets(readback);
  const out: SetMismatch[] = [];
  if (a.length !== b.length) out.push({ index: null, field: "count", expected: a.length, actual: b.length });
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i].category !== b[i].category) out.push({ index: i, field: "category", expected: a[i].category, actual: b[i].category });
    if (a[i].name !== b[i].name) out.push({ index: i, field: "name", expected: a[i].name, actual: b[i].name });
    if (a[i].reps !== b[i].reps) out.push({ index: i, field: "reps", expected: a[i].reps, actual: b[i].reps });
    const wa = a[i].weightG;
    const wb = b[i].weightG;
    if ((wa === null) !== (wb === null) || (wa !== null && wb !== null && Math.abs(wa - wb) > 1)) {
      out.push({ index: i, field: "weight", expected: wa, actual: wb });
    }
  }
  return out;
}

/**
 * The native metrics a set edit must leave exactly as they were. A path that
 * is absent BEFORE the write is not compared (Garmin omits fields it does not
 * have); one that was present must be present and equal afterwards.
 */
export const PRESERVED_METRIC_PATHS: readonly string[] = [
  "activityId",
  "activityTypeDTO.typeKey",
  "metadataDTO.manufacturer",
  "metadataDTO.deviceMetaDataDTO.deviceId",
  "metadataDTO.deviceMetaDataDTO.deviceTypePk",
  "summaryDTO.startTimeGMT",
  "summaryDTO.startTimeLocal",
  "summaryDTO.duration",
  "summaryDTO.elapsedDuration",
  "summaryDTO.movingDuration",
  "summaryDTO.averageHR",
  "summaryDTO.maxHR",
  "summaryDTO.minHR",
  "summaryDTO.calories",
  "summaryDTO.bmrCalories",
  "summaryDTO.trainingEffect",
  "summaryDTO.anaerobicTrainingEffect",
  "summaryDTO.activityTrainingLoad",
  "summaryDTO.differenceBodyBattery",
];

function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function extractPreservedMetrics(detail: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of PRESERVED_METRIC_PATHS) {
    const v = pick(detail, p);
    if (v !== undefined && v !== null) out[p] = v;
  }
  return out;
}

export interface MetricMismatch {
  path: string;
  before: unknown;
  after: unknown;
}

export function comparePreservedMetrics(before: Record<string, unknown>, afterDetail: unknown): MetricMismatch[] {
  const after = extractPreservedMetrics(afterDetail);
  const out: MetricMismatch[] = [];
  for (const [path, value] of Object.entries(before)) {
    if (canonicalJson(after[path]) !== canonicalJson(value)) out.push({ path, before: value, after: after[path] });
  }
  return out;
}

export function activityNameOf(detail: unknown): string | null {
  const v = pick(detail, "activityName");
  return typeof v === "string" ? v : null;
}

export function descriptionOf(detail: unknown): string | null {
  const v = pick(detail, "description");
  return typeof v === "string" ? v : null;
}

/**
 * Named tolerances for the full sequence comparison. Garmin stores set times
 * and durations as floating point; anything beyond these is a real change.
 */
export const TIMING_TOLERANCE = Object.freeze({ durationS: 0.5, startMs: 1000 });

const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;

/** Garmin set times carry no zone ("2026-03-10T17:00:00.0") and are UTC. */
function instantMs(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const iso = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(v) ? v : `${v.replace(" ", "T")}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function listOf(x: unknown): Array<Record<string, unknown>> | null {
  const sets = (x as { exerciseSets?: unknown } | null)?.exerciseSets;
  return Array.isArray(sets) ? (sets as Array<Record<string, unknown>>) : null;
}

/**
 * Compare a required value. `intended` undefined: not part of this write, not
 * compared. `intended` null: the read-back must hold no value (null or absent).
 * Any other value: the read-back MUST have it, and equal (within `tol`).
 */
function compareValue(
  out: SetMismatch[],
  index: number,
  field: SetMismatch["field"],
  intended: unknown,
  actualObj: Record<string, unknown>,
  key: string,
  eq: (a: unknown, b: unknown) => boolean = (a, b) => a === b,
): void {
  if (intended === undefined) return;
  const present = has(actualObj, key);
  const actual = present ? actualObj[key] : undefined;
  if (intended === null) {
    if (present && actual !== null) out.push({ index, field, expected: null, actual });
    return;
  }
  if (!present || actual === null || !eq(intended, actual)) out.push({ index, field, expected: intended, actual: present ? actual : "(missing)" });
}

const numEq = (tol: number) => (a: unknown, b: unknown) => {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= tol;
};

/**
 * Every set, ACTIVE and REST, in order: set type, start time and duration for
 * all of them; for ACTIVE sets also the step index, reps, weight and EVERY
 * exercise entry (category, name, probability). A value the intended state
 * has that the read-back lacks is a mismatch, never a pass. With
 * `activityId`, the read-back must name that activity.
 */
export function compareSetSequences(intended: unknown, readback: unknown, opts: { activityId?: number } = {}): SetMismatch[] {
  const out: SetMismatch[] = [];
  if (opts.activityId !== undefined) {
    const got = (readback as { activityId?: unknown } | null)?.activityId;
    if (Number(got) !== opts.activityId) out.push({ index: null, field: "activityId", expected: opts.activityId, actual: got ?? "(missing)" });
  }
  const a = listOf(intended);
  const b = listOf(readback);
  if (!a) return [...out, { index: null, field: "count", expected: "a set list", actual: "(intended has none)" }];
  if (!b) return [...out, { index: null, field: "count", expected: a.length, actual: "(missing)" }];
  if (a.length !== b.length) out.push({ index: null, field: "count", expected: a.length, actual: b.length });
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] ?? {};
    const y = b[i] ?? {};
    compareValue(out, i, "setType", x.setType ?? null, y, "setType");
    compareValue(out, i, "startTime", x.startTime, y, "startTime", (p, q) => {
      const s = instantMs(p);
      const t = instantMs(q);
      return s !== null && t !== null && Math.abs(s - t) <= TIMING_TOLERANCE.startMs;
    });
    compareValue(out, i, "duration", x.duration, y, "duration", numEq(TIMING_TOLERANCE.durationS));
    if (x.setType !== "ACTIVE") continue;
    compareValue(out, i, "wktStepIndex", x.wktStepIndex, y, "wktStepIndex", numEq(0));
    compareValue(out, i, "reps", x.repetitionCount, y, "repetitionCount", numEq(0));
    compareValue(out, i, "weight", x.weight, y, "weight", numEq(1));
    const ex = Array.isArray(x.exercises) ? (x.exercises as Array<Record<string, unknown>>) : null;
    const ey = Array.isArray(y.exercises) ? (y.exercises as Array<Record<string, unknown>>) : null;
    if (ex === null) continue;
    if (ey === null || ex.length !== ey.length) {
      out.push({ index: i, field: "exercises", expected: ex.length, actual: ey === null ? "(missing)" : ey.length });
      continue;
    }
    for (let j = 0; j < ex.length; j++) {
      compareValue(out, i, "category", ex[j]?.category ?? null, ey[j] ?? {}, "category");
      compareValue(out, i, "name", ex[j]?.name ?? null, ey[j] ?? {}, "name");
      compareValue(out, i, "probability", ex[j]?.probability, ey[j] ?? {}, "probability", numEq(0));
    }
  }
  return out;
}

/** Metrics an activity must expose before strict mode writes to it, and keep afterwards. */
export const REQUIRED_PRESERVED_METRICS: readonly string[] = [
  "activityId",
  "activityTypeDTO.typeKey",
  "metadataDTO.manufacturer",
  "summaryDTO.startTimeGMT",
  "summaryDTO.duration",
];

export function missingRequiredMetrics(detail: unknown): string[] {
  const have = extractPreservedMetrics(detail);
  return REQUIRED_PRESERVED_METRICS.filter((p) => !(p in have));
}
