/* One remote desktop session with the PC (GupDeskLink): signaling through GupAPI (in the app: the shell's bridge, so
   the token stays native), then WebRTC straight to the PC over the tailnet. Contract: docs/remote-desktop-protocol.md
   (gupworks repo), stage 1 v1. The PC offers (video track + the `ctl` and `motion` data channels), the phone answers.
     const link = GupDeskLink.start({monitor, confirm, video, viewport, on: {...}})
     link.request(msg) -> Promise(ack | error)   (ctl, with a new id)       link.send(msg)  (ctl, no answer)
     link.motion(msg)                            (motion channel)            link.end('user')
   on: state(s: signaling | connecting | live | ended), welcome(w), message(m) (every ctl message from the PC),
       ended({reason, by: pc | phone | net, message}), stall(bool), rtt(ms), track(stream)
   Ending: bye on ctl when it is open, then POST .../end (also what the shell does natively on the way to the
   background, because iOS stops this page's JavaScript there). */
(function (root) {
  'use strict';
  const API = root.GupAPI, C = root.GupDeskCore;

  const ANSWER_WAIT_MS = 2000;      // send the answer once ICE gathering is complete, or after 2 s
  const CONNECT_MS = 15000;         // ICE + DTLS after the answer, else "Couldn't reach the PC"
  const HELLO_MS = 10000;           // ctl open -> welcome
  const PING_MS = 2000, SILENT_MS = 6000, ICE_GRACE_MS = 3000, STALL_MS = 3000, STATS_MS = 5000;

  function start(o) {
    const on = o.on || {};
    const emit = (name, ...a) => { try { if (on[name]) on[name](...a); } catch (e) { console.error(e); } };
    let state = 'signaling', id = null, pc = null, ctl = null, mot = null, welcome = null;
    let nextId = 1, lastHeard = 0, ended = false, stalled = false, lastFrameAt = 0, lastFrames = -1;
    const waiting = new Map();      // request id -> {resolve}
    const timers = new Set();
    const ctlAbort = new AbortController();

    const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
    const every = (fn, ms) => { const t = setInterval(fn, ms); timers.add(t); return t; };
    function setState(s) { if (state !== s && state !== 'ended') { state = s; emit('state', s); } }

    function finish(reason, by, message) {
      if (ended) return;
      ended = true;
      timers.forEach(t => { clearTimeout(t); clearInterval(t); });
      timers.clear();
      ctlAbort.abort();
      waiting.forEach(w => w.resolve({ t: 'error', code: 'ended', message: 'The session ended.' }));
      waiting.clear();
      if (by !== 'pc' && ctl && ctl.readyState === 'open') {
        try { ctl.send(JSON.stringify(C.msg.bye(reason === 'background' ? 'background' : 'user'))); } catch (e) { /* closing */ }
      }
      // a moment for the bye to leave before the transport goes; then the dependable end: POST .../end ends the
      // session on the PC even if the bye was lost (a no-op when it already ended)
      const sid = id;
      const close = () => {
        try { if (pc) pc.close(); } catch (e) { /* gone */ }
        if (sid && reason !== 'replaced' && reason !== 'revoked') API.desktopEnd(sid).catch(() => {});
      };
      if (by !== 'pc' && ctl && ctl.readyState === 'open') setTimeout(close, 60); else close();
      state = 'ended';
      emit('state', 'ended');
      emit('ended', { reason, by, message });
    }

    function sendOn(ch, m) {
      if (ended || !ch || ch.readyState !== 'open') return false;
      const s = C.encode(m);
      if (!s) return false;
      try { ch.send(s); return true; } catch (e) { return false; }
    }

    function onCtl(ev) {
      if (typeof ev.data !== 'string') return;
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
      lastHeard = performance.now();
      if (m.t === 'ping') { sendOn(ctl, C.msg.pong(m.ts)); return; }
      if (m.t === 'pong') { if (typeof m.ts === 'number') emit('rtt', Math.max(0, Math.round(performance.now() - m.ts))); return; }
      if ((m.t === 'ack' || m.t === 'error') && Number.isInteger(m.id) && waiting.has(m.id)) {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        w.resolve(m);
      }
      if (m.t === 'welcome' && !welcome) {
        welcome = m;
        setState('live');
        emit('welcome', m);
      }
      if (m.t === 'error' && m.code === 'version') return finish('version', 'pc', m.message);
      if (m.t === 'bye') return finish(typeof m.reason === 'string' ? m.reason : 'error', 'pc');
      emit('message', m);
    }

    async function run() {
      let s;
      const body = { versions: C.VERSIONS.slice(), confirm: o.confirm };
      if (o.monitor) body.monitor = o.monitor;
      try {
        s = await API.desktopStart(body, { signal: ctlAbort.signal });
      } catch (e) {
        if (ended) return;
        ended = true;
        state = 'ended';
        emit('state', 'ended');
        return emit('ended', { reason: 'start_failed', by: 'pc', error: e });
      }
      if (ended) { if (s && s.id) API.desktopEnd(s.id).catch(() => {}); return; }
      if (!s || typeof s.id !== 'string' || !s.offer || typeof s.offer.sdp !== 'string') return finish('error', 'pc', 'The PC sent no offer.');
      id = s.id;
      emit('session', { id, version: s.version });
      setState('connecting');
      const config = { iceServers: Array.isArray(s.ice_servers) ? s.ice_servers : [], bundlePolicy: 'max-bundle' };
      try {
        pc = new RTCPeerConnection(config);
      } catch (e) {
        return finish('error', 'phone', 'This web view can\'t open a WebRTC connection.');
      }
      pc.ontrack = ev => {
        try { if ('jitterBufferTarget' in ev.receiver) ev.receiver.jitterBufferTarget = 0; } catch (e) { /* older WebKit */ }
        emit('track', ev.streams && ev.streams[0] ? ev.streams[0] : new MediaStream([ev.track]));
      };
      pc.ondatachannel = ev => {
        const ch = ev.channel;
        if (ch.label === 'motion') { mot = ch; return; }
        if (ch.label !== 'ctl') return;
        ctl = ch;
        const opened = () => {
          lastHeard = performance.now();
          sendOn(ctl, C.msg.hello({ app: o.app, viewport: o.viewport, video: o.video }));
          later(() => { if (!welcome) finish('timeout', 'net'); }, HELLO_MS);
        };
        ch.onmessage = onCtl;
        ch.onclose = () => finish(welcome ? 'dropped' : 'timeout', 'net');
        if (ch.readyState === 'open') opened(); else ch.onopen = opened;
      };
      let iceBad = null;
      pc.onconnectionstatechange = () => {
        const cs = pc.connectionState;
        if (cs === 'failed') return finish(welcome ? 'dropped' : 'timeout', 'net');
        if (cs === 'disconnected') { if (!iceBad) iceBad = later(() => finish('dropped', 'net'), ICE_GRACE_MS); }
        else if (iceBad) { clearTimeout(iceBad); timers.delete(iceBad); iceBad = null; }
      };
      try {
        await pc.setRemoteDescription(s.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await new Promise(resolve => {
          if (pc.iceGatheringState === 'complete') return resolve();
          const t = later(resolve, ANSWER_WAIT_MS);
          pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); timers.delete(t); resolve(); } });
        });
      } catch (e) {
        return finish('error', 'phone', 'The PC\'s offer didn\'t work here: ' + (e && e.message));
      }
      if (ended) return;
      try {
        const d = pc.localDescription;
        await API.desktopAnswer(id, { type: d.type, sdp: d.sdp }, { signal: ctlAbort.signal });
      } catch (e) {
        if (ended) return;
        return finish(e && e.code === 'stale' ? 'timeout' : 'error', 'pc', e && e.message);
      }
      later(() => { if (!welcome && !(ctl && ctl.readyState === 'open')) finish('timeout', 'net'); }, CONNECT_MS);
      // keep-alive, silence, stalls, stats
      every(() => {
        if (!ctl || ctl.readyState !== 'open') return;
        sendOn(ctl, C.msg.ping(performance.now()));
        if (welcome && performance.now() - lastHeard > SILENT_MS) finish('dropped', 'net');
      }, PING_MS);
      every(watchFrames, 500);
      every(sendStats, STATS_MS);
    }

    function watchFrames() {
      const v = o.video && o.video.el;
      if (!welcome || !v) return;
      const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
      const n = q ? q.totalVideoFrames : Math.round((v.currentTime || 0) * 1000);
      const t = performance.now();
      if (n !== lastFrames) { lastFrames = n; lastFrameAt = t; if (stalled) { stalled = false; emit('stall', false); } }
      else if (!stalled && lastFrameAt && t - lastFrameAt > STALL_MS) { stalled = true; emit('stall', true); }
      else if (!lastFrameAt) lastFrameAt = t;
    }

    let prevStats = null;
    async function sendStats() {
      if (!pc || !welcome || !welcome.caps || !welcome.caps.includes('stats')) return;
      let rep;
      try { rep = await pc.getStats(); } catch (e) { return; }
      const out = {};
      rep.forEach(r => {
        if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
          if (typeof r.framesPerSecond === 'number') out.fps = r.framesPerSecond;
          if (r.jitterBufferEmittedCount) out.jitter_buffer_ms = 1000 * r.jitterBufferDelay / r.jitterBufferEmittedCount;
          if (r.framesDecoded && typeof r.totalDecodeTime === 'number') {
            const p = prevStats;
            const df = p ? r.framesDecoded - p.framesDecoded : r.framesDecoded;
            const dt = p ? r.totalDecodeTime - p.totalDecodeTime : r.totalDecodeTime;
            if (df > 0) out.decode_ms = 1000 * dt / df;
            prevStats = { framesDecoded: r.framesDecoded, totalDecodeTime: r.totalDecodeTime };
          }
          if (typeof r.framesDropped === 'number') out.frames_dropped = r.framesDropped;
          if (r.frameWidth) { out.w = r.frameWidth; out.h = r.frameHeight; }
        }
        if (r.type === 'candidate-pair' && r.nominated && typeof r.currentRoundTripTime === 'number') out.rtt_ms = r.currentRoundTripTime * 1000;
      });
      sendOn(ctl, C.msg.stats(out));
      if (typeof out.fps === 'number') emit('fps', out.fps);
    }

    run();

    return {
      get state() { return state; },
      get id() { return id; },
      get welcome() { return welcome; },
      get stalled() { return stalled; },
      has(cap) { return !!(welcome && Array.isArray(welcome.caps) && welcome.caps.includes(cap) && C.CAPS.includes(cap)); },
      /** a ctl request with a fresh id; resolves the PC's ack or error (or {t: error, code: not_sent}) */
      request(m) {
        const rid = nextId++;
        const full = Object.assign({}, m, { id: rid });
        if (!sendOn(ctl, full)) return Promise.resolve({ t: 'error', id: rid, code: 'not_sent', message: 'Not connected.' });
        return new Promise(resolve => waiting.set(rid, { resolve }));
      },
      nextId() { return nextId++; },
      send(m) { return sendOn(ctl, m); },
      /** drag_move only, and only on `motion` (a lost move is fine: drag_end carries the exact point) */
      motion(m) { return sendOn(mot, m); },
      end(reason) { finish(reason || 'user', 'phone'); },
    };
  }

  root.GupDeskLink = { start };
})(window);
