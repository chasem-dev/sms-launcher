'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const multiplayer = require('../src/multiplayer');

// A host's INFO answer, laid out as the game writes it (ext/multiplayer/net/mp_net.cpp).
function infoPacket(nonce, { players = 1, max = 4, open = true, build = 'c8fb4a3e81a2', name = 'Host', status = 'Delfino Plaza', protocol = multiplayer.PROTOCOL } = {}) {
  const str = text => Buffer.concat([Buffer.from([Buffer.byteLength(text, 'latin1')]), Buffer.from(text, 'latin1')]);
  const head = Buffer.alloc(11);
  head.writeUInt32LE(0x504d4d53, 0);
  head.writeUInt16LE(protocol, 4);
  head.writeUInt8(2, 6);
  head.writeUInt32LE(nonce, 7);
  const tail = Buffer.alloc(2);
  tail.writeUInt16LE(protocol, 0);
  return Buffer.concat([head, Buffer.from([players, max, open ? 1 : 0]), str(build), str(name), str(status), tail]);
}

// A stand-in for a hosting game on a free local port; `answer` makes its reply.
async function fakeHost(answer, { drop = 0 } = {}) {
  const socket = dgram.createSocket('udp4');
  let seen = 0;
  socket.on('message', (message, from) => {
    seen++;
    if (seen <= drop) return; // lose the first few, as UDP may
    if (message.length < 200 || message.readUInt32LE(0) !== 0x504d4d53 || message.readUInt8(6) !== 1) return;
    const reply = answer(message.readUInt32LE(7));
    if (reply) socket.send(reply, from.port, from.address);
  });
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  return { port: socket.address().port, close: () => socket.close(), seen: () => seen };
}

test('addresses take a port from the address or the port field', () => {
  assert.deepEqual(multiplayer.parseAddress('203.0.113.7', '25000'), { host: '203.0.113.7', port: 25000 });
  assert.deepEqual(multiplayer.parseAddress(' 203.0.113.7:24010 ', '25000'), { host: '203.0.113.7', port: 24010 });
  assert.deepEqual(multiplayer.parseAddress('example.com', ''), { host: 'example.com', port: multiplayer.DEFAULT_PORT });
  assert.deepEqual(multiplayer.parseAddress('[2001:db8::1]:24003', '1'), { host: '2001:db8::1', port: 24003 });
  assert.deepEqual(multiplayer.parseAddress('2001:db8::1', '24004'), { host: '2001:db8::1', port: 24004 });
  assert.throws(() => multiplayer.parseAddress('', '24002'), /IP address/);
  assert.throws(() => multiplayer.parseAddress('my host', '24002'), /doesn't look like/);
  assert.throws(() => multiplayer.parseAddress('1.2.3.4', '70000'), /1 to 65535/);
  assert.throws(() => multiplayer.parseAddress('1.2.3.4:abc', ''), /1 to 65535/);
});

test('names are printable, short, and never empty', () => {
  assert.equal(multiplayer.playerName('  Chase  '), 'Chase');
  assert.equal(multiplayer.playerName('Ünïcødé ✨ name'), 'ncd  name');
  assert.equal(multiplayer.playerName('x'.repeat(40)).length, 23);
  assert.equal(multiplayer.playerName(''), 'Player');
  assert.equal(multiplayer.playerName('', 'Host'), 'Host');
});

test('a probe reads the host\'s answer, asking again when a packet is lost', async () => {
  const host = await fakeHost(nonce => infoPacket(nonce, { players: 2, status: 'Bianco Hills' }), { drop: 2 });
  try {
    const info = await multiplayer.probe('127.0.0.1', host.port, { timeout: 3000, attempts: 10 });
    assert.equal(info.players, 2);
    assert.equal(info.maxPlayers, 4);
    assert.equal(info.open, true);
    assert.equal(info.name, 'Host');
    assert.equal(info.status, 'Bianco Hills');
    assert.equal(info.build, 'c8fb4a3e81a2');
    assert.ok(host.seen() >= 3);
    assert.ok(Number.isInteger(info.ping) && info.ping >= 0 && info.ping < 1000, `ping ${info.ping}`);
    assert.equal(multiplayer.joinProblem(info, 'c8fb4a3e81a2'), null);
  } finally { host.close(); }
});

test('a probe ignores answers to someone else\'s question', async () => {
  const host = await fakeHost(nonce => infoPacket(nonce + 1));
  try {
    await assert.rejects(multiplayer.probe('127.0.0.1', host.port, { timeout: 600 }), /No game answered at 127\.0\.0\.1/);
  } finally { host.close(); }
});

test('no answer, a full game and another game version are reported for the player', async () => {
  const silent = await fakeHost(() => null);
  try {
    await assert.rejects(multiplayer.probe('127.0.0.1', silent.port, { timeout: 500 }), /forwarded the port/);
  } finally { silent.close(); }
  const full = { players: 4, maxPlayers: 4, open: false, build: 'abc', protocol: multiplayer.PROTOCOL };
  assert.match(multiplayer.joinProblem(full, 'abc'), /full \(4 players\)/);
  const choosing = { players: 1, maxPlayers: 4, open: false, build: 'abc', protocol: multiplayer.PROTOCOL };
  assert.match(multiplayer.joinProblem(choosing, 'abc'), /still choosing a save file/);
  const other = { players: 1, maxPlayers: 4, open: true, build: 'def', protocol: multiplayer.PROTOCOL };
  assert.match(multiplayer.joinProblem(other, 'abc'), /different version/);
  assert.equal(multiplayer.joinProblem(other, null), null); // unknown local build: the game checks
  assert.match(multiplayer.joinProblem({ ...other, protocol: multiplayer.PROTOCOL + 1 }, null), /different version/);
});

test('the ping is timed from the ask that was answered, not the first one', async () => {
  // the first two asks are lost; the third is answered 60 ms later
  const socket = dgram.createSocket('udp4');
  let seen = 0;
  socket.on('message', (message, from) => {
    if (++seen < 3) return;
    setTimeout(() => socket.send(infoPacket(message.readUInt32LE(7)), from.port, from.address), 60);
  });
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve));
  try {
    const info = await multiplayer.probe('127.0.0.1', socket.address().port, { timeout: 4000, attempts: 8 });
    assert.ok(info.ping >= 50 && info.ping < 400, `ping ${info.ping}`);
  } finally { socket.close(); }
});

