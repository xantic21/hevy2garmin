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
  if (opts.mutating) {
    // Cross-site request forgery: a browser sends Origin with every POST; another
    // origin (other sites, other local ports) is refused, and the body must be
    // JSON, which a page cannot send cross-origin without a preflight.
    const refusal = sameOriginJsonRefusal(request);
    if (refusal) return refusal;
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

/** A mutating operator request from another origin, or with a non-JSON body: refused. Null = fine. */
export function sameOriginJsonRefusal(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  if (origin) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    const hosts = [request.headers.get("x-forwarded-host"), request.headers.get("host")].filter((h): h is string => Boolean(h));
    if (!originHost || !hosts.some((h) => h.split(",")[0].trim() === originHost)) {
      return NextResponse.json({ ok: false, error: "Cross-origin request refused." }, { status: 403 });
    }
  }
  const length = request.headers.get("content-length");
  const hasBody = length !== null ? Number(length) > 0 : request.body !== null;
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (hasBody && !type.startsWith("application/json")) {
    return NextResponse.json({ ok: false, error: "The body must be JSON (Content-Type: application/json)." }, { status: 415 });
  }
  return null;
}

export const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
