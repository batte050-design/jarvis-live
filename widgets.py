"""Widgets: one self-contained HTML page per visual, on an origin of its own.

A widget is a capability, not a page of the app. It is reached by a random 128-bit token, it is
served from a hostname that never sees the app's cookie, and it runs in an opaque origin whatever
way it is opened — in the page's frame or straight from a link. Everything about that policy lives
here, so the page's own server does not have to know the details.

Nothing in this file serves a file out of the store directly: a widget is read by the route in
server.py, which decides the headers. The directory is never mounted.
"""
import hashlib
import json
import os
import re
import secrets
import time

HERE = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.join(HERE, "widgets")
LIB = os.path.join(STORE, "lib")
SETTINGS = os.path.join(STORE, "settings.json")

MAX_BYTES = 400_000                     # the same ceiling panels use
MAX_WIDGETS = 200                       # and a ceiling on how many may exist at once
MAX_STORE_BYTES = 40_000_000            # 40 MB for the store as a whole
DEFAULT_DAYS = 30
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{20,32}$")

DEFAULTS = {
    "enabled": True,                    # one switch stops creation and serving at once
    "host": "widgets.battemohammad.com",
}


def _ensure():
    os.makedirs(LIB, exist_ok=True)
    # The kit script is written from the single source of truth in this file, so the pinned URL
    # (its own hash) can never drift from the code that produced it.
    path = os.path.join(LIB, "jarvis-kit.js")
    try:
        with open(path, encoding="utf-8") as f:
            same = f.read() == KIT_JS
    except Exception:
        same = False
    if not same:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(KIT_JS)
        os.replace(tmp, path)


def settings():
    _ensure()
    out = dict(DEFAULTS)
    try:
        with open(SETTINGS, encoding="utf-8") as f:
            out.update(json.load(f) or {})
    except Exception:
        pass
    return out


def save_settings(patch):
    _ensure()
    out = settings()
    out.update(patch or {})
    tmp = SETTINGS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    os.replace(tmp, SETTINGS)
    return out


def host():
    return settings().get("host") or DEFAULTS["host"]


def enabled():
    return bool(settings().get("enabled", True))


# ---------------------------------------------------------------- the store
def new_token():
    return secrets.token_urlsafe(16)            # 128 bits of randomness


def _paths(token):
    if not TOKEN_RE.match(token or ""):
        raise ValueError("bad token")
    return (os.path.join(STORE, token + ".html"), os.path.join(STORE, token + ".json"))


def create(html, label="", device=""):
    """Store one widget. Raises ValueError with a reason a person can read."""
    _ensure()
    if not enabled():
        raise ValueError("widgets are switched off")
    body = html if isinstance(html, str) else ""
    raw = body.encode("utf-8")
    if not body.strip():
        raise ValueError("empty widget")
    if len(raw) > MAX_BYTES:
        raise ValueError("widget is %d bytes, over the %d cap" % (len(raw), MAX_BYTES))
    # Housekeeping on the way in, not only at startup. A process that runs for weeks would
    # otherwise hold every expired widget on disk, and nothing capped how many could pile up or
    # how much they could occupy between them.
    try:
        purge_expired()
    except Exception:
        pass
    try:
        live = list_all()
        total = sum(int(m.get("bytes") or 0) for m in live)
    except Exception:
        live, total = [], 0
    if MAX_WIDGETS and len(live) >= MAX_WIDGETS:
        raise ValueError("widget store is full: %d held, the cap is %d" % (len(live), MAX_WIDGETS))
    if MAX_STORE_BYTES and total + len(raw) > MAX_STORE_BYTES:
        raise ValueError("widget store is full: %d bytes held, the cap is %d"
                         % (total, MAX_STORE_BYTES))
    token = new_token()
    doc_path, meta_path = _paths(token)
    tmp = doc_path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(raw)
    os.replace(tmp, doc_path)
    meta = {"token": token, "label": str(label or "")[:120], "device": str(device or "")[:40],
            "created": int(time.time()), "expires": int(time.time()) + DEFAULT_DAYS * 86400,
            "bytes": len(raw)}
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)
    return meta


