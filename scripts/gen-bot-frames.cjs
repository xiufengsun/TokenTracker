#!/usr/bin/env node
/**
 * Pre-render the `bot` character's animation frames for the macOS app.
 *
 * The engine (dashboard/src/lib/bot/) is a pure function of time, so we run the
 * REAL engine here at build time and ship the sampled frames. macOS then only
 * plays and interpolates them.
 *
 * This is deliberate. The alternative — porting states.ts / decor.ts / face.ts /
 * expressions.ts / eyefit.ts to Swift — is ~1900 lines of logic kept in sync by
 * hand, which is exactly the duplication this character was adopted to remove.
 * The engine stays the single source of truth; Swift is one of its consumers.
 *
 * Re-run this after touching lib/bot/ or lib/bot-appearance.js, or macOS will
 * keep animating stale frames. `npm run gen:bot-frames`.
 */

const { buildSync } = require("esbuild");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "TokenTrackerBar", "TokenTrackerBar", "BotFrames.json");

/**
 * Sampling rates, per clip.
 *
 * The pet window interpolates between frames (every silhouette is sampled at the
 * same 64 angles, so a midpoint is a pairwise lerp), which means 12 fps of data
 * renders as smooth motion at any display rate.
 *
 * The menu bar cannot do that — it plays pre-rendered NSImages through a Timer —
 * so the clips it uses are sampled twice as densely instead. Only those four are
 * affected, which keeps the bundle from doubling.
 */
const PET_FPS = 12;
const MENUBAR_FPS = 24;

/** Bundle the TypeScript engine into something require() can load. */
function loadEngine() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokentracker-bot-engine-"));
  const entry = path.join(tempDir, "entry.mjs");
  const bundle = path.join(tempDir, "engine.cjs");
  try {
    fs.writeFileSync(
      entry,
      [
        `export { BotEngine } from ${JSON.stringify(path.join(ROOT, "dashboard/src/lib/bot/engine.ts"))}`,
        `export { STATES, STATE_BY_ID } from ${JSON.stringify(path.join(ROOT, "dashboard/src/lib/bot/states.ts"))}`,
        `export { SHAPE_BY_ID, COLOR_BY_ID } from ${JSON.stringify(path.join(ROOT, "dashboard/src/lib/bot/skins.ts"))}`,
        `export { EXPRESSION_BY_ID } from ${JSON.stringify(path.join(ROOT, "dashboard/src/lib/bot/expressions.ts"))}`,
        `export { RAYON, DEMI_VIEWBOX } from ${JSON.stringify(path.join(ROOT, "dashboard/src/lib/bot/repere.ts"))}`,
        `export * from ${JSON.stringify(path.join(ROOT, "dashboard/src/lib/bot-appearance.js"))}`,
      ].join("\n"),
    );
    buildSync({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "cjs",
      logLevel: "warning",
      outfile: bundle,
    });
    return require(bundle);
  } finally {
    fs.rmSync(entry, { force: true });
    fs.rmSync(bundle, { force: true });
    fs.rmdirSync(tempDir);
  }
}

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * The engine emits three different kinds of path, and they must be serialized
 * differently — a single "just keep the numbers" encoding silently corrupts two
 * of them (the eyes come back empty, the rings get closed into loops):
 *
 *   body  "M p C c c p …Z"   cubic Bézier, 64 segments  -> bodyPolyline
 *   eyes  "M p A r r 0 0 1 p L p …Z"  arc capsule       -> capsule
 *   dots  "M p L p …Z"       closed polyline            -> polyline
 *   arcs  "M p L p …"        OPEN polyline (stroked)    -> polyline
 *
 * Coordinates are rounded to whole viewBox units: the box is 316 wide and the pet
 * draws at ~190pt, so a unit is well under a pixel, and playback is 12 fps anyway.
 */
function polyline(d) {
  if (!d) return null;
  const numbers = d.match(/-?\d+(?:\.\d+)?/g);
  return numbers ? numbers.map((n) => Math.round(Number(n))) : null;
}

/**
 * A stroked path split into its subpaths. Orbit and swirl rings arrive as TWO
 * `M` runs — one ring, broken where the body occludes it — so flattening them
 * into one point list draws a stray line across the whole figure.
 */
function polylineSubpaths(d) {
  if (!d) return null;
  const runs = d.split("M").filter((run) => run.trim().length > 0);
  const subpaths = runs.map((run) => polyline(run)).filter((run) => run && run.length >= 4);
  return subpaths.length > 0 ? subpaths : null;
}

/**
 * Eye capsule -> half-width, half-height, corner radius.
 *
 * `capsulePath(w, h)` is fully determined by those three numbers (and r is always
 * min(hw, hh)), so shipping them lets Swift build the shape with a rounded rect
 * instead of implementing SVG arc-to-centre conversion. Recovering them: the
 * leading `M` is at (-hw, -hh + r), and the first arc's rx IS r.
 */
