// CouchTube – page bridge (runs in the page's MAIN world)
// -------------------------------------------------------
// Content scripts live in an isolated world and cannot call YouTube's player API
// (document.getElementById('movie_player').playVideo() etc). This tiny script runs
// in the page world and exposes the player through DOM CustomEvents, so the
// isolated content script can drive the real YouTube player (volume slider stays in
// sync, next/previous use YouTube's own queue, etc.). It falls back to the raw
// <video> element when the API is not there yet.

(() => {
  if (window.__couchtubeBridge) return;
  window.__couchtubeBridge = true;

  const player = () => document.getElementById('movie_player');
  const video = () => document.querySelector('#movie_player video, video.html5-main-video, video');
  const hasApi = (p) => p && typeof p.getPlayerState === 'function' && typeof p.seekTo === 'function';
  const click = (sel) => { const el = document.querySelector(sel); if (el) { el.click(); return true; } return false; };

  function videoIdFromUrl() {
    const u = new URL(location.href);
    if (u.pathname === '/watch') return u.searchParams.get('v');
    const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{6,})/);
    return m ? m[2] : null;
  }

  function getState() {
    const p = player(), v = video();
    const onWatch = location.pathname === '/watch' || location.pathname.startsWith('/shorts/') || location.pathname.startsWith('/live/');
    const st = { hasVideo: false, pageTitle: document.title.replace(/ - YouTube$/, ''), url: location.href };
    if (!onWatch || !v) return st;

    let title = '', channel = '', videoId = videoIdFromUrl();
    if (hasApi(p) && typeof p.getVideoData === 'function') {
      try { const d = p.getVideoData(); title = d.title || ''; channel = d.author || ''; videoId = d.video_id || videoId; } catch {}
    }
    if (!title) title = document.querySelector('h1.ytd-watch-metadata, h1.ytd-video-primary-info-renderer, ytd-reel-video-renderer[is-active] h2')?.textContent?.trim() || st.pageTitle;
    if (!channel) channel = document.querySelector('ytd-video-owner-renderer #channel-name a, #owner #channel-name a')?.textContent?.trim() || '';

    const api = hasApi(p);
    let paused = v.paused;
    if (api) { try { paused = p.getPlayerState() !== 1; } catch {} }

    const likeBtn = document.querySelector('like-button-view-model button, #segmented-like-button button, ytd-toggle-button-renderer#like-button button');
    const live = api ? !!safe(() => p.getVideoData()?.isLive, false) : !!document.querySelector('.ytp-live');
    const atLiveEdge = live && !!document.querySelector('.ytp-live-badge-is-livehead, .ytp-live-badge[disabled]');

    return {
      ...st,
      hasVideo: true,
      videoId, title, channel,
      thumb: videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : '',
      currentTime: api ? safe(() => p.getCurrentTime(), v.currentTime) : v.currentTime,
      duration: api ? safe(() => p.getDuration(), v.duration) : v.duration,
      paused,
      volume: api ? safe(() => p.getVolume(), v.volume * 100) / 100 : v.volume,
      muted: api ? safe(() => p.isMuted(), v.muted) : v.muted,
      rate: api ? safe(() => p.getPlaybackRate(), v.playbackRate) : v.playbackRate,
      live, atLiveEdge,
      ended: api ? (safe(() => p.getPlayerState(), -1) === 0 || p.classList.contains('ended-mode')) : !!v.ended,
      autoplay: (() => { const b = document.querySelector('.ytp-autonav-toggle-button'); return b ? b.getAttribute('aria-checked') === 'true' : null; })(),
      fullscreen: !!document.fullscreenElement || isFakeFs(),
      liked: likeBtn ? likeBtn.getAttribute('aria-pressed') === 'true' : null,
      ad: !!(p && p.classList.contains('ad-showing')),
      canSkip: !!document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern'),
      captions: (() => { const b = document.querySelector('.ytp-subtitles-button'); return b ? b.getAttribute('aria-pressed') === 'true' : null; })(),
    };
  }

  // ---- "web fullscreen": fills the screen without a user gesture ----
  // Browsers only allow requestFullscreen() right after a real click on the page, so a
  // command coming from the phone is usually refused. Fallback: pin the player over the
  // whole page (CSS class handled by content.js) and ask the extension to put the browser
  // window itself into fullscreen (chrome.windows API needs no gesture). Visually identical.
  const FAKE_CLASS = 'couchtube-fake-fs';
  const isFakeFs = () => document.documentElement.classList.contains(FAKE_CLASS);
  const windowEvent = (state) => document.dispatchEvent(new CustomEvent('couchtube:window', { detail: state }));
  function markAncestors() {
    document.querySelectorAll('[data-couchtube-ancestor]').forEach((el) => el.removeAttribute('data-couchtube-ancestor'));
    let el = player()?.parentElement;
    while (el && el !== document.documentElement) { el.setAttribute('data-couchtube-ancestor', ''); el = el.parentElement; }
  }
  function enterFakeFs() {
    markAncestors();
    document.documentElement.classList.add(FAKE_CLASS);
    windowEvent('fullscreen');
    // YouTube re-lays out its controls on resize
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    setTimeout(() => window.dispatchEvent(new Event('resize')), 600);
  }
  function exitFakeFs() {
    document.documentElement.classList.remove(FAKE_CLASS);
    windowEvent('restore');
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
  }
  // the player can be re-parented on SPA navigation (theater ↔ default): re-mark its ancestors
  window.addEventListener('yt-navigate-finish', () => { if (isFakeFs()) { markAncestors(); setTimeout(() => window.dispatchEvent(new Event('resize')), 300); } });
  // Esc on the computer leaves web fullscreen, like it does for real fullscreen
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isFakeFs()) exitFakeFs(); }, true);
  function safe(fn, fallback) { try { const r = fn(); return r === undefined || Number.isNaN(r) ? fallback : r; } catch { return fallback; } }

  function control(action, value) {
    const p = player(), v = video(), api = hasApi(p);
    const notice = (text) => document.dispatchEvent(new CustomEvent('couchtube:notice', { detail: text }));
    switch (action) {
      case 'play':   api ? p.playVideo() : v?.play().catch(() => click('.ytp-play-button')); break;
      case 'pause':  api ? p.pauseVideo() : v?.pause(); break;
      case 'toggle': {
        const paused = api ? p.getPlayerState() !== 1 : v?.paused;
        control(paused ? 'play' : 'pause');
        break;
      }
      case 'seek': {
        const delta = Number(value) || 0;
        const cur = api ? p.getCurrentTime() : v?.currentTime || 0;
        const dur = api ? p.getDuration() : v?.duration || Infinity;
        const t = Math.max(0, Math.min(dur - 0.5, cur + delta));
        api ? p.seekTo(t, true) : (v && (v.currentTime = t));
        break;
      }
      case 'seekTo': {
        const t = Math.max(0, Number(value) || 0);
        api ? p.seekTo(t, true) : (v && (v.currentTime = t));
        break;
      }
      case 'volume': {
        const vol = Math.max(0, Math.min(1, Number(value)));
        if (api) { p.setVolume(Math.round(vol * 100)); if (vol > 0 && p.isMuted()) p.unMute(); }
        else if (v) { v.volume = vol; v.muted = false; }
        break;
      }
      case 'mute':
        if (api) (p.isMuted() ? p.unMute() : p.mute());
        else if (v) v.muted = !v.muted;
        break;
      case 'rate': {
        const r = Number(value) || 1;
        api ? p.setPlaybackRate(r) : (v && (v.playbackRate = r));
        break;
      }
      case 'next':
        if (api && typeof p.nextVideo === 'function') p.nextVideo();
        else click('.ytp-next-button');
        break;
      case 'prev':
        if (api && typeof p.previousVideo === 'function' && p.getCurrentTime() < 5) p.previousVideo();
        else if (api) p.seekTo(0, true);
        else click('.ytp-prev-button') || (v && (v.currentTime = 0));
        break;
      case 'captions': click('.ytp-subtitles-button'); break;
      case 'theater': click('.ytp-size-button'); break;
      case 'fullscreen': {
        if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); break; }
        if (isFakeFs()) { exitFakeFs(); break; }
        // Real fullscreen only works within a few seconds of a click on the page. Try it,
        // and fall back to web fullscreen (no gesture needed) when the browser refuses.
        const target = p || document.documentElement;
        const attempt = target.requestFullscreen ? target.requestFullscreen() : Promise.reject();
        Promise.resolve(attempt).catch(() => enterFakeFs());
        break;
      }
      case 'fullscreenOn': { // re-apply web fullscreen after a page load (next video picked from the phone)
        let tries = 0;
        const t = setInterval(() => {
          if (document.fullscreenElement || isFakeFs()) return clearInterval(t);
          if (document.getElementById('movie_player')) { clearInterval(t); enterFakeFs(); }
          else if (++tries > 40) clearInterval(t);
        }, 250);
        break;
      }
      case 'replay': api ? (p.seekTo(0, true), p.playVideo()) : (v && (v.currentTime = 0, v.play().catch(() => {}))); break;
      case 'autoplay': click('.ytp-autonav-toggle-button'); break;
      case 'like': click('like-button-view-model button, #segmented-like-button button, ytd-toggle-button-renderer#like-button button'); break;
      case 'skipAd': click('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern') || notice('No skippable ad right now.'); break;
      case 'goLive':
        if (!click('.ytp-live-badge')) { if (api) p.seekTo(p.getDuration(), true); else if (v) v.currentTime = v.duration; }
        break;
    }
  }

  document.addEventListener('couchtube:cmd', (e) => {
    let msg; try { msg = JSON.parse(e.detail); } catch { return; }
    if (msg.action === 'getState') {
      document.dispatchEvent(new CustomEvent('couchtube:state', { detail: JSON.stringify(getState()) }));
    } else {
      try { control(msg.action, msg.value); } catch (err) { console.warn('[CouchTube] control failed', err); }
      // push a fresh state right after a command so the phone updates instantly
      setTimeout(() => document.dispatchEvent(new CustomEvent('couchtube:state', { detail: JSON.stringify(getState()) })), 80);
    }
  });
})();
