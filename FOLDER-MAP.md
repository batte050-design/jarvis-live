# What this folder is — plain-language map

**Folder:** `/data/apps/jarvis-live`
**Name:** JARVIS Live
**Written:** 13 October 2026

One sentence: this is the code for the private voice page at **live.battemohammad.com** — the one where you talk to JARVIS and it talks back.

---

## The 30-second version

Five things matter. Everything else is generated junk or history.

| # | What | Where |
|---|---|---|
| 1 | The whole server (all logic, all web routes) | `server.py` — 4,848 lines |
| 2 | The two web pages you actually see | `index.html` (the console at `/`) and `index_v1.html` (the voice page at `/v1`) |
| 3 | The page's styling and scripts | `static/` |
| 4 | Little HTML visuals the agent can push to a screen | `widgets/` |
| 5 | Test and probe scripts | `tools/` |

If you only ever open three files, open `server.py`, `index.html`, and `static/v1.js`.

---

## What lives where

### The code you'd edit

- **`server.py`** (4,848 lines, 232 KB) — the heart. A Python web server (FastAPI + uvicorn). It owns voice in, voice out, the chat stream, the settings, the widget store, and every URL the site answers on. If the site changes behaviour, the change is almost certainly here.
- **`index.html`** (1,447 lines) — the console page served at `/`.
- **`index_v1.html`** (1,704 lines) — the reimagined voice page served at `/v1`.
- **`build_v1.py`** (541 lines) — a builder that generates `index_v1.html`. Edit the builder, not the output, or your change gets overwritten next build.
- **`widgets.py`** (432 lines) — the widget policy: how a widget is stored, tokenised, and served on its own origin. Separate from `server.py` on purpose.
- **`static/`** — the page's assets:
  - `v1.css` / `v1.js` — the voice page's style and behaviour
  - `sw.js` — service worker (offline cache)
  - `manifest.webmanifest` + icons — makes it installable as a phone app

### Generated or stored data (don't hand-edit)

- **`widgets/`** — 54 widgets, each an `.html` plus a matching `.json`. 1.5 MB. Self-contained visuals the agent can push to a screen. Capped at 200 widgets / 40 MB by policy.
- **`artifacts.json`** — saved code/artifact snippets, with an id, language, and the question that produced them.
- **`sessions.json`** — the saved chat sessions and turns. **`session.json`** is the single most recent one. There are timestamped `.bak-` copies beside them.
- *(Superseded page versions were pruned on 15 Oct 2026 — the old `backups/` snapshots, `_snap/`, and the design mockups. They are archived, not gone, at `/data/backups/`.)*
- **`scratch/`** (2.6 MB) — screenshots and probe outputs from past work (`ws_*.png`, JSON dumps). Disposable.
- **`clips/`** (1.4 MB) — 25 recorded voice clips (`.wav` + `.json` pairs). Kept as the test set for speech-to-text quality comparisons.
- **`cues/`** — 6 short `.mp3` sounds the page plays (`agentempty`, `agentfailed`, `agenttimeout`, `lost`, `notcaught`, `phoneonly`).
- **`models/`** (895 MB) — downloaded Whisper speech-to-text models. Big, and re-downloadable, so never back it up.
- **`uploads/`** — where attachments land. Currently empty.
- **`tools/`** (97 MB, but mostly screenshots) — the probe, test, and gate scripts:
  - `turn_probe.py` — times one chat turn against the live page; also runs the routing test set
  - `reply_widget.py` — turns a rich reply into a widget
  - `widget.py` / `verify_widget.py` — push a widget, then verify it before showing
  - `stt_bakeoff.py` — times speech-to-text options on your 25 clips
  - `drain.sh` — finishes a turn in flight before a restart lands
  - `run_matrix.py` + `matrix.js` — the device-matrix test runner
  - `*-widget.html` — hostile and broken test widgets
- **`tests/`** — expected outputs: `baseline.json`, `routing.json`, `modes.json`, `after-*.json`, and the STT bake-off notes.

### Supporting material

- **`persona/system.txt`** — the persona prompt the page uses.
- **`vendor/`** — third-party libraries (`orbs.v15.js`, `beam.v15.js`) with their MIT licences. Credit them if you keep using them.
- **`audit/jarvis-live-audit-20260912-0955.md`** — one audit report from 12 Sept 2026.
- **`deploy/jarvis-live.service.d/drain.conf`** — the systemd drop-in that makes restarts wait for a turn to finish. Kept here so the setup is reproducible.
- **`venv/`** (504 MB, 8,664 files) — this project's own Python. Never edit by hand; it is the bulk of the file count.
- **`ORBS-INTEGRATION.md`** — the spec for wiring in the orbs/voice-beam visuals.
- **`REVIEW-CHANGES.md`** — the work log for the 30 Sept implementation orders: what changed, before/after numbers, file hashes, and what was deliberately skipped. Long but the honest record.
- **`__pycache__/`** — compiled Python. Ignore.

---

## How it runs

- Started by a **user service called `jarvis-live.service`** (not a system service). It runs:
  `/data/apps/jarvis-live/venv/bin/python /data/apps/jarvis-live/server.py`
- It listens on **port 8150**, on this machine only.
- **Cloudflare tunnel** (`cloudflared-jarvis.service`) publishes it as `live.battemohammad.com`, and the widget store as `widgets.battemohammad.com`. Nothing is exposed directly to the internet.
- It restarts itself automatically if it dies (`Restart=always`), and a stop waits for any answer in progress before it lands.
- Current process: PID 290650, running since 10 Oct.

Useful commands:
- Status: `systemctl --user status jarvis-live`
- Restart: `systemctl --user restart jarvis-live`
- Logs: `journalctl --user -u jarvis-live -f`

---

## Safe to touch vs leave alone

- **Edit freely:** `server.py`, `index.html`, `static/*.css`, `static/*.js`, `widgets.py`, docs.
- **Edit via the builder:** `index_v1.html` — change `build_v1.py` and rebuild instead.
- **Don't hand-edit:** `widgets/`, `scratch/`, `clips/`, `models/`, `venv/`, `*.json` session/artifact files.
- **Never back up:** `venv/`, `models/` — hundreds of megabytes, all rebuildable.
- **Real content worth keeping:** `server.py`, `index*.html`, `static/`, `widgets.py`, `build_v1.py`, `tools/`, `deploy/`, the two markdown docs, `persona/`.

---

## Git state (checked 13 Oct 2026)

- Branch: **master**. No remote configured — this is a local repo, history lives here only.
- **58 tracked files.** Working tree is deliberately dirty: **7 modified, 104 untracked** — mostly the widget store and session files, which are meant to be untracked.
- Many feature branches exist (`jarvis-live-nav-refactor`, `jarvis-live-one-rendering`, and others) from past work rounds.
- Rollback method: `git revert` in this folder. The noted baseline commit is `b56e296`.

---

## The one thing to remember

`server.py` is the site. `index.html` and `static/v1.js` are what you see. `widgets/` and `backups/` are the two big generated stores. Everything else is either the Python runtime, models, or history.
