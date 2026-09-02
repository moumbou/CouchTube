// Smoke test for the relay: spins up the server on a random port, connects a fake
// host (extension) and a fake remote (phone), and checks messages flow both ways.
// Run with: npm test

process.env.PORT = '0';
const assert = require('assert');
const { WebSocket } = require('ws');
const { server } = require('../src/index.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (ws, pred) => new Promise((resolve) => {
  const on = (raw) => { const m = JSON.parse(raw.toString()); if (pred(m)) { ws.off('message', on); resolve(m); } };
  ws.on('message', on);
});

(async () => {
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  const port = server.address().port;
  const base = `ws://127.0.0.1:${port}/ws`;

  // 1. host joins and gets a room
  const host = new WebSocket(`${base}?role=host`);
  const roomMsg = await once(host, (m) => m.type === 'room');
  assert.match(roomMsg.room, /^[A-Z2-9]{6}$/, 'room id format');
  assert.ok(roomMsg.token.length > 16, 'token present');
  assert.ok(roomMsg.remoteUrl.endsWith(`/r/#${roomMsg.room}.${roomMsg.token}`), 'remote url');
  console.log('✓ host got room', roomMsg.room);

  // 2. wrong token is rejected
  const bad = new WebSocket(`${base}?role=remote&room=${roomMsg.room}&token=nope`);
  const badClose = await new Promise((r) => bad.on('close', (code) => r(code)));
  assert.strictEqual(badClose, 4001, 'bad token closes with 4001');
  console.log('✓ bad token rejected');

  // 3. remote joins with the right token, host is notified, and gets a sync request
  const remote = new WebSocket(`${base}?role=remote&room=${roomMsg.room}&token=${roomMsg.token}`);
  const peerP = once(host, (m) => m.type === 'peer' && m.role === 'remote');
  const syncP = once(host, (m) => m.type === 'cmd' && m.action === 'sync');
  const joined = await once(remote, (m) => m.type === 'joined');
  assert.strictEqual(joined.hostConnected, true);
  const peer = await peerP;
  assert.strictEqual(peer.count, 1);
  await syncP;
  console.log('✓ remote joined, host notified + asked to sync');

  // 4. remote -> host command
  const cmdP = once(host, (m) => m.type === 'cmd' && m.action === 'seek');
  remote.send(JSON.stringify({ type: 'cmd', action: 'seek', value: 10 }));
  const cmd = await cmdP;
  assert.strictEqual(cmd.value, 10);
  console.log('✓ command relayed remote → host');

  // 5. host -> remote state
  const stateP = once(remote, (m) => m.type === 'state');
  host.send(JSON.stringify({ type: 'state', title: 'Test video', currentTime: 5, duration: 100 }));
  const state = await stateP;
  assert.strictEqual(state.title, 'Test video');
  console.log('✓ state relayed host → remote');

  // 6. host reconnects into the same room (QR stays valid)
  const hostOfflineP = once(remote, (m) => m.type === 'peer' && m.role === 'host' && m.connected === false);
  host.close();
  await hostOfflineP;
  const host2 = new WebSocket(`${base}?role=host&room=${roomMsg.room}&token=${roomMsg.token}`);
  const hostOnlineP = once(remote, (m) => m.type === 'peer' && m.role === 'host' && m.connected === true);
  const room2 = await once(host2, (m) => m.type === 'room');
  assert.strictEqual(room2.room, roomMsg.room, 'same room resumed');
  await hostOnlineP;
  console.log('✓ host resumed same room after reconnect');

  // 7. ping/pong
  remote.send(JSON.stringify({ type: 'ping' }));
  await once(remote, (m) => m.type === 'pong');
  console.log('✓ ping/pong');

  // 8. health endpoint
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const health = await res.json();
  assert.strictEqual(health.ok, true);
  const page = await fetch(`http://127.0.0.1:${port}/r/`);
  assert.strictEqual(page.status, 200);
  assert.ok((await page.text()).includes('CouchTube'));
  console.log('✓ http static + health');

  remote.close(); host2.close();
  await wait(50);
  server.close();
  console.log('\nAll relay tests passed');
  process.exit(0);
})().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
