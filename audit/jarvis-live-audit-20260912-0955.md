# JARVIS Live — code review package

Prepared 2026-09-12 09:55 UTC. Two files, self-contained. Please audit for correctness and safety, and be
blunt: this has had several rounds of fixes and I want the faults that remain, not praise.

## What it is

A private voice page served from one small server, reached at a token-gated URL. You speak,
it answers in a cloned voice, and it can hand real work to a Hermes agent running behind it.
No framework, no build step: one HTML file and one Python file.

## How it works, in the order sound travels

1. **Capture (browser).** `getUserMedia` with *all* of the phone's audio processing disabled.
   An `AudioWorklet` posts raw 128-sample frames to the main thread. A one-second rolling
   buffer is kept as a pre-roll.
2. **Detecting speech (browser).** Frames are aggregated into 50 ms blocks; the block RMS is
   compared against a room floor learned as a fast-falling, slowly-rising average.
3. **Cutting the clip (browser).** A capture starts on sustained level above the floor and
   ends after ~1.3 s of quiet. The pre-roll is prepended, so the first words are never lost —
   this was a real defect: "read me today's news" arrived as "make me mirrors" when the clip
   began after speech had started.
4. **Upload (browser).** The samples are converted to 16-bit mono WAV in the browser and
   POSTed to `/stt`.
5. **Transcription (server).** `faster-whisper` on CPU, small model first; if the result is
   thin or its confidence is poor, a larger model is asked for a second opinion. Leading and
   trailing silence is trimmed and the level normalised before transcribing, because phone
   audio arrives quiet.
6. **Reply (server).** The text goes to a fast model for the immediate answer and, for real
   work, to a Hermes agent in a child session. The answer streams back as text events and as
   sentence-by-sentence audio in a cloned voice; audio is fetched and played with one sentence
   of lookahead so playback never waits for a finished file.

## Constraints discovered by measurement, not theory

- **All of the phone's own audio processing must be off.** With the echo canceller on, the
  same speech came back as "Hello, Gary." instead of "Hello JARVIS.", and one clip was
  captured at level 57 while the words were clearly spoken. Normalisation happens server-side.
- **Automatic interruption is impossible with one microphone.** Measured on the same device:
  the operator's voice 743–2561, the phone speaker's bleed 2336–5402. Overlapping, so no
  loudness threshold separates them. A tap on the button is the only interruption path.
- **A recording already under way must be discarded when playback starts.** Otherwise a clip
  begins a fraction before JARVIS speaks and records the entire reply; one such 7.8 s clip
  contained his own answer and was fed back as the operator's question.

## Please look hard at

1. **Race conditions** in the capture gate: `earTurnOpen`, `turnActive`, `EarAudioUntil`,
   `earRecording`. Can any ordering let a capture survive into playback, or start during it?
2. **The discard path**: `earCapture = []` on playback start. Any way for partial frames to
   survive into a submission?
3. **`/stt` input handling**: size limits, timeouts, what a malformed body does, whether the
   temporary files are always removed, and whether `clean_and_boost` can be made to fail badly
   on a crafted WAV (it reads frames as 16-bit samples).
4. **Auth**: a shared token in a file, set as a cookie on `?k=`, compared with `==`. What is
   the realistic threat model for a page exposed through a Cloudflare tunnel, and what is the
   cheapest meaningful improvement?
5. **Resource use**: one `setInterval` at 60 ms, an `AudioWorklet` posting ~125 messages/s, a
   ~20 s cap per capture, a 500-token reply cap. Anything that leaks or grows without bound?
6. **Error paths**: what the user sees when transcription fails, when the model errors, when
   the network drops mid-stream. Silence is unacceptable; wrong answers are worse.
7. **Anything I have not thought of.** Say so plainly.

## Note on secrets

No credentials are embedded. The server reads them from environment variables and from a
token file outside the source tree; the paths appear in the code, the values never do.

---

## File 1 of 2 — `index.html` (the page: capture, gate, reactor, playback)

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#05070A">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>JARVIS</title>
<style>
  :root{ --bg:#05070A; --cyan:#22D3EE; --amber:#E8A020; --line:#182231; --ink:#DDE6F0;
         --muted:#66748A; --red:#F87171; }
  *{ box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  html,body{ margin:0; height:100%; background:var(--bg); color:var(--ink);
    font:15px/1.5 -apple-system,'Inter',system-ui,'Segoe UI',Roboto,sans-serif;
    overflow:hidden; overscroll-behavior:none; }
  canvas{ display:block; width:100%; height:100%; }
  #heard{ position:fixed; left:0; right:0; bottom:calc(112px + env(safe-area-inset-bottom,0));
    text-align:center; font-size:14px; color:var(--muted); padding:0 30px; opacity:0;
    transition:opacity .4s ease; pointer-events:none; }
  #heard.show{ opacity:1; }
  #err{ position:fixed; left:0; right:0; bottom:calc(112px + env(safe-area-inset-bottom,0));
    text-align:center; font-size:13px; color:var(--red); padding:0 30px; display:none; }
  #dock{ position:fixed; left:0; right:0; bottom:0; display:flex; justify-content:center;
    padding:14px 0 calc(18px + env(safe-area-inset-bottom,0)); pointer-events:none; }
  #mic{ pointer-events:auto; width:68px; height:68px; border-radius:50%; border:1px solid var(--line);
    background:rgba(17,23,32,.72); color:var(--ink); display:grid; place-items:center;
    backdrop-filter:blur(12px); transition:background .22s, color .22s, box-shadow .22s, transform .12s;
    box-shadow:0 0 0 0 rgba(232,160,32,0); }
  #mic svg{ width:26px; height:26px; }
  #mic:active{ transform:scale(.96); }
  #mic.earArmed{ background:var(--amber); color:#241703; border-color:transparent;
    box-shadow:0 0 0 6px rgba(232,160,32,.14); }
  #mic.earArmed.live{ animation:pulse 2.4s ease-in-out infinite; }
  @keyframes pulse{ 0%,100%{ box-shadow:0 0 0 6px rgba(232,160,32,.14); }
                    50%{ box-shadow:0 0 0 13px rgba(232,160,32,.05); } }
  /* a way in, but only if the microphone is unavailable: otherwise there is no text box */
  #fallback{ position:fixed; left:0; right:0; bottom:0; display:none; gap:9px; align-items:center;
    padding:12px 16px calc(12px + env(safe-area-inset-bottom,0)) 16px; }
  #fallback.show{ display:flex; }
  #fallback input{ flex:1; min-width:0; height:46px; border-radius:23px; padding:0 17px; font-size:16px;
    color:var(--ink); background:rgba(17,23,32,.72); border:1px solid var(--line); outline:none; }
  #fallback button{ height:46px; padding:0 18px; border-radius:23px; font-weight:600;
    background:var(--cyan); color:#04141A; border:0; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="heard"></div>
