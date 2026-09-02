// CouchTube – popup: shows the pairing QR and connection status
(() => {
  const $ = (id) => document.getElementById(id);
  let lastUrl = null;

  const call = (msg) => chrome.runtime.sendMessage(msg);

  function render(s) {
    // status pill
    const pill = $('status');
    if (!s.enabled) { pill.textContent = 'Paused'; pill.className = 'pill'; }
    else if (s.connected && s.remotes > 0) { pill.textContent = 'Phone connected'; pill.className = 'pill ok'; }
    else if (s.connected) { pill.textContent = 'Ready to pair'; pill.className = 'pill ok'; }
    else if (s.error) { pill.textContent = 'Relay offline'; pill.className = 'pill bad'; }
    else { pill.textContent = 'Connecting…'; pill.className = 'pill warn'; }

    $('remotes').textContent = s.remotes || 0;
    $('toggle').textContent = s.enabled ? 'Pause' : 'Start';
    $('relay').placeholder = s.relayUrl;
    if (document.activeElement !== $('relay') && !$('relay').value) $('relay').value = s.relayUrl;

    $('error').classList.toggle('hidden', !s.error);
    $('error').textContent = s.error ? `${s.error}. Is the relay running? (cd server && npm start)` : '';

    $('now').classList.toggle('hidden', !s.nowPlaying);
    $('now').innerHTML = s.nowPlaying ? `Controlling: <b></b>` : '';
    if (s.nowPlaying) $('now').querySelector('b').textContent = s.nowPlaying;

    // QR
    if (s.enabled && s.remoteUrl) {
      $('url').textContent = s.remoteUrl;
      if (s.remoteUrl !== lastUrl) {
        lastUrl = s.remoteUrl;
        const qr = qrcode(0, 'M');
        qr.addData(s.remoteUrl);
        qr.make();
        $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
      }
    } else {
      lastUrl = null;
      $('url').textContent = '';
      $('qr').innerHTML = `<div class="msg">${!s.enabled ? 'Paused. Press Start to get a new code.' : s.error ? 'Start the relay server, then this QR will appear.' : 'Connecting to relay…'}</div>`;
    }
  }

  $('newRoom').addEventListener('click', async () => render(await call({ type: 'popup:newRoom' })));
  $('toggle').addEventListener('click', async () => render(await call({ type: 'popup:toggle' })));
  $('saveRelay').addEventListener('click', async () => render(await call({ type: 'popup:setRelay', url: $('relay').value })));
  $('relay').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('saveRelay').click(); });

  chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'status') render(m.status); });
  call({ type: 'popup:getStatus' }).then(render);
})();
