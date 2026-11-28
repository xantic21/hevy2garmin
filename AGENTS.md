# Agent development governance

Applies to all automated and human work in this repository. Owner-approved requirements, the migration contract and the security gates remain authoritative. This document cannot grant release or deployment authority and does not override platform or security constraints.

## Project boundary

hevy2garmin here is a public fork of [drkostas/hevy2garmin](https://github.com/drkostas/hevy2garmin) (MIT, upstream attribution preserved). The fork carries one owner-approved code change: the strict in-place merge migration ([docs/STRICT_MERGE_MIGRATION.md](docs/STRICT_MERGE_MIGRATION.md)), based on upstream `b44bdc7`. Everything else (application features, releases, PyPI packages) belongs to upstream.

- Strict mode is the default everywhere. Never add or re-enable a path that uploads a FIT file, deletes a Garmin activity, replays a legacy pending upload, or writes outside the verified in-place merge. Never weaken the firewall, the journal, the backups, the read-back, the hard stop, the deployment quarantine or a test.
- Owner gates, in order and never merged into one another: E isolated synthetic staging, F one owner-authorized real activity (owner's own computer only), G production cutover and then automatic sync. Status and evidence: [docs/STRICT_OPERATIONS.md](docs/STRICT_OPERATIONS.md) §3; the owner's remaining steps: [docs/OWNER_RUNBOOK.md](docs/OWNER_RUNBOOK.md).
- No real credentials, real workout data or production database access in development, CI, previews or staging. Synthetic data only; staging refuses anything else by design.

## Execution

- Inspect the actual branch, SHA, open pull requests, CI and the gate state before changes. One writer per branch; coordinate with other sessions and never overwrite concurrent edits or force-push a shared branch.
- Implement the complete agreed scope with a traceable requirement-to-evidence map. Every safeguard gets a test and a negative control in [tools/maintenance/strict_mutations.py](tools/maintenance/strict_mutations.py); a change to a safeguard re-runs its controls.
- A code candidate is qualified only as a whole: engine and dashboard tests including real Postgres, Python tests, lint, the synthetic HTTP rehearsals and CI on that exact SHA. Reuse evidence only where its SHA is proven identical. Never claim an unverified result.
- Never expose secrets, tokens, credentials or personal data. Do not grant broad permissions or add tokens to work around a blocker.
- No merge, production deployment, package publication, real Garmin or Hevy write, automation, change to the production Vercel project or database, or deletion without the owner's separate approval.
- Executable workflow changes are separate, qualified pull requests, never part of a documentation change.

## Portfolio and brand (xantform)

- The portfolio governance lives in [xantic21/henning-hub](https://github.com/xantic21/henning-hub) (registers and handoffs on its issue #79). This repository keeps the name **hevy2garmin** (upstream fork).
- Files in `docs/brand/` are copies of the central masters in henning-hub [`docs/brand/xantform`](https://github.com/xantic21/henning-hub/blob/main/docs/brand/xantform/README.md); change them only there. The README follows the [xantform README standard](https://github.com/xantic21/henning-hub/blob/main/docs/brand/xantform/README_STANDARD.md). The upstream favicon, license and copyright stay unchanged.
