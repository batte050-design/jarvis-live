# JARVIS App — the plan

**Written:** 13 October 2026 · **scope reduced the same day, at his instruction** (see §9)
**Status:** proposed, nothing built
**Source project:** `/data/apps/jarvis-live` — the voice page at live.battemohammad.com

This document answers two questions and nothing else: **what language the app is built in**, and
**how it gets faster**.

---

## 1. What it is

JARVIS App is the voice page, installed on the phone as an app instead of opened in a browser.

---

## 2. The description, and the one constraint

**What it does.** Exactly what the page does — because it *is* the page. Voice in, voice out, the
visual state, the work trace, pushed panels, the saved conversation, the same designs.

**The constraint, and it governs everything below:**

> The app must work the way the website works. Same designs, same behaviour, same responses. Any
> difference between the app and the page is a **bug**, not a feature.

That is the whole specification for the client. The app is not a place to add things. The only
permitted difference is **where a step of the pipeline physically runs** — on the device instead of
on the server — and only where it produces the same result, faster.

**Not in this plan, deliberately.** A login or account system; a wake word; background listening; and
bundling the interface into the APK as a phase. Each is named here so nothing is silently dropped.
Login is parked rather than refused — it is a separate conversation if it is ever wanted.

---

## 3. The language — what we build it in

Three layers. Only one of them changes.

| Layer | Today | In the app | Change |
|---|---|---|---|
| **Engine** — every route, the agent, the widgets, speech-to-text, the persona | **Python 3** — FastAPI + uvicorn, `server.py`, 4,848 lines, **57 routes**, port 8150, published through a Cloudflare tunnel | **identical** | **None.** Nothing about being an app touches it. |
| **Interface** — what you see and hear | **HTML + CSS + vanilla JavaScript** — `index.html` (1,447 lines), `v1.css` (132 KB), `v1.js` (260 KB) | **identical files, not copied, not edited** | **None.** |
| **App container** — the new part | does not exist | **Capacitor 7** | New |

**So the new code is small, and in two languages:**

- **TypeScript** — a handful of lines of Capacitor configuration.
- **Kotlin** — the Android layer Capacitor generates, plus one hand-written plugin of ours for the
  microphone and the audio player. This is the only genuinely new code in the project.

**The bulk of the app is the JavaScript you already have.** No rewrite, no port, no second design.

### Why Capacitor, and why not the alternatives

- **Capacitor 7 — recommended.** It hosts the existing page inside a native shell, so the design is
  byte-for-byte the design, and it gives us the two things the speed work needs: a real microphone
  and a real audio player.
- **Flutter / Dart — rejected.** It would reuse the parked companion app, and it renders natively,
  which means a *different* interface. The constraint in §2 forbids that.
- **Tauri v2 (Rust) — rejected.** Same interface, but a heavy Rust toolchain and newer mobile
  support. Not worth it.
- **Native Kotlin / Swift — rejected.** Two codebases, no benefit.
- **PWA, no build — the fallback.** Already installable to the home screen today.

### Where it is built

The VPS has **Node 26.7.0** and npm 12.2.0, so the app project lives here. It has **no JDK and no
Android SDK**, and installing them is a multi-gigabyte addition — so the APK is compiled by **GitHub
Actions** (JDK + Android SDK on the runner) and downloaded from there. Nothing heavy lands on this
machine. *(Verified this session: `node -v`, `npm -v`, no `java`, no `~/Android`.)*

---

## 4. The speed

This is the part that matters, and it starts with a number read out of the running service.

**Baseline, from the live service's own log — 99 turns since 10 Oct 2026:**

| What | Measured |
|---|---|
| First token of the reply, ordinary spoken turn | **19–23 seconds** |
| First audio | 20–24 seconds |
| Whole turn finished | **26–36 seconds** |
| Substantive turns | 64 s, 79 s, 84 s, 92 s, 98 s, 118 s, 162 s, 194 s |
| Handover to the deeper layer | `handoff=yes` on nearly every turn, with `work=0.0s` |

Sample lines: `turn 1: tok=19.2s audio=20.2s done=28.7s handoff=yes chars=304`;
`turn 2: tok=20.7s ... done=20.7s`; `turn 5: tok=79.0s done=79.0s chars=1679`.

