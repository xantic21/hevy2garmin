import { strictOperatorRoute } from "@/lib/strict-ops-route";
import { strictCandidates } from "@/lib/strict-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/strict/candidates: unsynced finished workouts strict mode would consider. Read-only. */
export async function GET(request: Request) {
  return strictOperatorRoute(request, async (sql) => ({ candidates: await strictCandidates(sql) }), { mutating: false });
}
