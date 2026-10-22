#!/usr/bin/env python3
"""Build index_v1.html: the reimagined page, on the engine that already works.

The engine block from index.html is carried over byte for byte, with a few additive,
guarded hook lines inserted so the new surface can react to the voice. Nothing about capture,
sample rate, playback or the speech service is touched: the audio is the part that works.

This file owns the page SHELL only: the head, the body markup the stylesheet and hud script
expect, and the version stamps. Every asset is stamped with its own content hash, so an edit
can never be served from a cache holding the previous copy.
"""
import hashlib
import re
import subprocess
import tempfile
import os
import sys

HERE = "/data/apps/jarvis-live"
SRC = os.path.join(HERE, "index.html")
OUT = os.path.join(HERE, "index_v1.html")
CSS = os.path.join(HERE, "static", "v1.css")
JS = os.path.join(HERE, "static", "v1.js")

GROUND = "#0A0A0B"                      # the one token the ground, the seams and theme-color share
LIGHT_GROUND = "#FBFAF7"                # the light theme's ground, from the same token set

src = open(SRC, encoding="utf-8").read()
lines = src.split("\n")

head = "\n".join(lines[0:13])                 # lines 1-13: everything up to <style>
# The engine runs from its opening <script> to its matching </script>. Both ends are FOUND, not
# numbered: a fixed slice silently cut the closing tag off the moment anything above the block
# changed length, and the build then failed with a script-tag count that named the symptom and
# not the cause.
try:
    _OPEN = next(i for i, l in enumerate(lines) if l.strip() == "<script>")
    _CLOSE = next(i for i, l in enumerate(lines) if i > _OPEN and l.strip() == "</script>")
except StopIteration:
    sys.exit("build refused: could not find the engine's <script> ... </script> block")
engine = "\n".join(lines[_OPEN:_CLOSE + 1])   # the whole engine, verbatim
if not engine.startswith("<script>") or not engine.endswith("</script>"):
    sys.exit("build refused: the engine block is not a complete script element")

# --- the head, corrected for a phone -----------------------------------------------------------------
# L2: interactive-widget=resizes-content keeps the visual viewport honest when the keyboard opens.
_vp_old = 'content="width=device-width, initial-scale=1, viewport-fit=cover"'
_vp_new = ('content="width=device-width, initial-scale=1, viewport-fit=cover, '
           'interactive-widget=resizes-content"')
if _vp_old not in head:
    sys.exit("build refused: the viewport meta is not the one this build expects")
head = head.replace(_vp_old, _vp_new)
# L9: one token for the ground, the theme colour and the raised surfaces, so no seam can appear.
if '<meta name="theme-color" content="#05070A">' not in head:
    sys.exit("build refused: the theme-color meta is not the one this build expects")
head = head.replace('<meta name="theme-color" content="#05070A">',
                    '<meta name="theme-color" content="%s" media="(prefers-color-scheme: dark)">\n'
                    '<meta name="theme-color" content="%s" media="(prefers-color-scheme: light)">\n'
                    '<meta name="color-scheme" content="dark light">' % (GROUND, LIGHT_GROUND))

# --- the engine hooks, additive and guarded ----------------------------------------------------------
engine = engine.replace(
    "analyser.getByteFrequencyData(freq);",
    "analyser.getByteFrequencyData(freq);\n"
    "      try { window.__jarvisLevel && window.__jarvisLevel(freq, 'out'); } catch(e) {}")
engine = engine.replace(
    "micAnalyser.getByteFrequencyData(micFreq);",
    "micAnalyser.getByteFrequencyData(micFreq);\n"
    "      try { window.__jarvisLevel && window.__jarvisLevel(micFreq, 'in'); } catch(e) {}")
if engine.count("__jarvisLevel(freq, 'out')") != 1 or \
   engine.count("__jarvisLevel(micFreq, 'in')") != 1:
    sys.exit("engine hook insertion failed: %d/%d" % (engine.count("__jarvisLevel(freq, 'out')"),
                                                      engine.count("__jarvisLevel(micFreq, 'in')")))
# B9: the ordered reply, handed over rather than re-parsed. The engine already accumulates the
# tokens in order into the turn's own transcript; one guarded call publishes it, so the page stops
# reading the stream a second time behind the engine's back. Additive: nothing here changes what the
# engine does with its own variable. The accumulation lives on the turn's context rather than in a
# bare variable, because a turn now belongs to a conversation rather than to the connection it was
# asked down: two conversations can be in flight at once and each keeps its own words.
_ORD = "ctx.spoken += (d.d || '');"
if engine.count(_ORD) != 1:
    sys.exit("build refused: the token accumulation line appears %d times" % engine.count(_ORD))
