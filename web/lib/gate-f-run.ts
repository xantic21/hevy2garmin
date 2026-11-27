/**
 * Gate F, server side: the one owner-authorized merge and its evidence.
 *
 *  - status:   what is authorized and the state of every safeguard (DB only)
 *  - preview:  the strict dry run of exactly the authorized pair (reads only)
 *  - run:      the live merge, once. A single-row record (strict_gate_f) is
 *              claimed by one statement; a second, parallel or repeated call
 *              is refused. Once any write was journaled the record is done for
 *              good; a run that journaled nothing (watch activity not there
 *              yet, a mismatch found before writing) re-arms it.
 *  - evidence: before (the verified original backup), intended (the journal),
 *              after (a fresh read-only read of the activity), each compared,
 *              with a SHA-256 over the whole bundle.
 *
 * Every Garmin write still goes through the unchanged strict engine with the
 * pin, the hard stop, the freeze, the activity lock, the journal and the
 * read-back. Nothing here writes to Garmin itself.
 */
import { randomUUID } from "node:crypto";
import {
  activityNameOf,
  comparePreservedMetrics,
  compareSetSequences,
  descriptionOf,
  firewallSelfTest,
  firewallStats,
  sha256Canonical,
  strictGarminPort,
  strictWriteBlock,
  type StrictPin,
  type StrictSyncResult,
} from "hevy2garmin";
import type { GarminClient } from "garmin-auth";
import { vaultStatus } from "./credential-vault";
import { getGarminClient } from "./garmin-upload";
import { gateFState, type GateFAuthorization } from "./gate-f";
import type { Sql } from "./pending-store";
import { postgresStrictLedger, strictSchemaReady } from "./strict-ledger-store";
import { runStrictSync, strictEnvStop, type StrictRouteOptions } from "./strict-sync";

export const GATE_F_RUN_LEASE_MS = 10 * 60 * 1000;

export interface GateFRecord {
  hevyId: string;
  activityId: number;
  state: "armed" | "running" | "done";
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  authorizedUntil: string;
  lastResult: unknown;
}

type Seams = Pick<StrictRouteOptions, "fetchWorkouts" | "garminClientFactory" | "timing">;

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

function recordOf(r: Record<string, unknown>): GateFRecord {
  return {
    hevyId: String(r.hevy_id),
    activityId: Number(r.garmin_activity_id),
    state: r.state as GateFRecord["state"],
    attempts: Number(r.attempts),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    authorizedUntil: iso(r.authorized_until)!,
    lastResult: r.last_result ?? null,
  };
}

/** The authorization, or a refusal reason. */
function authorization(): { auth: GateFAuthorization; expired: boolean } | { refusal: string } {
  const gate = gateFState();
  if (!gate.requested) return { refusal: "this deployment is not in gate F mode" };
  if (!gate.ok) return { refusal: `the gate F authorization is refused: ${gate.error}` };
  return { auth: gate.auth, expired: gate.expired };
}

const pinOf = (a: GateFAuthorization): StrictPin => ({ hevyId: a.hevyId, activityId: a.activityId });

export function gateFConfirmation(a: Pick<GateFAuthorization, "hevyId" | "activityId">): string {
  return `GATE-F ${a.hevyId} ${a.activityId}`;
}

async function tableReady(sql: Sql): Promise<boolean> {
  const rows = await sql`SELECT to_regclass('public.strict_gate_f') AS r`;
  return Boolean(rows[0]?.r);
}

async function readRecord(sql: Sql): Promise<GateFRecord | null> {
  const rows = await sql`SELECT * FROM strict_gate_f WHERE id = 'gate_f'`;
  return rows[0] ? recordOf(rows[0] as Record<string, unknown>) : null;
}

/** Everything the gate F panel shows. Database only; no Garmin request. */
export async function gateFStatus(sql: Sql) {
  const a = authorization();
  if ("refusal" in a) return { gateF: false as const, reason: a.refusal };
  const ledger = postgresStrictLedger(sql);
  const [schema, table, block, binding, journal, original] = await Promise.all([
    strictSchemaReady(sql),
    tableReady(sql),
    strictWriteBlock(ledger).catch((e: Error) => ({ blocked: true, reason: e.message })),
    ledger.getBindingByHevy(a.auth.hevyId),
    ledger.listJournalForActivity(a.auth.activityId),
    ledger.getOriginalBackup(a.auth.activityId),
  ]);
  return {
    gateF: true as const,
    authorization: { ...a.auth, expired: a.expired },
    confirmation: gateFConfirmation(a.auth),
    record: table ? await readRecord(sql) : null,
    safeguards: {
      envStop: strictEnvStop(),
      writeBlock: block,
      schema: { ...schema, gateFTable: table },
      firewall: { installed: await firewallSelfTest(globalThis), ...firewallStats() },
      credentials: await vaultStatus(sql),
    },
    binding,
    journal: journal.map((e) => ({ id: e.id, hevyId: e.hevyId, step: e.step, phase: e.phase, intendedSha256: e.intendedSha256, createdAt: e.createdAt, updatedAt: e.updatedAt, detail: e.detail })),
    originalBackup: original ? { id: original.id, sha256: original.sha256, capturedAt: original.capturedAt, intact: sha256Canonical(original.payload) === original.sha256 } : null,
  };
}

