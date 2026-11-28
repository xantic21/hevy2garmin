"""The web dashboard seals platform_credentials (AES-256-GCM, web/lib/credential-vault.ts).

The Python package has no key for that envelope by design. It must never mistake the envelope
for a credential, and must fall back to the environment variables instead.
"""

from __future__ import annotations

from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest

from hevy2garmin.config import credentials_sealed, get_github_pat, load_config

ENVELOPE = {
    "h2g_enc": "h2g-aesgcm-v1",
    "kid": "0123456789abcdef",
    "iv": "AAAA",
    "tag": "AAAA",
    "ct": "AAAA",
}


def _fake_db(rows):
    cur = MagicMock()
    cur.fetchall.return_value = rows
    cur.fetchone.return_value = rows[0] if rows else None
    cur.__enter__.return_value = cur
    conn = MagicMock()
    conn.cursor.return_value = cur
    conn.__enter__.return_value = conn

    @contextmanager
    def get_conn():
        yield conn

    db = MagicMock()
    db._get_conn = get_conn
    return db


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in ("HEVY_API_KEY", "GITHUB_PAT"):
        monkeypatch.delenv(var, raising=False)


def test_recognises_only_the_envelope() -> None:
    assert credentials_sealed(ENVELOPE)
    assert not credentials_sealed({"api_key": "x"})
    assert not credentials_sealed({"h2g_enc": "something-else"})
    assert not credentials_sealed(None)


def test_github_pat_falls_back_to_env_for_a_sealed_row(monkeypatch, caplog) -> None:
    db = _fake_db([{"credentials": dict(ENVELOPE, pat="must-not-be-read")}])
    with (
        patch("hevy2garmin.db.get_database_url", return_value="postgresql://x"),
        patch("hevy2garmin.db.get_db", return_value=db),
    ):
        assert get_github_pat() is None
        monkeypatch.setenv("GITHUB_PAT", "synthetic-env-pat")
        assert get_github_pat() == "synthetic-env-pat"
    assert "encrypted by the web dashboard" in caplog.text


def test_load_config_ignores_sealed_rows(tmp_path, monkeypatch) -> None:
    rows = [{"platform": "hevy", "credentials": dict(ENVELOPE, api_key="must-not-be-read")}]
    db = _fake_db(rows)
    with (
        patch("hevy2garmin.config.CONFIG_DIR", tmp_path),
        patch("hevy2garmin.config.CONFIG_FILE", tmp_path / "config.json"),
        patch("hevy2garmin.config.get_database_url", return_value="postgresql://x", create=True),
        patch("hevy2garmin.db.get_database_url", return_value="postgresql://x"),
        patch("hevy2garmin.db.get_db", return_value=db),
    ):
        cfg = load_config()
    assert cfg.get("hevy_api_key") != "must-not-be-read"
