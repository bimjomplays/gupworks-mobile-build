/* Pairing with the PC (look D "Pair by QR"): the shell's camera runs full-screen under the page, this draws the
   overlay (close + torch, the "Pair with your PC" card, the viewfinder, the result card, "enter code instead").
   The shell reads the QR, checks the code with the PC (GET /v1/status with the new token) and keeps the PC address
   and token in the iOS Keychain; this page only hears "checking", "paired" or "failed" and never sees the token.
     GupPair.open({onPaired})   show it (onPaired({host, rtt, pairedAt}) runs once the PC has accepted the code)
     GupPair.close()
     GupPair.isOpen */
(function (root) {
  'use strict';
  const N = root.GupNative;
  const { ic, esc } = root.GupUI;
  const $ = id => document.getElementById(id);

  let opts = {}, open = false, offEvent = null, torch = false, doneTimer = null, paired = null, state = 'closed';

  function card(kind, title, line) {
    const icon = kind === 'ok' ? ic('check', 24, 2.6) : kind === 'bad' ? ic('x', 22, 2.6) : kind === 'busy' ? '<span class="pspin"></span>' : ic('lock', 22);
    const el = $('pair-found');
    el.className = `found g ${kind}`;
    el.innerHTML = `<span class="fi">${icon}</span><div class="grow"><div class="a">${title}</div><div class="b">${line}</div></div>`;
  }
  function hideCard() { $('pair-found').className = 'found g hidden'; }
  function step(n) { $('pair-step').textContent = `step ${n} / 2`; }

  function render(s, d) {
    d = d || {};
    state = s;
    $('pair').dataset.state = s;
    $('pair-settings').classList.toggle('hidden', s !== 'denied');
    switch (s) {
      case 'starting': step(1); hideCard(); break;
      case 'scanning': step(1); hideCard(); break;
      case 'checking':
        step(2);
        card('busy', '› checking the code…', `${esc(d.host || 'your PC')} · tailscale`);
        break;
      case 'paired':
        step(2);
        card('ok', '✓ found GupWorks PC', `tailscale · ${Number(d.rtt) || 0} ms · key saved`);
        break;
      case 'failed':
        step(1);
        card('bad', `✗ ${esc(d.title || 'that didn\'t work')}`, esc(d.message || 'Scan the code again.'));
        break;
      case 'denied':
        step(1);
        card('warn', '› camera is off for GupWorks', 'allow it in Settings, or enter the code instead');
        break;
      case 'nocamera':
        step(1);
        card('warn', '› no camera here', 'enter the code instead');
        break;
      case 'nonative':
        step(1);
        card('warn', '› pairing needs the iPhone app', 'open GupWorks on the phone to scan the code');
        break;
    }
  }

  function onPair(e) {
    if (!open) return;
    if (e.state === 'checking') render('checking', e);
    else if (e.state === 'failed') render('failed', e);
    else if (e.state === 'paired') {
      render('paired', e);
      // let the owner see "found" for a moment, then into the app (closing early goes straight in)
      paired = e;
      clearTimeout(doneTimer);
      doneTimer = setTimeout(close, 1100);
    }
  }

  async function openPair(o) {
    opts = o || {};
    if (open) return;
    open = true;
    torch = false;
    paired = null;
    $('pair-torch').classList.remove('on');
    $('pair').classList.remove('hidden');
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (!N.available) { document.documentElement.classList.add('fakecam'); return render('nonative'); }
    offEvent = N.on('pair', onPair);
    render('starting');
    let r;
    try { r = await N.call('pair.start'); } catch (e) { r = { error: 'no_camera' }; }
    if (!open || paired || (r && r.error === 'stopped')) return;   // a newer start/stop took over
    if (r && r.ok) { document.documentElement.classList.add('camera'); render('scanning'); }
    else render(r && r.error === 'denied' ? 'denied' : 'nocamera');
  }

  function close() {
    if (!open) return;
    open = false;
    clearTimeout(doneTimer);
    if (offEvent) { offEvent(); offEvent = null; }
    document.documentElement.classList.remove('camera', 'fakecam');
    $('pair').classList.add('hidden');
    if (N.available) N.call('pair.stop').catch(() => {});
    state = 'closed';
    if (paired) { const e = paired; paired = null; if (opts.onPaired) opts.onPaired(e); }
    else if (opts.onClose) opts.onClose();
  }

  // back from Settings (camera allowed now?) or from the background: start the camera again
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !open || !N.available || !['denied', 'nocamera'].includes(state)) return;
    N.call('pair.start').then(r => {
      if (open && r && r.ok) { document.documentElement.classList.add('camera'); render('scanning'); }
    }).catch(() => {});
  });

  function wire() {
    $('pair-x').innerHTML = ic('x', 22);
    $('pair-torch').innerHTML = ic('flash', 20);
    $('pair-x').addEventListener('click', close);
    $('pair-torch').addEventListener('click', async () => {
      if (!N.available) return;
      torch = !torch;
      try { torch = !!(await N.call('pair.torch', { on: torch })).on; } catch (e) { torch = false; }
      $('pair-torch').classList.toggle('on', torch);
    });
    $('pair-enter').addEventListener('click', () => { if (N.available) N.call('pair.enter').catch(() => {}); });
    $('pair-settings').addEventListener('click', () => { if (N.available) N.call('settings').catch(() => {}); });
  }

  wire();
  root.GupPair = { open: openPair, close, get isOpen() { return open; }, get state() { return state; } };
})(window);
