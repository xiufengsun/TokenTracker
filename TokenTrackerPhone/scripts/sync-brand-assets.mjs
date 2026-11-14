#!/usr/bin/env node
// Copies the product's real provider marks into the iPhone asset catalog.
//
// Source of truth (never edit the generated output by hand):
//   dashboard/src/ui/dashboard/components/ProviderIcon.jsx
//     PROVIDER_LOGO_MAP        -> files in dashboard/public/brand-logos/
//     PROVIDER_LOGO_CLASS_MAP  -> marks the dashboard re-inks per theme
//     PROVIDER_ICON_MAP        -> inline mono SVG components
//   TokenTrackerBar/AppIcon-iOS-Default-1024x1024@1x.png -> product mark
//
// Resolution order matches ProviderIcon(): logo file first (with the pi-*
// prefix fallback), then the inline component, else the dashed placeholder.
// Marks drawn in currentColor, or re-inked by PROVIDER_LOGO_CLASS_MAP, become
// template images so SwiftUI tints them with the label color in both themes.
//
// Usage: node TokenTrackerPhone/scripts/sync-brand-assets.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const jsxPath = path.join(repo, "dashboard/src/ui/dashboard/components/ProviderIcon.jsx");
const logosDir = path.join(repo, "dashboard/public/brand-logos");
const catalog = path.join(repo, "TokenTrackerPhone/TokenTrackerPhone/Assets.xcassets");
const brandDir = path.join(catalog, "ProviderMarks");
const swiftOut = path.join(repo, "TokenTrackerPhone/TokenTrackerPhone/Views/Components/ProviderMarkCatalog.generated.swift");

const jsx = fs.readFileSync(jsxPath, "utf8");

function objectLiteral(name) {
  const start = jsx.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`${name} not found in ProviderIcon.jsx`);
  const end = jsx.indexOf("\n};", start);
  const body = jsx.slice(start, end).replace(/\/\/.*$/gm, "");
  const out = {};
  for (const m of body.matchAll(/^\s*("?[A-Z0-9-]+"?)\s*:\s*("[^"]*"|[A-Za-z]+)\s*,/gm)) {
    out[m[1].replace(/"/g, "")] = m[2].replace(/"/g, "");
  }
  return out;
}

const logoMap = objectLiteral("PROVIDER_LOGO_MAP");
const classMap = objectLiteral("PROVIDER_LOGO_CLASS_MAP");
const iconMap = objectLiteral("PROVIDER_ICON_MAP");

function componentSource(name) {
  const start = jsx.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = jsx.indexOf("\n}\n", start);
  return jsx.slice(start, end);
}

// JSX <svg> -> standalone SVG. Only the attribute forms ProviderIcon.jsx uses.
function jsxToSvg(src) {
  const open = src.indexOf("<svg");
  const close = src.lastIndexOf("</svg>");
  if (open < 0 || close < 0) return null;
  let svg = src.slice(open, close + 6);
  svg = svg
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\s(width|height)=\{size\}/g, ' $1="24"')
    .replace(/\sclassName=\{[^}]*\}/g, "")
    .replace(/\sxmlns="[^"]*"/g, "")
    .replace(/fillRule=/g, "fill-rule=")
    .replace(/clipRule=/g, "clip-rule=")
    .replace(/strokeWidth=/g, "stroke-width=")
    .replace(/strokeLinecap=/g, "stroke-linecap=")
    .replace(/strokeLinejoin=/g, "stroke-linejoin=")
    .replace(/strokeDasharray=/g, "stroke-dasharray=")
    .replace(/aria-hidden="true"/g, "")
    .replace(/<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (/=\{/.test(svg)) throw new Error(`Unconverted JSX expression in:\n${svg.slice(0, 200)}`);
  return svg;
}

function writeImageset(name, files, { template }) {
  const dir = path.join(brandDir, `${name}.imageset`);
  fs.mkdirSync(dir, { recursive: true });
  const images = [];
  for (const f of files) {
    fs.writeFileSync(path.join(dir, f.filename), f.data);
    const entry = { filename: f.filename, idiom: "universal" };
    if (f.dark) entry.appearances = [{ appearance: "luminosity", value: "dark" }];
    images.push(entry);
  }
  const isVector = files.every((f) => f.filename.endsWith(".svg"));
  const contents = {
    images,
    info: { author: "xcode", version: 1 },
    properties: {
      ...(isVector ? { "preserves-vector-representation": true } : {}),
      "template-rendering-intent": template ? "template" : "original",
    },
  };
  fs.writeFileSync(path.join(dir, "Contents.json"), JSON.stringify(contents, null, 2) + "\n");
}

function assetFromLogoFile(file, forceTemplate) {
  const base = path.basename(file).replace(/\.(svg|png)$/, "");
  const name = `ProviderMark-${base}`;
  const raw = fs.readFileSync(path.join(logosDir, path.basename(file)));
  if (file.endsWith(".png")) {
    writeImageset(name, [{ filename: `${base}.png`, data: raw }], { template: forceTemplate });
    return { name, template: forceTemplate };
  }
  let svg = raw.toString("utf8");
  const embedded = svg.match(/href="data:image\/png;base64,([^"]+)"/);
  if (embedded) {
    // A PNG wrapped in SVG: ship the PNG itself, CoreSVG drops <image>.
    writeImageset(name, [{ filename: `${base}.png`, data: Buffer.from(embedded[1], "base64") }], { template: forceTemplate });
    return { name, template: forceTemplate };
  }
  const mono = svg.includes("currentColor");
  svg = svg
    .replace(/currentColor/g, "#000000")
    .replace(/\swidth="1em"/, ' width="24"')
    .replace(/\sheight="1em"/, ' height="24"');
  const template = mono || forceTemplate;
  writeImageset(name, [{ filename: `${base}.svg`, data: svg }], { template });
  return { name, template };
}

