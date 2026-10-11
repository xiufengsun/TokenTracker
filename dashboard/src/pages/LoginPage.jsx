import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useInsforgeAuth } from "../contexts/InsforgeAuthContext.jsx";
import { LoginCard } from "../components/LoginCard.jsx";
import { copy } from "../lib/copy";

/** @param {string} search */
function parseNext(search) {
  const raw = new URLSearchParams(search).get("next");
  if (typeof raw !== "string" || raw.length === 0) return "/dashboard";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    enabled,
    configurationError,
    loading: authLoading,
    signedIn,
    refreshUser,
  } = useInsforgeAuth();

  const nextPath = useMemo(() => parseNext(searchParams.toString()), [searchParams]);
  const cloudLogin = /^\/(cloud|billing\/checkout)(\?|$)/.test(nextPath);
  const trialLogin = cloudLogin && new URLSearchParams(nextPath.split("?")[1]).get("intent") === "trial";
  const [banner, setBanner] = useState(null);

  useEffect(() => {
    if (!/^\/(cloud|billing\/checkout)(\?|$)/.test(nextPath)) return;
    try { window.sessionStorage.setItem("tt.cloud.return", nextPath); } catch { /* next query still survives password sign-in. */ }
  }, [nextPath]);

  useEffect(() => {
    const status = searchParams.get("insforge_status");
    const type = searchParams.get("insforge_type");
    const err = searchParams.get("insforge_error");
    if (status === "success" && type === "verify_email") {
      setBanner(copy("login.verify_email_success"));
    } else if (status === "error" && type === "verify_email" && err) {
      setBanner(copy("shared.error.prefix", { error: err }));
    }
  }, [searchParams]);

  const isNativeLogin = useMemo(() => {
    return searchParams.get("native") === "1";
  }, [searchParams]);

  useEffect(() => {
    if (!enabled || authLoading) return;
    if (signedIn) {
      if (isNativeLogin) {
        window.location.href = "/auth/native-callback";
        return;
      }
      try { window.sessionStorage.removeItem("tt.cloud.return"); } catch { /* ignore */ }
      navigate(nextPath, { replace: true });
    }
  }, [enabled, authLoading, signedIn, navigate, nextPath, isNativeLogin]);

  useEffect(() => {
    if (!enabled) return;
    refreshUser();
  }, [enabled, refreshUser]);

  // Mark native login in sessionStorage so /auth/callback knows to redirect to app
  useEffect(() => {
    if (isNativeLogin && typeof window !== "undefined") {
      try {
        window.sessionStorage.setItem("tokentracker_native_login", "1");
      } catch {
        // Ignore storage failures
      }
    }
  }, [isNativeLogin]);

  const clearVerifyQuery = useCallback(() => {
    setSearchParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.delete("insforge_status");
        n.delete("insforge_type");
        n.delete("insforge_error");
        return n;
      },
      { replace: true },
    );
    setBanner(null);
  }, [setSearchParams]);

  if (!enabled) {
    return (
      <div className="min-h-screen bg-oai-gray-950 text-oai-white font-oai antialiased dark flex flex-col">
        <header className="border-b border-oai-gray-900 px-4 sm:px-6 py-4">
          <Link to="/" className="text-sm font-medium text-oai-gray-400 hover:text-white no-underline">
            {copy("login.back_home")}
          </Link>
        </header>
        <main className="flex-1 flex items-center justify-center px-4">
          <p className="text-oai-gray-400 text-center max-w-md" role={configurationError ? "alert" : undefined}>
            {configurationError ? copy("instance.configuration.invalid") : copy("login.cloud_only")}
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-oai-gray-950 text-oai-white font-oai antialiased dark flex flex-col">
      <header className="border-b border-oai-gray-900 px-4 sm:px-6 h-16 flex items-center justify-between">
        <Link
          to={cloudLogin ? "/cloud" : "/"}
          className="text-sm font-medium text-oai-gray-400 hover:text-white no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500 rounded"
        >
          {copy(cloudLogin ? "cloud.checkout.back" : "login.back_home")}
        </Link>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md space-y-6">
          {banner ? (
            <div
              className="rounded-lg border border-oai-gray-800 bg-oai-gray-900/50 px-4 py-3 text-sm text-oai-gray-300 flex justify-between gap-3 items-start"
              role="status"
            >
              <span>{banner}</span>
              <button
                type="button"
                onClick={clearVerifyQuery}
                className="shrink-0 text-oai-gray-500 hover:text-white text-xs"
              >
                {copy("login.dismiss")}
              </button>
            </div>
          ) : null}

          <div className="border border-oai-gray-900 bg-oai-gray-950 rounded-2xl overflow-hidden shadow-2xl">
            <LoginCard
              hideLogo
              title={copy("login.title")}
              subtitle={copy(cloudLogin ? trialLogin ? "cloud.login.trial_context" : "cloud.login.purchase_context" : "login.subtitle")}
              className="p-8 bg-transparent"
              onSuccess={() => {
                if (isNativeLogin) {
                  window.location.href = "/auth/native-callback";
                } else {
                  try { window.sessionStorage.removeItem("tt.cloud.return"); } catch { /* ignore */ }
                  navigate(nextPath, { replace: true });
                }
              }}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
