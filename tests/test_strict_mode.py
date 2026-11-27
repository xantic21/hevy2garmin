"""Strict in-place mode in the Python package: every write refuses before the network.

Runs with no mode variables (see conftest), exactly like a strict deployment.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from hevy2garmin import garmin, intervals_icu
from hevy2garmin.strict_mode import StrictModeViolation, strict_mode_active


def test_default_is_strict() -> None:
    assert strict_mode_active() is True


@pytest.mark.parametrize(
    "env",
    [
        {"H2G_SYNC_MODE": "legacy_upstream"},
        {"H2G_LEGACY_UPSTREAM_ACK": "uploads-and-deletes-allowed"},
        {"H2G_SYNC_MODE": "legacy_upstream", "H2G_LEGACY_UPSTREAM_ACK": "yes"},
        {
            "H2G_SYNC_MODE": "LEGACY_UPSTREAM",
            "H2G_LEGACY_UPSTREAM_ACK": "uploads-and-deletes-allowed",
        },
    ],
)
def test_partial_legacy_configuration_stays_strict(env: dict[str, str]) -> None:
    assert strict_mode_active(env) is True


def test_exact_legacy_pair_disables_strict() -> None:
    env = {
        "H2G_SYNC_MODE": "legacy_upstream",
        "H2G_LEGACY_UPSTREAM_ACK": "uploads-and-deletes-allowed",
    }
    assert strict_mode_active(env) is False


WRITES = [
    ("upload_fit", ("/tmp/x.fit",)),
    ("rename_activity", (1, "name")),
    ("set_description", (1, "text")),
    ("delete_activity", (1,)),
    ("upload_image", (1, "/tmp/x.png")),
    ("push_exercise_sets", (1, {"exerciseSets": []})),
    ("create_workout", ({},)),
    ("delete_workout", (1,)),
    ("schedule_workout", (1, "2026-12-01")),
    ("unschedule_workout", (1,)),
]


@pytest.mark.parametrize(("name", "args"), WRITES)
def test_every_garmin_write_refuses_without_touching_the_client(name: str, args: tuple) -> None:
    client = MagicMock()
    with pytest.raises(StrictModeViolation):
        getattr(garmin, name)(client, *args)
    assert client.method_calls == []


def test_intervals_icu_delete_refuses(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INTERVALS_API_KEY", "k")
    monkeypatch.setenv("INTERVALS_ATHLETE_ID", "i1")
    sent = MagicMock()
    monkeypatch.setattr(intervals_icu.requests, "delete", sent)
    monkeypatch.setattr(
        intervals_icu.requests,
        "get",
        MagicMock(
            return_value=MagicMock(
                json=lambda: [{"id": "x", "external_id": "123"}], raise_for_status=lambda: None
            )
        ),
    )
    try:
        intervals_icu.try_delete_icu_activity(123, "2026-03-10T17:00:00+00:00")
    except StrictModeViolation:
        pass
    sent.assert_not_called()
