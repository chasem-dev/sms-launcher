'use strict';

// The game's collision files (.col, e.g. map/map.col): the stage's solid
// ground, walls and water as triangles, in groups that share a ground type.
//
// Header: u32 vertex count, u32 vertex offset, u32 group count, u32 group
// offset. Vertices are three big-endian floats. Each 0x18-byte group: u16
// ground type, s16 triangle count, u16 flags (bit 0: each triangle carries a
// s16 value), u16 0xffff, then offsets to its triangles' vertex indexes (3 x
// u16 each), two per-triangle bytes, and the per-triangle values.

const MAX_GROUP = 0x7fff;

function readGroups(buffer) {
  const vertexCount = buffer.readUInt32BE(0), vertexAt = buffer.readUInt32BE(4);
  const groupCount = buffer.readUInt32BE(8), groupAt = buffer.readUInt32BE(12);
  if (vertexAt + vertexCount * 12 > buffer.length || groupAt + groupCount * 0x18 > buffer.length)
    throw new Error('A ground file on the game disc appears to be damaged.');
  const groups = [];
  for (let g = 0; g < groupCount; g++) {
    const o = groupAt + g * 0x18;
    const group = {
      type: buffer.readUInt16BE(o), count: buffer.readInt16BE(o + 2), flags: buffer.readUInt16BE(o + 4), pad: buffer.readUInt16BE(o + 6),
      indexAt: buffer.readUInt32BE(o + 8), byteAAt: buffer.readUInt32BE(o + 12), byteBAt: buffer.readUInt32BE(o + 16), valueAt: buffer.readUInt32BE(o + 20),
    };
    if (group.count < 0 || group.indexAt + group.count * 6 > buffer.length) throw new Error('A ground file on the game disc appears to be damaged.');
    groups.push(group);
  }
  return { vertexCount, vertexAt, groups };
}

// Every triangle, in file order: { a, b, c, type, flags, byteA, byteB, value }.
function triangles(buffer) {
  const { groups } = readGroups(buffer);
  const out = [];
  for (const group of groups)
    for (let i = 0; i < group.count; i++)
      out.push({
        a: buffer.readUInt16BE(group.indexAt + i * 6), b: buffer.readUInt16BE(group.indexAt + i * 6 + 2), c: buffer.readUInt16BE(group.indexAt + i * 6 + 4),
        type: group.type, flags: group.flags, pad: group.pad,
        byteA: buffer[group.byteAAt + i], byteB: buffer[group.byteBAt + i],
        value: group.flags & 1 ? buffer.readInt16BE(group.valueAt + i * 2) : 0,
      });
  return out;
}

// A ground type with its sound: the type in the upper bits, the per-triangle
// sound byte (footsteps and landing effects) in the lowest 8.
const surfaceCode = (type, sound) => type * 256 + sound;

// The triangles as a flat position list (9 floats each) and each one's surface code.
function parse(buffer) {
  const { vertexCount, vertexAt } = readGroups(buffer);
  const list = triangles(buffer);
  const position = new Float32Array(list.length * 9), codes = new Uint32Array(list.length);
  list.forEach((t, i) => {
    for (const [k, v] of [t.a, t.b, t.c].entries()) {
      if (v >= vertexCount) throw new Error('A ground file on the game disc appears to be damaged.');
      position[i * 9 + k * 3] = buffer.readFloatBE(vertexAt + v * 12);
      position[i * 9 + k * 3 + 1] = buffer.readFloatBE(vertexAt + v * 12 + 4);
      position[i * 9 + k * 3 + 2] = buffer.readFloatBE(vertexAt + v * 12 + 8);
    }
    codes[i] = surfaceCode(t.type, t.byteA);
  });
  return { position, codes };
}

// The file with some triangles given new surfaces ({ triangle index: surface
// code }). Triangles are regrouped by type; a repainted triangle takes the
// flags and value the file already uses for its new type, or the given defaults.
function paint(buffer, changes, defaults = {}) {
  return compose(buffer, { changes, defaults });
}

