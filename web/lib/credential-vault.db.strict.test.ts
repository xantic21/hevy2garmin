import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import { GarminAuth } from "garmin-auth";
import { SCHEMA_STATEMENTS } from "./schema";
import type { Sql } from "./pending-store";
import { createScratchDatabase } from "./test-scratch-db";
import { CredentialVaultError, migrateCredentials, readCredentials, vaultStatus, writeCredentials } from "./credential-vault";
import { EncryptedTokenStore } from "./encrypted-token-store";
import { loadGarminConnection, loadHevyConnection } from "./connections";

/**
 * The credential vault against real Postgres, synthetic secrets only: what is
 * stored at rest, lazy and explicit migration of existing plaintext rows,
 * rotation, compare-and-set under a concurrent writer, the strict refusals,
 * and garmin-auth driving the encrypted token store.
 */
const url = process.env.TEST_DATABASE_URL;
const key = () => randomBytes(32).toString("base64");
const HEVY = "synthetic-hevy-api-key-7d3e";
const DI = { di_token: "synthetic-di-token-a1", di_refresh_token: "synthetic-refresh-b2", di_client_id: "synthetic-client" };

describe.skipIf(!url)("credential vault on Postgres", () => {
  let db: ReturnType<typeof postgres>;
  let sql: Sql;
  let drop: () => Promise<void>;

  const raw = async (platform: string) =>
    (await db.unsafe(`SELECT credentials::text AS t FROM platform_credentials WHERE platform = $1`, [platform]))[0]?.t as string | undefined;
  const putPlain = (platform: string, value: unknown) =>
    db.unsafe(`INSERT INTO platform_credentials (platform, auth_type, credentials, status) VALUES ($1, 'x', $2::jsonb, 'active')
               ON CONFLICT (platform) DO UPDATE SET credentials = EXCLUDED.credentials`, [platform, JSON.stringify(value)]);

  beforeAll(async () => {
    const s = await createScratchDatabase("vault");
    db = s.db;
    sql = s.sql;
    drop = s.drop;
    for (const st of SCHEMA_STATEMENTS) await db.unsafe(st);
  });
  beforeEach(async () => {
    await db.unsafe("DELETE FROM platform_credentials");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await drop?.();
  });

  it("stores a sealed envelope: no secret byte in the row, the value reads back", async () => {
    const env = { H2G_CREDENTIALS_KEY: key() };
    await writeCredentials(sql, "hevy", { api_key: HEVY }, { authType: "api_key", touchConnectedAt: true }, env);
    const stored = await raw("hevy");
    expect(stored).toContain('"h2g_enc"');
    expect(stored).not.toContain(HEVY);
    expect(await readCredentials(sql, "hevy", env)).toEqual({ api_key: HEVY });
  });

  it("refuses to store or use plaintext in strict mode without a key", async () => {
    await expect(writeCredentials(sql, "hevy", { api_key: HEVY }, { authType: "api_key" }, {})).rejects.toThrow(CredentialVaultError);
    expect(await raw("hevy")).toBeUndefined();
    await putPlain("hevy", { api_key: HEVY });
    await expect(readCredentials(sql, "hevy", {})).rejects.toThrow(/plaintext hevy credentials/);
  });

  it("strict mode does not use a plaintext row even with a key: encrypt first", async () => {
    await putPlain("hevy", { api_key: HEVY });
    await expect(readCredentials(sql, "hevy", { H2G_CREDENTIALS_KEY: key() })).rejects.toThrow(/encrypt them first/);
  });

  it("legacy mode without a key keeps the upstream plaintext behaviour", async () => {
    const legacy = { H2G_SYNC_MODE: "legacy_upstream", H2G_LEGACY_UPSTREAM_ACK: "uploads-and-deletes-allowed" };
    await writeCredentials(sql, "github", { pat: "synthetic-pat" }, { authType: "pat" }, legacy);
    expect(JSON.parse((await raw("github"))!)).toEqual({ pat: "synthetic-pat" });
    expect(await readCredentials(sql, "github", legacy)).toEqual({ pat: "synthetic-pat" });
  });

  it("a read never writes: plaintext stays as it is until the explicit migration", async () => {
    const legacyWithKey = { H2G_SYNC_MODE: "legacy_upstream", H2G_LEGACY_UPSTREAM_ACK: "uploads-and-deletes-allowed", H2G_CREDENTIALS_KEY: key() };
    await putPlain("hevy", { api_key: HEVY });
    const before = await raw("hevy");
    expect(await readCredentials(sql, "hevy", legacyWithKey)).toEqual({ api_key: HEVY });
    await readCredentials(sql, "hevy", { H2G_CREDENTIALS_KEY: legacyWithKey.H2G_CREDENTIALS_KEY }).catch(() => null);
    expect(await raw("hevy")).toBe(before);
  });

  it("migrates every row explicitly and reports it; a second run changes nothing", async () => {
    const env = { H2G_CREDENTIALS_KEY: key() };
    await putPlain("hevy", { api_key: HEVY });
    await putPlain("garmin_tokens", { garmin_tokens: DI });
    await putPlain("github", { pat: "synthetic-pat" });
    expect((await vaultStatus(sql, env)).plaintext).toBe(3);
    const first = await migrateCredentials(sql, env);
    expect(first.encrypted.sort()).toEqual(["garmin_tokens", "github", "hevy"]);
    for (const p of ["hevy", "garmin_tokens", "github"]) {
      const t = (await raw(p))!;
      expect(t).not.toMatch(/synthetic-/);
    }
    expect(await vaultStatus(sql, env)).toMatchObject({ configured: true, rows: 3, encryptedCurrent: 3, plaintext: 0, unreadable: [] });
    const second = await migrateCredentials(sql, env);
    expect(second).toEqual({ encrypted: [], rotated: [], unchanged: ["garmin_tokens", "github", "hevy"], failed: [], unsupported: [] });
  });

  it("rotates: rows under the previous key are re-sealed with the new one, the old key can then be dropped", async () => {
    const oldKey = key();
    const newKey = key();
    await writeCredentials(sql, "hevy", { api_key: HEVY }, { authType: "api_key" }, { H2G_CREDENTIALS_KEY: oldKey });
    const rotating = { H2G_CREDENTIALS_KEY: newKey, H2G_CREDENTIALS_KEYS_PREVIOUS: oldKey };
    expect(await vaultStatus(sql, rotating)).toMatchObject({ encryptedPrevious: 1, encryptedCurrent: 0 });
    expect((await migrateCredentials(sql, rotating)).rotated).toEqual(["hevy"]);
    expect(await vaultStatus(sql, rotating)).toMatchObject({ encryptedPrevious: 0, encryptedCurrent: 1 });
    // After rotation the old key is no longer needed …
    expect(await readCredentials(sql, "hevy", { H2G_CREDENTIALS_KEY: newKey })).toEqual({ api_key: HEVY });
    // … and no longer works.
    await expect(readCredentials(sql, "hevy", { H2G_CREDENTIALS_KEY: oldKey })).rejects.toThrow(/no key for credential key id/);
  });

  it("a read issues nothing but SELECT, in every state a row can be in", async () => {
    const oldKey = key();
    const env = { H2G_CREDENTIALS_KEY: key(), H2G_CREDENTIALS_KEYS_PREVIOUS: oldKey };
    const statements: string[] = [];
    const recording = (async (st: TemplateStringsArray, ...v: unknown[]) => {
      statements.push(st.join("?").trim().split(/\s+/)[0].toUpperCase());
      return (sql as unknown as (st: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>)(st, ...v);
    }) as unknown as Sql;
    (recording as unknown as { json: unknown }).json = (sql as unknown as { json: unknown }).json;
    await writeCredentials(sql, "github", { pat: "synthetic" }, { authType: "pat" }, { H2G_CREDENTIALS_KEY: oldKey }); // previous key
    await writeCredentials(sql, "hevy", { api_key: HEVY }, { authType: "api_key" }, env); // current key
    await putPlain("garmin_tokens", { garmin_tokens: DI }); // plaintext
    for (const p of ["github", "hevy", "garmin_tokens", "absent"]) await readCredentials(recording, p, env).catch(() => null);
    await vaultStatus(recording, env);
    await new EncryptedTokenStore(recording, "hevy").load().catch(() => null);
    expect(new Set(statements)).toEqual(new Set(["SELECT"]));
  });

  it("a row under a previous key opens, and reading it changes nothing", async () => {
    const oldKey = key();
    const newKey = key();
    await writeCredentials(sql, "hevy", { api_key: HEVY }, { authType: "api_key" }, { H2G_CREDENTIALS_KEY: oldKey });
    const before = await raw("hevy");
    expect(await readCredentials(sql, "hevy", { H2G_CREDENTIALS_KEY: newKey, H2G_CREDENTIALS_KEYS_PREVIOUS: oldKey })).toEqual({ api_key: HEVY });
    expect(await raw("hevy")).toBe(before);
  });

  it("reports a row no configured key opens, and leaves it untouched", async () => {
    await writeCredentials(sql, "hevy", { api_key: HEVY }, { authType: "api_key" }, { H2G_CREDENTIALS_KEY: key() });
    const before = await raw("hevy");
    const env = { H2G_CREDENTIALS_KEY: key() };
    expect((await vaultStatus(sql, env)).unreadable).toEqual(["hevy"]);
    expect((await migrateCredentials(sql, env)).failed).toEqual(["hevy"]);
    expect(await raw("hevy")).toBe(before);
  });

  it("migration touches credential rows only, and never replaces an odd shape with a sealed {} (re-audit #2)", async () => {
    const env = { H2G_CREDENTIALS_KEY: key() };
    await putPlain("auto_sync", { enabled: true, interval_minutes: 120 }); // Python's settings, not a secret
    await putPlain("github", ["not", "an", "object"]);
    await db.unsafe(`INSERT INTO platform_credentials (platform, auth_type, credentials, status) VALUES ('hevy', 'api_key', to_jsonb($1::text), 'active')`, [JSON.stringify({ api_key: HEVY })]); // double-encoded
    const autoBefore = await raw("auto_sync");
    const githubBefore = await raw("github");
    const r = await migrateCredentials(sql, env);
    expect(r.encrypted).toEqual(["hevy"]);
    expect(r.unsupported).toEqual(["github"]);
    expect(await raw("auto_sync")).toBe(autoBefore);
    expect(await raw("github")).toBe(githubBefore);
    expect(await readCredentials(sql, "hevy", env)).toEqual({ api_key: HEVY });
    const status = await vaultStatus(sql, env);
    expect(status).toMatchObject({ rows: 2, encryptedCurrent: 1, plaintext: 0, unsupported: ["github"] });
  });

  it("a double-encoded plaintext row is still recognised as plaintext (strict refuses to use it)", async () => {
    await db.unsafe(`INSERT INTO platform_credentials (platform, auth_type, credentials, status) VALUES ('hevy', 'api_key', to_jsonb($1::text), 'active')`, [JSON.stringify({ api_key: HEVY })]);
    await expect(readCredentials(sql, "hevy", { H2G_CREDENTIALS_KEY: key() })).rejects.toThrow(/plaintext hevy credentials/);
  });

  it("a tampered row is refused, not misread", async () => {
    const env = { H2G_CREDENTIALS_KEY: key() };
    await writeCredentials(sql, "hevy", { api_key: HEVY }, { authType: "api_key" }, env);
    await db.unsafe(`UPDATE platform_credentials SET credentials = jsonb_set(credentials, '{kid}', to_jsonb(credentials->>'kid')) || jsonb_build_object('ct', 'AAAA' || (credentials->>'ct')) WHERE platform = 'hevy'`);
    await expect(readCredentials(sql, "hevy", env)).rejects.toThrow(/failed authentication/);
  });

  it("a row copied onto another platform does not open there", async () => {
    const env = { H2G_CREDENTIALS_KEY: key() };
    await writeCredentials(sql, "hevy", { api_key: HEVY }, { authType: "api_key" }, env);
    await db.unsafe(`INSERT INTO platform_credentials (platform, credentials) SELECT 'github', credentials FROM platform_credentials WHERE platform = 'hevy'`);
    await expect(readCredentials(sql, "github", env)).rejects.toThrow(/failed authentication/);
  });

  it("compare-and-set: a login that lands between the migration's read and its write is never overwritten", async () => {
    const env = { H2G_CREDENTIALS_KEY: key() };
    await putPlain("hevy", { api_key: "synthetic-old" });
    // A sql tag that lets a concurrent writer in just before the migration's UPDATE.
    let raced = false;
    const racing = (async (s: TemplateStringsArray, ...v: unknown[]) => {
      if (!raced && s.join("?").includes("UPDATE platform_credentials SET credentials")) {
        raced = true;
        await writeCredentials(sql, "hevy", { api_key: "synthetic-new" }, { authType: "api_key" }, env);
      }
      return (sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>)(s, ...v);
    }) as unknown as Sql;
    (racing as unknown as { json: unknown }).json = (sql as unknown as { json: unknown }).json;
    expect((await migrateCredentials(racing, env)).failed).toEqual(["hevy"]);
    expect(raced).toBe(true);
    expect(await readCredentials(sql, "hevy", env)).toEqual({ api_key: "synthetic-new" });
  });

  it("EncryptedTokenStore: garmin-auth saves, loads and deletes through the vault", async () => {
    vi.stubEnv("H2G_CREDENTIALS_KEY", key());
    const store = new EncryptedTokenStore(sql, "garmin_tokens");
    expect(await store.load()).toBeNull();
    await store.save(DI);
    const stored = (await raw("garmin_tokens"))!;
    for (const v of Object.values(DI)) expect(stored).not.toContain(v);
    expect(JSON.parse((await store.load())!)).toEqual(DI);
    const row = (await db.unsafe(`SELECT auth_type, status, connected_at FROM platform_credentials WHERE platform = 'garmin_tokens'`))[0];
    expect(row).toMatchObject({ auth_type: "oauth", status: "active" });
    expect(row.connected_at).not.toBeNull();
    // garmin-auth itself sees the tokens (no network: status() only inspects the store).
    expect(await new GarminAuth({ store }).status()).toMatchObject({ status: "stored", hasDiToken: true });
    await store.delete();
    expect(await raw("garmin_tokens")).toBeUndefined();
  });

  it("EncryptedTokenStore: a legacy flat plaintext row is refused until migrated, then reads", async () => {
    vi.stubEnv("H2G_CREDENTIALS_KEY", key());
    await putPlain("garmin_tokens", DI);
    const store = new EncryptedTokenStore(sql, "garmin_tokens");
    await expect(store.load()).rejects.toThrow(/encrypt them first/);
    expect((await migrateCredentials(sql)).encrypted).toEqual(["garmin_tokens"]);
    expect(await raw("garmin_tokens")).not.toContain(DI.di_token);
    expect(JSON.parse((await store.load())!)).toEqual(DI);
  });

  it("EncryptedTokenStore does not rewrite unchanged tokens (garmin-auth saves after every check)", async () => {
    vi.stubEnv("H2G_CREDENTIALS_KEY", key());
    const store = new EncryptedTokenStore(sql, "garmin_tokens");
    await store.save(DI);
    const before = await db.unsafe(`SELECT credentials::text AS c, connected_at FROM platform_credentials WHERE platform = 'garmin_tokens'`);
    await store.save(JSON.stringify(DI));
    await store.save({ di_client_id: DI.di_client_id, di_token: DI.di_token, di_refresh_token: DI.di_refresh_token });
    const after = await db.unsafe(`SELECT credentials::text AS c, connected_at FROM platform_credentials WHERE platform = 'garmin_tokens'`);
    expect(after).toEqual(before);
    // Rotated tokens are written.
    await store.save({ ...DI, di_refresh_token: "synthetic-refresh-rotated" });
    expect(JSON.parse((await store.load())!).di_refresh_token).toBe("synthetic-refresh-rotated");
    // A row marked disconnected is brought back to active even with the same tokens.
    await db.unsafe(`UPDATE platform_credentials SET status = 'disconnected' WHERE platform = 'garmin_tokens'`);
    await store.save({ ...DI, di_refresh_token: "synthetic-refresh-rotated" });
    expect((await db.unsafe(`SELECT status FROM platform_credentials WHERE platform = 'garmin_tokens'`))[0].status).toBe("active");
  });

  it("a migrated row in the legacy flat shape is not rewritten when the tokens did not change (re-audit #2)", async () => {
    vi.stubEnv("H2G_CREDENTIALS_KEY", key());
    await putPlain("garmin_tokens", DI);
    await db.unsafe(`UPDATE platform_credentials SET status = 'active' WHERE platform = 'garmin_tokens'`);
    await migrateCredentials(sql);
    const before = await db.unsafe(`SELECT credentials::text AS c, status, connected_at FROM platform_credentials`);
    await new EncryptedTokenStore(sql, "garmin_tokens").save(JSON.stringify(DI));
    expect(await db.unsafe(`SELECT credentials::text AS c, status, connected_at FROM platform_credentials`)).toEqual(before);
  });

  it("garmin-auth building a client from valid tokens leaves the row byte-identical (dry-run side effect closed)", async () => {
    vi.stubEnv("H2G_CREDENTIALS_KEY", key());
    const store = new EncryptedTokenStore(sql, "garmin_tokens");
    await store.save(DI);
    const before = await db.unsafe(`SELECT credentials::text AS c, status, connected_at FROM platform_credentials`);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    try {
      await new GarminAuth({ store }).client();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(await db.unsafe(`SELECT credentials::text AS c, status, connected_at FROM platform_credentials`)).toEqual(before);
  });

  it("…and a refresh Garmin performs is persisted (otherwise the rotated refresh token would be lost)", async () => {
    vi.stubEnv("H2G_CREDENTIALS_KEY", key());
    const store = new EncryptedTokenStore(sql, "garmin_tokens");
    await store.save(DI);
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      if (String(u).includes("diauth.garmin.com")) return new Response(JSON.stringify({ access_token: "synthetic-access-2", refresh_token: "synthetic-refresh-2" }), { status: 200 });
      calls++;
      return new Response("{}", { status: calls === 1 ? 401 : 200 });
    }));
    try {
      await new GarminAuth({ store }).client();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(JSON.parse((await store.load())!)).toMatchObject({ di_token: "synthetic-access-2", di_refresh_token: "synthetic-refresh-2" });
  });

  it("connection badges read sealed rows, and a row the keys cannot open is not 'connected'", async () => {
    const k1 = key();
    vi.stubEnv("H2G_CREDENTIALS_KEY", k1);
    vi.stubEnv("HEVY_API_KEY", "");
    await new EncryptedTokenStore(sql, "garmin_tokens").save(DI);
    await writeCredentials(sql, "hevy", { api_key: HEVY }, { authType: "api_key", touchConnectedAt: true });
    expect((await loadGarminConnection(sql as never)).connected).toBe(true);
    expect((await loadHevyConnection(sql as never)).connected).toBe(true);
    vi.stubEnv("H2G_CREDENTIALS_KEY", key());
    expect((await loadGarminConnection(sql as never)).connected).toBe(false);
    expect((await loadHevyConnection(sql as never)).connected).toBe(false);
  });

  it("strict mode without a key does not call a plaintext token 'connected'", async () => {
    vi.stubEnv("H2G_CREDENTIALS_KEY", "");
    vi.stubEnv("HEVY_API_KEY", "");
    await putPlain("garmin_tokens", { garmin_tokens: DI });
    await putPlain("hevy", { api_key: HEVY });
    expect((await loadGarminConnection(sql as never)).connected).toBe(false);
    expect((await loadHevyConnection(sql as never)).connected).toBe(false);
  });
});
