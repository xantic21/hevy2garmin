/**
 * Test helper: a uniquely named scratch database per test file, created from
 * TEST_DATABASE_URL and dropped afterwards. Test files run in parallel, and a
 * file that recreates the strict tables must never pull them from under
 * another file. Never point TEST_DATABASE_URL at a server with real data.
 */
import postgres from "postgres";
import type { Sql } from "./pending-store";

export async function createScratchDatabase(prefix: string): Promise<{ url: string; db: ReturnType<typeof postgres>; sql: Sql; drop: () => Promise<void> }> {
  const base = process.env.TEST_DATABASE_URL!;
  const name = `h2gt_${prefix}_${process.pid}_${Date.now().toString(36)}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const admin = postgres(base, { prepare: false, onnotice: () => {}, max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const u = new URL(base);
  u.pathname = `/${name}`;
  const url = u.toString();
  const db = postgres(url, { prepare: false, onnotice: () => {} });
  const tag = ((s: TemplateStringsArray, ...v: unknown[]) =>
    (db as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>)(s, ...v).then((r) => Array.from(r))) as unknown as Sql;
  (tag as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => db.json(v as never);
  return {
    url,
    db,
    sql: tag,
    drop: async () => {
      await db.end({ timeout: 1 });
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
