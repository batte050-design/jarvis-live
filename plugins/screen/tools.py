"""Handlers: hand a typed artifact to the page, and say what happened.

The return value matters as much as the artifact. A tool that reports success when nothing was
on screen teaches the agent that describing is enough, so a zero count comes back as a warning
saying no screen was open and the answer should be spoken instead.
"""
import json
import os
import urllib.request

ART_URL = os.environ.get("JARVIS_ART_URL", "http://127.0.0.1:8150/art")
TOKEN_FILE = os.path.expanduser("~/.hermes/jarvis_live_token")


def _token():
    try:
        with open(TOKEN_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def _publication():
    # Cold children inherit an immutable per-turn capability. Warm children use the existing
    # server-owned context file; a missing/malformed grant never becomes an unscoped push.
    raw = os.environ.get('JARVIS_SCREEN_PUBLICATION')
    if raw is not None:
        value = json.loads(raw)
    else:
        path = os.environ.get('JARVIS_WEB_CTX')
        if not path: return None
        with open(path, encoding='utf-8') as source: raw = source.read(32769)
        if len(raw.encode()) > 32768: return None
        value = json.loads(raw).get('JARVIS_SCREEN_PUBLICATION')
    if not isinstance(value, dict) or set(value) != {'turn','conv','token'}: return None
    if not all(isinstance(v,str) for v in value.values()): return None
    return value


def _post(payload):
    try: publication = _publication()
    except (OSError, ValueError, TypeError): publication = None
    if publication is None:
        return json.dumps({'error':'No active turn publication context; nothing was shown.'})
    tok = _token()
    if not tok:
        return json.dumps({"error": "the page's token file was not readable, so nothing was shown"})
    req = urllib.request.Request(
        ART_URL, data=json.dumps({**payload, 'publication':publication}).encode(), method="POST",
        headers={"Content-Type": "application/json", "X-Jarvis-Token": tok})
    try:
        with urllib.request.urlopen(req, timeout=6) as r:
            res = json.loads(r.read().decode())
    except Exception as e:
        return json.dumps({"error": "the screen could not be reached: %s" % e})
    n = int(res.get("screens") or 0)
    if not n:
        return json.dumps({"warning": "no screen is open right now, so nothing was displayed. "
                                      "Say the answer out loud instead."})
    return json.dumps({"ok": True, "shown_on_screens": n, "kind": res.get("kind")})


def screen_show(args, **kwargs):
    args = args or {}
    payload: dict = {"kind": str(args.get("kind") or "").strip()}
    for k in ("label", "text", "src", "href"):
        v = args.get(k)
        if v:
            payload[k] = str(v)
    # A widget travels as `url`, which is what the page frames. `href` is accepted as a stand-in so
    # a widget URL handed to the link field is not silently dropped.
    url = args.get("url") or (args.get("href") if payload["kind"] == "widget" else "")
    if url:
        payload["url"] = str(url)
    for k in ("columns", "rows"):
        v = args.get(k)
        if isinstance(v, list):
            payload[k] = [str(c) for c in v] if k == "columns" else v
    # A chart carries its own shape, its points and where they came from. Without this the payload
    # reached the page with only a kind, and a chart with no data is refused as nothing to draw.
    if payload["kind"] == "chart":
        style = str(args.get("chart") or "bar").strip().lower()
        payload["chart"] = "line" if style == "line" else "bar"
        data = args.get("data")
        if isinstance(data, list):
            pts = []
            for pair in data:
                if isinstance(pair, (list, tuple)) and len(pair) >= 2:
                    pts.append([str(pair[0]), str(pair[1])])
                elif isinstance(pair, dict) and "label" in pair and "value" in pair:
                    pts.append([str(pair["label"]), str(pair["value"])])
            payload["data"] = pts
        for k in ("unit", "source"):
            v = args.get(k)
            if v:
                payload[k] = str(v)
    items = args.get("items")
    if isinstance(items, list):
        if payload["kind"] == "metrics":
            out = []
            for it in items:
                if isinstance(it, dict):
                    out.append({"k": str(it.get("k", "")), "v": str(it.get("v", ""))})
                else:                                   # "name = value" is what the schema asks for
                    name, _, val = str(it).partition("=")
                    out.append({"k": name.strip(), "v": val.strip()})
            payload["items"] = out
        else:
            payload["items"] = [str(i) for i in items]
    return _post(payload)


def screen_clear(args, **kwargs):
    return _post({"kind": "clear"})
