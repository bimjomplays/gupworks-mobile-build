/* The two places later builds plug native features into the web UI.

   GupHooks.confirmOwnerAction(req) -> Promise<confirm block | null>
     EVERY owner decision (POST /v1/waiting/act) gets its `confirm` block from here and nowhere else. In the iPhone
     app the shell runs Face ID (or the device passcode) for exactly this decision (bridge op `confirm`) and answers
     {key, action, method: 'face_id' | 'touch_id' | 'passcode', at: <when the check passed, PC clock>}. The shell
     also remembers that block: it sends POST /v1/waiting/act only with a block it handed out, once, within 90 s, so
     a confirmation can't be made up or reused here. null when the owner cancels or the check fails; the UI then
     sends nothing. Asked again on every retry. req = {key, action, label, text, title}; the block is bound to the
     answer text too (the shell sends it only with that text), and title names the decision in the passcode prompt. Against the dev mock a glass sheet stands in for Face ID; in a desktop browser against a real PC
     owner decisions are refused (nothing can confirm them), so they are made on the PC.

   GupHooks.startVoice({onText}) -> Promise<{text, send} | null>
     The chat's mic: on-device speech-to-text in the voice sheet (voice.js). The words go into the chat box as they
     come (onText); it resolves the final text with send true (the owner tapped the send arrow) or false (keep it in
     the box to edit), or null when cancelled. The PC only ever gets the text, sent like a typed message; no audio
     leaves the phone. */
(function (root) {
  'use strict';
  const { ic, esc, sheet, toast } = root.GupUI;

  function devConfirm(req) {
    return new Promise(resolve => {
      let result = null;
      const s = sheet(
        `<div class="vtitle acc">confirm as owner <span>· dev mock</span></div>` +
        `<div class="vtext"><b>› </b>${esc(req.label || req.action)}<span> · ${esc(req.title || req.key)}</span>` +
        (req.text ? `<div class="ctext">"${esc(req.text)}"</div>` : '') + `</div>` +
        `<div class="vrow"><button class="vside g" data-act="cancel" aria-label="Cancel">${ic('x', 26)}</button>` +
        `<button class="vbig" data-act="ok" aria-label="Confirm">${ic('check', 40, 2.4)}</button>` +
        `<span class="vside"></span></div>` +
        `<div class="vnote">in the app this is Face ID<br>nothing is decided until you confirm</div>`,
        () => resolve(result));
      s.el.classList.add('confirm');
      s.el.querySelector('[data-act=cancel]').addEventListener('click', s.close);
      s.el.querySelector('[data-act=ok]').addEventListener('click', () => {
        // the contract only knows face_id / touch_id / passcode; the mock accepts any of them
        result = { key: req.key, action: req.action, method: 'passcode', at: root.GupAPI.serverNow().toISOString() };
        s.close();
      });
    });
  }

  async function nativeConfirm(req) {
    let r = null;
    try {
      r = await root.GupNative.call('confirm', {
        key: req.key, action: req.action, text: req.text || '', title: req.title || req.key,
        clockOffsetMs: root.GupAPI.serverNow().getTime() - Date.now(),
      });
    } catch (e) { /* locked meanwhile: nothing to decide */ }
    const c = r && r.confirm;
    if (c && c.key === req.key && c.action === req.action) return c;
    const why = {
      failed: 'Face ID didn\'t pass, so nothing was decided.',
      no_passcode: 'Set a passcode on this iPhone first: decisions need Face ID or the passcode.',
      busy: 'Another check is still open.',
    }[r && r.error];
    if (why) toast(esc(why), 'bad');
    return null;
  }

  const GupHooks = {
    async confirmOwnerAction(req) {
      if (root.GupAPI.mode === 'mock') return devConfirm(req);
      if (root.GupNative.available) return nativeConfirm(req);
      toast('Deciding needs Face ID in the GupWorks iPhone app. Decide this one on the PC.', 'bad');
      return null;
    },
    startVoice(opts) {
      return root.GupVoice.open(opts);
    },
  };
  root.GupHooks = GupHooks;
})(window);
