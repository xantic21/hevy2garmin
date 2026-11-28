# PES 1.0 evidence for the fork's own code (prepared for the re-baseline)

This pack prepares the governance lane's re-baseline of
[`products/hevy2garmin.json`](https://github.com/xantic21/henning-hub/blob/main/docs/governance/pes/products/hevy2garmin.json)
once PR #11 is merged. Today that record audits `main` at `5e36566`, where every
application criterion is N/A because the code was upstream's. After the merge
the fork ships its own strict engine and dashboard, so those criteria apply.

This document does not change the register. The single writer of the register
is the governance lane. Results here hold for the candidate named in each row,
on synthetic data only. Nothing here is a real device or real-data result.

## Thresholds, fixed before measuring

| Criterion | Method | Threshold | Why this threshold |
| --- | --- | --- | --- |
| P01 page response | `web/scripts/perf-probe.mjs`: production build, local Postgres, synthetic staging data after the rehearsal, Chromium desktop, signed in, 10 warm loads per page | server response (TTFB) median ≤ 300 ms and p95 ≤ 800 ms; DOMContentLoaded p95 ≤ 1500 ms on every page | a single-user operator dashboard; the pages read the database and nothing else, so anything slower points to a query regression |
| P01 cold start | time from `next start` to the first `200` on `/login` | ≤ 15 s | container start for the gate F run and CI |
| P02 call volume | the gate F rehearsal's simulator log for the one run | Garmin: 0 uploads, 0 deletes, writes only on the one activity; Hevy: reads only | the contract (no upload, no delete; in-place only) |
| A02 accessibility | `web/scripts/a11y-scan.mjs` (axe-core 4.10, WCAG 2.0/2.1 A and AA) on every page, desktop 1280 px and mobile 390 px; reflow at 320 px | 0 WCAG A/AA violations; no horizontal page scroll at 320 px (WCAG 1.4.10) | WCAG 2.1 AA is the portfolio's accessibility bar |
