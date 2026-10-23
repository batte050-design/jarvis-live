# Review changes — JARVIS Live

Work log for the implementation orders of 30 September 2026. One entry per item: what changed, the
numbers before and after, the md5 of both files, and anything deliberately not done.

**Ground rules being followed.** Snapshot first, one item at a time, restart + verify + log +
commit, the unit's own venv (`/data/apps/jarvis-live/venv`), tests against the public URL with the
cookie, no secrets in logs or here, nothing audible claimed from a headless browser, no identifier
renames by regex, and no `pgrep -f` pattern that matches the checking shell.

Rollback is `git revert` in this directory. Baseline commit: `b56e296`.

| file | at baseline (b56e296) | after item 1 |
|---|---|---|
| `server.py` | `d3b2c28af6631dc103682f0799c443e7` | `cfd60f915369b92d548b5798763eee88` |
| `index.html` | `4f77482ca20322449b5accc42286d3af` | `438291878cb349ca11fb8f271e63f705` |


---

## Item 0 — Baseline

**Built.**
- `tools/turn_probe.py` — one turn against the public URL, timed, plus `--routing` which runs the
  whole set and writes a results file. Reflects the current transport (POST since item 1; `--get`
  compares the old one).
- `tests/routing.json` — 22 typed questions covering the classes named in the orders: chit-chat,
  stable fact, changes-with-time, his own files, web, ambiguous, detail, a URL in the answer, a path
  in the answer, one-or-two-word answers, mostly numbers, an answer starting with a quote, one
  starting with a bracket. Each carries the route we expect.
- `tests/baseline.json` — the before-numbers everything later is compared against.
- **Per-turn line in the journal**, from `run()`:
  `turn 1: tok=0.8s audio=1.5s work=- done=1.8s handoff=no end=completed chars=13`
  Timestamps are taken where each event leaves the turn, not where it is made.
- **Client timeline** in `index.html`, printed to the console and also POSTed to `/timeline` so the
  phone-side figure lands in the journal. Reading a phone console by hand is not a measurement, and
  the endpoint-to-first-sound number only exists on the device.
  Example from the journal, a typed turn:
  `phone: endpoint decided+8614ms | ask called+8614ms | first token+9140ms | first sound+9906ms  endpoint->firstSound=1292ms`

**Baseline numbers (22 questions, 30 Sep 06:26, transport GET)**

