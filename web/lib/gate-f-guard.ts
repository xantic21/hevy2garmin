/**
 * The gate F database guard. A real gate F runs against its own, new, empty
 * database (STRICT_OPERATIONS.md §8), never the legacy production database
 * and never the staging database. Checked BEFORE the schema bootstrap, like
 * the staging guard: an unmarked database must hold no row in any table of
 * the app; it is then marked (`app_cache` key `h2g_gate_f`). A marked database
 * is accepted (it holds the gate F credentials and ledger by then).
 *
 * Memoised per process; a refusal is memoised too (fail closed until restart).
 */
import { count, USER_TABLES, type Client } from "./staging-guard";

export const GATE_F_MARKER_KEY = "h2g_gate_f";

export class GateFDatabaseError extends Error {
  readonly code = "GATE_F_DATABASE";
  constructor(message: string) {
    super(message);
    this.name = "GateFDatabaseError";
  }
}

let checked: Promise<void> | null = null;

export async function checkGateFDatabase(client: Client, bootstrap: () => Promise<unknown>, auth: { hevyId: string; activityId: number }): Promise<void> {
  const marked = (await count(client, "app_cache", `WHERE key = '${GATE_F_MARKER_KEY}'`)) > 0;
  if (!marked) {
    let rows = 0;
    for (const t of USER_TABLES) rows += await count(client, t);
    if (rows > 0) {
      throw new GateFDatabaseError(`refusing: this database holds ${rows} row(s) and is not the gate F database; gate F needs its own new, empty database`);
    }
  }
  await bootstrap();
  if (!marked) {
    // The object itself, not a JSON string: the driver serialises it for the jsonb parameter.
    await client.unsafe(`INSERT INTO app_cache (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [
      GATE_F_MARKER_KEY,
      { gateF: true, hevyId: auth.hevyId, activityId: auth.activityId, markedAt: new Date().toISOString() },
    ]);
  }
}

export function ensureGateFDatabase(client: Client, bootstrap: () => Promise<unknown>, auth: { hevyId: string; activityId: number }): Promise<void> {
  if (!checked) checked = checkGateFDatabase(client, bootstrap, auth);
  return checked;
}

/** Tests only. */
export function resetGateFGuardForTests(): void {
  checked = null;
}
