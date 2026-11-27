import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { STRICT_LEDGER_CONTRACT } from "hevy2garmin";
import { SCHEMA_STATEMENTS } from "./schema";
import { postgresStrictLedger, strictSchemaReady } from "./strict-ledger-store";
import type { Sql } from "./pending-store";

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

  beforeAll(async () => {
    db = postgres(url!, { prepare: false, onnotice: () => {} });
    for (const s of SCHEMA_STATEMENTS) await db.unsafe(s);
    const tag = ((strings: TemplateStringsArray, ...values: unknown[]) =>
      (db as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>)(strings, ...values).then((r) => Array.from(r))) as unknown as Sql;
    (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => db.json(v as never);
    sql = tag;
  });

  // Each case starts from empty strict tables. Backups are insert-only, so
  // the test drops and recreates them rather than deleting rows.
  beforeEach(async () => {
    await db.unsafe("DROP TABLE IF EXISTS strict_bindings, strict_backups, strict_journal, strict_control CASCADE");
    for (const s of SCHEMA_STATEMENTS) await db.unsafe(s);
  });

  afterAll(async () => {
    await db?.end();
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

  it("reports readiness, and not-ready when the insert-only trigger is missing", async () => {
    expect(await strictSchemaReady(sql)).toEqual({ ready: true, missing: [] });
    await db.unsafe("DROP TRIGGER strict_backups_insert_only ON strict_backups");
    const r = await strictSchemaReady(sql);
    expect(r.ready).toBe(false);
    expect(r.missing).toContain("trigger strict_backups_insert_only");
  });

  it("running the schema twice changes nothing (idempotent bootstrap)", async () => {
    for (const s of SCHEMA_STATEMENTS) await db.unsafe(s);
    expect((await strictSchemaReady(sql)).ready).toBe(true);
  });
});
