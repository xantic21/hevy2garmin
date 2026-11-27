/**
 * Strict in-place merge: the ONLY sync path a strict deployment runs.
 *
 * It writes a Hevy workout's sets into the one original Garmin strength
 * activity the user's watch recorded, and nothing else:
 *   - no FIT upload and no delete can be expressed here (the Garmin port has
 *     neither), and the process firewall refuses them at the network anyway;
 *   - no strategy fallback: anything uncertain ends as `pending`,
 *     `needs_review`, `blocked`, `failed` or `uncertain`, never as an upload;
 *   - dry run is the default and performs zero writes, to Garmin AND to the
 *     database.
 *
 * Live write sequence, each step durable before the next:
 *   claim exclusive binding (both ids, atomic, leased)
 *   → snapshot activity (sets, name, description, native metrics)
 *   → persist `original` (first ever) + `pre_write` backups, read both back,
 *     verify their SHA-256
 *   → journal `intent` → `put_sent` (compare-and-set, before the request)
 *   → ONE PUT inside a capability scope for this activity id
 *   → read back sets and activity; verify every ACTIVE set field and every
 *     preserved native metric
 *   → `verified`, or `not_applied` (Garmin still holds the backup), or
 *     `needs_review` + global freeze. Never a blind retry.
 */
import { randomUUID } from "node:crypto";
import type { GarminClient } from "garmin-auth";
import { getActivitiesByDate, getActivityDetail, getActivityExerciseSets, pushExerciseSets, updateActivityMetadata } from "../garmin";
import type { CandidateActivity } from "../merge-match";
import { createRateLimiter, type RateLimitOptions } from "../rate-limit";
import type { SetTiming } from "../exercise-sets";
import type { CustomMappings } from "../mapper";
import { selectStrictMergeMatch } from "../strict-merge-policy";
import type { SyncStore } from "../sync/store";
import type { DedupWorkout } from "../sync/types";
import { mergeDescription, strictDescriptionBlock } from "./description";
import { isStrictModeViolation, strictHardStopActive, withGarminWriteCapability, type GarminWriteKind } from "./firewall";
import { blockingIssues, buildStrictIntent, type StrictIntentIssue } from "./intent";
import { BLOCKING_PHASES, isJournalConflict, type JournalPhase, type JournalStep, type LockPurpose, type StrictLedger } from "./ledger";
import { encodeStrictPayload, type StrictSetsPayload } from "./payload";
import {
  activityNameOf,
  compareSetSequences,
  comparePreservedMetrics,
  descriptionOf,
  extractPreservedMetrics,
  missingRequiredMetrics,
  sha256Canonical,
  type MetricMismatch,
  type SetMismatch,
} from "./verify";

/**
 * The Garmin date range to list. Garmin filters by each activity's LOCAL date,
 * so a UTC range can miss an evening session west of UTC (or a morning one far
 * east). One day either side of the UTC dates covers every timezone (UTC−12 to
 * UTC+14); the matcher then decides by real instants.
 */
export function strictSearchRange(workout: { start_time?: unknown; end_time?: unknown }): { start: string; end: string } | null {
  const s = Date.parse(String(workout.start_time ?? ""));
  const e = Date.parse(String(workout.end_time ?? ""));
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return null;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { start: day(s - 86_400_000), end: day(e + 86_400_000) };
}

/** The Garmin surface strict mode can reach. There is no upload and no delete. */
export interface StrictGarminPort {
  activitiesByDate(startDate: string, endDate: string): Promise<CandidateActivity[]>;
  activityDetail(activityId: number): Promise<Record<string, unknown> | null>;
  exerciseSets(activityId: number): Promise<Record<string, unknown>>;
  putExerciseSets(activityId: number, payload: StrictSetsPayload): Promise<void>;
  updateActivityMetadata(activityId: number, fields: { activityName?: string; description?: string }): Promise<void>;
}

/** The listing size the default port asks for; a full page is treated as possibly truncated. */
export const STRICT_LISTING_LIMIT = 50;

export function strictGarminPort(client: GarminClient, options: RateLimitOptions = {}): StrictGarminPort {
  const limit = createRateLimiter(options);
  // Writes are paced but never resent: a 429 or a timeout on a PUT is an
  // uncertain outcome that only read-back may decide, never a blind retry.
  const limitWrite = createRateLimiter({ ...options, maxAttempts: 1 });
  return Object.freeze({
    activitiesByDate: async (s: string, e: string) =>
      (await limit(() => getActivitiesByDate(client, s, e, STRICT_LISTING_LIMIT))) as unknown as CandidateActivity[],
    activityDetail: (id: number) => limit(() => getActivityDetail(client, id)),
    exerciseSets: (id: number) => limit(() => getActivityExerciseSets(client, id)),
    putExerciseSets: (id: number, payload: StrictSetsPayload) => limitWrite(() => pushExerciseSets(client, id, payload)),
    updateActivityMetadata: (id: number, fields: { activityName?: string; description?: string }) =>
      limitWrite(() => updateActivityMetadata(client, id, fields)),
  });
}

export type StrictTrigger = "manual" | "batch" | "cron" | "webhook";

