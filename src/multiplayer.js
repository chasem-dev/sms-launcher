'use strict';

// Multiplayer: the launcher's side of the game's multiplayer extension
// (ext/multiplayer in sms-pc-port). Hosting and joining are the game's work;
// the launcher checks that a host answers before starting the game to join it,
// and hands the game its settings as SMS_MULTIPLAYER* variables.
//
// The check is the game's own probe: a UDP packet "SMMP", protocol version,
// type 1 (PROBE) and a number, padded to PROBE_SIZE bytes (the game ignores a
// shorter one, so nobody can use it to send someone else a bigger answer);
// a hosting game answers type 2 (INFO) with the
// same number, its player count, whether it takes more players, its build,
// the host's name and where it is in the game.

const dgram = require('node:dgram');
const dns = require('node:dns');
const net = require('node:net');
const os = require('node:os');

const DEFAULT_PORT = 24002;
const MAGIC = 0x504d4d53; // "SMMP", little-endian
const PROTOCOL = 2;
const PROBE_SIZE = 200;
const PROBE = 1, INFO = 2;
const NAME_LENGTH = 23;

// Invite codes: a host's public IPv4 address and port as twelve letters and
// digits, ABCD-EFGH-JKMN, easier to read out or type with a controller than an
// address. Crockford's base32 (no I, L, O or U), 48 bits of address and port
// and a 12-bit check, so a mistyped code is caught rather than joined.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_SHAPE = /^[0-9a-z]{4}-?[0-9a-z]{4}-?[0-9a-z]{4}$/i;

function codeCheck(bytes) {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return (hash ^ (hash >>> 12) ^ (hash >>> 24)) & 0xfff;
}

function inviteCode(host, port) {
  if (!net.isIPv4(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const bytes = [...host.split('.').map(Number), port >> 8, port & 0xff];
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  value = (value << 12n) | BigInt(codeCheck(bytes));
  let text = '';
  for (let i = 0; i < 12; i++, value >>= 5n) text = CODE_ALPHABET[Number(value & 31n)] + text;
  return `${text.slice(0, 4)}-${text.slice(4, 8)}-${text.slice(8)}`;
}

// { host, port } from an invite code; null for anything else (an address or a
// host name), and an error for a code with a typo in it.
function parseInvite(text) {
  const raw = String(text || '').trim();
  if (!CODE_SHAPE.test(raw)) return null;
  const chars = raw.replace(/-/g, '').toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
  let value = 0n;
  for (const char of chars) {
    const digit = CODE_ALPHABET.indexOf(char);
    if (digit < 0) return null;
    value = (value << 5n) | BigInt(digit);
  }
  const check = Number(value & 0xfffn);
  value >>= 12n;
  const bytes = [];
  for (let i = 0; i < 6; i++, value >>= 8n) bytes.unshift(Number(value & 0xffn));
  if (codeCheck(bytes) !== check) {
    // dashes where a code has them: a code with a typo, not a host name
    if (raw.includes('-')) throw new Error('That invite code has a typo in it. Check it with the host.');
    return null;
  }
  return { host: bytes.slice(0, 4).join('.'), port: (bytes[4] << 8) | bytes[5] };
}

// "host", "host:port", "[v6]:port", a bare IPv6 address or an invite code, and
// a port field that wins when the address has none. Throws a sentence for the
// player.
function parseAddress(text, portText) {
  let host = String(text || '').trim(), port = null;
  if (!host) throw new Error('Enter the host\'s invite code or IP address.');
  const invite = parseInvite(host);
  if (invite) return invite;
  const bracket = host.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracket) [host, port] = [bracket[1], bracket[2] || null];
  else if ((host.match(/:/g) || []).length === 1) [host, port] = host.split(':');
  if (/\s/.test(host) || /[/\\]/.test(host)) throw new Error('That doesn\'t look like an IP address or host name.');
  const chosen = port ?? (String(portText ?? '').trim() || String(DEFAULT_PORT));
  return { host, port: parsePort(chosen) };
}

function parsePort(text) {
  const digits = String(text ?? '').trim();
  const value = /^\d{1,5}$/.test(digits) ? Number(digits) : NaN;
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('The port must be a number from 1 to 65535.');
  return value;
}

// An address for the activity log, which players paste in public: enough to
// tell which host it was, not enough to find them.
function maskAddress(host) {
  const text = String(host || '');
  if (net.isIPv4(text)) return text.split('.').slice(0, 2).join('.') + '.x.x';
  if (net.isIPv6(text)) return text.split(':').slice(0, 2).join(':') + ':…';
  return text ? `${text.slice(0, 2)}…` : '';
}

// This computer's addresses on its home network (and VPNs such as Tailscale),
// for friends on the same Wi-Fi: the public address often doesn't work from
// inside the network it belongs to.
function lanAddresses(interfaces = os.networkInterfaces()) {
  const local = address => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address);
  // containers' and virtual machines' own networks are not where friends are
  const virtual = /^(docker|br-|veth|virbr|vboxnet|vmnet|lxc|lxd|cni|flannel|podman|vEthernet)/i;
  const rank = address => address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : address.startsWith('100.') ? 3 : 2;
  return Object.entries(interfaces).filter(([name]) => !virtual.test(name)).flatMap(([, entries]) => entries || [])
    .filter(entry => !entry.internal && (entry.family === 'IPv4' || entry.family === 4) && local(entry.address))
    .map(entry => entry.address).sort((a, b) => rank(a) - rank(b));
}

