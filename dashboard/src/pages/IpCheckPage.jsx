import React, { useEffect, useRef, useState } from "react";
import { copy } from "../lib/copy";

// Native port of ip.net.coffee/claude/ — no iframe.
// Visual layer matches LimitsPage / SettingsPage (oai palette + Tailwind).
// Imperative data layer preserved — DOM ids stay the integration surface.
//
// /api/*, /claude/*, /favicons/* route through /proxy/ipcheck/*
// (src/lib/local-api.js for the CLI; dashboard/vite.config.js for `dashboard:dev`).
// External trace endpoints (claude.ai, 1.1.1.1) stay direct — CORS-enabled.
// DNS leak detection hits *.d.ip.net.coffee directly so the resolver query
// reaches ip.net.coffee's authoritative DNS.
//
// On the deployed web app (tokentracker.cc) there's no local CLI proxy. We hit
// ip.net.coffee directly instead: its /api/* endpoints send
// `access-control-allow-origin: *`, and — crucially — a direct browser fetch
// exits from the visitor's own IP, so the probe still reports the user's real
// IP (a cloud proxy would report the server's IP, which is useless here).
// `/claude/status.json` lacks CORS; that one call degrades gracefully (the
// page already wraps every fetch in try/catch + timeout).
const IPCHECK_IS_LOCAL =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
const PROXY = IPCHECK_IS_LOCAL ? "/proxy/ipcheck" : "https://ip.net.coffee";
const IP_HISTORY_KEY = "claude_ip_history";
const IP_HISTORY_MAX = 6;

// ISO country code → i18n key under ipcheck.region.*
const CLAUDE_RESTRICTED_CCS = ["CN", "HK", "MO", "RU", "KP", "IR", "SY", "CU", "BY", "VE"];

const CC_TO_TZ = {
  CN: "Asia/Shanghai", TW: "Asia/Taipei", HK: "Asia/Hong_Kong", MO: "Asia/Macau",
  JP: "Asia/Tokyo", KR: "Asia/Seoul", SG: "Asia/Singapore", MY: "Asia/Kuala_Lumpur",
  TH: "Asia/Bangkok", VN: "Asia/Ho_Chi_Minh", ID: "Asia/Jakarta", PH: "Asia/Manila",
  IN: "Asia/Kolkata", PK: "Asia/Karachi", BD: "Asia/Dhaka",
  IR: "Asia/Tehran", IL: "Asia/Jerusalem", AE: "Asia/Dubai", SA: "Asia/Riyadh",
  TR: "Europe/Istanbul", RU: "Europe/Moscow", UA: "Europe/Kyiv",
  GB: "Europe/London", IE: "Europe/Dublin", FR: "Europe/Paris", DE: "Europe/Berlin",
  IT: "Europe/Rome", ES: "Europe/Madrid", PT: "Europe/Lisbon", NL: "Europe/Amsterdam",
  BE: "Europe/Brussels", CH: "Europe/Zurich", AT: "Europe/Vienna",
  SE: "Europe/Stockholm", NO: "Europe/Oslo", DK: "Europe/Copenhagen", FI: "Europe/Helsinki",
  PL: "Europe/Warsaw", CZ: "Europe/Prague", GR: "Europe/Athens", RO: "Europe/Bucharest",
  US: "America/Los_Angeles", CA: "America/Toronto", MX: "America/Mexico_City",
  BR: "America/Sao_Paulo", AR: "America/Argentina/Buenos_Aires", CL: "America/Santiago",
  AU: "Australia/Sydney", NZ: "Pacific/Auckland",
  ZA: "Africa/Johannesburg", EG: "Africa/Cairo", NG: "Africa/Lagos", KE: "Africa/Nairobi",
};

const LANG_MAP = {
  CN: ["zh"], TW: ["zh"], HK: ["zh", "en"], MO: ["zh", "en"],
  JP: ["ja"], KR: ["ko"], TH: ["th"], VN: ["vi"],
  SG: ["en", "zh", "ms", "ta"], MY: ["ms", "en", "zh", "ta"],
  ID: ["id", "en"], PH: ["en", "tl", "fil"],
  IN: ["en", "hi"], PK: ["ur", "en"], BD: ["bn", "en"],
  LK: ["si", "ta", "en"], NP: ["ne", "en"],
  US: ["en"], GB: ["en"], IE: ["en", "ga"],
  AU: ["en"], NZ: ["en", "mi"], CA: ["en", "fr"],
  DE: ["de"], AT: ["de"], CH: ["de", "fr", "it", "rm"],
  BE: ["nl", "fr", "de"], FR: ["fr"], IT: ["it"],
  ES: ["es", "ca", "gl", "eu"], PT: ["pt"],
  NL: ["nl", "fy"], LU: ["lb", "fr", "de"],
  SE: ["sv"], NO: ["no", "nb", "nn"], DK: ["da"],
  FI: ["fi", "sv"], IS: ["is", "en"],
  PL: ["pl"], CZ: ["cs"], SK: ["sk"], HU: ["hu"],
  RO: ["ro"], BG: ["bg"], GR: ["el"],
  RU: ["ru"], UA: ["uk", "ru"], BY: ["be", "ru"],
  TR: ["tr"], IL: ["he", "ar", "en"],
  SA: ["ar"], AE: ["ar", "en"], EG: ["ar"],
  IR: ["fa"], IQ: ["ar", "ku"],
  ZA: ["en", "af", "zu", "xh"], KE: ["en", "sw"],
  NG: ["en"], ET: ["am", "en"],
  BR: ["pt"], AR: ["es"], MX: ["es"], CL: ["es"],
  CO: ["es"], PE: ["es"], VE: ["es"],
};

const LOC_CC_TO_COUNTRY = {
  jp: "Japan", tw: "Taiwan", hk: "Hong Kong", sg: "Singapore",
  us: "United States", de: "Germany", kr: "South Korea", fr: "France",
  nl: "Netherlands", gb: "United Kingdom", au: "Australia",
  ca: "Canada", br: "Brazil", in: "India",
};

// ─── Helpers ──────────────────────────────────────────────────────────────
function isIPv6(ip) { return !!ip && ip.includes(":"); }
function truncateIP(ip) { return !isIPv6(ip) || ip.length <= 20 ? ip : ip.substring(0, 18) + "..."; }

// Escape user/upstream-supplied strings before interpolating into innerHTML.
// All values from /api/iprisk + /api/geoip + localStorage history pass through
// here — ip.net.coffee controls those JSON bodies, so unescaped interpolation
// would be stored XSS the moment they returned a malicious string.
function esc(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function flagImg(cc) {
  if (!cc) return "";
  // Defense-in-depth: only render flags for plausible ISO-2 codes (a-z {2}).
  // Anything else (upstream injection attempt, bogus values) → no image.
  if (!/^[a-zA-Z]{2}$/.test(cc)) return "";
  const low = cc.toLowerCase();
  const src = low === "cn"
    ? `${PROXY}/favicons/cn.png`
    : low === "tw"
      ? `${PROXY}/favicons/flags/tw.png`
      : `${PROXY}/favicons/flags/${low}.png`;
  return `<img src="${src}" alt="${low}" class="inline-block h-4 w-auto align-[-2px]" onerror="this.onerror=null;this.style.display='none'">`;
}

function maskIpText(text) {
  if (!text) return "";
  const t = String(text).trim();
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(t)) {
    const parts = t.split(".");
    return parts[0] + "." + parts[1] + ".*.*";
  }
  if (t.includes("…")) {
    const idx = t.lastIndexOf("…");
    return t.substring(0, idx + 1) + "*";
  }
  if (t.includes(":")) {
    const parts = t.split(":");
    if (parts.length >= 2) return parts[0] + ":" + parts[1] + ":*";
  }
  return t;
}

function currentOffsetMinutes(tzName) {
  if (!tzName) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tzName,
      timeZoneName: "longOffset",
    }).formatToParts(new Date());
    const p = parts.find((x) => x.type === "timeZoneName");
    if (!p) return null;
    if (p.value === "GMT" || p.value === "UTC") return 0;
    const m = p.value.match(/GMT([+-])(\d{1,2}):?(\d{0,2})/);
    if (!m) return null;
    const sign = m[1] === "+" ? 1 : -1;
    return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10));
  } catch {
    return null;
  }
}

function formatOffsetHours(mins) {
  if (mins == null) return "";
  const sign = mins >= 0 ? "+" : "-";
  const abs = Math.abs(mins);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return "UTC" + sign + h + (m ? ":" + String(m).padStart(2, "0") : "");
}