<div id="err"></div>
<div id="dock">
  <button id="mic" type="button" title="Talk">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"/>
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>
    </svg>
  </button>
</div>
<div id="fallback">
  <input id="q" type="text" autocomplete="off" placeholder="Type to JARVIS..." />
  <button id="send" type="button">Send</button>
</div>
<script>
const cv = document.getElementById('c'), ctx = cv.getContext('2d');
const heard = document.getElementById('heard'), errEl = document.getElementById('err');
const mic = document.getElementById('mic'), fallback = document.getElementById('fallback');
const input = document.getElementById('q'), sendBtn = document.getElementById('send');

let W = 0, H = 0, DPR = 1, phase = 0, state = 'idle', sweep = 0, glow = 0;
const BARS = 96, spectrum = new Float32Array(BARS), spin = new Float32Array(BARS);
for (let i = 0; i < BARS; i++) spin[i] = Math.random() * 0.4 + 0.6;

function resize(){
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = cv.width = Math.floor(innerWidth * DPR);
  H = cv.height = Math.floor(innerHeight * DPR);
  cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
}
addEventListener('resize', resize); resize();

const ACCENT = () => state === 'listening' ? '232,160,32' : '34,211,238';

function ring(cx, cy, r, alpha, width, blur){
  ctx.save();
  ctx.shadowBlur = blur; ctx.shadowColor = 'rgba(' + ACCENT() + ',.55)';
  ctx.strokeStyle = 'rgba(' + ACCENT() + ',' + alpha + ')';
  ctx.lineWidth = width;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

function draw(){
  phase += 0.016;
  const dock = 112 * DPR + 20;
  const cx = W / 2, cy = (H - dock) / 2 + 10 * DPR;
  const R = Math.min(W * 0.22, (H - dock) * 0.19);

  ctx.clearRect(0, 0, W, H);
  for (let i = 0; i < BARS; i++) spectrum[i] *= 0.90;

  const accent = ACCENT();
  const kick = Math.max.apply(null, Array.from(spectrum));
  glow += ((state === 'speaking' ? kick : 0) - glow) * 0.16;
  sweep += state === 'thinking' ? 0.085 : 0.012;

  const breath = 1 + Math.sin(phase * 0.9) * 0.012;

  const wash = ctx.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.6);
  wash.addColorStop(0, 'rgba(' + accent + ',' + (0.055 + 0.07 * glow) + ')');
  wash.addColorStop(0.55, 'rgba(' + accent + ',0.018)');
  wash.addColorStop(1, 'rgba(' + accent + ',0)');
  ctx.fillStyle = wash;
  ctx.beginPath(); ctx.arc(cx, cy, R * 1.6, 0, Math.PI * 2); ctx.fill();

  ring(cx, cy, R * 1.34, 0.10, 3.2 * DPR, 16 * DPR);
  ring(cx, cy, R * 1.34, 0.26, 1.3 * DPR, 0);
  ring(cx, cy, R * 0.99, 0.16, 4.5 * DPR, 20 * DPR);
  ring(cx, cy, R * 0.99, 0.40, 1.7 * DPR, 0);
  ring(cx, cy, R * 0.74, 0.18, 1.1 * DPR, 6 * DPR);

  const arcLen = state === 'thinking' ? Math.PI * 0.5 : Math.PI * 0.18;
  ctx.save();
  ctx.shadowBlur = 14 * DPR; ctx.shadowColor = 'rgba(' + accent + ',.7)';
  ctx.strokeStyle = 'rgba(' + accent + ',' + (state === 'thinking' ? 0.95 : 0.34) + ')';
  ctx.lineWidth = (state === 'thinking' ? 2.6 : 1.6) * DPR;
  ctx.beginPath(); ctx.arc(cx, cy, R * 1.34 * breath, sweep, sweep + arcLen); ctx.stroke();
  ctx.restore();

  const peak = Math.max.apply(null, Array.from(spectrum));
  const silent = state === 'speaking' && peak < 0.02;
  for (let i = 0; i < BARS; i++){
    const a = (i / BARS) * Math.PI * 2 - Math.PI / 2 + sweep * 0.1;
    const idle = 0.030 + 0.055 * Math.sin(phase * 1.35 - i * 0.28) * spin[i];
    const synth = silent ? (0.16 + 0.30 * Math.abs(Math.sin(phase * 2.1 + i * 0.7)) * spin[i]) : 0;
    const amp = Math.max(idle, spectrum[i], synth);
    const base = R * 1.02 * breath;
    const len = R * (0.045 + amp * 0.85);
    const x1 = cx + Math.cos(a) * base, y1 = cy + Math.sin(a) * base;
    const x2 = cx + Math.cos(a) * (base + len), y2 = cy + Math.sin(a) * (base + len);
    const lit = amp > 0.09 || spectrum[i] > 0.05;
    ctx.strokeStyle = lit ? 'rgba(' + accent + ',' + (0.35 + amp) + ')' : 'rgba(' + accent + ',' + (0.10 + amp) + ')';
    ctx.lineWidth = (lit ? 2.2 : 1.1) * DPR;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }

  if (state === 'listening'){
    const t = (phase * 0.5) % 1;
    ctx.strokeStyle = 'rgba(' + accent + ',' + (0.4 * (1 - t)) + ')';
    ctx.lineWidth = 1.8 * DPR;
    ctx.beginPath(); ctx.arc(cx, cy, R * (1.05 + t * 0.55), 0, Math.PI * 2); ctx.stroke();
  }

  const coreR = R * (0.50 + 0.14 * glow);
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
  core.addColorStop(0, 'rgba(255,255,255,' + (0.85 + 0.15 * glow) + ')');
  core.addColorStop(0.16, 'rgba(' + accent + ',' + (0.60 + 0.30 * glow) + ')');
  core.addColorStop(0.55, 'rgba(' + accent + ',' + (0.10 + 0.14 * glow) + ')');
  core.addColorStop(1, 'rgba(' + accent + ',0)');
  ctx.fillStyle = core;
  ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();

  requestAnimationFrame(draw);
}
draw();

// ---------------------------------------------------------------- audio, decoded
let AC = null, analyser = null, freq = null, playing = false, queue = [], currentSrc = null;
let spokenText = "", lastAudioAt = 0;

function audio(){
  if (!AC){
    AC = new (window.AudioContext || window.webkitAudioContext)();
    analyser = AC.createAnalyser();
    analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.7;
    freq = new Uint8Array(analyser.frequencyBinCount);
    analyser.connect(AC.destination);
  }
  if (AC.state === 'suspended') AC.resume();
  return AC;
}

