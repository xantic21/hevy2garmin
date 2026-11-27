"""Strict in-place mode for the Python package (fork-only migration guard).

The fork's verified sync path is the TypeScript strict in-place engine in the
web dashboard. The Python package and CLI are an alternate path that is not
independently qualified for strict mode, so every function here that would
create, change or delete data on Garmin or intervals.icu refuses unless the
legacy upstream behaviour is chosen explicitly, with the same two variables
the dashboard reads:

    H2G_SYNC_MODE=legacy_upstream
    H2G_LEGACY_UPSTREAM_ACK=uploads-and-deletes-allowed

Anything else, including no configuration at all, is strict (fail-closed).
Reads (listing, matching, exporting) are never affected.
"""

from __future__ import annotations

import os

LEGACY_MODE = "legacy_upstream"
LEGACY_ACK = "uploads-and-deletes-allowed"


class StrictModeViolation(RuntimeError):
    """A write strict in-place mode never performs from this package."""


def strict_mode_active(env: dict[str, str] | None = None) -> bool:
    e = os.environ if env is None else env
    return not (
        e.get("H2G_SYNC_MODE") == LEGACY_MODE and e.get("H2G_LEGACY_UPSTREAM_ACK") == LEGACY_ACK
    )


def refuse_if_strict(feature: str) -> None:
    """Raise before any network call when strict mode is active."""
    if strict_mode_active():
        raise StrictModeViolation(
            f"{feature} is disabled in strict in-place mode. The Python CLI is not a qualified "
            "strict path; use the dashboard's verified merge, or set H2G_SYNC_MODE=legacy_upstream "
            f"and H2G_LEGACY_UPSTREAM_ACK={LEGACY_ACK} to run the upstream behaviour deliberately."
        )
