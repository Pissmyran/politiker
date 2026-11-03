import json
import os
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest

import backfill_assignments as backfill


DATABASE = "00000000-0000-4000-8000-000000000001"
OTHER_DATABASE = "00000000-0000-4000-8000-000000000002"
CHANGES = {"person-1": ("Example area", {"Socialnämnden"})}


@pytest.fixture
def cache(monkeypatch, tmp_path):
    directory = tmp_path / "cache"
    monkeypatch.setattr(backfill, "CACHE_DIR", directory)
    monkeypatch.setattr(backfill, "CACHE_PATH", directory / "replay.json")
    return directory


def test_cache_round_trip_is_private_and_bound_to_database(cache):
    backfill.save_cache(CHANGES, 123, DATABASE)
    assert stat.S_IMODE(cache.stat().st_mode) == 0o700
    assert stat.S_IMODE((cache / "replay.json").stat().st_mode) == 0o600
    assert backfill.load_cache(DATABASE) == (CHANGES, 123)
    with pytest.raises(SystemExit, match="database id does not match"):
        backfill.load_cache(OTHER_DATABASE)


def test_rejects_untrusted_directory_and_file(cache, tmp_path):
    other = tmp_path / "attacker"
    other.mkdir(mode=0o700)
    cache.symlink_to(other, target_is_directory=True)
    with pytest.raises(SystemExit):
        backfill.load_cache(DATABASE)
    cache.unlink()
    cache.mkdir(mode=0o700)
    cache.chmod(0o755)
    with pytest.raises(SystemExit):
        backfill.load_cache(DATABASE)
    cache.chmod(0o700)
    (cache / "replay.json").symlink_to(tmp_path / "attacker-file")
    with pytest.raises(SystemExit):
        backfill.load_cache(DATABASE)
    (cache / "replay.json").unlink()
    (cache / "replay.json").write_text("{}")
    (cache / "replay.json").chmod(0o644)
    with pytest.raises(SystemExit):
        backfill.load_cache(DATABASE)


def test_rejects_nonregular_and_hardlinked_files(cache, tmp_path):
    cache.mkdir(mode=0o700)
    os.mkfifo(cache / "replay.json", 0o600)
    with pytest.raises(SystemExit):
        backfill.load_cache(DATABASE)
    (cache / "replay.json").unlink()
    other = tmp_path / "file"
    other.write_text("{}")
    other.chmod(0o600)
    os.link(other, cache / "replay.json")
    with pytest.raises(SystemExit):
        backfill.load_cache(DATABASE)


def test_invalid_cache_does_not_trigger_scraping_or_writes(cache, monkeypatch):
    cache.mkdir(mode=0o700)
    path = cache / "replay.json"
    path.write_text("{invalid")
    path.chmod(0o600)
    monkeypatch.setattr(backfill, "resolve_database_id", lambda: DATABASE)
    monkeypatch.setattr(backfill, "scrape_changes", lambda *_: pytest.fail("must not scrape"))
    monkeypatch.setattr(backfill, "write_assignments", lambda *_: pytest.fail("must not write"))
    with pytest.raises(SystemExit):
        backfill.main()
    assert path.read_text() == "{invalid"


def test_retry_validates_contacts_before_writing(cache, monkeypatch):
    backfill.save_cache(CHANGES, 123, DATABASE)
    monkeypatch.setattr(backfill, "resolve_database_id", lambda: DATABASE)
    monkeypatch.setattr(backfill, "load_politician_index", lambda db: {("Different area", "a@example.com"): "person-1"})
    monkeypatch.setattr(backfill, "write_assignments", lambda *_: pytest.fail("must not write"))
    with pytest.raises(SystemExit, match="matchar inte|inte längre matchar"):
        backfill.main()
    assert (cache / "replay.json").exists()


