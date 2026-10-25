#!/usr/bin/env python3
"""Push a widget document to the store and print its URL.

Usage: widget_push.py <file.html> [label]
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("JARVIS_LIVE", "http://127.0.0.1:8150")


def push(path, label=""):
    token = open(os.path.expanduser("~/.hermes/jarvis_live_token"), encoding="utf-8").read().strip()
    html = open(path, encoding="utf-8").read()
    body = json.dumps({"html": html, "label": label or os.path.basename(path)}).encode()
    req = urllib.request.Request(BASE + "/widget", data=body,
                                 headers={"x-jarvis-token": token,
                                          "Content-Type": "application/json"})
    try:
        return json.loads(urllib.request.urlopen(req, timeout=15).read().decode())
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read().decode()[:200]}


if __name__ == "__main__":
    print(json.dumps(push(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "")))
