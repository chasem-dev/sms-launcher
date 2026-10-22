'use strict';

// Edits a J3D model file (.bmd) in place of its sections, for the world
// editor's exports: shapes can lose triangles (ground repainted with another
// texture) and new shapes, materials and textures can be added (painted
// ground, built pieces, copied buildings). Sections the edit doesn't touch
// are written back byte for byte, and existing shapes keep their own display
// lists unless triangles were taken out of them.
//
// Layout notes (J3D2bmd3): INF1 is the scene graph (joint, material and
// shape nodes); VTX1 holds the vertex arrays every shape indexes into; SHP1
// the shapes with their vertex descriptors, matrix tables and display lists;
// MAT3 the materials as rows of indexes into shared tables; TEX1 the textures.

const POS = 9, NRM = 10, CLR0 = 11, TEX0 = 13;
const VTX_SLOTS = { 9: 0, 10: 1, 11: 3, 12: 4, 13: 5, 14: 6, 15: 7, 16: 8, 17: 9, 18: 10, 19: 11, 20: 12 };
const MAT_ENTRY = 0x14c, IND_ENTRY = 0x138;

const align = (n, to) => Math.ceil(n / to) * to;
function pad(buffer, to) {
  const size = align(buffer.length, to);
  return size === buffer.length ? buffer : Buffer.concat([buffer, Buffer.alloc(size - buffer.length)]);
}

function sections(data) {
  const list = [];
  for (let at = 0x20, i = data.readUInt32BE(0x0c); i > 0 && at + 8 <= data.length; i--) {
    const size = data.readUInt32BE(at + 4);
    list.push({ magic: data.toString('ascii', at, at + 4), data: data.subarray(at, at + size) });
    at += size;
  }
  return list;
}

// J3D's name table: count, then a hash and offset per name, then the names.
function readNames(data, at) {
  const names = [];
  for (let i = 0, count = data.readUInt16BE(at); i < count; i++) {
    const start = at + data.readUInt16BE(at + 4 + i * 4 + 2);
    names.push(data.toString('latin1', start, data.indexOf(0, start)));
  }
  return names;
}
function nameHash(name) {
  let hash = 0;
  for (const c of Buffer.from(name, 'latin1')) hash = (hash * 3 + c) & 0xffff;
  return hash;
}
function writeNames(names) {
  const head = 4 + names.length * 4;
  const strings = names.map(name => Buffer.concat([Buffer.from(name, 'latin1'), Buffer.alloc(1)]));
  const out = Buffer.alloc(head + strings.reduce((n, s) => n + s.length, 0));
  out.writeUInt16BE(names.length, 0);
  out.writeUInt16BE(0xffff, 2);
  let at = head;
  names.forEach((name, i) => {
    out.writeUInt16BE(nameHash(name), 4 + i * 4);
    out.writeUInt16BE(at, 4 + i * 4 + 2);
    strings[i].copy(out, at);
    at += strings[i].length;
  });
  return out;
}

// --- Vertex arrays ---------------------------------------------------------

function componentSize(type) { return [1, 1, 2, 2, 4][type] ?? 4; }
const COLOR_SIZE = [2, 3, 4, 2, 3, 4];