engine = engine.replace(
    _ORD,
    _ORD + "\n      if (window.__jarvisOrdered) try { window.__jarvisOrdered(ctx.spoken); } catch (e) {}")
if engine.count("window.__jarvisOrdered(ctx.spoken)") != 1:
    sys.exit("build refused: the ordered-text hook is not in exactly one place")

# The output mute. The engine connects its analyser straight to the destination, so there was no
# node a mute control could act on and any attempt to mute the voice had to suspend the audio
# clock (which freezes the caption pacing and the level meter). One guarded insertion puts a gain
# node in that single link; it becomes the page's master volume and nothing else in the audio
# path changes. There is exactly one `.connect(AC.destination)` in the engine.
_DEST = "analyser.connect(AC.destination);"
if engine.count(_DEST) != 1:
    sys.exit("build refused: the analyser-to-destination link appears %d times" % engine.count(_DEST))
engine = engine.replace(
    _DEST,
    "var __jg = AC.createGain(); analyser.connect(__jg); __jg.connect(AC.destination);\n"
    "    try {\n"
    "      window.__jarvisOut = __jg;\n"
    "      // Auto-play audio is a mute, not a stop: the graph keeps running, so the ring still moves\n"
    "      // to the voice while nothing reaches the speaker. Created already-muted when the page said so.\n"
    "      __jg.gain.value = (window.__jarvisAutoPlay === false) ? 0 : 1;\n"
    "      window.__jarvisSetAudio = function (on) {\n"
    "        window.__jarvisAutoPlay = !!on;\n"
    "        try { __jg.gain.value = on ? 1 : 0; } catch (err) {}\n"
    "        return !!on;\n"
    "      };\n"
    "    } catch (e) {}")

# A direct arm/disarm seam for the microphone. The engine's mic button doubles as the interrupt
# (during playback a tap stops him and starts a capture), so the live-voice strip cannot use it to
# close the microphone without cutting the answer. This sets the arm state and nothing else.
_ARM = "window.__jarvisArm = () => { earArmed = true; return earArmed; };"
if engine.count(_ARM) != 1:
    sys.exit("build refused: the arm seam appears %d times" % engine.count(_ARM))
engine = engine.replace(
    _ARM,
    _ARM + "\n"
    "window.__jarvisEar = on => {\n"
    "  earArmed = !!on;\n"
    "  if (!earArmed && typeof earRecording !== 'undefined' && earRecording) endCapture();\n"
    "  syncMic();\n"
    "  if (typeof setState === 'function') setState(earArmed ? 'listening' : (playing ? 'speaking' : 'idle'));\n"
    "  return earArmed;\n"
    "};")

if "micCtx = new AudioContext({ sampleRate: 16000 })" not in engine:
    sys.exit("engine changed: 16 kHz capture line not found")
if "FISH" in engine and "mp3" not in engine:
    sys.exit("engine changed: playback path not found")

# The turn's own options travel with the question: how hard to think, and whether this one wants the
# web. The page publishes the options and the engine merges them into the body it builds, so the engine
# still owns the request and the page still owns the settings. This guard is what stops the two controls
# silently doing nothing: the merge has to be in exactly one place, and that place is openStream, because
# a re-bind to a turn in flight must not re-send them (the turn is already running).
_OPTS = "window.__jarvisTurnOpts ? window.__jarvisTurnOpts() : null"
if engine.count(_OPTS) != 1:
    sys.exit("build refused: the turn-options seam appears %d times" % engine.count(_OPTS))

