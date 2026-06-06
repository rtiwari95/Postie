const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

// Force the app name to "Postie" so the Dock tooltip and About menu don't say
// "Electron" when running unpackaged. Must run before app.whenReady().
app.setName('Postie');
process.title = 'Postie';

let backendProc = null;
let backendPort = null;
let backendReady = null;

function resolveBackendPath() {
  const exe = process.platform === 'win32' ? 'postie-backend.exe' : 'postie-backend';
  const candidates = [
    path.join(process.resourcesPath || '', exe),
    path.join(__dirname, '..', 'backend', 'target', 'release', exe),
    path.join(__dirname, '..', 'backend', 'target', 'debug', exe),
  ];
  return candidates.find((p) => p && fs.existsSync(p));
}

function startBackend() {
  const bin = resolveBackendPath();
  if (!bin) {
    return Promise.reject(
      new Error('postie-backend binary not found. Run `npm run build:backend` first.')
    );
  }

  backendProc = spawn(bin, [], { env: { ...process.env, POSTIE_PORT: '0' } });

  backendReady = new Promise((resolve, reject) => {
    let buffer = '';
    backendProc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const m = buffer.match(/POSTIE_BACKEND_READY (\d+)/);
      if (m) {
        backendPort = parseInt(m[1], 10);
        resolve(backendPort);
      }
    });
    backendProc.stderr.on('data', (chunk) => {
      process.stderr.write(`[backend] ${chunk}`);
    });
    backendProc.on('exit', (code) => {
      if (backendPort === null) reject(new Error(`backend exited (${code}) before ready`));
    });
  });

  return backendReady;
}

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'Postie',
    backgroundColor: '#1e1f22',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Override the dock icon at runtime on macOS — `BrowserWindow.icon` is
  // ignored on macOS, so we set the Dock image explicitly.
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(iconPath); } catch {}
  }

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

ipcMain.handle('postie:port', () => backendPort);

ipcMain.handle('postie:save-file', async (_e, { defaultName, content }) => {
  const res = await dialog.showSaveDialog({
    defaultPath: defaultName || 'response.txt',
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, content);
  return res.filePath;
});

ipcMain.handle('postie:open-file', async (_e, opts) => {
  const res = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: opts?.filters || [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const filePath = res.filePaths[0];
  const content = fs.readFileSync(filePath, 'utf8');
  return { path: filePath, content };
});

// Returns a path only — used when the backend will read the file (uploads).
// Also returns size so the UI can warn about huge files.
ipcMain.handle('postie:pick-file-path', async (_e, opts) => {
  const res = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: opts?.filters,
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const filePath = res.filePaths[0];
  let size = 0;
  try { size = fs.statSync(filePath).size; } catch {}
  return { path: filePath, name: path.basename(filePath), size };
});

app.whenReady().then(async () => {
  try {
    await startBackend();
  } catch (e) {
    dialog.showErrorBox('Postie backend failed to start', String(e.message || e));
    app.quit();
    return;
  }

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ])
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (backendProc && !backendProc.killed) backendProc.kill();
});
