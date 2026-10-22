#!/usr/bin/env python3
"""One turn against the live page, timed. Also runs the routing set and records a baseline.

    python3 tools/turn_probe.py "a question"          # one turn, timed
    python3 tools/turn_probe.py --mode text "a question"   # a typed turn: no audio may exist
    python3 tools/turn_probe.py --routing             # the routing set -> tests/baseline.json
    python3 tools/turn_probe.py --routing tests/after.json

Transport: a POST with a JSON body since item 1 (it was a GET with the prompt in the query
string). Pass --get to compare against the old transport. The rest of this file does not care.

Mode: the turn carries `mode`, and each mode is checked for what it must NOT do. A text turn that
produces even one audio part is a failure (the prompt is never spoken, and the speech service is
never called for it). A voice turn with no audio is a failure too: it is a page that has gone mute.
"""
import argparse, json, os, re, sys, time, urllib.request, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
PUBLIC = "https://live.battemohammad.com"
TOKEN = open(os.path.expanduser("~/.hermes/jarvis_live_token"), encoding="utf-8").read().strip()
TRANSPORT = "POST"   # item 1: the page's stream is a POST now. --get compares the old one.
MODE = "voice"

MACHINERY = ("[[", "]]", "DSML", "<|", "\\uff5c", "```", "session_id", "Normalized model")


def open_turn(q, transport=None, mode=None):
    """Return an iterator of (event, data) for one turn, and the response object."""
    transport = (transport or TRANSPORT).upper()
    mode = mode or MODE
    if transport == "POST":
        body = json.dumps({"q": q, "mode": mode}).encode()
        req = urllib.request.Request(PUBLIC + "/stream", data=body,
                                     headers={"Cookie": "jl=" + TOKEN,
                                              # the same-origin guard (item 1) wants a browser-like
                                              # request; this stands in for the page's own fetch
                                              "Origin": PUBLIC,
                                              "Content-Type": "application/json",
                                              "Accept": "text/event-stream"})
    else:
        req = urllib.request.Request(PUBLIC + "/stream?q=" + urllib.parse.quote(q),
                                     headers={"Cookie": "jl=" + TOKEN, "Origin": PUBLIC,
                                              "Accept": "text/event-stream"})
    resp = urllib.request.urlopen(req, timeout=300)
    return resp


def run_turn(q, transport=None, mode=None):
    """One turn. Returns a dict of what happened, timed from the request."""
    mode = mode or MODE
    t0 = time.time()
    first_tok = first_audio = done_at = work_at = text_at = None
    text, settled, units, parts, bytes_in = "", "", set(), 0, 0
    audio_events = 0
    errors = []
    ev = None
    resp = open_turn(q, transport, mode)
    for raw in resp:
        line = raw.decode("utf-8", "ignore").rstrip("\n")
        if line.startswith("event: "):
            ev = line[7:]
        elif line.startswith("data: ") and ev:
            try:
                d = json.loads(line[6:])
            except Exception:
                continue
            if ev == "tok":
                text += (d.get("d") or "")
                if first_tok is None:
                    first_tok = time.time() - t0
            elif ev == "audio":
                audio_events += 1
                if d.get("part", -1) >= 0:
                    if first_audio is None:
                        first_audio = time.time() - t0
                    parts += 1
                    units.add(d.get("n"))
                else:
                    units.add(d.get("n"))
            elif ev == "text":
                # the settled answer, sent once in text mode
                settled = str(d.get("text") or "")
                text_at = time.time() - t0
            elif ev == "work":
                if d.get("state") == "start" and work_at is None:
                    work_at = time.time() - t0
            elif ev in ("err", "warnerr"):
                errors.append(json.dumps(d)[:120])
            elif ev == "done":
                done_at = time.time() - t0
                break
    spoken = text.strip()
    problems = []
    if mode == "text":
        if audio_events:
            problems.append("text turn produced %d audio events" % audio_events)
        if not settled:
            problems.append("text turn sent no settled text event")
    else:
        if not audio_events:
            problems.append("voice turn produced no audio at all")
    return {
        "question": q,
        "mode": mode,
        "route": "work" if work_at is not None else "answer",
        "work_at_s": round(work_at, 2) if work_at else None,
        "first_token_s": round(first_tok, 2) if first_tok else None,
        "first_audio_s": round(first_audio, 2) if first_audio else None,
        "text_at_s": round(text_at, 2) if text_at else None,
        "done_s": round(done_at, 2) if done_at else None,
        "audio_events": audio_events,
        "settled_chars": len(settled),
        "units": len(units),
        "parts": parts,
        "chars": len(spoken),
        "machinery": sorted({m for m in MACHINERY if m in spoken}),
        "errors": errors,
        "problems": problems,
        "mode_ok": not problems,
    }