/** The strict dry run of exactly the authorized pair. Reads Hevy and Garmin; writes nothing. */
export async function gateFPreview(sql: Sql, seams: Seams = {}): Promise<{ refused: string } | { result: StrictSyncResult }> {
  const a = authorization();
  if ("refusal" in a) return { refused: a.refusal };
  return { result: await runStrictSync(sql, { ...seams, dryRun: true, trigger: "manual", targetHevyId: a.auth.hevyId, pin: pinOf(a.auth) }) };
}

export type GateFRunOutcome =
  | { refused: string; record?: GateFRecord | null }
  | { result: StrictSyncResult; record: GateFRecord | null; consumed: boolean; warning?: string };

/**
 * The live merge of the authorized pair, at most once per database.
 * `confirm` must be exactly "GATE-F <hevyId> <activityId>"; `planSha256` is the
 * plan the preview showed, and a run whose plan differs writes nothing.
 */
export async function gateFRun(
  sql: Sql,
  input: { confirm: unknown; planSha256: unknown },
  seams: Seams = {},
  now: () => Date = () => new Date(),
): Promise<GateFRunOutcome> {
  const confirm = input.confirm;
  const a = authorization();
  if ("refusal" in a) return { refused: a.refusal };
  if (a.expired) return { refused: "the gate F authorization has expired; nothing more is merged" };
  if (confirm !== gateFConfirmation(a.auth)) return { refused: `type exactly "${gateFConfirmation(a.auth)}" to run gate F` };
  if (strictEnvStop()) return { refused: "H2G_STRICT_STOP is set: every Garmin write is refused" };
  const planSha256 = typeof input.planSha256 === "string" && /^[0-9a-f]{64}$/.test(input.planSha256) ? input.planSha256 : null;
  if (!planSha256) return { refused: "preview first: the run is bound to the plan the preview showed" };
  if (!(await tableReady(sql))) return { refused: "the gate F record table is missing; the schema bootstrap did not run" };
  const schema = await strictSchemaReady(sql);
  if (!schema.ready) return { refused: `strict ledger schema is incomplete (${schema.missing.join(", ")})` };

  // The claim: one statement. An armed record (nothing was ever journaled under
  // it) is taken and pointed at the current authorization; a running record
  // only for the same pair once its lease ran out. A done record is final.
  const owner = `gate-f-${randomUUID()}`;
  const started = now();
  const staleBefore = new Date(started.getTime() - GATE_F_RUN_LEASE_MS);
  const claimed = await sql`
    INSERT INTO strict_gate_f (id, hevy_id, garmin_activity_id, state, attempts, run_owner, started_at, authorized_until, updated_at)
    VALUES ('gate_f', ${a.auth.hevyId}, ${a.auth.activityId}, 'running', 1, ${owner}, ${started}, ${new Date(a.auth.expiresAt)}, ${started})
    ON CONFLICT (id) DO UPDATE
      SET state = 'running', attempts = strict_gate_f.attempts + 1, run_owner = EXCLUDED.run_owner,
          hevy_id = EXCLUDED.hevy_id, garmin_activity_id = EXCLUDED.garmin_activity_id,
          started_at = EXCLUDED.started_at, finished_at = NULL, authorized_until = EXCLUDED.authorized_until, updated_at = EXCLUDED.updated_at
      WHERE strict_gate_f.state = 'armed'
         OR (strict_gate_f.state = 'running' AND strict_gate_f.started_at < ${staleBefore}
             AND strict_gate_f.hevy_id = EXCLUDED.hevy_id AND strict_gate_f.garmin_activity_id = EXCLUDED.garmin_activity_id)
    RETURNING *
  `;
  if (!claimed[0]) {
    const existing = await readRecord(sql);
    if (existing?.state === "done") {
      return existing.hevyId === a.auth.hevyId && existing.activityId === a.auth.activityId
        ? { refused: "gate F has already run for this authorization; it is never repeated", record: existing }
        : { refused: `gate F already ran on this database for workout ${existing.hevyId} / activity ${existing.activityId}; one real activity per database`, record: existing };
    }
    return { refused: "another gate F run is in progress", record: existing };
  }

  const ledger = postgresStrictLedger(sql);
  let result: StrictSyncResult | null = null;
  let failure: string | null = null;
  try {
    result = await runStrictSync(sql, {
      ...seams,
      dryRun: false,
      trigger: "manual",
      targetHevyId: a.auth.hevyId,
      pin: pinOf(a.auth),
      expectPlanSha256: planSha256,
    });
  } catch (e) {
    failure = (e as Error).message;
  }
  // Consumed as soon as anything was journaled for the activity or a binding exists: never again.
  const [journal, binding] = await Promise.all([ledger.listJournalForActivity(a.auth.activityId), ledger.getBindingByHevy(a.auth.hevyId)]);
  const consumed = journal.length > 0 || binding !== null || (result?.writes ?? 0) > 0;
  const summary = result
    ? { status: result.status, reason: result.reason, activityId: result.activityId, journalIds: result.journalIds, writes: result.writes, plan: result.plan }
    : { status: "error", reason: failure };
  const finished = await sql`
    UPDATE strict_gate_f
       SET state = ${consumed ? "done" : "armed"}, finished_at = ${now()}, run_owner = NULL,
           last_result = ${sql.json(summary as never)}, updated_at = ${now()}
     WHERE id = 'gate_f' AND state = 'running' AND run_owner = ${owner}
    RETURNING *
  `;
  let warning: string | undefined;
  if (!finished[0]) {
    // Someone took the record over while this run was still going: fail closed.
    await ledger.setFrozen(true, "gate F record changed during the run; review before any further write");
    warning = "the gate F record changed during this run; every strict write is now frozen: check the evidence and the journal before anything else";
  }
  const record = await readRecord(sql);
  if (!result) return { refused: `gate F run failed: ${failure}`, record };
  return { result, record, consumed, ...(warning ? { warning } : {}) };
}