export interface StrictSyncDeps {
  ledger: StrictLedger;
  /** The dashboard's ledger: read to keep legacy rows out, written once a merge is verified. */
  legacy: Pick<SyncStore, "loadSyncedIds" | "loadPendingIds" | "markSynced">;
  garmin: () => Promise<StrictGarminPort>;
  fetchWorkouts: () => Promise<DedupWorkout[]>;
  owner?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface StrictSyncOptions {
  /** DEFAULT true: zero writes to Garmin and to the database. */
  dryRun?: boolean;
  trigger?: StrictTrigger;
  /** The owner gate for cron/webhook. DEFAULT false: automatic paths do nothing. */
  automaticEnabled?: boolean;
  targetHevyId?: string;
  /** Hevy ids to skip when picking the next candidate (a batch passes the ones it tried). */
  excludeHevyIds?: Iterable<string>;
  /** Re-write an already verified binding (same workout, same activity). Explicit only. */
  resync?: boolean;
  customMappings?: CustomMappings;
  timing?: Partial<SetTiming>;
  includeWarmups?: boolean;
  /** Name and description updates, each separately journaled and verified. DEFAULT both on. */
  metadata?: { rename?: boolean; description?: boolean };
  verifyDelayMs?: number;
  leaseMs?: number;
}

export type StrictStatus =
  | "dry_run"
  | "synced"
  | "already_synced"
  | "none"
  | "pending"
  | "needs_review"
  | "blocked"
  | "failed"
  | "uncertain";

export interface StrictPlan {
  activityId: number;
  activityName: string | null;
  timingSource: "native" | "synthesized";
  activeSets: number;
  setsAlreadyApplied: boolean;
  rename: string | null;
  descriptionChange: boolean;
  intendedSha256: string;
}

export interface StrictSyncResult {
  status: StrictStatus;
  reason: string | null;
  trigger: StrictTrigger;
  dryRun: boolean;
  hevyId: string | null;
  title: string | null;
  activityId: number | null;
  journalIds: string[];
  /** Garmin write requests actually sent by this call. */
  writes: number;
  plan: StrictPlan | null;
  issues: StrictIntentIssue[];
  mismatches?: { sets: SetMismatch[]; metrics: MetricMismatch[]; metadata: string[] };
}

export const STRICT_VERIFY_DELAY_MS = 4000;
export const DEFAULT_LEASE_MS = 10 * 60 * 1000;
const AUTOMATIC: ReadonlySet<StrictTrigger> = new Set(["cron", "webhook"]);

function result(base: Partial<StrictSyncResult> & Pick<StrictSyncResult, "status" | "trigger" | "dryRun">): StrictSyncResult {
  return {
    reason: null,
    hevyId: null,
    title: null,
    activityId: null,
    journalIds: [],
    writes: 0,
    plan: null,
    issues: [],
    ...base,
  };
}

/** Whether strict writes are currently allowed. Read-only. */
export async function strictWriteBlock(ledger: StrictLedger): Promise<{ blocked: boolean; reason: string | null }> {
  const control = await ledger.getControl();
  if (control.frozen) return { blocked: true, reason: `strict writes are frozen: ${control.reason ?? "no reason recorded"}` };
  const open = await ledger.listOpenJournal();
  const blocking = open.find((e) => BLOCKING_PHASES.has(e.phase));
  if (blocking) {
    return {
      blocked: true,
      reason: `journal ${blocking.id} (${blocking.phase}) on activity ${blocking.garminActivityId} must be reconciled first`,
    };
  }
  return { blocked: false, reason: null };
}

/** Close `intent` entries whose owner can no longer be sending: nothing was sent for them. */
async function abortStaleIntents(ledger: StrictLedger, now: Date, leaseMs: number): Promise<void> {
  for (const e of await ledger.listOpenJournal()) {
    if (e.phase === "intent" && now.getTime() - Date.parse(e.createdAt) > leaseMs) {
      await ledger.advanceJournal(e.id, ["intent"], "aborted", { abortedReason: "stale intent; no request was sent" });
    }
  }
}

const isFinished = (w: DedupWorkout, now: Date) => {
  const end = Date.parse(String(w.end_time ?? ""));
  return Number.isFinite(end) && end <= now.getTime();
};

/** Read-only: the workouts strict mode would consider, newest first. */
export async function listStrictCandidates(
  deps: Pick<StrictSyncDeps, "ledger" | "legacy" | "fetchWorkouts" | "now">,
): Promise<Array<{ hevyId: string; title: string | null; startTime: string | null }>> {
  const now = (deps.now ?? (() => new Date()))();
  const [workouts, synced, pending, bindings] = await Promise.all([
    deps.fetchWorkouts(),
    deps.legacy.loadSyncedIds(),
    deps.legacy.loadPendingIds(),
    deps.ledger.listBindings(),
  ]);
  const bound = new Set(bindings.map((b) => b.hevyId));
  return workouts
    .filter((w) => !bound.has(String(w.id)) && !synced.has(String(w.id)) && !pending.has(String(w.id)) && isFinished(w, now))
    .map((w) => ({ hevyId: String(w.id), title: (w.title as string | null) ?? null, startTime: (w.start_time as string | null) ?? null }));
}

export async function strictInPlaceSync(deps: StrictSyncDeps, options: StrictSyncOptions = {}): Promise<StrictSyncResult> {
  const dryRun = options.dryRun ?? true;
  const trigger: StrictTrigger = options.trigger ?? "manual";
  const clock = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const owner = deps.owner ?? `strict-${randomUUID()}`;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const verifyDelayMs = options.verifyDelayMs ?? STRICT_VERIFY_DELAY_MS;
  const rename = options.metadata?.rename ?? true;
  const describe = options.metadata?.description ?? true;
  const { ledger, legacy } = deps;
  const base = { trigger, dryRun };

  // 0. Gates that need no IO at all.
  if (AUTOMATIC.has(trigger) && !options.automaticEnabled) {
    return result({ ...base, status: "blocked", reason: "automatic strict sync is off until the owner activates it" });
  }
  if (options.resync && !options.targetHevyId) {
    return result({ ...base, status: "blocked", reason: "a resync needs an explicit workout id" });
  }

  // 1. The stop switch and any unreconciled write. Read-only, so a dry run
  //    reports it too; a live run stops here.
  const block = await strictWriteBlock(ledger);
  if (block.blocked && !dryRun) return result({ ...base, status: "blocked", reason: block.reason });

  // 2. Pick the workout.
  const now = clock();
  const [workouts, syncedIds, pendingIds, bindings] = await Promise.all([
    deps.fetchWorkouts(),
    legacy.loadSyncedIds(),
    legacy.loadPendingIds(),
    ledger.listBindings(),
  ]);
  const excluded = new Set([...(options.excludeHevyIds ?? [])].map(String));
  const bindingOf = (id: string) => bindings.find((b) => b.hevyId === id) ?? null;
  let workout: DedupWorkout | undefined;
  if (options.targetHevyId) {
    const id = options.targetHevyId;
    workout = workouts.find((w) => String(w.id) === id);
    if (!workout) return result({ ...base, status: "none", hevyId: id, reason: "Hevy does not list this workout" });
    if (pendingIds.has(id)) {
      return result({
        ...base,
        status: "blocked",
        hevyId: id,
        reason: "a legacy pending upload exists for this workout; it is quarantined and never replayed",
      });
    }
    const binding = bindingOf(id);
    if (binding?.state === "needs_review") {
      return result({ ...base, status: "needs_review", hevyId: id, activityId: binding.garminActivityId, reason: binding.lastError ?? "binding needs review" });
    }
    if (binding?.state === "verified" && !options.resync) {
      return result({ ...base, status: "already_synced", hevyId: id, activityId: binding.garminActivityId });
    }
    if (!binding && syncedIds.has(id)) {
      return result({
        ...base,
        status: "needs_review",
        hevyId: id,
        reason: "this workout was synced before strict mode (legacy ledger); strict mode does not rewrite it automatically",
      });
    }
  } else {
    workout = workouts.find((w) => {
      const id = String(w.id);
      return !excluded.has(id) && !bindingOf(id) && !syncedIds.has(id) && !pendingIds.has(id) && isFinished(w, now);
    });
    if (!workout) return result({ ...base, status: "none", reason: "no unsynced finished workout" });
  }
  const hevyId = String(workout.id);
  const idBase = { ...base, hevyId, title: (workout.title as string | null) ?? null };

  // 3. Validate the intent: mapping, units, set types, timing. No Garmin IO yet.
  const intent = buildStrictIntent(workout as Record<string, unknown>, {
    customMappings: options.customMappings,
    includeWarmups: options.includeWarmups,
  });
  const blocking = blockingIssues(intent);
  if (blocking.length) {
    return result({ ...idBase, status: "needs_review", reason: blocking.map((i) => i.message).join("; "), issues: intent.issues });
  }
  if (!isFinished(workout, now)) {
    return result({ ...idBase, status: "pending", reason: "the Hevy workout has not finished yet", issues: intent.issues });
  }

  // 4. Find the one original activity. Any read failure defers.
  const garmin = await deps.garmin();
  const range = strictSearchRange(workout);
  if (!range) return result({ ...idBase, status: "needs_review", reason: "workout has no usable interval", issues: intent.issues });
  let listing: CandidateActivity[];
  try {
    listing = await garmin.activitiesByDate(range.start, range.end);
  } catch (e) {
    return result({ ...idBase, status: "pending", reason: `Garmin listing unavailable: ${(e as Error).message}`, issues: intent.issues });
  }
  if (!Array.isArray(listing)) {
    return result({ ...idBase, status: "needs_review", reason: "Garmin returned an unreadable activity listing", issues: intent.issues });
  }
  if (listing.length >= STRICT_LISTING_LIMIT) {
    return result({ ...idBase, status: "needs_review", reason: "Garmin listing may be truncated; refusing to decide", issues: intent.issues });
  }
  const decision = selectStrictMergeMatch(workout, listing, now);
  if (decision.status !== "matched") {
    return result({ ...idBase, status: decision.status === "pending" ? "pending" : "needs_review", reason: decision.reason, issues: intent.issues });
  }
  const activity = decision.match.activity;
  const activityId = activity.activityId;
  const actBase = { ...idBase, activityId, issues: intent.issues };

  // The reverse question: does another Hevy workout claim the same session?
  const startMs = Date.parse(String(workout.start_time));
  for (const other of workouts) {
    if (String(other.id) === hevyId) continue;
    const otherStart = Date.parse(String(other.start_time ?? ""));
    if (!Number.isFinite(otherStart) || Math.abs(otherStart - startMs) > 36 * 3600 * 1000) continue;
    if (selectStrictMergeMatch(other, [activity], now).status === "matched") {
      return result({ ...actBase, status: "needs_review", reason: `Hevy workout ${String(other.id)} matches the same Garmin activity` });
    }
  }
  const actBinding = bindings.find((b) => b.garminActivityId === activityId);
  if (actBinding && actBinding.hevyId !== hevyId) {
    return result({ ...actBase, status: "needs_review", reason: `activity is already bound to Hevy workout ${actBinding.hevyId}` });
  }
  const ownBinding = bindingOf(hevyId);
  if (ownBinding && ownBinding.garminActivityId !== activityId) {
    return result({ ...actBase, status: "needs_review", reason: `workout is already bound to activity ${ownBinding.garminActivityId}` });
  }

  // 5. Read the activity as it is now, and plan the exact bytes.
  let detail: Record<string, unknown> | null;
  let originalSets: Record<string, unknown>;
  try {
    detail = await garmin.activityDetail(activityId);
    originalSets = await garmin.exerciseSets(activityId);
  } catch (e) {
    return result({ ...actBase, status: "pending", reason: `Garmin activity unreadable: ${(e as Error).message}` });
  }
  if (!detail) return result({ ...actBase, status: "pending", reason: "the activity is no longer on Garmin" });
  const detailType = (detail.activityTypeDTO as { typeKey?: string } | undefined)?.typeKey;
  const detailMaker = String((detail.metadataDTO as { manufacturer?: string } | undefined)?.manufacturer ?? "").toUpperCase();
  const detailChecked: Record<string, unknown> = detail;
  const missing = missingRequiredMetrics(detail);
  if (missing.length) {
    return result({ ...actBase, status: "needs_review", reason: `activity detail lacks required values (${missing.join(", ")}); nothing to verify against` });
  }
  if (Number(detail.activityId) !== activityId || detailType !== "strength_training" || detailMaker !== "GARMIN") {
    return result({ ...actBase, status: "needs_review", reason: "activity detail does not confirm a native Garmin strength activity" });
  }
  if (!originalSets || typeof originalSets !== "object") {
    return result({ ...actBase, status: "needs_review", reason: "existing exercise sets are unreadable" });
  }

  let encoded;
  try {
    encoded = encodeStrictPayload(
      intent,
      { activityId, startTimeGMT: String(activity.startTimeGMT), durationS: Number(activity.duration) },
      originalSets,
      options.timing,
    );
  } catch (e) {
    return result({ ...actBase, status: "needs_review", reason: `could not lay the sets out: ${(e as Error).message}` });
  }
  const payload = encoded.payload;
  const intendedSha256 = sha256Canonical(payload);
  const setsAlreadyApplied = compareSetSequences(payload, originalSets, { activityId }).length === 0;
  const currentName = activityNameOf(detail);
  const currentDescription = descriptionOf(detail);
  const newName = rename && intent.title !== currentName ? intent.title : null;
  const mergedDescription = describe ? mergeDescription(currentDescription, strictDescriptionBlock(intent)) : null;
  const issues = [...intent.issues];
  if (describe && mergedDescription === null) {
    issues.push({ code: "description_too_long", severity: "warn", message: "description left unchanged: it would exceed Garmin's length limit" });
  }
  const newDescription = mergedDescription !== null && mergedDescription !== currentDescription ? mergedDescription : null;
  const plan: StrictPlan = {
    activityId,
    activityName: currentName,
    timingSource: encoded.timingSource,
    activeSets: intent.activeSetCount,
    setsAlreadyApplied,
    rename: newName,
    descriptionChange: newDescription !== null,
    intendedSha256,
  };

  if (dryRun) {
    return result({ ...actBase, issues, status: "dry_run", plan, reason: block.blocked ? block.reason : null });
  }

  // ---- LIVE ----
  if (strictHardStopActive()) {
    return result({ ...actBase, issues, plan, status: "blocked", reason: "H2G_STRICT_STOP is set: every Garmin write is refused" });
  }
  await abortStaleIntents(ledger, now, leaseMs);
  const claim = await ledger.claimBinding({ hevyId, activityId, owner, now: clock(), leaseMs });
  if (!claim.ok) {
    return result({
      ...actBase,
      issues,
      plan,
      status: claim.reason === "lease_held" ? "blocked" : "needs_review",
      reason: `binding refused: ${claim.reason}`,
    });
  }
  // The activity itself, for the whole write: no restore or reconcile may
  // touch it meanwhile, and no other sync either.
  const lock = await ledger.acquireActivityLock({ activityId, owner, purpose: "sync", now: clock(), leaseMs });
  if (!lock.ok) {
    await ledger.releaseBinding(hevyId, owner).catch(() => false);
    return result({
      ...actBase,
      issues,
      plan,
      status: "blocked",
      reason: `activity is locked by a ${lock.heldBy?.purpose ?? "concurrent"} operation; nothing was written`,
    });
  }
  try {
    return await liveWrite();
  } finally {
    await ledger.releaseActivityLock(activityId, owner).catch(() => false);
  }

  async function liveWrite(): Promise<StrictSyncResult> {
  const detail = detailChecked;

  const journalIds: string[] = [];
  let writes = 0;
  const preservedBefore = extractPreservedMetrics(detail);
  const done = (r: Partial<StrictSyncResult> & Pick<StrictSyncResult, "status">) =>
    result({ ...actBase, issues, plan, journalIds, writes, ...r });

  try {
    // 6. Immutable backups, persisted and read back before any mutation.
    const snapshot = {
      activityId,
      exerciseSets: (originalSets as { exerciseSets?: unknown }).exerciseSets ?? [],
      activityName: currentName,
      description: currentDescription,
      preservedMetrics: preservedBefore,
    };
    const snapshotSha = sha256Canonical(snapshot);
    const original = await ledger.saveBackup({ garminActivityId: activityId, hevyId, kind: "original", payload: snapshot, sha256: snapshotSha });
    const pre = await ledger.saveBackup({ garminActivityId: activityId, hevyId, kind: "pre_write", payload: snapshot, sha256: snapshotSha });
    const [origBack, preBack] = await Promise.all([ledger.getBackup(original.id), ledger.getBackup(pre.id)]);
    const intact = (b: typeof origBack) => b != null && sha256Canonical(b.payload) === b.sha256;
    if (!intact(origBack) || !intact(preBack) || preBack!.sha256 !== snapshotSha) {
      await ledger.releaseBinding(hevyId, owner, { lastError: "backup could not be verified; nothing was written" });
      return done({ status: "failed", reason: "backup could not be verified; nothing was written" });
    }

    // 7. The writes, each journaled and verified. Sets first: a name or a
    //    description is never changed on an activity whose sets are wrong.
    const write = async (step: JournalStep, kind: GarminWriteKind, intended: unknown, perform: () => Promise<void>) => {
      const outcome = await guardedWrite({
        ledger,
        garmin,
        step,
        kind,
        hevyId,
        activityId,
        owner,
        intended,
        backupId: pre.id,
        backupPayload: snapshot,
        preservedBefore,
        perform,
        sleep,
        verifyDelayMs,
      });
      if (outcome.journalId) journalIds.push(outcome.journalId);
      writes += outcome.sent ? 1 : 0;
      return outcome;
    };

    if (!setsAlreadyApplied) {
      const o = await write("exercise_sets", "exercise_sets", payload, () => garmin.putExerciseSets(activityId, payload));
      if (o.status !== "verified") return finishFailure(o);
    }
    if (newName !== null || newDescription !== null) {
      const fields: { activityName?: string; description?: string } = {};
      if (newName !== null) fields.activityName = newName;
      if (newDescription !== null) fields.description = newDescription;
      const o = await write("metadata", "metadata", fields, () => garmin.updateActivityMetadata(activityId, fields));
      if (o.status !== "verified") return finishFailure(o);
    }

    // 8. Record it. The calories and heart rate are the watch's own.
    const summary = (detail.summaryDTO ?? {}) as Record<string, unknown>;
    await ledger.releaseBinding(hevyId, owner, { state: "verified", lastError: null, lastJournalId: journalIds.at(-1) ?? null });
    await legacy.markSynced(hevyId, {
      garminActivityId: String(activityId),
      title: intent.title,
      calories: Number.isFinite(Number(summary.calories)) ? Math.round(Number(summary.calories)) : null,
      avgHr: Number.isFinite(Number(summary.averageHR)) ? Math.round(Number(summary.averageHR)) : null,
      hevyUpdatedAt: intent.updatedAt,
      syncMethod: "strict_inplace",
      ...(options.resync ? { resync: true } : {}),
    });
    return done({ status: "synced" });
  } catch (e) {
    await ledger.releaseBinding(hevyId, owner, { lastError: (e as Error).message.slice(0, 500) }).catch(() => false);
    return done({ status: "failed", reason: (e as Error).message });
  }

  async function finishFailure(o: GuardedOutcome): Promise<StrictSyncResult> {
    if (o.status === "needs_review") {
      await ledger.setBindingState(hevyId, "needs_review", o.reason);
      await ledger.releaseBinding(hevyId, owner, { lastError: o.reason }).catch(() => false);
    } else {
      await ledger.releaseBinding(hevyId, owner, { lastError: o.reason }).catch(() => false);
    }
    const status: StrictStatus =
      o.status === "needs_review" ? "needs_review" : o.status === "uncertain" ? "uncertain" : o.status === "blocked" ? "blocked" : "failed";
    return done({ status, reason: o.reason, mismatches: o.mismatches });
  }
  }
}

interface GuardedOutcome {
  status: "verified" | "not_applied" | "uncertain" | "needs_review" | "blocked" | "failed";
  reason: string | null;
  journalId: string | null;
  sent: boolean;
  mismatches?: { sets: SetMismatch[]; metrics: MetricMismatch[]; metadata: string[] };
}

interface GuardedWriteInput {
  ledger: StrictLedger;
  garmin: StrictGarminPort;
  step: JournalStep;
  kind: GarminWriteKind;
  hevyId: string;
  activityId: number;
  owner: string;
  intended: unknown;
  backupId: string;
  backupPayload: { exerciseSets: unknown; activityName: string | null; description: string | null };
  preservedBefore: Record<string, unknown>;
  perform: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  verifyDelayMs: number;
}

/** One journaled, capability-scoped, read-back-verified Garmin write. */
async function guardedWrite(w: GuardedWriteInput): Promise<GuardedOutcome> {
  const { ledger, garmin, activityId } = w;
  // Another process may have frozen writes since this run started.
  const block = await strictWriteBlock(ledger);
  if (block.blocked) return { status: "blocked", reason: block.reason, journalId: null, sent: false };

  if (strictHardStopActive()) return { status: "blocked", reason: "H2G_STRICT_STOP is set: every Garmin write is refused", journalId: null, sent: false };
  const intendedSha256 = sha256Canonical(w.intended);
  let entry;
  try {
    entry = await ledger.openJournal({
      hevyId: w.hevyId,
      garminActivityId: activityId,
      step: w.step,
      owner: w.owner,
      intendedSha256,
      intended: w.intended,
      backupId: w.backupId,
    });
  } catch (e) {
    if (isJournalConflict(e)) return { status: "blocked", reason: (e as Error).message, journalId: null, sent: false };
    throw e;
  }
  // Durable BEFORE the request leaves: a crash from here on is an open,
  // blocking entry that only read-back can close.
  if (!(await ledger.advanceJournal(entry.id, ["intent"], "put_sent"))) {
    await ledger.advanceJournal(entry.id, ["intent"], "aborted", { abortedReason: "intent → put_sent was refused" }).catch(() => false);
    return { status: "failed", reason: "journal could not be advanced; nothing was sent", journalId: entry.id, sent: false };
  }

  let sendError: string | null = null;
  try {
    await withGarminWriteCapability({ activityId, allow: new Set([w.kind]) }, w.perform);
    await ledger.advanceJournal(entry.id, ["put_sent"], "put_acknowledged");
  } catch (e) {
    if (isStrictModeViolation(e)) {
      // Refused before any byte left the process.
      const message = (e as Error).message;
      await ledger.advanceJournal(entry.id, ["put_sent"], "aborted", { error: message });
      return { status: "failed", reason: message, journalId: entry.id, sent: false };
    }
    sendError = (e as Error).message.slice(0, 500);
    await ledger.advanceJournal(entry.id, ["put_sent"], "uncertain", { error: sendError });
  }

  return verifyJournalEntry(ledger, garmin, entry.id, specOf(w.step, activityId, w.intended, w.backupPayload, w.preservedBefore, {}), w.sleep, w.verifyDelayMs, sendError);
}

interface VerifySpec {
  activityId: number;
  /** ACTIVE sets that must now be on Garmin, or null when this write did not touch sets. */
  intendedSets: unknown | null;
  /** Name/description that must now be on Garmin, or null when untouched. */
  intendedMeta: { activityName?: string; description?: string } | null;
  /** The state immediately before this write, to recognise "not applied". */
  before: { exerciseSets: unknown; activityName: string | null; description: string | null };
  preservedBefore: Record<string, unknown>;
  step: JournalStep;
}

function specOf(
  step: JournalStep,
  activityId: number,
  intended: unknown,
  before: VerifySpec["before"],
  preservedBefore: Record<string, unknown>,
  detail: Record<string, unknown>,
): VerifySpec {
  if (step === "metadata") {
    return { step, activityId, intendedSets: null, intendedMeta: intended as VerifySpec["intendedMeta"], before, preservedBefore };
  }
  if (step === "restore") {
    const meta = (detail.metaFields ?? null) as VerifySpec["intendedMeta"];
    return { step, activityId, intendedSets: intended, intendedMeta: meta && Object.keys(meta).length ? meta : null, before, preservedBefore };
  }
  return { step, activityId, intendedSets: intended, intendedMeta: null, before, preservedBefore };
}

/**
 * Read back and close (or escalate) one journal entry. Shared by the live
 * write and by `reconcileStrictJournal`, so a crash-recovery verdict is the
 * same verdict the original run would have reached.
 */
async function verifyJournalEntry(
  ledger: StrictLedger,
  garmin: StrictGarminPort,
  journalId: string,
  spec: VerifySpec,
  sleep: (ms: number) => Promise<void>,
  delayMs: number,
  sendError: string | null,
): Promise<GuardedOutcome> {
  const sent = true;
  if (delayMs > 0) await sleep(delayMs);
  let readSets: Record<string, unknown>;
  let readDetail: Record<string, unknown> | null;
  try {
    readSets = await garmin.exerciseSets(spec.activityId);
    readDetail = await garmin.activityDetail(spec.activityId);
  } catch (e) {
    const reason = `read-back failed (${(e as Error).message}); strict writes stay blocked until journal ${journalId} is reconciled`;
    await ledger.advanceJournal(journalId, ["put_acknowledged"], "uncertain", { readbackError: (e as Error).message });
    return { status: "uncertain", reason, journalId, sent };
  }
  if (!readDetail) {
    const reason = `activity ${spec.activityId} is gone after the write`;
    await ledger.advanceJournal(journalId, ["put_sent", "put_acknowledged", "uncertain"], "needs_review", { reason });
    await ledger.setFrozen(true, `${reason} (journal ${journalId})`);
    return { status: "needs_review", reason, journalId, sent };
  }

  // Identity first: a read-back of another activity, or one that does not say
  // which activity it is, proves nothing.
  if (Number(readDetail.activityId) !== spec.activityId) {
    const reason = `read-back names activity ${String(readDetail.activityId ?? "(none)")}, not ${spec.activityId}`;
    await ledger.advanceJournal(journalId, ["put_sent", "put_acknowledged", "uncertain"], "needs_review", { reason });
    await ledger.setFrozen(true, `${reason} (journal ${journalId})`);
    return { status: "needs_review", reason, journalId, sent };
  }
  const metrics = comparePreservedMetrics(spec.preservedBefore, readDetail);
  // The whole sequence: ACTIVE and REST, timing, every exercise field. Sets
  // identity is required whether or not this write touched the sets.
  const sets =
    spec.intendedSets != null
      ? compareSetSequences(spec.intendedSets, readSets, { activityId: spec.activityId })
      : compareSetSequences(readSets, readSets, { activityId: spec.activityId }).filter((m) => m.field === "activityId");
  const metadata: string[] = [];
  const name = activityNameOf(readDetail);
  const desc = descriptionOf(readDetail);
  if (spec.intendedMeta) {
    const f = spec.intendedMeta;
    if (f.activityName !== undefined && name !== f.activityName) {
      metadata.push(`activityName: expected ${JSON.stringify(f.activityName)}, got ${JSON.stringify(name)}`);
    }
    if (f.description !== undefined && (desc ?? "") !== f.description) metadata.push("description differs from what was written");
  }
  const setsUnchanged =
    spec.intendedSets == null || compareSetSequences({ exerciseSets: spec.before.exerciseSets }, readSets).length === 0;
  const metaUnchanged =
    spec.intendedMeta == null ||
    ((spec.intendedMeta.activityName === undefined || name === spec.before.activityName) &&
      (spec.intendedMeta.description === undefined || (desc ?? "") === (spec.before.description ?? "")));
  const from: JournalPhase[] = ["put_sent", "put_acknowledged", "uncertain"];

  // Every closing transition is a compare-and-set. If it fails, someone else
  // moved this entry while we were reading back (a concurrent reconcile, an
  // operator): our verdict may be stale, so writes are frozen for a person.
  const conflict = async (): Promise<GuardedOutcome> => {
    const reason = `journal ${journalId} changed while its read-back ran; strict writes are frozen for review`;
    await ledger.setFrozen(true, reason);
    return { status: "needs_review", reason, journalId, sent };
  };
  if (!sets.length && !metadata.length && !metrics.length) {
    if (!(await ledger.advanceJournal(journalId, from, "verified", { verifiedAt: new Date().toISOString() }))) return conflict();
    return { status: "verified", reason: null, journalId, sent };
  }
  if (setsUnchanged && metaUnchanged && !metrics.length) {
    const reason = `Garmin did not apply the ${spec.step} write${sendError ? `: ${sendError}` : ""}; the activity is unchanged`;
    if (!(await ledger.advanceJournal(journalId, from, "not_applied", { reason }))) return conflict();
    return { status: "not_applied", reason, journalId, sent };
  }
  const reason = `read-back does not match the ${spec.step} write; strict writes are frozen until a person reviews journal ${journalId}`;
  // Frozen whether or not this transition wins: a mismatch is never ignored.
  await ledger.advanceJournal(journalId, from, "needs_review", { sets, metrics, metadata });
  await ledger.setFrozen(true, `read-back mismatch on activity ${spec.activityId} (journal ${journalId})`);
  return { status: "needs_review", reason, journalId, sent, mismatches: { sets, metrics, metadata } };
}

export interface StrictRecoveryDeps {
  ledger: StrictLedger;
  garmin: () => Promise<StrictGarminPort>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  owner?: string;
}

export interface StrictRecoveryResult {
  status: "verified" | "not_applied" | "needs_review" | "uncertain" | "aborted" | "not_open" | "restored" | "refused" | "failed";
  reason: string | null;
  journalId: string;
  writes: number;
}

/**
 * Reconcile one open journal entry by READ-BACK ONLY. Never writes to Garmin.
 * This is the controlled recovery after a crash, timeout or lost response.
 */
export async function reconcileStrictJournal(
  deps: StrictRecoveryDeps,
  journalId: string,
  options: { leaseMs?: number } = {},
): Promise<StrictRecoveryResult> {
  const now = (deps.now ?? (() => new Date()))();
  const entry = await deps.ledger.getJournal(journalId);
  if (!entry) return { status: "not_open", reason: "no such journal entry", journalId, writes: 0 };
  if (entry.phase === "intent") {
    if (now.getTime() - Date.parse(entry.createdAt) <= (options.leaseMs ?? DEFAULT_LEASE_MS)) {
      return { status: "refused", reason: "the writer may still be running; try again after its lease", journalId, writes: 0 };
    }
    await deps.ledger.advanceJournal(journalId, ["intent"], "aborted", { abortedReason: "stale intent; no request was sent" });
    return { status: "aborted", reason: null, journalId, writes: 0 };
  }
  if (!["put_sent", "put_acknowledged", "uncertain"].includes(entry.phase)) {
    return { status: entry.phase === "needs_review" ? "needs_review" : "not_open", reason: `journal is ${entry.phase}`, journalId, writes: 0 };
  }
  // The writer may still be between its PUT and its own read-back. Reading back
  // now could see the old state and close the entry as not applied just before
  // the PUT lands. Wait until the writer's lease has expired or been released.
  const binding = await deps.ledger.getBindingByHevy(entry.hevyId);
  if (binding?.leaseOwner === entry.owner && binding.leaseUntil && Date.parse(binding.leaseUntil) > now.getTime()) {
    return { status: "refused", reason: "the writer still holds its lease; try again after it finishes or the lease expires", journalId, writes: 0 };
  }
  // And the activity itself: no sync or restore may run while it is read back.
  const owner = deps.owner ?? `reconcile-${randomUUID()}`;
  const lock = await deps.ledger.acquireActivityLock({
    activityId: entry.garminActivityId,
    owner,
    purpose: "reconcile",
    now,
    leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
  });
  if (!lock.ok) {
    return { status: "refused", reason: `activity is locked by a ${lock.heldBy?.purpose ?? "concurrent"} operation`, journalId, writes: 0 };
  }
  try {
    return await reconcileUnderLock();
  } finally {
    await deps.ledger.releaseActivityLock(entry.garminActivityId, owner).catch(() => false);
  }

  async function reconcileUnderLock(): Promise<StrictRecoveryResult> {
  if (!entry) return { status: "not_open", reason: "no such journal entry", journalId, writes: 0 };
  const current = await deps.ledger.getJournal(journalId);
  if (!current || current.phase !== entry.phase) {
    return { status: "refused", reason: `journal moved to ${current?.phase ?? "nothing"} meanwhile; look again`, journalId, writes: 0 };
  }
  const backup = await deps.ledger.getBackup(entry.backupId);
  if (!backup || sha256Canonical(backup.payload) !== backup.sha256) {
    await deps.ledger.advanceJournal(journalId, [entry.phase], "needs_review", { reason: "backup missing or corrupt" });
    await deps.ledger.setFrozen(true, `backup for journal ${journalId} missing or corrupt`);
    return { status: "needs_review", reason: "backup missing or corrupt", journalId, writes: 0 };
  }
  const payload = backup.payload as GuardedWriteInput["backupPayload"] & { preservedMetrics: Record<string, unknown> };
  const garmin = await deps.garmin();
  const out = await verifyJournalEntry(
    deps.ledger,
    garmin,
    journalId,
    specOf(entry.step, entry.garminActivityId, entry.intended, payload, payload.preservedMetrics ?? {}, entry.detail),
    async () => {},
    0,
    null,
  );
  if (out.status === "needs_review") {
    // Same protection as a live mismatch: no manual sync may write this workout again.
    await deps.ledger.setBindingState(entry.hevyId, "needs_review", out.reason ?? "read-back mismatch found by reconcile");
  }
  if (out.status === "verified" || out.status === "not_applied") {
    // The rest of that sync (metadata, ledger row) is resumed by the next
    // manual sync of the workout, which finds these sets already applied.
    await deps.ledger.setBindingState(entry.hevyId, "claimed", `reconciled as ${out.status}; run a manual sync to finish`);
  }
  return { status: out.status as StrictRecoveryResult["status"], reason: out.reason, journalId, writes: 0 };
  }
}

/**
 * Operator-approved restore of an activity to a verified backup: its `pre_write`
 * snapshot (undo the last write) or its `original` (undo everything strict
 * mode ever wrote). Never automatic: requires `confirm: true`.
 *
 * Guarantees, in order, each checked before any network write:
 *  - H2G_STRICT_STOP refuses it outright (the database stop switch does not:
 *    a verified recovery is exactly what a frozen deployment may need);
 *  - the activity lock is held for the whole restore, so no sync, reconcile or
 *    second restore can interleave;
 *  - the reviewed entry is re-read under the lock and must still be
 *    needs_review/verified; the backup must pass its integrity check;
 *  - the current state is read, identified and snapshotted (a verified
 *    pre_write backup), so the restore itself can be undone;
 *  - its own journal entry must open (one in-flight write per activity) and
 *    move intent → put_sent by compare-and-set; if either fails, nothing is sent.
 * Then exactly one sets write and, if needed, one name/description write,
 * read back over the full set sequence and the activity's native metrics.
 */
export async function restoreStrictBackup(
  deps: StrictRecoveryDeps,
  input: { journalId: string; source: "pre_write" | "original"; confirm: boolean },
  options: { leaseMs?: number; verifyDelayMs?: number } = {},
): Promise<StrictRecoveryResult> {
  const { ledger } = deps;
  const refuse = (reason: string, journalId = input.journalId): StrictRecoveryResult => ({ status: "refused", reason, journalId, writes: 0 });
  if (input.confirm !== true) return refuse("a restore must be confirmed explicitly");
  if (strictHardStopActive()) return refuse("H2G_STRICT_STOP is set: every Garmin write is refused, restores included");
  const first = await ledger.getJournal(input.journalId);
  if (!first) return { status: "not_open", reason: "no such journal entry", journalId: input.journalId, writes: 0 };
  const activityId = first.garminActivityId;
  const clock = deps.now ?? (() => new Date());
  const owner = deps.owner ?? `restore-${randomUUID()}`;
  const lock = await ledger.acquireActivityLock({ activityId, owner, purpose: "restore", now: clock(), leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS });
  if (!lock.ok) return refuse(`activity ${activityId} is locked by a ${lock.heldBy?.purpose ?? "concurrent"} operation`);
  try {
    return await restoreUnderLock();
  } finally {
    await ledger.releaseActivityLock(activityId, owner).catch(() => false);
  }

  async function restoreUnderLock(): Promise<StrictRecoveryResult> {
    const entry = await ledger.getJournal(input.journalId);
    if (!entry || !["needs_review", "verified"].includes(entry.phase)) {
      return refuse(`cannot restore from a ${entry?.phase ?? "missing"} entry; reconcile it first`);
    }
    const backup = input.source === "original" ? await ledger.getOriginalBackup(activityId) : await ledger.getBackup(entry.backupId);
    if (!backup || backup.garminActivityId !== activityId || sha256Canonical(backup.payload) !== backup.sha256) {
      return refuse("backup missing, for another activity, or failed its integrity check", entry.id);
    }
    const target = backup.payload as GuardedWriteInput["backupPayload"] & { preservedMetrics: Record<string, unknown> };
    if (!Array.isArray(target.exerciseSets)) return refuse("backup holds no set list to restore", entry.id);
    const garmin = await deps.garmin();

    // The restore is itself reversible: snapshot the current state first.
    let current: Record<string, unknown>;
    let detail: Record<string, unknown> | null;
    try {
      current = await garmin.exerciseSets(activityId);
      detail = await garmin.activityDetail(activityId);
    } catch (e) {
      return { status: "failed", reason: `could not read the activity: ${(e as Error).message}`, journalId: entry.id, writes: 0 };
    }
    if (!detail) return { status: "failed", reason: "the activity is no longer on Garmin", journalId: entry.id, writes: 0 };
    if (Number(detail.activityId) !== activityId || Number((current as { activityId?: unknown }).activityId) !== activityId) {
      return refuse("Garmin's answer does not identify the activity; nothing was written", entry.id);
    }
    const missing = missingRequiredMetrics(detail);
    if (missing.length) return refuse(`activity detail lacks required values (${missing.join(", ")})`, entry.id);
    const snapshot = {
      activityId,
      exerciseSets: (current as { exerciseSets?: unknown }).exerciseSets ?? [],
      activityName: activityNameOf(detail),
      description: descriptionOf(detail),
      preservedMetrics: extractPreservedMetrics(detail),
    };
    const pre = await ledger.saveBackup({ garminActivityId: activityId, hevyId: entry.hevyId, kind: "pre_write", payload: snapshot, sha256: sha256Canonical(snapshot) });
    const reread = await ledger.getBackup(pre.id);
    if (!reread || reread.sha256 !== sha256Canonical(reread.payload)) {
      return { status: "failed", reason: "pre-restore backup could not be verified; nothing was written", journalId: entry.id, writes: 0 };
    }

    const setsPayload = { activityId, exerciseSets: target.exerciseSets };
    const metaFields: { activityName?: string; description?: string } = {};
    if (target.activityName != null && target.activityName !== snapshot.activityName) metaFields.activityName = target.activityName;
    // An original without a description is restored by clearing what strict
    // mode added (Garmin stores "no description" as empty).
    if ((target.description ?? "") !== (snapshot.description ?? "")) metaFields.description = target.description ?? "";

    let restoreEntry;
    try {
      restoreEntry = await ledger.openJournal({
        hevyId: entry.hevyId,
        garminActivityId: activityId,
        step: "restore",
        owner,
        intendedSha256: sha256Canonical(setsPayload),
        intended: setsPayload,
        backupId: pre.id,
        detail: { restoring: backup.id, source: input.source, forJournal: entry.id, metaFields },
      });
    } catch (e) {
      if (isJournalConflict(e)) return refuse((e as Error).message, entry.id);
      throw e;
    }
    // Durable before anything leaves; a refused transition means nothing is sent.
    if (!(await ledger.advanceJournal(restoreEntry.id, ["intent"], "put_sent"))) {
      await ledger.advanceJournal(restoreEntry.id, ["intent"], "aborted", { abortedReason: "intent → put_sent was refused" }).catch(() => false);
      return { status: "failed", reason: "restore journal could not be advanced; nothing was sent", journalId: restoreEntry.id, writes: 0 };
    }
    if (strictHardStopActive()) {
      await ledger.advanceJournal(restoreEntry.id, ["put_sent"], "aborted", { abortedReason: "H2G_STRICT_STOP set before sending" });
      return refuse("H2G_STRICT_STOP is set: every Garmin write is refused, restores included", restoreEntry.id);
    }

    let writes = 0;
    let sendError: string | null = null;
    let refusedBeforeNetwork = false;
    const allow = new Set<GarminWriteKind>(["exercise_sets"]);
    if (Object.keys(metaFields).length) allow.add("metadata");
    const attempt = async (call: () => Promise<void>) => {
      try {
        await call();
        writes += 1;
      } catch (e) {
        if (isStrictModeViolation(e)) refusedBeforeNetwork = writes === 0;
        else writes += 1; // it may have reached Garmin
        throw e;
      }
    };
    try {
      await withGarminWriteCapability({ activityId, allow }, async () => {
        await attempt(() => garmin.putExerciseSets(activityId, setsPayload as StrictSetsPayload));
        if (Object.keys(metaFields).length) await attempt(() => garmin.updateActivityMetadata(activityId, metaFields));
      });
      if (!(await ledger.advanceJournal(restoreEntry.id, ["put_sent"], "put_acknowledged"))) {
        await ledger.setFrozen(true, `restore journal ${restoreEntry.id} changed during its write`);
      }
    } catch (e) {
      sendError = (e as Error).message;
      if (refusedBeforeNetwork) {
        await ledger.advanceJournal(restoreEntry.id, ["put_sent"], "aborted", { error: sendError });
        return { status: "failed", reason: sendError, journalId: restoreEntry.id, writes: 0 };
      }
      await ledger.advanceJournal(restoreEntry.id, ["put_sent"], "uncertain", { error: sendError });
    }
    const out = await verifyJournalEntry(
      ledger,
      garmin,
      restoreEntry.id,
      specOf("restore", activityId, setsPayload, snapshot, snapshot.preservedMetrics, { metaFields }),
      deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
      options.verifyDelayMs ?? STRICT_VERIFY_DELAY_MS,
      sendError,
    );
    if (out.status === "verified") {
      if (!(await ledger.advanceJournal(entry.id, ["needs_review", "verified"], "restored", { restoredBy: restoreEntry.id, source: input.source }))) {
        await ledger.setFrozen(true, `journal ${entry.id} changed while it was being restored`);
        return { status: "needs_review", reason: `journal ${entry.id} changed during the restore; frozen for review`, journalId: restoreEntry.id, writes };
      }
      await ledger.setBindingState(entry.hevyId, "needs_review", `restored to the ${input.source} backup by an operator; review before syncing again`);
      return { status: "restored", reason: null, journalId: restoreEntry.id, writes };
    }
    return { status: out.status as StrictRecoveryResult["status"], reason: out.reason, journalId: restoreEntry.id, writes };
  }
}

/** Operator closes a reviewed entry. Local only. */
export async function resolveStrictJournal(ledger: StrictLedger, journalId: string, note: string): Promise<boolean> {
  return ledger.advanceJournal(journalId, ["needs_review"], "resolved", { resolution: note.slice(0, 500), resolvedAt: new Date().toISOString() });
}
