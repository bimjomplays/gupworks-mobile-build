/* GupWorks phone API v1 client: every call the web UI makes to the PC goes through here (contract: docs/phone-api.md
   in the gupworks repo). One transport function does the actual HTTP:
     - fetchTransport (default): fetch() to the PC's base URL with the bearer token.
     - GupAPI.useTransport(fn, mode): plug in another one with the same shape, e.g. a native WKWebView bridge doing the
       request in Swift so the token never enters JavaScript (native.js, used inside the iOS app), or the dev mock
       (mock.js).
   A transport gets {method, path, query, body, timeoutMs, signal} and resolves {status, json}; it rejects only when
   the PC can't be reached (or the call was aborted).
   Rules from the contract that live here: token only in the Authorization header, never in a URL; a 401 stops every
   further call until the app is configured again (no retry loops); long-polls ask for at most 25 s and allow 35 s. */
(function (root) {
  'use strict';

  const WAIT_MAX = 25;               // the PC clamps wait to 0..25 s
  const LONG_TIMEOUT_MS = 35000;     // HTTP timeout for long-polls (contract: at least 35 s)
  const SHORT_TIMEOUT_MS = 15000;
  const TEXT_MAX = 8000, ANSWER_MAX = 4000, BODY_MAX = 16 * 1024;

  const state = { baseUrl: null, token: null, transport: null, mode: 'none', unauthorized: false };
  let clockOffsetMs = 0;             // PC clock minus this device's clock, from /v1/status server_time
  let lastRtt = null;
  const listeners = {};

  class ApiError extends Error {
    constructor(status, code, message) {
      super(message || code);
      this.status = status;          // HTTP status; 0 = no answer (unreachable, timeout, aborted, not paired)
      this.code = code;              // the contract's error code, or unreachable / timeout / aborted / not_paired
    }
    get offline() { return this.status === 0 && (this.code === 'unreachable' || this.code === 'timeout'); }
  }

  function emit(name, value) { (listeners[name] || []).forEach(fn => { try { fn(value); } catch (e) { console.error(e); } }); }

  function queryString(query) {
    if (!query) return '';
    const parts = Object.keys(query).filter(k => query[k] !== undefined && query[k] !== null)
      .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(query[k])));
    return parts.length ? '?' + parts.join('&') : '';
  }

  // Joins the caller's abort signal with a timeout. Returns {signal, done(), timedOut()}.
  function deadline(timeoutMs, outer) {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    const onAbort = () => ctl.abort();
    if (outer) { if (outer.aborted) ctl.abort(); else outer.addEventListener('abort', onAbort, { once: true }); }
    return {
      signal: ctl.signal,
      timedOut: () => timedOut,
      done() { clearTimeout(timer); if (outer) outer.removeEventListener('abort', onAbort); },
    };
  }

  async function fetchTransport(req) {
    const headers = { Authorization: 'Bearer ' + state.token, Accept: 'application/json' };
    let body;
    if (req.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(req.body); }
    const d = deadline(req.timeoutMs, req.signal);
    try {
      const res = await fetch(state.baseUrl.replace(/\/+$/, '') + req.path + queryString(req.query), {
        method: req.method, headers, body, signal: d.signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
      });
      let json = null;
      try { json = await res.json(); } catch (e) { /* empty or non-JSON body */ }
      return { status: res.status, json };
    } catch (e) {
      if (d.timedOut()) throw new ApiError(0, 'timeout', 'The PC took too long to answer');
      if (req.signal && req.signal.aborted) throw new ApiError(0, 'aborted', 'aborted');
      throw new ApiError(0, 'unreachable', 'PC not reachable');
    } finally {
      d.done();
    }
  }

  async function request(method, path, opts) {
    opts = opts || {};
    if (state.unauthorized) throw new ApiError(401, 'unauthorized', 'Not paired anymore: pair the phone again');
    if (!state.transport) throw new ApiError(0, 'not_paired', 'This phone isn\'t paired with a PC yet');
    const req = { method, path, query: opts.query, body: opts.body, signal: opts.signal,
                  timeoutMs: opts.timeoutMs || SHORT_TIMEOUT_MS };
    const t0 = performance.now();
    let res;
    try {
      res = await state.transport(req);
    } catch (e) {
      if (opts.signal && opts.signal.aborted) throw new ApiError(0, 'aborted', 'aborted');
      const err = e instanceof ApiError ? e : new ApiError(0, 'unreachable', 'PC not reachable');
      if (err.offline) emit('reachable', false);
      throw err;
    }
    if (opts.signal && opts.signal.aborted) throw new ApiError(0, 'aborted', 'aborted');   // answer for a stopped loop
    if (!opts.long) lastRtt = Math.round(performance.now() - t0);
    emit('reachable', true);
    const json = res.json;
    if (res.status >= 400) {
      const e = (json && json.error) || {};
      const err = new ApiError(res.status, e.code || 'http_' + res.status, e.message || 'HTTP ' + res.status);
      if (res.status === 401) { state.unauthorized = true; emit('unauthorized', err); }
      throw err;
    }
    return json;
  }

  function clampWait(wait) { return Math.max(0, Math.min(WAIT_MAX, wait == null ? WAIT_MAX : wait)); }

  function newClientId() {
    if (root.crypto && crypto.randomUUID) { try { return crypto.randomUUID(); } catch (e) { /* insecure context */ } }
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase();
  }

  const GupAPI = {
    ApiError, TEXT_MAX, ANSWER_MAX, BODY_MAX, WAIT_MAX,

    /** Talk to a paired PC: its base URL (Tailscale HTTPS, port 10000) and the device token. */
    configure({ baseUrl, token, mode }) {
      Object.assign(state, { baseUrl, token, transport: fetchTransport, mode: mode || 'pc', unauthorized: false });
    },
    /** Plug in another transport (native bridge, dev mock). mode is a label for the UI: 'pc', 'mock', ... */
    useTransport(fn, mode) {
      Object.assign(state, { baseUrl: null, token: null, transport: fn, mode: mode || 'pc', unauthorized: false });
    },
    /** Forget the PC (unpaired): every call fails with not_paired until configured again. */
    reset() {
      Object.assign(state, { baseUrl: null, token: null, transport: null, mode: 'none', unauthorized: false });
    },
    get mode() { return state.mode; },
    get configured() { return !!state.transport; },
    get unauthorized() { return state.unauthorized; },
    get lastRtt() { return lastRtt; },
    /** 'unauthorized' (ApiError) once a 401 arrives; 'reachable' (true/false) after each call. Returns an unsubscribe. */
    on(name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
      return () => { listeners[name] = listeners[name].filter(f => f !== fn); };
    },
    /** The PC's clock, as far as the last /v1/status told us (confirmations must be within 2 min of it). */
    serverNow() { return new Date(Date.now() + clockOffsetMs); },
    newClientId,

    async status(opts) {
      const s = await request('GET', '/v1/status', opts);
      const t = s && Date.parse(s.server_time);
      if (t) clockOffsetMs = t - Date.now() + (lastRtt || 0) / 2;
      return s;
    },

    // ---- Gup chat
    /** Newest page: {messages, cursor, busy, more_before, reset}. */
    messages(limit, opts) {
      return request('GET', '/v1/threads/gup/messages', Object.assign({ query: { limit } }, opts));
    },
    /** Older history: messages with id < before (no waiting). */
    olderMessages(before, limit, opts) {
      return request('GET', '/v1/threads/gup/messages', Object.assign({ query: { before, limit } }, opts));
    },
    /** Long-poll: returns once anything changed since cursor, or after wait seconds with messages: []. */
    pollMessages(cursor, wait, opts) {
      return request('GET', '/v1/threads/gup/messages',
        Object.assign({ query: { cursor, wait: clampWait(wait) }, timeoutMs: LONG_TIMEOUT_MS, long: true }, opts));
    },
    /** Send the owner's message to Gup; reuse clientId on retries so it's never sent twice. */
    send(text, clientId, opts) {
      return request('POST', '/v1/threads/gup/messages', Object.assign({ body: { text, client_id: clientId } }, opts));
    },

    // ---- waiting on the owner
    waiting(opts) { return request('GET', '/v1/waiting', opts); },
    pollWaiting(version, wait, opts) {
      return request('GET', '/v1/waiting',
        Object.assign({ query: { version, wait: clampWait(wait) }, timeoutMs: LONG_TIMEOUT_MS, long: true }, opts));
    },
    /** Decide one waiting item as the owner. confirm comes from GupHooks.confirmOwnerAction() and only from there. */
    act(key, action, text, confirm, opts) {
      const body = { key, action, confirm };
      if (text) body.text = text;
      return request('POST', '/v1/waiting/act', Object.assign({ body }, opts));
    },

    /** New device token. Through the iOS shell the answer is {rotated, created_at}: the shell keeps the token in the
        Keychain and switches to it once the PC has seen it (docs/phone-api.md "Rotation from the app"). */
    rotate(opts) { return request('POST', '/v1/auth/rotate', Object.assign({ body: {} }, opts)); },

    // ---- remote desktop (docs/remote-desktop-protocol.md "Signaling"; the PC's bridge forwards these to its host)
    /** {available, versions, session, reason}; always 200 (a host that isn't running reads as available: false) */
    desktopStatus(opts) { return request('GET', '/v1/desktop/status', opts); },
    /** body {versions, monitor, confirm}: confirm from GupHooks.confirmDesktop() only. 201 {id, version, offer,
        expires_at, ice_servers?}. In the app the shell sends it only with a block it issued, and adds the device. */
    desktopStart(body, opts) { return request('POST', '/v1/desktop/sessions', Object.assign({ body, timeoutMs: 20000 }, opts)); },
    desktopAnswer(id, answer, opts) {
      return request('POST', `/v1/desktop/sessions/${encodeURIComponent(id)}/answer`, Object.assign({ body: { answer } }, opts));
    },
    desktopEnd(id, opts) { return request('POST', `/v1/desktop/sessions/${encodeURIComponent(id)}/end`, Object.assign({ body: {} }, opts)); },
  };

  root.GupAPI = GupAPI;
})(typeof window !== 'undefined' ? window : globalThis);
