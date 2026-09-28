#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────
# bundle-node.sh
# Downloads Node.js binary and bundles
# tokentracker source into EmbeddedServer/
#
# Usage:
#   ./bundle-node.sh              # universal (arm64 + x64)
#   ./bundle-node.sh --arch arm64 # Apple Silicon only
#   ./bundle-node.sh --arch x64   # Intel only
#   ./bundle-node.sh --clean      # wipe EmbeddedServer/
# ──────────────────────────────────────────────

# Pinned Node.js version. Any bump must come paired with running
# `npm test` against the new undici (the version Node 22+ bundles), since
# Node minor releases regularly tighten undici header validation — e.g. the
# 22.14 → 22.22 bump turned every POST /api/auth/* into 502 by promoting
# Content-Length to a forbidden request header (see v0.24.5 release notes).
EXPECTED_NODE_VERSION="22.22.2"
NODE_VERSION="${NODE_VERSION:-$EXPECTED_NODE_VERSION}"
if [[ "$NODE_VERSION" != "$EXPECTED_NODE_VERSION" ]]; then
  echo "❌ Refusing to bundle Node.js v${NODE_VERSION}; expected pinned v${EXPECTED_NODE_VERSION}." >&2
  echo "   Update EXPECTED_NODE_VERSION in this script after running npm test" >&2
  echo "   against the new Node so undici-regression cases (e.g. auth-relay" >&2
  echo "   forbidden headers) are still caught by CI." >&2
  exit 1
fi
TARGET_ARCH="universal"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
EMBED_DIR="$SCRIPT_DIR/../EmbeddedServer"

# ── Parse args ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean)
      echo "🧹 Cleaning EmbeddedServer/..."
      rm -rf "$EMBED_DIR"
      echo "Done."
      exit 0
      ;;
    --arch)
      TARGET_ARCH="${2:-universal}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

# ── Always start fresh ──
rm -rf "$EMBED_DIR"
mkdir -p "$EMBED_DIR"

TMPDIR_BUNDLE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BUNDLE"' EXIT

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 1. Download Node.js v${NODE_VERSION}
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NODE_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"
ARM64_TAR="node-v${NODE_VERSION}-darwin-arm64.tar.gz"
X64_TAR="node-v${NODE_VERSION}-darwin-x64.tar.gz"

# Use cache directory if available (CI caches pinned Node.js downloads)
CACHE_DIR="${NODE_CACHE_DIR:-}"
if [[ -n "$CACHE_DIR" ]]; then
  mkdir -p "$CACHE_DIR"
fi

if [[ "$TARGET_ARCH" == "arm64" ]]; then
  echo "⬇️  Downloading Node.js v${NODE_VERSION} (arm64 only)..."
  if [[ -n "$CACHE_DIR" && -f "$CACHE_DIR/$ARM64_TAR" ]]; then
    echo "  (using cached $ARM64_TAR)"
    cp "$CACHE_DIR/$ARM64_TAR" "$TMPDIR_BUNDLE/$ARM64_TAR"
  else
    curl -fSL --progress-bar -o "$TMPDIR_BUNDLE/$ARM64_TAR" "$NODE_BASE_URL/$ARM64_TAR"
    [[ -n "$CACHE_DIR" ]] && cp "$TMPDIR_BUNDLE/$ARM64_TAR" "$CACHE_DIR/$ARM64_TAR"
  fi
  tar -xzf "$TMPDIR_BUNDLE/$ARM64_TAR" -C "$TMPDIR_BUNDLE" "node-v${NODE_VERSION}-darwin-arm64/bin/node"
  cp "$TMPDIR_BUNDLE/node-v${NODE_VERSION}-darwin-arm64/bin/node" "$EMBED_DIR/node"
