'use strict';
// End-to-end smoke test. Starts the real app against a throwaway screenshot
// folder, drives it with real mouse and keyboard input, and checks the results.
// Run with: npm run smoke   (set SMOKE_OUT=<dir> to keep the window captures)

const { app, BrowserWindow, nativeImage, nativeTheme } = require('electron');
if (process.env.SMOKE_THEME) nativeTheme.themeSource = process.env.SMOKE_THEME; // 'light' or 'dark'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapmark-smoke-'));
const shots = path.join(root, 'Screenshots');
const userData = path.join(root, 'userData');
const outDir = process.env.SMOKE_OUT || root;
fs.mkdirSync(shots);
fs.mkdirSync(userData);
fs.mkdirSync(outDir, { recursive: true });
app.setPath('userData', userData);
// keep drawing while the window is off-screen
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
process.env.SNAPMARK_NO_CONFIRM = '1';
process.env.SNAPMARK_ALLOW_OFFSCREEN = '1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

function makeShot(file, w, h, seed) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const bar = y < 60;
      const card = x > 80 && x < w - 80 && y > 120 && y < h - 80;
      const v = bar ? 60 + seed : card ? 250 : 228;
      buf[i] = bar ? 90 : v; // B
      buf[i + 1] = bar ? 60 : v - (card && (x + y) % 97 < 2 ? 40 : 0); // G
      buf[i + 2] = v; // R
      buf[i + 3] = 255;
    }
  }
  fs.writeFileSync(file, nativeImage.createFromBitmap(buf, { width: w, height: h }).toPNG());
}

app.whenReady().then(() => {
  makeShot(path.join(shots, 'older.png'), 800, 500, 40);
  makeShot(path.join(shots, 'Screenshot 1.png'), 1200, 750, 0);
  fs.utimesSync(path.join(shots, 'older.png'), new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  // The window is placed off-screen so the real mouse cannot interfere with the simulated one.
  const bounds = process.env.SMOKE_VISIBLE ? null : { x: -6000, y: -6000, width: 1320, height: 840 };
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ screenshotDir: shots, history: [], bounds }));
});

require('../src/main/main.js');

