// End-to-end: relay + extension + phone page, with youtube.com faked via request routing.
const { chromium } = require('playwright');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const EXT = path.join(ROOT, 'apps', 'extension');

const fakeWatch = (id, title) => `<!doctype html><html><head><title>${title} - YouTube</title></head><body>
<h1 class="ytd-watch-metadata">${title}</h1>
<ytd-video-owner-renderer><div id="channel-name"><a>Fake Channel</a></div></ytd-video-owner-renderer>
<div id="masthead-container" style="position:fixed;top:0;left:0;right:0;height:56px;z-index:2020;background:#333">masthead</div>
<div id="player-container" style="view-transition-name: player-resize; position:relative"><div id="movie_player"><video></video>
  <div class="ytp-autonav-endscreen-countdown-overlay"><div class="ytp-autonav-endscreen-upnext-container" data-is-live="false"><a class="ytp-autonav-endscreen-link-container" href="https://www.youtube.com/watch?v=next0000001"></a><div class="ytp-autonav-endscreen-upnext-title">Autoplay pick</div><div class="ytp-autonav-endscreen-upnext-author">Chan N</div><div class="ytp-autonav-timestamp">3:33</div></div></div>
  <a class="ytp-videowall-still" href="https://www.youtube.com/watch?v=wall0000001" data-is-live="false"><span class="ytp-videowall-still-info-title">Wall one</span><span class="ytp-videowall-still-info-author">Chan W • 1M views</span><span class="ytp-videowall-still-info-duration">9:09</span></a>
  <a class="ytp-videowall-still" href="https://www.youtube.com/watch?v=wall0000002" data-is-live="true"><span class="ytp-videowall-still-info-title">Wall live</span><span class="ytp-videowall-still-info-author">Chan L</span></a>
  <button class="ytp-autonav-toggle-button" aria-checked="true" onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked')==='true'?'false':'true')"></button>
</div></div>
<div id="secondary">
  <ytd-compact-video-renderer><a id="video-title" href="/watch?v=rel00000001" title="Related one">Related one</a><ytd-channel-name><div id="text">Chan A</div></ytd-channel-name><ytd-thumbnail-overlay-time-status-renderer>4:20</ytd-thumbnail-overlay-time-status-renderer></ytd-compact-video-renderer>
  <ytd-compact-video-renderer><a id="video-title" href="/watch?v=rel00000002" title="Related two">Related two</a><div id="metadata-line">1.2K watching</div><span class="badge-shape-wiz--thumbnail-live">LIVE</span></ytd-compact-video-renderer>
</div>
<button class="ytp-subtitles-button" aria-pressed="false" onclick="this.setAttribute('aria-pressed', this.getAttribute('aria-pressed')==='true'?'false':'true')"></button>
<like-button-view-model><button aria-pressed="false" onclick="this.setAttribute('aria-pressed', this.getAttribute('aria-pressed')==='true'?'false':'true')">Like</button></like-button-view-model>
<button class="ytp-skip-ad-button" onclick="window.__skipped=true"></button>
<script>
  const p = document.getElementById('movie_player');
  let t = 42, playing = true, vol = 80, muted = false, rate = 1;
  setInterval(() => { if (playing) t += rate; }, 1000);
  Object.assign(p, {
    getPlayerState: () => window.__ended ? 0 : playing ? 1 : 2, playVideo: () => { playing = true; window.__ended = false; p.classList.remove('ended-mode'); }, pauseVideo: () => playing = false,
    seekTo: (s) => t = s, getCurrentTime: () => t, getDuration: () => 600,
    getVolume: () => vol, setVolume: (v) => vol = v, mute: () => muted = true, unMute: () => muted = false, isMuted: () => muted,
    setPlaybackRate: (r) => rate = r, getPlaybackRate: () => rate,
    nextVideo: () => location.href = '/watch?v=next0000001', previousVideo: () => {},
    getVideoData: () => ({ video_id: '${id}', title: '${title}', author: 'Fake Channel', isLive: false }),
  });
  window.__player = () => ({ t, playing, vol, muted, rate });
</script></body></html>`;

