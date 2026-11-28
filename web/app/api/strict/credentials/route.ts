import { strictOperatorRoute } from "@/lib/strict-ops-route";
import { migrateCredentials, vaultStatus } from "@/lib/credential-vault";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/strict/credentials: how the stored credentials are protected (counts only, never a value). */
export async function GET(request: Request) {
  return strictOperatorRoute(request, async (sql) => ({ credentials: await vaultStatus(sql) }), { mutating: false });
}

/**
 * POST /api/strict/credentials {confirm: "ENCRYPT"} seals every plaintext row
 * and re-seals every row still under a previous key with the current
 * H2G_CREDENTIALS_KEY. Migration and rotation are the same operation; each row
 * is a compare-and-set, so a concurrent login is never overwritten. A signed-in
 * session only (never the cron bearer).
 */
export async function POST(request: Request) {
  return strictOperatorRoute(
    request,
    async (sql, body) => {
      if (body.confirm !== "ENCRYPT") return { changed: false, reason: "confirm must be ENCRYPT" };
      const result = await migrateCredentials(sql);
      return { changed: result.encrypted.length + result.rotated.length > 0, result, credentials: await vaultStatus(sql) };
    },
    { mutating: true },
  );
}
