/**
 * Read-only audit of historical duplicates (contract item 6).
 *
 * Earlier syncs (legacy uploads, replace races, retries) can have left a
 * workout on Garmin twice. This finds those cases and every ledger
 * inconsistency around them, with exact ids and the evidence for each, and
 * removes nothing. Cleanup is a separate, explicitly approved step per exact
 * activity id with its own backup; the report hash lets that approval refer to
 * precisely this report.
 *
 * Pure: the caller gathers Hevy workouts, Garmin activities, the legacy ledger
 * and the strict bindings with reads only, and passes them in.
 */
import { toUtcDate } from "../match";
import type { StrictBinding } from "./ledger";
import { sha256Canonical } from "./verify";

export interface AuditWorkout {
  id: string;
  title?: string | null;
  start_time?: string | null;
  end_time?: string | null;
}

export interface AuditActivity {
  activityId: number;
  startTimeGMT?: string;
  duration?: number;
  manufacturer?: string;
  activityType?: { typeKey?: string };
  activityName?: string;
}

export interface AuditLedgerRow {
  hevyId: string;
  garminActivityId: string | null;
  syncMethod: string | null;
  status: string | null;
}

export type FindingKind =
  | "native_and_upload"
  | "multiple_uploads"
  | "multiple_native"
  | "ledger_missing_activity"
  | "ledger_shared_activity"
  | "binding_ledger_mismatch"
  | "orphan_upload";

export interface DuplicateFinding {
  kind: FindingKind;
  severity: "duplicate" | "conflict" | "info";
  hevyIds: string[];
  activityIds: number[];
  evidence: string;
  recommendation: string;
}

export interface CleanupCandidate {
  /** The activity a later, separately approved cleanup could remove. */
  activityId: number;
  /** The activity that would be kept. */
  keepActivityId: number;
  hevyId: string;
  reason: string;
}

export interface DuplicateAuditReport {
  mode: "read-only";
  deleted: 0;
  generatedAt: string;
  window: { start: string; end: string };
  scanned: { workouts: number; activities: number; ledgerRows: number; bindings: number };
  /** Days whose listing may have been cut off; nothing on them is concluded as missing. */
  truncatedDays: string[];
  findings: DuplicateFinding[];
  cleanupCandidates: CleanupCandidate[];
  summary: Record<FindingKind, number>;
  /** SHA-256 of window + findings + candidates: what a cleanup approval must name. */
  reportSha256: string;
}

const STRENGTHISH = new Set(["strength_training", "other", "indoor_cardio", "fitness_equipment"]);
const isUpload = (a: AuditActivity) => String(a.manufacturer ?? "").toUpperCase() === "DEVELOPMENT";
const isNative = (a: AuditActivity) => {
  const m = String(a.manufacturer ?? "").toUpperCase();
  return m !== "" && m !== "DEVELOPMENT";
};

function interval(a: AuditActivity): [number, number] | null {
  const s = toUtcDate(a.startTimeGMT ?? "");
  const d = Number(a.duration);
  if (!s || !Number.isFinite(d) || d <= 0) return null;
  return [s.getTime(), s.getTime() + d * 1000];
}

function workoutInterval(w: AuditWorkout): [number, number] | null {
  const s = Date.parse(String(w.start_time ?? ""));
  const e = Date.parse(String(w.end_time ?? ""));
  return Number.isFinite(s) && Number.isFinite(e) && e > s ? [s, e] : null;
}

