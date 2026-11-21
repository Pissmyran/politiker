#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Bakåtfyll relevanta politiska huvudnämnder/organ från Troman-profiler till D1.

Endast organ som faktiskt är användbara som mottagarfilter sparas: kommun-/
regionstyrelse och riktiga nämnder. Fullmäktige, utskott, beredningar, råd,
rollistor och andra administrativa sidouppdrag ignoreras redan vid skrapningen.
Detaljerade befattningar som ledamot, ersättare, ordförande eller sekreterare
samlas inte in.

D1 läses och skrivs via Wrangler. Därmed återanvänds den Cloudflare-inloggning
som redan används av resten av repot och skriptet kräver inga separata
CLOUDFLARE_* eller D1_* miljövariabler. HTTP-hämtning använder endast Pythons
standardbibliotek, så inga pip-paket behövs heller.

Skrapresultatet cachelagras i en privat katalog i /tmp innan D1-skrivningen. Om en D1-batch skulle
misslyckas kan skriptet köras igen utan att skrapa om alla 150 källor. Cachen
tas först bort efter att en separat D1-SELECT verifierat både antal kopplingar
och antal politiker för den aktuella körningen.
"""
from __future__ import annotations

import html
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

import sources

REPO_ROOT = Path(__file__).resolve().parents[2]
WRANGLER_CONFIG = REPO_ROOT / "app" / "wrangler.jsonc"
D1_NAME = os.environ.get("D1_DATABASE_NAME", "politiker")
CACHE_DIR = Path(f"/tmp/politiker-assignments-backfill-{os.geteuid()}")
CACHE_PATH = CACHE_DIR / "replay.json"
BATCH_PEOPLE = 200

# Dessa namn beskriver inte en avgränsad huvudnämnd som är rimlig att rikta ett
# massutskick mot. Filtreringen görs här, vid källan, så bruset aldrig lagras.
EXCLUDED_BODY_TERMS = (
    "fullmäktige",
    "utskott",
    "beredning",
    "nämndemän",
    "nämndeman",
    "vigselförrätt",
    "gruppledare",
    "kommunalråd",
    "regionråd",
    "partiföreträdare",
    "politisk sekreter",
    "politiska sekreter",
    "kommunalförbund",
)


def load_regioner() -> list[dict]:
    return sources.load("regioner")


def fetch(url: str, timeout: int = 30) -> str | None:
    try:
        request = Request(url, headers={"User-Agent": "Politikerkontakt scraper/1.0"})
        with urlopen(request, timeout=timeout) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.read().decode(charset, errors="replace")
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        print(f"  FEL {url}: {exc}", file=sys.stderr, flush=True)
        return None


def clean_text(fragment: str) -> str:
    text = html.unescape(re.sub(r"<[^>]+>", "", fragment))
    return re.sub(r"\s+", " ", text).strip()


def email_from_page(page_html: str) -> set[str]:
    emails = set()
    for href in re.findall(r'href="(mailto:[^"]+)"', page_html, re.I):
        email = href[7:].split("?", 1)[0].strip().lower()
        if "@" in email:
            emails.add(email)
    return emails


def normalize_body(raw_body: str) -> str | None:
    """Returnera kanoniskt namn för ett relevant huvudorgan, annars None."""
    body = re.sub(r"\s+", " ", raw_body).strip()
    if not body:
        return None
    folded = body.casefold()

    if any(term in folded for term in EXCLUDED_BODY_TERMS):
        return None

    if folded in {"kommunstyrelse", "kommunstyrelsen"}:
        return "Kommunstyrelsen"
    if folded in {"regionstyrelse", "regionstyrelsen"}:
        return "Regionstyrelsen"

    # Riktiga nämnder kan heta både "Socialnämnden" och exempelvis
    # "Nämnden för arbete och välfärd". Därför kräver vi nämnd i namnet, men
    # exkluderar ovan alla underutskott och andra irrelevanta konstruktioner.
    if "nämnd" not in folded:
        return None

    # Nämnd -> Nämnden ger en enkel gemensam form för vanliga singularvarianter.
    if folded.endswith("nämnd"):
        body += "en"

    # Troman innehåller ibland versala listnamn. Normalisera dem utan att röra
    # normal svensk versalisering i övriga namn.
    if body.isupper():
        body = body.capitalize()
    return body


def bodies(page_html: str) -> list[str]:
    match = re.search(r'id="engagementTable:tbody_element"(.*?)</table>', page_html, re.S | re.I)
    if not match:
        match = re.search(r'<table[^>]*id="engagementTable"[^>]*>(.*?)</table>', page_html, re.S | re.I)
    if not match:
        return []
    found: list[str] = []
    seen: set[str] = set()
    for row in re.finditer(r"<tr[^>]*>(.*?)</tr>", match.group(1), re.S | re.I):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row.group(1), re.S | re.I)
        if not cells:
            continue
        body = normalize_body(clean_text(cells[0]))
        if not body:
            continue
        key = body.casefold()
        if key not in seen:
            seen.add(key)
            found.append(body)
    return found


def wrangler_args(database_id: str) -> list[str]:
    return [
        "npx", "wrangler", "d1", "execute", database_id,
        "--remote", "--config", str(WRANGLER_CONFIG),
    ]


def resolve_database_id() -> str:
    # Wrangler's info and execute commands resolve names/bindings in the same way.
    proc = subprocess.run(
        ["npx", "wrangler", "d1", "info", D1_NAME, "--config", str(WRANGLER_CONFIG), "--json"],
        cwd=REPO_ROOT, text=True, capture_output=True,
    )
    if proc.returncode != 0:
        sys.exit("FEL: kunde inte identifiera D1-databasen via Wrangler. " + proc.stderr.strip())
    try:
        return str(uuid.UUID(json.loads(proc.stdout)["uuid"]))
    except (ValueError, TypeError, KeyError, json.JSONDecodeError):
        sys.exit("FEL: Wrangler returnerade inte ett giltigt D1-databas-id.")


def wrangler_json(sql: str, database_id: str) -> object:
    proc = subprocess.run(
        wrangler_args(database_id) + ["--command", sql, "--json"],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
    )
    if proc.returncode != 0:
        if proc.stdout:
            print(proc.stdout, file=sys.stderr)
        if proc.stderr:
            print(proc.stderr, file=sys.stderr)
        sys.exit("FEL: kunde inte läsa D1 via Wrangler.")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        print(proc.stdout, file=sys.stderr)
        sys.exit("FEL: Wrangler returnerade inte giltig JSON.")


def find_result_rows(value: object) -> list[dict]:
    """Hitta Wranglers SELECT-rader utan att låsa oss till en viss CLI-version."""
    if isinstance(value, dict):
        results = value.get("results")
        if isinstance(results, list) and (not results or isinstance(results[0], dict)):
            return results
        for child in value.values():
            rows = find_result_rows(child)
            if rows:
                return rows
    elif isinstance(value, list):
        for child in value:
            rows = find_result_rows(child)
            if rows:
                return rows
    return []


def load_politician_index(database_id: str) -> dict[tuple[str, str], str]:
    print("Läser befintliga politiker från D1 via Wrangler...", flush=True)
    payload = wrangler_json(
        "SELECT id, lower(trim(email)) AS email, area_name FROM public_contacts "
        "WHERE email IS NOT NULL AND trim(email) <> '';", database_id
    )
    rows = find_result_rows(payload)
    if not rows:
        sys.exit("FEL: kunde inte läsa några politiker från D1.")
    index: dict[tuple[str, str], str] = {}
    for row in rows:
        pid = str(row.get("id") or "").strip()
        email = str(row.get("email") or "").strip().lower()
        area = str(row.get("area_name") or "").strip()
        if pid and email and area:
            index[(area, email)] = pid
    print(f"  {len(index)} D1-rader indexerade.", flush=True)
    return index


def sql_quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


@contextmanager
def cache_directory():
    try:
        try:
            os.mkdir(CACHE_DIR, 0o700)
        except FileExistsError:
            pass
        fd = os.open(CACHE_DIR, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise ValueError("directory must be owned by the current user and have mode 0700")
            yield fd
        finally:
            os.close(fd)
    except (OSError, ValueError) as exc:
        sys.exit(f"FEL: osäker eller otillgänglig cachekatalog {CACHE_DIR}: {exc}")


def save_cache(changes: dict[str, tuple[str, set[str]]], now_ms: int, database_id: str) -> None:
    if not changes:
        return
    payload = {
        "database_id": database_id,
        "created_at_ms": now_ms,
        "changes": {
            pid: {"area_name": area, "bodies": sorted(person_bodies, key=str.casefold)}
            for pid, (area, person_bodies) in changes.items()
        },
    }
    with cache_directory() as directory:
        temporary = ".replay-" + secrets.token_hex(16)
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as file:
                    json.dump(payload, file, ensure_ascii=False)
                # Link exclusively so a concurrent job cannot overwrite replay state.
                os.link(temporary, CACHE_PATH.name, src_dir_fd=directory, dst_dir_fd=directory)
            finally:
                os.unlink(temporary, dir_fd=directory)
        except FileExistsError:
            sys.exit(f"FEL: cache finns redan i {CACHE_PATH}; starta inte parallella körningar.")
    print(f"Skrapresultatet cachelagrat i {CACHE_PATH}.", flush=True)


def load_cache(database_id: str) -> tuple[dict[str, tuple[str, set[str]]], int] | None:
    with cache_directory() as directory:
        try:
            fd = os.open(CACHE_PATH.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        except FileNotFoundError:
            return None
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
                raise ValueError("cache must be a private, user-owned regular file")
            with os.fdopen(fd, encoding="utf-8", closefd=False) as file:
                payload = json.load(file)
        finally:
            os.close(fd)
    try:
        if payload["database_id"] != database_id:
            raise ValueError("database id does not match")
        now_ms = payload["created_at_ms"]
        raw_changes = payload["changes"]
        if type(now_ms) is not int or now_ms <= 0 or not isinstance(raw_changes, dict) or not raw_changes:
            raise ValueError("invalid timestamp or changes")
        changes = {}
        for pid, item in raw_changes.items():
            area, bodies_list = item["area_name"], item["bodies"]
            if (not isinstance(pid, str) or not pid or not isinstance(area, str) or not area
                    or not isinstance(bodies_list, list) or not bodies_list
                    or any(not isinstance(body, str) or normalize_body(body) != body for body in bodies_list)):
                raise ValueError("invalid cached contact or body")
            changes[pid] = (area, set(bodies_list))
    except (ValueError, TypeError, KeyError) as exc:
        sys.exit(f"FEL: ogiltig cache i {CACHE_PATH}: {exc}")
    return changes, now_ms


def validate_cached_contacts(changes: dict[str, tuple[str, set[str]]], database_id: str) -> None:
    index = load_politician_index(database_id)
    current = {(pid, area) for (area, _email), pid in index.items()}
    if any((pid, area) not in current for pid, (area, _bodies) in changes.items()):
        sys.exit(f"FEL: cache innehåller kontakter som inte längre matchar D1. Kontrollera {CACHE_PATH}.")


def write_batch(batch: list[tuple[str, tuple[str, set[str]]]], now_ms: int, number: int, total: int, database_id: str) -> None:
    # D1:s remote execute tillåter inte BEGIN TRANSACTION/SAVEPOINT i SQL-filer.
    # Varje politiker är ändå idempotent: DELETE följt av INSERT OR IGNORE. Om en
    # batch avbryts kan cachen köras om säkert; samma politiker byggs då om igen.
    statements: list[str] = []
    body_count = 0
    for contact_id, (area_name, person_bodies) in batch:
        statements.append(
            "DELETE FROM public_contact_assignments "
            f"WHERE contact_id = {sql_quote(contact_id)} AND source = 'troman';"
        )
        for body in sorted(person_bodies, key=str.casefold):
            # Schema 002 har role TEXT NOT NULL DEFAULT ''. Vi sparar ingen
            # detaljroll, men måste därför skriva tom sträng (inte NULL).
            statements.append(
                "INSERT OR IGNORE INTO public_contact_assignments "
                "(contact_id, area_name, body, role, source, last_scraped_at) VALUES ("
                f"{sql_quote(contact_id)}, {sql_quote(area_name)}, {sql_quote(body)}, "
                f"'', 'troman', {now_ms});"
            )
            body_count += 1

    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", suffix=".sql", prefix="politiker-assignments-", delete=False
        ) as tmp:
            tmp.write("\n".join(statements) + "\n")
            tmp_path = Path(tmp.name)
        print(
            f"Batch {number}/{total}: {len(batch)} politiker, {body_count} nämnd/organ-kopplingar...",
            flush=True,
        )
        proc = subprocess.run(
            wrangler_args(database_id) + ["--file", str(tmp_path), "--yes"],
            cwd=REPO_ROOT,
        )
        if proc.returncode != 0:
            sys.exit(
                f"FEL: D1-skrivning misslyckades i batch {number}/{total}. "
                f"Cachen finns kvar i {CACHE_PATH}; kör skriptet igen för att försöka igen."
            )
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)


def verify_assignments(expected_people: int, expected_bodies: int, now_ms: int, database_id: str) -> None:
    payload = wrangler_json(
        "SELECT COUNT(*) AS assignments, COUNT(DISTINCT contact_id) AS public_contacts "
        "FROM public_contact_assignments "
        f"WHERE source = 'troman' AND last_scraped_at = {now_ms};", database_id
    )
    rows = find_result_rows(payload)
    if not rows:
        sys.exit(
            f"FEL: kunde inte verifiera D1 efter skrivningen. Cachen finns kvar i {CACHE_PATH}."
        )
    actual_bodies = int(rows[0].get("assignments") or 0)
    actual_people = int(rows[0].get("public_contacts") or 0)
    print(
        f"Efterkontroll D1: {actual_people} politiker, {actual_bodies} nämnd/organ-kopplingar.",
        flush=True,
    )
    if actual_people != expected_people or actual_bodies != expected_bodies:
        sys.exit(
            "FEL: D1-efterkontrollen matchar inte skrapresultatet: "
            f"förväntade {expected_people} politiker/{expected_bodies} kopplingar, "
            f"fick {actual_people}/{actual_bodies}. Cachen lämnas kvar i {CACHE_PATH}."
        )


def write_assignments(changes: dict[str, tuple[str, set[str]]], now_ms: int, database_id: str) -> None:
    if not changes:
        print("Inga nämnd/organ-kopplingar att skriva.", flush=True)
        return
    items = sorted(changes.items(), key=lambda item: (item[1][0].casefold(), item[0]))
    batches = [items[i:i + BATCH_PEOPLE] for i in range(0, len(items), BATCH_PEOPLE)]
    total_bodies = sum(len(v[1]) for v in changes.values())
    print(
        f"Skriver {total_bodies} nämnd/organ-kopplingar för {len(items)} politiker "
        f"i {len(batches)} mindre D1-batchar...",
        flush=True,
    )
    for number, batch in enumerate(batches, 1):
        write_batch(batch, now_ms, number, len(batches), database_id)
    verify_assignments(len(items), total_bodies, now_ms, database_id)
    with cache_directory() as directory:
        os.unlink(CACHE_PATH.name, dir_fd=directory)
    print("Alla D1-batchar verifierade; backfill-cachen borttagen.", flush=True)


def scrape_changes(database_id: str) -> tuple[dict[str, tuple[str, set[str]]], int, int, int, int]:
    politician_index = load_politician_index(database_id)
    targets = [row for row in load_regioner() if row.get("typ") == "troman"]
    now_ms = int(time.time() * 1000)
    total_people = total_bodies = total_missing = 0
    changes: dict[str, tuple[str, set[str]]] = {}

    print(f"{len(targets)} Troman-kommuner/regioner att läsa.", flush=True)
    for index, region in enumerate(targets, 1):
        area_name = region["namn"]
        print(f"[{index}/{len(targets)}] {area_name}...", flush=True)
        listing = fetch(region["url"])
        if not listing:
            continue
        base = re.match(r"(https?://[^/]+)", region["url"])
        if not base:
            continue
        person_paths = sorted(set(re.findall(r'href="(/person/[a-f0-9-]+)"', listing, re.I)))
        area_bodies = area_missing = 0
        for person_path in person_paths:
            page = fetch(urljoin(base.group(1), person_path), timeout=20)
            if not page:
                continue
            person_bodies = bodies(page)
            emails = email_from_page(page)
            if not person_bodies or not emails:
                continue

            contact_id = None
            for email in emails:
                contact_id = politician_index.get((area_name, email))
                if contact_id:
                    break
            if not contact_id:
                area_missing += 1
                continue

            previous = changes.get(contact_id)
            body_set = set(person_bodies)
            if previous:
                body_set.update(previous[1])
            changes[contact_id] = (area_name, body_set)
            area_bodies += len(person_bodies)
            total_people += 1
            time.sleep(0.05)

        total_bodies += area_bodies
        total_missing += area_missing
        print(
            f"  {area_bodies} relevanta nämnd/organ-kopplingar hittade, "
            f"{area_missing} profiler utan D1-match",
            flush=True,
        )

    save_cache(changes, now_ms, database_id)
    return changes, now_ms, total_people, total_bodies, total_missing


def main() -> None:
    database_id = resolve_database_id()
    cached = load_cache(database_id)
    if cached:
        changes, now_ms = cached
        validate_cached_contacts(changes, database_id)
        total_people = len(changes)
        total_bodies = sum(len(v[1]) for v in changes.values())
        total_missing = 0
        print(
            f"Återanvänder cache från {CACHE_PATH}: {total_people} politiker, "
            f"{total_bodies} nämnd/organ-kopplingar. Ingen omskrapning behövs.",
            flush=True,
        )
    else:
        changes, now_ms, total_people, total_bodies, total_missing = scrape_changes(database_id)

    write_assignments(changes, now_ms, database_id)
    print(
        f"\nKlart: {total_people} personer, {total_bodies} relevanta nämnd/organ-kopplingar, "
        f"{total_missing} profiler utan D1-match.",
        flush=True,
    )


if __name__ == "__main__":
    main()