| | |
|---|---|
| Misrouted of those we could judge | 0 of 16 |
| Machinery leaks (any of `[[`, `]]`, `DSML`, `<|`, ` ``` ` in spoken text) | 0 |
| Errors | 0 |
| Median first token | 0.80 s |
| Median first sound | 1.36 s |

Per-class routes, as measured: chit-chat/stable-fact/one-or-two-word/mostly-numbers/quote/bracket all
answered directly; changes-with-time, his own files, web and path-in-answer all delegated. The two
"detail" questions answered directly (32 and 6 units).

**Outstanding from item 0:** the orders want endpoint-to-first-sound logged for **five real spoken
turns**. The sink is in place; those five need him speaking to the page on the phone. Typed turns
measure 1.1–1.7 s, which is a proxy, not the thing.

**Not done, deliberately:** nothing.

---

## Item 1 — A cross-site link can run the agent

**Confirmed first, and it was real.** A request carrying his cookie with
`Sec-Fetch-Site: cross-site`, `Origin: https://evil.example` was **accepted** (HTTP 200) and ran a
whole turn — observed events `open`, `tok`, `audio`, `done` in 2.03 s. A page or link he opens
elsewhere could make this page run the agent, and every prompt was landing in URLs and proxy logs.

**Changed.**
1. `same_origin(request)` added and applied to `/stream`, `/stt`, `/reset` (and used by the new
   `/timeline`). Browsers send `Sec-Fetch-Site`; a browser old enough not to must show an `Origin`
   or `Referer` matching the Host or the configured public host. A request with neither is refused,
   because a browser would have sent one.
2. `/stream` is a **POST** with `{"q": "..."}`. Empty is rejected (400), over 2000 characters is
   rejected (413), a malformed body is rejected (400).
3. The client reads the stream by hand: `EventSource` is GET-only, so `openStream(q, onEvent,
   signal)` in `ask()` uses `fetch` + `AbortController` and keeps the same `.close()` interface
   `interrupt()` already used. Framing is unchanged (`event:`/`data:` lines, blank line between
   events, `: ping` comments carry no data and are skipped).
4. The cookie stays `SameSite=Lax`. `Strict` would risk the `?k=` keyed link opened from another app
   showing him the pairing gate, and POST + the origin guard already closes the hole.

**Verified.**
- Cross-site POST → **403** on `/stream`, `/stt`, `/reset` (was 200 and a whole turn).
- Same-origin POST → 200. `GET /stream` → 405, as expected after the transport change.
- The keyed link `/?k=<token>` still returns 302 with the cookie set (`HttpOnly; Secure;
  SameSite=lax`).
- One typed turn end to end over POST: first token 0.71 s, first sound 1.17 s, 41 parts, no errors,
  no machinery.
- Six turns over POST: median first token **0.71 s** (baseline 0.80 s), median first sound
  **1.42 s** (baseline 1.36 s). No regression through the proxy on a POST response — the thing the
  orders asked to re-measure.
- Real browser: turns complete, three in a row including one interrupted mid-answer, no console
  errors, and the next turn after an interrupt completes normally.
- Hanging up mid-answer still stops the work: **1.0 s**, journal shows `client left mid-turn:
  stopping the work`, `stopped the agent: the operator is no longer listening`, `turn 13 ended
  without completing: not recorded`, and nothing was committed.

**Not done, deliberately:** did not switch the cookie to `Strict` (reason above); did not add the
`/cancel` endpoint, which belongs to item 4.

---

## Item 2 — Agent answers deleted, mangled, or replaced by an error that gets remembered

**Confirmed first.** Running the old filters over a table of realistic agent output lost **6 of 15
lines**, of which three were real losses and three were correct drops:

| case | old result | should be |
|---|---|---|
| a line containing a URL | **LOST** (the whole line) | kept, URL reduced to its host |
| a one-word answer (`Yes.`) | **LOST** | kept |
| a two-word answer (`Yes, sir.`) | **LOST** | kept |
| a file path in a line | kept, path spoken aloud | kept, path not spoken |
| `session_id`, `Normalized model …`, a bare JSON blob, DSML markup | lost | lost (correct) |

And `hermes_answer` returned the **prose** `"I could not reach the agent just now, sir."` when the
agent binary was unreachable — an error returned as if it were the answer, so it was spoken and then
remembered as JARVIS's own words; with the fast layer's opener already in the accumulator, a failed
handoff also left that opener committed as the turn's answer.

**Changed.**
1. The agent is told to put its spoken reply between `<<<SPOKEN` and `SPOKEN>>>`, and that block is
   what gets used. The marker must start its own line, so an agent that echoes the instruction in
   prose cannot have the words between the markers spoken. Every miss is **counted and logged**
   (`agent did not use the sentinels (N times so far)`) rather than guessed at.
2. The fallback now **repairs instead of deleting**: a URL becomes its host, a file path becomes
   "that file", markdown and emoji go, and the line is kept. Only unmistakable runtime notices (the
   NOISE_WORDS phrases, `session_id`) and a line that is nothing but a JSON blob or markup are
   dropped. The notice test runs on the **raw** line, because repairing strips underscores and had
   turned `session_id` into `sessionid`, letting it through.
3. `hermes_answer` returns `(status, text)` with status in `ok, empty, stopped, timeout, failed`.
   No prose is ever returned for an error. The child's stderr is kept to the last 2 KB in the
   journal and never spoken.
4. A non-ok handoff speaks a **recorded cue in his voice** (`cues/agentfailed.mp3`,
   `agenttimeout.mp3`, `agentempty.mp3`, served by the existing `/cue/<name>` and requested by a new
   `cue` event), sends the error event, and **commits nothing**.
5. Memory holds **one assistant message per turn**: the opener and the agent's answer together for a
   handoff, and nothing at all when the handoff failed.

**Verified.**
- Extraction table after the change: URL line kept as `See bankofuganda.go.ug for the latest figure.`,
  `Yes.` and `Yes, sir.` kept, a path repaired to `… is at that file and totals 4,120,000.`, and
  `session_id`, the JSON blob, the runtime notice and the markup all still dropped.
- A real delegated turn: committed as **one assistant message of 186 characters** — opener plus
  answer, no markers, no sentinels, no angle brackets. (197 characters before the marker fix below.)
- **Forced failure** on a throwaway instance with an unreachable agent binary:
  `work:start → cue agentfailed → err agent_failed → work:done → done`, and `session.json` was
  **byte-identical before and after** — nothing remembered.

**Defects my own change introduced, caught by these checks** (each fixed before commit):
- The two new state names were initialised outside `run()`, so `handoff_status` was unbound inside
  it: the turn died in its own cleanup and never sent `done`, and the client hung. Caught by the
  probe timing out and the traceback in the journal.
- The status was recorded only on failure, so a **successful** handoff stored nothing.
- The opener was being remembered with a half-written `[[WORK` in it: the marker arrives split
  across deltas and the hold-back buffer leaves a partial behind. Pre-existing, invisible until the
  opener started being remembered; now stripped with the existing `drop_partial_marker`.

**Deviations, stated plainly.** A removed file path becomes "that file" rather than nothing, because
a bare deletion left "Your ledger is at and totals 4,120,000" — spoken aloud, that reads as a
stutter. And `HERMES_BIN` is now overridable through `JARVIS_HERMES_BIN` so the failure paths can be
driven deliberately, which is what made the forced-failure test above possible without touching the
live service.

---

## Item 3 — A full pipe can freeze the agent until the deadline

**Confirmed first.** A stand-in that writes 200 KB to stdout was never reaped by the `poll()` loop —
the loop hit its own 20-second bound with the child still alive, because the child was blocked
writing into a pipe nobody was draining. `communicate()` drained the same child at once (200,000
bytes). With the real deadline that meant a turn freezing for about **4.6 minutes** and then
reporting a timeout, and `waited < 260` in the outer loop could also give up 20 seconds *before* the
child's own 280-second limit, reporting "no answer" while the agent was still working.

**Changed.** One `AGENT_TIMEOUT = 280.0` for the whole agent run; `communicate(timeout=0.25)` in
slices instead of `poll()` (a `TimeoutExpired` is caught and retried, so nothing is lost); the outer
wait now watches only the worker and the stop flag. The last 2 KB of stderr is kept for the journal
and never spoken (landed with item 2).

**Verified.** The same stand-in, driven through the real page path on a throwaway instance, finished
in **3.4 seconds** and the turn completed normally with 2 spoken units — against the ~280 seconds the
poll loop would have waited.

---

## Item 4 — Turn lifecycle: the id, the races, and stopping work he cancelled

**4a — the id.** It is now minted in the request handler **before** the worker starts, and the live
turn is registered so `/cancel` can reach it; the worker reads it instead of minting its own. This
closes the window where a disconnect in the first milliseconds left the worker holding a *current*
id. The commit is guarded on `completed and not stop()` as well as on the id, so abandonment is
handled explicitly rather than by the id alone.

**4b — stopping cancelled work.**
- The fast-layer loop checks the stop flag on **every delta** and closes the generator explicitly, so
  the upstream response is torn down instead of streaming tokens nobody will hear.
- `Speaker.abort()` sets a cancel event checked between audio chunks, clears anything pending and
  wakes the emitter; the turn's `finally` now **aborts** on abandonment and closes normally
  otherwise. Previously a hung-up turn waited on work already gone.
- New `POST /cancel` (authenticated, same-origin) stops the turn in flight immediately — by turn id,
  or the newest live turn — and bumps the turn so nothing in flight can be committed. The client
  posts it from `interrupt()` (a tap on the orb) and from the reset button. The disconnect is now
  only a backstop.

**Verified.**
- `/cancel` while the agent was working: the agent process was gone **0.26 seconds** after the tap,
  and `session.json` was unchanged. The disconnect backstop alone takes about a second.
- **Twenty rapid connect-and-hang-up cycles**: history stayed at **12 messages** (zero commits) and
  **zero** agent processes were left behind.
- In a real browser: the tap logged `cancel requested: stopping turn 44`, the agent stopped, and the
  **following turn completed normally** (2.77 s of speech, no console errors). The state log ran
  `speaking → interrupted → idle → thinking → speaking → idle`.

---

## Routing, measured twice — and why it is unstable

Item 2 does not touch routing, and the fast layer's prompt is **byte-identical** to the baseline
commit (checked, not assumed). The routing set run after item 2 came out **3 misrouted of 16** where
the baseline had **0**:

- `What is today's date and what time is it?` → answered directly (should hand off)
- `What do my notes say about inspection pricing?` → answered directly
- `What is the latest Uganda news?` → answered directly

Repeating those same three questions four times, same prompt, same history, flipped the decision:

    What is today's date and what time is it?      work work work work
    What do my notes say about inspection pricing? work work answer work
    What is the latest Uganda news?                work work work work

So the difference is sampling variance in the routing decision, not a regression — and the
underlying instability is real: one class answered directly **1 run in 4**. A routing decision that
flips run to run on the same input is an argument for item 9's tool calling in its own right, and a
reason to treat any single routing run as a sample, not a verdict.

---

## Item 6 — Speech recognition: measure the real cost, guard the failures

**Confirmed first.** Three of the four claims were checked against the machine.

*(a) A fixed cost dominates — CONFIRMED.* One pass at full depth, voice-activity filtering off so
nothing is discarded, on his own joined speech:

| audio length | 1s | 2s | 4s | 8s | 16s |
|---|---|---|---|---|---|
| time | 1.13s | 1.16s | 1.13s | 1.25s | 1.89s |

Flat from one to eight seconds, then rising. The **first attempt at this measurement was invalid** —
all three "windows" were cut from a 0.28-second clip, so they were the same audio and proved
nothing. It was redone on joined speech and on real durations. Shortening what he says buys almost
nothing; only past about eight seconds does length matter.

*(b) The recovery pass may not be able to run — DISPROVEN today, guarded anyway.* Both `base` and
`small` are on disk, so no download can happen inside a request and the 500 cannot occur as
configured. It is a real hazard the moment the fallback name changes, so the guard went in and was
verified by forcing it.

*(c) `clean_and_boost` is slow for its job — part true.* Pure Python, 0.0755s on a 5-second clip and
**0.3823s on a 25-second one**. Not the dominant cost, but a third of a second of pure Python inside
a request, against a fixed 1.1s transcription, is worth having.

**Changed.**
1. `read_wav_samples` and `clean_and_boost` rewritten in numpy: `frombuffer` into int32 (so
   `abs(-32768)` cannot wrap), vectorised windowed peaks with the same windows including the same
   short final one, the same 6 % gate, the same gain cap of 40, and `tobytes` at the end.
2. The recovery pass is wrapped in try/except and runs **only if the fallback model is on disk**
   (`model_present`); otherwise it logs that it was skipped. The old rule is unchanged: recovery
   only after an empty result on more than two seconds of speech.
3. A stale upload now waits up to three seconds for a slot (`asyncio.to_thread(sem.acquire, True,
   3.0)`) instead of failing the next utterance outright; if it still cannot get one, the 429 stands.
4. The prime is a **vocabulary list, not a sample sentence**, and it lives in an editable
   `stt_vocab.txt` (reloaded when the file changes, so a name can be added without a restart). A
   transcript whose every word is in that vocabulary, on a clip under 1.2 seconds of speech, is
   discarded as the prime read back.

**Verified.**
- **Behaviour-neutral: byte-identical output on 25 of 25 clips**, same trims and same samples, and
  identical speech-length values. Cost fell from 0.0755s to **0.0032s** on a 5-second clip (24x) and
  from 0.3823s to **0.0075s** on a 25-second one (51x).
- **Three overlapping uploads all returned 200**, with the third waiting for a slot (the old code
  gave it an immediate 429).
- **No 500 with the recovery model absent**: a throwaway instance with a nonexistent fallback
  returned HTTP 200 and an empty transcript, having logged
  `recovery pass skipped: the not-a-real-model model is not on disk`.
- The prime guard: correct on all six cases tried, including `JARVIS` at 0.6s discarded and
  `JARVIS` at 2.0s kept, and `Read me the news` at 1.0s kept.

**Tradeoff, stated plainly.** The guard will discard a lone proper noun spoken in under 1.2 seconds,
for example just "InspectFirst" on its own. That is the price of catching the prime being handed
back, and the vocabulary is deliberately names and phrases only, so ordinary words are never
members.

**ASK (item 6) — the bake-off, run.** Four candidates on his own kept clips; the full run is in
`tests/stt-bakeoff.md` and the short version he reads in `tests/stt-bakeoff-summary.md`.

| model | mean per clip | lone dissenter, words only |
|---|---|---|
| tiny.en | 0.58s | 2, and it invents words |
| base.en | 0.96s | 0 |
| base (in use) | 1.02s | 1 |
| small (recovery) | 2.72s | 1 |

**No change**, because no candidate wins on both counts, which is the test that was set: tiny.en is
fast and worse, base.en is inside the noise on time and loses clips base wins, small is 2.7x slower
without winning more. The decision on base.en against base is his to make on the wording. A hosted
transcriber is not provisioned, not tested, and not proposed: it would send his voice to a third
party.

The guard proved itself on real audio during this run: `small` handed back "JARVIS" on a 0.6-second
clip and `base.en` returned "Ntinda" on a 0.3-second one, both the primer read back, both now
discarded and logged.

---

## Item 7 — New connection on every model and speech call: STOPPED BY ITS OWN GATE

**Confirmed first, and the item stops here.** Five calls to each API host from this machine:

| host | DNS | connect | TLS by | first byte |
|---|---|---|---|---|
| api.deepseek.com | 1.1ms | 1.8-2.1ms | 44.7-46.7ms | 45-47ms |
| api.fish.audio | 0.7ms | 1.6-2.0ms | 48.7-53.8ms | 49-54ms |

Connect plus TLS is **about 45 to 50 milliseconds**, well under the 150ms the orders set as the
threshold, so **no connection pooling was built**: `httpx`, `iter_raw`, warm connections and the
retry fallback are all unwarranted at these numbers. Nothing was installed and nothing changed.

The residual it leaves: every speech unit pays that handshake, and the speaker synthesises three
units ahead, so roughly 50ms of each unit's synthesis is handshake. If the pool depth or the units
per answer grow, this verdict should be re-measured rather than assumed.

**Investigated as instructed: the provider does offer persistent streaming.** From Fish Audio's own
documentation, the WebSocket TTS endpoint (`wss://api.fish.audio/v1/tts/live`):

- **It accepts `s2.1-pro-free` explicitly** — the model header is an enum of `s1, s2-pro, s2.1-pro,
  s2.1-pro-free`, and an unrecognised value falls back to the paid `s2.1-pro`.
- MessagePack serialisation, bidirectional: a Start event (with the same parameters as the HTTP API
  and `request.text` empty), then Text events that are **designed for text arriving incrementally,
  such as model tokens**, a Flush event that forces immediate synthesis of whatever is buffered, and
  an End event. Audio arrives as repeated Audio events to concatenate.
- The provider's own framing is that WebSocket is for *text that arrives incrementally*, and that
  Flush is for low latency in interactive applications.

That is a real opportunity for the fast layer, because speech could begin on tokens as they arrive
instead of waiting for a sentence boundary and a fresh request per unit. It is **not** built, and it
should not be on this evidence alone: it replaces the pool, the ordering guarantee and the
part-based protocol the player depends on, so it belongs to the Phase 5 class of work with its own
before-and-after numbers.

---

## Item 5 — Recognition starts before he stops speaking

**What it does.** Once he has been quiet for 600ms inside a recording, the audio so far goes up
speculatively. The endpoint at 1300ms is unchanged (shortening it still cuts him off mid-phrase), so
the transcriber now has a head start of about **0.72s** and the endpoint reuses the transcript
already in flight instead of uploading the same audio again. A loud block before the endpoint means
he was only pausing: the snapshot is aborted, its rejection swallowed, and a fresh snapshot starts.

**Verified on the real path**, feeding his own recorded speech through the page's own capture seam in
real time (one 50ms block per block — the first attempt fed everything in a single tick, which the
wall-clock logic cannot see, and proved nothing):

- *No pause:* one utterance, then quiet. Timeline: `speculative upload` at +8.87s, `endpoint decided`
  at +9.59s, `reusing the transcript already in flight`. **The server saw exactly one upload**, marked
  `+spec`, and the transcript was correct. Before this item the endpoint would have uploaded it again.
- *A deliberate 800ms pause inside one sentence:* `speculative upload` at +19.87s,
  **`speculation dropped`** at +20.29s when he resumed, a second `speculative upload` at +22.65s, then
  `endpoint decided` and reuse. The transcript was **one complete sentence across the pause**:
  *"I told you latest news. That story is two days back."* — both halves, one transcript, which is the
  test this item was given.

**One number in that test is not representative, and it matters.** The transcription inside the
browser harness took 4.24s. Measured directly on this machine, the same work is **1.20s idle, 2.79s
with all four cores busy**: whisper asks for `cpu_count` threads, and the harness runs headless Chrome
with software rendering on the same four cores. On his phone the rendering happens on the phone, so
the real figure is the idle one. It is recorded here rather than quietly dropped, because a 4s
recognition would have made this item a regression.


---

## Item 12 — The window ages, and stops poisoning itself

**Confirmed first.** Messages carried no timestamp at all, and the window was restored at boot and
never aged: a bad exchange survived every restart and `/reset` was the only cure.

**Changed.** Every stored message carries `at`; the outgoing list is built with **only `role` and
`content`**, so a provider that rejects unknown keys cannot fail a turn. A named constant,
`IDLE_RESET_SECONDS = 30 * 60`, starts a fresh conversation when the window has gone cold, applied
**both at boot and at the start of every turn** under the existing lock. The 12-message window is
unchanged, as are `_sanitise` and the no-markup guard.

**The ASK, decided (he asked me to choose): 30 minutes.** Long enough that a normal back-and-forth
keeps its thread, short enough that yesterday's question does not colour today's. One line to change
if he wants an hour.

**Verified.** A conversation file backdated two hours was **not restored**: the journal logged
`conversation window: idle for 120 minutes, starting fresh` and the window came up empty. A follow-up
inside the threshold kept its thread (two turns, four messages). The stored entries carry `at`, and
the list actually sent is `role` and `content` only — checked directly, not assumed.

---

## Item 13 — Authentication

**What was already sound and is untouched:** HttpOnly + Secure + Lax cookies, the loopback-only mint,
codes burned on first use, and the master-token fallback so a lost file cannot lock him out.

**Closed.** The pairing code now comes from `secrets.randbelow(10**6)` (it was `random.randint`, a
predictable generator, guarding access). A **global** failure counter joins the per-address one:
ten failures from any addresses burn the outstanding code, because rotating addresses defeats a
per-address limit. Token comparisons use `hmac.compare_digest`. A keyed sign-in now issues a **fresh
random session** (recorded with a label, scope and creation time) instead of handing back the master
token, so a leaked cookie or a logged URL can be withdrawn by deleting one line; the device file is
parsed leniently, and entries written before scopes existed count as full access, so nothing that
worked stopped working. The master token is still accepted during the transition. `/stream` and
`/stt` carry a per-device ceiling of 60 requests per five minutes: generous on purpose, a cost guard
rather than a nuisance.

**The ASK, decided (he asked me to choose): a paired screen is voice-only.** It answers and speaks,
and it cannot hand work to the agent. Implemented as a `scope` on the device entry, not a special
case for one screen, so any future device gets the same treatment by default.

**Verified, on the wire.** The phone's master-token cookie still works (200). A keyed sign-in returns
**302 with a session that is not the master token**, the session appears in the device file, and it
works; **deleting that one line revoked it** (401) while the master token kept working. Six wrong
codes from one address produced the per-address lockout; failures spread across addresses burned the
outstanding code. The rate guard allowed the first 60 calls and refused the 61st. A paired screen
(`scope=voice`, recorded as such) asked something needing the agent: the journal shows
`this screen is voice-only, not handing over`, no agent was spawned, and the same screen still
answered a simple question itself.

**Reported as the orders require, and stated honestly:** the master token is still accepted, and I
cannot enumerate his cookies. Any device that has not signed in with the key since this change still
holds the master token. The device file currently lists one session created before this change; it
counts as full access. One consequence worth knowing: **each keyed sign-in adds one session line**,
which is what makes them individually revocable, so the file grows slowly over time.

---

## A mistake I made, and what it cost

While splitting items 12 and 13 into their own commits I ran a copy from an old working file left
over from the items 3/4 split, and it **overwrote server.py with a stale version**: 147 lines were
lost, including `import numpy`, `import datetime`, `import zoneinfo`, `now_line()` and the clock rule
(items 6 and 8), and the whole numpy preprocessing rewrite.

**What caught it:** grepping the live file for the imports I had already verified in it, as part of
tidying the git history. **What it did not affect:** the running service, which still held the good
code in memory, so no turn he made was wrong. **What it would have done on the next restart:**
recognition would have silently returned "no speech" for every utterance, because the exception
raised by the missing `numpy` is swallowed by the same handler that reports silence.

**Repair:** rebuilt from the last complete snapshot (`backups/server.py.20260930-pre-item12`), item 12
and item 13 re-applied through the same patch, then verified before restarting: recognition on a real
clip (*"That story is today's back."*, 1.7s of speech), a clock turn, a delegated turn, the master
cookie and a keyed sign-in. Then the two commits were rebuilt from the corrected file so each one
contains what its message says — checked with greps on the committed content, not assumed.

**The rule this earns:** never copy a file from `/tmp` over a live source without checking its
timestamp and contents first, and after any file surgery, grep the live file for the functions
already verified in it before restarting anything.


---

## The cut he heard: the next sentence taking the playhead mid-sentence

**Reported by Mohammad:** "the audio comes before what was being read finished ... hello sir,
today's ne..., then the new audio starts." Only the opening was affected; the rest was fine.

**Root cause, measured.** Every decoded chunk is scheduled hard against one shared playhead (`at`).
Each unit decodes concurrently, so a small early chunk of a LATER sentence could grab the playhead
while an earlier sentence was still being decoded and scheduled. The player's own log, from a real
three-sentence answer:

    idx  ctx     from    dur     start   end
    5    3.39   2.952   3.814   5.232   6.094     unit 1 continues
    6   3.442       0   2.926   6.094    9.02     unit 2 starts
    7     3.5       0   0.209    9.02   9.229     unit 3's OPENING, wedged in here
    8   3.521   2.926   4.101   9.229  10.405     unit 2 continues
    9   3.521   0.209   4.049  10.405  14.245     unit 3 minus its opening

Unit 3's first 209ms was scheduled between unit 2's chunks, and unit 3 then resumed after it. To the
ear that is the current sentence being cut off by the next one, which is exactly what he described.

**Fixed, in two steps, both measured.**
1. A unit may only take the playhead once every earlier unit has arrived in full. The first attempt
   gated on parts having arrived — and the interleaving was **still there**, because a unit's parts
   can all be in while its last chunks are still decoding. The measurement caught that, not the code
   review.
2. The gate now waits for the decode chain itself (`done`, set after the final decode), and held
   chunks are released in order when each earlier unit completes.

**After, same three-sentence answer:** chunks grouped strictly by unit, `unit order [1,1,1,1,2,2,2,2,2,3]`,
**gaps and overlaps all zero**, and every unit playing its full length — total played 12.643s against
12.643s scheduled. Before the fix, one unit's opening was displaced into another.

**Stated limit:** the fix is verified on a three-unit answer (before and after) and on a single-unit
answer. A long delegated answer was attempted, but that run produced only one unit, so the many-unit
case rests on the three-unit measurement. He should confirm on the phone.

The player also keeps a small diagnostic ring (`window.__jarvisSched`), which is what produced the
table above.

---

## The commit shape, stated plainly

Phase 0's instrumentation and item 1's fix both live in `server.py` and `index.html`, and the
baseline had to be taken before the transport changed. They are therefore two commits that overlap
by file: `0. baseline …` carries the new `tools/`, `tests/` and this log; `1. same-origin guard …`
carries the code changes in both files, including the item 0 instrumentation that had to share the
same edit. Splitting a single function's hunks across two commits would have produced a first commit
that does not run.

---

## Voice and text modes — he speaks or he types, never both (8 October 2026)

**He asked for it in his own words:** "this page should only speak back when i press the live
button, but on texting, you should reply with the text", and the two must not hit each other.

**How the apps that do this well split it** (checked 8 Oct 2026): ChatGPT has two affordances — a
mic that dictates into the box and voice that converses; Claude states that dictation means "Claude
replies in text the way it always does" while voice mode is the spoken conversation, switchable
mid-thread; Gemini Live returns a parallel transcript of what it says; Siri has Type to Siri. All
four: two verbs, an explicit mode, silent text replies, spoken answers also written.

**The contract.** `POST /stream {"q": ..., "mode": "voice"|"text"}`. Missing means voice, so an
older client and a widget's own follow-up question behave exactly as before. The mode is fixed at the
start of a turn: a switch during a turn cuts that turn, the way a tap on the live button always has.

**Files, before -> after (md5)**

| file | before | after |
|---|---|---|
| `server.py` | `4c1ef4d07417a589474f5bb858620e3a` | `5358521e87fe788c0cfe96e244b93247` |
| `index.html` (the engine of record) | `94b0fa1f9bf4762c5f9a983969943627` | `efe4410936aadda10ca0c27d418f802b` |
| `index_v1.html` (built) | `63decf40ff5bc42f54ff968bf1c6a1c9` | `7233483839c7876c68b26e9e9a19e20e` |
| `static/v1.js` | `d0e5945917157220ace4060e00f9df2d` | `d2393b1ba57a48a13687dd9c5e56655a` |
| `static/v1.css` | (previous build) | `8790637ae27fc847afedd678975f8dc0` |
| `build_v1.py` | (previous) | `48b0178d67bd294563e9d2d0492d3595` |
| `tools/turn_probe.py` | (previous) | `ae6d3896108ee631b04d50537ae9cd62` |

Snapshot: `backups/modes-20261008-205032/`.

**Server**

1. `mode` parsed and validated; anything else is a 400 before a turn starts.
2. `QuietSpeaker` is the speaker in text mode: `submit` does nothing, so no speech unit is ever
   submitted, no synthesis call is made, no `audio` event exists and nothing is paid for. Because it
   is a speaker rather than a flag at each call site, a caller added later cannot miss the rule.
3. The settled answer is sent once as a `text` event immediately before `done`, so a dropped token
   delta cannot leave a truncated answer on the screen.
4. The prompt follows the mode. `EYE_SWAP` swaps the two "read aloud / write for the ear" passages
   for a written register and **raises** if a later wording change stops the swap matching — the
   silent version of that failure is a text reply written for the ear with nothing in the log.
   `hermes_answer` gets the same split: written answers may use a short list or a line of figures.
5. `WORKISH` now also hands over recommendation-shaped requests (recommend, options, compare,
   shortlist, suggest, which should) instead of letting the fast layer answer them in prose.
6. `hermes_answer` names the reply renderer: cards with an optional image, a badge and links, then
   up to two groups of choices, built with `tools/reply_widget.py` and pushed with
   `screen_show(kind="widget", ...)` **only after its gate passes**, with one short sentence said
   about it.
7. `screen_show`'s own schema now says what a widget is for (several cards, a comparison, choices
   whose tap asks JARVIS), because the tool description is what makes the agent reach for it at all.

