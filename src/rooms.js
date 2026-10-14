'use strict';

// Multiplayer rooms: a host gets a short room code (KQ7-M2D), and friends
// join with it from anywhere, with no port forwarding and no firewall rule.
// The room server is sms-server-api (its src/rooms.js describes the
// messages).
//
// The launcher stands between the game and the internet: it owns the UDP
// port players reach, the game listens on this computer only, and the
// launcher passes packets between them. That lets it
//
//   1. learn the port's public address from a STUN server,
//   2. give it to the room server, which introduces host and joiner to each
//      other, with their addresses on their own networks too,
//   3. have both send to each other at once (UDP hole punching): each one's
//      router and firewall then let the other's packets in as replies,
//   4. and where that fails (some mobile and shared-address networks), pass
//      the packets through the room server's WebSocket instead.
//
// The games then talk as they would over a direct connection.
//
// Punching packets are "SMLP", a type (HELLO, ACK, KEEP) and the 16-byte
// secret the room server gave both sides for this join; nothing answers a
// packet without it. The game's own packets start with "SMMP".

const dgram = require('node:dgram');
const net = require('node:net');
const nat = require('./nat');
const multiplayer = require('./multiplayer');
const telemetry = require('./telemetry');

const GAME_MAGIC = 0x504d4d53; // "SMMP"
const PUNCH_TAG = Buffer.from('SMLP');
const HELLO = 1, ACK = 2, KEEP = 3;
const PUNCH_EVERY = 100;       // ms between punches
const PUNCH_FOR = 5000;        // ms of punching before falling back to the relay
const KEEP_EVERY = 2000;       // ms: a quiet path is kept open this often
const KEEP_FOR = 60000;        // ms after punching that a path is kept open with no game on it
const QUIET_SWITCH = 4000;     // ms without a packet from the host before a joiner tries the relay
const PEER_IDLE = 30000;       // ms before a silent player's forwarding is closed
const MAX_PEERS = 12;          // players (and probes) forwarded at once by a host
const PING_EVERY = 30000;      // ms between WebSocket keepalives
const RESTUN_EVERY = 25000;    // ms between checks of the host's public address
const STATUS_EVERY = 20000;    // ms between a public host's reports of its game for the list
const STATUS_RETRY = 5000;     // ms between tries while the game isn't answering yet
const REPLY_WAIT = 8000;       // ms to wait for the room server
const RECONNECT = [2000, 5000, 10000, 30000];

// --- Room codes: six letters and digits from Crockford's base32 (no I, L,
// O or U), shown as KQ7-M2D.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

// The code in `text` ("kq7-m2d", "KQ7 M2D", O typed for 0), or null for
// anything else (an invite code, an address).
function parseRoomCode(text) {
  const raw = String(text || '').trim();
  if (!/^[0-9a-z]{3}[-\s]?[0-9a-z]{3}$/i.test(raw)) return null;
  const code = raw.toUpperCase().replace(/[-\s]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return [...code].every(char => CODE_ALPHABET.includes(char)) ? code : null;
}

function formatRoomCode(code) {
  return code ? `${code.slice(0, 3)}-${code.slice(3)}` : '';
}

function serverUrl(env = process.env) {
  return (env.SMS_ROOMS_URL || telemetry.TELEMETRY_URL).replace(/\/+$/, '');
}

// --- Packets

function punchPacket(type, secret) {
  return Buffer.concat([PUNCH_TAG, Buffer.from([type]), Buffer.from(secret, 'hex')]);
}

function readPunch(packet) {
  if (packet.length !== 21 || !packet.subarray(0, 4).equals(PUNCH_TAG)) return null;
  return { type: packet[4], secret: packet.subarray(5).toString('hex') };
}

const isGamePacket = packet => packet.length >= 7 && packet.readUInt32LE(0) === GAME_MAGIC;
const isStun = packet => packet.length >= 20 && packet.readUInt32BE(4) === nat.MAGIC;
const key = ({ address, port }) => `${address}:${port}`;

// An address on the player's own network (or a VPN such as Tailscale).
function privateAddress(address) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(address);
}

