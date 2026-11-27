/**
 * Runs once when the Node.js server starts (Next.js instrumentation hook).
 *
 * In strict in-place mode it installs the Garmin network firewall on the
 * process-wide fetch BEFORE any request is served, so every code path,
 * including ones added later, meets the same default-deny policy.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertStagingEnvironment, stagingMode } = await import("./lib/staging-mode");
  // Synthetic staging refuses to start as a production deployment or outside strict mode.
  assertStagingEnvironment();
  const { ensureStrictFirewall } = await import("./lib/strict-sync");
  if (ensureStrictFirewall()) {
    console.log("[strict] Garmin network firewall installed: uploads, deletes and non-merge writes are refused");
  }
  if (stagingMode()) {
    console.log("[staging] synthetic staging: Hevy and Garmin are simulated in-process; no external network, no credentials");
  }
}
