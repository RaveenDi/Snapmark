'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, clipboard, Menu, nativeTheme, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const { detectScreenshotDir, IMAGE_EXT } = require('./detect');

const MAX_LIST = 300;
const MAX_HISTORY = 200;
const MARKED_SUFFIX = /-marked(-\d+)?$/;
// 1x1 grey pixel, used as a drag icon when a thumbnail cannot be made.
const FALLBACK_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mOor6//DwAFgAKA3n0D4QAAAABJRU5ErkJggg==';

let win = null;
let watcher = null;
let watchTimer = null;
let saveTimer = null;
let dirtyCount = 0;
let pendingOpen = null;
let detectPromise = null;
let config = { screenshotDir: null, history: [], bounds: null };

const configPath = () => path.join(app.getPath('userData'), 'config.json');
const tempDir = () => path.join(app.getPath('temp'), 'snapmark-drag');
const isImage = (p) => typeof p === 'string' && IMAGE_EXT.has(path.extname(p).toLowerCase());
const send = (channel, ...args) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
};

// ---------- config ----------

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    config = { ...config, ...parsed };
    if (!Array.isArray(config.history)) config.history = [];
  } catch { /* first run */ }
}

function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fsp.writeFile(configPath(), JSON.stringify(config, null, 2)).catch(() => {});
  }, 150);
}

function saveConfigNow() {
  clearTimeout(saveTimer);
  try {
    fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
  } catch { /* ignore */ }
}

/** Remember a file we opened from outside the folder, or one we saved (edited). */
function remember(file, edited) {
  const p = path.normalize(file);
  const prev = config.history.find((h) => h.path === p);
  config.history = config.history.filter((h) => h.path !== p);
  config.history.unshift({ path: p, edited: !!edited || !!(prev && prev.edited) });
  config.history.length = Math.min(config.history.length, MAX_HISTORY);
  saveConfig();
}

// ---------- screenshot folder ----------

function watchDir() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (!config.screenshotDir) return;
  try {
    watcher = fs.watch(config.screenshotDir, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => send('images:changed'), 250);
    });
    watcher.on('error', () => {});
  } catch { /* folder vanished; the list will simply be empty */ }
}

function setScreenshotDir(dir) {
  config.screenshotDir = dir ? path.normalize(dir) : null;
  saveConfig();
  watchDir();
}

async function resolveScreenshotDir() {
  if (config.screenshotDir && fs.existsSync(config.screenshotDir)) {
    return { dir: config.screenshotDir, detected: false };
  }
  let pictures = null;
  try {
    pictures = app.getPath('pictures');
  } catch { /* ignore */ }
  const dir = await detectScreenshotDir(pictures);
  if (dir) setScreenshotDir(dir);
  return { dir, detected: !!dir };
}

async function statImages(dir) {
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  await Promise.all(
    names.filter(isImage).map(async (name) => {
      const p = path.join(dir, name);
      try {
        const st = await fsp.stat(p);
        if (st.isFile() && st.size > 0) out.push({ path: p, name, mtime: st.mtimeMs, size: st.size });
      } catch { /* ignore */ }
    })
  );
  return out;
}

async function listImages() {
  const map = new Map();
  if (config.screenshotDir) {
    for (const item of await statImages(config.screenshotDir)) map.set(item.path, item);
  }
  // Images worked on in the past that live outside the screenshot folder.
  const gone = new Set();
  await Promise.all(
    config.history.map(async (h) => {
      if (map.has(h.path)) return;
      try {
        const st = await fsp.stat(h.path);
        map.set(h.path, { path: h.path, name: path.basename(h.path), mtime: st.mtimeMs, size: st.size });
      } catch {
        gone.add(h.path);
      }
    })
  );
  if (gone.size) {
    config.history = config.history.filter((h) => !gone.has(h.path));
    saveConfig();
  }
  const edited = new Set(config.history.filter((h) => h.edited).map((h) => h.path));
  return [...map.values()]
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_LIST)
    .map((item) => ({ ...item, edited: edited.has(item.path) }));
}

// ---------- images ----------

async function thumbDataUrl(file) {
  if (process.platform !== 'linux') {
    try {
      const img = await nativeImage.createThumbnailFromPath(file, { width: 320, height: 320 });
      if (!img.isEmpty()) return img.toDataURL();
    } catch { /* fall through */ }
  }
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) return null;
  const { width } = img.getSize();
  const small = width > 320 ? img.resize({ width: 320, quality: 'good' }) : img;
  return 'data:image/jpeg;base64,' + small.toJPEG(82).toString('base64');
}

