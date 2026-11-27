<p align="center"><img src="docs/brand/hero.svg" alt="hevy2garmin — a community strength-training integration" width="100%"></p>

<p align="center"><img src="docs/brand/icon.svg" alt="hevy2garmin portfolio icon: dumbbell with a synchronization arrow" width="76"></p>

<p align="center"><strong>Strength training, connected to Garmin.</strong></p>

<p align="center">A community project for moving Hevy strength workouts into Garmin Connect, with structured sets, repetitions and exercise mapping.</p>

<p align="center"><strong>Public fork</strong> · Python + TypeScript · Hevy × Garmin Connect · Upstream maintained by <a href="https://github.com/drkostas/hevy2garmin">drkostas</a></p>

## What it offers

| From Hevy | Into Garmin Connect |
| --- | --- |
| Workouts, exercises, sets, weights and repetitions. | Structured activities with mapped exercise names. |
| Optional wearable heart-rate context. | Better continuity across training records. |

## Project and attribution

This repository is an **independently held fork**, not an original xantform product and not a replacement for the upstream maintainer's instructions. The original application icon, upstream copyright and project license are preserved.

[Upstream project](https://github.com/drkostas/hevy2garmin) · [Original license](LICENSE) · [Project screenshots](docs/screenshots/)

**Code status:** quarantined modernization candidate, based on upstream `b44bdc7c3a34a40fac77c5ec5dd18209f02f6d21`. Not approved for deployment. The existing production installation is not changed by this branch. See the [migration contract](docs/STRICT_MERGE_MIGRATION.md).

**Strict in-place mode (this fork's default):** Hevy sets are written only into the one activity your watch recorded, after a verified backup and with a full read-back. No FIT uploads, no deletions, no automatic runs until the owner approves them. Operations, gates and evidence: [STRICT_OPERATIONS.md](docs/STRICT_OPERATIONS.md).

## Getting started

For requirements, setup, available deployments, maintenance and security guidance, start with the **current [upstream documentation](https://github.com/drkostas/hevy2garmin#readme)**. An older snapshot of this fork's previous detailed README is retained for historical reference below. Do not rely on its legacy instructions for indefinitely valid broad-scope GitHub tokens; prefer current least-privilege, expiring credentials.

## Design

| Tonal light | Tonal dark |
| :---: | :---: |
| <img src="docs/brand/icon.svg" width="76" alt="hevy2garmin portfolio icon: dumbbell with a synchronization arrow"> | <img src="docs/brand/icon-dark.svg" width="76" alt="hevy2garmin portfolio icon, tonal dark variant"> |

The mint portfolio icon follows the xantform [Design System 2.0](https://github.com/xantic21/xantic21/blob/main/docs/xantform/DESIGN_SYSTEM.md) (palette: light `#E6F3EE` · medium `#A4C7B7` · ink `#1F5A4D` · dark `#253F38`) and is used only in GitHub-facing presentation material. It is **not** the original upstream app icon and does not imply original authorship. The upstream application assets, copyright and license are preserved from the pinned upstream tree. The retired Python dashboard remains in the prior fork history.

## Technical reference

- [Archived fork README](docs/brand/UPSTREAM_README_SNAPSHOT_20261122.md) — historical documentation; verify installation details with upstream.
- [Code and project structure](src/hevy2garmin/) — actual fork source.
- [Portfolio icon and attribution](docs/brand/ICON_PROVENANCE.md) — visual contract for GitHub-facing artwork; original app icon preserved.
- [Fork publication policy](docs/brand/PYPI_FORK_PUBLISH_POLICY_20261124.md) — inherited upstream PyPI release workflow disabled for this fork.
- [Security policy](.github/SECURITY.md) — how to report issues to upstream or to the fork owner.
- [xantform README standard](https://github.com/xantic21/xantic21/blob/main/docs/xantform/README_STANDARD.md) — presentation rules only.
- [xantform Design System 2.0](https://github.com/xantic21/xantic21/blob/main/docs/xantform/DESIGN_SYSTEM.md) — names, palettes, icon variants and verification.

## License

The upstream project is licensed under the [MIT License](LICENSE) (copyright Konstantinos Georgiou). This fork keeps the license, attribution and upstream authorship unchanged; the xantform presentation files in `docs/brand/` are original portfolio artwork.

---

<sub>Upstream attribution and original licensing remain authoritative. This is a quarantined migration candidate, not an official upstream release.</sub>