**Page**

- `modeArm()` is the single owner: the live button arms voice, the typing box and Send arm text, and
  a pill in the header (`#modeBtn`, 44px) shows which is armed and switches it by hand. The header,
  not the dock, because the dock is hidden while he is typing.
- In text mode the microphone is shut (`earArmed` false, `earTurnOpen` released, any recording
  ended) and `onBlock()` refuses to start one whatever the flags say.
- The `audio` branch returns immediately in text mode: a stale server's audio is dropped rather than
  played over what he is reading.
- Tokens go up as they arrive rather than paced off a sound that does not exist (`__jarvisReply`
  from the token branch, `__jarvisSetReply` for the settled text), and `paintCaption` drops the
  "already said" stepping in text mode, because in text mode every word is the answer.
- A switch mid-turn interrupts that turn (measured below): nothing is half-spoken, half-read, and
  whatever had already been said is left readable on the screen. The abandoned turn is not recorded.

**Measured, not inferred**

- Mode suite (`tests/modes.json`, 4 turns): text-fast `answer` with **0 audio events**; text-work
  `work` in 42.5s with **0 audio events**; voice-fast `answer` first sound **1.39s** (baseline
  1.36-1.42s); voice-work `work` 256 audio events. No misroutes, no machinery, no errors.
- The server's own line per turn: text turns print `audio=-`, voice turns `audio=1.3s`/`3.8s`.
- A typed turn through the browser: `scheduled 0, scheduled parts 0, sources 0, playing false`, and
  the answer settled in `#answer` ("144."). A delegated typed turn showed "working · 4s" so a slow
  text turn is not silence.
- Switching to voice 4s into a typed turn: state returned to Ready, `turnMode` stayed `text` for the
  cut turn, no audio, and the journal shows `client left mid-turn: stopping the work`,
  `turn 8 abandoned: nothing is spoken and nothing is kept`, `turn 8 ended without completing: not
  recorded`.
- Text mode for 30 idle seconds: the microphone was never opened (`earArmed false, micOpen false,
  recording false`). The two-minute soak in the plan is still owed on the phone.

**Not done, deliberately:** the 30s soak instead of the planned two minutes; no long spoken answer
was re-measured after the change (the mode suite's voice rows are the evidence, and the speech path
is untouched); the phone's own ear test is his.