// How a path is described in the activity log, without the address itself.
function pathName(address) {
  return privateAddress(address) ? 'over your local network' : 'directly over the internet';
}

// --- Sockets

function bindUdp(port, address) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const fail = error => {
      try { socket.close(); } catch (_) {}
      reject(error.code === 'EADDRINUSE'
        ? new Error(`UDP port ${port} is in use by another program. Close it, or choose another port.`)
        : new Error(`Couldn't open UDP port ${port}: ${error.message}`));
    };
    socket.once('error', fail);
    socket.bind({ port, address, exclusive: true }, () => {
      socket.off('error', fail);
      socket.on('error', () => {}); // a send to an unreachable address must not throw
      resolve(socket);
    });
  });
}

// A port on this computer that nothing is using, for the game to listen on.
async function freeLoopbackPort() {
  const socket = await bindUdp(0, '127.0.0.1');
  const { port } = socket.address();
  socket.close();
  return port;
}

// The socket's public address, from whichever STUN server answers first.
async function publicAddress(socket, servers = nat.SERVERS, timeout = 2000) {
  const answers = servers.map(server => nat.ask(socket, server, { timeout })
    .then(answer => answer?.mapped && net.isIPv4(answer.mapped.address) ? answer.mapped : Promise.reject()));
  try { return await Promise.any(answers); } catch (_) { return null; }
}

// Where others can reach this socket: its public address, then its address
// on each local network.
async function candidates(socket, { servers, lan = multiplayer.lanAddresses() } = {}) {
  const { port } = socket.address();
  const found = await publicAddress(socket, servers);
  const list = [...(found ? [{ address: found.address, port: found.port }] : []), ...lan.map(address => ({ address, port }))];
  return list.filter((item, index) => list.findIndex(other => key(other) === key(item)) === index).slice(0, 6);
}

// --- The room server's WebSocket

function openSocket(url, WebSocketImpl = globalThis.WebSocket) {
  return new Promise((resolve, reject) => {
    if (!WebSocketImpl) return reject(new Error('This launcher can\'t reach the room server.'));
    let ws;
    try { ws = new WebSocketImpl(url); } catch (error) { return reject(error); }
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('The room server didn\'t answer.')); }, REPLY_WAIT);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Couldn\'t reach the room server.')); }, { once: true });
  });
}

const send = (ws, value) => { try { if (ws?.readyState === 1) ws.send(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)); } catch (_) {} };

// A WebSocket message: an object for text, a Buffer for binary, null for the
// keepalive's answer or anything malformed.
function readMessage(data) {
  if (typeof data !== 'string') return Buffer.from(data);
  if (data === 'pong') return null;
  try { const value = JSON.parse(data); return value && typeof value === 'object' ? value : null; } catch (_) { return null; }
}

// The next message of `type`, or an error when the WebSocket closes first.
function nextMessage(ws, type, closedText) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('The room server didn\'t answer.')), REPLY_WAIT);
    const onMessage = event => {
      const msg = readMessage(event.data);
      if (msg && !Buffer.isBuffer(msg) && msg.type === type) finish(null, msg);
    };
    const onClose = event => finish(new Error(event.code === 4404 ? closedText : 'The room server closed the connection.'));
    function finish(error, value) {
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onClose);
      if (error) reject(error); else resolve(value);
    }
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
  });
}

// --- Joining: the room's host's name and build, before anything starts

async function lookup(code, { url = serverUrl(), fetchImpl = globalThis.fetch } = {}) {
  let response;
  try { response = await fetchImpl(`${url}/v1/rooms/${code}`, { signal: AbortSignal.timeout(REPLY_WAIT) }); }
  catch (_) { throw new Error('Couldn\'t reach the room server. Check your internet connection, or join with the host\'s address.'); }
  if (response.status === 404)
    throw new Error(`No game is open with room code ${formatRoomCode(code)}. Check the code with the host: a code ends when their game closes.`);
  if (!response.ok) throw new Error('The room server had a problem. Try again in a moment.');
  return response.json();
}

// --- The public list: games whose hosts chose to list them