app.whenReady().then(async () => {
  try {
    await run();
  } catch (err) {
    check('smoke run completed', false, String(err && err.stack ? err.stack : err));
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed. Output: ${outDir}`);
  fs.writeFileSync(path.join(outDir, 'smoke-results.json'), JSON.stringify(results, null, 2));
  app.exit(failed ? 1 : 0);
});

async function run() {
  const { detectScreenshotDir } = require('../src/main/detect.js');
  const detected = await detectScreenshotDir(app.getPath('pictures'));
  check('screenshot folder auto-detected on this machine', !!detected, String(detected));

  let win = null;
  for (let i = 0; i < 100 && !win; i++) {
    win = BrowserWindow.getAllWindows()[0];
    if (!win) await sleep(50);
  }
  const wc = win.webContents;
  if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r));
  wc.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 3) console.log('[page error]', e.message);
  });
  if (process.env.SMOKE_VISIBLE) win.setBounds({ width: 1320, height: 840 });
  win.show();
  win.focus();

  const js = (code) => wc.executeJavaScript(code, true);
  const until = async (code, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await js(code)) return true;
      await sleep(60);
    }
    return false;
  };
  const capture = async (name) => {
    await sleep(150);
    fs.writeFileSync(path.join(outDir, name), (await wc.capturePage()).toPNG());
  };

  const mouse = (type, x, y, extra = {}) => wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra });
  const click = async (x, y) => {
    mouse('mouseMove', x, y);
    mouse('mouseDown', x, y);
    mouse('mouseUp', x, y);
    await sleep(40);
  };
  const dblclick = async (x, y) => {
    mouse('mouseMove', x, y);
    mouse('mouseDown', x, y);
    mouse('mouseUp', x, y);
    mouse('mouseDown', x, y, { clickCount: 2 });
    mouse('mouseUp', x, y, { clickCount: 2 });
    await sleep(80);
  };
  const dragMouse = async (x1, y1, x2, y2) => {
    mouse('mouseMove', x1, y1);
    mouse('mouseDown', x1, y1);
    for (let i = 1; i <= 8; i++) {
      mouse('mouseMove', x1 + ((x2 - x1) * i) / 8, y1 + ((y2 - y1) * i) / 8, { modifiers: ['leftButtonDown'] });
      await sleep(8);
    }
    mouse('mouseUp', x2, y2);
    await sleep(40);
  };
  const key = async (keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (!modifiers.length && keyCode.length === 1) wc.sendInputEvent({ type: 'char', keyCode });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(40);
  };

  // ---- home ----
  check('newest screenshot opens on start', await until(`window.__snapmark.state.doc && window.__snapmark.state.doc.name === 'Screenshot 1.png'`));
  check('sidebar lists the folder', (await js(`document.querySelectorAll('#list .item').length`)) === 2);
  check('thumbnails load', await until(`document.querySelectorAll('#list .thumb img.ready').length === 2`));
  await capture('01-home.png');

  // page coordinates of an image point
  const pt = async (ix, iy) => {
    const p = await js(`(() => { const e = window.__snapmark.editor; const r = e.canvas.getBoundingClientRect(); const s = e.toScreen({x:${ix},y:${iy}}); return [r.left + s.x, r.top + s.y]; })()`);
    return p;
  };
  const shapes = () => js(`JSON.parse(JSON.stringify(window.__snapmark.editor.shapes))`);

  // ---- arrow + label at its end ----
  await key('a');
  let a = await pt(520, 430);
  let b = await pt(300, 250);
  await dragMouse(a[0], a[1], b[0], b[1]);
  let list = await shapes();
  check('arrow drawn by dragging', list.length === 1 && list[0].type === 'arrow', JSON.stringify(list[0] && { x1: list[0].x1 | 0, y1: list[0].y1 | 0, x2: list[0].x2 | 0, y2: list[0].y2 | 0 }));
  const mid = await pt(410, 340);
  await dblclick(mid[0], mid[1]);
  check('double-click on arrow opens label box', await until(`!!document.querySelector('.text-editor')`));
  await wc.insertText('Look here');
  await key('Enter');
  list = await shapes();
  check('arrow label saved', list.length === 1 && list[0].label === 'Look here', JSON.stringify(list.map((s) => s.type)));

  // ---- click-to-click shape, closed by clicking the first point ----
  await key('l');
  const poly = [[700, 200], [950, 220], [980, 420], [720, 400]];
  for (const [x, y] of poly) {
    const p = await pt(x, y);
    await click(p[0], p[1]);
  }
  check('rubber-band line follows the cursor while drawing', await js(`(() => { const e = window.__snapmark.editor; return !!e.draft && e.draft.pts.length === 4 && !!e.hover; })()`));
  await capture('02-drawing-shape.png');
  let first = await pt(700, 200);
  await sleep(400);
  await click(first[0], first[1]);
  list = await shapes();
  check('clicking the first point closes the shape', list.length === 2 && list[1].type === 'poly' && list[1].closed && list[1].pts.length === 4);

  // ---- open line, then closed by dragging one end onto the other ----
  await sleep(450);
  const open = [[150, 520], [330, 560], [330, 680], [150, 680]];
  for (const [x, y] of open) {
    const p = await pt(x, y);
    await click(p[0], p[1]);
  }
  await key('Enter');
  list = await shapes();
  check('Enter finishes an open line', list.length === 3 && list[2].type === 'poly' && !list[2].closed && list[2].pts.length === 4);
  await key('v');
  const end = await pt(150, 680);
  const start = await pt(150, 520);
  const edge = await pt(240, 540);
  await click(edge[0], edge[1]); // select it
  await dragMouse(end[0], end[1], start[0] + 3, start[1] + 3);
  list = await shapes();
  check('dragging one end onto the other closes the shape', list.length === 3 && list[2].closed === true && list[2].pts.length === 3, `closed=${list[2] && list[2].closed} pts=${list[2] && list[2].pts.length}`);

  // ---- double-click to add text ----
  const tp = await pt(620, 560);
  await key('Escape');
  await dblclick(tp[0], tp[1]);
  check('double-click on empty space opens a text box', await until(`!!document.querySelector('.text-editor')`));
  await wc.insertText('Hello from Snapmark');
  await key('Enter');
  list = await shapes();
  check('text added', list.length === 4 && list[3].type === 'text' && list[3].text === 'Hello from Snapmark');

  // ---- rectangle, undo/redo ----
  await key('r');
  a = await pt(900, 520);
  b = await pt(1100, 660);
  await dragMouse(a[0], a[1], b[0], b[1]);
  check('rectangle drawn', (await shapes()).length === 5);
  await key('z', ['control']);
  check('undo removes it', (await shapes()).length === 4);
  await key('y', ['control']);
  check('redo brings it back', (await shapes()).length === 5);

  // ---- zoom ----
  const z0 = await js(`window.__snapmark.editor.zoomPercent`);
  const c = await pt(600, 375);
  wc.sendInputEvent({ type: 'mouseWheel', x: Math.round(c[0]), y: Math.round(c[1]), deltaX: 0, deltaY: 240, canScroll: true });
  await sleep(150);
  const z1 = await js(`window.__snapmark.editor.zoomPercent`);
  check('mouse wheel zooms in', z1 > z0, `${z0}% -> ${z1}%`);
  await capture('03-zoomed.png');
  await key('0', ['control']);
  await sleep(100);
  check('Ctrl+0 fits again', (await js(`window.__snapmark.editor.zoomPercent`)) === z0);
  await key('Escape');
  await capture('04-annotated.png');

  // ---- drag-out copy is prepared without saving ----
  check('unsaved marker shown in sidebar', (await js(`document.querySelectorAll('#list .item.dirty').length`)) === 1);
  const tempReady = await until(`(() => { const s = window.__snapmark.state; return !!s.temp && s.temp.revision === window.__snapmark.editor.revision && s.temp.file; })()`, 3000);
  const tempFile = tempReady ? await js(`window.__snapmark.state.temp.file`) : null;
  check('drag-out copy written before any save', !!tempFile && fs.existsSync(tempFile) && fs.statSync(tempFile).size > 1000, String(tempFile));

  // Dragging the chip must hand that unsaved copy to the OS drag. The OS part
  // (webContents.startDrag) is swapped out here so nothing is really dropped anywhere.
  const { ipcMain } = require('electron');
  let dragged = null;
  ipcMain.removeAllListeners('drag:start');
  ipcMain.on('drag:start', (_e, file) => {
    dragged = file;
  });
  const chip = await js(`(() => { const r = document.querySelector('#drag-chip').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await dragMouse(chip[0], chip[1], chip[0] - 60, chip[1] + 80);
  await sleep(150);
  check('dragging the "Drag out" chip hands over the unsaved image', !!dragged && dragged === tempFile, String(dragged));

  // ---- Ctrl+S saves a NEW image ----
  const before = fs.readFileSync(path.join(shots, 'Screenshot 1.png'));
  await key('s', ['control']);
  const saved = path.join(shots, 'Screenshot 1-marked.png');
  const end2 = Date.now() + 4000;
  while (!fs.existsSync(saved) && Date.now() < end2) await sleep(60);
  check('Ctrl+S writes a new file', fs.existsSync(saved), saved);
  if (fs.existsSync(saved)) {
    await sleep(200);
    const size = nativeImage.createFromPath(saved).getSize();
    check('saved image keeps full resolution', size.width === 1200 && size.height === 750, `${size.width}x${size.height}`);
    check('saved image differs from the original (drawings baked in)', !fs.readFileSync(saved).equals(before));
    fs.copyFileSync(saved, path.join(outDir, '05-saved-output.png'));
  }
  check('original left untouched', fs.readFileSync(path.join(shots, 'Screenshot 1.png')).equals(before));
  check('saved copy appears in the sidebar', await until(`document.querySelectorAll('#list .item').length === 3`));
  check('unsaved marker cleared', await until(`document.querySelectorAll('#list .item.dirty').length === 0`));
  await key('s', ['control']);
  check('saving again makes another new file', await (async () => {
    const end3 = Date.now() + 4000;
    while (Date.now() < end3) {
      if (fs.existsSync(path.join(shots, 'Screenshot 1-marked-2.png'))) return true;
      await sleep(60);
    }
    return false;
  })());

  // ---- paste shortcut reaches the page ----
  await js(`window.__pasted = 0; document.addEventListener('paste', (e) => { window.__pasted++; e.stopImmediatePropagation(); e.preventDefault(); }, true); 0`);
  await key('v', ['control']);
  await sleep(150);
  check('Ctrl+V reaches the page as a paste', (await js(`window.__pasted`)) >= 1);

  // ---- a new screenshot shows up by itself ----
  makeShot(path.join(shots, 'Screenshot 2.png'), 1000, 600, 90);
  check('new screenshot opens automatically', await until(`window.__snapmark.state.doc.name === 'Screenshot 2.png'`, 5000));
  check('sidebar updated live', (await js(`document.querySelectorAll('#list .item').length`)) === 5);

  // ---- drawings survive switching images ----
  await js(`document.querySelector('#list .item[data-path$="Screenshot 1.png"]').click(); 0`);
  await until(`window.__snapmark.state.doc.name === 'Screenshot 1.png'`);
  check('drawings are kept when switching images', (await shapes()).length === 5);
  await capture('06-final.png');
}
