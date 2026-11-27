import type { getDb } from "./db";
import { ifNoTable } from "./missing-table";
import { peekStored } from "./credential-vault";

type Sql = ReturnType<typeof getDb>;

export interface Connection {
  connected: boolean;
  connectedAt: string | null;
}

const DISCONNECTED: Connection = { connected: false, connectedAt: null };

/**
 * Which platform_credentials row means what:
 *
 *   platform='hevy'          the API key, written by the setup form
 *   platform='garmin'        the Garmin email/password pair, written by the Python setup form only
 *   platform='garmin_tokens' the DI tokens, written by every Garmin login (Python and web)
 *
 * Garmin connectivity has to come from `garmin_tokens`. A web login writes only that row, so
 * pages that looked at `garmin` reported a working login as "Not connected" and stayed that way
 * until the user hand-copied the row (hevy2garmin#495).
 *
 * It also has to come from the stored token rather than the `status` column. DBTokenStore's
 * upsert sets status='active' on INSERT but not in its DO UPDATE branch, so a row first created
 * by anything else keeps the schema default 'disconnected' through every later login. Reading the
 * token itself is true whenever a sync would actually work, which is what the badge claims.
 *
 * Both token shapes count: 0.3+ nests the DI payload under `garmin_tokens`, older Python logins
 * wrote it flat. healGarminTokenRow migrates a flat row, but only during a sync.
 */
export async function loadGarminConnection(sql: Sql): Promise<Connection> {
  const rows = await sql`
    SELECT connected_at,
           (jsonb_exists(credentials -> 'garmin_tokens', 'di_token')
            OR jsonb_exists(credentials, 'di_token')) AS has_token,
           credentials
    FROM platform_credentials
    WHERE platform = 'garmin_tokens'
  `.catch(ifNoTable([] as Array<{ connected_at: string | null; has_token: boolean | null; credentials?: unknown }>));
  const row = rows[0];
  if (!row || !usable("garmin_tokens", row, (v) => hasDiToken(v.garmin_tokens) || "di_token" in v)) return DISCONNECTED;
  return { connected: true, connectedAt: row.connected_at ?? null };
}

const hasDiToken = (v: unknown) => Boolean(v && typeof v === "object" && "di_token" in (v as object));

/**
 * The credential vault seals the row (credential-vault.ts), so SQL cannot see
 * inside it: a sealed row counts when it opens with the configured keys and
 * holds the token; a plaintext row counts by the SQL test, unless strict mode
 * without a key would refuse to use it.
 */
function usable(platform: string, row: { credentials?: unknown; [k: string]: unknown }, holds: (v: Record<string, unknown>) => boolean): boolean {
  const flag = Boolean(row.has_token ?? row.has_key);
  if (row.credentials === undefined) return flag;
  const peek = peekStored(platform, row.credentials);
  if (peek === null) return false;
  if (peek === "plaintext") return flag;
  return holds(peek);
}

/**
 * Hevy is connected when a key is available and has not been rejected. The key comes from
 * HEVY_API_KEY or the credential row, in the order the sync resolves it (lib/hevy-sync.ts), so
 * a deployment that sets the key in its environment is connected without a row. A
 * row marked 'disconnected' (Hevy rejected the key, #605) wins either way. The setup form
 * writes status='active', so testing for the literal 'connected' never matches.
 */
export async function loadHevyConnection(sql: Sql): Promise<Connection> {
  const fromEnv = Boolean(process.env.HEVY_API_KEY?.trim());
  const rows = await sql`
    SELECT status, connected_at, jsonb_exists(credentials, 'api_key') AS has_key, credentials
    FROM platform_credentials
    WHERE platform = 'hevy'
  `.catch(ifNoTable([] as Array<{ status: string | null; connected_at: string | null; has_key: boolean | null; credentials?: unknown }>));
  const row = rows[0];
  if (row?.status === "disconnected") return DISCONNECTED;
  const stored = row ? usable("hevy", row, (v) => typeof v.api_key === "string" && v.api_key.trim() !== "") : false;
  if (!fromEnv && !stored) return DISCONNECTED;
  return { connected: true, connectedAt: row?.connected_at ?? null };
}