async function listPublic({ url = serverUrl(), fetchImpl = globalThis.fetch } = {}) {
  let response;
  try { response = await fetchImpl(`${url}/v1/rooms`, { signal: AbortSignal.timeout(REPLY_WAIT) }); }
  catch (_) { throw new Error('Couldn\'t reach the room server. Check your internet connection.'); }
  if (!response.ok) throw new Error('The room server had a problem. Try again in a moment.');
  const body = await response.json();
  return Array.isArray(body?.rooms) ? body.rooms : [];
}

// --- Hosting

// A player the host's launcher passes packets for: its own socket on this
// computer, so the game sees each player at its own address.
class Peer {
  constructor(room, route) {
    this.room = room;
    this.route = route; // { address, port } or { relay: id }
    this.heard = this.sent = Date.now();
    this.local = dgram.createSocket('udp4');
    this.local.on('error', () => {});
    this.local.on('message', (packet, from) => {
      if (from.address === '127.0.0.1' && from.port === room.gamePort) this.toInternet(packet);
    });
    this.local.bind(0, '127.0.0.1');
  }

  toGame(packet) {
    this.heard = Date.now();
    this.local.send(packet, this.room.gamePort, '127.0.0.1');
  }

  toInternet(packet) {
    this.sent = Date.now();
    if (this.route.relay) {
      const frame = Buffer.alloc(4 + packet.length);
      frame.writeUInt32LE(this.route.relay, 0);
      packet.copy(frame, 4);
      send(this.room.ws, frame);
    } else {
      this.room.socket.send(packet, this.route.port, this.route.address);
    }
  }

  close() {
    try { this.local.close(); } catch (_) {}
  }
}

class HostRoom {
  constructor({ port, name, build, isPublic = false, url = serverUrl(), WebSocketImpl = globalThis.WebSocket, log = () => {},
    onRoom = () => {}, servers, lan }) {
    Object.assign(this, { port, name, build, isPublic, url, WebSocketImpl, log, onRoom, servers, lan });
    this.statusAt = 0;
    this.code = null;
    this.roomKey = null;
    this.joins = new Map();     // join id -> { id, secret, candidates, name, started, reached, peer }
    this.peers = new Set();
    this.byAddress = new Map(); // "address:port" -> Peer
    this.closed = false;
    this.attempt = 0;
  }

  async start() {
    this.socket = await bindUdp(this.port);
    try { this.gamePort = await freeLoopbackPort(); } catch (error) { this.socket.close(); throw error; }
    this.socket.on('message', (packet, from) => this.fromInternet(packet, from));
    this.timer = setInterval(() => this.tick(), 250);
    this.candidates = await candidates(this.socket, { servers: this.servers, lan: this.lan });
    this.stunAt = Date.now();
    try { await this.connect(); }
    catch (error) {
      this.log(`Room codes aren't available right now (${error.message}) Friends can still join with your address.`);
      this.reconnectLater();
    }
    return this;
  }

  hello() {
    return { type: 'hello', candidates: this.candidates, name: this.name, build: this.build, protocol: multiplayer.PROTOCOL,
      public: this.isPublic };
  }

