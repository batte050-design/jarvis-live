# Voice build status, 16 October 2026

Phases 0, 1 and 2 are built. Phase 3 is next. Phase 5 is downgraded on the evidence (below).

## Built and verified

**Phase 0. Baseline frozen.** `BASELINE.md` holds the measured distribution and the machine facts, plus
the non-regression rule for the text surface. Every figure came from this node on 16 October 2026.

**Phase 1. The wait made audible.** Two new cues rendered in the same cloned voice the live path uses
(`working`, `stillworking`, made by `_make_cues.py`, which reads the voice and speed out of `server.py` so
a cue cannot drift from the speaker). The engine arms a timer when a turn starts, cancels it the moment a
token or audio arrives, and never fires in text mode.

Verified on the live page: a turn forced into voice mode logged `cues=['working']` at 3 s, then real audio
began streaming (`sources:3, playing:true, scheduled:0.888`), and the second cue never fired because the
answer arrived first. The self-cancelling behaviour is the point: a fast turn is never stepped on.

**Phase 2. Words while he is still speaking.** The engine now asks the local transcriber about the audio so
far every 900 ms of continuous speech, bounded to the last 10 seconds, one pass in flight, only the newest
answer shown. The result appears in the box he types in, prefixed by whatever he had already typed.

Verified on the live page: `lastSeconds` keeps exactly the requested window, `showPartial` fills the box,
and it preserves text already there ("tell me" + "about the swap file"). The repeated pass itself needs a
microphone, so its end-to-end proof is one turn on the phone, not something this browser can show.

## Next

**Phase 3. Native capture.** Kotlin AudioRecord at 16 kHz mono with a one second pre-roll, so the first
syllable survives the WebView's echo canceller. Needs a rebuilt APK, which the GitHub action already
produces. This is the last piece that needs a release rather than a deploy.

**Phase 4. Barge-in by voice: withdrawn, and this plan was wrong about it.** Checking the engine rather
than the plan found the feature already tried and deliberately turned off. The comment in the code records
why: loudness cannot separate his voice from the agent's own voice coming back off the phone's speaker
(measured then at 743 to 2561 for his, 2336 to 5402 for the agent's), and automatic interruption broke the
conversation twice. Tapping the button stops the audio and always works.

So the plan's "speaking while the answer plays stops the sound" is not a build item, it is a rejected
design with evidence behind it, and the honest plan says so. Two things follow:

- A tap is the interrupt, deliberately. That is a decision, not a gap.
- The native ear makes speaker bleed worse, not better: raw capture turns the platform's echo canceller off,
  which is exactly what stops it from eating his first syllable. Barge-in by voice would need a capture path
  that cancels the agent's own voice without truncating his, and that is a research question, not a phase.

## Phase 5, downgraded on the evidence

The plan proposed a keep-warm pulse, on the theory that the slow turns are a cold backend. The data does
not support it. Turns started more than an hour after the previous one had a median first token of 1.1 s,
while turns started 30 seconds to 5 minutes after the last one had 23.7 s. If warmth were the cause, the
long gap would be the worst case; it is one of the best.

What the record actually tracks is whether the turn had work to do: quick turns 0.9 s, working turns
35.6 s. So a keep-warm heartbeat would spend tokens on a theory the numbers contradict. It is dropped
until a measurement shows otherwise, and the cue from Phase 1 is the honest answer to that wait.

## Not covered

The repeated-pass cost on a long monologue (bounded to 10 seconds, not measured under load), recognition
accuracy on the phone's own microphone, and anything about Luganda or Swahili.