/**
 * The evidence bundle. Reads the activity from Garmin (reads only; building
 * the client may refresh the Garmin sign-in token, which is authentication,
 * not activity data) and compares it with the original backup and with what
 * the journal says was written. Allowed after the authorization expired.
 *
 * `verdict.ok` is true only when every comparison for the expected state ran
 * and found nothing: "merged" after a verified run, "original" after a
 * verified restore to the original, "untouched" before anything was written.
 */
export async function gateFEvidence(sql: Sql, garminClientFactory?: () => Promise<GarminClient>) {
  const a = authorization();
  if ("refusal" in a) return { refused: a.refusal };
  const status = await gateFStatus(sql);
  const ledger = postgresStrictLedger(sql);
  const original = await ledger.getOriginalBackup(a.auth.activityId);
  const journal = await ledger.listJournalForActivity(a.auth.activityId);
  const latest = (step: string) => [...journal].reverse().find((e) => e.step === step) ?? null;
  const setsEntry = [...journal].reverse().find((e) => e.step === "exercise_sets" && ["verified", "needs_review", "restored"].includes(e.phase)) ?? null;
  const metaEntry = [...journal].reverse().find((e) => e.step === "metadata" && ["verified", "needs_review", "restored"].includes(e.phase)) ?? null;
  const restoreEntry = latest("restore");
  const restoredToOriginal = restoreEntry?.phase === "verified" && restoreEntry.detail?.source === "original";
  const merged = !restoredToOriginal && setsEntry?.phase === "verified" && (metaEntry === null || metaEntry.phase === "verified");
  const expected: "merged" | "original" | "untouched" | "review" = restoredToOriginal ? "original" : merged ? "merged" : journal.length === 0 ? "untouched" : "review";

  let after: { detail: Record<string, unknown> | null; sets: Record<string, unknown> | null; error: string | null } = { detail: null, sets: null, error: null };
  try {
    const port = strictGarminPort(await (garminClientFactory ?? (() => getGarminClient()))());
    after = { detail: await port.activityDetail(a.auth.activityId), sets: await port.exerciseSets(a.auth.activityId), error: null };
  } catch (e) {
    after = { detail: null, sets: null, error: (e as Error).message };
  }
  const before = original?.payload as { exerciseSets?: unknown; activityName?: string | null; description?: string | null; preservedMetrics?: Record<string, unknown> } | undefined;
  const afterSets = (after.sets as { exerciseSets?: unknown } | null)?.exerciseSets;
  const nameNow = after.detail ? activityNameOf(after.detail) : null;
  const descriptionNow = after.detail ? descriptionOf(after.detail) : null;
  const metaIntended = (metaEntry?.intended ?? null) as { activityName?: string; description?: string } | null;
  const field = (label: string, want: unknown, got: unknown) => (want === got ? [] : [{ field: label, expected: want, actual: got }]);

  const comparisons = {
    // Garmin answered for the authorized activity in both reads.
    activityIdConfirmed: after.detail && after.sets ? Number(after.detail.activityId) === a.auth.activityId && Number(after.sets.activityId) === a.auth.activityId : null,
    // Every journaled intent and the backup still hash to what was stored.
    integrity:
      original === null
        ? null
        : [original.sha256 === sha256Canonical(original.payload) ? null : "original backup", ...journal.map((e) => (sha256Canonical(e.intended) === e.intendedSha256 ? null : `journal ${e.id}`))].filter(Boolean),
    // Native metrics (HR, calories, duration, ...) as they were before the first write.
    preservedMetrics: before?.preservedMetrics && after.detail ? comparePreservedMetrics(before.preservedMetrics, after.detail) : null,
    // The sets on Garmin now against what the verified write intended.
    setsAgainstIntended: setsEntry && after.sets ? compareSetSequences(setsEntry.intended, after.sets, { activityId: a.auth.activityId }) : null,
    // The sets on Garmin now against the original backup, nothing left behind.
    setsAgainstOriginal:
      Array.isArray(before?.exerciseSets) && after.sets
        ? compareSetSequences({ activityId: a.auth.activityId, exerciseSets: before.exerciseSets }, after.sets, { activityId: a.auth.activityId, absentMeansNull: true })
        : null,
    // Name and description against the journaled metadata write.
    metadataAgainstIntended:
      metaIntended && after.detail
        ? [
            ...("activityName" in metaIntended ? field("activityName", metaIntended.activityName, nameNow) : []),
            ...("description" in metaIntended ? field("description", metaIntended.description, descriptionNow) : []),
          ]
        : null,
    // Name and description against the original backup.
    metadataAgainstOriginal: before && after.detail ? [...field("activityName", before.activityName ?? null, nameNow), ...field("description", before.description ?? null, descriptionNow)] : null,
    nameNow,
    descriptionNow,
  };
  const required: Record<typeof expected, Array<keyof typeof comparisons>> = {
    merged: ["activityIdConfirmed", "integrity", "preservedMetrics", "setsAgainstIntended", "metadataAgainstIntended"],
    original: ["activityIdConfirmed", "integrity", "preservedMetrics", "setsAgainstOriginal", "metadataAgainstOriginal"],
    untouched: [],
    review: [],
  };
  const checks = Object.fromEntries(
    required[expected]
      .filter((k) => !(k === "metadataAgainstIntended" && metaEntry === null))
      .map((k) => {
        const v = comparisons[k];
        return [k, v === null ? "not_compared" : v === true || (Array.isArray(v) && v.length === 0) ? "passed" : "failed"];
      }),
  ) as Record<string, "passed" | "failed" | "not_compared">;
  const verdict = {
    expected,
    ok: after.error === null && (expected === "merged" || expected === "original") && Object.values(checks).every((c) => c === "passed"),
    checks,
    readError: after.error,
  };
  const bundle = {
    generatedAt: new Date().toISOString(),
    authorization: { ...a.auth, expired: a.expired },
    verdict,
    status,
    before: original ? { backupId: original.id, sha256: original.sha256, capturedAt: original.capturedAt, intact: sha256Canonical(original.payload) === original.sha256, payload: original.payload } : null,
    intended: setsEntry ? { journalId: setsEntry.id, phase: setsEntry.phase, intendedSha256: setsEntry.intendedSha256, intended: setsEntry.intended } : null,
    metadataIntended: metaEntry ? { journalId: metaEntry.id, phase: metaEntry.phase, intendedSha256: metaEntry.intendedSha256, intended: metaEntry.intended } : null,
    restore: restoreEntry ? { journalId: restoreEntry.id, phase: restoreEntry.phase, detail: restoreEntry.detail } : null,
    after: { ...after, setsSha256: afterSets !== undefined ? sha256Canonical(afterSets) : null },
    comparisons,
  };
  return { bundle, bundleSha256: sha256Canonical(bundle) };
}
