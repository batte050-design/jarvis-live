"""Presentation channel for the page: the harness authors, validates and owns every answer.

The page no longer calls a model. This plugin gives the harness one way to hand back a
finished interface, and refuses anything it cannot validate and evaluate.
"""
from __future__ import annotations

import json, os, subprocess, sys
import store

APP = os.environ.get("PRESENT_APP", "/data/apps/jarvis-live-staging")
NODE = os.environ.get("PRESENT_NODE", "/home/ubuntu/.hermes/node/bin/node")
VERSION = json.load(open(os.path.join(os.path.dirname(__file__), "version.json")))["version"]

UI_SCHEMA = {
    "name": "emit_ui",
    "description": ("Hand the reader a finished interface. Send the introduction in prose and the "
                    "OpenUI program that draws it. The program is validated and evaluated before it "
                    "reaches the page; if it is rejected you get the diagnostics and may repair it "
                    "once more in this same turn. Use this only when an interface serves the answer "
                    "better than prose."),
    "parameters": {
        "type": "object",
        "properties": {
            "intro": {"type": "string", "description": "the sentence(s) the reader sees above the interface"},
            "program": {"type": "string", "description": "the OpenUI Lang program, no code fences"},
            "kind": {"type": "string", "description": "what this is, e.g. quote, calculation, form, gallery"},
            "required": {"type": "array", "items": {"type": "string"},
                         "description": "controls this answer must expose, as state names"},
        },
        "required": ["intro", "program", "kind"],
    },
}

PROGRESS_SCHEMA = {
    "name": "emit_progress",
    "description": "One short line telling the reader what is being checked or gathered. No machinery.",
    "parameters": {"type": "object",
                   "properties": {"line": {"type": "string", "maxLength": 120}},
                   "required": ["line"]},
}


def _turn():
    return (os.environ.get("PRESENT_OWNER", ""), os.environ.get("PRESENT_CONV", ""),
            os.environ.get("PRESENT_SESSION", ""), os.environ.get("PRESENT_TURN", ""))


def _validate(program: str) -> dict:
    """Parse, validate and evaluate in a side-effect-free runtime. Returns diagnostics."""
    check = os.path.join(APP, "tools", "openui_validate_once.py")
    if not os.path.exists(check):
        return {"ok": False, "stage": "runtime", "error": "validator_missing"}
    try:
        p = subprocess.run([sys.executable, check], input=program, capture_output=True,
                           text=True, timeout=20, cwd=APP)
        out = (p.stdout or "").strip().splitlines()
        if not out:
            return {"ok": False, "stage": "runtime", "error": (p.stderr or "no output")[:400]}
        return json.loads(out[-1])
    except Exception as e:
        return {"ok": False, "stage": "runtime", "error": str(e)[:200]}


def handle_emit_ui(args):
    intro = str(args.get("intro") or "").strip()
    program = str(args.get("program") or "").strip()
    kind = str(args.get("kind") or "").strip() or "interface"
    required = [str(x) for x in (args.get("required") or []) if str(x).strip()]
    if not program:
        return json.dumps({"accepted": False, "stage": "input",
                           "diagnostics": ["program is empty"]})
    result = _validate(program)
    if not result.get("ok"):
        return json.dumps({"accepted": False, "stage": result.get("stage", "validate"),
                           "diagnostics": result.get("error") or result.get("diagnostics")})
    payload = {"version": VERSION, "kind": kind, "intro": intro,
               "program": program, "required": required,
               "components": result.get("components") or []}
    owner, conv, session, turn = _turn()
    try:
        rec = store.put(payload, owner, conv, session, turn, VERSION)
    except Exception as e:
        return json.dumps({"accepted": False, "stage": "store", "diagnostics": [str(e)]})
    return json.dumps({"accepted": True, "receipt": rec["sha256"][:16], "version": VERSION})


def handle_emit_progress(args):
    line = str(args.get("line") or "").strip()[:120]
    if not line:
        return json.dumps({"ok": False})
    owner, conv, session, turn = _turn()
    p = os.path.join(str(store.ROOT), "progress-%s.jsonl" % (turn or "none"))
    with open(p, "a") as fh:
        fh.write(json.dumps({"line": line, "owner": owner, "conv": conv, "turn": turn}) + "\n")
    return json.dumps({"ok": True})


def register(ctx) -> None:
    ctx.register_tool(name="emit_ui", toolset="page_presentation", schema=UI_SCHEMA,
                      handler=handle_emit_ui, emoji="🖼️")
    ctx.register_tool(name="emit_progress", toolset="page_presentation", schema=PROGRESS_SCHEMA,
                      handler=handle_emit_progress, emoji="…")
