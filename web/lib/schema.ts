/**
 * The web app creates its own schema on first database use (#475).
 *
 * `src/hevy2garmin/db_postgres.py` bootstraps nine tables in `_ensure_tables`;
 * until now `web/` created none, so a web-only fork against a brand-new Neon
 * database rendered every page (reads degrade to empty) and 500'd on every
 * write ("relation app_cache does not exist"). Same statements, same order,
 * every one `IF NOT EXISTS`, so running them against a populated database is
 * a no-op.
 *
 * Runs once per process: `getDb()` makes every query wait on the memoised
 * promise, so the first write cannot race the CREATEs. It never rejects; on
 * failure it logs and lets the real query report the real error, the same
 * contract as normalizeGarminTokenRow.
 */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS synced_workouts (
     hevy_id TEXT PRIMARY KEY,
     garmin_activity_id TEXT,
     title TEXT,
     synced_at TIMESTAMPTZ DEFAULT NOW(),
     calories INTEGER,
     avg_hr INTEGER,
     status VARCHAR(20) DEFAULT 'success'
   )`,
  `CREATE TABLE IF NOT EXISTS sync_log (
     id BIGSERIAL PRIMARY KEY,
     time TIMESTAMPTZ DEFAULT NOW(),
     synced INTEGER DEFAULT 0,
     skipped INTEGER DEFAULT 0,
     failed INTEGER DEFAULT 0,
     trigger VARCHAR(50) DEFAULT 'manual'
   )`,
  `CREATE TABLE IF NOT EXISTS hr_cache (
     hevy_id TEXT PRIMARY KEY,
     data JSONB NOT NULL,
     cached_at TIMESTAMPTZ DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS pending_uploads (
     hevy_id TEXT PRIMARY KEY,
     phase TEXT NOT NULL,
     next_step TEXT,
     upload_id TEXT,
     garmin_activity_id TEXT,
     watch_activity_id TEXT,
     pre_upload_ids JSONB NOT NULL DEFAULT '[]',
     payload JSONB NOT NULL DEFAULT '{}',
     resolution_source TEXT,
     attempt_count INTEGER NOT NULL DEFAULT 0,
     delete_attempt_count INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     locked_until TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS platform_credentials (
     platform VARCHAR(50) PRIMARY KEY,
     auth_type VARCHAR(20) NOT NULL DEFAULT 'oauth',
     credentials JSONB NOT NULL DEFAULT '{}',
     connected_at TIMESTAMPTZ,
     expires_at TIMESTAMPTZ,
     status VARCHAR(20) DEFAULT 'disconnected'
   )`,
  `CREATE TABLE IF NOT EXISTS custom_mappings (
     hevy_name TEXT PRIMARY KEY,
     category INTEGER NOT NULL,
     subcategory INTEGER NOT NULL DEFAULT 0
   )`,
  // Columns added after the first release; a database bootstrapped by an older
  // Python build lacks them. Idempotent.
  `ALTER TABLE synced_workouts ADD COLUMN IF NOT EXISTS hevy_updated_at TEXT`,
  `ALTER TABLE synced_workouts ADD COLUMN IF NOT EXISTS sync_method TEXT DEFAULT 'upload'`,
  `ALTER TABLE synced_workouts ADD COLUMN IF NOT EXISTS resolution_reason TEXT`,
  `ALTER TABLE synced_workouts ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`,
  `ALTER TABLE synced_workouts ADD COLUMN IF NOT EXISTS resolution_source TEXT`,
  `ALTER TABLE synced_workouts ADD COLUMN IF NOT EXISTS resynced_at TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS app_cache (
     key TEXT PRIMARY KEY,
     value JSONB NOT NULL,
     updated_at TIMESTAMPTZ DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS synced_routines (
     hevy_routine_id TEXT PRIMARY KEY,
     garmin_workout_id TEXT,
     title TEXT,
     hevy_updated_at TEXT,
     scheduled_date TEXT,
     content_hash TEXT,
     synced_at TIMESTAMPTZ DEFAULT NOW(),
     status VARCHAR(20) DEFAULT 'success'
   )`,
  `ALTER TABLE synced_routines ADD COLUMN IF NOT EXISTS content_hash TEXT`,
  `CREATE TABLE IF NOT EXISTS routine_schedules (
     hevy_routine_id TEXT NOT NULL,
     schedule_id TEXT NOT NULL,
     scheduled_date TEXT,
     PRIMARY KEY (hevy_routine_id, schedule_id)
   )`,
  // ---- Strict in-place merge (fork-only, additive). Older code ignores these
  // tables, so a rollback to the previous build needs no down-migration. ----
  // One binding per workout AND per activity: both columns are unique.
  `CREATE TABLE IF NOT EXISTS strict_bindings (
     hevy_id TEXT PRIMARY KEY,
     garmin_activity_id BIGINT NOT NULL UNIQUE,
     state TEXT NOT NULL CHECK (state IN ('claimed', 'verified', 'needs_review')),
     lease_owner TEXT,
     lease_until TIMESTAMPTZ,
     last_journal_id TEXT,
     last_error TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS strict_backups (
     id BIGSERIAL PRIMARY KEY,
     garmin_activity_id BIGINT NOT NULL,
     hevy_id TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('original', 'pre_write')),
     payload JSONB NOT NULL,
     sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
     captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS strict_backups_one_original
     ON strict_backups (garmin_activity_id) WHERE kind = 'original'`,
  `CREATE OR REPLACE FUNCTION strict_backups_refuse_change() RETURNS trigger
     LANGUAGE plpgsql AS $$
     BEGIN
       RAISE EXCEPTION 'strict_backups is insert-only (% refused)', TG_OP;
     END
     $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'strict_backups_insert_only') THEN
       CREATE TRIGGER strict_backups_insert_only BEFORE UPDATE OR DELETE ON strict_backups
         FOR EACH ROW EXECUTE FUNCTION strict_backups_refuse_change();
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'strict_backups_no_truncate') THEN
       CREATE TRIGGER strict_backups_no_truncate BEFORE TRUNCATE ON strict_backups
         FOR EACH STATEMENT EXECUTE FUNCTION strict_backups_refuse_change();
     END IF;
   END $$`,
  `CREATE TABLE IF NOT EXISTS strict_journal (
     id BIGSERIAL PRIMARY KEY,
     hevy_id TEXT NOT NULL,
     garmin_activity_id BIGINT NOT NULL,
     step TEXT NOT NULL CHECK (step IN ('exercise_sets', 'metadata', 'restore')),
     phase TEXT NOT NULL CHECK (phase IN ('intent', 'put_sent', 'put_acknowledged', 'uncertain', 'needs_review',
                                          'verified', 'not_applied', 'restored', 'aborted', 'resolved')),
     owner TEXT NOT NULL,
     intended_sha256 TEXT NOT NULL,
     intended JSONB NOT NULL,
     backup_id TEXT NOT NULL,
     detail JSONB NOT NULL DEFAULT '{}',
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS strict_journal_open ON strict_journal (phase)
     WHERE phase IN ('intent', 'put_sent', 'put_acknowledged', 'uncertain', 'needs_review')`,
  `CREATE INDEX IF NOT EXISTS strict_journal_activity ON strict_journal (garmin_activity_id)`,
  // One in-flight write per activity, enforced by the database itself.
  `CREATE UNIQUE INDEX IF NOT EXISTS strict_journal_one_in_flight ON strict_journal (garmin_activity_id)
     WHERE phase IN ('intent', 'put_sent', 'put_acknowledged', 'uncertain')`,
  // Sync, restore and reconcile each hold the activity for their whole run.
  `CREATE TABLE IF NOT EXISTS strict_activity_locks (
     garmin_activity_id BIGINT PRIMARY KEY,
     owner TEXT NOT NULL,
     purpose TEXT NOT NULL CHECK (purpose IN ('sync', 'restore', 'reconcile')),
     lease_until TIMESTAMPTZ NOT NULL,
     acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS strict_control (
     id SMALLINT PRIMARY KEY CHECK (id = 1),
     frozen BOOLEAN NOT NULL DEFAULT FALSE,
     reason TEXT,
     updated_at TIMESTAMPTZ
   )`,
  // Gate F (lib/gate-f-run.ts): one owner-authorized activity per database. The
  // single row is claimed by one statement; once a write was journaled it is
  // done for good, so the authorization cannot be replayed or re-pointed.
  `CREATE TABLE IF NOT EXISTS strict_gate_f (
     id TEXT PRIMARY KEY CHECK (id = 'gate_f'),
     hevy_id TEXT NOT NULL,
     garmin_activity_id BIGINT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('armed', 'running', 'done')),
     attempts INTEGER NOT NULL DEFAULT 0,
     run_owner TEXT,
     started_at TIMESTAMPTZ,
     finished_at TIMESTAMPTZ,
     authorized_until TIMESTAMPTZ NOT NULL,
     last_result JSONB,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
];

/**
 * The nine tables the Python bootstrap creates; the CI empty-database job asserts on them.
 * The strict tables are listed separately in lib/strict-ledger-store.ts.
 */
export const SCHEMA_TABLES = [
  "synced_workouts", "sync_log", "hr_cache", "pending_uploads", "platform_credentials",
  "custom_mappings", "app_cache", "synced_routines", "routine_schedules",
] as const;

/** A raw-SQL runner: postgres.js `client.unsafe(text)`. */
export type UnsafeRunner = { unsafe: (text: string) => Promise<unknown> };

let ready: Promise<boolean> | null = null;

/**
 * Run the schema statements once per process. Resolves true when every
 * statement ran, false when one failed (already logged). Never rejects.
 */
export function ensureSchema(db: UnsafeRunner): Promise<boolean> {
  if (ready) return ready;
  ready = (async () => {
    for (const text of SCHEMA_STATEMENTS) {
      try {
        await db.unsafe(text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[schema] ${text.split("\n")[0].trim()} failed: ${msg}`);
        return false;
      }
    }
    return true;
  })();
  return ready;
}

/** Tests only. */
export function resetSchemaForTests(): void {
  ready = null;
}
