#!/usr/bin/env bash
# Postie — Linux installer (Debian/Ubuntu x64)
#
# Usage:
#   ./scripts/install-linux.sh                          # uses dist/postie_*.deb
#   ./scripts/install-linux.sh path/to/postie.deb       # uses a specific deb
#
# What it does:
#   1. Verifies you're on a Debian-family distro
#   2. Installs the .deb via apt (which resolves dependencies automatically)
#   3. Reports the launch command

set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Error: this script is for Linux only." >&2
  exit 1
fi

if ! command -v apt >/dev/null 2>&1 && ! command -v dpkg >/dev/null 2>&1; then
  echo "Error: needs apt or dpkg. The .deb only works on Debian/Ubuntu and derivatives." >&2
  echo "On other distros, extract the .deb and run /opt/Postie/postie manually." >&2
  exit 1
fi

# Locate the .deb
DEB="${1:-}"
if [[ -z "$DEB" ]]; then
  DEB="$(ls -t dist/postie_*_amd64.deb 2>/dev/null | head -n1 || true)"
fi
if [[ -z "$DEB" || ! -f "$DEB" ]]; then
  echo "Error: no .deb found. Pass a path or build first (see setup.md)." >&2
  exit 1
fi

echo "==> Installing from: $DEB"

if command -v apt >/dev/null 2>&1; then
  sudo apt install -y "./$DEB"
else
  sudo dpkg -i "./$DEB" || true
  sudo apt -f install -y || true
fi

echo ""
echo "Done. Launch with:  postie"
echo "Or find Postie in your Applications menu."
