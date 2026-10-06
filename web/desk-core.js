/* The Desktop tab's logic without any screen (GupDeskCore): runs in the page and in Node (tests/web/desk-core.test.js).
   Contract: docs/remote-desktop-protocol.md (gupworks repo), stage 1, protocol v1.
     - view math: the whole monitor fitted into the stream area, pinch zoom about the fingers, pan clamped so no gap
       shows, and the mapping from a point on the phone's screen to normalized monitor coordinates (0..1, 5 digits)
     - gestures: tap / pan / pinch / press-and-hold-then-drag, from raw pointer events (timers injectable)
     - drag moves: at most 60 a second, newest only, the last point repeated every 500 ms while the finger is still
     - typing: what the hidden text field changed, as the spec's {del, text} (grapheme clusters), plain quotes/dashes,
       2000-character chunks
     - tap snapping to the PC's AT-SPI targets (a radius in phone points, so it shrinks on the monitor as you zoom in)
     - the PC's text focus -> the phone keyboard (a small state machine), what the hidden field tells the keyboard, and
       the pan/zoom that keeps the focused field in view above the keyboard
     - every message the phone sends on the data channels, in the spec's exact shape
     - words for the host's reasons (input off, session ended) */
(function (root) {
  'use strict';

  const VERSIONS = [1];
  const CAPS = ['monitors', 'input', 'type', 'focus', 'targets', 'stats'];
  const T = {
    HOLD_MS: 380,              // finger still this long, then it moves: a drag (press, move, release on the PC)
    SLOP: 10,                  // pt a finger may wander and still be a tap / a hold
    DOUBLE_MS: 400, DOUBLE_PT: 14,   // a second tap this soon and this close lands on the first one's point
    MOVE_MS: 1000 / 60,        // drag_move at most 60 a second
    REPEAT_MS: 500,            // finger down but still: repeat the last drag_move
    SWITCH_GUARD_MS: 300,      // no tap / drag_start until this long after the new monitor's `monitors`
    TEXT_MAX: 2000,            // type.text per message
    MSG_MAX: 64 * 1024,
    MAX_PX_PER_VIDEO_PX: 4,    // deepest zoom: one monitor pixel = 4 phone points
    SNAP_PT: 12,               // a tap snaps to a target whose edge is at most this far from the finger, on the phone's screen
    SNAP_SMALL_PT: 64,         // a snapped button / link no bigger than this on screen is clicked in its centre
    SNAP_INSET_PT: 3,          // otherwise at the nearest point this far inside it (text fields, sliders, big things)
    TARGETS_MAX: 4000,         // items kept from one `targets` message (the PC sends at most ~600)
    VIEW_MS: 500,              // `view` at most twice a second, once zoom/pan settle
    VIEW_SETTLE_MS: 250,
    READ_PT: 30,               // a focused one-line field is zoomed to about this tall on the phone...
    READ_MIN_PT: 16,           // ...when it shows smaller than this (or not wholly) above the keyboard
    REVEAL_PAD: 12,            // pt kept around a revealed field
  };

  const round5 = v => Math.round(v * 1e5) / 1e5;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------------------------------------------------------------- view: fit, zoom, pan, mapping
  /** A view of a vw x vh monitor picture in a w x h area. fit = the scale showing the whole monitor; z = zoom on top
      of it (1 = whole monitor); tx, ty = where the picture's top-left corner is in the area. */
  function makeView(area, vw, vh) {
    const v = { w: area.w, h: area.h, vw: vw || 16, vh: vh || 9, fit: 1, z: 1, tx: 0, ty: 0 };
    v.fit = Math.min(v.w / v.vw, v.h / v.vh);
    return clampView(v);
  }
  const scaleOf = v => v.fit * v.z;
  function maxZoom(v) { return Math.max(1, T.MAX_PX_PER_VIDEO_PX / v.fit); }
  /** keeps the zoom in range and the picture where it belongs: centred while it's smaller than the area, else no gap */
  function clampView(v) {
    v.z = clamp(v.z, 1, maxZoom(v));
    const cw = v.vw * scaleOf(v), ch = v.vh * scaleOf(v);
    v.tx = cw <= v.w ? (v.w - cw) / 2 : clamp(v.tx, v.w - cw, 0);
    v.ty = ch <= v.h ? (v.h - ch) / 2 : clamp(v.ty, v.h - ch, 0);
    return v;
  }
  /** zoom by factor, keeping the monitor point under (px, py) where it is */
  function zoomAt(v, factor, px, py) {
    const s0 = scaleOf(v);
    const mx = (px - v.tx) / s0, my = (py - v.ty) / s0;
    v.z = clamp(v.z * factor, 1, maxZoom(v));
    const s1 = scaleOf(v);
    v.tx = px - mx * s1;
    v.ty = py - my * s1;
    return clampView(v);
  }
  function panBy(v, dx, dy) { v.tx += dx; v.ty += dy; return clampView(v); }
  /** a new area (rotation, keyboard): same zoom, same monitor point in the middle */
  function resize(v, area, vw, vh) {
    const s0 = scaleOf(v);
    const cx = (v.w / 2 - v.tx) / s0, cy = (v.h / 2 - v.ty) / s0;
    const n = makeView(area, vw || v.vw, vh || v.vh);
    n.z = v.z;
    const sameMonitor = n.vw === v.vw && n.vh === v.vh;
    const s1 = scaleOf(n);
    n.tx = n.w / 2 - (sameMonitor ? cx : n.vw / 2) * s1;
    n.ty = n.h / 2 - (sameMonitor ? cy : n.vh / 2) * s1;
    return clampView(n);
  }
  /** a point in the area -> normalized monitor coordinates (5 digits, clamped to 0..1); inside: on the picture at all */
  function toNorm(v, px, py) {
    const s = scaleOf(v);
    const x = (px - v.tx) / (v.vw * s), y = (py - v.ty) / (v.vh * s);
    return { x: round5(clamp(x, 0, 1)), y: round5(clamp(y, 0, 1)), inside: x >= -1e-9 && x <= 1 + 1e-9 && y >= -1e-9 && y <= 1 + 1e-9 };
  }
  function toArea(v, nx, ny) {
    const s = scaleOf(v);
    return { x: v.tx + nx * v.vw * s, y: v.ty + ny * v.vh * s };
  }
  /** the part of the monitor on screen, normalized [x, y, w, h] (the `view` message, the minimap) */
  function visibleRect(v) {
    const a = toNorm(v, 0, 0), b = toNorm(v, v.w, v.h);
    return [a.x, a.y, round5(b.x - a.x), round5(b.y - a.y)];
  }

  // ---------------------------------------------------------------- gestures
  /** Raw pointers in, gestures out. opts: {holdMs, slop, now(), setTimer(fn, ms), clearTimer(t)}; on: {tap(x, y),
      panStart(), pan(dx, dy), pinch(factor, cx, cy, dx, dy), press(x, y) (held still: the drag starts here),
      dragMove(x, y), dragEnd(x, y), dragCancel(), end()}. A tap is a short touch that stays within the slop; moving
      before the hold time pans; two fingers pinch (and pan by their midpoint); holding still past the hold time
      presses, and everything after that until the finger lifts is the drag. */
  function createGestures(on, opts) {
    opts = opts || {};
    const holdMs = opts.holdMs || T.HOLD_MS, slop = opts.slop || T.SLOP;
    const now = opts.now || (() => Date.now());
    const setT = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearT = opts.clearTimer || (t => clearTimeout(t));
    const pts = new Map();          // id -> {x, y, x0, y0}
    let mode = 'idle';              // idle | pending | pan | pinch | drag | done
    let timer = null, t0 = 0, last = null, pinchD = 0, pinchMid = null, primary = null;
    const signal = (name, ...a) => { if (on[name]) on[name](...a); };

    function stopHold() { if (timer !== null) { clearT(timer); timer = null; } }
    function two() { const [a, b] = Array.from(pts.values()); return { a, b }; }
    function mid() { const { a, b } = two(); return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }; }

    function down(id, x, y) {
      pts.set(id, { x, y, x0: x, y0: y });
      if (pts.size === 1 && (mode === 'idle' || mode === 'done')) {
        mode = 'pending'; t0 = now(); last = { x, y }; primary = id;
        stopHold();
        timer = setT(() => {
          timer = null;
          if (mode !== 'pending' || pts.size !== 1) return;
          const p = pts.get(primary);
          mode = 'drag';
          signal('press', p.x0, p.y0);
          if (p.x !== p.x0 || p.y !== p.y0) signal('dragMove', p.x, p.y);
        }, holdMs);
        return;
      }
      if (pts.size === 2 && (mode === 'pending' || mode === 'pan')) {
        stopHold();
        mode = 'pinch';
        const m = mid();
        pinchD = m.d; pinchMid = m;
        return;
      }
      // a second finger during a drag, a third finger: ignored
    }

    function move(id, x, y) {
      const p = pts.get(id);
      if (!p) return;
      p.x = x; p.y = y;
      if (mode === 'pending') {
        if (Math.hypot(x - p.x0, y - p.y0) > slop) {
          stopHold();
          mode = 'pan';
          signal('panStart');
          signal('pan', x - last.x, y - last.y);
          last = { x, y };
        }
      } else if (mode === 'pan' && pts.size === 1) {
        signal('pan', x - last.x, y - last.y);
        last = { x, y };
      } else if (mode === 'pinch' && pts.size === 2) {
        const m = mid();
        const f = pinchD > 0 && m.d > 0 ? m.d / pinchD : 1;
        signal('pinch', f, m.x, m.y, m.x - pinchMid.x, m.y - pinchMid.y);
        pinchD = m.d; pinchMid = m;
      } else if (mode === 'drag' && id === primary) {
        signal('dragMove', x, y);
      }
    }

    function up(id, x, y) {
      const p = pts.get(id);
      if (!p) return;
      if (x !== undefined) { p.x = x; p.y = y; }
      pts.delete(id);
      if (mode === 'pending') {
        stopHold();
        mode = 'done';
        if (Math.hypot(p.x - p.x0, p.y - p.y0) <= slop) signal('tap', p.x0, p.y0, now() - t0);
      } else if (mode === 'drag') {
        if (id === primary) { mode = 'done'; signal('dragEnd', p.x, p.y); }   // other fingers changed nothing
        return finish();
      } else if (mode === 'pinch' && pts.size === 1) {
        mode = 'pan';                                 // one finger left: it pans on, it never taps
        const q = pts.values().next().value;
        last = { x: q.x, y: q.y };
      }
      finish();
    }

    function finish() {
      if (pts.size === 0) { stopHold(); if (mode !== 'idle') { mode = 'idle'; signal('end'); } }
    }

    /** the system took the touch (an alert, the app leaving): a drag is cancelled, nothing taps */
    function cancel() {
      stopHold();
      const wasDrag = mode === 'drag';
      pts.clear();
      mode = 'idle';
      if (wasDrag) signal('dragCancel');
      signal('end');
    }

    return { down, move, up, cancel, get mode() { return mode; }, get fingers() { return pts.size; } };
  }

  // ---------------------------------------------------------------- drag moves: newest only, 60 a second, repeats
  /** send(x, y) is called with the newest point, at most every MOVE_MS, and again every REPEAT_MS while nothing new
      comes (the PC lets go of a drag that hears nothing for 3 s). */
  function createMover(send, opts) {
    opts = opts || {};
    const now = opts.now || (() => Date.now());
    const setT = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearT = opts.clearTimer || (t => clearTimeout(t));
    const every = opts.moveMs || T.MOVE_MS, repeat = opts.repeatMs || T.REPEAT_MS;
    let lastAt = -Infinity, point = null, pending = false, timer = null, live = false;

    function schedule(ms) { if (timer !== null) clearT(timer); timer = setT(tick, ms); }
    function tick() {
      timer = null;
      if (!live || !point) return;
      fire();
    }
    function fire() {
      lastAt = now();
      pending = false;
      send(point.x, point.y);
      schedule(repeat);
    }
    return {
      start(x, y) { live = true; point = { x, y }; lastAt = now(); pending = false; schedule(repeat); },
      move(x, y) {
        if (!live) return;
        point = { x, y };
        const wait = lastAt + every - now();
        if (wait <= 0) fire();
        else if (!pending) { pending = true; schedule(wait); }
      },
      stop() { live = false; pending = false; if (timer !== null) { clearT(timer); timer = null; } },
      get live() { return live; },
    };
  }

  // ---------------------------------------------------------------- typing
  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  /** characters as people see them (Swift's String.count): what one Backspace removes */
  function graphemes(s) {
    if (!s) return [];
    if (segmenter) return Array.from(segmenter.segment(s), x => x.segment);
    return Array.from(s);
  }
  /** the phone keyboard's smart punctuation back to what was typed: plain quotes, -- for the em dash */
  function plain(s) {
    return String(s || '')
      .replace(/[‘’‚‛′]/g, "'")
      .replace(/[“”„‟″]/g, '"')
      .replace(/—/g, '--')
      .replace(/–/g, '-')
      .replace(/\r\n?/g, '\n')
      .replace(/ /g, ' ');
  }
  /** what changed from prev to next, as Backspaces then text: {del, text}; null when nothing did */
  function diffText(prev, next) {
    const a = graphemes(prev), b = graphemes(next);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const del = a.length - i, text = b.slice(i).join('');
    return del || text ? { del, text } : null;
  }
  /** text in pieces of at most max code points (so at most max characters however the PC counts), never splitting
      a character */
  function chunkText(text, max) {
    max = max || T.TEXT_MAX;
    const out = [];
    let cur = '', n = 0;
    for (const g of graphemes(text)) {
      const k = Array.from(g).length;
      if (cur && n + k > max) { out.push(cur); cur = ''; n = 0; }
      cur += g; n += k;
    }
    if (cur) out.push(cur);
    return out;
  }

  // ---------------------------------------------------------------- targets: tap snapping (cap `targets`)
  const ROLES = ['button', 'link', 'check', 'radio', 'toggle', 'menu', 'menuitem', 'tab', 'combo', 'text', 'slider', 'item', 'other'];
  // a missed tap snaps to the centre of these when they're small; anything else (text fields, sliders, list items, big
  // things) gets the nearest point inside, because where it's clicked matters there (the caret, the slider's value)
  const CENTRE_ROLES = new Set(['button', 'link', 'check', 'radio', 'toggle', 'menu', 'menuitem', 'tab', 'combo']);

  /** the PC's `targets` message -> {m, gen, source, truncated, items: [{x, y, w, h, role}]}; bad items are dropped */
  function parseTargets(m) {
    if (!m || typeof m.m !== 'string' || !Array.isArray(m.items)) return null;
    const items = [];
    for (const it of m.items) {
      if (items.length >= T.TARGETS_MAX) break;
      if (!Array.isArray(it) || it.length < 4) continue;
      const [x, y, w, h] = it;
      if (![x, y, w, h].every(n => typeof n === 'number' && isFinite(n)) || w <= 0 || h <= 0) continue;
      items.push({ x, y, w, h, role: ROLES.includes(it[4]) ? it[4] : 'other' });
    }
    return { m: m.m, gen: typeof m.gen === 'number' ? m.gen : 0, source: m.source === 'none' ? 'none' : 'atspi', truncated: !!m.truncated, items };
  }

  /** Where a tap at (px, py) in the area should click: {x, y (normalized, 5 digits), target (the item or null), snapped
      (the point moved), dist (pt from the finger to the target's edge)}. The finger on a target clicks right there
      (smallest target wins; a role `other` is often a container, so a real target close by beats it); a finger just
      off one (within SNAP_PT on the phone's screen, so less of the monitor the more you zoom in) clicks the nearest
      target: a small button / link in its centre, anything else at the nearest point inside. Nothing near: the raw
      point. */
  function snapTap(v, px, py, items, opts) {
    opts = opts || {};
    const grow = opts.growPt != null ? opts.growPt : T.SNAP_PT;
    const raw = toNorm(v, px, py);
    const out = { x: raw.x, y: raw.y, target: null, snapped: false, dist: null };
    if (!items || !items.length || !raw.inside) return out;
    const s = scaleOf(v), W = v.vw * s, H = v.vh * s;      // the picture's size on the phone, pt
    const fx = (px - v.tx) / W, fy = (py - v.ty) / H;
    let best = null;
    for (const t of items) {
      const dx = Math.max(t.x - fx, 0, fx - (t.x + t.w)) * W;
      const dy = Math.max(t.y - fy, 0, fy - (t.y + t.h)) * H;
      const d = Math.hypot(dx, dy);
      if (d > grow) continue;
      const area = t.w * t.h;
      // rank: on it (not a container) < near it < a container under the finger; then nearer; then smaller
      const rank = d === 0 ? (t.role === 'other' ? 2 : 0) : 1;
      if (!best || rank < best.rank || (rank === best.rank && (d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && area < best.area))))
        best = { t, d, rank, area };
    }
    if (!best) return out;
    const t = best.t;
    out.target = t;
    out.dist = Math.round(best.d * 10) / 10;
    if (best.d === 0) return out;                           // the finger is on it: click right there
    let nx, ny;
    if (CENTRE_ROLES.has(t.role) && t.w * W <= T.SNAP_SMALL_PT && t.h * H <= T.SNAP_SMALL_PT) { nx = t.x + t.w / 2; ny = t.y + t.h / 2; }
    else {
      const ix = Math.min(T.SNAP_INSET_PT / W, t.w / 2), iy = Math.min(T.SNAP_INSET_PT / H, t.h / 2);
      nx = clamp(fx, t.x + ix, t.x + t.w - ix);
      ny = clamp(fy, t.y + iy, t.y + t.h - iy);
    }
    out.x = round5(clamp(nx, 0, 1));
    out.y = round5(clamp(ny, 0, 1));
    out.snapped = true;
    return out;
  }

  /** the targets worth drawing: the ones at least partly in view (at most max), as area rects {x, y, w, h, role} */
  function targetsInView(v, items, max) {
    const out = [];
    if (!items) return out;
    const s = scaleOf(v), W = v.vw * s, H = v.vh * s;
    for (const t of items) {
      const x = v.tx + t.x * W, y = v.ty + t.y * H, w = t.w * W, h = t.h * H;
      if (x + w < 0 || y + h < 0 || x > v.w || y > v.h) continue;
      out.push({ x, y, w, h, role: t.role });
      if (out.length >= (max || 300)) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- the PC's text focus -> the phone keyboard
  const HINTS = ['text', 'number', 'email', 'url', 'search'];
  /** the PC's `focus` message -> {m, rect ([x, y, w, h] or null), multiline, secret, hint, app}; null for kind none */
  function parseFocus(m) {
    if (!m || m.kind !== 'text') return null;
    const r = m.rect;
    const rect = Array.isArray(r) && r.length === 4 && r.every(n => typeof n === 'number' && isFinite(n)) && r[2] > 0 && r[3] > 0 ? r.slice() : null;
    return { m: typeof m.m === 'string' ? m.m : null, rect, multiline: !!m.multiline, secret: !!m.secret,
             hint: HINTS.includes(m.hint) ? m.hint : 'text', app: typeof m.app === 'string' ? m.app : '' };
  }
  const focusKey = f => f ? JSON.stringify([f.m, f.rect, f.multiline, f.secret, f.hint, f.app]) : '';
  const sameKind = (a, b) => !!a && !!b && a.secret === b.secret && a.hint === b.hint && a.multiline === b.multiline;

  /** What the hidden field tells the phone keyboard for a PC field (null: opened by hand, no field known). A secret
      field is a password input (no autocorrect, suggestions or dictation; iOS caches nothing). */
  function keyboardAttrs(f) {
    const hint = f ? f.hint : 'text';
    const words = hint === 'text' || hint === 'search';
    return {
      secret: !!(f && f.secret),
      inputmode: { text: 'text', number: 'decimal', email: 'email', url: 'url', search: 'search' }[hint],
      enterkeyhint: f && !f.multiline ? (hint === 'search' ? 'search' : 'go') : 'enter',
      autocorrect: words ? 'on' : 'off',
      autocapitalize: words && hint !== 'search' ? 'sentences' : 'off',
      spellcheck: words ? 'true' : 'false',
    };
  }

  /** The keyboard's state machine. ctx = {active: the monitor shown, canType: live, input on and the `type` cap}.
      Every call returns {change: 'open' | 'close' | 'refocus' (open, but the field kind changed: secret / hint /
      multiline) | 'reset' (open, a different PC field: start the typing buffer over) | null, open, by: 'auto' | 'user',
      field: the PC's focused field on the shown monitor (or null), elsewhere: the monitor a field got focus on when it
      isn't the one shown}.
        pcFocus(msg, ctx)   the PC's `focus`: a text field on the shown monitor opens it (by 'auto') unless the owner
                            put the keyboard away for that same field; none closes what 'auto' opened (one the owner
                            opened stays)
        update(ctx)         the monitor, input or link changed: 'auto' closes when typing can't reach the field, opens
                            again when it can
        userOpen(ctx) / userClose()   the keyboard button / the keyboard went away (the owner dismissed it)
        tapText(ctx, onFocused)   a tap on the focused field (or another text target) while the keyboard is down:
                            open it now, inside the tap, because the PC sends no new focus for a field that already
                            has it (another field: no field known until the PC's focus for it comes)
        reset()             the viewer closed */
  function createFocusKeyboard() {
    const s = { focus: null, open: false, by: null, dismissed: null, ctx: { active: null, canType: false } };
    const here = () => !!(s.focus && s.focus.m === s.ctx.active);
    const out = change => ({ change, open: s.open, by: s.by, field: here() ? s.focus : null,
                              elsewhere: s.focus && s.focus.m && !here() ? s.focus.m : null });
    const take = ctx => { if (ctx) s.ctx = { active: ctx.active || null, canType: !!ctx.canType }; };
    function open(by) { s.open = true; s.by = by; return out('open'); }
    function close() { s.open = false; s.by = null; return out('close'); }
    return {
      pcFocus(m, ctx) {
        take(ctx);
        const prev = s.focus, f = parseFocus(m);
        const moved = focusKey(prev) !== focusKey(f);
        s.focus = f;
        if (!f) {
          s.dismissed = null;
          if (s.open && s.by === 'auto') return close();
          return out(s.open && moved ? 'reset' : null);
        }
        if (!here() || !s.ctx.canType) {
          if (s.open && s.by === 'auto') return close();
          return out(s.open && moved ? 'reset' : null);
        }
        if (s.open) return out(!moved ? null : sameKind(prev, f) ? 'reset' : 'refocus');
        if (s.dismissed && s.dismissed === focusKey(f)) return out(null);
        s.dismissed = null;
        return open('auto');
      },
      update(ctx) {
        take(ctx);
        const want = here() && s.ctx.canType;
        if (s.open && s.by === 'auto' && !want) return close();
        if (!s.open && want && s.dismissed !== focusKey(s.focus)) return open('auto');
        return out(null);
      },
      userOpen(ctx) { take(ctx); return s.open ? out(null) : open('user'); },
      userClose() {
        if (!s.open) return out(null);
        s.dismissed = focusKey(s.focus) || null;
        return close();
      },
      tapText(ctx, onFocused) {
        take(ctx);
        if (s.open || !s.ctx.canType) return out(null);
        s.dismissed = null;
        if (!onFocused) s.focus = null;                     // the click moves the PC's focus: its new field comes next
        return open('auto');
      },
      reset() { Object.assign(s, { focus: null, open: false, by: null, dismissed: null }); return out(null); },
      get state() { return { focus: s.focus, open: s.open, by: s.by, dismissed: s.dismissed }; },
    };
  }

  /** The view moved so a PC field (normalized rect) shows in the area (the stream above the keyboard): a field that
      already shows whole and readable (a multi-line one: filling half the view) stays put; else a one-line field is
      zoomed to about READ_PT tall (the owner's deeper zoom kept), a multi-line one to the area's width, never more
      than fits, then centred (a field taller or wider than the area: its top / left edge). Returns a new view. */
  function revealRect(v, rect, opts) {
    opts = opts || {};
    const pad = opts.pad != null ? opts.pad : T.REVEAL_PAD;
    const n = Object.assign({}, v);
    const [rx, ry, rw, rh] = rect;
    const on = (sc, tx, ty) => ({ x: tx + rx * n.vw * sc, y: ty + ry * n.vh * sc, w: rw * n.vw * sc, h: rh * n.vh * sc });
    const s0 = scaleOf(n), a = on(s0, n.tx, n.ty);
    const whole = a.x >= -0.5 && a.y >= -0.5 && a.x + a.w <= n.w + 0.5 && a.y + a.h <= n.h + 0.5;
    const ix = Math.max(0, Math.min(a.x + a.w, n.w) - Math.max(a.x, 0)), iy = Math.max(0, Math.min(a.y + a.h, n.h) - Math.max(a.y, 0));
    if (opts.multiline ? (whole || ix * iy >= n.w * n.h / 2) : (whole && a.h >= T.READ_MIN_PT)) return n;
    const fitW = (n.w - 2 * pad) / (rw * n.vw), fitH = (n.h - 2 * pad) / (rh * n.vh);
    const want = opts.multiline ? fitW : Math.min(Math.max(T.READ_PT / (rh * n.vh), s0), fitW, fitH);
    n.z = clamp(want / n.fit, 1, maxZoom(n));
    const s1 = scaleOf(n), b = on(s1, 0, 0);
    n.tx = b.w <= n.w - 2 * pad ? (n.w - b.w) / 2 - b.x : pad - b.x;
    n.ty = b.h <= n.h - 2 * pad ? (n.h - b.h) / 2 - b.y : pad - b.y;
    return clampView(n);
  }

  // ---------------------------------------------------------------- messages (phone -> PC), the spec's shapes
  const msg = {
    hello(o) {
      o = o || {};
      const m = { t: 'hello', v: 1, versions: VERSIONS.slice(), caps: CAPS.slice(), app: String(o.app || '1.0') };
      if (o.viewport) m.viewport = { w: Math.round(o.viewport.w), h: Math.round(o.viewport.h), scale: o.viewport.scale || 1 };
      m.video = { max_w: (o.video && o.video.max_w) || 2560, max_h: (o.video && o.video.max_h) || 1440 };
      return m;
    },
    tap(id, m, x, y, count) {
      const out = { t: 'tap', id, m, x: round5(x), y: round5(y) };
      if (count && count > 1) out.count = count;
      return out;
    },
    dragStart(id, m, drag, x, y) { return { t: 'drag_start', id, m, drag, x: round5(x), y: round5(y) }; },
    dragMove(m, drag, seq, x, y) { return { t: 'drag_move', m, drag, seq, x: round5(x), y: round5(y) }; },
    dragEnd(id, m, drag, x, y) { return { t: 'drag_end', id, m, drag, x: round5(x), y: round5(y) }; },
    type(id, del, text) { return { t: 'type', id, del: Math.max(0, del | 0), text: String(text || '') }; },
    selectMonitor(id, monitor) { return { t: 'select_monitor', id, monitor }; },
    view(m, rect) { return { t: 'view', m, rect: rect.map(round5) }; },
    ping(ts) { return { t: 'ping', ts: Math.round(ts) }; },
    pong(ts) { return { t: 'pong', ts }; },
    bye(reason) { return { t: 'bye', reason }; },
    stats(o) {
      const out = { t: 'stats' };
      for (const k of ['fps', 'rtt_ms', 'jitter_buffer_ms', 'decode_ms', 'frames_dropped', 'w', 'h']) {
        if (typeof o[k] === 'number' && isFinite(o[k])) out[k] = Math.round(o[k] * 10) / 10;
      }
      return out;
    },
  };
  /** the encoded message, or null when it would break the spec's size limits */
  function encode(m) {
    if (m.t === 'type' && Array.from(m.text).length > T.TEXT_MAX) return null;
    const s = JSON.stringify(m);
    return new TextEncoder().encode(s).length <= T.MSG_MAX ? s : null;
  }

  // ---------------------------------------------------------------- words for the host's reasons
  const INPUT_OFF = {
    disabled_on_pc: 'paused on the PC (Resume on the PC\'s badge)',
    locked: 'the PC\'s screen is locked',
    no_indicator: 'the PC can\'t show its "phone connected" badge',
    unavailable: 'the PC\'s remote control has no keyboard or mouse (gw desktop grant at the PC)',
  };
  function inputOffText(reason) {
    return INPUT_OFF[reason] ? 'Input is off: ' + INPUT_OFF[reason] : 'Input is off';
  }
  /** a session that ended: {title, text, retry: try again by itself (a dropped link), again: a try-again button} */
  function endedText(reason, host) {
    const pc = host || 'the PC';
    const R = {
      ended_on_pc: ['ended on the PC', `Someone pressed Disconnect on ${pc}.`, false, true],
      replaced: ['opened somewhere else', 'A newer session started, so this one closed.', false, true],
      revoked: ['pairing revoked', `${pc} doesn't know this phone anymore. Pair again to use the desktop.`, false, false],
      capture_lost: ['no monitor', `${pc} has no monitor to show right now.`, false, true],
      host_stopping: ['the PC stopped the stream', `The remote desktop on ${pc} is restarting, suspending or logging out.`, true, true],
      timeout: ['couldn\'t reach the PC', `The stream to ${pc} didn't open in time. Is Tailscale on on this phone?`, true, true],
      error: ['the stream broke', `Something went wrong on the way to ${pc}.`, true, true],
      dropped: ['disconnected', `The stream dropped and ${pc} doesn't answer on Tailscale.`, true, true],
      version: ['update needed', `This app and ${pc} speak different versions of the remote desktop.`, false, false],
    };
    const r = R[reason] || R.error;
    return { title: r[0], text: r[1], retry: r[2], again: r[3] };
  }

  /** "3440×1440 · ultrawide · 144 Hz" */
  function monitorSpec(m) {
    if (!m) return '';
    const parts = [];
    if (m.w && m.h) {
      const s = m.scale && m.scale !== 1 ? m.scale : 1;
      parts.push(`${Math.round(m.w * s)}×${Math.round(m.h * s)}`);
      if (m.w / m.h > 2.1) parts.push('ultrawide');
    }
    if (m.refresh) parts.push(Math.round(m.refresh) + ' Hz');
    return parts.join(' · ');
  }

  const GupDeskCore = {
    VERSIONS, CAPS, T, round5, clamp,
    makeView, clampView, zoomAt, panBy, resize, toNorm, toArea, visibleRect, scaleOf, maxZoom,
    createGestures, createMover,
    ROLES, parseTargets, snapTap, targetsInView, parseFocus, focusKey, keyboardAttrs, createFocusKeyboard, revealRect,
    graphemes, plain, diffText, chunkText,
    msg, encode, inputOffText, endedText, monitorSpec,
  };
  root.GupDeskCore = GupDeskCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = GupDeskCore;
})(typeof window !== 'undefined' ? window : globalThis);
