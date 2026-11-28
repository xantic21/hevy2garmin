# PES 1.0 evidence for the fork's own code (prepared for the re-baseline)

This pack prepares the governance lane's re-baseline of
[`products/hevy2garmin.json`](https://github.com/xantic21/henning-hub/blob/main/docs/governance/pes/products/hevy2garmin.json)
once PR #11 is merged. Today that record audits `main` at `5e36566`. There, every
application criterion is N/A, because the code was upstream's. After the merge
the fork ships its own strict engine and dashboard, so those criteria apply.

This document does not change the register; the governance lane is its single
writer.

- **Candidate:** all results hold for code commit **7b63cbf**, measured locally
  on its production build.
- **Data:** synthetic only. Nothing here is a real device or real-data result.
- **Qualification:** the full record is in [STRICT_GATE_F.md](STRICT_GATE_F.md) §3.
- **CI and Vercel:** their results are on PR #11.

## Thresholds, fixed before measuring

| Label | Method | Threshold | Why |
| --- | --- | --- | --- |
| PES-04 page response | `web/scripts/perf-probe.mjs`: production build, local Postgres, synthetic staging data after the rehearsal, Chromium desktop, signed in, 20 warm loads per page after one warm-up | TTFB median ≤ 300 ms and p95 ≤ 800 ms; DOMContentLoaded p95 ≤ 1500 ms, on every page | single-user operator dashboard whose pages read the database and nothing else: slower points to a query regression |
| PES-04 cold start | `next start` to the first `200` on `/login` | ≤ 15 s (measured locally; CI only waits up to 40 s, it does not gate this) | container start for the gate F run |
| PES-04 call volume | the gate F rehearsal's simulator log | Garmin: 0 uploads, 0 deletes, writes only on the one activity; Hevy: reads only | the contract (in place only) |
| PES-07 accessibility | `web/scripts/a11y-scan.mjs`: axe-core 4.13.0, WCAG 2.0/2.1 A and AA, each page's initial state, desktop 1280 px, mobile 390 px, reflow 320 px | 0 violations; every page answers 200 on its own path; no horizontal page scroll at 320 px (WCAG 1.4.10) | WCAG 2.1 AA is the portfolio bar |

## Results by dimension (candidate 7b63cbf)

| PES | Register criteria today | Proposed after the merge | Result | Evidence |
| --- | --- | --- | --- | --- |
| 01 Visual | V03 N/A | the dashboard's design system, contrast, consistent names and icons | PASS (light only, by design) | xantform DS 2.0, light (One UI 9.5): `web/styles/xantform.css`, every text token ≥ 4.5:1 computed in its header, axe contrast 0 violations. There is no dark theme: the owner-approved design is light only, so "dark" is N/A rather than open. Real-device screenshots belong to gate F |
| 02 Interaction | I01 N/A | navigation, empty, error and loading states | PASS | Playwright smoke 6/6: every page renders its "no database" state, desktop and mobile. The gate E rehearsal (38/38) shows every error scenario. The gate F click path 11/11 (`gate-f-ui-check.mjs`). Bottom navigation within thumb reach, 44 px targets |
| 03 Functional | F01–F03 | contract items 1–10 | PASS | engine 617, dashboard 1087, Python 484 / 491 tests; 102 negative controls (100 caught, 2 documented equivalent); gate E 38/38, gate F 35/35 over HTTP; three independent audits and a final audit, all closed |
| 04 Performance | P01, P02 N/A | page response, cold start, call volume, sync latency, rate limits | PASS | worst page `/dashboard`: TTFB median 50 ms, p95 65 ms. Worst DOMContentLoaded p95 96 ms. Cold start 0.9 s. One gate F run: 2 Garmin writes (sets PUT, name/description PUT), 0 uploads, 0 deletes. Rate limits: Garmin 401/429/5xx/timeouts on reads defer without a write (`typescript/tests/strict/strict-sync.test.ts`); Hevy 429 tolerated (`web/lib/hevy-routines.test.ts`). Real sync latency against Garmin is not measured (gate F) |
| 05 Energy | E01 N/A, E02 PASS | — | N/A | server-side web app: no client background work, no cron (`vercel.json` `crons: []`), automatic sync off until gate G |
| 06 Data | D01–D03 | provenance, freshness, units, time zones | PASS | one unambiguous native activity with UTC start and finite timing, otherwise defer; units and zero vs. missing sets verified by full read-back (contract items 1, 3; engine tests). Licence and attribution unchanged |
| 07 Accessibility | A01 PASS, A02 N/A | app accessibility | PASS for automated checks | 0 WCAG A/AA violations on 30 page views, gated in CI. Axe left 66 nodes undecided: 49 icon-only elements with no text, and 17 navigation labels under the translucent bar, which compute to 7.25:1 and 5.57:1 against the darkest possible background. Labelled, focusable scroll regions; visible focus outline. Not covered: dialogs, forms after input and messages after an action (beyond the gate F click path), and a manual screen-reader pass |
| 08 Reliability | R01–R03 | recovery, fail-closed, migration, backup and restore | PASS | write-ahead journal, verified backups, reconcile by read-back, confirmed restore (now also from the gate F panel), hard stop and freeze; schema bootstrap non-destructive; pg_dump/pg_restore drill in the tests; the atomic config write never leaves an empty file |
| 09 Personalization | U01, U02 N/A | persistence, safe defaults | PASS | settings in the database and in `config.json` (owner-only, atomic); safe defaults: strict mode, automatic sync off, dry run without writes, gate F confined to one pair |
| 10 Privacy | X01, X02 PASS; X03 NOT_TESTED; X04 FAIL | — | X03 owner; X04 PASS | X03 (F02): runbook step 6 (owner). X04 (F04): the legacy server is removed on #11; `config.json` is written 0600 in a 0700 folder, atomically; credentials sealed with AES-256-GCM in the dashboard; no telemetry by default; synthetic data only in CI and staging |

## Findings map

| Register finding | State on #11 | Evidence |
| --- | --- | --- |
| HEVY2GARMIN-F02 (old `DATABASE_URL` secret) | owner | [OWNER_RUNBOOK.md](OWNER_RUNBOOK.md) step 6 |
| HEVY2GARMIN-F04 (legacy dashboard, `config.json` rights) | fixed on the branch, closes on merge | `src/hevy2garmin/server.py` removed; `src/hevy2garmin/config.py` with `tests/test_config.py`, controls P01–P04. The register's proposed fix was docs-only; the code change is recorded under contract item 7 |
| HEVY2GARMIN-F05 (no governance contract) | fixed on the branch, closes on merge | [`AGENTS.md`](../AGENTS.md), [`CLAUDE.md`](../CLAUDE.md) |
| HEVY2GARMIN-F06 / F-H2G-01 (Dependabot #1, vitest < 3.2.6) | closes on merge | `typescript/package.json` vitest ^5 with `typescript/package-lock.json` |
| `LANE_PENDING` exemption (`docs/brand/ICON_PROVENANCE.md:5`) | governance, after the merge | henning-hub `audit_portfolio.py` |
