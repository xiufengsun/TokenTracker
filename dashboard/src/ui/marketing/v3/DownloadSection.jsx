import React, { useLayoutEffect, useRef } from "react";
import { gsap } from "./gsap.js";
import { InstallCommand } from "./InstallCommand.jsx";
import { DownloadButtons } from "./DownloadButtons.jsx";
import { CliUpgradeNotice } from "../../../components/CliUpgradeNotice.jsx";

// Deterministic sparse starfield (CSS-only echo of the hero galaxy — no
// second WebGL context for a closing section).
const STARS = Array.from({ length: 46 }, (_, i) => ({
  left: (i * 37.7 + 11) % 100,
  top: (i * 53.9 + 7) % 86,
  size: 1 + (i % 3),
  delay: (i % 7) * 0.7,
  duration: 2.6 + (i % 5) * 0.8,
  dim: i % 3 === 0,
}));

/**
 * Closing CTA: a purple horizon glow rises behind a final install prompt.
 */
export function DownloadSection({ copy, animate, installCommand, installCopied, onCopyInstallCommand, githubLabel }) {
  const sectionRef = useRef(null);

  useLayoutEffect(() => {
    if (!animate) return undefined;
    const ctx = gsap.context(() => {
      gsap.fromTo(
        ".lv3-dl-inner",
        { autoAlpha: 0, y: 36 },
        {
          autoAlpha: 1,
          y: 0,
          duration: 0.8,
          ease: "power3.out",
          scrollTrigger: { trigger: sectionRef.current, start: "top 72%" },
        },
      );
      gsap.fromTo(
        ".lv3-dl-horizon",
        { opacity: 0.2, scaleX: 0.7 },
        {
          opacity: 1,
          scaleX: 1,
          ease: "none",
          scrollTrigger: {
            trigger: sectionRef.current,
            start: "top 90%",
            end: "bottom bottom",
            scrub: 0.5,
          },
        },
      );
    }, sectionRef);
    return () => ctx.revert();
  }, [animate]);

  return (
    <section ref={sectionRef} className="relative overflow-hidden border-t border-oai-gray-900 bg-oai-gray-950 py-24 sm:py-32">
      {/* Sparse twinkling stars */}
      <style>{`@keyframes lv3-twinkle { 0%, 100% { opacity: 0.12; } 50% { opacity: 0.9; } }`}</style>
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        {STARS.map((star, i) => (
          <span
            key={i}
            className={`absolute rounded-full ${star.dim ? "bg-[color:var(--lv3-accent-soft)]" : "bg-white"}`}
            style={{
              left: `${star.left}%`,
              top: `${star.top}%`,
              width: star.size,
              height: star.size,
              opacity: star.dim ? 0.35 : 0.5,
              ...(animate
                ? { animation: `lv3-twinkle ${star.duration}s ease-in-out ${star.delay}s infinite` }
                : {}),
            }}
          />
        ))}
      </div>

      {/* Nebula washes */}
      <div
        className="pointer-events-none absolute -left-32 top-4 h-[26rem] w-[26rem] rounded-full opacity-30"
        style={{ background: "radial-gradient(closest-side, var(--lv3-accent-ghost), transparent 70%)" }}
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -right-40 bottom-10 h-[30rem] w-[30rem] rounded-full opacity-30"
        style={{ background: "radial-gradient(closest-side, var(--lv3-accent-ghost), transparent 70%)" }}
        aria-hidden="true"
      />

      {/* Dashed orbit ring circling the CTA — echo of the hero's provider orbit */}
      <svg
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-[0.14]"
        width="920"
        height="440"
        viewBox="0 0 920 440"
        fill="none"
        aria-hidden="true"
      >
        <ellipse
          cx="460"
          cy="220"
          rx="450"
          ry="205"
          stroke="var(--lv3-accent-soft)"
          strokeWidth="1"
          strokeDasharray="2 7"
        />
      </svg>

      {/* Horizon glow */}
      <div
        className="lv3-dl-horizon pointer-events-none absolute inset-x-0 bottom-[-14rem] h-[24rem]"
        style={{
          background: "radial-gradient(50% 100% at 50% 100%, var(--lv3-accent-faint), transparent 70%)",
        }}
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px"
        style={{
          background:
            "linear-gradient(90deg, transparent, var(--lv3-accent) 35%, var(--lv3-accent-soft) 50%, var(--lv3-accent) 65%, transparent)",
          opacity: 0.5,
        }}
        aria-hidden="true"
      />

      <div className="lv3-dl-inner relative z-10 mx-auto flex max-w-3xl flex-col items-center px-4 text-center sm:px-6">
        <h2 className="text-balance text-3xl font-semibold leading-tight tracking-tight text-white sm:text-5xl">
          {copy("landing.v3.download.title")}
        </h2>
        <p className="mt-4 max-w-xl text-base leading-relaxed text-oai-gray-400">
          {copy("landing.v3.download.subtitle")}
        </p>
        <div className="mt-9 w-full">
          <InstallCommand
            copy={copy}
            installCommand={installCommand}
            installCopied={installCopied}
            onCopyInstallCommand={onCopyInstallCommand}
            reduceMotion={!animate}
          />
        </div>
        <div className="mt-6 w-full">
          <CliUpgradeNotice className="mb-6 text-oai-gray-200" />
          <DownloadButtons copy={copy} githubLabel={githubLabel} />
        </div>
      </div>
    </section>
  );
}
