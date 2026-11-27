import { strictOperatorRoute } from "@/lib/strict-ops-route";
import { strictDuplicateAudit } from "@/lib/strict-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/strict/duplicate-audit?days=90 — the read-only historical
 * duplicate audit. Reports exact ids, evidence and cleanup candidates;
 * deletes nothing (deleted is always 0). Cleanup is a separate, explicitly
 * approved step that must cite reportSha256.
 */
export async function GET(request: Request) {
  const days = Number(new URL(request.url).searchParams.get("days") ?? 90);
  return strictOperatorRoute(
    request,
    async (sql) => ({ report: await strictDuplicateAudit(sql, Number.isFinite(days) ? days : 90) }),
    { mutating: false },
  );
}