elif [[ "$TARGET_ARCH" == "x64" ]]; then
  echo "⬇️  Downloading Node.js v${NODE_VERSION} (x64 only)..."
  if [[ -n "$CACHE_DIR" && -f "$CACHE_DIR/$X64_TAR" ]]; then
    echo "  (using cached $X64_TAR)"
    cp "$CACHE_DIR/$X64_TAR" "$TMPDIR_BUNDLE/$X64_TAR"
  else
    curl -fSL --progress-bar -o "$TMPDIR_BUNDLE/$X64_TAR" "$NODE_BASE_URL/$X64_TAR"
    [[ -n "$CACHE_DIR" ]] && cp "$TMPDIR_BUNDLE/$X64_TAR" "$CACHE_DIR/$X64_TAR"
  fi
  tar -xzf "$TMPDIR_BUNDLE/$X64_TAR" -C "$TMPDIR_BUNDLE" "node-v${NODE_VERSION}-darwin-x64/bin/node"
  cp "$TMPDIR_BUNDLE/node-v${NODE_VERSION}-darwin-x64/bin/node" "$EMBED_DIR/node"
else
  echo "⬇️  Downloading Node.js v${NODE_VERSION} (arm64 + x64)..."
  if [[ -n "$CACHE_DIR" && -f "$CACHE_DIR/$ARM64_TAR" ]]; then
    echo "  (using cached $ARM64_TAR)"
    cp "$CACHE_DIR/$ARM64_TAR" "$TMPDIR_BUNDLE/$ARM64_TAR"
  else
    curl -fSL --progress-bar -o "$TMPDIR_BUNDLE/$ARM64_TAR" "$NODE_BASE_URL/$ARM64_TAR"
    [[ -n "$CACHE_DIR" ]] && cp "$TMPDIR_BUNDLE/$ARM64_TAR" "$CACHE_DIR/$ARM64_TAR"
  fi
  if [[ -n "$CACHE_DIR" && -f "$CACHE_DIR/$X64_TAR" ]]; then
    echo "  (using cached $X64_TAR)"
    cp "$CACHE_DIR/$X64_TAR" "$TMPDIR_BUNDLE/$X64_TAR"
  else
    curl -fSL --progress-bar -o "$TMPDIR_BUNDLE/$X64_TAR"   "$NODE_BASE_URL/$X64_TAR"
    [[ -n "$CACHE_DIR" ]] && cp "$TMPDIR_BUNDLE/$X64_TAR" "$CACHE_DIR/$X64_TAR"
  fi
  tar -xzf "$TMPDIR_BUNDLE/$ARM64_TAR" -C "$TMPDIR_BUNDLE" "node-v${NODE_VERSION}-darwin-arm64/bin/node"
  tar -xzf "$TMPDIR_BUNDLE/$X64_TAR"   -C "$TMPDIR_BUNDLE" "node-v${NODE_VERSION}-darwin-x64/bin/node"
  echo "🔗 Creating universal binary with lipo..."
  lipo -create \
    "$TMPDIR_BUNDLE/node-v${NODE_VERSION}-darwin-arm64/bin/node" \
    "$TMPDIR_BUNDLE/node-v${NODE_VERSION}-darwin-x64/bin/node" \
    -output "$EMBED_DIR/node"
fi

chmod +x "$EMBED_DIR/node"
BUNDLED_NODE_VERSION="$("$EMBED_DIR/node" -p 'process.versions.node' 2>/dev/null || echo unknown)"
if [[ "$BUNDLED_NODE_VERSION" != "$EXPECTED_NODE_VERSION" ]]; then
  echo "❌ Bundled Node drifted: expected v${EXPECTED_NODE_VERSION}, got v${BUNDLED_NODE_VERSION}" >&2
  exit 1
fi
# Strip local symbols (~44MB off the universal binary). strip invalidates the
# code signature, so re-sign ad-hoc immediately — CI re-signs this Mach-O again
# before DMG packaging, but local builds run the binary straight from here.
echo "✂️  Stripping local symbols..."
strip -x "$EMBED_DIR/node"
codesign -s - -f "$EMBED_DIR/node"
STRIPPED_NODE_VERSION="$("$EMBED_DIR/node" -p 'process.versions.node' 2>/dev/null || echo unknown)"
if [[ "$STRIPPED_NODE_VERSION" != "$EXPECTED_NODE_VERSION" ]]; then
  echo "❌ Stripped Node binary no longer runs (got: $STRIPPED_NODE_VERSION)" >&2
  exit 1
