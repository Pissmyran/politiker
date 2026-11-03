import asyncio
import random
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import fetch_kyrka
import fetch_media
from politiker_common import ASCII_EMAIL_LOCAL_RE, UNICODE_EMAIL_LOCAL_RE, iter_email_matches


def test_matches_preserve_existing_patterns_and_offsets():
    rng = random.Random(17)
    samples = [
        "first@example.com+second@example.org",
        "one@example.com two@example.org",
        "<a href='mailto:person@example.com'>",
        "åsa@kyrkan.example and a@b.c",
        "bad@domain good@example.com",
    ]
    samples += ["".join(rng.choices("abc12._%+-@ åö", k=100)) for _ in range(1000)]
    for pattern, local in ((fetch_media.EMAIL_RE, ASCII_EMAIL_LOCAL_RE),
                           (fetch_kyrka.EMAIL_RE, UNICODE_EMAIL_LOCAL_RE)):
        for text in samples:
            expected = [(m.span(), m.group()) for m in pattern.finditer(text)]
            actual = [(m.span(), m.group()) for m in iter_email_matches(text, pattern, local)]
            assert actual == expected


def test_long_unmatched_tokens_complete_and_do_not_hide_later_matches():
    scraper_dir = Path(__file__).resolve().parents[1] / "scraper"
    program = """
import re
from politiker_common import ASCII_EMAIL_LOCAL_RE, UNICODE_EMAIL_LOCAL_RE, iter_email_matches
for pattern, local in ((r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}', ASCII_EMAIL_LOCAL_RE),
                       (r'[\\w.+-]+@[\\w.-]+\\.\\w{2,}', UNICODE_EMAIL_LOCAL_RE)):
    text = 'a' * 1000000 + ' ' + 'a@' + 'b' * 1000000 + ' ' + 'person@example.com'
    assert [m.group() for m in iter_email_matches(text, re.compile(pattern), local)] == ['person@example.com']
"""
    subprocess.run([sys.executable, "-c", program], cwd=scraper_dir, check=True, timeout=10)


def test_church_extraction_handles_long_non_address_line():
    lines = ["a" * 100000, "Example Person", "Stiftsstyrelsen", "E-post:", "person@example.com"]
    assert fetch_kyrka.extract(lines, "Example") == [("Example Person", "person@example.com", None, "Ledamot")]


def test_media_scrapers_find_contacts_after_long_non_address(monkeypatch):
    pages = {
        "https://example.com/staff": "a" * 100000 + "\nExample Person reporter\nperson@example.com",
        "https://example.com/public": "a" * 100000 + "\nperson@example.com",
        "https://example.com/section": '<a href="/article">Article</a>',
        "https://example.com/article": "a" * 100000 + "\nperson@example.com",
    }
    monkeypatch.setattr(fetch_media, "fetch_html", pages.__getitem__)
    staff = fetch_media.scrape_staff_page("https://example.com/staff", "Example", "News", "example.com")
    public = fetch_media.scrape_public_emails("https://example.com/public", "Example", "News", "example.com")
    authors = fetch_media.scrape_recent_section_authors("https://example.com/section", "Example", "News", "example.com")
    assert [c.email for c in staff] == ["person@example.com"]
    assert [c.email for c in public] == ["person@example.com"]
    assert [c.email for c in authors] == ["person@example.com"]


def test_regional_scraper_html_and_pdf_paths(monkeypatch):
    pytest.importorskip("playwright")
    pytest.importorskip("pypdf")
    import scraper

    class Page:
        async def goto(self, *args, **kwargs):
            pass

        async def eval_on_selector_all(self, *args):
            return []

        async def content(self):
            return "a" * 100000 + " person@example.com"

        async def close(self):
            pass

    class Context:
        async def new_page(self):
            return Page()

        request = SimpleNamespace(get=None)

    async def get(*args, **kwargs):
        async def body():
            return b"synthetic pdf"
        return SimpleNamespace(body=body)

    async def no_wait(*args):
        pass

    monkeypatch.setattr(scraper.asyncio, "sleep", no_wait)
    monkeypatch.setattr(scraper, "accept_cookies", no_wait)
    monkeypatch.setattr(Context.request, "get", get)
    monkeypatch.setattr(scraper, "PdfReader", lambda _: SimpleNamespace(
        pages=[SimpleNamespace(extract_text=lambda: "a" * 100000 + "\nExample Person person@example.com")]
    ))
    html_rows = asyncio.run(scraper.scrape_mailto(Context(), "Example", "https://example.com"))
    pdf_rows = asyncio.run(scraper.scrape_pdf_lista(Context(), "Example", "https://example.com", "example.com"))
    assert html_rows == {("", "person@example.com", None, None)}
    assert pdf_rows == {("Example Person", "person@example.com", None, None)}