function assetFromComponent(component) {
  const src = componentSource(component);
  const base = component.replace(/Icon$/, "").toLowerCase();
  const name = `ProviderMark-inline-${base}`;
  const imgs = [...src.matchAll(/src="\/brand-logos\/([^"]+\.png)"/g)].map((m) => m[1]);
  if (imgs.length) {
    // AcodeIcon: separate light / dark PNGs, mapped to asset appearances.
    const files = imgs.map((f) => ({
      filename: f,
      data: fs.readFileSync(path.join(logosDir, f)),
      dark: /-dark\.png$/.test(f),
    }));
    writeImageset(name, files, { template: false });
    return { name, template: false };
  }
  const svg = jsxToSvg(src);
  if (!svg) throw new Error(`No <svg> in ${component}`);
  const mono = svg.includes("currentColor");
  writeImageset(name, [{ filename: `${base}.svg`, data: svg.replace(/currentColor/g, "#000000") }], { template: mono });
  return { name, template: mono };
}

fs.rmSync(brandDir, { recursive: true, force: true });
fs.mkdirSync(brandDir, { recursive: true });
fs.writeFileSync(
  path.join(brandDir, "Contents.json"),
  JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2) + "\n",
);

const entries = {};
const byFile = new Map();
for (const [key, file] of Object.entries(logoMap)) {
  const forceTemplate = Boolean(classMap[key]);
  const cacheKey = `${file}|${forceTemplate}`;
  if (!byFile.has(cacheKey)) byFile.set(cacheKey, assetFromLogoFile(file, forceTemplate));
  entries[key] = byFile.get(cacheKey);
}
const byComponent = new Map();
for (const [key, component] of Object.entries(iconMap)) {
  if (entries[key]) continue; // logo file wins, same as ProviderIcon()
  // piAwareLogoKey(): any PI-* key without its own logo resolves to the PI logo.
  if (key.startsWith("PI-") && logoMap.PI) continue;
  if (!byComponent.has(component)) byComponent.set(component, assetFromComponent(component));
  entries[key] = byComponent.get(component);
}

// Product mark: the shipped iOS app icon artwork, used in-app as-is.
const markDir = path.join(catalog, "TokenTrackerMark.imageset");
fs.mkdirSync(markDir, { recursive: true });
fs.copyFileSync(
  path.join(repo, "TokenTrackerBar/AppIcon-iOS-Default-1024x1024@1x.png"),
  path.join(markDir, "TokenTrackerMark.png"),
);
fs.writeFileSync(
  path.join(markDir, "Contents.json"),
  JSON.stringify({
    images: [{ filename: "TokenTrackerMark.png", idiom: "universal" }],
    info: { author: "xcode", version: 1 },
    properties: { "template-rendering-intent": "original" },
  }, null, 2) + "\n",
);

const keys = Object.keys(entries).sort();
const lines = keys.map((k) => {
  const e = entries[k];
  return `        "${k}": .init(asset: "${e.name}", isTemplate: ${e.template}),`;
});
const swift = `// Generated by TokenTrackerPhone/scripts/sync-brand-assets.mjs from
// dashboard/src/ui/dashboard/components/ProviderIcon.jsx. Do not edit.

enum ProviderMarkCatalog {
    struct Entry: Equatable {
        let asset: String
        let isTemplate: Bool
    }

    /// Keyed by \`source.uppercased()\`, like \`PROVIDER_ICON_MAP\` / \`PROVIDER_LOGO_MAP\`.
    static let entries: [String: Entry] = [
${lines.join("\n")}
    ]
}
`;
fs.writeFileSync(swiftOut, swift);
console.log(`Wrote ${keys.length} provider keys, ${byFile.size + byComponent.size} assets.`);
