/* GupWorks iPhone app: the screens (Gup chat, Waiting on you, Status) and their live updates.
   All PC calls go through GupAPI (api.js); owner decisions get their confirmation from GupHooks.confirmOwnerAction()
   (hooks.js) and nowhere else.
   Starting: inside the iOS app, boot() asks the shell (native.js) whether a PC is paired; if so every call goes
   through the shell's transport (the token stays native), else the pairing screen (pair.js) opens. A desktop
   browser has no shell: nothing is paired there. Dev: ?mock runs on the in-page fake PC (mock.js), ?mock=server on
   scripts/mock-phone-api.js. */
(function (root) {
  'use strict';
  const API = root.GupAPI, H = root.GupHooks, N = root.GupNative, Pair = root.GupPair;
  const { ic, bot, ring, esc, fmtText, when, clock, ago, cap, toast, sheet } = root.GupUI;
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const params = new URLSearchParams(location.search);

  // ---------------------------------------------------------------- state
  const S = {
    tab: 'gup',
    conn: 'connecting',          // connecting | online | offline | unpaired | unauthorized
    status: null, statusAt: 0,
    // chat
    msgs: new Map(), cursor: null, busy: false, moreBefore: false, loadingOlder: false, pending: [], openTools: new Set(),
    // waiting
    items: null, version: null, filter: 'all', acting: new Set(),
    runCtl: null,
    phone: null,                 // {host, fqdn, pairedAt} of the paired PC (from the shell; never the token)
  };

  // ---------------------------------------------------------------- tabs
  function showTab(tab) {
    S.tab = tab;
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + tab));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === tab));
    if (tab === 'status') refreshStatus();
    if (tab === 'gup') stickBottom(false);
  }

  // ---------------------------------------------------------------- connection line
  function setConn(conn) {
    if (S.conn === 'unauthorized' && conn !== 'connecting') return;   // stays until configured again
    S.conn = conn;
    renderConn();
    renderStatus();
  }
  function renderConn() {
    const el = $('conn');
    let text, cls = '';
    const via = API.mode === 'mock' ? 'mock' : 'tailscale';
    const rtt = API.lastRtt != null ? ` · ${API.lastRtt} ms` : '';
    switch (S.conn) {
      case 'online':
        if (S.status && S.status.paused) { text = '● paused on the PC · messages wait'; cls = 'amber'; }
        else text = `● connected · ${via}${rtt}`;
        break;
      case 'offline': text = '● PC not reachable · retrying'; cls = 'red'; break;
      case 'unpaired': text = '● not paired with a PC yet'; cls = 'amber'; break;
      case 'unauthorized': text = '● not paired anymore · pair again'; cls = 'amber'; break;
      default: text = '● connecting…'; cls = 'dim';
    }
    el.textContent = text;
    el.className = 'st ' + cls;
  }

  // ================================================================= Gup chat
  const msgsEl = () => $('msgs');
  function nearBottom() { const m = msgsEl(); return m.scrollHeight - m.scrollTop - m.clientHeight < 80; }
  function stickBottom(force) {
    const m = msgsEl();
    if (force || S.stuck) requestAnimationFrame(() => { m.scrollTop = m.scrollHeight; });
  }

  function upsert(list) {
    for (const m of list || []) S.msgs.set(m.id, m);
    // a sent message that came back from the PC replaces its local "sending" bubble
    const sent = new Set([...S.msgs.values()].map(m => m.client_id).filter(Boolean));
    S.pending = S.pending.filter(p => !sent.has(p.client_id));
  }

  function toolLine(tools, key, solo) {
    const names = [...new Set(tools.map(t => (t.tool && t.tool.name) || String(t.body).split(':')[0]))];
    const failed = tools.some(t => t.tool && t.tool.error);
    const open = S.openTools.has(key);
    const list = tools.map(t => `<div class="${t.tool && t.tool.error ? 'bad' : ''}">${t.tool && t.tool.error ? '✗' : '›'} ${esc(t.body)}</div>`).join('');
    return `<button class="steps${solo ? ' solo' : ''}" data-tools="${key}" type="button">· ${tools.length} step${tools.length > 1 ? 's' : ''}: ` +
           `${esc(names.join(', '))}${failed ? ' <span class="red">· failed</span>' : ''}</button>` +
           `<div class="tools${open ? ' open' : ''}" data-tools-list="${key}">${list}</div>`;
  }
  function atts(m) {
    if (!m.attachments || !m.attachments.length) return '';
    return `<div class="atts">${m.attachments.map(a => `<span class="chip c-x">${ic('file', 13)}${esc(a.name)}</span>`).join('')}</div>`;
  }

  function renderChat() {
    const box = $('msgs-in');
    const m = msgsEl();
    const stick = nearBottom();
    const fromBottom = m.scrollHeight - m.scrollTop;
    const list = [...S.msgs.values()].sort((a, b) => a.id - b.id);
    const out = [];
    if (S.moreBefore) out.push(`<div class="older">${S.loadingOlder ? 'loading older…' : '↑ older messages'}</div>`);
    let tools = [];
    const flushTools = () => { if (tools.length) { out.push(toolLine(tools, Number(tools[0].id), true)); tools = []; } };
    for (const msg of list) {
      if (msg.kind === 'tool') { tools.push(msg); continue; }
      if (msg.role === 'owner') {
        flushTools();
        const meta = ['you', when(msg.ts)];
        if (msg.queued) meta.push('queued');
        out.push(`<div class="me selectable" data-id="${Number(msg.id)}"><div class="t">${esc(meta.join(' · '))}</div>${fmtText(msg.body)}${atts(msg)}</div>`);
        continue;
      }
      if (msg.kind === 'status' || msg.kind === 'error' || msg.role === 'system') {
        flushTools();
        out.push(`<div class="sys${msg.kind === 'error' ? ' err' : ''}" data-id="${Number(msg.id)}">${fmtText(msg.body)}</div>`);
        continue;
      }
      // gup or another agent: a card with a `name ›` header; tool rows just before it fold into its steps line
      const name = msg.role === 'gup' ? 'gup' : (msg.sender || msg.role);
      const steps = tools.length ? toolLine(tools, Number(tools[0].id), false) : '';
      tools = [];
      out.push(`<div class="gp g selectable" data-id="${Number(msg.id)}"><div class="hd">${bot(name, 26, { radius: 8 })}${esc(name.toLowerCase())} › ` +
               `<span class="t">${esc(clock(msg.ts, true))}</span></div>${steps}<div class="tx">${fmtText(msg.body)}` +
               `${msg.partial ? '<i class="cur blink"></i>' : ''}</div>${atts(msg)}</div>`);
    }
    if (tools.length && !S.busy) flushTools();
    for (const p of S.pending) {
      const label = p.state === 'failed' ? `not sent · ${p.why || 'tap to try again'}` : 'sending…';
      out.push(`<div class="me ${p.state}" data-pending="${esc(p.client_id)}"><div class="t">you · ${esc(label)}</div>${fmtText(p.text)}</div>`);
    }
    if (S.busy) {
      const last = tools.length ? tools[tools.length - 1].body : '';
      out.push(`<div class="typing" id="typing"><span id="spin">⠋</span> gup is working${last ? ': ' + esc(last) : ''}</div>`);
    }
    if (!list.length && !S.pending.length) out.push(emptyChat());
    box.innerHTML = out.join('');
    if (stick || S.forceBottom) { m.scrollTop = m.scrollHeight; S.forceBottom = false; }
    else m.scrollTop = m.scrollHeight - fromBottom;
    S.stuck = nearBottom();
  }
  function emptyChat() {
    if (S.conn === 'unpaired') return `<div class="empty">This phone isn't paired with your PC yet.<br>${pairButton('pair with your PC')}</div>`;
    if (S.conn === 'unauthorized') return `<div class="empty">The PC doesn't know this phone anymore.<br>${pairButton('pair again')}</div>`;
    if (S.conn === 'offline') return `<div class="empty">Can't reach the PC.<br>Is the phone on Tailscale?</div>`;
    return `<div class="empty">say hi to gup</div>`;
  }

  function pairButton(label) {
    return N.available ? `<button class="btn q pairbtn" data-pair type="button"><b>›</b>&nbsp;${esc(label)}</button>`
                       : `<b>›</b> pair it in the GupWorks iPhone app`;
  }

  // braille spinner while Gup works
  const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
  let spinI = 0;
  setInterval(() => { const s = $('spin'); if (s) s.textContent = SPIN[spinI = (spinI + 1) % SPIN.length]; }, 120);

  async function loadOlder() {
    if (S.loadingOlder || !S.moreBefore || !S.msgs.size) return;
    S.loadingOlder = true;
    renderChat();
    try {
      const r = await API.olderMessages(Math.min(...S.msgs.keys()), 50);
      upsert(r.messages);
      S.moreBefore = !!r.more_before;
    } catch (e) {
      if (e.code !== 'aborted') toast('Couldn\'t load older messages: ' + esc(e.message), 'bad');
    } finally {
      S.loadingOlder = false;
      renderChat();
    }
  }

  async function chatLoop(signal) {
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const t0 = Date.now();
        let r;
        if (!S.cursor) {
          r = await API.messages(50, { signal });
          S.msgs.clear();
          S.moreBefore = !!r.more_before;
          S.forceBottom = true;
        } else {
          r = await API.pollMessages(S.cursor, 25, { signal });
          if (r.reset) { S.msgs.clear(); S.moreBefore = !!r.more_before; S.forceBottom = true; }
        }
        upsert(r.messages);
        const quiet = !r.messages.length && r.cursor === S.cursor && S.busy === !!r.busy;
        S.cursor = r.cursor || S.cursor;
        S.busy = !!r.busy;
        setConn('online');
        renderChat();
        backoff = 1000;
        // the PC answers at once instead of waiting when too many long-polls are open: don't spin
        if (quiet && Date.now() - t0 < 1000) await sleep(2000);
      } catch (e) {
        if (await handleLoopError(e, signal, backoff)) return;
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }

  /** Shared error handling for the loops. Returns true when the loop should end. */
  async function handleLoopError(e, signal, backoff) {
    if (signal.aborted || e.code === 'aborted') return true;
    if (e.status === 401 || e.code === 'not_paired') return true;     // the unauthorized handler takes over
    if (e.offline) setConn('offline');
    else console.warn('GupWorks:', e.status, e.code, e.message);
    await sleep(backoff);
    return signal.aborted;
  }

  // ---- sending
  function sendFromInput() {
    const input = $('input');
    const text = input.value.trim();
    if (!text) return;
    if (text.length > API.TEXT_MAX) { toast(`That's over ${API.TEXT_MAX} characters.`, 'bad'); return; }
    if (new TextEncoder().encode(JSON.stringify({ text, client_id: 'x'.repeat(36) })).length > API.BODY_MAX) {
      toast('That message is too long to send from the phone (16 KB). Shorten it a little.', 'bad');
      return;
    }
    input.value = '';
    syncComposer();
    const p = { client_id: API.newClientId(), text, state: 'sending' };
    S.pending.push(p);
    S.forceBottom = true;
    renderChat();
    trySend(p);
  }
  async function trySend(p) {
    p.state = 'sending'; p.why = null;
    renderChat();
    try {
      const r = await API.send(p.text, p.client_id);     // same client_id on retries: never sent twice
      upsert([r.message]);
    } catch (e) {
      p.state = 'failed';
      // network trouble and busy PCs are worth retrying (same client_id); a refused message goes back to the box
      p.retry = e.status === 0 || e.status >= 500;
      p.why = e.offline ? 'PC not reachable · tap to retry' : e.status === 401 ? 'not paired'
        : p.retry ? 'tap to retry' : `${e.message || 'refused'} · tap to edit`;
    }
    renderChat();
  }

  // ---- composer: grows with the text; the mic turns into send when there is text
  function syncComposer() {
    const input = $('input');
    const has = input.value.trim().length > 0;
    $('field').classList.toggle('typing-on', input.value.length > 0);
    $('mic').innerHTML = has ? ic('arrowup', 30, 2.4) : ic('mic', 30, 2.2);
    $('mic').setAttribute('aria-label', has ? 'Send' : 'Talk to Gup');
    input.style.height = '50px';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
    document.documentElement.style.setProperty('--comp-h', Math.max(64, $('comp').offsetHeight) + 'px');
  }

  // ================================================================= Waiting on you
  const KINDS = {
    approval: ['Approval', 'c-a', 'Approvals'], escalated: ['Escalation', 'c-r', 'Escalations'], proposed: ['Proposed', 'c-v', 'Proposed'],
    stuck: ['Stuck', 'c-a', 'Stuck'], memory: ['Memory', 'c-i', 'Memory'],
  };
  const kindOf = k => KINDS[k] || [cap(k), 'c-x', cap(k)];

  function btnFor(item, a, round) {
    const cls = a.text === 'required' ? 'p' : a.style === 'yes' ? 'ok' : a.style === 'no' ? 'no' : 'q';
    const icon = a.text === 'required' ? 'chat' : a.style === 'yes' ? 'check' : a.style === 'no' ? 'x' : 'clock';
    const data = `data-key="${esc(item.key)}" data-action="${esc(a.id)}"`;
    if (round) return `<button class="btn ${cls} rb" ${data} type="button" aria-label="${esc(a.label)}">${ic(icon, 22, 2.6)}</button>`;
    return `<button class="btn ${cls}" ${data} type="button">${ic(icon, 20, 2.4)}${esc(a.label)}</button>`;
  }

  function cardFor(item) {
    const [label, chipCls] = kindOf(item.kind);
    const src = [item.project && cap(item.project), item.by && cap(item.by)].filter(Boolean).join(' · ');
    const title = (item.ticket ? `#${item.ticket} ` : '') + item.title;
    const kindRow = `<div class="kind"><span class="chip ${chipCls}">${esc(label)}</span>${item.by ? bot(item.by, 26, { radius: 8 }) : ''}` +
                    `<span class="src">${esc(src)}</span><span class="when">${esc(ago(item.at))}</span></div>`;
    const acts = item.pc_only ? [] : (item.actions || []);
    const busy = S.acting.has(item.key) ? ' busy' : '';
    if (item.kind === 'proposed' && acts.length && acts.length <= 3 && acts.every(a => a.text !== 'required')) {
      return `<div class="card g mini${busy}" data-item="${esc(item.key)}">${kindRow}<div class="row" style="gap:10px">` +
             `<div class="grow"><div class="ttl">${esc(title)}</div>${item.detail ? `<div class="det">${esc(item.detail)}</div>` : ''}</div>` +
             `<div class="rbs">${acts.map(a => btnFor(item, a, true)).join('')}</div></div></div>`;
    }
    let foot = '';
    if (item.pc_only) foot = `<div class="pconly"><b>›</b> decide this one on the PC</div>`;
    else if (acts.length) {
      // a text-taking action gets the chat button: answer or give a reason before deciding
      const canWrite = acts.some(a => a.text === 'optional') && !acts.some(a => a.text === 'required');
      foot = `<div class="acts">${acts.map(a => btnFor(item, a, false)).join('')}` +
             (canWrite ? `<button class="btn q more" data-key="${esc(item.key)}" data-write="1" type="button" aria-label="Add a note">${ic('chat', 20, 2.2)}</button>` : '') +
             `</div>`;
    }
    return `<div class="card g${item.kind === 'approval' ? ' wa' : ''}${busy}" data-item="${esc(item.key)}">${kindRow}` +
           `<div class="ttl">${esc(title)}</div>${item.detail ? `<div class="det">${fmtText(item.detail)}</div>` : ''}${foot}</div>`;
  }

  function renderWaiting() {
    const items = S.items;
    const n = items ? items.length : 0;
    const badge = $('badge');
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('hidden', !n);
    if (!items) {
      $('w-sub').textContent = S.conn === 'offline' ? 'PC not reachable · retrying' : S.conn === 'unpaired' || S.conn === 'unauthorized' ? 'not paired' : 'loading…';
      $('w-filters').innerHTML = '';
      $('w-list').innerHTML = S.conn === 'unpaired' || S.conn === 'unauthorized'
        ? `<div class="notice g"><b>›</b> Pair this phone with your PC to see what's waiting on you.<br>${pairButton('pair with your PC')}</div>` : '';
      return;
    }
    const times = items.map(i => Date.parse(i.at)).filter(Boolean);
    $('w-sub').textContent = n
      ? `${n} open${times.length ? ` · oldest ${ago(Math.min(...times))} · newest ${ago(Math.max(...times))}` : ''}`
      : 'nothing open';
    const counts = {};
    items.forEach(i => { counts[i.kind] = (counts[i.kind] || 0) + 1; });
    if (S.filter !== 'all' && !counts[S.filter]) S.filter = 'all';
    const chips = [['all', `All ${n}`]].concat(Object.keys(counts).map(k => [k, `${kindOf(k)[2]} ${counts[k]}`]));
    $('w-filters').innerHTML = n ? chips.map(([k, t]) => `<button class="chip ${S.filter === k ? 'on' : 'c-x'}" data-filter="${esc(k)}" type="button">${esc(t)}</button>`).join('') : '';
    const shown = items.filter(i => S.filter === 'all' || i.kind === S.filter);
    $('w-list').innerHTML = n ? shown.map(cardFor).join('')
      : `<div class="card g allclear"><div class="big">${ic('check', 44, 2.4)}</div><div class="ttl">all clear</div><div class="det">nothing is waiting on you</div></div>`;
    $('w-list').querySelectorAll('.allclear .ic').forEach(s => { s.style.margin = '0 auto'; });
  }

  async function refreshWaiting() {
    try {
      const r = await API.waiting();
      S.items = r.items; S.version = r.version;
      renderWaiting();
    } catch (e) { /* the loop retries */ }
  }

  async function waitingLoop(signal) {
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const t0 = Date.now();
        const r = S.version ? await API.pollWaiting(S.version, 25, { signal }) : await API.waiting({ signal });
        const quiet = r.version === S.version;
        S.items = r.items; S.version = r.version;
        setConn('online');
        renderWaiting();
        backoff = 1000;
        if (quiet && Date.now() - t0 < 1000) await sleep(2000);
      } catch (e) {
        if (await handleLoopError(e, signal, backoff)) return;
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  }

  // ---- deciding: tap -> (answer sheet) -> confirmOwnerAction -> POST /v1/waiting/act
  function findItem(key) { return (S.items || []).find(i => i.key === key); }

  function answerSheet(item, actionId) {
    const acts = (item.actions || []).filter(a => a.text !== 'none');
    let chosen = acts.find(a => a.id === actionId) || acts.find(a => a.text === 'required') || acts[0];
    return new Promise(resolve => {
      let result = null;
      const s = sheet(
        `<div class="vtitle acc">${esc(kindOf(item.kind)[0].toLowerCase())} <span>· ${esc(item.ticket ? '#' + item.ticket : item.key)}</span></div>` +
        `<div class="ttl">${esc(item.title)}</div>` +
        (acts.length > 1 ? `<div class="choose">${acts.map(a => `<button class="chip" data-pick="${esc(a.id)}" type="button">${esc(a.label)}</button>`).join('')}</div>` : '') +
        `<textarea id="answer-text" rows="4" maxlength="${API.ANSWER_MAX + 200}" enterkeyhint="done"></textarea>` +
        `<div class="count" id="answer-count"></div>` +
        `<div class="vrow"><button class="vside g" data-act="cancel" type="button" aria-label="Cancel">${ic('x', 26)}</button>` +
        `<button class="btn p" data-act="go" type="button"></button></div>`,
        () => resolve(result));
      s.el.classList.add('answer');
      const ta = s.el.querySelector('textarea'), go = s.el.querySelector('[data-act=go]'), count = s.el.querySelector('#answer-count');
      function sync() {
        const len = ta.value.trim().length;
        s.el.querySelectorAll('[data-pick]').forEach(b => { b.className = 'chip ' + (b.dataset.pick === chosen.id ? 'on' : 'c-x'); });
        ta.placeholder = chosen.text === 'required' ? '› your answer' : '› a note (optional)';
        go.innerHTML = ic('arrowup', 20, 2.4) + esc(chosen.label);
        go.disabled = (chosen.text === 'required' && !len) || len > API.ANSWER_MAX;
        count.textContent = len > API.ANSWER_MAX - 400 ? `${len} / ${API.ANSWER_MAX}` : '';
        count.classList.toggle('over', len > API.ANSWER_MAX);
      }
      s.el.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => { chosen = acts.find(a => a.id === b.dataset.pick); sync(); }));
      ta.addEventListener('input', sync);
      s.el.querySelector('[data-act=cancel]').addEventListener('click', s.close);
      go.addEventListener('click', () => { result = { action: chosen, text: ta.value.trim() }; s.close(); });
      sync();
      setTimeout(() => ta.focus(), 60);
    });
  }

  async function decide(key, actionId, write) {
    const item = findItem(key);
    if (!item || S.acting.has(key) || S.deciding) return;
    S.deciding = true;                                   // one decision at a time (Face ID prompts are async)
    try { await decideItem(item, key, actionId, write); } finally { S.deciding = false; }
  }
  async function decideItem(item, key, actionId, write) {
    let action = (item.actions || []).find(a => a.id === actionId);
    let text = '';
    if (write || (action && action.text === 'required')) {
      const r = await answerSheet(item, actionId);
      if (!r) return;
      action = r.action; text = r.text;
    }
    if (!action) return;
    const confirm = await H.confirmOwnerAction({ key, action: action.id, label: action.label, text, title: item.title });
    if (!confirm) return;
    S.acting.add(key);
    renderWaiting();
    try {
      const r = await API.act(key, action.id, text, confirm);
      S.items = (S.items || []).filter(i => i.key !== key);
      toast(`<b>✓</b> ${esc(r.receipt && r.receipt.summary || 'done')}`, 'good');
    } catch (e) {
      const why = {
        stale: 'That changed or was already decided elsewhere. Here is the fresh list.',
        confirmation_required: 'Not confirmed, so nothing happened. Try again.',
        pc_only: 'This one can only be decided on the PC.',
      }[e.code] || (e.offline ? 'PC not reachable: nothing was decided.' : e.message);
      toast(esc(why), 'bad');
    } finally {
      S.acting.delete(key);
      renderWaiting();
      refreshWaiting();
      refreshStatus();
    }
  }

  // ================================================================= Status
  async function refreshStatus() {
    if (!API.configured || API.unauthorized) return renderStatus();
    try {
      S.status = await API.status();
      S.statusAt = Date.now();
      setConn('online');
    } catch (e) {
      if (e.offline) setConn('offline');
    }
    renderStatus();
  }

  function renderStatus() {
    const s = S.status, body = $('s-body');
    if (!body) return;
    const chip = S.conn === 'online' ? (s && s.paused ? '<span class="chip c-a dot">paused</span>' : `<span class="chip c-g dot">PC online${API.mode === 'mock' ? ' · mock' : ''}</span>`)
      : S.conn === 'offline' ? '<span class="chip c-r dot">PC offline</span>'
      : S.conn === 'connecting' ? '<span class="chip c-x dot">connecting</span>' : '<span class="chip c-a dot">not paired</span>';
    const hdr = `<div class="hdr"><h1>Status</h1>${chip}</div>`;
    if (!s) {
      body.innerHTML = hdr + `<div class="notice g" style="margin:0"><b>›</b> ${S.conn === 'offline' ? 'Can\'t reach the PC. Is the phone on Tailscale?' :
        S.conn === 'connecting' ? 'Asking the PC…' : 'Pair this phone with your PC to see its status.<br>' + pairButton(S.conn === 'unauthorized' ? 'pair again' : 'pair with your PC')}</div>`;
      return;
    }
    const u = s.usage || {};
    const pct = v => (typeof v === 'number' ? v : null);
    const five = pct(u.five_hour), week = pct(u.seven_day);
    const col = (v, base, lim) => v != null && v >= lim ? 'var(--amber)' : base;
    const rings = `<div class="rings">` +
      `<div class="ring g"><div class="k">5-hour <i>stop 90</i></div>${ring(five, col(five, '#7c8cff', 90), { mark: .9 })}` +
      `<div class="r">${u.five_hour_resets ? 'resets ' + esc(clock(u.five_hour_resets, true)) : 'no reading yet'}</div></div>` +
      `<div class="ring g"><div class="k">weekly <i>cap 85</i></div>${ring(week, col(week, '#bf9bff', 85), { mark: .85 })}` +
      `<div class="r">${u.seven_day_resets ? 'resets ' + esc(clock(u.seven_day_resets, true)) : 'no reading yet'}</div></div></div>`;
    const nw = s.new_work || { ok: true };
    const guard = `<div class="guard g">${ic('shield', 20)}<span>` + (nw.ok
      ? '<b>› usage guard ok</b> · holds non-urgent work at 85% weekly'
      : `<b class="amber">› new work on hold</b> · ${esc(nw.why || 'held')}`) + `</span></div>`;
    const g = s.gup || {};
    const queued = Number(g.queued) || 0, waiting = Number(s.waiting) || 0;
    const gupLine = g.busy ? 'answering now' : String(g.status || 'idle');
    const rows =
      `<button class="cr" data-go="gup" type="button">${bot('gup', 38, { radius: 11 })}<div class="grow"><div class="a">Gup <span>· ${esc(gupLine)}</span></div>` +
      `<div class="b">${queued ? `${queued} message${queued > 1 ? 's' : ''} waiting for Gup` : 'nothing queued'}</div></div>` +
      `<span class="v ${g.busy ? 'green' : 'dim'}">${g.busy ? '●' : '○'}</span></button>` +
      `<button class="cr" data-go="waiting" type="button"><span class="ico">${ic('inbox', 20)}</span><div class="grow"><div class="a">Waiting on you</div>` +
      `<div class="b">${waiting ? `${waiting} to decide` : 'all clear'}</div></div><span class="v ${waiting ? 'amber' : 'green'}">${waiting || '✓'}</span></button>` +
      `<button class="cr" data-phone type="button"><span class="ico">${ic('lock', 20)}</span><div class="grow"><div class="a">This phone` +
      `${S.phone && S.phone.host ? ` <span>· ${esc(S.phone.host)}</span>` : ''}</div>` +
      `<div class="b">${s.device && s.device.paired_at ? 'paired ' + esc(when(s.device.paired_at)) : 'paired'} · ${API.mode === 'mock' ? 'dev mock' : 'over Tailscale'}</div></div>` +
      `${N.available ? ic('chev', 16, 2.4, 'dim') : ''}</button>`;
    const tiles = [
      ['net', 'Ping', API.lastRtt != null ? `${API.lastRtt} ms` : '--'],
      ['pulse', 'Reading', u.taken_at ? ago(u.taken_at) : '--'],
      ['chip', 'API', 'v' + (s.api || 1)],
    ].map(([i, k, v]) => `<div class="tile g"><div class="k">${ic(i, 15)}${k}</div><div class="v">${esc(v)}</div></div>`).join('');
    // old numbers stay readable, but the way back in comes first
    const gone = S.conn === 'unauthorized'
      ? `<div class="notice g" style="margin:0"><b>›</b> The PC doesn't know this phone anymore.<br>${pairButton('pair again')}</div>` : '';
    const held = s.paused ? `<div class="held">${ic('pause', 20, 2.6)}paused on the PC · messages wait for resume</div>` : '';
    body.innerHTML = hdr + gone + rings + guard + held + `<div class="lbl" style="padding:2px 4px 0">gupworks</div><div class="crew g">${rows}</div>` +
      `<div class="pc">${tiles}</div><div class="foot">updated ${esc(clock(S.statusAt || Date.now()))}</div>`;
  }

  async function statusLoop(signal) {
    while (!signal.aborted) {
      await refreshStatus();
      await sleep(S.tab === 'status' ? 15000 : 60000);
    }
  }

  // ================================================================= pairing
  function openPairing() {
    if (!N.available) return toast('Pairing works in the GupWorks iPhone app: scan the code the PC shows.');
    if (Pair.isOpen) return;
    Pair.open({ onPaired });
  }

  /** the shell has a PC (paired just now, or from the Keychain at launch): talk to it */
  function usePaired(info) {
    S.phone = { host: info.host || '', fqdn: info.fqdn || '', pairedAt: info.pairedAt || null };
    API.useTransport(N.transport, 'pc');
  }

  function onPaired(e) {
    S.msgs.clear(); S.cursor = null; S.pending = []; S.items = null; S.version = null; S.status = null;
    usePaired(e);
    start();
    toast(`<b>✓ paired</b> with ${esc(e.host || 'your PC')}`, 'good');
  }

  /** This phone (Status): pair again with a new code, or forget the PC */
  function phoneSheet() {
    if (!N.available) return;
    const s = sheet(
      `<div class="vtitle acc">this phone</div>` +
      `<div class="vtext">${S.phone && S.phone.host ? `paired with <b>${esc(S.phone.host)}</b>` : 'paired with your PC'}` +
      `${S.phone && S.phone.pairedAt ? `<span> · since ${esc(when(S.phone.pairedAt))}</span>` : ''}` +
      `${S.phone && S.phone.fqdn ? `<div class="ctext fqdn selectable">${esc(S.phone.fqdn)}</div>` : ''}` +
      `<div class="ctext">The key lives only in this iPhone's Keychain. Unpairing deletes it here; to cut it off on the PC too, ` +
      `run <b>gw bridge revoke</b> there.</div></div>` +
      `<button class="btn q" data-act="repair" type="button">${ic('qr', 19)}pair again (new code)</button>` +
      `<button class="btn no" data-act="unpair" type="button">unpair this phone</button>` +
      `<button class="btn q" data-act="cancel" type="button">cancel</button>`);
    s.el.classList.add('phone');
    s.el.querySelector('[data-act=cancel]').addEventListener('click', s.close);
    s.el.querySelector('[data-act=repair]').addEventListener('click', () => { s.close(); openPairing(); });
    const un = s.el.querySelector('[data-act=unpair]');
    un.addEventListener('click', async () => {
      if (!un.dataset.sure) { un.dataset.sure = '1'; un.textContent = 'tap again to unpair'; return; }
      s.close();
      await unpair();
    });
  }

  async function unpair() {
    stop();
    try { await N.call('pair.forget'); } catch (e) { return toast('Couldn\'t unpair: ' + esc(e.message || 'the app refused'), 'bad'); }
    API.reset();
    S.phone = null;
    S.msgs.clear(); S.cursor = null; S.pending = []; S.items = null; S.version = null; S.status = null; S.busy = false;
    S.conn = 'connecting';
    start();
    toast('Unpaired: the key is gone from this phone.');
  }

  /** Is a PC paired (in the Keychain)? At launch, and again when the app comes back while unpaired (the Keychain
      can't be read while the phone is locked). */
  async function askShell(openIfUnpaired) {
    let hello = null;
    try { hello = await N.call('hello'); } catch (e) { /* an older shell: nothing paired */ }
    if (hello && hello.paired) usePaired(hello);
    start();
    if (openIfUnpaired && !(hello && hello.paired) && hello && hello.keychain !== 'locked') openPairing();
  }

  // ================================================================= start / stop
  function stop() { if (S.runCtl) { S.runCtl.abort(); S.runCtl = null; } }
  function start() {
    stop();
    if (!API.configured) { setConn('unpaired'); renderChat(); renderWaiting(); renderStatus(); return; }
    S.conn = 'connecting';
    renderConn();
    const ctl = new AbortController();
    S.runCtl = ctl;
    chatLoop(ctl.signal);
    waitingLoop(ctl.signal);
    statusLoop(ctl.signal);
  }

  API.on('unauthorized', () => {
    stop();
    S.conn = 'unauthorized';
    renderConn(); renderChat(); renderWaiting(); renderStatus();
  });
  API.on('reachable', ok => { if (!ok && S.conn !== 'unauthorized') setConn('offline'); });

  // the app went to the background and back: long-polls may have died, start them fresh
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (API.configured && !API.unauthorized) start();
    else if (N.available && !API.configured && !Pair.isOpen && params.get('mock') === null) askShell(false);
  });
  // a pairing that finished after its screen was closed still counts
  N.on('pair', e => { if (e.state === 'paired' && !Pair.isOpen) onPaired(e); });

  // ---------------------------------------------------------------- keyboard: lift the composer above it
  if (root.visualViewport) {
    const vv = root.visualViewport;
    const onVV = () => {
      const kb = Math.max(0, root.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb', kb + 'px');
      document.body.classList.toggle('kb', kb > 80);
      if (kb > 80) stickBottom(true);
    };
    vv.addEventListener('resize', onVV);
    vv.addEventListener('scroll', onVV);
  }

  // ---------------------------------------------------------------- wire up
  function wire() {
    $('chead-bot').innerHTML = bot('gup', 52, { radius: 17 });
    $('chead-chev').outerHTML = ic('chev', 14, 2.6);
    $('plus').innerHTML = ic('plus', 24);
    $('tab-gup-icon').innerHTML = bot('gup', 30, { bg: false });
    $('tab-waiting-icon').outerHTML = ic('inbox', 25, 1.9);
    $('tab-projects-icon').outerHTML = ic('folder', 25, 1.9);
    $('tab-status-icon').outerHTML = ic('pulse', 25, 1.9);
    syncComposer();

    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
    $('chead-name').addEventListener('click', () => showTab('status'));
    const input = $('input');
    input.addEventListener('input', syncComposer);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendFromInput(); }
    });
    $('mic').addEventListener('click', async () => {
      if (input.value.trim()) return sendFromInput();
      const text = await H.startVoice();
      if (text) { input.value = text; syncComposer(); sendFromInput(); }
    });
    $('plus').addEventListener('click', () => toast('Sending files from the phone isn\'t supported yet.'));
    $('msgs').addEventListener('scroll', () => {
      S.stuck = nearBottom();
      if ($('msgs').scrollTop < 60) loadOlder();
    }, { passive: true });
    $('msgs-in').addEventListener('click', e => {
      const t = e.target.closest('[data-tools]');
      if (t) {
        const k = t.dataset.tools;
        S.openTools.has(k) ? S.openTools.delete(k) : S.openTools.add(k);
        const list = $('msgs-in').querySelector(`[data-tools-list="${k}"]`);
        if (list) list.classList.toggle('open');
        return;
      }
      const p = e.target.closest('[data-pending]');
      if (p) {
        const item = S.pending.find(x => x.client_id === p.dataset.pending);
        if (!item || item.state !== 'failed') return;
        if (item.retry) return trySend(item);
        S.pending = S.pending.filter(x => x !== item);
        const input = $('input');
        input.value = item.text + (input.value ? '\n' + input.value : '');
        syncComposer();
        renderChat();
        input.focus();
        return;
      }
      if (e.target.closest('.older')) loadOlder();
    });
    $('w-filters').addEventListener('click', e => {
      const c = e.target.closest('[data-filter]');
      if (c) { S.filter = c.dataset.filter; renderWaiting(); }
    });
    $('w-list').addEventListener('click', e => {
      const b = e.target.closest('[data-key]');
      if (b) decide(b.dataset.key, b.dataset.action, !!b.dataset.write);
    });
    $('s-body').addEventListener('click', e => {
      const b = e.target.closest('[data-go]');
      if (b) showTab(b.dataset.go);
      if (e.target.closest('[data-phone]')) phoneSheet();
    });
    document.getElementById('app').addEventListener('click', e => { if (e.target.closest('[data-pair]')) openPairing(); });
  }

  // ---------------------------------------------------------------- dev helpers (?frame, ?tab, ?mock)
  function devFrame() {
    const de = document.documentElement.style;
    de.setProperty('--sat', '54px');
    de.setProperty('--sab', '34px');
    const sb = document.createElement('div');
    sb.className = 'sb';
    sb.innerHTML = '<span class="sbt">9:41</span><span class="island"></span><span class="sbi">' +
      '<svg width="19" height="12" viewBox="0 0 19 12" fill="currentColor"><rect x="0" y="8" width="3.2" height="4" rx="1"/><rect x="5" y="5.5" width="3.2" height="6.5" rx="1"/>' +
      '<rect x="10" y="3" width="3.2" height="9" rx="1"/><rect x="15" y="0" width="3.2" height="12" rx="1"/></svg>' +
      '<svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor"><path d="M8.5 2.3c2.6 0 5 1 6.8 2.7l1.3-1.3A11.3 11.3 0 0 0 8.5.4 11.3 11.3 0 0 0 .4 3.7L1.7 5a9.6 9.6 0 0 1 6.8-2.7Zm0 3.8c1.6 0 3 .6 4.1 1.6l1.3-1.3a7.7 7.7 0 0 0-10.8 0l1.3 1.3A5.8 5.8 0 0 1 8.5 6.1Zm0 3.8c.6 0 1.1.2 1.5.6L8.5 12 7 10.5c.4-.4.9-.6 1.5-.6Z"/></svg>' +
      '<span class="batt"><i style="width:82%"></i></span></span>';
    const home = document.createElement('div');
    home.className = 'homeind';
    document.body.append(sb, home);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function boot() {
    if (params.has('frame')) devFrame();
    wire();
    showTab(['gup', 'waiting', 'projects', 'status'].includes(params.get('tab')) ? params.get('tab') : 'gup');
    const mock = params.get('mock');
    if (mock === 'server') {
      // dev only, and only against a mock on this machine: mock mode fakes the owner confirmation
      const base = params.get('api') || location.origin;
      if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(base)) throw new Error('?mock=server only talks to a local mock');
      API.configure({ baseUrl: base, token: 'mock', mode: 'mock' });
    } else if (mock !== null) {
      await loadScript('mock.js');                        // dev only: never loaded without ?mock
      const m = root.GupMock.createMock({ speed: Number(params.get('speed')) || 1 });
      API.useTransport(root.GupMock.inPageTransport(m), 'mock');
      root.GupDevMock = m;
    } else if (N.available) {
      return askShell(true);
    }
    start();
  }

  root.GupApp = { start, stop, showTab, decide, openPairing, unpair, get state() { return S; } };
  boot();
})(window);
