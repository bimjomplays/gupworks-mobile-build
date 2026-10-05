/* The iOS shell's bridge (ios/Sources/NativeBridge.swift), as seen from the page.
     GupNative.available        true inside the app (window.webkit.messageHandlers.gup exists)
     GupNative.call(op, args)   -> Promise of the native answer
     GupNative.on(name, fn)     native events (pair: {state: checking | paired | failed, ...}); returns an unsubscribe
     GupNative.transport        a GupAPI transport: the shell adds the PC address and the token and does the request
   The page never gets the token or the full PC address: it only asks for API paths. */
(function (root) {
  'use strict';
  const handler = root.webkit && root.webkit.messageHandlers && root.webkit.messageHandlers.gup;
  const listeners = {};
  let seq = 0;

  function call(op, args) {
    if (!handler) return Promise.reject(new Error('not in the app'));
    return Promise.resolve(handler.postMessage(Object.assign({}, args || {}, { op })));
  }

  async function transport(req) {
    const { ApiError } = root.GupAPI;
    if (req.signal && req.signal.aborted) throw new ApiError(0, 'aborted', 'aborted');
    const id = ++seq;
    const query = {};
    for (const k of Object.keys(req.query || {})) if (req.query[k] !== undefined && req.query[k] !== null) query[k] = String(req.query[k]);
    const msg = { id, method: req.method, path: req.path, query, timeoutMs: req.timeoutMs };
    if (req.body !== undefined) msg.body = JSON.stringify(req.body);
    const onAbort = () => { call('cancel', { id }).catch(() => {}); };
    if (req.signal) req.signal.addEventListener('abort', onAbort, { once: true });
    let r;
    try {
      r = await call('request', msg);
    } catch (e) {
      throw new ApiError(0, 'unreachable', 'PC not reachable');
    } finally {
      if (req.signal) req.signal.removeEventListener('abort', onAbort);
    }
    if (!r || r.error) {
      const code = (r && r.error) || 'unreachable';
      const text = { timeout: 'The PC took too long to answer', aborted: 'aborted', not_paired: 'This phone isn\'t paired with a PC yet',
                     bad_request: 'The app asked for something the PC API doesn\'t have' }[code] || 'PC not reachable';
      throw new ApiError(0, code, text);
    }
    let json = null;
    try { json = r.body ? JSON.parse(r.body) : null; } catch (e) { /* empty or non-JSON body */ }
    return { status: r.status, json };
  }

  root.GupNative = {
    available: !!handler,
    call,
    transport,
    on(name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
      return () => { listeners[name] = listeners[name].filter(f => f !== fn); };
    },
    /** called by the shell (evaluateJavaScript) */
    _event(name, data) {
      (listeners[name] || []).slice().forEach(fn => { try { fn(data || {}); } catch (e) { console.error(e); } });
    },
  };
})(window);
