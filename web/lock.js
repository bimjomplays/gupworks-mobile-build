/* The app lock (look D "Face ID lock"). Inside the iPhone app the page starts locked: the shell (NativeBridge.swift)
   decides when it's locked (at launch, and again every time the app comes back from the background) and runs Face ID
   with the passcode as the fallback; this only draws the lock screen and hides everything else while it's up.
   The shell refuses every PC call while locked, so hiding here is about what's on screen, not the gate itself.
   The one thing it shows from the PC is how many items wait on the owner (lock.peek: a number, nothing else).
     GupLock.isLocked
     GupLock.show(info)   info = the shell's lock event or hello answer: {state, biometry, passcode}
                          state: idle | checking | cancelled | failed | no_passcode; biometry: face_id | touch_id | none
     GupLock.hide()
   Outside the app (desktop browser, dev mock) there is no lock. */
(function (root) {
  'use strict';
  const N = root.GupNative;
  const { ic, bot, esc } = root.GupUI;
  const $ = id => document.getElementById(id);

  const FACEID = '<svg viewBox="0 0 64 64" width="78" height="78" fill="none" stroke="currentColor" stroke-width="3.2" ' +
    'stroke-linecap="round" stroke-linejoin="round"><path d="M6 20V12a6 6 0 0 1 6-6h8M44 6h8a6 6 0 0 1 6 6v8M58 44v8a6 6 0 0 1-6 6h-8M20 58h-8a6 6 0 0 1-6-6v-8"/>' +
    '<path d="M22 24v5M42 24v5M32 24v13h-3M24 44c4.5 4 11.5 4 16 0"/></svg>';
  const NAME = { face_id: 'face id', touch_id: 'touch id', none: 'passcode' };
  const LOOK = { face_id: 'look at your iPhone to unlock', touch_id: 'touch the sensor to unlock', none: 'enter your passcode to unlock' };

  let locked = false, info = {}, peekAsked = false, drawn = false;

  function draw() {
    if (drawn) return;
    drawn = true;
    $('lock-bot').innerHTML = bot('gup', 116, { radius: 30 });
    $('lock-fid').addEventListener('click', () => unlock(false));
    $('lock-pin').addEventListener('click', () => {
      if (info.state === 'no_passcode') N.call('settings').catch(() => {});
      else unlock(true);
    });
  }

  function unlock(passcode) {
    if (info.state === 'checking') return;
    N.call('unlock', { passcode }).catch(() => {});
  }

  function render() {
    const bio = NAME[info.biometry] ? info.biometry : 'face_id';
    const state = info.state || 'idle';
    $('lock').dataset.state = state;
    $('lock-sub').innerHTML = `${ic('lock', 17)}locked · ${NAME[bio]}`;
    $('lock-fid').innerHTML = bio === 'face_id' ? FACEID : ic('lock', 64, 1.6);
    $('lock-fid').setAttribute('aria-label', bio === 'none' ? 'Unlock with the passcode' : `Unlock with ${NAME[bio]}`);
    const hint = {
      cancelled: `tap to unlock`,
      failed: `didn't match · tap to try again`,
      no_passcode: `set a passcode on this iPhone first`,
    }[state] || LOOK[bio];
    $('lock-hint').textContent = hint;
    $('lock-hint').className = 'hint' + (state === 'failed' || state === 'no_passcode' ? ' bad' : '');
    $('lock-pin').textContent = state === 'no_passcode' ? 'open settings' : 'use passcode';
  }

  function pill(n) {
    const el = $('lock-pill');
    if (!locked || typeof n !== 'number' || n < 0) return el.classList.add('hidden');
    el.innerHTML = n ? `<span class="amber">●</span>${esc(String(n))} waiting on you` : `<span class="dim">●</span>nothing waiting`;
    el.classList.remove('hidden');
  }

  async function peek() {
    if (peekAsked) return;
    peekAsked = true;
    let r = null;
    try { r = await N.call('lock.peek'); } catch (e) { /* not answered: no line */ }
    pill(r && r.waiting);
  }

  const GupLock = {
    get isLocked() { return locked; },
    show(i) {
      draw();
      info = Object.assign({}, info, i || {});
      if (!locked) {
        locked = true;
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();   // keyboard down
        document.documentElement.classList.add('locked');
        $('lock').classList.remove('hidden');
      }
      render();
      if (i && i.native && !document.hidden) peek();     // the shell has answered, so it can ask the PC now
    },
    hide() {
      if (!locked) return;
      locked = false;
      peekAsked = false;
      info.state = 'idle';
      document.documentElement.classList.remove('locked');
      $('lock').classList.add('hidden');
      pill(null);
    },
  };
  root.GupLock = GupLock;

  // the shell locks while the app goes to the background: ask for the count fresh each time it's back in front
  document.addEventListener('visibilitychange', () => {
    if (!locked || !N.available) return;
    if (document.hidden) { peekAsked = false; return; }
    peek();
  });

  // in the app nothing shows before the shell says it's unlocked
  if (N.available) GupLock.show({ state: 'idle' });
})(window);