function readVertexFormats(vtx) {
  const formats = [];
  for (let f = vtx.readUInt32BE(8); vtx.readUInt32BE(f) !== 0xff; f += 16)
    formats.push({ attr: vtx.readUInt32BE(f), count: vtx.readUInt32BE(f + 4), type: vtx.readUInt32BE(f + 8), frac: vtx[f + 12], raw: vtx.subarray(f, f + 16) });
  return formats;
}
function elementSize(format) {
  if (format.attr === CLR0 || format.attr === CLR0 + 1) return COLOR_SIZE[format.type] ?? 4;
  const width = format.attr === POS ? (format.count ? 3 : 2) : format.attr === NRM ? (format.count ? 9 : 3) : (format.count ? 2 : 1);
  return width * componentSize(format.type);
}
function encodeElement(format, values) {
  const out = Buffer.alloc(elementSize(format));
  if (format.attr === CLR0 || format.attr === CLR0 + 1) {
    const [r, g, b, a = 255] = values.map(v => Math.max(0, Math.min(255, Math.round(v))));
    if (format.type === 0) out.writeUInt16BE(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3), 0);
    else if (format.type === 1 || format.type === 2) { out[0] = r; out[1] = g; out[2] = b; if (format.type === 2) out[3] = 255; }
    else if (format.type === 3) out.writeUInt16BE(((r >> 4) << 12) | ((g >> 4) << 8) | ((b >> 4) << 4) | (a >> 4), 0);
    else if (format.type === 4) { const v = ((r >> 2) << 18) | ((g >> 2) << 12) | ((b >> 2) << 6) | (a >> 2); out[0] = v >> 16; out[1] = (v >> 8) & 0xff; out[2] = v & 0xff; }
    else { out[0] = r; out[1] = g; out[2] = b; out[3] = a; }
    return out;
  }
  const size = componentSize(format.type), scale = format.type === 4 ? 1 : 1 << format.frac;
  const width = out.length / size;
  for (let i = 0; i < width; i++) {
    const v = (values[i] ?? 0) * scale, o = i * size;
    if (format.type === 4) out.writeFloatBE(values[i] ?? 0, o);
    else if (format.type === 0) out[o] = Math.max(0, Math.min(255, Math.round(v)));
    else if (format.type === 1) out.writeInt8(Math.max(-128, Math.min(127, Math.round(v))), o);
    else if (format.type === 2) out.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(v))), o);
    else out.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round(v))), o);
  }
  return out;
}

// --- The model ---------------------------------------------------------------

class BmdEdit {
  constructor(data) {
    if (data.toString('ascii', 0, 8) !== 'J3D2bmd3') throw new Error('Only stage models (.bmd) can be edited.');
    this.header = Buffer.from(data.subarray(0, 0x20));
    this.sections = sections(data);
    const get = magic => this.sections.find(s => s.magic === magic)?.data;
    for (const magic of ['INF1', 'VTX1', 'DRW1', 'JNT1', 'SHP1', 'MAT3', 'TEX1']) if (!get(magic)) throw new Error(`This model has no ${magic} section.`);
    this.readHierarchy(get('INF1'));
    this.readVertices(get('VTX1'));
    this.readDraw(get('DRW1'));
    this.readJoints(get('JNT1'));
    this.readShapes(get('SHP1'));
    this.readMaterials(get('MAT3'));
    this.readTextures(get('TEX1'));
  }

  // INF1: the node stream, plus which joint and material each shape hangs under.
  readHierarchy(inf) {
    this.inf = inf;
    this.nodes = [];
    const stack = [];
    let joint = -1, material = -1;
    this.shapeOwner = new Map();
    for (let p = inf.readUInt32BE(0x14); ; p += 4) {
      const type = inf.readUInt16BE(p), index = inf.readUInt16BE(p + 2);
      this.nodes.push({ type, index });
      if (type === 0) break;
      if (type === 1) stack.push({ joint, material });
      else if (type === 2) ({ joint, material } = stack.pop() || { joint: -1, material: -1 });
      else if (type === 0x10) joint = index;
      else if (type === 0x11) material = index;
      else if (type === 0x12) this.shapeOwner.set(index, { joint, material });
    }
    this.inserts = [];  // { joint, material, shape }
  }

  readVertices(vtx) {
    this.vtx = vtx;
    this.formats = readVertexFormats(vtx);
    const offsets = Array.from({ length: 13 }, (_, i) => vtx.readUInt32BE(0x0c + i * 4));
    this.arrays = new Map();  // attr -> { format, bytes, count, added: [] }
    for (const format of this.formats) {
      const slot = VTX_SLOTS[format.attr], start = offsets[slot];
      if (slot === undefined || !start) continue;
      const next = offsets.slice(slot + 1).find(o => o) || vtx.length;
      const bytes = vtx.subarray(start, next), size = elementSize(format);
      this.arrays.set(format.attr, { format, bytes, size, count: Math.ceil(bytes.length / size), added: [] });
    }
  }

  // Adds one vertex value to an attribute's array; returns its index.
  addVertex(attr, values) {
    const array = this.arrays.get(attr);
    if (!array) throw new Error(`This model has no vertex array for attribute ${attr}.`);
    const index = array.count + array.added.length;
    if (index > 0xffff) throw new Error('The stage model is too big to add more to.');
    array.added.push(encodeElement(array.format, values));
    return index;
  }
  hasArray(attr) { return this.arrays.has(attr); }

