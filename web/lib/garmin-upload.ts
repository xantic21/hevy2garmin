/**
 * Garmin upload wrappers — the DANGEROUS half of the sync engine.
 *
 * This module is the ONLY place in the web app that can write to Garmin
 * Connect (upload a FIT, rename, set a description). A bad Garmin upload
 * creates a duplicate Garmin/Strava activity, which is a hard user constraint,
 * so every entry point here is a thin, explicit wrapper over the published
 * `hevy2garmin` package's Garmin ops — no FIT generation, no HTTP is
 * reimplemented, and nothing in this file decides WHETHER to upload.
 *
 * `getGarminClient()` READS the stored DI tokens from platform_credentials
 * (platform='garmin_tokens') via garmin-auth. Building the client performs no
 * activity write; it only authenticates. The functions that mutate Garmin
 * (`upload`, `rename`, `describe`) are called by sync-one ONLY on the live path
 * (dryRun === false). `findExistingActivity` is a READ (the 409-prevention
 * lookup) and is always safe to call.
 */
import { getDb } from "./db";
import { GarminAuth, type GarminClient } from "garmin-auth";
import { EncryptedTokenStore } from "./encrypted-token-store";
import { resolveDatabaseUrl } from "./database-url";
import { ensureStrictFirewall } from "./strict-sync";
import { strictModeActive } from "./strict-mode";
import { stagingMode } from "./staging-mode";
import { stagingGarminClient } from "./staging-simulator";

/** The DI tokens live in platform_credentials at this platform key. */
export const GARMIN_TOKEN_PLATFORM = "garmin_tokens";

let cachedClient: GarminClient | null = null;
let normalized = false;

/**
 * Self-heal the token row (#459). garmin-auth < 0.3 (Python 0.2.x) wrote the DI payload FLAT
 * ({di_token, …}); 0.3+ on both stacks writes it NESTED under `garmin_tokens`, which is the only
 * shape DBTokenStore reads. A fork whose row was written by an older deploy would be told to
 * "reconnect Garmin" for no reason. Idempotent; runs once per process; never throws.
 */
export async function normalizeGarminTokenRow(sql: ReturnType<typeof getDb>): Promise<void> {
  if (normalized) return;
  // Strict mode never uses a plaintext row (the credential vault refuses it) and
  // never writes on a read: the explicit credential migration handles the flat shape.
  if (strictModeActive()) return;
  try {
    await sql`
      UPDATE platform_credentials
         SET credentials = jsonb_build_object('garmin_tokens', credentials), auth_type = 'oauth', status = 'active'
       WHERE platform = ${GARMIN_TOKEN_PLATFORM}
         AND credentials ? 'di_token'
         AND NOT (credentials ? 'garmin_tokens')`;
    normalized = true;
  } catch { /* best effort: DBTokenStore reports the real problem if any */ }
}

/**
 * Build (and cache) an authenticated GarminClient from the DI tokens stored in
 * Postgres. Uses garmin-auth's DBTokenStore, which reads
 * platform_credentials.credentials->garmin_tokens (the NESTED shape the TS
 * stack writes). Throws when DATABASE_URL is unset or the tokens are missing /
 * need a fresh MFA login — callers surface that as a "reconnect Garmin" error.
 *
 * This authenticates only; it does not upload or mutate any activity.
 */
export async function getGarminClient(databaseUrl?: string): Promise<GarminClient> {
  // Strict mode: no Garmin client exists without the network firewall in front of it.
  ensureStrictFirewall();
  // Synthetic staging: synthetic tokens, answered by the simulator only; no credential is read.
  if (stagingMode()) return stagingGarminClient();
  if (cachedClient) return cachedClient;
  const url = databaseUrl ?? resolveDatabaseUrl();
  if (!url) throw new Error("DATABASE_URL not set (cannot load Garmin tokens)");
  const sql = getDb();
  try { await normalizeGarminTokenRow(sql); } catch { /* the token store reports the real problem */ }
  // The DI tokens are sealed (AES-256-GCM) in the row; garmin-auth sees only the TokenStore interface.
  // GarminAuth saves the tokens after validating them and after every refresh. The store writes only
  // tokens that changed (a refresh), so a dry run writes the row only when Garmin rotated the tokens
  // during it, and deletes it only when Garmin rejected them (docs/STRICT_OPERATIONS.md, "Dry run").
  const store = new EncryptedTokenStore(sql, GARMIN_TOKEN_PLATFORM);
  const auth = new GarminAuth({ store });
  cachedClient = await auth.client();
  return cachedClient;
}

/** Reset the cached client (test seam / after a token rotation). */
export function resetGarminClient(): void {
  cachedClient = null;
}
