#!/usr/bin/env python3
"""Turn one RICH REPLY (JSON) into a JARVIS widget, and gate it before anything shows it.

The model writes the reply as data. This renders it. Nothing here decides content.

    reply_widget.py build reply.json out.html    # render the reply fragment to a widget file
    reply_widget.py check reply.json [label]     # build, push through the page, run the gate
    reply_widget.py plan  reply.json             # print the screen_show call(s) to make

Schema (exactly what the model emits; see references/rich-replies.md):

    {
      "title": "Meetups where people connect naturally",
      "intro": "one short paragraph",
      "sections": [
        {"type": "heading",   "text": "Best meetups to consider"},
        {"type": "paragraph", "text": "..."},
        {"type": "divider"},
        {"type": "cards", "items": [
            {"title": "...", "description": "...", "badge": "...", "metadata": "...",
             "image": {"src": "https://... | data:...", "alt": "..."},
             "links": [{"label": "...", "href": "https://..."}]}]},
        {"type": "choices", "id": "connection", "prompt": "...",
         "options": [{"label": "...", "value": "..."}]}
      ],
      "closing": "...",
      "followUpPrompt": "Find suitable upcoming meetups in the location I gave you."
    }

Hard limits this file exists to respect, all taken from the live code:
  * a widget's CSP is `default-src 'none'`, `img-src data:`, `connect-src 'none'`,
    `style-src 'unsafe-inline'`, `sandbox allow-scripts` — so no remote image, no fetch, no
    popup and no top navigation. An https image must be inlined (--inline) or left out.
  * an `<a href>` inside a widget cannot open, and the gate measures it: a link styled as text
    is the honest rendering.
  * the gate fails any control whose own box is under 43.5px, so the radio itself is 44px.
  * JARVIS.ask(text) is clamped to 200 characters, one call per two seconds.

Stdlib only. Terminal: `python3 scripts/reply_widget.py check reply.json "Meetups"`.
"""
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request

LIVE = os.environ.get("JARVIS_LIVE_DIR", "/data/apps/jarvis-live")
GATE = os.path.join(LIVE, "tools", "widget.py")
MAX_WIDGET_BYTES = 400_000          # widgets.py MAX_BYTES
ASK_LIMIT = 200                     # the kit and the page both clamp to this
IMAGE_BUDGET = 120_000              # bytes of image the whole widget may carry
CSS = """
.wr-h{font:inherit;font-weight:400;margin:16px 0 8px}
.wr-h:first-child{margin-top:0}
.wr-p{margin:0 0 12px;color:var(--soft)}
.wr-div{border:0;border-top:1px solid var(--border);margin:16px 0}
.wr-card{border:1px solid var(--border);border-radius:8px;padding:12px;margin:0 0 10px;max-width:100%}
.wr-card img{display:block;width:100%;max-width:100%;height:auto;border-radius:6px;margin-bottom:10px}
.wr-card h4{margin:0 0 6px;font-weight:400;font-size:var(--t2)}
.wr-badge{display:inline-block;border:1px solid var(--border);border-radius:999px;
  padding:2px 10px;margin:0 0 6px;color:var(--dim)}
.wr-meta{color:var(--dim);margin:8px 0 0}
.wr-link{display:block;color:var(--soft);margin:6px 0 0;word-break:break-all}
.wr-choices{border:1px solid var(--border);border-radius:8px;padding:12px;margin:0 0 12px;max-width:100%}
.wr-choices h4{margin:0 0 8px;font-weight:400}
.wr-opt{display:flex;align-items:center;gap:10px;cursor:pointer}
.wr-opt input{appearance:none;-webkit-appearance:none;flex:0 0 auto;width:44px;height:44px;
  margin:0;border:1px solid var(--border);border-radius:50%;background:none}
.wr-opt input:checked{border-color:var(--accent);box-shadow:inset 0 0 0 11px var(--accent)}
.wr-opt span{color:var(--soft)}
.wr-opt input:checked + span{color:var(--ink)}
.wr-sent{margin:10px 0 0;color:var(--accent)}
"""

