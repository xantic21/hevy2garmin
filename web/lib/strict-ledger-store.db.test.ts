import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { STRICT_LEDGER_CONTRACT } from "hevy2garmin";
import { SCHEMA_STATEMENTS } from "./schema";
import { postgresStrictLedger, strictSchemaReady } from "./strict-ledger-store";
import type { Sql } from "./pending-store";
import { createScratchDatabase } from "./test-scratch-db";

/**
 * The strict ledger against real Postgres: the same contract the engine's
 * in-memory ledger passes, plus the database-only guarantees (insert-only
 * backups enforced by trigger, both ids unique, schema readiness check).
 *
 * Runs only with TEST_DATABASE_URL naming a database it may wipe the strict
 * tables in. Never point it at a database with real data.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("postgresStrictLedger (real Postgres)", () => {
  let db: ReturnType<typeof postgres>;
  let sql: Sql;

  let drop: () => Promise<void>;

  beforeAll(async () => {
    const scratch = await createScratchDatabase("ledger");
    db = scratch.db;
    sql = scratch.sql;
    drop = scratch.drop;
    for (const s of SCHEMA_STATEMENTS) await db.unsafe(s);
  });

  // Each case starts from empty strict tables. Backups are insert-only, so
  // the test drops and recreates them rather than deleting rows.
  beforeEach(async () => {
    await db.unsafe("DROP TABLE IF EXISTS strict_bindings, strict_backups, strict_journal, strict_control, strict_activity_locks, strict_gate_f CASCADE");
    for (const s of SCHEMA_STATEMENTS) await db.unsafe(s);
  });

  afterAll(async () => {
    await drop?.();
  });

  for (const c of STRICT_LEDGER_CONTRACT) {
    it(c.name, () => c.run(async () => postgresStrictLedger(sql)));
  }

  it("refuses UPDATE, DELETE and TRUNCATE of backups at the database", async () => {
    const l = postgresStrictLedger(sql);
    const b = await l.saveBackup({ garminActivityId: 7, hevyId: "h", kind: "pre_write", payload: { a: 1 }, sha256: "a".repeat(64) });
    await expect(db.unsafe(`UPDATE strict_backups SET payload = '{}' WHERE id = ${b.id}`)).rejects.toThrow(/insert-only/);
    await expect(db.unsafe(`DELETE FROM strict_backups WHERE id = ${b.id}`)).rejects.toThrow(/insert-only/);
    await expect(db.unsafe("TRUNCATE strict_backups")).rejects.toThrow(/insert-only/);
    expect((await l.getBackup(b.id))?.payload).toEqual({ a: 1 });
  });

  it("enforces exclusivity in the schema itself, not only in code", async () => {
    await db.unsafe(`INSERT INTO strict_bindings (hevy_id, garmin_activity_id, state) VALUES ('a', 1, 'verified')`);
    await expect(db.unsafe(`INSERT INTO strict_bindings (hevy_id, garmin_activity_id, state) VALUES ('b', 1, 'verified')`)).rejects.toThrow(/unique/i);
    await expect(db.unsafe(`INSERT INTO strict_bindings (hevy_id, garmin_activity_id, state) VALUES ('a', 2, 'verified')`)).rejects.toThrow(/unique|duplicate/i);
    await expect(db.unsafe(`INSERT INTO strict_bindings (hevy_id, garmin_activity_id, state) VALUES ('c', 3, 'bogus')`)).rejects.toThrow(/check/i);
  });

  it("allows only one in-flight write per activity at the database, whatever the code does", async () => {
    const ins = (id: string, phase: string) =>
      db.unsafe(`INSERT INTO strict_journal (hevy_id, garmin_activity_id, step, phase, owner, intended_sha256, intended, backup_id)
                 VALUES ('${id}', 500, 'exercise_sets', '${phase}', 'o', 'x', '{}', 'b')`);
    await ins("a", "put_sent");
    await expect(ins("b", "intent")).rejects.toThrow(/strict_journal_one_in_flight/);
    await expect(ins("c", "uncertain")).rejects.toThrow(/strict_journal_one_in_flight/);
    await ins("d", "needs_review");
    await ins("e", "verified");
  });

  it("reports readiness, and not-ready when the insert-only trigger is missing", async () => {
    expect(await strictSchemaReady(sql)).toEqual({ ready: true, missing: [] });
    await db.unsafe("DROP TRIGGER strict_backups_insert_only ON strict_backups");
    const r = await strictSchemaReady(sql);
    expect(r.ready).toBe(false);
    expect(r.missing).toContain("trigger strict_backups_insert_only");
    await db.unsafe("DROP INDEX strict_journal_one_in_flight");
    expect((await strictSchemaReady(sql)).missing).toContain("index strict_journal_one_in_flight");
  });

  it("running the schema twice changes nothing (idempotent bootstrap)", async () => {
    for (const s of SCHEMA_STATEMENTS) await db.unsafe(s);
    expect((await strictSchemaReady(sql)).ready).toBe(true);
  });
});
