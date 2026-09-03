// CouchTube – background service worker
// -------------------------------------
// Keeps one WebSocket open to the relay server as the "host", forwards commands
// coming from the phone to the YouTube tab, and forwards player state / scraped
// video lists back to the phone.
//
// MV3 service workers get killed when idle. Chrome 116+ keeps a worker alive while
// a WebSocket exchanges messages at least every 30s, so we ping every 20s and use
// an alarm as a safety net to reconnect if the worker was restarted.

importScripts('config.js'); // COUCHTUBE_DEFAULT_RELAY: localhost when loaded unpacked, the public relay when installed from a store
const DEFAULT_RELAY = COUCHTUBE_DEFAULT_RELAY;
const PING_MS = 20_000;

let ws = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let pingTimer = null;

// in-memory mirror of the session (also persisted to storage.session so a worker
// restart can resume the same room and keep the QR on screen valid)
const S = {
  relayUrl: DEFAULT_RELAY,
  enabled: true,
  room: null,
  token: null,
  remoteUrl: null,
  connected: false,
  remotes: 0,
  controlledTabId: null,
  pendingScrape: null,
  lastState: null,
  sleepUntil: null,
  webFullscreen: false,
  error: null,
};

// ---------- persistence ----------
async function loadSettings() {
  const local = await chrome.storage.local.get({ relayUrl: DEFAULT_RELAY, enabled: true });
  S.relayUrl = local.relayUrl || DEFAULT_RELAY;
  S.enabled = local.enabled !== false;
  const sess = await chrome.storage.session.get(['room', 'token', 'remoteUrl', 'controlledTabId', 'sleepUntil']);
  Object.assign(S, sess);
  if (S.sleepUntil && S.sleepUntil < Date.now()) S.sleepUntil = null;
}
function saveSession() {
  chrome.storage.session.set({ room: S.room, token: S.token, remoteUrl: S.remoteUrl, controlledTabId: S.controlledTabId, sleepUntil: S.sleepUntil });
}

// ---------- popup notifications ----------
function status() {
  const { relayUrl, enabled, room, remoteUrl, connected, remotes, error, lastState } = S;
  return { relayUrl, defaultRelay: DEFAULT_RELAY, isDev: COUCHTUBE_IS_DEV, enabled, room, remoteUrl, connected, remotes, error, nowPlaying: lastState?.hasVideo ? lastState.title : null };
}
function notifyPopup() {
  chrome.runtime.sendMessage({ type: 'status', status: status() }).catch(() => {});
}

// ---------- websocket ----------
function relayWsUrl() {
  let u = S.relayUrl.trim();
  if (u.startsWith('http://')) u = 'ws://' + u.slice(7);
  if (u.startsWith('https://')) u = 'wss://' + u.slice(8);
  if (!/^wss?:\/\//.test(u)) u = 'ws://' + u;
  if (!u.endsWith('/ws')) u = u.replace(/\/+$/, '') + '/ws';
  const url = new URL(u);
  url.searchParams.set('role', 'host');
  if (S.room && S.token) { url.searchParams.set('room', S.room); url.searchParams.set('token', S.token); }
  return url.toString();
}

function connect() {
  if (!S.enabled) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  let url;
  try { url = relayWsUrl(); } catch (e) { S.error = 'Invalid relay URL'; notifyPopup(); return; }
  S.error = null;
  let sock;
  try { sock = ws = new WebSocket(url); } catch (e) { S.error = String(e.message || e); scheduleReconnect(); return; }

  ws.onopen = () => {
    if (sock !== ws) return; // a newer socket replaced this one
    reconnectAttempt = 0;
    S.connected = true;
    S.error = null;
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); }, PING_MS);
    notifyPopup();
  };
  ws.onmessage = (e) => {
    if (sock !== ws) return;
    let m; try { m = JSON.parse(e.data); } catch { return; }
    handleRelayMessage(m);
  };
  ws.onerror = () => { if (sock === ws) S.error = 'Cannot reach relay at ' + S.relayUrl; };
  ws.onclose = (e) => {
    if (sock !== ws) return; // closed on purpose by disconnect(); a new socket may already be live
    S.connected = false;
    clearInterval(pingTimer);
    ws = null;
    if (e.code === 4002) { S.room = S.token = S.remoteUrl = null; saveSession(); } // room closed server-side
    notifyPopup();
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (!S.enabled) return;
  clearTimeout(reconnectTimer);
  const delay = Math.min(1000 * 2 ** reconnectAttempt++, 15_000);
  reconnectTimer = setTimeout(connect, delay);
}

// closeRoom=true tells the relay to destroy the room, so the old QR stops working immediately
function disconnect({ closeRoom = false } = {}) {
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  if (ws) { try { ws.close(closeRoom ? 4003 : 1000, closeRoom ? 'close room' : 'bye'); } catch {} ws = null; }
  S.connected = false;
  S.remotes = 0;
}