# --- the shell ---------------------------------------------------------------------------------------
# Every id the engine looks up by name is present and keeps its name: c, heard, doing, err,
# fallback, mic, q, send, typing, reset. `doing` is the engine's own state word and is not shown;
# the page writes its own label, with a shape, in the bottom bar.
#
# The header is three controls only — menu, the wordmark, a new conversation. The old work line,
# history and text-size controls stay in the document because the engine and the older sheet code
# still bind to them, but they are retired from the header: their jobs live in the drawer.
BODY = """<body data-state="idle">
<canvas id="c" aria-hidden="true"></canvas>

<header id="top">
  <button id="menu" type="button" aria-label="Menu" aria-expanded="false" aria-controls="navpanel">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true"><path d="M4 7.5h16M4 12h11M4 16.5h16"/></svg>
  </button>
  <span id="brand" aria-hidden="true">JARVIS</span>
  <button id="newchat" type="button" aria-label="Start a new conversation">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5H5.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V12"/><path d="M18.4 2.7a2.13 2.13 0 0 1 3 3l-7.5 7.5-3.9.9.9-3.9z"/></svg>
  </button>
  <button id="work" type="button" aria-label="Show what JARVIS did"></button>
  <button id="clock" type="button" title="Past turns" aria-label="Past turns">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.6"/><path d="M12 7.4V12l3.2 2"/>
    </svg>
  </button>
  <button id="size" type="button" title="Text size" aria-label="Text size"><span aria-hidden="true">Aa</span></button>
  <button id="modeBtn" type="button" aria-label="Reply mode: voice. Press to switch.">Voice</button>
</header>

<main id="content" tabindex="-1">
  <div id="view">
    <div id="empty" hidden>
      <div class="hero">
        <svg class="bootmark" viewBox="0 0 44 44" aria-hidden="true">
          <!-- The Angular J: a bevel-cut stem that turns hard into its foot, and the detached
               slash at upper left. Two solid shapes, no outline, no ring, no glow. -->
          <path class="j-stem" d="M29 6v19.5L14 40"/>
          <path class="j-slash" d="M6 25.4V15.8L15.4 6.4v9.6z"/>
        </svg>
        <p id="greet">What are we building today?</p>
        <p id="greet-sub">Plan, research, analyze, build. I’ll handle the work with you.</p>
      </div>
      <div id="suggests" role="group" aria-label="Quick prompts">
        <button type="button" data-mode="send" data-ask="Run a system check on this machine and tell me what needs attention."><span class="si" aria-hidden="true">&#x1FA7A;</span><span class="st">Check server health</span></button>
        <button type="button" data-mode="send" data-ask="Look at my projects and tell me what is unfinished and what I should do next."><span class="si" aria-hidden="true">&#x1F4CA;</span><span class="st">Project status</span></button>
        <button type="button" data-mode="fill" data-ask="Search the web for: "><span class="si" aria-hidden="true">&#x1F310;</span><span class="st">Search the web</span></button>
        <button type="button" data-mode="send" data-ask="Read the newest script on this machine and tell me what you would change."><span class="si" aria-hidden="true">&#x1F4BB;</span><span class="st">Review the latest code</span></button>
        <button type="button" data-mode="send" data-ask="Give me a briefing on Uganda first, then the world: what happened overnight and what matters today."><span class="si" aria-hidden="true">&#x1F4F0;</span><span class="st">Kampala morning briefing</span></button>
      </div>
    </div>
    <div id="thread" aria-label="Earlier turns in this conversation"></div>
    <p id="heard"></p>
    <p id="question"></p>
    <!-- The question's own controls, on the message rather than only on the answer: the prompt is
         copyable and it is editable, and the live row is built here while an older turn's row is
         built with that turn. -->
    <div id="qacts" hidden>
      <button id="qcopy" type="button" aria-label="Copy this question" title="Copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.6" y="8.6" width="11.4" height="11.4" rx="2.4"/><path d="M15.4 8.6V6.4a2.4 2.4 0 0 0-2.4-2.4H6.4A2.4 2.4 0 0 0 4 6.4v6.6a2.4 2.4 0 0 0 2.4 2.4h2.2"/></svg></button>
      <button id="qedit" type="button" aria-label="Edit this question" title="Edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>
    </div>
    <div id="artifact"></div>
    <div id="speak">
      <div id="stages">
        <span id="state" aria-live="polite" aria-atomic="true"><i class="shape" aria-hidden="true"><s></s><s></s><s></s></i><b class="word"></b><i class="secs" aria-hidden="true"></i></span>
        <span id="meta" hidden></span>
      </div>
      <p id="answer" aria-live="polite" aria-atomic="false"></p>
      <p id="caption" aria-live="polite" aria-atomic="false"></p>
      <div id="acts" hidden>
        <button id="copy" type="button" aria-label="Copy this answer" title="Copy"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.6" y="8.6" width="11.4" height="11.4" rx="2.4"/><path d="M15.4 8.6V6.4a2.4 2.4 0 0 0-2.4-2.4H6.4A2.4 2.4 0 0 0 4 6.4v6.6a2.4 2.4 0 0 0 2.4 2.4h2.2"/></svg></button>
        <button id="share" type="button" aria-label="Share or export this answer" title="Share"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15.4V3.6"/><path d="m7.7 7.9 4.3-4.3 4.3 4.3"/><path d="M4.4 14.2v4.2a2 2 0 0 0 2 2h11.2a2 2 0 0 0 2-2v-4.2"/></svg></button>
        <button id="again" type="button" aria-label="Ask this question again" title="Regenerate"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg></button>
      </div>
    </div>
  </div>
</main>

<!-- Back to the latest. Outside the dock on purpose: the dock's measured height is what the scroll's
     foot padding is derived from, so a control parked inside it would be counted into that number
     and lift the last line of every answer. Here it rides above the dock and costs it nothing. -->
<button id="tobottom" type="button" aria-label="Back to the latest" hidden>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5.5v12.4"/><path d="M6.6 12.5 12 17.9l5.4-5.4"/></svg>
</button>

<div id="bar">
  <p id="err" role="alert"></p>
  <p id="offline" role="status" hidden>Offline. JARVIS needs a connection.</p>
  <p id="toast" role="status" aria-live="polite" hidden></p>
  <div id="chips" aria-label="Attached files and links"></div>
  <div id="composer">
    <button id="plus" type="button" aria-label="Add a document, an image or a live capture" aria-expanded="false" aria-controls="attachpop">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
    </button>
    <div id="fallback">
      <textarea id="q" rows="1" autocomplete="off" spellcheck="false" placeholder="Type or ask JARVIS" aria-label="Type or ask JARVIS"></textarea>
      <button id="typingx" type="button" aria-label="Close typing">Close</button>
      <button id="send" type="button" aria-label="Send">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h13"/><path d="M12.5 6.2 18.3 12l-5.8 5.8"/></svg>
      </button>
    </div>
    <div id="bar3">
      <button id="typing" type="button" title="Type instead" aria-label="Type to JARVIS instead of talking">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <rect x="1.6" y="6" width="20.8" height="12" rx="2.6"/>
          <path d="M5.6 9.6h.01M9.2 9.6h.01M12.8 9.6h.01M16.4 9.6h.01M6.6 14.4h10.8"/>
        </svg>
      </button>
      <button id="mic" type="button" title="Talk" aria-label="Talk to JARVIS">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="9.1" y="2.6" width="5.8" height="11.2" rx="2.9"/>
          <path d="M5.4 11.4a6.6 6.6 0 0 0 13.2 0M12 18v3.2M8.6 21.2h6.8"/>
        </svg>
      </button>
      <button id="live" type="button" title="Live voice" aria-label="Start live voice mode">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" aria-hidden="true">
          <path d="M4 10.4v3.2M8 7.2v9.6M12 4.4v15.2M16 7.2v9.6M20 10.4v3.2"/>
        </svg>
      </button>
      <button id="reset" type="button" title="Start a new conversation" aria-label="Start a new conversation. Press twice to confirm.">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 11a8 8 0 1 0-2.6 5.9"/><path d="M20 4.5V11h-6.5"/>
        </svg>
      </button>
    </div>
    <button id="stopin" type="button" hidden aria-label="Stop JARVIS"><span class="stopsq" aria-hidden="true"></span></button>
    <div id="voicestrip" hidden>
      <span id="vwave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
      <b id="vtime">Live</b>
      <button id="vmute" type="button" aria-pressed="false" aria-label="Mute JARVIS">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 9.5h3l4-3.5v12l-4-3.5H4z"/><path d="M16 9.2a4 4 0 0 1 0 5.6"/><path d="M14 6.6a7.4 7.4 0 0 1 0 10.8"/>
        </svg>
      </button>
      <button id="vend" type="button" aria-label="End live voice">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 6l12 12M18 6L6 18"/>
        </svg>
      </button>
    </div>
  </div>
  <div id="level" aria-hidden="true"><i></i></div>
</div>

<div id="nav" hidden>
  <div id="navscrim"></div>
  <nav id="navpanel" role="dialog" aria-modal="true" aria-label="Menu">
    <!-- Two pages on one track. The menu is the first; a destination is the second, arriving from
         the right edge so a menu row reads as going deeper rather than as a sheet thrown over the
         canvas. Back is that same motion run backwards. -->
    <div id="navtrack">
      <div id="navroot" class="navpage">
    <button id="navnewchat" class="navcta" type="button">
      <span class="aic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M12 5.4v13.2M5.4 12h13.2"/></svg></span>
      <span class="ncta">New chat</span>
    </button>
    <div id="navscroll">
    <div class="navsec">Tools &amp; Agent Engine</div>
    <button class="navrow" type="button" data-go="skills">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3.6" y="3.6" width="7" height="7" rx="2"/><rect x="13.4" y="3.6" width="7" height="7" rx="2"/><rect x="3.6" y="13.4" width="7" height="7" rx="2"/><rect x="13.4" y="13.4" width="7" height="7" rx="2"/></svg>
      <span>Skills</span>
    </button>
    <button class="navrow" type="button" data-go="automations">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3.6" y="5.2" width="16.8" height="15" rx="2.6"/><path d="M3.6 10h16.8M8.4 3.4v3.6M15.6 3.4v3.6"/></svg>
      <span>Automations</span>
    </button>
    <button class="navrow" type="button" data-go="mcp">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2.8v4.6M15 2.8v4.6"/><path d="M6.4 7.4h11.2v3.2a5.6 5.6 0 0 1-11.2 0z"/><path d="M12 16.2v5"/></svg>
      <span>MCP / Connectors</span>
    </button>
    <button class="navrow" type="button" data-go="channels">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.3"/><path d="M7.9 7.9a5.8 5.8 0 0 0 0 8.2M16.1 7.9a5.8 5.8 0 0 1 0 8.2"/><path d="M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/></svg>
      <span>Channels</span>
    </button>
    <button class="navrow" type="button" data-go="plugins">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.2 3.6h3.6v1.9a1.6 1.6 0 1 0 3.2 0V3.6h3.4v3.6h-1.9a1.6 1.6 0 1 0 0 3.2h1.9v3.6h-3.6v1.9a1.6 1.6 0 1 1-3.2 0v-1.9H6.8V10.4h1.9a1.6 1.6 0 1 1 0-3.2H6.8V3.6z"/></svg>
      <span>Plugins</span>
    </button>
    <div class="navdiv" role="separator"></div>
    <div class="navsec" id="navpinssec" hidden>Pinned</div>
    <div id="navpins"></div>
    <div class="navsec" id="navrecsec" hidden>Recents</div>
    <div id="navrecents"></div>
    <div class="navspacer" aria-hidden="true"></div>
        </div>
    <div id="navfoot">
    <div class="navcard">
      <button id="navprofile" type="button" class="ncardid" aria-label="Open your profile">
        <span class="av" aria-hidden="true">M</span>
        <span class="nw"><b>Mohammad</b><span class="nrole">Admin</span></span>
      </button>
      <button id="navgear" type="button" class="ngear" aria-label="Settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12.22 2.6h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/></svg>
      </button>
    </div>
    </div>
      </div>
      <section id="navdetail" class="navpage" aria-labelledby="navdetailtitle">
        <header id="navdetailhead">
          <button id="navback" type="button" aria-label="Back to the menu">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.6 5.4 8 12l6.6 6.6"/></svg>
            <span>Back</span>
          </button>
          <h2 id="navdetailtitle">Menu</h2>
        </header>
        <div id="navdetailbody" class="pane" role="region" aria-label="Menu page"></div>
      </section>
    </div>
  </nav>
</div>

<div id="page" hidden aria-labelledby="pagetitle">
  <header id="pagehead">
    <button id="pageback" type="button" aria-label="Back to the menu">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M15 5.5 8.5 12 15 18.5"/></svg>
      <span>Back</span>
    </button>
    <h2 id="pagetitle">Settings</h2>
    <button id="pageact" type="button" class="p-actbtn">Done</button>
  </header>
  <div id="pagebody" class="pane"></div>
</div>
<div id="attach" hidden>
  <div id="attachscrim"></div>
  <div id="attachpop" role="dialog" aria-modal="true" aria-label="Add something to this message">
    <div class="grab" aria-hidden="true"></div>
    <header id="atthead">
      <button id="attachx" type="button" aria-label="Close this menu">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>
      </button>
      <h2>Add to chat</h2>
    </header>
    <div id="attachrows">
    <div id="attachmedia" role="group" aria-label="Add something to this message">
      <button id="attachcam" type="button" class="tile" aria-label="Camera: live vision capture">
        <span class="aic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 9.2A2.2 2.2 0 0 1 5.7 7h1.1l.9-1.7a1 1 0 0 1 .9-.55h6.8a1 1 0 0 1 .9.55L17.2 7h1.1a2.2 2.2 0 0 1 2.2 2.2v8.1a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z"/><circle cx="12" cy="13.2" r="3.5"/></svg></span>
        <span class="tt">Camera</span>
      </button>
      <button id="attachimage" type="button" class="tile" aria-label="Photos: from the gallery">
        <span class="aic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="8.7" cy="9.6" r="1.6"/><path d="M4 17.2l4.6-4.4 3.1 3 2.9-2.6 5.4 5"/></svg></span>
        <span class="tt">Photos</span>
      </button>
      <button id="attachfile" type="button" class="tile" aria-label="Files: documents, audio and assets">
        <span class="aic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7.5A1.5 1.5 0 0 0 6 4.5v15A1.5 1.5 0 0 0 7.5 21h9a1.5 1.5 0 0 0 1.5-1.5V7z"/><path d="M14 3v4.5h4.5"/><path d="M9 13.5h6M9 17h4"/></svg></span>
        <span class="tt">Files</span>
      </button>
    </div>
      <button id="attachreason" type="button" role="menuitem" class="arow">
        <span class="aic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.6 4.3A3.3 3.3 0 0 0 6.3 7.6 3.05 3.05 0 0 0 4.8 13a3.15 3.15 0 0 0 2.7 4.1 2.85 2.85 0 0 0 5.3-1.1V6.7a2.4 2.4 0 0 0-3.2-2.4z"/><path d="M14.4 4.3a3.3 3.3 0 0 1 3.3 3.3A3.05 3.05 0 0 1 19.2 13a3.15 3.15 0 0 1-2.7 4.1"/><path d="M9.3 9.6h1.8M9.3 13.2h1.8"/></svg></span>
        <span class="atx"><b>Thinking depth</b><i id="reasonlevel">Auto</i></span>
        <span class="achev" aria-hidden="true">&#8250;</span>
      </button>
      <button id="attachweb" type="button" role="menuitemcheckbox" aria-checked="false" class="arow">
        <span class="aic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M3.4 12h17.2M12 3.4c2.4 2.4 2.4 14.8 0 17.2-2.4-2.4-2.4-14.8 0-17.2z"/></svg></span>
        <span class="atx"><b>Always search the web</b><i id="websub">JARVIS searches when it needs to</i></span>
        <span class="xswitch" aria-hidden="true"><span class="xknob"></span></span>
      </button>
      <button id="qtmemory" type="button" role="menuitemcheckbox" aria-checked="true" class="arow">
        <span class="aic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.6 20.4 8 12 12.4 3.6 8z"/><path d="M4.7 12.3 12 16.2l7.3-3.9"/><path d="M4.7 16.1 12 20l7.3-3.9"/></svg></span>
        <span class="atx"><b>Use memory</b><i id="memusage">remembers things from other chats</i></span>
        <span class="xswitch on" aria-hidden="true"><span class="xknob"></span></span>
      </button>
      <button id="qtpermissions" type="button" role="menuitemcheckbox" aria-checked="false" class="arow">
        <span class="atx"><b>Auto-approve</b><i id="permsub">asks before making changes</i></span>
        <span class="xswitch" aria-hidden="true"><span class="xknob"></span></span>
      </button>
    </div>
    <div id="reasonpanel" hidden>
      <button id="reasonback" type="button" class="arow aback">
        <span class="aic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5.5 8.5 12 15 18.5"/></svg></span>
        <span class="atx"><b>Back</b></span>
      </button>
      <button id="rvauto" type="button" role="menuitemradio" data-rv="auto" aria-checked="true" class="arow">
        <span class="atx"><b>Auto</b><i>Balanced, and still fast</i></span>
        <span class="rtick" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12.6 10 17l8.5-9.4"/></svg></span>
      </button>
      <button id="rvnone" type="button" role="menuitemradio" data-rv="none" aria-checked="false" class="arow">
        <span class="atx"><b>Off</b><i>No reasoning at all</i></span>
        <span class="rtick" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12.6 10 17l8.5-9.4"/></svg></span>
      </button>
      <button id="rvmedium" type="button" role="menuitemradio" data-rv="medium" aria-checked="false" class="arow">
        <span class="atx"><b>Medium</b><i>Thinks it through, every turn</i></span>
        <span class="rtick" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12.6 10 17l8.5-9.4"/></svg></span>
      </button>
      <button id="rvhigh" type="button" role="menuitemradio" data-rv="high" aria-checked="false" class="arow">
        <span class="atx"><b>High</b><i>Thinks hard, every turn</i></span>
        <span class="rtick" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12.6 10 17l8.5-9.4"/></svg></span>
      </button>
      <button id="rvmax" type="button" role="menuitemradio" data-rv="max" aria-checked="false" class="arow">
        <span class="atx"><b>Max</b><i>The longest think this model has</i></span>
        <span class="rtick" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12.6 10 17l8.5-9.4"/></svg></span>
      </button>
    </div>
    <div id="attachtools" hidden>
      <button id="attachback" type="button" class="arow aback">
        <span class="aic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5.5 8.5 12 15 18.5"/></svg></span>
        <span class="atx"><b>Back</b></span>
      </button>
      <button id="qtweb" type="button" role="menuitemcheckbox" aria-checked="false" class="arow">
        <span class="aic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8"/><path d="M12 3.6c2.4 2.3 3.6 5.2 3.6 8.4S14.4 18.1 12 20.4c-2.4-2.3-3.6-5.2-3.6-8.4S9.6 5.9 12 3.6z"/></svg></span>
        <span class="atx"><b>Web search override</b><i>Force live search for next turn</i></span>
        <span class="xswitch" aria-hidden="true"><span class="xknob"></span></span>
      </button>
    </div>
  </div>
  <!-- Three pickers, three different doors, and the difference is the accept attribute.
       Files carries accept="*/*" and no capture: an unconstrained input is what makes Android and
       iOS open the document provider's own drawer (Recent / Audio / Documents / Downloads /
       Internal storage) rather than the photo picker.
       Photos and Camera are IMAGES only. Video is the one kind this line refuses, and it is refused
       at the upload as well, so a video picked through the wide Files door is refused too. -->
  <input id="fileinput" type="file" multiple hidden accept="*/*">
  <input id="imageinput" type="file" multiple hidden accept="image/*">
  <input id="caminput" type="file" hidden accept="image/*" capture="environment">
</div>

<div id="sheet" hidden>
  <div id="scrim"></div>
  <section id="sheetpanel" role="dialog" aria-modal="true" aria-labelledby="sheettitle">
    <header><h2 id="sheettitle">Steps</h2><button id="sheetx" type="button" aria-label="Close">Close</button></header>
    <div id="steps" class="pane"></div>
  </section>
</div>

<!-- The one question the page asks before it destroys something. A small card rather than a sheet:
     the Steps sheet carries drag-to-dismiss springs and a grabber, and a confirmation should not be
     something you can flick away by accident. The wording is the operator's own. -->
<div id="confirm" hidden>
  <div id="confirmscrim"></div>
  <div id="confirmcard" role="alertdialog" aria-modal="true" aria-labelledby="confirmtitle" aria-describedby="confirmbody">
    <h2 id="confirmtitle">Clear all local chat history?</h2>
    <p id="confirmbody">The conversations kept on this device go, and so do the session logs behind them. This cannot be undone.</p>
    <div id="confirmacts">
      <button id="confirmkeep" type="button" class="cbtn">Keep</button>
      <button id="confirmgo" type="button" class="cbtn go">Clear</button>
    </div>
  </div>
</div>

<p id="doing"></p>
"""