const TAG_CLASSES = {
  safe: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  warn: "bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
  danger: "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  info: "bg-blue-50 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  neutral: "bg-oai-gray-100 text-oai-gray-600 dark:bg-oai-gray-800 dark:text-oai-gray-400",
};

export default function IpCheckPage() {
  const containerRef = useRef(null);
  const [maskOn, setMaskOn] = useState(false);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return undefined;
    const $ = (id) => root.querySelector(`#${id}`);
    let aborted = false;

    // ─── Localized string surface ─────────────────────────────────────────
    // Capture all i18n strings once per mount. App.jsx remounts the page on
    // locale change (key={resolvedLocale}), so this stays in sync.
    const t = {
      unknown: copy("ipcheck.common.unknown"),
      failed: copy("ipcheck.ip.failed"),
      regionAccessible: copy("ipcheck.trust.region.accessible"),
      regionWarnTitle: (region) => copy("ipcheck.trust.region_warn.title", { region }),
      regionWarnBody: copy("ipcheck.trust.region_warn.body"),
      regionRestrictedText: copy("ipcheck.trust.text.restricted"),
      noData: copy("ipcheck.trust.no_data"),
      noIp: copy("ipcheck.trust.no_ip"),
      noScore: copy("ipcheck.trust.no_score"),
      // Trust score band labels
      score: {
        pristine: copy("ipcheck.trust.label.pristine"),
        clean: copy("ipcheck.trust.label.clean"),
        good: copy("ipcheck.trust.label.good"),
        neutral: copy("ipcheck.trust.label.neutral"),
        suspicious: copy("ipcheck.trust.label.suspicious"),
        unreachable: copy("ipcheck.trust.label.unreachable"),
      },
      scoreText: {
        excellent: copy("ipcheck.trust.text.excellent"),
        great: copy("ipcheck.trust.text.great"),
        minor: copy("ipcheck.trust.text.minor"),
        moderate: copy("ipcheck.trust.text.moderate"),
        severe: copy("ipcheck.trust.text.severe"),
      },
      // Properties
      propsRegion: copy("ipcheck.props.region"),
      propsCity: copy("ipcheck.props.city"),
      propsType: copy("ipcheck.props.type"),
      propsAsn: copy("ipcheck.props.asn"),
      propsOrg: copy("ipcheck.props.org"),
      propsResidential: copy("ipcheck.props.residential"),
      propsDatacenter: copy("ipcheck.props.datacenter"),
      // Security
      secVpn: copy("ipcheck.security.vpn"),
      secProxy: copy("ipcheck.security.proxy"),
      secTor: copy("ipcheck.security.tor"),
      secCrawler: copy("ipcheck.security.crawler"),
      secAbuser: copy("ipcheck.security.abuser"),
      secProxyFlag: copy("ipcheck.security.proxy_flag"),
      secCrawlerYes: copy("ipcheck.security.crawler_yes"),
      secCrawlerNo: copy("ipcheck.security.crawler_no"),
      secAbuserYes: copy("ipcheck.security.abuser_yes"),
      secAbuserNo: copy("ipcheck.security.abuser_no"),
      secClean: copy("ipcheck.security.clean"),
      // Availability
      availSvc: copy("ipcheck.avail.svc_row"),
      availLat: {
        normal: copy("ipcheck.avail.latency.normal"),
        good: copy("ipcheck.avail.latency.good"),
        slow: copy("ipcheck.avail.latency.slow"),
        unreachable: copy("ipcheck.avail.latency.unreachable"),
      },
      availSvcStatus: {
        none: copy("ipcheck.avail.svc.none"),
        minor: copy("ipcheck.avail.svc.minor"),
        major: copy("ipcheck.avail.svc.major"),
        critical: copy("ipcheck.avail.svc.critical"),
        maintenance: copy("ipcheck.avail.svc.maintenance"),
        other: copy("ipcheck.avail.svc.other"),
      },
      // DNS leak
      dnsStatus: copy("ipcheck.dns.status"),
      dnsOutlet: copy("ipcheck.dns.outlet"),
      dnsOutletIp: copy("ipcheck.dns.outlet_ip"),
      dnsIsp: copy("ipcheck.dns.isp"),
      dnsLeaked: copy("ipcheck.dns.leaked"),
      dnsNoLeak: copy("ipcheck.dns.no_leak"),
      dnsEncrypted: copy("ipcheck.dns.encrypted"),
      dnsCnTag: copy("ipcheck.dns.cn_tag"),
      // UDP leak
      udpStatus: copy("ipcheck.udp.status"),
      udpOutlet: copy("ipcheck.udp.outlet"),
      udpOutletIp: copy("ipcheck.udp.outlet_ip"),
      udpOrigin: copy("ipcheck.udp.origin"),
      udpDisabled: copy("ipcheck.udp.disabled"),
      udpNoLeak: copy("ipcheck.udp.no_leak"),
      udpLeaked: copy("ipcheck.udp.leaked"),
      udpAnomaly: copy("ipcheck.udp.anomaly"),
      // Device
      devTz: copy("ipcheck.device.tz"),
      devLang: copy("ipcheck.device.lang"),
      devOs: copy("ipcheck.device.os"),
      devTouch: copy("ipcheck.device.touch"),
      devNet: copy("ipcheck.device.net"),
      devDnt: copy("ipcheck.device.dnt"),
      devWebglRender: copy("ipcheck.device.webgl_render"),
      devCanvasFp: copy("ipcheck.device.canvas_fp"),
      devWebglFp: copy("ipcheck.device.webgl_fp"),
      devMatch: copy("ipcheck.device.match"),
      devMismatch: copy("ipcheck.device.mismatch"),
      devLocal: copy("ipcheck.device.local"),
      devEstSuffix: copy("ipcheck.device.estimate_suffix"),
      devDiffEqual: copy("ipcheck.device.diff_equal"),
      devDiffAhead: (h) => copy("ipcheck.device.diff_ahead", { h }),
      devDiffBehind: (h) => copy("ipcheck.device.diff_behind", { h }),
      devLangExpected: copy("ipcheck.device.lang_expected"),
      devTouchYes: copy("ipcheck.device.touch_yes"),
      devTouchNo: copy("ipcheck.device.touch_no"),
      devDntOn: copy("ipcheck.device.dnt_on"),
      devDntOff: copy("ipcheck.device.dnt_off"),
      devDntUnset: copy("ipcheck.device.dnt_unset"),
      devNetUnsupported: copy("ipcheck.device.net_unsupported"),
      devUnsupported: copy("ipcheck.device.unsupported"),
      // History
      histEmpty: copy("ipcheck.history.empty"),
      histCurrent: copy("ipcheck.history.current"),
      histLoading: copy("ipcheck.ip.loading"),
    };

    // ─── HTML snippet builders (use `t` from closure) ─────────────────────
    function tag(text, variant = "neutral") {
      const cls = TAG_CLASSES[variant] || TAG_CLASSES.neutral;
      return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}">${text}</span>`;
    }
    function boolTag(val, trueText, falseText) {
      if (val === true) return tag(trueText, "danger");
      if (val === false) return tag(falseText, "safe");
      return tag(t.unknown, "neutral");
    }
    function displayIP(ip) {
      if (!ip) return `<span class="text-oai-gray-400 dark:text-oai-gray-500">${esc(t.failed)}</span>`;
      const safeIp = esc(ip);
      if (isIPv6(ip)) return `<span class="ip-mask-target truncate" title="${safeIp}">${esc(truncateIP(ip))}</span>`;
      return `<span class="ip-mask-target">${safeIp}</span>`;
    }
    function linkIP(ip) {
      // Display-only: the upstream /proxy/ipcheck/ip/{ip} detail page is not
      // wired into our app, and a clickable link surprises users who expect
      // read-only metrics. Keep .ip-link class so the mask toggle observer
      // still picks these nodes up for the Hide IP feature.
      if (!ip) return `<span class="text-oai-gray-400 dark:text-oai-gray-500">${esc(t.failed)}</span>`;
      return `<span class="ip-link">${displayIP(ip)}</span>`;
    }
    function row(label, valueHtml, isChecking = false) {
      let value = valueHtml;
      if (valueHtml === undefined) {
        if (isChecking) {
          value = `<div class="inline-flex items-center gap-1.5 text-xs text-oai-gray-400">
            <svg class="animate-spin-subtle h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          </div>`;
        } else {
          value = '<span class="block h-3 w-20 rounded bg-oai-gray-100 dark:bg-oai-gray-800 shimmer"></span>';
        }
      } else {
        value = `<div class="animate-scale-up-fade">${valueHtml}</div>`;
      }
      return `<div class="flex items-center justify-between py-2.5 gap-3">
        <span class="text-sm text-oai-gray-500 dark:text-oai-gray-400 shrink-0">${label}</span>
        <span class="text-sm font-medium text-oai-black dark:text-white text-right min-w-0">${value}</span>
      </div>`;
    }
    function loadingRows(labels) { return labels.map((l) => row(l, undefined)).join(""); }
    function ipHeroSkeleton() { return '<div class="h-7 w-44 rounded bg-oai-gray-100 dark:bg-oai-gray-800 shimmer"></div>'; }
    function ipGeoSkeleton() { return '<div class="h-3 w-52 mt-2 rounded bg-oai-gray-100 dark:bg-oai-gray-800 shimmer"></div>'; }

    function scoreLabel(score) {
      if (score >= 95) return { text: t.score.pristine, variant: "safe" };
      if (score >= 80) return { text: t.score.clean, variant: "safe" };
      if (score >= 50) return { text: t.score.good, variant: "info" };
      if (score >= 25) return { text: t.score.neutral, variant: "warn" };
      return { text: t.score.suspicious, variant: "danger" };
    }

    const state = {
      ip: null, ippure: null, ipapis: null,
      claudeGeo: null, claudeRisk: null, cfGeo: "",
      scoreAnimId: null,
      lastScore: 0
    };

    function restrictedRegion() {
      const cc = (state.claudeRisk?.countryCode || "").toUpperCase();
      if (!cc || !CLAUDE_RESTRICTED_CCS.includes(cc)) return null;
      return copy(`ipcheck.region.${cc}`);
    }

    function showIPv6Warning() { const el = $("ipv6Warn"); if (el) el.classList.remove("hidden"); }

    function setGeoText(elId, text) {
      const el = $(elId);
      if (!el) return;
      el.textContent = text || "";
      el.classList.remove("animate-pulse", "bg-oai-gray-200", "dark:bg-oai-gray-800", "w-52", "h-3", "mt-2", "rounded");
    }

    // ─── Initial skeletons (own the containers fully) ─────────────────────
    const skeletons = {
      gaugeScore: '<span class="block h-8 w-16 rounded bg-oai-gray-100 dark:bg-oai-gray-800 shimmer"></span>',
      ipAddrCN: ipHeroSkeleton(),
      ipGeoCN: ipGeoSkeleton(),
      ipAddr: ipHeroSkeleton(),
      ipGeo: ipGeoSkeleton(),
      ipAddrClaude: ipHeroSkeleton(),
      ipGeoClaude: ipGeoSkeleton(),
      propsContent: loadingRows([t.propsRegion, t.propsCity, t.propsType, t.propsAsn, t.propsOrg]),
      securityContent: loadingRows([t.secVpn, t.secProxy, t.secTor, t.secCrawler, t.secAbuser]),
      claudeAvailContent: row("claude.ai", undefined, true) + row("anthropic.com", undefined, true),
      dnsLeakContent: row(t.dnsStatus, undefined, true) + row(t.dnsOutletIp, undefined, true),
      udpLeakContent: row(t.udpStatus, undefined, true) + row(t.udpOutletIp, undefined, true),
      deviceContent: loadingRows([t.devTz, t.devLang, t.devOs, t.devTouch, t.devNet, t.devDnt, t.devWebglRender, t.devCanvasFp]),
      ipHistoryContent: `<span class="text-sm text-oai-gray-400 dark:text-oai-gray-500">${t.histLoading}</span>`,
    };
    Object.entries(skeletons).forEach(([id, html]) => { const el = $(id); if (el) el.innerHTML = html; });

    // ─── Mask handling ────────────────────────────────────────────────────
    // Closure-scoped flag — no window globals, no third-party script
    // tampering, no StrictMode double-mount interference.
    let maskOn = false;
    function applyMaskTo(el) {
      if (!el) return;
      if (!el.dataset.realText) el.dataset.realText = (el.textContent || "").trim();
      const real = el.dataset.realText;
      const want = maskOn ? maskIpText(real) : real;
      if (el.textContent !== want) el.textContent = want;
    }
    function applyAllMasks() { root.querySelectorAll(".ip-link, .ip-mask-target").forEach(applyMaskTo); }
    const maskObserver = new MutationObserver(() => requestAnimationFrame(applyAllMasks));
    ["ipHeroCN", "ipHero", "ipHeroClaude", "ipHistoryContent", "dnsLeakContent", "udpLeakContent"]
      .forEach((id) => { const el = $(id); if (el) maskObserver.observe(el, { childList: true, subtree: true }); });
    root.__setMaskOn = (next) => { maskOn = !!next; applyAllMasks(); };

    // ─── IP fetch primitives ──────────────────────────────────────────────
    async function fetchCfIP() {
      try {
        const r = await fetch("https://1.1.1.1/cdn-cgi/trace", { signal: AbortSignal.timeout(5000) });
        const txt = await r.text();
        const m = txt.match(/ip=([^\n]+)/);
        if (m) state.ip = m[1].trim();
      } catch { /* best-effort IP source */ }
    }
    async function fetchClaudeIP() {
      try {
        const r = await fetch("https://claude.ai/cdn-cgi/trace", { cache: "no-store", signal: AbortSignal.timeout(8000) });
        const text = await r.text();
        const entries = Object.fromEntries(text.trim().split("\n").map((l) => l.split("=")));
        return { ip: entries.ip || null, loc: entries.loc?.toLowerCase() || null };
      } catch { return null; }
    }
    async function fetchCNIP() {
      try {
        const r = await fetch("https://2026.ip138.com/", { signal: AbortSignal.timeout(5000) });
        const html = await r.text();
        const m = html.match(/(\d+\.\d+\.\d+\.\d+)/);
        if (m) return { ip: m[1] };
      } catch { /* try the fallback source below */ }
      try {
        const r = await fetch("https://my.ip.cn/", { signal: AbortSignal.timeout(5000) });
        const html = await r.text();
        const m = html.match(/(\d+\.\d+\.\d+\.\d+)/);
        if (m) return { ip: m[1] };
      } catch { /* no fallback source remains */ }
      return null;
    }

    async function renderIPCard(ipId, geoId, ip, locHint) {
      const ipEl = $(ipId);
      const geoEl = $(geoId);
      if (!ipEl || !geoEl) return;
      if (!ip) {
        ipEl.innerHTML = `<span class="text-oai-gray-400 dark:text-oai-gray-500">${t.failed}</span>`;
        geoEl.textContent = "";
        return;
      }
      if (isIPv6(ip)) showIPv6Warning();
      ipEl.innerHTML = `${locHint ? flagImg(locHint) + ' ' : ""}${linkIP(ip)}`;
      try {
        const r = await fetch(`${PROXY}/api/geoip/${ip}`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const g = await r.json();
          const geo = [g.country, g.region, g.city, g.isp].filter(Boolean).join(" · ");
          const cc = g.country_code || locHint || "";
          ipEl.innerHTML = `${flagImg(cc)} ${linkIP(ip)}`;
          setGeoText(geoId, geo);
        }
      } catch { /* geo lookup is optional */ }
    }

    // ─── Render bound to data state ───────────────────────────────────────
    function render() {
      const p = state.ippure;
      const cr = state.claudeRisk;
      const cg = state.claudeGeo;
      const a = state.ipapis;
      const asn = cr?.asn || p?.asn || "";
      const asnOrg = cr?.asOrganization || p?.asOrganization || a?.company?.name || "";
      const restrictedName = restrictedRegion();

      const hasClaudeIp = !!(cr && cr.ip);
      let trustScore;
      let restrictedText = null;
      if (!hasClaudeIp) {
        trustScore = null;
      } else if (restrictedName) {
        trustScore = 0;
        restrictedText = t.regionRestrictedText;
      } else {
        trustScore = typeof cr.trust_score === "number" ? cr.trust_score : null;
      }

      const gaugePointer = $("gaugePointer");
      const gaugeScoreEl = $("gaugeScore");
      const gaugeTextEl = $("gaugeText");
      if (trustScore === null) {
        gaugeScoreEl.innerHTML = `<span class="text-4xl font-bold tracking-tight tabular-nums text-oai-gray-400 dark:text-oai-gray-500">—</span> ${tag(t.noData, "neutral")}`;
        gaugePointer.style.left = "0%";
        gaugePointer.style.opacity = "0.3";
        gaugePointer.style.borderColor = "";
        gaugePointer.style.boxShadow = "";
        gaugeTextEl.textContent = hasClaudeIp ? t.noScore : t.noIp;
      } else {
        const sl = restrictedName ? { text: t.score.unreachable, variant: "danger" } : scoreLabel(trustScore);
        const scoreColor =
          trustScore >= 50 ? "text-emerald-500"
          : trustScore >= 25 ? "text-amber-500"
          : "text-red-500";
        const pointerColor =
          trustScore >= 50 ? "#10b981"
          : trustScore >= 25 ? "#f59e0b"
          : "#ef4444";

        // Number Ticker animation for Trust Score
        if (state.lastScore !== trustScore) {
          if (state.scoreAnimId) {
            cancelAnimationFrame(state.scoreAnimId);
          }
          const startVal = state.lastScore || 0;
          state.lastScore = trustScore;

          const startTime = performance.now();
          const duration = 800; // ms

          const updateScoreAnim = (currentTime) => {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const ease = progress * (2 - progress); // easeOutQuad
            const currentVal = Math.round(startVal + (trustScore - startVal) * ease);

            const curColor =
              currentVal >= 50 ? "text-emerald-500"
              : currentVal >= 25 ? "text-amber-500"
              : "text-red-500";

            if (gaugeScoreEl) {
              gaugeScoreEl.innerHTML = `<span class="text-4xl font-bold tracking-tight tabular-nums ${curColor}">${currentVal}</span> ${tag(sl.text, sl.variant)}`;
            }

            if (progress < 1) {
              state.scoreAnimId = requestAnimationFrame(updateScoreAnim);
            } else {
              state.scoreAnimId = null;
            }
          };
          state.scoreAnimId = requestAnimationFrame(updateScoreAnim);
        } else {
          gaugeScoreEl.innerHTML = `<span class="text-4xl font-bold tracking-tight tabular-nums ${scoreColor}">${trustScore}</span> ${tag(sl.text, sl.variant)}`;
        }

        // Smooth transition slide for pointer
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (gaugePointer) {
              gaugePointer.style.left = Math.min(trustScore, 100) + "%";
              gaugePointer.style.opacity = "1";
              gaugePointer.style.borderColor = pointerColor;
              gaugePointer.style.boxShadow = `0 0 10px ${pointerColor}80, 0 2px 6px rgba(0,0,0,0.15)`;
            }
          });
        });

        gaugeTextEl.textContent = restrictedText
          || (trustScore >= 95 ? t.scoreText.excellent
            : trustScore >= 80 ? t.scoreText.great
            : trustScore >= 50 ? t.scoreText.minor
            : trustScore >= 25 ? t.scoreText.moderate : t.scoreText.severe);
      }

      // Drive the Claude card's status dot by trust score state. Three buckets
      // share the page's tag palette (emerald = safe, amber = neutral, red =
      // danger) so a single green doesn't compete with the emerald "未检测到"
      // tag elsewhere. Class names are full literals for Tailwind's scanner.
      const statusDot = $("statusDotClaude");
      if (statusDot) {
        let pingCls, dotCls;
        if (trustScore === null) {
          pingCls = "animate-ping absolute inline-flex h-full w-full rounded-full bg-oai-gray-300 dark:bg-oai-gray-600 opacity-75";
          dotCls = "relative inline-flex h-2 w-2 rounded-full bg-oai-gray-400 dark:bg-oai-gray-500";
        } else if (restrictedName || trustScore < 25) {
          pingCls = "animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75";
          dotCls = "relative inline-flex h-2 w-2 rounded-full bg-red-500";
        } else if (trustScore < 50) {
          pingCls = "animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75";
          dotCls = "relative inline-flex h-2 w-2 rounded-full bg-amber-500";
        } else {
          pingCls = "animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75";
          dotCls = "relative inline-flex h-2 w-2 rounded-full bg-emerald-500";
        }
        statusDot.innerHTML = `<span class="${pingCls}"></span><span class="${dotCls}"></span>`;
      }

      const regionWarn = $("regionWarn");
      if (regionWarn) {
        if (restrictedName) {
          regionWarn.innerHTML = `<span class="font-medium">⚠️ ${t.regionWarnTitle(restrictedName)}</span><br><span class="text-[13px] font-normal mt-1 block opacity-90">${t.regionWarnBody}</span>`;
          regionWarn.classList.remove("hidden");
        } else {
          regionWarn.classList.add("hidden");
        }
      }

      const supportRow = $("claudeRegionSupportRow");
      const supportVal = $("claudeRegionSupport");
      if (supportRow && supportVal) {
        if (restrictedName) {
          supportRow.classList.add("hidden");
        } else {
          const hasIp = !!(cr && cr.ip);
          const hasCC = !!(cr && cr.countryCode);
          supportVal.innerHTML = !hasIp || !hasCC ? tag(t.unknown, "neutral") : tag(t.regionAccessible, "safe");
          supportRow.classList.remove("hidden");
        }
      }

      // Properties
      const isResidential = cr?.isResidential ?? (a ? !a.is_datacenter : null);
      const companyType = a?.company?.type || "";
      const regionStr = cg?.country || cr?.country || "";
      const cityStr = cg?.city || cr?.city || "";
      let propTag;
      if (isResidential === true) propTag = tag(t.propsResidential, "safe");
      else if (isResidential === false) propTag = tag(t.propsDatacenter, "warn");
      else propTag = tag(t.unknown, "neutral");
      if (companyType) {
        const typeMap = { hosting: "Hosting", isp: "ISP", business: "Business", education: "Education" };
        // companyType only renders if it's a known map key OR after escaping;
        // upstream value never lands raw in innerHTML.
        const label = typeMap[companyType] || esc(companyType);
        propTag += ` <span class="text-xs text-oai-gray-500 dark:text-oai-gray-400">${label}</span>`;
      }

      $("propsContent").innerHTML =
        row(t.propsRegion, regionStr ? esc(regionStr) : tag(t.unknown, "neutral"))
        + row(t.propsCity, cityStr ? esc(cityStr) : tag(t.unknown, "neutral"))
        + row(t.propsType, propTag)
        + row(t.propsAsn, asn ? `<span class="font-mono tabular-nums">AS${esc(asn)}</span>` : tag(t.unknown, "neutral"))
        + row(t.propsOrg, asnOrg ? esc(asnOrg) : tag(t.unknown, "neutral"));

      const sec = a || {};
      $("securityContent").innerHTML =
        row(t.secVpn, boolTag(sec.is_vpn, t.secVpn, t.secClean))
        + row(t.secProxy, boolTag(sec.is_proxy, t.secProxyFlag, t.secClean))
        + row(t.secTor, boolTag(sec.is_tor, t.secTor, t.secClean))
        + row(t.secCrawler, boolTag(sec.is_crawler, t.secCrawlerYes, t.secCrawlerNo))
        + row(t.secAbuser, boolTag(sec.is_abuser, t.secAbuserYes, t.secAbuserNo));
    }

    // ─── DNS leak detection ───────────────────────────────────────────────
    async function detectDNSLeak() {
      const el = $("dnsLeakContent");
      if (!el) return;
      el.innerHTML = row(t.dnsStatus, undefined, true) + row(t.dnsOutletIp, undefined, true);
      const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      for (let i = 1; i <= 2; i++) {
        await new Promise((resolve) => {
          const img = new Image();
          const timer = setTimeout(resolve, 2000);
          img.onload = img.onerror = () => { clearTimeout(timer); resolve(); };
          // Use http: the DNS-trigger subdomains intentionally have no TLS
          // cert (https → SSL error before DNS leak detection completes).
          // The browser resolves the hostname BEFORE making the HTTP request,
          // so even when the request itself errors, the DNS query already
          // hit ip.net.coffee's authoritative server — which is the whole
          // point of this detection. Mixed-content blocking only applies on
          // https pages; this feature is local-only (http://127.0.0.1:7680)
          // so http is fine. On https pages (e.g. www.tokentracker.cc) the
          // /proxy/ipcheck/* prefix doesn't exist anyway, so the page is
          // effectively gated to the local runtime.
          img.src = `http://${token}-${i}.d.ip.net.coffee/pixel.gif?_=${Date.now()}`;
        });
      }
      await new Promise((r) => setTimeout(r, 1500));

      let dnsServers = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await fetch(`${PROXY}/api/dns/result/${token}`, { signal: AbortSignal.timeout(3000) });
          if (r.ok) {
            const data = await r.json();
            dnsServers = data.dns_servers || [];
            if (dnsServers.length > 0) break;
          }
        } catch { /* retry below */ }
        if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
      }

      if (dnsServers.length === 0) {
        el.innerHTML = row(t.dnsStatus, tag(t.dnsEncrypted, "safe"));
        return;
      }
      const claudeCountry = (state.claudeRisk?.country || "").toLowerCase();
      const claudeInChina = claudeCountry.includes("china") || claudeCountry.includes("中国");
      let showIP = null;
      let isLeaked = false;
      for (const ip of dnsServers) {
        let geo = null;
        try {
          const r = await fetch(`${PROXY}/api/geoip/${ip}`, { signal: AbortSignal.timeout(3000) });
          if (r.ok) geo = await r.json();
        } catch { /* geo enrichment is optional */ }
        const cc = geo?.country_code || "";
        const isp = geo?.isp || "";
        const isCN = cc === "cn";
        if (isCN && !claudeInChina) { showIP = { ip, cc, isp, leaked: true }; isLeaked = true; break; }
        if (!showIP) showIP = { ip, cc, isp, leaked: false };
      }
      let html = row(t.dnsStatus, isLeaked ? tag(t.dnsLeaked, "warn") : tag(t.dnsNoLeak, "safe"));
      if (showIP) {
        const ipValue = `${flagImg(showIP.cc)} <span class="ip-mask-target ${showIP.leaked ? "text-amber-600 dark:text-amber-400 font-medium" : ""}">${esc(showIP.ip)}</span>${showIP.leaked ? " " + tag(t.dnsCnTag, "warn") : ""}`;
        html += row(t.dnsOutlet, ipValue);
        if (showIP.isp) html += row(t.dnsIsp, `<span class="text-xs text-oai-gray-500 dark:text-oai-gray-400 font-normal truncate inline-block max-w-[12rem] align-bottom">${esc(showIP.isp)}</span>`);
      }
      el.innerHTML = html;
    }

    // ─── WebRTC UDP leak detection ────────────────────────────────────────
    async function detectWebRTCLeak() {
      const el = $("udpLeakContent");
      if (!el) return;
      el.innerHTML = row(t.udpStatus, undefined, true) + row(t.udpOutletIp, undefined, true);
      const udpIPs = new Set();
      try {
        const pc = new RTCPeerConnection({
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun.cloudflare.com:3478" },
          ],
        });
        pc.createDataChannel("");
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await new Promise((resolve) => {
          const timeout = setTimeout(() => { pc.close(); resolve(); }, 5000);
          pc.onicecandidate = (e) => {
            if (!e.candidate) { clearTimeout(timeout); pc.close(); resolve(); return; }
            const m = e.candidate.candidate.match(/([0-9]{1,3}\.){3}[0-9]{1,3}/);
            if (m) {
              const ip = m[0];
              if (!ip.startsWith("0.") && !ip.startsWith("127.") && ip !== "0.0.0.0") udpIPs.add(ip);
            }
            const m6 = e.candidate.candidate.match(/([a-f0-9]{1,4}:){2,7}[a-f0-9]{1,4}/i);
            if (m6) udpIPs.add(m6[0]);
          };
        });
      } catch { /* UDP candidates remain empty */ }

      const claudeIp = state.claudeRisk?.ip || "";
      const allUdp = [...udpIPs];
      const publicUdp = allUdp.filter((ip) =>
        !isIPv6(ip)
        && !ip.startsWith("192.168.") && !ip.startsWith("10.")
        && !ip.startsWith("172.") && !ip.startsWith("198.18.")
        && !ip.startsWith("198.19.") && !ip.startsWith("100.64.")
        && !ip.startsWith("127.") && !ip.startsWith("0."));

      if (publicUdp.length === 0 && allUdp.length === 0) {
        el.innerHTML = row(t.udpStatus, tag(t.udpDisabled, "safe"));
        return;
      }
      if (publicUdp.length === 0) {
        el.innerHTML = row(t.udpStatus, tag(t.udpNoLeak, "safe"));
        return;
      }
      let showIP = publicUdp.find((ip) => ip === claudeIp) || publicUdp[0];
      const hasMultiple = new Set(publicUdp).size > 1;
      const matchesClaude = showIP === claudeIp;
      const isLeaked = hasMultiple && !matchesClaude;
      let html = row(t.udpStatus, isLeaked ? tag(t.udpLeaked, "warn") : tag(t.udpNoLeak, "safe"));
      let showFlag = "", showCountry = "";
      try {
        const r = await fetch(`${PROXY}/api/geoip/${showIP}`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) { const g = await r.json(); showFlag = g.country_code || ""; showCountry = g.country || ""; }
      } catch { /* geo enrichment is optional */ }
      const ipValue = `${flagImg(showFlag)} <span class="${isLeaked ? "text-amber-600 dark:text-amber-400 font-medium" : ""}">${displayIP(showIP)}</span>${matchesClaude ? "" : isLeaked ? " " + tag(t.udpAnomaly, "warn") : ""}`;
      html += row(t.udpOutlet, ipValue);
      if (showCountry) html += row(t.udpOrigin, `<span class="text-xs text-oai-gray-500 dark:text-oai-gray-400 font-normal">${esc(showCountry)}</span>`);
      el.innerHTML = html;
    }

    // ─── Claude availability ──────────────────────────────────────────────
    async function detectClaudeAvail() {
      const el = $("claudeAvailContent");
      if (!el) return;
      el.innerHTML = row("claude.ai", undefined, true) + row("anthropic.com", undefined, true);
      const targets = [
        { name: "claude.ai", url: "https://claude.ai/cdn-cgi/trace" },
        { name: "anthropic.com", url: "https://www.anthropic.com/favicon.ico" },
      ];
      const results = await Promise.allSettled(targets.map(async (target) => {
        const start = performance.now();
        try {
          await fetch(target.url, { mode: "no-cors", signal: AbortSignal.timeout(6000) });
          return { name: target.name, ms: Math.round(performance.now() - start), ok: true };
        } catch {
          return { name: target.name, ms: -1, ok: false };
        }
      }));
      const restricted = restrictedRegion();
      let html = "";
      results.forEach((r) => {
        const d = r.value;
        if (restricted) {
          html += row(d.name, tag(t.availLat.unreachable, "danger"));
        } else if (d.ok) {
          const variant = d.ms < 250 ? "safe" : d.ms < 500 ? "info" : "warn";
          const label = d.ms < 250 ? t.availLat.normal : d.ms < 500 ? t.availLat.good : t.availLat.slow;
          html += row(d.name, `${tag(label, variant)} <span class="text-xs text-oai-gray-500 dark:text-oai-gray-400 font-normal">${d.ms}ms</span>`);
        } else {
          html += row(d.name, tag(t.availLat.unreachable, "danger"));
        }
      });
      try {
        const statusResp = await fetch(`${PROXY}/claude/status.json`, { signal: AbortSignal.timeout(3000) });
        if (statusResp.ok) {
          const st = await statusResp.json();
          const ind = st.overall_indicator || "none";
          const indText = t.availSvcStatus[ind] || t.availSvcStatus.other;
          const indVar = { none: "safe", minor: "warn", major: "danger", critical: "danger", maintenance: "warn" };
          html += row(t.availSvc, tag(indText, indVar[ind] || "warn"));
        }
      } catch { /* service status is optional */ }
      el.innerHTML = html;
    }
    root.__detectClaudeAvail = detectClaudeAvail;

    // ─── Device info ──────────────────────────────────────────────────────
    function renderDeviceInfo() {
      const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || t.unknown;
      const localOffset = -(new Date().getTimezoneOffset() / 60);
      const localUtc = "UTC" + (localOffset >= 0 ? "+" : "") + localOffset;
      const cr = state.claudeRisk;
      const _cc = (cr?.countryCode || "").toUpperCase();
      const claudeTz = cr?.timezone || CC_TO_TZ[_cc] || "";
      const tzIsExact = !!cr?.timezone;
      const claudeOffMin = currentOffsetMinutes(claudeTz);
      const localOffMin = -new Date().getTimezoneOffset();
      let tzMatch = null;
      if (claudeTz && claudeOffMin != null) tzMatch = Math.abs(claudeOffMin - localOffMin) <= 60;

      let tzHtml;
      // localTz from browser Intl, claudeTz from CC_TO_TZ map or upstream;
      // only the upstream-derived claudeTz can be malicious → esc() it.
      const safeLocalTz = esc(localTz);
      const safeClaudeTz = esc(claudeTz);
      if (tzMatch === true) {
        tzHtml = `${tag(t.devMatch, "safe")} <span class="text-xs text-oai-gray-500 dark:text-oai-gray-400">${safeLocalTz} (${localUtc})</span>`;
      } else if (tzMatch === false) {
        const claudeOffStr = formatOffsetHours(claudeOffMin);
        const diffHours = Math.round((claudeOffMin - localOffMin) / 60);
        const diffLabel = diffHours === 0 ? t.devDiffEqual
          : diffHours > 0 ? t.devDiffAhead(diffHours) : t.devDiffBehind(-diffHours);
        const claudeTzLabel = tzIsExact ? safeClaudeTz : `${safeClaudeTz} ${t.devEstSuffix}`;
        tzHtml = `${tag(t.devMismatch, "warn")}<br><span class="text-xs text-oai-gray-500 dark:text-oai-gray-400 font-normal">${t.devLocal} ${safeLocalTz} (${localUtc})<br>Claude ${claudeTzLabel} (${claudeOffStr}) · ${diffLabel}</span>`;
      } else {
        tzHtml = `<span class="text-xs text-oai-gray-500 dark:text-oai-gray-400 font-normal">${safeLocalTz} (${localUtc})</span>`;
      }

      const localLangs = navigator.languages || [navigator.language];
      const langsStr = localLangs.join(", ") || t.unknown;
      const localPrimary = (localLangs[0] || "").split("-")[0].toLowerCase();
      const regionLangs = LANG_MAP[_cc] || [];
      const langMatch = localPrimary && regionLangs.length ? regionLangs.includes(localPrimary) : null;
      let langHtml;
      const safeLangs = esc(langsStr);
      const safeRegionLangs = esc(regionLangs.join(" / "));
      if (langMatch === true) langHtml = `${tag(t.devMatch, "safe")} <span class="text-xs text-oai-gray-500 dark:text-oai-gray-400">${safeLangs}</span>`;
      else if (langMatch === false) langHtml = `${tag(t.devMismatch, "warn")}<br><span class="text-xs text-oai-gray-500 dark:text-oai-gray-400 font-normal">${t.devLocal} ${safeLangs}<br>${t.devLangExpected} ${safeRegionLangs}</span>`;
      else langHtml = `<span class="text-xs text-oai-gray-500 dark:text-oai-gray-400 font-normal">${safeLangs}</span>`;

      const ua = navigator.userAgent;
      let os = t.unknown, browser = t.unknown;
      if (ua.includes("Windows")) os = "Windows";
      else if (ua.includes("Mac OS")) os = "macOS";
      else if (ua.includes("iPhone") || ua.includes("iPad")) os = "iOS";
      else if (ua.includes("Android")) os = "Android";
      else if (ua.includes("Linux")) os = "Linux";
      if (ua.includes("Edg/")) browser = "Edge " + (ua.match(/Edg\/([\d.]+)/) || [])[1];
      else if (ua.includes("Chrome/")) browser = "Chrome " + (ua.match(/Chrome\/([\d.]+)/) || [])[1];
      else if (ua.includes("Firefox/")) browser = "Firefox " + (ua.match(/Firefox\/([\d.]+)/) || [])[1];
      else if (ua.includes("Safari/") && !ua.includes("Chrome")) browser = "Safari " + (ua.match(/Version\/([\d.]+)/) || [])[1];

      let webglRenderer = t.devUnsupported;
      try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (gl) {
          const ext = gl.getExtension("WEBGL_debug_renderer_info");
          if (ext) webglRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
        }
      } catch { /* WebGL renderer may be unavailable */ }
      let webglHash = t.devUnsupported;
      try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (gl) {
          const ext = gl.getExtension("WEBGL_debug_renderer_info");
          const vendor = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : "";
          const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "";
          const str = vendor + "~" + renderer + "~" + gl.getParameter(gl.VERSION) + "~" + gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
          let h = 0;
          for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
          webglHash = (h >>> 0).toString(16).toUpperCase();
        }
      } catch { /* WebGL fingerprint may be unavailable */ }
      let canvasHash = t.devUnsupported;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 200; canvas.height = 50;
        const ctx = canvas.getContext("2d");
        ctx.textBaseline = "top";
        ctx.font = "14px Arial";
        ctx.fillStyle = "#f60"; ctx.fillRect(50, 0, 100, 50);
        ctx.fillStyle = "#069"; ctx.fillText("net.coffee", 2, 15);
        ctx.fillStyle = "rgba(102,204,0,0.7)"; ctx.fillText("canvas fp", 4, 30);
        const data = canvas.toDataURL();
        let hash = 0;
        for (let i = 0; i < data.length; i++) hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0;
        canvasHash = (hash >>> 0).toString(16).toUpperCase();
      } catch { /* canvas fingerprint may be unavailable */ }
      const isTouch = navigator.maxTouchPoints > 0;
      const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      const netType = conn ? (conn.effectiveType || conn.type || t.unknown) : t.devNetUnsupported;
      const dnt = navigator.doNotTrack === "1" ? t.devDntOn : navigator.doNotTrack === "0" ? t.devDntOff : t.devDntUnset;

      // os/browser parsed from local navigator.userAgent — locally controlled,
      // safe. webglRenderer/canvasHash/webglHash from local Canvas/WebGL —
      // also local. langsStr/netType also navigator-derived. Still esc()
      // defense-in-depth for any future locale-dependent quirk.
      $("deviceContent").innerHTML =
        row(t.devTz, tzHtml)
        + row(t.devLang, langHtml)
        + row(t.devOs, `${esc(os)} <span class="text-oai-gray-400 dark:text-oai-gray-500">/</span> ${esc(browser)}`)
        + row(t.devTouch, isTouch ? tag(t.devTouchYes, "info") : tag(t.devTouchNo, "neutral"))
        + row(t.devNet, `<span class="font-mono uppercase">${esc(netType)}</span>`)
        + row(t.devDnt, esc(dnt))
        + row(t.devWebglRender, `<span class="text-xs font-normal text-oai-gray-600 dark:text-oai-gray-400 break-all">${esc(webglRenderer)}</span>`)
        + row(t.devCanvasFp, `<span class="font-mono text-oai-gray-700 dark:text-oai-gray-300">${esc(canvasHash)}</span>`)
        + row(t.devWebglFp, `<span class="font-mono text-oai-gray-700 dark:text-oai-gray-300">${esc(webglHash)}</span>`);
    }

    // ─── IP history ───────────────────────────────────────────────────────
    function getIPHistory() {
      try { return JSON.parse(localStorage.getItem(IP_HISTORY_KEY)) || []; } catch { return []; }
    }
    function saveAndRenderIPHistory() {
      const claudeIp = state.claudeRisk?.ip || "";
      const claudeCC = (state.claudeRisk?.countryCode || "").toLowerCase();
      const claudeGeo = state.claudeRisk?.city || "";
      if (!claudeIp) { renderIPHistory(); return; }
      const history = getIPHistory();
      const now = new Date();
      const entry = { ip: claudeIp, cc: claudeCC, geo: claudeGeo, time: now.toISOString() };
      if (history.length > 0) {
        const last = history[0];
        const hoursSince = (now - new Date(last.time)) / (1000 * 60 * 60);
        if (last.ip === claudeIp && hoursSince < 24) { renderIPHistory(); return; }
      }
      history.unshift(entry);
      if (history.length > IP_HISTORY_MAX) history.length = IP_HISTORY_MAX;
      try { localStorage.setItem(IP_HISTORY_KEY, JSON.stringify(history)); } catch { /* History persistence is optional. */ }
      renderIPHistory();
    }
    function renderIPHistory() {
      const el = $("ipHistoryContent");
      if (!el) return;
      const history = getIPHistory();
      if (history.length === 0) {
        el.innerHTML = `<span class="text-sm text-oai-gray-500 dark:text-oai-gray-400">${t.histEmpty}</span>`;
        return;
      }
      // h.geo / h.cc / h.ip flow: upstream JSON → localStorage → here. Treat
      // every field as tainted even though it round-tripped through our own
      // storage — the original write was upstream-controlled.
      el.innerHTML = `<ul class="divide-y divide-oai-gray-100 dark:divide-oai-gray-800">${
        history.map((h, i) => {
          const d = new Date(h.time);
          const timeStr = `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
          const isCurrent = i === 0;
          return `<li class="flex items-center justify-between py-3 gap-4">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-sm ${isCurrent ? "text-oai-black dark:text-white" : "text-oai-gray-500 dark:text-oai-gray-400"}">${timeStr}</span>
              ${isCurrent ? `<span class="inline-flex items-center rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300 px-1.5 py-0.5 text-[10px] font-medium">${esc(t.histCurrent)}</span>` : ""}
            </div>
            <div class="flex items-center gap-2 text-sm font-medium text-oai-black dark:text-white min-w-0">
              ${flagImg(h.cc)}
              ${linkIP(h.ip)}
              ${h.geo ? `<span class="text-xs text-oai-gray-500 dark:text-oai-gray-400 font-normal truncate">${esc(h.geo)}</span>` : ""}
            </div>
          </li>`;
        }).join("")
      }</ul>`;
    }
    root.__clearIPHistory = () => {
      try { localStorage.removeItem(IP_HISTORY_KEY); } catch { /* Keep any history that remains readable. */ }
      renderIPHistory();
    };

    // ─── Main orchestration ───────────────────────────────────────────────
    async function main() {
      const [, cnResult, claudeResult] = await Promise.allSettled([fetchCfIP(), fetchCNIP(), fetchClaudeIP()]);
      if (aborted) return;
      const cn = cnResult.status === "fulfilled" ? cnResult.value : null;
      const claude = claudeResult.status === "fulfilled" ? claudeResult.value : null;

      const tasks = [];
      tasks.push(renderIPCard("ipAddrCN", "ipGeoCN", cn?.ip, "cn"));

      tasks.push((async () => {
        const ipAddrEl = $("ipAddr");
        const ipGeoEl = $("ipGeo");
        if (!state.ip) {
          if (ipAddrEl) ipAddrEl.innerHTML = `<span class="text-oai-gray-400 dark:text-oai-gray-500">${t.failed}</span>`;
          if (ipGeoEl) ipGeoEl.textContent = "";
          return;
        }
        if (isIPv6(state.ip)) showIPv6Warning();
        if (ipAddrEl) ipAddrEl.innerHTML = linkIP(state.ip);
        try {
          const r = await fetch(`${PROXY}/api/geoip/${state.ip}`, { signal: AbortSignal.timeout(5000) });
          if (r.ok) {
            const g = await r.json();
            const cc = (g.country_code || "").toLowerCase();
            state.ippure = { ip: state.ip, country: g.country, countryCode: (g.country_code || "").toUpperCase(), region: g.region, city: g.city };
            state.cfGeo = [g.country, g.region, g.city, g.isp].filter(Boolean).join(" · ");
            if (ipAddrEl) ipAddrEl.innerHTML = `${flagImg(cc)} ${linkIP(state.ip)}`;
            setGeoText("ipGeo", state.cfGeo);
          }
        } catch { /* Cloudflare geo is optional */ }
      })());

      tasks.push((async () => {
        const claudeIp = claude?.ip;
        const ipAddrEl = $("ipAddrClaude");
        const ipGeoEl = $("ipGeoClaude");
        if (!claudeIp) {
          if (ipAddrEl) ipAddrEl.innerHTML = `<span class="text-oai-gray-400 dark:text-oai-gray-500">${t.failed}</span>`;
          if (ipGeoEl) ipGeoEl.textContent = "";
          return;
        }
        if (isIPv6(claudeIp)) showIPv6Warning();
        if (ipAddrEl) ipAddrEl.innerHTML = `${flagImg(claude.loc || "")} ${linkIP(claudeIp)}`;
        const [riskResp, geoResp] = await Promise.allSettled([
          fetch(`${PROXY}/api/iprisk/${claudeIp}`, { signal: AbortSignal.timeout(10000) }),
          fetch(`${PROXY}/api/geoip/${claudeIp}`, { signal: AbortSignal.timeout(5000) }),
        ]);
        let geoOk = false;
        if (geoResp.status === "fulfilled" && geoResp.value.ok) {
          try {
            const g = await geoResp.value.json();
            if (g.country) {
              state.claudeGeo = { country: g.country, region: g.region, city: g.city, isp: g.isp, country_code: g.country_code };
              const geo = [g.country, g.region, g.city, g.isp].filter(Boolean).join(" · ");
              if (ipAddrEl) ipAddrEl.innerHTML = `${flagImg(g.country_code || claude.loc || "")} ${linkIP(claudeIp)}`;
              setGeoText("ipGeoClaude", geo);
              geoOk = true;
            }
          } catch { /* local geo fallback runs below */ }
        }
        if (!geoOk && claude.loc) {
          if (ipAddrEl) ipAddrEl.innerHTML = `${flagImg(claude.loc)} ${linkIP(claudeIp)}`;
          setGeoText("ipGeoClaude", LOC_CC_TO_COUNTRY[claude.loc] || claude.loc.toUpperCase());
        }
        if (riskResp.status === "fulfilled" && riskResp.value.ok) {
          const d = await riskResp.value.json();
          state.ipapis = {
            is_datacenter: d.is_datacenter, is_vpn: d.is_vpn, is_proxy: d.is_proxy,
            is_tor: d.is_tor, is_crawler: d.is_crawler, is_abuser: d.is_abuser,
            is_mobile: d.is_mobile, company: { type: d.company_type, name: d.company_name },
            abuser_score: d.abuser_score, datacenter_name: d.datacenter_name,
          };
          state.claudeRisk = {
            ip: claudeIp, asn: d.asn, asOrganization: d.asOrganization,
            country: d.country, countryCode: d.countryCode, region: d.region, city: d.city,
            isResidential: d.isResidential, isBroadcast: d.isBroadcast,
            trust_score: d.trust_score, timezone: d.timezone,
          };
        }
      })());

      await Promise.allSettled(tasks);
      if (aborted) return;
      render();
      Promise.allSettled([detectDNSLeak(), detectWebRTCLeak(), detectClaudeAvail()]);
      renderDeviceInfo();
      saveAndRenderIPHistory();
      // No /api/session telemetry: the upstream collects all three IPs for
      // its own sharing analytics. Token Tracker stays local-first — token
      // counts only, never user IPs to third parties.
    }
    main();

    return () => {
      aborted = true;
      maskObserver.disconnect();
      if (state.scoreAnimId) cancelAnimationFrame(state.scoreAnimId);
      delete root.__setMaskOn;
      delete root.__clearIPHistory;
      delete root.__detectClaudeAvail;
    };
  }, []);

  // ─── React-bound controls ───────────────────────────────────────────────
  const handleMaskToggle = (next) => {
    setMaskOn(next);
    containerRef.current?.__setMaskOn?.(next);
  };
  const handleClearHistory = () => containerRef.current?.__clearIPHistory?.();
  const handleRefreshAvail = () => containerRef.current?.__detectClaudeAvail?.();

  // ─── Layout ──────────────────────────────────────────────────────────────
  const heroEmpty = { __html: "" };

  return (
    <div ref={containerRef} className="flex flex-col flex-1 text-oai-black dark:text-oai-white font-oai antialiased">
      <main className="flex-1 pt-8 sm:pt-10 pb-12 sm:pb-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          {/* Header */}
          <div className="flex items-start justify-between gap-4 mb-8">
            <div className="min-w-0">
              <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-oai-black dark:text-white mb-3">
                {copy("ipcheck.page.title")}
              </h1>
              <p className="text-oai-gray-500 dark:text-oai-gray-400 text-sm sm:text-base max-w-3xl text-pretty">
                {copy("ipcheck.page.subtitle")}
              </p>
            </div>
            <label className="shrink-0 inline-flex items-center gap-2.5 cursor-pointer select-none group">
              <div className="text-oai-gray-400 group-hover:text-oai-gray-600 dark:text-oai-gray-500 dark:group-hover:text-oai-gray-300 transition-colors duration-200">
                {maskOn ? (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4.5 w-4.5 animate-scale-up-fade">
                    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                    <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                    <path d="M6.61 6.61A13.52 13.52 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                    <line x1="2" y1="2" x2="22" y2="22" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4.5 w-4.5 animate-scale-up-fade">
                    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </div>
              <span className="text-xs font-medium text-oai-gray-500 group-hover:text-oai-gray-700 dark:text-oai-gray-400 dark:group-hover:text-oai-gray-200 transition-colors duration-200">
                {copy("ipcheck.mask.toggle")}
              </span>
              <span className="relative inline-block w-9 h-5">
                <input
                  type="checkbox"
                  checked={maskOn}
                  onChange={(e) => handleMaskToggle(e.target.checked)}
                  className="peer sr-only"
                />
                <span className="absolute inset-0 rounded-full bg-oai-gray-200 dark:bg-oai-gray-800 peer-checked:bg-oai-brand-500 transition-colors duration-200" />
                <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 peer-checked:translate-x-4" />
              </span>
            </label>
          </div>

          <div id="ipv6Warn" className="hidden mb-4 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
            {copy("ipcheck.ipv6.warn")}
          </div>

          <div className="space-y-4">
          {/* IP trio */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <IpHero id="CN" label={copy("ipcheck.ip.cn")} icon={null} className="animate-fade-in-up stagger-1" />
            <IpHero id="" label={copy("ipcheck.ip.cloudflare")} icon={<img src={`${PROXY}/favicons/cloudflare.webp`} alt="" className="h-4 w-4" />} className="animate-fade-in-up stagger-2" />
            <IpHero id="Claude" label={copy("ipcheck.ip.claude")} icon={<img src={`${PROXY}/favicons/claude.webp`} alt="" className="h-4 w-4" />} statusDot className="animate-fade-in-up stagger-3" />
          </div>

          {/* Trust + Properties + Security */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card title={copy("ipcheck.trust.title")} subtitle={copy("ipcheck.trust.subtitle")} className="animate-fade-in-up stagger-4">
              <div className="px-1 py-2">
                <div className="flex items-baseline justify-between mb-2 gap-3">
                  <div
                    id="gaugeScore"
                    className="flex items-baseline gap-2 min-h-[2.5rem]"
                    dangerouslySetInnerHTML={heroEmpty}
                  />
                </div>
                <div id="gaugeText" className="text-xs text-oai-gray-500 dark:text-oai-gray-400 mb-4 min-h-[1rem]" />
                <div>
                  <div className="relative">
                    <div
                      className="h-1.5 rounded-full"
                      style={{ background: "linear-gradient(90deg, #ef4444 0%, #f59e0b 50%, #10b981 100%)" }}
                    />
                    <span
                      id="gaugePointer"
                      className="absolute top-1/2 -translate-y-1/2 h-3.5 w-3.5 rounded-full bg-white dark:bg-oai-gray-900 border-2 border-oai-gray-300 dark:border-oai-gray-700 shadow-[0_2px_6px_rgba(0,0,0,0.15)] dark:shadow-[0_2px_6px_rgba(0,0,0,0.4)] -translate-x-1/2 transition-[left,border-color] duration-700 ease-out"
                      style={{ left: "0%" }}
                    />
                  </div>
                  <div className="mt-2 flex justify-between text-[10px] uppercase tracking-wider text-oai-gray-400 dark:text-oai-gray-500 font-medium">
                    <span>{copy("ipcheck.trust.gauge.low")}</span>
                    <span className="tracking-normal">25</span>
                    <span className="tracking-normal">50</span>
                    <span className="tracking-normal">75</span>
                    <span>{copy("ipcheck.trust.gauge.high")}</span>
                  </div>
                </div>
                <div id="regionWarn" className="hidden mt-4 rounded-lg border border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10 px-3 py-2 text-xs text-red-800 dark:text-red-300" />
                <div id="claudeRegionSupportRow" className="hidden mt-4 pt-4 border-t border-oai-gray-100 dark:border-oai-gray-800 flex items-center justify-between">
                  <span className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("ipcheck.trust.region_support")}</span>
                  <span id="claudeRegionSupport" className="text-sm font-medium text-oai-black dark:text-white" dangerouslySetInnerHTML={heroEmpty} />
                </div>
              </div>
            </Card>

            <Card title={copy("ipcheck.props.title")} className="animate-fade-in-up stagger-4">
              <div id="propsContent" className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800 pt-1" dangerouslySetInnerHTML={heroEmpty} />
            </Card>

            <Card title={copy("ipcheck.security.title")} className="animate-fade-in-up stagger-4">
              <div id="securityContent" className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800 pt-1" dangerouslySetInnerHTML={heroEmpty} />
            </Card>
          </div>

          {/* Availability + DNS leak + WebRTC leak */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card
              title={<span className="flex items-center gap-1.5">{copy("ipcheck.avail.title")}<Tooltip text={copy("ipcheck.avail.tooltip")} /></span>}
              action={<CardAction label={copy("ipcheck.avail.refresh")} onClick={handleRefreshAvail} />}
              className="animate-fade-in-up stagger-5"
            >
              <div id="claudeAvailContent" className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800 pt-1" dangerouslySetInnerHTML={heroEmpty} />
            </Card>
            <Card title={copy("ipcheck.dns.title")} className="animate-fade-in-up stagger-5">
              <div id="dnsLeakContent" className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800 pt-1" dangerouslySetInnerHTML={heroEmpty} />
            </Card>
            <Card title={copy("ipcheck.udp.title")} className="animate-fade-in-up stagger-5">
              <div id="udpLeakContent" className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800 pt-1" dangerouslySetInnerHTML={heroEmpty} />
            </Card>
          </div>

          <Card title={copy("ipcheck.device.title")} className="animate-fade-in-up stagger-6">
            <div id="deviceContent" className="divide-y divide-oai-gray-100 dark:divide-oai-gray-800 pt-1" dangerouslySetInnerHTML={heroEmpty} />
          </Card>

          <Card
            title={copy("ipcheck.history.title")}
            subtitle={copy("ipcheck.history.subtitle")}
            action={<CardAction label={copy("ipcheck.history.clear")} onClick={handleClearHistory} />}
            className="animate-fade-in-up stagger-6"
          >
            <div id="ipHistoryContent" dangerouslySetInnerHTML={heroEmpty} />
          </Card>
          </div>
        </div>
      </main>
    </div>
  );
}

// ─── Internal components ───────────────────────────────────────────────────

function Card({ title, subtitle, action, children, className = "" }) {
  // Use a plain <div> for the header row, NOT the semantic <header> element:
  // macOS app's WKWebView (Safari) applies a 36px padding-top to <header>
  // via its user-agent stylesheet (Blink does not). Chrome looks fine, the
  // app does not. <div> sidesteps all UA semantics.
  return (
    <section className={`rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-5 sm:p-6 transition-colors duration-200 ${className}`}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-oai-black dark:text-white">{title}</h2>
          {subtitle ? <p className="mt-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">{subtitle}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function CardAction({ label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 inline-flex h-7 items-center px-2.5 rounded-md text-xs font-medium text-oai-gray-600 dark:text-oai-gray-300 border border-oai-gray-200 dark:border-oai-gray-700 hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800 hover:text-oai-black dark:hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-oai-brand-500"
    >
      {label}
    </button>
  );
}

function Tooltip({ text }) {
  return (
    <span className="relative inline-flex items-center group">
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-oai-gray-400 dark:text-oai-gray-500" fill="currentColor" aria-hidden>
        <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM7.25 6.75a.75.75 0 0 1 1.5 0V11a.75.75 0 0 1-1.5 0V6.75zM8 4a.85.85 0 1 1 0 1.7A.85.85 0 0 1 8 4z" />
      </svg>
      <span className="pointer-events-none absolute left-1/2 top-full z-10 mt-1.5 -translate-x-1/2 w-56 rounded-md bg-oai-gray-900 dark:bg-oai-gray-800 px-2.5 py-2 text-[11px] font-normal text-white opacity-0 scale-95 translate-y-1 group-hover:opacity-100 group-hover:scale-100 group-hover:translate-y-0 transition-all duration-200 cubic-bezier(0.16, 1, 0.3, 1) leading-relaxed shadow-lg origin-top">
        {text}
      </span>
    </span>
  );
}

function IpHero({ id, label, icon, statusDot, className = "" }) {
  const addrId = `ipAddr${id}`;
  const geoId = `ipGeo${id}`;
  // Pulse dot signals "live, monitored connection" and encodes safety state
  // via color (set imperatively from trust score). Class names are full
  // literals so Tailwind's content scanner picks them up.
  return (
    <article
      id={`ipHero${id}`}
      className={`rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-5 sm:p-6 cursor-default transition-colors duration-200 ${className}`}
    >
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-medium text-oai-gray-500 dark:text-oai-gray-400 mb-2">
        {icon}
        <span>{label}</span>
        {statusDot ? (
          <span
            id={`statusDot${id}`}
            className="relative inline-flex h-2 w-2 ml-1.5"
            aria-hidden
          >
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-oai-gray-300 dark:bg-oai-gray-600 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-oai-gray-400 dark:bg-oai-gray-500" />
          </span>
        ) : null}
      </div>
      <div id={addrId} className="text-xl sm:text-2xl font-semibold text-oai-black dark:text-white flex items-center gap-2 min-h-[2rem]" dangerouslySetInnerHTML={{ __html: "" }} />
      <div id={geoId} className="mt-1 text-xs text-oai-gray-500 dark:text-oai-gray-400 truncate min-h-[1rem]" />
    </article>
  );
}
