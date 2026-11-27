/**
 * Gate F end to end on real Postgres, through the dashboard's real strict
 * runtime, with Hevy and Garmin simulated in-process (synthetic staging) and
 * the process network replaced by a tripwire. The authorization is the
 * synthetic rehearsal form; the code path is the one a real gate F runs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { createScratchDatabase } from "./test-scratch-db";

const url = process.env.TEST_DATABASE_URL;
const FAST = { delayMs: 0, maxAttempts: 1, baseWaitMs: 0 };
const SEAMS = { timing: { verifyDelayMs: 0, rateLimit: FAST } };

describe.skipIf(!url)("gate F: one authorized activity, end to end", { timeout: 30_000 }, () => {
  let drop: () => Promise<void>;
  let raw: ReturnType<typeof postgres>;
  const realFetch = globalThis.fetch;
  const tripwire = vi.fn(async () => {
    throw new Error("TRIPWIRE: a request reached the process network");
  });
  let m: {
    db: typeof import("./db");
    sync: typeof import("./strict-sync");
    routes: typeof import("./strict-routes");
    fixtures: typeof import("./staging-fixtures");
    gate: typeof import("./gate-f-run");
  };

  const authorize = (hevyId = "syn-legs", activityId = "9100001", expires = new Date(Date.now() + 3_600_000).toISOString()) => {
    vi.stubEnv("H2G_GATE_F", "approved-by-owner");
    vi.stubEnv("H2G_GATE_F_HEVY_ID", hevyId);
    vi.stubEnv("H2G_GATE_F_GARMIN_ACTIVITY_ID", activityId);
    vi.stubEnv("H2G_GATE_F_EXPIRES", expires);
  };
  const deauthorize = () => {
    for (const k of ["H2G_GATE_F", "H2G_GATE_F_HEVY_ID", "H2G_GATE_F_GARMIN_ACTIVITY_ID", "H2G_GATE_F_EXPIRES"]) vi.stubEnv(k, "");
  };

  beforeAll(async () => {
    const s = await createScratchDatabase("gatef");
    drop = s.drop;
    raw = s.db;
    vi.stubEnv("H2G_STAGING", "synthetic");
    vi.stubEnv("DATABASE_URL", s.url);
    vi.stubEnv("H2G_CREDENTIALS_KEY", "");
    vi.stubEnv("HEVY_API_KEY", "");
    vi.stubEnv("H2G_PASSWORD", "staging-pass");
    vi.stubEnv("H2G_STRICT_STOP", "");
    globalThis.fetch = tripwire as unknown as typeof fetch;
    vi.resetModules();
    m = {
      db: await import("./db"),
      sync: await import("./strict-sync"),
      routes: await import("./strict-routes"),
      fixtures: await import("./staging-fixtures"),
      gate: await import("./gate-f-run"),
    };
    m.sync.ensureStrictFirewall();
  });

  beforeEach(async () => {
    deauthorize();
    await m.fixtures.seedStaging(m.db.getDb(), m.db.stagingRebootstrap);
    authorize();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
    const { setStrictTransport } = await import("hevy2garmin");
    setStrictTransport(null);
    await drop?.();
  });

  const sql = () => m.db.getDb();
  const puts = async (activityId?: number) =>
    (activityId === undefined
      ? await raw`SELECT count(*)::int AS n FROM staging_requests WHERE method = 'PUT'`
      : await raw`SELECT count(*)::int AS n FROM staging_requests WHERE method = 'PUT' AND path LIKE ${`%/${activityId}%`}`)[0].n as number;
  const run = (confirm = "GATE-F syn-legs 9100001") => m.gate.gateFRun(sql(), confirm, SEAMS);
  const record = async () => (await raw`SELECT * FROM strict_gate_f WHERE id = 'gate_f'`)[0] as Record<string, unknown> | undefined;

  it("status names the authorization and every safeguard; no record before the first run", async () => {
    const s = await m.gate.gateFStatus(sql());
    expect(s).toMatchObject({ gateF: true, authorization: { hevyId: "syn-legs", activityId: 9100001, synthetic: true, expired: false }, confirmation: "GATE-F syn-legs 9100001", record: null });
    if (!s.gateF) throw new Error("unreachable");
    expect(s.safeguards.firewall.installed).toBe(true);
    expect(s.safeguards.schema).toMatchObject({ ready: true, gateFTable: true });
    expect(s.safeguards.envStop).toBe(false);
  });

  it("preview plans exactly the authorized pair and writes nothing", async () => {
    const out = await m.gate.gateFPreview(sql(), SEAMS);
    expect("result" in out && out.result).toMatchObject({ status: "dry_run", activityId: 9100001, plan: { activityId: 9100001 } });
    expect(await puts()).toBe(0);
    expect(await record()).toBeUndefined();
  });

  it("every generic sync path refuses in gate F mode and nothing is written", async () => {
    expect(await m.sync.runStrictSync(sql(), { dryRun: false, trigger: "manual", targetHevyId: "syn-legs", ...SEAMS })).toMatchObject({ status: "blocked", writes: 0 });
    expect(await m.sync.runStrictSync(sql(), { dryRun: false, trigger: "manual", targetHevyId: "syn-pull", pin: { hevyId: "syn-pull", activityId: 9100003 }, ...SEAMS })).toMatchObject({ status: "blocked" });
    expect(await m.sync.runStrictSync(sql(), { dryRun: false, trigger: "batch", ...SEAMS })).toMatchObject({ status: "blocked" });
    const post = (path: string) => new Request(`http://h${path}`, { method: "POST", body: JSON.stringify({ live: true }), headers: { "content-type": "application/json" } });
    expect((await m.routes.strictSyncRoute(post("/api/sync-one"))).status).toBe(423);
    expect((await m.routes.strictSyncRoute(post("/api/sync/syn-legs"), "syn-legs")).status).toBe(423);
    expect((await m.routes.strictBatchRoute(post("/api/sync"))).status).toBe(423);
    expect((await m.routes.strictAutomaticRoute(new Request("http://h/api/cron/sync", { headers: { authorization: "Bearer x" } }), "cron")).status).toBe(423);
    expect(await puts()).toBe(0);
  });

  it("the run needs the exact confirmation; a wrong one claims nothing and writes nothing", async () => {
    expect(await m.gate.gateFRun(sql(), undefined, SEAMS)).toMatchObject({ refused: expect.stringMatching(/type exactly/) });
    expect(await m.gate.gateFRun(sql(), { toString: () => "GATE-F syn-legs 9100001" }, SEAMS)).toMatchObject({ refused: expect.stringMatching(/type exactly/) });
    for (const c of ["", "GATE-F syn-legs", "gate-f syn-legs 9100001", "GATE-F syn-legs 9100002", "GATE-F syn-pull 9100001", " GATE-F syn-legs 9100001"]) {
      expect(await run(c)).toMatchObject({ refused: expect.stringMatching(/type exactly/) });
    }
    expect(await record()).toBeUndefined();
    expect(await puts()).toBe(0);
  });

  it("the one run merges and verifies, the record is final, and a replay writes nothing", async () => {
    const out = await run();
    expect("result" in out && out.result).toMatchObject({ status: "synced", activityId: 9100001 });
    expect("consumed" in out && out.consumed).toBe(true);
    expect(await record()).toMatchObject({ state: "done", attempts: 1, hevy_id: "syn-legs" });
    const after = await puts();
    expect(after).toBeGreaterThanOrEqual(1);
    expect(await puts(9100001)).toBe(after);

    expect(await run()).toMatchObject({ refused: expect.stringMatching(/already run/) });
    // Re-pointed at another workout on the same database: still final.
    authorize("syn-pull", "9100003");
    expect(await run("GATE-F syn-pull 9100003")).toMatchObject({ refused: expect.stringMatching(/already ran on this database for workout syn-legs/) });
    expect(await puts()).toBe(after);
  });

  it("evidence: before = the verified original, after = what was intended, native metrics unchanged; restore brings the original back", async () => {
    await run();
    const ev = await m.gate.gateFEvidence(sql());
    const bundle = ev.bundle;
    if (!bundle) throw new Error(String(ev.refused));
    expect(ev.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.before).toMatchObject({ intact: true });
    expect(bundle.intended).toMatchObject({ phase: "verified" });
    expect(bundle.comparisons).toMatchObject({ activityIdUnchanged: true, setsAgainstIntended: [], preservedMetrics: [] });
    expect((bundle.comparisons.setsAgainstOriginal ?? []).length).toBeGreaterThan(0);

    const journalId = bundle.intended!.journalId;
    const restored = await m.sync.strictRestore(sql(), { journalId, source: "original", confirm: true }, undefined, { verifyDelayMs: 0, rateLimit: FAST });
    expect(restored.status).toBe("restored");
    const bundle2 = (await m.gate.gateFEvidence(sql())).bundle;
    if (!bundle2) throw new Error("no evidence");
    expect(bundle2.comparisons.setsAgainstOriginal).toEqual([]);
    expect(bundle2.restore).toMatchObject({ phase: "verified" });
    // Restored is not a licence to merge again.
    expect(await run()).toMatchObject({ refused: expect.stringMatching(/already run/) });
  }, 30_000);

  it("parallel runs: exactly one claim and one sets write", async () => {
    const outs = await Promise.all([run(), run(), run()]);
    expect(outs.filter((o) => "result" in o)).toHaveLength(1);
    expect(outs.filter((o) => "refused" in o).every((o) => /in progress|already run/.test(String((o as { refused: string }).refused)))).toBe(true);
    expect((await raw`SELECT count(*)::int AS n FROM staging_requests WHERE method = 'PUT' AND path LIKE '%/9100001/exerciseSets'`)[0].n).toBe(1);
  });

  it("a different activity than the authorized one: nothing written, the record re-arms for a corrected authorization", async () => {
    authorize("syn-legs", "9100002");
    const out = await run("GATE-F syn-legs 9100002");
    expect("result" in out && out.result).toMatchObject({ status: "needs_review", writes: 0 });
    expect("result" in out && out.result.reason).toMatch(/authorization names activity 9100002/);
    expect(await record()).toMatchObject({ state: "armed", attempts: 1 });
    expect(await puts()).toBe(0);
    authorize("syn-legs", "9100001");
    const fixed = await run();
    expect("result" in fixed && fixed.result.status).toBe("synced");
    expect(await record()).toMatchObject({ state: "done", attempts: 2, garmin_activity_id: "9100001" });
  });

  it("an expired authorization: no run, but preview, status and evidence stay available", async () => {
    authorize("syn-legs", "9100001", new Date(Date.now() - 60_000).toISOString());
    expect(await run()).toMatchObject({ refused: expect.stringMatching(/expired/) });
    expect("result" in (await m.gate.gateFPreview(sql(), SEAMS))).toBe(true);
    expect((await m.gate.gateFStatus(sql())) as { authorization?: { expired: boolean } }).toMatchObject({ authorization: { expired: true } });
    expect(await record()).toBeUndefined();
    expect(await puts()).toBe(0);
  });

  it("the hard stop wins: refused before any claim, nothing written", async () => {
    vi.stubEnv("H2G_STRICT_STOP", "1");
    try {
      expect(await run()).toMatchObject({ refused: expect.stringMatching(/H2G_STRICT_STOP/) });
    } finally {
      vi.stubEnv("H2G_STRICT_STOP", "");
    }
    expect(await record()).toBeUndefined();
    expect(await puts()).toBe(0);
  });

  it("the database freeze wins too: the claim re-arms, nothing written", async () => {
    await m.sync.strictSetFrozen(sql(), true, "test");
    const out = await run();
    expect("result" in out && out.result.status).toBe("blocked");
    expect(await record()).toMatchObject({ state: "armed" });
    expect(await puts()).toBe(0);
  });

  it("a running record is refused; a stale one whose run never wrote can be taken over", async () => {
    await raw`INSERT INTO strict_gate_f (id, hevy_id, garmin_activity_id, state, attempts, run_owner, started_at, authorized_until)
              VALUES ('gate_f', 'syn-legs', 9100001, 'running', 1, 'crashed', NOW(), NOW() + interval '1 hour')`;
    expect(await run()).toMatchObject({ refused: expect.stringMatching(/in progress/) });
    await raw`UPDATE strict_gate_f SET started_at = NOW() - interval '11 minutes'`;
    const out = await run();
    expect("result" in out && out.result.status).toBe("synced");
    expect(await record()).toMatchObject({ state: "done", attempts: 2 });
  });

  it("recovery outside the authorized pair is refused (restore, reconcile, resolve)", async () => {
    deauthorize();
    const other = await m.sync.runStrictSync(sql(), { dryRun: false, trigger: "manual", targetHevyId: "syn-push", ...SEAMS });
    expect(other.status).toBe("needs_review");
    authorize();
    const before = await puts();
    const journalId = other.journalIds[0];
    expect(await m.sync.strictRestore(sql(), { journalId, source: "original", confirm: true }, undefined, { verifyDelayMs: 0, rateLimit: FAST })).toMatchObject({ status: "refused", writes: 0 });
    expect(await m.sync.strictReconcile(sql(), journalId, undefined, FAST)).toMatchObject({ status: "refused" });
    expect(await m.sync.strictResolve(sql(), journalId, "not mine")).toBe(false);
    expect(await puts()).toBe(before);
  });

  it("a record taken over during the run freezes all writes", async () => {
    const hevy = await import("./hevy-sync");
    const out = await m.gate.gateFRun(sql(), "GATE-F syn-legs 9100001", {
      ...SEAMS,
      fetchWorkouts: async () => {
        await raw`UPDATE strict_gate_f SET run_owner = 'intruder'`;
        return hevy.fetchAllWorkouts();
      },
    });
    expect("result" in out).toBe(true);
    expect((await raw`SELECT frozen FROM strict_control WHERE id = 1`)[0]?.frozen).toBe(true);
  });
});
