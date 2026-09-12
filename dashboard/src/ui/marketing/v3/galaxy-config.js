// Static configuration for the TokenGalaxy hero: provider anchors, particle
// counts, and the GLSL that moves every particle on the GPU. Colors are
// numeric (three.js) — the shared purple palette lives in palette.js.

// Provider orbs orbit the WHOLE hero like satellites — four above, four
// below, mirror-symmetric pairs — with the top-center and bottom-center kept
// open so the headline and the live counter breathe. RING_SLOTS are
// hand-placed screen positions (viewport %, y down); index i pairs with
// GALAXY_PROVIDERS[i].
export const GALAXY_PROVIDERS = [
  "claude", // right upper flank
  "opencode", // top-right
  "gemini", // top-left
  "copilot", // left upper flank
  "codex", // left, core level
  "antigravity", // bottom-left
  "cursor", // bottom-right
  "kimi", // right, core level
];

const RING_SLOTS = [
  { left: 88, top: 29 }, // claude
  { left: 73, top: 9 }, // opencode
  { left: 27, top: 9 }, // gemini
  { left: 12, top: 29 }, // copilot
  { left: 9, top: 57 }, // codex
  { left: 24, top: 79 }, // antigravity
  { left: 76, top: 79 }, // cursor
  { left: 91, top: 57 }, // kimi
];

// World-space disc the particles live on (before the X-axis tilt).
// The galaxy now lives in its own stage — the bottom half of the hero —
// viewed from above like a vortex rising over the horizon. The camera sits
// elevated and looks down at the disc, so the whole ring of provider icons
// and the bright core are fully visible, with the hero copy on clean black
// above it (no scrim fighting, no text overlap).
export const DISC = {
  radius: 13, // disc-body outer radius (world units) — geometry + shader share it
  tilt: -0.58, // radians; combined with the elevated camera → strong top-down perspective
  flatten: 0.72, // mild squash — most of the foreshortening comes from the camera angle
  swirl: 2.6, // spiral sweep from rim to core — high enough that streams wrap into arms
  cameraZ: 17,
  cameraY: 7.0, // elevated eye point looking down at the disc center
  cameraFov: 62,
  cameraDollyIn: 7, // extra distance the camera starts back at, for the entrance dolly
  cameraPushIn: 11, // how far the camera dives toward the core at full scroll progress
  introSeconds: 2.4, // entrance duration: streams grow from the chips into the core
  // Global orbital speed (rad/s): the whole system — orbs, their streams and
  // the disc — slowly revolves together like a real galaxy (~9 min per turn).
  orbitSpeed: 0.012,
  // Compact screens need enough movement to communicate the orbit within a
  // short mobile hero visit. One revolution takes roughly 45 seconds.
  mobileOrbitSpeed: 0.14,
  // A closer, narrower mobile camera lets the galaxy rim breathe past the
  // viewport edges while the black-hole focal point remains fixed at 68vh.
  mobileCameraZ: 20,
  mobileCameraY: 6,
  mobileCameraFov: 82,
  mobilePointScale: 1.45,
  mobileLensScale: 1.45,
  // The canvas covers the whole hero viewport (so no container edge can ever
  // slice the galaxy); this world-space drop parks the complete disc — far
  // rim to near rim — inside the lower half of the frame.
  yOffset: -3.9,
};

export function orbitSpeedForViewport({ compactViewport }) {
  return compactViewport ? DISC.mobileOrbitSpeed : DISC.orbitSpeed;
}

export function sceneConfigForViewport({ compactViewport }) {
  return compactViewport
    ? {
        cameraFov: DISC.mobileCameraFov,
        cameraY: DISC.mobileCameraY,
        cameraZ: DISC.mobileCameraZ,
        lensScale: DISC.mobileLensScale,
        lookAtY: DISC.yOffset,
        pointScale: DISC.mobilePointScale,
      }
    : {
        cameraFov: DISC.cameraFov,
        cameraY: DISC.cameraY,
        cameraZ: DISC.cameraZ,
        lensScale: 1,
        lookAtY: 0,
        pointScale: 1,
      };
}

