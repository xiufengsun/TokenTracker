import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  buildQuipPool,
  buildPetLimitSummaries,
  formatCompactTokens as formatTokens,
  getPetLimitDisplay,
  formatPetLimitSummary,
  normalizePetLocale,
  petLabels,
} from "./lib/pet-quips.js";
import {
  normalizePetCharacter,
  petRenderer,
  pickPetAmbientState,
  resolvePetState,
} from "./lib/pet-personality.js";
import { BOT_COLOR_CHOICES } from "./lib/bot-appearance.js";
import { petVisualScale } from "./lib/pet-appearance.js";
import { BotAnimated } from "./ui/foundation/BotAnimated.jsx";
import { PetAtlasAnimated } from "./ui/foundation/PetAtlasAnimated.jsx";
import { usePetCatalog } from "./hooks/use-pet-catalog.js";

/**
 * Standalone floating-pet entry for the Windows tray app (PetWindow.cs loads
 * `/pet.html?app=1`). Deliberately tiny: it renders ONLY the animated Clawd
 * companion on a fully transparent surface — no router, providers, sidebar or
 * global styles.
 *
 * Behaviour mirrors the macOS popover companion (ClawdCompanionView.swift):
 *   • Auto state: live sync/typing/errors win; usage volume, streak and model variety
 *     feed short ambient scenes (thinking/juggling/wizard) every 12–25s.
 *   • tap (click in place) → cycles the "fun" animations in order, 2.5s each.
 *   • drag (left-press + move) → moves the window (host runs the OS move loop).
 *   • right-click → opens the full dashboard panel.
 *
 * State source: the pet runs in its own WebView2 partition, so it can't read the
 * dashboard's localStorage NOR should it poll usage independently (that drifts
 * from the tray). The native host pushes EVERYTHING — currency, locale, today's
 * usage (the same numbers the tray's UsagePoller fetched), syncing + connection —
 * via `window.__ttPet*` globals + `pet:*` events, so the pet always matches the tray.
 */

const TAP_HOLD_MS = 2500;
// Pointer travel (px) past which a left-press is treated as a drag, not a tap.
// Kept generous: an ordinary click jitters a few px, and once a drag is detected
// the native HTCAPTION move loop takes over (the window can't snap back to a tap),
// so too small a value makes every click nudge the pet's position.
const DRAG_THRESHOLD = 10;
// Top band reserved for the bubble so it never overlaps Clawd (the host sizes the
// window height to include this — keep in sync with PetWindow.SizeDimensions). The
// hover card can show several active, non-full limits as compact progress rows.
const MIN_BUBBLE_BAND = 138;

// Hover lean (macOS parity): while the cursor is over the pet, Clawd leans toward it
// (ClawdCompanionView shifts the body ±1.2px and the eyes a touch more, ≈7% of width).
// We approximate that with a horizontal lean + a small tilt, proportional to how far
// the cursor sits from center (−1 = far left … +1 = far right). Small center deadzone.
const LEAN_DEADZONE = 0.12;
const LEAN_MAX_SHIFT_FRAC = 0.07; // translateX, as a fraction of the sprite size
const LEAN_MAX_TILT_DEG = 3;      // subtle tilt toward the cursor, for a "looking" feel
// Eyes additionally glance toward the cursor, in SVG user units (the artboard is 15
// wide), on top of the body lean — mirrors macOS hoverEyeShift (±0.5px in a 15-grid).
const EYE_GLANCE_UNITS = 0.6;

// Tapping cycles these in order — the full macOS tapAnimations set. Heads-up: the last
// two (sleeping, error) are "sploot" poses that flatten the crab onto the floor (torso
// drops from y6 to y10–15), so tapping into them makes it visibly lie down. The crab
// stays horizontally anchored (feet/shadow pinned) — it just lowers, by design.
const TAP_ANIMATIONS = [
  "happy",
  "working-wizard",
  "working-juggling",
  "working-thinking",
  "working-ultrathink",
  "working-typing",
  "disconnected",
  "idle-look",
  "idle-doze",
  "sleeping",
  "error",
];
// Idle variety: rotate every 12–25s, weighted toward the calm "living" pose.
function readPetUsage() {
  const tk = Number(window.__ttPetTokens);
  const cost = Number(window.__ttPetCostUsd);
  return {
    tokens: Number.isFinite(tk) ? tk : 0,
    costUsd: Number.isFinite(cost) ? cost : 0,
  };
}

