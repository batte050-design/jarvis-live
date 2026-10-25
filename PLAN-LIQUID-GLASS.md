# Liquid glass for JARVIS Live — what it is, and how we do it

> **NOT ADOPTED — 16 October 2026.** Mohammad saw it on his phone and asked for it to come out:
> "Remove those settings and that theme from the app." It is removed — the reading, the loader, the
> styling, the library and the test page are all gone, and the Material control is back to Ink and
> Frost. This document is kept only as the record of the research, in case the decision is ever
> revisited. Nothing in it is live.

Rewritten 16 October 2026, after studying Apple's own guidance and testing a real implementation.
Supersedes the first version of this document.

Sources read this session: Apple's Human Interface Guidelines, **Materials**
(developer.apple.com/design/human-interface-guidelines/materials) and Apple's Liquid Glass overview
(developer.apple.com/documentation/technologyoverviews/liquid-glass); the library
**github.com/Oliverrr2424/webgl-apple-liquid-glass** (MIT, v2.6.0, npm, zero dependencies); the
studio **github.com/iyinchao/liquid-glass-studio** (MIT).

---

## 1. What Apple actually says

The rule that decides our whole architecture, quoted from Apple's Materials page:

> **"Don't use Liquid Glass in the content layer."** Liquid Glass works best when it provides a clear
> distinction between interactive elements and content, and including it in the content layer can
> result in unnecessary complexity and a confusing visual hierarchy. Instead, use standard materials
> for elements in the content layer, such as app backgrounds.

So: **glass belongs on the control layer** — controls and navigation that float above content — and
**not on the content itself**. Apple's stated aims for the material, from the WWDC25 sessions "Meet
Liquid Glass" and "Get to know the new design system", are a unified language across platforms,
hierarchy carried by the glass layer, and **legibility of primary controls preserved through adaptive
tinting and dimming**.

That last one is a technical requirement, not a nicety: the glass must adapt to what is behind it so
the controls on it stay readable. Our transcript is content. It does not get glass.

## 2. The three ways to build it on the web

| approach | refraction | support | cost | verdict for us |
| --- | --- | --- | --- | --- |
| CSS `backdrop-filter` | none — blur and tint only | everywhere | cheapest | not glass, just frosted |
| `backdrop-filter` + SVG displacement map | real bend | **Chromium only** — Safari and Firefox accept it and drop the filter | cheap | works in our WebView, useless as a general answer |
| WebGL2 shader | true refraction, edge compression, dispersion, rim light, highlight | anywhere with WebGL2: Chrome, Edge, Firefox, Safari 15+ | one WebGL context per surface, real GPU work | **the only path to "as Apple as possible"** |

The studio studied first was the third kind, but it is a React/TypeScript playground whose own TODO
still has "UI content inside of shape" unchecked: it draws glass over a background and cannot put
interface content inside it. Its default material is deliberately exaggerated — dispersion 7, glare
90 — and it took four live surfaces to bring this box's renderer to its knees. It taught us the
architecture; it is not the tool.

## 3. The decision: `apple-liquid-glass-webgl`

It does exactly what our app needs, and its own documentation states the three properties that
decide it:

- **It refracts the actual page behind a given element**, in page coordinates, while it scrolls,
  resizes and animates. Not an image we supply — the real content, aligned.
- **The DOM is untouched.** The glass is a canvas at `z-index: -1` inside the element, behind its
  children, so text stays text: selectable, translatable, read by a screen reader. Click handlers,
  layout and CSS are unchanged. This is precisely Apple's "controls float above content".
- **One call per surface**: `new LiquidGlass('.navbar')`. Shape and corner radius come from the
  element's own CSS `border-radius`.

Also: MIT, no runtime dependencies, plain ES modules with no build step, and it falls back to a CSS
`backdrop-filter` surface with `data-liquid-glass="fallback"` where WebGL2 is missing. It carries
`respectReducedTransparency`, which is Apple's own accessibility behaviour.

Its material options we will use: `tint` and `tintTone` (the adaptive tinting Apple requires),
`frost` (blur behind the lens), `maxDpr` (the resolution cap, our main performance lever), `targets`
(several surfaces on one canvas) and `live` (redraw every frame only while something moving sits
behind the glass).

## 4. What this means for our app

