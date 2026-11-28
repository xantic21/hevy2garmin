#!/usr/bin/env node
/**
 * Vercel "Ignored Build Step" for this quarantined migration candidate
 * (web/vercel.json → ignoreCommand). Exit 0 = Vercel skips the build,
 * exit 1 = the build runs.
 *
 * A build runs ONLY for a preview deployment in synthetic staging mode
 * (H2G_STAGING=synthetic, gate E). Production and every other preview are
 * skipped here, and next.config.ts refuses them again at build time.
 */
const env = (process.env.VERCEL_ENV ?? "").trim();
const staging = (process.env.H2G_STAGING ?? "").trim() === "synthetic";
if (env === "preview" && staging) {
  console.log("[quarantine] synthetic staging preview: building");
  process.exit(1);
}
console.log(`[quarantine] build skipped: only a synthetic-staging preview may build (VERCEL_ENV=${env || "unset"}, H2G_STAGING=${staging ? "synthetic" : "unset"})`);
process.exit(0);