  readDraw(drw) {
    this.drw = drw;
    const count = drw.readUInt16BE(8), weighted = drw.readUInt32BE(0x0c), index = drw.readUInt32BE(0x10);
    this.draw = Array.from({ length: count }, (_, i) => ({ weighted: drw[weighted + i] === 1, index: drw.readUInt16BE(index + i * 2) }));
  }

  readJoints(jnt) {
    this.jnt = Buffer.from(jnt);
    const count = jnt.readUInt16BE(8), entries = jnt.readUInt32BE(0x0c), remap = jnt.readUInt32BE(0x10);
    this.joints = Array.from({ length: count }, (_, i) => entries + jnt.readUInt16BE(remap + i * 2) * 0x40);
  }
  // Grows a joint's bounds so the game doesn't cull geometry added under it.
  growJoint(joint, min, max) {
    const at = this.joints[joint];
    if (at === undefined) return;
    const j = this.jnt;
    for (let k = 0; k < 3; k++) {
      j.writeFloatBE(Math.min(j.readFloatBE(at + 0x28 + k * 4), min[k]), at + 0x28 + k * 4);
      j.writeFloatBE(Math.max(j.readFloatBE(at + 0x34 + k * 4), max[k]), at + 0x34 + k * 4);
    }
    const radius = Math.max(...[0, 1, 2].map(k => Math.max(Math.abs(j.readFloatBE(at + 0x28 + k * 4)), Math.abs(j.readFloatBE(at + 0x34 + k * 4)))));
    j.writeFloatBE(Math.max(j.readFloatBE(at + 0x24), radius * Math.sqrt(3)), at + 0x24);
  }

  // SHP1: each shape with its descriptor, packets (matrix table + triangles of
  // raw attribute indexes, in the game's winding) and original bytes.
  readShapes(shp) {
    this.shp = shp;
    const count = shp.readUInt16BE(8), off = k => shp.readUInt32BE(0x0c + k * 4);
    const entries = off(0), remap = off(1), descs = off(3), matrixTable = off(4), dlData = off(5), matrixData = off(6), packets = off(7);
    this.shapes = Array.from({ length: count }, (_, s) => {
      const e = entries + shp.readUInt16BE(remap + s * 2) * 0x28;
      const packetCount = shp.readUInt16BE(e + 2), descAt = descs + shp.readUInt16BE(e + 4);
      const firstMatrix = shp.readUInt16BE(e + 6), firstPacket = shp.readUInt16BE(e + 8);
      const attrs = [];
      for (let a = descAt; shp.readUInt32BE(a) !== 0xff; a += 8) attrs.push({ attr: shp.readUInt32BE(a), type: shp.readUInt32BE(a + 4) });
      const shapePackets = [];
      for (let p = 0; p < packetCount; p++) {
        const md = matrixData + (firstMatrix + p) * 8, mCount = shp.readUInt16BE(md + 2), mFirst = shp.readUInt32BE(md + 4);
        const matrices = Array.from({ length: mCount }, (_, i) => shp.readUInt16BE(matrixTable + (mFirst + i) * 2));
        const loc = packets + (firstPacket + p) * 8, size = shp.readUInt32BE(loc), start = dlData + shp.readUInt32BE(loc + 4);
        shapePackets.push({ use: shp.readUInt16BE(md), matrices, list: shp.subarray(start, start + size), triangles: null });
      }
      return { entry: Buffer.from(shp.subarray(e, e + 0x28)), attrs, packets: shapePackets, changed: false, ...this.shapeOwner.get(s) };
    });
  }

  // A packet's triangles as vertex records ({ attr: index }), in the order the
  // world editor's model reader (j3d.js) numbers them.
  triangles(shape, packet) {
    if (packet.triangles) return packet.triangles;
    const list = packet.list, tris = [];
    for (let q = 0; q < list.length;) {
      const op = list[q++];
      if (op !== 0x90 && op !== 0x98 && op !== 0xa0) { if (op === 0) continue; break; }
      const n = list.readUInt16BE(q); q += 2;
      const strip = [];
      for (let v = 0; v < n; v++) {
        const vert = {};
        for (const { attr, type } of shape.attrs) {
          vert[attr] = type === 3 ? list.readUInt16BE(q) : list[q];
          q += type === 3 ? 2 : 1;
        }
        strip.push(vert);
      }
      // Kept in the game's (clockwise) order: [a, b, c] as drawn.
      if (op === 0x90) for (let i = 0; i + 2 < n; i += 3) tris.push([strip[i], strip[i + 1], strip[i + 2]]);
      else if (op === 0x98) for (let i = 2; i < n; i++) tris.push(i & 1 ? [strip[i - 1], strip[i - 2], strip[i]] : [strip[i - 2], strip[i - 1], strip[i]]);
      else for (let i = 2; i < n; i++) tris.push([strip[0], strip[i - 1], strip[i]]);
    }
    packet.triangles = tris;
    return tris;
  }

