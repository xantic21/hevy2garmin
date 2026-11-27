/**
 * Binds the strict in-place engine to this app: Postgres ledgers, the
 * dashboard's Garmin client (behind the process firewall), the Hevy fetch,
 * the sync window and the user's mappings and timing.
 *
 * Every route that syncs goes through `runStrictSync` in strict mode. The
 * legacy engine (`./sync-one`) is never reached from a strict deployment.
 */
import {
  installStrictGarminFirewall,
  isStrictFirewallInstalled,
  listStrictCandidates,
  reconcileStrictJournal,
  resolveStrictJournal,
  restoreStrictBackup,
  strictGarminPort,
  strictInPlaceSync,
  strictWriteBlock,
  firewallStats,
  firewallSelfTest,
  strictHardStopActive,
  auditDuplicates,
  gatherActivities,
  STRICT_LISTING_LIMIT,
  type StrictSyncOptions,
  type StrictSyncResult,
  type StrictTrigger,
  type RateLimitOptions,
} from "hevy2garmin";
import type { GarminClient } from "garmin-auth";
import { vaultStatus } from "./credential-vault";
import { installStagingTransport } from "./staging-simulator";
import { getGarminClient } from "./garmin-upload";
import { fetchAllWorkouts, fetchAllWorkoutsReadOnly, type HevyWorkout } from "./hevy-sync";
import type { Sql } from "./pending-store";
import { postgresSyncStore } from "./sync-store";
import { loadCustomMappings, loadSyncSettings, loadSyncStartDate } from "./sync-settings";
import { parseStartDate, withinSyncWindow } from "./sync-window";
import { postgresStrictLedger, strictSchemaReady } from "./strict-ledger-store";
import { strictAutomaticEnabled, strictModeActive } from "./strict-mode";

/**
 * Install the Garmin firewall if strict mode is on. Called at server start
 * (instrumentation.ts) AND before any Garmin client is built, so a runtime
 * that skips instrumentation (a test, a script) is still guarded.
 */
export function ensureStrictFirewall(): boolean {
  if (!strictModeActive()) return false;
  // Synthetic staging: what the firewall allows goes to the in-process simulator, never the network.
  installStagingTransport();
  if (!isStrictFirewallInstalled(globalThis)) installStrictGarminFirewall(globalThis);
  return true;
}

export interface StrictRouteOptions {
  dryRun: boolean;
  trigger: StrictTrigger;
  targetHevyId?: string;
  excludeHevyIds?: string[];
  resync?: boolean;
  /** Test seams. */
  fetchWorkouts?: () => Promise<HevyWorkout[]>;
  garminClientFactory?: () => Promise<GarminClient>;
  /** Test seam: production waits STRICT_VERIFY_DELAY_MS before read-back and paces Garmin calls. */
  timing?: { verifyDelayMs?: number; rateLimit?: RateLimitOptions };
}

function deps(sql: Sql, o: Pick<StrictRouteOptions, "fetchWorkouts" | "garminClientFactory" | "resync" | "timing" | "dryRun">) {
  const clientFactory = o.garminClientFactory ?? (() => getGarminClient());
  // A dry run reads Hevy without recording the key's status: no sync bookkeeping.
  const fetch = o.fetchWorkouts ?? (() => (o.dryRun ? fetchAllWorkoutsReadOnly() : fetchAllWorkouts()));
  return {
    ledger: postgresStrictLedger(sql),
    legacy: postgresSyncStore(sql),
    garmin: async () => {
      ensureStrictFirewall();
      return strictGarminPort(await clientFactory(), o.timing?.rateLimit);
    },
    fetchWorkouts: async () => {
      const all = await fetch();
      // The sync window chooses candidates; a resync addresses a workout by id.
      const start = o.resync ? null : parseStartDate(await loadSyncStartDate(sql).catch(() => null));
      return withinSyncWindow(all, start) as never;
    },
  };
}

/** The user's mapping, timing and description choices, in strict-engine terms. */
async function strictOptions(sql: Sql): Promise<Pick<StrictSyncOptions, "customMappings" | "timing" | "metadata">> {
  const [settings, custom] = await Promise.all([loadSyncSettings(sql), loadCustomMappings(sql)]);
  return {
    customMappings: Object.keys(custom).length ? custom : undefined,
    timing: settings.merge.timing,
    metadata: { rename: true, description: settings.descriptionEnabled },
  };
}