def stamp(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:10]


out = (
    head + "\n"
    # The build the page itself was made from. An installed app keeps its page alive across
    # launches, so a fix can be live on the server and invisible on his phone; the page compares
    # this against the server and reloads itself when they differ.
    '<meta name="jl-build" content="%s|%s|%s">\n' % (stamp(CSS), stamp(JS), stamp(_APPROVALS) if "_APPROVALS" in globals() else "") +
    '<link rel="stylesheet" href="/static/v1.css?v=%s">\n' % stamp(CSS)
    + "</head>\n"
    + BODY
    + engine + "\n"
    '<script src="/static/v1.js?v=%s"></script>\n' % stamp(JS)
    + "</body>\n</html>\n"
)

# The engine arrives already wrapped in its own <script> tags. Wrapping it twice leaves an empty
# script element whose contents begin with the text "<script>", and the browser then refuses the
# whole engine with a syntax error: the page draws, and nothing on it responds.
for pattern, why in (("<script>\n<script>", "the engine is wrapped in a second script tag"),
                     ("</script>\n</script>", "the engine is closed twice")):
    if pattern in out:
        sys.exit("build refused: " + why)
# One external script rides with the engine: v1.js.
EXPECTED_EXTERNAL = 1
if out.count("<script") != engine.count("<script") + EXPECTED_EXTERNAL:
    sys.exit("build refused: script tag count %d does not match the engine's plus %d"
             % out.count("<script"))
