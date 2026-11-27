#!/usr/bin/env node
/**
 * Gate F rehearsal over HTTP, against a running SYNTHETIC STAGING server that
 * also carries a synthetic gate F authorization:
 *
 *   H2G_STAGING=synthetic H2G_GATE_F=approved-by-owner H2G_GATE_F_HEVY_ID=syn-legs \
 *   H2G_GATE_F_GARMIN_ACTIVITY_ID=9100001 H2G_GATE_F_EXPIRES=<ISO time ≤ 14 days ahead> npx next start …
 *   H2G_REHEARSAL_URL=http://127.0.0.1:8122 H2G_REHEARSAL_PASSWORD=<staging password> node scripts/gate-f-rehearsal.mjs
 *
 * It drives exactly what the owner does at gate F (preview, the one run with
 * the typed confirmation, evidence, restore) and proves over HTTP that every
 * other sync path is locked, that the run cannot be repeated, and that the
 * only Garmin writes were the sets and name/description PUTs on the one
 * authorized activity. Optional: H2G_REHEARSAL_BYPASS, H2G_REHEARSAL_REPORT.
 *
 * Safety: it stops before any write unless the target reports itself as
 * synthetic staging AND as a synthetic gate F rehearsal.
 */
const base = (process.env.H2G_REHEARSAL_URL ?? "").replace(/\/+$/, "");
const password = process.env.H2G_REHEARSAL_PASSWORD ?? "";
if (!base || !password) {
  console.error("usage: H2G_REHEARSAL_URL=… H2G_REHEARSAL_PASSWORD=… node scripts/gate-f-rehearsal.mjs");
  process.exit(2);
}