  // Every triangle of a shape with its packet, numbered as j3d.js numbers them.
  shapeTriangles(index) {
    const shape = this.shapes[index], out = [];
    shape.packets.forEach((packet, p) => { for (const tri of this.triangles(shape, packet)) out.push({ packet: p, tri }); });
    return out;
  }

  // Takes the numbered triangles out of a shape.
  removeTriangles(index, numbers) {
    const shape = this.shapes[index], drop = new Set(numbers);
    let n = 0;
    for (const packet of shape.packets) {
      const tris = this.triangles(shape, packet);
      packet.triangles = tris.filter(() => !drop.has(n++));
    }
    shape.changed = true;
  }

  // A new shape: `attrs` as a descriptor ([{ attr, type }], indexes 16-bit),
  // packets of { matrices, triangles: [[vertex record × 3]] } in game winding.
  addShape({ attrs, packets, joint, material, bounds }) {
    const index = this.shapes.length;
    const entry = Buffer.alloc(0x28);
    entry[0] = 0;  // one matrix per packet
    entry[1] = 0xff;
    entry.writeUInt16BE(0xffff, 0x0a);
    const { min, max } = bounds;
    const radius = Math.hypot(...[0, 1, 2].map(k => Math.max(Math.abs(min[k]), Math.abs(max[k]))));
    entry.writeFloatBE(radius, 0x0c);
    for (let k = 0; k < 3; k++) { entry.writeFloatBE(min[k], 0x10 + k * 4); entry.writeFloatBE(max[k], 0x1c + k * 4); }
    // A single-matrix shape draws with the matrix its packet names first
    // (J3DShapeMtx's use index), not 0xffff.
    this.shapes.push({ entry, attrs, packets: packets.map(p => ({ use: p.use ?? p.matrices.find(m => m !== 0xffff) ?? 0, matrices: p.matrices, list: null, triangles: p.triangles })), changed: true, joint, material });
    this.inserts.push({ joint, material, shape: index });
    this.growJoint(joint, min, max);
    return index;
  }

  // MAT3: materials are rows of indexes into shared tables. New ones copy a
  // row (and its indirect-texture row), optionally pointing texture slot 0 at
  // another texture.
  readMaterials(mat) {
    this.mat = mat;
    this.materialCount = mat.readUInt16BE(8);
    const offsets = Array.from({ length: 30 }, (_, k) => mat.readUInt32BE(0x0c + k * 4));
    const sorted = [...new Set(offsets.filter(Boolean))].sort((a, b) => a - b);
    this.matTables = offsets.map(start => {
      if (!start) return null;
      const end = sorted.find(o => o > start) ?? mat.length;
      return { bytes: mat.subarray(start, end), extra: [] };
    });
    this.materialNames = readNames(mat, offsets[2]);
    this.addedMaterials = [];  // { row, indirect, name }
  }
  materialName(index) { return index < this.materialCount ? this.materialNames[index] : this.addedMaterials[index - this.materialCount].name; }
  materialRow(index) {
    const remap = this.matTables[1].bytes, rows = this.matTables[0].bytes;
    if (index >= this.materialCount) return Buffer.from(this.addedMaterials[index - this.materialCount].row);
    const at = remap.readUInt16BE(index * 2) * MAT_ENTRY;
    return Buffer.from(rows.subarray(at, at + MAT_ENTRY));
  }
  // The TEX1 index a material's texture slot uses, or -1.
  materialTexture(index, slot = 0) {
    const row = this.materialRow(index), at = row.readUInt16BE(0x84 + slot * 2);
    if (at === 0xffff) return -1;
    return this.textureSlot(at);
  }
  textureSlot(at) {
    const table = this.matTables[15];
    const base = table.bytes.length / 2;
    return at < base ? table.bytes.readUInt16BE(at * 2) : table.extra[at - base];
  }
  // `cutout` gives it an alpha test, so its texture's see-through parts are
  // cut away (grass fringes), as GX_GEQUAL 128 AND GX_LEQUAL 255.
  cloneMaterial(template, { texture = null, name = null, cutout = false } = {}) {
    const row = this.materialRow(template);
    if (cutout) row.writeUInt16BE(this.alphaCompare([6, 128, 0, 3, 255]), 0x146);
    if (texture !== null) {
      const table = this.matTables[15];
      const slot = Math.floor(table.bytes.length / 2) + table.extra.length;
      table.extra.push(texture);
      row.writeUInt16BE(slot, 0x84);
    }
    const ind = this.matTables[3];
    let indirect = null;
    if (ind) {
      const source = Math.min(template, this.materialCount - 1);
      indirect = Buffer.from(ind.bytes.subarray(source * IND_ENTRY, source * IND_ENTRY + IND_ENTRY));
      if (indirect.length < IND_ENTRY) indirect = null;
    }
    const index = this.materialCount + this.addedMaterials.length;
    this.addedMaterials.push({ row, indirect, name: name || `${this.materialName(template)}_${index}` });
    return index;
  }