test('a host on another version is told apart by both sides\' game and launcher versions', () => {
  const host = { players: 1, maxPlayers: 8, open: true, build: '955abf3ab1c2', protocol: multiplayer.PROTOCOL,
    version: '2026.10.16-beta.955abf3', launcher: '0.1.61-pr149.256' };
  const mine = { build: '92158d913e8e', version: '2026.10.15.1', launcher: '0.1.61' };
  assert.equal(multiplayer.joinProblem(host, mine), 'The host is on a different version. '
    + 'Host: game 2026.10.16-beta.955abf3 (955abf3), launcher 0.1.61-pr149.256. '
    + 'You: game 2026.10.15.1 (92158d9), launcher 0.1.61. Update both launchers (on the same update channel) to play together.');
  // a host found by address says only its build
  assert.match(multiplayer.joinProblem({ ...host, version: undefined, launcher: undefined }, mine),
    /Host: game build 955abf3\. You: game 2026\.10\.15\.1 \(92158d9\), launcher 0\.1\.61\./);
  // this player's game not built yet: only a protocol tells them apart
  assert.equal(multiplayer.joinProblem(host, { ...mine, build: null }), null);
  assert.match(multiplayer.joinProblem({ ...host, protocol: 1 }, { ...mine, build: null }), /Host: .*You: game 2026\.10\.15\.1, launcher 0\.1\.61\./);
  // the same game, Eclipse on one side
  assert.equal(multiplayer.joinProblem({ ...host, build: '92158d913e8e-eclipse' }, mine),
    'The host has Super Mario Eclipse on and you have it off. Both players need the same Eclipse setting.');
  assert.equal(multiplayer.describeVersion({ build: 'abc1234def56-eclipse', version: '2026.10.15.1' }), 'game 2026.10.15.1 (abc1234) with Eclipse');
  assert.equal(multiplayer.formatPing(0.4), '1 ms');
  assert.equal(multiplayer.formatPing(undefined), '');
});

test('the probe packet is the game\'s PROBE', () => {
  const packet = multiplayer.probePacket(0xdeadbeef);
  // padded past any answer, as the game wants (it ignores shorter probes)
  assert.equal(packet.length, 200);
  assert.equal(packet.toString('latin1', 0, 4), 'SMMP');
  assert.equal(packet.readUInt16LE(4), multiplayer.PROTOCOL);
  assert.equal(packet.readUInt8(6), 1);
  assert.equal(packet.readUInt32LE(7), 0xdeadbeef);
  assert.equal(multiplayer.readInfo(Buffer.from('nonsense'), 1), null);
  assert.equal(multiplayer.readInfo(infoPacket(5), 6), null);
  assert.equal(multiplayer.readInfo(infoPacket(5).subarray(0, 20), 5), null);
});

test('the game is told to host or join through its environment', () => {
  assert.deepEqual(multiplayer.environment('host', { port: 24005, name: 'Chase' }),
    { SMS_MULTIPLAYER: 'host', SMS_MULTIPLAYER_PORT: '24005', SMS_MULTIPLAYER_NAME: 'Chase', SMS_MULTIPLAYER_MAX_PLAYERS: '8' });
  assert.equal(multiplayer.environment('host', { port: 24005, name: 'Chase', maxPlayers: '3' }).SMS_MULTIPLAYER_MAX_PLAYERS, '3');
  assert.throws(() => multiplayer.environment('host', { port: 24005, name: 'Chase', maxPlayers: 9 }), /2 to 8/);
  assert.deepEqual(multiplayer.environment('join', { host: '203.0.113.7', port: 24002, name: 'Bob' }),
    { SMS_MULTIPLAYER: 'join', SMS_MULTIPLAYER_ADDRESS: '203.0.113.7:24002', SMS_MULTIPLAYER_PORT: '24002', SMS_MULTIPLAYER_NAME: 'Bob' });
  assert.equal(multiplayer.environment('join', { host: '2001:db8::1', port: 24002, name: 'Bob' }).SMS_MULTIPLAYER_ADDRESS,
    '[2001:db8::1]:24002');
});

