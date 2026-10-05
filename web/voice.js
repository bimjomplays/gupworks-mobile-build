/* Talking to Gup: the look D voice sheet (mockups/gen.py voice_sheet, look 'd').

   GupVoice.open({onText}) -> Promise<{text, send} | null>
     Opens the sheet and listens. The words show in the sheet as they come and go into the chat box too
     (onText(text) on every change). ↑ stops, takes the final text and resolves {text, send: true}; ■, a tap on the
     dimmer or the app locking stop and resolve {text, send: false}, so the text stays in the box to edit; × resolves
     null (nothing kept). Nothing is sent from here: the chat sends the text like a typed message.

   Engines: in the iPhone app the shell (VoiceInput.swift: Apple's speech recognizer ON THE DEVICE ONLY; bridge ops
   voice.start {tag} / voice.stop / voice.cancel, events `voice` {tag, state: listening, text} · {tag, level} ·
   {tag, state: stopped, text, reason}). On the dev mock a pretend one "hears" a sentence. In a desktop browser there
   is none on purpose: the browser's own speech API sends the audio to a cloud service, and no voice leaves the phone. */
(function (root) {
  'use strict';
  const { ic, esc, sheet, toast } = root.GupUI;
  const BARS = 34;

  // what each way of not listening says: [title, explanation, way out: settings | retry | null]
  const PROBLEMS = {
    mic_denied: ['microphone off', 'GupWorks isn\'t allowed to use the microphone. Turn it on in Settings › GupWorks › Microphone.', 'settings'],
    speech_denied: ['speech recognition off', 'Turn on Speech Recognition for GupWorks in Settings › GupWorks.', 'settings'],
    restricted: ['speech recognition blocked', 'Speech recognition is restricted on this iPhone (Screen Time or a device profile). Type your message instead.', null],
    language: ['language not supported', 'iOS speech recognition doesn\'t support this iPhone\'s language ({locale}). Type your message instead.', null],
    no_on_device: ['no on-device model', 'This iPhone can\'t turn {locale} speech into text on the device, and GupWorks never sends your voice anywhere else. ' +
                   'Turn on Dictation (Settings › General › Keyboard) so iOS downloads the model, then try again.', 'retry'],
    unavailable: ['speech recognition busy', 'iOS speech recognition isn\'t available right now. Try again in a moment.', 'retry'],
    audio: ['microphone busy', 'The microphone couldn\'t start; another app may be using it.', 'retry'],
    busy: ['still finishing', 'The last dictation is still finishing.', 'retry'],
    no_speech: ['didn\'t hear anything', 'Nothing came through. Tap the mic and talk again.', 'retry'],
    failed: ['transcription stopped', 'Speech recognition stopped with an error.', 'retry'],
  };
  // why a dictation ended by itself (shown after "stopped")
  const ENDED = { limit: 'time limit', interrupted: 'interrupted', ended: 'pause' };

  // ---------------------------------------------------------------- engines
  function nativeEngine() {
    const N = root.GupNative;
    return {
      start: tag => N.call('voice.start', { tag }).catch(() => ({ error: 'cancelled' })),
      stop: () => N.call('voice.stop').then(r => (r && typeof r.text === 'string' ? r.text : ''), () => ''),
      cancel: () => { N.call('voice.cancel').catch(() => {}); },
      on: fn => N.on('voice', fn),
      settings: () => { N.call('settings').catch(() => {}); },
    };
  }

  /** dev mock: "hears" a sentence a word at a time, with a waveform from the mockup's pattern */
  function mockEngine() {
    const speed = Number(new URLSearchParams(location.search).get('speed')) || 1;
    const WORDS = 'turn off the push rule for Ghost for an hour while I test'.split(' ');
    const WAVE = [3, 5, 8, 12, 9, 14, 18, 12, 7, 10, 16, 20, 15, 9, 6, 11, 17, 13, 8, 5, 9, 14, 10, 6, 4, 7, 11, 8, 5, 3];
    let listeners = [], timers = [], tag = 0, heard = 0;
    const emit = e => listeners.slice().forEach(fn => fn(Object.assign({ tag }, e)));
    const clear = () => { timers.forEach(clearInterval); timers = []; };
    return {
      start(t) {
        clear();
        tag = t; heard = 0;
        let k = 0;
        timers.push(setInterval(() => emit({ level: heard < WORDS.length ? WAVE[k++ % WAVE.length] / 20 : 0.05 }), 70));
        timers.push(setInterval(() => {
          if (heard < WORDS.length) emit({ state: 'listening', text: WORDS.slice(0, ++heard).join(' ') });
        }, 320 / speed));
        return Promise.resolve({ ok: true, tag, locale: 'en-US', maxSeconds: 120 });
      },
      stop() {
        clear();
        const text = WORDS.slice(0, heard).join(' ');
        // the recognizer's final answer adds capitals and punctuation
        return new Promise(r => setTimeout(() => r(text && text.charAt(0).toUpperCase() + text.slice(1) + '.'), 120));
      },
      cancel: clear,
      on(fn) { listeners.push(fn); return () => { listeners = listeners.filter(f => f !== fn); }; },
      settings() {},
    };
  }

  function pickEngine() {
    if (root.GupNative && root.GupNative.available) return nativeEngine();
    if (root.GupAPI && root.GupAPI.mode === 'mock') return mockEngine();
    return null;
  }

  const words = s => s.split(/\s+/).filter(Boolean);

  // ---------------------------------------------------------------- the sheet
  let tags = 0;
  let current = null;

  function open(opts) {
    const onText = (opts && opts.onText) || (() => {});
    if (current) return Promise.resolve(null);
    const engine = pickEngine();
    if (!engine) {
      toast('Voice input is in the GupWorks iPhone app (turned into text on the phone). Type your message here.');
      return Promise.resolve(null);
    }
    return new Promise(resolve => {
      // st: starting | listening | finishing | stopped | problem
      let tag = 0, st = 'starting', said = '', settled = 0, t0 = 0, ticker = null, decided = false, problem = null, reason = '';
      const levels = new Array(BARS).fill(0);
      const s = sheet(
        `<div class="vtitle" id="v-title"></div>` +
        `<div class="vwave" id="v-wave"><span class="wave">${'<i class="p"></i>'.repeat(BARS)}</span></div>` +
        `<div class="vtext" id="v-text" aria-live="polite"></div>` +
        `<div class="vrow" id="v-row"></div>` +
        `<div class="vnote" id="v-note"></div>`,
        () => end(null, true));
      s.el.classList.add('voice');
      const $ = id => s.el.querySelector('#' + id);
      const bars = [...s.el.querySelectorAll('.wave i')];
      const off = engine.on(onEvent);
      const offLock = root.GupNative && root.GupNative.available
        ? root.GupNative.on('lock', d => { if (d.locked) end(null, true); }) : () => {};
      // back from Settings after turning a permission on: try again by itself
      const onVisible = () => { if (!document.hidden && st === 'problem' && PROBLEMS[problem.code][2] === 'settings') start(); };
      document.addEventListener('visibilitychange', onVisible);
      current = { close: () => end(null, true) };
      document.documentElement.classList.add('voice');

      function mmss() {
        const sec = t0 ? Math.floor((Date.now() - t0) / 1000) : 0;
        return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      }
      function render() {
        const title = $('v-title');
        title.className = 'vtitle' + (st === 'listening' || st === 'problem' ? '' : ' acc');
        title.innerHTML = st === 'problem' ? esc(PROBLEMS[problem.code][0]) : `${st} <span>· ` +
          (st === 'starting' ? '' : mmss() + ' · ') + (st === 'stopped' && ENDED[reason] ? ENDED[reason] + ' · ' : '') + 'on-device</span>';
        const box = $('v-text');
        if (st === 'problem') {
          box.className = 'vtext msg';
          box.innerHTML = esc(PROBLEMS[problem.code][1].replace('{locale}', problem.locale || 'its language'));
        } else {
          // the words the recognizer kept are white; the newest ones (still settling) dim, like the mockup
          const w = words(said);
          box.className = 'vtext';
          box.innerHTML = '<b>› </b>' + (w.length
            ? esc(w.slice(0, settled).join(' ')) + (settled && settled < w.length ? ' ' : '') + `<span>${esc(w.slice(settled).join(' '))}</span>`
            : st === 'listening' ? '<span>say something…</span>' : '') +
            (st === 'listening' || st === 'starting' ? '<i class="cur blink"></i>' : '');
        }
        $('v-wave').classList.toggle('hidden', st === 'problem');
        const way = st === 'problem' ? PROBLEMS[problem.code][2] : null;
        const cancel = `<button class="vside g" data-act="cancel" type="button" aria-label="${st === 'problem' ? 'Close' : 'Cancel'}">${ic('x', 26)}</button>`;
        $('v-row').innerHTML = st === 'problem'
          ? cancel + (way === 'retry' ? `<button class="vbig" data-act="retry" type="button" aria-label="Try again">${ic('mic', 40, 2.2)}</button>`
            : way === 'settings' ? `<button class="btn p" data-act="settings" type="button">open settings</button>` : '') + '<span class="vside"></span>'
          : cancel +
            `<button class="vbig" data-act="send" type="button" aria-label="Send"${st === 'listening' || st === 'stopped' ? '' : ' disabled'}>${ic('arrowup', 40, 2.4)}</button>` +
            `<button class="vside g" data-act="edit" type="button" aria-label="Stop and edit"${st === 'listening' || st === 'stopped' ? '' : ' disabled'}>${ic('stop', 24)}</button>`;
        $('v-note').innerHTML = st === 'problem'
          ? (way === 'settings' ? 'turn it on, then come back' : way === 'retry' ? 'tap the mic to try again' : 'type your message for now')
          : st === 'stopped' ? 'tap ↑ to send, or ■ to edit it first' : 'transcribed on your iPhone<br>nothing is sent until you tap ↑';
        drawWave();
      }
      function drawWave() {
        const live = st === 'listening';
        bars.forEach((b, i) => { b.style.height = (live ? Math.round(6 + levels[i] * 58) : 6) + 'px'; });
      }
      function heard(text, final) {
        const before = words(said), now = words(text);
        let k = 0;
        while (k < before.length && k < now.length && before[k] === now[k]) k++;
        settled = final ? now.length : k;
        said = text;
        onText(said);
      }

      async function start() {
        problem = null; reason = ''; said = ''; settled = 0; t0 = 0; levels.fill(0);
        st = 'starting';
        onText('');
        render();
        const mine = tag = ++tags;
        const r = await engine.start(mine);
        if (decided || mine !== tag) return;
        if (!r || !r.ok) {
          if (r && r.error === 'cancelled') return;
          return showProblem((r && r.error) || 'failed', r && r.locale);
        }
        st = 'listening';
        t0 = Date.now();
        clearInterval(ticker);
        ticker = setInterval(() => { if (st === 'listening') render(); }, 500);
        render();
      }
      function showProblem(code, locale) {
        problem = { code: PROBLEMS[code] ? code : 'failed', locale };
        st = 'problem';
        clearInterval(ticker);
        render();
      }
      function onEvent(e) {
        if (decided || e.tag !== tag) return;
        if (typeof e.level === 'number' && st === 'listening') {
          levels.push(Math.max(0, Math.min(1, e.level)));
          levels.shift();
          drawWave();
        }
        if (e.state === 'listening' && st === 'listening' && typeof e.text === 'string') { heard(e.text, false); render(); }
        if (e.state === 'stopped' && (st === 'listening' || st === 'finishing')) {
          // it ended by itself (a pause, the time limit, a call, an error): keep what it heard
          clearInterval(ticker);
          if (typeof e.text === 'string' && e.text.trim()) heard(e.text, true);
          if (!said.trim()) return showProblem(e.reason === 'failed' ? 'failed' : 'no_speech');
          st = 'stopped';
          reason = e.reason;
          render();
        }
      }

      /** ↑ (send) or ■ (edit): stop, take the final text */
      async function finish(send) {
        if (st === 'listening') {
          st = 'finishing';
          clearInterval(ticker);
          render();
          const text = await engine.stop();
          if (decided) return;
          if (text.trim()) heard(text, true);
        } else if (st !== 'stopped') return;
        if (!said.trim()) return showProblem('no_speech');
        end({ text: said.trim(), send }, false);
      }

      /** closes once. A result, or null: keep = dimmer / lock (what was heard stays in the box), else cancelled */
      function end(result, keep) {
        if (decided) return;
        decided = true;
        clearInterval(ticker);
        off(); offLock();
        document.removeEventListener('visibilitychange', onVisible);
        current = null;
        document.documentElement.classList.remove('voice');
        if (st === 'starting' || st === 'listening' || st === 'finishing') engine.cancel();
        s.close();
        if (result) return resolve(result);
        resolve(keep && said.trim() ? { text: said.trim(), send: false } : null);
      }

      $('v-row').addEventListener('click', e => {
        const b = e.target.closest('[data-act]');
        if (!b || b.disabled) return;
        const act = b.dataset.act;
        if (act === 'cancel') end(null, false);
        else if (act === 'send') finish(true);
        else if (act === 'edit') finish(false);
        else if (act === 'retry') start();
        else if (act === 'settings') engine.settings();
      });
      start();
    });
  }

  root.GupVoice = { open, get isOpen() { return !!current; }, close() { if (current) current.close(); } };
})(window);
