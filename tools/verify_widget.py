"""Verify a widget before it is shown (brief 5.6).

The harness helpers live in the calling script's namespace, not in this module's, so they are
passed in:

    import sys; sys.path.insert(0, "/data/apps/jarvis-live/tools")
    from verify_widget import verify, show
    show(verify(url, token, cdp=cdp, js=js, goto=goto_url, wait=wait_for_load))

Renders the widget in headless Chrome at 360x640 and 1440x900 and fails it on any console error,
any CSP violation, horizontal overflow, a blank canvas, a tap target under 44px, or text clipped by
its container. Saves a screenshot per size. The hook has to be installed before the widget's own
scripts run, so it goes in through Page.addScriptToEvaluateOnNewDocument rather than after load.
"""
import base64
import json
import os
import time

PROBE = open("/data/apps/jarvis-live/tools/widget_probe.js").read()
SHOTS = "/data/apps/jarvis-live/tools/widget-shots"

HOOK = """
// Installed before every widget's own scripts. Guarded, because Page.addScriptToEvaluateOnNewDocument
// accumulates: every earlier run's copy would otherwise run too and report each error twice.
if (!window.__wHook) {
window.__wHook = true;
window.__werr = [];
window.__wviol = [];
window.addEventListener('error', function (e) { window.__werr.push('error: ' + (e.message || '')); });
window.addEventListener('unhandledrejection', function (e) {
  window.__werr.push('rejection: ' + (e.reason && (e.reason.message || e.reason)));
});
window.addEventListener('securitypolicyviolation', function (e) {
  window.__wviol.push(e.violatedDirective + ' -> ' + String(e.blockedURI || '').slice(0, 70));
});
(function () {
  var ce = console.error;
  console.error = function () {
    window.__werr.push('console.error: ' + Array.prototype.join.call(arguments, ' '));
    return ce.apply(console, arguments);
  };
  var cw = console.warn;
  console.warn = function () {
    window.__werr.push('console.warn: ' + Array.prototype.join.call(arguments, ' '));
    return cw.apply(console, arguments);
  };
})();
}
"""

SIZES = ((360, 640, True), (1440, 900, False))


def verify(url, token="", cdp=None, js=None, goto=None, wait=None, sizes=SIZES, shot=True,
           settle=1.2):
    os.makedirs(SHOTS, exist_ok=True)
    cdp("Network.setCacheDisabled", cacheDisabled=True)
    try:
        cdp("Page.enable")
        cdp("Page.addScriptToEvaluateOnNewDocument", source=HOOK)
    except Exception as e:
        print("hook could not be installed:", e)

    report = {"url": url, "token": token, "sizes": {}, "ok": True}
    for (w, h, mobile) in sizes:
        cdp("Emulation.setDeviceMetricsOverride", width=w, height=h,
            deviceScaleFactor=2, mobile=mobile, scale=1)
        goto("%s?v=%d" % (url, int(time.time() * 1000) % 1000000))
        wait()
        time.sleep(settle)
        js(PROBE)
        time.sleep(0.4)
        probe = js("window.__wp.probe()")
        errs = js("(window.__werr || []).slice()")
        viol = js("(window.__wviol || []).slice()")
        label = "%dx%d" % (w, h)

        checks = []
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

        if shot:
            try:
                png = cdp("Page.captureScreenshot", format="png", captureBeyondViewport=True)["data"]
                path = os.path.join(SHOTS, "%s-%s.png" % ((token[:10] or "widget"), label))
                with open(path, "wb") as f:
                    f.write(base64.b64decode(png))
                probe["shot"] = path
            except Exception as e:
                probe["shot"] = "screenshot failed: %s" % e

        probe["violations"] = checks
        report["sizes"][label] = probe
        if checks:
            report["ok"] = False
    return report


def show(report, quiet=False):
    for label, p in report["sizes"].items():
        v = p["violations"]
        print("  %-10s %s" % (label, "PASS" if not v else "FAIL: " + " | ".join(v)))
        if not quiet:
            print("             %d targets, %d canvas, overflow %dpx, text %r"
                  % (p["targets"], p["canvases"], p["docOverflow"], p["text"][:60]))
    print("verdict:", "PASS" if report["ok"] else "FAIL")
    return report["ok"]
