import { NextResponse } from "next/server";
import { resolveTerminal } from "@/lib/pending-store";
import { getDb } from "@/lib/db";
import { strictModeActive } from "@/lib/strict-mode";

// Writes the app's own synced_workouts ledger at request time — never at build.
export const dynamic = "force-dynamic";

/**
 * POST /api/workout/[hevyId]/skip
 * Body: { reason?: string }
 *
 * Records a deliberate skip: inserts a terminal 'skipped' row into
 * synced_workouts (so this workout is excluded from future sync candidates) and
 * clears any pending row. DB-only — no Garmin call, no upload.
 *
 * NOTE: auth-gating (session cookie / middleware) is added in the login phase;
 * this route is intentionally unauthenticated for now.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ hevyId: string }> },
) {
  const { hevyId } = await params;
  if (!hevyId) {
    return NextResponse.json({ error: "hevyId is required." }, { status: 400 });
  }

  let body: { reason?: unknown } = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;

  // Strict in-place mode: skipping only marks a workout nobody has touched yet.
  // A legacy pending row is quarantined evidence of an upload, a ledger row or a
  // strict binding records a write; deleting or overwriting either would lose
  // track of what is on Garmin and could let the workout be written twice.
  if (strictModeActive()) {
    try {
      const sql = getDb();
      const [pending, synced, bound] = await Promise.all([
        sql`SELECT 1 FROM pending_uploads WHERE hevy_id = ${hevyId} LIMIT 1`.catch(() => []),
        sql`SELECT 1 FROM synced_workouts WHERE hevy_id = ${hevyId} LIMIT 1`.catch(() => []),
        sql`SELECT 1 FROM strict_bindings WHERE hevy_id = ${hevyId} LIMIT 1`.catch(() => []),
      ]);
      if (pending.length || synced.length || bound.length) {
        return NextResponse.json(
          { ok: false, strict: true, error: "In strict in-place mode only an untouched workout can be skipped; this one has a pending, synced or bound record." },
          { status: 423 },
        );
      }
    } catch (err) {
      return NextResponse.json({ ok: false, error: `DB unavailable: ${(err as Error).message}` }, { status: 503 });
    }
  }

  try {
    await resolveTerminal(hevyId, { status: "skipped", reason, source: "web" });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error }, { status: 500 });
  }

  return NextResponse.json({ ok: true, hevyId, status: "skipped" });
}