fi

echo "✅ Node.js binary ready ($TARGET_ARCH) — v${BUNDLED_NODE_VERSION}"
file "$EMBED_DIR/node"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 2. Bundle tokentracker source
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "📂 Copying tokentracker source..."

TT_DIR="$EMBED_DIR/tokentracker"
mkdir -p "$TT_DIR/bin"

cp "$REPO_ROOT/bin/tracker.js" "$TT_DIR/bin/"
cp -R "$REPO_ROOT/src" "$TT_DIR/src"
cp "$REPO_ROOT/package.json" "$TT_DIR/"
# The lockfile pins transitive versions; without it `npm install` resolves
# whatever is newest at build time (undici 8.11.0 shipped in 1.0.2 this way).
cp "$REPO_ROOT/package-lock.json" "$TT_DIR/"

# Dashboard build artifacts
if [[ -d "$REPO_ROOT/dashboard/dist" ]]; then
  mkdir -p "$TT_DIR/dashboard"
  cp -R "$REPO_ROOT/dashboard/dist" "$TT_DIR/dashboard/dist"
else
  echo "⚠️  dashboard/dist/ not found — run 'npm run dashboard:build' first"
  echo "   Continuing without dashboard assets..."
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 3. Install production dependencies
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "📥 Installing production dependencies..."
(cd "$TT_DIR" && npm ci --omit=dev --no-optional --ignore-scripts 2>&1 | tail -1)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 4. Clean node_modules bloat
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo "🗑️  Cleaning node_modules bloat..."

find "$TT_DIR/node_modules" -type f \( \
  -name "*.md" -o \
  -name "*.txt" -o \
  -name "*.map" -o \
  -name "*.ts" -o \
  -name "*.d.ts" -o \
  -iname "LICENSE*" -o \
  -iname "LICENCE*" -o \
  -iname "CHANGELOG*" -o \
  -iname "CHANGES*" -o \
  -iname "HISTORY*" -o \
  -name ".npmignore" -o \
  -name ".eslintrc*" -o \
  -name ".prettierrc*" -o \
  -name "tsconfig.json" -o \
  -name ".editorconfig" \
\) -delete 2>/dev/null || true

find "$TT_DIR/node_modules" -type d \( \
  -name "test" -o \
  -name "tests" -o \
  -name "__tests__" -o \
  -name "examples" -o \
  -name "example" -o \
  -name "docs" -o \
  -name ".github" \
\) -exec rm -rf {} + 2>/dev/null || true

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 5. Size report
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo "═══════════════════════════════════════"
echo "  EmbeddedServer Size Report ($TARGET_ARCH)"
echo "═══════════════════════════════════════"

NODE_SIZE=$(du -sh "$EMBED_DIR/node" | cut -f1)
TT_SRC_SIZE=$(du -sh "$TT_DIR/src" "$TT_DIR/bin" | tail -1 | cut -f1)
NM_SIZE=$(du -sh "$TT_DIR/node_modules" 2>/dev/null | cut -f1 || echo "0")
DASH_SIZE=$(du -sh "$TT_DIR/dashboard/dist" 2>/dev/null | cut -f1 || echo "N/A")
TOTAL_SIZE=$(du -sh "$EMBED_DIR" | cut -f1)

printf "  %-25s %s\n" "Node.js binary:" "$NODE_SIZE"
printf "  %-25s %s\n" "Source (src/ + bin/):" "$TT_SRC_SIZE"
printf "  %-25s %s\n" "node_modules:" "$NM_SIZE"
printf "  %-25s %s\n" "Dashboard dist:" "$DASH_SIZE"
echo "───────────────────────────────────────"
printf "  %-25s %s\n" "TOTAL:" "$TOTAL_SIZE"
echo "═══════════════════════════════════════"
echo ""
echo "✅ Bundle complete: $EMBED_DIR"
