// TimeAlign desktop app (Electron): the measurement page in a native Mac window with
// Chromium's audio engine, so every Dante Virtual Soundcard / USB channel is addressable.
const { app, BrowserWindow, session, systemPreferences, shell } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const ALLOW = new Set(['media', 'speaker-selection', 'clipboard-sanitized-write', 'clipboard-read', 'wake-lock']);

async function createWindow() {
  if (process.platform === 'darwin') {
    try { await systemPreferences.askForMediaAccess('microphone'); } catch (e) { /* user can allow later in System Settings */ }
  }
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOW.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOW.has(permission));
  const win = new BrowserWindow({
    width: 1440, height: 960, minWidth: 900, minHeight: 600, title: 'TimeAlign', backgroundColor: '#0e1116',
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