if out.count("<script") != out.count("</script"):
    sys.exit("build refused: %d script tags opened, %d closed"
             % (out.count("<script"), out.count("</script")))
# The console's own policy rests on a per-response nonce, so the engine's inline script carries a
# placeholder the server fills in. Only the opening tag is touched: the engine's body is carried
# byte for byte. Exactly one bare <script> may exist, or the substitution is ambiguous.
NONCE = "{{CSP_NONCE}}"
if out.count("<script>") != 1:
    sys.exit("build refused: %d bare <script> tags, expected exactly the engine's"
             % out.count("<script>"))
out = out.replace("<script>", '<script nonce="%s">' % NONCE, 1)
if out.count(NONCE) != 1:
    sys.exit("build refused: the nonce placeholder does not appear exactly once")
required = ["c", "heard", "doing", "err", "fallback", "mic", "q", "send", "typing", "reset",
            "top", "content", "view", "artifact", "answer", "caption", "bar", "bar3", "stages",
            "state", "meta", "stopin", "level", "sheet", "sheetpanel", "steps", "sheetx", "work", "thread", "stages",
            # the one question asked before destroying something
            "confirm", "confirmscrim", "confirmcard", "confirmtitle", "confirmbody", "confirmacts",
            "confirmkeep", "confirmgo",
            "modeBtn",
            # the workspace shell
            "menu", "brand", "newchat", "chips", "composer", "plus", "live", "voicestrip",
            "vwave", "vtime", "vmute", "vend", "nav", "navscrim", "navpanel", "attach",
            "attachscrim", "attachpop", "attachrows", "attachtools", "attachback",
            "attachfile", "attachimage", "attachcam", 
            "qtweb", "qtmemory", "qtpermissions", "fileinput", "imageinput", "caminput",
            "attachreason", "reasonlevel", "reasonpanel", "reasonback",
            "rvauto", "rvnone", "rvmedium", "rvhigh", "rvmax",
            "empty", "greet", "suggests",
            # the drawer's two-page viewport
            "navtrack", "navroot", "navdetail", "navdetailhead", "navback", "navdetailtitle",
            "navdetailbody",
            # the full-screen pages: Settings, Persona & Memory and User Profile
            "page", "pagehead", "pageback", "pagetitle", "pageact", "pagebody"]
