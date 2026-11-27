# Owner runbook: from here to gate G

Only the steps that need the owner personally, in order. Everything else
(code, tests, rehearsals, documentation, read-only checks) is done and
recorded in [STRICT_OPERATIONS.md](STRICT_OPERATIONS.md) and
[STRICT_GATE_F.md](STRICT_GATE_F.md). Each phase ends with a message to
Claude, which checks the result read-only and records it.

Nothing below is approved by this document. Each phase starts only with your
decision.

## Phase 1 — Production hardening (about 15 minutes, browser only)

Why: the legacy production app still has a daily sync that uploads FIT files,
and its real credentials reach every preview build (STRICT_OPERATIONS.md §14).

| # | Where | What |
| --- | --- | --- |
| 1 | Vercel → project `hevy2garmin` → Settings → Cron Jobs | **Disable Cron Jobs** |
| 2 | Vercel → Storage → `neon-champagne-mountain` → Projects → `hevy2garmin` | environments: **Production only** |
| 3 | Vercel → `hevy2garmin` → Settings → Environment Variables | delete `GITHUB_PAT`, `GARMIN_EMAIL`, `GARMIN_PASSWORD`; `HEVY_API_KEY` → Production only (or delete) |
| 4 | Vercel → `hevy2garmin` → Deployments | select all **except** the current production deployment (main `5e36566`) → Delete |
| 5 | GitHub → Settings → Developer settings → Tokens | revoke the token that was `GITHUB_PAT` |
| 6 | Garmin account | change the password (sign in again on the phone app if asked) |
| 7 | Hevy → Settings → API | regenerate the API key; keep the new one for phase 2 only |
| 8 | Claude | "Härtung erledigt" → read-only check of cron, variables and deployments |

Until step 3 is done, no branch other than `migration/strict-inplace-20261127`
is pushed (any other branch would build a preview with the old credentials).

## Phase 2 — Gate F: one real activity (about 45 minutes)

Needs: Docker Desktop on your computer, a checkout of the qualified commit
(named in STRICT_GATE_F.md), phase 1 done (at least steps 1–7).

| # | What |
| --- | --- |
| 9 | Record a strength workout with the watch and log it in Hevy. Wait until both apps show it. Note the **Hevy workout id** (in the workout's link) and the **Garmin activity id** (`connect.garmin.com/modern/activity/<id>`) |
| 10 | Neon console → **New project** `hevy2garmin-live` (free plan) → copy the connection string |
| 11 | In the checkout: `bash tools/gate-f/prepare-env.sh` → answer the three questions → it writes `gate-f.env` and prints the dashboard password and two `docker` commands → run them |
| 12 | Open `http://localhost:8096` → sign in → Setup: connect **Hevy** (the new key) and **Garmin** (email, password, MFA code) |
| 13 | Dashboard → **Gate F** panel: **1 · Preview** — check activity id, set count, timing, name |
| 14 | Type the confirmation shown (`GATE-F <hevyId> <activityId>`) → **2 · Run gate F** → expect "synced" |
| 15 | **3 · Evidence** → save the JSON |
| 16 | Garmin Connect, web and phone: heart-rate graph, calories, training effect and duration unchanged; exercises, reps, weights as in Hevy; exercise **names shown** |
| 17 | If anything is wrong: Strict panel → **Stop all writes**, then **Restore backup… → original**, then Evidence again |
| 18 | Stop the container (Ctrl-C). Put `gate-f.env` and the evidence JSON into your password manager; `H2G_CREDENTIALS_KEY` from it is needed at gate G |
| 19 | Claude | "Gate F: akzeptiert" (or "abgelehnt", with what you saw) and the evidence file → recorded; gate G prepared as a separate pull request |

## Phase 3 — Gate G (later, separate decision)

Not part of this runbook's approval. Expected owner steps then: review and
approve the gate G pull request (lifts the build quarantine), create the Vercel
project for the new dashboard with the gate F database and key, set
`H2G_PRODUCTION_CUTOVER`, and only after watching manual syncs, set
`H2G_STRICT_AUTOMATIC`. Retire the legacy project.
