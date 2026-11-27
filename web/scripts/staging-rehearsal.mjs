#!/usr/bin/env node
/**
 * Gate E rehearsal over HTTP, against a running SYNTHETIC STAGING deployment:
 * a local production build in CI, or the Vercel staging preview.
 *
 *   H2G_REHEARSAL_URL=https://<staging-preview> H2G_REHEARSAL_PASSWORD=<staging password> node scripts/staging-rehearsal.mjs
 *
 * Optional: H2G_REHEARSAL_BYPASS (Vercel deployment-protection bypass token,
 * sent as x-vercel-protection-bypass), H2G_REHEARSAL_REPORT (write the JSON
 * report to this path), H2G_REHEARSAL_SKIP_WAIT=1 (skip the 60 s outage wait).
 *
 * Safety: the script first asks the target whether it is a synthetic staging
 * deployment (GET /api/staging/status, which exists only there) and stops
 * before any write if it is not. It never sends a real credential: the only
 * secret it uses is the staging deployment's own dashboard password.
 */
const base = (process.env.H2G_REHEARSAL_URL ?? "").replace(/\/+$/, "");
const password = process.env.H2G_REHEARSAL_PASSWORD ?? "";
if (!base || !password) {
  console.error("usage: H2G_REHEARSAL_URL=… H2G_REHEARSAL_PASSWORD=… node scripts/staging-rehearsal.mjs");
  process.exit(2);
}

const results = [];
let cookie = "";
const headers = (extra = {}) => ({
  ...(cookie ? { cookie } : {}),
  ...(process.env.H2G_REHEARSAL_BYPASS ? { "x-vercel-protection-bypass": process.env.H2G_REHEARSAL_BYPASS } : {}),
  ...extra,
});

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: headers(body === undefined ? {} : { "content-type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && /h2g_session=/.test(setCookie)) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, 200);
  }
  return { status: res.status, data };
}

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  → ${JSON.stringify(detail).slice(0, 400)}`}`);
  return Boolean(ok);
}

const strictOf = (r) => r.data?.strict ?? {};
const sync = async (hevyId, live) => strictOf(await call("POST", `/api/sync/${hevyId}`, live ? { live: true } : {}));

