/**
 * Shared by the browser checks (a11y-scan, perf-probe, gate-f-ui-check): sign
 * in, refuse anything but a synthetic staging deployment, and open a page only
 * when it really loaded (HTTP 200 on the requested path, not an error page or
 * a redirect to the login).
 *
 * The synthetic check matters because every dashboard page makes server-side
 * calls with the deployment's stored credentials: pointed at a real
 * deployment, a scan would drive real Hevy, Garmin and GitHub requests.
 * H2G_BROWSER_ALLOW_REAL=1 skips it, for an owner who decides so.
 */
export async function signIn(page, base, password) {
  await open(page, base, "/login", { waitUntil: "networkidle" });
  await page.fill('input[type="password"]', password);
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
  if (process.env.H2G_BROWSER_ALLOW_REAL === "1") return;
  const res = await page.request.get(`${base}/api/staging/status`);
  const body = await res.json().catch(() => ({}));
  if (res.status() !== 200 || body?.staging?.marker?.synthetic !== true) {
    throw new Error(`STOP: ${base} is not a synthetic staging deployment (staging status ${res.status()}); nothing was scanned`);
  }
}

/** Navigate and fail unless the requested page itself answered 200. */
export async function open(page, base, path, options = { waitUntil: "load" }) {
  const res = await page.goto(`${base}${path}`, options);
  const landed = new URL(page.url()).pathname;
  if (!res || res.status() !== 200 || landed !== path) {
    throw new Error(`${path} did not load: HTTP ${res?.status() ?? "none"}, landed on ${landed}`);
  }
  return res;
}
