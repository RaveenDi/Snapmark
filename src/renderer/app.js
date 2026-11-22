'use strict';
// Glue between the page (sidebar, toolbar, shortcuts) and the Editor.

(() => {
  const api = window.api;
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const COLORS = ['#ff3b30', '#ff9500', '#ffd60a', '#30d158', '#0a84ff', '#bf5af2', '#ffffff', '#111111'];
  const TOOL_KEYS = { v: 'select', a: 'arrow', l: 'poly', r: 'rect', o: 'ellipse', p: 'pen', t: 'text' };
  const HINTS = {
    select: 'Drag a drawing to move it · drag its dots to reshape · double-click anywhere to type',
    arrow: 'Drag to draw an arrow · double-click the arrow to label its end',
    poly: 'Click point after point · click the first point to close the shape · double-click or Enter to finish',
    rect: 'Drag to draw a rectangle · hold Shift for a square',
    ellipse: 'Drag to draw an ellipse · hold Shift for a circle',
    pen: 'Drag to draw freehand',
    text: 'Click where the text should go · Enter to finish, Shift+Enter for a new line',
  };
  const FILLS = ['none', 'soft', 'solid'];
  const FILL_HINTS = {
    none: 'Outline only: shapes are not filled',
    soft: 'See-through fill: rectangles, ellipses and closed shapes get a light tint',
    solid: 'Solid fill: rectangles, ellipses and closed shapes are filled in completely',
  };
  const CANVAS_SIZE = { w: 1920, h: 1080 };

  const editor = new window.Editor($('#stage'));
  const state = {
    dir: null,
    items: [],
    blanks: [], // blank canvases that only exist in memory until they are saved
    known: new Set(), // every path we have listed so far (to spot new screenshots)
    doc: null, // { path, name }
    sessions: new Map(), // path -> drawings, kept while the app is open
    dirty: new Set(), // paths with drawings that were not saved yet
    thumbs: new Map(), // "path|mtime" -> data URL
    temp: null, // flattened copy ready to be dragged out
    openToken: 0,
    draggingOut: false,
    mac: navigator.platform.toLowerCase().includes('mac'),
  };
  window.__snapmark = { editor, state };

  const baseName = (p) => p.split(/[\\/]/).pop();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isTyping = (el) => !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable);
  const markedName = (name) => name.replace(/\.[^.]+$/, '').replace(/-marked(-\d+)?$/, '') + '-marked.png';
  const isBlank = (p) => typeof p === 'string' && p.startsWith('canvas:');
  const tempName = (doc) => (doc.blank ? `${doc.name}.png` : markedName(doc.name));
  const thumbKey = (item) => `${item.path}|${item.mtime}`;

  // ---------- toasts ----------

  function toast(message, { action, run, ms = 3200 } = {}) {
    const el = document.createElement('div');
    el.className = 'toast';
    const text = document.createElement('span');
    text.textContent = message;
    el.append(text);
    if (action) {
      const b = document.createElement('button');
      b.textContent = action;
      b.addEventListener('click', () => {
        run();
        el.remove();
      });
      el.append(b);
    }
    $('#toasts').append(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 220);
    }, ms);
  }

  // ---------- sidebar ----------

  function when(ms) {
    const diff = Date.now() - ms;
    const min = Math.round(diff / 60000);
    if (min < 1) return 'now';
    if (min < 60) return `${min}m`;
    const d = new Date(ms);
    const today = new Date();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return time;
    const days = Math.round(diff / 86400000);
    if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  const thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        thumbObserver.unobserve(entry.target);
        loadThumb(entry.target);
      }
    },
    { root: $('#list'), rootMargin: '300px' }
  );

  async function loadThumb(img) {
    const key = img.dataset.key;
    let url = state.thumbs.get(key);
    if (!url) {
      if (isBlank(img.dataset.path)) return;
      url = await api.thumb(img.dataset.path);
      if (!url) return;
      state.thumbs.set(key, url);
    }
    img.src = url;
    img.classList.add('ready');
  }

  function renderList() {
    const list = $('#list');
    const scroll = list.scrollTop;
    thumbObserver.disconnect();
    list.textContent = '';

    if (!state.items.length) {
      const empty = document.createElement('div');
      empty.className = 'list-empty';
      empty.textContent = state.dir
        ? 'No images yet. Take a screenshot and it will appear here.'
        : 'Choose your screenshot folder below to see your images here.';
      list.append(empty);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const item of state.items) {
      const el = document.createElement('button');
      el.className = 'item';
      el.draggable = true;
      el.dataset.path = item.path;
      el.title = item.blank ? 'Blank canvas — not saved yet. Press Ctrl+S to save it as an image.' : item.path;
      if (state.doc && state.doc.path === item.path) el.classList.add('active');
      if (state.dirty.has(item.path)) el.classList.add('dirty');

      const thumb = document.createElement('span');
      thumb.className = 'thumb';
      const img = document.createElement('img');
      img.alt = '';
      img.dataset.path = item.path;
      img.dataset.key = thumbKey(item);
      const cached = state.thumbs.get(img.dataset.key);
      if (cached) {
        img.src = cached;
        img.classList.add('ready');
      } else {
        thumbObserver.observe(img);
      }
      thumb.append(img);

      const meta = document.createElement('span');
      meta.className = 'meta';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = item.name;
      const time = document.createElement('span');
      time.className = 'when';
      time.textContent = when(item.mtime);
      meta.append(name, time);

      el.append(thumb, meta);
      if (item.edited) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'Marked up';
        el.append(badge);
      }
      const dot = document.createElement('span');
      dot.className = 'unsaved';
      dot.title = 'Has drawings that are not saved yet';
      el.append(dot);
      frag.append(el);
    }
    list.append(frag);
    list.scrollTop = scroll;
  }

  function markActive() {
    for (const el of $$('#list .item')) {
      el.classList.toggle('active', !!state.doc && el.dataset.path === state.doc.path);
      el.classList.toggle('dirty', state.dirty.has(el.dataset.path));
    }
  }

  /** Reload the list. Returns the newest image that was not there before. */
  async function refresh() {
    const items = await api.listImages();
    const fresh = items.filter((i) => !state.known.has(i.path));
    for (const i of items) state.known.add(i.path);
    state.items = [...state.blanks, ...items];
    renderList();
    return fresh;
  }

  $('#list').addEventListener('click', (e) => {
    const el = e.target.closest('.item');
    if (!el) return;
    el.blur();
    openPath(el.dataset.path);
  });

  $('#list').addEventListener('dragstart', (e) => {
    const el = e.target.closest('.item');
    if (!el) return;
    e.preventDefault();
    let file = el.dataset.path;
    if (isBlank(file)) {
      // a canvas has no file yet: only the one on the workbench can be handed over
      file = state.doc && state.doc.path === file ? fileForDrag() : null;
    }
    if (!file) return;
    state.draggingOut = true;
    api.startDrag(file);
  });

  // ---------- documents ----------

  function stashSession() {
    if (!state.doc) return;
    const s = editor.getState();
    if (s.shapes.length || s.undoStack.length) state.sessions.set(state.doc.path, s);
    else state.sessions.delete(state.doc.path);
  }

  async function openPath(file, { retry = true } = {}) {
    if (state.doc && state.doc.path === file) return;
    const token = ++state.openToken;
    try {
      const blank = state.blanks.find((b) => b.path === file);
      if (isBlank(file) && !blank) return;
      const bitmap = blank
        ? window.Editor.blankBitmap(blank.w, blank.h)
        : await createImageBitmap(new Blob([await api.readImage(file)]));
      if (token !== state.openToken) return;
      stashSession();
      state.doc = blank ? { path: file, name: blank.name, blank } : { path: file, name: baseName(file) };
      state.temp = null;
      editor.setImage(bitmap, state.sessions.get(file));
      document.title = `${state.doc.name} — Snapmark`;
      updateChrome();
      markActive();
    } catch (err) {
      if (token !== state.openToken) return;
      if (retry) {
        // a screenshot that is still being written: give it a moment
        await sleep(400);
        if (token === state.openToken) return openPath(file, { retry: false });
        return;
      }
      toast(`Could not open ${baseName(file)}`);
    }
  }

  /** A plain white page to draw on. It becomes a file the first time it is saved. */
  let canvasCount = 0;
  async function newCanvas() {
    const n = ++canvasCount;
    const blank = { path: `canvas:${n}`, name: `Blank canvas ${n}`, mtime: Date.now(), blank: true, ...CANVAS_SIZE };
    state.blanks.unshift(blank);
    state.thumbs.set(thumbKey(blank), WHITE_THUMB);
    state.items = [blank, ...state.items];
    renderList();
    $('#list').scrollTop = 0;
    await openPath(blank.path);
    if (editor.tool === 'select') setTool('pen');
  }

  const WHITE_THUMB = (() => {
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 18;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 32, 18);
    return c.toDataURL('image/png');
  })();

  /** Keep the sidebar preview of a blank canvas in step with what is drawn on it. */
  function updateCanvasThumb(doc) {
    if (!doc.blank || state.doc !== doc) return;
    const url = editor.thumbDataURL();
    if (!url) return;
    state.thumbs.set(thumbKey(doc.blank), url);
    const img = $$('#list .thumb img').find((i) => i.dataset.path === doc.path);
    if (img) img.src = url;
  }

  function updateDirty() {
    if (!state.doc) return;
    const p = state.doc.path;
    if (editor.shapes.length && editor.revision !== state.doc.savedRevision) state.dirty.add(p);
    else state.dirty.delete(p);
    api.setDirty(state.dirty.size);
    markActive();
  }

  async function flattened() {
    editor.commitText();
    const blob = await editor.exportBlob();
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }

  async function save(saveAs = false) {
    if (!state.doc) return;
    const doc = state.doc;
    try {
      const data = await flattened();
      // a blank canvas has no original file: it is saved as "Snapmark <date>.png" in the screenshot folder
      const res = await (saveAs ? api.saveAs : api.save)({ sourcePath: doc.blank ? null : doc.path, data });
      if (!res) return;
      doc.savedRevision = editor.revision;
      updateDirty();
      state.known.add(res.path);
      await refresh();
      toast(`Saved as ${res.name}`, { action: 'Show in folder', run: () => api.reveal(res.path), ms: 4500 });
    } catch (err) {
      toast('Could not save the image: ' + (err && err.message ? err.message : err));
    }
  }

  let lastCopy = 0;
  async function copyImage() {
    if (!state.doc || performance.now() - lastCopy < 300) return;
    lastCopy = performance.now();
    const data = await flattened();
    await api.copyImage(data);
    toast('Copied to the clipboard');
  }

  async function openDialog() {
    const file = await api.openDialog();
    if (!file) return;
    state.known.add(file);
    await refresh();
    openPath(file);
  }

  async function importBlob(blob) {
    const ext = { 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp' }[blob.type] || '.png';
    const res = await api.importImage({ data: new Uint8Array(await blob.arrayBuffer()), ext });
    state.known.add(res.path);
    await refresh();
    openPath(res.path);
  }

  async function openFiles(files) {
    const paths = files.map((f) => api.pathForFile(f)).filter((p) => /\.(png|jpe?g|webp|bmp|gif)$/i.test(p));
    if (!paths.length) {
      const blob = files.find((f) => f.type.startsWith('image/'));
      if (blob) await importBlob(blob);
      return;
    }
    for (const p of paths) {
      await api.remember(p);
      state.known.add(p);
    }
    await refresh();
    openPath(paths[0]);
  }

  // ---------- drag the image out, without saving ----------

  let tempTimer = 0;

  function scheduleTemp() {
    clearTimeout(tempTimer);
    tempTimer = setTimeout(prepareTemp, 300);
  }

  /** Keep a flattened copy on disk so a drag can start instantly. */
  async function prepareTemp() {
    const doc = state.doc;
    if (!doc || (!editor.shapes.length && !doc.blank)) return;
    const revision = editor.revision;
    updateCanvasThumb(doc);
    const blob = await editor.exportBlob();
    if (!blob || state.doc !== doc || editor.revision !== revision) return;
    const file = await api.writeTemp({ name: tempName(doc), data: new Uint8Array(await blob.arrayBuffer()) });
    if (state.doc === doc && editor.revision === revision) state.temp = { doc, revision, file };
  }

  function fileForDrag() {
    const doc = state.doc;
    if (!doc) return null;
    editor.commitText();
    if (!editor.shapes.length && !doc.blank) return doc.path; // nothing drawn: hand over the original
    const t = state.temp;
    if (t && t.doc === doc && t.revision === editor.revision) return t.file;
    const file = api.writeTempSync({ name: tempName(doc), dataUrl: editor.exportDataURL() });
    if (file) state.temp = { doc, revision: editor.revision, file };
    return file;
  }

  $('#drag-chip').addEventListener('dragstart', (e) => {
    e.preventDefault();
    const file = fileForDrag();
    if (!file) return;
    state.draggingOut = true;
    api.startDrag(file);
  });

  // ---------- drop files in, paste ----------

  const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  let veilTimer = 0;

  window.addEventListener('pointermove', () => {
    state.draggingOut = false;
  });

  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e) || state.draggingOut) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    $('#drop-veil').classList.add('show');
    clearTimeout(veilTimer);
    veilTimer = setTimeout(() => $('#drop-veil').classList.remove('show'), 180);
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    $('#drop-veil').classList.remove('show');
    if (state.draggingOut) {
      state.draggingOut = false;
      return;
    }
    const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
    if (files.length) openFiles(files);
  });

  document.addEventListener('paste', (e) => {
    if (isTyping(e.target)) return;
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    openFiles(files);
  });

  document.addEventListener('copy', (e) => {
    if (isTyping(e.target) || !state.doc) return;
    e.preventDefault();
    copyImage();
  });
  document.addEventListener('cut', (e) => {
    if (!isTyping(e.target)) e.preventDefault();
  });

  // ---------- toolbar ----------

  function setTool(tool) {
    editor.setTool(tool);
    for (const b of $$('#tools .tool')) b.classList.toggle('active', b.dataset.tool === tool);
    showHint(HINTS[tool]);
  }

  let hintTimer = 0;
  function showHint(text) {
    const el = $('#hint');
    if (!state.doc || !text) {
      el.classList.remove('show');
      return;
    }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => el.classList.remove('show'), 4200);
  }

  function setColor(color) {
    editor.setColor(color);
    for (const b of $$('#colors .swatch')) b.classList.toggle('active', b.dataset.color === color);
  }

  function setSize(i) {
    editor.setSizeIndex(i);
    for (const b of $$('#sizes .size')) b.classList.toggle('active', Number(b.dataset.size) === i);
  }

  function showFill() {
    const mode = editor.fill || 'none';
    for (const b of $$('#fills .tool')) b.classList.toggle('active', b.dataset.fill === mode);
  }

  function setFill(mode) {
    editor.setFill(mode === 'none' ? false : mode);
    showFill();
  }

  function updateChrome() {
    const has = !!state.doc;
    $('#empty').hidden = has;
    $('#drag-chip').hidden = !has;
    $('#zoombar').hidden = !has;
    $('#btn-save').disabled = !has;
    $('#btn-copy').disabled = !has;
    $('#btn-undo').disabled = !editor.undoStack.length;
    $('#btn-redo').disabled = !editor.redoStack.length;
    $('#zoom-label').textContent = `${editor.zoomPercent}%`;
  }

  for (const color of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.color = color;
    b.style.setProperty('--c', color);
    b.title = color;
    $('#colors').append(b);
  }

  // toolbar buttons never take keyboard focus, so Space and letters keep working
  $('#toolbar').addEventListener('mousedown', (e) => e.preventDefault());
  $('#zoombar').addEventListener('mousedown', (e) => e.preventDefault());

  $('#tools').addEventListener('click', (e) => {
    const b = e.target.closest('.tool');
    if (b) setTool(b.dataset.tool);
  });
  $('#colors').addEventListener('click', (e) => {
    const b = e.target.closest('.swatch');
    if (b) setColor(b.dataset.color);
  });
  $('#sizes').addEventListener('click', (e) => {
    const b = e.target.closest('.size');
    if (b) setSize(Number(b.dataset.size));
  });
  $('#fills').addEventListener('click', (e) => {
    const b = e.target.closest('.tool');
    if (!b) return;
    setFill(b.dataset.fill);
    showHint(FILL_HINTS[b.dataset.fill]);
  });
  $('#btn-new').addEventListener('click', newCanvas);
  $('#btn-new-empty').addEventListener('click', newCanvas);
  $('#btn-undo').addEventListener('click', () => editor.undo());
  $('#btn-redo').addEventListener('click', () => editor.redo());
  $('#btn-save').addEventListener('click', (e) => save(e.shiftKey));
  $('#btn-copy').addEventListener('click', copyImage);
  $('#btn-open').addEventListener('click', openDialog);
  $('#btn-open-empty').addEventListener('click', openDialog);
  $('#zoom-in').addEventListener('click', () => editor.zoomAt(1.25));
  $('#zoom-out').addEventListener('click', () => editor.zoomAt(0.8));
  $('#zoom-fit').addEventListener('click', () => editor.fit());
  $('#zoom-label').addEventListener('click', () => editor.setZoomPercent(100));

  editor.onChange = () => {
    updateDirty();
    updateChrome();
    scheduleTemp();
  };
  editor.onView = updateChrome;
  editor.onSelect = () => {
    // show the style of what is selected in the toolbar
    const s = editor.selected;
    if (!s) return;
    editor.color = s.color;
    for (const b of $$('#colors .swatch')) b.classList.toggle('active', b.dataset.color === s.color);
    if ('fill' in s) {
      editor.fill = s.fill === 'solid' ? 'solid' : s.fill ? 'soft' : false;
      showFill();
    }
  };

  // ---------- keyboard ----------

  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

    if (mod && key === 's') {
      e.preventDefault();
      save(e.shiftKey);
      return;
    }
    if (isTyping(e.target)) return;

    if (mod) {
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) editor.redo();
        else editor.undo();
      } else if (key === 'y') {
        e.preventDefault();
        editor.redo();
      } else if (key === 'c') {
        e.preventDefault();
        copyImage();
      } else if (key === 'o') {
        e.preventDefault();
        openDialog();
      } else if (key === 'n') {
        e.preventDefault();
        newCanvas();
      } else if (key === '0') {
        e.preventDefault();
        editor.fit();
      } else if (key === '1') {
        e.preventDefault();
        editor.setZoomPercent(100);
      } else if (key === '=' || key === '+') {
        e.preventDefault();
        editor.zoomAt(1.25);
      } else if (key === '-') {
        e.preventDefault();
        editor.zoomAt(0.8);
      }
      return;
    }
    if (e.altKey) return;

    if (key === ' ') {
      e.preventDefault();
      editor.setSpace(true);
      return;
    }
    if (key === 'f') {
      const next = FILLS[(FILLS.indexOf(editor.fill || 'none') + 1) % FILLS.length];
      setFill(next);
      showHint(FILL_HINTS[next]);
      return;
    }
    if (TOOL_KEYS[key]) {
      setTool(TOOL_KEYS[key]);
      return;
    }
    if (editor.key(e)) e.preventDefault();
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') editor.setSpace(false);
  });
  window.addEventListener('blur', () => editor.setSpace(false));

  // ---------- folder ----------

  function showFolder() {
    $('#folder-path').textContent = state.dir || 'Choose screenshot folder';
    $('#btn-folder').title = state.dir ? `${state.dir}\nClick to choose a different folder` : 'Choose the folder where your screenshots are saved';
  }

  async function chooseDir() {
    const dir = await api.chooseDir();
    if (!dir) return false;
    state.dir = dir;
    showFolder();
    await refresh();
    if (!state.doc && state.items[0]) openPath(state.items[0].path);
    return true;
  }

  $('#btn-folder').addEventListener('click', chooseDir);
  $('#welcome-choose').addEventListener('click', async () => {
    if (await chooseDir()) $('#welcome').hidden = true;
  });
  $('#welcome-skip').addEventListener('click', () => {
    $('#welcome').hidden = true;
  });

  api.onImagesChanged(async () => {
    const fresh = await refresh();
    // A brand-new screenshot goes straight to the workbench, unless you are mid-edit.
    const shot = fresh.find((i) => !i.edited);
    const busy = state.doc && (state.dirty.has(state.doc.path) || editor.draft || editor.editing);
    if (shot && !busy) openPath(shot.path);
  });

  api.onOpenFile(async (file) => {
    state.known.add(file);
    await refresh();
    openPath(file);
  });

  setInterval(() => {
    for (const el of $$('#list .item')) {
      const item = state.items.find((i) => i.path === el.dataset.path);
      if (item) el.querySelector('.when').textContent = when(item.mtime);
    }
  }, 60000);

  // ---------- start ----------

  (async () => {
    setTool('select');
    setColor(COLORS[0]);
    setSize(1);
    setFill('none');
    updateChrome();

    const init = await api.init();
    state.dir = init.dir;
    showFolder();
    if (!state.dir) $('#welcome').hidden = false;

    await refresh();
    const pending = await api.pendingOpen();
    if (pending) openPath(pending);
    else if (state.items[0]) openPath(state.items[0].path);

    if (init.detected && state.dir) {
      toast(`Watching ${state.dir}`, { action: 'Change', run: chooseDir, ms: 6000 });
    }
  })();
})();