// The hosts joined lately, newest first: one entry per address and port.
const RECENT_HOSTS = 5;
function rememberHost(list, { host, port, name }) {
  const entry = { address: String(host).slice(0, 255), port, name: playerName(name, '') };
  const rest = (Array.isArray(list) ? list : []).filter(item => !(item.address === entry.address && item.port === entry.port));
  return [entry, ...rest].slice(0, RECENT_HOSTS);
}

// A player's name as the game shows it: printable ASCII (the game's overlay
// font), at most 23 characters.
function playerName(text, fallback = 'Player') {
  const name = String(text || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, NAME_LENGTH);
  return name || fallback;
}

function probePacket(nonce) {
  const packet = Buffer.alloc(PROBE_SIZE);
  packet.writeUInt32LE(MAGIC, 0);
  packet.writeUInt16LE(PROTOCOL, 4);
  packet.writeUInt8(PROBE, 6);
  packet.writeUInt32LE(nonce >>> 0, 7);
  return packet;
}

// The host's INFO answer, or null when the packet is anything else.
function readInfo(packet, nonce) {
  try {
    let at = 0;
    const u8 = () => packet.readUInt8(at++);
    const u16 = () => { const v = packet.readUInt16LE(at); at += 2; return v; };
    const u32 = () => { const v = packet.readUInt32LE(at); at += 4; return v; };
    const str = () => { const n = u8(); const s = packet.toString('latin1', at, at + n); if (at + n > packet.length) throw new Error('short'); at += n; return s; };
    if (u32() !== MAGIC) return null;
    const protocol = u16();
    if (u8() !== INFO || u32() !== (nonce >>> 0)) return null;
    const info = { players: u8(), maxPlayers: u8(), open: u8() === 1, build: str(), name: str(), status: str(), protocol };
    if (at + 2 <= packet.length) info.protocol = u16();
    return info;
  } catch (_) { return null; }
}

// Asks the game at host:port whether it is hosting. Resolves with its INFO,
// or rejects with a sentence for the player after `timeout` ms of silence.
async function probe(host, port, options = {}) {
  // a host name may have only an IPv6 address: ask for either
  let address = host;
  if (!net.isIP(host)) {
    try { ({ address } = await dns.promises.lookup(host)); }
    catch (_) { throw new Error(`Couldn't find ${host}. Check the address.`); }
  }
  return probeAddress(address, port, options);
}

function probeAddress(host, port, { timeout = 4000, attempts = 4 } = {}) {
  return new Promise((resolve, reject) => {
    const family = net.isIPv6(host) ? 'udp6' : 'udp4';
    const socket = dgram.createSocket(family);
    const nonce = (Math.random() * 0xffffffff) >>> 0 || 1;
    let timer = null, retry = null, done = false;
    const finish = (error, info) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(retry);
      try { socket.close(); } catch (_) {}
      if (error) reject(error); else resolve(info);
    };
    socket.on('error', error => finish(new Error(error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN'
      ? `Couldn't find ${host}. Check the address.` : `Couldn't reach ${host}: ${error.message}`)));
    socket.on('message', message => {
      const info = readInfo(message, nonce);
      if (info) finish(null, info);
    });
    const send = () => socket.send(probePacket(nonce), port, host, error => {
      if (error) finish(new Error(error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN'
        ? `Couldn't find ${host}. Check the address.` : `Couldn't reach ${host}: ${error.message}`));
    });
    send();
    // UDP can lose a packet; ask a few times within the timeout
    retry = setInterval(send, Math.max(250, Math.floor(timeout / attempts)));
    timer = setTimeout(() => finish(new Error(`No game answered at ${host}:${port}. Check the address and port, `
      + 'and that the host has pressed Host Game and forwarded the port.')), timeout);
  });
}

// Why joining `info` would fail, or null when it can be joined.
function joinProblem(info, localBuild = null) {
  if (info.protocol !== PROTOCOL || (localBuild && info.build && info.build !== localBuild))
    return 'The host is playing a different version of the game. Update both games to the same version.';
  if (!info.open || info.players >= info.maxPlayers) return `The game is full (${info.maxPlayers} players).`;
  return null;
}

// The game's multiplayer settings, as environment variables.
function environment(mode, { host, port, name }) {
  if (mode === 'host') return { SMS_MULTIPLAYER: 'host', SMS_MULTIPLAYER_PORT: String(port), SMS_MULTIPLAYER_NAME: name };
  const address = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
  return { SMS_MULTIPLAYER: 'join', SMS_MULTIPLAYER_ADDRESS: address, SMS_MULTIPLAYER_PORT: String(port),
    SMS_MULTIPLAYER_NAME: name };
}

module.exports = { DEFAULT_PORT, PROTOCOL, parseAddress, parsePort, playerName, probePacket, readInfo, probe,
  joinProblem, environment, inviteCode, parseInvite, maskAddress, lanAddresses, rememberHost, RECENT_HOSTS };
