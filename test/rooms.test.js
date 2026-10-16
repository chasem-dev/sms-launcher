'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const rooms = require('../src/rooms');
const multiplayer = require('../src/multiplayer');

// The room server (sms-server-api's src/rooms.js) as far as these tests need
// it: one room, its host and joiners over stand-in WebSockets.
function roomServer({ code = 'KQ7M2D', secret = 'ab'.repeat(16) } = {}) {
  const server = { host: null, hostInfo: null, joiners: new Map(), nextId: 1, connections: [] };
  class Socket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = { open: [], message: [], close: [], error: [] };
      server.connections.push(this);
      setImmediate(() => {
        this.readyState = 1;
        if (url.includes('/v1/rooms/new')) server.host = this;
        else {
          this.id = server.nextId++;
          server.joiners.set(this.id, this);
        }
        this.emit('open', {});
      });
    }
    addEventListener(type, fn, options) { this.listeners[type].push({ fn, once: options?.once }); }
    removeEventListener(type, fn) { this.listeners[type] = this.listeners[type].filter(entry => entry.fn !== fn); }
    emit(type, event) {
      for (const entry of [...this.listeners[type]]) {
        if (entry.once) this.removeEventListener(type, entry.fn);
        entry.fn(event);
      }
    }
    // from the server to this end
    deliver(data) {
      const copy = typeof data === 'string' ? data : new Uint8Array(data).slice().buffer;
      setImmediate(() => { if (this.readyState === 1) this.emit('message', { data: copy }); });
    }
    send(data) { setImmediate(() => server.receive(this, data)); }
    close(code = 1000) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      setImmediate(() => { this.emit('close', { code }); server.closed(this); });
    }
  }
  server.WebSocket = Socket;
  server.receive = (ws, data) => {
    if (ws.readyState !== 1 || data === 'ping') return;
    if (typeof data !== 'string') {
      const bytes = Buffer.from(data);
      if (ws === server.host) {
        const joiner = server.joiners.get(bytes.readUInt32LE(0));
        if (joiner?.relay) joiner.deliver(bytes.subarray(4));
      } else if (ws.relay) {
        const frame = Buffer.alloc(4 + bytes.length);
        frame.writeUInt32LE(ws.id, 0);
        bytes.copy(frame, 4);
        server.host.deliver(frame);
      }
      return;
    }
    const msg = JSON.parse(data);
    if (ws === server.host && msg.type === 'hello') {
      server.hostInfo = msg;
      ws.deliver(JSON.stringify({ type: 'room', code, key: 'cd'.repeat(16) }));
    } else if (msg.type === 'hello') {
      server.host.deliver(JSON.stringify({ type: 'join', id: ws.id, secret, candidates: msg.candidates, name: msg.name,
        ...(msg.check === true ? { check: true } : {}) }));
      ws.deliver(JSON.stringify({ type: 'host', id: ws.id, secret, candidates: server.hostInfo.candidates, name: server.hostInfo.name }));
    } else if (ws === server.host && msg.type === 'status') {
      server.statuses = [...(server.statuses || []), msg];
    } else if (msg.type === 'relay') {
      ws.relay = true;
      server.relayed = msg.reason;
      server.host.deliver(JSON.stringify({ type: 'relay', id: ws.id, reason: msg.reason }));
      ws.deliver(JSON.stringify({ type: 'relay' }));
    }
  };
  server.closed = ws => {
    if (ws === server.host) for (const joiner of server.joiners.values()) joiner.close(4404);
    else if (server.host) server.host.deliver(JSON.stringify({ type: 'leave', id: ws.id }));
  };
  return server;
}

// A hosting game on `port`, on this computer: answers probes as the game does.
async function fakeGame(port, { name = 'Chase', build = 'c8fb4a3e81a2' } = {}) {
  const socket = dgram.createSocket('udp4');
  const seen = [];
  socket.on('message', (message, from) => {
    if (message.length < 200 || message.readUInt32LE(0) !== 0x504d4d53 || message.readUInt8(6) !== 1) return;
    seen.push(from);
    const str = text => Buffer.concat([Buffer.from([text.length]), Buffer.from(text, 'latin1')]);
    const head = Buffer.alloc(11);
    head.writeUInt32LE(0x504d4d53, 0);
    head.writeUInt16LE(multiplayer.PROTOCOL, 4);
    head.writeUInt8(2, 6);
    head.writeUInt32LE(message.readUInt32LE(7), 7);
    const tail = Buffer.alloc(2);
    tail.writeUInt16LE(multiplayer.PROTOCOL, 0);
    socket.send(Buffer.concat([head, Buffer.from([1, 4, 1]), str(build), str(name), str('Delfino Plaza'), tail]), from.port, from.address);
  });
  await new Promise(resolve => socket.bind(port, '127.0.0.1', resolve));
  return { seen, close: () => socket.close() };
}

