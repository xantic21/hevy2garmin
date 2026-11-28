#!/usr/bin/env node
/**
 * The owner's gate F path, clicked through the dashboard exactly as
 * docs/OWNER_RUNBOOK.md block B describes it, against a FRESH synthetic gate F
 * deployment (a new database: the one run is consumed here):
 *
 *   1 · Preview → type the confirmation → 2 · Run gate F → 3 · Evidence
 *   (verdict OK, merged) → type the restore confirmation → 4 · Restore original
 *   → 3 · Evidence again (verdict OK, original) → nothing left to restore.
 *
 *   H2G_UI_URL=http://127.0.0.1:8123 H2G_UI_PASSWORD=… node scripts/gate-f-ui-check.mjs
 *
 * Optional: H2G_UI_CHROMIUM (a Chromium binary). Refuses anything but synthetic
 * staging with a synthetic gate F authorization. Exit 1 on the first failed step.
 */
import { chromium } from "@playwright/test";
import { open, signIn } from "./browser-target.mjs";

const base = (process.env.H2G_UI_URL ?? "").replace(/\/+$/, "");
const password = process.env.H2G_UI_PASSWORD ?? "";
if (!base || !password) {
  console.error("usage: H2G_UI_URL=… H2G_UI_PASSWORD=… node scripts/gate-f-ui-check.mjs");
  process.exit(2);
}

let passed = 0;
let reported = false;
const step = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    console.log(`FAIL  ${name}  → ${(e?.message ?? String(e)).split("\n")[0]}`);
    reported = true;
    throw e;
  }
};
const expectText = (panel, re) => panel.getByText(re).first().waitFor({ state: "visible", timeout: 60_000 });

const browser = await chromium.launch(process.env.H2G_UI_CHROMIUM ? { executablePath: process.env.H2G_UI_CHROMIUM } : {});
let ok = false;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  await signIn(page, base, password);
  const status = await (await page.request.get(`${base}/api/strict/gate-f`)).json();
  if (status?.gateF !== true || status?.authorization?.synthetic !== true || status?.record) {
    throw new Error("STOP: not a fresh synthetic gate F deployment (gate F off, a real authorization, or the run already used)");
  }
  await step("seed the synthetic scenario (the authorized workout and its watch activity)", async () => {
    const seed = await page.request.post(`${base}/api/staging/seed`, { data: { confirm: "SEED" } });
    if (seed.status() !== 200 || (await seed.json())?.seeded !== true) throw new Error(`seed HTTP ${seed.status()}`);
  });
  await open(page, base, "/dashboard", { waitUntil: "networkidle" });
  const panel = page.getByRole("region", { name: "Gate F" });
  await step("the gate F panel is shown", () => panel.waitFor({ state: "visible", timeout: 30_000 }));
  await step("nothing to restore before the run", async () => {
    if (await panel.getByRole("button", { name: /Restore original/ }).count()) throw new Error("restore offered before any write");
  });

  await step("1 · Preview: the plan, nothing written", async () => {
    await panel.getByRole("button", { name: /1 · Preview/ }).click();
    await expectText(panel, /^Preview: activity \d+, \d+ sets .*Nothing was written\.$/);
  });
  const confirmation = String(status.confirmation);
  await step("2 · Run gate F refuses until the confirmation is typed exactly", async () => {
    const run = panel.getByRole("button", { name: /2 · Run gate F/ });
    await panel.getByLabel("Gate F confirmation").fill(confirmation.toLowerCase());
    if (await run.isEnabled()) throw new Error("run enabled with a wrong confirmation");
    await panel.getByLabel("Gate F confirmation").fill(confirmation);
    if (!(await run.isEnabled())) throw new Error("run disabled with the right confirmation");
  });
  await step("2 · Run gate F: synced", async () => {
    await panel.getByRole("button", { name: /2 · Run gate F/ }).click();
    await expectText(panel, /^Gate F run: synced; \d+ Garmin write\(s\)/);
  });
  await step("3 · Evidence: downloaded, verdict OK (merged)", async () => {
    const download = page.waitForEvent("download");
    await panel.getByRole("button", { name: /3 · Evidence/ }).click();
    if (!/^gate-f-evidence-\d+\.json$/.test((await download).suggestedFilename())) throw new Error("no evidence file");
    await expectText(panel, /verdict OK \(merged\)/);
  });

  const restoreInput = panel.getByLabel("Restore confirmation");
  const restoreButton = panel.getByRole("button", { name: /4 · Restore original/ });
  let restoreText = "";
  await step("4 · Restore original is offered, bound to the journal entry", async () => {
    await restoreInput.waitFor({ state: "visible", timeout: 30_000 });
    restoreText = String(await restoreInput.getAttribute("placeholder")).replace(/^Type: /, "");
    if (!/^RESTORE \S+$/.test(restoreText)) throw new Error(`unexpected confirmation ${restoreText}`);
    if (await restoreButton.isEnabled()) throw new Error("restore enabled before the confirmation is typed");
    await restoreInput.fill(`${restoreText}x`);
    if (await restoreButton.isEnabled()) throw new Error("restore enabled with a wrong confirmation");
  });
  await step("4 · Restore original: restored", async () => {
    await restoreInput.fill(restoreText);
    await restoreButton.click();
    await expectText(panel, /^Restore: restored\./);
  });
  await step("3 · Evidence again: verdict OK (original)", async () => {
    const download = page.waitForEvent("download");
    await panel.getByRole("button", { name: /3 · Evidence/ }).click();
    await download;
    await expectText(panel, /verdict OK \(original\)/);
  });
  await step("nothing left to restore, and no second run", async () => {
    if (await restoreButton.count()) throw new Error("restore still offered");
    const after = await (await page.request.get(`${base}/api/strict/gate-f`)).json();
    if (after?.record?.state !== "done") throw new Error(`record ${after?.record?.state}`);
  });
  ok = true;
} catch (e) {
  if (!reported) console.log(`FAIL  ${(e?.message ?? String(e)).split("\n")[0]}`);
} finally {
  await browser.close();
}
console.log(`\n${passed} passed, ${ok ? 0 : 1} failed`);
process.exit(ok ? 0 : 1);