/** Overlap of the two, as a fraction of the SHORTER interval. */
function overlapFraction(a: [number, number], b: [number, number]): number {
  const o = Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
  return o / Math.max(1, Math.min(a[1] - a[0], b[1] - b[0]));
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function auditDuplicates(input: {
  window: { start: string; end: string };
  workouts: AuditWorkout[];
  activities: AuditActivity[];
  ledger: AuditLedgerRow[];
  bindings: Pick<StrictBinding, "hevyId" | "garminActivityId" | "state">[];
  truncatedDays?: string[];
  now?: Date;
  /** Minimum overlap (fraction of the shorter interval) to call two things the same session. */
  minOverlap?: number;
}): DuplicateAuditReport {
  const minOverlap = input.minOverlap ?? 0.5;
  const truncated = new Set(input.truncatedDays ?? []);
  const findings: DuplicateFinding[] = [];
  const cleanup: CleanupCandidate[] = [];
  const activities = input.activities.filter((a) => Number.isSafeInteger(a?.activityId));
  const byId = new Map(activities.map((a) => [a.activityId, a]));
  const ledgerByHevy = new Map(input.ledger.map((r) => [r.hevyId, r]));
  const matchedActivity = new Set<number>();

  for (const w of input.workouts) {
    const wi = workoutInterval(w);
    if (!wi) continue;
    const overlapping = activities.filter((a) => {
      const ai = interval(a);
      return ai != null && overlapFraction(wi, ai) >= minOverlap;
    });
    overlapping.forEach((a) => matchedActivity.add(a.activityId));
    const uploads = overlapping.filter(isUpload);
    const natives = overlapping.filter((a) => isNative(a) && STRENGTHISH.has(a.activityType?.typeKey ?? ""));
    const ledgerId = Number(ledgerByHevy.get(w.id)?.garminActivityId ?? NaN);
    const label = `"${w.title ?? "Untitled"}" (${w.start_time})`;

    if (natives.length && uploads.length) {
      const keep = natives.length === 1 ? natives[0].activityId : null;
      findings.push({
        kind: "native_and_upload",
        severity: "duplicate",
        hevyIds: [w.id],
        activityIds: [...natives, ...uploads].map((a) => a.activityId),
        evidence: `${label}: watch recording ${natives.map((a) => a.activityId).join(", ")} and uploaded copy ${uploads.map((a) => a.activityId).join(", ")} cover the same session`,
        recommendation:
          keep != null
            ? `keep the watch recording ${keep} (heart rate, native metrics); the upload is a cleanup candidate after separate approval and backup`
            : "several watch recordings overlap as well; decide by hand",
      });
      if (keep != null) {
        for (const u of uploads) cleanup.push({ activityId: u.activityId, keepActivityId: keep, hevyId: w.id, reason: "uploaded copy of a session the watch recorded" });
      }
    } else if (uploads.length > 1) {
      const keep = uploads.find((u) => u.activityId === ledgerId)?.activityId ?? null;
      findings.push({
        kind: "multiple_uploads",
        severity: "duplicate",
        hevyIds: [w.id],
        activityIds: uploads.map((a) => a.activityId),
        evidence: `${label}: ${uploads.length} uploaded activities cover the same session`,
        recommendation:
          keep != null
            ? `keep ${keep}, the one the ledger records; the others are cleanup candidates after separate approval`
            : "the ledger names none of them; decide by hand",
      });
      if (keep != null) {
        for (const u of uploads) if (u.activityId !== keep) cleanup.push({ activityId: u.activityId, keepActivityId: keep, hevyId: w.id, reason: "second upload of the same workout" });
      }
    }
    if (natives.length > 1) {
      findings.push({
        kind: "multiple_native",
        severity: "conflict",
        hevyIds: [w.id],
        activityIds: natives.map((a) => a.activityId),
        evidence: `${label}: ${natives.length} watch recordings overlap (watch started twice?)`,
        recommendation: "strict mode will not merge into either until a person decides; nothing to delete automatically",
      });
    }

    const row = ledgerByHevy.get(w.id);
    if (row?.garminActivityId && Number.isFinite(ledgerId) && !byId.has(ledgerId)) {
      const days = [day(wi[0]), day(wi[1])];
      if (!days.some((d) => truncated.has(d))) {
        findings.push({
          kind: "ledger_missing_activity",
          severity: "conflict",
          hevyIds: [w.id],
          activityIds: [ledgerId],
          evidence: `${label}: the ledger records activity ${ledgerId}, which Garmin no longer lists for that day`,
          recommendation: "the activity was deleted or never existed; review the ledger row, do not re-upload automatically",
        });
      }
    }
  }

  const ledgerByActivity = new Map<string, string[]>();
  for (const r of input.ledger) {
    if (!r.garminActivityId) continue;
    ledgerByActivity.set(r.garminActivityId, [...(ledgerByActivity.get(r.garminActivityId) ?? []), r.hevyId]);
  }
  for (const [activity, hevyIds] of ledgerByActivity) {
    if (hevyIds.length > 1) {
      findings.push({
        kind: "ledger_shared_activity",
        severity: "conflict",
        hevyIds: hevyIds.slice().sort(),
        activityIds: [Number(activity)],
        evidence: `${hevyIds.length} workouts are recorded against the same Garmin activity ${activity}`,
        recommendation: "only one workout can own an activity; strict mode keeps both out until resolved",
      });
    }
  }

  for (const b of input.bindings) {
    const row = ledgerByHevy.get(b.hevyId);
    if (row?.garminActivityId && Number(row.garminActivityId) !== b.garminActivityId) {
      findings.push({
        kind: "binding_ledger_mismatch",
        severity: "conflict",
        hevyIds: [b.hevyId],
        activityIds: [b.garminActivityId, Number(row.garminActivityId)],
        evidence: `strict binding names activity ${b.garminActivityId}, the dashboard ledger ${row.garminActivityId}`,
        recommendation: "review both activities before any further write",
      });
    }
  }

  for (const a of activities) {
    if (!isUpload(a) || matchedActivity.has(a.activityId)) continue;
    const ai = interval(a);
    if (!ai) continue;
    findings.push({
      kind: "orphan_upload",
      severity: "info",
      hevyIds: [],
      activityIds: [a.activityId],
      evidence: `uploaded activity ${a.activityId} (${a.activityName ?? "unnamed"}, ${a.startTimeGMT}) matches no Hevy workout in the window`,
      recommendation: "possibly an upload of a workout since deleted in Hevy; informational only",
    });
  }

  const order: Record<DuplicateFinding["severity"], number> = { duplicate: 0, conflict: 1, info: 2 };
  findings.sort((x, y) => order[x.severity] - order[y.severity] || (x.activityIds[0] ?? 0) - (y.activityIds[0] ?? 0));
  cleanup.sort((x, y) => x.activityId - y.activityId);
  const summary = {
    native_and_upload: 0,
    multiple_uploads: 0,
    multiple_native: 0,
    ledger_missing_activity: 0,
    ledger_shared_activity: 0,
    binding_ledger_mismatch: 0,
    orphan_upload: 0,
  } as Record<FindingKind, number>;
  for (const f of findings) summary[f.kind] += 1;

  return {
    mode: "read-only",
    deleted: 0,
    generatedAt: (input.now ?? new Date()).toISOString(),
    window: input.window,
    scanned: {
      workouts: input.workouts.length,
      activities: activities.length,
      ledgerRows: input.ledger.length,
      bindings: input.bindings.length,
    },
    truncatedDays: [...truncated].sort(),
    findings,
    cleanupCandidates: cleanup,
    summary,
    reportSha256: sha256Canonical({ window: input.window, findings, cleanup }),
  };
}

/**
 * The date chunks to list Garmin activities in. Garmin returns at most
 * `limit` per call, so a chunk that comes back full is split into days, and a
 * day that is still full is reported as truncated rather than trusted.
 */
export async function gatherActivities(
  list: (start: string, end: string) => Promise<AuditActivity[]>,
  window: { start: string; end: string },
  limit: number,
  chunkDays = 3,
): Promise<{ activities: AuditActivity[]; truncatedDays: string[] }> {
  const out = new Map<number, AuditActivity>();
  const truncatedDays: string[] = [];
  const startMs = Date.parse(`${window.start}T00:00:00Z`);
  const endMs = Date.parse(`${window.end}T00:00:00Z`);
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  for (let t = startMs; t <= endMs; t += chunkDays * 86_400_000) {
    const s = iso(t);
    const e = iso(Math.min(endMs, t + (chunkDays - 1) * 86_400_000));
    let got = await list(s, e);
    if (got.length >= limit && s !== e) {
      got = [];
      for (let d = Date.parse(`${s}T00:00:00Z`); d <= Date.parse(`${e}T00:00:00Z`); d += 86_400_000) {
        const one = await list(iso(d), iso(d));
        if (one.length >= limit) truncatedDays.push(iso(d));
        got.push(...one);
      }
    } else if (got.length >= limit) {
      truncatedDays.push(s);
    }
    for (const a of got) if (Number.isSafeInteger(a?.activityId)) out.set(a.activityId, a);
  }
  return { activities: [...out.values()], truncatedDays };
}
