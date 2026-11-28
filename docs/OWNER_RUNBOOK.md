# Owner checklist: from here to gate G

The only steps left are ones that need you personally, listed in order. Everything else is done and recorded:
code, tests, rehearsals, the independent audits and the read-only checks. See
[STRICT_OPERATIONS.md](STRICT_OPERATIONS.md) and [STRICT_GATE_F.md](STRICT_GATE_F.md).
Each block ends with a message to Claude. Claude then checks the result read-only and records it.

This document approves nothing. Each block starts only when you decide.

| Block | What | Time | Unlocks |
| --- | --- | --- | --- |
| A | Production hardening, incl. the old repository secret | about 20 min, browser | B |
| B | Gate F: one real activity | about 45 min, your computer | C |
| C | Merge PR #11 into `main` | about 5 min, GitHub | governance re-baseline |
| D | Gate G | later, separate decision | production |

## A — Production hardening

Why:

- The legacy production app still has a daily sync that uploads FIT files.
- Its real credentials reach every preview build (STRICT_OPERATIONS.md §14).
- The legacy app also wrote its production database's connection string into the repository secret `DATABASE_URL`. That secret fed the fork's old auto-sync workflow (PES HEVY2GARMIN-F02).

| # | Where | What |
| --- | --- | --- |
| 1 | Vercel → project `hevy2garmin` → Settings → Cron Jobs | **Disable Cron Jobs** |
| 2 | Vercel → Storage → `neon-champagne-mountain` → Projects → `hevy2garmin` | environments: **Production only** |
| 3 | Vercel → `hevy2garmin` → Settings → Environment Variables | delete `GITHUB_PAT`, `GARMIN_EMAIL`, `GARMIN_PASSWORD`. Set `HEVY_API_KEY` to Production only, or delete it |
| 4 | Vercel → `hevy2garmin` → Deployments | keep only `dpl_3xaUyy9uvxcNnJQPUYHnjeFJibjA`, marked "Current"; select every other deployment → Delete |
| 5 | GitHub → Settings → Developer settings → Tokens | revoke the token that was `GITHUB_PAT` |
| 6 | GitHub → `xantic21/hevy2garmin` → Settings → Secrets and variables → Actions | delete `DATABASE_URL` if it is listed. Then rotate the credential it held: Neon console → the project behind `neon-champagne-mountain` → Roles → reset the password of the app's role. The legacy dashboard then cannot reach its database until its connection string is updated; nothing syncs after step 1, and gate G retires it. To keep the legacy dashboard readable until then, defer the reset: tell Claude "F02 deferred" in step 9 |
| 7 | Garmin account | change the password (sign in again on the phone app if asked) |
| 8 | Hevy → Settings → API | regenerate the API key; keep the new one for block B only |
| 9 | Claude | "Härtung erledigt" → read-only check of cron, variables and deployments |

Until step 3 is done, push no branch other than `migration/strict-inplace-20261127`.
Any other branch would build a preview with the old credentials. Claude cannot see
the repository's secrets (step 6). GitHub shows you their names only, never their values.

## B — Gate F: one real activity

Needs:

- Docker Desktop on your computer
- block A done (at least steps 1–8)
- the qualified code commit **`7b63cbf`** (STRICT_GATE_F.md §3)

```bash
git clone https://github.com/xantic21/hevy2garmin && cd hevy2garmin && git checkout 7b63cbf
```

| # | What |
| --- | --- |
| 10 | Record a strength workout with the watch and log it in Hevy. Wait until both apps show it. Note the **Hevy workout id** (in the workout's link) and the **Garmin activity id** (`connect.garmin.com/modern/activity/<id>`) |
| 11 | Neon console → **New project** `hevy2garmin-live` (free plan) → copy the connection string |
| 12 | In the checkout, run `bash tools/gate-f/prepare-env.sh` and answer the three questions. It writes `gate-f.env` (git-ignored) and prints the dashboard password and two `docker` commands. Run those commands |
| 13 | Open `http://localhost:8096` → sign in → Setup: connect **Hevy** (the new key) and **Garmin** (email, password, MFA code) |
| 14 | Dashboard → **Gate F** panel: **1 · Preview**. Check the activity id, set count, timing and name |
| 15 | Type the confirmation shown (`GATE-F <hevyId> <activityId>`) → **2 · Run gate F** → expect "synced". The run is bound to the preview: if it says the plan differs, preview again |
| 16 | **3 · Evidence** → expect "verdict OK (merged)" → save the JSON |
| 17 | Garmin Connect, web and phone. Heart-rate graph, calories, training effect and duration must be unchanged. Exercises, reps and weights must match Hevy. Note whether the exercise **names** are shown or read "Unknown". "Unknown" is a known Garmin display limit on watch recordings (upstream #325), not a data fault: the read-back has already verified the stored exercises. Whether you accept it is your decision; say which in step 20 |
| 18 | Not accepted? Gate F panel → type the restore confirmation shown (`RESTORE <journal id>`) → **4 · Restore original** → expect "restored" → **3 · Evidence** → expect "verdict OK (original)". This also works after the authorization expired. If the restore is refused or the verdict is not OK: Strict panel → **Stop all writes**, and tell Claude |
| 19 | Stop the container (Ctrl-C). Put `gate-f.env` and the evidence JSON into your password manager; gate G needs `H2G_CREDENTIALS_KEY` from it. The gate F database now refuses every live write unless gate F mode or the gate G cutover is set |
| 20 | Tell Claude "Gate F: akzeptiert" (or "abgelehnt", with what you saw) and share the evidence file. Claude records it. A rejection means a code fix in PR #11, a newly qualified commit, and block B again from step 10: a new workout, a new Neon project and a new `gate-f.env`. The old database stays locked by its gate F record; archive the old file. All of this comes before C |

## C — Merge PR #11

After gate F is accepted, so that `main` gets the code that passed the real activity.
Merging deploys nothing:

- `vercel.json` and `web/vercel.json` at the merged commit turn off Git deployments.
- No cron runs.
- The current production deployment stays as it is.

| # | Where | What |
| --- | --- | --- |
| 21 | GitHub → PR #11 | Merge only when **every** check on the current head is green, not just the three the `main` ruleset requires ("Tests (SQLite, Python 3.10/3.12)", "Tests (Postgres)"), and Claude's last PR comment confirms that the head differs from the gate F commit in documentation only. Then **Ready for review**, and merge with **Create a merge commit**, not squash or rebase, so the upstream history and attribution are kept. The ruleset may ask for one extra approval for commits made by Claude; approve it yourself |
| 22 | Claude | "#11 gemergt" → read-only check: CI on `main`, no new Vercel deployment, Dependabot alert #1 closed (vitest 5 with a lockfile). Then a handover to the governance lane: remove the `LANE_PENDING` exemption and re-baseline the PES entry for the fork's own code ([PES_EVIDENCE.md](PES_EVIDENCE.md)) |

## D — Gate G (later, separate decision)

This runbook does not approve gate G. The owner steps expected then:

1. Review and approve the gate G pull request, which lifts the build quarantine.
2. Create the Vercel project for the new dashboard with the gate F database and key.
3. Set `H2G_PRODUCTION_CUTOVER`.
4. Only after watching manual syncs, set `H2G_STRICT_AUTOMATIC`.
5. Retire the legacy project.

No fork release, package or signing step exists: releases and PyPI packages stay upstream.
