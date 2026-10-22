"""Redaction: secrets are masked before anything is stored or returned.

Two surfaces, one rule. Text on its way into a stored turn (sessions, session window, audit rows)
and text on its way out to a page pass through `redact()`. The mask keeps the shape so a reader can
tell a key was there - `sk-ab…cdef` - without ever carrying enough of it to be used.

Nothing here reads a secret file to learn the values: patterns do the work, and a value known to
the process (the master token, keys from the environment) is added to the exact-match set at import
so it is masked even when its shape is unrecognisable.
"""

from __future__ import annotations

import os
import re
from typing import Iterable, List, Set

# Shapes, not values.
PATTERNS: List[re.Pattern] = [
    re.compile(r"\bsk-[A-Za-z0-9_\-]{12,}\b"),                       # OpenAI-style
    re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{12,}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_\-]{20,}\b"),                      # Google
    re.compile(r"\b[0-9]{8,10}:AA[0-9A-Za-z_\-]{20,}\b"),           # Telegram bot token
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),                  # GitHub
    re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b"),  # JWT
    re.compile(r"(?i)\b(bearer)\s+([A-Za-z0-9._\-]{16,})"),
    # A key assignment only masks when the value reads like a credential: one run of token
    # characters, no brackets or calls. Otherwise ordinary code was being redacted.
    re.compile(r"(?i)\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*[\"']?([A-Za-z0-9_\-\.]{20,})[\"']?\s*$", re.M),
    re.compile(r"(?i)\b(https?://)([^/\s:@]+):([^/\s@]{8,})@"),     # credentials in a URL
]

_EXACT: Set[str] = set()


def register_secret(value: str) -> None:
    """A value this process already knows, masked wherever it appears."""
    v = (value or "").strip()
    if len(v) >= 12:
        _EXACT.add(v)


def _mask(value: str) -> str:
    """A short secret shows at most four characters, and never both ends.

    Four from each end of a twenty-character key is eight characters of a twenty-character key;
    that is a quarter of it. Below 24 characters only the first two are shown, so a guesser gets
    a hint of the prefix and nothing of the tail.
    """
    v = value or ""
    if len(v) < 24:
        return (v[:2] + "…") if len(v) >= 8 else "***"
    return v[:4] + "…" + v[-4:]


def redact(text: str) -> str:
    """Mask every secret-shaped run and every registered value. Never raises."""
    if not text:
        return text or ""
    out = str(text)
    for value in list(_EXACT):
        if value in out:
            out = out.replace(value, _mask(value))
    for pat in PATTERNS:
        def _sub(m):
            groups = m.groups()
            if len(groups) == 2 and groups[0] and groups[0].lower() == "bearer":
                return "%s %s" % (groups[0], _mask(groups[1]))
            if len(groups) == 2 and groups[0] and groups[1] and m.re is PATTERNS[7]:
                return "%s=%s" % (groups[0], _mask(groups[1]))
            if len(groups) == 3 and groups[0] and groups[0].startswith("http"):
                return "%s%s:%s@" % (groups[0], "***", "***")
            whole = m.group(0)
            if whole.lower().startswith("bearer "):
                return "Bearer " + _mask(whole[7:])
            return _mask(whole)
        out = pat.sub(_sub, out)
    return out


def redact_rows(rows: Iterable[dict], fields: Iterable[str] = ("q", "a", "question", "action", "reason")) -> List[dict]:
    """A list of dicts with the named fields masked. The rest is untouched."""
    out = []
    for row in rows or []:
        if not isinstance(row, dict):
            out.append(row)
            continue
        copy = dict(row)
        for f in fields:
            if isinstance(copy.get(f), str):
                copy[f] = redact(copy[f])
        out.append(copy)
    return out


def load_known_secrets(token_file: str = "") -> None:
    """Register the values this process already holds: the app token and every *_KEY/_TOKEN in env."""
    try:
        if token_file and os.path.exists(token_file):
            register_secret(open(token_file, encoding="utf-8").read().strip())
    except Exception:
        pass
    for k, v in os.environ.items():
        if any(k.endswith(s) for s in ("_KEY", "_TOKEN", "_SECRET", "_PASSWORD")):
            register_secret(v)
