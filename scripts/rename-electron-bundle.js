// Rewrites node_modules/electron/dist/Electron.app/Contents/Info.plist so the
// Dock tooltip and About dialog say "Postie" instead of "Electron" when running
// unpackaged. Packaged builds get the right name from electron-builder's
// productName, so this only matters in dev. macOS only.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

if (process.platform !== 'darwin') process.exit(0);

const plist = path.join(
  __dirname, '..',
  'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Info.plist'
);
if (!fs.existsSync(plist)) {
  console.log('[rename-electron-bundle] Info.plist not found, skipping.');
  process.exit(0);
}

const set = (key, value) => {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist]);
  }
};

set('CFBundleName', 'Postie');
set('CFBundleDisplayName', 'Postie');
console.log('[rename-electron-bundle] Patched Electron.app -> Postie');