def test_retry_writes_and_removes_cache_only_after_verification(cache, monkeypatch):
    backfill.save_cache(CHANGES, 123, DATABASE)
    monkeypatch.setattr(backfill, "resolve_database_id", lambda: DATABASE)
    monkeypatch.setattr(backfill, "load_politician_index", lambda db: {("Example area", "a@example.com"): "person-1"})
    calls = []
    monkeypatch.setattr(backfill, "write_batch", lambda batch, now, number, total, db: calls.append((batch, now, db)))
    monkeypatch.setattr(backfill, "verify_assignments", lambda *args: (_ for _ in ()).throw(SystemExit("failed")))
    with pytest.raises(SystemExit):
        backfill.main()
    assert (cache / "replay.json").exists()
    monkeypatch.setattr(backfill, "verify_assignments", lambda *args: calls.append(args))
    backfill.main()
    assert calls[0] == (list(CHANGES.items()), 123, DATABASE)
    assert calls[-1] == (1, 1, 123, DATABASE)
    assert not (cache / "replay.json").exists()


def test_database_resolution_and_execution_use_uuid(monkeypatch):
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=0, stdout=json.dumps({"uuid": DATABASE}), stderr="")
    monkeypatch.setattr(backfill.subprocess, "run", run)
    assert backfill.resolve_database_id() == DATABASE
    assert calls[0][1:5] == ["wrangler", "d1", "info", backfill.D1_NAME]
    assert backfill.wrangler_args(DATABASE)[4] == DATABASE


def test_existing_cache_is_never_overwritten(cache):
    backfill.save_cache(CHANGES, 123, DATABASE)
    with pytest.raises(SystemExit):
        backfill.save_cache({"other": ("Example area", {"Socialnämnden"})}, 456, DATABASE)
    assert backfill.load_cache(DATABASE) == (CHANGES, 123)


def test_batch_replaces_only_selected_troman_rows_and_is_repeatable(monkeypatch):
    import sqlite3

    db = sqlite3.connect(":memory:")
    db.executescript("""
        CREATE TABLE public_contact_assignments (
            contact_id TEXT, area_name TEXT, body TEXT, role TEXT, source TEXT,
            last_scraped_at INTEGER, UNIQUE(contact_id, body, role)
        );
        INSERT INTO public_contact_assignments VALUES
          ('person-1', 'Example area', 'Old body', '', 'troman', 1),
          ('person-1', 'Example area', 'Other source', '', 'manual', 1),
          ('person-2', 'Example area', 'Old body', '', 'troman', 1);
    """)
    def run(args, **kwargs):
        assert args[4] == DATABASE
        db.executescript(Path(args[args.index("--file") + 1]).read_text())
        return SimpleNamespace(returncode=0)
    monkeypatch.setattr(backfill.subprocess, "run", run)
    batch = [("person-1", ("Example area", {"Barnens nämnd"}))]
    backfill.write_batch(batch, 123, 1, 1, DATABASE)
    backfill.write_batch(batch, 123, 1, 1, DATABASE)
    assert db.execute("SELECT contact_id, body, source, last_scraped_at FROM public_contact_assignments ORDER BY contact_id, source").fetchall() == [
        ("person-1", "Other source", "manual", 1),
        ("person-1", "Barnens nämnd", "troman", 123),
        ("person-2", "Old body", "troman", 1),
    ]


def test_foreign_owned_cache_directory_and_file_are_rejected(cache, monkeypatch):
    backfill.save_cache(CHANGES, 123, DATABASE)
    real_fstat = os.fstat
    for target in (cache, cache / "replay.json"):
        target_inode = target.stat().st_ino
        def foreign_owner(fd):
            info = real_fstat(fd)
            if info.st_ino == target_inode:
                return SimpleNamespace(st_uid=info.st_uid + 1, st_mode=info.st_mode, st_nlink=info.st_nlink)
            return info
        with monkeypatch.context() as patch:
            patch.setattr(backfill.os, "fstat", foreign_owner)
            with pytest.raises(SystemExit):
                backfill.load_cache(DATABASE)


def test_database_resolution_failure_prevents_backfill(monkeypatch):
    monkeypatch.setattr(backfill.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=0, stdout='{}', stderr=''))
    monkeypatch.setattr(backfill, "scrape_changes", lambda *_: pytest.fail("must not scrape"))
    monkeypatch.setattr(backfill, "write_assignments", lambda *_: pytest.fail("must not write"))
    with pytest.raises(SystemExit, match="databas-id"):
        backfill.main()
