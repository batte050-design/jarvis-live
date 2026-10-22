# The voice build is parked

Parked on the operator's instruction, 16 October 2026. The page behaves as it did before the voice work
began; the work itself is kept whole.

## The switch

`VOICE_PARKED = true` in `index.html`, near the microphone state. While it is true:

- no microphone is ever opened, native or webview, on any path;
- no wait-line cue is ever armed;
- the live partial transcript never runs;
- the Talk and Live controls show "Voice is still in production - type your question for now."

To resume: set it to false, then `venv/bin/python build_v1.py && systemctl --user restart jarvis-live`.
The four gates are one switch plus three guards, and the guards are what make it safe rather than tidy:
`beginCapture()` refuses at the top, the cue timer is never armed, and a capture-phase click listener
takes the two voice buttons before any handler of theirs can run.

## What is behind the switch, and where

- **Wait-line cues (phase 1).** `_make_cues.py` renders `cues/working.mp3` and `cues/stillworking.mp3`
  by reading VOICE and SPEED out of `server.py`, so a cue cannot drift from the speaker. The engine arms
  them at turn start and cancels on the first token or the first audio.
- **Live partial transcript (phase 2).** Every 900 ms of continuous speech the engine re-asks `/stt`
  about the last ten seconds, one pass in flight. The result goes to the page's "what I heard" line and
  never to the composer: `#q` belongs to the page module, which reads its value to decide what to send.
- **Native ear (phase 3).** `NativeEarPlugin.java` in `/data/halvor/apps/jarvis-live-android`: raw
  AudioRecord, 16 kHz mono, rolling thirty-second window, a level event every 50 ms, and `stop({seconds})`
  returning only the tail asked for. Shell version 1.3, built and verified, installed or not.
- **Found and fixed while parking:** the page counted the native ear's level events as if each were 50 ms
  when they were 20, so it hung up after about half a second and a sentence reached the transcriber as a
  0.34 s clip. Silence is now measured against the clock, and only the utterance is uploaded.

## What is not parked

Typed turns, the spoken answers the page already gave, and everything in the settings, account and
pairing work. The voice work never touched any of it; the last verification of a typed turn was after
every voice patch, and it answered in two seconds.

## Recovering this state

Git: the voice code is in the commit that carries this note (4bab797), whole and unmodified, behind the
switch. That is the state to return to if the switch alone is not enough. Nothing about the voice work
was deleted, so resuming costs one flag, not a rebuild of the work.
