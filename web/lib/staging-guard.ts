/**
 * The staging database guard. In synthetic staging every query waits on this
 * (lib/db.ts), so a staging deployment pointed at the wrong database reads
 * and writes nothing at all.
 *
 *  - Checked BEFORE the schema bootstrap: a database is accepted only when it
 *    holds no credential and no non-synthetic sync history, ledger, pending
 *    upload or routine. Every synthetic id starts with `syn-`.
 *  - It is then marked (`app_cache` key `h2g_staging`, for the operator).
 *  - The simulator's own tables are created here, never in production.
 *
 * Memoised per process; a refusal is memoised too (fail closed until restart).
 */
import { STAGING_MARKER_KEY, StagingIsolationError } from "./staging-mode";

type Client = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  unsafe: (text: string, params?: any[]) => PromiseLike<unknown>;
};

export const STAGING_TABLES = ["staging_hevy_workouts", "staging_garmin_activities", "staging_requests"] as const;

/** Every table of the app (web/lib/schema.ts and the strict ledger). */
const USER_TABLES = [
  "synced_workouts", "sync_log", "hr_cache", "pending_uploads", "platform_credentials", "custom_mappings", "app_cache",
  "synced_routines", "routine_schedules", "strict_bindings", "strict_backups", "strict_journal", "strict_control", "strict_activity_locks",
] as const;

export const STAGING_SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS staging_hevy_workouts (
     id TEXT PRIMARY KEY CHECK (id LIKE 'syn-%'),
     payload JSONB NOT NULL,
     start_time TIMESTAMPTZ NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS staging_garmin_activities (
     activity_id BIGINT PRIMARY KEY CHECK (activity_id BETWEEN 9100000 AND 9199999),
     summary JSONB NOT NULL,
     detail JSONB NOT NULL,
     sets JSONB NOT NULL,
     quirk TEXT CHECK (quirk IS NULL OR quirk IN ('drop_names', 'lose_response', 'blackout', 'reject')),
     start_gmt TIMESTAMPTZ NOT NULL,
     reads_fail_until TIMESTAMPTZ
   )`,
  `CREATE TABLE IF NOT EXISTS staging_requests (
     id BIGSERIAL PRIMARY KEY,
     at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     method TEXT NOT NULL,
     host TEXT NOT NULL,
     path TEXT NOT NULL,
     status INTEGER NOT NULL,
     note TEXT
   )`,
];

let checked: Promise<void> | null = null;

const rowsOf = (r: unknown) => Array.from(r as ArrayLike<Record<string, unknown>>);

async function count(client: Client, table: string, where = ""): Promise<number> {
  const [reg] = rowsOf(await client.unsafe(`SELECT to_regclass($1) AS r`, [`public.${table}`]));
  if (!reg?.r) return 0;
  const [row] = rowsOf(await client.unsafe(`SELECT count(*)::int AS n FROM ${table} ${where}`));
  return Number(row?.n ?? 0);
}

/**
 * Runs BEFORE the schema bootstrap, so a staging deployment pointed at a
 * production database refuses before it changes anything there, not even an
 * additive CREATE. `bootstrap` is the normal schema bootstrap.
 */
export async function checkStagingDatabase(client: Client, bootstrap: () => Promise<unknown>): Promise<void> {
  const credentials = await count(client, "platform_credentials");
  if (credentials > 0) {
    throw new StagingIsolationError(`refusing: this database holds ${credentials} stored credential row(s); synthetic staging needs its own empty database`);
  }
  const marked = (await count(client, "app_cache", `WHERE key = '${STAGING_MARKER_KEY}'`)) > 0;
  if (!marked) {
    // Never used by staging: it must hold nothing at all, in any table of the app.
    let rows = 0;
    for (const t of USER_TABLES) rows += await count(client, t);
    if (rows > 0) {
      throw new StagingIsolationError(`refusing: this database holds ${rows} row(s) and is not a staging database; synthetic staging needs its own empty database`);
    }
  } else {
    // A staging database: only synthetic workouts (ids "syn-…") may ever appear in it.
    const foreign =
      (await count(client, "synced_workouts", "WHERE hevy_id NOT LIKE 'syn-%'")) +
      (await count(client, "strict_bindings", "WHERE hevy_id NOT LIKE 'syn-%'")) +
      (await count(client, "strict_backups", "WHERE hevy_id NOT LIKE 'syn-%'")) +
      (await count(client, "strict_journal", "WHERE hevy_id NOT LIKE 'syn-%'")) +
      (await count(client, "hr_cache", "WHERE hevy_id NOT LIKE 'syn-%'")) +
      (await count(client, "pending_uploads")) +
      (await count(client, "synced_routines")) +
      (await count(client, "routine_schedules"));
    if (foreign > 0) {
      throw new StagingIsolationError(`refusing: the staging database holds ${foreign} non-synthetic row(s)`);
    }
  }
  await bootstrap();
  for (const st of STAGING_SCHEMA) await client.unsafe(st);
  // The object itself, not a JSON string: the driver serialises it for the jsonb parameter.
  await client.unsafe(`INSERT INTO app_cache (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [
    STAGING_MARKER_KEY,
    { synthetic: true, markedAt: new Date().toISOString() },
  ]);
}

export function ensureStagingDatabase(client: Client, bootstrap: () => Promise<unknown>): Promise<void> {
  if (!checked) checked = checkStagingDatabase(client, bootstrap);
  return checked;
}

/** Tests only. */
export function resetStagingGuardForTests(): void {
  checked = null;
}
