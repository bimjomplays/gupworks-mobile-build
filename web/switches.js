/* Switches screen and "type on the PC" pop-up (Core #524: docs/phone-api.md "Quick switches" and "Type on the PC").
   They replace the old Clodex toggles and its clodex-ask command.

   Switches: the PC lists them (GET /v1/switches) and this screen draws what it gets: Away mode and the game bot as on/off
   toggles with their status, Restart PC as a button. A restart is never fired by one tap: tap, read the warning, tap the
   red button, Face ID, and only then is it sent.

   Type on the PC: an agent that needs a password or 2FA code typed into a PC window asks for it; the PC lists the
   request (GET /v1/type-requests) and this module pops a sheet over whatever screen is open. The owner types into masked
   boxes and Face ID confirms; the values go in the POST body straight from the boxes to the PC's virtual keyboard. They
   are never kept in a variable of this module past the send, shown, logged, toasted, put in an error text or stored, and
   the boxes are emptied the moment they are sent, when the sheet closes and when the app locks.
   The app polls while it is open (a push for a request that arrives while the app is closed is Core's stage 2). */
(function (root) {
  'use strict';
  const API = root.GupAPI, { esc, ic, toast, sheet } = root.GupUI;
  const $ = id => document.getElementById(id);
  const sleep = (ms, signal) => new Promise(r => {
    const t = setTimeout(r, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
  });

  const VALUE_MAX = 256;                 // the PC refuses longer
  const UNTYPEABLE = /[^\x20-\x7e]/;     // the PC types US-keyboard characters only
  const TYPE_POLL_MS = 4000, SWITCH_POLL_MS = 15000;

  const S = {
    list: null,                          // [{id, label, ...}] from the PC, or null (not asked yet)
    error: '',                           // why the list couldn't be read, in words
    supported: true,                     // false: an older PC (404)
    busy: new Map(),                     // switch id -> true while a flip / restart is on its way
    notes: new Map(),                    // switch id -> {text, kind: bad | good}: the last answer, in words
    restart: null,                       // {state: going | waiting | back | late, since} after Restart PC was accepted
    requests: [],                        // the PC's waiting type requests
    typeSupported: true,
    dismissed: new Set(),                // request ids the owner chose "later" for: not popped up again
    sheet: null,                         // {id, el, close, ...} while the pop-up is open
    loading: false,
  };

  // ================================================================ the switches screen
  const view = () => $('v-switches');

  function statusLine(sw) {
    if (sw.kind !== 'toggle') return '';
    if (sw.on === true) return '<b class="green">● on</b>';
    if (sw.on === false) return '<b class="dim">○ off</b>';
    return '<b class="amber">? unknown</b>';
  }

  function switchCard(sw) {
    const busy = S.busy.get(sw.id), note = S.notes.get(sw.id);
    const unknown = sw.kind === 'toggle' && sw.on == null;
    let control;
    if (sw.kind === 'toggle') {
      control = `<button class="swt${sw.on === true ? ' on' : ''}${unknown ? ' unk' : ''}" type="button" role="switch" data-sw="${esc(sw.id)}" ` +
        `aria-checked="${sw.on === true}" aria-label="${esc(sw.label)}"${busy ? ' disabled' : ''}><i></i></button>`;
    } else {
      control = `<button class="btn no swbtn" type="button" data-run="${esc(sw.id)}"${busy || S.restart ? ' disabled' : ''}>${esc(sw.button || 'Run')}</button>`;
    }
    const detail = sw.detail ? `<div class="swd">${esc(sw.detail)}</div>` : '';
    const err = sw.error ? `<div class="swe bad">${esc(sw.error)}</div>` : '';
    const msg = busy ? `<div class="swe">⠶ ${sw.kind === 'toggle' ? 'working… this can take a couple of minutes' : 'sending…'}</div>`
      : note ? `<div class="swe ${note.kind}">${esc(note.text)}</div>` : '';
    return `<div class="card g sw" data-card="${esc(sw.id)}"><div class="swh"><span class="swi">${esc(sw.icon || '•')}</span>` +
      `<div class="grow"><div class="swn">${esc(sw.label)}</div><div class="swn2">${statusLine(sw)}</div></div>${control}</div>` +
      `<div class="swt2">${esc(sw.note || '')}</div>${detail}${err}${msg}</div>`;
  }

  function restartBanner() {
    const r = S.restart;
    if (!r) return '';
    const text = r.state === 'going' ? 'The PC is restarting. It will be back in a minute or two.'
      : r.state === 'waiting' ? 'The PC went down. Waiting for it to come back (after it logs in)…'
      : r.state === 'back' ? '<b class="green">✓</b> The PC is back.'
      : 'The PC hasn\'t answered for a while. Check it; the phone keeps trying.';
    return `<div class="notice g swrs" style="margin:0"><b>›</b> ${text}</div>`;
  }

  function typeSection() {
    if (!S.requests.length) return '';
    const rows = S.requests.map(r => `<button class="cr" type="button" data-req="${esc(r.id)}"><span class="ico">${ic('keyboard', 20)}</span>` +
      `<div class="grow"><div class="a">${esc(r.title || 'Type on the PC')}</div><div class="b">${esc(r.asker || 'an agent')} · ${esc(r.target || '')}</div></div>` +
      `${ic('chev', 16, 2.4, 'dim')}</button>`).join('');
    return `<div class="lbl" style="padding:2px 4px 0">asked to type on the PC</div><div class="crew g">${rows}</div>`;
  }

  function render() {
    const v = view(), body = $('sw-body');
    if (!body) return;
    const chip = !API.configured || API.unauthorized ? '<span class="chip c-a dot">not paired</span>'
      : S.error && !S.list ? '<span class="chip c-r dot">no answer</span>' : '<span class="chip c-g dot">live</span>';
    let html = `<div class="hdr"><button class="swback g" type="button" data-back aria-label="Back to Status">${ic('back', 22, 2.2)}</button>` +
      `<h1>Switches</h1>${chip}</div>`;
    if (!S.supported) {
      html += `<div class="notice g" style="margin:0"><b>›</b> This PC can't do switches from the phone yet. Update GupWorks on the PC.</div>`;
    } else if (!S.list) {
      html += `<div class="notice g" style="margin:0"><b>›</b> ${S.error ? esc(S.error) : 'Asking the PC…'}</div>`;
    } else {
      html += typeSection() + restartBanner();
      html += S.list.length ? S.list.map(switchCard).join('') : `<div class="notice g" style="margin:0"><b>›</b> The PC lists no switches.</div>`;
      if (S.error) html += `<div class="notice g" style="margin:0"><b>›</b> ${esc(S.error)}</div>`;
    }
    body.innerHTML = html;
    v.classList.toggle('has-req', !!S.requests.length);
  }

  const WHY = (e, what) => e.offline ? `PC not reachable: ${what} was not changed.`
    : e.status === 428 ? 'Not confirmed, so nothing happened. Try again.'
    : e.status === 503 ? 'Another switch is still changing. Try again in a moment.'
    : e.status === 404 ? 'This PC doesn\'t know that switch (update GupWorks on the PC).'
    : e.status === 502 ? (e.code === 'restart_refused' ? 'The PC refused to restart: ' : 'It didn\'t work: ') + String(e.message || '').slice(0, 300)
    : String(e.message || 'It didn\'t work.').slice(0, 300);

  async function load(opts) {
    if (!API.configured || API.unauthorized || S.loading) return;
    S.loading = true;
    try {
      const r = await API.switches(opts);
      S.list = Array.isArray(r && r.switches) ? r.switches : [];
      S.error = ''; S.supported = true;
    } catch (e) {
      if (e.status === 404) { S.supported = false; S.list = null; }
      else if (e.code !== 'aborted') S.error = e.offline ? 'Can\'t reach the PC. Is the phone on Tailscale?' : 'The PC didn\'t give the list: ' + String(e.message || '').slice(0, 200);
    }
    S.loading = false;
    if (!S.busy.size) render();
  }

  /** Away mode ("monitors and RGB go off ...") asks first when the PC says so; off never does. */
  function askFirst(sw) {
    return new Promise(resolve => {
      let go = false;
      const s = sheet(
        `<div class="vtitle acc">${esc(sw.label)} <span>· turn on</span></div>` +
        `<div class="vtext">${esc(sw.confirm_text)}</div>` +
        `<div class="vrow"><button class="btn q" data-act="cancel" type="button">cancel</button>` +
        `<button class="btn p" data-act="ok" type="button">turn on</button></div>`, () => resolve(go));
      s.el.classList.add('confirm', 'swask');
      s.el.querySelector('[data-act=cancel]').addEventListener('click', s.close);
      s.el.querySelector('[data-act=ok]').addEventListener('click', () => { go = true; s.close(); });
    });
  }

  async function toggle(id) {
    const sw = (S.list || []).find(x => x.id === id);
    if (!sw || S.busy.size) return;
    const action = sw.on === true ? 'off' : 'on';
    if (action === 'on' && sw.confirm_text && !(await askFirst(sw))) return;
    S.busy.set(id, true); S.notes.delete(id);
    render();
    try {
      const r = await API.switchAct(id, action);
      const now = r && r.switch;
      if (now && now.id === id) Object.assign(sw, now);
      S.notes.set(id, { kind: 'good', text: `${sw.label} is ${sw.on === true ? 'on' : sw.on === false ? 'off' : 'changed'}.` });
    } catch (e) {
      S.notes.set(id, { kind: 'bad', text: WHY(e, sw.label) });
    }
    S.busy.delete(id);
    render();
    load();                                              // read what the PC really says now
  }

  /** Restart PC: warning with the PC's words -> red button -> Face ID -> sent. Nothing here ever fires by itself. */
  function runButton(id) {
    const sw = (S.list || []).find(x => x.id === id);
    if (!sw || S.busy.size || S.restart) return;
    let go = false;
    const s = sheet(
      `<div class="vtitle">${esc(sw.label)}</div>` +
      `<div class="vtext">${esc(sw.confirm_text || sw.note || 'Run this on the PC?')}</div>` +
      `<div class="vrow"><button class="btn q" data-act="cancel" type="button">cancel</button>` +
      `<button class="btn no" data-act="ok" type="button">${esc(sw.button || 'Run')} now</button></div>` +
      `<div class="vnote">then Face ID confirms it</div>`, () => { if (go) send(sw); });
    s.el.classList.add('confirm', 'swask');
    s.el.querySelector('[data-act=cancel]').addEventListener('click', s.close);
    s.el.querySelector('[data-act=ok]').addEventListener('click', () => { go = true; s.close(); });
  }

  async function send(sw) {
    const confirm = await root.GupHooks.confirmSwitch({ id: sw.id, label: sw.label });
    if (!confirm) { S.notes.set(sw.id, { kind: 'bad', text: 'Not confirmed, so nothing happened.' }); return render(); }
    S.busy.set(sw.id, true); S.notes.delete(sw.id);
    render();
    try {
      const r = await API.switchAct(sw.id, 'run', confirm);
      if (r && r.restarting) { S.restart = { state: 'going', since: Date.now() }; watchRestart(); }
      else S.notes.set(sw.id, { kind: 'good', text: 'Done.' });
    } catch (e) {
      S.notes.set(sw.id, { kind: 'bad', text: WHY(e, sw.label) });
    }
    S.busy.delete(sw.id);
    render();
  }

  /** After a restart is accepted the bridge goes quiet: look at /v1/status until it answers again. */
  let watching = false;
  async function watchRestart() {
    if (watching) return;
    watching = true;
    let down = false;
    while (S.restart && S.restart.state !== 'back') {
      await sleep(4000);
      try {
        await API.status();
        // the PC answers right after the command too; "back" only counts once it was seen gone, or after a minute
        if (down || Date.now() - S.restart.since > 60000) { S.restart.state = 'back'; break; }
      } catch (e) {
        if (e.status === 401) break;
        down = true;
        S.restart.state = Date.now() - S.restart.since > 5 * 60000 ? 'late' : 'waiting';
      }
      render();
    }
    watching = false;
    if (!S.restart) return;
    render();
    load();
    setTimeout(() => { if (S.restart && S.restart.state === 'back') { S.restart = null; render(); } }, 6000);
  }

  // ================================================================ type on the PC
  const fmtLeft = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const leftSec = r => Math.max(0, Math.floor((r.expires * 1000 - API.serverNow().getTime()) / 1000));

  function openType(id) {
    const req = S.requests.find(r => r.id === id);
    if (!req || S.sheet) return;
    const fields = (Array.isArray(req.fields) && req.fields.length ? req.fields : [{ label: 'Text', secret: true }]).slice(0, 8);
    const inputs = fields.map((f, i) =>
      `<label class="tyf"><span>${esc(f.label || 'Field ' + (i + 1))}</span>` +
      `<input class="ty-in" type="${f.secret ? 'password' : 'text'}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" ` +
      `enterkeyhint="${i === fields.length - 1 ? 'send' : 'next'}" maxlength="${VALUE_MAX}" aria-label="${esc(f.label || 'Field ' + (i + 1))}" data-i="${i}"></label>`).join('');
    const s = sheet(
      `<div class="vtitle acc">type on the PC <span>· ${esc(req.asker || 'an agent')} asks</span></div>` +
      `<div class="vtext ty-what"><b>${esc(req.title || 'Type on the PC')}</b>` +
        `${req.note ? `<span> · ${esc(req.note)}</span>` : ''}` +
        `<div class="ctext">into: ${esc(req.target || 'the window on the PC')}</div></div>` +
      `<div class="ty-fields">${inputs}</div>` +
      `<label class="tyenter"><input type="checkbox" class="ty-enter"${req.enter ? ' checked' : ''}> press Enter afterwards</label>` +
      `<div class="swe ty-msg" role="status"></div>` +
      `<div class="vrow"><button class="btn q ty-later" type="button">later</button>` +
      `<button class="btn p ty-go" type="button" disabled>${ic('arrowup', 20, 2.4)}type on PC</button></div>` +
      `<button class="btn no ty-cancel" type="button">cancel request</button>` +
      `<div class="vnote ty-note">goes from your phone to the PC's keyboard.<br>the AI never sees it · <span class="ty-left"></span></div>`,
      () => { wipe(); stopClock(); if (S.sheet && S.sheet.id === id) S.sheet = null; });
    s.el.classList.add('typing');
    S.sheet = { id, el: s.el, close: s.close, working: false, over: false };
    const q = sel => s.el.querySelector(sel);
    const all = () => Array.from(s.el.querySelectorAll('.ty-in'));
    const sync = () => {
      q('.ty-go').disabled = S.sheet.working || S.sheet.over || all().some(i => !i.value);
      all().forEach(i => { i.disabled = S.sheet.working || S.sheet.over; });
      q('.ty-cancel').disabled = S.sheet.working;
      q('.ty-later').disabled = S.sheet.working;
    };
    S.sheet.sync = sync;
    all().forEach((i, n) => {
      i.addEventListener('input', () => { q('.ty-msg').textContent = ''; sync(); });
      i.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.isComposing) return;
        e.preventDefault();
        if (n < all().length - 1) all()[n + 1].focus(); else submit();
      });
    });
    q('.ty-go').addEventListener('click', submit);
    q('.ty-later').addEventListener('click', () => { S.dismissed.add(id); s.close(); render(); });
    q('.ty-cancel').addEventListener('click', cancelRequest);
    tick();
    S.sheet.clock = setInterval(tick, 1000);
    sync();
    setTimeout(() => { const f = all()[0]; if (f && S.sheet && S.sheet.id === id) f.focus(); }, 80);
  }

  function stopClock() { if (S.sheet && S.sheet.clock) clearInterval(S.sheet.clock); }
  function wipe() { if (S.sheet) S.sheet.el.querySelectorAll('.ty-in').forEach(i => { i.value = ''; }); }
  function say(text, bad) {
    if (!S.sheet) return;
    const m = S.sheet.el.querySelector('.ty-msg');
    m.textContent = text; m.className = 'swe ty-msg' + (bad ? ' bad' : '');
  }

  /** the clock on the sheet; at the end the request is over (the PC drops it too) */
  function tick() {
    const sh = S.sheet, req = sh && S.requests.find(r => r.id === sh.id);
    if (!sh) return;
    const left = req ? leftSec(req) : 0;
    sh.el.querySelector('.ty-left').textContent = left > 0 ? `expires in ${fmtLeft(left)}` : 'expired';
    if (left <= 0 && !sh.over && !sh.working) over('This request expired. Ask the agent again if it is still needed.');
  }

  /** the request is no longer waiting (expired, cancelled by the agent, typed elsewhere): empty the boxes and say so */
  function over(text) {
    const sh = S.sheet;
    if (!sh || sh.over) return;
    sh.over = true;
    wipe();
    say(text, true);
    sh.sync();
    const id = sh.id;
    setTimeout(() => { if (S.sheet && S.sheet.id === id) S.sheet.close(); }, 2500);
  }

  async function submit() {
    const sh = S.sheet;
    if (!sh || sh.working || sh.over) return;
    const req = S.requests.find(r => r.id === sh.id);
    const boxes = Array.from(sh.el.querySelectorAll('.ty-in'));
    if (!req || boxes.some(b => !b.value)) return;
    if (boxes.some(b => UNTYPEABLE.test(b.value))) return say('The PC can only type plain US-keyboard characters (letters, digits, symbols, space). Check for curly quotes or accents.', true);
    const title = req.title;
    sh.working = true; sh.sync(); say('Confirm with Face ID…');
    const confirm = await root.GupHooks.confirmType({ id: sh.id, title });
    if (S.sheet !== sh || sh.over) return;               // closed or locked meanwhile: the boxes were emptied then
    if (!confirm) { sh.working = false; sh.sync(); return say('Not confirmed, so nothing was typed.', true); }
    say('Typing on the PC…');
    // the values leave the boxes and go into the request in the same breath; nothing else holds them
    const enter = sh.el.querySelector('.ty-enter').checked;
    const posting = API.typeAnswer(sh.id, boxes.map(b => b.value), enter, confirm);
    wipe();
    let ok = false, why = '';
    try {
      await posting;
      ok = true;
    } catch (e) {
      why = e.offline ? 'PC not reachable. Nothing was typed; type it again when it is back.'
        : e.status === 409 && e.code === 'busy' ? 'Away mode is switching right now. Wait a moment and type it again.'
        : e.status === 409 ? 'That request is already finished or expired.'
        : e.status === 400 || e.status === 413 ? 'The PC can\'t type that (plain US-keyboard characters, up to 256 each).'
        : e.status === 428 ? 'Not confirmed, so nothing was typed. Try again.'
        : e.status === 502 ? 'The PC couldn\'t type it: the window is gone or the PC\'s virtual keyboard isn\'t running.'
        : e.status === 404 ? 'That request is gone.'
        : 'The PC didn\'t take it. Nothing was kept on the phone; type it again.';
      if (e.status === 409 && e.code !== 'busy' || e.status === 404 || e.status === 502) { S.dismissed.add(sh.id); }
    }
    if (S.sheet !== sh) return;
    sh.working = false;
    if (ok) {
      S.dismissed.add(sh.id);
      S.requests = S.requests.filter(r => r.id !== sh.id);
      sh.close();
      toast('<b>✓</b> Typed on the PC', 'good');
      render();
      pollNow();
    } else {
      sh.sync();
      say(why, true);
      if (sh.el.querySelector('.ty-in')) sh.el.querySelector('.ty-in').focus();
    }
  }

  async function cancelRequest() {
    const sh = S.sheet;
    if (!sh || sh.working) return;
    sh.working = true; sh.sync();
    const id = sh.id;
    try {
      await API.typeCancel(id);
      toast('Cancelled: the agent is told.', 'good');
    } catch (e) {
      if (e.status !== 409) { sh.working = false; sh.sync(); return say(e.offline ? 'PC not reachable. The request is still open.' : 'Couldn\'t cancel it.', true); }
    }
    S.dismissed.add(id);
    S.requests = S.requests.filter(r => r.id !== id);
    if (S.sheet === sh) sh.close();
    render();
    pollNow();
  }

  /** a new list from the PC: pop up what is new, and tell an open pop-up when its request went away */
  function applyRequests(list) {
    S.requests = list;
    const ids = new Set(list.map(r => r.id));
    S.dismissed.forEach(id => { if (!ids.has(id)) S.dismissed.delete(id); });
    if (S.sheet && !ids.has(S.sheet.id) && !S.sheet.working) over('This request is no longer waiting (finished, cancelled or expired).');
    if (!S.sheet && !root.GupLock.isLocked) {
      const next = list.find(r => !S.dismissed.has(r.id) && leftSec(r) > 0);
      if (next) { S.dismissed.add(next.id); openType(next.id); }   // popped once; "later" and the list reopen it
    }
    render();
    if (root.GupApp) root.GupApp.renderStatus();         // the Status row counts them
  }

  async function pollType(signal) {
    if (!API.configured || API.unauthorized) return;
    try {
      const r = await API.typeRequests({ signal });
      S.typeSupported = true;
      applyRequests(Array.isArray(r && r.requests) ? r.requests : []);
    } catch (e) {
      if (e.status === 404) { S.typeSupported = false; S.requests = []; }
    }
  }

  let nudge = null;
  function pollNow() { if (nudge) nudge(); }

  /** The loops, tied to the app's run signal: type requests every few seconds, the switches while their screen is open. */
  async function run(signal) {
    let lastSwitches = 0;
    while (!signal.aborted) {
      await pollType(signal);
      if (!S.typeSupported) { await sleep(300000, signal); continue; }
      const open = root.GupApp && root.GupApp.state.tab === 'switches';
      if (open && Date.now() - lastSwitches > SWITCH_POLL_MS - 500) { lastSwitches = Date.now(); load({ signal }); }
      await new Promise(resolve => { nudge = resolve; sleep(TYPE_POLL_MS, signal).then(resolve); });
      nudge = null;
    }
  }

  /** the screen was opened: read the list now */
  function show() { render(); load(); pollNow(); }

  function closeSheet() { wipe(); if (S.sheet) S.sheet.close(); }
  function reset() {
    closeSheet();
    Object.assign(S, { list: null, error: '', supported: true, requests: [], typeSupported: true, restart: null });
    S.busy.clear(); S.notes.clear(); S.dismissed.clear();
    render();
  }

  function wire() {
    const v = view();
    v.addEventListener('click', e => {
      if (e.target.closest('[data-back]')) return root.GupApp.showTab('status');
      const sw = e.target.closest('[data-sw]');
      if (sw) return toggle(sw.dataset.sw);
      const run = e.target.closest('[data-run]');
      if (run) return runButton(run.dataset.run);
      const rq = e.target.closest('[data-req]');
      if (rq) { S.dismissed.add(rq.dataset.req); openType(rq.dataset.req); }
    });
    render();
  }

  root.GupSwitches = { wire, run, show, render, reset, closeSheet, load, get state() { return S; } };
})(window);
