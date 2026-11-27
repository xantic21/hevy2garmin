/**
 * Database qualification on SYNTHETIC data (contract item 7):
 *
 *  1. fresh empty database → the web bootstrap creates every table, the
 *     strict ledger and its insert-only triggers;
 *  2. existing legacy database (the previous fork main's exact schema, with
 *     synthetic rows) → migration is additive: every legacy row is
 *     byte-identical afterwards, re-running changes nothing, the old columns
 *     an older build reads are all still there (rollback-safe);
 *  3. backup and restore → pg_dump/pg_restore round-trips every table,
 *     including the strict ledger, and the restored backups are still
 *     insert-only.
 *
 * Needs TEST_DATABASE_URL with permission to CREATE/DROP DATABASE (CI's
 * service user is a superuser). Creates uniquely named scratch databases and
 * drops them afterwards. Never point it at a server with real data.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { SCHEMA_STATEMENTS, SCHEMA_TABLES } from "./schema";
import { postgresStrictLedger, STRICT_SCHEMA_TABLES, strictSchemaReady } from "./strict-ledger-store";
import type { Sql } from "./pending-store";

const url = process.env.TEST_DATABASE_URL;
const suffix = `${process.pid}_${Date.now()}`;
const DBS = { fresh: `h2gq_fresh_${suffix}`, legacy: `h2gq_legacy_${suffix}`, restore: `h2gq_restore_${suffix}` };

const urlFor = (db: string) => {
  const u = new URL(url!);
  u.pathname = `/${db}`;
  return u.toString();
};
const tagFor = (db: ReturnType<typeof postgres>) => {
  const tag = ((s: TemplateStringsArray, ...v: unknown[]) =>
    (db as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>)(s, ...v).then((r) => Array.from(r))) as unknown as Sql;
  (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => db.json(v as never);
  return tag;
};

/** Stable digest of a table's contents, over `columns` (default: all of them). */
async function digest(db: ReturnType<typeof postgres>, table: string, columns?: string[]): Promise<string> {
  const cols = columns?.length ? columns.map((c) => `"${c}"`).join(", ") : "*";
  const rows = await db.unsafe(
    `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS d FROM (SELECT ${cols} FROM ${table}) t`,
  );
  return String(rows[0].d);
}

/**
 * pg_dump/pg_restore must match the SERVER's major version: a newer pg_dump
 * writes settings an older server rejects on restore (found in CI: pg_dump 18
 * against Postgres 16). Either PG_BINDIR points at matching client tools, or
 * PG_DOCKER_IMAGE (e.g. postgres:16) runs them from the server's own image.
 */
