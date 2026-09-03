// CouchTube relay server
// ----------------------
// A tiny WebSocket relay that pairs a browser extension ("host") with one or more
// phones ("remotes") through a room id + secret token. The server never interprets
// commands: it only forwards JSON messages between the two sides.
//
// It also serves two static apps from the workspace:
//   /      -> apps/website  (landing page, privacy policy)
//   /r/    -> apps/remote   (the phone remote; the QR code points to /r/#ROOM.TOKEN)
//
// Env:
//   PORT         port to listen on (default 8787)
//   PUBLIC_URL   base URL the phone should use (default: http://<LAN IP>:PORT)
//                set this when deployed, e.g. https://couchtube.example.com
//                (Railway's RAILWAY_PUBLIC_DOMAIN and Render's RENDER_EXTERNAL_URL are picked up automatically)
//   WEBSITE_DIR  override the website folder (default ../../website)
//   REMOTE_DIR   override the remote folder  (default ../../remote)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

let PORT = process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : 8787;
const WEBSITE_DIR = path.resolve(process.env.WEBSITE_DIR || path.join(__dirname, '..', '..', 'website'));
const REMOTE_DIR = path.resolve(process.env.REMOTE_DIR || path.join(__dirname, '..', '..', 'remote'));
const ROOM_GRACE_MS = 10 * 60 * 1000; // keep a room alive 10 min after its host drops
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 5000;
// abuse limits, per client IP (the real IP behind Railway / Cloudflare / any proxy)
const MAX_CONNS_PER_IP = Number(process.env.MAX_CONNS_PER_IP) || 40;        // simultaneous sockets
const MAX_ROOMS_PER_IP_WINDOW = Number(process.env.MAX_ROOMS_PER_IP) || 60;  // rooms created per window
const ROOM_WINDOW_MS = 10 * 60 * 1000;

// ---------- helpers ----------

function lanIp() {
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      // Prefer classic home-network ranges, skip virtual adapters when possible
      const score =
        (i.address.startsWith('192.168.') ? 3 : i.address.startsWith('10.') ? 2 : 1) -
        (/vmware|virtualbox|vethernet|docker|wsl|hyper-v/i.test(name) ? 10 : 0);
      candidates.push({ address: i.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ? candidates[0].address : '127.0.0.1';
}

function publicBaseUrl() {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  // zero-config on common hosts: they expose their own public domain as an env var
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL.replace(/\/+$/, '');
  return `http://${lanIp()}:${PORT}`;
}

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
function randomRoomId() {
  const bytes = crypto.randomBytes(6);
  let id = '';
  for (const b of bytes) id += ROOM_ALPHABET[b % ROOM_ALPHABET.length];
  return id;
}
function randomToken() {
  return crypto.randomBytes(18).toString('base64url');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------- per-IP limits ----------

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
const connsByIp = new Map();   // ip -> open socket count
const roomsByIp = new Map();   // ip -> { count, windowStart }
function tooManyConnections(ip) { return (connsByIp.get(ip) || 0) >= MAX_CONNS_PER_IP; }
function trackConnection(ip, delta) {
  const n = (connsByIp.get(ip) || 0) + delta;
  if (n <= 0) connsByIp.delete(ip); else connsByIp.set(ip, n);
}
function roomCreationAllowed(ip) {
  const now = Date.now();
  let e = roomsByIp.get(ip);
  if (!e || now - e.windowStart > ROOM_WINDOW_MS) { e = { count: 0, windowStart: now }; roomsByIp.set(ip, e); }
  if (e.count >= MAX_ROOMS_PER_IP_WINDOW) return false;
  e.count++;
  return true;
}
setInterval(() => { const now = Date.now(); for (const [ip, e] of roomsByIp) if (now - e.windowStart > ROOM_WINDOW_MS) roomsByIp.delete(ip); }, 60 * 1000).unref();

// ---------- rooms ----------

/** @type {Map<string, {token:string, hosts:Set<any>, remotes:Set<any>, createdAt:number, hostLeftAt:number|null}>} */
const rooms = new Map();

function createRoom() {
  if (rooms.size >= MAX_ROOMS) {
    // drop the oldest host-less room to make space
    let oldest = null;
    for (const [id, r] of rooms) if (r.hosts.size === 0 && (!oldest || r.createdAt < rooms.get(oldest).createdAt)) oldest = id;
    if (oldest) destroyRoom(oldest);
  }
  let id;
  do id = randomRoomId(); while (rooms.has(id));
  const room = { id, token: randomToken(), hosts: new Set(), remotes: new Set(), createdAt: Date.now(), hostLeftAt: null };
  rooms.set(id, room);
  return room;
}

function destroyRoom(id) {
  const room = rooms.get(id);
  if (!room) return;
  for (const ws of room.remotes) { send(ws, { type: 'error', code: 'room_closed' }); ws.close(4002, 'room closed'); }
  for (const ws of room.hosts) ws.close(4002, 'room closed');
  rooms.delete(id);
}

function broadcast(set, obj, except) {
  const data = JSON.stringify(obj);
  for (const ws of set) if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(data);
}

// periodic sweep of abandoned rooms
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.hosts.size === 0 && room.hostLeftAt && now - room.hostLeftAt > ROOM_GRACE_MS) destroyRoom(id);
  }
}, 60 * 1000).unref();