def read_meta(token):
    try:
        _, meta_path = _paths(token)
    except ValueError:
        return None
    if not os.path.exists(meta_path):
        return None
    try:
        with open(meta_path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def expired(meta):
    return bool(meta) and int(meta.get("expires") or 0) < time.time()


def document(token):
    """The widget as served: the house kit, then the stored content."""
    try:
        doc_path, _ = _paths(token)
    except ValueError:
        return None
    if not os.path.exists(doc_path):
        return None
    with open(doc_path, encoding="utf-8") as f:
        content = f.read()
    meta = read_meta(token) or {}
    return KIT.format(label=_esc(meta.get("label") or "JARVIS"), host=host(),
                      lib=lib_url()) + content


def list_all(include_expired=False):
    _ensure()
    out = []
    for name in os.listdir(STORE):
        if not name.endswith(".json") or name == "settings.json":
            continue
        meta = read_meta(name[:-5])
        if not meta:
            continue
        if expired(meta) and not include_expired:
            continue
        out.append(meta)
    out.sort(key=lambda m: m.get("created", 0), reverse=True)
    return out


def delete(token):
    try:
        doc_path, meta_path = _paths(token)
    except ValueError:
        return False
    gone = False
    for p in (doc_path, meta_path):
        try:
            os.remove(p)
            gone = True
        except FileNotFoundError:
            pass
    return gone


def purge_expired():
    """Housekeeping: an expired widget is a file nobody may read again."""
    removed = 0
    for meta in list_all(include_expired=True):
        if expired(meta) and delete(meta["token"]):
            removed += 1
    return removed


def lib_url():
    """The pinned URL of the kit script. The pin is the file's own hash, so a change is a new
    URL and no client can hold the previous copy."""
    path = os.path.join(LIB, "jarvis-kit.js")
    try:
        with open(path, "rb") as f:
            return "/lib/jarvis-kit.js?v=" + hashlib.sha256(f.read()).hexdigest()[:10]
    except Exception:
        return "/lib/jarvis-kit.js"


def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


# ---------------------------------------------------------------- the policy
def widget_csp(page_origin):
    """The policy a widget runs under, on every route and on every host.

    `sandbox allow-scripts` is in the header as well as on the frame, so a widget opened as a
    plain link still lands in an opaque origin: it cannot read the app's storage, cannot reach
    the network, and cannot take the tab anywhere.
    """
    return "; ".join([
        "default-src 'none'",
        "script-src 'unsafe-inline' " + host() + "/lib/",
        "style-src 'unsafe-inline'",
        "img-src data:",
        "font-src data:",
        "connect-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "frame-ancestors " + page_origin,
        "sandbox allow-scripts",
    ])


def widget_headers(page_origin):
    return {
        "Content-Security-Policy": widget_csp(page_origin),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "no-store, max-age=0",
        "Pragma": "no-cache",
    }


# ---------------------------------------------------------------- the house kit
# Prepended to every widget, so JARVIS writes content and the visual language is not his problem.
# Flat fills, thin borders, no gradients or shadows; two text sizes; meaning never carried by
# colour alone.
KIT = """<!doctype html>
<html lang="en" data-jarvis-widget>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>{label}</title>
<style>
:root{{
  --ground:#0A0A0B; --ink:#EAE6DE; --soft:#C6C0B5; --dim:#9A948A; --border:#57534B;
  --accent:#D8B15C;
  --c1:#D8B15C; --c2:#7FA6C9; --c3:#C98F7F; --c4:#8FBF9F; --c5:#B39BC9;
  --t1:clamp(.78rem,.74rem + .16vw,.9rem);
  --t2:clamp(1rem,.94rem + .3vw,1.15rem);
}}
@media (prefers-color-scheme: light){{
  :root{{ --ground:#FBFAF7; --ink:#1C1A17; --soft:#4A453E; --dim:#6B655C; --border:#C9C3B8;
          --accent:#9A6B15;
          --c1:#9A6B15; --c2:#2F6690; --c3:#A2543C; --c4:#3F7A5A; --c5:#6A4C8C; }}
}}
/* The page's own choice beats the device's. An attribute has to be able to override a media query,
   and a widget still following the device while the page showed the other theme looked broken.
   The page passes its choice and the reader's text size in on the query string. */
:root[data-theme="light"]{{ --ground:#FBFAF7; --ink:#1C1A17; --soft:#4A453E; --dim:#6B655C;
  --border:#C9C3B8; --accent:#9A6B15;
  --c1:#9A6B15; --c2:#2F6690; --c3:#A2543C; --c4:#3F7A5A; --c5:#6A4C8C }}
:root[data-theme="dark"]{{ --ground:#0A0A0B; --ink:#EAE6DE; --soft:#C6C0B5; --dim:#9A948A;
  --border:#57534B; --accent:#D8B15C;
  --c1:#D8B15C; --c2:#7FA6C9; --c3:#C98F7F; --c4:#8FBF9F; --c5:#B39BC9 }}
*{{ box-sizing:border-box }}
html,body{{ margin:0; background:var(--ground); color:var(--ink);
  font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-size:var(--t1); line-height:1.45; -webkit-font-smoothing:antialiased }}
body{{ padding:12px }}
h1,h2,h3{{ font-weight:400; margin:0 0 8px }}
h1{{ font-size:var(--t2) }} h2{{ font-size:var(--t2) }} h3{{ font-size:var(--t1); color:var(--soft) }}
.jw-card{{ border:1px solid var(--border); border-radius:8px; padding:12px; margin:0 0 10px }}
.jw-tiles{{ display:flex; flex-wrap:wrap; gap:10px }}
.jw-tile{{ border:1px solid var(--border); border-radius:8px; padding:10px 12px; min-width:110px }}
.jw-tile .v{{ font-size:var(--t2); font-variant-numeric:tabular-nums }}
.jw-tile .k{{ color:var(--dim); margin-top:2px }}
.jw-row{{ display:flex; align-items:center; gap:8px; padding:6px 0;
  border-bottom:1px solid var(--border) }}
.jw-row:last-child{{ border-bottom:0 }}
.jw-node{{ border:1px solid var(--border); border-radius:6px; padding:8px 10px; display:inline-block }}
.jw-arrow{{ color:var(--dim); font-variant-numeric:tabular-nums }}
.jw-legend{{ display:flex; flex-wrap:wrap; gap:12px; color:var(--dim); margin-top:8px }}
.jw-legend span{{ display:inline-flex; align-items:center; gap:6px }}
.jw-swatch{{ width:10px; height:10px; border-radius:2px; border:1px solid var(--border);
  display:inline-block }}
.jw-swatch.dashed{{ border-style:dashed }}
.jw-swatch.dotted{{ border-style:dotted }}
.jw-table{{ width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums }}
.jw-table th,.jw-table td{{ text-align:left; padding:5px 8px 5px 0;
  border-bottom:1px solid var(--border); white-space:normal }}
.jw-table th{{ color:var(--dim); font-weight:400 }}
.jw-table td.num,.jw-table th.num{{ text-align:right }}
.jw-muted{{ color:var(--dim) }}
.jw-accent{{ color:var(--accent) }}
.jw-figure{{ font-size:calc(var(--t2) * 1.9); font-variant-numeric:tabular-nums;
  letter-spacing:-.02em }}
.jw-cta{{ border:1px solid var(--border); background:none; color:var(--ink);
  border-radius:6px; padding:8px 12px; font:inherit; min-height:44px; cursor:pointer }}
.jw-cta:hover{{ border-color:var(--accent) }}
.jw-input{{ border:1px solid var(--border); background:none; color:var(--ink);
  border-radius:6px; padding:8px 10px; font:inherit; min-height:44px; width:100% }}
</style>
</head>
<body data-widget="jarvis">
<script src="https://{host}{lib}"></script>
"""

KIT_JS = r"""/* The JARVIS widget kit. One job: let a widget speak to the page it is framed in, and nothing
 * else. It never reaches the network, never touches a cookie and never leaves the frame. */
(function () {
  "use strict";
  var last = 0, pending = null;

  // What the page is showing. A widget opened as a link has no query string and falls back to the
  // device's preference, which is the right answer when it is the only thing on screen.
  (function () {
    try {
      var p = new URLSearchParams(location.search);
      var th = p.get("theme");
      if (th === "light" || th === "dark") document.documentElement.setAttribute("data-theme", th);
      var t = parseFloat(p.get("t"));
      if (t > 0.5 && t < 3) {
        var r = document.documentElement.style;
        r.setProperty("--t1", (0.84 * t).toFixed(3) + "rem");
        r.setProperty("--t2", (1.07 * t).toFixed(3) + "rem");
      }
    } catch (e) { /* no URLSearchParams, or no query string: keep the device's answer */ }
  })();

  function post(msg) {
    try { parent.postMessage(msg, "*"); } catch (e) { /* no parent: opened as a link */ }
  }

  function sendResize() {
    var h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    if (Math.abs(h - last) < 2) return;
    last = h;
    post({ type: "jarvis:resize", height: h });
  }

  function observe() {
    sendResize();
    if (window.ResizeObserver) {
      try { new ResizeObserver(sendResize).observe(document.documentElement); } catch (e) {}
    }
    window.addEventListener("load", sendResize);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(sendResize);
    if (pending) { clearTimeout(pending); pending = null; }
    setTimeout(sendResize, 60);
  }

  window.JARVIS = {
    /* Ask the page to put a follow-up question to JARVIS, as if it had been typed. */
    ask: function (text) {
      text = String(text == null ? "" : text).slice(0, 200);
      if (!text) return false;
      post({ type: "jarvis:ask", text: text });
      return true;
    },
    resize: sendResize,
    num: function (v, digits) {
      var n = Number(v);
      if (!isFinite(n)) return String(v == null ? "" : v);
      var d = digits == null ? 0 : digits;
      return n.toLocaleString("en-UG", { minimumFractionDigits: d, maximumFractionDigits: d });
    },
    ugx: function (v) { return "UGX " + JARVIS.num(Math.round(Number(v) || 0)); },
    pct: function (v, digits) { return JARVIS.num(v, digits == null ? 1 : digits) + "%"; },
    /* A bar row, the workhorse of an amounts comparison. No colour carries meaning on its own: the
     * value is written beside every bar. */
    bars: function (host, rows, opts) {
      opts = opts || {};
      var max = 0;
      rows.forEach(function (r) { max = Math.max(max, Number(r.value) || 0); });
      if (!max) max = 1;
      var unit = opts.unit || "";
      var out = [];
      rows.forEach(function (r, i) {
        var w = Math.round(((Number(r.value) || 0) / max) * 100);
        out.push('<div class="jw-row"><span style="flex:1">' + esc(r.label) + '</span>' +
                 '<span style="width:45%;height:10px;background:var(--border);border-radius:2px">' +
                 '<span style="display:block;height:10px;width:' + w + '%;background:var(--c' +
                 ((i % 5) + 1) + ');border-radius:2px"></span></span>' +
                 '<span class="jw-muted" style="min-width:5.5em;text-align:right">' +
                 JARVIS.num(r.value, opts.digits) + unit + '</span></div>');
      });
      if (host) host.innerHTML = out.join("");
      return out.join("");
    },
    legend: function (host, items) {
      var html = '<div class="jw-legend">' + items.map(function (it, i) {
        var cls = "jw-swatch" + (it.variant === "dashed" ? " dashed" :
                                 it.variant === "dotted" ? " dotted" : "");
        var style = it.variant === "dash" ? "" : "background:var(--c" + ((i % 5) + 1) + ")";
        return '<span><i class="' + cls + '" style="' + style + '"></i>' + esc(it.label) + "</span>";
      }).join("") + "</div>";
      if (host) host.innerHTML = html;
      return html;
    }
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  observe();
})();
"""