// Camera-frame extents at the disc plane (z=0) for slot → world conversion:
// vertical half-extent from the camera fov/distance, horizontal via a 16:9
// design aspect (exact aspect varies per viewport; chips reproject live).
const FRAME_HALF_H = 10.56;
const FRAME_ASPECT = 1.78;

// The orbs travel on this fixed SCREEN-SPACE ellipse (viewport %). Orbiting
// along it keeps every orb inside the frame forever — orbiting disc-plane
// circles instead would fling the large-radius ones off screen.
const ORB_RING = { cx: 50, cy: 43, rx: 40, ry: 34 };
// Compact screens use a viewport-height galaxy stage, with the shared black
// hole / counter focal point at 68vh.
const MOBILE_ORB_RING = { cx: 50, cy: 68, rx: 43, ry: 19 };

// Initial angle of each provider on the orbit, matching the designed slots.
export function orbBaseAngles() {
  return RING_SLOTS.map((s) =>
    Math.atan2((ORB_RING.cy - s.top) / ORB_RING.ry, (s.left - ORB_RING.cx) / ORB_RING.rx),
  );
}

export function orbScreenPos(
  theta,
  scale = 1.0,
  compactViewport = false,
  compactCenterPct = MOBILE_ORB_RING.cy,
) {
  const ring = compactViewport ? MOBILE_ORB_RING : ORB_RING;
  const centerY = compactViewport ? compactCenterPct : ring.cy;
  return {
    left: ring.cx + Math.cos(theta) * ring.rx * scale,
    top: centerY - Math.sin(theta) * ring.ry * scale,
  };
}

// Screen % → world point on the disc plane (inverts flatten/tilt/yOffset),
// used to keep each orb's particle stream glued to it while it orbits.
function screenToPlane(left, top) {
  const cosT = Math.cos(DISC.tilt);
  const yFinal = ((50 - top) / 50) * FRAME_HALF_H;
  const xFinal = ((left - 50) / 50) * FRAME_HALF_H * FRAME_ASPECT;
  return { x: xFinal, y: (yFinal - DISC.yOffset) / (DISC.flatten * cosT), z: 0 };
}

// Anchor positions at t=0 (used to bake the initial stream geometry; the
// live positions stream in per-frame via the uAnchors uniform).
export function computeAnchors() {
  return orbBaseAngles().map((theta) => {
    const pos = orbScreenPos(theta);
    return screenToPlane(pos.left, pos.top);
  });
}

export function particleCounts({ lowPower }) {
  return lowPower
    ? { flow: 1400, disc: 4600, stars: 400 }
    : { flow: 4200, disc: 14000, stars: 1000 };
}

// Static-mode chip positions (CSS %, no WebGL). Mirrors the tilted disc:
// an ellipse squeezed vertically, centered slightly above the midline.
export function staticChipPositions() {
  return orbBaseAngles().map(orbScreenPos);
}

// Art-directed depth: true camera-distance differences across the ring are
// only ~6% (imperceptible), so the perspective is exaggerated by screen
// height — far (upper) orbs shrink, near (lower) ones grow. Also applied
// live as orbs orbit, so an orb visibly grows while swinging to the front.
export function slotDepthFactor(top) {
  const clamped = Math.min(79, Math.max(9, top));
  return 0.35 + ((clamped - 9) / 70) * 1.15;
}