const results = [];
let cookie = "";
async function call(method, path, body, extra = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(process.env.H2G_REHEARSAL_BYPASS ? { "x-vercel-protection-bypass": process.env.H2G_REHEARSAL_BYPASS } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...extra,
    },
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
const gateF = (body) => call("POST", "/api/strict/gate-f", body);
const putsOf = async () => ((await call("GET", "/api/staging/status")).data?.staging?.writes ?? []);

async function main() {
  const login = await call("POST", "/api/login", { password });
  if (!check("sign in", login.status === 200 && cookie, { status: login.status })) return;
  const staging = await call("GET", "/api/staging/status");
  const status0 = await call("GET", "/api/strict/gate-f");
  const auth = status0.data?.authorization;
  if (
    !check(
      "target is synthetic staging with a synthetic gate F authorization",
      staging.data?.staging?.marker?.synthetic === true && status0.data?.gateF === true && auth?.synthetic === true,
      { staging: staging.status, gateF: status0.data },
    )
  ) {
    console.error("STOP: not a synthetic gate F rehearsal. Nothing was written.");
    return;
  }
  const seed = await call("POST", "/api/staging/seed", { confirm: "SEED" });
  check("seed synthetic scenarios", seed.status === 200 && seed.data?.seeded === true, seed);
  const s = (await call("GET", "/api/strict/gate-f")).data;
  check("status: authorization valid, no run yet, every safeguard green",
    s?.authorization?.expired === false && s?.record === null && s?.safeguards?.firewall?.installed === true && s?.safeguards?.schema?.gateFTable === true && s?.safeguards?.envStop === false && s?.safeguards?.writeBlock?.blocked === false,
    s);
  const confirmation = s?.confirmation;
  check("the confirmation names both ids", confirmation === `GATE-F ${auth.hevyId} ${auth.activityId}`, confirmation);

  // Every other sync path is locked, before authentication matters.
  for (const [m, p, body] of [
    ["POST", "/api/sync", { live: true }],
    ["POST", "/api/sync-one", { live: true }],
    ["POST", `/api/sync/${auth.hevyId}`, { live: true }],
    ["GET", "/api/sync/preview"],
    ["POST", "/api/sync-run", {}],
    ["GET", "/api/cron/sync"],
    ["POST", "/api/cron/webhook", {}],
    ["POST", "/api/unsync-all", { confirm: "UNSYNC ALL" }],
    ["POST", "/api/pending/syn-legs/retry", {}],
  ]) {
    const r = await call(m, p, body, { authorization: "Bearer rehearsal" });
    check(`${m} ${p} → 423`, r.status === 423, r);
  }
  check("nothing written so far", (await putsOf()).length === 0, await putsOf());

  const preview = await gateF({ action: "preview" });
  const planSha256 = preview.data?.result?.plan?.planSha256;
  check("preview plans exactly the authorized pair, no write",
    preview.data?.result?.status === "dry_run" && preview.data?.result?.plan?.activityId === auth.activityId && /^[0-9a-f]{64}$/.test(String(planSha256)) && (await putsOf()).length === 0,
    preview.data);
  for (const wrong of ["", "GATE-F", `GATE-F ${auth.hevyId}`, `gate-f ${auth.hevyId} ${auth.activityId}`, `GATE-F ${auth.hevyId} ${auth.activityId + 1}`]) {
    const r = await gateF({ action: "run", confirm: wrong, planSha256 });
    check(`run refused without the exact confirmation (${JSON.stringify(wrong)})`, /type exactly/.test(String(r.data?.refused)), r.data);
  }
  const noPlan = await gateF({ action: "run", confirm: confirmation });
  check("run refused without the previewed plan", /preview first/.test(String(noPlan.data?.refused)), noPlan.data);
  const otherPlan = await gateF({ action: "run", confirm: confirmation, planSha256: "f".repeat(64) });
  check("run with another plan writes nothing", otherPlan.data?.result?.status === "blocked" && /plan differs/.test(String(otherPlan.data?.result?.reason)), otherPlan.data);
  // Cross-site requests: another origin, or a body that is not JSON.
  const foreign = await call("POST", "/api/strict/gate-f", { action: "run", confirm: confirmation, planSha256 }, { origin: "http://localhost:1" });
  check("a request from another origin is refused (403)", foreign.status === 403, foreign);
  const plain = await fetch(`${base}/api/strict/gate-f`, {
    method: "POST",
    headers: { cookie, "content-type": "text/plain", ...(process.env.H2G_REHEARSAL_BYPASS ? { "x-vercel-protection-bypass": process.env.H2G_REHEARSAL_BYPASS } : {}) },
    body: JSON.stringify({ action: "run", confirm: confirmation, planSha256 }),
  });
  check("a non-JSON body is refused (415)", plain.status === 415, plain.status);
  check("still nothing written", (await putsOf()).length === 0, await putsOf());

  const runOut = await gateF({ action: "run", confirm: confirmation, planSha256 });
  check("the one run: synced and verified", runOut.data?.result?.status === "synced" && runOut.data?.record?.state === "done", runOut.data);
  const again = await gateF({ action: "run", confirm: confirmation, planSha256 });
  check("a second run is refused", /already run/.test(String(again.data?.refused)), again.data);

  const ev = await gateF({ action: "evidence" });
  const c = ev.data?.bundle?.comparisons ?? {};
  check("evidence: SHA-256 over the bundle", /^[0-9a-f]{64}$/.test(String(ev.data?.bundleSha256)), ev.data?.bundleSha256);
  check("evidence verdict: merged and OK (backup and journal intact, sets, name and description as written, native metrics unchanged)",
    ev.data?.bundle?.verdict?.expected === "merged" && ev.data?.bundle?.verdict?.ok === true && ev.data?.bundle?.before?.intact === true && c.activityIdConfirmed === true,
    ev.data?.bundle?.verdict);

  const journalId = ev.data?.bundle?.intended?.journalId;
  const restore = await call("POST", "/api/strict/restore", { journalId, source: "original", confirm: `RESTORE ${journalId}` });
  check("restore of the original → restored", restore.data?.result?.status === "restored", restore.data);
  const ev2 = await gateF({ action: "evidence" });
  check("after the restore the verdict is original and OK", ev2.data?.bundle?.verdict?.expected === "original" && ev2.data?.bundle?.verdict?.ok === true, ev2.data?.bundle?.verdict);
  const after = await gateF({ action: "run", confirm: confirmation, planSha256 });
  check("restored is no licence to merge again", /already run/.test(String(after.data?.refused)), after.data);

  const evidence = (await call("GET", "/api/staging/status")).data?.staging ?? {};
  const writes = evidence.writes ?? [];
  check("only the simulated hosts were contacted, nothing else", (evidence.hosts ?? []).every((h) => h === "api.hevyapp.com" || h === "connectapi.garmin.com") && evidence.refusedRequests === 0, evidence.hosts);
  check(
    "every Garmin write was a sets or name/description PUT on the authorized activity",
    writes.length > 0 && writes.every((w) => w.method === "PUT" && new RegExp(`^/activity-service/activity/${auth.activityId}(/exerciseSets)?$`).test(w.path)),
    writes,
  );
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
