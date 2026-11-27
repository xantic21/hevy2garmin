import postgres from "postgres";
import { ensureSchema, SCHEMA_STATEMENTS } from "./schema";
import { resolveDatabaseUrl, DATABASE_URL_HINT } from "./database-url";
import { stagingMode } from "./staging-mode";
import { ensureStagingDatabase, STAGING_SCHEMA } from "./staging-guard";
import { ensureGateFDatabase } from "./gate-f-guard";
import { gateFState } from "./gate-f";

/**
 * Tagged-template SQL function matching the @neondatabase/serverless shape
 * the ecosystem web apps are written against: `sql` returns Promise<rows[]>.
 *
 * Exposes `.json(x)` as a passthrough helper to mark values that must be sent
 * as a JSONB payload. Do NOT JSON.stringify values before `sql.json(x)` — that
 * produces a double-encoded string in the column.
 *
 * Reads the Postgres URL through `resolveDatabaseUrl`, which accepts the same
 * four variable names Python does, in the same order (#615).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

type SqlTag = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  json: <T>(value: T) => unknown;
};

let cached: SqlTag | null = null;
let rawClient: ReturnType<typeof postgres> | null = null;

export function getDb(): SqlTag {
  if (cached) return cached;
  const url = resolveDatabaseUrl();
  if (!url) {
    // Names all four, because the one a user has set is often not the one the
    // old message demanded: Vercel Storage sets POSTGRES_URL (#615).
    throw new Error(`No Postgres connection string. Set one of: ${DATABASE_URL_HINT}`);
  }
  // `onnotice` silenced: every start re-runs the idempotent schema, and each
  // CREATE ... IF NOT EXISTS would otherwise log an expected "already exists"
  // notice, burying real warnings in operations logs. Errors still throw.
  const client = postgres(url, { prepare: false, onnotice: () => {} });
  rawClient = client;

  // Every query waits for the one-time schema bootstrap (#475), so the first
  // write on a fresh database cannot outrun the CREATE TABLE statements.
  // Synthetic staging: the database guard runs first, before even the additive
  // bootstrap, and a refusal fails every query (lib/staging-guard.ts).
  // A real gate F (lib/gate-f.ts) accepts only its own new, empty database, checked the same way (lib/gate-f-guard.ts).
  const ready = () => {
    if (stagingMode()) return ensureStagingDatabase(client, () => ensureSchema(client));
    const gate = gateFState();
    if (gate.requested && gate.ok && !gate.auth.synthetic) return ensureGateFDatabase(client, () => ensureSchema(client), gate.auth);
    return ensureSchema(client);
  };
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    ready()
      .then(() => (client as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>)(strings, ...values))
      .then((rows) => Array.from(rows) as Row[])) as SqlTag;

  tag.json = <T,>(value: T) => (client as unknown as { json: (v: T) => unknown }).json(value);

  cached = tag;
  return cached;
}

/**
 * Synthetic staging only: re-run the schema (and the simulator tables) after
 * the staging seed dropped the ledger tables, which the memoised per-process
 * bootstrap would not re-create. Refused outside staging.
 */
export async function stagingRebootstrap(): Promise<void> {
  if (!stagingMode()) throw new Error("stagingRebootstrap is only available in synthetic staging");
  getDb();
  for (const s of [...SCHEMA_STATEMENTS, ...STAGING_SCHEMA]) await rawClient!.unsafe(s);
}