SCRIPT = """
(function () {
  var ids = %(ids)s, limit = %(limit)d;
  var btn = document.getElementById("wr-send"), sent = document.getElementById("wr-sent");
  if (!btn) return;
  function chosen() {
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var picked = document.querySelector('input[name="' + ids[i] + '"]:checked');
      if (picked) out.push(ids[i] + ": " + picked.value);
    }
    return out;
  }
  function refresh() {
    var n = chosen().length;
    btn.disabled = n < ids.length;
    btn.style.opacity = btn.disabled ? "0.4" : "1";
  }
  document.addEventListener("change", refresh);
  refresh();
  btn.addEventListener("click", function () {
    var answers = chosen();
    if (!answers.length) return;
    var text = (%(prompt)s + " " + answers.join(" ")).slice(0, limit);
    // Shown whatever the transport: opened as a plain link, nothing can reach the page, and a
    // control that silently did nothing would be the lie.
    sent.textContent = "Sent to JARVIS: " + text;
    try { if (window.JARVIS && window.JARVIS.ask) window.JARVIS.ask(text); } catch (e) {}
  });
})();
"""


def esc(s):
    return (str("" if s is None else s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


def js_str(s):
    return json.dumps(str(s or ""))


def host_of(url):
    m = re.match(r"^https?://([^/]+)", str(url or ""))
    return m.group(1) if m else ""


def inline_image(src, spent):
    """An https image cannot be fetched by the widget (img-src data:), so fetch it here."""
    if src.startswith("data:"):
        return src
    if not re.match(r"^https?://", src):
        return ""
    if spent[0] >= IMAGE_BUDGET:
        return ""
    req = urllib.request.Request(src, headers={"User-Agent": "jarvis-reply-widget/1"})
    with urllib.request.urlopen(req, timeout=15) as r:
        raw = r.read(IMAGE_BUDGET - spent[0] + 1)
        ctype = (r.headers.get("Content-Type") or "image/jpeg").split(";")[0].strip()
    if len(raw) > IMAGE_BUDGET - spent[0]:
        return ""
    if not ctype.startswith("image/"):
        return ""
    spent[0] += len(raw)
    return "data:%s;base64,%s" % (ctype, base64.b64encode(raw).decode())


def render_card(card, inline, spent, notes):
    img = card.get("image") or {}
    src = str(img.get("src") or "")
    data_uri = ""
    if src:
        try:
            data_uri = inline_image(src, spent) if inline else (src if src.startswith("data:") else "")
        except Exception as e:                                  # a dead image is not a dead reply
            notes.append("image not inlined (%s): %s" % (src, e))
            data_uri = ""
        if src and not data_uri:
            notes.append("image left out of the widget (remote image, no --inline): %s" % src)
    out = ['<section class="wr-card">']
    if data_uri:
        out.append('<img src="%s" alt="%s">' % (esc(data_uri), esc(img.get("alt") or "")))
    if card.get("badge"):
        out.append('<span class="wr-badge">%s</span>' % esc(card["badge"]))
    out.append("<h4>%s</h4>" % esc(card.get("title") or ""))
    if card.get("description"):
        out.append('<p class="wr-p">%s</p>' % esc(card["description"]))
    if card.get("metadata"):
        out.append('<p class="wr-meta">%s</p>' % esc(card["metadata"]))
    for link in (card.get("links") or []):
        href = str(link.get("href") or "")
        # Deliberately not an <a>: a sandboxed widget cannot open one, and the gate measures it.
        out.append('<span class="wr-link">%s - %s</span>'
                   % (esc(link.get("label") or href), esc(host_of(href))))
    out.append("</section>")
    return "".join(out)


def render_choices(sec, used_ids):
    sid = str(sec.get("id") or ("choice%d" % (len(used_ids) + 1)))
    sid = re.sub(r"[^A-Za-z0-9_-]", "_", sid) or "choice"
    while sid in used_ids:
        sid += "x"
    used_ids.add(sid)
    out = ['<section class="wr-choices">', "<h4>%s</h4>" % esc(sec.get("prompt") or "")]
    for opt in (sec.get("options") or []):
        label = str(opt.get("label") or "")
        value = str(opt.get("value") if opt.get("value") is not None else label)
        out.append('<label class="wr-opt"><input type="radio" name="%s" value="%s"><span>%s</span></label>'
                   % (esc(sid), esc(value), esc(label)))
    out.append("</section>")
    return sid, "".join(out)


def render(data, inline=False, notes=None):
    notes = notes if notes is not None else []
    spent = [0]
    parts = ['<style>%s</style>' % CSS]
    if data.get("title"):
        parts.append('<h2 class="wr-h">%s</h2>' % esc(data["title"]))
    if data.get("intro"):
        parts.append('<p class="wr-p">%s</p>' % esc(data["intro"]))
    choice_ids, used_ids = [], set()
    for sec in (data.get("sections") or []):
        kind = str(sec.get("type") or "")
        if kind == "heading":
            parts.append('<h3 class="wr-h">%s</h3>' % esc(sec.get("text") or ""))
        elif kind == "paragraph":
            parts.append('<p class="wr-p">%s</p>' % esc(sec.get("text") or ""))
        elif kind == "divider":
            parts.append('<hr class="wr-div">')
        elif kind == "cards":
            for card in (sec.get("items") or []):
                parts.append(render_card(card, inline, spent, notes))
        elif kind == "choices":
            sid, markup = render_choices(sec, used_ids)
            choice_ids.append(sid)
            parts.append(markup)
        else:
            notes.append("unknown section type ignored: %r" % kind)
    if data.get("closing"):
        parts.append('<p class="wr-p">%s</p>' % esc(data["closing"]))
    if choice_ids:
        # Worst case, all sections answered with their longest label: the ask is clamped to 200
        # characters, and a silently truncated answer is a wrong answer.
        worst = len(str(data.get("followUpPrompt") or "")) + sum(
            len(sid) + 2 + max([len(str(o.get("value") or o.get("label") or ""))
                                for o in (sec.get("options") or [{}])] or [0]) + 1
            for sid, sec in zip(choice_ids, [s for s in data.get("sections") or []
                                             if s.get("type") == "choices"]))
        if worst > ASK_LIMIT:
            notes.append("choices compose to ~%d chars, over the %d allowed: shorten the option "
                         "values or the followUpPrompt" % (worst, ASK_LIMIT))
        parts.append('<button class="jw-cta" id="wr-send" type="button" disabled>Continue</button>')
        parts.append('<p class="wr-sent" id="wr-sent"></p>')
        parts.append("<script>%s</script>" % (SCRIPT % {
            "ids": json.dumps(choice_ids), "limit": ASK_LIMIT,
            "prompt": js_str(data.get("followUpPrompt") or "Continue with these preferences:")}))
    return "".join(parts), notes


def build(data, inline=False):
    html, notes = render(data, inline=inline)
    return html, notes


def check(path, label):
    """Push through the page and run the gate. Exit code is the gate's own."""
    return subprocess.call([sys.executable, GATE, "check", path, label or path])


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 1
    cmd, src = argv[1], argv[2]
    inline = "--inline" in argv
    rest = [a for a in argv[3:] if not a.startswith("--")]
    data = json.load(open(src, encoding="utf-8"))
    html, notes = build(data, inline=inline)
    for n in notes:
        print("note:", n)
    raw = html.encode("utf-8")
    if len(raw) > MAX_WIDGET_BYTES:
        print("FAIL: %d bytes, over the %d cap: drop a card or inline a smaller image"
              % (len(raw), MAX_WIDGET_BYTES))
        return 2
    if cmd == "build":
        out = rest[0] if rest else os.path.splitext(src)[0] + ".widget.html"
        with open(out, "w", encoding="utf-8") as f:
            f.write(html)
        print("wrote %s (%d bytes)" % (out, len(raw)))
        return 0
    if cmd == "check":
        out = os.path.join(tempfile.gettempdir(), "reply-widget-check.html")
        with open(out, "w", encoding="utf-8") as f:
            f.write(html)
        label = rest[0] if rest else (data.get("title") or "Reply")
        rc = check(out, label)
        print("gate:", "PASS" if rc == 0 else "FAIL")
        return rc
    if cmd == "plan":
        kinds = ["metrics", "table", "list", "code", "text"]
        print("# one thing on the screen at a time: a composed reply is a widget, not a sequence")
        print('# 1. push it:      python3 %s check %s "%s"'
              % (os.path.relpath(__file__), src, data.get("title") or "Reply"))
        print('# 2. then show it: screen_show(kind="widget", label="%s", url="<url from the push>")'
              % (data.get("title") or "Reply"))
        for sec in (data.get("sections") or []):
            if sec.get("type") == "cards":
                for card in (sec.get("items") or []):
                    for link in (card.get("links") or []):
                        print('# link that must open: screen_show(kind="link", label="%s", href="%s")'
                              % (link.get("label") or "", link.get("href") or ""))
        print("# native kinds available for a simple reply: " + ", ".join(kinds))
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