missing = [i for i in required if ('id="%s"' % i) not in out]
if missing:
    sys.exit("build refused: missing required ids: " + ", ".join(missing))

# ---------------------------------------------------------------- the inline script must parse
# A raw newline inside a JS string literal silently killed the whole engine, and the built page
# shipped broken to the phone. The build now refuses to write a page whose script does not parse.
_inline = re.findall(r"<script(?![^>]*src)[^>]*>(.*?)</script>", out, re.S)
for _n, _body in enumerate(_inline):
    _t = tempfile.NamedTemporaryFile("w", suffix=".js", delete=False)
    _t.write(_body); _t.close()
    _r = subprocess.run(["node", "--check", _t.name], capture_output=True, text=True)
    os.unlink(_t.name)
    if _r.returncode != 0:
        sys.exit("build refused: inline script %d does not parse:\n%s" % (_n, _r.stderr[:500]))

# The approval card is its own file, so every rebuild put the page back without it. The builder
# now links it itself, stamped with its own contents so a change can never be served from a cache.
_APPROVALS = os.path.join(HERE, "static", "approvals-ui.js")
if os.path.exists(_APPROVALS) and "approvals-ui.js" not in out:
    _astamp = stamp(_APPROVALS)
    out = out.replace("</body>", '<script src="/static/approvals-ui.js?v=%s" defer></script>\n</body>' % _astamp)

open(OUT, "w", encoding="utf-8").write(out)
print("wrote", OUT, len(out), "bytes")
print("engine lines:", engine.count("\n") + 1)
print("css stamp:", stamp(CSS), " js stamp:", stamp(JS))
