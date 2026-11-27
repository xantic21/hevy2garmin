/**
 * Route handlers for strict mode. Each sync route calls one of these first
 * thing when `strictModeActive()`, so the legacy engine, GitHub-dispatched
 * runs and the staged webhook retry are unreachable in a strict deployment.
 *
 * Responses keep the fields the existing dashboard components read (status,
 * dryRun, workout, garminActivityId, error, mode, totals) and add `strict`
 * with the full strict result, so nothing in the UI reads a missing field.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import type { StrictSyncResult, StrictTrigger } from "hevy2garmin";
import { authEnabled, productionRuntime, SESSION_COOKIE, verifySession } from "./auth";
import { bearerMatches } from "./bearer";
import { getDb } from "./db";
import { getSessionEpoch } from "./session-epoch";
import { gateFMode, gateFRefusalBody } from "./gate-f";
import { runStrictSync, type StrictRouteOptions } from "./strict-sync";

type Sql = ReturnType<typeof getDb>;

/** Session cookie (with the sign-out-everywhere epoch) or the CRON_SECRET bearer. */

/** Time after which a live batch request starts no further workout (one sync stays within 60 s). */
export const STRICT_BATCH_BUDGET_MS = 20_000;

export async function strictAuthorized(request: Request, opts: { allowCron: boolean }): Promise<boolean> {
  const cron = process.env.CRON_SECRET ?? "";
  if (opts.allowCron && cron && bearerMatches(request.headers.get("authorization"), cron)) return true;
  if (!authEnabled()) return !productionRuntime();
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE)?.value ?? null;
  // The sign-out-everywhere epoch; unreadable (no database) means epoch 0, as the proxy assumes.
  let epoch = 0;
  try {
    epoch = await getSessionEpoch(getDb());
  } catch {
    epoch = 0;
  }
  return verifySession(cookie, epoch);
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

function flag(request: Request, body: Record<string, unknown>, name: string): boolean {
  const q = new URL(request.url).searchParams.get(name);
  if (q === "1" || q === "true") return true;
  const b = body[name];
  return b === 1 || b === true || b === "1" || b === "true";
}

const STATUS_VIEW: Record<StrictSyncResult["status"], string> = {
  dry_run: "dry_run",
  synced: "synced",
  already_synced: "skipped",
  none: "none",
  pending: "merge_pending",
  needs_review: "needs_review",
  blocked: "deferred",
  failed: "failed",
  uncertain: "processing",
};

/** The legacy-shaped view of a strict result, with the full result attached. */
export function strictView(r: StrictSyncResult, remaining = 0) {
  return {
    status: STATUS_VIEW[r.status],
    dryRun: r.dryRun,
    wouldUpload: false,
    dedupDecision: `strict_${r.status}`,
    workout: r.hevyId ? { hevy_id: r.hevyId, title: r.title, start_time: null } : null,
    fitStats: null,
    existingGarminActivityId: r.activityId,
    garminActivityId: r.activityId,
    remaining,
    syncMethod: r.activityId ? "merge" : null,
    error: ["failed", "blocked", "uncertain", "needs_review"].includes(r.status) ? r.reason : null,
    mergeFallbackReason: r.status === "pending" ? r.reason : null,
    strict: r,
  };
}

/** Per-workout outcomes the next candidate may still be fine after. */
const SKIP_TO_NEXT = new Set<StrictSyncResult["status"]>(["pending", "needs_review"]);
export const MAX_CANDIDATES_PER_REQUEST = 10;

/**
 * The next workout that can actually be acted on. A workout whose watch
 * activity has not arrived, or that needs review, is passed over (and listed)
 * instead of being returned again and again to a client that loops.
 */
export async function runStrictNext(
  sql: Sql,
  o: Omit<StrictRouteOptions, "targetHevyId" | "excludeHevyIds">,
): Promise<{ result: StrictSyncResult; passedOver: StrictSyncResult[] }> {
  const tried: string[] = [];
  const passedOver: StrictSyncResult[] = [];
  for (let i = 0; i < MAX_CANDIDATES_PER_REQUEST; i++) {
    const r = await runStrictSync(sql, { ...o, excludeHevyIds: tried });
    if (!SKIP_TO_NEXT.has(r.status) || !r.hevyId) return { result: r, passedOver };
    tried.push(r.hevyId);
    passedOver.push(r);
  }
  const last = passedOver.at(-1)!;
  return { result: { ...last, status: "none", reason: `no actionable workout among the next ${MAX_CANDIDATES_PER_REQUEST}` }, passedOver };
}

function db(): Sql | NextResponse {
  try {
    return getDb();
  } catch (err) {
    return NextResponse.json({ error: `DB unavailable: ${(err as Error).message}` }, { status: 503 });
  }
}

/** POST /api/sync-one and /api/sync/[hevyId] in strict mode. Dry run unless live AND authorized. */
/** Gate F mode: the generic sync routes never run (the gate F route is the only merge path). */
function gateFLocked(): NextResponse | null {
  return gateFMode() ? NextResponse.json(gateFRefusalBody(), { status: 423 }) : null;
}