  // An alpha compare entry (comp0, ref0, op, comp1, ref1): the table's own if
  // it has one, else one added.
  alphaCompare(entry) {
    const table = this.matTables[24], count = Math.floor(table.bytes.length / 8);
    for (let i = 0; i < count; i++) if (entry.every((v, k) => table.bytes[i * 8 + k] === v)) return i;
    const known = table.extra.findIndex(e => e.every((v, k) => v === entry[k]));
    if (known >= 0) return count + known;
    table.extra.push(entry);
    return count + table.extra.length - 1;
  }

  // TEX1: BTI headers (0x20 bytes, offsets relative to each header), their
  // data, then a name table.
  readTextures(tex) {
    this.tex = tex;
    this.textureCount = tex.readUInt16BE(8);
    this.textureNames = readNames(tex, tex.readUInt32BE(0x10));
    this.addedTextures = [];  // { header, data, palette, name }
  }
  textureName(index) { return index < this.textureCount ? this.textureNames[index] : this.addedTextures[index - this.textureCount].name; }
  findTexture(name) {
    const lower = name.toLowerCase();
    for (let i = 0; i < this.textureCount + this.addedTextures.length; i++) if (this.textureName(i).toLowerCase() === lower) return i;
    return -1;
  }
  // A texture as another file stores it (a BTI header at `h` in `data`, its
  // offsets relative to the header); returns its index here.
  addTexture(data, h, name) {
    const header = Buffer.from(data.subarray(h, h + 0x20));
    const format = data[h], width = data.readUInt16BE(h + 2), height = data.readUInt16BE(h + 4);
    const mipmaps = Math.max(1, data[h + 0x18]);
    let bytes = 0;
    for (let level = 0, w = width, hgt = height; level < mipmaps; level++, w = Math.max(1, w >> 1), hgt = Math.max(1, hgt >> 1)) bytes += textureBytes(format, w, hgt);
    const start = h + data.readUInt32BE(h + 0x1c);
    const paletteCount = data.readUInt16BE(h + 10), paletteAt = h + data.readUInt32BE(h + 12);
    const palette = data[h + 8] && paletteCount ? Buffer.from(data.subarray(paletteAt, paletteAt + paletteCount * 2)) : null;
    this.addedTextures.push({ header, data: Buffer.from(data.subarray(start, start + bytes)), palette, name });
    return this.textureCount + this.addedTextures.length - 1;
  }

  // --- Writing ---

  write() {
    const out = [];
    const built = { INF1: this.writeHierarchy(), VTX1: this.writeVertices(), JNT1: this.jnt, SHP1: this.writeShapes(), MAT3: this.writeMaterials(), TEX1: this.writeTextures() };
    for (const section of this.sections) out.push(pad(built[section.magic] ? fixSize(built[section.magic]) : Buffer.from(section.data), 32));
    const body = Buffer.concat(out);
    const header = Buffer.from(this.header);
    header.writeUInt32BE(0x20 + body.length, 8);
    return Buffer.concat([header, body]);
  }

