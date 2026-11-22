'use strict';
// The workbench: one canvas that shows the image, the drawings on top of it,
// and handles zoom, pan and every drawing tool. All shapes live in image pixels,
// so what you see is exactly what gets saved.

(() => {
  const ACCENT = '#3b82f6';
  // Text you type uses the bundled "Edu NSW ACT Foundation" handwriting font (see fonts/OFL.txt).
  const FONT_STACK = '"Edu NSW ACT Foundation", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
  const FONT_WEIGHT = 600;
  const LINE_H = 1.3;
  const STROKES = [2, 4, 7, 12];
  const FONTS = [15, 22, 32, 46];
  const HANDLE_R = 5.5; // css px
  const HIT_PX = 7; // css px
  const CLOSE_PX = 12; // css px
  const MIN_SCALE = 0.02;
  const MAX_SCALE = 40;
  const TAU = Math.PI * 2;

  const measureCtx = document.createElement('canvas').getContext('2d');
  let idCounter = 0;
  const uid = () => `s${Date.now().toString(36)}${(idCounter++).toString(36)}`;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function pointInPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i];
      const b = pts[j];
      if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  function haloFor(color) {
    const m = /^#?([0-9a-f]{6})$/i.exec(color || '');
    if (!m) return 'rgba(255,255,255,0.9)';
    const n = parseInt(m[1], 16);
    const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.62 ? 'rgba(0,0,0,0.78)' : 'rgba(255,255,255,0.92)';
  }

  const fontOf = (size) => `${FONT_WEIGHT} ${size}px ${FONT_STACK}`;
  // The canvas can only draw with the font once it is loaded.
  const fontReady = document.fonts.load(fontOf(32)).then((faces) => faces.length > 0, () => false);

  /** false = outline only, 'soft' = see-through fill, 'solid' = fully filled. */
  const fillMode = (v) => (v === 'solid' ? 'solid' : v ? 'soft' : false);

  function measureText(text, size) {
    measureCtx.font = fontOf(size);
    const lines = String(text || '').split('\n');
    let w = 0;
    for (const line of lines) w = Math.max(w, measureCtx.measureText(line).width);
    return { lines, w, h: lines.length * size * LINE_H };
  }

  function drawTextBlock(ctx, text, x, y, size, color, align = 'left') {
    const { lines, w } = measureText(text, size);
    const lh = size * LINE_H;
    ctx.save();
    ctx.font = fontOf(size);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = haloFor(color);
    ctx.lineWidth = Math.max(2, size * 0.16);
    ctx.fillStyle = color;
    lines.forEach((line, i) => {
      const lw = ctx.measureText(line).width;
      const lx = align === 'right' ? x + w - lw : align === 'center' ? x + (w - lw) / 2 : x;
      const ly = y + i * lh + lh / 2;
      ctx.strokeText(line, lx, ly);
      ctx.fillText(line, lx, ly);
    });
    ctx.restore();
  }

  /** Where an arrow's label sits: just past the tail, pushed away from the head. */
  function labelLayout(s, text = s.label) {
    const { w, h } = measureText(text || ' ', s.fontSize);
    let dx = s.x1 - s.x2;
    let dy = s.y1 - s.y2;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const gap = s.width * 1.5 + s.fontSize * 0.35;
    const ax = s.x1 + dx * gap;
    const ay = s.y1 + dy * gap;
    if (Math.abs(dx) >= Math.abs(dy)) {
      return { x: dx >= 0 ? ax : ax - w, y: ay - h / 2, w, h, align: dx >= 0 ? 'left' : 'right' };
    }
    return { x: ax - w / 2, y: dy >= 0 ? ay : ay - h, w, h, align: 'center' };
  }

  function textBox(s) {
    const { w, h } = measureText(s.text, s.fontSize);
    return { x: s.x, y: s.y, w, h };
  }

  function drawShape(ctx, s, opts = {}) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width || 1;

    // Fills the current path. A shape that is still being drawn is kept
    // see-through so what is underneath stays visible while you place points.
    const paintFill = (preview = false) => {
      const mode = fillMode(s.fill);
      if (!mode) return;
      ctx.save();
      ctx.globalAlpha = mode === 'solid' ? (preview ? 0.5 : 1) : 0.22;
      ctx.fill();
      ctx.restore();
    };

    switch (s.type) {
      case 'arrow': {
        const dx = s.x2 - s.x1;
        const dy = s.y2 - s.y1;
        const len = Math.hypot(dx, dy);
        if (len > 0.5) {
          const ux = dx / len;
          const uy = dy / len;
          const head = Math.min(len * 0.6, s.width * 4.2 + 6);
          const half = head * 0.5;
          const bx = s.x2 - ux * head;
          const by = s.y2 - uy * head;
          ctx.beginPath();
          ctx.moveTo(s.x1, s.y1);
          ctx.lineTo(bx + ux * head * 0.15, by + uy * head * 0.15);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(s.x2, s.y2);
          ctx.lineTo(bx - uy * half, by + ux * half);
          ctx.lineTo(bx + uy * half, by - ux * half);
          ctx.closePath();
          ctx.lineWidth = Math.max(1, s.width * 0.35);
          ctx.fill();
          ctx.stroke();
        }
        if (s.label && !opts.hideLabel) {
          const l = labelLayout(s);
          drawTextBlock(ctx, s.label, l.x, l.y, s.fontSize, s.color, l.align);
        }
        break;
      }
      case 'poly': {
        const pts = opts.hover ? [...s.pts, opts.hover] : s.pts;
        if (!pts.length) break;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        if (s.closed) ctx.closePath();
        if (s.closed) paintFill();
        else if (opts.draft && pts.length >= 3) paintFill(true);
        ctx.stroke();
        break;
      }
      case 'rect': {
        ctx.beginPath();
        ctx.rect(s.x, s.y, s.w, s.h);
        paintFill();
        ctx.stroke();
        break;
      }
      case 'ellipse': {
        ctx.beginPath();
        ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w / 2), Math.abs(s.h / 2), 0, 0, TAU);
        paintFill();
        ctx.stroke();
        break;
      }
      case 'pen': {
        const pts = s.pts;
        if (!pts.length) break;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        if (pts.length < 3) {
          for (const p of pts) ctx.lineTo(p.x, p.y);
        } else {
          for (let i = 1; i < pts.length - 1; i++) {
            const mx = (pts[i].x + pts[i + 1].x) / 2;
            const my = (pts[i].y + pts[i + 1].y) / 2;
            ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
          }
          const last = pts[pts.length - 1];
          ctx.lineTo(last.x, last.y);
        }
        ctx.stroke();
        break;
      }
      case 'text': {
        drawTextBlock(ctx, s.text, s.x, s.y, s.fontSize, s.color);
        break;
      }
    }
    ctx.restore();
  }

  function shapeBounds(s) {
    switch (s.type) {
      case 'arrow':
        return {
          x: Math.min(s.x1, s.x2),
          y: Math.min(s.y1, s.y2),
          w: Math.abs(s.x2 - s.x1),
          h: Math.abs(s.y2 - s.y1),
        };
      case 'rect':
      case 'ellipse':
        return { x: s.x, y: s.y, w: s.w, h: s.h };
      case 'text':
        return textBox(s);
      default: {
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (const p of s.pts) {
          x0 = Math.min(x0, p.x);
          y0 = Math.min(y0, p.y);
          x1 = Math.max(x1, p.x);
          y1 = Math.max(y1, p.y);
        }
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
    }
  }

  function hitShape(s, x, y, tol) {
    const t = tol + (s.width || 0) / 2;
    const inBox = (b, pad = tol) => x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;
    switch (s.type) {
      case 'arrow':
        if (distToSeg(x, y, s.x1, s.y1, s.x2, s.y2) <= t + s.width) return true;
        return !!s.label && inBox(labelLayout(s));
      case 'poly':
      case 'pen': {
        const pts = s.pts;
        for (let i = 0; i < pts.length - 1; i++) {
          if (distToSeg(x, y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= t) return true;
        }
        if (s.closed && pts.length > 2) {
          const a = pts[pts.length - 1];
          if (distToSeg(x, y, a.x, a.y, pts[0].x, pts[0].y) <= t) return true;
          if (s.fill && pointInPoly(x, y, pts)) return true;
        }
        return false;
      }
      case 'rect': {
        const { x: rx, y: ry, w, h } = s;
        if (s.fill && inBox(s, 0)) return true;
        return (
          distToSeg(x, y, rx, ry, rx + w, ry) <= t ||
          distToSeg(x, y, rx + w, ry, rx + w, ry + h) <= t ||
          distToSeg(x, y, rx + w, ry + h, rx, ry + h) <= t ||
          distToSeg(x, y, rx, ry + h, rx, ry) <= t
        );
      }
      case 'ellipse': {
        const rx = Math.abs(s.w / 2) || 0.001;
        const ry = Math.abs(s.h / 2) || 0.001;
        const d = Math.hypot((x - (s.x + s.w / 2)) / rx, (y - (s.y + s.h / 2)) / ry);
        if (s.fill && d <= 1) return true;
        return Math.abs(d - 1) * Math.min(rx, ry) <= t;
      }
      case 'text':
        return inBox(textBox(s));
    }
    return false;
  }

  function handlesOf(s) {
    switch (s.type) {
      case 'arrow':
        return [
          { x: s.x1, y: s.y1 },
          { x: s.x2, y: s.y2 },
        ];
      case 'poly':
        return s.pts;
      case 'rect':
      case 'ellipse':
        return [
          { x: s.x, y: s.y },
          { x: s.x + s.w, y: s.y },
          { x: s.x + s.w, y: s.y + s.h },
          { x: s.x, y: s.y + s.h },
        ];
      default:
        return [];
    }
  }

  function translate(s, dx, dy) {
    switch (s.type) {
      case 'arrow':
        s.x1 += dx;
        s.y1 += dy;
        s.x2 += dx;
        s.y2 += dy;
        break;
      case 'poly':
      case 'pen':
        for (const p of s.pts) {
          p.x += dx;
          p.y += dy;
        }
        break;
      default:
        s.x += dx;
        s.y += dy;
    }
  }

  class Editor {
    constructor(host) {
      this.host = host;
      this.canvas = host.querySelector('canvas');
      this.ctx = this.canvas.getContext('2d');

      this.image = null;
      this.iw = 0;
      this.ih = 0;
      this.k = 1; // size multiplier so strokes look right on big screenshots
      this.shapes = [];
      this.undoStack = [];
      this.redoStack = [];
      this.view = { scale: 1, tx: 0, ty: 0 };
      this.vw = 0;
      this.vh = 0;

      this.tool = 'select';
      this.color = '#ff3b30';
      this.sizeIndex = 1;
      this.fill = false;

      this.selectedId = null;
      this.draft = null; // shape being drawn
      this.hover = null; // cursor position in image pixels
      this.drag = null; // current pointer gesture
      this.editing = null; // open text editor
      this.spaceDown = false;
      this.revision = 0;
      this._raf = 0;
      this._needsFit = false;
      this._polyClosedAt = 0;

      this.onChange = () => {};
      this.onView = () => {};
      this.onSelect = () => {};

      const c = this.canvas;
      c.addEventListener('pointerdown', (e) => this._down(e));
      c.addEventListener('pointermove', (e) => this._move(e));
      c.addEventListener('pointerup', (e) => this._up(e));
      c.addEventListener('pointercancel', (e) => this._up(e));
      c.addEventListener('dblclick', (e) => this._dbl(e));
      c.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
      c.addEventListener('contextmenu', (e) => e.preventDefault());
      c.addEventListener('pointerleave', () => {
        if (!this.drag) {
          this.hover = null;
          this.requestRender();
        }
      });
      new ResizeObserver(() => this._resize()).observe(host);
      this._resize();
      this.fontReady = fontReady;
      fontReady.then(() => {
        this._placeEditor();
        this.requestRender();
      });
    }

    // ---------- document ----------

    setImage(bitmap, state) {
      this.cancelText();
      this.image = bitmap;
      this.iw = bitmap.width;
      this.ih = bitmap.height;
      this.k = clamp(Math.max(this.iw, this.ih) / 1400, 1, 3);
      this.shapes = state ? state.shapes : [];
      this.undoStack = state ? state.undoStack : [];
      this.redoStack = state ? state.redoStack : [];
      this.selectedId = null;
      this.draft = null;
      this.drag = null;
      this.revision++;
      this.fit();
      this.onSelect();
      this.requestRender();
    }

    clear() {
      this.cancelText();
      this.image = null;
      this.shapes = [];
      this.undoStack = [];
      this.redoStack = [];
      this.selectedId = null;
      this.draft = null;
      this.revision++;
      this.requestRender();
    }

    getState() {
      this.commitText();
      return { shapes: this.shapes, undoStack: this.undoStack, redoStack: this.redoStack };
    }

    get selected() {
      return this.shapes.find((s) => s.id === this.selectedId) || null;
    }

    // ---------- view ----------

    _resize() {
      const r = this.host.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const hadSize = this.vw > 0 && this.vh > 0;
      // keep the same image point in the middle of the workbench
      if (hadSize && this.image) {
        this.view.tx += (r.width - this.vw) / 2;
        this.view.ty += (r.height - this.vh) / 2;
      }
      this.vw = r.width;
      this.vh = r.height;
      this.canvas.width = Math.max(1, Math.round(r.width * dpr));
      this.canvas.height = Math.max(1, Math.round(r.height * dpr));
      if (this._needsFit) this.fit();
      this._placeEditor();
      this.render();
    }

    fit() {
      if (!this.image) return;
      if (!this.vw || !this.vh) {
        this._needsFit = true;
        return;
      }
      this._needsFit = false;
      const dpr = window.devicePixelRatio || 1;
      const pad = 56;
      const scale = Math.min((this.vw - pad) / this.iw, (this.vh - pad) / this.ih, 1 / dpr);
      this.view = {
        scale: Math.max(scale, MIN_SCALE),
        tx: (this.vw - this.iw * scale) / 2,
        ty: (this.vh - this.ih * scale) / 2,
      };
      this._viewChanged();
    }

    /** Zoom as a percentage of real pixels (100 = one image pixel per screen pixel). */
    get zoomPercent() {
      return Math.round(this.view.scale * (window.devicePixelRatio || 1) * 100);
    }

    zoomAt(factor, cx = this.vw / 2, cy = this.vh / 2) {
      if (!this.image) return;
      const v = this.view;
      const next = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
      const f = next / v.scale;
      v.tx = cx - (cx - v.tx) * f;
      v.ty = cy - (cy - v.ty) * f;
      v.scale = next;
      this._viewChanged();
    }

    setZoomPercent(percent) {
      const target = percent / 100 / (window.devicePixelRatio || 1);
      this.zoomAt(target / this.view.scale);
    }

    _viewChanged() {
      this._placeEditor();
      this.onView();
      this.requestRender();
    }

    toImage(e) {
      const r = this.canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left - this.view.tx) / this.view.scale,
        y: (e.clientY - r.top - this.view.ty) / this.view.scale,
      };
    }

    toScreen(p) {
      return { x: p.x * this.view.scale + this.view.tx, y: p.y * this.view.scale + this.view.ty };
    }

    // ---------- style ----------

    get strokeWidth() {
      return Math.round(STROKES[this.sizeIndex] * this.k);
    }

    get fontSize() {
      return Math.round(FONTS[this.sizeIndex] * this.k);
    }

    setTool(tool) {
      if (this.draft && this.draft.type === 'poly') this.finishPoly(false);
      this.commitText();
      this.tool = tool;
      this._updateCursor();
      this.requestRender();
    }

    setColor(color) {
      this.color = color;
      if (this.editing) {
        this.editing.color = color;
        this._placeEditor();
      }
      const s = this.selected;
      if (s && s.color !== color) this._commit(() => (s.color = color));
    }

    setSizeIndex(i) {
      this.sizeIndex = clamp(i, 0, STROKES.length - 1);
      if (this.editing) {
        this.editing.size = this.fontSize;
        this._placeEditor();
      }
      const s = this.selected;
      if (!s) return;
      this._commit(() => {
        if (s.type !== 'text') s.width = this.strokeWidth;
        if (s.type === 'text' || s.type === 'arrow') s.fontSize = this.fontSize;
      });
    }

    setFill(fill) {
      this.fill = fillMode(fill);
      const s = this.selected;
      if (s && 'fill' in s && s.fill !== this.fill) this._commit(() => (s.fill = this.fill));
    }

    select(id) {
      if (this.selectedId === id) return;
      this.selectedId = id;
      this.onSelect();
      this.requestRender();
    }

    // ---------- history ----------

    _snapshot() {
      return JSON.stringify(this.shapes);
    }

    _pushUndo(snapshot) {
      this.undoStack.push(snapshot);
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
    }

    _changed() {
      this.revision++;
      this.onChange();
      this.requestRender();
    }

    _commit(mutate) {
      const before = this._snapshot();
      mutate();
      this._pushUndo(before);
      this._changed();
    }

    undo() {
      this.commitText();
      if (this.draft) {
        this.draft = null;
        this.requestRender();
        return;
      }
      if (!this.undoStack.length) return;
      this.redoStack.push(this._snapshot());
      this.shapes = JSON.parse(this.undoStack.pop());
      if (!this.selected) this.selectedId = null;
      this.onSelect();
      this._changed();
    }

    redo() {
      this.commitText();
      if (!this.redoStack.length) return;
      this.undoStack.push(this._snapshot());
      this.shapes = JSON.parse(this.redoStack.pop());
      if (!this.selected) this.selectedId = null;
      this.onSelect();
      this._changed();
    }

    deleteSelected() {
      const s = this.selected;
      if (!s) return false;
      this._commit(() => {
        this.shapes = this.shapes.filter((x) => x !== s);
      });
      this.select(null);
      return true;
    }

    // ---------- pointer ----------

    _tol(px = HIT_PX) {
      return px / this.view.scale;
    }

    _shapeAt(p) {
      const tol = this._tol();
      for (let i = this.shapes.length - 1; i >= 0; i--) {
        if (hitShape(this.shapes[i], p.x, p.y, tol)) return this.shapes[i];
      }
      return null;
    }

    _handleAt(p) {
      const s = this.selected;
      if (!s) return null;
      const tol = this._tol(HANDLE_R + 4);
      const hs = handlesOf(s);
      for (let i = hs.length - 1; i >= 0; i--) {
        if (dist(hs[i], p) <= tol) return { shape: s, index: i };
      }
      return null;
    }

    /** Shift keeps lines on 45° steps. */
    _constrain(from, p, on) {
      if (!on || !from) return p;
      const dx = p.x - from.x;
      const dy = p.y - from.y;
      const len = Math.hypot(dx, dy);
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      return { x: from.x + Math.cos(angle) * len, y: from.y + Math.sin(angle) * len };
    }

    _down(e) {
      if (!this.image) return;
      if (this.editing) {
        // a click outside the text box just finishes typing
        this.commitText();
        return;
      }
      this.canvas.setPointerCapture(e.pointerId);
      const p = this.toImage(e);
      this.hover = p;

      if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
        this._startPan(e);
        return;
      }
      if (e.button === 2) {
        if (this.draft && this.draft.type === 'poly') this.finishPoly(false);
        return;
      }
      if (e.button !== 0) return;

      if (!this.draft) {
        const h = this._handleAt(p);
        if (h) {
          const s = h.shape;
          const d = { kind: 'handle', id: s.id, index: h.index, before: this._snapshot(), moved: false };
          if (s.type === 'rect' || s.type === 'ellipse') {
            const corners = handlesOf(s);
            d.anchor = { ...corners[(h.index + 2) % 4] };
          }
          this.drag = d;
          return;
        }
      }

      const base = { id: uid(), color: this.color, width: this.strokeWidth };
      switch (this.tool) {
        case 'select': {
          const s = this._shapeAt(p);
          if (s) {
            this.select(s.id);
            this.drag = { kind: 'move', id: s.id, last: p, before: this._snapshot(), moved: false };
          } else {
            this.select(null);
            this._startPan(e);
          }
          break;
        }
        case 'arrow':
          this.select(null);
          this.draft = { ...base, type: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, label: '', fontSize: this.fontSize };
          this.drag = { kind: 'draw', sx: e.clientX, sy: e.clientY, start: p };
          break;
        case 'rect':
        case 'ellipse':
          this.select(null);
          this.draft = { ...base, type: this.tool, x: p.x, y: p.y, w: 0, h: 0, fill: this.fill };
          this.drag = { kind: 'draw', sx: e.clientX, sy: e.clientY, start: p };
          break;
        case 'pen':
          this.select(null);
          this.draft = { ...base, type: 'pen', pts: [p] };
          this.drag = { kind: 'draw', sx: e.clientX, sy: e.clientY, start: p };
          break;
        case 'poly':
          this._polyClick(p, e);
          break;
        case 'text':
          this.drag = { kind: 'textclick', p };
          break;
      }
      this.requestRender();
    }

    _startPan(e) {
      this.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, tx: this.view.tx, ty: this.view.ty };
      this.canvas.style.cursor = 'grabbing';
    }

    _move(e) {
      if (!this.image) return;
      const p = this.toImage(e);
      this.hover = p;
      const d = this.drag;
      if (!d) {
        this._updateCursor(p);
        if (this.draft) {
          this._shift = e.shiftKey;
          this.requestRender();
        }
        return;
      }
      switch (d.kind) {
        case 'pan':
          this.view.tx = d.tx + e.clientX - d.sx;
          this.view.ty = d.ty + e.clientY - d.sy;
          this._viewChanged();
          return;
        case 'draw': {
          const s = this.draft;
          if (!s) break;
          if (s.type === 'arrow') {
            const q = this._constrain(d.start, p, e.shiftKey);
            s.x2 = q.x;
            s.y2 = q.y;
          } else if (s.type === 'pen') {
            if (dist(s.pts[s.pts.length - 1], p) > this._tol(1.5)) s.pts.push(p);
          } else {
            s.w = p.x - d.start.x;
            s.h = p.y - d.start.y;
            if (e.shiftKey) {
              const m = Math.max(Math.abs(s.w), Math.abs(s.h));
              s.w = Math.sign(s.w || 1) * m;
              s.h = Math.sign(s.h || 1) * m;
            }
          }
          break;
        }
        case 'move': {
          const s = this.shapes.find((x) => x.id === d.id);
          if (s) {
            translate(s, p.x - d.last.x, p.y - d.last.y);
            d.last = p;
            d.moved = true;
          }
          break;
        }
        case 'handle':
          this._dragHandle(d, p, e);
          break;
      }
      this.requestRender();
    }

    _dragHandle(d, p, e) {
      const s = this.shapes.find((x) => x.id === d.id);
      if (!s) return;
      d.moved = true;
      d.closeTarget = null;
      if (s.type === 'arrow') {
        const other = d.index === 0 ? { x: s.x2, y: s.y2 } : { x: s.x1, y: s.y1 };
        const q = this._constrain(other, p, e.shiftKey);
        if (d.index === 0) {
          s.x1 = q.x;
          s.y1 = q.y;
        } else {
          s.x2 = q.x;
          s.y2 = q.y;
        }
      } else if (s.type === 'poly') {
        const last = s.pts.length - 1;
        let q = p;
        // Dropping one end of an open line on the other end closes the shape.
        if (!s.closed && s.pts.length >= 4 && (d.index === 0 || d.index === last)) {
          const target = s.pts[d.index === 0 ? last : 0];
          if (dist(target, p) <= this._tol(CLOSE_PX)) {
            q = { x: target.x, y: target.y };
            d.closeTarget = target;
          }
        }
        s.pts[d.index] = q;
      } else if (d.anchor) {
        s.x = Math.min(d.anchor.x, p.x);
        s.y = Math.min(d.anchor.y, p.y);
        s.w = Math.abs(p.x - d.anchor.x);
        s.h = Math.abs(p.y - d.anchor.y);
      }
    }

    _up(e) {
      // make sure the exact release position counts, even if the last move was skipped
      if (this.drag && e.type === 'pointerup' && ['draw', 'move', 'handle'].includes(this.drag.kind)) this._move(e);
      const d = this.drag;
      this.drag = null;
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
      if (!d) return;
      switch (d.kind) {
        case 'draw': {
          const s = this.draft;
          this.draft = null;
          const movedPx = Math.hypot(e.clientX - d.sx, e.clientY - d.sy);
          if (s && movedPx >= 4) {
            if (s.type === 'rect' || s.type === 'ellipse') {
              if (s.w < 0) {
                s.x += s.w;
                s.w = -s.w;
              }
              if (s.h < 0) {
                s.y += s.h;
                s.h = -s.h;
              }
            }
            this._commit(() => this.shapes.push(s));
            this.select(s.id);
          }
          break;
        }
        case 'move':
        case 'handle': {
          if (!d.moved) break;
          const s = this.shapes.find((x) => x.id === d.id);
          if (s && d.closeTarget && s.type === 'poly') {
            if (d.index === 0) s.pts.shift();
            else s.pts.pop();
            s.closed = true;
          }
          this._pushUndo(d.before);
          this._changed();
          break;
        }
        case 'textclick': {
          const s = this._shapeAt(d.p);
          if (s && s.type === 'text') this.editText(s);
          else if (s && s.type === 'arrow') this.editLabel(s);
          else this.newText(d.p);
          break;
        }
      }
      this._updateCursor(this.hover);
      this.requestRender();
    }

    _wheel(e) {
      e.preventDefault();
      if (!this.image) return;
      const r = this.canvas.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018));
      this.zoomAt(factor, e.clientX - r.left, e.clientY - r.top);
    }

    _dbl(e) {
      if (!this.image) return;
      const p = this.toImage(e);
      // the click that closed a shape may be the first half of a double-click
      const justClosed = performance.now() - this._polyClosedAt < 500;
      if (this.draft && this.draft.type === 'poly') {
        const pts = this.draft.pts;
        // both clicks of the double-click added a point: drop the duplicate
        if (pts.length >= 2 && dist(pts[pts.length - 1], pts[pts.length - 2]) * this.view.scale < 5) pts.pop();
        if (pts.length >= 2) {
          this.finishPoly(false);
          return;
        }
        this.draft = null; // a lone point: treat it as "double-click to type"
      } else if (justClosed) {
        return;
      }
      const s = this._shapeAt(p);
      if (s && s.type === 'text') this.editText(s);
      else if (s && s.type === 'arrow') this.editLabel(s);
      else this.newText(p);
    }

    // ---------- click-to-click lines and shapes ----------

    _polyClick(p, e) {
      if (!this.draft) {
        if (performance.now() - this._polyClosedAt < 350) return;
        this.select(null);
        this.draft = {
          id: uid(),
          type: 'poly',
          pts: [p],
          closed: false,
          color: this.color,
          width: this.strokeWidth,
          fill: this.fill,
        };
      } else {
        const pts = this.draft.pts;
        if (pts.length >= 3 && dist(p, pts[0]) <= this._tol(CLOSE_PX)) {
          this._polyClosedAt = performance.now();
          this.finishPoly(true);
          return;
        }
        pts.push(this._constrain(pts[pts.length - 1], p, e && e.shiftKey));
      }
      this.requestRender();
    }

    finishPoly(close) {
      const s = this.draft;
      this.draft = null;
      if (s && s.type === 'poly' && s.pts.length >= 2) {
        s.closed = !!close && s.pts.length >= 3;
        this._commit(() => this.shapes.push(s));
        this.select(s.id);
      }
      this.requestRender();
    }

    // ---------- text ----------

    newText(p) {
      this._openEditor({ mode: 'new', x: p.x, y: p.y, size: this.fontSize, color: this.color, text: '', align: 'left' });
    }

    editText(s) {
      this.select(s.id);
      this._openEditor({ mode: 'text', id: s.id, x: s.x, y: s.y, size: s.fontSize, color: s.color, text: s.text, align: 'left' });
    }

    /** Text at the tail of an arrow. */
    editLabel(s) {
      this.select(s.id);
      const l = labelLayout(s, s.label || ' ');
      const x = l.align === 'right' ? l.x + l.w : l.align === 'center' ? l.x + l.w / 2 : l.x;
      this._openEditor({ mode: 'label', id: s.id, x, y: l.y, size: s.fontSize, color: s.color, text: s.label || '', align: l.align });
    }

    _openEditor(ed) {
      this.commitText();
      const ta = document.createElement('textarea');
      ta.className = 'text-editor';
      ta.rows = 1;
      ta.spellcheck = false;
      ta.value = ed.text;
      ta.placeholder = ed.mode === 'label' ? 'Label' : 'Type…';
      ta.style.fontFamily = FONT_STACK;
      ta.style.fontWeight = FONT_WEIGHT;
      ta.style.lineHeight = LINE_H;
      ta.style.textAlign = ed.align;
      ed.el = ta;
      this.editing = ed;
      this.host.appendChild(ta);
      this._placeEditor();
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          ev.stopPropagation();
          this.cancelText();
        } else if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          ev.stopPropagation();
          this.commitText();
        }
      });
      ta.addEventListener('blur', () => this.commitText());
      ta.focus();
      ta.select();
      this.requestRender();
    }

    _placeEditor() {
      const ed = this.editing;
      if (!ed) return;
      const s = this.toScreen(ed);
      const st = ed.el.style;
      st.fontSize = `${ed.size * this.view.scale}px`;
      st.color = ed.color;
      st.top = `${s.y}px`;
      st.left = `${s.x}px`;
      st.transform = ed.align === 'right' ? 'translateX(-100%)' : ed.align === 'center' ? 'translateX(-50%)' : 'none';
    }

    commitText() {
      const ed = this.editing;
      if (!ed) return;
      this.editing = null;
      const text = ed.el.value.replace(/\s+$/, '');
      ed.el.remove();
      if (ed.mode === 'new') {
        if (text) {
          const s = { id: uid(), type: 'text', x: ed.x, y: ed.y, text, color: ed.color, fontSize: ed.size };
          this._commit(() => this.shapes.push(s));
          this.select(s.id);
        }
      } else {
        const s = this.shapes.find((x) => x.id === ed.id);
        if (s) {
          const key = ed.mode === 'label' ? 'label' : 'text';
          if (s[key] !== text || s.color !== ed.color || s.fontSize !== ed.size) {
            this._commit(() => {
              if (ed.mode === 'text' && !text) this.shapes = this.shapes.filter((x) => x !== s);
              else s[key] = text;
            });
          }
        }
      }
      this.requestRender();
    }

    cancelText() {
      const ed = this.editing;
      if (!ed) return;
      this.editing = null;
      ed.el.remove();
      this.requestRender();
    }

    // ---------- keyboard ----------

    setSpace(down) {
      this.spaceDown = down;
      this._updateCursor(this.hover);
    }

    /** Returns true when the key was used. */
    key(e) {
      switch (e.key) {
        case 'Escape':
          if (this.draft) this.draft = null;
          else this.select(null);
          this.requestRender();
          return true;
        case 'Enter':
          if (this.draft && this.draft.type === 'poly') {
            this.finishPoly(false);
            return true;
          }
          if (this.selected && this.selected.type === 'text') {
            this.editText(this.selected);
            return true;
          }
          if (this.selected && this.selected.type === 'arrow') {
            this.editLabel(this.selected);
            return true;
          }
          return false;
        case 'Backspace':
        case 'Delete':
          if (this.draft && this.draft.type === 'poly') {
            this.draft.pts.pop();
            if (!this.draft.pts.length) this.draft = null;
            this.requestRender();
            return true;
          }
          return this.deleteSelected();
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          const s = this.selected;
          if (!s) return false;
          const step = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          this._commit(() => translate(s, dx, dy));
          return true;
        }
      }
      return false;
    }

    _updateCursor(p) {
      let cursor = 'default';
      if (!this.image) cursor = 'default';
      else if (this.spaceDown) cursor = 'grab';
      else if (p && !this.draft && this._handleAt(p)) cursor = 'pointer';
      else if (this.tool === 'select') cursor = p && this._shapeAt(p) ? 'move' : 'default';
      else if (this.tool === 'text') cursor = 'text';
      else cursor = 'crosshair';
      this.canvas.style.cursor = cursor;
    }

    // ---------- drawing ----------

    requestRender() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => {
        this._raf = 0;
        this.render();
      });
    }

    render() {
      const ctx = this.ctx;
      const dpr = window.devicePixelRatio || 1;
      const v = this.view;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (!this.image) return;

      ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.tx, dpr * v.ty);

      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 28 * dpr;
      ctx.shadowOffsetY = 8 * dpr;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.iw, this.ih);
      ctx.restore();

      ctx.imageSmoothingEnabled = v.scale * dpr < 3; // crisp pixels when zoomed far in
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.image, 0, 0);

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, this.iw, this.ih);
      ctx.clip();
      const ed = this.editing;
      for (const s of this.shapes) {
        if (ed && ed.id === s.id) {
          if (ed.mode === 'text') continue;
          drawShape(ctx, s, { hideLabel: true });
        } else {
          drawShape(ctx, s);
        }
      }
      if (this.draft) {
        let hover = null;
        if (this.draft.type === 'poly' && this.hover) {
          const pts = this.draft.pts;
          hover = this._constrain(pts[pts.length - 1], this.hover, this._shift);
        }
        drawShape(ctx, this.draft, { hover, draft: true });
      }
      ctx.restore();

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._drawOverlay(ctx);
    }

    _dot(ctx, p, { r = HANDLE_R, fill = '#ffffff', stroke = ACCENT } = {}) {
      const s = this.toScreen(p);
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, TAU);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 1.75;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }

    _drawOverlay(ctx) {
      // while drawing a click-to-click line: show the points and the "close" target
      if (this.draft && this.draft.type === 'poly') {
        const pts = this.draft.pts;
        const canClose = pts.length >= 3 && this.hover && dist(this.hover, pts[0]) <= this._tol(CLOSE_PX);
        pts.forEach((p, i) => {
          if (i === 0 && canClose) this._dot(ctx, p, { r: HANDLE_R + 4, fill: ACCENT, stroke: '#ffffff' });
          else this._dot(ctx, p, { r: i === 0 ? HANDLE_R : 3.5 });
        });
        return;
      }

      const s = this.selected;
      if (!s || (this.editing && this.editing.id === s.id && this.editing.mode === 'text')) return;

      if (s.type === 'text' || s.type === 'pen') {
        const b = shapeBounds(s);
        const a = this.toScreen({ x: b.x, y: b.y });
        const pad = 5;
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = ACCENT;
        ctx.strokeRect(a.x - pad, a.y - pad, b.w * this.view.scale + pad * 2, b.h * this.view.scale + pad * 2);
        ctx.restore();
        return;
      }

      if (s.type === 'rect' || s.type === 'ellipse') {
        const a = this.toScreen({ x: s.x, y: s.y });
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = ACCENT;
        ctx.strokeRect(a.x, a.y, s.w * this.view.scale, s.h * this.view.scale);
        ctx.restore();
      }

      const d = this.drag;
      const closeTarget = d && d.kind === 'handle' ? d.closeTarget : null;
      const hs = handlesOf(s);
      hs.forEach((h, i) => {
        const isEnd = s.type === 'poly' && !s.closed && (i === 0 || i === hs.length - 1);
        if (closeTarget && h === closeTarget) this._dot(ctx, h, { r: HANDLE_R + 4, fill: ACCENT, stroke: '#ffffff' });
        else this._dot(ctx, h, { r: isEnd ? HANDLE_R + 1 : HANDLE_R });
      });
    }

    // ---------- export ----------

    _flatten() {
      const c = document.createElement('canvas');
      c.width = this.iw;
      c.height = this.ih;
      const ctx = c.getContext('2d');
      ctx.drawImage(this.image, 0, 0);
      for (const s of this.shapes) drawShape(ctx, s);
      return c;
    }

    /** The image with every drawing baked in, as a PNG blob. */
    exportBlob() {
      if (!this.image) return Promise.resolve(null);
      return new Promise((resolve) => this._flatten().toBlob(resolve, 'image/png'));
    }

    exportDataURL() {
      return this.image ? this._flatten().toDataURL('image/png') : null;
    }

    /** A small preview of the image with its drawings (for the sidebar). */
    thumbDataURL(maxWidth = 320) {
      if (!this.image) return null;
      const scale = Math.min(1, maxWidth / this.iw);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(this.iw * scale));
      c.height = Math.max(1, Math.round(this.ih * scale));
      const ctx = c.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this._flatten(), 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.85);
    }
  }

  /** A plain white image to draw on when there is no screenshot. */
  Editor.blankBitmap = (width, height) => {
    const c = new OffscreenCanvas(width, height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    return c.transferToImageBitmap();
  };

  window.Editor = Editor;
})();
