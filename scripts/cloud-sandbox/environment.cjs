// Injected after esbuild transforms the sandbox sources. The real platform
// environment stays unchanged, including for already deployed live functions.
function tokentrackerSandboxEnv(name) {
  if (name === "TOKENTRACKER_BILLING_ENVIRONMENT") return "sandbox";
  if (name === "TOKENTRACKER_WAFFO_LIVE_CHECKOUT_VERIFIED") return "false";
  if (name === "TOKENTRACKER_BILLING_SITE_URL") {
    const site = Deno.env.get("TOKENTRACKER_SANDBOX_BILLING_SITE_URL");
    if (!site) throw new Error("sandbox_site_not_configured");
    return site;
  }
  if (name.startsWith("WAFFO_")) return Deno.env.get("TOKENTRACKER_SANDBOX_" + name);
  if (["INSFORGE_BASE_URL", "INSFORGE_ANON_KEY", "ANON_KEY", "INSFORGE_SERVICE_ROLE_KEY",
    "JWT_SECRET", "JWT_PUBLIC_KEY", "TOKENTRACKER_SANDBOX_USER_IDS", "TOKENTRACKER_SANDBOX_GIFT_USER_IDS"].includes(name)) {
    return Deno.env.get(name);
  }
  // Retired payment credentials and all future unreviewed settings stay closed.
  return undefined;
}

// Access QA uses separate credentials and never reads payment configuration.
function tokentrackerQaAccessEnv(name) {
  if (name === "TOKENTRACKER_BILLING_ENVIRONMENT") return "sandbox";
  if (name === "TOKENTRACKER_WAFFO_LIVE_CHECKOUT_VERIFIED") return "false";
  if (["INSFORGE_BASE_URL", "INSFORGE_ANON_KEY", "ANON_KEY", "INSFORGE_SERVICE_ROLE_KEY",
    "JWT_SECRET", "JWT_PUBLIC_KEY", "LEADERBOARD_BLOCKED_USER_IDS",
    "TOKENTRACKER_SANDBOX_ACCESS_USER_IDS", "TOKENTRACKER_SANDBOX_ACCESS_SITE_URL"].includes(name)) {
    return Deno.env.get(name);
  }
  return undefined;
}

module.exports = { sandboxEnvironmentBanner: tokentrackerSandboxEnv.toString(),
  accessEnvironmentBanner: tokentrackerQaAccessEnv.toString() };
