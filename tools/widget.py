#!/usr/bin/env python3
"""The widget gate: push a widget, then verify it before anything is allowed to show it.

    widget.py push <file.html> [label]     write it to the store, print the URL
    widget.py verify <token|url> [--push]  render it at 360x640 and 1440x900 and fail it on any
                                           console error, CSP violation, horizontal overflow, a
                                           blank canvas, a tap target under 44px, or clipped text
    widget.py list | rm <token>
    widget.py check <file.html> [label]    push and verify in one step (what Phase 5.6 asks for)

Exit code is 0 only on a pass, so a caller that ignores the output still cannot show a widget that
failed. Screenshots land in tools/widget-shots/.

Standalone on purpose: it drives its own headless Chrome over CDP, so it works from a shell, a cron
job or a skill without a browser session already open.
"""
import asyncio
import base64
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
BASE = os.environ.get("JARVIS_LIVE", "http://127.0.0.1:8150")
SHOTS = os.path.join(HERE, "widget-shots")
SIZES = ((360, 640, True), (1440, 900, False))
TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")


def _token():
    with open(os.path.expanduser("~/.hermes/jarvis_live_token"), encoding="utf-8") as f:
        return f.read().strip()


def _api(path, payload=None, method="POST"):
    req = urllib.request.Request(BASE + path, method=method,
                                 headers={"x-jarvis-token": _token(),
                                          "Content-Type": "application/json"},
                                 data=json.dumps(payload).encode() if payload is not None else None)
    try:
        return json.loads(urllib.request.urlopen(req, timeout=20).read().decode())
    except urllib.error.HTTPError as e:
        return {"ok": False, "error": e.code, "body": e.read().decode()[:200]}


# ---------------------------------------------------------------- the gate

HOOK = """
if (!window.__wHook) { window.__wHook = true;
window.__werr = []; window.__wviol = [];
window.addEventListener('error', function (e) { window.__werr.push('error: ' + (e.message || '') + ' @' + (e.filename||'') + ':' + (e.lineno||'')); });
window.addEventListener('unhandledrejection', function (e) {
  window.__werr.push('rejection: ' + (e.reason && (e.reason.message || e.reason))); });
window.addEventListener('securitypolicyviolation', function (e) {
  window.__wviol.push(e.violatedDirective + ' -> ' + String(e.blockedURI || '').slice(0, 70)); });
(function () { var ce = console.error;
  console.error = function () { window.__werr.push('console.error: ' + Array.prototype.join.call(arguments, ' '));
    return ce.apply(console, arguments); };
  var cw = console.warn;
  console.warn = function () { window.__werr.push('console.warn: ' + Array.prototype.join.call(arguments, ' '));
    return cw.apply(console, arguments); };
})(); }
"""

PROBE = open(os.path.join(HERE, "widget_probe.js"), encoding="utf-8").read()


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _wait_devtools(port, tries=60):
    for _ in range(tries):
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/json/version" % port, timeout=1) as r:
                json.loads(r.read().decode())
                return True
        except Exception:
            time.sleep(0.25)
    return False


def _new_target(port):
    req = urllib.request.Request("http://127.0.0.1:%d/json/new?about:blank" % port, method="PUT")
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read().decode())["webSocketDebuggerUrl"]


async def _drive(ws_url, url, width, height, mobile, shot_path):
    import websockets
    n = [0]

    async def send(ws, method, **params):
        n[0] += 1
        mid = n[0]
        await ws.send(json.dumps({"id": mid, "method": method, "params": params}))
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError("%s: %s" % (method, msg["error"]))
                return msg.get("result", {})

    async def evaluate(ws, expr, await_promise=True):
        r = await send(ws, "Runtime.evaluate", expression=expr, returnByValue=True,
                       awaitPromise=await_promise)
        if r.get("exceptionDetails"):
            raise RuntimeError(str(r["exceptionDetails"].get("text"))[:120])
        return r.get("result", {}).get("value")

    async with websockets.connect(ws_url, max_size=None) as ws:
        await send(ws, "Page.enable")
        await send(ws, "Page.addScriptToEvaluateOnNewDocument", source=HOOK)
        await send(ws, "Emulation.setDeviceMetricsOverride", width=width, height=height,
                   deviceScaleFactor=2, mobile=mobile, scale=1)
        await send(ws, "Page.navigate", url=url)
        for _ in range(60):
            await asyncio.sleep(0.25)
            if await evaluate(ws, "document.readyState") == "complete":
                break
        await asyncio.sleep(1.2)
        # The gate renders the widget top-level, where a document can still navigate itself away.
        # If it did, everything measured after this point belongs to some other page, so say so
        # instead of reporting on the wrong document.
        left = await evaluate(ws, "({url: location.href, ours: !!document.querySelector('body[data-widget]')})")
        if not left.get("ours") or not str(left.get("url", "")).startswith(url.split("?")[0].rsplit("/w/", 1)[0]):
            return {"left": True, "where": left.get("url")}, [], []
        await evaluate(ws, PROBE, await_promise=False)
        await asyncio.sleep(0.4)
        probe = await evaluate(ws, "window.__wp.probe()")
        errs = await evaluate(ws, "(window.__werr || []).slice()")
        viol = await evaluate(ws, "(window.__wviol || []).slice()")
        if shot_path:
            png = await send(ws, "Page.captureScreenshot", format="png",
                             captureBeyondViewport=True)
            with open(shot_path, "wb") as f:
                f.write(base64.b64decode(png["data"]))
        return probe, errs, viol


