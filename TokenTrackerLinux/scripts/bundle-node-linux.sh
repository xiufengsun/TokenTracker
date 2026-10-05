#!/usr/bin/env bash
set -euo pipefail

EXPECTED_NODE_VERSION="22.22.2"
NODE_VERSION="${NODE_VERSION:-$EXPECTED_NODE_VERSION}"
if [[ "$NODE_VERSION" != "$EXPECTED_NODE_VERSION" ]]; then
  echo "Refusing to bundle Node.js v${NODE_VERSION}; expected pinned v${EXPECTED_NODE_VERSION}." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LINUX_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$LINUX_DIR/.." && pwd)"
# Overrides keep bundle tests isolated; production builds retain these default paths.
EMBED_DIR="${TOKENTRACKER_LINUX_EMBED_DIR:-$LINUX_DIR/EmbeddedServer}"
DASHBOARD_DIST="${TOKENTRACKER_DASHBOARD_DIST:-$REPO_ROOT/dashboard/dist}"
TAURI_ICON="${TOKENTRACKER_TAURI_ICON:-$LINUX_DIR/src-tauri/icons/icon.png}"

TARGET_ARCH="${TARGET_ARCH:-x64}"
if [[ "$TARGET_ARCH" != "x64" ]]; then
  echo "Refusing to bundle unsupported Linux architecture: $TARGET_ARCH" >&2
  exit 1
fi

assert_safe_embed_dir() {
  local normalized="$EMBED_DIR"
  while [[ "$normalized" != "/" && "$normalized" == */ ]]; do
    normalized="${normalized%/}"
  done
  if [[ -z "$normalized" || "$normalized" != /* ]]; then
    echo "Refusing to clean a non-absolute EmbeddedServer path: $EMBED_DIR" >&2
    exit 1
  fi
  case "$normalized" in
    /|"$SCRIPT_DIR"|"$LINUX_DIR"|"$REPO_ROOT")
      echo "Refusing to clean unsafe EmbeddedServer path: $EMBED_DIR" >&2
      exit 1
      ;;
  esac
  if [[ "$(basename -- "$normalized")" != "EmbeddedServer" ]]; then
    echo "Refusing to clean a path not named EmbeddedServer: $EMBED_DIR" >&2
    exit 1
  fi

  local component="$normalized"
  while [[ "$component" != "/" ]]; do
    if [[ -L "$component" ]]; then
      echo "Refusing to clean an EmbeddedServer path containing a symlink: $EMBED_DIR" >&2
      exit 1
    fi
    component="$(dirname -- "$component")"
  done
}

assert_safe_embed_dir

NODE_PLATFORM="linux-${TARGET_ARCH}"
NODE_TAR="node-v${NODE_VERSION}-${NODE_PLATFORM}.tar.gz"
NODE_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"

if [[ "${1:-}" == "--clean" ]]; then
  rm -rf "$EMBED_DIR"
  echo "Cleaned $EMBED_DIR"
  exit 0
fi

node "$LINUX_DIR/scripts/sync-tauri-icon.mjs" "$REPO_ROOT/dashboard/public/icon-512.png" "$TAURI_ICON"

rm -rf "$EMBED_DIR"
mkdir -p "$EMBED_DIR"

TMPDIR_BUNDLE="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BUNDLE"' EXIT

curl -fSL --retry 4 --retry-delay 2 -o "$TMPDIR_BUNDLE/$NODE_TAR" "$NODE_BASE_URL/$NODE_TAR"
curl -fSL --retry 4 --retry-delay 2 -o "$TMPDIR_BUNDLE/SHASUMS256.txt" "$NODE_BASE_URL/SHASUMS256.txt"
EXPECTED_SUM="$(grep " $NODE_TAR\$" "$TMPDIR_BUNDLE/SHASUMS256.txt" | awk '{print $1}')"
ACTUAL_SUM="$(sha256sum "$TMPDIR_BUNDLE/$NODE_TAR" | awk '{print $1}')"
if [[ -z "$EXPECTED_SUM" || "$EXPECTED_SUM" != "$ACTUAL_SUM" ]]; then
  echo "Node.js checksum mismatch for $NODE_TAR" >&2
  echo "expected: $EXPECTED_SUM" >&2
  echo "actual:   $ACTUAL_SUM" >&2
  exit 1
fi

tar -xzf "$TMPDIR_BUNDLE/$NODE_TAR" -C "$TMPDIR_BUNDLE" "node-v${NODE_VERSION}-${NODE_PLATFORM}/bin/node"
cp "$TMPDIR_BUNDLE/node-v${NODE_VERSION}-${NODE_PLATFORM}/bin/node" "$EMBED_DIR/node"
chmod +x "$EMBED_DIR/node"

BUNDLED_NODE_VERSION="$("$EMBED_DIR/node" -p 'process.versions.node')"
if [[ "$BUNDLED_NODE_VERSION" != "$EXPECTED_NODE_VERSION" ]]; then
  echo "Bundled Node drifted: expected $EXPECTED_NODE_VERSION, got $BUNDLED_NODE_VERSION" >&2
  exit 1
fi

TT_DIR="$EMBED_DIR/tokentracker"
mkdir -p "$TT_DIR/bin"
cp "$REPO_ROOT/bin/tracker.js" "$TT_DIR/bin/"
cp -R "$REPO_ROOT/src" "$TT_DIR/src"
cp "$REPO_ROOT/package.json" "$TT_DIR/"
cp "$REPO_ROOT/package-lock.json" "$TT_DIR/"

if [[ ! -d "$DASHBOARD_DIST" ]]; then
  echo "dashboard/dist not found. Run npm run dashboard:build first." >&2
  exit 1
fi
mkdir -p "$TT_DIR/dashboard"
cp -R "$DASHBOARD_DIST" "$TT_DIR/dashboard/dist"

(
  cd "$TT_DIR"
  npm ci --omit=dev --no-optional --ignore-scripts
)

find "$TT_DIR/node_modules" -type f \( \
  -name "*.map" -o \
  -name "*.ts" -o \
  -name "*.d.ts" -o \
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
  -name ".github" \
\) -exec rm -rf {} + 2>/dev/null || true

# Package-specific trims (unused WASM builds) shared with macOS and Windows.
node "$REPO_ROOT/scripts/trim-embedded-deps.cjs" "$TT_DIR/node_modules"

printf 'Bundled TokenTracker Linux runtime at %s\n' "$EMBED_DIR"
printf 'Node: %s\n' "$("$EMBED_DIR/node" -p 'process.versions.node')"
printf 'Size: %s\n' "$(du -sh "$EMBED_DIR" | cut -f1)"