async function freePort() {
  const socket = dgram.createSocket('udp4');
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  socket.close();
  return port;
}

const quiet = { servers: [], log: () => {} };

test('room codes read forgivingly and are told apart from invite codes and addresses', () => {
  assert.equal(rooms.parseRoomCode('kq7-m2d'), 'KQ7M2D');
  assert.equal(rooms.parseRoomCode(' KQ7 M2D '), 'KQ7M2D');
  assert.equal(rooms.parseRoomCode('KO7ML2'), 'K07M12');
  for (const other of ['SC07-21TX-R94X', '203.0.113.7', 'example.com', 'KQ7-M2U', 'KQ7M2', 'host:24002', ''])
    assert.equal(rooms.parseRoomCode(other), null, other);
  assert.equal(rooms.formatRoomCode('KQ7M2D'), 'KQ7-M2D');
});

test('punching packets carry their type and the join\'s secret, and nothing else passes for one', () => {
  const secret = '0123456789abcdef0123456789abcdef';
  const packet = rooms.punchPacket(rooms.HELLO, secret);
  assert.equal(packet.length, 21);
  assert.equal(packet.subarray(0, 4).toString(), 'SMLP');
  assert.deepEqual(rooms.readPunch(packet), { type: rooms.HELLO, secret });
  assert.equal(rooms.readPunch(Buffer.concat([packet, Buffer.from([0])])), null);
  assert.equal(rooms.readPunch(Buffer.from('SMMP'.padEnd(21, '\0'))), null);
});

