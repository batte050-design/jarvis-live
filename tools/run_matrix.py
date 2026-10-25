"""The Phase 0 device-matrix runner.

Loaded into a browser_exec session, where `cdp`, `js`, `goto_url`, `wait_for_load` are already in
scope. It walks the brief's matrix, injects the stress content, and prints PASS or FAIL per
scenario with the violations found. Import it and call `run(sizes)`.
"""
import json
import time

PROBE = open("/data/apps/jarvis-live/tools/matrix.js").read()
URL = "https://live.battemohammad.com/v1"

CONSOLE_HOOK = """
window.__errs = window.__errs || [];
window.addEventListener('error', function (e) {
  window.__errs.push('error: ' + (e.message || '') + ' @' + (e.filename || '') + ':' + (e.lineno || ''));
});
window.addEventListener('unhandledrejection', function (e) {
  window.__errs.push('rejection: ' + (e.reason && (e.reason.message || e.reason)));
});
(function () {
  var ce = console.error;
  console.error = function () {
    window.__errs.push('console.error: ' + Array.prototype.join.call(arguments, ' '));
    return ce.apply(console, arguments);
  };
})();
"""

SCENARIOS = ("idle", "long", "table", "panel400k", "typing", "speaking")


def _nav(width, height, mobile, tag):
    cdp("Emulation.setDeviceMetricsOverride", width=width, height=height,
        deviceScaleFactor=2, mobile=mobile, scale=1)
    goto_url("%s?m=%s" % (URL, tag))
    wait_for_load()
    time.sleep(0.5)
    js(PROBE)


def run(sizes, scenarios=SCENARIOS, kb=False, reduced=False, quiet=False):
    cdp("Network.setCacheDisabled", cacheDisabled=True)
    if reduced:
        cdp("Emulation.setEmulatedMedia",
            features=[{"name": "prefers-reduced-motion", "value": "reduce"}])
    else:
        cdp("Emulation.setEmulatedMedia", features=[])
    try:
        cdp("Page.enable")
        cdp("Page.addScriptToEvaluateOnNewDocument", source=CONSOLE_HOOK)
    except Exception as e:
        print("console hook could not be installed:", e)

    report = {}
    for (w, h) in sizes:
        height = int(h * 0.55) if kb else h
        label = ("kb-" if kb else "") + ("rm-" if reduced else "") + "%dx%d" % (w, h)
        _nav(w, height, w < 900, "%d%s" % (int(time.time() * 1000) % 100000, label))
        rec = {}
        for sc in scenarios:
            js("window.__mtx.load(%s)" % json.dumps(sc))
            time.sleep(0.7)
            probe = js("window.__mtx.probe()")
            errs = js("(window.__errs || []).slice()")
            probe["console"] = errs
            if errs:
                probe["violations"].append("console: " + "; ".join(errs[:3]))
            rec[sc] = probe
            if not quiet:
                v = probe["violations"]
                print("  %-10s %-10s %s" % (label, sc,
                      "PASS" if not v else "FAIL: " + " | ".join(v)))
        report[label] = rec
    return report


def summary(report):
    fails = 0
    total = 0
    for label, rec in report.items():
        for sc, probe in rec.items():
            total += 1
            if probe["violations"]:
                fails += 1
    print("matrix: %d checks, %d failed" % (total, fails))
    return fails
