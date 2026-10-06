/* DEV ONLY: a fake remote desktop host for the dev mock (mock.js), so the Desktop tab can be tried in a desktop
   browser and tested in headless Chromium without a PC. Loaded only with ?mock (app.js) or by the test shell.
   It plays docs/remote-desktop-protocol.md v1 (gupworks repo) from the PC's side, in this same page: a second
   RTCPeerConnection offers a canvas "monitor" as the video track plus the `ctl` and `motion` data channels, and answers
   hello / tap / drag / type / select_monitor / ping / bye like the real host. Every message the app sends is checked
   against the spec's shapes; anything off lands in `violations` (the tests want that empty). Demo data only.
     const desk = GupMockDesk.create({state: 'ok' | 'off' | 'nogrant' | 'down'})
     desk.status() / desk.start(body) / desk.answer(id, body) / desk.end(id)   -> {status, json}   (mock.js routes)
   Test hooks: desk.log, desk.violations, desk.clicks, desk.drags, desk.text, desk.sessions, desk.endFromPC(reason),
     desk.setInput(enabled, reason), desk.drop(), desk.unplug(), desk.set({state, reason}). */
(function (root) {
  'use strict';

  const CAPS = ['monitors', 'input', 'type', 'focus', 'targets', 'stats'];
  const MONITORS = [
    { id: 'DP-1', label: 'Demo ultrawide (left)', x: 0, y: 0, w: 3440, h: 1440, scale: 1.0, refresh: 144, primary: true },
    { id: 'DP-2', label: 'Demo 1080p (right)', x: 3440, y: 0, w: 1920, h: 1080, scale: 1.0, refresh: 60, primary: false },
  ];
  const CANVAS = { 'DP-1': [1376, 576], 'DP-2': [1280, 720] };
  const REASONS = {
    off: 'Remote desktop is turned off on the PC.',
    nogrant: 'Remote desktop isn\'t allowed on the PC yet: run `gw desktop grant` at the PC once.',
    down: 'The remote desktop host isn\'t running.',
  };
  const err = (status, code, message, extra) => ({ status, json: { error: Object.assign({ code, message }, extra || {}) } });
  const ok = (json, status) => ({ status: status || 200, json });
  const b64id = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const is5 = v => typeof v === 'number' && isFinite(v) && Math.abs(v * 1e5 - Math.round(v * 1e5)) < 1e-6;
  const inUnit = v => is5(v) && v >= -0.01 && v <= 1.01;
  const graphemes = s => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), x => x.segment);

  function create(opts) {
    opts = opts || {};
    const cfg = { state: opts.state || 'ok', reason: null };
    const log = [], violations = [], clicks = [], drags = [], sessions = [];
    let text = '';
    let s = null;                 // the current session
    let lastMonitor = null;

    function violation(m, why) { violations.push({ t: m && m.t, why, m }); }

    // ---------------------------------------------------------------- the "monitor"
    const canvas = document.createElement('canvas');
    const g = canvas.getContext('2d');
    let active = MONITORS[0].id, frame = 0, painter = null, flash = 0, held = null;
    function size(id) { [canvas.width, canvas.height] = CANVAS[id]; }
    function paint() {
      frame++;
      const W = canvas.width, H = canvas.height, k = W / 1280;
      const bg = g.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, active === 'DP-1' ? '#1d2350' : '#143c52'); bg.addColorStop(1, '#2b1f55');
      g.fillStyle = bg; g.fillRect(0, 0, W, H);
      // a "Kate" window with what was typed
      g.fillStyle = '#1b1e24'; g.fillRect(40 * k, 40 * k, 620 * k, 380 * k);
      g.fillStyle = '#2a2e37'; g.fillRect(40 * k, 40 * k, 620 * k, 26 * k);
      g.fillStyle = '#d6d9e2'; g.font = `${14 * k}px monospace`; g.fillText(`notes.md – Kate · ${active}`, 52 * k, 58 * k);
      g.fillStyle = '#e6e9f4'; g.font = `${18 * k}px monospace`;
      const lines = (text + (frame % 20 < 10 ? '▏' : ' ')).split('\n').slice(-14);
      lines.forEach((l, i) => g.fillText(l.slice(-48), 56 * k, (96 + i * 22) * k));
      // a button that lights up when clicked
      g.fillStyle = flash > 0 ? '#ff9a4d' : '#e0663b'; g.fillRect(720 * k, 80 * k, 220 * k, 64 * k);
      g.fillStyle = '#fff'; g.font = `bold ${20 * k}px sans-serif`; g.fillText('Click me', 770 * k, 120 * k);
      if (flash > 0) flash--;
      // the last drag and the last click
      const d = drags[drags.length - 1];
      if (d && d.points.length > 1) {
        g.strokeStyle = '#7ee08f'; g.lineWidth = 4 * k; g.beginPath();
        d.points.forEach((p, i) => (i ? g.lineTo : g.moveTo).call(g, p[0] * W, p[1] * H)); g.stroke();
      }
      const c = clicks[clicks.length - 1];
      if (c && c.m === active) { g.strokeStyle = '#fff'; g.lineWidth = 3 * k; g.beginPath(); g.arc(c.x * W, c.y * H, 14 * k, 0, 7); g.stroke(); }
      // the panel with a clock (so the picture always changes a little)
      g.fillStyle = 'rgba(10,12,22,.92)'; g.fillRect(0, H - 40 * k, W, 40 * k);
      g.fillStyle = '#aeb4cc'; g.font = `${15 * k}px sans-serif`; g.fillText(new Date().toLocaleTimeString(), W - 120 * k, H - 14 * k);
      if (held) { g.fillStyle = 'rgba(126,224,143,.5)'; g.beginPath(); g.arc(held[0] * W, held[1] * H, 18 * k, 0, 7); g.fill(); }
    }
    size(active);

    // ---------------------------------------------------------------- the session (PC side)
    function sendCtl(m) { if (s && s.ctl && s.ctl.readyState === 'open') s.ctl.send(JSON.stringify(m)); }
    const monitorsMsg = reason => Object.assign({ t: 'monitors', active, list: JSON.parse(JSON.stringify(MONITORS)) }, reason ? { reason } : {});
    function inputMsg() { return { t: 'input_state', enabled: s.input.enabled, reason: s.input.enabled ? null : s.input.reason }; }
    const caps = c => s && s.caps.includes(c);

    function finish(sess, reason, sendBye) {
      if (!sess || sess.state === 'ended') return;
      if (sendBye && sess.ctl && sess.ctl.readyState === 'open') { try { sess.ctl.send(JSON.stringify({ t: 'bye', reason })); } catch (e) { /* closing */ } }
      sess.state = 'ended'; sess.reason = reason;
      held = null;
      clearInterval(sess.pinger);
      setTimeout(() => { try { sess.pc.close(); } catch (e) { /* gone */ } }, sendBye ? 80 : 0);
      if (s === sess) { s = null; clearInterval(painter); painter = null; }
    }

    function reply(m, extra) { if (Number.isInteger(m.id)) sendCtl(Object.assign({ t: 'ack', id: m.id }, extra || {})); }
    function fail(m, code, message) { if (Number.isInteger(m.id)) sendCtl({ t: 'error', id: m.id, code, message }); }
    function checkM(m) {
      if (typeof m.m !== 'string') { violation(m, 'm missing'); fail(m, 'bad_message', 'm'); return false; }
      if (m.m !== active) { fail(m, 'stale_monitor', 'not the active monitor'); return false; }
      return true;
    }
    function inputOk(m) { if (s.input.enabled) return true; fail(m, 'input_blocked', 'Input is off.'); return false; }
    function idOk(m, need) {
      if (need && !Number.isInteger(m.id)) { violation(m, 'id missing'); return false; }
      if (m.id !== undefined && !Number.isInteger(m.id)) { violation(m, 'id not an integer'); return false; }
      return true;
    }
    function xy(m) {
      if (!inUnit(m.x) || !inUnit(m.y)) { violation(m, 'x/y not 0..1 with up to 5 digits'); fail(m, 'bad_message', 'x/y'); return false; }
      return true;
    }
    function closeDrag(why) {
      const d = s && s.drag;
      if (!d) return;
      s.drag = null; held = null;
      d.state = why;
      if (why !== 'ended') sendCtl({ t: 'drag_cancelled', drag: d.id });
    }

    function onCtl(m, raw, channel) {
      log.push(m);
      if (channel === 'motion' && m.t !== 'drag_move') violation(m, 'only drag_move goes on motion');
      if (channel === 'ctl' && m.t === 'drag_move') violation(m, 'drag_move belongs on motion');
      if (new TextEncoder().encode(raw).length > 64 * 1024) violation(m, 'over 64 KiB');
      if (!s.hello && !['hello', 'ping', 'bye'].includes(m.t)) return violation(m, 'before hello');
      switch (m.t) {
        case 'hello': {
          if (m.v !== 1 || !Array.isArray(m.versions) || !m.versions.includes(1) || !Array.isArray(m.caps) || typeof m.app !== 'string' ||
              !m.video || !Number.isInteger(m.video.max_w) || !Number.isInteger(m.video.max_h) ||
              (m.viewport && !(Number.isFinite(m.viewport.w) && Number.isFinite(m.viewport.h))))
            violation(m, 'hello shape');
          if (s.hello) return violation(m, 'second hello');
          s.hello = m;
          s.caps = CAPS.filter(c => m.caps.includes(c));
          sendCtl({ t: 'welcome', v: 1, caps: s.caps, host: 'desk', session: s.id });
          sendCtl(monitorsMsg());
          sendCtl({ t: 'indicator', shown: true });
          sendCtl(inputMsg());
          if (caps('focus')) sendCtl({ t: 'focus', kind: 'none' });
          s.pinger = setInterval(() => sendCtl({ t: 'ping', ts: Math.round(performance.now()) }), 2000);
          return;
        }
        case 'ping': if (typeof m.ts !== 'number') violation(m, 'ping.ts'); return sendCtl({ t: 'pong', ts: m.ts });
        case 'pong': return;
        case 'bye': if (!['user', 'background'].includes(m.reason)) violation(m, 'bye.reason'); return finish(s, 'bye', false);
        case 'stats':
          for (const k of Object.keys(m)) if (k !== 't' && typeof m[k] !== 'number') violation(m, 'stats.' + k);
          s.stats.push(m);
          return;
        case 'tap':
          if (!caps('input')) return fail(m, 'unsupported', 'input');
          if (!idOk(m, false) || !checkM(m) || !xy(m)) return;
          if (m.count !== undefined && !(Number.isInteger(m.count) && m.count >= 1)) violation(m, 'tap.count');
          if (!inputOk(m)) return;
          closeDrag('cancelled');
          clicks.push({ m: m.m, x: m.x, y: m.y, count: m.count || 1 });
          flash = 8;
          return reply(m);
        case 'drag_start':
          if (!caps('input')) return fail(m, 'unsupported', 'input');
          if (!idOk(m, false) || !checkM(m) || !xy(m)) return;
          if (!Number.isInteger(m.drag)) return violation(m, 'drag id');
          if (!inputOk(m)) return;
          closeDrag('ended');
          s.drag = { id: m.drag, seq: 0, state: 'open' };
          drags.push({ id: m.drag, m: m.m, points: [[m.x, m.y]], moves: 0, end: null, state: 'open', ref: s.drag });
          held = [m.x, m.y];
          return reply(m);
        case 'drag_move': {
          if (!Number.isInteger(m.drag) || !Number.isInteger(m.seq) || m.seq < 1 || typeof m.m !== 'string' || !inUnit(m.x) || !inUnit(m.y)) return violation(m, 'drag_move shape');
          if (m.id !== undefined) violation(m, 'drag_move has no id');
          const d = s.drag;
          if (!d || d.id !== m.drag || m.m !== active || m.seq <= d.seq) return;
          d.seq = m.seq;
          const rec = drags[drags.length - 1];
          rec.points.push([m.x, m.y]); rec.moves++;
          held = [m.x, m.y];
          return;
        }
        case 'drag_end': {
          if (!idOk(m, false) || typeof m.m !== 'string' || !xy(m) || !Number.isInteger(m.drag)) return violation(m, 'drag_end shape');
          const d = s.drag;
          if (d && d.id === m.drag) {
            const rec = drags[drags.length - 1];
            rec.points.push([m.x, m.y]); rec.end = [m.x, m.y]; rec.state = 'ended';
            closeDrag('ended');
          }
          return reply(m);
        }
        case 'type': {
          if (!caps('type')) return fail(m, 'unsupported', 'type');
          if (!idOk(m, false) || !Number.isInteger(m.del) || m.del < 0 || typeof m.text !== 'string') return violation(m, 'type shape');
          if (graphemes(m.text).length > 2000) { violation(m, 'type over 2000'); return fail(m, 'too_large', 'text'); }
          if (!inputOk(m)) return;
          const chars = graphemes(text);
          text = chars.slice(0, Math.max(0, chars.length - m.del)).join('') + m.text.replace(/\r\n/g, '\n');
          return reply(m, { typed: graphemes(m.text).length, skipped: '' });
        }
        case 'select_monitor': {
          if (!idOk(m, false) || typeof m.monitor !== 'string') return violation(m, 'select_monitor shape');
          if (!MONITORS.some(x => x.id === m.monitor)) return fail(m, 'no_monitor', 'unknown monitor');
          closeDrag('cancelled');
          setTimeout(() => {                         // the new monitor's first frame, then ack, then monitors
            if (!s) return;
            active = m.monitor; lastMonitor = active; size(active); paint();
            reply(m);
            sendCtl(monitorsMsg());
          }, 120);
          return;
        }
        case 'view':
          if (!Array.isArray(m.rect) || m.rect.length !== 4) violation(m, 'view.rect');
          return;
        default:
          violation(m, 'not a stage-1 phone message');
      }
    }

    async function start(body) {
      if (cfg.state !== 'ok') return err(503, 'host_unavailable', cfg.reason || REASONS[cfg.state] || REASONS.down);
      if (!Array.isArray(body.versions) || !body.versions.includes(1)) return err(409, 'version', 'No protocol version in common.', { supported: [1] });
      const c = body.confirm;
      const at = c && Date.parse(c.at);
      if (!c || c.key !== 'desktop' || c.action !== 'start' || !['face_id', 'touch_id', 'passcode'].includes(c.method) || !at || Math.abs(Date.now() - at) > 120e3)
        return err(428, 'confirmation_required', 'Confirm with Face ID first.');
      if (body.monitor !== undefined && typeof body.monitor !== 'string') return err(400, 'bad_request', 'monitor');
      if (s) finish(s, 'replaced', true);
      const want = MONITORS.some(m => m.id === body.monitor) ? body.monitor : lastMonitor || MONITORS.find(m => m.primary).id;
      active = want; lastMonitor = want; size(active); paint();
      if (!painter) painter = setInterval(paint, 66);
      const pc = new RTCPeerConnection({ iceServers: [] });
      const sess = { id: b64id(), pc, state: 'offered', hello: null, caps: [], drag: null, input: { enabled: true, reason: null },
                     stats: [], device: body.device || null, body: JSON.parse(JSON.stringify(body)), answered: false };
      s = sess;
      sessions.push(sess);
      const stream = canvas.captureStream(15);
      stream.getTracks().forEach(t => pc.addTrack(t, stream));
      sess.ctl = pc.createDataChannel('ctl');
      sess.motion = pc.createDataChannel('motion', { ordered: false, maxRetransmits: 0 });
      sess.ctl.onmessage = ev => { if (s === sess) { try { onCtl(JSON.parse(ev.data), ev.data, 'ctl'); } catch (e) { violation(null, 'not JSON on ctl'); } } };
      sess.motion.onmessage = ev => { if (s === sess) { try { onCtl(JSON.parse(ev.data), ev.data, 'motion'); } catch (e) { violation(null, 'not JSON on motion'); } } };
      sess.ctl.onclose = () => finish(sess, 'closed', false);
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise(r => {
        if (pc.iceGatheringState === 'complete') return r();
        pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') r(); });
        setTimeout(r, 3000);
      });
      sess.expires = Date.now() + 30e3;
      setTimeout(() => { if (!sess.answered) finish(sess, 'timeout', false); }, 30e3);
      return ok({ id: sess.id, version: 1, offer: { type: 'offer', sdp: pc.localDescription.sdp },
                  expires_at: new Date(sess.expires).toISOString().replace(/\.\d+Z$/, '+00:00') }, 201);
    }

    async function answer(id, body) {
      const sess = sessions.find(x => x.id === id);
      if (!sess || sess !== s || sess.answered || sess.state === 'ended') return err(409, 'stale', 'Not the current session.');
      const a = body && body.answer;
      if (!a || a.type !== 'answer' || typeof a.sdp !== 'string') return err(400, 'bad_request', 'answer');
      sess.answered = true;
      sess.state = 'connecting';
      try { await sess.pc.setRemoteDescription(a); } catch (e) { finish(sess, 'error', false); return err(400, 'bad_request', 'bad SDP'); }
      return ok({ ok: true });
    }

    function end(id) {
      const sess = sessions.find(x => x.id === id);
      if (sess) { sess.endedBy = sess.endedBy || 'phone'; finish(sess, sess.reason || 'phone_end', false); }
      return ok({ ok: true });
    }

    function status() {
      const live = s && s.state !== 'ended' ? { id: s.id, state: s.hello ? 'live' : s.state, started_at: new Date().toISOString() } : null;
      if (cfg.state !== 'ok') return ok({ available: false, versions: [1], session: live, reason: cfg.reason || REASONS[cfg.state] || REASONS.down });
      return ok({ available: true, versions: [1], session: live, reason: null });
    }

    return {
      status, start, answer, end,
      log, violations, clicks, drags, sessions, canvas,
      get text() { return text; },
      get active() { return active; },
      get session() { return s; },
      set(o) { Object.assign(cfg, o); },
      endFromPC(reason) { if (s) finish(s, reason || 'ended_on_pc', true); },
      setInput(enabled, reason) {
        if (!s) return;
        s.input = { enabled, reason: enabled ? null : reason || 'disabled_on_pc' };
        if (!enabled) closeDrag('cancelled');
        sendCtl(inputMsg());
      },
      /** the network goes away: no bye, the channels just die */
      drop() { if (s) { const x = s; s = null; clearInterval(x.pinger); x.state = 'ended'; x.reason = 'dropped'; try { x.pc.close(); } catch (e) { /* gone */ } } },
      /** the active monitor is unplugged: the PC moves to the primary (or the other one) by itself */
      unplug() {
        if (!s) return;
        closeDrag('cancelled');
        active = MONITORS.find(m => m.id !== active).id; size(active); paint();
        sendCtl(monitorsMsg('unplugged'));
      },
    };
  }

  // ---------------------------------------------------------------- ?mock&rtc=loop: WebRTC without a network
  /** Replaces RTCPeerConnection in this page with an in-page loopback that keeps the API the app and the fake host
      use (offer/answer, data channels, ontrack with the host's real canvas stream, connection states, getStats), for
      sandboxes where Chromium finds no network interface to gather ICE candidates on (only loopback). Dev only. */
  function installLoopbackRTC() {
    if (root.RTCPeerConnection && root.RTCPeerConnection.loopback) return;
    const peers = new Map();
    let n = 0;
    const later = (fn, ms) => setTimeout(fn, ms || 1);

    class Channel {
      constructor(label, opts) {
        Object.assign(this, { label, ordered: !(opts && opts.ordered === false), readyState: 'connecting', other: null,
                              onopen: null, onmessage: null, onclose: null });
      }
      send(data) {
        if (this.readyState !== 'open') throw new Error('InvalidStateError: channel not open');
        const o = this.other;
        later(() => { if (o && o.readyState === 'open' && o.onmessage) o.onmessage({ data }); });
      }
      _open() { if (this.readyState === 'connecting') { this.readyState = 'open'; later(() => this.onopen && this.onopen({})); } }
      close() {
        if (this.readyState === 'closed') return;
        this.readyState = 'closed';
        later(() => this.onclose && this.onclose({}));
        if (this.other) this.other.close();
      }
    }

    class LoopPC extends EventTarget {
      constructor(config) {
        super();
        this.id = 'loop' + (++n);
        peers.set(this.id, this);
        Object.assign(this, { config, connectionState: 'new', iceGatheringState: 'new', signalingState: 'stable', localDescription: null,
                              remoteDescription: null, peer: null, channels: [], tracks: [], ontrack: null, ondatachannel: null,
                              onconnectionstatechange: null, frames: 0 });
      }
      createDataChannel(label, opts) { const c = new Channel(label, opts); this.channels.push(c); return c; }
      addTrack(track, stream) { this.tracks.push({ track, stream }); return {}; }
      async createOffer() { return { type: 'offer', sdp: `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\na=x-loop:${this.id}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n` }; }
      async createAnswer() { return { type: 'answer', sdp: `v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\na=x-loop:${this.id}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n` }; }
      async setLocalDescription(d) {
        this.localDescription = { type: d.type, sdp: d.sdp };
        this.iceGatheringState = 'complete';
        later(() => this.dispatchEvent(new Event('icegatheringstatechange')));
      }
      async setRemoteDescription(d) {
        const m = /a=x-loop:(loop\d+)/.exec(d && d.sdp || '');
        if (!m || !peers.has(m[1])) throw new Error('OperationError: not a loopback description');
        this.remoteDescription = { type: d.type, sdp: d.sdp };
        this.peer = peers.get(m[1]);
        if (d.type === 'answer') { this.peer.peer = this; later(() => this._connect(), 40); }
      }
      _state(s) {
        if (this.connectionState === s || this.connectionState === 'closed') return;
        this.connectionState = s;
        if (this.onconnectionstatechange) this.onconnectionstatechange({});
      }
      _connect() {                                 // the offerer (the host) connects both sides
        const a = this, b = this.peer;
        if (!b || a.connectionState === 'closed' || b.connectionState === 'closed') return;
        a._state('connected'); b._state('connected');
        for (const t of a.tracks) if (b.ontrack) b.ontrack({ track: t.track, streams: [t.stream], receiver: {} });
        for (const c of a.channels) {
          const mirror = new Channel(c.label, { ordered: c.ordered });
          c.other = mirror; mirror.other = c;
          if (b.ondatachannel) b.ondatachannel({ channel: mirror });
          later(() => { c._open(); mirror._open(); }, 5);
        }
      }
      async getStats() {
        this.frames += 75;
        return new Map([['in', { type: 'inbound-rtp', kind: 'video', framesPerSecond: 15, jitterBufferDelay: 0.3, jitterBufferEmittedCount: 30,
                                 framesDecoded: this.frames, totalDecodeTime: this.frames * 0.003, framesDropped: 0, frameWidth: 1280, frameHeight: 720 }],
                        ['cp', { type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.002 }]]);
      }
      close() {
        if (this.connectionState === 'closed') return;
        this.connectionState = 'closed';
        this.channels.forEach(c => c.close());
        if (this.peer && this.peer.connectionState !== 'closed') {
          const p = this.peer;
          p.channels.forEach(c => c.close());
          later(() => p._state('failed'), 50);
        }
        peers.delete(this.id);
      }
    }
    LoopPC.loopback = true;
    root.RTCPeerConnection = LoopPC;
  }

  root.GupMockDesk = { create, MONITORS, installLoopbackRTC };
})(window);