test('looking up a room says when there is none, or the server can\'t be reached', async () => {
  const answer = (status, body) => async () => ({ status, ok: status === 200, json: async () => body });
  assert.deepEqual(await rooms.lookup('KQ7M2D', { url: 'https://x', fetchImpl: answer(200, { name: 'Chase', build: 'b', protocol: 2 }) }),
    { name: 'Chase', build: 'b', protocol: 2 });
  await assert.rejects(rooms.lookup('KQ7M2D', { url: 'https://x', fetchImpl: answer(404) }), /No game is open with room code KQ7-M2D/);
  await assert.rejects(rooms.lookup('KQ7M2D', { url: 'https://x', fetchImpl: async () => { throw new Error('offline'); } }),
    /Couldn't reach the room server/);
});

test('a joiner reaches the host\'s game directly through the punched path', async () => {
  const server = roomServer();
  const port = await freePort();
  const rooms_ = [];
  const host = await rooms.host({ ...quiet, port, name: 'Chase', build: 'c8fb4a3e81a2', version: '2026.10.15.1', launcher: '0.1.61',
    url: 'http://rooms.test', WebSocketImpl: server.WebSocket, lan: ['127.0.0.1'], onRoom: code => rooms_.push(code) });
  const game = await fakeGame(host.gamePort);
  try {
    assert.equal(host.code, 'KQ7M2D');
    assert.deepEqual(rooms_, ['KQ7M2D']);
    assert.deepEqual(server.hostInfo.candidates, [{ address: '127.0.0.1', port }]);
    assert.equal(server.hostInfo.build, 'c8fb4a3e81a2');
    assert.equal(server.hostInfo.version, '2026.10.15.1');
    assert.equal(server.hostInfo.launcher, '0.1.61');
    const link = await rooms.join({ ...quiet, code: 'KQ7M2D', name: 'Luigi', url: 'http://rooms.test',
      WebSocketImpl: server.WebSocket, lan: ['127.0.0.1'] });
    try {
      assert.equal(link.mode, 'direct');
      const info = await multiplayer.probe('127.0.0.1', link.localPort, { timeout: 2000 });
      assert.equal(info.name, 'Chase');
      assert.equal(info.status, 'Delfino Plaza');
      // the game sees the player at its own address on this computer, not the launcher's port
      assert.equal(game.seen.at(-1).address, '127.0.0.1');
      assert.notEqual(game.seen.at(-1).port, port);
    } finally { link.close(); }
  } finally {
    game.close();
    host.close();
  }
});

test('a ping check reaches the host\'s game like a join, without the host hearing of a player, and lets go', async () => {
  const server = roomServer();
  const hostLog = [];
  const host = await rooms.host({ ...quiet, log: line => hostLog.push(line), port: await freePort(), name: 'Chase', build: 'b',
    url: 'http://rooms.test', WebSocketImpl: server.WebSocket, lan: ['127.0.0.1'] });
  const game = await fakeGame(host.gamePort);
  try {
    const link = await rooms.join({ ...quiet, code: 'KQ7M2D', name: 'Luigi', check: true, url: 'http://rooms.test',
      WebSocketImpl: server.WebSocket, lan: ['127.0.0.1'] });
    try {
      const info = await multiplayer.probe('127.0.0.1', link.localPort, { timeout: 2000 });
      assert.equal(info.name, 'Chase');
      assert.ok(Number.isInteger(info.ping));
      assert.equal(host.peers.size, 1);
    } finally { link.close(); }
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(host.peers.size, 0, 'the check\'s forwarding is closed when it leaves');
    assert.deepEqual(hostLog, []);
  } finally {
    game.close();
    host.close();
  }
});

test('with no way through, the joiner falls back to the relay, and the host hears why', async () => {
  const server = roomServer();
  const hostLog = [];
  const port = await freePort();
  const host = await rooms.host({ ...quiet, log: line => hostLog.push(line), port, name: 'Chase', build: 'b', url: 'http://rooms.test',
    WebSocketImpl: server.WebSocket, lan: [] });
  const game = await fakeGame(host.gamePort);
  try {
    const link = await rooms.join({ ...quiet, code: 'KQ7M2D', name: 'Luigi', url: 'http://rooms.test',
      WebSocketImpl: server.WebSocket, lan: [], punchFor: 300 });
    try {
      assert.equal(link.mode, 'relay');
      assert.equal(server.relayed, 'punch');
      const info = await multiplayer.probe('127.0.0.1', link.localPort, { timeout: 2000 });
      assert.equal(info.name, 'Chase');
      assert.match(hostLog.join('\n'), new RegExp(`Luigi is connected through the relay.*Forwarding UDP port ${port}`));
    } finally { link.close(); }
  } finally {
    game.close();
    host.close();
  }
});

test('players joining with the host\'s address still get through', async () => {
  const server = roomServer();
  const port = await freePort();
  const host = await rooms.host({ ...quiet, port, name: 'Chase', build: 'b', url: 'http://rooms.test',
    WebSocketImpl: server.WebSocket, lan: [] });
  const game = await fakeGame(host.gamePort);
  try {
    const info = await multiplayer.probe('127.0.0.1', port, { timeout: 2000 });
    assert.equal(info.name, 'Chase');
  } finally {
    game.close();
    host.close();
  }
});

test('hosting still works when the room server can\'t be reached', async () => {
  class Unreachable {
    constructor() { setImmediate(() => this.error?.()); }
    addEventListener(type, fn) { if (type === 'error') this.error = fn; }
    close() {}
  }
  const logged = [];
  const host = await rooms.host({ servers: [], log: line => logged.push(line), port: await freePort(), name: 'Chase',
    build: 'b', url: 'http://rooms.test', WebSocketImpl: Unreachable, lan: [] });
  try {
    assert.equal(host.code, null);
    assert.match(logged.join('\n'), /Room codes aren't available right now/);
  } finally { host.close(); }
});

test('a joiner hears when the room is gone', async () => {
  const server = roomServer();
  const host = await rooms.host({ ...quiet, port: await freePort(), name: 'Chase', build: 'b', url: 'http://rooms.test',
    WebSocketImpl: server.WebSocket, lan: [] });
  host.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  // the stand-in server keeps no room once its host has gone
  server.hostInfo = null;
  server.host = null;
  server.receive = (ws, data) => { if (JSON.parse(data).type === 'hello') ws.close(4404); };
  await assert.rejects(rooms.join({ ...quiet, code: 'KQ7M2D', name: 'Luigi', url: 'http://rooms.test',
    WebSocketImpl: server.WebSocket, lan: [] }), /The host closed their game/);
});

test('when the direct path stops working mid-game, the joiner moves to the relay and the host\'s game sees the same player', async () => {
  const server = roomServer();
  const host = await rooms.host({ ...quiet, port: await freePort(), name: 'Chase', build: 'b', url: 'http://rooms.test',
    WebSocketImpl: server.WebSocket, lan: ['127.0.0.1'] });
  const game = await fakeGame(host.gamePort);
  const joinLog = [];
  const link = await rooms.join({ ...quiet, log: line => joinLog.push(line), code: 'KQ7M2D', name: 'Luigi', url: 'http://rooms.test',
    WebSocketImpl: server.WebSocket, lan: ['127.0.0.1'] });
  const hostLog = [];
  host.log = line => hostLog.push(line);
  // a joining game that keeps asking, as a game sends all the time
  const player = dgram.createSocket('udp4');
  let answers = 0;
  player.on('message', () => answers++);
  await new Promise(resolve => player.bind(0, '127.0.0.1', resolve));
  const probe = multiplayer.probePacket(7);
  const asking = setInterval(() => player.send(probe, link.localPort, '127.0.0.1'), 50);
  try {
    assert.equal(link.mode, 'direct');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(answers > 0, 'answered directly');
    // the routers stop passing the host's packets
    host.socket.send = () => {};
    await new Promise(resolve => setTimeout(resolve, 5500));
    assert.equal(link.mode, 'relay');
    assert.equal(server.relayed, 'lost');
    assert.match(joinLog.join('\n'), /stopped working. Switching to the relay/);
    assert.match(hostLog.join('\n'), /Luigi's direct connection stopped working, so they're now connected through the relay/);
    const before = answers;
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(answers > before, 'answered through the relay');
    assert.equal(new Set(game.seen.map(from => from.port)).size, 1, 'one address for the player throughout');
  } finally {
    clearInterval(asking);
    player.close();
    link.close();
    game.close();
    host.close();
  }
});

test('a public host says so, and reports its game for the list once the game answers', async () => {
  const server = roomServer();
  const logged = [];
  const host = await rooms.host({ ...quiet, log: line => logged.push(line), port: await freePort(), name: 'Chase', build: 'b',
    isPublic: true, url: 'http://rooms.test', WebSocketImpl: server.WebSocket, lan: [] });
  try {
    assert.equal(server.hostInfo.public, true);
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(server.statuses, undefined, 'nothing before the game answers');
    const game = await fakeGame(host.gamePort);
    try {
      // the next try is a few seconds away; don't wait for it
      host.statusAt = 0;
      for (let i = 0; i < 40 && !server.statuses; i++) await new Promise(resolve => setTimeout(resolve, 50));
      assert.deepEqual(server.statuses[0], { type: 'status', players: 1, maxPlayers: 4, status: 'Delfino Plaza', open: true });
      assert.match(logged.join('\n'), /Your game is in the public list/);
    } finally { game.close(); }
  } finally { host.close(); }
});

test('a private host is never reported for the list', async () => {
  const server = roomServer();
  const host = await rooms.host({ ...quiet, port: await freePort(), name: 'Chase', build: 'b', url: 'http://rooms.test',
    WebSocketImpl: server.WebSocket, lan: [] });
  const game = await fakeGame(host.gamePort);
  try {
    await new Promise(resolve => setTimeout(resolve, 600));
    assert.equal(server.hostInfo.public, false);
    assert.equal(server.statuses, undefined);
  } finally {
    game.close();
    host.close();
  }
});

test('the public list comes back as the server sends it, or says why not', async () => {
  const games = [{ code: 'KQ7M2D', name: 'Chase', build: 'b', protocol: 2, players: 1, maxPlayers: 4, status: 'Delfino Plaza', open: true, minutes: 3 }];
  const answer = (status, body) => async () => ({ status, ok: status === 200, json: async () => body });
  assert.deepEqual(await rooms.listPublic({ url: 'https://x', fetchImpl: answer(200, { rooms: games }) }), games);
  assert.deepEqual(await rooms.listPublic({ url: 'https://x', fetchImpl: answer(200, {}) }), []);
  await assert.rejects(rooms.listPublic({ url: 'https://x', fetchImpl: answer(500) }), /had a problem/);
  await assert.rejects(rooms.listPublic({ url: 'https://x', fetchImpl: async () => { throw new Error('x'); } }), /Couldn't reach/);
});