// The full stats object the host pushes (window.__ttPetStats) — today + rolling 7d/30d
// + heatmap + top models + conversations. Read fresh at tap time so the quip pool always
// reflects the latest poll. Falls back to today-only numbers if the host hasn't pushed yet.
function readPetStats() {
  const s = typeof window !== "undefined" ? window.__ttPetStats : null;
  const today = readPetUsage();
  const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
  return {
    todayTokens: num(s?.todayTokens, today.tokens),
    todayCostUsd: num(s?.todayCostUsd, today.costUsd),
    costPartial: s?.costPartial === true,
    conversations: num(s?.conversations),
    last7dTokens: num(s?.last7dTokens),
    last7dActiveDays: num(s?.last7dActiveDays),
    last30dTokens: num(s?.last30dTokens),
    last30dAvgPerDay: num(s?.last30dAvgPerDay),
    streakDays: num(s?.streakDays),
    activeDaysAllTime: num(s?.activeDaysAllTime),
    topModels: Array.isArray(s?.topModels) ? s.topModels : [],
  };
}

function readPetLimitSummaries() {
  const limits = typeof window !== "undefined" ? window.__ttPetLimits : null;
  return buildPetLimitSummaries(limits);
}

function readPetConnected() {
  // Default to connected until the host says otherwise.
  return window.__ttPetConnected !== false;
}

function readPetCurrency() {
  const c = typeof window !== "undefined" ? window.__ttPetCurrency : null;
  const rate = Number(c?.rate);
  return {
    symbol: c?.symbol || "$",
    rate: Number.isFinite(rate) && rate > 0 ? rate : 1,
  };
}

function readPetLocale() {
  return normalizePetLocale(typeof window !== "undefined" ? window.__ttPetLocale : null);
}

function readPetCharacter() {
  return normalizePetCharacter(typeof window !== "undefined" ? window.__ttPetCharacter : null);
}

function readPetBotColor() {
  const value = typeof window !== "undefined" ? window.__ttPetBotColor : null;
  return BOT_COLOR_CHOICES.includes(value) ? value : "auto";
}

function post(type) {
  try { window.chrome?.webview?.postMessage(type); } catch { /* not in WebView2 */ }
}

function readPetBubbleBand() {
  const value = Number(window.__ttPetBubbleBand);
  return Number.isFinite(value) && value >= MIN_BUBBLE_BAND ? value : MIN_BUBBLE_BAND;
}

function sizeFor(bubbleBand = readPetBubbleBand()) {
  // The sprite tracks the smaller of (width, height MINUS the reserved bubble band),
  // so it fills the lower area without growing into the bubble's space.
  return Math.max(40, Math.min(window.innerWidth, window.innerHeight - bubbleBand) - 8);
}

// ── Fixed-frame Clawd renderer (macOS parity) ────────────────────────────────
//
// The macOS companion frames every pose on the character's fixed 15×16 artboard
// (ClawdCompanionView: `.frame(width: 15*px, height: 16*px)`), so the crab never
// rescales or drifts between states. The shared web <ClawdAnimated> instead re-crops
// the viewBox to each pose's OWN content bbox (getBBox), which makes the sprite jump
// in size + position on every tap. We can't change that shared component (it's in the
// mac/web main bundle), so the pet renders Clawd itself, pinning the fixed frame.
//
// Every clawd SVG draws the character at the same coords (torso ~x2–13, y6–15); the
// animated poses just add overshoot padding around it. Pinning viewBox "0 0 15 16"
// frames exactly the character on every pose — identical scale + anchor, like macOS.
const CLAWD_FRAME_VIEWBOX = "0 0 15 16";

// The poses the pet shows (subset of ClawdAnimated.STATE_TO_PATH), kept local so the
// shared component stays untouched.
const PET_STATE_TO_PATH = {
  "idle-living": "idle/living.svg",
  "idle-look": "idle/look.svg",
  "idle-doze": "idle/doze.svg",
  "yawning": "idle/yawn.svg",
  "collapsing": "idle/collapse.svg",
  "waking": "sleep/wake.svg",
  "working-typing": "working/typing.svg",
  "working-thinking": "working/thinking.svg",
  "working-ultrathink": "working/ultrathink.svg",
  "working-juggling": "working/juggling.svg",
  "working-wizard": "working/wizard.svg",
  "working-overheated": "working/overheated.svg",
  "happy": "happy.svg",
  "sleeping": "sleep/sleeping.svg",
  "disconnected": "status/disconnected.svg",
  "error": "status/error.svg",
  "static-base": "static-base.svg",
  // Mini mode variants
  "mini-idle": "mini/idle.svg",
  "mini-peek": "mini/peek.svg",
  "mini-alert": "mini/alert.svg",
  "mini-happy": "mini/happy.svg",
  "mini-sleep": "mini/sleep.svg",
  "mini-enter": "mini/enter.svg",
  "mini-enter-sleep": "mini/enter-sleep.svg",
  "mini-crabwalk": "mini/crabwalk.svg",
  "running-left": "mini/crabwalk.svg",
  "running-right": "mini/crabwalk.svg",
};