export async function strictSyncRoute(request: Request, target?: string): Promise<NextResponse> {
  const locked = gateFLocked();
  if (locked) return locked;
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const live = flag(request, body, "live");
  if (live && !(await strictAuthorized(request, { allowCron: false }))) {
    return NextResponse.json({ error: "Unauthorized: a live sync requires a session." }, { status: 401 });
  }
  const sql = db();
  if (sql instanceof NextResponse) return sql;
  const trigger: StrictTrigger = flag(request, body, "batch") ? "batch" : "manual";
  try {
    if (target) {
      const r = await runStrictSync(sql, { dryRun: !live, trigger, targetHevyId: target, resync: flag(request, body, "resync") });
      return NextResponse.json(strictView(r));
    }
    const { result, passedOver } = await runStrictNext(sql, { dryRun: !live, trigger });
    return NextResponse.json({ ...strictView(result), passedOver: passedOver.map((p) => strictView(p)) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/** POST /api/sync (the batch) in strict mode: never dispatches to GitHub Actions. */
export async function strictBatchRoute(request: Request): Promise<NextResponse> {
  const locked = gateFLocked();
  if (locked) return locked;
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const live = flag(request, body, "live");
  if (live && !(await strictAuthorized(request, { allowCron: false }))) {
    return NextResponse.json({ error: "Unauthorized: a live batch sync requires a session." }, { status: 401 });
  }
  const sql = db();
  if (sql instanceof NextResponse) return sql;
  try {
    if (!live) {
      const { result, passedOver } = await runStrictNext(sql, { dryRun: true, trigger: "batch" });
      return NextResponse.json({
        dryRun: true,
        mode: "preview",
        candidates: result.status === "none" ? 0 : 1 + passedOver.length,
        preview: strictView(result),
        strict: true,
      });
    }
    const runs: StrictSyncResult[] = [];
    // Workouts an earlier request of the same "Sync all" already tried (the client sends them back).
    const earlier = Array.isArray(body.exclude) ? body.exclude.filter((x): x is string => typeof x === "string").slice(0, 1000) : [];
    const tried: string[] = [...earlier];
    // One request stays well inside the function limit (maxDuration 60 s): a new
    // workout starts only while the budget lasts, and the client calls again
    // for the rest. A run cut off mid-write by the platform would leave the
    // deployment blocked until someone reconciles it.
    const budgetMs = Math.max(1_000, Number(process.env.H2G_BATCH_BUDGET_MS) || STRICT_BATCH_BUDGET_MS);
    const started = Date.now();
    let more = false;
    let stopped = false;
    for (let i = 0; i < 50; i++) {
      if (Date.now() - started > budgetMs) {
        more = true;
        break;
      }
      const r = await runStrictSync(sql, { dryRun: false, trigger: "batch", excludeHevyIds: [...tried] });
      if (r.status === "none") break;
      runs.push(r);
      if (r.hevyId) tried.push(r.hevyId);
      // A global stop (freeze, unreconciled write, uncertain outcome) ends the batch.
      if (r.status === "blocked" || r.status === "uncertain" || (r.status === "needs_review" && r.writes > 0)) {
        stopped = true;
        break;
      }
    }
    const count = (s: StrictSyncResult["status"]) => runs.filter((r) => r.status === s).length;
    return NextResponse.json({
      dryRun: false,
      mode: "inline",
      strict: true,
      runs: runs.map((r) => strictView(r)),
      // More candidates may remain: the client calls again with `exclude: tried`.
      more: more && !stopped,
      tried,
      totalSynced: count("synced"),
      totalSkipped: count("already_synced") + count("pending"),
      totalDeferred: count("blocked") + count("needs_review"),
      totalError: count("failed") + count("uncertain"),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * GET /api/cron/sync and POST /api/cron/webhook in strict mode. Bearer
 * CRON_SECRET only (constant-time). Locked (423) until the owner gate is set,
 * and then never more than the strict engine allows.
 */
export async function strictAutomaticRoute(request: Request, trigger: "cron" | "webhook"): Promise<NextResponse> {
  const locked = gateFLocked();
  if (locked) return locked;
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) return NextResponse.json({ ok: false, error: "CRON_SECRET is unset." }, { status: 503 });
  if (!bearerMatches(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  const sql = db();
  if (sql instanceof NextResponse) return sql;
  try {
    const { result, passedOver } = await runStrictNext(sql, { dryRun: false, trigger });
    if (result.status === "blocked" && /owner activates/.test(result.reason ?? "")) {
      return NextResponse.json({ ok: false, mode: "strict_locked", strict: true, reason: result.reason }, { status: 423 });
    }
    return NextResponse.json({
      ok: !["failed", "uncertain"].includes(result.status),
      mode: "strict",
      status: strictView(result).status,
      strict: result,
      passedOver: passedOver.length,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
