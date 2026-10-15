/* Claude sign-in from the phone: when the PC's Claude login expires, one banner (not one notice per chat) and a bottom sheet:
   open the claude.ai sign-in page in the phone's browser, paste the code it shows, send it to the PC, watch the status
   (awaiting code -> finishing -> signed in again).
   The PC's side is Core #485 (web/api.js claudeLogin*, web/mock.js):
     GET /v1/claude-login {state: ok | expired | awaiting-code | finishing, since, message, url, expires_at, error: {code, message}, paused, version}
   The pasted code is a secret. It lives in the input box until the owner taps send, goes straight into the POST body
   (GupAPI.claudeLoginCode) and is wiped from the box before the request even starts. It is never kept in a variable of
   this module, shown, logged, toasted or put in an error text, and the sheet clears it when it closes or the app locks. */
(function (root) {
  'use strict';
  const API = root.GupAPI, { esc, ic, toast, sheet } = root.GupUI;
  const $ = id => document.getElementById(id);
  const sleep = (ms, signal) => new Promise(r => {
    const t = setTimeout(r, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
  });

  const STATES = ['ok', 'expired', 'awaiting-code', 'finishing'];
  const CODE_MAX = 512;                 // the PC refuses longer, and any code with spaces inside
  const BANNER = {
    expired: ['Claude is signed out', 'tap to sign in again'],
    'awaiting-code': ['Claude is waiting for your code', 'tap to enter it'],
    finishing: ['Claude is finishing sign-in', 'one moment'],
  };
  // the last attempt's error, in fixed words (the PC's own error text is kept off the screen)
  const ERRORS = {
    bad_code: 'That code didn\'t work. Start again for a fresh sign-in page and copy the new code.',
    timeout: 'The sign-in page expired before a code came back. Start again.',
    login_failed: 'The PC couldn\'t finish signing in. Start again.',
    start_failed: 'The PC couldn\'t start the sign-in. Try again.',
  };
  const HOSTS = ['claude.ai', 'claude.com', 'anthropic.com'];

  /** Only a real https claude.ai / claude.com / anthropic.com link is opened (the PC's answer is data, not a command). */
  function safeUrl(u) {
    if (typeof u !== 'string' || u.length > 4000) return null;
    let url;
    try { url = new URL(u); } catch (e) { return null; }
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h)) ? url.href : null;
  }

  const S = {
    cur: null,                   // {state, url, since, error (a code), paused} from the PC, or null (not asked yet, or a PC without it)
    supported: true,
    wasOut: false,               // the login was out since we last saw it signed in: say "signed in again" once
    sheet: null,                 // {el, close} while open
    sending: false, starting: false, done: false, note: '',
  };

  function norm(j) {
    if (!j || !STATES.includes(j.state)) return null;
    const e = j.error && typeof j.error === 'object' && typeof j.error.code === 'string' ? j.error.code : null;
    return { state: j.state, url: safeUrl(j.url), since: j.since || null, error: e, paused: j.paused === true };
  }

  // ---------------------------------------------------------------- banner
  function renderBanner() {
    const el = $('cbn'), c = S.cur;
    const show = !!(c && c.state !== 'ok');
    document.documentElement.classList.toggle('claude-out', show);
    el.hidden = !show;
    if (!show) return;
    const [a, b] = BANNER[c.state];
    el.innerHTML = `<span class="cbi">${ic('lock', 20, 2.2)}</span><span class="cbt"><b>${esc(a)}</b><i>${esc(b)}</i></span>${ic('chev', 15, 2.6, 'dim')}`;
    el.classList.toggle('busy', c.state === 'finishing');
  }

  // ---------------------------------------------------------------- the sheet
  function sheetMessage(c) {
    if (S.done) return '<b>✓</b> Signed in again. Gup and the team are back.';
    if (S.note) return esc(S.note);
    if (!c) return 'Asking the PC…';
    if (c.state === 'finishing') return 'Finishing sign-in on the PC…';
    const err = c.error ? `<b>${esc(ERRORS[c.error] || 'The last sign-in attempt didn\'t work.')}</b><br>` : '';
    if (c.state === 'awaiting-code') {
      return err + (c.url ? '<b>1</b> Open the sign-in page and choose Google.<br><b>2</b> Copy the code it shows and paste it below.'
                          : 'The PC is waiting for a code. Tap start sign-in for the page to open.');
    }
    return err + 'Claude on your PC is signed out' + (c.paused ? ', so Gup and the team are paused' : '') + '. Signing in again takes a minute.';
  }

  function renderSheet() {
    const s = S.sheet;
    if (!s) return;
    const c = S.cur, el = s.el;
    const st = S.done ? 'done' : c ? c.state : 'unknown';
    el.querySelector('.cl-msg').innerHTML = sheetMessage(c);
    const title = el.querySelector('.vtitle');
    title.innerHTML = S.done ? 'claude · signed in' : st === 'awaiting-code' ? 'claude · awaiting code' : st === 'finishing' ? 'claude · finishing' : 'claude · signed out';
    title.classList.toggle('acc', S.done || st === 'finishing');
    const link = el.querySelector('.cl-open'), start = el.querySelector('.cl-start'), code = el.querySelector('.cl-code');
    const url = c && c.url;
    link.hidden = !(url && st === 'awaiting-code');
    if (url) link.href = url;
    start.hidden = !(c && (st === 'expired' || (st === 'awaiting-code' && !url)));
    start.disabled = S.starting;
    code.hidden = st !== 'awaiting-code';
    const input = el.querySelector('.cl-input'), send = el.querySelector('.cl-send');
    input.disabled = S.sending;
    send.disabled = S.sending || !input.value.trim();
    el.querySelector('.cl-spin').hidden = !(S.sending || st === 'finishing');
  }

  function openSheet() {
    if (S.sheet) return;
    S.done = false; S.note = '';
    const s = sheet(
      `<div class="vtitle"></div>` +
      `<div class="vtext msg cl-msg"></div>` +
      `<div class="cl-spin dim" hidden>⠶ working…</div>` +
      `<a class="btn p cl-open" target="_blank" rel="noopener noreferrer" hidden>${ic('arrowup', 20, 2.4)}open the sign-in page</a>` +
      `<button class="btn p cl-start" type="button" hidden>${ic('arrowup', 20, 2.4)}start sign-in</button>` +
      `<div class="cl-code" hidden>` +
        `<input class="cl-input" type="text" inputmode="text" enterkeyhint="send" autocomplete="off" autocapitalize="off" autocorrect="off" ` +
        `spellcheck="false" maxlength="${CODE_MAX}" aria-label="Sign-in code" placeholder="› paste the code here">` +
        `<button class="btn p cl-send" type="button" disabled>${ic('arrowup', 20, 2.4)}send code</button>` +
      `</div>` +
      `<button class="btn q" data-act="cancel" type="button">close</button>`,
      () => { wipe(); S.sheet = null; });
    s.el.classList.add('claude');
    S.sheet = s;
    const input = s.el.querySelector('.cl-input');
    input.addEventListener('input', () => { S.note = ''; renderSheet(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); } });
    s.el.querySelector('.cl-send').addEventListener('click', submit);
    s.el.querySelector('.cl-start').addEventListener('click', startLogin);
    s.el.querySelector('[data-act=cancel]').addEventListener('click', s.close);
    // opening the link counts as having started: look at the PC soon, the code comes next
    s.el.querySelector('.cl-open').addEventListener('click', () => { wake(); });
    renderSheet();
    refresh();
  }

  function wipe() {
    const i = S.sheet && S.sheet.el.querySelector('.cl-input');
    if (i) i.value = '';
  }

  /** The app locked (or the PC was unpaired): the sheet goes away and the box is emptied first. */
  function closeSheet() {
    wipe();
    if (S.sheet) S.sheet.close();
  }

  // ---------------------------------------------------------------- talking to the PC
  const reason = (e, fallback) => e.offline ? 'PC not reachable: nothing was sent.'
    : e.status === 404 ? 'This PC can\'t do Claude sign-in from the phone yet. Update GupWorks on the PC.'
    : e.status === 409 ? 'The PC isn\'t waiting for a code right now. Here is where things stand.'
    : e.status === 503 ? 'The PC can\'t start a sign-in right now. Try again in a minute.'
    : fallback;                                          // the PC's own error wording is kept off the screen

  async function startLogin() {
    if (S.starting) return;
    S.starting = true; S.note = '';
    renderSheet();
    try { apply(await API.claudeLoginStart()); }
    catch (e) {
      S.note = e.status === 409 ? 'A sign-in is already finishing on the PC.' : reason(e, 'Couldn\'t start the sign-in.');
      refresh();
    }
    S.starting = false;
    renderSheet();
    wake();
  }

  async function submit() {
    const s = S.sheet;
    if (!s || S.sending) return;
    const input = s.el.querySelector('.cl-input');
    if (!S.cur || S.cur.state !== 'awaiting-code' || !input.value.trim()) return;
    if (/\s/.test(input.value.trim())) {                // the PC refuses a code with spaces inside: say so, send nothing
      S.note = 'The code has a space in it. Copy just the code from the sign-in page.';
      renderSheet();
      return;
    }
    S.sending = true; S.note = '';
    // the code leaves the box and goes into the request in the same breath; nothing else holds it
    const body = API.claudeLoginCode(input.value.trim());
    input.value = '';
    renderSheet();
    try {
      apply(await body);
    } catch (e) {
      S.note = e.status === 400 ? 'The PC says that isn\'t a code. Copy it again from the sign-in page and paste it.'
        : reason(e, 'The PC didn\'t take the code. Copy it again from the sign-in page and paste it.');
      refresh();
    }
    S.sending = false;
    renderSheet();
    wake();                                              // the loop looks at the PC again at once, then every second while it finishes
  }

  /** a new state from the PC (poll, start, or the answer to a code) */
  function apply(j) {
    const c = norm(j);
    if (!c) return;
    S.supported = true;
    if (c.state !== 'ok') S.wasOut = true;
    else if (S.wasOut) {
      S.wasOut = false;
      S.done = !!S.sheet;
      if (S.sheet) setTimeout(() => { if (S.done) closeSheet(); S.done = false; }, 1800);
      toast('<b>✓</b> Claude is signed in again', 'good');
    }
    if (c.state === 'ok') S.note = '';
    S.cur = c;
    renderBanner();
    renderSheet();
  }

  async function refresh(signal) {
    try { apply(await API.claudeLogin({ signal })); }
    catch (e) {
      if (e.status === 404) { S.supported = false; S.cur = null; renderBanner(); }
      else if (e.code !== 'aborted' && e.status !== 401 && e.code !== 'not_paired') { /* the loop tries again */ }
    }
  }

  let nudge = null;
  function wake() { if (nudge) nudge(); }

  /** The poll loop, tied to the app's run signal: every 30 s while signed in, quicker while something is going on. */
  async function run(signal) {
    while (!signal.aborted) {
      await refresh(signal);
      const c = S.cur;
      const ms = !S.supported ? 300000 : c && c.state === 'finishing' ? 1000 : S.sheet || (c && c.state === 'awaiting-code') ? 3000 : c && c.state === 'expired' ? 15000 : 30000;
      await new Promise(resolve => {
        nudge = resolve;
        sleep(ms, signal).then(resolve);
      });
      nudge = null;
    }
  }

  /** forget the PC's answer (unpair, another PC) */
  function reset() { closeSheet(); S.cur = null; S.supported = true; S.wasOut = false; renderBanner(); }

  function wire() {
    const b = $('cbn');
    b.addEventListener('click', openSheet);
  }

  root.GupClaude = { wire, run, refresh, openSheet, closeSheet, reset, apply, safeUrl, get state() { return S; } };
})(window);