**What that means.** Nearly every turn hands straight over to the deep agent and then waits, and the
wait is that agent's **cold start** — not the model's thinking, and not the browser. The page is not
slow because it is a web page; it would be slow as a native app too.

**The honest headline, stated once:** *becoming an app is not what makes this fast.* About 20 of
those 28 seconds are server-side. The app is worth building because it is a better place to use the
thing from — but the speed comes from the levers below, and they pay off on the website as well.

**Reference numbers from earlier measurement on this same stack — these are why each lever is worth
doing:**

- front model, first token **0.29 s**
- streaming speech, first sound **0.31 s** — against a finished file at **1.18 s** for ten words and
  **4.35 s** for twenty
- a cold agent run **6–40 s** → this is the 19–23 seconds above
- browser microphone processing: **0.4–0.6 s of usable speech out of a 1.2 s phrase**, measured on a
  real phone

### The levers, in order of what they are worth

1. **Keep the deep layer warm.** One long-lived process instead of a fresh agent per turn. This is
   the ~20 seconds, and it is worth more than everything else here combined. The supported route is
   already on this machine: **`hermes acp`** — JSON-RPC over stdio, built for machine clients. *(The
   interactive PTY route hangs on reply and must not be used.)*
2. **Hold one connection open** instead of a fresh stream per turn. Today every turn pays TLS and
   connection setup again.
3. **Never wait on the deep work.** Answer instantly with a pre-rendered acknowledgement, and let the
   fast lane answer the turns it can, so the handover stops being the default.
4. **Stream the speech sentence by sentence** with one sentence of lookahead, instead of waiting for
   a finished file — 0.31 s to first sound against 1.18–4.35 s. *(To verify: how much of this the
   page already does.)*
5. **Capture the microphone raw, in native code.** The browser's echo canceller, noise suppressor and
   gain control are eating the front of every utterance on the phone. This does not make the reply
   faster; it makes **mis-hearings rarer**, and a repeated question costs 28 seconds. This is the
   biggest *felt* speed win available.
6. **Play audio through the native player**, which has a real clock, instead of Web Audio, whose
   clock can sit suspended at zero with no error.
7. **Optional — recognise short speech on the device**, so a two-word question never travels. Gated
   on accuracy: never ship a recogniser below the accuracy floor, and keep the server path for long
   or mixed speech.
8. **Optional — bundle the interface into the app** so launch paints from the phone's own storage.
   Measure the launch first; if it is already fast, skip this, because it means an app release for
   every design change.

**What none of this fixes, said plainly:** the model's own thinking time, the speech provider's
synthesis time, and the distance from Kampala to the server. A native client cannot beat those.

---

## 5. Ground rules

1. **The app behaves exactly as the page behaves.** A difference is a bug.
2. **No second design, no fork of the surface files.** One source, two consumers.
3. **The engine stays Python.** Porting it buys nothing and risks everything it holds.
4. **Nothing heavy on the VPS.** Builds happen in CI.
5. **No speed claim ships that was not measured on the live public URL that session.**

---

## 6. The build

Phases run in order. No phase starts until the one above it is confirmed **on the phone**.

### Phase 0 — Freeze and measure

**Goal.** A rollback point and a real baseline before anything moves.

**Steps.** Tag `/data/apps/jarvis-live` `pre-app-2026-10-13` and record the commit; run
`tools/turn_probe.py` on three turns (trivial, substantial, voice) against the **public** URL and
keep the output beside the matching `turn N:` log lines; create the app repository
(`/data/apps/jarvis-app`) with a GitHub remote — the live repo has **no remote**, so it cannot host
the build.

**Done when.** The tag exists, three timings are on file, and the new repo can run CI.
**Proof.** The tag, the probe timings next to their log lines, the remote URL.

### Phase 1 — The app as the page is

**Goal.** The page, unchanged, running on the phone. Nothing added, nothing upgraded, **not one line
of the server changed**.

**Steps.** Capacitor init and `npx cap add android`; point the shell at
`https://live.battemohammad.com`; a GitHub Actions workflow builds the APK on a runner with JDK +
SDK; install on the phone and sign in exactly as the browser does; run real turns; note anything that
differs from the browser.

**Done when.** Real turns complete on the phone — **and not one tracked file in
`/data/apps/jarvis-live` has changed.**

**Proof.** `git status --short --untracked-files=no` in the live repo printing nothing, which is the
evidence this phase added nothing (this plan file is untracked and does not count); the APK's build
number; one turn's log line produced from the phone.

