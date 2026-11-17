const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

// DashboardPage is too heavy to render in a unit test, so this pins the wiring
// of the Profile selector in its source, as dashboard-layout-adjustments does
// for the layout. Spec: the chosen profile narrows the summary, daily table,
// trend and heatmap; the model breakdown stays unfiltered because it supplies
// the list of profiles to choose from.

const page = fs.readFileSync(
  path.join(__dirname, "..", "dashboard", "src", "pages", "DashboardPage.jsx"),
  "utf8",
);

// The text between "name({" and its matching "})".
function callBodies(name) {
  const bodies = [];
  let from = 0;
  for (;;) {
    const start = page.indexOf(`${name}({`, from);
    if (start === -1) break;
    let depth = 0;
    let i = page.indexOf("{", start);
    const open = i;
    for (; i < page.length; i += 1) {
      if (page[i] === "{") depth += 1;
      else if (page[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push(page.slice(open, i + 1));
    from = i;
  }
  return bodies;
}

test("both useUsageData calls (hero total and daily breakdown) receive the profile", () => {
  const calls = callBodies("useUsageData");
  assert.equal(calls.length, 2);
  for (const body of calls) assert.match(body, /profile:\s*selectedProfile/);
});

test("the trend and the heatmap receive the profile", () => {
  for (const name of ["useTrendData", "useActivityHeatmap"]) {
    const calls = callBodies(name);
    assert.equal(calls.length, 1, name);
    assert.match(calls[0], /profile:\s*selectedProfile/, name);
  }
});

test("the trend zoom modal reads the same profile as the main trend chart", () => {
  const zoom = page.slice(page.indexOf("const trendZoomConfig"), page.indexOf("const {", page.indexOf("const trendZoomConfig")));
  assert.match(zoom, /profile:\s*selectedProfile/);
  assert.match(zoom, /selectedProfile,?\s*\]/, "the memo must depend on the profile");
});

test("the model breakdown is not filtered by profile, so the selector keeps listing every profile", () => {
  const calls = callBodies("useUsageModelBreakdown");
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /profile/);
});

test("the profile choice is ignored in the account (cloud) view", () => {
  assert.match(page, /const selectedProfile = accountView \? "" : storedProfile;/);
  assert.match(page, /accountView \? \[\] : buildProfileOptions\(knownProfiles\)/);
});

test("the selector state starts on All profiles (no default)", () => {
  assert.match(page, /useState\(""\);\s*\n\s*const \[knownProfiles/);
});

test("the options reach UsageOverview through DashboardView", () => {
  const view = fs.readFileSync(
    path.join(__dirname, "..", "dashboard", "src", "ui", "dashboard", "views", "DashboardView.jsx"),
    "utf8",
  );
  for (const prop of ["profileOptions", "selectedProfile", "onProfileChange"]) {
    assert.match(page, new RegExp(`${prop}=\\{`), `DashboardPage passes ${prop}`);
    assert.match(view, new RegExp(`${prop}=\\{${prop}\\}`), `DashboardView forwards ${prop}`);
  }
});