// ---------- http (static + health) ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // /r/... is the phone remote, everything else is the website
  let root = WEBSITE_DIR;
  if (urlPath === '/r' || urlPath.startsWith('/r/')) { root = REMOTE_DIR; urlPath = urlPath.slice(2) || '/'; }
  if (urlPath === '' || urlPath === '/') urlPath = '/index.html';
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const filePath = path.normalize(path.join(root, urlPath));
  if (!filePath.startsWith(root)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, publicUrl: publicBaseUrl() }));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res);
});

// ---------- websocket relay ----------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const role = q.get('role');
  const ip = clientIp(req);
  if (tooManyConnections(ip)) { send(ws, { type: 'error', code: 'too_many_connections' }); return ws.close(4029, 'too many connections'); }
  trackConnection(ip, 1);
  ws.on('close', () => trackConnection(ip, -1));
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let room = null;

  if (role === 'host') {
    // A host may try to resume its previous room so the QR on screen stays valid
    const wanted = rooms.get((q.get('room') || '').toUpperCase());
    if (wanted && safeEqual(wanted.token, q.get('token') || '')) room = wanted;
    else {
      if (!roomCreationAllowed(ip)) { send(ws, { type: 'error', code: 'rate_limited' }); return ws.close(4029, 'rate limited'); }
      room = createRoom();
    }
    room.hosts.add(ws);
    room.hostLeftAt = null;
    ws.role = 'host';
    send(ws, {
      type: 'room',
      room: room.id,
      token: room.token,
      remoteUrl: `${publicBaseUrl()}/r/#${room.id}.${room.token}`,
      remotes: room.remotes.size,
    });
    broadcast(room.remotes, { type: 'peer', role: 'host', connected: true });
    console.log(`[host] joined room ${room.id} (${room.hosts.size} host, ${room.remotes.size} remote)`);
  } else if (role === 'remote') {
    const candidate = rooms.get((q.get('room') || '').toUpperCase());
    if (!candidate || !safeEqual(candidate.token, q.get('token') || '')) {
      send(ws, { type: 'error', code: 'bad_room' });
      return ws.close(4001, 'bad room');
    }
    room = candidate;
    room.remotes.add(ws);
    ws.role = 'remote';
    send(ws, { type: 'joined', room: room.id, hostConnected: room.hosts.size > 0 });
    broadcast(room.hosts, { type: 'peer', role: 'remote', count: room.remotes.size });
    // ask the host for a fresh state snapshot for the newcomer
    broadcast(room.hosts, { type: 'cmd', action: 'sync' });
    console.log(`[remote] joined room ${room.id} (${room.remotes.size} remote)`);
  } else {
    send(ws, { type: 'error', code: 'bad_role' });
    return ws.close(4000, 'bad role');
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') return send(ws, { type: 'pong' });
    // pure relay: remotes talk to hosts, hosts talk to remotes
    if (ws.role === 'remote') broadcast(room.hosts, msg);
    else broadcast(room.remotes, msg);
  });

  ws.on('close', (code) => {
    if (!room) return;
    if (ws.role === 'host') {
      room.hosts.delete(ws);
      if (code === 4003) { // host asked for a new code: kill the room so the old QR is dead
        if (room.hosts.size === 0) destroyRoom(room.id);
        return;
      }
      if (room.hosts.size === 0) {
        room.hostLeftAt = Date.now();
        broadcast(room.remotes, { type: 'peer', role: 'host', connected: false });
      }
    } else {
      room.remotes.delete(ws);
      broadcast(room.hosts, { type: 'peer', role: 'remote', count: room.remotes.size });
    }
  });
});

// heartbeat: drop dead sockets (phones that lost Wi-Fi, etc.)
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  }
}, 25 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => {
  PORT = server.address().port; // resolves PORT=0 (random port, used by tests)
  console.log('CouchTube relay running');
  console.log(`  local:   http://localhost:${PORT}`);
  console.log(`  network: ${publicBaseUrl()}   <- phones use this (same Wi-Fi)`);
  console.log(`  ws:      ws://localhost:${PORT}/ws   <- set this as relay URL in the extension`);
  console.log(`  serving: website ${path.relative(process.cwd(), WEBSITE_DIR) || '.'}  remote ${path.relative(process.cwd(), REMOTE_DIR) || '.'}`);
});

module.exports = { server, rooms };