async function main() {
  // 0. Is this a synthetic staging deployment? (unauthenticated: the proxy answers 401 everywhere but login)
  const login = await call("POST", "/api/login", { password });
  if (!check("sign in to the staging dashboard", login.status === 200 && cookie, { status: login.status })) return;
  const staging = await call("GET", "/api/staging/status");
  if (!check("target is a synthetic staging deployment", staging.status === 200 && staging.data?.staging?.marker?.synthetic === true, staging)) {
    console.error("STOP: not a synthetic staging deployment. Nothing was written.");
    return;
  }

  // 1. Credentials can never reach it.
  for (const p of ["/api/garmin-login", "/api/garmin-login-mfa", "/api/garmin-ticket", "/api/garmin-ticket-exchange", "/api/connect-hevy", "/api/validate-hevy", "/api/setup-actions", "/api/strict/credentials"]) {
    const r = await call("POST", p, { placeholder: "not-a-credential" });
    // 423 from the staging lock, or from the strict lock that some of these routes meet first.
    check(`credential route ${p} → 423`, r.status === 423 && (r.data?.staging === true || r.data?.strict === true), r);
  }
  for (const p of ["/api/unsync/syn-legs", "/api/unsync-all", "/api/routines/sync"]) {
    const r = await call("POST", p, { confirm: "UNSYNC ALL" });
    check(`destructive route ${p} → 423`, r.status === 423, r);
  }

  // 2. Fresh synthetic data.
  const seed = await call("POST", "/api/staging/seed", { confirm: "SEED" });
  check("seed synthetic scenarios", seed.status === 200 && seed.data?.seeded === true, seed);
  const st = (await call("GET", "/api/strict/status")).data?.status ?? {};
  check("firewall installed (network-free self-test)", st.firewall?.installed === true, st.firewall);
  check("ledger schema ready", st.schema?.ready === true, st.schema);
  check("automatic sync off", st.automaticEnabled === false, st.automaticEnabled);
  check("no stored credential", st.credentials?.rows === 0, st.credentials);

  // 3. Scenarios.
  const prev = await sync("syn-legs", false);
  check("preview plans the merge into 9100001, no write", prev.status === "dry_run" && prev.plan?.activityId === 9100001 && prev.writes === 0, prev);
  const legs = await sync("syn-legs", true);
  check("clean scenario synced", legs.status === "synced", legs);
  check("ambiguous → needs review, nothing written", (await sync("syn-ambiguous", true)).writes === 0);
  const missing = await sync("syn-missing", true);
  check("missing recording → waits, nothing written", missing.status === "pending" && missing.writes === 0, missing);
  const legacy = await sync("syn-legacy", true);
  check("legacy workout → needs review, nothing written", legacy.status === "needs_review" && legacy.writes === 0, legacy);
  const reject = await sync("syn-reject", true);
  check("rejected write → not synced", reject.status !== "synced", reject);
  const pull = await sync("syn-pull", true);
  check("lost response → read-back verifies, synced", pull.status === "synced", pull);
  const hinge = await sync("syn-hinge", true);
  check("lost response + outage → uncertain", hinge.status === "uncertain" && hinge.journalIds?.length === 1, hinge);
  const blocked = await sync("syn-core", true);
  check("live writes blocked while uncertain", blocked.status === "blocked", blocked);
  if (process.env.H2G_REHEARSAL_SKIP_WAIT !== "1") {
    console.log("…waiting 62 s for the simulated outage to end");
    await new Promise((r) => setTimeout(r, 62_000));
    const rec = await call("POST", "/api/strict/reconcile", { journalId: hinge.journalIds?.[0] });
    check("reconcile by read-back → verified, no write", rec.data?.result?.status === "verified" && rec.data?.result?.writes === 0, rec);
    const lift = await call("POST", "/api/strict/freeze", { frozen: false, confirm: "UNFREEZE" });
    check("stop lifted after reconcile", lift.data?.frozen === false, lift);
    const core = await sync("syn-core", true);
    check("timed scenario synced with synthesized timing", core.status === "synced" && core.plan?.timingSource === "synthesized", core);
    const push = await sync("syn-push", true);
    check("read-back mismatch → needs review", push.status === "needs_review", push);
    const frozen = (await call("GET", "/api/strict/status")).data?.status?.control?.frozen;
    check("writes frozen after the mismatch", frozen === true, frozen);
    const journalId = push.journalIds?.[0];
    const restore = await call("POST", "/api/strict/restore", { journalId, source: "original", confirm: `RESTORE ${journalId}` });
    check("restore of the original → restored", restore.data?.result?.status === "restored", restore);
  }

  // 4. Read-only audit and the network evidence.
  const audit = await call("GET", "/api/strict/duplicate-audit?days=30");
  check("duplicate audit reports the legacy upload 9100009", audit.status === 200 && JSON.stringify(audit.data).includes("9100009"), audit.status);
  const after = (await call("GET", "/api/staging/status")).data?.staging ?? {};
  const hosts = [...new Set((after.requests ?? []).map((r) => r.host))];
  check("only the simulated hosts were contacted", hosts.every((h) => h === "api.hevyapp.com" || h === "connectapi.garmin.com"), hosts);
  check("no request to any other host", after.refusedRequests === 0, after.refusedRequests);
  const writes = (after.requests ?? []).filter((r) => r.method !== "GET").map((r) => r.path);
  check("every simulated write is a sets or name/description PUT", writes.every((p) => /^\/activity-service\/activity\/\d+(\/exerciseSets)?$/.test(p)), writes);
}

main()
  .catch((e) => check("rehearsal ran to the end", false, String(e?.stack ?? e)))
  .finally(async () => {
    const failed = results.filter((r) => !r.ok);
    const report = { target: base, at: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results };
    if (process.env.H2G_REHEARSAL_REPORT) (await import("node:fs")).writeFileSync(process.env.H2G_REHEARSAL_REPORT, JSON.stringify(report, null, 2));
    console.log(`\n${report.passed} passed, ${report.failed} failed`);
    process.exit(failed.length || !results.length ? 1 : 0);
  });
