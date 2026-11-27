# Strict in-place merge — operations and qualification dossier

Status: **development-qualified on synthetic data; deployment quarantine in force.**
Contract: [STRICT_MERGE_MIGRATION.md](STRICT_MERGE_MIGRATION.md). Branch
`migration/strict-inplace-20261127`, draft PR #11. Nothing here authorises a
deployment, a live sync, a package publication or a change to real Garmin or
Hevy data. Each of those needs the owner's separate approval (gates E–G).

## 1. What strict mode guarantees, and where each guarantee is enforced

| Guarantee | Enforced by (outermost first) | Evidence |
| --- | --- | --- |
| No FIT upload, no activity delete, no workout/calendar/gear write | 1. process `fetch` firewall (`typescript/src/strict/firewall.ts`, installed by `web/instrumentation.ts` and before every Garmin client); 2. 423 in `web/proxy.ts`; 3. 423 in each route; 4. library guards (`assertLegacyGarminWrites`); 5. the strict engine's Garmin port has no upload/delete at all | `tests/strict/firewall.test.ts`, `web/app/api/strict-route-matrix.strict.test.ts`, `web/lib/strict-e2e.db.strict.test.ts`, CI "Web against an empty database" (production server: firewall self-test, 423s) |
| Only sets and name/description of ONE activity, only inside a capability scope for that id | firewall classifier + AsyncLocalStorage scope shared process-wide | firewall tests incl. two engine copies in one process |
| One unambiguous native original; defer otherwise | `selectStrictMergeMatch` + reverse match against other Hevy workouts + listing-truncation check + detail re-check | `tests/strict/strict-sync.test.ts` "matching" |
| Exclusive durable binding, atomic claims | `strict_bindings` (both ids UNIQUE), single-statement claim, leases | ledger contract on memory and Postgres |
| Immutable original backup, verified before any write | `strict_backups` insert-only triggers, one `original` per activity, SHA-256 read back before the PUT | contract + DB tests (UPDATE/DELETE/TRUNCATE refused, also after restore) |
| Write-ahead journal; uncertain ⇒ blocked; no blind retry | `put_sent` durable before the request; read-back decides `verified` / `not_applied` / `needs_review` (+ freeze) | strict-sync tests: lost response, timeout, partial read-back, crash after `put_sent`, concurrent runs |
| Native timing, HR and metrics preserved; user notes kept; no estimated HR/kcal in text | payload overlays watch timing when set counts match; 19 native metric paths compared after every write; description block appended between markers | model tests, e2e test |
| Dry run writes nothing (Garmin AND database) | default `dryRun: true`; plan computed from reads only | dry-run tests compare full ledger dumps / row counts |
| Automatic paths off | `H2G_STRICT_AUTOMATIC=enabled-by-owner` required; otherwise 423 | route matrix, CI production check |
| Legacy pending uploads quarantined | strict engine refuses them; retry/abandon/finalize routes 423 | strict-sync + matrix tests |
| Python CLI cannot write | `refuse_if_strict` before every Garmin/intervals.icu write | `tests/test_strict_mode.py` |

## 2. Configuration

Strict mode needs **no** variable. Every variable below exists to be set
deliberately, and a missing or misspelled one keeps the safe state.

| Variable | Effect |
| --- | --- |
| *(none)* | strict in-place merge, firewall on, automatic runs locked |
| `H2G_STRICT_AUTOMATIC=enabled-by-owner` | gate G: cron and webhook may run the strict merge |
| `H2G_STRICT_STOP=1` | stop switch at deployment level: every live strict write refused before DB, Hevy or Garmin are touched |
| `H2G_SYNC_MODE=legacy_upstream` **and** `H2G_LEGACY_UPSTREAM_ACK=uploads-and-deletes-allowed` | upstream behaviour (uploads, replace = delete). Both, exactly. Never for this deployment |
| `H2G_DIRECT_GARMIN_LOGIN=1` or `GARMIN_LOGIN_WORKER_URL=<your own Worker>` | how Garmin sign-in runs. With neither, sign-in is refused; credentials are never sent to the shared upstream Worker |
| `H2G_UPDATE_CHECK=off` | recommended: no calls to the GitHub API for the update banner (the banner is hidden in strict mode anyway) |

## 3. Gates (contract § Gates)

| Gate | State | Evidence / what remains |
| --- | --- | --- |
| A snapshot and quarantine | done | `vercel.json` (both roots) deployment off, `next.config.ts` refuses Vercel builds, no publish path, `typescript/` private with `prepublishOnly` refusal |
| B end-to-end strict mode | done (synthetic) | engine 523 tests, web 822 tests incl. Postgres (strict project included), e2e through firewall + Postgres |
| C synthetic migration and full CI | done | `web/lib/db-qualification.db.test.ts` (fresh DB, previous fork-main schema, pg_dump/restore); all CI jobs |
| D independent review | prepared | see `docs/STRICT_REAUDIT.md` (findings and their closure) |
| E isolated staging | **owner** | procedure §7; synthetic data only |
| F one owner-accepted real activity | **owner** | procedure §8 |
| G production activation | **owner** | set `H2G_STRICT_AUTOMATIC` only after F; keep stop switches documented |

## 4. Deployment (quarantined)

- Build the container from the repository root:
  `docker build -f web/Dockerfile -t hevy2garmin-web .` The image compiles
  the engine from `typescript/`, installs it into `web/node_modules` as a copy
  and fails the build unless `web/scripts/verify-engine.mjs` proves the
  installed engine is the private fork build of this commit's source.
