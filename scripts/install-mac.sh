#!/usr/bin/env bash
# Postie — macOS installer (Apple Silicon)
#
# Usage:
#   ./scripts/install-mac.sh                        # uses dist/Postie-*.dmg
#   ./scripts/install-mac.sh path/to/Postie.dmg     # uses a specific dmg
#
# What it does:
#   1. Mounts the DMG
#   2. Copies Postie.app into /Applications (replacing any prior copy)
#   3. Strips the macOS quarantine flag so Gatekeeper doesn't block launch
#   4. Unmounts and launches Postie

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: this script is for macOS only. On Linux use install-linux.sh." >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Error: Postie ships only for Apple Silicon (arm64). Detected: $(uname -m)." >&2
  exit 1
fi

# Locate the DMG
DMG="${1:-}"
if [[ -z "$DMG" ]]; then
  DMG="$(ls -t dist/Postie-*.dmg 2>/dev/null | head -n1 || true)"
fi
if [[ -z "$DMG" || ! -f "$DMG" ]]; then
  echo "Error: no .dmg found. Pass a path or build first (see setup.md)." >&2
  exit 1
fi

echo "==> Installing from: $DMG"

# If a prior install exists, macOS caches its signature. Remove it before copying.
if [[ -d "/Applications/Postie.app" ]]; then
  echo "==> Removing existing /Applications/Postie.app"
  rm -rf "/Applications/Postie.app"
fi

# Mount, copy, eject
MOUNT_DIR="$(mktemp -d -t postie-mount)"
echo "==> Mounting"
hdiutil attach "$DMG" -mountpoint "$MOUNT_DIR" -nobrowse -quiet

trap 'hdiutil detach "$MOUNT_DIR" -quiet || true; rmdir "$MOUNT_DIR" 2>/dev/null || true' EXIT

APP_SRC="$MOUNT_DIR/Postie.app"
if [[ ! -d "$APP_SRC" ]]; then
  echo "Error: Postie.app not found inside the DMG." >&2
  exit 1
fi

echo "==> Copying to /Applications"
cp -R "$APP_SRC" /Applications/

# Bypass Gatekeeper for an unsigned/ad-hoc-signed app
echo "==> Removing quarantine attribute"
xattr -cr /Applications/Postie.app || true

echo "==> Launching Postie"
open /Applications/Postie.app

echo ""
echo "Done. Postie is in /Applications and ready to use."