  async connect() {
    const query = this.code && this.roomKey ? `?code=${this.code}&key=${this.roomKey}` : '';
    const ws = await openSocket(`${this.url.replace(/^http/, 'ws')}/v1/rooms/new${query}`, this.WebSocketImpl);
    if (this.closed) return ws.close();
    this.ws = ws;
    ws.addEventListener('message', event => this.fromServer(readMessage(event.data)));
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.closed) this.reconnectLater();
    });
    const reply = nextMessage(ws, 'room', 'The room closed.');
    send(ws, this.hello());
    let code, roomKey;
    try { ({ code, key: roomKey } = await reply); }
    catch (error) {
      this.ws = null;
      ws.close();
      throw error;
    }
    const changed = this.code && this.code !== code;
    this.code = code;
    this.roomKey = roomKey;
    this.attempt = 0;
    this.pingAt = Date.now();
    this.statusAt = 0; // a new connection's room needs its line in the list again
    this.onRoom(code, Boolean(changed));
  }

  reconnectLater() {
    if (this.closed || this.reconnecting) return;
    const wait = RECONNECT[Math.min(this.attempt++, RECONNECT.length - 1)];
    this.reconnecting = setTimeout(async () => {
      this.reconnecting = null;
      try { await this.connect(); } catch (_) { this.reconnectLater(); }
    }, wait);
  }

  fromServer(msg) {
    if (!msg) return;
    if (Buffer.isBuffer(msg)) {
      if (msg.length <= 4) return;
      const join = this.joins.get(msg.readUInt32LE(0));
      if (join?.peer?.route.relay) join.peer.toGame(msg.subarray(4));
      return;
    }
    if (msg.type === 'join' && Number.isInteger(msg.id) && /^[0-9a-f]{32}$/.test(msg.secret) && Array.isArray(msg.candidates)) {
      this.joins.set(msg.id, { id: msg.id, secret: msg.secret, candidates: msg.candidates.filter(c => net.isIPv4(c?.address)),
        name: multiplayer.playerName(msg.name, 'A player'), started: Date.now(), punchedAt: 0, reached: null, peer: null });
      this.log(`${multiplayer.playerName(msg.name, 'A player')} is joining with your room code…`);
    } else if (msg.type === 'relay') {
      const join = this.joins.get(msg.id);
      if (!join) return;
      const peer = this.peerFor(join);
      if (!peer) return;
      peer.route = { relay: join.id };
      this.log(msg.reason === 'lost'
        ? `${join.name}'s direct connection stopped working, so they're now connected through the relay, which adds a little delay.`
        : `${join.name} is connected through the relay, which adds a little delay: your networks couldn't connect directly. `
          + `Forwarding UDP port ${this.port} on your router to this computer would let players connect directly.`);
    } else if (msg.type === 'leave') {
      const join = this.joins.get(msg.id);
      if (join?.peer?.route.relay) this.dropPeer(join.peer);
      this.joins.delete(msg.id);
    }
  }

  // The forwarding for a join, made the first time it's needed.
  peerFor(join, route) {
    if (!join.peer || !this.peers.has(join.peer)) {
      if (this.peers.size >= MAX_PEERS) return null;
      join.peer = new Peer(this, route || { relay: join.id });
      this.peers.add(join.peer);
    }
    return join.peer;
  }

  dropPeer(peer) {
    peer.close();
    this.peers.delete(peer);
    for (const [where, other] of this.byAddress) if (other === peer) this.byAddress.delete(where);
    for (const join of this.joins.values()) if (join.peer === peer) join.peer = null;
  }

  fromInternet(packet, from) {
    if (isStun(packet)) return;
    const punch = readPunch(packet);
    if (punch) {
      const join = [...this.joins.values()].find(item => item.secret === punch.secret);
      if (!join) return;
      if (punch.type === HELLO) this.socket.send(punchPacket(ACK, join.secret), from.port, from.address);
      if (punch.type !== HELLO && punch.type !== ACK) return;
      const peer = this.peerFor(join, { address: from.address, port: from.port });
      if (!peer) return;
      this.byAddress.set(key(from), peer);
      if (!join.reached) {
        join.reached = { address: from.address, port: from.port };
        this.log(`${join.name} is connected ${pathName(from.address)}.`);
      }
      return;
    }
    if (!isGamePacket(packet)) return;
    let peer = this.byAddress.get(key(from));
    if (!peer) {
      // someone joining with the address rather than the code
      if (this.peers.size >= MAX_PEERS) return;
      peer = new Peer(this, { address: from.address, port: from.port });
      this.peers.add(peer);
      this.byAddress.set(key(from), peer);
    }
    // answer from wherever the player sends from now
    if (!peer.route.relay) peer.route = { address: from.address, port: from.port };
    peer.toGame(packet);
  }

  tick() {
    const now = Date.now();
    for (const join of this.joins.values()) {
      const age = now - join.started;
      // punch while the joiner does; then keep the path open until their game is on it
      if (!join.reached && age < PUNCH_FOR + 1000 && now - join.punchedAt >= PUNCH_EVERY) {
        join.punchedAt = now;
        for (const target of join.candidates) this.socket.send(punchPacket(HELLO, join.secret), target.port, target.address);
      } else if (join.reached && age < KEEP_FOR && now - (join.peer?.sent || 0) >= KEEP_EVERY && now - join.punchedAt >= KEEP_EVERY) {
        join.punchedAt = now;
        this.socket.send(punchPacket(KEEP, join.secret), join.reached.port, join.reached.address);
      }
      if (!join.peer && age > 10 * 60 * 1000) this.joins.delete(join.id);
    }
    for (const peer of this.peers) if (now - Math.max(peer.heard, peer.sent) > PEER_IDLE) this.dropPeer(peer);
    // a public room's line in the list: the game's own answer to a probe
    if (this.isPublic && this.ws && !this.reporting && now >= this.statusAt) {
      this.reporting = true;
      multiplayer.probe('127.0.0.1', this.gamePort, { timeout: 1500, attempts: 3 }).then(info => {
        send(this.ws, { type: 'status', players: info.players, maxPlayers: info.maxPlayers, status: info.status, open: info.open });
        if (!this.listed) {
          this.listed = true;
          this.log('Your game is in the public list: anyone can join it from their Multiplayer window.');
        }
        this.statusAt = Date.now() + STATUS_EVERY;
      }, () => { this.statusAt = Date.now() + STATUS_RETRY; }).finally(() => { this.reporting = false; });
    }
    if (this.ws && now - this.pingAt >= PING_EVERY) {
      this.pingAt = now;
      send(this.ws, 'ping');
    }
    // the router may give the port another public address after a quiet while
    if (this.ws && !this.stunning && now - this.stunAt >= RESTUN_EVERY) {
      this.stunning = true;
      this.stunAt = now;
      candidates(this.socket, { servers: this.servers, lan: this.lan }).then(list => {
        if (list.length && JSON.stringify(list) !== JSON.stringify(this.candidates)) {
          this.candidates = list;
          send(this.ws, this.hello());
        }
      }).finally(() => { this.stunning = false; });
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.reconnecting);
    try { this.ws?.close(1000); } catch (_) {}
    for (const peer of this.peers) peer.close();
    this.peers.clear();
    try { this.socket?.close(); } catch (_) {}
  }
}

