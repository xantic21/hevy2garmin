/**
 * Authenticated encryption for stored credentials (Garmin DI tokens, the Hevy
 * API key, a GitHub token): `platform_credentials.credentials` holds an
 * envelope, never the secret.
 *
 *   cipher   AES-256-GCM, 96-bit random IV per write, 128-bit tag
 *   AAD      "h2g-credentials:v1:<platform>": a row copied onto another
 *            platform fails authentication instead of being misread
 *   keys     H2G_CREDENTIALS_KEY (current, base64 of 32 bytes) and
 *            H2G_CREDENTIALS_KEYS_PREVIOUS (comma-separated, decrypt only).
 *            Separate from the session secret, the cron secret, the password
 *            and the backup key; a key equal to any of them is refused.
 *   kid      the first 16 hex of SHA-256("h2g-kid:" + key), stored in the
 *            envelope so rotation knows which key opened a row
 *
 * Policy: strict mode, or any deployment that has a key, stores credentials
 * sealed only. Strict mode never uses a plaintext credential. Reads never
 * write: existing plaintext rows (and rows under a previous key) are sealed by
 * the explicit `migrateCredentials`, row by row with compare-and-set so a
 * concurrent login is never overwritten. Legacy mode with no key keeps the
 * upstream plaintext behaviour.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { getDb } from "./db";
import { strictModeActive } from "./strict-mode";

type Sql = ReturnType<typeof getDb>;
type Env = Record<string, string | undefined>;

export const ENVELOPE_VERSION = "h2g-aesgcm-v1" as const;

export interface CredentialEnvelope {
  h2g_enc: typeof ENVELOPE_VERSION;
  kid: string;
  iv: string;
  tag: string;
  ct: string;
}

export class CredentialVaultError extends Error {
  readonly code = "CREDENTIAL_VAULT";
  constructor(message: string) {
    super(message);
    this.name = "CredentialVaultError";
  }
}

interface Keyring {
  current: { kid: string; key: Buffer } | null;
  byKid: Map<string, Buffer>;
}

const kidOf = (key: Buffer) => createHash("sha256").update("h2g-kid:").update(key).digest("hex").slice(0, 16);

function decodeKey(raw: string, name: string): Buffer {
  const key = Buffer.from(raw.trim().replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== 32) throw new CredentialVaultError(`${name} must be base64 of exactly 32 random bytes`);
  return key;
}

/** The keys from the environment. Throws on a malformed or re-used key: fail closed. */
export function loadKeyring(env: Env = process.env): Keyring {
  const byKid = new Map<string, Buffer>();
  const currentRaw = env.H2G_CREDENTIALS_KEY?.trim();
  let current: Keyring["current"] = null;
  if (currentRaw) {
    for (const other of ["HEVY2GARMIN_SECRET", "H2G_SECRET", "CRON_SECRET", "H2G_PASSWORD", "H2G_BACKUP_KEY"]) {
      if (env[other]?.trim() && env[other]!.trim() === currentRaw) {
        throw new CredentialVaultError(`H2G_CREDENTIALS_KEY must be its own secret, not the same value as ${other}`);
      }
    }
    const key = decodeKey(currentRaw, "H2G_CREDENTIALS_KEY");
    current = { kid: kidOf(key), key };
    byKid.set(current.kid, key);
  }
  for (const raw of (env.H2G_CREDENTIALS_KEYS_PREVIOUS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const key = decodeKey(raw, "H2G_CREDENTIALS_KEYS_PREVIOUS");
    byKid.set(kidOf(key), key);
  }
  return { current, byKid };
}

/** Plaintext is acceptable only in legacy mode with no key at all. */
export function encryptionRequired(env: Env = process.env): boolean {
  return strictModeActive(env) || Boolean(env.H2G_CREDENTIALS_KEY?.trim());
}

const aad = (platform: string) => Buffer.from(`h2g-credentials:v1:${platform}`, "utf8");

export function isEnvelope(v: unknown): v is CredentialEnvelope {
  const e = v as Partial<CredentialEnvelope> | null;
  return Boolean(e && typeof e === "object" && e.h2g_enc === ENVELOPE_VERSION && typeof e.ct === "string" && typeof e.iv === "string" && typeof e.tag === "string" && typeof e.kid === "string");
}

export function seal(platform: string, value: Record<string, unknown>, ring: Keyring = loadKeyring()): CredentialEnvelope {
  if (!ring.current) throw new CredentialVaultError("H2G_CREDENTIALS_KEY is not set; credentials cannot be stored");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ring.current.key, iv);
  cipher.setAAD(aad(platform));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    h2g_enc: ENVELOPE_VERSION,
    kid: ring.current.kid,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

export function open(platform: string, envelope: CredentialEnvelope, ring: Keyring = loadKeyring()): Record<string, unknown> {
  const key = ring.byKid.get(envelope.kid);
  if (!key) throw new CredentialVaultError(`no key for credential key id ${envelope.kid}; add it to H2G_CREDENTIALS_KEYS_PREVIOUS`);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(aad(platform));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const pt = Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64")), decipher.final()]);
    const value = JSON.parse(pt.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new CredentialVaultError(`credential for ${platform} failed authentication (wrong key, wrong row or tampered)`);
  }
}

const parse = (raw: unknown): unknown => {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * One platform's credentials, decrypted, or null when there is no row.
 *
 * A read never writes: migration and rotation are the explicit
 * `migrateCredentials` (POST /api/strict/credentials), so a dry run or a status
 * page cannot change a credential row. A row under a previous key still opens.
 * Strict mode refuses to USE a plaintext credential at all, key or not: the
 * operator encrypts first, and the status panel says so.
 */
export async function readCredentials(sql: Sql, platform: string, env: Env = process.env): Promise<Record<string, unknown> | null> {
  const rows = (await sql`SELECT credentials FROM platform_credentials WHERE platform = ${platform} LIMIT 1`) as Array<{ credentials: unknown }>;
  if (!rows.length) return null;
  const stored = parse(rows[0].credentials);
  const ring = loadKeyring(env);
  if (isEnvelope(stored)) return open(platform, stored, ring);
  const value = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  if (strictModeActive(env) && Object.keys(value).length) {
    throw new CredentialVaultError(
      ring.current
        ? `plaintext ${platform} credentials found; encrypt them first (dashboard "Encrypt stored credentials", or POST /api/strict/credentials)`
        : `plaintext ${platform} credentials found; set H2G_CREDENTIALS_KEY and encrypt them before use`,
    );
  }
  return value;
}

/**
 * Replace the stored value only if it is still exactly `previous` (jsonb
 * equality). `previous` is what the driver returned; a driver that hands back
 * jsonb as text is matched on the parsed value as well.
 */
async function compareAndSet(sql: Sql, platform: string, previous: unknown, next: CredentialEnvelope): Promise<boolean> {
  const rows = (await sql`
    UPDATE platform_credentials SET credentials = ${sql.json(next)}
    WHERE platform = ${platform}
      AND (credentials = ${sql.json(previous)}::jsonb OR credentials = ${sql.json(parse(previous))}::jsonb)
    RETURNING platform
  `) as unknown[];
  return rows.length === 1;
}

/**
 * What a stored value can be used as, without touching the database: the
 * decrypted value of an envelope that opens, `"plaintext"` for an unsealed
 * object that is usable here, or null (no value, a sealed value that does not
 * open, or plaintext that strict mode without a key refuses). Never throws.
 */
export function peekStored(platform: string, raw: unknown, env: Env = process.env): Record<string, unknown> | "plaintext" | null {
  try {
    const v = parse(raw);
    const ring = loadKeyring(env);
    if (isEnvelope(v)) return open(platform, v, ring);
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    if (strictModeActive(env)) return null; // strict mode never uses a plaintext credential
    return "plaintext";
  } catch {
    return null;
  }
}

/** Throws unless a credential could be stored right now. Checked before a login or a key probe, so nobody signs in for nothing. */
export function assertVaultWritable(env: Env = process.env): void {
  const ring = loadKeyring(env);
  if (!ring.current && encryptionRequired(env)) {
    throw new CredentialVaultError("H2G_CREDENTIALS_KEY is not set; refusing to store a credential in plaintext");
  }
}

/** Store credentials: sealed when a key is configured; refused in plaintext where encryption is required. */
export async function writeCredentials(
  sql: Sql,
  platform: string,
  value: Record<string, unknown>,
  meta: { authType: string; status?: string; touchConnectedAt?: boolean },
  env: Env = process.env,
): Promise<void> {
  const ring = loadKeyring(env);
  let stored: unknown;
  if (ring.current) stored = seal(platform, value, ring);
  else if (encryptionRequired(env)) throw new CredentialVaultError("H2G_CREDENTIALS_KEY is not set; refusing to store a credential in plaintext");
  else stored = value;
  const status = meta.status ?? "active";
  if (meta.touchConnectedAt) {
    await sql`
      INSERT INTO platform_credentials (platform, auth_type, credentials, status, connected_at)
      VALUES (${platform}, ${meta.authType}, ${sql.json(stored)}, ${status}, NOW())
      ON CONFLICT (platform) DO UPDATE SET auth_type = EXCLUDED.auth_type, credentials = EXCLUDED.credentials,
        status = EXCLUDED.status, connected_at = EXCLUDED.connected_at
    `;
  } else {
    await sql`
      INSERT INTO platform_credentials (platform, auth_type, credentials, status)
      VALUES (${platform}, ${meta.authType}, ${sql.json(stored)}, ${status})
      ON CONFLICT (platform) DO UPDATE SET auth_type = EXCLUDED.auth_type, credentials = EXCLUDED.credentials, status = EXCLUDED.status
    `;
  }
}

export interface VaultReport {
  configured: boolean;
  currentKid: string | null;
  rows: number;
  encryptedCurrent: number;
  encryptedPrevious: number;
  plaintext: number;
  unreadable: string[];
}

/** Counts only; never decrypts. For the status panel. */
export async function vaultStatus(sql: Sql, env: Env = process.env): Promise<VaultReport> {
  let ring: Keyring;
  try {
    ring = loadKeyring(env);
  } catch (e) {
    return { configured: false, currentKid: null, rows: 0, encryptedCurrent: 0, encryptedPrevious: 0, plaintext: 0, unreadable: [(e as Error).message] };
  }
  const rows = (await sql`SELECT platform, credentials FROM platform_credentials`.catch(() => [])) as Array<{ platform: string; credentials: unknown }>;
  const r: VaultReport = { configured: Boolean(ring.current), currentKid: ring.current?.kid ?? null, rows: rows.length, encryptedCurrent: 0, encryptedPrevious: 0, plaintext: 0, unreadable: [] };
  for (const row of rows) {
    const v = parse(row.credentials);
    if (isEnvelope(v)) {
      if (v.kid === ring.current?.kid) r.encryptedCurrent += 1;
      else if (ring.byKid.has(v.kid)) r.encryptedPrevious += 1;
      else r.unreadable.push(row.platform);
    } else if (v && typeof v === "object" && Object.keys(v as object).length) {
      r.plaintext += 1;
    }
  }
  return r;
}

/**
 * Encrypt every plaintext row and re-encrypt every row under a previous key
 * with the current one (migration and rotation are the same operation).
 * Each row is a compare-and-set; a row that cannot be opened is reported and
 * left untouched.
 */
export async function migrateCredentials(sql: Sql, env: Env = process.env): Promise<{ encrypted: string[]; rotated: string[]; unchanged: string[]; failed: string[] }> {
  const ring = loadKeyring(env);
  if (!ring.current) throw new CredentialVaultError("H2G_CREDENTIALS_KEY is not set; nothing can be encrypted");
  const out = { encrypted: [] as string[], rotated: [] as string[], unchanged: [] as string[], failed: [] as string[] };
  const rows = (await sql`SELECT platform, credentials FROM platform_credentials ORDER BY platform`) as Array<{ platform: string; credentials: unknown }>;
  for (const row of rows) {
    const v = parse(row.credentials);
    try {
      if (isEnvelope(v)) {
        if (v.kid === ring.current.kid) {
          out.unchanged.push(row.platform);
          continue;
        }
        const value = open(row.platform, v, ring);
        if (await compareAndSet(sql, row.platform, row.credentials, seal(row.platform, value, ring))) out.rotated.push(row.platform);
        else out.failed.push(row.platform);
      } else {
        const value = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
        if (await compareAndSet(sql, row.platform, row.credentials, seal(row.platform, value, ring))) out.encrypted.push(row.platform);
        else out.failed.push(row.platform);
      }
    } catch {
      out.failed.push(row.platform);
    }
  }
  return out;
}
