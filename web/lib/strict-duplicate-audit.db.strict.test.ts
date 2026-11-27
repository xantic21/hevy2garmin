/**
 * The duplicate audit through the dashboard binding: real Postgres ledgers,
 * the real firewall, Garmin over simulated HTTP. Asserts it sends no write
 * and changes no row.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { GarminClient } from "garmin-auth";
import { SCHEMA_STATEMENTS } from "./schema";
import type { Sql } from "./pending-store";
import { createScratchDatabase } from "./test-scratch-db";
import { ensureStrictFirewall, strictDuplicateAudit } from "./strict-sync";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("strict duplicate audit (read-only, Postgres + firewall)", () => {
  let db: ReturnType<typeof postgres>;
  let sql: Sql;
  const realFetch = globalThis.fetch;
  const requests: string[] = [];

  let drop: () => Promise<void>;
  beforeAll(async () => {
    const scratch = await createScratchDatabase("audit");
    db = scratch.db;
    sql = scratch.sql;
    drop = scratch.drop;
    for (const s of SCHEMA_STATEMENTS) await db.unsafe(s);
    await db.unsafe("DELETE FROM synced_workouts WHERE hevy_id LIKE 'dup-%'");
    await db.unsafe("INSERT INTO synced_workouts (hevy_id, garmin_activity_id, status, sync_method) VALUES ('dup-1', '501', 'success', 'upload')");
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      requests.push(`${String(init?.method ?? "GET")} ${new URL(String(input)).pathname}`);
      return new Response(
        JSON.stringify([
          { activityId: 500, startTimeGMT: "2026-05-05 17:00:00", duration: 3600, manufacturer: "GARMIN", activityType: { typeKey: "strength_training" } },
          { activityId: 501, startTimeGMT: "2026-05-05 17:00:00", duration: 3600, manufacturer: "DEVELOPMENT", activityType: { typeKey: "strength_training" } },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    ensureStrictFirewall();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await db.unsafe("DELETE FROM synced_workouts WHERE hevy_id LIKE 'dup-%'");
    await drop?.();
  });

  it("reports the duplicate pair with exact ids and changes nothing", async () => {
    const before = await db`SELECT count(*)::int AS n FROM synced_workouts`;
    const client = { domain: "garmin.com", di_token: "t", refreshDiToken: async () => {}, connectapi: async (p: string) => (await fetch(`https://connectapi.garmin.com${p}`)).json() } as unknown as GarminClient;
    const report = await strictDuplicateAudit(sql, 7, {
      now: new Date("2026-05-07T12:00:00Z"),
      fetchWorkouts: async () => [{ id: "dup-1", title: "Synthetic", start_time: "2026-05-05T17:01:00Z", end_time: "2026-05-05T17:59:00Z" }] as never,
      garminClientFactory: async () => client,
      rateLimit: { delayMs: 0, maxAttempts: 1, baseWaitMs: 0 },
    });
    expect(report).toMatchObject({ mode: "read-only", deleted: 0 });
    expect(report.cleanupCandidates).toEqual([{ activityId: 501, keepActivityId: 500, hevyId: "dup-1", reason: "uploaded copy of a session the watch recorded" }]);
    expect(requests.every((r) => r.startsWith("GET "))).toBe(true);
    expect((await db`SELECT count(*)::int AS n FROM synced_workouts`)[0].n).toBe(before[0].n);
  });
});