// Hosts on UDP `port`: the game listens on `room.gamePort`, on this computer
// only. `room.code` is the room code, or null when the room server can't be
// reached (it keeps trying; `onRoom` hears when it has one).
async function host(options) {
  return new HostRoom(options).start();
}

// --- Joining

// Sends HELLOs to `targets` until the other side's HELLO or ACK arrives:
// the address it came from, or null after `ms`.
function punch(socket, targets, secret, ms = PUNCH_FOR) {
  return new Promise(resolve => {
    const hello = punchPacket(HELLO, secret);
    const onMessage = (packet, from) => {
      const got = readPunch(packet);
      if (!got || got.secret !== secret || (got.type !== HELLO && got.type !== ACK)) return;
      if (got.type === HELLO) socket.send(punchPacket(ACK, secret), from.port, from.address);
      finish({ address: from.address, port: from.port });
    };
    const sendAll = () => { for (const target of targets) socket.send(hello, target.port, target.address); };
    const timer = setInterval(sendAll, PUNCH_EVERY);
    const stop = setTimeout(() => finish(null), ms);
    function finish(value) {
      clearInterval(timer);
      clearTimeout(stop);
      socket.off('message', onMessage);
      resolve(value);
    }
    socket.on('message', onMessage);
    sendAll();
  });
}

class JoinLink {
  constructor({ code, name, url = serverUrl(), WebSocketImpl = globalThis.WebSocket, log = () => {}, servers, lan, punchFor = PUNCH_FOR }) {
    Object.assign(this, { code, name, url, WebSocketImpl, log, servers, lan, punchFor });
    this.hostAddresses = new Set();
    this.game = null;
    this.heard = this.sent = this.keptAt = 0;
    this.closed = false;
  }