def verify(url, token="", shot=True):
    if not url.startswith("http"):
        url = "https://widgets.battemohammad.com/w/" + url
    os.makedirs(SHOTS, exist_ok=True)
    port = _free_port()
    profile = tempfile.mkdtemp(prefix="wgate-")
    proc = subprocess.Popen(
        ["/usr/bin/google-chrome", "--headless=new", "--no-sandbox", "--disable-gpu",
         "--disable-dev-shm-usage", "--hide-scrollbars", "--remote-debugging-port=%d" % port,
         "--user-data-dir=" + profile, "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        if not _wait_devtools(port):
            raise RuntimeError("headless Chrome did not come up")
        report = {"url": url, "token": token, "sizes": {}, "ok": True}
        for (w, h, mobile) in SIZES:
            label = "%dx%d" % (w, h)
            shot_path = os.path.join(SHOTS, "%s-%s.png" % (token[:10] or "widget", label)) if shot else None
            ws_url = _new_target(port)                      # a fresh target per size, so nothing carries over
            probe, errs, viol = asyncio.run(_drive(ws_url, url + "?v=%d" % int(time.time() * 1000),
                                                   w, h, mobile, shot_path))
            if isinstance(probe, dict) and probe.get("left"):
                report["sizes"][label] = {"violations": ["the widget left its own page for %s"
                                                         % probe.get("where")], "targets": 0,
                                          "canvases": 0, "docOverflow": 0, "text": "", "shot": None}
                report["ok"] = False
                continue
            checks = []
            # A widget is normally framed. Rendered top-level for the gate, an opaque-origin
            # sandbox document produces this one message about its own frame relationship, which
            # has nothing to do with the widget. It is dropped and counted, never dropped silently,
            # so a real cross-frame error still shows up as a number the reader can question.
            NOISE = "Blocked a frame with origin"
            kept = [e for e in errs if NOISE not in e]
            suppressed = len(errs) - len(kept)
            errs = kept

            if errs:
                checks.append("console: " + "; ".join(errs[:3]))
            if viol:
                checks.append("csp: " + "; ".join(viol[:3]))
            if probe["docOverflow"] > 1:
                checks.append("horizontal overflow %dpx" % probe["docOverflow"])
            if probe["blankCanvases"]:
                checks.append("blank canvas: " + json.dumps(probe["blankCanvases"][:3]))
            if probe["smallTargets"]:
                checks.append("tap target: " + json.dumps(probe["smallTargets"][:3]))
            if probe["clippedText"]:
                checks.append("clipped text: " + json.dumps(probe["clippedText"][:3]))
            if probe["escapes"]:
                checks.append("past the edge: " + json.dumps(probe["escapes"][:3]))
            probe["violations"] = checks
            probe["suppressed"] = suppressed
            probe["shot"] = shot_path
            report["sizes"][label] = probe
            if checks:
                report["ok"] = False
        return report
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


# ---------------------------------------------------------------- the command line

def push(path, label=""):
    html = open(path, encoding="utf-8").read()
    return _api("/widget", {"html": html, "label": label or os.path.basename(path)})


def check(path, label=""):
    r = push(path, label)
    if not r.get("ok"):
        print("push failed:", json.dumps(r)[:200])
        return 1
    print("pushed:", r["url"])
    return _report(verify(r["url"], r["token"]))


def _report(report):
    for label, p in report["sizes"].items():
        v = p["violations"]
        print("  %-10s %s" % (label, "PASS" if not v else "FAIL: " + " | ".join(v)))
        print("             %d targets, %d canvas, overflow %dpx, text %r"
              % (p["targets"], p["canvases"], p["docOverflow"], p["text"][:60]))
        if p.get("suppressed"):
            print("             (%d sandbox frame-relationship messages set aside)" % p["suppressed"])
        if p.get("shot"):
            print("             %s" % p["shot"])
    print("verdict:", "PASS" if report["ok"] else "FAIL")
    return 0 if report["ok"] else 2


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 1
    cmd, rest = argv[1], argv[2:]
    if cmd == "push" and rest:
        print(json.dumps(push(rest[0], rest[1] if len(rest) > 1 else "")))
        return 0
    if cmd == "check" and rest:
        return check(rest[0], rest[1] if len(rest) > 1 else "")
    if cmd == "verify" and rest:
        target = rest[0]
        tok = target.rsplit("/", 1)[-1]
        return _report(verify(target, tok if TOKEN_RE.match(tok) else ""))
    if cmd == "list":
        print(json.dumps(_api("/widgets", method="POST"), indent=1))
        return 0
    if cmd == "rm" and rest:
        print(json.dumps(_api("/widgets/delete", {"token": rest[0]})))
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
