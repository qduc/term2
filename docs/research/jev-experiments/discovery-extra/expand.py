"""Replace thin stubs with authored topic-specific content.

Lookup is keyed by the original stub text. Already-substantive sentences pass
through unchanged. Empty/whitespace strings stay empty.
"""

from __future__ import annotations

from stubs_code import CODE
from stubs_logs import LOGS
from stubs_prose import PROSE


def expand_prose(text: str, key: str) -> str:
    if not isinstance(text, str) or not text.strip():
        return text
    return PROSE.get(text, text)


def expand_code(path: str, text: str, key: str) -> str:
    if not isinstance(text, str) or not text.strip():
        return text
    return CODE.get(text) or CODE.get(f"{path}|{text}") or text


def expand_log(text: str, key: str) -> str:
    if not isinstance(text, str) or not text.strip():
        return text
    return LOGS.get(text, text)