const petSvgCache = new Map();
async function fetchPetSvg(path) {
  if (petSvgCache.has(path)) return petSvgCache.get(path);
  const resp = await fetch(`/clawd/${path}`);
  if (!resp.ok) return null;
  const raw = await resp.text();
  // Strip the SVG's own sizing and pin the fixed character frame so every pose scales
  // + anchors identically (no per-pose bbox crop). Keep the inlined <style>/@keyframes
  // so the animations still run.
  const result = raw.replace(/<svg([^>]*)>/, (_m, attrs) => {
    const cleaned = attrs
      .replace(/\s+width="[^"]*"/g, "")
      .replace(/\s+height="[^"]*"/g, "")
      .replace(/\s+viewBox="[^"]*"/g, "")
      .replace(/\s+preserveAspectRatio="[^"]*"/g, "");
    return `<svg${cleaned} viewBox="${CLAWD_FRAME_VIEWBOX}" preserveAspectRatio="xMidYMid meet" width="100%" height="100%">`;
  });
  petSvgCache.set(path, result);
  return result;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Animated Clawd locked to the fixed 15×16 character frame (see above), with the eyes
 * glancing toward the cursor while hovering (`leanX`, −1..+1).
 *
 * Each pose wraps its eyes in a <g> whose class/id contains "eye" (e.g. eyes-look,
 * eyes-focus, eyes-read). Those groups already run their own blink/track transform
 * animations, which would override any transform we set directly — so after a pose
 * loads we wrap each (non-shut) eye group in our own <g> and translate THAT, letting
 * the inner animation keep running relative to it.
 */
function PetClawd({ state, size, leanX }) {
  const [svgHtml, setSvgHtml] = useState("");
  const containerRef = useRef(null);
  const eyeWrapsRef = useRef([]);
  const leanRef = useRef(leanX);
  const path = PET_STATE_TO_PATH[state] || PET_STATE_TO_PATH["static-base"];

  useEffect(() => {
    let cancelled = false;
    fetchPetSvg(path).then((html) => { if (!cancelled && html) setSvgHtml(html); });
    return () => { cancelled = true; };
  }, [path]);

  // After each pose loads, wrap its outermost (open) eye group(s) so we can glance them.
  useEffect(() => {
    eyeWrapsRef.current = [];
    const svg = containerRef.current?.querySelector("svg");
    if (!svg) return;
    const matches = Array.from(svg.querySelectorAll('[class*="eye"],[id*="eye"]'));
    // Keep only the outermost eye element(s) (drop nested blink groups, etc.).
    const outer = matches.filter((el) => !matches.some((o) => o !== el && o.contains(el)));
    for (const el of outer) {
      const tag = `${el.getAttribute("class") || ""} ${el.id || ""}`;
      if (/shut|closed|sleep/i.test(tag)) continue; // closed eyes — nothing to glance
      const wrap = document.createElementNS(SVG_NS, "g");
      el.parentNode.insertBefore(wrap, el);
      wrap.appendChild(el);
      eyeWrapsRef.current.push(wrap);
    }
    applyGlance(leanRef.current);
  }, [svgHtml]);

  // Glance the eyes toward the cursor whenever the lean changes.
  useEffect(() => {
    leanRef.current = leanX;
    applyGlance(leanX);
  }, [leanX]);

  function applyGlance(lx) {
    const dx = lx * EYE_GLANCE_UNITS;
    for (const w of eyeWrapsRef.current) w.setAttribute("transform", `translate(${dx},0)`);
  }

  return (
    <div
      ref={containerRef}
      className="clawd-animated"
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
      dangerouslySetInnerHTML={{ __html: svgHtml }}
    />
  );
}

function PetCharacterSprite({ state, dragState, size, leanX, character, pet, lookDirectionIndex, botColor }) {
  const renderer = petRenderer(character);
  if (renderer === "vector") {
    // The outer wrapper already applies the body lean; leanX here drives the
    // engine's spherical gaze, which replaces the flat eye shift Clawd uses.
    return (
      <BotAnimated
        state={state}
        dragState={dragState}
        size={size * petVisualScale(character)}
        leanX={leanX}
        color={botColor}
      />
    );
  }
  if (renderer === "atlas") {
    return (
      <PetAtlasAnimated
        character={character}
        pet={pet}
        state={state}
        dragState={dragState}
        size={size}
        lookDirectionIndex={lookDirectionIndex}
      />
    );
  }
  return <PetClawd state={dragState || state} size={size * petVisualScale(character)} leanX={leanX} />;
}

const PET_STATUS_COLORS = {
  good: "rgba(116, 235, 174, 0.96)",
  warning: "rgba(255, 203, 105, 0.98)",
  danger: "rgba(255, 116, 126, 0.98)",
};

/** Transparent glass speech bubble shown in the top band. Hover usage gets a
    compact token row plus one progress row for every active, non-full limit. */
function Bubble({ text, usage = null, onHeightChange }) {
  const bubbleRef = useRef(null);

  useLayoutEffect(() => {
    const element = bubbleRef.current;
    if (!element || !onHeightChange) return undefined;
    const report = () => onHeightChange(Math.ceil(element.getBoundingClientRect().height) + 12);
    report();
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onHeightChange]);

  return (
    <div
      ref={bubbleRef}
      style={{
        position: "relative",
        width: "min(340px, calc(100% - 40px))",
      }}
    >
      <div
        role="status"
        aria-live="polite"
        aria-label={usage?.ariaLabel || text}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: usage ? "9px 13px 10px" : "5px 11px 6px",
          borderRadius: 22,
          color: "rgba(255,255,255,0.94)",
          background: "linear-gradient(145deg, rgba(18,20,24,0.82), rgba(30,32,38,0.72))",
          border: "1px solid rgba(255,255,255,0.24)",
          boxShadow: "0 4px 8px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.16)",
          backdropFilter: "blur(18px) saturate(145%)",
          WebkitBackdropFilter: "blur(18px) saturate(145%)",
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        {usage ? (
          <div style={{ display: "grid", gap: 0, minWidth: 0, textAlign: "left" }}>
            {usage.tokenText && (
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  flexWrap: "wrap",
                  gap: 8,
                  fontVariantNumeric: "tabular-nums",
                  paddingBottom: 6,
                  marginBottom: 4,
                  borderBottom: "1px solid rgba(255,255,255,0.13)",
                }}
              >
                <span style={{ fontSize: 11.5, fontWeight: 750, lineHeight: 1.1, letterSpacing: "0.01em" }}>
                  {usage.tokenText} tokens
                </span>
                {usage.costText && (
                  <span style={{ marginLeft: "auto", color: "rgba(255,255,255,0.68)", fontSize: 9.5, lineHeight: 1.1 }}>
                    {usage.costText}
                  </span>
                )}
              </div>
            )}
            {usage.limits?.map((limit, index) => {
              const toneColor = PET_STATUS_COLORS[limit.tone] || PET_STATUS_COLORS.good;
              const progress = Math.max(2, Math.min(100, Number(limit.value) || 0));
              const rowTop = index !== 0 || Boolean(usage.tokenText) ? 3 : 0;
              return (
                <div
                  key={`${limit.provider}-${limit.window}`}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) 50px 42px",
                    alignItems: "center",
                    gap: 7,
                    minWidth: 0,
                    paddingTop: rowTop,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  <span style={{ minWidth: 0, overflowWrap: "anywhere", fontSize: 9.5, fontWeight: 650, lineHeight: 1.15 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        display: "inline-block",
                        width: 5,
                        height: 5,
                        marginRight: 6,
                        borderRadius: "50%",
                        background: toneColor,
                        boxShadow: `0 0 0 3px ${toneColor.replace("0.96", "0.12").replace("0.98", "0.12")}`,
                      }}
                    />
                    {limit.provider} {limit.window}
                  </span>
                  <span
                    aria-hidden="true"
                    style={{
                      display: "block",
                      width: 50,
                      height: 4,
                      overflow: "hidden",
                      borderRadius: 999,
                      background: "rgba(255,255,255,0.16)",
                    }}
                  >
                    <span
                      style={{
                        display: "block",
                        width: `${progress}%`,
                        height: "100%",
                        borderRadius: 999,
                        background: toneColor,
                        boxShadow: `0 0 6px ${toneColor}`,
                      }}
                    />
                  </span>
                  <span style={{ width: 42, color: "rgba(255,255,255,0.58)", fontSize: 8.5, fontWeight: 500, lineHeight: 1, textAlign: "right", letterSpacing: "0.01em" }}>
                    {limit.resetText || ""}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 7 }}>
            <span
              aria-hidden="true"
              style={{
                width: 5,
                height: 5,
                flex: "0 0 auto",
                marginTop: 4,
                borderRadius: "50%",
                background: "rgba(255,255,255,0.9)",
                boxShadow: "0 0 0 3px rgba(255,255,255,0.08)",
              }}
            />
            <span
              style={{
                minWidth: 0,
                overflowWrap: "anywhere",
                textAlign: "left",
                fontSize: 11,
                fontWeight: 600,
                lineHeight: 1.25,
                letterSpacing: "0.01em",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {text}
            </span>
          </div>
        )}
      </div>
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "50%",
          bottom: -4,
          width: 8,
          height: 8,
          transform: "translateX(-50%) rotate(45deg)",
          background: "rgba(255,255,255,0.06)",
          borderRight: "1px solid rgba(255,255,255,0.18)",
          borderBottom: "1px solid rgba(255,255,255,0.18)",
          backdropFilter: "blur(18px) saturate(145%)",
          WebkitBackdropFilter: "blur(18px) saturate(145%)",
        }}
      />
    </div>
  );
}