def routing(path_in, path_out):
    spec = json.load(open(path_in, encoding="utf-8"))
    rows = []
    for i, item in enumerate(spec, 1):
        try:
            r = run_turn(item["q"], mode=item.get("mode", "voice"))
        except Exception as e:
            r = {"question": item["q"], "route": "error", "errors": [repr(e)[:120]],
                 "mode": item.get("mode", "voice"), "mode_ok": False, "problems": ["raised"]}
        r["class"] = item.get("class")
        r["expect"] = item.get("expect")
        r["correct"] = ("either" if item.get("expect") in (None, "either")
                        else item.get("expect") == r.get("route"))
        rows.append(r)
        print("%2d. %-9s %-5s want %-7s %-7s tok=%-5s audio=%-5s events=%-3s %s %s" % (
            i, r["class"], r.get("mode", "voice"), r.get("expect"), r.get("route"),
            r.get("first_token_s"), r.get("first_audio_s"), r.get("audio_events"),
            "" if r["correct"] in (True, "either") else "<-- MISROUTED",
            "  ".join(r.get("problems") or [])))
        sys.stdout.flush()
    judged = [r for r in rows if r["correct"] in (True, False)]

    def med(key):
        vals = sorted(r[key] for r in rows if r.get(key) is not None)
        return round(vals[len(vals) // 2], 2) if vals else None

    summary = {
        "when": time.strftime("%Y-%m-%d %H:%M:%S"),
        "transport": TRANSPORT,
        "questions": len(rows),
        "misrouted": sum(1 for r in judged if not r["correct"]),
        "judged": len(judged),
        "mode_failures": [r["question"] for r in rows if not r.get("mode_ok", True)],
        "machinery_leaks": [r["question"] for r in rows if r["machinery"]],
        "errors": [r["question"] for r in rows if r.get("errors")],
        "first_token_median_s": med("first_token_s"),
        "first_audio_median_s": med("first_audio_s"),
        "rows": rows,
    }
    json.dump(summary, open(path_out, "w", encoding="utf-8"), indent=1)
    print("\n%s: %d questions, %d misrouted of %d judged, machinery leaks %d, errors %d, "
          "mode failures %d"
          % (path_out, summary["questions"], summary["misrouted"], summary["judged"],
             len(summary["machinery_leaks"]), len(summary["errors"]),
             len(summary["mode_failures"])))
    print("medians: first token %ss, first sound %ss" %
          (summary["first_token_median_s"], summary["first_audio_median_s"]))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("question", nargs="?")
    ap.add_argument("--routing", nargs="?", const="", metavar="OUT")
    ap.add_argument("--in", dest="path_in", default=os.path.join(APP, "tests", "routing.json"))
    ap.add_argument("--post", action="store_true")
    ap.add_argument("--get", action="store_true")
    ap.add_argument("--mode", default="voice", choices=("voice", "text"))
    a = ap.parse_args()
    if a.post:
        TRANSPORT = "POST"
    if a.get:
        TRANSPORT = "GET"
    MODE = a.mode
    if a.routing is not None:
        out = a.routing or os.path.join(APP, "tests", "baseline.json")
        routing(a.path_in, out)
    elif a.question:
        r = run_turn(a.question)
        for k, v in r.items():
            if k != "question":
                print("%-14s %s" % (k, v))
    else:
        ap.print_help()