const fakeResults = (q) => `<!doctype html><html><head><title>${q} - YouTube</title></head><body><div id="primary">
${[1, 2, 3].map((i) => `<ytd-video-renderer><a id="video-title" href="/watch?v=res0000000${i}" title="${q} video ${i}">${q} video ${i}</a><ytd-channel-name><div id="text">Channel ${i}</div></ytd-channel-name><ytd-thumbnail-overlay-time-status-renderer>1${i}:0${i}</ytd-thumbnail-overlay-time-status-renderer></ytd-video-renderer>`).join('')}
</div></body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let relay = null;
process.on('exit', () => { try { relay?.kill(); } catch {} });

(async () => {
  // 1. relay
  relay = spawn('node', ['src/index.js'], { cwd: path.join(ROOT, 'apps', 'relay'), env: { ...process.env, PORT: '8787', PUBLIC_URL: 'http://127.0.0.1:8787' } });
  relay.stdout.on('data', (d) => process.stdout.write('[relay] ' + d));
  relay.stderr.on('data', (d) => process.stdout.write('[relay!] ' + d));
  await sleep(700);

  // 2. browser with extension
  const ctx = await chromium.launchPersistentContext('', {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true, args0: null,
    args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  // fake youtube.com
  await ctx.route(/https:\/\/www\.youtube\.com\/.*/, (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/watch') return route.fulfill({ contentType: 'text/html', body: fakeWatch(u.searchParams.get('v'), 'Video ' + u.searchParams.get('v')) });
    if (u.pathname === '/results') return route.fulfill({ contentType: 'text/html', body: fakeResults(u.searchParams.get('search_query')) });
    if (u.pathname.startsWith('/channel/UC4R8DWoMoI7CAwX8_LjQHig')) return route.fulfill({ contentType: 'text/html', body: fakeResults('live').replace(/ytd-thumbnail-overlay-time-status-renderer>1/g, 'ytd-thumbnail-overlay-time-status-renderer overlay-style="LIVE">LIVE 1') });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>YouTube</title><div id="primary"></div>' });
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  console.log('✓ extension loaded', extId);

  // 3. popup shows QR + url
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector('#qr svg', { timeout: 10000 });
  const remoteUrl = await popup.textContent('#url');
  assert.match(remoteUrl, /^http:\/\/127\.0\.0\.1:8787\/r\/#[A-Z2-9]{6}\.[\w-]+$/);
  assert.strictEqual(await popup.textContent('#status'), 'Ready to pair');
  // loaded unpacked => development mode => default relay is localhost, DEV badge visible
  await popup.waitForSelector('#devBadge:not(.hidden)', { timeout: 3000 });
  assert.ok((await popup.textContent('#relayHint')).includes('ws://localhost:8787'), 'dev default relay');
  console.log('✓ popup renders QR for', remoteUrl, '(DEV mode detected, localhost relay by default)');

  // 4. open a fake youtube watch page
  const yt = await ctx.newPage();
  await yt.goto('https://www.youtube.com/watch?v=abc12345678');
  await sleep(1500);

  // 5. phone page connects
  const phone = await ctx.newPage();
  phone.on('pageerror', (e) => console.log('[phone error]', e.message));
  await phone.goto(remoteUrl);
  await phone.waitForFunction(() => document.getElementById('status').textContent === 'Connected', null, { timeout: 8000 });
  await phone.waitForFunction(() => document.getElementById('title').textContent.startsWith('Video abc'), null, { timeout: 8000 });
  console.log('✓ phone connected and shows now playing:', await phone.textContent('#title'), '/', await phone.textContent('#channel'));
  assert.strictEqual(await popup.textContent('#remotes'), '1');

  // 6. controls
  await phone.click('[data-cmd="seek"][data-value="10"]');
  await sleep(500);
  let st = await yt.evaluate(() => window.__player());
  assert.ok(st.t >= 52 && st.t < 56, 'seek +10 applied, got ' + st.t);
  await phone.click('#playBtn');
  await sleep(400);
  st = await yt.evaluate(() => window.__player());
  assert.strictEqual(st.playing, false, 'toggle pauses');
  await phone.waitForSelector('#iconPlay:not(.hidden)');
  await phone.click('[data-rate="1.5"]');
  await sleep(400);
  assert.strictEqual((await yt.evaluate(() => window.__player())).rate, 1.5);
  await phone.click('#muteBtn');
  await sleep(400);
  assert.strictEqual((await yt.evaluate(() => window.__player())).muted, true);
  await phone.evaluate(() => { const v = document.getElementById('vol'); v.value = 35; v.dispatchEvent(new Event('change')); });
  await sleep(400);
  st = await yt.evaluate(() => window.__player());
  assert.strictEqual(st.vol, 35); assert.strictEqual(st.muted, false, 'setting volume unmutes');
  await phone.click('[data-cmd="captions"]');
  await sleep(300);
  assert.strictEqual(await yt.evaluate(() => document.querySelector('.ytp-subtitles-button').getAttribute('aria-pressed')), 'true', 'captions button clicked');
  await phone.waitForSelector('#ccBtn.on', { timeout: 3000 });
  await phone.click('#likeBtn');
  await phone.waitForSelector('#likeBtn.on', { timeout: 3000 });
  assert.strictEqual(await phone.textContent('#likeBtn'), '♥ Liked');
  await yt.evaluate(() => document.getElementById('movie_player').classList.add('ad-showing'));
  await phone.waitForSelector('#ad.show', { timeout: 3000 });
  await phone.click('#skipAd');
  await sleep(300);
  assert.strictEqual(await yt.evaluate(() => window.__skipped), true, 'skip ad clicked');
  await yt.evaluate(() => document.getElementById('movie_player').classList.remove('ad-showing'));
  await phone.waitForFunction(() => !document.getElementById('ad').classList.contains('show'), null, { timeout: 3000 });
  console.log('✓ seek / pause / rate / mute / volume / captions / like / skip-ad all reached the page');

  // 6b. fullscreen without a click: real requestFullscreen is refused -> web fullscreen + window fullscreen
  await phone.click('#fsBtn');
  await yt.waitForFunction(() => document.documentElement.classList.contains('couchtube-fake-fs'), null, { timeout: 5000 });
  await phone.waitForSelector('#fsBtn.on', { timeout: 3000 });
  await sleep(500);
  const winState = await sw.evaluate(async () => (await chrome.windows.getAll()).map((w) => w.state));
  assert.ok(winState.includes('fullscreen'), 'browser window went fullscreen, got ' + winState);
  const playerBox = await yt.evaluate(() => { const r = document.getElementById('movie_player').getBoundingClientRect(); return [r.left, r.top, Math.round(r.width), Math.round(r.height)]; });
  assert.deepStrictEqual(playerBox.slice(0, 2), [0, 0]);
  assert.deepStrictEqual(playerBox.slice(2), await yt.evaluate(() => [window.innerWidth, window.innerHeight]), 'player fills the viewport');
  const onTop = await yt.evaluate(() => [[10, 10], [innerWidth / 2, innerHeight / 2], [innerWidth - 10, innerHeight - 10]].map(([x, y]) => document.elementFromPoint(x, y)?.closest('#movie_player') ? 'player' : document.elementFromPoint(x, y)?.id));
  assert.deepStrictEqual(onTop, ['player', 'player', 'player'], 'nothing paints over the player (masthead hidden, view-transition stacking neutralized): ' + onTop);
  await phone.click('#fsBtn'); // toggle back
  await yt.waitForFunction(() => !document.documentElement.classList.contains('couchtube-fake-fs'), null, { timeout: 5000 });
  await phone.waitForSelector('#fsBtn:not(.on)', { timeout: 3000 });
  await sleep(500);
  assert.ok(!(await sw.evaluate(async () => (await chrome.windows.getAll()).map((w) => w.state))).includes('fullscreen'), 'window restored');
  // and again, to prove it is repeatable (the original bug)
  await phone.click('#fsBtn');
  await yt.waitForFunction(() => document.documentElement.classList.contains('couchtube-fake-fs'), null, { timeout: 5000 });
  await phone.click('#fsBtn');
  await yt.waitForFunction(() => !document.documentElement.classList.contains('couchtube-fake-fs'), null, { timeout: 5000 });
  console.log('✓ fullscreen from the phone works with no click, on and off, repeatedly');

  // 6c. sleep timer state round-trips
  await phone.click('[data-sleep="15"]');
  await phone.waitForFunction(() => /Pausing in 1[45] min/.test(document.getElementById('sleepInfo').textContent), null, { timeout: 5000 });
  const alarms = await sw.evaluate(async () => (await chrome.alarms.getAll()).map((a) => a.name));
  assert.ok(alarms.includes('couchtube-sleep'), 'sleep alarm scheduled');
  await phone.click('[data-sleep="0"]');
  await phone.waitForFunction(() => document.getElementById('sleepInfo').classList.contains('hidden'), null, { timeout: 5000 });
  console.log('✓ sleep timer set and cleared');

  // 7. "Up next" list is filled automatically for the current video (no tap needed)
  await phone.waitForFunction(() => document.querySelectorAll('#upnextList .result').length >= 2, null, { timeout: 10000 });
  assert.strictEqual(await phone.textContent('#upnextList .result .t'), 'Related one');
  const second = await phone.$eval('#upnextList .result:nth-child(2)', (el) => ({ badge: el.querySelector('.d').textContent, meta: el.querySelector('.c').textContent }));
  assert.strictEqual(second.badge, 'LIVE'); assert.ok(second.meta.includes('1.2K watching'), second.meta);
  console.log('✓ "up next" list filled automatically, live item tagged with viewers');

  // 7b. video ends -> end-screen suggestions replace the list, Replay appears, autoplay chip reflects state
  await phone.waitForSelector('#autoplayBtn.on', { timeout: 5000 });
  await yt.evaluate(() => { window.__ended = true; document.getElementById('movie_player').classList.add('ended-mode'); });
  await phone.waitForFunction(() => document.getElementById('upnextTitle').textContent === 'Video ended', null, { timeout: 5000 });
  await phone.waitForFunction(() => document.querySelector('#upnextList .result .next')?.textContent === 'NEXT', null, { timeout: 8000 });
  const wall = await phone.$$eval('#upnextList .result', (els) => els.map((e) => e.querySelector('.t').textContent));
  assert.deepStrictEqual(wall, ['NEXTAutoplay pick', 'Wall one', 'Wall live']);
  assert.strictEqual(await phone.$eval('#upnextList .result:nth-child(3) .d', (e) => e.textContent), 'LIVE');
  await phone.click('#replayBtn');
  await phone.waitForFunction(() => document.getElementById('upnextTitle').textContent === 'Up next', null, { timeout: 5000 });
  assert.strictEqual((await yt.evaluate(() => window.__player())).t, 0, 'replay seeks to 0');
  await phone.click('#autoplayBtn');
  await phone.waitForSelector('#autoplayBtn:not(.on)', { timeout: 5000 });
  console.log('✓ end screen: autoplay pick + wall shown on the phone, replay + autoplay toggle work');

  // 8. search from the phone -> tab navigates -> results shown on phone
  await phone.fill('#q', 'cats');
  await phone.press('#q', 'Enter');
  await phone.waitForFunction(() => document.querySelectorAll('#results .result').length === 3, null, { timeout: 10000 });
  assert.ok(yt.url().includes('results?search_query=cats'), 'tab navigated to search');
  assert.strictEqual(await phone.textContent('#results .result .t'), 'cats video 1');
  assert.strictEqual(await phone.textContent('#results .result .d'), '11:01');
  console.log('✓ search from phone navigated the tab and returned results');

  // 8b. live tab
  await phone.click('[data-cmd="live"]');
  await phone.waitForFunction(() => document.querySelectorAll('#results .result').length === 3 && document.querySelector('#results .result .t').textContent.startsWith('live video'), null, { timeout: 10000 });
  assert.ok(yt.url().includes('/channel/UC4R8DWoMoI7CAwX8_LjQHig'));
  assert.strictEqual(await phone.textContent('#results .result .d'), 'LIVE');
  console.log('✓ live tab lists live streams');
  await phone.fill('#q', 'cats'); await phone.press('#q', 'Enter');
  await phone.waitForFunction(() => document.querySelector('#results .result .t')?.textContent === 'cats video 1', null, { timeout: 10000 });

  // 9. tap a result -> tab opens the video, phone shows it, and Up next refreshes for the new video
  await phone.click('#results .result');
  await phone.waitForFunction(() => document.getElementById('title').textContent === 'Video res00000001', null, { timeout: 10000 });
  assert.ok(yt.url().includes('watch?v=res00000001'));
  await phone.waitForFunction(() => document.querySelector('#upnextList .result .t')?.textContent === 'Related one', null, { timeout: 10000 });
  console.log('✓ picked a video from the phone, Up next refreshed for it');

  // 10. new code invalidates the old one for new joins
  await popup.click('#newRoom');
  await popup.waitForFunction((old) => document.getElementById('url').textContent && document.getElementById('url').textContent !== old, remoteUrl, { timeout: 8000 });
  const phone2 = await ctx.newPage();
  await phone2.goto(remoteUrl);
  await phone2.waitForFunction(() => /Invalid|ended/.test(document.getElementById('status').textContent), null, { timeout: 8000 });
  await phone.waitForFunction(() => document.getElementById('status').textContent === 'Session ended', null, { timeout: 5000 });
  console.log('✓ old QR rejected after "New code", connected phone told the session ended');

  await ctx.close();
  relay.kill();
  console.log('\nAll end-to-end tests passed');
  process.exit(0);
})().catch((e) => { console.error('E2E FAILED:', e); process.exit(1); });
