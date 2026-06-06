# Postie — Setup & Install Guide

Postie 1.1.0 ships as native installers for macOS (Apple Silicon), Linux (Debian/Ubuntu x64), and Windows (x64).

All builds live in `dist/` after running the build commands at the bottom of this doc.

---

## One-line install (recommended)

The fastest way to get going on each platform — handles Gatekeeper / SmartScreen / quarantine flags for you. Run from the project root **after** `dist/` has the artifacts (or pass an explicit path to a downloaded installer).

| Platform | Command |
|---|---|
| **macOS (Apple Silicon)** | `./scripts/install-mac.sh` |
| **Linux (Debian/Ubuntu x64)** | `./scripts/install-linux.sh` |
| **Windows (x64)** | `powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1` |

Each script accepts an optional installer path:
```bash
./scripts/install-mac.sh ~/Downloads/Postie-1.1.0-arm64.dmg
./scripts/install-linux.sh ~/Downloads/postie_1.1.0_amd64.deb
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Installer "C:\Users\me\Downloads\Postie Setup 1.1.0.exe"
```

What each script does:
- **mac:** mounts the DMG, copies into `/Applications`, runs `xattr -cr` to clear quarantine, launches.
- **linux:** runs `sudo apt install ./postie_*.deb` so dependencies resolve cleanly.
- **windows:** `Unblock-File` strips mark-of-the-web, then runs the NSIS installer interactively.

If you'd rather do it manually (or are on a distro/architecture not covered above), see the per-platform sections below.

---

## Artifacts

| Platform | File | Size | Format |
|---|---|---|---|
| macOS (Apple Silicon) | `Postie-1.1.0-arm64.dmg` | 94 MB | Disk image, ad-hoc signed |
| Linux x64 | `postie_1.1.0_amd64.deb` | 76 MB | Debian package |
| Windows x64 | `Postie Setup 1.1.0.exe` | 77 MB | NSIS installer |
| Windows x64 | `Postie-1.1.0-portable.exe` | 77 MB | Single-file portable |

---

## Install — macOS (Apple Silicon)

1. Mount `Postie-1.1.0-arm64.dmg` and drag **Postie.app** into **Applications**.
2. First launch: macOS will say *"Apple could not verify Postie is free of malware..."* — this is Gatekeeper blocking unsigned/un-notarized apps. Two ways to bypass:

   **Option A (fastest — Terminal):**
   ```bash
   xattr -cr /Applications/Postie.app
   ```
   Then double-click Postie. Done.

   **Option B (no Terminal):**
   1. Try to open Postie — let the warning appear, click **Done**.
   2. Open **System Settings → Privacy & Security**.
   3. Scroll down to *"Postie was blocked to protect your Mac"* and click **Open Anyway** → confirm with password.

   > The old "right-click → Open" trick was removed in macOS Sequoia (15.0+). Use one of the two methods above.

3. If you had a previous version, **delete it first** before copying the new one — macOS caches the old signature and will refuse the new build otherwise.

> The DMG is ad-hoc signed (self-issued). It is not notarized, so SmartScreen-style warnings on first launch are expected.

---

## Install — Ubuntu / Debian (x64)

```bash
# Recommended — apt resolves dependencies automatically
sudo apt install ./postie_1.1.0_amd64.deb

# Alternate if apt is unavailable
sudo dpkg -i ./postie_1.1.0_amd64.deb
sudo apt -f install   # pulls any missing libs
```

Run from anywhere with `postie`, or launch from the Applications menu (a `.desktop` entry is installed).