function sendToRemote(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------- relay -> extension ----------
async function handleRelayMessage(m) {
  switch (m.type) {
    case 'room':
      S.room = m.room; S.token = m.token; S.remoteUrl = m.remoteUrl; S.remotes = m.remotes || 0;
      saveSession(); notifyPopup();
      break;
    case 'peer':
      if (m.role === 'remote') { S.remotes = m.count; notifyPopup(); }
      break;
    case 'cmd':
      await handleCommand(m.action, m.value);
      break;
  }
}

// ---------- YouTube tab management ----------
async function tabExists(id) {
  if (id == null) return null;
  try { const t = await chrome.tabs.get(id); return t && /^https?:\/\/www\.youtube\.com\//.test(t.url || '') ? t : null; } catch { return null; }
}

async function getTargetTab({ create = false } = {}) {
  let tab = await tabExists(S.controlledTabId);
  if (tab) return tab;
  const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/*' });
  tab = tabs.find((t) => t.audible) || tabs.find((t) => t.active) || tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  if (!tab && create) tab = await chrome.tabs.create({ url: 'https://www.youtube.com/', active: true });
  if (tab) { S.controlledTabId = tab.id; saveSession(); }
  return tab || null;
}

async function navigate(url, kind) {
  const tab = await getTargetTab({ create: true });
  S.pendingScrape = kind || null;
  await chrome.tabs.update(tab.id, { url, active: true });
}

async function handleCommand(action, value) {
  switch (action) {
    case 'sync': {
      pushState();
      const tab = await getTargetTab();
      if (tab) chrome.tabs.sendMessage(tab.id, { type: 'getState' }).catch(() => {});
      else sendToRemote({ type: 'state', hasVideo: false, pageTitle: 'No YouTube tab open' });
      return;
    }
    case 'search':
      return navigate(`https://www.youtube.com/results?search_query=${encodeURIComponent(String(value || ''))}`, 'search');
    case 'home':
      return navigate('https://www.youtube.com/', 'home');
    case 'subscriptions':
      return navigate('https://www.youtube.com/feed/subscriptions', 'subscriptions');
    case 'live':
      // YouTube's "Live" destination (the "Live" entry in YouTube's sidebar)
      return navigate('https://www.youtube.com/channel/UC4R8DWoMoI7CAwX8_LjQHig', 'live');
    case 'sleep':
      return setSleepTimer(Number(value) || 0);
    case 'related': {
      const tab = await getTargetTab();
      if (!tab) return sendToRemote({ type: 'results', kind: 'related', items: [] });
      return scrapeTab(tab.id, 'related');
    }
    case 'open': {
      if (typeof value !== 'string' || !/^https:\/\/www\.youtube\.com\//.test(value)) return;
      const tab = await getTargetTab({ create: true });
      S.pendingScrape = null;
      await chrome.tabs.update(tab.id, { url: value, active: true });
      return;
    }
    default: {
      const tab = await getTargetTab();
      if (!tab) return sendToRemote({ type: 'notice', text: 'Open a YouTube tab on your computer first.' });
      chrome.tabs.sendMessage(tab.id, { type: 'control', action, value }).catch(() => {});
    }
  }
}

// ---------- sleep timer (runs here, so it works even if the phone screen turns off) ----------
async function setSleepTimer(minutes) {
  await chrome.alarms.clear('couchtube-sleep');
  if (minutes > 0) {
    S.sleepUntil = Date.now() + minutes * 60_000;
    chrome.alarms.create('couchtube-sleep', { when: S.sleepUntil });
    sendToRemote({ type: 'notice', text: `Sleep timer: pausing in ${minutes} min` });
  } else {
    S.sleepUntil = null;
    sendToRemote({ type: 'notice', text: 'Sleep timer off' });
  }
  saveSession();
  pushState();
}
async function fireSleepTimer() {
  S.sleepUntil = null; saveSession();
  const tab = await getTargetTab();
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'control', action: 'pause' }).catch(() => {});
  sendToRemote({ type: 'notice', text: 'Sleep timer: paused' });
  pushState();
}
function pushState() {
  if (S.lastState) sendToRemote({ type: 'state', ...S.lastState, sleepUntil: S.sleepUntil });
}

// ---------- browser window fullscreen (for "web fullscreen" mode) ----------
const prevWindowState = new Map(); // windowId -> state before we changed it
async function setWindowFullscreen(tabId, on) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    if (on) {
      if (win.state !== 'fullscreen') { prevWindowState.set(win.id, win.state); await chrome.windows.update(win.id, { state: 'fullscreen' }); }
    } else if (prevWindowState.has(win.id)) {
      const prev = prevWindowState.get(win.id); prevWindowState.delete(win.id);
      await chrome.windows.update(win.id, { state: prev === 'minimized' ? 'normal' : prev });
    }
  } catch (e) { console.warn('[CouchTube] window state', e); }
}

// debounce "Up next" refreshes (ready + state change can both fire for one navigation)
let relatedTimer = null;
function scheduleRelated(tabId) {
  clearTimeout(relatedTimer);
  relatedTimer = setTimeout(() => scrapeTab(tabId, 'related'), 800);
}

async function scrapeTab(tabId, kind) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'scrape', kind });
    if (kind === 'endscreen' && !(res?.items || []).length) return; // no end screen on this video: phone keeps "Up next"
    sendToRemote({ type: 'results', kind, items: res?.items || [] });
  } catch {
    sendToRemote({ type: 'results', kind, items: [] });
  }
}

// ---------- content script -> extension ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // messages from the popup
  if (msg?.type?.startsWith('popup:')) { handlePopup(msg).then(sendResponse); return true; }

  const tabId = sender.tab?.id;
  if (tabId == null) return;

  if (msg.type === 'state') {
    // The tab that is actually playing becomes the controlled one; otherwise keep the current one.
    const playing = msg.state.hasVideo && !msg.state.paused;
    if (S.controlledTabId == null || playing || (msg.state.hasVideo && !S.lastState?.hasVideo)) {
      if (S.controlledTabId !== tabId) { S.controlledTabId = tabId; saveSession(); }
    }
    if (tabId === S.controlledTabId) {
      const prev = S.lastState;
      S.lastState = msg.state;
      sendToRemote({ type: 'state', ...msg.state, sleepUntil: S.sleepUntil });
      // video just ended: send YouTube's end-screen suggestions (the wall + the autoplay pick)
      if (msg.state.ended && !(prev && prev.ended && prev.videoId === msg.state.videoId)) scrapeTab(tabId, 'endscreen');
      // a different video started playing in this tab (autoplay, click on the computer…): refresh "Up next"
      if (msg.state.hasVideo && msg.state.videoId && prev?.videoId !== msg.state.videoId) scheduleRelated(tabId);
    }
  } else if (msg.type === 'window') {
    S.webFullscreen = msg.state === 'fullscreen';
    setWindowFullscreen(tabId, S.webFullscreen);
  } else if (msg.type === 'ready') {
    if (tabId === S.controlledTabId && S.pendingScrape) {
      const kind = S.pendingScrape; S.pendingScrape = null;
      scrapeTab(tabId, kind);
    }
    // a watch page loaded: show its "Up next" list on the phone, like YouTube's sidebar
    if (tabId === S.controlledTabId && /youtube\.com\/(watch|live\/|shorts\/)/.test(msg.url || '')) scheduleRelated(tabId);
    // keep web fullscreen across full page loads (e.g. next video picked from the phone)
    if (tabId === S.controlledTabId && S.webFullscreen && /youtube\.com\/(watch|live\/|shorts\/)/.test(msg.url || '')) {
      chrome.tabs.sendMessage(tabId, { type: 'control', action: 'fullscreenOn' }).catch(() => {});
    }
  } else if (msg.type === 'notice') {
    sendToRemote({ type: 'notice', text: msg.text });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === S.controlledTabId) { S.controlledTabId = null; S.lastState = null; S.webFullscreen = false; saveSession(); sendToRemote({ type: 'state', hasVideo: false, pageTitle: 'YouTube tab closed' }); }
});

// ---------- popup ----------
async function handlePopup(msg) {
  switch (msg.type) {
    case 'popup:getStatus':
      if (S.enabled && !ws) connect();
      return status();
    case 'popup:newRoom':
      disconnect({ closeRoom: true });
      S.room = S.token = S.remoteUrl = null; saveSession();
      S.enabled = true; await chrome.storage.local.set({ enabled: true });
      reconnectAttempt = 0; connect();
      return status();
    case 'popup:setRelay': {
      S.relayUrl = (msg.url || DEFAULT_RELAY).trim() || DEFAULT_RELAY;
      await chrome.storage.local.set({ relayUrl: S.relayUrl });
      disconnect({ closeRoom: true });
      S.room = S.token = S.remoteUrl = null; saveSession();
      reconnectAttempt = 0; connect();
      return status();
    }
    case 'popup:toggle':
      S.enabled = !S.enabled;
      await chrome.storage.local.set({ enabled: S.enabled });
      if (S.enabled) { reconnectAttempt = 0; connect(); } else { disconnect({ closeRoom: true }); S.room = S.token = S.remoteUrl = null; saveSession(); }
      return status();
  }
  return status();
}

// ---------- lifecycle ----------
chrome.alarms.create('couchtube-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'couchtube-keepalive') connect();
  if (a.name === 'couchtube-sleep') fireSleepTimer();
});
chrome.runtime.onStartup.addListener(() => loadSettings().then(connect));
chrome.runtime.onInstalled.addListener(() => loadSettings().then(connect));
loadSettings().then(connect);
