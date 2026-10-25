"""Fixed progress states. The model may pick from this table and nothing else."""
import os, time, pathlib, json

ROOT = pathlib.Path(os.environ.get("PRESENT_STORE", "/data/apps/jarvis-live-staging/ctx/present"))
STATES = {"checking_figures": "Checking the figures",
          "reading_source": "Reading the source",
          "gathering_file": "Gathering the file",
          "computing": "Working the numbers",
          "drafting": "Drafting the answer"}
MIN_GAP = 3.0


def accept(state, turn_id):
    if state not in STATES:
        raise ValueError("unsupported_progress_state")
    marker = ROOT / ("progress-%s.stamp" % turn_id)
    now = time.time()
    if marker.exists():
        try:
            last = float(marker.read_text())
        except ValueError:
            last = 0.0
        if now - last < MIN_GAP:
            return None
    marker.write_text(str(now))
    ev = {"state": state, "line": STATES[state], "ts": now, "turn_id": turn_id, "ephemeral": True}
    with open(ROOT / ("exec-%s.jsonl" % turn_id), "a") as fh:
        fh.write(json.dumps({**ev, "private": True}) + "\n")
    return ev
