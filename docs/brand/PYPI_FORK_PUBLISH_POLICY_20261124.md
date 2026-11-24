# Fork publication policy · 24 November 2026

This is the **public xantic21 fork** of [drkostas/hevy2garmin](https://github.com/drkostas/hevy2garmin), not an independent publisher of the upstream `hevy2garmin` Python package.

## Verified behavior

- The existing `.github/workflows/publish.yml` was inherited from upstream and was triggered on **every push to `main`**. It contained a conditional job capable of creating a version tag and performing PyPI Trusted Publishing if the version string in `pyproject.toml` changed.
- A docs-only merge on 24 November 2026 started that workflow; `check-version` succeeded and `publish` was **skipped**, so **no release was produced by that run**.
- Although the skip worked, future version-file edits could have reached the publishing job. This is not an appropriate default for a personally maintained public fork.

## Enforced fork boundary

The workflow now requires `github.repository == 'drkostas/hevy2garmin'` **at both jobs**, independently of version checks. Consequently, `xantic21/hevy2garmin` cannot run either the tag-creation or PyPI publication step under this workflow.

This change is intentionally narrow: the upstream `drkostas/hevy2garmin` repository is **not** modified; the fork's source code, package version, runtime, Vercel integration, original favicon, attribution and MIT license remain unchanged. The normal `CI` workflow remains enabled.

**Reactivation:** Only after an explicit owner decision to publish an independently owned and properly identified package, a separate reviewed release workflow and verified PyPI ownership should be configured. Never rely on this inherited upstream publisher for the fork.
