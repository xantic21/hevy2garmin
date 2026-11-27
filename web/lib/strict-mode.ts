/**
 * Which sync mode this deployment runs, decided in ONE place.
 *
 * Strict in-place merge is the default and the fail-closed answer: any
 * missing, misspelled or partial configuration runs strict. The upstream
 * behaviour (FIT uploads, replace = delete the watch copy, routines,
 * GitHub-dispatched syncs) runs only when BOTH variables say so exactly:
 *
 *   H2G_SYNC_MODE=legacy_upstream
 *   H2G_LEGACY_UPSTREAM_ACK=uploads-and-deletes-allowed
 *
 * Automatic strict syncs (cron, webhook) additionally need the owner gate
 *   H2G_STRICT_AUTOMATIC=enabled-by-owner
 * which stays unset until the owner has accepted a real activity (Gate F/G).
 *
 * Strict mode never "falls back" to legacy at runtime: there is no code path
 * that switches mode after start-up.
 */
import { NextResponse } from "next/server";
import { StrictModeViolation } from "hevy2garmin";

export type SyncMode = "strict_inplace" | "legacy_upstream";

type Env = Record<string, string | undefined>;

export const LEGACY_ACK = "uploads-and-deletes-allowed";
export const AUTOMATIC_ACK = "enabled-by-owner";

export function syncMode(env: Env = process.env): SyncMode {
  return env.H2G_SYNC_MODE === "legacy_upstream" && env.H2G_LEGACY_UPSTREAM_ACK === LEGACY_ACK
    ? "legacy_upstream"
    : "strict_inplace";
}

export function strictModeActive(env: Env = process.env): boolean {
  return syncMode(env) === "strict_inplace";
}

export function strictAutomaticEnabled(env: Env = process.env): boolean {
  return strictModeActive(env) && env.H2G_STRICT_AUTOMATIC === AUTOMATIC_ACK;
}

/**
 * The answer every route gives for a feature strict mode does not run.
 * 423 Locked: the resource exists, this deployment has it locked.
 */
export function strictRefusal(feature: string): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      strict: true,
      error: `${feature} is disabled in strict in-place mode. It can create, delete or replay Garmin data outside the verified merge path.`,
    },
    { status: 423 },
  );
}

/** For route handlers: a 423 response in strict mode, otherwise null. */
export function strictGuard(feature: string, env: Env = process.env): NextResponse | null {
  return strictModeActive(env) ? strictRefusal(feature) : null;
}

/** For library code that would write to Garmin: throws in strict mode. */
export function assertLegacyGarminWrites(feature: string, env: Env = process.env): void {
  if (strictModeActive(env)) throw new StrictModeViolation(`${feature} is disabled in strict in-place mode`);
}