  writeHierarchy() {
    const nodes = [];
    // New shapes go under their joint, right after the joint opens its children.
    const byJoint = new Map();
    for (const insert of this.inserts) {
      if (!byJoint.has(insert.joint)) byJoint.set(insert.joint, []);
      byJoint.get(insert.joint).push(insert);
    }
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i];
      nodes.push(node);
      if (node.type === 0x10 && this.nodes[i + 1]?.type === 1 && byJoint.has(node.index)) {
        nodes.push(this.nodes[++i]);
        for (const insert of byJoint.get(node.index)) nodes.push({ type: 0x11, index: insert.material }, { type: 1, index: 0 }, { type: 0x12, index: insert.shape }, { type: 2, index: 0 });
        byJoint.delete(node.index);
      }
    }
    if (byJoint.size) throw new Error('A joint for added geometry has no children in the model.');
    const start = this.inf.readUInt32BE(0x14);
    const head = Buffer.from(this.inf.subarray(0, start));
    const stream = Buffer.alloc(nodes.length * 4);
    nodes.forEach((node, i) => { stream.writeUInt16BE(node.type, i * 4); stream.writeUInt16BE(node.index, i * 4 + 2); });
    head.writeUInt32BE(this.shapes.reduce((n, s) => n + s.packets.length, 0), 0x0c);
    head.writeUInt32BE(this.arrays.get(POS) ? this.arrays.get(POS).count + this.arrays.get(POS).added.length : head.readUInt32BE(0x10), 0x10);
    return Buffer.concat([head, stream]);
  }

  writeVertices() {
    const head = Buffer.from(this.vtx.subarray(0, 0x40));
    const formatAt = this.vtx.readUInt32BE(8);
    const formats = Buffer.from(this.vtx.subarray(formatAt, formatAt + (this.formats.length + 1) * 16));
    const parts = [pad(Buffer.concat([head.subarray(0, formatAt), formats]), 32)];
    let at = parts[0].length;
    for (let i = 0; i < 13; i++) head.writeUInt32BE(0, 0x0c + i * 4);
    const bySlot = [...this.arrays.entries()].sort((a, b) => VTX_SLOTS[a[0]] - VTX_SLOTS[b[0]]);
    for (const [attr, array] of bySlot) {
      head.writeUInt32BE(at, 0x0c + VTX_SLOTS[attr] * 4);
      const original = Buffer.concat([array.bytes, Buffer.alloc(array.count * array.size - array.bytes.length)]);
      const bytes = pad(Buffer.concat([original, ...array.added]), 32);
      parts.push(bytes);
      at += bytes.length;
    }
    head.copy(parts[0], 0, 0, 0x40);
    return Buffer.concat(parts);
  }

  writeShapes() {
    const descTable = [], descOffsets = new Map();
    const matrixTable = [], matrixData = [], lists = [], packetLocs = [], entries = [];
    let descBytes = 0, listBytes = 0;
    for (const shape of this.shapes) {
      const key = shape.attrs.map(a => `${a.attr}/${a.type}`).join(' ');
      if (!descOffsets.has(key)) {
        const desc = Buffer.alloc((shape.attrs.length + 1) * 8);
        shape.attrs.forEach((a, i) => { desc.writeUInt32BE(a.attr, i * 8); desc.writeUInt32BE(a.type, i * 8 + 4); });
        desc.writeUInt32BE(0xff, shape.attrs.length * 8);
        descOffsets.set(key, descBytes);
        descTable.push(desc);
        descBytes += desc.length;
      }
      const entry = Buffer.from(shape.entry);
      entry.writeUInt16BE(shape.packets.length, 2);
      entry.writeUInt16BE(descOffsets.get(key), 4);
      entry.writeUInt16BE(matrixData.length, 6);
      entry.writeUInt16BE(packetLocs.length, 8);
      entries.push(entry);
      for (const packet of shape.packets) {
        const data = Buffer.alloc(8);
        data.writeUInt16BE(packet.use, 0);
        data.writeUInt16BE(packet.matrices.length, 2);
        data.writeUInt32BE(matrixTable.length, 4);
        matrixData.push(data);
        matrixTable.push(...packet.matrices);
        // An emptied packet still calls a display list: 32 bytes of no-ops rather than none.
        let list = pad(packet.triangles && (shape.changed || !packet.list) ? encodeTriangles(shape.attrs, packet.triangles) : packet.list, 32);
        if (!list.length) list = Buffer.alloc(32);
        const loc = Buffer.alloc(8);
        loc.writeUInt32BE(list.length, 0);
        loc.writeUInt32BE(listBytes, 4);
        packetLocs.push(loc);
        lists.push(list);
        listBytes += list.length;
      }
    }
    const remap = Buffer.alloc(this.shapes.length * 2);
    this.shapes.forEach((_, i) => remap.writeUInt16BE(i, i * 2));
    const mtx = Buffer.alloc(matrixTable.length * 2);
    matrixTable.forEach((v, i) => mtx.writeUInt16BE(v, i * 2));
    const tables = [Buffer.concat(entries), remap, null, Buffer.concat(descTable), mtx, Buffer.concat(lists), Buffer.concat(matrixData), Buffer.concat(packetLocs)];
    const head = Buffer.alloc(0x2c);
    head.write('SHP1', 0, 'ascii');
    head.writeUInt16BE(this.shapes.length, 8);
    head.writeUInt16BE(0xffff, 0x0a);
    const parts = [head];
    let at = head.length;
    tables.forEach((table, k) => {
      if (!table) { head.writeUInt32BE(0, 0x0c + k * 4); return; }
      const aligned = align(at, 32);
      if (aligned > at) { parts.push(Buffer.alloc(aligned - at)); at = aligned; }
      head.writeUInt32BE(at, 0x0c + k * 4);
      parts.push(table);
      at += table.length;
    });
    return Buffer.concat(parts);
  }

  writeMaterials() {
    const count = this.materialCount + this.addedMaterials.length;
    const tables = this.matTables.map(t => t && Buffer.from(t.bytes));
    if (this.addedMaterials.length) {
      const rowCount = Math.floor(tables[0].length / MAT_ENTRY);
      const rows = tables[0].subarray(0, rowCount * MAT_ENTRY);
      tables[0] = Buffer.concat([rows, ...this.addedMaterials.map(m => m.row)]);
      const remap = Buffer.alloc(count * 2);
      this.matTables[1].bytes.copy(remap, 0, 0, this.materialCount * 2);
      this.addedMaterials.forEach((_, i) => remap.writeUInt16BE(rowCount + i, (this.materialCount + i) * 2));
      tables[1] = remap;
      tables[2] = writeNames([...this.materialNames, ...this.addedMaterials.map(m => m.name)]);
      if (tables[3]) {
        const own = tables[3].subarray(0, this.materialCount * IND_ENTRY);
        tables[3] = Buffer.concat([own, ...this.addedMaterials.map(m => m.indirect || Buffer.from(own.subarray(0, IND_ENTRY)))]);
      }
    }
    const extra = this.matTables[15]?.extra || [];
    if (extra.length) {
      const base = Math.floor(this.matTables[15].bytes.length / 2);
      const own = this.matTables[15].bytes.subarray(0, base * 2);
      const more = Buffer.alloc(extra.length * 2);
      extra.forEach((t, i) => more.writeUInt16BE(t, i * 2));
      tables[15] = Buffer.concat([own, more]);
    }
    const alphas = this.matTables[24]?.extra || [];
    if (alphas.length) {
      const own = this.matTables[24].bytes.subarray(0, Math.floor(this.matTables[24].bytes.length / 8) * 8);
      tables[24] = Buffer.concat([own, ...alphas.map(e => { const b = Buffer.alloc(8, 0xff); e.forEach((v, k) => { b[k] = v; }); return b; })]);
    }
    const head = Buffer.from(this.mat.subarray(0, 0x84));
    head.writeUInt16BE(count, 8);
    const parts = [head];
    let at = head.length;
    // Tables keep their order in the file; each starts 4-byte aligned.
    const order = this.matTables.map((t, k) => ({ k, start: t ? this.mat.readUInt32BE(0x0c + k * 4) : 0 })).filter(e => e.start).sort((a, b) => a.start - b.start || a.k - b.k);
    for (let k = 0; k < 30; k++) head.writeUInt32BE(0, 0x0c + k * 4);
    for (const { k } of order) {
      const aligned = align(at, 4);
      if (aligned > at) { parts.push(Buffer.alloc(aligned - at)); at = aligned; }
      head.writeUInt32BE(at, 0x0c + k * 4);
      parts.push(tables[k]);
      at += tables[k].length;
    }
    return Buffer.concat(parts);
  }

  writeTextures() {
    if (!this.addedTextures.length) return this.tex;
    const tex = this.tex, headersAt = tex.readUInt32BE(0x0c), namesAt = tex.readUInt32BE(0x10);
    const count = this.textureCount + this.addedTextures.length;
    const headers = Buffer.alloc(count * 0x20);
    const dataStart = headersAt + this.textureCount * 0x20;
    const shift = this.addedTextures.length * 0x20;
    const ownData = tex.subarray(dataStart, namesAt);
    for (let i = 0; i < this.textureCount; i++) {
      const h = Buffer.from(tex.subarray(headersAt + i * 0x20, headersAt + i * 0x20 + 0x20));
      // Offsets are from each header; the data moves down by the added headers.
      if (h.readUInt32BE(0x1c)) h.writeUInt32BE(h.readUInt32BE(0x1c) + shift, 0x1c);
      if (h[8] && h.readUInt32BE(0x0c)) h.writeUInt32BE(h.readUInt32BE(0x0c) + shift, 0x0c);
      h.copy(headers, i * 0x20);
    }
    const chunks = [ownData];
    let at = headersAt + count * 0x20 + ownData.length;
    this.addedTextures.forEach((t, n) => {
      const i = this.textureCount + n, h = Buffer.from(t.header), headerAt = headersAt + i * 0x20;
      if (t.palette) {
        at = align(at, 32);
        chunks.push(Buffer.alloc(at - (headersAt + count * 0x20 + chunks.reduce((s, c) => s + c.length, 0))));
        h.writeUInt32BE(at - headerAt, 0x0c);
        chunks.push(t.palette);
        at += t.palette.length;
      }
      const aligned = align(at, 32);
      chunks.push(Buffer.alloc(aligned - at));
      at = aligned;
      h.writeUInt32BE(at - headerAt, 0x1c);
      chunks.push(t.data);
      at += t.data.length;
      h.copy(headers, i * 0x20);
    });
    const body = Buffer.concat(chunks);
    const namesStart = align(headersAt + count * 0x20 + body.length, 4);
    const head = Buffer.from(tex.subarray(0, headersAt));
    head.writeUInt16BE(count, 8);
    head.writeUInt32BE(namesStart, 0x10);
    const before = Buffer.concat([head, headers, body]);
    return Buffer.concat([before, Buffer.alloc(namesStart - before.length), writeNames([...this.textureNames, ...this.addedTextures.map(t => t.name)])]);
  }
}

