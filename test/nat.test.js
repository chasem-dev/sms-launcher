'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const nat = require('../src/nat');

// A STUN server on two local ports (its "other address"), playing a router:
// `mapped(n)` is the public port it reports for the n-th request from a
// port, and `answerChanged` whether a CHANGE-REQUEST answer gets through.
async function fakeStun({ publicAddress = '203.0.113.5', mapped = () => 40000, answerChanged = false, silent = false,
  ignoreChange = false, noOther = false }) {
  const primary = dgram.createSocket('udp4'), other = dgram.createSocket('udp4');
  await Promise.all([primary, other].map(socket => new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))));
  const otherPort = other.address().port;
  let requests = 0;
  function response(request, port) {
    const attrs = [];
    const xor = Buffer.alloc(12);
    xor.writeUInt16BE(0x0020, 0); xor.writeUInt16BE(8, 2); xor.writeUInt8(1, 5);
    xor.writeUInt16BE(port ^ (nat.MAGIC >>> 16), 6);
    publicAddress.split('.').forEach((part, i) => xor.writeUInt8(Number(part) ^ ((nat.MAGIC >>> (24 - 8 * i)) & 0xff), 8 + i));
    attrs.push(xor);
    const otherAttr = Buffer.alloc(12);
    otherAttr.writeUInt16BE(0x802c, 0); otherAttr.writeUInt16BE(8, 2); otherAttr.writeUInt8(1, 5);
    otherAttr.writeUInt16BE(otherPort, 6);
    [127, 0, 0, 1].forEach((part, i) => otherAttr.writeUInt8(part, 8 + i));
    if (!noOther) attrs.push(otherAttr);
    const body = Buffer.concat(attrs);
    const head = Buffer.alloc(20);
    head.writeUInt16BE(0x0101, 0); head.writeUInt16BE(body.length, 2); request.copy(head, 4, 4, 20);
    return Buffer.concat([head, body]);
  }
  primary.on('message', (request, from) => {
    if (silent || request.length < 20 || request.readUInt16BE(0) !== 0x0001) return;
    const change = request.length >= 28 && request.readUInt16BE(20) === 0x0003 ? request.readUInt32BE(24) : 0;
    const reply = response(request, mapped(requests++));
    if (!change || ignoreChange) primary.send(reply, from.port, from.address);
    else if (answerChanged) other.send(reply, from.port, from.address);
  });
  return { server: { host: '127.0.0.1', port: primary.address().port },
    close: () => { primary.close(); other.close(); } };
}

test('a port anyone can reach is open: hosting works', async () => {
  const stun = await fakeStun({ answerChanged: true });
  try {
    const result = await nat.detect({ servers: [stun.server], timeout: 400 });
    assert.equal(result.type, 'open');
    assert.equal(result.canHost, true);
    assert.equal(result.publicAddress, '203.0.113.5');
    assert.equal(result.publicPort, 40000);
  } finally { stun.close(); }
});

test('one public port, but only answers get in: moderate, joining only', async () => {
  const stun = await fakeStun({});
  try {
    const result = await nat.detect({ servers: [stun.server], timeout: 400 });
    assert.equal(result.type, 'moderate');
    assert.equal(result.canHost, false);
    assert.equal(result.canJoin, true);
    assert.match(result.text, /forward the UDP port/);
  } finally { stun.close(); }
});

test('a new public port for each destination is strict', async () => {
  const stun = await fakeStun({ mapped: n => 40000 + n });
  try {
    assert.equal((await nat.detect({ servers: [stun.server], timeout: 400 })).type, 'strict');
  } finally { stun.close(); }
});

test('no answer at all while online means UDP is blocked', async () => {
  const stun = await fakeStun({ silent: true });
  try {
    const result = await nat.detect({ servers: [{ ...stun.server, host: 'localhost' }], timeout: 300 });
    assert.equal(result.type, 'blocked');
    assert.equal(result.canJoin, false);
  } finally { stun.close(); }
});

test('the port to host on is checked, or another when a game holds it', async () => {
  const stun = await fakeStun({ answerChanged: true });
  const busy = dgram.createSocket('udp4');
  await new Promise(resolve => busy.bind(0, resolve));
  try {
    const port = busy.address().port;
    const result = await nat.detect({ port, servers: [stun.server], timeout: 400 });
    assert.equal(result.portBusy, true);
    assert.notEqual(result.port, port);
    assert.equal(result.type, 'open');
  } finally { busy.close(); stun.close(); }
});

test('classify reads the tests as RFC 5780 does', () => {
  const at = (address, port) => ({ mapped: { address, port } });
  const local = new Set(['192.168.1.20']);
  assert.equal(nat.classify({ first: null, local }), 'blocked');
  assert.equal(nat.classify({ first: at('192.168.1.20', 24002), changed: true, local }), 'open');
  assert.equal(nat.classify({ first: at('192.168.1.20', 24002), changed: false, local }), 'moderate');
  assert.equal(nat.classify({ first: at('198.51.100.1', 5000), changed: true, local }), 'open');
  assert.equal(nat.classify({ first: at('198.51.100.1', 5000), changed: null, second: at('198.51.100.1', 5000), local }), 'moderate');
  assert.equal(nat.classify({ first: at('198.51.100.1', 5000), changed: false, second: at('198.51.100.1', 5001), local }), 'strict');
});

test('responses to someone else\'s request are ignored', () => {
  const a = nat.bindingRequest(), b = nat.bindingRequest();
  const response = Buffer.from(a.message);
  response.writeUInt16BE(0x0101, 0);
  assert.equal(nat.readResponse(response, b.id), null);
  assert.equal(nat.readResponse(Buffer.from('short'), a.id), null);
});

test('a server that ignores the request to answer from elsewhere does not make the port look open', async () => {
  const stun = await fakeStun({ ignoreChange: true });
  try {
    const result = await nat.detect({ servers: [stun.server], timeout: 400 });
    assert.equal(result.type, 'moderate');
    assert.equal(result.canHost, false);
  } finally { stun.close(); }
});

test('without a server that can test hosting, it says hosting was not checked', async () => {
  const stun = await fakeStun({ noOther: true });
  try {
    const result = await nat.detect({ servers: [stun.server], timeout: 400 });
    assert.equal(result.type, 'moderate');
    assert.equal(result.confirmed, false);
    assert.match(result.text, /couldn't be checked/);
  } finally { stun.close(); }
});