test('an invite code carries the host\'s address and port, and catches typos', () => {
  const code = multiplayer.inviteCode('203.0.113.7', 24002);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.deepEqual(multiplayer.parseInvite(code), { host: '203.0.113.7', port: 24002 });
  // typed loosely: lower case, no dashes, O for 0 and I or L for 1
  const loose = code.toLowerCase().replace(/-/g, '').replace(/0/g, 'o').replace(/1/g, 'l');
  assert.deepEqual(multiplayer.parseInvite(loose), { host: '203.0.113.7', port: 24002 });
  for (const [host, port] of [['0.0.0.1', 1], ['255.255.255.255', 65535], ['192.168.1.20', 24010]])
    assert.deepEqual(multiplayer.parseInvite(multiplayer.inviteCode(host, port)), { host, port });
  // one character wrong: caught, not joined somewhere else
  const wrong = code.slice(0, 5) + (code[5] === 'A' ? 'B' : 'A') + code.slice(6);
  assert.throws(() => multiplayer.parseInvite(wrong), /typo/);
  // only IPv4 addresses have codes
  assert.equal(multiplayer.inviteCode('2001:db8::1', 24002), null);
  // the Join field takes a code, an address or a host name
  assert.deepEqual(multiplayer.parseAddress(code, '99'), { host: '203.0.113.7', port: 24002 });
  assert.deepEqual(multiplayer.parseAddress('example.com', '24003'), { host: 'example.com', port: 24003 });
  assert.equal(multiplayer.parseInvite('example.com'), null);
});

test('the most players a host takes is a whole number from 2 to 8', () => {
  assert.equal(multiplayer.DEFAULT_MAX_PLAYERS, 8);
  assert.equal(multiplayer.parseMaxPlayers(' 4 '), 4);
  assert.equal(multiplayer.parseMaxPlayers(2), 2);
  assert.equal(multiplayer.parseMaxPlayers('8'), 8);
  for (const text of ['1', '9', '0', '-3', '4.5', '1e1', '0x4', '', 'abc', null, 4.5])
    assert.throws(() => multiplayer.parseMaxPlayers(text), /2 to 8/);
});

test('a probe answer with more players than a game takes is not a game\'s', () => {
  assert.equal(multiplayer.readInfo(infoPacket(7, { players: 8, max: 8 }), 7).maxPlayers, 8);
  assert.equal(multiplayer.readInfo(infoPacket(7, { players: 1, max: 9 }), 7), null);
  assert.equal(multiplayer.readInfo(infoPacket(7, { players: 4, max: 3 }), 7), null);
});

test('ports are plain numbers', () => {
  assert.equal(multiplayer.parsePort(' 24002 '), 24002);
  for (const text of ['0x5dc2', '1e4', '24002.0', '-1', '0', '65536', '', 'abc'])
    assert.throws(() => multiplayer.parsePort(text), /1 to 65535/);
});

test('the activity log gets a masked address', () => {
  assert.equal(multiplayer.maskAddress('203.0.113.7'), '203.0.x.x');
  assert.equal(multiplayer.maskAddress('2001:db8::1'), '2001:db8:…');
  assert.equal(multiplayer.maskAddress('mario.example.com'), 'ma…');
});

test('the address for friends on the same Wi-Fi skips containers and VPN bridges', () => {
  const interfaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
    'br-ccb48beef84f': [{ address: '192.168.0.1', family: 'IPv4', internal: false }],
    tailscale0: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
    enp2s0: [{ address: '192.168.50.100', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    wan: [{ address: '203.0.113.7', family: 'IPv4', internal: false }]
  };
  assert.deepEqual(multiplayer.lanAddresses(interfaces), ['192.168.50.100', '100.101.102.103']);
});

test('recent hosts: newest first, one entry each, five at most', () => {
  let list = [];
  for (let i = 1; i <= 7; i++) list = multiplayer.rememberHost(list, { host: `203.0.113.${i}`, port: 24002, name: `Host ${i}` });
  assert.equal(list.length, multiplayer.RECENT_HOSTS);
  assert.equal(list[0].address, '203.0.113.7');
  list = multiplayer.rememberHost(list, { host: '203.0.113.5', port: 24002, name: 'Back again' });
  assert.equal(list[0].name, 'Back again');
  assert.equal(list.filter(item => item.address === '203.0.113.5').length, 1);
});