function fixSize(section) {
  const out = pad(section, 32);
  out.writeUInt32BE(out.length, 4);
  return out;
}

const BLOCK = { 0: [8, 8, 4], 1: [8, 4, 8], 2: [8, 4, 8], 3: [4, 4, 16], 4: [4, 4, 16], 5: [4, 4, 16], 6: [4, 4, 32], 8: [8, 8, 4], 9: [8, 4, 8], 10: [4, 4, 16], 14: [8, 8, 4] };
function textureBytes(format, width, height) {
  const [bw, bh, bits] = BLOCK[format] || BLOCK[6];
  return Math.ceil(width / bw) * bw * Math.ceil(height / bh) * bh * bits / 8;
}

// Triangles back into a display list: GX_TRIANGLES runs of up to 0xfffe vertices.
function encodeTriangles(attrs, triangles) {
  const vertexSize = attrs.reduce((n, a) => n + (a.type === 3 ? 2 : 1), 0);
  const perDraw = Math.floor(0xfffe / 3);
  const parts = [];
  for (let i = 0; i < triangles.length; i += perDraw) {
    const run = triangles.slice(i, i + perDraw);
    const out = Buffer.alloc(3 + run.length * 3 * vertexSize);
    out[0] = 0x90;
    out.writeUInt16BE(run.length * 3, 1);
    let q = 3;
    for (const tri of run) for (const vert of tri) for (const { attr, type } of attrs) {
      const value = vert[attr] ?? 0;
      if (type === 3) { out.writeUInt16BE(value, q); q += 2; } else out[q++] = value;
    }
    parts.push(out);
  }
  return Buffer.concat(parts);
}

module.exports = { BmdEdit, encodeTriangles, readNames, writeNames, nameHash, POS, NRM, CLR0, TEX0 };
