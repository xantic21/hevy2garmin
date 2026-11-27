/**
 * Shared plumbing for the /api/strict/* operator routes: strict mode only,
 * a signed-in session for anything that changes state (never the cron
 * bearer), JSON in and out.
 */
import { NextResponse } from "next/server";
import { getDb } from "./db";
import { strictModeActive } from "./strict-mode";
import { strictAuthorized } from "./strict-routes";

type Sql = ReturnType<typeof getDb>;

export async function strictOperatorRoute(
  request: Request,
  handler: (sql: Sql, body: Record<string, unknown>) => Promise<unknown>,
  opts: { mutating: boolean },
): Promise<NextResponse> {
  if (!strictModeActive()) {
    return NextResponse.json({ ok: false, error: "This deployment is not in strict in-place mode." }, { status: 409 });
  }
  if (opts.mutating && !(await strictAuthorized(request, { allowCron: false }))) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  let body: Record<string, unknown> = {};
  if (opts.mutating) {
    try {
      const text = await request.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
    }
  }
  let sql: Sql;
  try {
    sql = getDb();
  } catch (err) {
    return NextResponse.json({ ok: false, error: `DB unavailable: ${(err as Error).message}` }, { status: 503 });
  }
  try {
    return NextResponse.json({ ok: true, ...((await handler(sql, body)) as Record<string, unknown>) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}

export const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
