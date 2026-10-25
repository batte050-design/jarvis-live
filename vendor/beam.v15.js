// Voice beam for JARVIS Live — a native port of voice-glow.
//
// Geometry, palette and theme values are taken verbatim from the library:
//   voiceLobes / LOBE_SPACING / LOBE_SPAN / voicePalettes.mono.dark / themePresets.dark
//   packages/voice-glow/src/styles.ts
// Driver shape (gain, noise gate, attack/release envelope, three bands, flow
// phase, spread) follows packages/voice-glow/src/voiceDriver.ts.
//
// Their original renders this as CSS on DOM elements; this paints the same
// lobes to the page's canvas, which is what this page has. The numbers are
// theirs; only the drawing surface differs.
//
// Source: https://github.com/Jakubantalik/Libraries.dev — MIT, (c) 2026 Jakub Antalik.

// --- their lobe geometry, verbatim (px, for a ~350px-wide reference element) ---
export const VOICE_LOBES = [
  { x:    0, w: 74, h: 46, band: 0 },
  { x:  -36, w: 54, h: 40, band: 1 },
  { x:   36, w: 54, h: 40, band: 1 },
  { x:  -72, w: 48, h: 32, band: 2 },
  { x:   72, w: 48, h: 32, band: 2 },
  { x: -108, w: 42, h: 26, band: 1 },
  { x:  108, w: 42, h: 26, band: 1 }
];

export const LOBE_SPACING = 36;
export const LOBE_SPAN = LOBE_SPACING * VOICE_LOBES.length;   // 252

// --- their mono palette, dark variant (the page substrate is dark) ---
export const MONO_DARK = [
  'rgb(215, 215, 215)', 'rgb(180, 180, 180)', 'rgb(190, 190, 190)',
  'rgb(160, 160, 160)', 'rgb(170, 170, 170)', 'rgb(150, 150, 150)',
  'rgb(155, 155, 155)'
];

// --- their dark theme preset, verbatim ---
const THEME = { strokeOpacity: 1.16, innerOpacity: 0.47, bloomOpacity: 0.89 };

// Driver tuning, in the spirit of theirs: quick to rise, slower to fall, so the
// beam tracks a voice without flickering on every syllable.
const ATTACK = 0.28;          // per-frame rise toward the target
const RELEASE = 0.075;        // per-frame fall
const GATE = 0.055;           // below this the beam is simply off
const FLOW_PX_PER_S = 26;     // their "flow speed at full level"
const SOFT = 0.72;            // soft saturation knee, their style of shaping

export function createBeam() {
  return { level: 0, bands: [0, 0, 0], phase: 0 };
}

function shape(v) {
  // gain, then soft saturation so a loud voice compresses instead of clipping
  const g = Math.max(0, v - GATE) / (1 - GATE);
  return g <= SOFT ? g : SOFT + (1 - SOFT) * Math.tanh((g - SOFT) / (1 - SOFT));
}

/**
 * Advance the beam one frame and draw it.
 *   ctx      canvas 2d context
 *   b        state from createBeam()
 *   energy   overall level 0..1 (the page's reactor.energy)
 *   bands    [low, mid, high] 0..1, their band order
 *   cx, cy   where the beam sits (the orb's base line)
 *   radius   the orb radius, so the beam scales with it
 *   active   false when nothing is being heard or said
 */
export function drawBeam(ctx, b, energy, bands, cx, cy, radius, active) {
  const target = active ? shape(energy) : 0;
  for (let i = 0; i < 3; i++) {
    const t = active ? shape(bands[i]) : 0;
    const k = t > b.bands[i] ? ATTACK : RELEASE;
    b.bands[i] += (t - b.bands[i]) * k;
  }
  const k = target > b.level ? ATTACK : RELEASE;
  b.level += (target - b.level) * k;

  if (b.level < 0.004) return;                       // resting: nothing to draw

  b.phase += (FLOW_PX_PER_S * b.level) / 60;

  const scale = radius / 108;                        // outermost lobe reaches the orb edge
  const spread = 1 + 0.55 * b.level;                 // a loud sound pushes the sides apart
  const wrap = LOBE_SPAN / 2;
  const baseY = cy + radius * 0.62;                  // the beam rises from below the orb

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  for (let i = 0; i < VOICE_LOBES.length; i++) {
    const lobe = VOICE_LOBES[i];
    const lvl = b.bands[lobe.band];
    if (lvl < 0.012) continue;

    // their flow: every lobe slides along the ring, wrapping through the centre
    let slide = b.phase % LOBE_SPAN;
    let x = (lobe.x + slide - LOBE_SPAN / 2) * scale * spread;
    while (x > wrap * scale) x -= LOBE_SPAN * scale;
    while (x < -wrap * scale) x += LOBE_SPAN * scale;

    const w = lobe.w * scale * (1 + 0.5 * lvl);
    const h = lobe.h * scale * (1 + 2.4 * lvl);      // height is what the voice drives
    const colour = MONO_DARK[i % MONO_DARK.length];
    const rgb = colour.slice(4, -1);
    const a = Math.min(1, lvl * THEME.bloomOpacity);
    const px = cx + x;
    const py = baseY - h * 0.5;

    const g = ctx.createRadialGradient(px, py, 0, px, py, Math.max(2, w * 0.75));
    g.addColorStop(0, `rgba(${rgb}, ${a * THEME.innerOpacity})`);
    g.addColorStop(0.45, `rgba(${rgb}, ${a * 0.34})`);
    g.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(px, py, Math.max(2, w * 0.75), Math.max(2, h * 0.75), 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // the band line: a thin bright edge along the top of the glow, their "stroke"
  const hb = 30 * scale * (1 + 2.0 * b.level);
  const yb = baseY - hb;
  const lw = Math.max(80, radius * 2.6);
  const lg = ctx.createLinearGradient(cx - lw / 2, 0, cx + lw / 2, 0);
  const edge = Math.min(1, b.level * THEME.strokeOpacity);
  lg.addColorStop(0, 'rgba(220, 220, 220, 0)');
  lg.addColorStop(0.5, `rgba(235, 235, 235, ${edge * 0.5})`);
  lg.addColorStop(1, 'rgba(220, 220, 220, 0)');
  ctx.strokeStyle = lg;
  ctx.lineWidth = Math.max(1, 2 * scale * (1 + 1.6 * b.level));
  ctx.beginPath();
  ctx.moveTo(cx - lw / 2, yb);
  ctx.quadraticCurveTo(cx, yb - 26 * scale * b.level, cx + lw / 2, yb);
  ctx.stroke();

  ctx.restore();
}
