from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest
import requests

import fetch_media


@contextmanager
def server(routes):
    received = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            received.append(self.path)
            status, headers, body = routes(self.path, self.headers)
            self.send_response(status)
            for key, value in headers.items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body.encode())

        def log_message(self, format, *args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}", received
    finally:
        httpd.shutdown()
        thread.join()
        httpd.server_close()


@pytest.fixture(autouse=True)
def bypass_proxies(monkeypatch):
    monkeypatch.setenv("NO_PROXY", "*")


def test_section_articles_cannot_redirect_to_another_origin():
    with server(lambda path, headers: (200, {}, "secret@paper.example")) as (other, other_requests):
        def routes(path, headers):
            if path == "/section":
                return 200, {}, f'<a href="/article">article</a><a href="{other}/direct">other</a>'
            if path == "/article":
                return 302, {"Location": "/hop"}, ""
            return 302, {"Location": f"{other}/private"}, ""

        with server(routes) as (origin, received):
            contacts = fetch_media.scrape_recent_section_authors(
                f"{origin}/section", "Paper", "News", "paper.example"
            )
    assert contacts == []
    assert received == ["/section", "/article", "/hop"]
    assert other_requests == []


def test_same_origin_redirects_keep_cookies_and_collect_contacts():
    def routes(path, headers):
        if path == "/section":
            return 200, {}, '<a href="/article">article</a>'
        if path == "/article":
            return 302, {"Location": "/final", "Set-Cookie": "seen=yes"}, ""
        return 200, {}, "anna.andersson@paper.example" if headers.get("Cookie") == "seen=yes" else ""

    with server(routes) as (origin, received):
        contacts = fetch_media.scrape_recent_section_authors(
            f"{origin}/section", "Paper", "News", "paper.example"
        )
    assert received == ["/section", "/article", "/final"]
    assert [(c.email, c.source) for c in contacts] == [
        ("anna.andersson@paper.example", f"{origin}/article")
    ]


def test_section_ignores_different_schemes_and_malformed_links():
    def routes(path, headers):
        if path == "/section":
            host = headers["Host"]
            return 200, {}, f'<a href="https://{host}/other">other</a><a href="http://[broken/">bad</a><a href="/article">article</a>'
        return 200, {}, "anna.andersson@paper.example"

    with server(routes) as (origin, received):
        contacts = fetch_media.scrape_recent_section_authors(
            f"{origin}/section", "Paper", "News", "paper.example"
        )
    assert received == ["/section", "/article"]
    assert [c.email for c in contacts] == ["anna.andersson@paper.example"]


def test_configured_page_redirect_cannot_leave_origin():
    with server(lambda path, headers: (200, {}, "secret")) as (other, other_requests):
        with server(lambda path, headers: (302, {"Location": other}, "")) as (origin, received):
            with pytest.raises(ValueError, match="leaves the source origin"):
                fetch_media.fetch_html(origin)
    assert received == ["/"]
    assert other_requests == []


def test_redirect_loop_is_bounded():
    with server(lambda path, headers: (302, {"Location": "/loop"}, "")) as (origin, received):
        with pytest.raises(requests.TooManyRedirects):
            fetch_media.fetch_html(origin)
    assert len(received) == 11


@pytest.mark.parametrize("url", ["ftp://paper.example/article", "https://paper.example@other.example/", "http://paper.example:bad/"])
def test_invalid_origins_are_rejected(url):
    with pytest.raises((ValueError, requests.RequestException)):
        fetch_media.http_origin(url)


def test_origin_checks_scheme_and_normalizes_default_ports():
    assert fetch_media.http_origin("https://PAPER.example:443/a") == fetch_media.http_origin("https://paper.example/b")
    assert fetch_media.http_origin("http://paper.example/a") != fetch_media.http_origin("https://paper.example/a")
