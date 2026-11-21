'use strict';
// Finds the folder where the OS drops screenshots, without asking the user.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);

function run(cmd, args) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 3000, windowsHide: true }, (err, stdout) => {
        resolve(err ? '' : String(stdout));
      });
    } catch {
      resolve('');
    }
  });
}

function expandWinEnv(value) {
  return value.replace(/%([^%]+)%/g, (whole, name) => process.env[name] || whole);
}

async function candidates(picturesDir) {
  const home = os.homedir();
  const list = [];

  if (process.platform === 'win32') {
    // The "Screenshots" known folder (Win+PrtScn and the Snipping Tool autosave).
    const out = await run('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders',
      '/v',
      '{B7BEDE81-DF94-4682-A7D8-57A52620B86F}',
    ]);
    const match = out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
    if (match) list.push(expandWinEnv(match[1].trim()));
    if (picturesDir) list.push(path.join(picturesDir, 'Screenshots'));
    for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
      if (process.env[key]) list.push(path.join(process.env[key], 'Pictures', 'Screenshots'));
    }
    list.push(path.join(home, 'Pictures', 'Screenshots'));
  } else if (process.platform === 'darwin') {
    const out = (await run('defaults', ['read', 'com.apple.screencapture', 'location'])).trim();
    if (out) list.push(out.replace(/^~/, home));
    list.push(path.join(home, 'Desktop'));
  } else {
    const xdg = (await run('xdg-user-dir', ['PICTURES'])).trim();
    if (xdg) list.push(path.join(xdg, 'Screenshots'));
    list.push(path.join(home, 'Pictures', 'Screenshots'));
    list.push(path.join(home, 'Pictures', 'screenshots'));
    if (xdg) list.push(xdg);
    list.push(path.join(home, 'Pictures'));
  }

  const seen = new Set();
  return list
    .map((p) => path.normalize(p))
    .filter((p) => {
      const key = process.platform === 'win32' ? p.toLowerCase() : p;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function newestImageTime(dir) {
  let newest = 0;
  try {
    const names = await fsp.readdir(dir);
    await Promise.all(
      names
        .filter((n) => IMAGE_EXT.has(path.extname(n).toLowerCase()))
        .slice(0, 2000)
        .map(async (n) => {
          try {
            const st = await fsp.stat(path.join(dir, n));
            if (st.mtimeMs > newest) newest = st.mtimeMs;
          } catch { /* ignore */ }
        })
    );
  } catch { /* ignore */ }
  return newest;
}

async function isDir(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * @param {string} [picturesDir] the OS "Pictures" folder, if known
 * @returns {Promise<string|null>} the screenshot folder, or null if none could be found
 */
async function detectScreenshotDir(picturesDir) {
  const existing = [];
  for (const dir of await candidates(picturesDir)) {
    if (await isDir(dir)) existing.push(dir);
  }
  if (!existing.length) return null;
  if (process.platform !== 'win32') return existing[0];

  // Windows can have several "Screenshots" folders (local and OneDrive).
  // Prefer the one that is actually receiving screenshots.
  let best = existing[0];
  let bestTime = 0;
  for (const dir of existing) {
    const t = await newestImageTime(dir);
    if (t > bestTime) {
      best = dir;
      bestTime = t;
    }
  }
  return best;
}

module.exports = { detectScreenshotDir, IMAGE_EXT };
