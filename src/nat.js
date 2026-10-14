'use strict';

// Whether this network lets the player host and join multiplayer games: the
// NAT type, found with STUN (RFC 5389, with RFC 5780's behaviour tests) from
// the UDP port the player would host on.
//
//   1. A binding request to a STUN server: the public address and port this
//      network gives the port (no answer from any server: UDP is blocked).
//   2. The same, asking the server to answer from its other address and
//      port (CHANGE-REQUEST): an answer means the router lets in packets
//      from anyone to this port (or the port is forwarded), so a hosted
//      game can be joined. That is "open".
//   3. A request to another server: the same public port means the router
//      keeps one public port per local port ("moderate": joining works,
//      hosting needs the port forwarded); another port means it makes one
//      per destination ("strict": joining works with hosts whose port is
//      open; hosting needs the port forwarded).

const dgram = require('node:dgram');
const crypto = require('node:crypto');
const os = require('node:os');

const MAGIC = 0x2112a442;
const BINDING_REQUEST = 0x0001, BINDING_RESPONSE = 0x0101;
const ATTR = { MAPPED_ADDRESS: 0x0001, CHANGE_REQUEST: 0x0003, CHANGED_ADDRESS: 0x0005, XOR_MAPPED_ADDRESS: 0x0020,
  OTHER_ADDRESS: 0x802c };
// RFC 5780 servers (they can answer from a second address), then plain ones.
const SERVERS = [
  { host: 'stun.stunprotocol.org', port: 3478 },
  { host: 'stun.l.google.com', port: 19302 },
  { host: 'stun.cloudflare.com', port: 3478 }
];

function bindingRequest(changeIp = false, changePort = false) {
  const id = crypto.randomBytes(12);
  const change = changeIp || changePort;
  const message = Buffer.alloc(20 + (change ? 8 : 0));
  message.writeUInt16BE(BINDING_REQUEST, 0);
  message.writeUInt16BE(change ? 8 : 0, 2);
  message.writeUInt32BE(MAGIC, 4);
  id.copy(message, 8);
  if (change) {
    message.writeUInt16BE(ATTR.CHANGE_REQUEST, 20);
    message.writeUInt16BE(4, 22);
    message.writeUInt32BE((changeIp ? 4 : 0) | (changePort ? 2 : 0), 24);
  }
  return { id, message };
}

function readAddress(value, xor, id) {
  if (value.length < 8) return null;
  const family = value.readUInt8(1);
  let port = value.readUInt16BE(2);
  if (xor) port ^= MAGIC >>> 16;
  if (family === 1) {
    const bytes = Buffer.from(value.subarray(4, 8));
    if (xor) for (let i = 0; i < 4; i++) bytes[i] ^= (MAGIC >>> (24 - 8 * i)) & 0xff;
    return { address: [...bytes].join('.'), port };
  }
  if (family === 2 && value.length >= 20) {
    const bytes = Buffer.from(value.subarray(4, 20));
    if (xor) {
      const key = Buffer.alloc(16);
      key.writeUInt32BE(MAGIC, 0);
      id.copy(key, 4);
      for (let i = 0; i < 16; i++) bytes[i] ^= key[i];
    }
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
    return { address: groups.join(':'), port };
  }
  return null;
}

// A binding response to request `id`: { mapped, other } addresses, or null.
function readResponse(packet, id) {
  if (packet.length < 20 || packet.readUInt16BE(0) !== BINDING_RESPONSE || packet.readUInt32BE(4) !== MAGIC
    || !packet.subarray(8, 20).equals(id)) return null;
  const length = packet.readUInt16BE(2);
  const result = { mapped: null, other: null };
  let at = 20;
  while (at + 4 <= Math.min(packet.length, 20 + length)) {
    const type = packet.readUInt16BE(at), size = packet.readUInt16BE(at + 2);
    const value = packet.subarray(at + 4, at + 4 + size);
    if (type === ATTR.XOR_MAPPED_ADDRESS) result.mapped = readAddress(value, true, id) || result.mapped;
    else if (type === ATTR.MAPPED_ADDRESS && !result.mapped) result.mapped = readAddress(value, false, id);
    else if (type === ATTR.OTHER_ADDRESS || type === ATTR.CHANGED_ADDRESS) result.other = readAddress(value, false, id);
    at += 4 + size + ((4 - (size % 4)) % 4);
  }
  return result.mapped ? result : null;
}

