import React from "react";
import { motion } from "motion/react";
import { Check, Copy } from "lucide-react";

/**
 * The npx install one-liner with animated star-border orbs and a copy button.
 * Shared by the hero and the closing download section.
 */
export function InstallCommand({ copy, installCommand, installCopied, onCopyInstallCommand, reduceMotion }) {
  return (
    <div className="w-full max-w-lg mx-auto">
      <motion.div
        whileHover={reduceMotion ? undefined : { scale: 1.01, y: -1 }}
        transition={{ type: "spring", stiffness: 400, damping: 25 }}
        className="group relative inline-block w-full overflow-hidden rounded-2xl"
        style={{ padding: "1.5px 0" }}
      >
        {/* Star border orbs */}
        <div
          className="absolute w-[300%] h-[50%] opacity-70 bottom-[-11px] right-[-250%] rounded-full animate-star-movement-bottom z-0"
          style={{
            background: "radial-gradient(circle, var(--lv3-glint), transparent 10%)",
            animationDuration: "6s",
            animationPlayState: reduceMotion ? "paused" : "running",
          }}
        />
        <div
          className="absolute w-[300%] h-[50%] opacity-70 top-[-10px] left-[-250%] rounded-full animate-star-movement-top z-0"
          style={{
            background: "radial-gradient(circle, var(--lv3-glint), transparent 10%)",
            animationDuration: "6s",
            animationPlayState: reduceMotion ? "paused" : "running",
          }}
        />

        <div className="relative z-[1] flex items-center justify-between w-full bg-oai-black border border-oai-gray-800 rounded-2xl p-1.5 pl-5 shadow-2xl shadow-black/50">
          <div className="flex items-center gap-3 overflow-hidden">
            <span className="text-oai-gray-600 font-mono select-none" aria-hidden="true">›</span>
            <code className="font-mono text-sm text-oai-gray-200 overflow-x-auto whitespace-nowrap py-2 [scrollbar-width:none]">
              {installCommand
                ? installCommand.split(" ").map((part, i) => (
                    <span
                      key={i}
                      className={
                        part === "npx" || part === "tokentracker-cli"
                          ? "text-white font-medium"
                          : part === "--yes"
                            ? "text-oai-gray-500"
                            : "text-[color:var(--lv3-accent-soft)]"
                      }
                    >
                      {part}{" "}
                    </span>
                  ))
                : null}
            </code>
          </div>

          <button
            type="button"
            onClick={onCopyInstallCommand}
            aria-label={
              installCopied ? copy("landing.install.action.copied") : copy("landing.install.action.copy")
            }
            className="shrink-0 flex h-9 w-9 items-center justify-center text-oai-gray-200 bg-oai-gray-900 border border-oai-gray-700 rounded-lg hover:bg-oai-gray-800 hover:text-white motion-safe:active:scale-95 transition-all duration-200 motion-reduce:transition-none shadow-sm"
          >
            <motion.span
              key={installCopied ? "copied" : "copy"}
              className="inline-flex"
              initial={reduceMotion ? false : { opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: reduceMotion ? 0 : 0.18, ease: "easeOut" }}
            >
              {installCopied ? (
                <Check className="h-4 w-4 text-[color:var(--lv3-accent-soft)]" aria-hidden />
              ) : (
                <Copy className="h-4 w-4 opacity-70" aria-hidden />
              )}
            </motion.span>
          </button>
        </div>
      </motion.div>
      <span className="sr-only" aria-live="polite">
        {installCopied ? copy("landing.install.action.copied") : ""}
      </span>
    </div>
  );
}
