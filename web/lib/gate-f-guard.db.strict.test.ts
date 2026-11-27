/**
 * The gate F database guard (re-audit #3, F6): a real gate F accepts only its
 * own new, empty database, checked BEFORE the schema bootstrap, so pointing it
 * at the legacy production database or the staging database changes nothing
 * there.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { createScratchDatabase } from "./test-scratch-db";
import { checkGateFDatabase, GateFDatabaseError } from "./gate-f-guard";

const url = process.env.TEST_DATABASE_URL;
const AUTH = { hevyId: "b1e2c3d4-0000-4a5b-8c9d-0123456789ab", activityId: 21345678901 };

describe.skipIf(!url)("gate F database guard", () => {
  const scratch: Array<{ drop: () => Promise<void> }> = [];
  afterAll(async () => {
    for (const s of scratch) await s.drop();
  });
  const fresh = async () => {
    const s = await createScratchDatabase("gatefguard");
    scratch.push(s);
    return s.db;
  };
  const tables = async (db: ReturnType<typeof postgres>) =>
    (await db`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`).map((r) => String(r.tablename));
  const bootstrapFor = (db: ReturnType<typeof postgres>) => async () => {
    const { SCHEMA_STATEMENTS } = await import("./schema");
    for (const s of SCHEMA_STATEMENTS) await db.unsafe(s);
  };

  it("refuses a legacy database (sync history and a plain credential) before creating anything", async () => {
    const db = await fresh();
    await db.unsafe(`CREATE TABLE synced_workouts (hevy_id TEXT PRIMARY KEY)`);
    await db.unsafe(`INSERT INTO synced_workouts VALUES ('8f3a-real-workout')`);
    await db.unsafe(`CREATE TABLE platform_credentials (platform TEXT PRIMARY KEY, credentials JSONB NOT NULL DEFAULT '{}')`);
    await db.unsafe(`INSERT INTO platform_credentials VALUES ('garmin', '{"email":"x","password":"y"}')`);
    const bootstrap = vi.fn(async () => {});
    await expect(checkGateFDatabase(db, bootstrap, AUTH)).rejects.toBeInstanceOf(GateFDatabaseError);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(await tables(db)).toEqual(["platform_credentials", "synced_workouts"]);
  });

  it("refuses the staging database (marked as staging, not as gate F)", async () => {
    const db = await fresh();
    await db.unsafe(`CREATE TABLE app_cache (key TEXT PRIMARY KEY, value JSONB NOT NULL)`);
    await db.unsafe(`INSERT INTO app_cache VALUES ('h2g_staging', '{"synthetic": true}')`);
    const bootstrap = vi.fn(async () => {});
    await expect(checkGateFDatabase(db, bootstrap, AUTH)).rejects.toThrow(/not the gate F database/);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("accepts an empty database, bootstraps it and marks it with the authorization", async () => {
    const db = await fresh();
    await checkGateFDatabase(db, bootstrapFor(db), AUTH);
    expect((await db`SELECT value FROM app_cache WHERE key = 'h2g_gate_f'`)[0].value).toMatchObject({ gateF: true, hevyId: AUTH.hevyId, activityId: AUTH.activityId });
    expect(await tables(db)).toEqual(expect.arrayContaining(["strict_gate_f", "strict_journal", "platform_credentials"]));
  });

  it("the runtime applies it: a real gate F pointed at a legacy database fails every query and creates nothing", async () => {
    const s = await createScratchDatabase("gatefrt");
    scratch.push(s);
    await s.db.unsafe(`CREATE TABLE synced_workouts (hevy_id TEXT PRIMARY KEY)`);
    await s.db.unsafe(`INSERT INTO synced_workouts VALUES ('8f3a-real-workout')`);
    const env: Record<string, string> = {
      DATABASE_URL: s.url,
      H2G_STAGING: "",
      H2G_GATE_F: "approved-by-owner",
      H2G_GATE_F_HEVY_ID: AUTH.hevyId,
      H2G_GATE_F_GARMIN_ACTIVITY_ID: String(AUTH.activityId),
      H2G_GATE_F_EXPIRES: new Date(Date.now() + 3_600_000).toISOString(),
      H2G_PASSWORD: "owner-pass",
      H2G_CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64"),
      HEVY_API_KEY: "",
      GARMIN_EMAIL: "",
      GARMIN_PASSWORD: "",
      GITHUB_PAT: "",
    };
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    try {
      vi.resetModules();
      const { gateFState } = await import("./gate-f");
      expect(gateFState()).toMatchObject({ ok: true, auth: { synthetic: false } });
      const db = await import("./db");
      await expect(db.getDb()`SELECT 1 AS one`).rejects.toThrow(/not the gate F database/);
      expect(await tables(s.db)).toEqual(["synced_workouts"]);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("accepts its own marked database later, credentials and ledger included", async () => {
    const db = await fresh();
    await checkGateFDatabase(db, bootstrapFor(db), AUTH);
    await db.unsafe(`INSERT INTO platform_credentials (platform, auth_type, credentials, status) VALUES ('hevy', 'api_key', '{"h2g_enc":"h2g-aesgcm-v1"}', 'active')`);
    const bootstrap = vi.fn(bootstrapFor(db));
    await checkGateFDatabase(db, bootstrap, AUTH);
    expect(bootstrap).toHaveBeenCalledOnce();
  });
});
