import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { removeRoutine } from "@/lib/garmin-routine-sync";
import { getDb } from "@/lib/db";
import { verifySession, SESSION_COOKIE, authEnabled } from "@/lib/auth";
import { strictGuard } from "@/lib/strict-mode";
import { bearerMatches } from "@/lib/bearer";

// Deletes a Garmin planned workout at request time.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/routines/[hevyId]/remove
 *
 * Deletes the routine's planned workout on Garmin and removes the routine and its
 * schedules from this app (#733). A workout Garmin no longer has is removed here
 * only. Same authorization gate as sync/schedule/unschedule.
 */
async function isAuthorized(request: Request): Promise<boolean> {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    // Constant-time (fork hardening): a plain === leaks the secret's prefix by timing.
    if (bearerMatches(request.headers.get("authorization"), cronSecret)) return true;
  }
  if (!authEnabled()) return true;
  const store = await cookies();
  return verifySession(store.get(SESSION_COOKIE)?.value ?? null);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ hevyId: string }> },
) {
  const locked = strictGuard("Removing a routine from Garmin");
  if (locked) return locked;
  const { hevyId } = await params;
  if (!hevyId) {
    return NextResponse.json({ error: "hevyId is required." }, { status: 400 });
  }
  if (!(await isAuthorized(request))) {
    return NextResponse.json(
      { error: "Unauthorized: removing a routine requires a session or CRON_SECRET." },
      { status: 401 },
    );
  }

  let sql: ReturnType<typeof getDb>;
  try {
    sql = getDb();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `DB unavailable: ${error}` }, { status: 503 });
  }

  try {
    const result = await removeRoutine(hevyId, sql);
    const code = result.status === "error" ? 502 : 200;
    return NextResponse.json({ ok: result.status === "removed", ...result }, { status: code });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error }, { status: 502 });
  }
}