function capsule(d) {
  if (!d) return null;
  const head = d.match(/^M(-?[\d.]+) (-?[\d.]+)A(-?[\d.]+) /);
  if (!head) return null;
  const hw = -Number(head[1]);
  const r = Number(head[3]);
  const hh = r - Number(head[2]);
  // Guard the invariant rather than trusting the regex: a shape that violates it
  // would silently render as the wrong eye.
  if (!(hw > 0 && hh > 0 && Math.abs(r - Math.min(hw, hh)) < 0.02)) return null;
  return [round(hw, 2), round(hh, 2), round(r, 2)];
}

/**
 * The body specifically: keep only the 64 on-curve points and drop the control
 * points. `closedPath` derives those from the neighbours (Catmull-Rom, tension
 * 1/6), so they are recomputable — storing them tripled the file for nothing.
 * Interpolating the on-curve points is also more correct: the tangents follow.
 *
 * Input shape is "M p0 C c1 c2 p1 C c1 c2 p2 ... C c1 c2 p0 Z" — 2 + 64*6 numbers.
 *
 * Kept to one decimal, NOT rounded to whole units: idle's liveliness breathes by
 * well under a unit, and integers quantised it away entirely — which showed up as
 * duplicate frames surviving interpolation, i.e. a pet that visibly stepped.
 */
function bodyPolyline(d) {
  const numbers = d?.match(/-?\d+(?:\.\d+)?/g);
  if (!numbers) return null;
  const flat = numbers.map(Number);
  const points = [round(flat[0], 1), round(flat[1], 1)];
  // Each cubic contributes 6 numbers; its endpoint is the last pair. The final
  // cubic closes back onto p0, so it is dropped.
  const cubics = (flat.length - 2) / 6;
  for (let i = 0; i < cubics - 1; i++) {
    points.push(round(flat[2 + i * 6 + 4], 1), round(flat[2 + i * 6 + 5], 1));
  }
  return points;
}

function matrixNumbers(matrix) {
  if (!matrix) return null;
  const numbers = matrix.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g);
  return numbers ? numbers.map((n) => round(Number(n), 4)) : null;
}

/** Mid stop of the gradient: macOS strokes the rings in one flat colour. */
function arcColor(stops) {
  if (!Array.isArray(stops) || stops.length === 0) return "#888888";
  return stops[Math.floor(stops.length / 2)];
}

function serializeFrame(frame) {
  return {
    body: bodyPolyline(frame.bodyPath),
    bodyAlpha: round(frame.bodyAlpha, 3),
    eyes: frame.eyes.map((eye) => {
      const shape = capsule(eye.d);
      if (eye.d && !shape) throw new Error(`Eye path is not a capsule: ${eye.d}`);
      return { c: shape, m: matrixNumbers(eye.matrix), a: round(eye.alpha, 3) };
    }),
    dots: frame.dots.map((dot) => ({
      x: round(dot.x, 1),
      y: round(dot.y, 1),
      r: dot.r === undefined ? null : round(dot.r, 2),
      d: polyline(dot.d),
      rot: dot.rot === undefined ? null : round(dot.rot, 2),
      depth: dot.depth === undefined ? null : round(dot.depth, 3),
      color: dot.color ?? null,
      opacity: round(dot.opacity ?? 1, 3),
    })),
    dotsBehind: Boolean(frame.dotsBehind),
    arcs: frame.arcs.map((arc) => ({
      back: polylineSubpaths(arc.back),
      front: polylineSubpaths(arc.front),
      width: round(arc.width, 2),
      opacity: round(arc.opacity, 3),
      color: arcColor(arc.grad?.stops),
    })),
    notif: frame.notif
      ? { x: round(frame.notif.x, 1), y: round(frame.notif.y, 1), r: round(frame.notif.r, 2) }
      : null,
    notch: frame.notch
      ? { x: round(frame.notch.x, 1), y: round(frame.notch.y, 1), r: round(frame.notch.r, 2) }
      : null,
  };
}

