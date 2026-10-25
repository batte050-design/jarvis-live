# JARVIS Live — orbs + voice beam integration spec

Written 2026-09-20. Source: https://github.com/Jakubantalik/Libraries.dev (MIT, © 2026 Jakub Antalik).
Cloned to `/data/apps/libraries-dev`. **Keep their licence notice and credit them in the page source.**

## Verified facts (do not re-derive)

- `thinking-orbs` ships a **framework-agnostic engine**, `thinking-orbs/engine` — pure geometry, zero
  React, zero DOM. Built output at `packages/thinking-orbs/dist/engine.es.js` (re-exports a chunk).
  **Confirmed: the built chunk contains zero references to React.** Drop-in for a vanilla page.
- `voice-glow`'s component is React-bound, but its hard parts are not:
  - `src/audio.ts` — `getAudioContext()`, `isAudioSupported()`, `acquireAnalyser(stream)`. Web Audio
    only. Exported by their index. Use as-is.
  - `src/styles.ts` / `src/presets.ts` — lobes, palettes, geometry, theme presets as **data**.
    Exported. Use as-is.
  - `src/voiceDriver.ts` — the audio→intensity driver. **Not** exported by their index, but it
    bundles React-free: `npx esbuild src/voiceDriver.ts --bundle --format=esm` → 20 KB, zero React.
- Decision: **no React anywhere.** No build step in the page. Their code where it exists; the only
  thing written here is the canvas painter and the state wiring.

## The engine contract (their API, verbatim)

```js
import { resolvePreset, MODE_FRAMES } from '.../engine.es.js';
const { mode, speed, opts } = resolvePreset(state, size);
const { dots, lines } = MODE_FRAMES[mode](size, elapsedSeconds * speed, opts);
// draw `dots` in order (z-sorted, final values). `lines` only for 'connecting'.
```

Sizes: `64` (avatar scale) and `20` (inline). **Separate tunings, not a scale factor.**

## State mapping — the nine orbs onto JARVIS Live's real states

| Page state | Orb | Their words |
|---|---|---|
| idle | `breathing` | a ring slowly morphing |
| listening | `listening` | a waveform rolls through the rings |
| capturing | `weaving` | three strands plait around the sphere |
| transcribing | `solving` | bands scramble, then click back solved |
| thinking | `working` | particles on tilted orbits |
| speaking | `composing` | an undulating multi-band sash |
| interrupted | `shaping` | dotted outline: circle → triangle → square |
| error | `searching` | a scan meridian sweeps a dotted globe |
| page load / session connect | `connecting` | a constellation wires itself |

All nine used. Rationale: transcribing→solving is speech becoming text; thinking→working is the model
at work; page load→connecting is the session coming up.

## The beam (voice-glow)

- Layer: a beam under the orb. **The orb is the state; the beam is the voice level.**
- Beam shows only in `listening` and `speaking`.
- Drive it from their `voiceDriver` + `acquireAnalyser(stream)` on the existing mic stream.
- Render it ourselves in canvas: take the lobe geometry, spacing and palette values from
  `styles.ts` / `presets.ts` (import them, do not retype them).

## Constraints the page already has — hold them

- **Nothing decorative may be load-bearing.** The page must still work if the canvas dies.
- **Respect `prefers-reduced-motion`.** Their orb component already does; mirror it.
- **Pause when off-screen or when the tab is hidden.** Their component uses IntersectionObserver +
  visibility; mirror it so the phone is not burning battery.
- One reactor in the centre. Never the orb, the beam and the iris all at once.
- The page is key-gated (`?k=<key>`), served with caching disabled.

## Plan, in order

1. Copy the live `index.html` to a **local sandbox** path. Never edit the live page first.
2. Add the orb engine + the state wiring to the sandbox; render all nine states on a debug page.
3. Screenshot each state at phone width (390px) and send them for approval.
4. Add the beam; screenshot listening and speaking.
5. Only then copy to the live page — with a timestamped checkpoint of the working version taken
   first, so rollback is one command.

## Status

- [x] Both libraries cloned, built with their own build, inspected
- [x] React-free path proven for both
- [x] State mapping decided
- [ ] Sandbox render of the nine states
- [ ] Screenshots for approval
- [ ] Beam
- [ ] Live deploy with checkpoint
