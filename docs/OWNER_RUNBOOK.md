# Owner checklist: from here to gate G

The only steps left are ones that need you personally, in order. Everything else is done and recorded:
code, tests, rehearsals, the independent audits and the read-only checks. See
[STRICT_OPERATIONS.md](STRICT_OPERATIONS.md) and [STRICT_GATE_F.md](STRICT_GATE_F.md).
Each block ends with a message to Claude. Claude then checks the result read-only and records it.

This document approves nothing. Each block starts only when you decide.

| Block | What | State | Unlocks |
| --- | --- | --- | --- |
| A | Production hardening | **done** (28.11.2026, owner attestation; step 7 waived; read-back below) | B |
| B | Gate F: one real activity, on your Windows computer | about 60 min (the first build takes 10–20) | C |
| C | Merge PR #11 into `main` | about 5 min, GitHub | governance re-baseline |
| D | Gate G | later, separate decision | production |

## A — Production hardening (done)

You confirmed all eight steps on 28.11.2026 (PR #11 comments 7238714843 and 7238742921).
Claude read back what the available read-only access shows on 28.11.2026:

| # | Step | State | Read-back |
| --- | --- | --- | --- |
| 1 | Disable the Vercel cron jobs | done (owner) | not readable with Claude's tools |
| 2 | Database variables to Production only | done | all 18 Neon variables target Production only |
| 3 | Delete `GITHUB_PAT`, `GARMIN_EMAIL`, `GARMIN_PASSWORD`; `HEVY_API_KEY` Production only | done | gone; `HEVY_API_KEY` Production only |
| 4 | Delete old deployments | done | one deployment left: `dpl_4HByTtU3rQTNzMYgQCvnWkieSJe5` (production, main `5e36566`, redeployed 28.11. 11:21 UTC); no preview |
| 5 | Revoke the GitHub token | done (owner) | not readable |
| 6 | Delete the `DATABASE_URL` repository secret, rotate the Neon credential (O-12) | done (owner) | not readable; the Neon variables were re-issued at 11:36 UTC |
| 7 | Change the Garmin password | **waived, owner risk acceptance**, not a rotation | see below |
| 8 | Regenerate the Hevy API key | done (owner) | not readable |

**Step 7, owner risk acceptance (28.11.2026).** You decided not to rotate the
Garmin password and accepted the remaining risk (PR #11 comment 7238714843).
This is recorded as an exception for step 7 only, not as a passed rotation.

- **Remaining risk:** the earlier password was stored readable in up to 40
  deployment snapshots. Deleting them, removing the variable and MFA reduce the
  exposure. They do not invalidate a copy that may already exist, or a session
  that is still open.
- **What stays binding:** every other control. Gate F does not depend on the
  rotation: it signs in to Garmin directly, with MFA, and seals the tokens in its
  own vault.
- **If there is any sign of misuse,** change the password at once.

## B — Gate F: one real activity (Windows, no Docker, no administrator rights)

**Needs:**

- Windows 10 (1803 or later) or 11, x64.
- A **normal Command Prompt**, not "Run as administrator".
- About 3 GB of free space.
- Internet access to nodejs.org, raw.githubusercontent.com, codeload.github.com, registry.npmjs.org, Neon, and Garmin and Hevy.
- On a work computer: only if its rules allow it. Nothing here bypasses them.
  Otherwise use a personal computer.

Everything goes into `%LOCALAPPDATA%\hevy2garmin-gate-f`: local, not OneDrive.

**Binding values** (STRICT_GATE_F.md §3c):

- code commit **`338be15a7c4e0bce83a02205a25949d5f9e3af92`**
- `gate-f.cmd` SHA-256 **`746dc29357d466a20a7a4960b65069b1d6b5125b7b192900ba6d3698dd86f4d2`**

The file pins everything else: Node.js v22.23.5 (official ZIP, SHA-256
`4a191082…a0e3`), `node.exe`, the source manifest and the launcher.

| # | What |
| --- | --- |
| 9 | Record a strength workout with the watch and log it in Hevy. Wait until both apps show it. Note the **Hevy workout id** (in the workout's link) and the **Garmin activity id** (`connect.garmin.com/modern/activity/<id>`) |
| 10 | Neon console → **New project** `hevy2garmin-live` (free plan) → copy its connection string |
| 11 | Start menu → "Command Prompt" (not as administrator). Run the three commands below. Then compare the printed hash with `746dc29357d466a20a7a4960b65069b1d6b5125b7b192900ba6d3698dd86f4d2`; if it differs, stop |
| 12 | `gate-f.cmd setup 338be15a7c4e0bce83a02205a25949d5f9e3af92`. It downloads and checks Node.js and the source, then builds; this takes 10–20 minutes. Expect `build manifest SHA-256 …` at the end; note that value |
| 13 | `gate-f.cmd selftest`. Expect `SELFTEST PASS … 127.0.0.1:8096 only`. It runs without any data |
| 14 | `gate-f.cmd prepare`. Paste the Neon connection string (the input stays hidden), then type the Hevy workout id and the Garmin activity id. It checks the database over verified TLS and that it is empty, then writes `private\gate-f.env`, readable by you only. It prints the **dashboard password** |
| 15 | `gate-f.cmd start`. Expect `READY http://127.0.0.1:8096`, and in the line below it `commit 338be15a7c4e…`; if the commit differs, stop. Leave this window open |
| 16 | Open `http://127.0.0.1:8096` in the browser → sign in → Setup: connect **Hevy** (the new key) and **Garmin** (email, password, MFA code) |
| 17 | Dashboard → **Gate F** panel: **1 · Preview**. Check the activity id, set count, timing and name |
| 18 | Type the confirmation shown (`GATE-F <hevyId> <activityId>`) → **2 · Run gate F** → expect "synced". If it says the plan differs, preview again |
| 19 | **3 · Evidence** → expect "verdict OK (merged)" → save the JSON |
| 20 | Garmin Connect, web and phone. Heart-rate graph, calories, training effect and duration must be unchanged. Exercises, reps and weights must match Hevy. Note whether the exercise **names** are shown or read "Unknown": a known Garmin display limit on watch recordings (upstream #325), not a data fault. Accepting it is your decision |
| 21 | Not accepted? Type the restore confirmation shown (`RESTORE <journal id>`) → **4 · Restore original** → expect "restored" → **3 · Evidence** → expect "verdict OK (original)". If the restore is refused or the verdict is not OK: Strict panel → **Stop all writes**, and tell Claude |
| 22 | Press Ctrl+C in the `start` window and answer `Y` to "Terminate batch job". Or, in a second Command Prompt, run `cd /d %LOCALAPPDATA%` and then `gate-f.cmd stop`. Put `private\gate-f.env`, the dashboard password and the evidence JSON into your password manager; gate G needs `H2G_CREDENTIALS_KEY` from that file |
| 23 | Tell Claude "Gate F: akzeptiert" (or "abgelehnt", with what you saw), share the evidence file and the build manifest value from step 12. A rejection means a code fix in PR #11, a newly qualified commit, and block B again from step 9 in a new folder under `%LOCALAPPDATA%` (`set GATE_F_HOME=%LOCALAPPDATA%\hevy2garmin-gate-f-2`), with a new workout and a new Neon project. All of this comes before C |

The commands for step 11 (Command Prompt):

```bat
cd /d %LOCALAPPDATA%
```

```bat
%SystemRoot%\System32\curl.exe -fsSLo gate-f.cmd https://raw.githubusercontent.com/xantic21/hevy2garmin/338be15a7c4e0bce83a02205a25949d5f9e3af92/tools/gate-f-windows/gate-f.cmd
```

```bat
%SystemRoot%\System32\certutil.exe -hashfile gate-f.cmd SHA256
```

Steps 12–15 run in that same window, from `%LOCALAPPDATA%`.

**If `setup` or `start` refuses**, it says why. The common cases:

- an administrator window
- a OneDrive folder
- a variable such as `NODE_OPTIONS`, `OPENSSL_CONF` or `DATABASE_URL` set in the window
- port 8096 in use
- a changed file

Fix that and run the same command again; nothing has been written to Garmin at that point.
Docker remains possible instead (STRICT_OPERATIONS.md §8, `tools/gate-f/prepare-env.sh`).

## C — Merge PR #11

After gate F is accepted, so that `main` gets the code that passed the real activity.
Merging deploys nothing:

- `vercel.json` and `web/vercel.json` at the merged commit turn off Git deployments.
- No cron runs.
- The current production deployment stays as it is.

| # | Where | What |
| --- | --- | --- |
| 24 | GitHub → PR #11 | Merge only when **every** check on the current head is green, not just the three the `main` ruleset requires ("Tests (SQLite, Python 3.10/3.12)", "Tests (Postgres)"), and Claude's last PR comment confirms that the head differs from the gate F commit in documentation only. Then **Ready for review**, and merge with **Create a merge commit**, not squash or rebase, so the upstream history and attribution are kept. The ruleset may ask for one extra approval for commits made by Claude; approve it yourself |
| 25 | Claude | "#11 gemergt" → read-only check: CI on `main`, no new Vercel deployment, Dependabot alert #1 closed (vitest 5 with a lockfile). Then a handover to the governance lane: remove the `LANE_PENDING` exemption and re-baseline the PES entry for the fork's own code ([PES_EVIDENCE.md](PES_EVIDENCE.md)) |

## D — Gate G (later, separate decision)

This runbook does not approve gate G. The owner steps expected then:

1. Review and approve the gate G pull request, which lifts the build quarantine.
2. Create the Vercel project for the new dashboard with the gate F database and key.
3. Set `H2G_PRODUCTION_CUTOVER`.
4. Only after watching manual syncs, set `H2G_STRICT_AUTOMATIC`.
5. Retire the legacy project.

No fork release, package or signing step exists: releases and PyPI packages stay upstream.
