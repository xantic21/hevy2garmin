/**
 * The strict ledger on Postgres. Atomicity comes from single statements:
 *  - a claim is one INSERT ... ON CONFLICT DO NOTHING (both ids are unique),
 *    or one conditional UPDATE that takes over an expired lease of the SAME
 *    pair; no read-then-write anywhere;
 *  - an `original` backup is guarded by a partial unique index, and the table
 *    refuses UPDATE, DELETE and TRUNCATE with a trigger (schema.ts);
 *  - a journal transition is one UPDATE ... WHERE phase = ANY(from).
 *
 * Satisfies STRICT_LEDGER_CONTRACT (lib/strict-ledger-store.db.test.ts).
 */
import { JournalConflictError } from "hevy2garmin";
import type {
  ActivityLock,
  BindingState,
  ClaimOutcome,
  LockOutcome,
  JournalPhase,
  StrictBackup,
  StrictBinding,
  StrictControl,
  StrictJournalEntry,
  StrictLedger,
} from "hevy2garmin";
import type { Sql } from "./pending-store";

type Row = Record<string, unknown>;

const iso = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

const json = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);

function binding(r: Row): StrictBinding {
  return {
    hevyId: String(r.hevy_id),
    garminActivityId: Number(r.garmin_activity_id),
    state: String(r.state) as BindingState,
    leaseOwner: (r.lease_owner as string | null) ?? null,
    leaseUntil: iso(r.lease_until),
    lastJournalId: (r.last_journal_id as string | null) ?? null,
    lastError: (r.last_error as string | null) ?? null,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

function backup(r: Row): StrictBackup {
  return {
    id: String(r.id),
    garminActivityId: Number(r.garmin_activity_id),
    hevyId: String(r.hevy_id),
    kind: String(r.kind) as StrictBackup["kind"],
    payload: json(r.payload),
    sha256: String(r.sha256),
    capturedAt: iso(r.captured_at)!,
  };
}

function entry(r: Row): StrictJournalEntry {
  return {
    id: String(r.id),
    hevyId: String(r.hevy_id),
    garminActivityId: Number(r.garmin_activity_id),
    step: String(r.step) as StrictJournalEntry["step"],
    phase: String(r.phase) as JournalPhase,
    owner: String(r.owner),
    intendedSha256: String(r.intended_sha256),
    intended: json(r.intended),
    backupId: String(r.backup_id),
    detail: (json(r.detail) as Record<string, unknown>) ?? {},
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
  };
}

const OPEN = ["intent", "put_sent", "put_acknowledged", "uncertain", "needs_review"];

function lockRow(r: Row): ActivityLock {
  return {
    garminActivityId: Number(r.garmin_activity_id),
    owner: String(r.owner),
    purpose: String(r.purpose) as ActivityLock["purpose"],
    leaseUntil: iso(r.lease_until)!,
    acquiredAt: iso(r.acquired_at)!,
  };
}

const isUniqueViolation = (e: unknown, constraint: string) =>
  (e as { code?: string; constraint_name?: string; constraint?: string })?.code === "23505" &&
  [((e as { constraint_name?: string }).constraint_name ?? ""), ((e as { constraint?: string }).constraint ?? ""), String((e as Error).message)].some((x) => x.includes(constraint));

export function postgresStrictLedger(sql: Sql): StrictLedger {
  const patchBinding = async (
    where: { hevyId: string; owner: string | null },
    patch: Partial<Pick<StrictBinding, "state" | "lastJournalId" | "lastError">>,
    release: boolean,
  ): Promise<boolean> => {
    const hasState = patch.state !== undefined;
    const hasJournal = patch.lastJournalId !== undefined;
    const hasError = patch.lastError !== undefined;
    const rows = await sql`
      UPDATE strict_bindings SET
        state = CASE WHEN ${hasState} THEN ${patch.state ?? null}::text ELSE state END,
        last_journal_id = CASE WHEN ${hasJournal} THEN ${patch.lastJournalId ?? null}::text ELSE last_journal_id END,
        last_error = CASE WHEN ${hasError} THEN ${patch.lastError ?? null}::text ELSE last_error END,
        lease_owner = CASE WHEN ${release} THEN NULL ELSE lease_owner END,
        lease_until = CASE WHEN ${release} THEN NULL ELSE lease_until END,
        updated_at = NOW()
      WHERE hevy_id = ${where.hevyId}
        AND (${where.owner}::text IS NULL OR lease_owner = ${where.owner})
      RETURNING hevy_id
    `;
    return rows.length === 1;
  };

  return {
    async getBindingByHevy(hevyId) {
      const rows = await sql`SELECT * FROM strict_bindings WHERE hevy_id = ${hevyId}`;
      return rows[0] ? binding(rows[0]) : null;
    },
    async getBindingByActivity(activityId) {
      const rows = await sql`SELECT * FROM strict_bindings WHERE garmin_activity_id = ${activityId}`;
      return rows[0] ? binding(rows[0]) : null;
    },
    async listBindings() {
      return (await sql`SELECT * FROM strict_bindings ORDER BY created_at`).map(binding);
    },
    async claimBinding({ hevyId, activityId, owner, now, leaseMs }): Promise<ClaimOutcome> {
      const until = new Date(now.getTime() + leaseMs);
      const inserted = await sql`
        INSERT INTO strict_bindings (hevy_id, garmin_activity_id, state, lease_owner, lease_until, created_at, updated_at)
        VALUES (${hevyId}, ${activityId}, 'claimed', ${owner}, ${until}, ${now}, ${now})
        ON CONFLICT DO NOTHING
        RETURNING *
      `;
      if (inserted[0]) return { ok: true, binding: binding(inserted[0]), created: true };
      const resumed = await sql`
        UPDATE strict_bindings
        SET lease_owner = ${owner}, lease_until = ${until}, updated_at = ${now}
        WHERE hevy_id = ${hevyId} AND garmin_activity_id = ${activityId}
          AND state <> 'needs_review'
          AND (lease_owner IS NULL OR lease_owner = ${owner} OR lease_until IS NULL OR lease_until <= ${now})
        RETURNING *
      `;
      if (resumed[0]) return { ok: true, binding: binding(resumed[0]), created: false };
      const mine = (await sql`SELECT * FROM strict_bindings WHERE hevy_id = ${hevyId}`)[0];
      const theirs = (await sql`SELECT * FROM strict_bindings WHERE garmin_activity_id = ${activityId}`)[0];
      if (mine && Number(mine.garmin_activity_id) !== activityId) {
        return { ok: false, reason: "hevy_bound_elsewhere", binding: binding(mine) };
      }
      if (theirs && String(theirs.hevy_id) !== hevyId) {
        return { ok: false, reason: "activity_bound_elsewhere", binding: binding(theirs) };
      }
      if (mine && mine.state === "needs_review") return { ok: false, reason: "needs_review", binding: binding(mine) };
      return { ok: false, reason: "lease_held", binding: mine ? binding(mine) : null };
    },
    updateBinding: (hevyId, owner, patch) => patchBinding({ hevyId, owner }, patch, false),
    releaseBinding: (hevyId, owner, patch = {}) => patchBinding({ hevyId, owner }, patch, true),
    setBindingState: (hevyId, state, lastError) => patchBinding({ hevyId, owner: null }, { state, lastError }, false),

    async saveBackup(input) {
      if (input.kind === "original") {
        const rows = await sql`
          INSERT INTO strict_backups (garmin_activity_id, hevy_id, kind, payload, sha256)
          VALUES (${input.garminActivityId}, ${input.hevyId}, 'original', ${sql.json(input.payload)}, ${input.sha256})
          ON CONFLICT (garmin_activity_id) WHERE kind = 'original' DO NOTHING
          RETURNING *
        `;
        if (rows[0]) return backup(rows[0]);
        const existing = await sql`
          SELECT * FROM strict_backups WHERE garmin_activity_id = ${input.garminActivityId} AND kind = 'original'
        `;
        return backup(existing[0]);
      }
      const rows = await sql`
        INSERT INTO strict_backups (garmin_activity_id, hevy_id, kind, payload, sha256)
        VALUES (${input.garminActivityId}, ${input.hevyId}, 'pre_write', ${sql.json(input.payload)}, ${input.sha256})
        RETURNING *
      `;
      return backup(rows[0]);
    },
    async getBackup(id) {
      if (!/^\d+$/.test(id)) return null;
      const rows = await sql`SELECT * FROM strict_backups WHERE id = ${id}`;
      return rows[0] ? backup(rows[0]) : null;
    },
    async getOriginalBackup(activityId) {
      const rows = await sql`SELECT * FROM strict_backups WHERE garmin_activity_id = ${activityId} AND kind = 'original'`;
      return rows[0] ? backup(rows[0]) : null;
    },

    async openJournal(input) {
      try {
        const rows = await sql`
          INSERT INTO strict_journal (hevy_id, garmin_activity_id, step, phase, owner, intended_sha256, intended, backup_id, detail)
          VALUES (${input.hevyId}, ${input.garminActivityId}, ${input.step}, 'intent', ${input.owner},
                  ${input.intendedSha256}, ${sql.json(input.intended)}, ${input.backupId}, ${sql.json(input.detail ?? {})})
          RETURNING *
        `;
        return entry(rows[0]);
      } catch (e) {
        if (isUniqueViolation(e, "strict_journal_one_in_flight")) throw new JournalConflictError(input.garminActivityId);
        throw e;
      }
    },
    async advanceJournal(id, from, to, detail) {
      if (!/^\d+$/.test(id)) return false;
      const rows = await sql`
        UPDATE strict_journal
        SET phase = ${to}, updated_at = NOW(), detail = detail || ${sql.json(detail ?? {})}::jsonb
        WHERE id = ${id} AND phase = ANY(${from as string[]})
        RETURNING id
      `;
      return rows.length === 1;
    },
    async getJournal(id) {
      if (!/^\d+$/.test(id)) return null;
      const rows = await sql`SELECT * FROM strict_journal WHERE id = ${id}`;
      return rows[0] ? entry(rows[0]) : null;
    },
    async listOpenJournal() {
      return (await sql`SELECT * FROM strict_journal WHERE phase = ANY(${OPEN}) ORDER BY id`).map(entry);
    },
    async listJournalForActivity(activityId) {
      return (await sql`SELECT * FROM strict_journal WHERE garmin_activity_id = ${activityId} ORDER BY id`).map(entry);
    },

    async getControl(): Promise<StrictControl> {
      const rows = await sql`SELECT frozen, reason, updated_at FROM strict_control WHERE id = 1`;
      const r = rows[0];
      return r ? { frozen: Boolean(r.frozen), reason: (r.reason as string | null) ?? null, updatedAt: iso(r.updated_at) } : { frozen: false, reason: null, updatedAt: null };
    },
    async setFrozen(frozen, reason) {
      await sql`
        INSERT INTO strict_control (id, frozen, reason, updated_at) VALUES (1, ${frozen}, ${reason}, NOW())
        ON CONFLICT (id) DO UPDATE SET frozen = EXCLUDED.frozen, reason = EXCLUDED.reason, updated_at = NOW()
      `;
    },

    async acquireActivityLock({ activityId, owner, purpose, now, leaseMs }): Promise<LockOutcome> {
      const until = new Date(now.getTime() + leaseMs);
      // One statement: insert, or take over an expired lease, or extend one's own.
      const rows = await sql`
        INSERT INTO strict_activity_locks (garmin_activity_id, owner, purpose, lease_until, acquired_at)
        VALUES (${activityId}, ${owner}, ${purpose}, ${until}, ${now})
        ON CONFLICT (garmin_activity_id) DO UPDATE
          SET owner = EXCLUDED.owner, purpose = EXCLUDED.purpose, lease_until = EXCLUDED.lease_until, acquired_at = EXCLUDED.acquired_at
          WHERE strict_activity_locks.lease_until <= ${now} OR strict_activity_locks.owner = EXCLUDED.owner
        RETURNING *
      `;
      if (rows[0]) return { ok: true, lock: lockRow(rows[0]) };
      const held = await sql`SELECT * FROM strict_activity_locks WHERE garmin_activity_id = ${activityId}`;
      return { ok: false, heldBy: held[0] ? lockRow(held[0]) : null };
    },
    async releaseActivityLock(activityId, owner) {
      const rows = await sql`
        DELETE FROM strict_activity_locks WHERE garmin_activity_id = ${activityId} AND owner = ${owner} RETURNING garmin_activity_id
      `;
      return rows.length === 1;
    },
    async getActivityLock(activityId) {
      const rows = await sql`SELECT * FROM strict_activity_locks WHERE garmin_activity_id = ${activityId}`;
      return rows[0] ? lockRow(rows[0]) : null;
    },
  };
}

/** The strict tables and their safety constraints, as schema.ts creates them. */
export const STRICT_SCHEMA_TABLES = [
  "strict_bindings",
  "strict_backups",
  "strict_journal",
  "strict_control",
  "strict_activity_locks",
] as const;

/**
 * Live strict writes require the full schema, including the insert-only
 * trigger on backups. A database where it could not be created (missing
 * privilege, partial migration) blocks live writes instead of running with
 * mutable backups.
 */
export async function strictSchemaReady(sql: Sql): Promise<{ ready: boolean; missing: string[] }> {
  const missing: string[] = [];
  try {
    for (const t of STRICT_SCHEMA_TABLES) {
      const rows = await sql`SELECT to_regclass(${`public.${t}`}) AS r`;
      if (!rows[0]?.r) missing.push(`table ${t}`);
    }
    const trig = await sql`SELECT tgname FROM pg_trigger WHERE tgname IN ('strict_backups_insert_only', 'strict_backups_no_truncate')`;
    const names = new Set(trig.map((r) => String(r.tgname)));
    if (!names.has("strict_backups_insert_only")) missing.push("trigger strict_backups_insert_only");
    if (!names.has("strict_backups_no_truncate")) missing.push("trigger strict_backups_no_truncate");
    for (const index of ["strict_backups_one_original", "strict_journal_one_in_flight"]) {
      const idx = await sql`SELECT to_regclass(${`public.${index}`}) AS r`;
      if (!idx[0]?.r) missing.push(`index ${index}`);
    }
  } catch (e) {
    missing.push(`schema check failed: ${(e as Error).message}`);
  }
  return { ready: missing.length === 0, missing };
}
