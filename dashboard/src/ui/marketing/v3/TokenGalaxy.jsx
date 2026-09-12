import React, { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { ProviderIcon } from "../../dashboard/components/ProviderIcon.jsx";
import { BLACK_HOLE_FRAGMENT, BLACK_HOLE_VERTEX } from "./black-hole.js";
import { LV3, LV3_GL } from "./palette.js";
import {
  DISC,
  GALAXY_FRAGMENT,
  GALAXY_PROVIDERS,
  GALAXY_VERTEX,
  computeAnchors,
  orbBaseAngles,
  orbScreenPos,
  orbitSpeedForViewport,
  particleCounts,
  sceneConfigForViewport,
  slotDepthFactor,
  staticChipPositions,
} from "./galaxy-config.js";

const COMPACT_GALAXY_QUERY = "(max-width: 1023px)";

export function getViewportHeight(
  view = typeof window === "undefined" ? undefined : window,
  doc = typeof document === "undefined" ? undefined : document,
) {
  return (
    view?.visualViewport?.height ||
    doc?.documentElement?.clientHeight ||
    view?.innerHeight ||
    1
  );
}

function isLowPower() {
  if (typeof window === "undefined") return true;
  const smallViewport = window.matchMedia?.(COMPACT_GALAXY_QUERY)?.matches;
  const fewCores = (navigator.hardwareConcurrency || 8) <= 4;
  return Boolean(smallViewport || fewCores);
}

function buildGeometry(anchors, counts) {
  const total = counts.flow + counts.disc + counts.stars;
  const positions = new Float32Array(total * 3);
  const seeds = new Float32Array(total);
  const phases = new Float32Array(total);
  const sizes = new Float32Array(total);
  const flows = new Float32Array(total);
  const streams = new Float32Array(total);

  for (let i = 0; i < counts.flow; i += 1) {
    const streamIndex = i % anchors.length;
    const anchor = anchors[streamIndex];
    positions[i * 3] = anchor.x;
    positions[i * 3 + 1] = anchor.y;
    positions[i * 3 + 2] = anchor.z;
    seeds[i] = Math.random();
    phases[i] = Math.random();
    sizes[i] = 1.0 + Math.random() * 1.9;
    flows[i] = 1;
    streams[i] = streamIndex;
  }
  for (let i = counts.flow; i < counts.flow + counts.disc; i += 1) {
    // Galaxy disc body: center-weighted bulge + a ring band through the
    // provider chips + a sparse halo beyond them. Together the whole disc —
    // including the gaps between icons — reads as a continuous star field,
    // just denser where the streams run.
    const u = Math.random();
    const r =
      u < 0.55
        ? 11 * (0.05 + 0.95 * Math.pow(Math.random(), 0.8))
        : u < 0.85
          ? 9 + Math.random() * 3.4
          : 11 + Math.random() * 3;
    const theta = Math.random() * Math.PI * 2;
    positions[i * 3] = Math.cos(theta) * r;
    positions[i * 3 + 1] = Math.sin(theta) * r;
    positions[i * 3 + 2] = 0;
    seeds[i] = Math.random();
    phases[i] = Math.random();
    sizes[i] = 1.1 + Math.random() * 1.6;
    flows[i] = 2;
    streams[i] = 0;
  }
  for (let i = counts.flow + counts.disc; i < total; i += 1) {
    // Background stars in a wide, shallow shell behind the disc.
    const r = 14 + Math.random() * 22;
    const theta = Math.random() * Math.PI * 2;
    positions[i * 3] = Math.cos(theta) * r;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 16;
    positions[i * 3 + 2] = -8 - Math.random() * 22;
    seeds[i] = Math.random();
    phases[i] = Math.random();
    sizes[i] = 0.5 + Math.random() * 1.0;
    flows[i] = 0;
    streams[i] = 0;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("aFlow", new THREE.BufferAttribute(flows, 1));
  geometry.setAttribute("aStream", new THREE.BufferAttribute(streams, 1));
  return geometry;
}

/**
 * The hero's WebGL particle galaxy. Thousands of GPU-driven particles stream
 * from eight AI-provider nodes into a central vortex. `progressRef` (0..1,
 * written by the hero's ScrollTrigger) pushes the camera in and fades the
 * scene out; pointer parallax is handled internally. `mode="static"` renders
 * a WebGL-free fallback (CSS glow + fixed provider ring) for reduced-motion,
 * screenshot mode, and devices without WebGL.
 */
export function TokenGalaxy({ mode = "full", progressRef, className = "" }) {
  const mountRef = useRef(null);
  const chipRefs = useRef([]);
  const glowRef = useRef(null);
  const [webglFailed, setWebglFailed] = useState(false);

  useEffect(() => {
    if (mode !== "full") return undefined;
    const mount = mountRef.current;
    if (!mount) return undefined;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: true,
        depth: false,
        stencil: false,
        powerPreference: "high-performance",
      });
    } catch (e) {
      console.warn("TokenGalaxy: WebGL unavailable, using static fallback.", e);
      setWebglFailed(true);
      return undefined;
    }

    const lowPower = isLowPower();
    const compactViewport = window.matchMedia?.(COMPACT_GALAXY_QUERY)?.matches ?? false;
    const orbitSpeed = orbitSpeedForViewport({ compactViewport });
    const sceneConfig = sceneConfigForViewport({ compactViewport });
    const dpr = Math.min(window.devicePixelRatio || 1, lowPower ? 1.5 : 2);
    renderer.setPixelRatio(dpr);
    renderer.setClearColor(0x000000, 0);
    const canvas = renderer.domElement;
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
    mount.appendChild(canvas);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(sceneConfig.cameraFov, 1, 0.1, 120);
    camera.position.set(0, 0, sceneConfig.cameraZ);

    const anchors = computeAnchors();
    const geometry = buildGeometry(anchors, particleCounts({ lowPower }));
    const uniforms = {
      uTime: { value: 0 },
      uPixelRatio: { value: dpr },
      uSwirl: { value: DISC.swirl },
      uFlatten: { value: DISC.flatten },
      uTilt: { value: DISC.tilt },
      uYOffset: { value: DISC.yOffset },
      uIntro: { value: 0 },
      uOrbit: { value: 0 },
      uAnchors: { value: anchors.map((a) => new THREE.Vector3(a.x, a.y, a.z)) },
      uGlobalAlpha: { value: 0 },
      uProgress: { value: 0 },
      uLensScale: { value: sceneConfig.lensScale },
      uBlackHoleScale: { value: sceneConfig.lensScale * (compactViewport ? 1.8 : 1) },
      uPointScale: { value: sceneConfig.pointScale },
      uColorA: { value: new THREE.Color(LV3_GL.accent) },
      uColorB: { value: new THREE.Color(LV3_GL.accentSoft) },
      uColorC: { value: new THREE.Color(LV3_GL.glint) },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader: GALAXY_VERTEX,
      fragmentShader: GALAXY_FRAGMENT,
      uniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    scene.add(points);

    const blackHoleGeometry = new THREE.PlaneGeometry(12, 12);
    const blackHoleUniforms = {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uTilt: { value: -0.10 },
      uColor: { value: new THREE.Color(LV3_GL.accent) },
      uHotColor: { value: new THREE.Color(LV3_GL.glint) },
      uShadowColor: { value: new THREE.Color(LV3.bg) },
    };
    const blackHoleMaterial = new THREE.ShaderMaterial({
      vertexShader: BLACK_HOLE_VERTEX,
      fragmentShader: BLACK_HOLE_FRAGMENT,
      uniforms: blackHoleUniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const blackHole = new THREE.Mesh(blackHoleGeometry, blackHoleMaterial);
    blackHole.position.set(0, DISC.yOffset, 0);
    // The wider mobile camera otherwise shrinks the entire shadow behind
    // the counter. Keep the lensed edge visible above and below the text.
    blackHole.scale.setScalar(sceneConfig.lensScale * (compactViewport ? 1.8 : 1));
    blackHole.renderOrder = 1;
    blackHole.frustumCulled = false;
    scene.add(blackHole);

    // Chips glide along a fixed screen-space orbit ellipse (always inside the
    // frame). Every frame, a ray from the camera through the chip's screen
    // position is intersected with the disc plane — the EXACT world point
    // that projects back onto the chip — and fed to the shader, so streams
    // stay pixel-glued to their orbs under orbit, parallax and scroll alike.
    const baseAngles = orbBaseAngles();
    const tiltCosP = Math.cos(DISC.tilt);
    const tiltSinP = Math.sin(DISC.tilt);
    const planeNormal = new THREE.Vector3(0, -tiltSinP, tiltCosP);
    const planePoint = new THREE.Vector3(0, DISC.yOffset, 0);
    const planeDir = new THREE.Vector3(0, tiltCosP, tiltSinP);
    const rayPoint = new THREE.Vector3();
    const rayDir = new THREE.Vector3();
    const planeDelta = new THREE.Vector3();
    const chipAnchorOnPlane = (leftPct, topPct, out) => {
      rayPoint.set(leftPct / 50 - 1, 1 - topPct / 50, 0.5).unproject(camera);
      rayDir.copy(rayPoint).sub(camera.position).normalize();
      const denom = planeNormal.dot(rayDir);
      if (Math.abs(denom) < 1e-6) return out.set(0, 0, 0);
      const s = planeNormal.dot(planeDelta.copy(planePoint).sub(camera.position)) / denom;
      rayPoint.copy(camera.position).addScaledVector(rayDir, s);
      // World hit → planar disc coords (invert the flatten along the plane).
      planeDelta.copy(rayPoint).sub(planePoint);
      return out.set(rayPoint.x, planeDelta.dot(planeDir) / DISC.flatten, 0);
    };

    // Resize
    let lastW = 0;
    let lastH = 0;
    function resize() {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      if (Math.abs(w - lastW) < 1 && Math.abs(h - lastH) < 1) return;
      lastW = w;
      lastH = h;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();

      // Keep galaxy visual center aligned to the top 100vh of the canvas by shifting projection center
      const hView = getViewportHeight();
      if (h > hView) {
        camera.projectionMatrix.elements[9] = - (h - hView) / h;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      }
    }
    let rafResize = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafResize);
      rafResize = requestAnimationFrame(resize);
    });
    ro.observe(mount);
    resize();

    // Pause when off-screen or tab hidden.
    const inView = { current: true };
    const paused = { current: false };
    const io = new IntersectionObserver(
      (entries) => {
        inView.current = entries[0]?.isIntersecting ?? true;
      },
      { threshold: 0 },
    );
    io.observe(mount);
    const onVisibility = () => {
      paused.current = document.hidden;
    };
    document.addEventListener("visibilitychange", onVisibility, { passive: true });

    // Pointer parallax (window-level so it works while content overlays the canvas).
    const pointerTarget = { x: 0, y: 0 };
    const pointerSmooth = { x: 0, y: 0 };
    const onPointerMove = (e) => {
      pointerTarget.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointerTarget.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    const supportsHover = window.matchMedia?.("(hover: hover)")?.matches;
    if (supportsHover) {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
    }

    // Advance scene time only while visible, so returning to the page does
    // not jump the orbit or the flowing gas forward by the hidden duration.
    let sceneTime = 0;
    let previousFrame = performance.now();
    let fade = 0;
    let intro = 0;
    let rafId = 0;
    let progressSmooth = 0;

    function animate() {
      rafId = requestAnimationFrame(animate);
      const frameTime = performance.now();
      const dt = Math.min(Math.max((frameTime - previousFrame) / 1000, 0.001), 0.033);
      previousFrame = frameTime;
      if (paused.current || !inView.current) return;
      sceneTime += dt;
      const t = sceneTime;
      // Damped scroll progress: the camera dive glides instead of tracking
      // every notch of the wheel 1:1.
      const progressTarget = Math.min(Math.max(progressRef?.current ?? 0, 0), 1);
      progressSmooth += (progressTarget - progressSmooth) * (1 - Math.exp(-dt / 0.14));
      const progress = progressSmooth;

      uniforms.uTime.value = t;
      uniforms.uOrbit.value = t * orbitSpeed;
      uniforms.uProgress.value = progress;
      fade = Math.min(1, fade + dt / 0.9);
      // Entrance: eased 0..1 sweep that grows the streams out of the chips
      // and dollies the camera in.
      intro = Math.min(1, intro + dt / DISC.introSeconds);
      const introEase = 1 - Math.pow(1 - intro, 3);
      uniforms.uIntro.value = introEase;
      // Fade the whole galaxy out as the visitor scrolls past the hero.
      uniforms.uGlobalAlpha.value = fade * (1 - THREE.MathUtils.smoothstep(progress, 0.55, 0.80));

      const damp = 1 - Math.exp(-dt / 0.22);
      pointerSmooth.x += (pointerTarget.x - pointerSmooth.x) * damp;
      pointerSmooth.y += (pointerTarget.y - pointerSmooth.y) * damp;
      camera.position.x = pointerSmooth.x * 1.8;
      // Elevated eye looking down at the vortex; scrolling dives it toward
      // the core (y sinks as z closes in).
      camera.position.y = sceneConfig.cameraY - pointerSmooth.y * 1.2 - progress * 4.5;
      camera.position.z =
        sceneConfig.cameraZ +
        (1 - introEase) * DISC.cameraDollyIn -
        progress * DISC.cameraPushIn;
      // On compact screens, aim the camera at the black-hole origin itself
      // before deriving the projection offset. This keeps the actual WebGL
      // event horizon—not just the DOM glow—at the provider orbit center.
      camera.lookAt(0, sceneConfig.lookAtY, 0);
      camera.updateMatrixWorld();
      // Keep galaxy visual center aligned to 68vh of the viewport dynamically
      const hView = getViewportHeight();
      const v_camera = new THREE.Vector3(0, DISC.yOffset, 0);
      v_camera.applyMatrix4(camera.matrixWorldInverse);
      const targetY_ndc = 1 - 2 * (0.68 * hView / lastH);
      camera.projectionMatrix.elements[9] = (camera.projectionMatrix.elements[5] * v_camera.y) / (-v_camera.z) - targetY_ndc;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

      blackHole.quaternion.copy(camera.quaternion);
      blackHoleUniforms.uTime.value = t;
      blackHoleUniforms.uTilt.value = -0.10 + pointerSmooth.x * 0.025;
      blackHoleUniforms.uOpacity.value = fade * introEase *
        (1 - THREE.MathUtils.smoothstep(progress, 0.12, 0.50));

      renderer.render(scene, camera);

      // Animate background core glow (glowRef) during the big bang explosion
      if (glowRef.current) {
        const glowFlash = THREE.MathUtils.smoothstep(progress, 0.0, 0.25) * (1.0 - THREE.MathUtils.smoothstep(progress, 0.25, 0.65));
        const glowFade = 1.0 - THREE.MathUtils.smoothstep(progress, 0.35, 0.75);
        const glowScale = 1.0 + progress * 1.2;
        const glowOpacity = 0.4 * fade * glowFade * (1.0 + glowFlash * 1.5);
        glowRef.current.style.transform = `translate3d(-50%, -50%, 0) scale(${glowScale.toFixed(3)})`;
        glowRef.current.style.opacity = String(glowOpacity.toFixed(3));
      }

      // Project provider chips into screen space alongside the particles.
      // Chips cascade in one by one during the intro, then track scroll fade.
      // Each orb is scaled by its camera distance so the far (upper) orbs
      // read smaller than the near (lower) ones — true perspective toward
      // the convergence point under the counter.
      const orbExplosionScale = 1.0 + Math.pow(progress, 1.8) * 1.5;
      const chipAlpha = fade * (1 - THREE.MathUtils.smoothstep(progress, 0.25, 0.70));
      const chipFlash = THREE.MathUtils.smoothstep(progress, 0.0, 0.20) * (1.0 - THREE.MathUtils.smoothstep(progress, 0.20, 0.60));
      for (let i = 0; i < baseAngles.length; i += 1) {
        const el = chipRefs.current[i];
        if (!el) continue;
        const theta = baseAngles[i] + uniforms.uOrbit.value;
        const compactCenterPct = (68 * hView) / lastH;
        const pos = orbScreenPos(
          theta,
          orbExplosionScale,
          compactViewport,
          compactCenterPct,
        );
        chipAnchorOnPlane(pos.left, pos.top, uniforms.uAnchors.value[i]);
        const x = (pos.left / 100) * lastW;
        const y = (pos.top / 100) * lastH;
        // Depth follows the orb's live screen height — it visibly grows as
        // it orbits toward the near side and shrinks as it swings away.
        const depthScale = slotDepthFactor(pos.top);
        const cascade = Math.min(1, Math.max(0, introEase * 2.6 - i * 0.22));
        const scale = depthScale * (0.6 + 0.4 * cascade) * (1.0 - progress * 0.3);
        el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
        el.style.opacity = String(Math.max(0, chipAlpha * cascade * (0.75 + 0.25 * depthScale)).toFixed(3));
        
        // Planet / orb igniting and glowing hot matching the big bang color flash
        const brightness = 1.0 + chipFlash * 1.4;
        const saturate = 1.0 + chipFlash * 0.6;
        el.style.filter = `brightness(${brightness.toFixed(2)}) saturate(${saturate.toFixed(2)})`;
        
        const shadowGlow = (12 + chipFlash * 28).toFixed(0);
        const shadowOpacity = (0.3 + chipFlash * 0.6).toFixed(2);
        el.style.boxShadow = `0 0 ${shadowGlow}px rgba(168, 85, 247, ${shadowOpacity})`;
      }
    }
    animate();

    return () => {
      cancelAnimationFrame(rafId);
      cancelAnimationFrame(rafResize);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      if (supportsHover) window.removeEventListener("pointermove", onPointerMove);
      scene.clear();
      geometry.dispose();
      material.dispose();
      blackHoleGeometry.dispose();
      blackHoleMaterial.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (mount.contains(canvas)) mount.removeChild(canvas);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const isStatic = mode !== "full" || webglFailed;
  const staticPositions = staticChipPositions();

  return (
    <div
      ref={mountRef}
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}
      aria-hidden="true"
      data-mode={isStatic ? "static" : "webgl"}
    >
      {/* Core convergence glow (both modes; the particles amplify it in full mode). */}
      <div
        ref={glowRef}
        className="absolute left-1/2 top-[68vh] h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full opacity-45 lg:h-[28rem] lg:w-[28rem]"
        style={{
          background:
            "radial-gradient(circle, var(--lv3-bg) 6%, rgba(138, 122, 255, 0.28) 18%, rgba(138, 122, 255, 0.05) 45%, transparent 68%)",
        }}
      />
      {isStatic ? (
        <div
          className="absolute left-1/2 top-[68vh] h-[22rem] w-[52rem] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-[50%] opacity-50"
          style={{
            background:
              "radial-gradient(ellipse at center, var(--lv3-accent-ghost) 0%, transparent 60%)",
            boxShadow: "inset 0 0 120px var(--lv3-accent-ghost)",
          }}
        />
      ) : null}
      {GALAXY_PROVIDERS.map((provider, i) => (
        <div
          key={provider}
          data-provider-orb={provider}
          ref={(el) => {
            chipRefs.current[i] = el;
          }}
          className="absolute left-0 top-0 flex h-10 w-10 items-center justify-center rounded-full border border-white/20 lg:h-12 lg:w-12"
          style={{
            background: "var(--lv3-orb-surface)",
            boxShadow: "var(--lv3-orb-shadow)",
            backdropFilter: "blur(10px) saturate(1.3)",
            WebkitBackdropFilter: "blur(10px) saturate(1.3)",
            ...(isStatic
              ? {
                  left: `${staticPositions[i].left}%`,
                  top: `${staticPositions[i].top}%`,
                  // Mirror the live depth cue: upper (far) orbs smaller.
                  transform: `translate(-50%, -50%) scale(${slotDepthFactor(staticPositions[i].top).toFixed(2)})`,
                  opacity: 0.9,
                }
              : { opacity: 0 }),
          }}
        >
          {/* Emission ripple: the orb reads as actively firing particles. */}
          {!isStatic ? (
            <span
              className="absolute inset-0 animate-ping rounded-full border border-[color:var(--lv3-accent)] opacity-40"
              style={{ animationDuration: `${2.2 + i * 0.35}s` }}
              aria-hidden="true"
            />
          ) : null}
          {/* Glass glint across the upper hemisphere + a sharp specular dot. */}
          <span
            className="absolute left-[16%] top-[8%] h-[32%] w-[52%] rounded-full opacity-80"
            style={{ background: "var(--lv3-orb-highlight)", filter: "blur(1.5px)" }}
            aria-hidden="true"
          />
          <span
            className="absolute left-[24%] top-[13%] h-[16%] w-[22%] rounded-full"
            style={{ background: "var(--lv3-orb-glint)" }}
            aria-hidden="true"
          />
          <ProviderIcon provider={provider} size={19} />
        </div>
      ))}
    </div>
  );
}
