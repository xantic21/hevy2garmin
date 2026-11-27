import { NextResponse } from "next/server";
import { stagingRebootstrap } from "@/lib/db";
import { seedStaging, STAGING_SCENARIOS } from "@/lib/staging-fixtures";
import { stagingMode } from "@/lib/staging-mode";
import { strictOperatorRoute } from "@/lib/strict-ops-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// One workout per request with paced, read-back-verified Garmin calls; within every Vercel plan.
export const maxDuration = 60;

/**
 * POST /api/staging/seed {confirm: "SEED"}: empty the synthetic staging data,
 * ledger included, and load the rehearsal scenarios. Synthetic staging only
 * (404 elsewhere), a signed-in session only, on a database the staging guard
 * accepted and marked.
 */
export async function POST(request: Request) {
  if (!stagingMode()) return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  return strictOperatorRoute(
    request,
    async (sql, body) => {
      if (body.confirm !== "SEED") return { seeded: false, reason: "confirm must be SEED" };
      const counts = await seedStaging(sql, stagingRebootstrap);
      return { seeded: true, ...counts, scenarios: STAGING_SCENARIOS.map((s) => ({ hevyId: s.hevyId, title: s.title, expect: s.expect })) };
    },
    { mutating: true },
  );
}