function main() {
  const bot = loadEngine();
  const shape = bot.SHAPE_BY_ID.get(bot.BOT_DEFAULT_SHAPE);
  if (!shape) throw new Error(`Unknown default shape ${bot.BOT_DEFAULT_SHAPE}`);
  const expression = bot.EXPRESSION_BY_ID.get(bot.BOT_DEFAULT_EXPRESSION) ?? null;

  const menubarStates = new Set(Object.values(bot.BOT_MENUBAR_CLIPS));
  const states = {};
  for (const id of bot.botReachableStates()) {
    const def = bot.STATE_BY_ID.get(id);
    if (!def) throw new Error(`Unknown engine state ${id}`);
    // A fresh engine per state so each clip starts from that state's own pose
    // rather than mid-morph out of the previous one. Cross-state morphing is
    // Swift's job — it lerps between the two clips' control points.
    const engine = new bot.BotEngine(bot.RAYON, id, shape.radii, expression);
    const fps = menubarStates.has(id) ? MENUBAR_FPS : PET_FPS;
    const count = Math.max(1, Math.round(def.duration * fps));
    const frames = [];
    for (let i = 0; i < count; i++) frames.push(serializeFrame(engine.sample(i / fps)));
    // Whether the clip can be looped, measured rather than assumed. Several states
    // are one-shot in the upstream engine (its editor plays them as a montage, not on
    // repeat): orbit morphs the body out of a spinning triangle and ends as a ball
    // with rings faded in, so wrapping it back to frame 0 crosses ~130 viewBox units
    // in a single frame. Those clips hold their last frame instead, which is also
    // what the web renderer does — its clock keeps running and the engine settles.
    const first = frames[0].body;
    const last = frames[frames.length - 1].body;
    let seam = 0;
    if (first.length === last.length) {
      for (let i = 0; i < first.length; i++) seam = Math.max(seam, Math.abs(first[i] - last[i]));
    } else {
      seam = Infinity;
    }
    // 6 units of a 316-unit box: below this the wrap is imperceptible, and it cleanly
    // separates the genuinely cyclic states from the one-shot ones.
    const loops = seam <= 6;

    states[id] = {
      fps,
      loops,
      seam: Number.isFinite(seam) ? round(seam, 1) : null,
      duration: round(def.duration, 3),
      // How long the engine takes to morph INTO this state; Swift reuses it as
      // the cross-fade length when it lerps out of the previous clip.
      morph: round(def.morph, 3),
      baseFace: Boolean(def.baseFace),
      frames,
    };
  }

  // Ship the pet-state -> engine-state mapping too, so macOS looks it up instead of
  // mirroring lib/bot-appearance.js by hand. That mirroring is the failure mode this
  // whole pre-render exists to avoid.
  const scenes = {};
  for (const petState of bot.botMappedPetStates()) {
    scenes[petState] = bot.botSceneForPetState(petState).state;
  }

  // The palette too: hex values live in the engine's skins.ts, and the picker's
  // curated subset in bot-appearance.js. Neither should be retyped in Swift.
  const palette = {};
  for (const id of bot.BOT_COLOR_CHOICES) {
    if (id === "auto") continue;
    const entry = bot.COLOR_BY_ID.get(id);
    if (!entry) throw new Error(`Palette is missing ${id}`);
    palette[id] = entry.hex;
  }
  const autoColors = {
    light: bot.COLOR_BY_ID.get(bot.BOT_DEFAULT_COLOR_LIGHT).hex,
    dark: bot.COLOR_BY_ID.get(bot.BOT_DEFAULT_COLOR_DARK).hex,
  };

  const payload = {
    // Bumped when the frame schema changes so a stale bundled file is detectable.
    schema: 4,
    radius: bot.RAYON,
    halfViewBox: bot.DEMI_VIEWBOX,
    shape: bot.BOT_DEFAULT_SHAPE,
    expression: bot.BOT_DEFAULT_EXPRESSION,
    scenes,
    paper: bot.BOT_PAPER,
    menubarClips: bot.BOT_MENUBAR_CLIPS,
    palette,
    autoColors,
    states,
  };

  const serialized = `${JSON.stringify(payload)}\n`;

  // --check: the committed file must match what the engine produces now. It is
  // checked in because the Xcode build needs it and CI's macOS job does not run
  // Node, so a stale copy would silently ship old animations.
  if (process.argv.includes("--check")) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
    if (existing === serialized) {
      process.stdout.write(`bot frames up to date (${path.relative(ROOT, OUT)})\n`);
      return;
    }
    process.stderr.write(
      `${path.relative(ROOT, OUT)} is ${existing === null ? "missing" : "stale"}.\n` +
        `The engine or the state mapping changed. Run: npm run gen:bot-frames\n`,
    );
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(OUT, serialized);
  const bytes = fs.statSync(OUT).size;
  const totalFrames = Object.values(states).reduce((sum, s) => sum + s.frames.length, 0);
  process.stdout.write(
    `bot frames -> ${path.relative(ROOT, OUT)}\n` +
      `  ${Object.keys(states).length} states, ${totalFrames} frames (${MENUBAR_FPS}fps for the ${Object.keys(payload.menubarClips).length} menu bar clips, ${PET_FPS} elsewhere), ` +
      `${(bytes / 1024).toFixed(0)} KB\n`,
  );
}

main();
