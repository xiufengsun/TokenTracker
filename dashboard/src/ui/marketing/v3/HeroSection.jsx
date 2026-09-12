import React, { useLayoutEffect, useRef } from "react";
import { motion } from "motion/react";
import { gsap, ScrollTrigger } from "./gsap.js";
import { InstallCommand } from "./InstallCommand.jsx";
import { DownloadButtons } from "./DownloadButtons.jsx";
import { CountUp } from "../../components/CountUp.jsx";
import "./galaxy-legibility.css";

// three.js (~150KB gzip) is decorative and below the hero copy — keep it out
// of the landing critical path and hydrate the galaxy right after first paint.
const TokenGalaxy = React.lazy(() =>
  import("./TokenGalaxy.jsx").then((m) => ({ default: m.TokenGalaxy })),
);

export function galaxyStageClassName(animate) {
  return animate
    ? "absolute inset-x-0 bottom-0 top-0 z-0 lg:bottom-[-40vh]"
    : "absolute inset-0 z-0";
}

/**
 * Split-stage hero: the copy (headline, install command, CTAs) sits on clean
 * black in the upper half; the token galaxy is a fully visible top-down
 * vortex rising from the bottom edge, with the live community counter
 * floating directly over its bright core — every provider stream visibly
 * feeds that number. A scrubbed ScrollTrigger writes 0..1 into `progressRef`
 * so scrolling dives the camera into the vortex while the copy drifts away.
 */
