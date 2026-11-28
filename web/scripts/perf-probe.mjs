#!/usr/bin/env node
/**
 * Page performance probe (PES-04, docs/PES_EVIDENCE.md): Navigation Timing of
 * every dashboard page in Chromium, signed in, against a running deployment
 * (locally: the production build in synthetic staging mode after the rehearsal).
 *
 *   H2G_PERF_URL=http://127.0.0.1:8124 H2G_PERF_PASSWORD=… node scripts/perf-probe.mjs
 *
 * Optional: H2G_PERF_RUNS (warm loads per page, default 20), H2G_PERF_PAGES,
 * H2G_PERF_REPORT (JSON path), H2G_PERF_CHROMIUM (a Chromium binary).
 * One untimed load per page warms it first. Exit 1 when a page misses the
 * thresholds fixed in docs/PES_EVIDENCE.md before measuring: TTFB median
 * <= 300 ms and p95 <= 800 ms, DOMContentLoaded p95 <= 1500 ms, and when a
 * page does not load (HTTP 200 on the requested path). Reads only; refuses a
 * deployment that is not synthetic staging (browser-target.mjs).
 */
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { open, signIn } from "./browser-target.mjs";

const base = (process.env.H2G_PERF_URL ?? "").replace(/\/+$/, "");
const password = process.env.H2G_PERF_PASSWORD ?? "";
if (!base || !password) {
  console.error("usage: H2G_PERF_URL=… H2G_PERF_PASSWORD=… node scripts/perf-probe.mjs");
  process.exit(2);
}
const runs = Math.max(1, Number(process.env.H2G_PERF_RUNS ?? 20));
const pages = (process.env.H2G_PERF_PAGES ?? "/dashboard,/workouts,/history,/mappings,/routines,/settings,/setup").split(",").map((p) => p.trim()).filter(Boolean);
const LIMIT = { ttfbMedian: 300, ttfbP95: 800, dclP95: 1500 };

const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
};
const round = (x) => Math.round(x);

const report = { target: base, at: new Date().toISOString(), runs, limits: LIMIT, pages: {} };
let misses = 0;
const browser = await chromium.launch(process.env.H2G_PERF_CHROMIUM ? { executablePath: process.env.H2G_PERF_CHROMIUM } : {});
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await signIn(page, base, password);
  for (const path of pages) {
    await open(page, base, path);
    const ttfb = [];
    const dcl = [];
    for (let i = 0; i < runs; i++) {
      await open(page, base, path);
      const t = await page.evaluate(() => {
        const n = performance.getEntriesByType("navigation")[0];
        return { ttfb: n.responseStart - n.startTime, dcl: n.domContentLoadedEventEnd - n.startTime };
      });
      ttfb.push(t.ttfb);
      dcl.push(t.dcl);
    }
    const r = {
      ttfbMedian: round(quantile(ttfb, 0.5)),
      ttfbP95: round(quantile(ttfb, 0.95)),
      dclMedian: round(quantile(dcl, 0.5)),
      dclP95: round(quantile(dcl, 0.95)),
    };
    const ok = r.ttfbMedian <= LIMIT.ttfbMedian && r.ttfbP95 <= LIMIT.ttfbP95 && r.dclP95 <= LIMIT.dclP95;
    if (!ok) misses++;
    report.pages[path] = { ...r, ok };
    console.log(`${ok ? "PASS" : "MISS"}  ${path.padEnd(10)} TTFB median ${r.ttfbMedian} ms, p95 ${r.ttfbP95} ms; DOMContentLoaded median ${r.dclMedian} ms, p95 ${r.dclP95} ms`);
  }
  await context.close();
} finally {
  await browser.close();
}
if (process.env.H2G_PERF_REPORT) writeFileSync(process.env.H2G_PERF_REPORT, JSON.stringify(report, null, 2));
console.log(`\n${misses ? `${misses} page(s) missed the thresholds` : "every page within the thresholds"} (${runs} warm loads each)`);
process.exit(misses ? 1 : 0);