  async start() {
    this.socket = await bindUdp(0);
    try {
      const list = await candidates(this.socket, { servers: this.servers, lan: this.lan });
      this.ws = await openSocket(`${this.url.replace(/^http/, 'ws')}/v1/rooms/${this.code}/join`, this.WebSocketImpl);
      const hostReply = nextMessage(this.ws, 'host', 'The host closed their game.');
      send(this.ws, { type: 'hello', candidates: list, name: this.name });
      const { secret, candidates: targets } = await hostReply;
      this.secret = secret;
      const path = await punch(this.socket, (targets || []).filter(c => net.isIPv4(c?.address)), secret, this.punchFor);
      if (path) {
        this.path = path;
        this.hostAddresses.add(key(path));
        this.mode = privateAddress(path.address) ? 'lan' : 'direct';
      } else {
        await this.useRelay('punch');
      }
      this.local = await bindUdp(0, '127.0.0.1');
      this.local.on('message', (packet, from) => this.fromGame(packet, from));
      this.socket.on('message', (packet, from) => this.fromInternet(packet, from));
      this.ws.addEventListener('message', event => this.fromServer(readMessage(event.data)));
      this.ws.addEventListener('close', () => {
        if (!this.closed && this.mode === 'relay') this.log('The relay closed: the host\'s game has probably closed.');
      });
      this.heard = this.pingAt = Date.now();
      this.timer = setInterval(() => this.tick(), 250);
      this.localPort = this.local.address().port;
      return this;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  // `reason`: 'punch' (punching failed) or 'lost' (the direct path stopped working)
  async useRelay(reason) {
    const reply = nextMessage(this.ws, 'relay', 'The host closed their game.');
    send(this.ws, { type: 'relay', reason });
    await reply;
    this.mode = 'relay';
  }

  fromGame(packet, from) {
    if (from.address !== '127.0.0.1') return;
    this.game = { address: from.address, port: from.port };
    this.sent = Date.now();
    if (this.mode === 'relay') send(this.ws, packet);
    else this.socket.send(packet, this.path.port, this.path.address);
  }

  toGame(packet) {
    this.heard = Date.now();
    if (this.game) this.local.send(packet, this.game.port, this.game.address);
  }

  fromInternet(packet, from) {
    const got = readPunch(packet);
    if (got) {
      // the host's other addresses can still answer a punch
      if (got.secret !== this.secret) return;
      if (got.type === HELLO) this.socket.send(punchPacket(ACK, this.secret), from.port, from.address);
      if (got.type === HELLO || got.type === ACK) this.hostAddresses.add(key(from));
      return;
    }
    if (this.mode !== 'relay' && isGamePacket(packet) && this.hostAddresses.has(key(from))) this.toGame(packet);
  }

  fromServer(msg) {
    if (Buffer.isBuffer(msg) && this.mode === 'relay') this.toGame(msg);
  }

  tick() {
    const now = Date.now();
    if (now - this.pingAt >= PING_EVERY) {
      this.pingAt = now;
      send(this.ws, 'ping');
    }
    if (this.mode === 'relay') return;
    // keep the path open until the game is on it
    if (now - this.sent >= KEEP_EVERY && now - this.keptAt >= KEEP_EVERY) {
      this.keptAt = now;
      this.socket.send(punchPacket(KEEP, this.secret), this.path.port, this.path.address);
    }
    // the game is talking but nothing comes back: the direct path broke (tried once)
    if (!this.switched && this.game && now - this.sent < 1000 && now - this.heard > QUIET_SWITCH) {
      this.switched = true;
      this.log('The direct connection to the host stopped working. Switching to the relay…');
      this.useRelay('lost').then(() => { this.heard = Date.now(); this.log('Connected through the relay, which adds a little delay.'); },
        error => this.log(`Couldn't switch to the relay: ${error.message}`));
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    try { this.ws?.close(1000); } catch (_) {}
    try { this.socket?.close(); } catch (_) {}
    try { this.local?.close(); } catch (_) {}
  }
}

// Joins room `code`: a link whose `localPort` the game joins on this
// computer, and `mode` how it reaches the host ('lan', 'direct' or 'relay').
async function join(options) {
  return new JoinLink(options).start();
}

module.exports = { parseRoomCode, formatRoomCode, serverUrl, lookup, listPublic, host, join, punchPacket, readPunch, candidates,
  freeLoopbackPort, HELLO, ACK, KEEP };
