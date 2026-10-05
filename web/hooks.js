/* The two places later builds plug native features into the web UI.

   GupHooks.confirmOwnerAction(req) -> Promise<confirm block | null>
     EVERY owner decision (POST /v1/waiting/act) gets its `confirm` block from here and nowhere else. The Face ID
     build replaces the body: ask the native side for Face ID (or the device passcode) for exactly this decision,
     then return {key, action, method: 'face_id' | 'touch_id' | 'passcode', at: <when the check passed, PC clock>}.
     Return null when the owner cancels or the check fails; the UI then sends nothing. Ask again on every retry.
     req = {key, action, label, text, title} (title/label are for the prompt).
     Until then: against the dev mock a glass sheet stands in for Face ID; against a real PC owner decisions are
     refused here (no way to confirm yet), so they are made on the PC.

   GupHooks.startVoice() -> Promise<string | null>
     The voice build replaces this: on-device speech-to-text, resolving the transcript (sent as text, the PC never
     gets audio) or null if cancelled. Until then the mic button only says it isn't ready. */
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

  const GupHooks = {
    async confirmOwnerAction(req) {
      if (root.GupAPI.mode === 'mock') return devConfirm(req);
      toast('Deciding from the phone needs Face ID, which isn\'t in this build yet. Decide it on the PC for now.', 'bad');
      return null;
    },
    async startVoice() {
      toast('Voice input isn\'t in this build yet: type your message for now.');
      return null;
    },
  };
  root.GupHooks = GupHooks;
})(window);