/**
 * The deployment-level stop switch: H2G_STRICT_STOP=1 blocks every live strict
 * write regardless of the database (which may be the thing that is broken).
 * The DB stop switch (strict_control) is the operator's in-app equivalent.
 */
export function strictEnvStop(env: Record<string, string | undefined> = process.env): boolean {
  // The engine's definition, so the route check and the network boundary agree.
  return strictHardStopActive(env);
}

export async function runStrictSync(sql: Sql, o: StrictRouteOptions): Promise<StrictSyncResult> {
  ensureStrictFirewall();
  if (!o.dryRun && strictEnvStop()) {
    return {
      status: "blocked",
      reason: "H2G_STRICT_STOP is set: live strict writes are stopped for this deployment",
      trigger: o.trigger,
      dryRun: false,
      hevyId: o.targetHevyId ?? null,
      title: null,
      activityId: null,
      journalIds: [],
      writes: 0,
      plan: null,
      issues: [],
    };
  }
  if (!o.dryRun) {
    const schema = await strictSchemaReady(sql);
    if (!schema.ready) {
      return {
        status: "blocked",
        reason: `strict ledger schema is incomplete (${schema.missing.join(", ")}); live writes stay off`,
        trigger: o.trigger,
        dryRun: false,
        hevyId: o.targetHevyId ?? null,
        title: null,
        activityId: null,
        journalIds: [],
        writes: 0,
        plan: null,
        issues: [],
      };
    }
  }
  return strictInPlaceSync(deps(sql, o), {
    ...(await strictOptions(sql)),
    dryRun: o.dryRun,
    trigger: o.trigger,
    automaticEnabled: strictAutomaticEnabled(),
    targetHevyId: o.targetHevyId,
    excludeHevyIds: o.excludeHevyIds,
    resync: o.resync,
    ...(o.timing?.verifyDelayMs !== undefined ? { verifyDelayMs: o.timing.verifyDelayMs } : {}),
  });
}

export async function strictCandidates(sql: Sql, o: Pick<StrictRouteOptions, "fetchWorkouts"> = {}) {
  return listStrictCandidates(deps(sql, { ...o, dryRun: true }));
}

/** Everything the dashboard shows about strict mode. Read-only. */
export async function strictStatus(sql: Sql) {
  const ledger = postgresStrictLedger(sql);
  const [schema, block, control, open, bindings, credentials] = await Promise.all([
    strictSchemaReady(sql),
    strictWriteBlock(ledger).catch((e: Error) => ({ blocked: true, reason: e.message })),
    ledger.getControl().catch(() => ({ frozen: false, reason: null, updatedAt: null })),
    ledger.listOpenJournal().catch(() => []),
    ledger.listBindings().catch(() => []),
    vaultStatus(sql),
  ]);
  const counts = { claimed: 0, verified: 0, needs_review: 0 } as Record<string, number>;
  for (const b of bindings) counts[b.state] = (counts[b.state] ?? 0) + 1;
  return {
    mode: "strict_inplace" as const,
    automaticEnabled: strictAutomaticEnabled(),
    envStop: strictEnvStop(),
    // Enforcement, proven by a network-free self-test against the live global
    // fetch (not just a marker, which a later wrapper such as Next's would hide).
    firewall: { installed: await firewallSelfTest(globalThis), outermost: isStrictFirewallInstalled(globalThis), ...firewallStats() },
    schema,
    writeBlock: block,
    control,
    // Counts only: whether every stored credential is sealed with the current key.
    credentials,
    openJournal: open.map((e) => ({
      id: e.id,
      hevyId: e.hevyId,
      activityId: e.garminActivityId,
      step: e.step,
      phase: e.phase,
      updatedAt: e.updatedAt,
      detail: e.detail,
    })),
    bindings: counts,
    reviewBindings: bindings
      .filter((b) => b.state !== "verified")
      .map((b) => ({ hevyId: b.hevyId, activityId: b.garminActivityId, state: b.state, lastError: b.lastError })),
  };
}