function dragIcon(file) {
  try {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) {
      const { width, height } = img.getSize();
      return width >= height ? img.resize({ width: 128 }) : img.resize({ height: 128 });
    }
  } catch { /* fall through */ }
  return nativeImage.createFromDataURL(FALLBACK_ICON);
}

function uniquePath(dir, stem, ext = '.png') {
  let candidate = path.join(dir, stem + ext);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem}-${i}${ext}`);
  return candidate;
}

function stamp() {
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

function outputDir() {
  return config.screenshotDir && fs.existsSync(config.screenshotDir) ? config.screenshotDir : app.getPath('pictures');
}

function markedStem(sourcePath) {
  if (!sourcePath) return `Snapmark ${stamp()}`;
  return path.basename(sourcePath, path.extname(sourcePath)).replace(MARKED_SUFFIX, '') + '-marked';
}

const safeName = (name) => String(name || 'image.png').replace(/[\\/:*?"<>|]/g, '_');

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('app:init', async () => {
    const { dir, detected } = await detectPromise;
    return { dir: config.screenshotDir || dir, detected, platform: process.platform };
  });

  ipcMain.handle('dir:choose', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose the folder where your screenshots are saved',
      defaultPath: config.screenshotDir || app.getPath('pictures'),
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    setScreenshotDir(res.filePaths[0]);
    return config.screenshotDir;
  });

  ipcMain.handle('images:list', () => listImages());

  ipcMain.handle('image:read', async (_e, file) => {
    if (!isImage(file)) throw new Error('Not an image file');
    return fsp.readFile(file);
  });

  ipcMain.handle('thumb:get', async (_e, file) => {
    if (!isImage(file)) return null;
    try {
      return await thumbDataUrl(file);
    } catch {
      return null;
    }
  });

  ipcMain.handle('image:remember', (_e, file) => {
    if (isImage(file) && fs.existsSync(file)) remember(file, false);
  });

  ipcMain.handle('image:open', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Open image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: [...IMAGE_EXT].map((e) => e.slice(1)) }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    remember(res.filePaths[0], false);
    return path.normalize(res.filePaths[0]);
  });

  // Ctrl/Cmd+S: always writes a NEW file next to the original, never overwrites.
  ipcMain.handle('image:save', async (_e, { sourcePath, data }) => {
    const buffer = Buffer.from(data);
    const stem = markedStem(sourcePath);
    const dirs = [sourcePath ? path.dirname(sourcePath) : outputDir(), outputDir(), app.getPath('pictures')];
    let lastError = null;
    for (const dir of [...new Set(dirs)]) {
      const target = uniquePath(dir, stem);
      try {
        remember(target, true);
        await fsp.writeFile(target, buffer);
        return { path: target, name: path.basename(target) };
      } catch (err) {
        config.history = config.history.filter((h) => h.path !== target);
        lastError = err;
      }
    }
    throw lastError || new Error('Could not save');
  });

  ipcMain.handle('image:saveAs', async (_e, { sourcePath, data }) => {
    const res = await dialog.showSaveDialog(win, {
      title: 'Save image as',
      defaultPath: path.join(sourcePath ? path.dirname(sourcePath) : outputDir(), markedStem(sourcePath) + '.png'),
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    if (res.canceled || !res.filePath) return null;
    remember(res.filePath, true);
    await fsp.writeFile(res.filePath, Buffer.from(data));
    return { path: res.filePath, name: path.basename(res.filePath) };
  });

  // An image pasted from the clipboard becomes a real file so it shows in the sidebar.
  ipcMain.handle('image:import', async (_e, { data, ext }) => {
    const extension = IMAGE_EXT.has(ext) ? ext : '.png';
    const target = uniquePath(outputDir(), `Snapmark ${stamp()}`, extension);
    remember(target, false);
    await fsp.writeFile(target, Buffer.from(data));
    return { path: target, name: path.basename(target) };
  });

  ipcMain.handle('temp:write', async (_e, { name, data }) => {
    await fsp.mkdir(tempDir(), { recursive: true });
    const target = path.join(tempDir(), safeName(name));
    await fsp.writeFile(target, Buffer.from(data));
    return target;
  });

  ipcMain.on('temp:writeSync', (e, { name, dataUrl }) => {
    try {
      fs.mkdirSync(tempDir(), { recursive: true });
      const target = path.join(tempDir(), safeName(name));
      fs.writeFileSync(target, Buffer.from(String(dataUrl).split(',')[1] || '', 'base64'));
      e.returnValue = target;
    } catch {
      e.returnValue = null;
    }
  });

  ipcMain.on('drag:start', (e, file) => {
    if (typeof file !== 'string' || !fs.existsSync(file)) return;
    try {
      e.sender.startDrag({ file, icon: dragIcon(file) });
    } catch (err) {
      console.error('startDrag failed:', err);
    }
  });

  ipcMain.handle('clipboard:writeImage', (_e, data) => {
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(data)));
    return true;
  });

  ipcMain.on('shell:reveal', (_e, file) => {
    if (typeof file === 'string' && fs.existsSync(file)) shell.showItemInFolder(file);
  });

  ipcMain.on('shell:openDir', () => {
    if (config.screenshotDir) shell.openPath(config.screenshotDir);
  });

  ipcMain.on('app:dirty', (_e, count) => {
    dirtyCount = Number(count) || 0;
  });
}

// ---------- window ----------

function buildMenu() {
  if (process.platform !== 'darwin') {
    // Keyboard shortcuts are handled in the page; no menu bar keeps startup fast.
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'Edit',
        submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
      },
      { role: 'windowMenu' },
    ])
  );
}

/** Saved window position, unless that spot is no longer on any screen (monitor unplugged). */
function usableBounds(b) {
  if (!b) return {};
  if (typeof b.x !== 'number' || typeof b.y !== 'number') return { width: b.width, height: b.height, maximized: b.maximized };
  if (process.env.SNAPMARK_ALLOW_OFFSCREEN) return b;
  const width = b.width || 1320;
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) => {
    return b.x + width > a.x + 80 && b.x < a.x + a.width - 80 && b.y > a.y - 20 && b.y < a.y + a.height - 80;
  });
  return onScreen ? b : { width: b.width, height: b.height, maximized: b.maximized };
}

function createWindow() {
  const bounds = usableBounds(config.bounds);
  win = new BrowserWindow({
    width: bounds.width || 1320,
    height: bounds.height || 840,
    x: bounds.x,
    y: bounds.y,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Snapmark',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16171a' : '#f3f3f5',
    icon: process.platform === 'linux' ? path.join(__dirname, '../../build/icon.png') : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (bounds.maximized) win.maximize();

  win.once('ready-to-show', () => win.show());
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    });
  }

  win.on('close', (e) => {
    if (dirtyCount > 0 && !process.env.SNAPMARK_NO_CONFIRM) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question',
        buttons: ['Close without saving', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: dirtyCount === 1 ? '1 image has unsaved drawings.' : `${dirtyCount} images have unsaved drawings.`,
        detail: 'Press Ctrl+S (Cmd+S on Mac) on an image to save it as a new file.',
      });
      if (choice === 1) {
        e.preventDefault();
        return;
      }
    }
    config.bounds = { ...win.getNormalBounds(), maximized: win.isMaximized() };
    saveConfigNow();
  });
  win.on('closed', () => {
    win = null;
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

function fileFromArgv(argv) {
  return argv.slice(1).find((a) => !a.startsWith('-') && isImage(a) && fs.existsSync(a)) || null;
}

function openExternalFile(file) {
  const p = path.resolve(file);
  remember(p, false);
  if (win && !win.isDestroyed() && !win.webContents.isLoading()) send('file:open', p);
  else pendingOpen = p;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const file = fileFromArgv(argv);
    if (file) openExternalFile(file);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('open-file', (e, file) => {
    e.preventDefault();
    if (isImage(file)) openExternalFile(file);
  });

  app.whenReady().then(() => {
    loadConfig();
    detectPromise = resolveScreenshotDir().then((res) => {
      watchDir();
      return res;
    });
    registerIpc();
    buildMenu();

    const file = fileFromArgv(process.argv);
    if (file) {
      pendingOpen = path.resolve(file);
      remember(pendingOpen, false);
    }
    ipcMain.handle('app:pendingOpen', () => {
      const p = pendingOpen;
      pendingOpen = null;
      return p;
    });

    createWindow();
    fsp.rm(tempDir(), { recursive: true, force: true }).catch(() => {});

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (watcher) watcher.close();
    app.quit();
  });
}