function Pet() {
  const { pets, refresh: refreshPetCatalog } = usePetCatalog();
  const [today, setToday] = useState(readPetUsage);
  const [limitSummaries, setLimitSummaries] = useState(readPetLimitSummaries);
  const [connected, setConnected] = useState(readPetConnected);
  const [currency, setCurrency] = useState(readPetCurrency);
  const [locale, setLocale] = useState(readPetLocale);
  const [character, setCharacter] = useState(readPetCharacter);
  const [botColor, setBotColor] = useState(readPetBotColor);
  const [isSyncing, setIsSyncing] = useState(false);
  const [userTyping, setUserTyping] = useState(false);
  const [rage, setRage] = useState(false);
  const [idleVariant, setIdleVariant] = useState("idle-living");
  const [tapState, setTapState] = useState(null);
  const [speech, setSpeech] = useState(null);
  const [dragState, setDragState] = useState(null);
  const [hovering, setHovering] = useState(false);
  const [leanX, setLeanX] = useState(0); // −1..+1, cursor offset from center while hovering
  const [lookDirectionIndex, setLookDirectionIndex] = useState(null);
  const [size, setSize] = useState(sizeFor);
  const [bubbleBand, setBubbleBand] = useState(readPetBubbleBand);
  const [miniMode, setMiniMode] = useState(false);
  const [sleepState, setSleepState] = useState(null);
  const [modelStatus, setModelStatus] = useState(null);
  const selectedPet = pets.find((pet) => pet.id === character) || pets[0];
  const dragRef = useRef(null);
  const tapIndexRef = useRef(0);
  const quipIndexRef = useRef(0); // rotates through the quip pool on each tap (macOS quipIndex)
  const tapTimer = useRef(0);
  const idleTimer = useRef(0);
  const wakeTimer = useRef(0);
  const modelStatusTimer = useRef(0);

  // Subscribe to miniMode, sleep, and model status updates pushed by the host.
  useEffect(() => {
    const update = () => setMiniMode(Boolean(window.__ttPetMiniMode));
    update();
    window.addEventListener("pet:minimode", update);
    return () => window.removeEventListener("pet:minimode", update);
  }, []);

  useEffect(() => {
    const update = () => {
      const next = readPetBubbleBand();
      setBubbleBand(next);
      setSize(sizeFor(next));
    };
    update();
    window.addEventListener("pet:bubble-band", update);
    return () => window.removeEventListener("pet:bubble-band", update);
  }, []);

  useEffect(() => {
    const handleWake = () => {
      clearTimeout(wakeTimer.current);
      setSleepState("waking");
      wakeTimer.current = setTimeout(() => setSleepState(null), 1500);
    };
    const handleSleep = (e) => {
      clearTimeout(wakeTimer.current);
      setSleepState(e.detail?.phase || "sleeping");
    };
    window.addEventListener("pet:wake", handleWake);
    window.addEventListener("pet:sleep", handleSleep);
    return () => {
      clearTimeout(wakeTimer.current);
      window.removeEventListener("pet:wake", handleWake);
      window.removeEventListener("pet:sleep", handleSleep);
    };
  }, []);

  useEffect(() => {
    const handleModelStatus = (e) => {
      clearTimeout(modelStatusTimer.current);
      setModelStatus(e.detail || null);
      // Auto-clear so the increment bubble is transient (parity with macOS' 3s timer).
      modelStatusTimer.current = setTimeout(() => setModelStatus(null), 3000);
    };
    window.addEventListener("pet:model-status", handleModelStatus);
    return () => {
      clearTimeout(modelStatusTimer.current);
      window.removeEventListener("pet:model-status", handleModelStatus);
    };
  }, []);

  // Usage + connection are pushed by the native host (same numbers the tray shows),
  // so the pet never drifts from the app and does no independent polling.
  useEffect(() => {
    const update = () => setToday(readPetUsage());
    update();
    window.addEventListener("pet:usage", update);
    return () => window.removeEventListener("pet:usage", update);
  }, []);
  useEffect(() => {
    const update = () => setLimitSummaries(readPetLimitSummaries());
    update();
    window.addEventListener("pet:limits", update);
    return () => window.removeEventListener("pet:limits", update);
  }, []);
  useEffect(() => {
    const update = () => setConnected(readPetConnected());
    update();
    window.addEventListener("pet:connected", update);
    return () => window.removeEventListener("pet:connected", update);
  }, []);

  // Currency + locale pushed by the native host.
  useEffect(() => {
    const update = () => setCurrency(readPetCurrency());
    update();
    window.addEventListener("pet:currency", update);
    return () => window.removeEventListener("pet:currency", update);
  }, []);
  useEffect(() => {
    const update = () => setLocale(readPetLocale());
    update();
    window.addEventListener("pet:locale", update);
    return () => window.removeEventListener("pet:locale", update);
  }, []);
  useEffect(() => {
    const update = () => {
      setCharacter(readPetCharacter());
      refreshPetCatalog();
    };
    update();
    window.addEventListener("pet:character", update);
    return () => window.removeEventListener("pet:character", update);
  }, [refreshPetCatalog]);
  useEffect(() => {
    const update = () => setBotColor(readPetBotColor());
    update();
    window.addEventListener("pet:botColor", update);
    return () => window.removeEventListener("pet:botColor", update);
  }, []);
  // This host renders without ThemeProvider, so the `dark` class nothing else sets
  // here is applied from the appearance the native shell pushes. BotAnimated reads
  // that class to resolve its theme-following default colour.
  useEffect(() => {
    const apply = () => {
      // Undefined only before the first PushContext; the Windows shell opens dark.
      const dark = window.__ttPetDark !== false;
      document.documentElement.classList.toggle("dark", dark);
    };
    apply();
    window.addEventListener("pet:dark", apply);
    return () => window.removeEventListener("pet:dark", apply);
  }, []);
  // Syncing state pushed by the native host (drives the typing animation, like macOS).
  useEffect(() => {
    const update = () => setIsSyncing(Boolean(window.__ttPetSyncing));
    update();
    window.addEventListener("pet:syncing", update);
    return () => window.removeEventListener("pet:syncing", update);
  }, []);
  // The native host detects global typing activity (count-only, no key content) and
  // pushes it here so Clawd types along while you type — anywhere.
  useEffect(() => {
    const update = () => setUserTyping(Boolean(window.__ttPetTyping));
    update();
    window.addEventListener("pet:typing", update);
    return () => window.removeEventListener("pet:typing", update);
  }, []);
  // "Overheat" gag: after the host sees ~30s of non-stop typing it sets this; Clawd
  // plays the error (fanning/steaming = cooling off) pose for a ~30s cooldown.
  useEffect(() => {
    const update = () => setRage(Boolean(window.__ttPetRage));
    update();
    window.addEventListener("pet:rage", update);
    return () => window.removeEventListener("pet:rage", update);
  }, []);

  // Keep Clawd filling the window as the host resizes it.
  useEffect(() => {
    const onResize = () => setSize(sizeFor(readPetBubbleBand()));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Hover is driven by the native host (PetWindow polls the OS cursor vs the
  // window rect and pushes `window.__ttPetHover` + a `pet:hover` event). DOM
  // mouse-leave is unreliable on this transparent, never-activated topmost window
  // — it would leave the bubble stuck — so we don't use it.
  useEffect(() => {
    const update = () => setHovering(Boolean(window.__ttPetHover));
    update();
    window.addEventListener("pet:hover", update);
    return () => window.removeEventListener("pet:hover", update);
  }, []);

  // When the cursor leaves, straighten Clawd back up (no stuck lean — DOM moves stop
  // firing on leave, so the host's hover signal is what tells us we've left).
  useEffect(() => {
    if (!hovering) {
      setLeanX(0);
    }
  }, [hovering]);

  useEffect(() => {
    const update = () => {
      const value = Number(window.__ttPetLookDirectionIndex);
      setLookDirectionIndex(
        selectedPet?.spriteVersionNumber === 2 && Number.isInteger(value)
          ? ((value % 16) + 16) % 16
          : null,
      );
    };
    update();
    window.addEventListener("pet:look", update);
    return () => window.removeEventListener("pet:look", update);
  }, [selectedPet?.spriteVersionNumber]);

  // The native host owns the modal window move loop. Keep the visual run cycle alive
  // until that loop ends, then return to the state that was active before dragging.
  useEffect(() => {
    const update = () => {
      const next = window.__ttPetDragState;
      setDragState(next === "running-left" || next === "running-right" ? next : null);
    };
    const end = () => setDragState(null);
    update();
    window.addEventListener("pet:drag-state", update);
    window.addEventListener("pet:drag-end", end);
    return () => {
      window.removeEventListener("pet:drag-state", update);
      window.removeEventListener("pet:drag-end", end);
    };
  }, []);

  // Ambient rotation: real usage context unlocks short scenes, while calm poses remain
  // heavily weighted to avoid an always-busy pet and unnecessary continuous animation.
  useEffect(() => {
    let cancelled = false;
    const schedule = () => {
      const delay = 12_000 + Math.random() * 13_000;
      idleTimer.current = window.setTimeout(() => {
        if (cancelled) return;
        setIdleVariant(pickPetAmbientState(readPetStats()));
        schedule();
      }, delay);
    };
    schedule();
    return () => { cancelled = true; clearTimeout(idleTimer.current); };
  }, []);

  useEffect(() => () => clearTimeout(tapTimer.current), []);

  // Urgent live context wins; usage data shapes the calmer ambient state above.
  const isDisconnected = !connected;
  let autoState = resolvePetState({
    rage,
    connected,
    syncing: isSyncing,
    typing: userTyping,
    celebrating: Boolean(modelStatus),
    todayTokens: today.tokens,
    ambientState: idleVariant,
  });

  // Apply sleep/wake override — but never mask an active working/celebration/error/
  // disconnected state (parity with macOS isBusy: workingTyping / happy / disconnected /
  // error; "working-overheated" here is the rage gag, this platform's error analogue).
  const busy =
    autoState === "working-typing" ||
    autoState === "happy" ||
    autoState === "working-overheated" ||
    autoState === "disconnected";
  if (sleepState && !busy) {
    autoState = sleepState;
  }

  // Mini mode state redirection
  if (miniMode) {
    if (autoState === "working-overheated" || autoState === "disconnected") {
      autoState = "mini-alert";
    } else if (
      autoState === "sleeping" ||
      autoState === "yawning" ||
      autoState === "collapsing" ||
      autoState === "idle-doze"
    ) {
      autoState = "mini-sleep";
    } else if (autoState === "waking") {
      autoState = "mini-enter";
    } else if (autoState.startsWith("working-")) {
      autoState = "mini-crabwalk";
    } else if (autoState === "happy") {
      autoState = "mini-happy";
    } else {
      autoState = hovering ? "mini-peek" : "mini-idle";
    }
  }

  const state = tapState || autoState;

  // Tap → reaction animation + a spoken quip (macOS handleTap parity), both held
  // for TAP_HOLD_MS then cleared.
  const triggerTap = useCallback(() => {
    const anim = TAP_ANIMATIONS[tapIndexRef.current % TAP_ANIMATIONS.length];
    tapIndexRef.current += 1;
    setTapState(anim);
    // Build the full data-rich pool from the host's latest stats and rotate through it
    // by index (macOS parity), so each tap surfaces a different real figure — today's
    // tokens/cost, 7d/30d rolling, streak, top model, conversations — with personality
    // lines as a natural minority.
    const s = readPetStats();
    const costValue = s.todayCostUsd * currency.rate;
    const pool = buildQuipPool(locale, {
      ...s,
      tokens: s.todayTokens,
      tokensText: formatTokens(s.todayTokens),
      costText: s.costPartial ? "—" : `${currency.symbol}${costValue.toFixed(2)}`,
      costValue,
      limitText: formatPetLimitSummary(locale, limitSummaries[0] || null),
      isSyncing,
    });
    setSpeech(pool[quipIndexRef.current % pool.length] || null);
    quipIndexRef.current += 1;
    clearTimeout(tapTimer.current);
    tapTimer.current = window.setTimeout(() => {
      setTapState(null);
      setSpeech(null);
    }, TAP_HOLD_MS);
  }, [locale, currency.symbol, currency.rate, isSyncing, limitSummaries]);

  // Distinguish a tap (→ cycle animation) from a drag (→ native window move):
  // only hand the move to the OS once the pointer travels past a small threshold.
  const onMouseDown = useCallback((e) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, dragging: false };
  }, []);
  const onMouseMove = useCallback((e) => {
    const d = dragRef.current;
    // Hover lean: track the cursor's horizontal position (unless we're mid-drag) so
    // Clawd leans toward it. The pet receives moves across its whole window, so just
    // sliding the cursor left/right over it drives the lean — no click needed.
    if (!d || !d.dragging) {
      let f = (e.clientX / window.innerWidth - 0.5) * 2; // −1 (left) … +1 (right)
      if (Math.abs(f) < LEAN_DEADZONE) f = 0;
      setLeanX(Math.max(-1, Math.min(1, f)));
    }
    if (!d || d.dragging) return;
    if (Math.abs(e.clientX - d.x) > DRAG_THRESHOLD || Math.abs(e.clientY - d.y) > DRAG_THRESHOLD) {
      const deltaX = e.clientX - d.x;
      d.dragging = true;
      setDragState(deltaX < 0 ? "running-left" : "running-right");
      // The native move loop swallows the matching mouseup, so clear the drag ref now —
      // otherwise `dragging` stays true and suppresses hover lean + taps until the next click.
      dragRef.current = null;
      post(deltaX < 0 ? "pet:drag-left" : "pet:drag-right"); // native move loop takes over
    }
  }, []);
  const onMouseUp = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    if (d && !d.dragging) triggerTap();
  }, [triggerTap]);
  const onContextMenu = useCallback((e) => {
    e.preventDefault();
    post("pet:context-menu");
  }, []);

  // Speech quip (on tap) takes priority over the hover usage readout.
  const L = petLabels(locale);
  const limitText = limitSummaries
    .map((reading) => formatPetLimitSummary(locale, reading))
    .filter(Boolean)
    .join(" · ");
  const limitItems = limitSummaries.map((reading) => {
    const display = getPetLimitDisplay(locale, reading);
    if (!display) return null;
    return {
      provider: reading.provider,
      window: reading.window,
      label: display.label,
      tone: display.tone,
      resetText: display.resetText,
      value: display.value,
      ariaLabel: formatPetLimitSummary(locale, reading),
    };
  }).filter(Boolean);
  const tokenUsageText = today.tokens > 0
    ? `${L.today} ${formatTokens(today.tokens)} · ${currency.symbol}${(today.costUsd * currency.rate).toFixed(2)}`
    : "";
  const usageText = isDisconnected
    ? L.offline
    : isSyncing
      ? L.syncing
      : [tokenUsageText, limitText].filter(Boolean).join("\n") || L.noUsage;

  let bubbleText = speech;
  if (!bubbleText) {
    if (modelStatus) {
      const costValue = modelStatus.costDelta * currency.rate;
      bubbleText = `${modelStatus.modelName} · +${formatTokens(modelStatus.tokensDelta)} (${currency.symbol}${costValue.toFixed(3)})`;
    } else if (hovering) {
      bubbleText = usageText;
    }
  }

  // Hover gets a small visual hierarchy instead of two equal-weight sentences.
  // Keep the raw summary as the accessible label and for the no-data fallback.
  const hoverUsage = hovering && !speech && !modelStatus && !isDisconnected && !isSyncing
    && (today.tokens > 0 || limitItems.length > 0)
    ? {
      tokenText: today.tokens > 0 ? formatTokens(today.tokens) : "",
      costText: today.tokens > 0
        ? `${currency.symbol}${(today.costUsd * currency.rate).toFixed(2)} · ${L.today}`
        : "",
      limits: limitItems,
      ariaLabel: [tokenUsageText, limitText].filter(Boolean).join(" · "),
    }
    : null;

  const reportBubbleHeight = useCallback((height) => {
    const next = Math.max(MIN_BUBBLE_BAND, Math.ceil(Number(height) || 0));
    post(`pet:bubble-height:${next}`);
  }, []);

  useEffect(() => {
    if (!bubbleText) reportBubbleHeight(MIN_BUBBLE_BAND);
  }, [bubbleText, reportBubbleHeight]);

  return (
    <div
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onContextMenu={onContextMenu}
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      {/* Top band: the bubble lives here, above Clawd — never overlapping it. */}
      <div
        style={{
          height: bubbleBand,
          flexShrink: 0,
          width: "100%",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
        }}
      >
        {bubbleText && (
          <Bubble text={bubbleText} usage={hoverUsage} onHeightChange={reportBubbleHeight} />
        )}
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Lean toward the cursor while hovering — pivot at the feet so it tilts like
            a body lean, smoothed so the discrete cursor samples read as fluid. */}
        <div
          style={{
            transform: lookDirectionIndex == null
              ? `translateX(${leanX * size * LEAN_MAX_SHIFT_FRAC}px) rotate(${leanX * LEAN_MAX_TILT_DEG}deg)`
              : "none",
            transformOrigin: "50% 92%",
            transition: "transform 0.12s ease-out",
          }}
        >
          <PetCharacterSprite
            state={state}
            dragState={dragState}
            size={size}
            leanX={leanX}
            character={character}
            botColor={botColor}
            pet={selectedPet}
            lookDirectionIndex={lookDirectionIndex}
          />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("pet-root")).render(
  <React.StrictMode>
    <Pet />
  </React.StrictMode>,
);