export function HeroSection({
  copy,
  animate,
  effectsReady,
  stats,
  tokenFallback,
  devsFallback,
  installCommand,
  installCopied,
  onCopyInstallCommand,
  githubLabel,
}) {
  const sectionRef = useRef(null);
  const copyRef = useRef(null);
  const statRef = useRef(null);
  const progressRef = useRef(0);

  useLayoutEffect(() => {
    if (!animate) return undefined;
    const ctx = gsap.context(() => {
      // Raw progress for the galaxy camera (smoothed inside TokenGalaxy).
      ScrollTrigger.create({
        trigger: sectionRef.current,
        start: "top top",
        end: "bottom top",
        scrub: true,
        onUpdate: (st) => {
          progressRef.current = st.progress;
        },
      });
      // One smoothed exit timeline for the whole hero: copy leaves first,
      // the counter dissolves last, and the section unpins the moment the
      // stage is empty — no dead scroll at the tail.
      const tl = gsap.timeline({
        defaults: { ease: "none" },
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top top",
          end: "bottom top",
          scrub: 0.5,
        },
      });
      tl.to(copyRef.current, { yPercent: -16, autoAlpha: 0, duration: 0.30 }, 0.08);
      tl.to(statRef.current, { y: -28, scale: 0.94, autoAlpha: 0, duration: 0.22 }, 0.45);
      tl.to({}, { duration: 0.1 });
    }, sectionRef);
    return () => ctx.revert();
  }, [animate]);

  const tokenTotal = stats.status === "ready" ? stats.tokenFloor : tokenFallback;
  const devsTotal = stats.status === "ready" ? stats.totalEntries : devsFallback;
  // Estimated live feed: ~0.4% community growth per day, spread across the
  // seconds — enough to keep the trailing digits visibly spinning. The real
  // fetch calibrates the base on every page load.
  const tokensPerSec = (tokenTotal * 0.004) / 86400;
  const galaxyMode = animate && effectsReady ? "full" : "static";

  return (
    <section ref={sectionRef} className="relative">
      {/* min 52rem stage: on very short viewports the galaxy stage extends
          below the fold instead of letting the copy crash into the counter. */}
      <div className="relative min-h-[max(100svh,52rem)]">
        {/* Upper stage: hero copy on clean black — no particles behind it. */}
        <div
          ref={copyRef}
          className="relative z-20 mx-auto flex max-w-3xl flex-col items-center px-4 pt-28 text-center tall:pt-48 xtall:pt-56 sm:px-6 sm:pt-36 sm:xtall:pt-60"
        >
          <motion.div
            initial={animate ? { opacity: 0, y: 24 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="flex flex-col items-center"
          >
            <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-oai-gray-400 tall:mb-5">
              <span className="relative flex h-1.5 w-1.5" aria-hidden="true">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[color:var(--lv3-accent)] opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[color:var(--lv3-accent)]" />
              </span>
              {copy("landing.v3.hero.kicker")}
            </p>

            <h1 className="lv3-hero-title text-balance text-4xl font-semibold leading-[1.08] tracking-tight text-white sm:text-[2.75rem] sm:tall:text-[3.25rem] sm:xtall:text-6xl lg:xtall:text-[4rem]">
              {copy("landing.v2.hero.title_line1")}
              <br />
              <span
                className="bg-gradient-to-b from-white via-[color:var(--lv3-accent-soft)] to-[color:var(--lv3-accent)] bg-clip-text font-bold tracking-tight text-transparent"
                style={{ WebkitTextStroke: "1px rgba(255, 255, 255, 0.12)" }}
              >
                {copy("landing.v2.hero.title_line2")}
              </span>
            </h1>

            <div className="mt-8 sm:mt-10 w-full xtall:mt-12">
              <InstallCommand
                copy={copy}
                installCommand={installCommand}
                installCopied={installCopied}
                onCopyInstallCommand={onCopyInstallCommand}
                reduceMotion={!animate}
              />
            </div>

            <div className="mt-4 w-full xtall:mt-5">
              <DownloadButtons copy={copy} githubLabel={githubLabel} />
            </div>
          </motion.div>
        </div>

        {/* The galaxy canvas covers the whole viewport — no container edge can
            slice it — while the disc itself is parked in the lower half, with
            the live counter floating on its bright core. */}
        <div className={galaxyStageClassName(animate)}>
          <React.Suspense fallback={null}>
            <TokenGalaxy mode={galaxyMode} progressRef={progressRef} />
          </React.Suspense>

          {/* Outer div owns the centering; GSAP animates the inner one so the
              -50% translate never gets clobbered by the tween's transform. */}
          <div className="pointer-events-none absolute left-1/2 top-[68vh] z-10 -translate-x-1/2 -translate-y-1/2">
            <div ref={statRef} className="lv3-counter flex flex-col items-center gap-2">
            {/* A feathered, narrow scrim protects the text band while the
                bright upper/lower lens arcs remain fully visible. */}
            <div className="lv3-counter-scrim" aria-hidden="true" />
            <p className="text-[11px] font-bold uppercase tracking-[0.3em] text-oai-gray-300">
              {copy("landing.v3.hero.stat_label")}
            </p>
            <p
              className="whitespace-nowrap font-mono text-4xl font-bold tabular-nums leading-none text-white sm:tall:text-5xl"
            >
              <CountUp
                value={tokenTotal}
                animate={animate}
                ratePerSec={tokensPerSec}
                format={(v) =>
                  Math.round(v)
                    .toLocaleString("en-US")
                    .split(",")
                    .map((part, index) => (
                      <React.Fragment key={`${index}-${part}`}>
                        {index !== 0 ? (
                          <span className="-mx-[0.14em] inline-block sm:mx-0">
                            ,
                          </span>
                        ) : null}
                        {part}
                      </React.Fragment>
                    ))
                }
              />
            </p>
              <p className="font-mono text-sm text-oai-gray-300">
                {copy("landing.v3.stats.devs_syncing", {
                  count: (Number(devsTotal) || 0).toLocaleString("en-US"),
                })}
              </p>
            </div>
          </div>

          {/* Fade the vortex into the page background at the bottom edge. */}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-24"
            style={{ background: "linear-gradient(to bottom, transparent, var(--lv3-bg) 85%)" }}
            aria-hidden="true"
          />
        </div>
      </div>
    </section>
  );
}
