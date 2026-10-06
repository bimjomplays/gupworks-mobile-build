/* The Desktop tab (look D, mockups/gen.py screens 7-12): the phone's remote desktop, stage 1.
   Home = the monitor picker (or why the PC can't stream: never a dialog on the PC); "view" runs Face ID, then
   GupDeskLink opens the session (signaling through GupAPI / the shell's bridge, WebRTC on the tailnet) and the viewer
   shows the whole monitor: pinch zoom, one-finger pan when zoomed, minimap + hint, tap = click, hold then move = drag,
   switch monitor, keyboard button (the phone keyboard types into the PC), input-off reasons, PC ended / dropped /
   reconnect, and the app lock (the session ends on the way to the background; Face ID resumes it).
   Slice 2 (cap focus + targets): taps snap to the PC's AT-SPI targets near the finger (outlines show while a finger is
   down, the hit one lights up, mockup 8), and the phone keyboard opens by itself when a PC text field gets focus
   (mockup 9: the field outlined and panned / zoomed into view above the keyboard; a password field gets a password
   input), closing again when the focus leaves it or the owner puts it away.
     GupDesk.show() / hide()          the tab came into / left view
     GupDesk.lock() / unlocked()      the shell locked (app to the background) / Face ID passed again
     GupDesk.reset()                  unpaired / pairing changed
     GupDesk.state                    for tests
   Not in stage 1: window list, fit-to-phone, key bar, trackpad, right-click, scroll, clipboard. */
