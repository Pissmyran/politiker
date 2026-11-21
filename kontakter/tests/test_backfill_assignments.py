import os
import subprocess
import sys
from pathlib import Path

import backfill_assignments as backfill


def test_bodies_extracts_first_cell_normalizes_and_deduplicates():
    page = '''
        <table id="engagementTable"><tbody id="engagementTable:tbody_element">
          <tr><td><span>Socialnämnd</span></td><td>Ledamot</td></tr>
          <TR class="row"><TD>Kommunstyrelsen</TD></TR>
          <tr><td>SOCIALNÄMND</td></tr>
          <tr><td>Socialnämndens utskott</td></tr>
          <tr><td>Nämnden för arbete &amp; välfärd</td></tr>
        </tbody></table>
    '''
    assert backfill.bodies(page) == [
        "Socialnämnden", "Kommunstyrelsen", "Nämnden för arbete & välfärd"
    ]


def test_bodies_fallback_and_unicode_before_table():
    page = 'İ<table ID="engagementTable"><tr><td>Regionstyrelse</td></tr></table>'
    assert backfill.bodies(page) == ["Regionstyrelsen"]
    assert backfill.bodies('<table id="engagementTable"><tr><td>Socialnämnd</td></tr>') == []
    assert backfill.bodies('<table><tr><td>Socialnämnd</td></tr></table>') == []


def test_scrape_changes_uses_extracted_bodies_for_matching_contact(monkeypatch):
    listing = '<a href="/person/abc-123">Profile</a>'
    page = '''<table id="engagementTable">
      <tr><td>Ignorednämnd</td></tr>
      <tbody id="engagementTable:tbody_element">
        <tr><td>Socialnämnd</td></tr><tr><td>Fullmäktige</td></tr>
      </tbody></table><a href="mailto:Person@example.com">Email</a>'''
    monkeypatch.setattr(backfill, "load_regioner", lambda: [
        {"typ": "troman", "namn": "Example", "url": "https://example.com/list"}
    ])
    monkeypatch.setattr(backfill, "load_politician_index", lambda: {
        ("Example", "person@example.com"): "contact-1"
    })
    monkeypatch.setattr(backfill, "fetch", lambda url, timeout=30: listing if url.endswith("/list") else page)
    monkeypatch.setattr(backfill.time, "sleep", lambda _: None)
    cached = []
    monkeypatch.setattr(backfill, "save_cache", lambda changes, now: cached.append((changes, now)))

    changes, now, people, bodies, missing = backfill.scrape_changes()
    assert changes == {"contact-1": ("Example", {"Socialnämnden"})}
    assert (people, bodies, missing) == (1, 1, 0)
    assert cached == [(changes, now)]


def test_malformed_html_does_not_cause_repeated_suffix_scans():
    # Run separately so a regression fails within the timeout instead of hanging pytest.
    script = '''
import backfill_assignments as b
n = 50000
assert b.bodies('<tbody id="engagementTable:tbody_element">' + '<tr>' * n + '</table>') == []
assert b.bodies('<tbody id="engagementTable:tbody_element"><tr>' + '<td>' * n + '</tr></table>') == []
assert b.bodies('<table ' * n + '></table>') == []
assert b.clean_text('<' * n) == '<' * n
'''
    subprocess.run(
        [sys.executable, "-c", script], check=True, timeout=10,
        env={**os.environ, "PYTHONPATH": str(Path(backfill.__file__).parent)},
    )
