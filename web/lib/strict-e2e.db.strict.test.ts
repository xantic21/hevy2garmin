/**
 * Strict in-place merge, end to end in the dashboard's own runtime:
 * the real routes' strict engine binding, real Postgres (schema bootstrap,
 * ledgers, insert-only backups), the real network firewall on the process
 * fetch, and a Garmin Connect simulated at the HTTP level. Hevy is a fixture.
 *
 * Synthetic data only. Runs with TEST_DATABASE_URL (CI: the empty-database
 * job's Postgres); skipped otherwise.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { deleteActivity, StrictModeViolation, uploadFit } from "hevy2garmin";
import type { GarminClient } from "garmin-auth";
import { SCHEMA_STATEMENTS } from "./schema";
import type { Sql } from "./pending-store";
import { ensureStrictFirewall, runStrictSync, strictReconcile, strictStatus } from "./strict-sync";
import { syncOneWorkout } from "./sync-one";

const url = process.env.TEST_DATABASE_URL;
const FAST = { delayMs: 0, maxAttempts: 1, baseWaitMs: 0 };

/** A Garmin Connect that keeps state and records every request it receives. */
function garminServer() {
  const activity = {
    activityId: 424242,
    activityName: "Strength",
    description: "my own note",
    sets: [] as unknown[],
    calories: 380,
  };
  const requests: Array<{ method: string; path: string }> = [];
  const detail = () => ({
    activityId: activity.activityId,
    activityName: activity.activityName,
    description: activity.description,
    activityTypeDTO: { typeKey: "strength_training" },
    metadataDTO: { manufacturer: "GARMIN", deviceMetaDataDTO: { deviceId: 1 } },
    summaryDTO: { startTimeGMT: "2026-02-02 18:00:00", duration: 3300, averageHR: 121, maxHR: 160, calories: activity.calories },
  });
  const fetchImpl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    const method = String(init?.method ?? "GET").toUpperCase();
    const override = (init?.headers as Record<string, string> | undefined)?.["X-HTTP-Method-Override"];
    const effective = (override ?? method).toUpperCase();
    requests.push({ method: effective, path: u.pathname });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
    if (u.hostname !== "connectapi.garmin.com") return new Response("not here", { status: 404 });
    if (u.pathname === "/activitylist-service/activities/search/activities") {
      return json([{ activityId: activity.activityId, startTimeGMT: "2026-02-02 18:00:00", duration: 3300, manufacturer: "GARMIN", activityType: { typeKey: "strength_training" } }]);
    }
    if (u.pathname === `/activity-service/activity/${activity.activityId}` && effective === "GET") return json(detail());
    if (u.pathname === `/activity-service/activity/${activity.activityId}/exerciseSets` && effective === "GET") {
      return json({ activityId: activity.activityId, exerciseSets: activity.sets });
    }
    if (u.pathname === `/activity-service/activity/${activity.activityId}/exerciseSets` && effective === "PUT") {
      activity.sets = (JSON.parse(String(init?.body)) as { exerciseSets: unknown[] }).exerciseSets;
      return new Response(null, { status: 204 });
    }
    if (u.pathname === `/activity-service/activity/${activity.activityId}` && effective === "PUT") {
      const b = JSON.parse(String(init?.body)) as { activityName?: string; description?: string };
      if (b.activityName !== undefined) activity.activityName = b.activityName;
      if (b.description !== undefined) activity.description = b.description;
      return new Response(null, { status: 204 });
    }
    return json({ error: "unexpected" }, 500);
  };
  return { activity, requests, fetchImpl };
}

const client = { domain: "garmin.com", di_token: "t", refreshDiToken: async () => {}, connectapi: async (p: string) => (await fetch(`https://connectapi.garmin.com${p}`)).json() } as unknown as GarminClient;

const workout = {
  id: "e2e-hevy-1",
  title: "Legs (synthetic)",
  start_time: "2026-02-02T18:01:00Z",
  end_time: "2026-02-02T18:53:00Z",
  updated_at: "2026-02-02T19:00:00Z",
  exercises: [
    { title: "Squat (Barbell)", sets: [{ type: "warmup", weight_kg: 60, reps: 8 }, { type: "normal", weight_kg: 100, reps: 5 }] },
    { title: "Plank", sets: [{ type: "normal", duration_seconds: 60 }] },
  ],
};

