// CouchTube – content script (isolated world, runs on www.youtube.com)
// --------------------------------------------------------------------
// Responsibilities:
//   • report player state to the background worker (which relays it to the phone)
//   • execute control commands by handing them to bridge.js (page world)
//   • scrape video lists (search results, home feed, subscriptions, "up next")
//     so the phone can browse and pick what to play

(() => {
  if (window.__couchtubeContent) return;
  window.__couchtubeContent = true;

  const post = (msg) => { try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch {} };
  const toBridge = (action, value) => document.dispatchEvent(new CustomEvent('couchtube:cmd', { detail: JSON.stringify({ action, value }) }));

  // ---- state reporting ----
  let lastSent = '';
  document.addEventListener('couchtube:state', (e) => {
    let state; try { state = JSON.parse(e.detail); } catch { return; }
    const key = JSON.stringify({ ...state, currentTime: Math.floor(state.currentTime || 0), duration: Math.floor(state.duration || 0) });
    if (key === lastSent) return; // don't spam identical states
    lastSent = key;
    post({ type: 'state', state });
  });
  document.addEventListener('couchtube:notice', (e) => post({ type: 'notice', text: e.detail }));
  // bridge asks to put the browser window in / out of fullscreen (web fullscreen mode)
  document.addEventListener('couchtube:window', (e) => post({ type: 'window', state: e.detail }));

  // ---- web fullscreen styles (activated by bridge.js with a class on <html>) ----
  const style = document.createElement('style');
  style.id = 'couchtube-style';
  style.textContent = `
    html.couchtube-fake-fs, html.couchtube-fake-fs body { overflow: hidden !important; }
    html.couchtube-fake-fs #movie_player {
      position: fixed !important; top: 0 !important; left: 0 !important;
      width: 100vw !important; height: 100vh !important; z-index: 2147483000 !important;
      background: #000 !important; border-radius: 0 !important;
    }
    html.couchtube-fake-fs #movie_player video.html5-main-video {
      width: 100% !important; height: 100% !important; left: 0 !important; top: 0 !important; object-fit: contain;
    }
    html.couchtube-fake-fs #movie_player .ytp-chrome-bottom { width: calc(100% - 24px) !important; left: 12px !important; }
    html.couchtube-fake-fs #movie_player .html5-video-container { width: 100% !important; height: 100% !important; }
    /* YouTube gives #player-container a view-transition-name, which creates a stacking context
       that keeps the player UNDER the masthead and sidebar no matter its z-index. Neutralize it
       (and the other stacking-context makers) on every ancestor, and hide the header outright. */
    html.couchtube-fake-fs [data-couchtube-ancestor] { view-transition-name: none !important; isolation: auto !important; contain: none !important; container-type: normal !important; transform: none !important; filter: none !important; }
    html.couchtube-fake-fs #masthead-container, html.couchtube-fake-fs ytd-masthead { display: none !important; }
  `;
  (document.head || document.documentElement).appendChild(style);

  setInterval(() => toBridge('getState'), 1000);
  toBridge('getState');

  // ---- navigation: tell the background a page is ready (used for pending scrapes) ----
  const announceReady = () => { lastSent = ''; post({ type: 'ready', url: location.href }); toBridge('getState'); };
  window.addEventListener('yt-navigate-finish', announceReady);
  announceReady();

  // ---- commands from background ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'control') { toBridge(msg.action, msg.value); sendResponse({ ok: true }); return; }
    if (msg?.type === 'scrape') { scrapeWithRetry(msg.kind).then((items) => sendResponse({ items })); return true; }
    if (msg?.type === 'getState') { toBridge('getState'); sendResponse({ ok: true }); return; }
  });

  // ---- scraping ----
  const CONTAINERS = 'ytd-playlist-panel-video-renderer, ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, yt-lockup-view-model, ytd-playlist-video-renderer, ytd-reel-item-renderer';
  const LIVE_BADGE = '[class*="BadgeShapeLive"], [class*="ThumbnailLive"], [class*="thumbnail-live"], [overlay-style="LIVE"], [class*="live-now"]';

  function videoIdFrom(href) {
    try {
      const u = new URL(href, location.origin);
      if (u.pathname === '/watch') return u.searchParams.get('v');
      const m = u.pathname.match(/^\/shorts\/([\w-]{6,})/);
      return m ? m[1] : null;
    } catch { return null; }
  }

  const txt = (el) => (el?.textContent || '').replace(/\s+/g, ' ').replace(/^[•·\s]+/, '').trim();
  const item = (id, extra) => ({ url: `https://www.youtube.com/watch?v=${id}`, thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, ...extra });

  // YouTube ships two generations of markup side by side: Polymer components (ytd-video-renderer,
  // #video-title, ytd-channel-name…) and the newer "view models" whose classes are camelCase
  // (ytLockupMetadataViewModelTitle, ytContentMetadataViewModelMetadataRow, ytBadgeShapeText…).
  // The selectors below use substring matches so both generations, and small renames, keep working.
  function scrapeOnce(kind) {
    if (kind === 'endscreen') return scrapeEndscreen();
    let root = document;
    if (kind === 'related') root = document.querySelector('#secondary, #related') || document;
    else root = document.querySelector('#primary, ytd-page-manager') || document;

    const items = [], seen = new Set();
    for (const el of root.querySelectorAll(CONTAINERS)) {
      if (el.querySelector(CONTAINERS)) continue; // outer wrapper (e.g. rich-item around a lockup): use the inner one
      const a = el.querySelector('a#video-title, a#video-title-link, h3 a[href], a[href*="/watch?v="], a[href*="/shorts/"]');
      if (!a) continue;
      const id = videoIdFrom(a.getAttribute('href') || '');
      if (!id || seen.has(id)) continue;
      const h3 = el.querySelector('h3');
      const title = txt(el.querySelector('#video-title')) || h3?.getAttribute('title') || txt(h3) || txt(el.querySelector('[class*="ViewModelTitle"], [class*="__title"]')) || a.getAttribute('title') || a.getAttribute('aria-label') || txt(a);
      if (!title) continue;
      const channel = txt(el.querySelector('ytd-channel-name #text, ytd-channel-name a, #channel-name #text')) || txt(el.querySelector('[class*="MetadataRow"], [class*="metadata-row"]'));
      const rows = [...el.querySelectorAll('[class*="MetadataRow"], [class*="metadata-row"], #metadata-line')].map(txt).filter((t) => t && t !== channel);
      const allMeta = rows.join(' ');
      const badge = txt(el.querySelector('[class*="BadgeShapeText"], [class*="badge-shape__text"], [class*="badge-shape-wiz__text"], ytd-thumbnail-overlay-time-status-renderer, [class*="thumbnail-overlay-time"]'));
      const live = /^LIVE\b/i.test(badge) || !!el.querySelector(LIVE_BADGE) || /\bwatching\b/i.test(allMeta);
      const viewers = (allMeta.match(/([\d.,]+\s?[KkMm]?)\s+watching/) || [])[1] || '';
      seen.add(id);
      items.push(item(id, { title, channel, meta: rows[0] || '', duration: live ? '' : (badge.match(/\d+:\d\d(?::\d\d)?/) || [''])[0], live, viewers }));
      if (items.length >= 30) break;
    }
    return items;
  }

  // The wall of suggestions YouTube shows when a video ends (+ the autoplay "Up next" pick first)
  function scrapeEndscreen() {
    const items = [], seen = new Set();
    const next = document.querySelector('.ytp-autonav-endscreen-upnext-container');
    const nextLink = next?.querySelector('a[href*="/watch"]');
    const nextId = nextLink && videoIdFrom(nextLink.getAttribute('href'));
    if (nextId) {
      seen.add(nextId);
      items.push(item(nextId, {
        title: txt(next.querySelector('.ytp-autonav-endscreen-upnext-title')) || 'Up next',
        channel: txt(next.querySelector('.ytp-autonav-endscreen-upnext-author')),
        duration: txt(next.querySelector('.ytp-autonav-timestamp')),
        live: next.getAttribute('data-is-live') === 'true', viewers: '', autoplayNext: true,
      }));
    }
    for (const a of document.querySelectorAll('.ytp-videowall-still[href]')) {
      const id = videoIdFrom(a.getAttribute('href'));
      if (!id || seen.has(id)) continue;
      const author = txt(a.querySelector('.ytp-videowall-still-info-author'));
      const live = a.getAttribute('data-is-live') === 'true';
      seen.add(id);
      items.push(item(id, {
        title: txt(a.querySelector('.ytp-videowall-still-info-title')) || a.getAttribute('aria-label') || '',
        channel: author.split('•')[0].trim(), meta: (author.split('•')[1] || '').trim(),
        duration: live ? '' : txt(a.querySelector('.ytp-videowall-still-info-duration')), live, viewers: '',
      }));
    }
    return items;
  }

  // YouTube renders lists progressively; wait until the count stops growing.
  async function scrapeWithRetry(kind) {
    let best = [], stable = 0;
    for (let i = 0; i < 20; i++) {
      const items = scrapeOnce(kind);
      if (items.length > best.length) { best = items; stable = 0; } else if (items.length > 0) stable++;
      if (best.length > 0 && stable >= 3) break; // list stopped growing
      await new Promise((r) => setTimeout(r, 350));
    }
    return best;
  }
})();
