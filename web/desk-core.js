/* The Desktop tab's logic without any screen (GupDeskCore): runs in the page and in Node (tests/web/desk-core.test.js).
   Contract: docs/remote-desktop-protocol.md (gupworks repo), stage 1, protocol v1.
     - view math: the whole monitor fitted into the stream area, pinch zoom about the fingers, pan clamped so no gap
       shows, and the mapping from a point on the phone's screen to normalized monitor coordinates (0..1, 5 digits)
     - gestures: tap / pan / pinch / press-and-hold-then-drag, from raw pointer events (timers injectable)
     - drag moves: at most 60 a second, newest only, the last point repeated every 500 ms while the finger is still
     - typing: what the hidden text field changed, as the spec's {del, text} (grapheme clusters), plain quotes/dashes,
       2000-character chunks
     - every message the phone sends on the data channels, in the spec's exact shape
     - words for the host's reasons (input off, session ended) */
(function (root) {
  'use strict';

  const VERSIONS = [1];
  // stage 1, slice 1: no focus / targets yet (keyboard auto-pop and tap snapping are the next slice)
  const CAPS = ['monitors', 'input', 'type', 'stats'];
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
    graphemes, plain, diffText, chunkText,
    msg, encode, inputOffText, endedText, monitorSpec,
  };
  root.GupDeskCore = GupDeskCore;
  if (typeof module !== 'undefined' && module.exports) module.exports = GupDeskCore;
})(typeof window !== 'undefined' ? window : globalThis);
