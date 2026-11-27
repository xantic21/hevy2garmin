/**
 * Synthetic staging, qualified end to end on real Postgres (gate E
 * preparation): the database guard, the seed, every rehearsal scenario through
 * the dashboard's real strict runtime (db.ts, default Hevy and Garmin clients,
 * firewall, ledger), restore and reconcile, and the network fence. The
 * process network is replaced by a tripwire first: any request that reached it
 * (other than none) fails the test.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { isStrictModeViolation, uploadFit } from "hevy2garmin";
import { createScratchDatabase } from "./test-scratch-db";
import { checkStagingDatabase } from "./staging-guard";
import { StagingIsolationError, assertStagingEnvironment, stagingCredentialPath } from "./staging-mode";

const url = process.env.TEST_DATABASE_URL;
const FAST = { delayMs: 0, maxAttempts: 1, baseWaitMs: 0 };

describe.skipIf(!url)("staging database guard", () => {
  const scratch: Array<{ drop: () => Promise<void>; db: ReturnType<typeof postgres> }> = [];
  afterAll(async () => {
    for (const s of scratch) await s.drop();
  });
  const fresh = async () => {
    const s = await createScratchDatabase("stgguard");
    scratch.push(s);
    return s.db;
  };
  const tables = async (db: ReturnType<typeof postgres>) =>
    (await db`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`).map((r) => String(r.tablename));

  it("refuses a database with a stored credential BEFORE creating anything in it", async () => {
    const db = await fresh();
    await db.unsafe(`CREATE TABLE platform_credentials (platform TEXT PRIMARY KEY, credentials JSONB NOT NULL DEFAULT '{}')`);
    await db.unsafe(`INSERT INTO platform_credentials (platform, credentials) VALUES ('hevy', '{"api_key":"synthetic"}')`);
    const bootstrap = vi.fn(async () => {});
    await expect(checkStagingDatabase(db, bootstrap)).rejects.toBeInstanceOf(StagingIsolationError);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(await tables(db)).toEqual(["platform_credentials"]);
  });

  it("refuses a database with real sync history", async () => {
    const db = await fresh();
    await db.unsafe(`CREATE TABLE synced_workouts (hevy_id TEXT PRIMARY KEY)`);
    await db.unsafe(`INSERT INTO synced_workouts VALUES ('8f3a-real-workout')`);
    await expect(checkStagingDatabase(db, async () => {})).rejects.toThrow(/non-synthetic/);
  });

  it("accepts an empty database and marks it", async () => {
    const db = await fresh();
    const { SCHEMA_STATEMENTS } = await import("./schema");
    await checkStagingDatabase(db, async () => {
      for (const s of SCHEMA_STATEMENTS) await db.unsafe(s);
    });
    expect((await db`SELECT value FROM app_cache WHERE key = 'h2g_staging'`)[0].value).toMatchObject({ synthetic: true });
    expect(await tables(db)).toEqual(expect.arrayContaining(["staging_garmin_activities", "staging_hevy_workouts", "staging_requests", "strict_journal"]));
  });
});

describe("staging mode switches", () => {
  it("refuses to run as a Vercel production deployment or in legacy mode", () => {
    expect(() => assertStagingEnvironment({ H2G_STAGING: "synthetic", VERCEL_ENV: "production" })).toThrow(StagingIsolationError);
    expect(() =>
      assertStagingEnvironment({ H2G_STAGING: "synthetic", H2G_SYNC_MODE: "legacy_upstream", H2G_LEGACY_UPSTREAM_ACK: "uploads-and-deletes-allowed" }),
    ).toThrow(/strict mode only/);
    expect(() => assertStagingEnvironment({ H2G_STAGING: "synthetic", VERCEL_ENV: "preview" })).not.toThrow();
    expect(() => assertStagingEnvironment({ VERCEL_ENV: "production" })).not.toThrow(); // not staging: not this guard's business
  });

  it("names every route that could receive a credential (mutating requests only)", () => {
    for (const p of ["/api/garmin-login", "/api/garmin-login-mfa", "/api/garmin-ticket", "/api/garmin-ticket-exchange", "/api/connect-hevy", "/api/validate-hevy", "/api/setup-actions", "/api/strict/credentials"]) {
      expect(stagingCredentialPath(p, "POST"), p).toBe(true);
    }
    expect(stagingCredentialPath("/api/strict/credentials", "GET")).toBe(false);
    expect(stagingCredentialPath("/api/sync", "POST")).toBe(false);
  });
});

describe.skipIf(!url)("synthetic staging rehearsal (real runtime, simulated Hevy and Garmin)", () => {
  let drop: () => Promise<void>;
  let raw: ReturnType<typeof postgres>;
  const realFetch = globalThis.fetch;
  const tripwire = vi.fn(async () => {
    throw new Error("TRIPWIRE: a request reached the process network");
  });
  // Loaded after the environment is set: db.ts reads DATABASE_URL on first use.
  let m: {
    db: typeof import("./db");
    sync: typeof import("./strict-sync");
    fixtures: typeof import("./staging-fixtures");
    vault: typeof import("./credential-vault");
    hevy: typeof import("./hevy-sync");
    upload: typeof import("./garmin-upload");
  };

  beforeAll(async () => {
    const s = await createScratchDatabase("staging");
    drop = s.drop;
    raw = s.db;
    vi.stubEnv("H2G_STAGING", "synthetic");
    vi.stubEnv("DATABASE_URL", s.url);
    vi.stubEnv("H2G_CREDENTIALS_KEY", "");
    vi.stubEnv("HEVY_API_KEY", "");
    globalThis.fetch = tripwire as unknown as typeof fetch;
    vi.resetModules();
    m = {
      db: await import("./db"),
      sync: await import("./strict-sync"),
      fixtures: await import("./staging-fixtures"),
      vault: await import("./credential-vault"),
      hevy: await import("./hevy-sync"),
      upload: await import("./garmin-upload"),
    };
    m.sync.ensureStrictFirewall();
    const seeded = await m.fixtures.seedStaging(m.db.getDb(), m.db.stagingRebootstrap);
    expect(seeded.workouts).toBe(m.fixtures.STAGING_SCENARIOS.length);
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
    const { setStrictTransport } = await import("hevy2garmin");
    setStrictTransport(null);
    await drop?.();
  });

  const sql = () => m.db.getDb();
  const live = (hevyId: string) =>
    m.sync.runStrictSync(sql(), { dryRun: false, trigger: "manual", targetHevyId: hevyId, timing: { verifyDelayMs: 0, rateLimit: FAST } });
  const preview = (hevyId: string) =>
    m.sync.runStrictSync(sql(), { dryRun: true, trigger: "manual", targetHevyId: hevyId, timing: { verifyDelayMs: 0, rateLimit: FAST } });
  const activity = async (id: number) =>
    (await raw`SELECT detail, sets FROM staging_garmin_activities WHERE activity_id = ${id}`)[0] as { detail: Record<string, unknown>; sets: Array<Record<string, unknown>> };

  it("uses the staging clients: synthetic Hevy key, synthetic Garmin tokens, no credential read", async () => {
    expect(await m.hevy.resolveHevyKey()).toBe("h2g-staging-synthetic-key");
    const client = await m.upload.getGarminClient();
    expect(client.di_token).toBe("h2g-staging-synthetic");
    expect((await raw`SELECT count(*)::int AS n FROM platform_credentials`)[0].n).toBe(0);
  });

  it("the vault refuses to store any credential", async () => {
    await expect(m.vault.writeCredentials(sql(), "hevy", { api_key: "x" }, { authType: "api_key" })).rejects.toThrow(/staging never stores/);
  });

  it("preview of the clean scenario plans a merge and writes nothing anywhere", async () => {
    const before = await activity(9100001);
    const r = await preview("syn-legs");
    expect(r.status).toBe("dry_run");
    expect(r.plan?.activityId).toBe(9100001);
    expect(await activity(9100001)).toEqual(before);
  });

  it("clean scenario: synced, verified, native timing and the user's note kept", async () => {
    const r = await live("syn-legs");
    expect(r.status).toBe("synced");
    const a = await activity(9100001);
    expect(a.sets.filter((s) => s.setType === "ACTIVE").length).toBe(6);
    expect(a.sets.every((s) => s.setType !== "ACTIVE" || (s.exercises as Array<{ name: string | null }>)[0].name)).toBe(true);
    expect(String(a.detail.description)).toContain("Felt strong (my own note)");
    expect(a.detail.activityId).toBe(9100001);
  });

  const putCount = async () => (await raw`SELECT count(*)::int AS n FROM staging_requests WHERE method = 'PUT'`)[0].n as number;

  it("ambiguous and missing recordings: nothing is written", async () => {
    const w = await putCount();
    expect(await live("syn-ambiguous")).toMatchObject({ status: "needs_review", reason: "ambiguous activity candidates", writes: 0 });
    expect(await live("syn-missing")).toMatchObject({ status: "pending", writes: 0 });
    expect(await putCount()).toBe(w);
  });

  it("the legacy-duplicate workout is not rewritten by strict sync", async () => {
    const w = await putCount();
    const r = await live("syn-legacy");
    expect(r).toMatchObject({ status: "needs_review", writes: 0 });
    expect(r.reason).toMatch(/legacy ledger/);
    expect(await putCount()).toBe(w);
  });

  it("rejected write: not applied, the activity unchanged", async () => {
    const before = await activity(9100007);
    const r = await live("syn-reject");
    expect(["failed", "needs_review", "blocked"]).toContain(r.status);
    expect((await activity(9100007)).sets).toEqual(before.sets);
  });

  it("lost response: the read-back finds the write applied, no blind retry", async () => {
    const w = await putCount();
    expect((await live("syn-pull")).status).toBe("synced");
    expect((await raw`SELECT count(*)::int AS n FROM staging_requests WHERE method = 'PUT' AND path LIKE '%/9100003/exerciseSets'`)[0].n).toBe(1);
    expect(await putCount()).toBeGreaterThan(w);
  });

  it("lost response and an outage: uncertain, live writes blocked, reconcile after the outage verifies", async () => {
    const r = await live("syn-hinge");
    expect(r.status).toBe("uncertain");
    expect((await live("syn-core")).status).toBe("blocked");
    const early = await m.sync.strictReconcile(sql(), r.journalIds[0], undefined, FAST);
    expect(early.status).not.toBe("verified"); // Garmin still unreadable: nothing is decided
    await raw`UPDATE staging_garmin_activities SET reads_fail_until = NOW() - interval '1 second' WHERE activity_id = 9100010`; // a minute later
    const rec = await m.sync.strictReconcile(sql(), r.journalIds[0], undefined, FAST);
    expect(rec).toMatchObject({ status: "verified", writes: 0 });
    expect((await raw`SELECT count(*)::int AS n FROM staging_requests WHERE method = 'PUT' AND path LIKE '%/9100010/exerciseSets'`)[0].n).toBe(1);
  });

  it("read-back mismatch: needs review and freeze; restore of the original verifies", async () => {
    const status = await m.sync.strictStatus(sql());
    if (status.control.frozen && !status.openJournal.some((e) => e.phase !== "intent")) await m.sync.strictSetFrozen(sql(), false, null);
    const r = await live("syn-push");
    expect(r.status).toBe("needs_review");
    expect((await m.sync.strictStatus(sql())).control.frozen).toBe(true);
    const restored = await m.sync.strictRestore(sql(), { journalId: r.journalIds[0], source: "original", confirm: true }, undefined, { verifyDelayMs: 0, rateLimit: FAST });
    expect(restored.status).toBe("restored");
  });

  it("the read-only duplicate audit reports the legacy upload next to the watch recording", async () => {
    const w = await putCount();
    const report = await m.sync.strictDuplicateAudit(sql(), 30, { rateLimit: FAST });
    expect(JSON.stringify(report)).toContain("9100009");
    expect(await putCount()).toBe(w);
  });

  it("uploads and deletes never reach the simulator; foreign hosts never reach the network", async () => {
    const client = await m.upload.getGarminClient();
    const before = (await raw`SELECT count(*)::int AS n FROM staging_requests`)[0].n;
    await expect(uploadFit(client, Buffer.from("x"), "x.fit")).rejects.toSatisfy(isStrictModeViolation);
    expect((await raw`SELECT count(*)::int AS n FROM staging_requests`)[0].n).toBe(before);
    const res = await fetch("https://example.com/collect", { method: "POST", body: "x" });
    expect(res.status).toBe(503);
    expect((await raw`SELECT count(*)::int AS n FROM staging_requests WHERE host = 'example.com' AND note = 'refused'`)[0].n).toBe(1);
  });

  it("H2G_STRICT_STOP still refuses every write in staging", async () => {
    vi.stubEnv("H2G_STRICT_STOP", "1");
    try {
      expect((await live("syn-core")).status).toBe("blocked");
    } finally {
      vi.stubEnv("H2G_STRICT_STOP", "");
    }
  });

  it("no request ever reached the process network", () => {
    expect(tripwire).not.toHaveBeenCalled();
  });
});