// The file rebuilt: its own triangles (with `clear`, only those whose type
// `keep` accepts), repainted as in `paint`, plus `add`ed ones ({ p: [[x, y, z] × 3], code }) with their
// corners welded. Added triangles face the way their corners turn
// counter-clockwise, as the game's floors do seen from above.
function compose(buffer, { changes = {}, defaults = {}, clear = false, keep = () => false, add = [] } = {}) {
  const own = buffer ? triangles(buffer) : [];
  const usual = new Map();  // type -> { flags, byteB, value } as the file has it
  for (const t of own) if (!usual.has(t.type)) usual.set(t.type, { flags: t.flags, byteB: t.byteB, value: t.value });
  const like = type => usual.get(type) || { flags: 0, byteB: 0, value: 0, ...defaults[type] };
  const list = clear ? own.filter(t => keep(t.type)) : own;
  if (!clear) for (const [index, code] of Object.entries(changes)) {
    const t = list[Number(index)], type = Math.floor(code / 256), byteA = code & 0xff;
    if (!t || (t.type === type && t.byteA === byteA)) continue;
    if (t.type !== type) Object.assign(t, { type, flags: like(type).flags, byteB: like(type).byteB, value: like(type).value });
    t.byteA = byteA;
  }
  const chunks = [];
  let vertexCount = 0;
  if (buffer && (!clear || list.length)) {
    const { vertexCount: count, vertexAt } = readGroups(buffer);
    chunks.push(buffer.subarray(vertexAt, vertexAt + count * 12));
    vertexCount = count;
  }
  if (add.length) {
    const welded = new Map(), extra = [];
    const vertex = ([x, y, z]) => {
      const key = `${Math.round(x * 4)},${Math.round(y * 4)},${Math.round(z * 4)}`;
      if (!welded.has(key)) { welded.set(key, vertexCount + extra.length / 3); extra.push(x, y, z); }
      return welded.get(key);
    };
    for (const { p, code } of add) {
      const type = Math.floor(code / 256), [a, b, c] = p.map(vertex);
      if (a === b || b === c || a === c) continue;
      list.push({ a, b, c, type, flags: like(type).flags, pad: 0xffff, byteA: code & 0xff, byteB: like(type).byteB, value: like(type).value });
    }
    const bytes = Buffer.alloc(extra.length * 4);
    extra.forEach((v, i) => bytes.writeFloatBE(v, i * 4));
    chunks.push(bytes);
    vertexCount += extra.length / 3;
  }
  if (vertexCount > 0xffff) throw new Error('The stage has too much ground for the game to hold. Remove some built pieces.');
  return write(Buffer.concat(chunks), vertexCount, list);
}

// Groups in ground type order, as the game's files have them.
function write(vertices, vertexCount, list) {
  const byKey = new Map();
  for (const t of list) {
    const key = `${t.type}:${t.flags}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(t);
  }
  const groups = [];
  for (const [key, tris] of [...byKey].sort((a, b) => a[1][0].type - b[1][0].type || a[1][0].flags - b[1][0].flags))
    for (let i = 0; i < tris.length; i += MAX_GROUP) groups.push({ key, tris: tris.slice(i, i + MAX_GROUP) });

  const groupAt = 0x10, vertexAt = groupAt + groups.length * 0x18;
  let at = vertexAt + vertexCount * 12;
  for (const g of groups) { g.indexAt = at; at += g.tris.length * 6; }
  for (const g of groups) { g.byteAAt = at; at += g.tris.length; }
  for (const g of groups) { g.byteBAt = at; at += g.tris.length; }
  at = Math.ceil(at / 2) * 2;
  for (const g of groups) { g.valueAt = g.tris[0].flags & 1 ? at : 0; if (g.valueAt) at += g.tris.length * 2; }
  const out = Buffer.alloc(Math.ceil(at / 4) * 4);
  out.writeUInt32BE(vertexCount, 0);
  out.writeUInt32BE(vertexAt, 4);
  out.writeUInt32BE(groups.length, 8);
  out.writeUInt32BE(groupAt, 12);
  Buffer.from(vertices).copy(out, vertexAt);
  groups.forEach((g, n) => {
    const o = groupAt + n * 0x18, first = g.tris[0];
    out.writeUInt16BE(first.type, o);
    out.writeInt16BE(g.tris.length, o + 2);
    out.writeUInt16BE(first.flags, o + 4);
    out.writeUInt16BE(first.pad ?? 0xffff, o + 6);
    out.writeUInt32BE(g.indexAt, o + 8);
    out.writeUInt32BE(g.byteAAt, o + 12);
    out.writeUInt32BE(g.byteBAt, o + 16);
    out.writeUInt32BE(g.valueAt, o + 20);
    g.tris.forEach((t, i) => {
      out.writeUInt16BE(t.a, g.indexAt + i * 6);
      out.writeUInt16BE(t.b, g.indexAt + i * 6 + 2);
      out.writeUInt16BE(t.c, g.indexAt + i * 6 + 4);
      out[g.byteAAt + i] = t.byteA;
      out[g.byteBAt + i] = t.byteB;
      if (g.valueAt) out.writeInt16BE(t.value, g.valueAt + i * 2);
    });
  });
  return out;
}

module.exports = { parse, paint, compose, triangles, surfaceCode };