export const GALAXY_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uPixelRatio;
  uniform float uSwirl;
  uniform float uFlatten;
  uniform float uTilt;
  uniform float uYOffset;
  uniform float uIntro;
  uniform float uOrbit;
  uniform vec3 uAnchors[8];
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  uniform float uProgress;
  uniform float uLensScale;
  uniform float uBlackHoleScale;
  uniform float uPointScale;
  attribute float aSeed;
  attribute float aPhase;
  attribute float aSize;
  attribute float aFlow;
  attribute float aStream;
  varying float vAlpha;
  varying float vGlow;
  varying vec3 vColor;
  varying vec2 vTangent;
  varying float vStretch;

  void main() {
    vec3 p;
    float glow = 0.0;
    float alpha = 1.0;
    float capture = 0.0;

    if (aFlow > 1.5) {
      // Galaxy disc body: fills the space between the provider streams.
      // Differential rotation (inner faster) plus a two-armed logarithmic
      // spiral brightness pattern — the luminous "body" of the galaxy.
      float r0 = length(position.xy);
      float ang0 = atan(position.y, position.x);
      float angSpeed = 0.09 / max(r0 / 11.0, 0.3);
      float ang = ang0 + uTime * angSpeed + uOrbit;
      float radius = r0 * (1.0 + 0.03 * sin(uTime * 0.5 + aSeed * 21.0));
      float zThick = mix(1.5, 0.3, radius / 11.0);
      p = vec3(cos(ang) * radius, sin(ang) * radius, (fract(aSeed * 3.7) - 0.5) * 2.0 * zThick);
      p.y *= uFlatten;

      // The two-armed brightness pattern visibly sweeps around the disc
      // (≈36 s per revolution) — this is what makes the whole galaxy read
      // as rotating, on top of the per-particle orbital motion.
      float arm = sin(2.0 * ang - 3.4 * log(max(radius, 0.4)) - uTime * 0.14);
      // Gentle arm modulation only — inter-arm gaps stay visibly starry, and
      // the chip-ring band is exempted entirely so the ring never dims.
      float armBoost = 0.46 + 0.54 * smoothstep(-0.3, 0.9, arm);
      armBoost = mix(armBoost, 1.0, smoothstep(8.0, 10.2, radius));
      // Extra glow on the band running through the outer disc.
      float ringBoost = 0.3 * smoothstep(8.0, 10.2, radius) * (1.0 - smoothstep(11.9, 14.0, radius));
      // Soft outer halo: fade gradually past the rim, no hard edge.
      float rimFade = 1.0 - 0.75 * smoothstep(11.9, 14.9, radius);
      float coreBoost = 1.0 - smoothstep(1.3, 11.0, radius);
      float tw = 0.75 + 0.25 * sin(uTime * (0.5 + aSeed) + aSeed * 30.0);
      // Far-side compensation: the tilted disc's far half sits deeper in
      // perspective (smaller, dimmer points) — brighten it so the rim reads
      // as one continuous ring instead of fading to black behind the headline.
      float farBoost = 1.0 + 0.6 * smoothstep(0.0, 8.0, p.y);
      alpha = (0.44 + 0.24 * coreBoost + ringBoost) * armBoost * tw * farBoost * rimFade * smoothstep(0.0, 0.65, uIntro);
      glow = coreBoost * 0.42 + ringBoost * 0.5;
    } else if (aFlow > 0.5) {
      // Journey from the provider anchor (live-fed via uAnchors, so streams
      // stay glued to the orbiting orbs) to the core (t=1).
      vec3 anchor = uAnchors[int(aStream + 0.5)];
      float speed = 0.05 + 0.035 * aSeed;
      float t = fract(uTime * speed + aPhase);
      float tt = pow(t, 1.35);
      float r0 = length(anchor.xy);
      float ang0 = atan(anchor.y, anchor.x);
      float dir = 0.85 + 0.3 * fract(aSeed * 7.31);
      float radius = mix(r0, 0.25, tt);
      capture = smoothstep(0.42, 0.96, tt);
      float winding = -log(max(1.0 - tt, 0.025)) * 1.35;
      float ang = ang0 + uSwirl * tt * dir + winding * capture;
      ang += sin(tt * 17.0 + aStream * 2.4 + uTime * 0.35) * capture * 0.08;
      vec2 radial = vec2(cos(ang), sin(ang));
      vec2 lateral = vec2(-radial.y, radial.x);
      // Tight comet band: wide-ish at the chip, needle-thin near the core.
      float band = mix(0.55, 0.035, tt);
      float off1 = (fract(aSeed * 13.37) - 0.5) * 2.0;
      float off2 = (fract(aSeed * 47.11) - 0.5) * 2.0;
      p = vec3(radial * radius, anchor.z * (1.0 - tt));
      p.xy += lateral * off1 * band + radial * off2 * band * 0.35;
      p.z += off2 * band * 0.5;
      // Squash the whole disc plane (path AND spawn point — the JS chip
      // projection applies the same factor so streams stay glued to icons).
      p.y *= uFlatten;

      // Fade in only after leaving the chip so particles appear to pour out
      // from BEHIND the icon instead of covering it.
      float fadeIn = smoothstep(0.025, 0.1, t);
      // Thin out well before the core so the convergence stays luminous but
      // never blows out into a white blob under the counter.
      float fadeOut = 1.0 - smoothstep(0.88, 0.995, t);
      // Emission spike just past the chip edge — the icon reads as firing.
      float spawn = (1.0 - smoothstep(0.05, 0.22, t)) * fadeIn;
      // Each stream breathes on its own rhythm, strongest near its source.
      float pulse = 0.72 + 0.28 * sin(uTime * 2.1 + aStream * 2.4);
      float streamPulse = mix(pulse, 1.0, tt);
      // Entrance: streams grow outward from the chips as uIntro sweeps 0 -> 1.
      float reveal = smoothstep(t - 0.12, t, uIntro);
      float farBoost = 1.0 + 0.5 * smoothstep(0.0, 8.0, p.y);
      alpha = 0.95 * fadeIn * fadeOut * streamPulse * reveal * farBoost * (1.0 + spawn * 0.9);
      alpha *= 1.0 - capture * 0.35;
      glow = smoothstep(0.5, 0.92, tt) * 0.7 + spawn * 0.55;
    } else {
      // Ambient starfield: slow drift + twinkle, fading in with the intro.
      p = position;
      p.x += sin(uTime * 0.05 + aSeed * 40.0) * 0.4;
      p.y += cos(uTime * 0.04 + aSeed * 55.0) * 0.3;
      float tw = 0.5 + 0.5 * sin(uTime * (0.6 + aSeed) + aSeed * 20.0);
      alpha = 0.22 * tw * uIntro;
    }

    // --- COSMIC BIG BANG EXPLOSION ---
    // Calculate 3D explosion direction based on the local position p
    // Adding some random spread on Z direction so it expands as a 3D dome/ellipsoid.
    vec3 explodeDir = normalize(p + vec3(0.0, 0.0, (fract(aSeed * 7.13) - 0.5) * 1.5));
    // Each particle has its own explosion speed based on aSeed
    float explodeSpeed = 0.4 + 0.6 * fract(aSeed * 19.87);
    // Exponential acceleration for the blast wave
    float expProgress = pow(uProgress, 2.2);
    float explodeDist = expProgress * 48.0 * explodeSpeed;
    
    // Displace the particle outward
    p += explodeDir * explodeDist;

    // Soft neon purple/pink/cyan flash at the start of the explosion
    // Peaks around uProgress = 0.2, cools down by 0.6
    float flash = smoothstep(0.0, 0.2, uProgress) * (1.0 - smoothstep(0.2, 0.6, uProgress));
    vec3 flashColor = mix(uColorA * 1.5, uColorC * 1.6, fract(aSeed * 3.0));
    
    // Scale particle sizes up moderately during the flash phase to intensify the explosion
    float sizeMultiplier = 1.0 + flash * 0.8;

    // Individual particle burnout based on uProgress and aSeed (burn out completely by progress = 0.80)
    float burnOut = smoothstep(0.08 + 0.52 * fract(aSeed * 23.45), 0.80, uProgress);
    alpha *= (1.0 - burnOut);
    // ---------------------------------

    // Tilt the whole disc around the X axis for depth.
    float c = cos(uTilt);
    float s = sin(uTilt);
    p = vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
    p.y += uYOffset;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);

    // --- GRAVITATIONAL LENSING WARP (3D BLACK HOLE) IN CAMERA SPACE ---
    vec3 bh_cam = (modelViewMatrix * vec4(0.0, uYOffset, 0.0, 1.0)).xyz;
    vec2 toParticle = mv.xy - bh_cam.xy;
    float r_cam = length(toParticle);
    float lensGlow = 0.0;
    if (r_cam > 0.001) {
      float R_E = 1.35 * uBlackHoleScale;
      float R_horizon = 1.38 * uBlackHoleScale;
      
      // Keep a smooth dark neighborhood for the continuous accretion disc.
      // Limit magnification so the inner stars stay fine instead of exploding
      // into a thick ring of white point sprites.
      alpha *= smoothstep(R_horizon * 0.92, R_horizon * 1.30, r_cam);
      float innerVisibility = mix(0.28, 0.72, capture);
      alpha *= mix(innerVisibility, 1.0, smoothstep(R_E * 2.1, R_E * 5.0, r_cam));
      float r_lensed = 0.5 * (r_cam + sqrt(r_cam * r_cam + 4.0 * R_E * R_E));
      float influence = 1.0 - smoothstep(R_E * 2.0, R_E * 6.0, r_cam);
      float shift = (r_lensed - r_cam) * influence * 0.80;
      mv.xy += toParticle * (shift / r_cam);
      mv.z += shift * 0.15;
      lensGlow = min(0.45, 0.65 / (r_cam + 1.0)) * influence;
    }

    // Stretch infalling points tangentially into short light trails. Use
    // projected direction so their orientation follows the tilted camera.
    vec2 tangent = vec2(-toParticle.y * projectionMatrix[0][0],
                         toParticle.x * projectionMatrix[1][1]);
    vTangent = normalize(vec2(tangent.x, -tangent.y) + vec2(0.00001));
    vStretch = 1.0 + capture * 1.6;
    gl_Position = projectionMatrix * mv;
    float dist = max(0.001, -mv.z);
    // Exaggerated near-big/far-small: particles low in the frame (near side
    // of the tilted disc) render larger than the far ones behind the copy.
    float depthK = mix(1.85, 0.45, smoothstep(-10.0, 8.0, p.y));
    
    // Scale particle sizes up based on lensing magnification
    sizeMultiplier *= 1.0 + lensGlow * 0.15;
    gl_PointSize = aSize * uPixelRatio * uPointScale * (26.0 / dist) * depthK * (1.0 + (glow + lensGlow * 0.35) * 1.7) * sizeMultiplier * vStretch * (1.0 - capture * 0.3);

    // Apply lensing color boost: blend into bright hot white/blue light at the Einstein Ring
    vColor = mix(mix(uColorA, uColorB, aSeed), uColorC, clamp(glow + lensGlow * 0.35, 0.0, 1.0) * 0.85);
    vColor = mix(vColor, flashColor, flash * 0.95);
    vAlpha = alpha;
    vGlow = glow;
  }
`;

export const GALAXY_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform float uGlobalAlpha;
  varying float vAlpha;
  varying float vGlow;
  varying vec3 vColor;
  varying vec2 vTangent;
  varying float vStretch;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    vec2 trailUv = vec2(dot(uv, vTangent), dot(uv, vec2(-vTangent.y, vTangent.x)));
    trailUv.y *= vStretch;
    float d = length(trailUv);
    float core = 1.0 - smoothstep(0.02, 0.5, d);
    float halo = (1.0 - smoothstep(0.18, 0.5, d)) * 0.3;
    float a = (core + halo * vGlow) * vAlpha * uGlobalAlpha;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;
