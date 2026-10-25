# Voice baseline, frozen 16 October 2026

The benchmark everything in the voice plan is measured against. Read from this node, not estimated.

## Machine

| | |
|---|---|
| CPU | 4 vCPU |
| RAM | 24 GB total, no swap configured |
| GPU | none |
| Free space | 79 GB on /data |

## Turn timings (478 finished turns, 10 days to 16 Oct 2026)

Source: the service journal of `jarvis-live`, lines of the form
`turn N: tok=Xs audio=- work=Ys done=Zs handoff=yes end=completed chars=N`.

| Measure | Result |
|---|---|
| Time to first token, all turns | median 7.3 s, p25 0.9 s, p90 81.3 s, best 0.4 s, worst 306.3 s |
| Time to completion | median 27.5 s, p90 85.5 s |
| Under 10 s | 244 of 478 |
| Over 60 s | 79 of 478 |
| Quick turns (finished under 20 s) | first token median 0.9 s |
| Turns with real work (20 s or more) | first token median 35.6 s |
| Started under 30 s after the previous turn | median 0.9 s, 88 per cent under 10 s |
| Started 30 s to 5 min after the previous turn | median 23.7 s, 42 per cent under 10 s |
| First turn after a fresh process | median 7.6 s |
| Later turns in the same process | median 6.9 s |

The cold-process figure is included because it rules out process start as the cause of the slow turns.

## Speech components present before any of this work

| Component | Where |
|---|---|
| Mic capture worklet with a one second pre-roll ring | `index.html`, `earCapture` |
| Silence endpointing (600 ms speculative, 1300 ms endpoint) | `index.html`, `voiceTick` |
| Speculative early transcription pass | `index.html`, `uploadAudio(snap, true)` |
| Local transcription endpoint | `server.py`, `POST /stt` |
| Streaming per-unit speech playback | `index.html`, `unitStreams` |
| Short spoken cue library | `/data/apps/jarvis-live/cues/*.mp3`, served by `GET /cue/{name}` |
| Interrupt, output gain, state machine | `index.html` |
| Spoken words split from visual artifacts | `window.__jarvisOrdered` hook, guarded in `build_v1.py` |

## The non-regression rule

Before any voice change ships, the text surface must still pass:

1. A text turn through `POST /stream` returns events and completes.
2. A markdown table still renders as a table, with no glued lines.
3. The work trace drawer still fills.
4. `window.__jarvisOrdered` is still present in exactly one place, so the build is not refused.

This is the guard, not a formality: the voice work touches the same audio graph and the same stream
that the text surface depends on.