describe.skipIf(!url)("strict in-place merge end to end (Postgres + firewall + HTTP Garmin)", () => {
  let db: ReturnType<typeof postgres>;
  let sql: Sql;
  let server: ReturnType<typeof garminServer>;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    db = postgres(url!, { prepare: false, onnotice: () => {} });
    const tag = ((s: TemplateStringsArray, ...v: unknown[]) =>
      (db as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>)(s, ...v).then((r) => Array.from(r))) as unknown as Sql;
    (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => db.json(v as never);
    sql = tag;
  });

  beforeEach(async () => {
    await db.unsafe("DROP TABLE IF EXISTS strict_bindings, strict_backups, strict_journal, strict_control CASCADE");
    for (const s of SCHEMA_STATEMENTS) await db.unsafe(s);
    await db.unsafe("DELETE FROM synced_workouts WHERE hevy_id LIKE 'e2e-%'");
    server = garminServer();
    globalThis.fetch = server.fetchImpl as typeof fetch;
    ensureStrictFirewall(); // wraps the fake network exactly as instrumentation.ts wraps the real one
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await db?.end();
  });

  const run = (dryRun: boolean) =>
    runStrictSync(sql, {
      dryRun,
      trigger: "manual",
      targetHevyId: workout.id,
      fetchWorkouts: async () => [workout] as never,
      garminClientFactory: async () => client,
      timing: { verifyDelayMs: 0, rateLimit: FAST },
    });

  it("dry run: reads only, no Garmin write and no database row", async () => {
    const r = await run(true);
    expect(r.status).toBe("dry_run");
    expect(server.requests.filter((q) => q.method !== "GET")).toEqual([]);
    expect((await db`SELECT count(*)::int AS n FROM strict_bindings`)[0].n).toBe(0);
    expect((await db`SELECT count(*)::int AS n FROM strict_backups`)[0].n).toBe(0);
    expect((await db`SELECT count(*)::int AS n FROM strict_journal`)[0].n).toBe(0);
  });

  it("live: exactly two allowed writes, verified, durable ledger, user note kept, no upload or delete", async () => {
    const r = await run(false);
    expect(r.status).toBe("synced");
    const writes = server.requests.filter((q) => q.method !== "GET");
    expect(writes).toEqual([
      { method: "PUT", path: "/activity-service/activity/424242/exerciseSets" },
      { method: "PUT", path: "/activity-service/activity/424242" },
    ]);
    expect(server.requests.some((q) => q.path.includes("upload-service") || q.method === "DELETE")).toBe(false);
    expect(server.activity.activityName).toBe("Legs (synthetic)");
    expect(server.activity.description?.startsWith("my own note\n\n[hevy2garmin]")).toBe(true);
    expect(server.activity.calories).toBe(380);

    const [binding] = await db`SELECT * FROM strict_bindings`;
    expect(binding).toMatchObject({ hevy_id: "e2e-hevy-1", garmin_activity_id: "424242", state: "verified", lease_owner: null });
    const backups = await db`SELECT kind FROM strict_backups ORDER BY id`;
    expect(backups.map((b) => b.kind)).toEqual(["original", "pre_write"]);
    const journal = await db`SELECT step, phase FROM strict_journal ORDER BY id`;
    expect(journal.map((j) => `${j.step}:${j.phase}`)).toEqual(["exercise_sets:verified", "metadata:verified"]);
    const [legacyRow] = await db`SELECT garmin_activity_id, sync_method, calories, avg_hr FROM synced_workouts WHERE hevy_id = 'e2e-hevy-1'`;
    expect(legacyRow).toMatchObject({ garmin_activity_id: "424242", sync_method: "strict_inplace", calories: 380, avg_hr: 121 });

    const status = await strictStatus(sql);
    expect(status).toMatchObject({ mode: "strict_inplace", automaticEnabled: false, writeBlock: { blocked: false }, bindings: { verified: 1 } });
    expect(status.firewall.installed).toBe(true);

    // Repeated: nothing more is written.
    expect((await run(false)).status).toBe("already_synced");
    expect(server.requests.filter((q) => q.method !== "GET")).toHaveLength(2);
  });

  it("in the same process, uploads, deletes and the legacy engine are refused before the network", async () => {
    const before = server.requests.length;
    await expect(uploadFit(client, new Uint8Array([1]), undefined)).rejects.toBeInstanceOf(StrictModeViolation);
    await expect(deleteActivity(client, 424242)).rejects.toBeInstanceOf(StrictModeViolation);
    await expect(syncOneWorkout(sql, { dryRun: false })).rejects.toBeInstanceOf(StrictModeViolation);
    expect(server.requests.length).toBe(before);
    const status = await strictStatus(sql);
    expect(status.firewall.blocked).toBeGreaterThanOrEqual(2);
  });

  it("a lost response is reconciled by read-back after restart, not resent", async () => {
    // First attempt: the PUT lands but the process "dies" before read-back.
    const crashing = async (input: unknown, init?: RequestInit) => {
      const res = await server.fetchImpl(input, init);
      const u = String(input);
      if (u.endsWith("/exerciseSets") && init?.method === "POST") throw new Error("socket hang up");
      if (u.endsWith("/exerciseSets") && String(init?.method ?? "GET") === "GET" && server.activity.sets.length) {
        throw new Error("process killed before read-back");
      }
      return res;
    };
    globalThis.fetch = crashing as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = crashing as typeof fetch;
    ensureStrictFirewall();
    const first = await run(false);
    expect(first.status).toBe("uncertain");
    expect((await db`SELECT phase FROM strict_journal`)[0].phase).toBe("uncertain");

    // "Restart": a healthy network; live writes are blocked until reconciled.
    globalThis.fetch = server.fetchImpl as typeof fetch;
    ensureStrictFirewall();
    expect((await run(false)).status).toBe("blocked");
    const rec = await strictReconcile(sql, first.journalIds[0], async () => client, FAST);
    expect(rec).toMatchObject({ status: "verified", writes: 0 });
    const resumed = await run(false);
    expect(resumed.status).toBe("synced");
    const setPuts = server.requests.filter((q) => q.method === "PUT" && q.path.endsWith("/exerciseSets"));
    expect(setPuts).toHaveLength(1);
  });
});