**The renderer, proven end to end (same day, after the modes landed).** A typed,
recommendation-shaped request ("shortlist three lunch spots near Kampala Road, each on a card with a
link, and give me a choice to narrow it down") was routed to the agent in **text** mode:

- the agent built a reply widget: `widget OJMEjG -> 4996 bytes`, label `Lunch near Kampala Road`;
- its gate passed and it was pushed: `artifact widget -> 1 screen(s)`;
- the page framed it: `#artifact iframe -> https://widgets.battemohammad.com/w/OJMEjGPfCLdYufuj2Zsgww`;
- opening that widget: **3 cards, 4 radios, 1 button, 0 anchors, 2 asks-JARVIS calls** — cards and a
  group of choices whose tap asks the question, and no link that cannot be opened inside the frame;
- the turn itself: `turn 45: tok=210.7s audio=- work=0.0s end=completed chars=820`. The longest turn
  measured, and text mode produced **no audio at all**.

The widget was deleted afterwards to leave the store clean; the frame stays on an open test page
until it is reloaded, which is harmless.

**One expectation corrected.** `tests/routing.json` still expected "What is today's date and what
time is it?" to be handed over. It is answered directly (twice, 0.69s and 1.03s first token), which
is the design: the clock rides on his message and the fast layer must not hand it over. The row now
says `answer`, with the reason attached. The other two rows that changed route (a "walk me
through..." and "Where is the InspectFirst site published?") moved `answer -> work`; neither
contains a word this change added, so that drift belongs to earlier work, not this one.

**Both surfaces carry it.** `/` and `/v1` serve the same engine (`__jarvisModes` answers on both,
dock, artifact area and the mode pill all present). An earlier `__jarvisModes is not a function`
reading was a stale pairing cookie, not a missing surface: the keyed link restores it.

---

## The interface, rebuilt on the apple-design skill (8 October 2026)

**He asked for it plainly:** learn `https://github.com/emilkowalski/skills` (the `apple-design` skill),
then "make [it] usable by you, remove unnecessary instructions that wont help you, also follow it and
redesign our live page".

**The skill, made usable.** Installed from the repo as a hub skill (MIT, Emil Kowalski). Two edits, both
to the index rather than the content: the description is 59 characters now, so the skill index keeps its
whole line instead of cutting the "use when" triggers off the end, and the opening block that told the
agent to say a canned sentence and then stay quiet was removed. The trigger list moved into a
`## When to Use` section in the body, where it is read on load. Everything the author wrote about
motion, materials and type is carried as written.

**Files, before -> after (md5)**

| file | before | after |
|---|---|---|
| `static/v1.css` | `8790637ae27fc847afedd678975f8dc0` | `40e8fd4ee6450b7f51fe4900a5925f19` |
| `static/v1.js` | `d2393b1ba57a48a13687dd9c5e56655a` | `5d4dc45645954c9937a1797d688e6dc1` |
| `index_v1.html` (built) | `7233483839c7876c68b26e9e9a19e20e` | `41284abb3b13d35c050799371d453fa4` |

`index.html` (the engine of record) and `build_v1.py` are untouched: this is the surface, not the engine.
No service restart was needed or made, because `server.py` reads `index_v1.html` per request. Snapshot of
the four page files: `backups/apple-design/`.

**Motion is springs now, not keyframes (sections 3, 4, 5, 6, 9, 10, 11).**

- `spring()` integrates damping and response on rAF, sub-stepped at 1/240s so a dropped frame cannot
  change the feel, and it starts from the value on the screen, which is what makes it interruptible.
  Apple's own numbers as given: a sheet is 0.8 / 0.3, a reposition is 1.0 / 0.4.
- `project()` (exponential decay) and `rubberband()` are the skill's own formulas. The decay used for a
  *dismissal* is 0.99 rather than the helper's 0.998: at 0.998 a leisurely 120px drag projects another
  ~200px and slams the sheet shut, which is the wrong read of a slow hand. Found by measuring, not taste.
- Summary, History and Appearance are one draggable surface. `#sheetpanel` takes the gesture unless it
  begins on the timeline while that is scrolled, in which case the list keeps it.
- The old dismissal was a 60px touch swipe that reported a final state and could not be reversed: the
  exact shape section 3 calls the most important thing to get right.
- The arrival animation lost its `filter: blur(3px)` keyframe (paint-bound, a jank source on a phone for
  as long as it runs) and `.art::after`'s gradient sweep was deleted, since it cost a compositor layer per
  arrival to decorate an arrival the rise already announces.

**The bar is chrome over the content (section 12).** Translucent (`blur(22px) saturate(1.5)`), pulled up
over the content by its own measured height (`--barh`, published from a ResizeObserver), with `#content`
padded by the same number so the last line of an answer never ends underneath it. The seam where content
passes under the bar is a fade, never a rule. Switched off in the landscape rail and while typing, where
the bar is a column beside the content rather than chrome over it.

**Two materials, because the choice should be looked at, not described.** Ink (denser, the default) and
Frost (the same structure read lighter), switched in Appearance -> Material and remembered per device.

**Feedback on the press (section 1).** Every control responds on pointer-down (`:active`, with a 90ms
release curve), plus `touch-action: manipulation` everywhere and a no-op touch listener for iOS, which
otherwise paints `:active` only on release.

**The accessibility trio (section 14).** `prefers-reduced-motion` removes travel and overshoot but keeps
1:1 dragging, because his own hand is not animation. `prefers-reduced-transparency` and
`prefers-contrast: more` collapse the materials to solid surfaces with defined edges. The script reads
the same media queries as the stylesheet, so the two cannot disagree.

**Measured, not inferred** (headless Chrome at 360x640 unless stated, `Page.bringToFront` first: a hidden
tab runs no rAF and every spring freezes where the finger left it, which reads as a broken handler):

- The drag tracks the finger exactly: samples `[0, 40, 90, 120]` for finger moves of 40, 90 and 120.
- A slow 120px drag returns to rest and the sheet stays open. A slow 250px drag closes (past ~45% of
  the panel). A fast flick, 200px in ~46ms, closes on the velocity clause alone (`v > 620px/s`).
- Rubber-band past the rest position: finger -40 -> sheet -20.8px; finger -80 -> sheet -39.5px; released,
  it returns to 0 with the sheet still open.
- Grabbed mid-flight: 29.5 on screen -> 29.5 at the grab (no jump) -> 69.5 after a 40px move.
- Ownership: a drag from the timeline at its top moves the sheet; the same drag with the timeline
  scrolled to 80 leaves the sheet at 0 and the list keeps its position.
- Layout: bar 148px at rest, `--barh` 148px, content padding 160.8px, last line bottom 555 against bar
  top 565. `scrollWidth == clientWidth` at 360 portrait, at 640 landscape and in the typing state.
- Landscape rail: the bar is a column (x=561, w=79) with no overlay and no overflow.
- Preferences: reduced motion -> no sheet keyframes and instant open/close; reduced transparency ->
  `backdrop-filter: none` and an opaque surface; more contrast -> no blur plus a 1px border; back to
  normal -> `blur(22px) saturate(1.5)`.
- Ink/Frost: `data-material` flips and the bar's blur changes with it; the choice lands in `localStorage`.
- The modes are untouched by this work: a typed turn in text mode answered "144." in about a second with
  `audioBusy false` and **0 audio elements playing**, and the mode pill still flips voice and text.

**Not verified, and stated as such:** how the press states and the two materials feel under a real thumb
on his phone. `:active` from a real finger cannot be exercised headless, and which material reads better
is his eye to make. The first run of these tests also spent a round on a hidden tab (no rAF) and on
synthetic events that cannot capture the pointer; both are now recorded in the `jarvis-live-page` skill,
so the next run starts from the answer.

---

## The Plugins view — names, shelves, and a card that opens (15 October 2026)

**The order.** Four things on the Plugins panel: slugs turned into names, "bundled" replaced by what
each plugin does, a distinct mark per kind of plugin, a filter bar under the search, and a card that
opens to show its own detail.

**What the machine already knew and the page was not saying.** `hermes plugins list --json` prints
`name, status, version, description, source, removed` — the description was there all along and the
endpoint was dropping it, which is why every row read "bundled". `/sys/extensions` now carries
`description`, `kind`, `tools` and `hooks` per plugin, read from each plugin's own `plugin.yaml`
(`_plugin_manifests()`, cached on the same 4s clock as the rest of the endpoint). Nothing on a card
is inferred: the name is a label, and every other line is read back.

**The numbers, live.** 61 plugins, 56 enabled. Shelves: Web & Search 14, System 10, Integrations 25,
AI & Media 12. Each pill was clicked and the visible rows counted: 61 / 56 / 14 / 10 / 25 / 12 — the
pill count and the filtered row count agree in every case. Search + shelf compose: "tavily" alone is
1 row, "tavily" on AI & Media is 0 with "Nothing matches that search.", "video" on AI & Media is the
4 video backends.

**Two plugins share a slug.** `deepinfra`, `fal`, `openrouter` and `xai` each appear twice — an image
half and a video half under one name. Hiding one would be a lie about the machine; renaming one by
position would be a guess. The description the machine itself writes ("... image generation backend",
"... video generation backend") decides, so the rows read DeepInfra Image and DeepInfra Video.
`browser-firecrawl` and `web-firecrawl` are genuinely different plugins too, so the browser one is
named Firecrawl Browser.

**Two bugs found by measuring, not by reading the DOM.** Both rendered a correct DOM and a wrong
screen:

1. The shelf bar came back **4px tall**. The panel is a flex column, and a flex item with
   `overflow: auto` has an automatic minimum size of **zero** — the bar was squeezed to its own
   padding and the pills were invisible while every probe said the pills were there. Fixed with
   `flex: 0 0 auto` on the bar.
2. `.p-pills` was **already taken** (line 1940, the wrapping metrics row), so the new bar silently
   inherited `flex-wrap: wrap` and stacked into three rows at 95px. Renamed `p-shelf` / `p-shelfbtn`.

The lesson, and it is the same one twice: a DOM assertion is not a layout test. Geometry —
`getBoundingClientRect`, `scrollWidth` vs `clientWidth`, computed `flex-wrap` — is what caught both.

**One live side effect, put back.** A test tap on the switch column disabled `mattermost-platform`
for about thirty seconds. It was switched back on and confirmed twice: the page reports it `on`, and
`hermes plugins list --json` reports 56 of 61 enabled with `plugins.disabled: []`. Verification that
touches a live control is a change to live state.

**Verified.** 181 skill rows and 11 MCP rows still render with no filter bar (the panels that share
the code path are untouched). Cards: 16px radius, `1px solid var(--mat-edge)`, a chevron, a tag line,
an icon per shelf (globe / disk / key / chat / camera / film / search / bolt). Tapping a card opens
one body at a time with the description, the declared tools and hooks, the runtime line and the
identifier; tapping the switch does not open the card. The light theme was checked separately — the
edge still reads as a card at `rgba(255,255,255,.85)` over the raised fill.

**Not verified, and stated as such.** How the shelf bar feels to scroll with a thumb, and whether
`--mat-edge` is edge enough for him. Both are his eye to make on his phone.

**Rollback.** `backups/plugins-ui-20261015-204129/` holds `server.py`, `build_v1.py`, `index_v1.html`
and `static/v1.{js,css}` as they stood before this work.

---

## Connectors, schedules and skills — names, places, and what the machine already knew
(15 October 2026, second pass)

**The order.** The same reading the Plugins panel got, applied to MCP, Automations and Skills:
readable names, a mark per kind of thing, transport badges on the connectors, plain-English
schedules and a routing badge on the jobs, and one card across all four lists.

**Skills: the panel was hiding six of them.** `_extensions()` swept `skills/*/*/SKILL.md`, which
cannot see a skill nested one level deeper — `mlops/evaluation/*` and `mlops/inference/*` — and the
four at those depths plus the two that sit directly under `skills/` were missing entirely. A
recursive sweep now finds 187 where the flat one found 181, and each row carries its own group path,
so `mlops/evaluation/llama-cpp` is filed under MLOps rather than under nothing. The count is the
tree's, not a constant: it moves when a skill is added.

**Automations: the schedule was being printed, not read.** The endpoint was handing the page
`when: "0 7 * * *"` and the panel was showing exactly that, next to `→ whatsapp:<operator-lid>@lid`.
The endpoint now sends the schedule's own parts — `kind`, `expr`, `minutes` — plus `last_run_at`,
`next_run_at`, `failure_streak` and `last_error`, and the page says the sentence: "Daily at 7:00 AM",
"Mondays at 6:00 AM", "Every 6 hours", "Hourly at :25", "4 Oct at 5:48 PM". Every one of the twenty
jobs was checked against its own expression. The delivery target is a chip with the channel's own
mark and only the platform name — an identifier is not a destination anyone reads. The third line is
the run's real state read from its own timestamp: "Last run 18h ago · Success", or, when a job is
genuinely failing, the machine's own last error in the danger colour. "Upgrade check" has failed 21
times in a row and is paused; it says so on the row.

**MCP: the transport is now a fact rather than a blank.** The panel was showing nothing at all for
the ten HTTP servers, because the endpoint sent no URL and the page asked for one. It now sends the
host and the transport, and the row reads `mcp.cloudflare.com` with an `HTTP` badge, or
`local process` with `stdio` for Serena. The badge is derived from how the endpoint is reached — a
URL ending `/sse` is the older event-stream transport, anything else is streamable HTTP — never from
a label anyone typed.

**Marks.** Cloudflare, Hugging Face, GitHub and Wolfram carry the shape the brand itself publishes
(Simple Icons, CC0, fetched and inlined so the page keeps no runtime dependency), as do Telegram,
WhatsApp and Email on the routing chips. Everything else gets this app's own glyph by kind: a book
for the documentation servers, a globe, a plane for Kiwi.com, a chart for Twelve Data, code for
Serena, and a bot, gear, brush, flask, briefcase, user, clipboard, pencil or apple per skill shelf.
Nothing is a brand mark guessed from memory — where a published shape was not available the page
says so with its own drawing instead.

**Skills titles.** Kebab-case through a capitaliser is not a name: the first pass produced
"Findmy", "Imessage", "Acp", "Sdlc", "Youtube", "Comfyui" and "Llama Cpp". There are now two
dictionaries — the ~70 words that are acronyms or have their own casing, and the handful that are
not words at all — which give "Find My", "iMessage", "ACP", "SDLC", "YouTube", "ComfyUI",
"llama.cpp", "DESIGN.md", "p5.js" and "JARVIS Live Page". The small joining words stay lowercase
except at the ends, so "X Reading Without Credentials" reads as English.

**Three things measured, not read.** As before, all three faults rendered a correct DOM and a wrong
screen:

1. The third line on a job card, "Last run 14d ago · Failed · 21 in a row · Paused", overflowed a
   390px phone and was cut to "…· P". It wraps now.
2. A job name is primary content, and "Assumptions register s…" is not a name. Titles clamp at two
   lines instead of one.
3. The chip line has to be allowed to wrap or the badge is the thing that gets cut — GitHub's
   `api.githubcopilot.com` is the one row that takes two lines for it, which is the honest outcome.

**Verified.** 61 plugins, 187 skills, 11 connectors and 20 jobs all render; no title is truncated;
the shelf bars count to 34/31/27/22/19/8/8/8/7/5/5/4/3/1/1/1/1/1 = 187 and add up on the page. Every
card is `1px solid var(--mat-edge)` at 16px with the page's blur, on all four lists. The plugin
card still opens and still shows one body at a time after the card style was generalised.

**Rollback.** `backups/panels-ui-20261015-205148/` holds the five files as they stood before this
second pass.

---

## The conversation lifecycle — a new chat, a row, a deletion (16 October 2026)

The drawer's Recents list and the conversation it shows had no shared idea of which conversation was
on the canvas. `sessionId` was the only marker and it was set in one place, cleared in another, and
read by the dot, by the new-chat guard and by nothing else. His three faults all came out of that:
a chat you were in could report itself empty when you tapped its own row, a conversation started
after the page loaded never appeared in Recents at all, and the bin refused the one conversation you
were most likely to want gone because that record is the live window.

**One answer to "which conversation is this".** `activeId` names the conversation on the canvas: `""`
is a chat that has not been named yet, which is what the header pen leaves behind and what the first
message turns into a real one. `pending` is the row for a conversation that has just started, because
the machine lists a conversation only once one of its turns has been saved and a chat you are looking
at must not be missing from the drawer for the length of an answer. Both live in the file's outer
scope because the sessions panel and the drawer are separate closures and two answers to that
question is exactly how a row gets a stale id.

**The first message makes the conversation.** The turn hook already received the question as its
argument; the old wrapper read the composer instead, which the engine empties on the way past, so the
name was always empty and the row never existed. It now takes the argument, derives the title with the
same rule the machine uses (`concise_title`, both sides, so the row drawn now and the row stored a
moment later cannot disagree), and pushes the row in at that instant. A padded request names itself
properly — "hey jarvis can you please reply with the single word kite" is *Reply with the single* —
because the rule strips the padding a spoken request opens with and cuts at a word boundary inside
25 characters.

**Tapping.** A row for the conversation already on the canvas closes the drawer and does nothing else:
no fetch, no rehydrate, no toast (`window.fetch` counted zero calls to `/api/sessions/<id>`, and a
sentinel attribute on the thread survived the tap). Any other row switches, which is what hydrating
the turns, taking the landing hero down and closing the drawer all mean.

**Deleting.** The endpoint refuses the live window outright — that record is assembled from the agent's
window rather than stored — so the conversation you are in goes the other way: the window is closed
first (`POST /reset`, which files it away under its own id) and the kept copy is then deleted by name.
The screen returns to a blank chat, which is the only honest outcome of deleting the chat you are
reading. The server log says both halves: `conversation reset: session 3c3c1685f4ac` then
`session forgotten: 9822541914874bb686a20e2192bccb2d (1 turns), 0 left, copy at backups/forget-<stamp>`.

### Two faults found while verifying, both older than this work

1. **Opening a saved conversation threw, and the throw was reported as a broken conversation.**
   `rehydrate()` called `clearStaged()` and `syncEmpty()`, both of which live in a *later* IIFE. A name
   from another closure is a `ReferenceError`, and it fired on the first two lines of housekeeping:
   `ReferenceError: clearStaged is not defined at rehydrate`. The fetch's own `catch` then treated it
   as "the machine could not be reached", showed the device's turns instead of the machine's, and the
   page announced the conversation as unopenable. The chips are now cleared through the surface the
   drawer publishes for it (`window.__jarvisClearStaged`, the same pattern as `__jarvisResetSurface`)
   and the hero is taken down at the point of the repaint, the way `retireTurn` already did it. The
   paint is also wrapped separately now, so a failure to draw is never again reported as a failure to
   find.
2. **The list was only ever the one painted when the page loaded.** Two listeners sat on the menu
   button: the toggle, registered first, then `if (nav && nav.hidden) paintNavSessions()`. The toggle
   has already flipped `hidden` by the time the second runs, so that guard was never true: a
   conversation started after the load did not appear in Recents until a reload. It refreshes on every
   open now, through a `setTimeout(…, 0)` so the refresh never depends on which listener ran first.

**Rollback.** `backups/lifecycle-ui-20261016-034538/` holds `server.py`, `build_v1.py`,
`index_v1.html` and `static/v1.{js,css}` as they stood before this pass. The five files are not in
git here, so that directory is the rollback point.

## The session store — a conversation written where it can survive (16 October 2026)

**What was asked.** A conversation must exist in persistent storage the moment it has a first message,
must carry its work trace as well as its words, must appear in Recents without a reload, and "+ New chat"
must store the thread before it empties the screen instead of being the one control that can throw it away.

**The store, both halves.**
1. **On the machine** (`sessions.json`, `POST /api/sessions`) a turn now carries `s` — the bounded work
   trace — beside `q`, `a` and `t`. `_clean_steps()` keeps the words that were on the rows and drops the raw
   call and its output, which nothing on this surface can open any more, so a conversation that read forty
   files stays a conversation object rather than a file. Same shape as the device's, so a turn renders the
   same wherever it is opened from.
2. **On the device** (`localStorage["jarvis.v1.sessionstore"]`, keyed by the same conversation id) one
   object per conversation: `id`, `title`, `started`, `updated`, `turns[]`, written from the first message
   (id + name + timestamp, `turns: []`) and rewritten at every turn end. Twelve conversations are kept.
   The device's copy is written *first* on every save and its result is what the caller gets back, because
   that is the copy that answers "is this thread stored" with no network in the way; the POST follows on its
   own and a lost one is not a lost turn.

**Recents subscribes.** The drawer's list is the machine's records merged with anything the device holds
that the machine does not (`mergedSessions()`), and `saveConversation()` calls `window.__jarvisSessionsChanged()`
the moment a save lands, which repaints the list if the drawer is open. Verified by stamping a `data-mark`
attribute on a row and watching it disappear: the rows were rebuilt mid-drawer, with no reload and no reopen.

**New chat cannot lose a thread.** `startNewConversation()` now calls `flushSession()` before it blanks the
canvas: the device copy is written, the machine's POST is fired, and only then are `sessionId`, `activeId`
and the viewport reset. This is load-bearing, not defensive — `clearView()` (which `resetSurface()` calls)
runs `markReset()` and `saveHistory([])`, so emptying the canvas *destroys* the flat turn history the session
object is built from. The engine's dock reset does the same two calls now (`__jarvisFlushSession` then
`__jarvisResetSurface`) before its own `POST /reset`, so the two ways of starting over behave the same.
Deleting a conversation drops its device copy in the same step (`devDrop`) — including the running window,
where the delete path rotates first — so a deleted thread cannot come back through the device store; clearing
all local history (`devWipe`) now means that too.

**Opening a conversation brings the work with it.** `rehydrate()` takes the trace from the turn itself
(`rec.s`), then from the device's copy of that turn, then nothing. Verified end to end: after `localStorage.clear()`
and a reload — a device that has never stored anything — opening the conversation from Recents rendered
`Ran free` from the machine's record alone.

**Three faults found on the way.**
1. **The traces were stripped, not carried.** `_merge_traces()` paired the page's copy with the agent's copy
   on `(question, timestamp)`. The page's clock is the second the turn finished on the device; the machine's
   is the second it recorded the question. They never agree, so the merge that was supposed to restore a
   trace silently removed it instead — the archived window came back with its work gone. It pairs in order on
   the question text now.
2. **A save could take a trace away.** `POST /api/sessions` overwrote the stored copy with whatever the page
   sent, so a page that saved a turn without its trace — an older tab, a rebuilt bundle — deleted the trace
   that was already stored. The stored copy is merged with the incoming one now: traces are monotone.
3. **The closure trap again.** `sessionObject()` and `saveConversation()` are in the file's outer half and
   referenced `sessionId`, which lives in the drawer's closure — the same `ReferenceError` class as the
   lifecycle pass, caught this time by a mechanical audit (every name the drawer closure declares, grepped
   across the outer half) rather than by a user complaint.

**Rollback.** `backups/lifecycle-ui-20261016-034538/` is the pre-pass base for the five files;
`backups/panels-ui-20261015-205148/` and `backups/plugins-ui-20261015-204129/` are the earlier ones. The trees
are not in git here, so those directories are the rollback points.

## RECENTS newest first, and the turn that outlives the screen (16 October 2026)

The list was right about what it held and wrong about the order; the stream was right while the screen
stayed put and lost its nerve the moment it moved. Both are now tied to the turn rather than to the
screen.

**The list.** `byNewest()` sorts every conversation by its own `updated` stamp, and both paint paths
run it (`withPending(byNewest(mergedSessions()))` for the drawer, the same for the pending merge). A
conversation still being written has no stored turns yet, so the list adds it from the running turn's
own question — with `turns: 0`, which is what it is — and `GET /api/sessions/{sid}` answers for such a
conversation with no turns and the turn to bind to instead of 404. Before this, the one conversation
with work in flight was the one the drawer could not show.

**The turn owns its conversation.** A turn now carries its conversation id from the moment it is
asked, and that id is what every save uses — whether the answer is drawn on the canvas it was asked
from or finishes after the screen has moved on. Four faults were found while proving it:

1. *An off-screen turn was also filed on the canvas.* The engine announced the end of a turn and the
   page filed it against whatever conversation it happened to be showing, so one answer existed twice:
   once under its own question, once as a phantom row with the question missing. The turn's own
   conversation is now what decides, and the canvas save is skipped when the turn was not asked there.
2. *The machine and the page could disagree about the name.* The server named a conversation from its
   own window key, which is blank after a restart; the page named it from what it was showing. The same
   answer was filed twice — under the real id and under `current`. The page now names the conversation
   the turn is asked in (a name it can only know from the screen), the server mints one when the turn is
   the first in a fresh window, and the page adopts the machine's name from the turn's own opening event
   so both sides write one conversation.
3. *The end of every turn threw.* The guard that decides whether a turn belongs to the canvas read a
   drawer-only variable from the other half of the page — a `ReferenceError`, swallowed by the engine's
   try/catch, which silently killed the page's own copy of the turn: no device record, no flat history,
   and no final settle of the canvas. It reads the drawer's published hook now.
4. *A placeholder pooled conversations.* Every window that had never been reset filed under `current`,
   which is how his question and four of mine became one row. A conversation is now named by its first
   turn.

**Re-attaching.** Switching conversations no longer stops anything: the reader stays on the turn, the
turn's events go to a record held for the conversation it was asked in, and the answer is written there
when it lands (words, question and work trace together). Coming back re-binds the canvas to the live
turn; a full reload mid-answer binds to it too, because `/stream/attach` replays the turn's own log from
the beginning. "The link to JARVIS dropped mid-answer" was the page treating a view change as a lost
connection: the view change is now told to the engine (`__jarvisViewChanged`), which keeps the one fact
the page cannot know for itself — whether the turn in flight is the one on screen.

Verified on the live surface: walk away mid-answer (no error line, turn completes, recorded under its
own conversation with its trace); return through the drawer and mid-answer reload (both re-bind, answer
continues onto the canvas); ordinary turn (canvas copy saved, device copy and flat history written);
drawer order newest-first. Test conversations and their turns were removed from the store afterwards;
only his own records remain. Rollback: `backups/lifecycle-ui-20261016-034538` (pre-pass),
`backups/streams-20261016-045102` (post-pass snapshot).


## One chat, one heading; and a delete that finishes (16 October 2026)

He reported three faults from using it, and they were one seam seen from three sides.

**A chat that duplicated when he walked away.** The window he asked in was archived correctly, and then the
answer was written a second time into the window that existed by the time it landed. Three things fed it:

1. `commit()` only refuses when a *newer turn* has started, so a reset in mid-flight was invisible to it and
   the finished answer went into the live history — the new window — as well as its own record. A reset now
   retires the turn in flight, and the existing path files the answer where it was asked.
2. A reset archived the window but left its turns in `HISTORY`, so the drawer showed the archived
   conversation again as a live row under a fresh name. A new conversation now starts with an empty window.
3. The page's own save posted the *whole flat history* — turns from several conversations — as if it were
   one conversation, which is how a chat's turns turned up under another chat's heading, and how a device
   copy ended up keyed by a placeholder (`current`) beside the machine's real name. The flat history no
   longer posts; a single finished turn is saved by name, into the conversation it was asked in.

**"Couldn't open the chat", and a delete that sometimes did not work.** A row the machine no longer has
could not be opened (nothing to read) and could not be deleted (the endpoint answered 404 and the row
stayed). Such a row is now removed on this device, with an honest line, because that is the whole of what
deleting it can mean — and the id is remembered in `jarvis.v1.gone` so the machine's list cannot bring it
back. Separately, the delete icon armed itself against the DOM button: any repaint replaced that button, so
the second tap re-armed instead of deleting. Arming is now held against the row's id and survives repaints,
and a 409 (the live window) routes to the close-then-delete path instead of a dead-end message.

**An empty RECENTS list.** A publish (`window.__jarvisGone`) was placed in a scope that could not see the
function it published: a `ReferenceError` at load, which took the rest of the drawer's setup down with it —
no rows at all. Published beside its own function now.

Verified on the live surface, in his order: ask then leave at once (one heading, recorded under its own
conversation); open a chat the machine never stored (reads from this device); delete such a row (removed,
honest toast); arm a delete, let the list repaint, tap again (it deletes); an ordinary turn (answer on the
canvas, one row, work trace kept).

Left open, stated rather than papered over: for a very fast single-command turn the step can arrive after
the answer is finished, and that turn's stored trace stays empty — the words and the record are intact, only
the work row is missing. The smallest next step is to hold each turn's trace in the painter rather than in
the shared step list.

Rollback: `backups/streams-20261016-045102` (pre-change), `backups/chatrows-20261016-051433` (post-change).


## One conversation's words, and only its own (16 October 2026, second pass)

He asked for strict per-conversation tagging, no cross-contamination between chats, and a re-opened
background chat that shows its prompt. The tag was already travelling and the routing was already by
conversation, so the work was in the exceptions:

- **Every chunk now names its conversation** — stamped once, in the one place a turn publishes an event, so
  the buffered replay carries it too. The engine refuses a chunk naming a conversation other than the turn it
  is reading, before it is drawn or recorded.
- **The answer is filed by the conversation it was asked in, not by the window that is open when it lands.**
  `commit()` only refused when a newer *turn* had started, so a window that had rotated (he started a new
  chat while the old one was still working) took the answer into its own history — one chat's words under
  another chat's heading. The commit now compares the turn's conversation with the window's name and hands
  the turn to the conversation's own record when they differ.
- **A re-opened conversation comes back with its question.** Opening a chat whose first answer was still
  being written hydrated from an *empty* turn list, and a re-bound turn never went through the page's own
  start, so the canvas was a working light and a step list with nothing on it saying what the work was for.
  The machine's own record of the question now travels with the live turn (`turn_q`), the page hydrates the
  conversation's stored turns in that branch, and a placeholder question stands with the work until the
  finished turn replaces it (`retireTurn` removes it, so there is never a second copy). Where the page knows
  nothing — a reload — it asks the machine rather than leaving the canvas blank.
- **A running chat does not present itself as finished.** Reading a record back settles the phase on
  "worked"; a conversation with a turn in flight is set back to thinking, and the pill says so.
- **A running window's drawer row is named by its question** instead of "Untitled".
- **Every save is on the record**: a small ring (`__jarvisSaveLog`) of conversation, question and answer for
  the last 40 saves. It was added to catch a mis-file and it is worth keeping — "which call put those words
  there" is a question no amount of reading the code answers as fast as one look at this.

Verified on a freshly emptied store: two chats, one asked while the other was still working — each holds
only its own turn, with its own trace; a chat reopened mid-answer shows its question, its steps and its
answer arriving; a chat left and returned to shows its answer in full; nothing bled between them. The
pollution visible before this pass came from earlier builds' writes, which is why the store was emptied
rather than trusted.

Rollback: `backups/preclean-20261016-053724` (before this pass), `backups/session-isolation-<stamp>`.


## The conversation's own name, and everything under it (16 October 2026, third pass)

He asked for store keying by an immutable id, for a selected chat to render all of its answers, and for
one prompt at a time. Each ask had a real fault behind it.

- **Keyed by title, not by id.** The drawer folded a device copy into a machine row when their *titles*
  matched — and two conversations can be given the same opening words, so genuinely different chats could be
  joined while a copy under a placeholder name stayed a twin heading of the chat it belonged to. Nothing is
  matched on a title now: a copy under a name that is not a conversation name is joined only to the machine's
  name for it (found by the question that opened it), and only when that name is known here. An id is the
  conversation; a title is what it happens to be called.
- **A copy under a placeholder never moved.** The first turn of a new chat was filed on the device under the
  placeholder the page was using before the machine named the conversation, and it stayed there — so the real
  chat held half of itself and the placeholder was a second heading with nothing readable in it. The device's
  copy now moves to the machine's name the moment the name is known, carrying its turns, joined on the
  question each turn was asked.
- **An empty record is not a row.** A conversation with no turns was kept (a title, no turns) and became
  exactly the heading he could neither open nor use. Nothing empty is written or shown.
- **The machine files every finished turn.** Only the page's own save carried a turn into a conversation's
  record, so a chat could come back as its last answer with nothing above it. Every completed turn now goes
  to its conversation's record on the machine as well as into the window — the window is the live surface,
  not the store.
- **The canvas asks for the rest of the conversation, once, on the way up.** What the page kept is normally
  the last answer; the machine holds the whole chat. One look at load (never while a turn is being written)
  puts the earlier turns back behind the newest one.
- **One prompt at a time, and his words are not thrown away.** The composer emptied as he sent already; a
  second send while a turn is genuinely working is now refused with a plain line and his text left in the
  box, ready for when the answer lands. The first version of that guard was wrong in the other direction — it
  blocked the follow-up question too, because the engine keeps its turn context after a turn ends — so the
  guard tests that the turn is running, not that one exists.
- **A turn is never painted twice.** The same turn can be held by the page and by the machine; the canvas
  joins them on the question and draws it once.

Verified cold: two turns in one chat, then a load with no page history at all — the first turn is above, the
newest answer below, one row in Recents, no error line. And: a second send during a working turn is refused
with the words kept, then sends normally when the turn ends.

Rollback: `backups/session-isolation-20261016-054323` (before this pass), `backups/state-store-<stamp>`.


## Work in flight, said in two places (16 October 2026)

- **The drawer row.** While a conversation is being answered, the row's bin becomes a golden pulse in the
  accent the page already uses for a live conversation, and the dot keeps its place. The bin is not offered
  mid-answer on purpose: deleting a conversation being written would throw the record of what it is doing
  away. When the work ends the pulse returns to the bin by itself — the list repaints on a four-second beat
  only while something is running, so there is nothing to tap and nothing to reload.
- **The canvas.** A chat being answered says so in words directly under his prompt — "JARVIS is working in
  the background… 12s" — and the count starts from the machine's own record of when the turn began, not from
  when he happened to open it. It comes up immediately on opening such a chat from Recents, which is the
  blank-canvas-with-an-orphaned-step-count case.
- **Completion.** The pill does not vanish, it becomes the record: a green badge reading `✓ WORKED · 20s`
  with the turn's step count beside it, and it is a control — tapping it opens the same Summary the status
  badge opens, so there is one way into the steps and not two. It stays until his next turn, matching the
  status bar, and a turn of his own on that canvas clears it.

Two faults surfaced in the making, both worth keeping:

- The engine reported a finished turn as still alive: `alive` was "the connection object exists", and the
  reader settles a moment after the last event. The drawer's pulse would have stayed on a chat that had
  finished, and the send guard built on the same flag blocked the follow-up question. It is now "the turn is
  still being worked on".
- A turn that ran while he was looking elsewhere kept no steps on the canvas, so the badge had nothing to
  count. The background record's own step count is carried over for exactly that case.

Verified: pulse and dot on the row while working, bin back after; the pill under the prompt with a live
count; `✓ WORKED · 20s · 3 steps` in green when it ended; tapping it opening the Summary.

Rollback: `backups/state-store-20261016-0600` (before this pass), `backups/status-indicators-<stamp>`.


## The dock belongs to the conversation on the screen (16 October 2026)

Five asks in one pass: session-scoped dock, drawer indicators and order, one status pill, id-keyed
store with dedup, and a summary that holds the work.

- **The dock is scoped to the conversation he is looking at.** The working posture — phase, state and the
  stop control — was page-wide, so a turn being answered in another chat left "+ New chat" locked: Send and
  Mic replaced by a stop control on a blank canvas. Opening or switching a conversation now clears the
  posture first (`unlockDock`: clock stopped, phase cleared, state idle) and sets it again only for the
  conversation that is actually being answered. Verified: a chat was asked and answered while a 35-second
  turn ran in another one, from a blank canvas whose dock read "Ready".
- **Recents order and indicator.** Newest first, and the row of a conversation being answered swaps its bin
  for the golden pulse with the dot in place; the bin returns when the work ends. A row that is working never
  offers the delete control — deleting a conversation mid-answer throws the record of what it is doing away.
- **One status, not two.** The badge, the pill and the engine all had a word for "running". Now the pill
  under the prompt is the single status of a background turn — working, then `✓ WORKED · 20s` with the step
  count — and the status badge stands down while that pill is on the screen, including a beat after the turn
  ends when the engine's own settling would otherwise print the same verdict a second time. The blank canvas
  carries no pill at all.
- **Id-keyed store and dedup** (already in from the previous pass, re-verified): one conversation one record,
  never joined on a title, a prompt appended only if its id is not already in the store.
- **The summary holds the work.** Two gaps closed: the machine now files each turn with its own step list and
  its own measured duration (`TurnChan.steps`, `_session_keep_turn(..., ms, steps)`), and the page's own save
  no longer drops the duration it was sent. A turn that ran while he was looking elsewhere is fetched from
  the conversation's record when the canvas has nothing, so the badge counts real steps and the summary opens
  the real trace rather than "Nothing ran for this turn". The elapsed beside WORKED on a reopened conversation
  is written from the turn's own record, so it reads the work it did and not the seconds since the page opened.

Verified end to end: landing unlocked; a second chat answered while the first ran; Recents newest-first with
the working row pulsed and no bin; the pill as the only status mid-flight; `✓ WORKED · 8s · 2 steps` after; tapping it opening
a summary with the turn's steps; a reopened finished chat showing its question, answer, steps and its real
duration rather than 1s. One cosmetic item stays open: a step's label is only as good as the agent's own name
for it (a bare tool call can read "Used the unnamed tool").

Rollback: `backups/status-indicators-20261016-061501` (before this pass), `backups/dock-and-status-<stamp>`.


## Conversations get names, steps get words, tables get width (16 October 2026)

Five asks: AI thread titles, strict id-keyed dedup, table and card-header styling, step naming, and a quiet
socket recovery on wake.

- **A conversation is named for what it is about.** `_session_title` sliced the first eighty characters of the
  first request, so three chats about the same machine all read the same. After the first turn is filed, the
  backend asks a small model for a three-to-five-word title — subject, not wording — writes it to the
  conversation with a `named` flag so it is asked once, and the row reads it on the next refresh
  ("WhatsApp Front Desk Protocol", "Full Day Rate Kampala"). Every refusal is logged with the text it refused.
- **Two faults found in the making, both worth keeping.** The namer first handed the call to a worker thread:
  measured, the thread printed "asked for" and then never reached the call — the naming now runs inline on the
  thread already finishing the turn, measured at about a second, with the answer already delivered. And the
  call was hooked only into the machine's own filing path, which is the fallback: an ordinary turn is filed by
  the page's save, and that path was never hooked, so no ordinary conversation was ever named. Both paths ask now.
- **Strict id-keyed dedup** (in from earlier passes, re-verified): one conversation one record, keyed by its id
  in both the device store and the machine's store, never joined on a title; a re-sent prompt maps to the
  conversation it came from rather than a new row.
- **Tables and headers.** Any table's wrapper now takes the full width it is given and scrolls sideways with
  momentum (`-webkit-overflow-scrolling`, `overscroll-behavior-x: contain`, a thin scrollbar), and the table
  inside keeps its columns at `min-width: max(100%, 34rem)`. Card header titles — the summary's line, a card's
  title, a page's own name — wrap onto a second line instead of losing their end to three dots.
- **Steps are named.** The stored steps are written as `{label}`, the live ones as `{title}`, a tool may arrive
  as its name or its slug, and the renderer read only `title` — which is exactly why a reopened summary said
  "Used the unnamed tool" while the step had a name all along. The chain is `title || label || tool_name ||
  name || slug`, a slug is spelled out ("terminal_exec" reads as Used Terminal), and a genuinely nameless step
  reads "Ran a step" — never "the unnamed tool".
- **A dropped socket on wake is not a failure when the answer is already here.** `window.fail` first asks
  whether the turn is already answered — the conversation's own record holds it, or the words are on the screen
  — and if it is, it settles quietly instead of raising the red "link dropped" line. Work having happened is
  deliberately NOT the test: a failure during a turn that already drew its steps is still a failure.

Verified: the AI title on a live turn and in the drawer; no "unnamed tool" after a reopen; the CSS rules
present and applied (wrapping titles, full-width scrolling wrappers); `fail()` quiet with an answer on screen.
Rollback: `backups/dock-and-status-20261016-062016`, `backups/naming-and-tables-<stamp>`.


## A row is a door, and a wake is not a blank page (16 October 2026)

Four asks: tap any Recents row including a busy one, cache-first re-hydration on wake, AI titles, dedup.

- **The whole row opens the conversation.** Only the words in the row were a button: the dot, the golden
  pulse, the pin, the bin and the space beside the title were dead ground, and a row that was being answered
  gave no sign of being tappable at all. The row wrapper now takes the tap — a working row included, because
  the pulse is a status and not a shut door — while the pin and the bin keep their own jobs. The marks carry
  `pointer-events: none`, so a tap that lands on the dot or the pulse belongs to the row underneath it.
  Verified: with a 35-second turn running in another conversation, a tap on that row's pulse opened it, pill
  and all.
- **Cache-first on wake.** The panels that read the machine (`/sys/extensions`, `/sys/channels`) painted a
  skeleton and then, with the read failing, either said "Unreachable" or shimmered indefinitely. The last
  list each panel was shown is now kept on the device (`jarvis.v1.panelcache`, eight entries, oldest dropped)
  and painted at once, with the machine's answer replacing it when it lands. A failed read never empties a
  list — an empty list is a claim and a failed read is no evidence for it — and a list from the cache says so
  in one line rather than passing itself off as live. The two Recents paths already fell back to the device's
  own store on a failed read.
- **AI titles and id-keyed dedup** (delivered in the previous pass, re-checked): a conversation is named for
  its subject after its first turn, once, and the row shows it; every thread is keyed by its immutable id in
  both stores, never joined on a title, so a retried or reconnected turn maps to the row it came from.

Honest note on verification: the tap fix is verified live on a busy row, and the titles and dedup were
verified on live turns. The panel cache is in place and carried by the built page, but it was NOT exercised
end to end — the path to those panels is a UI walk (Settings, then the panel) that this pass did not complete,
so its first real test will be a wake with the network cut. The smallest next step if it misbehaves: open
Plugins with the machine reachable (the cache fills), cut the network, open it again — it should list what it
last read, with the one-line note.
Rollback: `backups/naming-and-tables-20261016-071147`, `backups/rowtaps-cache-<stamp>`.


## Navigation is not a crash, and a link is not a headline (16 October 2026)

Five asks: guards against unmounted writes, no raw connection strings in the header, turn validation before
the dropped-link toast, full-width tables, and background work that survives a view change.

- **Nothing throws when the view moves under a stream.** Painting checked that an element was remembered, not
  that it was still in the document: a view switch took the step list and the answer out from under a turn
  that was still arriving, and writing into a let-go element is where the null errors came from. Both paints
  now require `isConnected`, and the stream's own dispatch is isolated per event so one bad write cannot take
  the page down. Verified by hammering the drawer, Settings and "+ New chat" three times over while a 35-second
  turn streamed: zero window errors, zero unhandled rejections, and the turn still completed.
- **The header carries no connection string.** "screen link down" was written into a span in the top row, so
  the page's chrome reported its own plumbing. The dot keeps its colour — a quiet mark — and the words live
  only in its accessible name; the retry logic behind it is unchanged and still silent.
- **A closed socket is not a lost turn.** The dropped-link line now has to survive two checks first: this
  page's flat history, and the conversation's own record on the machine, which holds a complete answer for the
  question. The "Ask again" control is hidden outright when the record already has the answer — an invitation
  to redo work that has been done is worse than no control at all.
- **Tables take the width.** The cells were held on one line inside a card-width wrapper, which is how
  "26 open tabs" came out as "26 open tab…". Tables are now full width with wrapping cells and break-anywhere
  fallback, and the sideways scroller remains for a table that is genuinely too wide.
- **Background work survives navigation.** The turn belongs to the machine, the reader only watches it, and
  moving to another view detaches the drawing without closing anything. Confirmed: the navigated turn's answer
  is in its own conversation's record after three rounds of menu-diving.

Rollback: `backups/rowtaps-cache-20261016-073626`, `backups/nav-guards-<stamp>`.


## Absolute clocks, ground truth, and ten conversations brought back (16 October 2026)

Five asks: absolute turn timestamps, REST status with no socket, AI titles, a non-destructive store guard
with an audit of the database layer, and the unmount guards.

- **Timers count from an absolute stamp.** Every turn now carries `startedAt` — the wall-clock moment it began —
  written by the machine's own filing AND by the page's save (which had been dropping it, the same way it once
  dropped the duration). A screen that arrives late has two absolute numbers to subtract instead of a duration
  it cannot count, so a thread reopened from Recents shows the true elapsed rather than starting again at zero.
- **Ground truth without a socket.** `GET /api/sessions/status` answers per conversation from the machine's own
  registry — `running`, `completed`, `failed`, `empty` — with the live turn ids, and refuses without the cookie
  (401 measured). The drawer now reconciles its rings against it on a wake, a return to the tab, a focus, and
  whenever the drawer opens with something marked busy: a conversation the machine says is finished has its ring
  taken down even if the socket died mid-turn, and the canvas's background pill stands down on the same evidence.
- **AI titles** (in from the previous pass, verified again on live traffic): the 07:00 briefing turn was named
  "Uganda Overnight And Global" by the backend namer, once, and the record carries `named: true`.
- **The store is only ever added to.** A device-store write is refused when it would replace a loaded store with
  nothing, and a turn with no content never overwrites one that has some. A failed sync, an empty read or a
  reconnect that has not finished cannot take his conversations off the phone.
- **The audit and the restore.** Codex was asked to sweep the filesystem for lost threads and refused to run:
  every model this plan can name (`gpt-4.1`, `gpt-5-codex`, `gpt-5`) is rejected by the Codex CLI with "not
  supported when using Codex with a ChatGPT account". That contradicts our own note that the Codex lane works on
  the ChatGPT plan — flagged as a conflict to settle, and the audit was done directly instead. Result: 68 record
  files scanned, 76 conversations present in backups but absent from the store, of which **10 carried questions
  that are not automated probes** and were restored — including a Bolt-versus-Faras driving comparison with 30
  turns, a Uganda news thread, a payment-gateway simulation and two audit requests. 49 probe-only threads were
  left out. The store now holds 11 conversations and his drawer lists them.

Rollback: `backups/nav-guards-20261016-074902`, `backups/pre-restore-<stamp>`, `backups/timestamps-status-<stamp>`.

## Round: engine surgery closed — deadlock, list cap, stuck ring (2026-10-16 08:5x)

Three faults found by running the app rather than reading it, all now fixed and verified live:

1. **Permanent deadlock in the naming path.** `name_conversation` took `LIVE_LOCK`, then called
   `_live_turn_for`, which takes `LIVE_LOCK` itself. On a plain (non-reentrant) lock that deadlocks the
   thread and leaves the lock held for good, so every later reader — `GET /api/sessions` — blocked
   forever. Symptom: the drawer's RECENTS never filled, and the service could not shut down
   (`stop-sigterm` forever) so it needed SIGKILL. Fix: the nesting removed at the call site, and
   LIVE_LOCK / SESSIONS_LOCK / TITLE_LOCK / TURN_CHANS_LOCK / HISTORY_LOCK / SCREENS_LOCK made
   reentrant so the shape cannot wedge the machine again.
   Regression test: run a turn, let the namer title it, then read the list — 200 in 2.5 ms, 18 sessions.

2. **RECENTS silently capped at eight rows.** `.slice(0, 8)` in `paintNavSessions` hid ten of his
   eighteen conversations with nothing on screen saying so. The cap is gone; the endpoint already
   bounds the list.

3. **A ring pulsing with nothing running.** The client marked a row busy when `s.live` (the window he
   is in) rather than only when work is in flight. Busy is now `s.running` or a turn id from the
   machine. Verified: zero visible rings at rest, exactly one while a turn runs.

Verified by eye at the end: 19 rows, no rings at rest, badge `WORKED · 42s` on a 42s turn,
absolute `turn.startIn` + `ms` on every filed turn, AI titles live ("Uganda Election Recount Halted").

## Round: two questions in a loading chat, and a trace full of plumbing (16 Oct 2026)

Reported from real use, both reproduced and fixed:

1. **The same question twice in a loading chat.** `showRunningQuestion` drew the working placeholder
   without first asking whether the canvas already carried that question — and it does, because the page
   draws it when he sends and a rehydrated conversation paints it from its own turns. Fix: if the last
   question on the canvas is the text being drawn, mark that as the running one and draw nothing.
   Verified: one `.t-q` while running, one after.

2. **"WORKED is full of 'opened a page', 'read a file'".** Two causes:
   - `foldedSteps()` compared `title || tool`, but a stored step carries `label` — so a reopened trace
     never folded at all and the summary showed every duplicate ("Opened the page in a browser" four
     times, "Ran echo" eleven). Named once now (`stepNameOf`), used by both the fold and the label.
   - Shell plumbing read as work. `cd`/`pwd`/`export`/`source`/`unset`/`alias`/`true`/`false`/`:` now
     read "Set up the shell"; `echo`/`printf`/`test`/`[` read "Ran a shell step"; repeats carry "×n".
     `_clean_steps` folds the same way when the machine files a turn.
   Verified on the very conversation he screenshotted: its trace is now four lines —
   "Read the clock", "Searched for the Uganda news today query", "Read a page",
   "Opened the page in a browser ×4".
   Nothing is hidden: the record keeps every step, the fold and its count are what is shown.

## Round: mixed conversations, one shared name, and a timer that restarted (16 Oct 2026)

Reported from real use, reproduced in the records, fixed at the cause.

**What the history showed.** Four conversations held a turn wearing another turn's answer:
- `ec786a50a9c3` — a machine-check question with the briefing question beside it, the briefing row
  carrying the machine-check answer. Titled "Give me a briefing on" while its own first question was the
  machine check.
- `785343b313e7`, `35a066cf4d90`, `a8866e1cfb22` — the same answer under two different questions.

**Cause.** `saveTurnInto` sent the page's whole history for a conversation, with `id` only when the page
was sure of the name. When the name was a placeholder the payload was filed against whichever window the
machine happened to be in, so one conversation's turns landed in another's record. Separately, a save
recomputed the record's title from whatever the payload began with, which is how a briefing name ended on
a machine-check conversation.

**Fixes.**
- Each turn now carries `cid` — the conversation it was asked in — and an unnamed page sends only the one
  turn it is saving instead of a history whose owner the machine has to guess.
- The save path routes every turn to its `cid` record and nowhere else, and a title comes from the
  conversation's own earliest question (or the name it already had), never from the payload's first item.
- `_merge_turns`: one answer belongs to one question — an incoming turn carrying an answer the record
  already holds under a different question is refused, as is an exact (question, answer) repeat.
- The working pill counts from the turn's own recorded start, never from "now", which is what made one
  chat keep honest seconds while another began again at zero each time it was opened.

**Repairs to the existing records.** Four mis-filed answers were put back with their own question, found
by matching the question across the store and its backups; nothing was blanked. Two titles that my own
retitle pass had overwritten (`Zero Swap OOM Risk`, `Uganda Overnight And Global`) were restored and
marked named — my error, corrected in the same session.

**Verified.** A fresh turn: its own conversation, its own answer, `ms 42552`, AI-titled
"Server Resource Health Check"; reopening it showed `WORKED · 44s` where it had shown 44s before.
**Open:** one badged reading of `63s` against a record of 42.5s on a chat that had just run on the same
page — the finished phase can still take its seconds from a live count instead of the record. Next step
is to make the finished phase always write the duration from the record and stop the pill's timer at
completion.

## Round: the seconds beside WORKED were a clock, not a duration (16 Oct 2026)

Reported: `WORKED · 63s` on a chat whose own record said 42.5s. Cause: `settle()` stopped the tick and set
the phase, but `paintState` rendered `secs()` — `now - t0` — so any later repaint printed a larger number.
The badge was showing how long ago the turn had started, whenever you happened to look.

Fix: the duration is frozen once, where the turn ends (`workMs`), and that figure is what every later
repaint prints. The live count still runs while a turn is in flight; the record's own `ms` seeds it when a
conversation is opened, and it is cleared when the phase is cleared or a new turn starts.

Verified: `WORKED · 32s` at completion, unchanged 25s later, unchanged after leaving the view and
returning — against a record of ms 32,0xx. Previously this number grew the longer the page stayed open,
which is also why one chat looked honest and the next looked wrong.

## Round: a reloaded page re-bound the canvas, so a repeat question duplicated itself (16 Oct 2026)

Reported from a screenshot: the same question twice in one chat with one answer. Reproduced: after a
reload the page re-attaches to the machine's window (deliberate, for a turn still in flight) and paints
that conversation; the next question then continued that chat instead of starting a new one, so asking
the same thing again produced two identical questions in one record -- and two unrelated subjects sharing
one (the same fault as the mixed conversations).

Fix: the drawer records whether the page put the conversation on the canvas itself or the operator opened
it. A question asked on a canvas the page bound starts its own conversation (POST /reset first, the typed
text carried across and re-issued); a question asked on a conversation he opened from the drawer is a
follow-up and is left alone.

Verified both ways in one run: a page-bound canvas + "What is the load average on this machine?" produced
its own new conversation ("System Load Average", 1 turn); opening a chat from the drawer and asking a
follow-up appended to that chat. The duplicate still present in "Root Disk Free Space" was made by my own
test before this fix landed, not by the running code.

## Still open, needs his call

A record keyed "current" holds three turns from three different conversations (a briefing, and two
machine-check asks), with no durations. It is the placeholder key leaking into the store before the
routing fix. Options: split it into its own conversations, or delete it as pre-fix junk. Not touched.

## Round: the same question twice in one chat (16 Oct 2026) — closed

Reported: the duplicate question came in on later questions, after the first was clean. Two causes, both
now fixed and verified:

1. Filing. One conversation holds one turn per question. Asking the same thing again refreshed that turn
   in place instead of adding a second identical row (`_merge_turns` and `_session_keep_turn`). Records
   are also cleaned of the duplicates already in them: five collapsed, including the "car hire rates as a
   chart" turn in two chats and the payment-gateway simulation.
2. Starting a chat. A question asked on a landing canvas, or on a canvas the page bound to itself after a
   reload, now starts its own conversation; a question on a chat he opened from the drawer stays a
   follow-up.

Verified: the same question asked twice in one chat ended as one turn with one refreshed answer
("Swap Configuration Status", 1 turn, 7.0s), and that conversation is separate from the chats before it.
A follow-up in an opened chat still appends (load average -> uptime -> memory free, three turns).
Note for whoever tests next: the device store holds the canvas copy of the window, so repeated test asks
from one browser accumulate turns there even when every server record holds one turn per question.

Still open, his call: the record keyed "current" (three turns from three conversations, no durations) --
split it into its own conversations or delete it as pre-fix junk.

## Round: the canvas painted the machine's window as if it were this conversation (16 Oct 2026)

The operator asked whether my test had shown the same thing he had: the same question twice, and an answer
about one subject standing above a question about another. It had not, and my earlier explanation (his
browser's local copy) was wrong. The fault was the engine's device history: `jarvis.v1.history` was one
flat list of the last 30 turns shared by every conversation, painted on load. A reload therefore put the
previous chat's turns at the top of the canvas as if they were the current thread, the next question
joined them, and asking the same question again stood beside its own first copy.

Fix: the device history is kept per conversation (`jarvis.v1.history.<conversation id>`), and with no
conversation adopted the canvas paints nothing at all — the conversations wait in Recents and a turn in
flight draws itself. One conversation's turns can no longer appear in another, and a repeat ask cannot
join the first.

Verified on the live page: a load painted 0 turns where it painted 5 before; the same question asked twice
in one chat ended as one bubble and one record, and the drawer listed six distinct titled conversations
including "Kernel Version On Machine". The filing rule from the previous round (one turn per question per
conversation) holds alongside it.

## Round: a markdown table glued into the sentence around it printed as pipes (16 Oct 2026)

Reported from a live briefing: a line read "(BBC, 16 Oct) Figures that moved | Item | Figure | Source |". The
model wrote the heading, the table's header row and the closing paragraph into the ends of the lines around
them -- "(BBC, 16 Oct) **Figures that moved** | Item | Figure | Source |" -- so the table run started a line
late: the header row stayed in the prose and the first row of data was promoted into the column labels.

Fix, in the renderer and not in the prompt alone, because it has to hold for whatever a model writes:
`splitGluedTableLines(lines)` runs before any block rule. Words before the first pipe are prose; the row is
from the pipe on; a bold heading glued to the row's left edge goes on its own line; a sentence after the
last pipe of a row goes under the table on its own line. It only fires on a real row -- three or more cells,
each short -- so a sentence carrying two bars is left alone, and a line that already starts with a pipe is
only touched to take its closing sentence off. The app's own instructions now ask for a blank line either
side of a table and its header rule row.

Verified on the exact text: one table, header Item/Figure/Source (previously the header row was prose and
"Exports" was the header), last row Jakarta stocks / -11% / Euronews, 16 Oct with the closing sentence a
paragraph under the table, and zero raw pipes in prose. Tested without touching any store by painting the
text through the page's own hydrate path; unit-checked the split function on the briefing line, a clean
table, and two prose lines that carry bars.

## Round: the counting timer removed, and the placeholder record closed (16 Oct 2026)

Two things, both from real use:

1. **The timer.** The background pill counted the seconds ("JARVIS is working in the background... 47s") and
   the dock pill counted under THINKING and WORKING with a 400 ms repaint to move the number. Removed: the
   words stay, the pill repaints when the phase changes, and the seconds appear only once a turn is done,
   as part of its verdict ("WORKED - 48s"). Verified live: THINKING with an empty seconds element over 24
   seconds of a running turn, then WORKED - 48s written once at the end.
2. **`_session_key()` minted nothing.** A window with no id filed its turns under the literal name
   "current", so the next window's turns joined them, and one answer was stored twice -- once under
   "current" and once under the page's real name. A window is now given a name (os.urandom(16).hex()) the
   first time it needs one. The duplicate "current" record holding the briefing that was already stored
   under b984b88b55ac was removed; the store holds two conversations, no placeholder key.

Note on housekeeping: the conversation the timer verification created ("Machine Resource Health Check") was
deleted through the app's own forget path. "Machine Capacity And Maintenance" was left alone -- it may be
the operator's own.

Follow-up in the same round: when the page posts the conversation it is in and the machine's window has no
name yet, the window adopts the page's name (POST /stream, the posted_conv branch). `_session_key()` mints a
name only when nothing named it. Two names for one conversation -- the page's and the machine's -- is how a
single answer ended up stored twice.

## Round: the drawer came up empty, and two conversations recovered (16 Oct 2026)

Reported: pressing "+ New chat" left Recents reading "Nothing yet". Cause: `openNav()` ended with a call to
`updateNavPill()`, a function nothing in the file ever defined. It threw on every open, after the panel was
shown and after `resetNavView()` had put the empty state up, and before the list was fetched and painted --
so the drawer always came up empty while the conversations were sitting on the machine. Removed the call.

Verified live: drawer opens with both rows, no "Nothing yet", no JS errors; pressing "+ New chat" leaves both
rows and both machine records in place.

Two conversations were forgotten at 09:57:06 and 09:57:09 ("Uganda Briefing And World News",
"Machine Capacity And Maintenance"). The per-row bin is the only path in the page that forgets a conversation
and the log records no user agent for it, so who tapped it cannot be proved from the record. Each delete took
its own safety copy first, and both conversations were restored from backups/forget-20261016-095706 (which
holds both, taken before the first removal). The store holds 2 conversations.

Lesson: an undefined call at the end of a UI block is not a harmless warning -- it aborted the paint that
followed it and the screen said there was no history. Check a drawer change by opening it and counting rows,
not by the absence of an error in a console nobody reads.

## Round: the operator confirmed the two deletions were his (16 Oct 2026)

He had deleted "Uganda Briefing And World News" and "Machine Capacity And Maintenance" himself before
retesting. The purge was therefore run again through the app's own clear path: 2 conversations and 2 turns
removed, purge stamp renewed so any device holding a copy drops it, safety copy taken by the endpoint first.
The store is empty and the drawer reads "Nothing yet" because there is nothing -- which is the state he asked
for.

Lesson: reading the record told me the conversations were gone, but not whether that was wanted. A missing
conversation should be restored only after asking, or restored *and* named as restored -- which is what
happened here, and it was still the wrong order. Backup before delete is the rule; ask before restore is its
mirror.

## Round: a new chat inherited the last one's dock, and refused its question (16 Oct 2026)

Reported from real use: in a new chat the stop button behaved as if it belonged to the previous chat, a notice
said it was still answering the last question, and the new question would not send.

Three causes, all confirmed by reproducing the sequence:

1. The dock's state was driven by *any* running turn's events, whatever conversation they belonged to, so a
   turn in another chat painted THINKING/WORKING and raised the stop control on the chat on the screen.
   Fix: `mineHere(d)` -- the machine names every event with its conversation, and only an event belonging to
   the conversation on screen moves the phase and the stop control. The trace is still kept either way.
2. The engine's own reset control (the header's new chat) did not tell the page. The canvas emptied, the
   conversation id stayed, and the dock kept its running state. Fix: it now calls `window.__jarvisNewChat`,
   the page's single new-chat path, and no longer `interrupt()`s the running turn -- a turn belongs to the
   conversation being left and keeps going in it. The fallback path (no page) detaches instead of cancelling,
   clears the dock, and still mints the machine's next window.
3. The refusal itself was correct given (2): `index.html` refuses a send when the live turn is in the same
   conversation, and the id had not changed.

Verified in sequence: a turn running in chat A, New chat pressed -> stop hidden, pill word "Ready", canvas
empty; a question asked in the new chat -> accepted, THINKING then WORKED - 6s, its question standing on the
canvas, no refusal notice; the question landed in its own conversation. The operator's test chats were then
purged through the app's own clear path (7 conversations, 9 turns), leaving the store empty for his retest.

Known gap: the background pill ("JARVIS is working in the background...") appears when a conversation with a
live turn is opened or re-bound, not while a new chat is started over a running one -- so a turn left running
elsewhere is not announced from a fresh canvas. The refusal that used to announce it is gone by design.

## Round: the landing hero could sit over the canvas, and its visibility was animation-dependent (16 Oct 2026)

Reported: the greeting ("What are we building today?" with its suggestion rows) sometimes lands at app start
and then does not leave, misaligned against the composer.

Three defects, in the same mechanism:

1. `hidden` did not take the hero out of the layout. `#empty{ display: grid }` is an ID rule and beats the
   user-agent's `[hidden]` rule, so the element kept its box on screen while every other signal said it was
   gone. Fixed with `#empty[hidden]{ display: none !important }`. Verified: forcing `hidden` computes
   `display: none`.
2. Nothing hid it at the moment of sending -- only the thread's watcher, when it next settled. It now hides
   on the send control itself, so a turn can never start underneath it. Verified: `display: none` two seconds
   after send, and still none when the turn finished.
3. Its opacity came only from the entry animation (`emptyIn ... both`), so whether it was visible depended on
   the animation having run: hidden during boot and it could stay invisible, re-shown at the wrong moment and
   it could hang at zero. It now carries `opacity: 1` and the animation only adds motion. `z-index: 0` on the
   hero and the canvas above it, so the landing can never cover what is being written.

Measured on the landing: the suggestion rows clear the dock by their own band (`chipClearsDock: true`), the
hero's box spans the viewport as designed with the dock's height reserved in its padding.

## Round: the landing's visibility, made deterministic (16 Oct 2026)

The greeting's show/hide was decided by `lastQ`, `answerText`, the artifact panel and a bare child count of
the thread. Those are values the *last* conversation leaves behind: a leftover empty block read as a
committed turn (greeting hidden on a blank screen), and a stale answer read as "there is something here"
(greeting shown over a new chat, which is what the operator photographed). It is now decided by what is
actually on the screen: no conversation adopted, no real turns painted (a child with words in it), and no
turn running. Verified in the page: fresh screen shows the greeting, opening a conversation from the drawer
hides it, New chat brings it back.

Earlier in the same round: `#empty[hidden]{ display: none !important }` (an ID rule setting `display` beats
the user-agent's `[hidden]`, so the hero kept its box while every other sign said it was gone), the hero
hides on the send control as well as when the watcher settles, it carries `opacity: 1` with the entry
animation only adding motion (it used to depend on the animation having run), and it sits at `z-index: 0`
with the canvas above it so it can never cover an answer.

Note: the operator's exact stuck state was not reproduced. His screen showed the greeting over content; mine
showed it hidden on a blank screen. Both are the same rule disagreeing, which is what the deterministic
version removes.

## Round: the Account & Authentication portal (16 Oct 2026)

The User Profile screen was refactored into an account portal, to the operator's directive.

**Identity.** An avatar ("M"), the name, and an Admin badge. The session id, turn counter, messages kept,
turns in flight, uptime, node location, local time, agent socket and gateway unit are gone from this
screen: they were diagnostics on a page whose subject is who he is and what holds access. Verified by
reading the rendered page back -- none of those strings appear.

**Authentication methods.** Three rows, each with what it is, the value behind it, and a status badge.
Every badge is derived at request time from a file that actually holds the thing:
  * Email Address -> the node's own channel directory, taking only the entry attributable to him
    (owner@example.com, Bound, Primary). It does not take the first address it finds: that directory also
    lists people who have written to him, and a customer's address on his account page would be both wrong
    and careless.
  * Google Account -> ~/.hermes/google_token.json, checked by name and by holding a refresh_token.
  * Phone Number -> the config's own admin list (his WhatsApp identity).

**Sessions & security.** The count of sessions holding access, this device, then the two ways out:
  * "Log Out" forgets this device's token, clears its cookie and returns the page to the door.
  * "Log Out of All Devices" revokes every OTHER session and keeps the one asking -- a control that locked
    the hand pressing it would be a trap. Asked for twice; POST /api/account/logout-all with
    confirm="revoke-other-devices". A `dry=1` form answers what it would revoke without revoking anything,
    which is how it was verified without touching the operator's phone.

**A defect found while measuring, and fixed.** The device list was growing by a line per page load: the
keyed sign-in minted a fresh session every visit, by design ("a revocable session per sign-in"), but a
browser that already held a session was signed in again and again. 227 rows had accumulated, most from
testing, the oldest from before scopes existed. A browser already holding a session (device token or the
master key) is now redirected without minting. Verified: three consecutive keyed loads left the count at
227, 227, 227.

**Correction made during the build.** The first version of the Google check searched the tree for
"refresh_token" and reported a binding that did not exist: model request dumps under ~/.hermes/sessions
merely mention the word. A badge is a claim; it is now checked by name, at the two paths the credential is
actually stored at.

## Round: session cleanup, the toggle out, and a real door (16 Oct 2026)

**1. The device list.** It held 227 rows because the label was the raw user agent, so every page load
from the same phone looked like a new device, and nothing was ever revoked. Now:
  * `ua_name()` names a client the way a person would: "Samsung Galaxy A24 (Android 16)", "Windows PC
    (Windows)", "iPhone (iOS 18)". The raw agent is stored for nobody and displayed nowhere.
  * `prune_devices()` keeps ONE live session per named client, newest wins, and drops entries unseen for
    90 days. It takes a safety copy of the file before it writes, and runs at boot and on the account
    page's own read at most every six hours. Verified: 227 -> 5 -> 3 -> 2, ending at exactly the phone
    and the laptop, with every intermediate step snapshotted under backups/devices-prune-*.
  * A browser already holding a session is redirected without minting another (fixed in the previous
    round, kept here): a signed-in browser is not signed in again.

**2. New Conversations (Voice/Text)** removed from the account page, as directed: the input mode is
chosen in the chat dock itself. Verified by reading the page back: the block is gone, the two headings
that remain are "Authentication methods" and "Sessions & security".

**3. The door.** What stood in front was a master key in a URL: copied into histories, logs and
screenshots, and it never expires. An unauthenticated visitor now gets a door (GET /door):
  * Enter the registered address, ask for a code, and it is sent to the owner's own channel by
    `hermes send` ("device", which is what the address list actually supports here). Six digits,
    ten minutes, single use, five wrong guesses allowed; stored as a salted hash, never as the code.
  * An address that is not registered gets the SAME answer as one that is, and no code is sent: whether
    an address is registered is not something a stranger learns from this page.
  * Rate limited at three codes and twelve verifications per IP per fifteen minutes.
  * Redeeming a code mints a device token scoped `full`, in a 30-day HttpOnly/Secure/SameSite=lax
    cookie. Verified over HTTP: 200 + Set-Cookie; the same code refused immediately afterwards; a wrong
    code refused; a stranger's address answered with the generic line.
  * Escape hatches kept on purpose: the pairing-code form still lives at /pair-screen (the door links to
    it) and the keyed address still works, so the door is never the only way in.
  * "Log Out" already clears the token and reloads: it now lands on the door, as directed.

NOT built, and why: Google Sign-In needs a redirect URI registered against the OAuth client in the
Google Cloud console, which only the operator can do, and the credential stored on this node is the
assistant's mail token rather than an identity provider for him. Email+password was left out on purpose:
the directive allowed "password OR OTP", and a code that is never stored beats a password that must be.

## Round: a real sign-in, with accounts, devices and sessions (16 Oct 2026)

**The model.** An account signs in; an account holds devices; a device holds sessions. The same phone is
ONE device whether it opens the web app or the installed app, because a device is keyed by what the client
IS (model and system), never by the surface or the raw agent. "Sessions & security" is now "Devices &
security", and it lists devices with their session counts, not a flat list of loads.

**The account.** `~/.hermes/jarvis_live_accounts.json` holds exactly one account -- the owner's,
owner@example.com, role admin -- with `"signup": "closed"`. It is data, not a hardcoded name. Sign-up is
refused in the sign-in screen itself.

**The sign-in screen.** GET / (unauthenticated) or GET /door: the address, then the code, with Google
beside it and a link to the pairing form. The code is MAILED to the account's own address through the
node's mail channel (`hermes send -t email:<address>`, falling back to the email home channel). Six digits,
ten minutes, single use, five wrong guesses, stored as a salted hash. An address with no account gets the
same answer as one with an account and no mail at all: which addresses exist here is not something the
sign-in page tells a stranger.

**Google.** The flow is built -- /auth/google builds the consent URL and /auth/google/callback exchanges
the code, checks `email_verified`, and signs in only an address that already has an account here.
It is NOT live, for one reason that only the owner can fix: the Google credential on this node is an
INSTALLED client (redirect_uris = http://localhost), and Google only permits those to redirect to
localhost. A client of type "Web application" with https://live.battemohammad.com/auth/google/callback as
its authorised redirect URI is needed; the door reads it from ~/.hermes/jarvis_live_google.json. Until
then the button says exactly that rather than failing silently.

**A defect of mine, found by reading the record and disclosed.** An earlier tidy-up passed already-humanised
device labels back through the user-agent parser. A label has no agent markers, so it degraded to "browser"
-- and the same loop then deleted rows reading "browser", which is how the phone's own paired session was
revoked. The device key is now normalised (`device_key_norm`) so both stored forms group as one device, and
the phone signs in again through the new door with a mailed code. Lesson recorded in the skill: never feed a
stored label back through the agent parser.

## Round: Google sign-in is live (16 Oct 2026)

The operator created a Web-application OAuth client in project pure-coda-506623-s8 with
https://live.battemohammad.com/auth/google/callback registered, and delivered the console's JSON. It was
placed at ~/.hermes/jarvis_live_google.json mode 0600 in the console's own shape ({"web": {...}}), which
the reader now accepts alongside a flat file, and it takes the redirect from the file so the flow and the
console cannot drift apart.

Verified without asking him to test:
  * the door's reader returns the client, and the flow's redirect matches the registered one;
  * the sign-in page now offers "Continue with Google" instead of the "not wired" note;
  * Google ACCEPTS the authorize request the flow builds -- HTTP 302 with no error page, so client id,
    redirect URI and scopes all validate (a mismatch would be a 400 redirect_uri_mismatch);
  * the callback path exercised for real: a wrong state is refused, a missing code is refused, and a
    bogus code reaches the real token exchange and comes back "Google refused the sign-in". The exchange
    is therefore wired to Google, not merely written.

Hygiene: the delivered copy under the upload cache was mode 664 (world-readable) and was deleted; only the
0600 file remains. A client secret that travels through a chat should be rotated when convenient.

## Round: consent once, and a way back into the app (16 Oct 2026)

**Google asked every time, and that was mine.** /auth/google sent prompt=select_account, which forces the
account chooser and the share-name-and-address screen on EVERY sign-in, even with the grant already held.
It now sends prompt=none (silent) with include_granted_scopes, and retries interactively exactly once --
force=1, with a guard against a silent loop -- only when Google answers login_required /
interaction_required / consent_required / account_selection_required. Verified: the built URL carries
prompt=none; the forced retry drops it; a callback carrying interaction_required 302s to the interactive
retry; a real refusal now reports Google's own words ("access denied") instead of a generic line.

**The state no longer depends on a cookie.** The callback had compared the state against a cookie, and the
owner's browser did not carry it back from Google, so he was refused before Google was ever called. States
now live on the node (single use, fifteen minutes) and the callback spends one from there. Verified: a
forged state refused; a real state arriving with NO cookie passes the gate and reaches the token exchange.

**The app could not be brought back, because a browser's cookie never reaches the app's webview.** Server
side is now built: a flow started with ?client=app records that on its state, and the callback hands the
sign-in back as a one-time code (three minutes, single use) via jarvislive://auth?code=..., which the app
redeems at /app/session to mint the session inside its OWN webview. Verified: a minted code lands on / with
the cookie set in the app's jar and cannot be replayed. What remains is the app-side half -- an intent
filter for the jarvislive scheme plus @capacitor/app's appUrlOpen handler -- which needs a rebuilt APK.

**Inside the app the page now says so.** An embedded client is detected from its user agent (Capacitor /
"; wv)" / JARVISLive) and told, next to the Google button, to use the emailed code instead, because a
sign-in completed in a browser belongs to the browser. Verified: the note appears for an embedded agent and
not for a desktop one, and the page's own script receives IN_APP=true/false.

**Back no longer walks into Google.** A plain redirect left the callback in the back stack, so pressing
back returned him to the consent screen. The sign-in now lands through _bounce(), which sets the cookie on
a page that does location.replace('/'), leaving one history entry instead of three.

## Round: the code could not be sent, and the screen has two buttons (16 Oct 2026)

**The send failure was an environment, not the mail.** "Could not send" was a FileNotFoundError: the
jarvis-live user unit gets PATH=/usr/local/sbin:...:/snap/bin with nothing of the user's, so `subprocess`
could not find `hermes` at all -- the mail path itself was never reached. Every direct test had passed
because they ran from a shell where PATH had it. Now the executable is resolved by hand once
(shutil.which, then ~/.local/bin/hermes, then the checkout's venv) and the child is handed a PATH holding
the same directory plus HOME, so anything it spawns resolves too. Verified from the service: "mail will use
/home/ubuntu/.local/bin/hermes", then "sign-in code mailed to owner@example.com" in 4.6 s.

**Two buttons, as he asked.** The screen had three controls and a separate "Continue" that did nothing
until you pressed the other one. It is now: **Email me a code** and **Continue with Google**. The first
sends the code and relabels itself **Sign in**, revealing the code field; pressing it again signs in. One
button, two steps -- the same shape the big apps use. The code field stays hidden until it is needed, and
Enter in either field triggers the same single button.

**The in-app note was ambiguous** ("that button hands off to your browser"), so it now reads: "In the app,
use the code. Google opens your browser and the sign-in stays there, not in the app." Shown only for an
embedded client.

## Round: the settings engine, four domains (16 Oct 2026)

**Where the effects actually live.** The directive asked for the mutations to be wired in build_v1.py. That
file is the BUILD script -- it bundles and hashes static assets when the page is built and is not running when
a turn, a tool call or a spoken reply happens. A control wired there would be a control wired to nothing. The
real layers are server.py (the live process), ~/.hermes/node_ui_config.json (the node's own UI contract) and
~/.hermes/jarvis_live_prefs.json (voice and rate). Those are what changed.

**Four domains, and what each control genuinely does.**
- Appearance: Mode, Material, Density. Density now writes --padding-base, --card-gutter and --font-scale, with
  the layout's existing --pad/--gap/--tscale derived from them, so it moves real geometry rather than only the
  type. Measured on the live page: a paragraph went 13.088px -> 14.3968px at Roomy (exactly x1.1).
- Speech: the voice dropdown (unchanged, account-listed), a rate slider constrained to 0.75-1.50 written into
  the synthesis call itself, and Auto-play audio. Autoplay is a MUTE, not a stop: the engine's gain node goes
  to zero while the graph keeps running, so the ring still moves to the voice with nothing audible. It defaults
  to on, which is what the surface did before the control existed.
- Agent: transcript depth (the cap on the record this screen keeps -- honestly the page's, not the agent's own
  context window, which belongs to the process that owns it), and tool execution as the DEVICE SCOPE -- the
  boundary enforced where work is handed over, not a label over nothing. On a browser carrying the machine's own
  key there is nothing to restrict, so the segment is not drawn and a one-line status says so; paired devices
  get the real switch.
- Maintenance: Clear client cache (localStorage caches, history kept) and Re-sync node config, which drops this
  server's cached reads by their real names (_sys_cache, _MANIFEST_INDEX, IDENTITY_CACHE, VOCAB_CACHE) and
  explicitly does NOT reach into the agent, which owns its own state.

**Removed:** Clear server cache, Reload config, System Telemetry, Restart Gateway, and every paragraph block on
the screen. Two one-line statements remain (the approval consequence, and the keyed-session status) because both
state a consequence rather than describe a feature.

**Errors, both caught before they shipped.**
- The build guard refused the round: I had hand-added a gain node to the engine, and build_v1.py already injects
  one as the page's master volume. The guard counted the output link and stopped the build. Had it shipped, the
  autoplay toggle would have driven a node that was not in the audible path -- a control that does nothing, the
  exact failure this work was meant to avoid. Reverted, and the toggle now drives the build's own seam.
- /api/v1/node/reload returned 500 on first live use: the cache names in the handler were invented rather than
  read (one was NameError). Fixed against the real names and re-verified: dropped 1, ok.

**Verification:** endpoints exercised from the page's own authenticated context (GET+POST /api/v1/node/ui, POST
/api/v1/node/reload, GET /sys/settings with ui + scope); the settings pane read back after opening it the way a
finger does; the four removed strings confirmed absent; density measured on a real element. Test values were
written to the node during the check and have been reset to a neutral, audible default.

## Round: voice phases 0 to 2, and the native ear (16 Oct 2026)

**Phase 0, the baseline.** voice-plan/BASELINE.md carries the measured distribution (478 turns), the
machine facts (4 vCPU, 24 GB, no GPU, no swap) and the non-regression rule for the text surface. Every
figure came from this node, read on the day, not from a document.

**Phase 1, the wait made audible.** Two cues in the cloned voice, rendered by
_make_cues.py, which reads VOICE and SPEED out of server.py so a cue cannot drift from the speaker. The
engine arms a timer at turn start and cancels it at the first token or the first audio, and never fires in
text mode. Verified live: cue logged at 3 s, then real audio, and the second cue suppressed because the
answer beat it.

**Phase 2, words while he speaks.** Every 900 ms of continuous speech the engine asks the local
transcriber about the audio so far: bounded to the last 10 seconds, one pass in flight, newest answer wins,
shown in the box he types in with his own text preserved. Verified: the window maths, the display, and the
preservation of prior text. The repeated pass needs a microphone, so its proof is one turn on the phone.

**Phase 3, the native ear (app side).** NativeEarPlugin.java records raw 16 kHz mono with AudioRecord,
preferring UNPROCESSED, then VOICE_RECOGNITION, then MIC, keeping a rolling 30 second window and returning
one well formed WAV. Levels are published as events, so the page's silence detection is untouched. The
engine uses it when Capacitor reports the plugin and falls back to the webview path after one failure.
Verified in a browser that NATIVE_EAR is null there, that every web mic function survives, and that a text
turn still completes.

**Phase 5 dropped on the evidence.** The keep-warm theory failed against the log: turns after a gap over an
hour had a 1.1 s median first token, against 23.7 s for turns 30 s to 5 min after the last. Warmth is not
the driver; whether the turn had work to do is.