The installer:
- Installs to `/opt/Postie/`
- Creates a symlink at `/usr/bin/postie`
- Drops icons under `/usr/share/icons/hicolor/*/apps/postie.png`
- Sets the SUID bit on `chrome-sandbox` (required for Electron's renderer sandbox)

**Uninstall:** `sudo apt remove postie`.

---

## Install — Windows (x64)

You have two options — both are unsigned, so Windows Defender SmartScreen will warn on first launch.

### Option A — Installer (recommended)

1. Double-click `Postie Setup 1.1.0.exe`.
2. SmartScreen pops up: *"Windows protected your PC."*
   - Click **More info** → **Run anyway**.
3. Choose install location (default: `%LocalAppData%\Programs\Postie`).
4. Setup adds **Start Menu** and **Desktop** shortcuts.

**Uninstall:** Settings → Apps → Postie → Uninstall, or use the entry in *Add or Remove Programs*.

### Option B — Portable

1. Double-click `Postie-1.1.0-portable.exe`.
2. Same SmartScreen warning → **More info** → **Run anyway**.
3. The .exe self-extracts to a temp folder and launches Postie. No install, no shortcuts, no admin rights needed.

### Notes
- **Antivirus:** unsigned Electron apps can occasionally get flagged. If the .exe gets quarantined, whitelist it or use the installer with admin rights.
- **Architecture:** x64 only. ARM Windows is not built.

---

## Build from source (maintainer reference)

Postie is an Electron app with a Rust HTTP backend that runs as a sidecar. Each platform needs the backend cross-compiled, then electron-builder bundles it.

### Prerequisites (one-time, on macOS dev machine)

```bash
# Rust + targets
brew install rustup-init
rustup-init -y
rustup target add x86_64-unknown-linux-musl x86_64-pc-windows-gnu

# Cross-compilers (zigbuild handles both Linux and Windows-gnu)
brew install cargo-zigbuild

# .deb packaging tool (Homebrew dpkg)
brew install dpkg

# Node deps
npm install
```

### macOS DMG (Apple Silicon)

```bash
# 1. Backend
cd backend && cargo build --release && cd ..

# 2. Renderer bundle
node_modules/.bin/esbuild renderer/js/editor-entry.js --bundle --format=esm \
  --outfile=renderer/js/editor.bundle.js --target=es2022

# 3. Build, ad-hoc sign, repackage
rm -rf dist
CSC_IDENTITY_AUTO_DISCOVERY=false node_modules/.bin/electron-builder --mac dmg --arm64
codesign --force --deep --sign - "dist/mac-arm64/Postie.app"
rm -f dist/Postie-*.dmg dist/Postie-*.dmg.blockmap
node_modules/.bin/electron-builder --mac dmg --arm64 --prepackaged dist/mac-arm64/Postie.app
```

> The ad-hoc signing step is mandatory. macOS on Apple Silicon refuses to launch unsigned arm64 binaries; without re-signing you'll see *"Postie can't be opened."*

### Linux .deb (x64)

```bash
# 1. Cross-compile backend (musl, fully static — no glibc dependency)
cd backend
cargo zigbuild --release --target x86_64-unknown-linux-musl
cd ..

# 2. Stage with electron-builder (its .deb output is broken on macOS, ignore it)
node_modules/.bin/electron-builder --linux deb --x64

# 3. Repackage with dpkg-deb (Homebrew)
./scripts/build-deb.sh
```

> `electron-builder`'s bundled fpm produces a malformed 96-byte `.deb` on macOS because BSD `ar` doesn't write the Debian archive format correctly. `scripts/build-deb.sh` re-stages and runs `dpkg-deb` directly to produce a valid ~76 MB package.

### Windows .exe (x64)

```bash
# 1. Cross-compile backend for Windows
cd backend
cargo zigbuild --release --target x86_64-pc-windows-gnu
cd ..

# 2. Build NSIS installer + portable .exe (electron-builder uses bundled Wine)
node_modules/.bin/electron-builder --win nsis portable --x64
```

Output:
- `dist/Postie Setup 1.1.0.exe` — NSIS installer
- `dist/Postie-1.1.0-portable.exe` — single-file portable

> First Windows build downloads Wine, winCodeSign, and the NSIS toolchain (~140 MB total). They're cached at `~/Library/Caches/electron-builder/` for subsequent builds.

---

## Version bump checklist

Bump in two places — both must match:

1. `package.json` — `version`
2. `backend/Cargo.toml` — `version`

After bumping, rerun the build steps above. Artifact filenames pick up the new version automatically.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| macOS: *"Postie can't be opened"* | Right-click → Open, or `xattr -cr /Applications/Postie.app`. Delete prior copies first. |
| macOS: *"code has no resources"* during `codesign --verify` | The DMG was packaged before signing — re-run the sign + repackage steps. |
| Linux: 96-byte `.deb` from electron-builder | Expected. Use `scripts/build-deb.sh` instead. |
| Linux: launches but renderer is blank | `chrome-sandbox` SUID bit not set. The postinst script handles this; verify with `ls -l /opt/Postie/chrome-sandbox` (should show `-rwsr-xr-x`). |
| Windows: SmartScreen blocks the .exe | Click *More info* → *Run anyway*. Builds are unsigned — code-signing certs cost ~$300/yr. |
| Windows: backend fails to start | Confirm `resources/postie-backend.exe` is present in the install dir. If missing, the `extraResources` path in `package.json` is wrong. |
| Dev launch shows *"Electron"* in Dock tooltip | `npm run rename:electron` patches `node_modules/electron/dist/Electron.app/Contents/Info.plist`. Auto-runs on `npm install`. |
