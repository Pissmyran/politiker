import itertools
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import backfill_assignments
import fetch_kyrka
import fetch_media
from html_text import strip_tags


def test_strip_tags_preserves_existing_substitution_behavior():
    # Include malformed, nested, empty and incomplete tags, as well as entities.
    samples = ["<p>A &amp; B</p>", "<a <b>tail", "<>text<", "<\n>\n<>"]
    samples.extend("".join(chars) for n in range(7) for chars in itertools.product("<>a&", repeat=n))
    for sample in samples:
        for replacement in ("", "\n"):
            assert strip_tags(sample, replacement) == re.sub(r"<[^>]+>", replacement, sample)


def test_importers_extract_contacts_from_html(monkeypatch):
    pages = {
        "https://media.example/staff": "<p>Anna Andersson Reporter</p><p>anna.andersson@media.example</p>",
        "https://media.example/section": '<a href="/article">Article</a>',
        "https://media.example/article": "<p>anna.andersson@media.example</p>",
        "https://church.example/board": (
            "<p>Anna Andersson (S)</p><p>Stiftsstyrelsen</p>"
            "<p>E-post:</p><p>anna.andersson@church.example</p>"
        ),
    }

    def get(url, **kwargs):
        return SimpleNamespace(text=pages[url], raise_for_status=lambda: None)

    monkeypatch.setattr(fetch_media.requests, "get", get)
    staff = fetch_media.scrape_staff_page("https://media.example/staff", "Media", "Politik", "media.example")
    public = fetch_media.scrape_public_emails("https://media.example/staff", "Media", "Politik", "media.example")
    authors = fetch_media.scrape_recent_section_authors("https://media.example/section", "Media", "Politik", "media.example")
    assert [(c.name, c.email) for c in staff] == [("Anna Andersson", "anna.andersson@media.example")]
    assert [c.email for c in public] == ["anna.andersson@media.example"]
    assert [c.email for c in authors] == ["anna.andersson@media.example"]
    lines = fetch_kyrka.page_lines("https://church.example/", "board")
    assert fetch_kyrka.extract(lines, "Church") == [("Anna Andersson", "anna.andersson@church.example", "S", "Ledamot")]
    assert backfill_assignments.clean_text("<b>Social&amp; miljönämnden</b>") == "Social& miljönämnden"


def test_unmatched_opening_brackets_do_not_stall_importers():
    # A subprocess timeout keeps a regression from hanging the test suite.
    scraper_dir = Path(__file__).resolve().parents[1] / "scraper"
    script = """
from types import SimpleNamespace
import backfill_assignments, fetch_kyrka, fetch_media
payload = '<' * 200_000
fetch_media.requests.get = lambda *args, **kwargs: SimpleNamespace(text=payload, raise_for_status=lambda: None)
assert fetch_media.scrape_public_emails('https://media.example/', 'Media', 'Role', 'media.example') == []
assert fetch_kyrka.extract(fetch_kyrka.page_lines('https://church.example/', ''), 'Church') == []
assert backfill_assignments.clean_text(payload) == payload
"""
    subprocess.run([sys.executable, "-c", script], cwd=scraper_dir, check=True, timeout=5)
