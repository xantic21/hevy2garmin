import { strictOperatorRoute } from "@/lib/strict-ops-route";
import { strictCandidates } from "@/lib/strict-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// One workout per request with paced, read-back-verified Garmin calls; within every Vercel plan.
export const maxDuration = 60;

/** GET /api/strict/candidates: unsynced finished workouts strict mode would consider. Read-only. */
export async function GET(request: Request) {
  return strictOperatorRoute(request, async (sql) => ({ candidates: await strictCandidates(sql) }), { mutating: false });
}
