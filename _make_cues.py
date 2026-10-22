#!/usr/bin/env python3
"""Make the short spoken cues the page plays while it waits.

The wait lines did not exist: the page could say "the agent failed" but not "I am working on it", so a
slow turn was silence. These are rendered in the same cloned voice, with the same settings the live
speech path uses, so they cannot sound like a different speaker.

    /data/apps/jarvis-live/venv/bin/python _make_cues.py

Add a line to CUES and re-run to add another. Anything already on disk is left alone unless --force.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CUES = os.path.join(HERE, "cues")
ENV = os.path.expanduser("~/.hermes/.env")

VOICE = "79554ca723f442a3af718d5aab8e30f7"          # replaced at run time from the server's own voice
MODEL = "s2.1-pro-free"

# The lines, and when the page plays them.
LINES = {
    # Fired about a second in, when a turn has produced neither a token nor audio.
    "working": "Working on it.",
    # Fired at about fifteen seconds, so a long job is never a dead line. He can talk over both.
    "stillworking": "Still working on it.",
}


def env(key: str) -> str:
    if os.environ.get(key):
        return os.environ[key]
    try:
        with open(ENV, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith(key + "="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return ""


def voice() -> str:
    """Read the voice the live server is actually using, so a cue cannot drift from the speaker."""
    try:
        src = open(os.path.join(HERE, "server.py"), encoding="utf-8").read()
        i = src.index('VOICE = "') + len('VOICE = "')
        return src[i:src.index('"', i)]
    except Exception:
        return VOICE


def speed() -> float:
    try:
        src = open(os.path.join(HERE, "server.py"), encoding="utf-8").read()
        i = src.index("SPEED = ")
        return float(src[i + len("SPEED = "):].split()[0].strip().rstrip(";,"))
    except Exception:
        return 1.0


def synth(text: str, ref: str, sp: float, key: str) -> bytes:
    body = json.dumps({"text": text, "reference_id": ref, "format": "mp3",
                       "latency": "balanced", "chunk_length": 150,
                       "temperature": 0.7, "top_p": 0.7, "normalize": True,
                       "prosody": {"speed": sp}}).encode()
    req = urllib.request.Request(
        "https://api.fish.audio/v1/tts", data=body,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                 "model": MODEL})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def main() -> int:
    force = "--force" in sys.argv
    key = env("FISH_AUDIO_API_KEY") or env("FISH_API_KEY")
    if not key:
        print("no speech key found in the environment or ~/.hermes/.env")
        return 1
    ref, sp = voice(), speed()
    os.makedirs(CUES, exist_ok=True)
    made = 0
    for name, line in LINES.items():
        path = os.path.join(CUES, name + ".mp3")
        if os.path.exists(path) and not force:
            print("%-14s kept (already there, %d bytes)" % (name, os.path.getsize(path)))
            continue
        audio = synth(line, ref, sp, key)
        if len(audio) < 2000:
            print("%-14s REFUSED: %d bytes, that is not speech" % (name, len(audio)))
            return 1
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(audio)
        os.replace(tmp, path)
        print("%-14s wrote %d bytes  \"%s\"" % (name, len(audio), line))
        made += 1
    print("voice %s  speed %.2f  made %d" % (ref[:8] + "...", sp, made))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
