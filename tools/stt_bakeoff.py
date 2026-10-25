#!/usr/bin/env python3
"""The bake-off item 6 asks for: what is on disk, timed on his own 25 kept clips.

Judged by Mohammad reading the transcripts. Nothing is changed on the basis of this file alone.
"""
import glob, os, sys, time, wave

sys.path.insert(0, "/data/apps/jarvis-live")
import server

CANDIDATES = ["base", "base.en", "small", "tiny.en"]
clips = sorted(glob.glob("/data/apps/jarvis-live/clips/*.wav"))
print("clips: %d" % len(clips), flush=True)

# Fetch anything not already here, outside any request, so the download cannot land in a turn.
for name in CANDIDATES:
    ok = server.model_present(name)
    print("  %-8s %s" % (name, "already on disk" if ok else "downloading..."), flush=True)
    if not ok:
        try:
            server.whisper(name)
            print("           downloaded", flush=True)
        except Exception as e:
            print("           could not be fetched: %s" % str(e)[:100], flush=True)

rows, totals = [], {c: 0.0 for c in CANDIDATES}
for c in clips:
    row = {"clip": os.path.basename(c)[:15], "seconds": 0.0}
    with wave.open(c) as w:
        row["seconds"] = round(w.getnframes() / float(w.getframerate() or 1), 2)
    for name in CANDIDATES:
        try:
            t0 = time.time()
            segs, info = server.whisper(name).transcribe(
                c, language="en", beam_size=5, vad_filter=True,
                condition_on_previous_text=False, temperature=0.0, no_speech_threshold=0.65,
                initial_prompt=server.vocab()[0])
            text = " ".join(s.text.strip() for s in segs).strip()
            dt = time.time() - t0
        except Exception as e:
            text, dt = "(%s)" % str(e)[:40], 0.0
        row[name] = text
        row[name + "_s"] = round(dt, 2)
        totals[name] += dt
    rows.append(row)
    print("  %s done" % row["clip"], flush=True)

out = ["# Speech recognition bake-off", "",
       "His own 25 kept clips, the same settings the page uses. Nothing here changes the page:",
       "judged by reading the transcripts.", "",
       "| clip | secs | " + " | ".join(CANDIDATES) + " |",
       "|---|---|" + "---|" * len(CANDIDATES)]
for r in rows:
    out.append("| %s | %.2f | %s |" % (r["clip"], r["seconds"], " | ".join(r[c] for c in CANDIDATES)))
out += ["", "## Time per clip (seconds)", "",
        "| model | total | mean | on-disk |", "|---|---|---|---|"]
for name in CANDIDATES:
    present = "yes" if server.model_present(name) else "no"
    out.append("| %s | %.1f | %.2f | %s |" % (name, totals[name], totals[name] / max(len(rows), 1), present))
out += ["", "## Transcripts, one line per candidate", ""]
for r in rows:
    out.append("### %s (%.2fs)" % (r["clip"], r["seconds"]))
    for name in CANDIDATES:
        out.append("- **%s** (%.2fs): %s" % (name, r[name + "_s"], r[name] or "(nothing)"))
    out.append("")

path = "/data/apps/jarvis-live/tests/stt-bakeoff.md"
with open(path, "w", encoding="utf-8") as f:
    f.write("\n".join(out))
print("\n" + "\n".join(out[-1 * (len(CANDIDATES) * 0) - 12:]))
print("\nwritten to %s" % path)
for name in CANDIDATES:
    print("  %-8s total %.1fs  mean %.2fs" % (name, totals[name], totals[name] / max(len(rows), 1)))