function enqueue(b64){
  queue.push(b64);
  if (!playing) play();
}

function play(){
  if (!queue.length){ playing = false; earTurnOpen = false; setState(earArmed ? 'listening' : 'idle'); return; }
  playing = true; setState('speaking'); lastAudioAt = Date.now();
  const b64 = queue.shift();
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  audio().decodeAudioData(bytes.buffer.slice(0), buf => {
    const src = audio().createBufferSource();
    src.buffer = buf; src.connect(analyser);
    currentSrc = src;
    src.onended = () => { currentSrc = null; play(); };
    src.start();
    (function sample(){
      if (currentSrc !== src) return;
      analyser.getByteFrequencyData(freq);
      const step = Math.max(1, Math.floor(freq.length / BARS));
      for (let i = 0; i < BARS; i++){
        let m = 0;
        for (let k = i * step; k < (i + 1) * step && k < freq.length; k++) m = Math.max(m, freq[k]);
        spectrum[i] = Math.max(spectrum[i], (m / 255) * 0.95);
      }
      requestAnimationFrame(sample);
    })();
  }, () => play());
}

function stopAudio(){
  try{ if (currentSrc){ currentSrc.onended = null; currentSrc.stop(); } }catch(e){}
  currentSrc = null; queue = []; playing = false;
  for (let i = 0; i < BARS; i++) spectrum[i] = 0;
}

// ---------------------------------------------------------------- state
let stream = null, earArmed = false, heardTimer = null, turnActive = false;

function setState(s){ state = s; }
function say(text){
  heard.textContent = text; heard.classList.add('show');
  clearTimeout(heardTimer);
  heardTimer = setTimeout(() => heard.classList.remove('show'), 4500);
}
function fail(text){ errEl.textContent = text; errEl.style.display = 'block';
  setTimeout(() => { errEl.style.display = 'none'; }, 7000); }
function showFallback(){ fallback.classList.add('show'); mic.style.display = 'none'; }
function interrupt(){
  stopAudio();
  if (stream){ try{ stream.close(); }catch(e){} stream = null; }
  turnActive = false;             // abandoning a turn must also release the microphone gate
  setState(earArmed ? 'listening' : 'idle');
}

function ask(q){
  interrupt();
  earTurnOpen = true;
  spokenText = "";
  turnActive = true;
  setState('thinking');
  stream = new EventSource('/stream?q=' + encodeURIComponent(q));
  stream.addEventListener('tok', ev => { spokenText += (JSON.parse(ev.data).d || ''); });
  stream.addEventListener('audio', ev => enqueue(JSON.parse(ev.data).mp3));
  stream.addEventListener('work', ev => { if (JSON.parse(ev.data).state === 'start') setState('thinking'); });
  stream.addEventListener('err', ev => fail(JSON.parse(ev.data).message));
  stream.addEventListener('done', () => { stream.close(); stream = null; turnActive = false; if (!playing) setState(earArmed ? 'listening' : 'idle'); });
  stream.onerror = () => { if (stream){ stream.close(); stream = null; } turnActive = false; if (!playing) setState(earArmed ? 'listening' : 'idle'); };
}

// ---------------------------------------------------------------- ears
// Raw audio, not the browser's speech service, and not a chunked earRecording either: a
// chunked earRecording starts too late and swallows the first words, which is why "read me
// today's news" arrived as nonsense. We keep a rolling buffer of the last second, so when
// you start speaking the clip already contains the beginning of what you said.

const earWORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs){
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('earCapture', Capture);
`;

let earMicStream = null, micCtx = null, rate = 16000;
let earRing = [];                 // the rolling pre-roll while idle
let earCapture = [];              // everything from just before you spoke
let earRecording = false;
let block = [], blockLen = 0, blockMs = 50;
let floor = 0.01, bleed = 0.02, tripCount = 0, quietBlocks = 0, loudBlocks = 0;
let EarAudioUntil = 0, EarQuietBlocks = 0;
let earTurnOpen = false;   // open from your message until the last of his audio finishes
let earQuietFrom = 0, recordStart = 0, barged = false, ignoreUntil = 0;
let earLastText = '', lastMeta = '';
const BUILD = 'v11-no-self-capture';

function rmsOf(a){
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / a.length);
}

async function openMic(){
  if (earMicStream) return true;
  try{
    earMicStream = await navigator.mediaDevices.getUserMedia({
      // All three off. Measured on his own recordings: with the echo canceller on, the same
      // speech came back as "Hello, Gary." instead of "Hello JARVIS.", and one clip was
      // captured at level 57 while the words were clearly spoken. The phone's audio
      // processing removes his voice along with the speaker's; the server normalises instead.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  }catch(e){
    fail('Microphone refused. Allow it for this site, or type below.');
    showFallback();
    return false;
  }
  try{
    micCtx = new AudioContext({ sampleRate: 16000 });
    if (!micCtx.audioWorklet) throw new Error('no audio worklet');
    const earUrl = URL.createObjectURL(new Blob([earWORKLET], { type: 'application/javascript' }));
    await micCtx.audioWorklet.addModule(earUrl);
    const src = micCtx.createMediaStreamSource(earMicStream);
    const earNode = new AudioWorkletNode(micCtx, 'earCapture');
    earNode.port.onmessage = ev => pushSamples(ev.data);
    src.connect(earNode);
    rate = micCtx.sampleRate;
    return true;
  }catch(e){
    fail('This browser cannot record. Use the typing box below.');
    showFallback();
    return false;
  }
}

function pushSamples(chunk){
  if (chunk.length > 4){
    block.push(chunk); blockLen += chunk.length;
    if (blockLen >= rate * blockMs / 1000){
      const earFlat = new Float32Array(blockLen);
      let o = 0;
      for (const a of block){ earFlat.set(a, o); o += a.length; }
      block = []; blockLen = 0;
      onBlock(earFlat, rmsOf(earFlat));
    }
  }
  if (earRecording) earCapture.push(chunk);
  else {
    earRing.push(chunk);
    let n = 0;
    for (const a of earRing) n += a.length;
    while (n > rate * 1.0 && earRing.length > 1){ n -= earRing[0].length; earRing.shift(); }   // keep one second
  }
}

function onBlock(earFlat, lv){
  if (!earArmed) return;

  if (playing){
    EarAudioUntil = Date.now() + 500;   // that sound came from the speaker, not from you
    // A recording already under way when he starts speaking is capturing HIS voice off the
    // speaker. That produced a 7.8 second clip of his own answer, fed back as the question.
    if (earRecording && !barged){
      earRecording = false; earCapture = []; earRing = [];
      console.log('discarded a recording: he started speaking, so that was his voice');
      setState('speaking');
    }
    // Loudness cannot separate your voice from his coming back off the phone's own speaker
    // (measured: yours 743-2561, his 2336-5402), and automatic interruption broke the
    // conversation twice. It is off. Tapping the button stops him, and that always works.
    if (!barged) bleed = bleed * 0.9 + lv * 0.1;
    tripCount = 0;
    return;
  }

  if (turnActive && !earRecording){
    // he is thinking: stay quiet and wait
    return;
  }

  if (!earRecording){
    // Do not listen while he is producing: thinking, streaming, speaking, or in the short
    // gap between his sentences. That is what stops him recording his own voice. A
    // deliberate interruption is the one exception, and it arrives with barged set.
    // Requiring quiet here was wrong: it reset itself on the first loud block and made the
    // page deaf to continuous speech, so the speaker's tail got recorded instead.
    if ((earTurnOpen || turnActive || Date.now() < EarAudioUntil) && !barged){ loudBlocks = 0; return; }
    // the quiet level of this room: falls at once, rises very slowly, so a sudden loud
    // noise (the speaker, a door, a shout) cannot leave the page deaf for seconds after
    if (lv < floor) floor = floor * 0.5 + lv * 0.5;
    else floor = floor * 0.995 + lv * 0.005;
    const gate = Math.max(floor * 3.0, 0.024);
    if (lv > gate){
      if (++loudBlocks >= 3){ loudBlocks = 0; beginCapture(); }
    } else loudBlocks = Math.max(0, loudBlocks - 1);
    return;
  }

  // earRecording: stop once you have been quiet for a moment
  quietBlocks = lv < Math.max(floor * 2.0, 0.018) ? quietBlocks + 1 : 0;
  const earQuietMs = quietBlocks * blockMs;
  const earSpokeMs = (Date.now() - recordStart);
  // a natural gap between words used to end the recording and cut him off mid-phrase,
  // which is why "hello JARVIS" arrived as "Hello."
  if (earQuietMs >= 1300 && earSpokeMs > 400) endCapture();
  else if (earSpokeMs > 20000) endCapture();
}

function beginCapture(){
  if (earRecording) return;
  earRecording = true; recordStart = Date.now(); quietBlocks = 0;
  earCapture = earRing.slice();                 // the second before you spoke: nothing gets cut off
  earRing = [];
  setState('listening');
}

function endCapture(){
  if (!earRecording) return;
  earRecording = false;
  const earTotal = earCapture.reduce((n, a) => n + a.length, 0);
  const audio = earCapture;
  earCapture = [];
  if (earTotal < rate * 0.25 || Date.now() - recordStart < 300){
    setState(earArmed ? 'listening' : 'idle');
    return;
  }
  const earFlat = new Float32Array(earTotal);
  let o = 0;
  for (const a of audio){ earFlat.set(a, o); o += a.length; }
  submit(earFlat);
}

function toWav(samples, hz){
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (off, t) => { for (let i = 0; i < t.length; i++) v.setUint8(off + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, hz, true); v.setUint32(28, hz * 2, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++){
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    off += 2;
  }
  return buf;
}

function submit(earFlat){
  const earSeconds = earFlat.length / rate;
  setState('thinking');
  const earT0 = performance.now();
  fetch('/stt', { method: 'POST', body: new Blob([toWav(earFlat, rate)], { type: 'audio/wav' }),
                  headers: { 'Content-Type': 'audio/wav', 'X-Jarvis-Page': BUILD } })
    .then(r => r.json())
    .then(d => {
      const earWaited = Math.round(performance.now() - earT0);
      earLastText = (d.text || '').trim();
      lastMeta = 'clip ' + earSeconds.toFixed(1) + 's | heard in ' + earWaited + 'ms | ' +
                 (d.transcribe_s !== undefined ? d.transcribe_s + 's of it transcribing' : (d.reason || ''));
      console.log('you said:', earLastText, '|', lastMeta);
      if (!earLastText){ setState(earArmed ? 'listening' : 'idle'); return; }
      say(earLastText);
      barged = false;
      ask(earLastText);
    })
    .catch(e => { fail('Could not reach the transcriber.'); console.log(e); setState(earArmed ? 'listening' : 'idle'); });
}

mic.addEventListener('click', () => {
  audio();
  if (earArmed && (playing || turnActive || Date.now() < EarAudioUntil)){
    ignoreUntil = Date.now() + 300;
    interrupt();
    if (earRecording){ endCapture(); return; }
    earRing = [];                   // drop the pre-roll: it holds his voice, not yours
    barged = true;               // this capture is deliberate, so the gate lets it through
    console.log('tapped to interrupt - listening now');
    beginCapture();
    return;
  }
  earArmed = !earArmed;
  mic.classList.toggle('armed', earArmed);
  if (earArmed){
    openMic().then(ok => { if (ok) beginCapture(); });   // tap to talk: earRecording starts at once
  } else {
    if (earRecording) endCapture();
    mic.classList.remove('live');
    setState(playing ? 'speaking' : 'idle');
  }
});

// a seam for testing without a real microphone: feed samples down the same path the
// microphone uses, so the earCapture, the cutting and the upload can be checked for real
window.__jarvisFeed = arr => pushSamples(Float32Array.from(arr));
window.__jarvisArm = () => { earArmed = true; return earArmed; };
window.__jarvisBusy = ms => { EarAudioUntil = Date.now() + (ms || 0); return EarAudioUntil; };
window.__jarvisPlaying = v => { playing = !!v; if (v) EarAudioUntil = Date.now() + 500; return playing; };
window.__jarvisState = () => ({ earRecording, earArmed, rate, floor, loudBlocks,
                                ringSamples: earRing.reduce((n, a) => n + a.length, 0),
                                settling: Date.now() < EarAudioUntil, quietBlocks: EarQuietBlocks,
                                earLastText, lastMeta });

sendBtn.addEventListener('click', () => { const v = input.value.trim(); if (!v) return; input.value = ''; ask(v); });
input.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); sendBtn.click(); } });
document.addEventListener('click', () => audio(), {once:true});
setState('idle');
</script>
</body>
</html>

```

---

## File 2 of 2 — `server.py` (token gate, streaming reply, speech to text, delegation)

```python
#!/usr/bin/env python3
"""JARVIS Live — streaming text, streaming voice, ears, interruption, and a real brain.

Design (three lines):
  voice in      browser speech recognition, with the interrupt decided on the phone
  voice out     the cloned voice, streamed a sentence at a time, played as it lands
  behind it     a fast front layer that answers instantly, and Hermes delegated the
                real work, whose result is spoken into the same conversation when it lands

The page owns all audio. This server owns the two model links and nothing else.
"""
import base64
import json
import os
import queue
import random
import re
import glob
import threading
import time
import urllib.request

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, StreamingResponse
import uvicorn

HERMES = os.path.expanduser("~/.hermes")
HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("JARVIS_LIVE_PORT", "8150"))
VOICE = "79554ca723f442a3af718d5aee6751ab"
FISH_MODEL = "s2.1-pro-free"
FRONT_MODEL = "deepseek-v4-flash"
SHIM = "http://127.0.0.1:8140"
COOKIE = "jl"
WORK_MARK = "[[WORK]]"

SYSTEM = (
    "You are JARVIS, Mohammad's personal assistant. He is in Kampala, Uganda, and he is "
    "talking to you through your own private page on his phone. Everything you write is "
    "read aloud as you write it, so write for the ear: short sentences, plain words, no "
    "markdown, no bullets, no emoji, no headings, no file paths, no code. Lead with the "
    "answer, then stop. Dry wit is welcome, padding is not. Default to two or three short "
    "sentences unless he asks for detail, because every extra sentence costs him time.\n\n"
    "You are one JARVIS, not several. You have tools, his files, the web and memory, and "
    "when a request needs them you simply go and use them yourself. Never mention layers, "
    "handoffs, other agents or models, and never say you cannot reach something. If you "
    "need to work, say one short line that you are on it and then put " + WORK_MARK + " at "
    "the very end and nothing after it, for example: 'Let me pull that up, sir. " + WORK_MARK + "' "
    "Everything you write is spoken aloud, so all of it must be prose a person can hear: "
    "no lists, no paths, no code, no status lines, no emoji. For greetings, opinions and "
    "anything you already know, just answer normally and never emit that marker.\n\n"
    "Standing facts: he owns InspectFirst, a vehicle inspection business in Kampala, site "
    "battemohammad.com. He supports Arsenal. He prefers plain language and hates filler."
)


IDENTITY_CACHE = {"at": 0, "text": ""}


def identity():
    """The same soul and the same memory the engine runs on, so the quick answers are
    mine rather than a generic assistant's. Cached for a minute and kept compact: this
    text is prefilled on every turn, so length costs latency."""
    now = time.time()
    if now - IDENTITY_CACHE["at"] < 60 and IDENTITY_CACHE["text"]:
        return IDENTITY_CACHE["text"]
    parts = []
    for name, cap in (("SOUL.md", 2200), ("MEMORY.md", 1400), ("USER.md", 1400)):
        for sub in ("", "memories/"):
            path = os.path.join(HERMES, sub + name)
            if os.path.exists(path):
                try:
                    parts.append("## " + name + "\n" + open(path, encoding="utf-8").read()[:cap])
                except Exception:
                    pass
                break
    text = "\n\n".join(parts)
    IDENTITY_CACHE.update({"at": now, "text": text})
    return text


def env(name):
    p = os.path.join(HERMES, ".env")
    if os.path.exists(p):
        for line in open(p, encoding="utf-8", errors="ignore"):
            m = re.match(r"^\s*(?:export\s+)?%s\s*=\s*(.+?)\s*$" % re.escape(name), line)
            if m:
                return m.group(1).strip().strip('"').strip("'")
    return os.environ.get(name)


TOKEN = open(os.path.join(HERMES, "jarvis_live_token")).read().strip()
SHIM_KEY = open(os.path.join(HERMES, "shim_auth_key")).read().strip()
DS_KEY = env("DEEPSEEK_API_KEY")
FISH_KEY = env("FISH_AUDIO_API_KEY") or env("FISH_API_KEY")

app = FastAPI()


HISTORY = []
HISTORY_LOCK = threading.Lock()
HISTORY_MAX = 12          # last six exchanges, enough for follow-ups, short enough to prefill fast
HISTORY_FILE = os.path.join(HERE, "session.json")
TURN = {"n": 0}                     # newest turn id

def new_turn():
    with HISTORY_LOCK:
        TURN["n"] += 1
        return TURN["n"]


def _sanitise(msgs):
    """Keep only well-formed alternating pairs. A user message with no answer, or two of
    the same role in a row, is what made the model answer a stale question."""
    out = []
    for m in msgs:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant"):
            continue
        if out and out[-1]["role"] == m["role"]:
            out[-1] = m                      # same role twice: the later one wins
            continue
        out.append(m)
    while out and out[-1]["role"] == "user":
        out.pop()                            # never end on an unanswered question
    return out


def _load_history():
    try:
        if os.path.exists(HISTORY_FILE):
            data = json.load(open(HISTORY_FILE, encoding="utf-8"))
            if isinstance(data, list):
                HISTORY.extend(_sanitise(data)[-HISTORY_MAX:])
    except Exception:
        pass
    return len(HISTORY)


def commit(turn, user_text, assistant_text):
    """Write one complete exchange. Nothing is written until the turn finishes, and a turn
    that was interrupted writes nothing at all — neither half. Half a turn in memory is
    worse than no turn: it leaves a question with no answer, and the next reply answers it."""
    with HISTORY_LOCK:
        if turn != TURN["n"]:
            return False
        if user_text:
            HISTORY.append({"role": "user", "content": user_text})
        if assistant_text:
            HISTORY.append({"role": "assistant", "content": assistant_text})
        del HISTORY[:-HISTORY_MAX]
        try:
            json.dump(HISTORY, open(HISTORY_FILE, "w", encoding="utf-8"))
        except Exception:
            pass
        return True


def recall():
    with HISTORY_LOCK:
        return list(HISTORY)


def authed(request: Request):
    raw = request.headers.get("cookie", "")
    if not raw:
        return False
    for part in raw.split(";"):
        if "=" in part:
            k, v = part.strip().split("=", 1)
            if k == COOKIE and v == TOKEN:
                return True
    return False


def sse(event, data):
    return "event: %s\ndata: %s\n\n" % (event, json.dumps(data))


def sentences(text):
    """Split into speakable sentences, keeping any tail."""
    out, rest = [], text
    while True:
        m = re.search(r"^.*?[.!?][\"')\]]?(?=\s|$)", rest, re.S)
        if not m:
            return out, rest.strip()
        out.append(m.group(0).strip())
        rest = rest[m.end():].lstrip()


def fish_stream(text):
    body = json.dumps({"text": text, "reference_id": VOICE, "format": "mp3",
                       "latency": "balanced", "chunk_length": 150,
                       "temperature": 0.7, "top_p": 0.7, "normalize": True,
                       "prosody": {"speed": 1.0}}).encode()
    req = urllib.request.Request(
        "https://api.fish.audio/v1/tts", data=body,
        headers={"Authorization": "Bearer " + FISH_KEY, "Content-Type": "application/json",
                 "model": FISH_MODEL})
    with urllib.request.urlopen(req, timeout=120) as resp:
        while True:
            chunk = resp.read(8192)
            if not chunk:
                return
            yield chunk


PROGRESS_SYSTEM = (
    "You are JARVIS and you are still working on the request below. Write ONE spoken "
    "sentence of five to twelve words that is specific to what he asked and honest about "
    "the wait. Never invent a result or a fact. Never say 'still working', 'one moment', "
    "'bear with me' or any stock phrase; those sound like a machine. Say something only "
    "you would say, calm and concrete, and do not repeat any line already used. Output "
    "the sentence alone."
)


def progress_line(question, used):
    try:
        body = json.dumps({"model": FRONT_MODEL, "stream": False, "max_tokens": 60,
                           "messages": [{"role": "system", "content": PROGRESS_SYSTEM},
                                        {"role": "user",
                                         "content": "His request: %s\nLines already used: %s"
                                                    % (question, "; ".join(used) or "none")}]}).encode()
        req = urllib.request.Request("https://api.deepseek.com/chat/completions", data=body,
                                     headers={"Content-Type": "application/json",
                                              "Authorization": "Bearer " + DS_KEY})
        with urllib.request.urlopen(req, timeout=30) as resp:
            txt = json.loads(resp.read())["choices"][0]["message"]["content"].strip()
        txt = re.sub(r"^[\-•*\d.\s]+", "", txt).strip().strip('"')
        return txt if 3 < len(txt) < 160 else ""
    except Exception:
        return ""


def front_stream(prompt, history=None):
    ident = identity()
    system = SYSTEM + ("\n\n" + ident if ident else "")
    prior = recall() if history is None else history
    messages = [{"role": "system", "content": system}] + prior + [{"role": "user", "content": prompt}]
    body = json.dumps({"model": FRONT_MODEL, "stream": True, "max_tokens": 500,
                       "messages": messages}).encode()
    req = urllib.request.Request("https://api.deepseek.com/chat/completions", data=body,
                                 headers={"Content-Type": "application/json",
                                          "Authorization": "Bearer " + DS_KEY})
    with urllib.request.urlopen(req, timeout=120) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "ignore").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                return
            try:
                d = json.loads(payload)["choices"][0].get("delta", {}).get("content") or ""
            except Exception:
                continue
            if d:
                yield d


NOISE_WORDS = ("normalized model", "model restored", "resumed session", "session_id",
              "using model", "tool_call", "function call", "exit code", "warning:",
              "note:", "running:", "executing", "fetching ", "calling ")
NOISE = re.compile(r"^\s*(?:[^\w\s]{1,4}\s*)?(?:\{|\[|\"|')")


def speakable(line):
    """A line earns its place in the spoken reply only if it reads as prose."""
    t = line.strip()
    low = t.lower()
    if not t or NOISE.match(t):
        return False
    if any(w in low for w in NOISE_WORDS):          # anywhere in the line, however it arrives
        return False
    if re.search(r"(?i)session_id|\\u|https?://|/home/|\.py\b|\balerts?\b.*\|", t):
        return False
    words = t.split()
    if len(words) < 3:
        return False
    letters = sum(ch.isalpha() or ch.isspace() for ch in t)
    if letters / max(1, len(t)) < 0.72:                        # mostly punctuation/emoji
        return False
    return True


def scrub(line):
    """Strip anything that would be read aloud as gibberish."""
    line = re.sub(r"[\U0001F300-\U0001FAFF\u2600-\u27BF\uFE0F\u200B\u2022]", "", line)
    for junk in ("**", "`", "⚠️", "✅", "🔹", "•", "—  "):
        line = line.replace(junk, "")
    line = re.sub(r"\s{2,}", " ", line)
    return line.strip() if speakable(line) else ""


def _line_scrubber(stream, sink=None):
    """Pass a stream through, scrubbing only at line boundaries.

    Judging fragments is what leaked 'epeek-flash' into the reply: a runtime notice
    arrives split across chunks, so each piece looked like ordinary text.
    """
    buf = ""
    for chunk in stream:
        buf += chunk
        while "\n" in buf:
            line, buf = buf.split("\n", 1)
            clean = scrub(line)
            if clean:
                if sink is not None:
                    sink.append(clean)
                yield clean + " "
    if buf.strip():
        clean = scrub(buf)
        if clean:
            if sink is not None:
                sink.append(clean)
            yield clean


HERMES_BIN = os.path.join(HERMES, "hermes-agent/venv/bin/hermes")
WORKDIR = "/data/apps/jarvis-live"


def hermes_answer(prompt):
    """Ask the real agent and return its words.

    Called directly rather than through the voice shim: the shim buffers the whole
    answer anyway, and in quiet mode `session_id:` lands on stderr, so its parser falls
    through and returns the runtime notice line along with the reply.
    """
    import subprocess
    ask = ("Answer as JARVIS speaking aloud to Mohammad. Plain spoken English only: no "
           "emoji, no markdown, no lists, no paths, no code, no tool output, no status "
           "lines. At most three short sentences, and for news just the two or three "
           "biggest headlines, never a full bulletin. Start straight in with the news "
           "itself.\n\n" + prompt)
    try:
        proc = subprocess.run([HERMES_BIN, "chat", "-q", ask, "--oneshot", "-Q",
                               "--reasoning", "none", "-c", "jarvis-voice",
                               "--create-if-missing"],
                              cwd=WORKDIR, capture_output=True, text=True, timeout=280)
    except subprocess.TimeoutExpired:
        return "That one ran long, sir. Ask me again and I will keep it shorter."
    if proc.returncode != 0:
        return "I could not reach the agent just now, sir."
    keep = [ln for ln in (proc.stdout or "").splitlines() if scrub(ln)]
    return " ".join(keep).strip()


def _tee(text_iter, sink):
    """Pass a stream through while collecting it."""
    for chunk in text_iter:
        sink.append(chunk)
        yield chunk


def speak_pipeline(text_iter, out, prefix, counter):
    """Consume a text stream: emit tokens, and speak each sentence as it completes."""
    buf = ""
    for delta in text_iter:
        buf += delta
        out.put(("tok", {"d": delta, "kind": prefix}))
        done, buf = sentences(buf)
        for s in done:
            if s.strip():
                counter[0] += 1
                try:
                    blob = b"".join(fish_stream(s))
                    out.put(("audio", {"n": counter[0], "kind": prefix,
                                       "mp3": base64.b64encode(blob).decode()}))
                except Exception as e:
                    out.put(("warnerr", {"err": str(e)[:100]}))
    if buf.strip():
        counter[0] += 1
        try:
            blob = b"".join(fish_stream(buf.strip()))
            out.put(("audio", {"n": counter[0], "kind": prefix,
                               "mp3": base64.b64encode(blob).decode()}))
        except Exception as e:
            out.put(("warnerr", {"err": str(e)[:100]}))


LOADED = _load_history()


WHISPER = {"models": {}, "lock": threading.Lock(), "name": os.environ.get("JARVIS_STT_MODEL", "tiny"),
           "fallback": "base"}
PROMPT = ("JARVIS. Read me today's news. InspectFirst. Mohammad. Kampala. Pre-purchase inspection. "
          "Advanced diagnosis. Business card. WhatsApp. Nahia. Arsenal.")


def whisper(name=None):
    """Load once, keep warm. Speech to text runs here rather than in the browser: the
    browser's recogniser depends on a service I cannot see, which is why the microphone
    kept failing silently. Measured on this box, the small model handles a 1.5 second clip
    in 0.9s and the larger one in 1.5s, both correctly, so the small one runs first."""
    name = name or WHISPER["name"]
    if name not in WHISPER["models"]:
        with WHISPER["lock"]:
            if name not in WHISPER["models"]:
                from faster_whisper import WhisperModel
                WHISPER["models"][name] = WhisperModel(
                    name, device="cpu", compute_type="int8", cpu_threads=os.cpu_count() or 4,
                    download_root=os.path.join(HERE, "models"))
    return WHISPER["models"][name]


HALLUCINATIONS = {"thank you.", "thanks for watching.", "thank you for watching.",
                  "please subscribe.", "subscribe.", "you", ".", "okay.", "ok.", "bye.",
                  "yeah.", "hmm.", "uh.", "the patient.", "payment.", "hello, dear."}


def read_wav_samples(path):
    import wave as _wave
    with _wave.open(path, "rb") as w:
        rate, n, raw = w.getframerate(), w.getnframes(), w.readframes(w.getnframes())
    samples = [int.from_bytes(raw[i:i + 2], "little", signed=True) for i in range(0, len(raw), 2)]
    return rate, samples


def clean_and_boost(path):
    """Phone audio arrives quietly and padded with silence. Trim the padding and lift the
    level, which is the difference between 'Thank you.' and the actual words."""
    import wave as _wave
    try:
        rate, samples = read_wav_samples(path)
    except Exception:
        return path, 0.0
    if not samples:
        return path, 0.0
    win = max(rate // 50, 1)
    blocks = [max(abs(x) for x in samples[i:i + win]) for i in range(0, len(samples), win)]
    peak_all = max(blocks) if blocks else 0
    if peak_all == 0:
        return path, 0.0
    gate = peak_all * 0.06
    loud = [i for i, b in enumerate(blocks) if b > gate]
    if not loud:
        return path, 0.0
    start = max(0, (loud[0] - 3) * win)
    end = min(len(samples), (loud[-1] + 4) * win)
    speech = (loud[-1] - loud[0] + 1) * win / float(rate)
    kept = samples[start:end]
    peak = max((abs(x) for x in kept), default=0)
    if peak:
        gain = min((0.85 * 32767.0) / peak, 40.0)
        kept = [int(max(-32768, min(32767, x * gain))) for x in kept]
    with _wave.open(path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(b"".join(int(x).to_bytes(2, "little", signed=True) for x in kept))
    return path, speech


def transcribe(wav):
    """One pass with the small model. If the result is thin or unsure, spend the extra
    second on the larger one: better to be slow occasionally than wrong often."""
    def run(name):
        segs, info = whisper(name).transcribe(
            wav, language="en", beam_size=1, vad_filter=True,
            condition_on_previous_text=False, temperature=0.0, no_speech_threshold=0.65,
            initial_prompt=PROMPT)
        segs = list(segs)
        text = " ".join(s.text.strip() for s in segs).strip()
        conf = sum(getattr(s, "avg_logprob", -9.0) for s in segs) / len(segs) if segs else -9.0
        return text, conf, info

    text, conf, info = run(WHISPER["name"])
    used = WHISPER["name"]
    if (conf < -0.75 or len(text.split()) < 2) and WHISPER["name"] != WHISPER["fallback"]:
        second, conf2, info2 = run(WHISPER["fallback"])
        if len(second.split()) > len(text.split()) or conf2 > conf:
            text, info, used = second, info2, WHISPER["fallback"]
        print("second opinion asked: %r (%.2f) vs %r (%.2f)" % (text, conf2, text, conf))
    return text, info, used


def warm_whisper():
    try:
        whisper()
        print("whisper ready:", WHISPER["name"])
    except Exception as e:
        print("whisper unavailable:", str(e)[:160])


@app.post("/stt")
async def stt(request: Request):
    """Speech to text. The phone sends 16 kHz mono WAV, built in the browser, so there is no
    conversion step and no container format to go wrong."""
    if not authed(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    import json as _json
    import subprocess
    import tempfile
    import time as _time
    import wave

    t_recv = _time.time()
    raw = await request.body()
    if len(raw) < 2000:
        return JSONResponse({"text": "", "reason": "clip too short", "bytes": len(raw)})

    ctype = (request.headers.get("content-type") or "").lower()
    suffix = ".wav" if "wav" in ctype else ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(raw)
        src = f.name
    wav = src if suffix == ".wav" else src + ".wav"
    converted = False
    try:
        duration = 0.0
        try:
            with wave.open(wav, "rb") as w:
                duration = w.getnframes() / float(w.getframerate() or 1)
                rate, channels = w.getframerate(), w.getnchannels()
        except Exception:
            rate, channels = 0, 0
        if suffix != ".wav" or rate == 0:
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", src, "-ac", "1", "-ar", "16000", wav],
                           capture_output=True, timeout=60)
            converted = True

        t_trans = _time.time()
        wav, speech_s = clean_and_boost(wav)
        if speech_s < 0.30:                      # almost no speech: anything the model says is invention
            result = {"text": "", "reason": "no speech in the clip",
                      "seconds": round(speech_s, 2), "received_s": round(t_trans - t_recv, 2),
                      "transcribe_s": 0.0, "model": "skipped", "bytes": len(raw)}
            keep_for_diagnosis(wav, result)
            print("stt: no speech (%.2fs of sound) - ignored" % speech_s)
            return JSONResponse(result)
        text, info, used_model = transcribe(wav)
        if text.strip().lower() in HALLUCINATIONS and speech_s < 0.9:
            print("stt: discarded an invention (%r) from %.2fs of sound" % (text, speech_s))
            text = ""
        t_done = _time.time()

        result = {
            "text": text,
            "seconds": round(info.duration, 2),
            "speech_s": round(speech_s, 2),
            "received_s": round(t_trans - t_recv, 2),
            "transcribe_s": round(t_done - t_trans, 2),
            "model": used_model,
            "rate": rate,
            "channels": channels,
            "converted": converted,
            "bytes": len(raw),
        }
        keep_for_diagnosis(src if suffix != ".wav" else wav, result)
        print("stt[%s]: %r | %.2fs speech (%.2fs clip) | %.2fs transcribed (%s)" % (
            request.headers.get("X-Jarvis-Page", "unknown-page"), text[:80],
            result.get("speech_s", -1), result["seconds"], result["transcribe_s"], result["model"]))
        return JSONResponse(result)
    except Exception as e:
        print("stt failed:", str(e)[:200])
        return JSONResponse({"error": str(e)[:200], "text": ""}, status_code=500)
    finally:
        for f in (src, wav):
            try:
                os.unlink(f)
            except Exception:
                pass


def keep_for_diagnosis(path, result):
    """Keep the last few clips with what we made of them. When a transcript comes out wrong,
    the clip itself is the only way to tell whether the recording or the model was at fault."""
    import json as _json
    import shutil as _shutil
    import time as _time
    try:
        d = os.path.join(HERE, "clips")
        os.makedirs(d, exist_ok=True)
        stamp = _time.strftime("%Y%m%d-%H%M%S")
        _shutil.copyfile(path, os.path.join(d, stamp + ".wav"))
        with open(os.path.join(d, stamp + ".json"), "w") as f:
            _json.dump(result, f)
        files = sorted(glob.glob(os.path.join(d, "*.wav")))
        for old in files[:-25]:
            for ext in (".wav", ".json"):
                try:
                    os.unlink(old.replace(".wav", ext))
                except Exception:
                    pass
    except Exception as e:
        print("could not keep the clip:", str(e)[:120])


@app.get("/healthz")
def healthz():
    return JSONResponse({"ok": True})


@app.get("/", response_class=HTMLResponse)
def index(request: Request, k: str = ""):
    if k and k == TOKEN:
        r = RedirectResponse("/", status_code=302)
        r.set_cookie(COOKIE, TOKEN, max_age=31536000, httponly=True, secure=True, samesite="lax")
        return r
    if not authed(request):
        return HTMLResponse("<h1>401</h1><p>This page needs the key.</p>", status_code=401)
    with open(os.path.join(HERE, "index.html"), encoding="utf-8") as f:
        return HTMLResponse(f.read(), headers={"Cache-Control": "no-store, must-revalidate",
                                               "Pragma": "no-cache"})


@app.get("/ack")
def ack(request: Request, i: int = 0):
    if not authed(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    i = max(0, min(3, i))
    path = os.path.join(HERE, "acks", "%d.mp3" % i)
    if not os.path.exists(path):
        return JSONResponse({"error": "no ack"}, status_code=404)
    return FileResponse(path, media_type="audio/mpeg")


@app.get("/stream")
def stream(request: Request, q: str):
    if not authed(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    def gen():
        out = queue.Queue()
        counter = [0]
        work = {"needed": False, "said": False}

        def run():
            my = new_turn()
            snapshot = recall()
            spoken_total = []
            try:
                # 1. the fast layer answers immediately
                spoken = ""
                buf = ""
                held = ""
                for delta in front_stream(q, snapshot):
                    buf += delta
                    if WORK_MARK in buf:
                        # hold back the marker itself; anything before it is spoken as normal
                        head = buf.split(WORK_MARK)[0]
                        if head.strip() and not work["said"]:
                            speak_pipeline(iter([head]), out, "front", counter)
                            work["said"] = True
                        work["needed"] = True
                        buf = ""
                        break
                    spoken += delta
                    # emit only characters that cannot be part of a marker
                    held += delta
                    keep = len(WORK_MARK) - 1
                    if len(held) > keep:
                        out.put(("tok", {"d": held[:-keep], "kind": "front"}))
                        held = held[-keep:]
                    done, buf = sentences(buf)
                    for s in done:
                        counter[0] += 1
                        try:
                            blob = b"".join(fish_stream(s))
                            out.put(("audio", {"n": counter[0], "kind": "front",
                                               "mp3": base64.b64encode(blob).decode()}))
                        except Exception as e:
                            out.put(("warnerr", {"err": str(e)[:100]}))
                if held and not work["needed"]:
                    out.put(("tok", {"d": held, "kind": "front"}))
                    held = ""
                if buf.strip() and not work["needed"]:
                    counter[0] += 1
                    try:
                        blob = b"".join(fish_stream(buf.strip()))
                        out.put(("audio", {"n": counter[0], "kind": "front",
                                           "mp3": base64.b64encode(blob).decode()}))
                    except Exception as e:
                        out.put(("warnerr", {"err": str(e)[:100]}))

                if spoken.strip():
                    spoken_total.append(spoken.strip())

                # 2. the real work, delegated, fed back in when it lands
                if work["needed"]:
                    out.put(("work", {"state": "start"}))
                    try:
                        holder = {}

                        def go():
                            holder["text"] = hermes_answer(q)

                        th = threading.Thread(target=go, daemon=True)
                        th.start()
                        waited, gap = 0.0, 14.0
                        used = []
                        while th.is_alive() and waited < 260:
                            th.join(timeout=gap)
                            if th.is_alive():
                                waited += gap
                                line = progress_line(q, used)
                                if line:
                                    used.append(line)
                                    speak_pipeline(iter([line]), out, "front", counter)
                                gap = min(gap * 2, 45.0)
                        answer = holder.get("text", "")
                        if answer:
                            for line in answer.split("\n"):
                                clean = scrub(line)
                                if clean:
                                    speak_pipeline(iter([clean + " "]), out, "agent", counter)
                            spoken_total.append(answer[:1200])
                        out.put(("work", {"state": "done"}))
                    except Exception as e:
                        out.put(("work", {"state": "failed", "err": str(e)[:140]}))
            except Exception as e:
                out.put(("err", {"message": str(e)[:200]}))
            finally:
                commit(my, q, " ".join(spoken_total).strip())
                out.put(("done", {}))

        threading.Thread(target=run, daemon=True).start()
        yield sse("open", {"t": time.time()})
        while True:
            try:
                ev, data = out.get(timeout=8)
            except queue.Empty:
                # keep the pipe warm so a long silent agent run cannot idle it shut
                yield ": ping\n\n"
                continue
            yield sse(ev, data)
            if ev == "done":
                break

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache, no-transform",
                                      "X-Accel-Buffering": "no", "Connection": "keep-alive"})


if __name__ == "__main__":
    missing = [n for n, v in [("DEEPSEEK_API_KEY", DS_KEY), ("FISH", FISH_KEY)] if not v]
    if missing:
        print("missing:", missing); raise SystemExit(1)
    threading.Thread(target=warm_whisper, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")

```