**Said plainly:** this looks and behaves like the page, because it is the page. It is the container
and the build pipeline, not a speed-up. Expecting a difference here is how this gets judged unfairly.

### Phase 2 — The speed phase

**Goal.** The 19–23 second wait removed, with the app behaving exactly as before.

**Steps.** Stand up the warm deep layer on `hermes acp` — one long-lived process; scope its session
per surface and age it out; hold one connection per client instead of a stream per turn; keep the
fast lane in front with a pre-rendered acknowledgement; confirm the speech streams per sentence. Then
re-measure the **same three turns**, same method, same hour.

**Done when.** First-token time is materially below the Phase 0 baseline and nothing else regressed —
capture accuracy, gate release, stream latency and history pairing all re-checked, not only the
number being chased.

**Proof.** A before/after table of first-token, first-audio and total time from the log, same three
questions, with the environment named for each measurement. *Estimated: most of the 20 seconds
recovered. An estimate is not a measurement — the table replaces it.*

### Phase 3 — Native microphone and player

**Goal.** Audio straight from the hardware, in and out, with no change in behaviour.

**Steps.** A Kotlin plugin capturing raw 16 kHz mono with a ~1 s pre-roll and no browser processing,
handed to the existing speech endpoint unchanged; a native player receiving the streamed audio with
its own clock. Keep the browser path as the fallback.

**Done when.** The same sentence, captured both ways, transcribes the same or better, and the page's
state machine still reads listening → thinking → speaking correctly.

**Proof.** Both transcripts side by side for one recorded clip, with timings, and the state
transitions observed on a live turn.

### Phase 4 — Ship

**Goal.** A signed APK, installed once and kept.

**Steps.** Release signing key generated and stored **off** the VPS and out of git; CI signs from
secrets; `gh release create` with the APK; distribution by direct download (GitHub's release CDN
stalls on some phone browsers — a static host behind the existing tunnel is the known-good route); a
build marker visible in the app so a fault report names the build it came from.

**Done when.** A signed, versioned APK is installed from a link, and its turns appear in the service
log with the build number attached.

**Proof.** The release URL, the signature, one log line carrying the new build id.

### After Phase 4 — measure, then decide

Levers 7 and 8 stay unbuilt until there is a number to justify them: on-device recognition only if
short turns are measurably slower than they need to be, at or above the accuracy floor; bundling only
if launch-to-painted is slow.

---

## 7. Risks, ranked

1. **The CI build with no local toolchain.** Nothing heavy here by choice, so everything depends on
   the runner working. Mitigated by an already-proven workflow on the companion app's repo.
2. **Phase 2 is both the biggest win and the fiddliest work** — a warm process and session lifecycle,
   with one known hazard on this stack: a stale session once resumed an old task and restarted the
   live service. A turn's tool events must contain only tools the question can explain.
3. **Parity drift.** Two consumers of one surface file set diverge the moment someone edits the app's
   copy. The mitigation is the ground rule: the app copies nothing.

**Fallback, if the app stalls:** the page is already installable to the home screen as a PWA. No
build, no release, working today.

**Conflict with an existing plan:** the parked Flutter companion app targets the same brain with a
different interface. Two clients will diverge; one should be designated *the* app and the other
frozen. Raised here, not decided here.

---

## 8. How to work in the repository

- The surface's source of truth stays `/data/apps/jarvis-live`. `index_v1.html` is **generated** by
  `build_v1.py` — edit the builder, never the output.
- The app repository holds **no copy** of the surface files. It loads them.
- Never hand-edit `widgets/`, `backups/`, `models/`, `venv/`, or the session/artifact JSON.
- Restarting the live service cuts every open stream mid-answer — drain the turn in flight first.

---

## 9. Status

- **Scope reduced, 13 Oct 2026, at his instruction.** The document now carries only the two things
  asked of it — the language and the speed — with the app required to work exactly as the website
  works. Cut from it: secure login and accounts, wake word and background listening, interface
  bundling as a phase, and the earlier operator directive section that carried them. Login is parked,
  not refused.
- **Plan only.** Nothing has been built. The live page is untouched; this file is untracked.
- **The baseline is real** — 99 turns read on 13 Oct 2026, and **19–23 seconds to first token** is the
  number to beat.
- **Blocked externally:** nothing in this scope.