// One request from `socket`, asked a few times (UDP can lose one); resolves
// with the response or null after `timeout` ms.
function ask(socket, server, { changeIp = false, changePort = false, timeout = 1500 } = {}) {
  return new Promise(resolve => {
    const { id, message } = bindingRequest(changeIp, changePort);
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      clearInterval(retry);
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(value);
    };
    const onMessage = (packet, from) => {
      const response = readResponse(packet, id);
      if (response) finish({ ...response, from: { address: from.address, port: from.port } });
    };
    socket.on('message', onMessage);
    const send = () => socket.send(message, server.port, server.host, error => { if (error) finish(null); });
    send();
    const retry = setInterval(send, Math.max(200, Math.floor(timeout / 4)));
    const timer = setTimeout(() => finish(null), timeout);
  });
}

function localAddresses() {
  return new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map(entry => entry.address));
}

// The NAT type from what the tests found (for tests: the pure part).
function classify({ first, changed, second, local }) {
  if (!first) return 'blocked';
  if (local.has(first.mapped.address)) return changed === false ? 'moderate' : 'open';
  if (changed) return 'open';
  if (second && second.mapped.port !== first.mapped.port) return 'strict';
  return 'moderate';
}

const DESCRIPTIONS = {
  open: { label: 'Open', canHost: true, canJoin: true,
    text: 'You can host and join. Friends join you with your room code, or your public IP address and port.' },
  moderate: { label: 'Moderate', canHost: false, canJoin: true,
    text: 'You can host and join with room codes. Joining you with your address needs the UDP port forwarded on your router.' },
  strict: { label: 'Strict', canHost: false, canJoin: true,
    text: 'You can host and join with room codes, though some friends may connect through the relay, which adds a little delay. Forwarding the UDP port on your router avoids that.' },
  blocked: { label: 'Blocked', canHost: false, canJoin: true,
    text: "This network doesn't let UDP through. You can still host and join with room codes, through the relay, which adds a little delay." },
  unknown: { label: 'Unknown', canHost: false, canJoin: false,
    text: "Couldn't check your network. Are you online?" }
};

// Checks the network from UDP port `port` (0: any). Resolves with
// { type, label, text, canHost, canJoin, publicAddress, publicPort, port }.
async function detect({ port = 0, servers = SERVERS, timeout = 1500 } = {}) {
  const socket = dgram.createSocket('udp4');
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(port, () => { socket.off('error', reject); resolve(); });
    });
  } catch (error) {
    // the port is taken (a hosted game is running there): check from another
    try { socket.close(); } catch (_) {}
    if (port) return { ...(await detect({ port: 0, servers, timeout })), portBusy: true };
    return { type: 'unknown', ...DESCRIPTIONS.unknown, error: error.message };
  }
  socket.on('error', () => {});
  try {
    let first = null, server = null;
    for (const candidate of servers) {
      first = await ask(socket, candidate, { timeout });
      if (first) { server = candidate; break; }
    }
    let changed = null, second = null;
    if (first) {
      // only a server that has a second address can answer from it; an answer
      // from the address we asked proves nothing (the server ignored the
      // request), so only one from elsewhere counts
      if (first.other) {
        const reply = await ask(socket, server, { changeIp: true, changePort: true, timeout });
        changed = Boolean(reply && (reply.from.address !== first.from.address || reply.from.port !== first.from.port));
      }
      const another = first.other ? { host: first.other.address, port: server.port }
        : servers.find(candidate => candidate !== server);
      if (another) second = await ask(socket, another, { timeout });
    }
    const local = localAddresses();
    const type = first ? classify({ first, changed, second, local })
      : await online(servers) ? 'blocked' : 'unknown';
    const result = { type, ...DESCRIPTIONS[type], publicAddress: first?.mapped.address || null,
      publicPort: first?.mapped.port || null, port: socket.address().port,
      // whether hosting was really tested (a server that can answer from its other address answered)
      confirmed: changed !== null };
    if (first && local.has(first.mapped.address) && changed === false)
      // no router in the way: what blocks players is this computer's firewall
      result.text = 'You can join games. To host, allow the UDP port through this computer\'s firewall.';
    else if (type === 'moderate' && changed === null)
      result.text = 'You can join games. Hosting couldn\'t be checked from here: to host, make sure the UDP port is '
        + 'forwarded on your router to this computer.';
    return result;
  } finally {
    try { socket.close(); } catch (_) {}
  }
}

// Whether the STUN servers' names resolve at all (else we are offline, not blocked).
async function online(servers) {
  const dns = require('node:dns').promises;
  try { await dns.lookup(servers[0].host); return true; } catch (_) { return false; }
}

module.exports = { detect, classify, ask, bindingRequest, readResponse, DESCRIPTIONS, SERVERS, MAGIC };
