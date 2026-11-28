#!/usr/bin/env node
/**
 * Accessibility gate: axe-core (WCAG 2.0/2.1 A and AA) over every dashboard
 * page, desktop and mobile, against a running deployment (CI: the synthetic
 * staging build after its rehearsal, so the pages hold data), and reflow at
 * 320 CSS px (WCAG 1.4.10: no horizontal page scroll; wide tables scroll inside
 * their own focusable region).
 *
 *   H2G_A11Y_URL=http://127.0.0.1:8120 H2G_A11Y_PASSWORD=… node scripts/a11y-scan.mjs
 *
 * Optional: H2G_A11Y_PAGES (comma separated, default every page), H2G_A11Y_REPORT
 * (JSON path), H2G_A11Y_CHROMIUM (a Chromium binary, where Playwright's own is not
 * installed). Exit 1 on any WCAG A/AA violation; axe "best-practice" findings
 * are reported but do not fail. Sends nothing but the deployment's own
 * dashboard password.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const base = (process.env.H2G_A11Y_URL ?? "").replace(/\/+$/, "");
const password = process.env.H2G_A11Y_PASSWORD ?? "";
if (!base || !password) {
  console.error("usage: H2G_A11Y_URL=… H2G_A11Y_PASSWORD=… node scripts/a11y-scan.mjs");
  process.exit(2);
}
const pages = (process.env.H2G_A11Y_PAGES ?? "/dashboard,/workouts,/history,/mappings,/routines,/settings,/setup").split(",").map((p) => p.trim()).filter(Boolean);
const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const viewports = [
  { name: "desktop", viewport: { width: 1280, height: 900 } },
  { name: "mobile", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  // Not isMobile: mobile emulation widens the layout viewport to fit oversized
  // content, which would hide exactly the overflow this check looks for.
  { name: "reflow-320", viewport: { width: 320, height: 640 }, reflowOnly: true },
];

/** WCAG 1.4.10: at 320 CSS px the page itself must not scroll sideways. */
async function reflow(page) {
  const r = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: 320 }));
  return r.width > r.viewport + 1
    ? [{ id: "reflow-1.4.10", impact: "serious", wcag: true, help: "Content must reflow at 320 CSS px", nodes: [`page is ${r.width} px wide in a ${r.viewport} px viewport`] }]
    : [];
}

async function scan(page) {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async (wcag) => {
    const r = await window.axe.run(document, { runOnly: { type: "tag", values: [...wcag, "best-practice"] } });
    return r.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      wcag: v.tags.some((t) => wcag.includes(t)),
      help: v.help,
      nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(" ")}: ${(n.failureSummary ?? "").split("\n").slice(0, 2).join(" ")}`),
    }));
  }, WCAG);
}

const report = { target: base, at: new Date().toISOString(), results: {} };
let failures = 0;
const browser = await chromium.launch(process.env.H2G_A11Y_CHROMIUM ? { executablePath: process.env.H2G_A11Y_CHROMIUM } : {});
try {
  for (const vp of viewports) {
    const context = await browser.newContext({ viewport: vp.viewport, isMobile: vp.isMobile, hasTouch: vp.hasTouch });
    const page = await context.newPage();
    const record = (key, violations) => {
      report.results[key] = violations;
      const wcag = violations.filter((v) => v.wcag);
      failures += wcag.length;
      console.log(`${wcag.length ? "FAIL" : "PASS"}  ${key}${violations.length ? `  ${violations.map((v) => `${v.id}${v.wcag ? "" : " (best practice)"}`).join(", ")}` : ""}`);
      for (const v of wcag) for (const n of v.nodes) console.log(`        ${v.id}: ${n}`);
    };
    const check = (p) => (vp.reflowOnly ? reflow(p) : scan(p));
    await page.goto(`${base}/login`, { waitUntil: "networkidle" });
    record(`${vp.name} /login`, await check(page));
    await page.fill('input[type="password"]', password);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
    for (const path of pages) {
      await page.goto(`${base}${path}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(500);
      record(`${vp.name} ${path}`, await check(page));
    }
    await context.close();
  }
} finally {
  await browser.close();
}
if (process.env.H2G_A11Y_REPORT) writeFileSync(process.env.H2G_A11Y_REPORT, JSON.stringify(report, null, 2));
console.log(`\n${failures ? `${failures} WCAG violation(s)` : "no WCAG A/AA violation"} on ${Object.keys(report.results).length} page views`);
process.exit(failures ? 1 : 0);
