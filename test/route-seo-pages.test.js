const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const repoRoot = path.join(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

// Guards the SEO fix that makes /ip-check and /leaderboard independently
// indexable. The dashboard is a single-page app: Vercel rewrites every route to
// index.html, whose canonical is the homepage. Without per-route static HTML
// (self-referential canonical + route-specific copy) Google collapses these
// routes into the homepage and drops them from the index — which is exactly the
// organic traffic these tests protect.
const ROUTE_PAGES = [
  { route: "/ip-check", file: "/ip-check.html", canonical: "https://www.tokentracker.cc/ip-check" },
  { route: "/leaderboard", file: "/leaderboard.html", canonical: "https://www.tokentracker.cc/leaderboard" },
];

test("vercel.json rewrites map route SEO pages before the SPA catch-all", () => {
  const config = JSON.parse(read("dashboard/vercel.json"));
  const rewrites = (config.routes || config.rewrites || []).map((route) => ({
    source: route.src || route.source,
    destination: route.dest || route.destination,
  }));
  const catchAllIndex = rewrites.findIndex((r) => r.destination === "/index.html");
  assert.ok(catchAllIndex >= 0, "expected SPA catch-all rewrite to exist");

  for (const { route, file } of ROUTE_PAGES) {
    const index = rewrites.findIndex((r) => r.destination === file && new RegExp(r.source).test(route));
    assert.ok(index >= 0, `expected rewrite ${route} -> ${file}`);
    assert.ok(index < catchAllIndex, `${route} rewrite must precede the SPA fallback`);
  }
});

test("vite.config.js registers the route SEO plugin and defines each route page", () => {
  const config = read("dashboard/vite.config.js");
  assert.ok(config.includes("routeSeoPagesPlugin()"), "route SEO plugin should be registered in plugins array");
  assert.ok(config.includes("ROUTE_SEO_PAGES"), "ROUTE_SEO_PAGES config should exist");

  for (const { file, canonical } of ROUTE_PAGES) {
    assert.ok(config.includes(`"${file.replace(/^\//, "")}"`), `ROUTE_SEO_PAGES should define ${file}`);
    assert.ok(config.includes(`"${canonical}"`), `ROUTE_SEO_PAGES should set canonical ${canonical}`);
  }
});

test("sitemap.xml lists the indexable route pages", () => {
  const sitemap = read("dashboard/public/sitemap.xml");
  for (const { canonical } of ROUTE_PAGES) {
    assert.ok(sitemap.includes(canonical), `sitemap should include ${canonical}`);
  }
});