function recoveryDeps(sql: Sql, garminClientFactory?: () => Promise<GarminClient>, rateLimit?: RateLimitOptions) {
  return {
    ledger: postgresStrictLedger(sql),
    garmin: async () => {
      ensureStrictFirewall();
      return strictGarminPort(await (garminClientFactory ?? (() => getGarminClient()))(), rateLimit);
    },
  };
}

export const strictReconcile = (sql: Sql, journalId: string, f?: () => Promise<GarminClient>, rateLimit?: RateLimitOptions) =>
  reconcileStrictJournal(recoveryDeps(sql, f, rateLimit), journalId);

/**
 * Controlled recovery. The DATABASE stop switch does not block it (recovering
 * a frozen deployment is its purpose); H2G_STRICT_STOP does, here and again at
 * the network boundary.
 */
export async function strictRestore(
  sql: Sql,
  input: { journalId: string; source: "pre_write" | "original"; confirm: boolean },
  f?: () => Promise<GarminClient>,
  timing?: { verifyDelayMs?: number; rateLimit?: RateLimitOptions },
) {
  if (strictEnvStop()) {
    return { status: "refused" as const, reason: "H2G_STRICT_STOP is set: every Garmin write is refused, restores included", journalId: input.journalId, writes: 0 };
  }
  ensureStrictFirewall();
  return restoreStrictBackup(recoveryDeps(sql, f, timing?.rateLimit), input, { verifyDelayMs: timing?.verifyDelayMs });
}

export const strictResolve = (sql: Sql, journalId: string, note: string) =>
  resolveStrictJournal(postgresStrictLedger(sql), journalId, note);

export const strictSetFrozen = (sql: Sql, frozen: boolean, reason: string | null) =>
  postgresStrictLedger(sql).setFrozen(frozen, reason);

/**
 * The read-only historical duplicate audit (contract item 6) over the last
 * `days` days. Reads Hevy, Garmin (paged by date, truncation reported) and
 * both ledgers; writes nothing anywhere.
 */
export async function strictDuplicateAudit(
  sql: Sql,
  days: number,
  o: { fetchWorkouts?: () => Promise<HevyWorkout[]>; garminClientFactory?: () => Promise<GarminClient>; now?: Date; rateLimit?: RateLimitOptions } = {},
) {
  ensureStrictFirewall();
  const now = o.now ?? new Date();
  const span = Math.max(1, Math.min(365, Math.floor(days)));
  const start = new Date(now.getTime() - span * 86_400_000).toISOString().slice(0, 10);
  const end = now.toISOString().slice(0, 10);
  const port = strictGarminPort(await (o.garminClientFactory ?? (() => getGarminClient()))(), o.rateLimit);
  const [all, ledgerRows, bindings] = await Promise.all([
    (o.fetchWorkouts ?? (() => fetchAllWorkoutsReadOnly()))(),
    sql`SELECT hevy_id, garmin_activity_id, sync_method, status FROM synced_workouts`.catch(() => []),
    postgresStrictLedger(sql).listBindings().catch(() => []),
  ]);
  const workouts = (all as Array<Record<string, unknown>>)
    .filter((w) => String(w.start_time ?? "").slice(0, 10) >= start)
    .map((w) => ({ id: String(w.id), title: (w.title as string | null) ?? null, start_time: (w.start_time as string | null) ?? null, end_time: (w.end_time as string | null) ?? null }));
  const { activities, truncatedDays } = await gatherActivities(
    (s, e) => port.activitiesByDate(s, e) as never,
    { start, end },
    STRICT_LISTING_LIMIT,
  );
  return auditDuplicates({
    window: { start, end },
    workouts,
    activities,
    ledger: (ledgerRows as Array<Record<string, unknown>>).map((r) => ({
      hevyId: String(r.hevy_id),
      garminActivityId: r.garmin_activity_id == null ? null : String(r.garmin_activity_id),
      syncMethod: (r.sync_method as string | null) ?? null,
      status: (r.status as string | null) ?? null,
    })),
    bindings,
    truncatedDays,
    now,
  });
}
