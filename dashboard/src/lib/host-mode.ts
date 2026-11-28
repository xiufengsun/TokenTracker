export function isProductionHost(hostname: string): boolean {
  return hostname === "www.tokentracker.cc" || hostname === "tokentracker.cc";
}

/** True when the dashboard is served from loopback, i.e. the local CLI/app is backing it. */
export function isLocalDashboardHost(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

/** Path to open the dashboard from marketing: loopback keeps `/` as dashboard; public deploy uses `/dashboard` while `/` stays landing. */
export function getDashboardEntryPath(): string {
  return isLocalDashboardHost() ? "/" : "/dashboard";
}
