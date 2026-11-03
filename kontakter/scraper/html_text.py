"""Helpers for extracting text from scraped HTML."""


def strip_tags(raw_html: str, replacement: str = "\n") -> str:
    """Replace the same spans as <[^>]+> without rescanning unmatched suffixes."""
    parts = []
    copied_until = search_from = 0
    while True:
        start = raw_html.find("<", search_from)
        if start == -1:
            break
        end = raw_html.find(">", start + 1)
        if end == -1:
            break
        if end == start + 1:
            search_from = end + 1
            continue
        parts.extend((raw_html[copied_until:start], replacement))
        copied_until = search_from = end + 1
    parts.append(raw_html[copied_until:])
    return "".join(parts)