function command(tool: string, args: string[]): [string, string[]] {
  if (process.env.PG_DOCKER_IMAGE) return ["docker", ["run", "--rm", "-i", "--network", "host", process.env.PG_DOCKER_IMAGE, tool, ...args]];
  return [process.env.PG_BINDIR ? join(process.env.PG_BINDIR, tool) : tool, args];
}
const run = (tool: string, args: string[], input?: Buffer) => {
  const [cmd, argv] = command(tool, args);
  try {
    return execFileSync(cmd, argv, { input, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { stderr?: Buffer };
    throw new Error(`${tool} failed: ${err.stderr?.toString() ?? String(e)}`);
  }
};
const hasPgDump = (() => {
  try {
    run("pg_dump", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

if (url && process.env.REQUIRE_PG_DUMP === "1" && !hasPgDump) {
  throw new Error("REQUIRE_PG_DUMP=1 but pg_dump is not available: the backup/restore qualification would be skipped");
}

describe.skipIf(!url)("database qualification on synthetic data", () => {
  let admin: ReturnType<typeof postgres>;
  const open: Array<ReturnType<typeof postgres>> = [];
  const connect = (db: string) => {
    const c = postgres(urlFor(db), { prepare: false, onnotice: () => {}, max: 2 });
    open.push(c);
    return c;
  };

  beforeAll(async () => {
    admin = postgres(url!, { prepare: false, onnotice: () => {}, max: 1 });
    for (const db of Object.values(DBS)) await admin.unsafe(`CREATE DATABASE ${db}`);
  });

  afterAll(async () => {
    await Promise.all(open.map((c) => c.end({ timeout: 1 })));
    for (const db of Object.values(DBS)) await admin.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  });

  it("a fresh empty database gets every table and the strict safety constraints", async () => {
    const db = connect(DBS.fresh);
    expect((await db`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`)[0].n).toBe(0);
    for (const s of SCHEMA_STATEMENTS) await db.unsafe(s);
    for (const t of [...SCHEMA_TABLES, ...STRICT_SCHEMA_TABLES]) {
      expect((await db`SELECT to_regclass(${`public.${t}`}) AS r`)[0].r, t).toBe(t);
    }
    expect(await strictSchemaReady(tagFor(db))).toEqual({ ready: true, missing: [] });
  });

  it("an existing legacy database migrates additively, idempotently and rollback-safe", async () => {
    const db = connect(DBS.legacy);
    await db.unsafe(readFileSync(join(__dirname, "fixtures", "legacy-fork-0.5.17-schema.sql"), "utf8"));
    // Synthetic rows in every legacy table (no real data).
    await db.unsafe(`
      INSERT INTO synced_workouts (hevy_id, garmin_activity_id, title, calories, avg_hr, status, hevy_updated_at, sync_method)
        VALUES ('syn-1', '1001', 'Synthetic A', 300, 120, 'success', '2026-01-01T00:00:00Z', 'upload'),
               ('syn-2', NULL, 'Synthetic B', NULL, NULL, 'skipped', NULL, 'upload');
      INSERT INTO sync_log (synced, skipped, failed, trigger) VALUES (1, 1, 0, 'manual');
      INSERT INTO hr_cache (hevy_id, data) VALUES ('syn-1', '{"samples": [[0, 100]]}');
      INSERT INTO platform_credentials (platform, auth_type, credentials, status)
        VALUES ('hevy', 'api_key', '{"api_key": "synthetic-not-a-key"}', 'connected');
      INSERT INTO custom_mappings (hevy_name, category, subcategory) VALUES ('Synthetic Lift', 0, 1);
      INSERT INTO app_cache (key, value) VALUES ('merge_settings', '{"merge_mode": true}');
    `);
    const legacyTables = ["synced_workouts", "sync_log", "hr_cache", "platform_credentials", "custom_mappings", "app_cache"];
    const columnsBefore = await db`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`;
    // Each legacy row is compared on the columns it had: the migration may add
    // columns (upstream's resolution/resync fields), never change existing values.
    const legacyColumns = (t: string) => columnsBefore.filter((c) => c.table_name === t).map((c) => String(c.column_name));
    const before = Object.fromEntries(await Promise.all(legacyTables.map(async (t) => [t, await digest(db, t, legacyColumns(t))] as const)));

    for (let pass = 0; pass < 2; pass++) for (const s of SCHEMA_STATEMENTS) await db.unsafe(s);

    for (const t of legacyTables) expect(await digest(db, t, legacyColumns(t)), `${t} rows changed`).toBe(before[t]);
    const columnsAfter = await db`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1, 2`;
    const key = (r: Record<string, unknown>) => `${r.table_name}.${r.column_name}:${r.data_type}`;
    const after = new Set(columnsAfter.map(key));
    for (const c of columnsBefore) expect(after.has(key(c)), `column lost or retyped: ${key(c)}`).toBe(true);
    expect(await strictSchemaReady(tagFor(db))).toEqual({ ready: true, missing: [] });
  });

  it.skipIf(!hasPgDump)("backup and restore round-trip everything, and restored backups stay insert-only", async () => {
    const db = connect(DBS.legacy);
    const ledger = postgresStrictLedger(tagFor(db));
    const claim = await ledger.claimBinding({ hevyId: "syn-1", activityId: 1001, owner: "q", now: new Date(), leaseMs: 1000 });
    expect(claim.ok).toBe(true);
    const backup = await ledger.saveBackup({ garminActivityId: 1001, hevyId: "syn-1", kind: "original", payload: { exerciseSets: [] }, sha256: "a".repeat(64) });
    await ledger.openJournal({ hevyId: "syn-1", garminActivityId: 1001, step: "exercise_sets", owner: "q", intendedSha256: "b".repeat(64), intended: { exerciseSets: [] }, backupId: backup.id });
    await ledger.setFrozen(true, "qualification");

    const tables = [...SCHEMA_TABLES, ...STRICT_SCHEMA_TABLES];
    const before = Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await digest(db, t)] as const)));

    const dump = run("pg_dump", ["--format=custom", "--no-owner", urlFor(DBS.legacy)]);
    run("pg_restore", ["--no-owner", "--exit-on-error", `--dbname=${urlFor(DBS.restore)}`], dump);

    const restored = connect(DBS.restore);
    for (const t of tables) expect(await digest(restored, t), `${t} differs after restore`).toBe(before[t]);
    expect(await strictSchemaReady(tagFor(restored))).toEqual({ ready: true, missing: [] });
    await expect(restored.unsafe("DELETE FROM strict_backups")).rejects.toThrow(/insert-only/);
    await expect(restored.unsafe("TRUNCATE strict_backups")).rejects.toThrow(/insert-only/);
    expect((await postgresStrictLedger(tagFor(restored)).getControl()).frozen).toBe(true);
  });
});
