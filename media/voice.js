// media/voice.js (loaded BEFORE chat.js)
(function () {
  const vscodeApi = acquireVsCodeApi();
  window.acquireVsCodeApi = () => vscodeApi; // chat.js gets the same object

  const input = document.getElementById('input');
  const actions = document.querySelector('.composer-actions');
  const stopBtn = document.getElementById('stop');
  const send = document.getElementById('send');
  if (!input || !actions) return;

  // --- Mic button (icon only) ---
  const MIC_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" stroke="none"/>' +
    '<path d="M5 11a7 7 0 0 0 14 0"/>' +
    '<path d="M12 18v3M8 21h8"/>' +
    '</svg>';

  const btn = document.createElement('button');
  btn.id = 'mic';
  btn.className = 'icon-btn';
  btn.title = 'Dictate your message (opens a recording tab in your browser)';
  btn.setAttribute('aria-label', 'Voice input');
  btn.innerHTML = MIC_SVG;
  actions.insertBefore(btn, stopBtn || send);

  let listening = false;
  btn.addEventListener('click', () => {
    if (!listening) vscodeApi.postMessage({ type: 'mic' });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) return;

    if (msg.type === 'voiceState') {
      listening = msg.value === 'listening';
      btn.disabled = listening;
      btn.classList.toggle('listening', listening);
      btn.title = listening ? 'Listening… finish in your browser' : 'Dictate your message';
    } else if (msg.type === 'transcript') {
      const gap = input.value && !/\s$/.test(input.value) ? ' ' : '';
      input.value += gap + msg.text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }
  });
})();