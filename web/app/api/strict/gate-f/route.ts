import { strictOperatorRoute } from "@/lib/strict-ops-route";
import { gateFEvidence, gateFPreview, gateFRun, gateFStatus } from "@/lib/gate-f-run";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// One workout, paced and read back; within every plan's function limit.
export const maxDuration = 60;

/** GET /api/strict/gate-f: the authorization and every safeguard. Database only. */
export async function GET(request: Request) {
  return strictOperatorRoute(request, async (sql) => await gateFStatus(sql), { mutating: false });
}

/**
 * POST /api/strict/gate-f
 *   {action: "preview"}                                    strict dry run of the authorized pair
 *   {action: "run", confirm: "GATE-F <hevyId> <activityId>", planSha256} the one live merge, bound to the preview
 *   {action: "evidence"}                                   before / intended / after, read-only
 */
export async function POST(request: Request) {
  return strictOperatorRoute(
    request,
    async (sql, body) => {
      if (body.action === "preview") return await gateFPreview(sql);
      if (body.action === "run") return await gateFRun(sql, { confirm: body.confirm, planSha256: body.planSha256 });
      if (body.action === "evidence") return await gateFEvidence(sql);
      return { refused: 'action must be "preview", "run" or "evidence"' };
    },
    { mutating: true },
  );
}