(function (root) {
  'use strict';
  const API = root.GupAPI, H = root.GupHooks, C = root.GupDeskCore, Link = root.GupDeskLink;
  const { ic, esc, toast, sheet } = root.GupUI;
  const $ = id => document.getElementById(id);
  const SENTINEL = '​';          // the hidden field is never empty, so Backspace always reaches us
  const RETRY_MS = 10000;
  const APP_VERSION = '1.0';

  const D = {
    shown: false,
    phase: 'home',                    // home | connecting | viewer | disconnected
    status: null, statusErr: null, statusAt: 0, checking: false,
    monitors: [], active: null, lastMonitor: null, host: null, thumbs: {},
    link: null, connecting: null,     // connecting: {monitor, steps}
    ended: null,                      // {reason, title, text, retry, again, at}
    retryTimer: null, retryCount: 0, retrying: false,
    resume: null,                     // {monitor} after the app lock closed a session
    view: null, input: { enabled: true, reason: null }, indicator: true,
    guardUntil: 0, switching: null, rtt: null, fps: null, stalled: false,
    gestures: null, mover: null, drag: null, dragSeq: 0, dragCount: 0, lastTap: null,
    typing: { sent: '', composing: false, busy: Promise.resolve() },
    hintUntil: 0, sent: [],
    targets: null,                    // the PC's last `targets` ({m, gen, items}), only used while m is the monitor shown
    tgtShown: false, tgtTimer: null, viewTimer: null, viewAt: -Infinity, viewSent: '',
    // the keyboard: the focus state machine, which hidden field (secret = the password one), who opened it, the field
    // to keep in view (reveal), whether the phone keyboard failed to come up without a tap (needTap)
    kb: { sm: C.createFocusKeyboard(), secret: false, by: null, field: null, token: 0, quiet: false, needTap: false,
          reveal: null, revealTimer: null, checkTimer: null, atUntil: 0, atTimer: null },
  };
  const KB_CHECK_MS = 900;            // the phone keyboard should be up by then; else a "tap to type" chip
  const AT_MS = 3000;                 // "keyboard opened for you" stays this long
  const now = () => performance.now();

  // ================================================================= tab screens (home, connecting, disconnected)
  function hostName() { return D.host || (root.GupApp && root.GupApp.state.phone && root.GupApp.state.phone.host) || 'your PC'; }

  function thumb(m) {
    const ratio = m && m.w && m.h ? `${m.w}/${m.h}` : '16/9';
    const img = m && D.thumbs[m.id] ? `<img src="${D.thumbs[m.id]}" alt="">` : '<i class="w1"></i><i class="w2"></i><i class="w3"></i>';
    return `<div class="mth" style="aspect-ratio:${ratio}">${img}<b class="pn"></b></div>`;
  }

  function card(m, i) {
    const last = m ? m.id === D.lastMonitor : true;
    const tag = !m ? '' : (m.primary ? ' <span class="chip c-x mini">main</span>' : '') + (last ? ' <span class="chip c-g mini">last viewed</span>' : '');
    const name = m ? esc(m.id) : 'main monitor';
    const spec = m ? esc([C.monitorSpec(m), m.label].filter(Boolean).join(' · ')) : 'the PC shows its last used, else its main monitor';
    return `<div class="g mc${last ? ' sel' : ''}" data-mon="${m ? esc(m.id) : ''}" data-i="${i}">${thumb(m)}` +
      `<div class="ft"><div class="grow"><div class="t1">${name}${tag}</div><div class="t2">${spec}</div></div>` +
      `<button class="btn ${last ? 'p' : 'q'}" type="button" data-view="${m ? esc(m.id) : ''}">view ${ic('chev', 16, 2.4)}</button></div></div>`;
  }

  function header(chip, sub) {
    return `<div class="dth"><h1>desktop</h1>${chip}</div><div class="dtsub">${sub}</div>`;
  }

  function render() {
    if (!D.shown && D.phase !== 'viewer') return;
    const body = $('d-body');
    $('desk').classList.toggle('hidden', D.phase !== 'viewer');
    document.documentElement.classList.toggle('desk-on', D.phase === 'viewer');
    if (D.phase === 'viewer') return;
    if (D.phase === 'connecting') return renderConnecting(body);
    if (D.phase === 'disconnected') return renderDisconnected(body);
    renderHome(body);
  }

  function renderHome(body) {
    const app = root.GupApp ? root.GupApp.state : {};
    const host = esc(hostName());
    if (!API.configured || app.conn === 'unpaired' || app.conn === 'unauthorized') {
      const again = app.conn === 'unauthorized';
      body.innerHTML = header('<span class="chip c-a dot">not paired</span>', 'pair this phone first') +
        `<div class="g notice"><b>›</b> ${again ? 'The PC doesn\'t know this phone anymore.' : 'This phone isn\'t paired with your PC yet.'}` +
        `<br><button class="btn q" data-pair type="button">${again ? 'pair again' : 'pair with your PC'}</button></div>`;
      return;
    }
    const s = D.status;
    if (!s && D.statusErr) {
      body.innerHTML = header('<span class="chip c-r dot">offline</span>', `${host} · not answering`) +
        `<div class="g notice"><b>›</b> Can't reach ${host}. Is Tailscale on on this phone, and the PC awake?` +
        `<br><button class="btn q" data-check type="button">check again</button></div>`;
      return;
    }
    if (!s) {
      body.innerHTML = header('<span class="chip c-x dot">checking</span>', `${host} · tailscale`) + '<div class="g notice"><b>›</b> Asking the PC…</div>';
      return;
    }
    if (!s.available) {
      body.innerHTML = header(`<span class="chip c-a dot">${host}</span>`, 'remote desktop unavailable') +
        `<div class="g notice"><span class="ico">${ic('monitoroff', 26, 1.8)}</span><div><b>›</b> ${esc(s.reason || 'The PC can\'t stream its screen right now.')}` +
        `<div class="dim small">Nothing was asked on the PC. Fix it there, then check again.</div></div></div>` +
        `<button class="btn q wide" data-check type="button">check again</button>`;
      return;
    }
    const rtt = API.lastRtt != null ? ` · ${API.lastRtt} ms` : '';
    const mons = D.monitors.length ? D.monitors : [null];
    body.innerHTML = header(`<span class="chip c-g dot">${host}</span>`, `tailscale${rtt} · ${D.monitors.length ? D.monitors.length + ' monitor' + (D.monitors.length > 1 ? 's' : '') : 'monitors show after the first connect'}`) +
      mons.map(card).join('') +
      `<div class="g hint"><span class="acc">${ic('search', 22, 2)}</span><div>Pick a monitor to see it live.<br><b>pinch</b> to zoom, <b>drag</b> to pan, ` +
      `<b>tap</b> clicks, <b>hold</b> then move drags.</div></div>`;
  }

  function step(mark, cls, label, tm) {
    return `<div class="stp"><span class="ck ${cls}">${mark}</span><span class="${cls === 'dim' ? 'dim' : ''}">${label}</span><span class="tm">${tm || ''}</span></div>`;
  }

  function renderConnecting(body) {
    const c = D.connecting || {};
    const host = esc(hostName());
    const st = c.stage || 'status';
    const order = ['status', 'start', 'webrtc', 'show'];
    const at = order.indexOf(st);
    const mark = i => i < at ? ['✓', 'green'] : i === at ? ['<i class="spin"></i>', 'acc'] : ['·', 'dim'];
    const mon = c.monitor ? esc(c.monitor) : 'the main monitor';
    body.innerHTML = header('<span class="chip c-a dot">connecting</span>', `${host} · tailscale`) +
      `<div class="ctr"><div class="drings"><i class="r1"></i><i class="r2"></i><i class="r3"></i><span class="core g">${ic('monitor', 40, 1.8)}</span></div>` +
      `<div class="big"><span class="acc">›</span> connecting to ${host}</div><div class="dim small">usually takes 2 to 3 seconds</div></div>` +
      `<div class="g steps">` +
      step(...mark(0), 'tailscale reachable', c.rtt != null ? c.rtt + ' ms' : '') +
      step(...mark(1), `pc agent found · ${host}`, c.version ? 'v' + c.version : '') +
      step(...mark(2), 'opening the stream (webrtc)', at === 2 ? '…' : '') +
      step(...mark(3), `show ${mon} · whole monitor`, '') + `</div>` +
      `<button class="btn q wide" data-cancel type="button">cancel</button>`;
  }

  function renderDisconnected(body) {
    const e = D.ended || C.endedText('dropped', hostName());
    const host = esc(hostName());
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const reach = D.status ? (D.status.available ? ['✓', 'green', `${host} · answers`] : ['✕', 'red', `${host} · ${esc(D.status.reason || 'unavailable')}`])
      : ['✕', 'red', `${host} · no answer`];
    const auto = e.retry && D.retryTimer;
    body.innerHTML = header(`<span class="chip c-r dot">${e.retry ? 'offline' : 'ended'}</span>`, `${host}${D.ended && D.ended.at ? ' · ' + esc(clockAt(D.ended.at)) : ''}`) +
      `<div class="ctr"><span class="g dicon">${ic('monitoroff', 52, 1.7)}</span>` +
      `<div class="big"><span class="acc">›</span> ${esc(e.title)}</div><div class="mut why">${esc(e.text)}</div></div>` +
      (e.retry ? `<div class="g steps">` +
        step(offline ? '✕' : '✓', offline ? 'red' : 'green', offline ? 'phone offline' : 'phone online', '') +
        step(reach[0], reach[1], reach[2], '') +
        step(D.status && D.status.available ? '✓' : '·', D.status && D.status.available ? 'green' : 'dim', D.status && D.status.available ? 'pc agent · ready' : 'pc agent · not reachable', '') +
        `</div>` : '') +
      `<div class="dbtns">${e.again ? '<button class="btn p" data-retry type="button">try again</button>' : ''}` +
      (e.again ? '' : '<button class="btn p" data-pair type="button">pair again</button>') +
      `<button class="btn q" data-home type="button">monitors</button></div>` +
      (e.retry ? `<div class="dim small center">${auto ? 'retries by itself every 10 s' : 'Face ID again to reconnect: tap try again'}</div>` : '');
  }

  function clockAt(t) {
    const d = new Date(t);
    const h = d.getHours() % 12 || 12, m = String(d.getMinutes()).padStart(2, '0');
    return `last seen ${h}:${m} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  }

  // ================================================================= status
  async function refreshStatus() {
    if (!API.configured || API.unauthorized || D.checking) return;
    D.checking = true;
    try {
      D.status = await API.desktopStatus();
      D.statusErr = null;
      if (D.status && Array.isArray(D.status.monitors) && D.status.monitors.length) D.monitors = D.status.monitors;   // a later bridge may list them
    } catch (e) {
      D.status = null;
      D.statusErr = e;
    } finally {
      D.checking = false;
      D.statusAt = Date.now();
    }
    render();
  }

  // ================================================================= starting a session
  async function view(monitor, opts) {
    opts = opts || {};
    if (D.link || D.starting || D.phase === 'connecting') return;
    // one start at a time: a second tap, try again, the unlock or a retry while Face ID is up does nothing
    D.starting = true;
    if (D.retryTimer) { clearTimeout(D.retryTimer); D.retryTimer = null; }   // D.retrying stays: a failure backs off
    let confirm;
    try {
      confirm = await H.confirmDesktop({ title: 'view ' + (monitor || 'the main monitor'), reuse: !!opts.reuse, reuseOnly: !!opts.reuseOnly });
    } finally {
      D.starting = false;
    }
    if (!confirm || isLocked()) {
      if (opts.reuseOnly) return false;          // too long since the last Face ID: the owner taps try again
      if (D.phase === 'disconnected') render();
      return false;
    }
    D.connecting = { monitor, stage: 'status' };
    D.phase = 'connecting';
    D.ended = null;
    render();
    const mine = D.connecting;
    const t0 = now();
    try {
      D.status = await API.desktopStatus();
      D.statusErr = null;
    } catch (e) {
      if (D.connecting !== mine || D.phase !== 'connecting') return;    // cancelled or locked meanwhile
      D.status = null;
      return endedNow({ reason: e.status === 401 ? 'revoked' : 'dropped' });
    }
    if (D.connecting !== mine || D.phase !== 'connecting') return;
    if (!D.status.available) { D.phase = 'home'; render(); return; }
    D.connecting.rtt = Math.round(now() - t0);
    D.connecting.version = (D.status.versions || [])[0] || 1;
    D.connecting.stage = 'start';
    render();
    D.input = { enabled: true, reason: null };
    D.indicator = true;
    D.active = null;                                 // known only from the PC's first `monitors`
    D.switching = null;
    D.typing.sent = '';
    D.targets = null;
    D.viewSent = '';
    D.kb.sm.reset();
    const link = Link.start({
      monitor, confirm, app: APP_VERSION,
      viewport: { w: root.innerWidth, h: root.innerHeight, scale: root.devicePixelRatio || 1 },
      video: { max_w: 2560, max_h: 1440, el: $('d-video') },
      on: {
        state: s => {
          if (D.link !== link) return;
          if (s === 'connecting' && D.connecting) { D.connecting.stage = 'webrtc'; render(); }
        },
        welcome: w => {
          if (D.link !== link) return;
          D.host = w.host || D.host;
          if (D.connecting) D.connecting.stage = 'show';
          openViewer();
        },
        track: stream => {
          if (D.link !== link) return;
          const v = $('d-video');
          v.srcObject = stream;
          const p = v.play();
          if (p && p.catch) p.catch(() => {});
        },
        message: m => { if (D.link === link) onMessage(m); },
        rtt: ms => { if (D.link === link) { D.rtt = ms; renderTop(); } },
        fps: f => { if (D.link === link) { D.fps = f; renderTop(); } },
        stall: on => { if (D.link === link) { D.stalled = on; renderNote(); } },
        ended: e => { if (D.link === link) onEnded(e); },
      },
    });
    D.link = link;
    return true;
  }

  function onEnded(e) {
    if (e.reason === 'start_failed') {
      const err = e.error || {};
      D.link = null;
      if (err.status === 503) { D.status = { available: false, reason: err.message, versions: [1] }; D.phase = 'home'; render(); return; }
      if (err.code === 'version') return endedNow({ reason: 'version' });
      if (err.status === 401) return endedNow({ reason: 'revoked' });
      if (err.status === 428) { toast('The PC wants a fresh Face ID: try again.', 'bad'); D.phase = 'home'; render(); return; }
      if (err.code === 'aborted') return;
      return endedNow({ reason: err.offline ? 'dropped' : 'error' });
    }
    if (e.by === 'phone' && (e.reason === 'user' || e.reason === 'background')) return;   // whoever ended it moved on
    endedNow(e);
  }

  /** the session is gone (by the PC, or the network): the disconnected screen, and retries for a dropped link */
  function endedNow(e) {
    teardownViewer();
    D.link = null;
    const t = C.endedText(e.reason, hostName());
    D.ended = Object.assign({ reason: e.reason, at: Date.now() }, t);
    D.phase = 'disconnected';
    if (t.retry) startRetry(D.retrying ? RETRY_MS : 1000); else stopRetry();
    refreshStatus();
    render();
  }

  // ---------------------------------------------------------------- reconnect by itself (no new Face ID)
  function startRetry(ms) {
    if (D.retryTimer) clearTimeout(D.retryTimer);
    D.retryTimer = setTimeout(retryOnce, ms);
  }
  function stopRetry() { D.retrying = false; if (D.retryTimer) { clearTimeout(D.retryTimer); D.retryTimer = null; } }
  async function retryOnce() {
    D.retryTimer = null;
    if (D.phase !== 'disconnected' || D.link || isLocked()) return;
    D.retryCount++;
    D.retrying = true;                               // a failed retry waits the full 10 s before the next
    await refreshStatus();
    if (D.phase !== 'disconnected') return;
    if (D.status && D.status.available) {
      const started = await view(D.lastMonitor || D.active, { reuse: true, reuseOnly: true });
      if (started === false) { D.retrying = false; render(); return; }    // the last Face ID is too old: wait for the owner
      return;
    }
    D.retryTimer = setTimeout(retryOnce, RETRY_MS);
    render();
  }
  const isLocked = () => !!(root.GupLock && root.GupLock.isLocked);

  // ================================================================= the viewer
  function openViewer() {
    D.phase = 'viewer';
    D.retrying = false;
    D.connecting = null;
    D.hintUntil = now() + 6000;
    render();
    layout();
    renderTop();
    renderNote();
    setTimeout(renderHint, 6100);
    renderHint();
    if (!D.thumbTimer) D.thumbTimer = setInterval(() => { takeThumb(); drawMini(); }, 500);
  }

  function teardownViewer() {
    if (D.mover) D.mover.stop();
    D.drag = null;
    if (D.gestures) D.gestures.cancel();
    takeThumb(true);
    if (D.thumbTimer) { clearInterval(D.thumbTimer); D.thumbTimer = null; }
    const v = $('d-video');
    v.srcObject = null;
    kbApply(D.kb.sm.reset());
    kbdHide();
    closeMonitorSheet();
    D.stalled = false;
    D.targets = null;
    showTargets(false);
    clearTimeout(D.viewTimer);
  }

  /** user leaves: end on the PC, back to the picker */
  function disconnect() {
    const link = D.link;
    D.link = null;
    teardownViewer();
    if (link) link.end('user');
    D.phase = 'home';
    stopRetry();
    render();
    refreshStatus();
  }

  // ---------------------------------------------------------------- messages from the PC
  function activeMonitor() { return D.monitors.find(m => m.id === D.active) || null; }

  function onMessage(m) {
    switch (m.t) {
      case 'monitors': {
        if (!Array.isArray(m.list) || typeof m.active !== 'string') return;
        const changed = D.active && m.active !== D.active;
        D.monitors = m.list.filter(x => x && typeof x.id === 'string');
        if (changed && !D.switching) {
          const from = D.active;
          toast(m.reason === 'unplugged' || m.reason === 'capture_lost'
            ? `${esc(from)} went away: showing ${esc(m.active)}` : `The PC switched to ${esc(m.active)}`);
        }
        D.active = m.active;
        D.lastMonitor = m.active;
        // a list-only update (another monitor plugged) while switching keeps the guard until the new one is active
        if (changed || (D.switching && m.active === D.switching)) {
          D.guardUntil = now() + C.T.SWITCH_GUARD_MS;   // frames of the old monitor can still be on screen
          D.switching = null;
          if (D.mover) D.mover.stop();
          D.drag = null;
          setTimeout(() => { renderNote(); kbApply(D.kb.sm.update(kctx())); }, C.T.SWITCH_GUARD_MS + 20);
        }
        if (changed) { D.targets = null; D.viewSent = ''; showTargets(false); }   // the old monitor's targets mean nothing here
        layout(true);
        renderTop(); renderNote(); renderMonitorSheet();
        kbApply(D.kb.sm.update(kctx()));
        return;
      }
      case 'indicator': D.indicator = m.shown !== false; renderTop(); return;
      case 'input_state':
        D.input = { enabled: !!m.enabled, reason: m.enabled ? null : (m.reason || null) };
        if (!m.enabled && D.drag) { D.mover.stop(); D.drag = null; }
        renderTop(); renderNote();
        kbApply(D.kb.sm.update(kctx()));
        return;
      case 'focus': {
        if (!D.link || !D.link.has('focus')) return;
        const r = D.kb.sm.pcFocus(m, kctx());
        kbApply(r);
        if (r.elsewhere && m.kind === 'text') note(`text field focused on ${r.elsewhere}`, 3000);
        return;
      }
      case 'targets': {
        if (!D.link || !D.link.has('targets')) return;
        const t = C.parseTargets(m);
        if (!t || (D.targets && t.m === D.targets.m && t.gen < D.targets.gen)) return;   // an older list overtaken
        D.targets = t;
        if (D.tgtShown) renderTargets();
        renderHint();
        return;
      }
      case 'drag_cancelled':
        if (D.drag && D.drag.id === m.drag) { D.mover.stop(); D.drag = null; dragFx(null); note('the PC let go of the drag', 2000); }
        return;
      default:
    }
  }

  // ---------------------------------------------------------------- layout and drawing
  function videoSize() {
    const v = $('d-video');
    if (v.videoWidth && v.videoHeight) return [v.videoWidth, v.videoHeight];
    const m = activeMonitor();
    if (m && m.w && m.h) return [m.w * (m.scale || 1), m.h * (m.scale || 1)];
    return [16, 9];
  }

  function layout(newPicture) {
    const el = $('d-stream');
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const [vw, vh] = videoSize();
    const area = { w: r.width, h: r.height };
    if (!D.view || newPicture && (Math.abs(vw / vh - D.view.vw / D.view.vh) > 0.01)) D.view = C.makeView(area, vw, vh);
    else D.view = C.resize(D.view, area, vw, vh);
    // the keyboard is coming up (the area shrinks): the focused field stays in view above it
    const rv = D.kb.reveal;
    if (rv && now() < rv.until && kbdOpen()) D.view = C.revealRect(D.view, rv.rect, { multiline: rv.multiline });
    paintView();
  }

  function paintView() {
    const v = D.view, el = $('d-video');
    if (!v) return;
    el.style.width = v.vw * v.fit + 'px';
    el.style.height = v.vh * v.fit + 'px';
    el.style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.z})`;
    renderMini();
    renderFocusBox();
    if (D.tgtShown) renderTargets();
    scheduleView();
  }

  /** `view`: the part of the monitor on the phone, once zoom / pan settle, at most twice a second (the PC keeps those
      targets first when it has to cut its list) */
  function scheduleView() {
    if (!D.link || !D.link.has('targets') || !D.active || !D.view) return;
    clearTimeout(D.viewTimer);
    D.viewTimer = setTimeout(() => {
      D.viewTimer = null;
      if (!D.link || D.link.state !== 'live' || !D.active || !D.view) return;
      if (D.switching || now() < D.guardUntil) return scheduleView();          // after the switch guard: the new monitor's view
      const rect = C.visibleRect(D.view);
      const key = D.active + rect.join(',');
      if (key === D.viewSent) return;
      if (D.link.send(C.msg.view(D.active, rect)) !== false) { D.viewSent = key; D.viewAt = now(); }
    }, Math.max(C.T.VIEW_SETTLE_MS, D.viewAt + C.T.VIEW_MS - now()));
  }

  function renderTop() {
    if (D.phase !== 'viewer') return;
    const m = activeMonitor();
    const [vw, vh] = videoSize();
    $('d-title').textContent = `${D.active || 'monitor'} · whole monitor`;
    const bits = [];
    if (kbdOpen()) bits.push(D.kb.secret ? 'typing a password' : 'typing into the PC');
    else bits.push(m ? C.monitorSpec(m).split(' · ')[0] : `${vw}×${vh}`);
    if (D.rtt != null) bits.push(D.rtt + ' ms');
    if (D.fps != null && !kbdOpen()) bits.push(Math.round(D.fps) + ' fps');
    $('d-sub').textContent = bits.join(' · ');
    const chip = $('d-chip');
    if (!D.input.enabled) { chip.className = 'chip c-a dot'; chip.textContent = 'view only'; }
    else if (!D.indicator) { chip.className = 'chip c-a dot'; chip.textContent = 'no badge'; }
    else if (kbdOpen()) { chip.className = 'chip c-i'; chip.innerHTML = `${ic('keyboard', 13, 2.2)} ${D.kb.by === 'auto' ? 'auto' : 'typing'}`; }
    else { chip.className = 'chip c-g dot'; chip.textContent = 'live'; }
    $('d-kbd-btn').classList.toggle('on', kbdOpen());
  }

  let noteText = null, noteTimer = null;
  function note(text, ms) {
    noteText = text;
    clearTimeout(noteTimer);
    if (ms) noteTimer = setTimeout(() => { noteText = null; renderNote(); }, ms);
    renderNote();
  }
  function renderNote() {
    const el = $('d-note');
    let t = null, cls = '';
    if (D.switching || now() < D.guardUntil) { t = 'switching monitor…'; cls = ''; }
    else if (!D.input.enabled) { t = C.inputOffText(D.input.reason); cls = 'warn'; }
    else if (D.stalled) { t = 'the picture stopped · waiting for the PC'; cls = 'warn'; }
    else if (noteText) t = noteText;
    el.classList.toggle('hidden', !t);
    el.className = `dnote g ${cls}` + (t ? '' : ' hidden');
    el.innerHTML = t ? (cls === 'warn' ? `<span class="amber">●</span>` : `<span class="acc">●</span>`) + esc(t) : '';
  }

  function renderHint() {
    $('d-hint').classList.toggle('hidden', now() > D.hintUntil || kbdOpen());
    $('d-hint-tap').innerHTML = liveTargets() ? '<b>tap</b> snaps to targets' : '<b>tap</b> clicks · <b>hold</b> drags';
  }

  function renderMini() {
    const v = D.view;
    const show = v && v.z > 1.05 && !kbdOpen();
    $('d-mini').classList.toggle('hidden', !show);
    if (!show) return;
    const [x, y, w, h] = C.visibleRect(v);
    const box = $('d-mini-m');
    box.style.aspectRatio = `${v.vw} / ${v.vh}`;
    const vp = $('d-mini-vp');
    vp.style.left = x * 100 + '%'; vp.style.top = y * 100 + '%';
    vp.style.width = w * 100 + '%'; vp.style.height = h * 100 + '%';
    $('d-mini-z').textContent = (v.z).toFixed(1) + '×';
  }

  function drawMini() {
    if ($('d-mini').classList.contains('hidden')) return;
    const v = $('d-video'), c = $('d-mini-c');
    if (!v.videoWidth) return;
    const g = c.getContext('2d');
    c.width = 228; c.height = Math.round(228 * v.videoHeight / v.videoWidth);
    try { g.drawImage(v, 0, 0, c.width, c.height); } catch (e) { /* no frame yet */ }
  }

  let thumbAt = 0;
  function takeThumb(force) {
    const v = $('d-video');
    if (!v.videoWidth || !D.active || D.switching || now() < D.guardUntil) return;
    if (!force && now() - thumbAt < 5000) return;
    thumbAt = now();
    try {
      const c = document.createElement('canvas');
      c.width = 360; c.height = Math.round(360 * v.videoHeight / v.videoWidth);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      D.thumbs[D.active] = c.toDataURL('image/jpeg', 0.7);     // memory only: gone when the app closes
    } catch (e) { /* no frame */ }
  }

  // ---------------------------------------------------------------- input: taps, drags
  function canInput(what) {
    if (!D.link || D.link.state !== 'live' || !D.active) return false;   // no monitor id from the PC yet
    if (D.switching || now() < D.guardUntil) { note('switching monitor… try again in a moment', 1200); return false; }
    if (!D.input.enabled) { renderNote(); flashNote(); return false; }
    if (!D.link.has('input')) { note('The PC doesn\'t take ' + what + ' yet', 2000); return false; }
    return true;
  }
  function flashNote() { const el = $('d-note'); el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse'); }

  function ripple(x, y, cls) {
    const r = document.createElement('i');
    r.className = 'ripple ' + (cls || '');
    r.style.left = x + 'px'; r.style.top = y + 'px';
    $('d-fx').appendChild(r);
    setTimeout(() => r.remove(), 500);
  }
  function dragFx(p) {
    let el = $('d-fx').querySelector('.hold');
    if (!p) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('i'); el.className = 'hold'; $('d-fx').appendChild(el); }
    el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
  }

  /** the PC's targets for the monitor shown (null: none, another monitor's, or the cap isn't on) */
  function liveTargets() {
    const t = D.targets;
    return t && D.link && D.link.has('targets') && t.m === D.active && t.items.length ? t.items : null;
  }

  function onTap(x, y) {
    const v = D.view;
    if (!v) return;
    const n = C.toNorm(v, x, y);
    if (!n.inside) return;
    if (!canInput('clicks')) return;
    // a quick second tap close by lands exactly on the first one, so the PC sees a double click
    let p;
    const t = now();
    if (D.lastTap && t - D.lastTap.t < C.T.DOUBLE_MS && Math.hypot(x - D.lastTap.px, y - D.lastTap.py) < C.T.DOUBLE_PT && D.lastTap.m === D.active) p = D.lastTap.n;
    else p = C.snapTap(v, x, y, liveTargets());          // the nearest AT-SPI target close to the finger, else right here
    D.lastTap = { t, px: x, py: y, n: p, m: D.active };
    const at = p.snapped ? C.toArea(v, p.x, p.y) : { x, y };
    ripple(at.x, at.y);
    if (p.target && (p.snapped || p.target.role !== 'other')) hitFx(p.target, p.snapped);   // no big box for a container
    // the PC's focused field (or a text target) tapped while the keyboard is down: up it comes, inside this tap
    const f = D.kb.sm.state.focus;
    const onFocused = !!(f && f.rect && f.m === D.active && inRect(f.rect, p));
    const onField = onFocused || (p.target && p.target.role === 'text');
    if (onField && D.link.has('type')) {
      // another text field than the focused one: a plain keyboard until the PC's focus for it arrives
      const r = D.kb.sm.tapText(kctx(), onFocused);
      kbApply(r, true);
      // the PC normally answers with a text focus; if it stays "none" (the list was stale, the field wasn't one) the
      // keyboard goes away again by itself
      if (r.change === 'open' && !onFocused && D.link.has('focus')) {
        setTimeout(() => { const st = D.kb.sm.state; if (!st.focus && st.open && st.by === 'auto') kbApply(D.kb.sm.pcFocus({ kind: 'none' }, kctx())); }, 1500);
      }
    }
    D.link.request(C.msg.tap(0, D.active, p.x, p.y)).then(answer => onAnswer(answer, 'tap'));
  }
  const inRect = (r, p) => p.x >= r[0] && p.x <= r[0] + r[2] && p.y >= r[1] && p.y <= r[1] + r[3];

  /** the target a tap went to lights up (mockup 8), with a tip when the tap moved to it */
  function hitFx(tg, snapped) {
    const v = D.view, s = C.scaleOf(v);
    const x = v.tx + tg.x * v.vw * s, y = v.ty + tg.y * v.vh * s, w = tg.w * v.vw * s, h = tg.h * v.vh * s;
    const box = document.createElement('i');
    box.className = 'thit';
    Object.assign(box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
    $('d-fx').appendChild(box);
    setTimeout(() => box.remove(), 700);
    if (!snapped) return;
    const tip = document.createElement('span');
    tip.className = 'ttip';
    tip.textContent = `tap snapped → ${tg.role}`;
    tip.style.left = Math.max(8, Math.min(x, v.w - 200)) + 'px';
    tip.style.top = (y + h + 34 < v.h ? y + h + 8 : Math.max(8, y - 34)) + 'px';
    $('d-fx').appendChild(tip);
    setTimeout(() => tip.remove(), 1100);
  }

  // ---------------------------------------------------------------- the PC's targets, outlined while a finger is down
  function showTargets(on) {
    clearTimeout(D.tgtTimer);
    D.tgtTimer = null;
    if (on && !liveTargets()) on = false;
    D.tgtShown = on;
    $('d-tgt').classList.toggle('on', on);
    if (on) renderTargets();
  }
  /** after the last finger lifts the outlines fade out */
  function fadeTargets() {
    clearTimeout(D.tgtTimer);
    D.tgtTimer = setTimeout(() => showTargets(false), 900);
  }
  function renderTargets() {
    const items = liveTargets();
    if (!items || !D.view) { $('d-tgt').innerHTML = ''; return; }
    $('d-tgt').innerHTML = C.targetsInView(D.view, items, 250).map(r =>
      `<i style="left:${r.x.toFixed(1)}px;top:${r.y.toFixed(1)}px;width:${r.w.toFixed(1)}px;height:${r.h.toFixed(1)}px"></i>`).join('');
  }

  function onAnswer(a, what) {
    if (!a || a.t !== 'error') return;
    if (a.code === 'input_blocked') { renderNote(); flashNote(); }
    else if (a.code === 'stale_monitor') note('the monitor changed: tap again', 1800);
    else if (a.code === 'busy') note('the PC is catching up…', 1200);
    else if (a.code !== 'ended' && a.code !== 'not_sent') note(`the PC refused the ${what} (${a.code})`, 2200);
  }

  function onPress(x, y) {
    const v = D.view;
    if (!v || D.drag) return;
    const n = C.toNorm(v, x, y);
    if (!n.inside || !canInput('drags')) { D.drag = null; return; }
    const id = ++D.dragCount;
    D.dragSeq = 0;
    D.drag = { id, m: D.active, last: n };
    if (navigator.vibrate) { try { navigator.vibrate(10); } catch (e) { /* no haptics */ } }
    dragFx({ x, y });
    D.link.request(C.msg.dragStart(0, D.active, id, n.x, n.y)).then(a => {
      if (a && a.t === 'error' && D.drag && D.drag.id === id) { D.mover.stop(); D.drag = null; dragFx(null); onAnswer(a, 'drag'); }
    });
    D.mover.start(n.x, n.y);
  }
  function onDragMove(x, y) {
    if (!D.drag) return;
    const n = C.toNorm(D.view, x, y);
    D.drag.last = n;
    dragFx({ x, y });
    D.mover.move(n.x, n.y);
  }
  function onDragEnd(x, y) {
    const d = D.drag;
    D.mover.stop();
    dragFx(null);
    if (!d) return;
    D.drag = null;
    const n = x === undefined ? d.last : C.toNorm(D.view, x, y);
    D.link.request(C.msg.dragEnd(0, d.m, d.id, n.x, n.y)).then(a => onAnswer(a, 'drag'));
  }

  function wireGestures() {
    const el = $('d-stream');
    D.mover = C.createMover((x, y) => {
      const d = D.drag;
      if (d && D.link) D.link.motion(C.msg.dragMove(d.m, d.id, ++D.dragSeq, x, y));
    });
    D.gestures = C.createGestures({
      tap: (x, y) => onTap(x, y),
      panStart: () => { D.kb.reveal = null; },          // the owner moves the picture: no more keeping a field in view
      pan: (dx, dy) => { if (D.view) { C.panBy(D.view, dx, dy); paintView(); } },
      pinch: (f, cx, cy, dx, dy) => {
        if (!D.view) return;
        D.kb.reveal = null;
        C.zoomAt(D.view, f, cx, cy);
        C.panBy(D.view, dx, dy);
        D.hintUntil = 0; renderHint();
        paintView();
      },
      press: (x, y) => onPress(x, y),
      dragMove: (x, y) => onDragMove(x, y),
      dragEnd: (x, y) => onDragEnd(x, y),
      dragCancel: () => onDragEnd(),
    });
    const pt = e => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    el.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try { el.setPointerCapture(e.pointerId); } catch (x) { /* synthetic */ }
      D.gestures.down(e.pointerId, ...pt(e));
      showTargets(true);
      e.preventDefault();
    });
    el.addEventListener('pointermove', e => D.gestures.move(e.pointerId, ...pt(e)));
    el.addEventListener('pointerup', e => { D.gestures.up(e.pointerId, ...pt(e)); if (!D.gestures.fingers) fadeTargets(); });
    el.addEventListener('pointercancel', () => { D.gestures.cancel(); fadeTargets(); });
    // desktop browsers (dev): the wheel / a trackpad pinch zooms about the pointer
    el.addEventListener('wheel', e => {
      if (!D.view) return;
      e.preventDefault();
      const [x, y] = pt(e);
      C.zoomAt(D.view, Math.exp(-e.deltaY / 300), x, y);
      paintView();
    }, { passive: false });
    el.addEventListener('contextmenu', e => e.preventDefault());
    $('d-video').addEventListener('resize', () => { layout(true); renderTop(); });
    $('d-video').addEventListener('loadedmetadata', () => { layout(true); renderTop(); });
    if (root.ResizeObserver) new ResizeObserver(() => layout()).observe(el);
  }

  // ---------------------------------------------------------------- typing: the hidden field -> type messages
  // Two hidden fields: a textarea (autocorrect + dictation, keyboard type and Return key from the PC field) and, for a
  // PC password field, a password input (no autocorrect, suggestions or dictation; nothing kept after it closes).
  const kbdFields = () => [$('d-kbd'), $('d-kbd-secret')];
  const kbd = () => D.kb.secret ? $('d-kbd-secret') : $('d-kbd');
  function kbdOpen() { return kbdFields().includes(document.activeElement); }
  function kbdReset() { kbd().value = SENTINEL; D.typing.sent = ''; D.typing.composing = false; try { kbd().setSelectionRange(1, 1); } catch (e) { /* not focused */ } }
  /** what the keyboard state machine needs to know: the monitor shown, and whether typing can reach the PC now */
  function kctx() {
    const live = !!(D.link && D.link.state === 'live' && D.link.has('type'));
    return { active: D.active, canType: live && D.input.enabled && !D.switching && now() >= D.guardUntil };
  }
  function kbdToggle() {
    if (D.kb.needTap && kbdOpen()) return kbdFocusNow();             // focused, but iOS kept the keyboard down: this tap brings it
    if (kbdOpen() || D.kb.sm.state.open) return kbdClose();
    if (!D.link || !D.link.has('type')) return note('The PC doesn\'t take typing yet', 2000);
    kbApply(D.kb.sm.userOpen(kctx()), true);                           // in a tap handler, so iOS brings up the keyboard
  }
  /** the owner puts the keyboard away (the button, a sheet opening): it stays down for this PC field */
  function kbdClose() { kbApply(D.kb.sm.userClose()); }

  /** Does what the keyboard state machine decided. gesture: we're inside the owner's tap (iOS shows the keyboard for
      a focus there by itself); otherwise the shell is asked to let the next focus bring it up (keyboard.allow). */
  function kbApply(r, gesture) {
    if (!r) return;
    D.kb.by = r.open ? r.by : null;
    D.kb.field = r.field;
    if (r.change === 'open' || r.change === 'refocus') kbdShow(r.field, !!gesture, r.by === 'auto');
    else if (r.change === 'close') kbdHide();
    else if (r.change === 'reset') { kbdReset(); if (!D.gestures || !D.gestures.fingers) revealField(); }   // not while the owner moves the picture
    renderTop(); renderHint(); renderMini(); renderFocusBox(); renderAt();
  }

  function setKbdAttrs(a) {
    const el = $('d-kbd');
    el.setAttribute('inputmode', a.inputmode);
    el.setAttribute('enterkeyhint', a.enterkeyhint);
    el.setAttribute('autocorrect', a.autocorrect);
    el.setAttribute('autocapitalize', a.autocapitalize);
    el.setAttribute('spellcheck', a.spellcheck);
    const sec = $('d-kbd-secret');                                     // a PIN gets digits, a one-line field "go"
    sec.setAttribute('inputmode', a.inputmode === 'decimal' ? 'numeric' : 'text');
    sec.setAttribute('enterkeyhint', a.enterkeyhint === 'enter' ? 'enter' : 'go');
  }

  async function kbdShow(field, gesture, auto) {
    const tok = ++D.kb.token;
    const a = C.keyboardAttrs(field);
    D.kb.quiet = true;                                                  // our own blur isn't the owner putting it away
    if (kbdOpen()) document.activeElement.blur();
    D.kb.quiet = false;
    $('d-kbd-secret').value = '';
    D.kb.secret = a.secret;
    setKbdAttrs(a);
    kbdReset();
    D.kb.needTap = false;
    clearTimeout(D.kb.checkTimer);
    let allowed = gesture || !(root.GupNative && root.GupNative.available);   // a desktop browser focuses fine
    if (!gesture && root.GupNative && root.GupNative.available) {
      try { const ok = await root.GupNative.call('keyboard.allow'); allowed = !!(ok && ok.allowed); } catch (e) { allowed = false; }
      if (tok !== D.kb.token || !D.kb.sm.state.open || D.phase !== 'viewer') return;   // closed or changed meanwhile
    }
    D.kb.quiet = true;
    kbd().focus({ preventScroll: true });
    D.kb.quiet = false;
    kbdReset();
    if (auto) { D.kb.atUntil = now() + AT_MS; clearTimeout(D.kb.atTimer); D.kb.atTimer = setTimeout(renderAt, AT_MS + 20); }
    if (!gesture && root.GupNative && root.GupNative.available) {
      // WKWebView may still keep the keyboard down for a focus without a tap: then a "tap to type" chip does it
      if (!allowed) D.kb.needTap = true;
      else D.kb.checkTimer = setTimeout(() => {
        if (tok === D.kb.token && kbdOpen() && !document.body.classList.contains('kb')) { D.kb.needTap = true; renderAt(); }
      }, KB_CHECK_MS);
    }
    revealField(true);
    renderTop(); renderHint(); renderMini(); renderFocusBox(); renderAt();
  }
  /** a tap on "tap to type" (or the keyboard button): focus again inside the tap */
  function kbdFocusNow() {
    D.kb.needTap = false;
    D.kb.quiet = true;
    kbd().blur();
    kbd().focus({ preventScroll: true });
    D.kb.quiet = false;
    revealField(true);
    renderAt();
  }
  function kbdHide() {
    D.kb.token++;
    clearTimeout(D.kb.checkTimer); clearTimeout(D.kb.revealTimer);
    D.kb.needTap = false; D.kb.reveal = null; D.kb.atUntil = 0;
    D.kb.quiet = true;
    if (kbdOpen()) document.activeElement.blur();
    D.kb.quiet = false;
    $('d-kbd-secret').value = '';                                       // nothing of a password stays in the page
    D.kb.secret = false;
    kbdReset();
    renderTop(); renderHint(); renderMini(); renderFocusBox(); renderAt();
  }

  /** keep the PC's focused field in view above the keyboard: now (glide), and again while the keyboard comes up */
  function revealField(glide) {
    const f = D.kb.field;
    clearTimeout(D.kb.revealTimer);
    if (!f || !f.rect || !D.view) { D.kb.reveal = null; return; }
    D.kb.reveal = { rect: f.rect, multiline: f.multiline, until: now() + 1200 };
    const go = () => {
      const r = D.kb.reveal;
      if (!r || !D.view || !kbdOpen()) return;
      const before = D.view;
      D.view = C.revealRect(D.view, r.rect, { multiline: r.multiline });
      if (D.view.z === before.z && D.view.tx === before.tx && D.view.ty === before.ty) return;
      if (glide) { const v = $('d-video'); v.classList.add('glide'); setTimeout(() => v.classList.remove('glide'), 300); }
      paintView();
    };
    go();
    D.kb.revealTimer = setTimeout(go, 400);            // the keyboard's height is known by then (or never comes)
  }

  /** mockup 9: the PC's focused field outlined while the keyboard types into it */
  function renderFocusBox() {
    const el = $('d-focus');
    const f = D.kb.field, v = D.view;
    const show = !!(f && f.rect && v && kbdOpen() && D.phase === 'viewer');
    el.classList.toggle('hidden', !show);
    if (!show) return;
    const a = C.toArea(v, f.rect[0], f.rect[1]), b = C.toArea(v, f.rect[0] + f.rect[2], f.rect[1] + f.rect[3]);
    Object.assign(el.style, { left: a.x + 'px', top: a.y + 'px', width: (b.x - a.x) + 'px', height: (b.y - a.y) + 'px' });
  }

  /** the chip over the keyboard: "keyboard opened for you" for a while, or "tap to type" when iOS kept it down */
  function renderAt() {
    const el = $('d-at');
    let html = null;
    if (D.kb.sm.state.open && D.kb.needTap) html = `${ic('keyboard', 13, 2.2)} text field focused · tap to type`;
    else if (kbdOpen() && D.kb.by === 'auto' && now() < D.kb.atUntil) html = `${ic('keyboard', 13, 2.2)} text field focused · keyboard opened for you`;
    el.classList.toggle('hidden', !html || D.phase !== 'viewer');
    el.classList.toggle('act', !!(html && D.kb.needTap));
    if (html) el.innerHTML = html;
  }

  function sendTyping(del, text) {
    if (!D.link) return;
    if (!D.input.enabled) { renderNote(); flashNote(); return; }
    const parts = C.chunkText(text);
    if (!parts.length) parts.push('');
    parts.forEach((p, i) => {
      D.link.request(C.msg.type(0, i === 0 ? del : 0, p)).then(a => {
        if (!a) return;
        if (a.t === 'ack' && a.skipped) note(`Couldn't type: ${a.skipped}`, 3000);
        else if (a.t === 'ack' && a.stopped) { renderNote(); flashNote(); }
        else onAnswer(a, 'typing');
      });
    });
  }

  function kbdSync() {
    const el = kbd();
    if (D.typing.composing) return;
    if (!D.link || D.link.state !== 'live' || !D.input.enabled) {
      // nothing can be typed now: put the field back to what the PC has, so a later Backspace can't eat PC text
      el.value = SENTINEL + D.typing.sent;
      try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* ok */ }
      renderNote(); flashNote();
      return;
    }
    let v = el.value;
    if (!v.startsWith(SENTINEL)) v = v.replace(new RegExp(SENTINEL, 'g'), '');
    else v = v.slice(1);
    const next = C.plain(v);
    const d = C.diffText(D.typing.sent, next);
    D.typing.sent = next;
    if (!el.value.startsWith(SENTINEL)) { el.value = SENTINEL + v; try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* ok */ } }
    if (d) sendTyping(d.del, d.text);
    // keep the field short: after a Return, or when it gets long, start over (the PC keeps what was typed)
    if (next.endsWith('\n') || C.graphemes(next).length > 400) kbdReset();
  }

  function wireKeyboard() {
    for (const el of kbdFields()) {
      el.value = SENTINEL;
      el.addEventListener('beforeinput', e => {
        // Backspace with nothing of ours left: one Backspace on the PC, the field stays as it is
        if (e.inputType === 'deleteContentBackward' && !D.typing.composing && el.selectionStart <= 1 && el.selectionEnd <= 1) {
          e.preventDefault();
          sendTyping(1, '');
        }
      });
      el.addEventListener('compositionstart', () => { D.typing.composing = true; });
      el.addEventListener('compositionend', () => { D.typing.composing = false; kbdSync(); });
      el.addEventListener('input', e => { if (!e.isComposing) kbdSync(); });
      el.addEventListener('focus', () => { renderTop(); renderHint(); renderMini(); renderFocusBox(); });
      el.addEventListener('blur', () => {
        // a composition cut off by the keyboard closing never sends compositionend: don't wait for it forever
        if (D.typing.composing) { D.typing.composing = false; kbdSync(); }
        // the keyboard went away without us (Done, swiped down): the owner put it away
        if (!D.kb.quiet && D.kb.sm.state.open) kbApply(D.kb.sm.userClose());
        renderTop(); renderMini(); renderFocusBox();
      });
    }
    $('d-at').addEventListener('pointerdown', e => e.preventDefault());
    $('d-at').addEventListener('click', () => { if (D.kb.needTap) kbdFocusNow(); });
  }

  // ---------------------------------------------------------------- switch monitor
  let monSheet = null;
  function monitorSheetHtml() {
    const list = D.monitors.length ? D.monitors : [];
    return `<div class="vtitle acc">monitors <span>· ${esc(hostName())}</span></div>` +
      `<div class="mlist">${list.map(m => `<button class="g mrow${m.id === D.active ? ' on' : ''}" type="button" data-pick="${esc(m.id)}">` +
        `<span class="acc">${ic('monitor', 22, 2)}</span><span class="grow"><b>${esc(m.id)}</b>${m.primary ? ' <span class="chip c-x mini">main</span>' : ''}` +
        `<small>${esc([C.monitorSpec(m), m.label].filter(Boolean).join(' · '))}</small></span>` +
        `${m.id === D.active ? '<span class="chip c-g mini">showing</span>' : ic('chev', 16, 2.4)}</button>`).join('') || '<div class="dim">no monitor list yet</div>'}</div>` +
      `<button class="btn no" type="button" data-act="disconnect">${ic('x', 18, 2.2)}disconnect</button>` +
      `<button class="btn q" type="button" data-act="cancel">close</button>`;
  }
  function openMonitorSheet() {
    if (monSheet) return;
    kbdClose();
    monSheet = sheet(monitorSheetHtml(), () => { monSheet = null; });
    monSheet.el.classList.add('monsheet');
    monSheet.el.addEventListener('click', e => {
      if (e.target.closest('[data-act=cancel]')) return monSheet.close();
      if (e.target.closest('[data-act=disconnect]')) { monSheet.close(); return disconnect(); }
      const b = e.target.closest('[data-pick]');
      if (b) { monSheet.close(); selectMonitor(b.dataset.pick); }
    });
  }
  function renderMonitorSheet() {
    if (!monSheet) return;
    monSheet.el.innerHTML = monitorSheetHtml();
  }
  function closeMonitorSheet() { if (monSheet) monSheet.close(); }

  function selectMonitor(id) {
    if (!D.link || id === D.active) return;
    if (!D.link.has('monitors')) return note('The PC can\'t switch monitors yet', 2000);
    if (D.drag) onDragEnd();
    D.switching = id;                              // no taps or drags until 300 ms after the new `monitors`
    renderNote();
    D.link.request(C.msg.selectMonitor(0, id)).then(a => {
      if (a && a.t === 'error') {
        D.switching = null;
        renderNote();
        note(a.code === 'no_monitor' ? `${id} isn't there anymore` : `couldn't switch (${a.code})`, 2500);
      }
    });
  }

  // ================================================================= wiring
  function wire() {
    $('tab-desktop-icon').outerHTML = ic('monitor', 25, 1.9);
    $('d-back').innerHTML = ic('back', 20, 2.2);
    $('d-mon').innerHTML = ic('monitor', 18, 2);
    $('d-kbd-btn').innerHTML = ic('keyboard', 20, 2);
    $('d-hint').innerHTML = `<div><span class="acc">${ic('expand', 15, 2.2)}</span><span><b>pinch</b> zoom · <b>drag</b> pan</span></div>` +
      `<div><span class="acc">${ic('search', 15, 2.2)}</span><span id="d-hint-tap"><b>tap</b> clicks · <b>hold</b> drags</span></div>`;
    $('d-back').addEventListener('click', disconnect);
    $('d-mon').addEventListener('click', openMonitorSheet);
    $('d-titlebox').addEventListener('click', openMonitorSheet);
    $('d-kbd-btn').addEventListener('pointerdown', e => e.preventDefault());   // keep the field focused while tapping
    $('d-kbd-btn').addEventListener('click', kbdToggle);
    $('d-body').addEventListener('click', e => {
      const v = e.target.closest('[data-view]');
      if (v) return view(v.dataset.view || null);
      const c = e.target.closest('.mc');
      if (c && !e.target.closest('button')) return view(c.dataset.mon || null);
      if (e.target.closest('[data-check]')) { D.status = null; D.statusErr = null; render(); return refreshStatus(); }
      if (e.target.closest('[data-cancel]')) { const l = D.link; D.link = null; if (l) l.end('user'); D.phase = 'home'; D.connecting = null; render(); return; }
      if (e.target.closest('[data-retry]')) return view(D.lastMonitor || D.active, { reuse: true });
      if (e.target.closest('[data-home]')) { stopRetry(); D.phase = 'home'; D.ended = null; render(); refreshStatus(); }
    });
    wireGestures();
    wireKeyboard();
    root.addEventListener('resize', () => { if (D.phase === 'viewer') layout(); });
  }

  const GupDesk = {
    show() {
      D.shown = true;
      render();
      if (D.phase === 'home' || D.phase === 'disconnected') refreshStatus();
    },
    hide() { D.shown = false; },
    /** the shell locked (the app went to the background): the session ends now (the shell also calls /end) */
    lock() {
      stopRetry();
      if (D.link || D.phase === 'viewer' || D.phase === 'connecting') {
        D.resume = { monitor: D.active || (D.connecting && D.connecting.monitor) || null, host: hostName() };
        const l = D.link;
        D.link = null;
        teardownViewer();
        if (l) l.end('background');
        D.phase = 'home';
        render();
      }
      if (root.GupLock && D.resume) root.GupLock.desktopClosed(D.resume.host);
    },
    /** Face ID passed again: pick the session up where it was (the check just now counts for the PC) */
    unlocked() {
      const r = D.resume;
      D.resume = null;
      if (root.GupLock) root.GupLock.desktopClosed(null);
      if (!r || !API.configured || isLocked()) return;
      if (root.GupApp) root.GupApp.showTab('desktop');
      view(r.monitor, { reuse: true });
    },
    reset() {
      const l = D.link;
      D.link = null;
      if (l) l.end('user');
      teardownViewer();
      stopRetry();
      Object.assign(D, { phase: 'home', status: null, statusErr: null, monitors: [], active: null, lastMonitor: null, host: null, thumbs: {}, ended: null, resume: null });
      render();
    },
    /** the PC no longer takes our token: everything stops */
    unauthorized() {
      const l = D.link;
      D.link = null;
      if (l) l.end('user');
      teardownViewer();
      stopRetry();
      D.phase = 'home';
      render();
    },
    view, disconnect, selectMonitor,
    wire,
    get state() { return D; },
  };
  root.GupDesk = GupDesk;
})(window);
