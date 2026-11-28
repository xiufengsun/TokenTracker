import process from "node:process";
import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

import * as cronHarness from "./test/cron-harness.ts" with { type: "cf-worker" };

const qaDatabase = "607710e9-2229-460a-bb47-0256130c9e4b";
const sampleDatabase = "6fd95547-4042-40b0-82c6-cca13a279081";
const rehearsalDatabase = "a065bb23-3bf7-4b6f-84c3-ea2473a60d3c";
const liveHostname = "api.tokentracker.cc";
const mirrorUsageSchedule = "* * * * *";
const schedules = [
  "17,47 * * * *",
  "23 */6 * * *",
  "32 */6 * * *",
  "17 * * * *",
  "41 * * * *",
  "*/10 * * * *",
  "12 4 * * *",
];

export default defineConfig(({ mode, isPreview }) => {
  if (mode === "cron-qa" || mode === "cron-qa-off")
    return {
      worker: {
        name: "tokentracker-cron-validation",
        compatibilityDate: "2026-11-19",
        compatibilityFlags: ["nodejs_compat"],
        entrypoint: cronHarness,
        triggers:
          mode === "cron-qa"
            ? [triggers.scheduled({ schedule: "* * * * *" })]
            : [],
        env: {
          DB: bindings.d1({ id: qaDatabase }),
          LEADERBOARD_BLOCKED_USER_IDS: bindings.secret(),
        },
      },
    };
  const production = mode === "live";
  const database = production ? process.env.TT_PRODUCTION_D1_ID : qaDatabase;
  if (
    !database ||
    (production &&
      (isPreview || [qaDatabase, sampleDatabase, rehearsalDatabase].includes(database)))
  ) {
    throw new Error(
      "Production requires a separate D1 database and a production build.",
    );
  }
  const emailFrom = process.env.TT_EMAIL_FROM;
  const usageMirrorSource = process.env.TT_USAGE_MIRROR_SOURCE_URL;
  if (usageMirrorSource && new URL(usageMirrorSource).protocol !== "https:")
    throw new Error("The usage mirror source requires HTTPS.");

  const legacyAuth = process.env.TT_LEGACY_AUTH_ENABLED === "1";
  const legacyAuthMode = process.env.TT_LEGACY_AUTH_MODE || "parallel";
  const legacyAuthExpiresAt = process.env.TT_LEGACY_AUTH_EXPIRES_AT || "";
  if (legacyAuth && !["parallel", "exchange"].includes(legacyAuthMode))
    throw new Error("Set TT_LEGACY_AUTH_MODE to parallel or exchange.");
  if (legacyAuth && (
    !/^\d{10}$/.test(legacyAuthExpiresAt) ||
    Number(legacyAuthExpiresAt) <= Math.floor(Date.now() / 1000)
  ))
    throw new Error("Set TT_LEGACY_AUTH_EXPIRES_AT to a future Unix timestamp in seconds.");
  const qaProviders = new Set((process.env.TT_QA_OAUTH ?? "").split(",").filter(Boolean));
  const qaOrigin = process.env.TT_QA_AUTH_ORIGIN?.trim();
  if (!production && qaProviders.size > 0 && !qaOrigin)
    throw new Error("Set TT_QA_AUTH_ORIGIN to the QA OAuth origin.");
  if (production && !emailFrom)
    throw new Error("Set TT_EMAIL_FROM to the verified sender address.");
  return {
    worker: {
      name: production ? "tokentracker-api" : "tokentracker-migration-staging",
      compatibilityDate: "2026-11-19",
      compatibilityFlags: ["nodejs_compat"],
      entrypoint,
      ...(production ? { domains: [liveHostname] } : {}),
      triggers: [
        ...(production ? schedules : []),
        ...(usageMirrorSource ? [mirrorUsageSchedule] : []),
      ].map((schedule) => triggers.scheduled({ schedule })),
      env: {
        DB: bindings.d1({ id: database }),
        USAGE_MIRROR_SOURCE_URL: bindings.text(usageMirrorSource || ""),
        ...(usageMirrorSource ? { USAGE_MIRROR_SECRET: bindings.secret() } : {}),
        AUTH_ORIGIN: bindings.text(production ? "https://" + liveHostname : qaOrigin || "http://127.0.0.1"),
        AUTH_ENFORCE_CANONICAL_ORIGIN: bindings.text(production ? "1" : "0"),
        AUTH_WEB_ORIGIN: bindings.text("https://www.tokentracker.cc"),
        AUTH_REGISTRATION_ENABLED: bindings.text(production ? "1" : "0"),
        ...(legacyAuth
          ? {
              LEGACY_AUTH_ENABLED: bindings.text("1"),
              LEGACY_AUTH_MODE: bindings.text(legacyAuthMode),
              LEGACY_AUTH_ORIGIN: bindings.text(
                process.env.TT_LEGACY_AUTH_ORIGIN ||
                  "https://srctyff5.us-east.insforge.app",
              ),
              LEGACY_AUTH_JWKS_URL: bindings.text(
                process.env.TT_LEGACY_AUTH_JWKS_URL ||
                  "https://srctyff5.us-east.insforge.app/.well-known/jwks.json",
              ),
              LEGACY_AUTH_ANON_KEY: bindings.secret(),
              LEGACY_AUTH_EXPIRES_AT: bindings.text(legacyAuthExpiresAt),
            }
          : {}),
        AUTH_LIMIT: bindings.rateLimit({
          namespace: production ? "2202412" : "2202411",
          simple: { limit: 60, period: 60 },
        }),
        AUTH_SECRET: bindings.secret(),
        AUTH_MIGRATION_KEY: bindings.secret(),
        ...(production || qaProviders.has("github")
          ? {
              GITHUB_CLIENT_ID: bindings.secret(),
              GITHUB_CLIENT_SECRET: bindings.secret(),
            }
          : {}),
        ...(production || qaProviders.has("google")
          ? {
              GOOGLE_CLIENT_ID: bindings.secret(),
              GOOGLE_CLIENT_SECRET: bindings.secret(),
            }
          : {}),
        ...(emailFrom
          ? {
              EMAIL: bindings.sendEmail(),
              AUTH_EMAIL_FROM: bindings.text(emailFrom),
            }
          : {}),
        LEADERBOARD_REFRESH_SECRET: bindings.secret(),
        LEADERBOARD_BLOCKED_USER_IDS: bindings.secret(),
        TOKENTRACKER_BILLING_ENVIRONMENT: bindings.text(
          production ? "live" : "sandbox",
        ),
        ...(production
          ? {
              WAFFO_LIVE_PRIVATE_KEY_SHA256: bindings.secret(),
              TOKENTRACKER_WAFFO_LIVE_CHECKOUT_VERIFIED: bindings.secret(),
            }
          : {}),
        WAFFO_PRIVATE_KEY: bindings.secret(),
        WAFFO_MERCHANT_ID: bindings.secret(),
        WAFFO_STORE_ID: bindings.secret(),
        WAFFO_CLOUD_MONTHLY_PRODUCT_ID: bindings.secret(),
        WAFFO_CLOUD_YEARLY_PRODUCT_ID: bindings.secret(),
        WAFFO_CLOUD_MONTHLY_PASS_PRODUCT_ID: bindings.secret(),
        WAFFO_CLOUD_YEARLY_PASS_PRODUCT_ID: bindings.secret(),
      },
    },
  };
});
