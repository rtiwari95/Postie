#!/usr/bin/env bash
# Build a working amd64 .deb for Postie from macOS.
#
# electron-builder's bundled fpm produces a malformed 96-byte .deb on macOS,
# so we use it for staging only and re-package with dpkg-deb (Homebrew).
#
# Prereqs:
#   brew install dpkg cargo-zigbuild
#   cargo zigbuild --release --target x86_64-unknown-linux-musl  (in backend/)
#   node_modules/.bin/electron-builder --linux deb --x64        (produces dist/linux-unpacked/)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION=$(node -p "require('./package.json').version")
PKG=postie
ARCH=amd64
STAGE="dist/deb-stage"
OUT="dist/${PKG}_${VERSION}_${ARCH}.deb"

UNPACKED="dist/linux-unpacked"
[ -d "$UNPACKED" ] || { echo "$UNPACKED missing — run electron-builder --linux deb --x64 first"; exit 1; }

rm -rf "$STAGE"
mkdir -p "$STAGE/opt/Postie" "$STAGE/usr/bin" "$STAGE/usr/share/applications" "$STAGE/DEBIAN"

# Copy the unpacked tree
cp -R "$UNPACKED/." "$STAGE/opt/Postie/"

# Symlink so users can run `postie`
ln -sf /opt/Postie/postie "$STAGE/usr/bin/postie"

# Icons (hicolor theme — sizes that GNOME, KDE, etc. look up)
for SIZE in 16 32 48 64 128 256 512; do
  D="$STAGE/usr/share/icons/hicolor/${SIZE}x${SIZE}/apps"
  mkdir -p "$D"
  /usr/bin/sips -s format png -z "$SIZE" "$SIZE" assets/icon.png \
    --out "$D/postie.png" >/dev/null
done

# .desktop entry
cat > "$STAGE/usr/share/applications/postie.desktop" <<'EOF'
[Desktop Entry]
Name=Postie
Comment=A Postman-like API client
Exec=/opt/Postie/postie %U
Terminal=false
Type=Application
Icon=postie
StartupWMClass=Postie
Categories=Development;
EOF

# Compute installed size in KB (sum of opt + usr trees, excludes DEBIAN dir)
INSTALLED_SIZE=$(du -sk "$STAGE/opt" "$STAGE/usr" | awk '{s+=$1} END{print s}')

cat > "$STAGE/DEBIAN/control" <<EOF
Package: ${PKG}
Version: ${VERSION}
Section: devel
Priority: optional
Architecture: ${ARCH}
Installed-Size: ${INSTALLED_SIZE}
Maintainer: Postie <postie@local>
Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, xdg-utils, libatspi2.0-0, libdrm2, libgbm1, libasound2 | libasound2t64
Homepage: https://github.com/postie/postie
Description: Postman-like API client
 Postie is a fast, local-first Postman-like API client built with Electron
 and Rust.
EOF

# postinst — set chrome-sandbox SUID bit (required for Electron renderer sandbox on Linux)
cat > "$STAGE/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if [ -e /opt/Postie/chrome-sandbox ]; then
  chown root:root /opt/Postie/chrome-sandbox
  chmod 4755 /opt/Postie/chrome-sandbox
fi
update-desktop-database -q || true
gtk-update-icon-cache -q -t /usr/share/icons/hicolor || true
exit 0
EOF
chmod 755 "$STAGE/DEBIAN/postinst"

cat > "$STAGE/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
update-desktop-database -q || true
gtk-update-icon-cache -q -t /usr/share/icons/hicolor || true
exit 0
EOF
chmod 755 "$STAGE/DEBIAN/postrm"

rm -f "$OUT"
/opt/homebrew/bin/dpkg-deb --build --root-owner-group -Zxz "$STAGE" "$OUT"
echo
echo "Built: $OUT ($(ls -lh "$OUT" | awk '{print $5}'))"
/opt/homebrew/bin/dpkg-deb --info "$OUT" | head -20