- At start the log must show
  `[strict] Garmin network firewall installed`; `GET /api/strict/status`
  (signed in) must report `firewall.installed: true` (a network-free
  self-test), `schema.ready: true`, `automaticEnabled: false`.
- Vercel stays disabled. The quarantine guards are removed only in a separate,
  reviewed cutover.

## 5. Database

- Additive bootstrap (`web/lib/schema.ts`): four strict tables, two
  insert-only triggers, one partial unique index. Idempotent; never drops or
  alters an upstream table. Live strict writes are blocked unless
  `strictSchemaReady` confirms tables, triggers and index.
- **Backup**: `pg_dump --format=custom --no-owner "$DATABASE_URL" > h2g-$(date +%F).dump`
  with client tools of the **same major version as the server** (CI found that
  pg_dump 18 output cannot be restored into Postgres 16).
- **Restore** into an empty database: `pg_restore --no-owner --exit-on-error --dbname="$TARGET" h2g.dump`;
  then check `GET /api/strict/status` → `schema.ready` and that
  `DELETE FROM strict_backups` is refused. Qualified on synthetic data, the
  stop switch state survives the round-trip.
- Never delete strict tables: they hold the only copy of the original sets.

## 6. Rollback and stop

- **Stop now**: dashboard "Stop all writes" (or `POST /api/strict/freeze {frozen:true}`);
  if the database is unreachable, set `H2G_STRICT_STOP=1` and restart.
- **Lift** only when no journal entry is open: dashboard "Lift stop…" (typed `UNFREEZE`).
- **Code rollback**: redeploy the previous *strict-qualified* image with the
  stop switch on. Never roll back to an upstream image or set legacy mode: that
  re-enables uploads and deletes. The strict tables are additive; older code
  ignores them, and the migration test proves no legacy column is lost.
- **Undo a verified merge**: open the journal entry → "Restore backup…" →
  choose original or pre-write → type `RESTORE <id>`. One sets PUT and, if
  needed, one name/description PUT, both read back.

## 7. Isolated staging (gate E, owner)

Separate Postgres with synthetic data only; separate deployment with
`H2G_STRICT_STOP` unset, no `H2G_STRICT_AUTOMATIC`, a Garmin test account if
available. Check: start log, `/api/strict/status`, every locked route 423,
dry-run preview of a synthetic workout, duplicate audit (read-only).

## 8. One owner-accepted real activity (gate F, owner)

1. Record a strength workout on the watch and in Hevy; wait until both are synced.
2. `pg_dump` the database (§5).
3. Dashboard → "Preview" for that workout: confirm the activity id, set count,
   timing source and the planned name/description.
4. "Sync now" once. Expect `synced`; the journal shows `exercise_sets:verified`
   and `metadata:verified`; the activity id is unchanged.
5. Compare on Garmin Connect (web and phone) before/after: HR graph, calories,
   training effect, duration unchanged; exercises, reps and weights as in Hevy;
   **exercise names displayed** (read-back verifies stored state only; display
   is confirmed here — upstream #159/#325).
6. If anything differs: "Stop all writes", then "Restore backup…" → original.
7. Only after acceptance: gate G.

## 9. Security notes

- Session: HMAC-signed cookie, 30-day TTL, "sign out everywhere" epoch; argon2
  password hash supported (`H2G_PASSWORD_HASH`, preferred over plain
  `H2G_PASSWORD`, whose comparison is constant-time but length-revealing).
  Login rate limit per IP (5 failures) and global (50).
- Cron/webhook: bearer `CRON_SECRET`, constant-time everywhere.
- Garmin tokens and the Hevy key live in `platform_credentials` as JSON, not
  encrypted at rest by the app: database access equals account access. Keep
  the database private, credentials scoped, and backups encrypted.
- No third-party telemetry by default: the visit/error collector runs only
  when `COLLECTOR_URL` and `COLLECTOR_TOKEN` are both set.
- No live credentials in CI: every secret there is a synthetic placeholder.

## 10. Dependencies (npm audit / pip-audit, 2026-11-27)

| Package set | Production | All | Note |
| --- | --- | --- | --- |
| `typescript/` engine | 0 | 0 | |
| `web/` dashboard | 0 | 0 | soma-style removed (it pulled react-native/metro/image-size) |
| Python (`requirements.txt`) | 0 | — | pip-audit |
| `universal/` Expo app | 7 (4 high) | — | needs an Expo SDK major; not deployed, GET-only, never built or published by CI |

## 11. Upstream cutover blockers

- **#475** (web never created its schema): fixed upstream by `web/lib/schema.ts`;
  proven by CI "Web against an empty database" (write round-trip, nine tables)
  and here extended to the strict tables and triggers.
- **#473** (auth middleware answered `/api/cron/*` with 401): `/api/cron` is a
  public path in `web/proxy.ts` with its own constant-time bearer check; the
  strict cron route answers 423 without the owner gate (CI-checked).

## 12. Known limits

- If Garmin normalises a missing weight/reps to 0 (or the reverse), read-back
  reports a mismatch, the write freezes for review and the backup can be
  restored. Fail-closed by design until gate F shows Garmin's behaviour.
- Warm-ups are written as ACTIVE sets (Garmin's set model has no warm-up flag;
  the watch records them too). Cardio distance is not representable in sets
  and is kept in the journal and description only.
- A Garmin listing of 50 activities for the search window is treated as
  possibly truncated and not decided on.
- The Expo app's remaining advisories (§10).
