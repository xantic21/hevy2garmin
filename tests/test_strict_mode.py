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


# Re-audit finding 1: the sync FLOW must refuse before it touches the ledger,
# not let a swallowed refusal record a false success or park a pending row.
import inspect

from hevy2garmin import cli, merge, sync


def _call_with_mocks(fn, store: MagicMock, client: MagicMock):
    """Call `fn` with a mock for every required parameter, positional or keyword-only."""
    args, kwargs = [], {}
    for i, p in enumerate(inspect.signature(fn).parameters.values()):
        if p.default is not inspect.Parameter.empty or p.kind in (p.VAR_POSITIONAL, p.VAR_KEYWORD):
            continue
        value = store if i == 0 else client
        if p.kind is p.KEYWORD_ONLY:
            kwargs[p.name] = value
        else:
            args.append(value)
    return fn(*args, **kwargs)


@pytest.mark.parametrize(
    "fn",
    [
        "finalize_pending",
        "reconcile_pending",
        "sync_one_workout",
        "sync",
        "sync_routines",
        "sync_routine",
        "schedule_routine",
        "unschedule_routine_entry",
    ],
)
def test_sync_engine_entry_points_refuse_before_any_store_access(fn: str) -> None:
    store = MagicMock()
    client = MagicMock()
    with pytest.raises(StrictModeViolation):
        # The guard is the first statement, so no argument is ever used.
        _call_with_mocks(getattr(sync, fn), store, client)
    assert store.method_calls == []
    assert client.method_calls == []


def test_merge_path_refuses_before_touching_garmin() -> None:
    client = MagicMock()
    with pytest.raises(StrictModeViolation):
        merge.attempt_merge(client, {"id": "w"}, MagicMock())
    assert client.method_calls == []


@pytest.mark.parametrize(
    "command",
    [
        "sync",
        "sync_routines",
        "unsync",
        "reconcile",
        "retry_failed",
        "abandon_pending",
        "mark_synced",
        "skip",
    ],
)
def test_ledger_changing_cli_commands_exit_with_a_clear_error(
    command: str, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    touched = MagicMock()
    monkeypatch.setattr(cli, "db", touched)
    monkeypatch.setattr(cli, "sync", touched)
    monkeypatch.setattr(
        cli.sys,
        "argv",
        [
            "hevy2garmin",
            command.replace("_", "-"),
            *(
                ["x"]
                if command
                in {"unsync", "reconcile", "retry_failed", "abandon_pending", "mark_synced", "skip"}
                else []
            ),
        ],
    )
    with pytest.raises(SystemExit) as exit_info:
        cli.main()
    assert exit_info.value.code != 0
    assert "strict in-place mode" in capsys.readouterr().err
    assert touched.method_calls == []
