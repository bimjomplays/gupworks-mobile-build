/* DEV ONLY: a fake GupWorks PC that speaks phone API v1 (docs/phone-api.md in the gupworks repo), so the web UI
   works without the PC. Demo data only. The app loads this file only when its URL has ?mock (see app.js); the
   shipped app never does.
   One implementation, two ways to use it:
     - in the page:  index.html?mock            (GupMock.inPageTransport plugs into GupAPI.useTransport)
     - as a server:  node scripts/mock-phone-api.js  (wraps mock.handle() in real HTTP, CORS and all), then
                     open http://127.0.0.1:47121/?mock=server
   What it implements: bearer auth (401 after a short delay), JSON body rules (411/413/415/400), Gup's thread with
   newest/older pages and the cursor long-poll (upserts: queued -> picked up, partial -> final, tool rows -> done),
   send with client_id dedupe, the waiting list with its version long-poll, /v1/waiting/act with the confirm block
   (428 / 409 stale / 403 pc_only), /v1/status and /v1/auth/rotate, and /v1/desktop/... answered by a fake remote
   desktop host when one is passed in (createMock({desktop}), web/mock-desktop.js; the HTTP mock has none). Gup "answers" with canned replies. */
(function (root) {
  'use strict';

  const DEV_TOKEN = 'mock';
  const BODY_MAX = 16 * 1024, TEXT_MAX = 8000, ANSWER_MAX = 4000, WAIT_MAX = 25, MAX_LONG_POLLS = 4;
  const CLIENT_ID = /^[A-Za-z0-9_.-]{1,64}$/;
  const METHODS = ['face_id', 'touch_id', 'passcode'];

  const iso = t => new Date(t).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  const hex = n => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const err = (status, code, message) => ({ status, json: { error: { code, message } } });
  const ok = (json, status) => ({ status: status || 200, json });

  function createMock(opts) {
    opts = opts || {};
    const speed = opts.speed || 1;                 // > 1: Gup answers faster (tests)
    const authDelayMs = opts.authDelayMs == null ? 500 : opts.authDelayMs;
    const tick = ms => sleep(ms / speed);
    const epoch = hex(12);

    let seq = 0;                                   // change counter: every new or changed message, every busy flip
    let nextId = 400;
    let busy = false, working = false, longPolls = 0;
    const msgs = [], queue = [], byClient = new Map(), waiters = new Set();
    let waiting = [], waitingRev = 1;
    const tokens = { current: opts.token || DEV_TOKEN, pending: null };
    const settings = { paused: false, newWork: { ok: true, why: 'ok' } };
    const t0 = Date.now();
    const desk = opts.desktop || null;            // a GupMockDesk (browser only: it needs WebRTC)

    // ---------------------------------------------------------------- thread
    function wake() { for (const w of Array.from(waiters)) w.check(); }
    function addMsg(m, at) {
      nextId += 1 + Math.floor(Math.random() * 3);   // ids are shared with other threads on the PC: gaps
      const full = Object.assign({ id: nextId, sender: 'gup', role: 'gup', kind: 'text', body: '', ts: iso(at || Date.now()),
        partial: false, queued: false, via: null, client_id: null, attachments: [], tool: null }, m);
      full._rev = ++seq;
      msgs.push(full);
      wake();
      return full;
    }
    function update(m, patch) { Object.assign(m, patch); m._rev = ++seq; wake(); }
    function setBusy(b) { if (busy !== b) { busy = b; seq++; wake(); } }
    const pub = m => { const o = Object.assign({}, m); delete o._rev; return o; };
    const cursor = () => `1.${seq}.${epoch}`;
    function parseCursor(c) {
      const m = /^1\.(\d+)\.([0-9a-f]+)$/.exec(String(c || ''));
      return m && m[2] === epoch && +m[1] <= seq ? +m[1] : null;
    }

    // resolves when ready() holds, after waitSec, when aborted, or at once when too many long-polls are open
    function waitFor(ready, waitSec, signal) {
      if (ready() || waitSec <= 0 || longPolls >= MAX_LONG_POLLS || (signal && signal.aborted)) return Promise.resolve();
      longPolls++;
      return new Promise(resolve => {
        const w = { check() { if (ready()) finish(); } };
        const timer = setTimeout(finish, waitSec * 1000);
        function finish() {
          if (!waiters.delete(w)) return;
          longPolls--; clearTimeout(timer);
          if (signal) signal.removeEventListener('abort', finish);
          resolve();
        }
        waiters.add(w);
        if (signal) signal.addEventListener('abort', finish, { once: true });
      });
    }

    // ---------------------------------------------------------------- pretend Gup
    function replyFor(text) {
      const t = text.toLowerCase();
      if (/\b(propose|ticket|file)\b/.test(t)) {
        const id = 170 + waiting.length;
        const title = text.replace(/^(please\s+)?(propose|file|make)\s+(a\s+)?(ticket\s+)?(to\s+|for\s+)?/i, '').slice(0, 80) || 'New idea';
        return { tools: ['Bash: gw ticket propose', 'Bash: gw ticket list --proposed'],
                 text: `Proposed **#${id}** ${title}. It's in your Waiting tab: tap yes to start it.`,
                 after() { addWaiting(proposedItem(id, 'gup', 'from your chat', title, 'Asked for in the Gup chat.')); } };
      }
      if (/\b(status|how.*going|usage)\b/.test(t)) {
        return { tools: ['Bash: gw status', 'Read: PROJECT_STATE.md'],
                 text: `All quiet. 3 agents are working, nothing is failing, and usage is at 34% of the 5-hour limit. ` +
                       `${waiting.length} things wait on you in the Waiting tab.` };
      }
      if (/^(hi|hey|hello|yo)\b/.test(t)) return { tools: [], text: 'Hi! I\'m here. Ask me about the team, the PC or anything waiting on you.' };
      return { tools: ['Bash: gw helper pc-care status'],
               text: `On it: "${text.length > 90 ? text.slice(0, 90) + '…' : text}". (This is the dev mock: nothing really happened on the PC.)` };
    }

    async function work() {
      if (working) return;
      working = true;
      try {
        while (queue.length) {
          await tick(500);
          const m = queue.shift();
          update(m, { queued: false });
          setBusy(true);
          const r = replyFor(m.body);
          for (const tool of r.tools) {
            await tick(450);
            const row = addMsg({ kind: 'tool', body: tool, tool: { name: tool.split(':')[0], error: false, done: false } });
            await tick(550);
            update(row, { tool: Object.assign({}, row.tool, { done: true }) });
          }
          const words = r.text.split(' ');
          const parts = [Math.ceil(words.length * .25), Math.ceil(words.length * .55), Math.ceil(words.length * .8)];
          let msg = null;
          for (const n of parts) {
            await tick(350);
            const body = words.slice(0, n).join(' ');
            if (!msg) msg = addMsg({ body, partial: true }); else update(msg, { body });
          }
          await tick(350);
          update(msg, { body: r.text, partial: false });
          if (r.after) r.after();
          setBusy(queue.length > 0);
        }
      } finally {
        working = false;
        setBusy(false);
      }
    }

    // ---------------------------------------------------------------- waiting list
    const yesNo = [{ id: 'approve', label: 'Yes', text: 'optional', style: 'yes' }, { id: 'reject', label: 'No', text: 'optional', style: 'no' }];
    const escActs = [{ id: 'answer', label: 'Answer', text: 'required', style: 'yes' }, { id: 'park', label: 'Later', text: 'optional', style: 'neutral' },
                     { id: 'drop', label: 'Drop', text: 'optional', style: 'no' }];
    const propActs = [{ id: 'promote', label: 'Yes', text: 'optional', style: 'yes' }, { id: 'park', label: 'Later', text: 'optional', style: 'neutral' },
                      { id: 'drop', label: 'No', text: 'optional', style: 'no' }];
    function proposedItem(ticket, by, detail, title, more, at) {
      return { key: `proposed:${ticket}`, kind: 'proposed', ref: ticket, ticket, project: 'website', title, detail: detail + (more ? ' · ' + more : ''),
               by, at: iso(at || Date.now()), actions: propActs, pc_only: false };
    }
    function addWaiting(item) { waiting.push(item); waitingRev++; wake(); }
    const version = () => 'w' + waitingRev.toString(16).padStart(6, '0') + epoch.slice(0, 5);

    // ---------------------------------------------------------------- seed data
    (function seed() {
      const min = 60000, now = Date.now();
      const filler = [
        ['user', 'what did the builders get done yesterday?'],
        ['gup', 'Four tickets merged: the story ring fix, the settings page, two docs updates. One review failed and went back.'],
        ['user', 'ok. anything risky waiting?'],
        ['gup', 'Nothing risky. One publish waits on you; it passed its gate.'],
        ['user', 'remind me tomorrow morning'],
        ['gup', 'Done, I\'ll bring it up at 9.'],
      ];
      for (let i = 0; i < 60; i++) {
        const [who, body] = filler[i % filler.length];
        const owner = who === 'user';
        addMsg({ sender: who, role: owner ? 'owner' : 'gup', body, via: owner ? 'pc' : null }, now - (26 * 60 - i * 9) * min);
      }
      addMsg({ sender: 'gupworks', role: 'system', kind: 'status', body: 'Nightly update finished: 14 packages, no restart needed.' }, now - 75 * min);
      addMsg({ sender: 'user', role: 'owner', body: 'how\'s the website going?', via: 'phone' }, now - 29 * min);
      addMsg({ kind: 'tool', body: 'Bash: gw ticket show 152', tool: { name: 'Bash', error: false, done: true } }, now - 29 * min);
      addMsg({ body: 'The services page is built and the reviewer passed it (12 checks green). It\'s waiting on you to publish: **#152** Publish services page.' }, now - 28 * min);
      addMsg({ sender: 'user', role: 'owner', body: 'can Casper look at the story ring bug when he\'s free', via: 'phone' }, now - 21 * min);
      for (const t of ['Read: tickets.md', 'Bash: gw ticket propose', 'Edit: notes/ghost.md'])
        addMsg({ kind: 'tool', body: t, tool: { name: t.split(':')[0], error: false, done: true } }, now - 20 * min);
      addMsg({ body: 'Filed **#812** for Casper. He planned it and a builder is on it now.' }, now - 20 * min);
      addMsg({ sender: 'casper', role: 'agent', body: 'Builder picked up #812; first test run is green.' }, now - 9 * min);

      // cards as the PC makes them (docs/phone-api.md "The card"); approval:14 and proposed:161 stay without one, like an
      // item from an older PC, so the plain card is exercised too
      const reply = (label, action, text, style, recommended, pc_only) => ({ label, action, text, recommended: !!recommended, style, pc_only: !!pc_only });
      const card = (title, lines, replies) => ({ title, lines, replies, source: 'model', made_at: iso(now - 30 * min) });
      waiting = [
        { key: 'approval:12', kind: 'approval', ref: 12, ticket: 806, project: 'ghost', title: 'Publish Ghost 1.15.2',
          detail: 'Gate green: 41 passed, 0 failed. Reviewed by Opus 5.5.', by: 'casper', at: iso(now - 120 * min), actions: yesNo, pc_only: false,
          card: card('Publish Ghost 1.15.2', ['The new version passed every check and a reviewer signed it off.', 'Say yes and the team ships it.'], [
            reply('Yes, ship it', 'approve', 'Ship it.', 'yes', true), reply('Not yet', 'reject', 'Hold off for now.', 'no'),
            reply('Ask Gup about it', 'chat', 'About #806 (Publish Ghost 1.15.2): what changed in this version?', 'neutral')]) },
        { key: 'approval:14', kind: 'approval', ref: 14, ticket: 152, project: 'website', title: 'Publish services page',
          detail: 'Reviewer passed it: 12 checks green.', by: 'sky', at: iso(now - 28 * min), actions: yesNo, pc_only: false },
        { key: 'escalated:131:9031', kind: 'escalated', ref: 131, ticket: 131, project: 'mobile', title: 'Sideload with the free Apple ID or pay $99/yr?',
          detail: 'Free: re-signed every 7 days. Paid: TestFlight and push.', by: 'gizmo', at: iso(now - 64 * min), actions: escActs, pc_only: false,
          card: card('Free Apple ID or $99 a year?', ['Free means the app must be re-signed every 7 days.', 'Paid adds TestFlight and push.'], [
            reply('Stay on free for now', 'answer', 'Free for now.', 'yes', true), reply('Ask me later', 'park', 'Ask me again next week.', 'neutral'),
            reply('Tell me more', 'chat', 'About #131: what would the paid account change for me?', 'neutral')]) },
        proposedItem(161, 'gup', 'from an email', 'Weekly SEO report for the website', '', now - 40 * min),
        Object.assign(proposedItem(160, 'sky', 'from a web form', 'Fix the broken link a visitor reported', '', now - 4 * min), {
          card: card('Fix a broken link', ['A visitor reported a dead link on the website.'], [
            reply('Yes, fix it', 'promote', '', 'yes', true), reply('Later', 'park', '', 'neutral'), reply('No', 'drop', '', 'no')]) }),
        { key: 'stuck:157', kind: 'stuck', ref: 157, ticket: 157, project: 'website', title: 'Contact page build is past its time limit',
          detail: 'Building for 3 h (limit 2 h). Gup was told 40 min ago.', by: 'gup', at: iso(now - 40 * min),
          actions: [{ id: 'ok', label: 'It\'s fine', text: 'required', style: 'neutral' }], pc_only: false,
          card: card('Contact page build is slow', ['It has run 3 hours; the limit is 2.'], [
            reply('It\'s fine, keep going', 'ok', 'It is fine, leave it running.', 'neutral', true), reply('Ask Gup what happened', 'chat', 'About #157 (Contact page build is slow): why is it taking so long?', 'neutral')]) },
        { key: 'memory:5', kind: 'memory', ref: 5, ticket: null, project: null, title: 'New rule: run the gate before every publish',
          detail: 'The Librarian proposes a rule. Rules change only on the PC.', by: 'librarian', at: iso(now - 15 * min), actions: [], pc_only: true,
          card: card('New rule: run the gate first', ['The Librarian suggests running the tests before every publish.', 'Rules are decided on the PC.'], [
            reply('Accept the rule', 'accept', '', 'yes', true, true), reply('Ask Gup about it', 'chat', 'About the proposed rule "run the gate before every publish": why?', 'neutral')]) },
      ];
    })();

    // ---------------------------------------------------------------- endpoints
    function status() {
      return ok({
        api: 1, server_time: iso(Date.now()), paused: settings.paused, new_work: settings.newWork,
        usage: { five_hour: 34.0, five_hour_resets: iso(t0 + 3.2 * 3600e3), seven_day: 61.0, seven_day_resets: iso(t0 + 3.6 * 86400e3),
                 taken_at: iso(Date.now() - 90e3) },
        gup: { status: busy ? 'answering' : 'idle', busy, queued: msgs.filter(m => m.role === 'owner' && m.queued).length },
        waiting: waiting.length, device: { paired_at: iso(t0 - 86400e3) },
      });
    }

    async function getMessages(q, signal) {
      let limit = 50;
      if (q.limit !== undefined) {
        limit = Number(q.limit);
        if (!Number.isInteger(limit) || limit < 1) return err(400, 'bad_request', 'limit must be a positive integer');
        limit = Math.min(limit, 200);
      }
      if (q.cursor !== undefined) {
        const c = parseCursor(q.cursor);
        if (c !== null) {
          const wait = Math.max(0, Math.min(WAIT_MAX, Number(q.wait) || 0));
          await waitFor(() => seq > c, wait, signal);
          const changed = msgs.filter(m => m._rev > c).sort((a, b) => a.id - b.id).map(pub);
          return ok({ messages: changed, cursor: cursor(), busy, more_before: null, reset: false });
        }
        const page = msgs.slice(-limit);
        return ok({ messages: page.map(pub), cursor: cursor(), busy, more_before: msgs.length > page.length, reset: true });
      }
      if (q.before !== undefined) {
        const before = Number(q.before);
        if (!Number.isInteger(before)) return err(400, 'bad_request', 'before must be a message id');
        const older = msgs.filter(m => m.id < before);
        const page = older.slice(-limit);
        return ok({ messages: page.map(pub), cursor: null, busy, more_before: older.length > page.length, reset: false });
      }
      const page = msgs.slice(-limit);
      return ok({ messages: page.map(pub), cursor: cursor(), busy, more_before: msgs.length > page.length, reset: false });
    }

    function postMessage(body) {
      if (typeof body.text !== 'string' || !body.text.trim()) return err(400, 'bad_request', 'text is required');
      const text = body.text.trim();
      if (text.length > TEXT_MAX) return err(413, 'too_large', `text is over ${TEXT_MAX} characters`);
      const cid = body.client_id;
      if (cid != null && (typeof cid !== 'string' || !CLIENT_ID.test(cid))) return err(400, 'bad_request', 'client_id: up to 64 of A-Z a-z 0-9 _ . -');
      if (cid && byClient.has(cid)) return ok({ message: pub(byClient.get(cid)), duplicate: true }, 200);
      const m = addMsg({ sender: 'user', role: 'owner', body: text, queued: true, via: 'phone', client_id: cid || null });
      if (cid) byClient.set(cid, m);
      queue.push(m);
      work();
      return ok({ message: pub(m), duplicate: false }, 201);
    }

    async function getWaiting(q, signal) {
      if (q.version !== undefined) {
        const v = String(q.version);
        await waitFor(() => version() !== v, Math.max(0, Math.min(WAIT_MAX, Number(q.wait) || 0)), signal);
      }
      return ok({ items: JSON.parse(JSON.stringify(waiting)), count: waiting.length, version: version() });
    }

    function act(body) {
      const { key, action, confirm } = body;
      if (typeof key !== 'string' || typeof action !== 'string') return err(400, 'bad_request', 'key and action are required');
      const at = confirm && Date.parse(confirm.at);
      if (!confirm || typeof confirm !== 'object' || confirm.key !== key || confirm.action !== action ||
          !METHODS.includes(confirm.method) || !at || Math.abs(Date.now() - at) > 120e3)
        return err(428, 'confirmation_required', 'Confirm this decision with Face ID first.');
      const item = waiting.find(i => i.key === key);
      if (!item) return err(409, 'stale', 'It isn\'t waiting anymore (decided elsewhere or changed). Refresh the list.');
      if (item.pc_only) return err(403, 'pc_only', 'This one can only be decided on the PC.');
      const a = item.actions.find(x => x.id === action);
      if (!a) return err(400, 'bad_request', `unknown action: ${action}`);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (a.text === 'required' && !text) return err(400, 'bad_request', 'this action needs text');
      if (text.length > ANSWER_MAX) return err(413, 'too_large', `text is over ${ANSWER_MAX} characters`);
      waiting = waiting.filter(i => i !== item);
      waitingRev++;
      const verb = { approve: 'approved', reject: 'rejected', answer: 'answered', park: 'parked', drop: 'dropped', promote: 'started', ok: 'okayed' }[action] || action;
      const summary = `you ${verb} via phone: ${item.title}${text ? ` (${text})` : ''}`;
      addMsg({ sender: 'gupworks', role: 'system', kind: 'status', body: `Decided on your phone: ${summary.replace(/^you /, '')}` });
      return ok({ ok: true, receipt: { key, action, ticket: item.ticket, at: iso(Date.now()), summary } });
    }

    function rotate() {
      tokens.pending = 'mock-' + hex(24);
      return ok({ token: tokens.pending, created_at: iso(Date.now()) });
    }

    function checkAuth(header) {
      const m = /^Bearer (\S+)$/.exec(header || '');
      if (!m) return false;
      if (m[1] === tokens.current) return true;
      if (tokens.pending && m[1] === tokens.pending) { tokens.current = tokens.pending; tokens.pending = null; return true; }
      return false;
    }

    const ROUTES = {
      '/v1/status': { GET: () => status() },
      '/v1/threads/gup/messages': { GET: (q, b, s) => getMessages(q, s), POST: (q, b) => postMessage(b) },
      '/v1/waiting': { GET: (q, b, s) => getWaiting(q, s) },
      '/v1/waiting/act': { POST: (q, b) => act(b) },
      '/v1/auth/rotate': { POST: () => rotate() },
      // remote desktop: answered by a fake host (mock-desktop.js) when there is one; the HTTP mock has none
      '/v1/desktop/status': { GET: () => desk ? desk.status() : ok({ available: false, versions: [1], session: null, reason: 'This mock has no desktop host (use index.html?mock in a browser).' }) },
      '/v1/desktop/sessions': { POST: (q, b) => desk ? desk.start(b) : err(503, 'host_unavailable', 'This mock has no desktop host.') },
    };
    const DESK_SESSION = /^\/v1\/desktop\/sessions\/([A-Za-z0-9_-]{22})\/(answer|end)$/;
    function deskRoute(path) {
      const m = DESK_SESSION.exec(path);
      if (!m) return null;
      return { POST: (q, b) => !desk ? err(409, 'stale', 'No such session.') : m[2] === 'answer' ? desk.answer(m[1], b) : desk.end(m[1]) };
    }

    /** One request: {method, path, query (strings), auth (Authorization header), contentType, contentLength (number or
        null), bodyText, signal}. Resolves {status, json}. */
    async function handle(req) {
      if (!checkAuth(req.auth)) {
        await sleep(authDelayMs);
        return err(401, 'unauthorized', 'Not paired: pair this phone again.');
      }
      const route = ROUTES[req.path] || deskRoute(req.path);
      if (!route) return err(404, 'not_found', 'no such endpoint');
      const fn = route[req.method];
      if (!fn) return err(405, 'method_not_allowed', `use ${Object.keys(route).join(' or ')}`);
      let body = null;
      if (req.method === 'POST') {
        if (req.contentLength == null) return err(411, 'length_required', 'Content-Length is required');
        if (req.contentLength > BODY_MAX) return err(413, 'too_large', 'body over 16 KiB');
        if (!/^application\/json\b/i.test(req.contentType || '')) return err(415, 'unsupported_media_type', 'send application/json');
        try { body = JSON.parse(req.bodyText || ''); } catch (e) { return err(400, 'bad_request', 'bad JSON'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return err(400, 'bad_request', 'body must be a JSON object');
      }
      try {
        return await fn(req.query || {}, body, req.signal);
      } catch (e) {
        return err(500, 'server_error', String(e && e.message || e));
      }
    }

    return {
      handle,
      get token() { return tokens.current; },
      /** test and demo helpers */
      addWaiting, proposedItem,
      set(o) { if ('paused' in o) settings.paused = o.paused; if ('newWork' in o) settings.newWork = o.newWork; },
      get counts() { return { messages: msgs.length, waiting: waiting.length, longPolls }; },
    };
  }

  /** A GupAPI transport that answers from a mock in this page (same {status, json} as the HTTP one). */
  function inPageTransport(mock, opts) {
    const latency = (opts && opts.latencyMs) || 25;
    return async function (req) {
      if (req.signal && req.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const bodyText = req.body === undefined ? null : JSON.stringify(req.body);
      const query = {};
      for (const k of Object.keys(req.query || {})) if (req.query[k] != null) query[k] = String(req.query[k]);
      await sleep(latency);
      const res = await mock.handle({
        method: req.method, path: req.path, query, auth: 'Bearer ' + mock.token, signal: req.signal,
        contentType: bodyText == null ? null : 'application/json',
        contentLength: bodyText == null ? null : new TextEncoder().encode(bodyText).length, bodyText,
      });
      if (req.signal && req.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { status: res.status, json: JSON.parse(JSON.stringify(res.json)) };
    };
  }

  const GupMock = { createMock, inPageTransport, DEV_TOKEN };
  root.GupMock = GupMock;
  if (typeof module !== 'undefined' && module.exports) module.exports = GupMock;
})(typeof window !== 'undefined' ? window : globalThis);
