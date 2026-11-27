/**
 * garmin-auth's TokenStore over the credential vault: the Garmin DI tokens are
 * stored sealed (AES-256-GCM) instead of as plaintext JSON. Same row and the
 * same nested `{ garmin_tokens: {...} }` shape inside the envelope, so the
 * migration of an existing plaintext row is a pure re-encoding.
 */
import type { TokenStore } from "garmin-auth";
import { canonicalJson } from "hevy2garmin";
import { peekStored, readCredentials, writeCredentials } from "./credential-vault";
import type { getDb } from "./db";

type Sql = ReturnType<typeof getDb>;

export class EncryptedTokenStore implements TokenStore {
  constructor(
    private readonly sql: Sql,
    private readonly platform: string,
  ) {}

  async load(): Promise<string | null> {
    const value = await readCredentials(this.sql, this.platform);
    if (!value) return null;
    const nested = value.garmin_tokens;
    if (nested && typeof nested === "object" && "di_token" in (nested as object)) return JSON.stringify(nested);
    if (typeof nested === "string") return nested;
    if ("di_token" in value) return JSON.stringify(value); // the flat pre-0.3 shape
    return null;
  }

  /**
   * garmin-auth saves after every successful token check, not only after a
   * refresh. Unchanged tokens on an active row are not written again, so a
   * dry run (or any read-only use) leaves the row exactly as it was; tokens
   * Garmin rotated are always written, or the login would be lost.
   */
  async save(tokens: string | Record<string, unknown>): Promise<void> {
    const payload = typeof tokens === "string" ? (JSON.parse(tokens) as Record<string, unknown>) : tokens;
    const rows = (await this.sql`SELECT credentials, status FROM platform_credentials WHERE platform = ${this.platform} LIMIT 1`) as Array<{ credentials: unknown; status: string | null }>;
    const current = rows[0] ? peekStored(this.platform, rows[0].credentials) : null;
    // Unchanged = the same tokens, nested or in the legacy flat shape a migrated row may still have.
    const unchanged = (v: Record<string, unknown>) => canonicalJson(v) === canonicalJson({ garmin_tokens: payload }) || canonicalJson(v) === canonicalJson(payload);
    if (current && current !== "plaintext" && rows[0].status === "active" && unchanged(current)) return;
    await writeCredentials(this.sql, this.platform, { garmin_tokens: payload }, { authType: "oauth", status: "active", touchConnectedAt: true });
  }

  async delete(): Promise<void> {
    await this.sql`DELETE FROM platform_credentials WHERE platform = ${this.platform}`;
  }
}
