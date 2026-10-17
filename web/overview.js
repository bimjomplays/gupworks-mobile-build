/* Overview screen (docs/phone-api.md "GET /v1/overview"). Read-only: what is waiting on the owner, what is
   running (tickets claimed / building / in review, with who works on them) and what finished in the last 24 hours, like the
   PC app's Overview. It sits beside Waiting: a "Waiting | Overview" switch at the top of both screens. Nothing here decides
   anything; a waiting row opens the Waiting tab where the owner decides (with Face ID). The app polls while the screen is open. */
(function (root) {
  'use strict';
  const API = root.GupAPI, { esc, ic, ago, cap } = root.GupUI;
  const $ = id => document.getElementById(id);
  const sleep = (ms, signal) => new Promise(r => {
    const t = setTimeout(r, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
  });

  const POLL_MS = 15000;
  const SHOW_MAX = 30;                   // the PC sends at most 30 done tickets; the other lists are capped here too, defensively
  const STATE_CLS = { claimed: 'c-i', building: 'c-g', review: 'c-v' };
  const KIND_CLS = { approval: 'c-a', escalated: 'c-r', proposed: 'c-v', stuck: 'c-a', memory: 'c-i' };

  const S = {
    data: null,                          // {waiting, running, done_today} from the PC, or null (not asked yet)
    at: 0,                               // when it was read
    error: '',                           // why it couldn't be read, in words
    supported: true,                     // false: an older PC (404)
    loading: false,
  };

  const list = (a, max) => Array.isArray(a) ? a.slice(0, max || SHOW_MAX) : [];
  const txt = (v, max) => String(v == null ? '' : v).slice(0, max || 200);
  const view = () => $('v-overview');

  function waitingRow(i) {
    const src = [i.project && cap(txt(i.project, 60)), i.by && cap(txt(i.by, 60)), i.at && ago(Date.parse(i.at))].filter(Boolean).join(' · ');
    return `<button class="cr ov" type="button" data-go="waiting"><span class="chip mini ${KIND_CLS[i.kind] || 'c-x'}">${esc(cap(txt(i.kind, 20)))}</span>` +
      `<div class="grow"><div class="a">${esc(txt(i.title) || 'Waiting')}</div><div class="b">${esc(src)}</div></div>${ic('chev', 16, 2.4, 'dim')}</button>`;
  }

  function runningRow(t) {
    const who = t.worker ? esc(txt(t.worker, 80)) : '<span class="dim">no one yet</span>';
    return `<div class="cr ov"><span class="chip mini ${STATE_CLS[t.state] || 'c-x'}">${esc(txt(t.state, 20))}</span>` +
      `<div class="grow"><div class="a">${esc(txt(t.title))}</div>` +
      `<div class="b">#${esc(txt(t.id, 12))}${t.project ? ' · ' + esc(cap(txt(t.project, 60))) : ''} · ${who}</div></div></div>`;
  }

  function doneRow(t) {
    const at = t.closed_at ? Date.parse(t.closed_at) : NaN;
    return `<div class="cr ov"><span class="ovck green">${ic('check', 16, 2.6)}</span>` +
      `<div class="grow"><div class="a">${esc(txt(t.title))}</div>` +
      `<div class="b">#${esc(txt(t.id, 12))}${t.project ? ' · ' + esc(cap(txt(t.project, 60))) : ''}${at ? ' · ' + esc(ago(at)) + ' ago' : ''}</div></div></div>`;
  }

  function section(name, n, rows, empty) {
    return `<div class="lbl" style="padding:2px 4px 0" data-sec="${esc(name)}">${esc(name)} · ${n}</div>` +
      (n ? `<div class="crew g">${rows.join('')}</div>` : `<div class="notice g ovempty" style="margin:0"><b>›</b> ${esc(empty)}</div>`);
  }

  function render() {
    const body = $('ov-body');
    if (!body) return;
    const unpaired = !API.configured || API.unauthorized;
    const chip = unpaired ? '<span class="chip c-a dot">not paired</span>'
      : S.error && !S.data ? '<span class="chip c-r dot">no answer</span>' : '<span class="chip c-g dot">live</span>';
    let html = `<div class="hdr"><h1>Overview</h1>${chip}</div>` + segment('overview');
    if (unpaired) {
      html += `<div class="notice g" style="margin:0"><b>›</b> Pair this phone with your PC to see what is going on.<br>` +
        (root.GupNative.available ? `<button class="btn q pairbtn" data-pair type="button"><b>›</b>&nbsp;pair with your PC</button>` : `<b>›</b> pair it in the GupWorks iPhone app`) + `</div>`;
    } else if (!S.supported) {
      html += `<div class="notice g" style="margin:0"><b>›</b> This PC can't show the Overview on the phone yet. Update GupWorks on the PC.</div>`;
    } else if (!S.data) {
      html += `<div class="notice g" style="margin:0"><b>›</b> ${S.error ? esc(S.error) : 'Asking the PC…'}</div>`;
    } else {
      const w = list(S.data.waiting), r = list(S.data.running), d = list(S.data.done_today);
      html += section('waiting on you', w.length, w.map(waitingRow), 'Nothing is waiting on you.') +
        section('running', r.length, r.map(runningRow), 'Nothing is running right now.') +
        section('done today', d.length, d.map(doneRow), 'Nothing finished in the last 24 hours.');
      if (S.error) html += `<div class="notice g" style="margin:0"><b>›</b> ${esc(S.error)}</div>`;
      html += `<div class="foot">updated ${esc(root.GupUI.clock(S.at || Date.now()))}</div>`;
    }
    body.innerHTML = html;
  }

  /** the "Waiting | Overview" switch; the Waiting screen draws the same markup */
  function segment(on) {
    return `<div class="seg g" role="tablist" aria-label="Waiting or Overview">` +
      `<button type="button" role="tab" data-seg="waiting" aria-selected="${on === 'waiting'}" class="${on === 'waiting' ? 'on' : ''}">Waiting</button>` +
      `<button type="button" role="tab" data-seg="overview" aria-selected="${on === 'overview'}" class="${on === 'overview' ? 'on' : ''}">Overview</button></div>`;
  }

  async function load(opts) {
    if (!API.configured || API.unauthorized || S.loading) return;
    S.loading = true;
    try {
      const r = await API.overview(opts);
      S.data = { waiting: list(r && r.waiting), running: list(r && r.running), done_today: list(r && r.done_today) };
      S.error = ''; S.supported = true; S.at = Date.now();
    } catch (e) {
      if (e.status === 404) { S.supported = false; S.data = null; }
      else if (e.code !== 'aborted') S.error = e.offline ? 'Can\'t reach the PC. Is the phone on Tailscale?' : 'The PC didn\'t give the overview: ' + String(e.message || '').slice(0, 200);
    } finally { S.loading = false; }
    render();
  }

  let nudge = null;
  /** while the Overview is the open screen, read it every few seconds (the PC gives no long-poll for it) */
  async function run(signal) {
    while (!signal.aborted) {
      if (root.GupApp && root.GupApp.state.tab === 'overview') await load({ signal });
      await new Promise(resolve => { nudge = resolve; sleep(POLL_MS, signal).then(resolve); });
      nudge = null;
    }
  }

  function show() { render(); load(); if (nudge) nudge(); }

  function reset() {
    Object.assign(S, { data: null, at: 0, error: '', supported: true });
    render();
  }

  function wire() {
    view().addEventListener('click', e => {
      const g = e.target.closest('[data-go]');
      if (g) return root.GupApp.showTab(g.dataset.go);
      const s = e.target.closest('[data-seg]');
      if (s) root.GupApp.showTab(s.dataset.seg);
    });
    render();
  }

  root.GupOverview = { wire, run, show, render, reset, load, segment, get state() { return S; } };
})(window);