- **Glass on the chrome only**: the header, the composer bar, the nav pill, the sheets, the notice.
- **The transcript stays flat content**, per Apple's rule. Not glass, however tempting.
- **The structure does not move.** Each surface is an element that already exists; the library reads
  its geometry from the DOM. No new markup, no ids, no state.
- **Today's CSS material is the fallback**, so a WebGL2 failure or a missed frame budget degrades to
  the look we already have. The app cannot be broken by this.
- **Surfaces get grouped with `targets`** where they share a canvas, because browsers allow about 16
  WebGL contexts per page and a navbar alone can take two.

**One constraint to respect.** The library's `auto` backdrop paints real elements — backgrounds,
borders, `<img>`, `<video>`, `<canvas>`, text — but skips `::before`/`::after`, shadows, CSS filters,
SVG and form controls. Whatever we want visible *through* the glass must be a real element, or be
drawn by a painter. Anything in our chrome's backdrop relying on a pseudo-element has to become a
real node first.

## 5. P0 — built, waiting on one measurement

`/static/_glass-test.html` is live, with the library vendored beside it under `/static/lg/`. It has
the four surfaces our app actually has — top bar, nav pill, card, composer — over a colourful
scrolling page, and an instrument in the corner:

- **fps** — rolling average
- **worst frame** — the slowest frame in the last five seconds, in milliseconds; above 34 ms it turns
  amber, which is a dropped frame at 30 fps
- **surfaces** — how many of the four are glass
- **renderer** — `webgl2` or `css fallback`, so a silent downgrade is visible
- **dpr cap** — the resolution factor in use
- **fault** — any error the page hit, in plain words, instead of dying quietly

Switches for bisecting the cost on the phone: `?n=1|2|3|4` limits how many surfaces are glass;
`?cap=1|1.5|2` sets the resolution cap. Two sliders adjust `frost` and `tint` live.

**This can only be measured on his phone.** The box that built it renders in software: one surface
ran at ~13 fps, two at ~4 fps with a 767 ms worst frame. That is a hostile floor, not a verdict — a
mid-range phone GPU is a different machine. So the gate is unchanged and still his to run.

**The gate:** open the page on the A24, watch `fps` and `worst frame`, and try `?cap=1` against
`?cap=2`. Hold 50 fps with a `worst frame` under ~34 ms at a cap that still looks like glass, and we
continue. If it cannot, we keep the CSS look and I say so plainly.

## 6. After the gate

- **P1 — the chrome.** Header and composer of the real app, glass, behind a switch so the app stays
  untouched until he approves it on the phone.
- **P2 — the overlays.** Notice, sheets, nav panel, attach popover; geometry read from the DOM.
- **P3 — his tuning surface.** Frost, tint, cap and material values on a hidden panel, so he sets the
  look himself rather than describing it to me. Two presets side by side: restrained, and pronounced.
- **P4 — the backdrop decision.** What the glass refracts. Already proven: glass over near-black is
  invisible, so there must be luminance behind the chrome.
- **P5 — retire the CSS material** once glass is everywhere he wants it.

## 7. Risks, ranked

1. **Frame rate on the A24.** The one that kills the idea. Mitigations: `maxDpr` (the cheapest lever),
   `?cap=` to find the floor, grouping with `targets`, `live: 'auto'` so static surfaces stop
   redrawing, and the CSS fallback. Measured first, at P0.
2. **The `auto` backdrop's blind spots** — pseudo-elements, shadows, filters, SVG, form controls. Any
   chrome backdrop depending on those will look wrong through the glass. Mitigation: make them real
   nodes before the glass goes on.
3. **Geometry drift.** Panels must track the DOM through scroll, keyboard and rotation. The library
   follows scale and translate but not rotation, and reads shape from CSS. Mitigation: one
   measure-on-change routine and a `ResizeObserver`; drift shows as glass detached from its content.
4. **WebGL context budget.** About 16 per page. Mitigation: `targets` to group surfaces.

## 8. Conflicts with anything else on his plate

- Voice stays parked; none of this touches capture, playback or the speech path.
- The build's parse guard stays — it is what stops a dead page reaching his phone.
- Free, no-paid-tier only: MIT library, no service at the other end.
- The Android shell needs no rebuild; the page is loaded remotely.
