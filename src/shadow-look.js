'use strict';
// A character's body drawn as Shadow Mario: its own shapes on Mario's skeleton
// with Shadow Mario's materials (the plaza's kagemario/default.bmd: the screen
// seen through him, his shimmer, his scrolling texture). The game draws a
// character's look/default.bmd so (the port's patch zzzzzz-character-04).
//
// The body's chunks are kept but its materials and textures (MAT3, TEX1) are
// Shadow Mario's. J3D binds one shape to each material, so each of the body's
// materials takes one of his: its eyes his eye's, the rest his body's, with
// copies of his after his own when the body has more (the loader wants each
// material that isn't a copy at its own entry, J3DModelLoader::readMaterial),
// and the scene graph's material numbers changed to match. His scrolling
// texture (kagemario_scroll.btk) moves each copy as it moves the one it was
// copied from.
const { hash } = require('./rarc-write');

const align = (n, a) => (n + a - 1) & ~(a - 1);
// A material's indirect texturing (J3DIndInitData), read by its material number, not through the remap
// table: each material needs one of its own.
const IND_SIZE = 0x138;

// The chunks of a J3D file: [{ type, data }], in order.
function chunks(file) {
  const out = [];
  for (let i = 0, at = 0x20, count = file.readUInt32BE(0x0c); i < count; i++) {
    const size = file.readUInt32BE(at + 4);
    out.push({ type: file.toString('ascii', at, at + 4), data: file.subarray(at, at + size) });
    at += size;
  }
  return out;
}

function writeFile(header, list) {
  const out = Buffer.concat([header.subarray(0, 0x20), ...list.map(c => c.data)]);
  out.writeUInt32BE(out.length, 0x08);
  out.writeUInt32BE(list.length, 0x0c);
  return out;
}

function readNames(data, at) {
  const names = [];
  for (let i = 0, count = data.readUInt16BE(at); i < count; i++) {
    const start = at + data.readUInt16BE(at + 4 + i * 4 + 2);
    names.push(data.toString('latin1', start, data.indexOf(0, start)));
  }
  return names;
}

// A J3D name table: count, 0xffff, then a hash and an offset per name, then the names.
function nameTable(names) {
  const head = Buffer.alloc(4 + names.length * 4);
  head.writeUInt16BE(names.length, 0);
  head.writeUInt16BE(0xffff, 2);
  const strings = [];
  let offset = head.length;
  names.forEach((name, i) => {
    head.writeUInt16BE(hash(name), 4 + i * 4);
    head.writeUInt16BE(offset, 6 + i * 4);
    strings.push(Buffer.from(`${name}\0`, 'latin1'));
    offset += name.length + 1;
  });
  return Buffer.concat([head, ...strings]);
}

// A chunk with more appended, 4-byte aligned: returns { data, at } with the offset of each part.
function append(chunk, parts) {
  const pieces = [chunk], at = [];
  let size = chunk.length;
  for (const part of parts) {
    const pad = align(size, 4) - size;
    if (pad) pieces.push(Buffer.alloc(pad));
    size += pad;
    at.push(size);
    pieces.push(part);
    size += part.length;
  }
  pieces.push(Buffer.alloc(align(size, 32) - size));
  const data = Buffer.concat(pieces);
  data.writeUInt32BE(data.length, 4);
  return { data, at };
}

// The materials of the look: his own first, in his order (as many as the body has, at most all of his),
// then copies of his: [{ name, from }] (from: his material). `of` gives the look's material for each of the
// body's: its eyes take his eye's, the rest his body's, then copies of the first of those.
function assign(bodyNames, shadowNames) {
  const eye = name => /eye/i.test(name);
  const materials = shadowNames.slice(0, bodyNames.length).map((name, from) => ({ name, from }));
  const free = new Set(materials.keys()), taken = new Set(materials.map(m => m.name));
  const take = wantEye => [...free].find(i => eye(materials[i].name) === wantEye);
  const of = bodyNames.map(name => {
    const slot = take(eye(name)) ?? take(!eye(name));
    if (slot !== undefined) { free.delete(slot); return slot; }
    // a copy of his first eye or body material, named for the body's (unless that name is taken)
    const pool = shadowNames.map((n, i) => i).filter(i => eye(shadowNames[i]) === eye(name));
    let copy = name;
    for (let n = 2; taken.has(copy); n++) copy = `${name}(${n})`;
    taken.add(copy);
    materials.push({ name: copy, from: pool.length ? pool[0] : 0 });
    return materials.length - 1;
  });
  return { materials, of };
}

// The body's materials as Shadow Mario's: { bmd, materials } (materials: assign's list).
function shadowModel(body, shadow) {
  const own = chunks(body), his = chunks(shadow);
  const find = (list, type) => list.find(c => c.type === type)?.data;
  const bodyMat = find(own, 'MAT3'), shadowMat = find(his, 'MAT3'), inf = find(own, 'INF1');
  if (!bodyMat || !shadowMat || !inf || !find(his, 'TEX1')) throw new Error('A model without materials or a scene graph.');
  const bodyNames = readNames(bodyMat, bodyMat.readUInt32BE(0x14));
  const shadowNames = readNames(shadowMat, shadowMat.readUInt32BE(0x14));
  const { materials, of } = assign(bodyNames, shadowNames);

  // his MAT3 with these materials: the remap table, the names and the indirect texturing written anew at
  // its end (the names before the indirect texturing, as the loader expects: J3DMaterialFactory)
  const remapAt = shadowMat.readUInt32BE(0x10), indAt = shadowMat.readUInt32BE(0x18);
  const remap = Buffer.alloc(materials.length * 2);
  materials.forEach((m, i) => remap.writeUInt16BE(shadowMat.readUInt16BE(remapAt + m.from * 2), i * 2));
  const parts = [remap, nameTable(materials.map(m => m.name))];
  if (indAt) parts.push(Buffer.concat(materials.map(m => shadowMat.subarray(indAt + m.from * IND_SIZE, indAt + (m.from + 1) * IND_SIZE))));
  const { data: mat, at } = append(shadowMat.subarray(0, shadowMat.readUInt32BE(4)), parts);
  mat.writeUInt16BE(materials.length, 0x08);
  mat.writeUInt32BE(at[0], 0x10);
  mat.writeUInt32BE(at[1], 0x14);
  if (indAt) mat.writeUInt32BE(at[2], 0x18);

  // the scene graph's material nodes (type 0x11) name the look's material for the body's
  const graph = Buffer.from(inf);
  for (let node = graph.readUInt32BE(0x14); node + 4 <= graph.length; node += 4) {
    const type = graph.readUInt16BE(node);
    if (type === 0) break;
    if (type !== 0x11) continue;
    const index = graph.readUInt16BE(node + 2);
    if (index >= of.length) throw new Error('The scene graph names a material the model hasn\'t.');
    graph.writeUInt16BE(of[index], node + 2);
  }

  const list = own.map(c => c.type === 'MAT3' ? { type: 'MAT3', data: mat }
    : c.type === 'TEX1' ? { type: 'TEX1', data: find(his, 'TEX1') } : c.type === 'INF1' ? { type: 'INF1', data: graph } : c);
  return { bmd: writeFile(body, list), materials };
}

// His scrolling texture for these materials: each one's animation is the one of the material it was copied from.
function shadowScroll(btk, materials, shadowNames) {
  const [ttk] = chunks(btk).filter(c => c.type === 'TTK1').map(c => c.data);
  if (!ttk) throw new Error('A texture animation without TTK1.');
  const count = ttk.readUInt16BE(0x0c) / 3, entry = 9 * 6;   // U, V, W each: scale, rotation, translation
  const table = ttk.readUInt32BE(0x14), remap = ttk.readUInt32BE(0x18), texIndex = ttk.readUInt32BE(0x20), centers = ttk.readUInt32BE(0x24);
  const names = readNames(ttk, ttk.readUInt32BE(0x1c));
  const anims = materials.map(m => names.indexOf(shadowNames[m.from])).map(i => (i < 0 || i >= count ? 0 : i));
  const parts = [
    Buffer.concat(anims.map(i => ttk.subarray(table + i * entry, table + (i + 1) * entry))),
    Buffer.concat(anims.map((i, n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; })),
    nameTable(materials.map(m => m.name)),
    Buffer.from(anims.map(i => ttk[texIndex + i])),
    Buffer.concat(anims.map(i => ttk.subarray(centers + i * 12, centers + (i + 1) * 12))),
  ];
  const { data, at } = append(ttk.subarray(0, ttk.readUInt32BE(4)), parts);
  data.writeUInt16BE(materials.length * 3, 0x0c);
  data.writeUInt32BE(at[0], 0x14);
  data.writeUInt32BE(at[1], 0x18);
  data.writeUInt32BE(at[2], 0x1c);
  data.writeUInt32BE(at[3], 0x20);
  data.writeUInt32BE(at[4], 0x24);
  return writeFile(btk, chunks(btk).map(c => (c.type === 'TTK1' ? { type: 'TTK1', data } : c)));
}

// A copy of a model with these shapes drawing nothing: each of their display lists all GX no-ops (0x00).
function withoutShapes(model, hidden) {
  const out = Buffer.from(model);
  const shp = chunks(out).find(c => c.type === 'SHP1');
  if (!shp || !hidden.length) return out;
  const at = shp.data.byteOffset - out.byteOffset, off = k => at + out.readUInt32BE(at + 0x0c + k * 4);
  const entries = off(0), remap = off(1), dlData = off(5), packets = off(7);
  for (const s of hidden) {
    if (s >= out.readUInt16BE(at + 8)) continue;
    const e = entries + out.readUInt16BE(remap + s * 2) * 0x28;
    for (let p = 0, count = out.readUInt16BE(e + 2), first = out.readUInt16BE(e + 8); p < count; p++) {
      const loc = packets + (first + p) * 8, start = dlData + out.readUInt32BE(loc + 4);
      out.fill(0, start, start + out.readUInt32BE(loc));
    }
  }
  return out;
}

// Vertex attributes (GX_VA_*) and where VTX1 keeps each one's array (its 13 offsets: position, normal,
// NBT, two colours, eight texture coordinates).
const PNMTXIDX = 0, POS = 9, NRM = 10, CLR0 = 11, CLR1 = 12;
const VTX_SLOT = attr => (attr === POS ? 0 : attr === NRM ? 1 : attr >= CLR0 && attr <= 20 ? attr - 8 : -1);
// The size of one entry of an array in this format: its components (by count), each by its type.
function entrySize(attr, { count, type }) {
  if (attr === CLR0 || attr === CLR1) return [2, 3, 4, 2, 3, 4][type];
  const components = attr === POS ? (count ? 3 : 2) : attr === NRM ? 3 : (count ? 2 : 1);
  return components * [1, 1, 2, 2, 4][type];
}
// VTX1's formats ({ count, type, frac } by attribute) and arrays (the bytes by attribute, padding and all).
function readVertexArrays(vtx) {
  const formats = new Map();
  for (let f = vtx.readUInt32BE(8); vtx.readUInt32BE(f) !== 0xff; f += 16)
    formats.set(vtx.readUInt32BE(f), { count: vtx.readUInt32BE(f + 4), type: vtx.readUInt32BE(f + 8), frac: vtx[f + 12] });
  const offsets = Array.from({ length: 13 }, (_, i) => vtx.readUInt32BE(0x0c + i * 4));
  const arrays = new Map();
  for (const attr of formats.keys()) {
    const slot = VTX_SLOT(attr), start = offsets[slot];
    if (slot < 0 || !start) continue;
    const next = offsets.filter(o => o > start).reduce((a, b) => Math.min(a, b), vtx.length);
    arrays.set(attr, vtx.subarray(start, next));
  }
  return { formats, offsets, arrays };
}

// A shape's place in SHP1 (offsets from the chunk's start): its entry, attributes ([{ attr, type }]) and
// display lists ([{ loc, start, size }]).
function readShape(shp, s) {
  const off = k => shp.readUInt32BE(0x0c + k * 4);
  const entry = off(0) + shp.readUInt16BE(off(1) + s * 2) * 0x28;
  const attrs = [];
  for (let a = off(3) + shp.readUInt16BE(entry + 4); shp.readUInt32BE(a) !== 0xff; a += 8) attrs.push({ attr: shp.readUInt32BE(a), type: shp.readUInt32BE(a + 4) });
  const lists = [];
  for (let p = 0, first = shp.readUInt16BE(entry + 8); p < shp.readUInt16BE(entry + 2); p++) {
    const loc = off(7) + (first + p) * 8;
    lists.push({ loc, start: off(5) + shp.readUInt32BE(loc + 4), size: shp.readUInt32BE(loc) });
  }
  return { entry, attrs, lists };
}

// Each vertex of a shape's display lists: [{ op, vertices: [{ attr: index }] }] per primitive.
function readPrimitives(shp, { attrs, lists }) {
  const out = [];
  for (const { start, size } of lists) {
    for (let q = start; q < start + size;) {
      const op = shp[q++];
      if (op === 0) continue;
      if ((op & 0xf8) < 0x80 || (op & 0xf8) > 0xb8) throw new Error(`A display list with command ${op.toString(16)}.`);
      const n = shp.readUInt16BE(q), vertices = [];
      q += 2;
      for (let v = 0; v < n; v++) {
        const vertex = {};
        for (const { attr, type } of attrs) {
          if (type === 0) continue;
          vertex[attr] = type === 3 ? shp.readUInt16BE(q) : shp[q];
          q += type === 3 ? 2 : 1;
        }
        vertices.push(vertex);
      }
      out.push({ op, vertices });
    }
  }
  return out;
}

// A copy of a model with shape `target` drawn as `donor`'s one shape (a model of one joint, as the cap
// ma_cap1.bmd is), on the model's draw matrix `draw`: the donor's positions, normals and texture coordinates
// are added to the model's arrays, and the target draws them in a display list of its own, in its own
// material. A colour the donor hasn't is the one the target's first vertex had.
function withShapeFrom(model, target, donor, { draw }) {
  const own = chunks(model), his = chunks(donor);
  const find = (list, type) => list.find(c => c.type === type)?.data;
  const vtx = find(own, 'VTX1'), shp = find(own, 'SHP1'), donorVtx = find(his, 'VTX1'), donorShp = find(his, 'SHP1');
  if (!vtx || !shp || !donorVtx || !donorShp) throw new Error('A model without vertices or shapes.');
  if (target >= shp.readUInt16BE(8) || donorShp.readUInt16BE(8) !== 1) throw new Error('No such shape to draw anew, or a donor of more than one.');
  const shape = readShape(shp, target), donorShape = readShape(donorShp, 0);
  if (shape.lists.length !== 1) throw new Error('A shape of more than one packet.');
  if (shape.attrs.some(a => a.type === 1 && a.attr !== PNMTXIDX) || shape.attrs.some(a => a.type === 2)) throw new Error('A shape with 8-bit or direct vertex data.');
  const vertices = readVertexArrays(vtx), donorVertices = readVertexArrays(donorVtx);
  const [first] = readPrimitives(shp, shape)[0]?.vertices || [{}];
  const primitives = readPrimitives(donorShp, donorShape);
  const donorMatrices = donorShp.readUInt32BE(0x0c + 6 * 4) + donorShp.readUInt16BE(donorShape.entry + 6) * 8;
  if (donorShape.lists.some((_, p) => donorShp.readUInt16BE(donorMatrices + p * 8 + 2) !== 1)) throw new Error('A donor on more than one matrix.');

  // each array the donor adds to: the model's (an entry's worth of padding at most), then the donor's
  const base = new Map();
  const grown = new Map([...vertices.arrays].map(([attr, bytes]) => {
    const format = vertices.formats.get(attr), donorFormat = donorVertices.formats.get(attr);
    const extra = donorVertices.arrays.get(attr);
    if (!shape.attrs.some(a => a.attr === attr) || attr === CLR0 || attr === CLR1 || !extra) return [attr, bytes];
    if (!donorFormat || ['count', 'type', 'frac'].some(k => donorFormat[k] !== format[k])) throw new Error('The donor\'s vertices are in another format.');
    const size = entrySize(attr, format), count = Math.ceil(bytes.length / size);
    base.set(attr, count);
    const out = Buffer.alloc(count * size + Math.floor(extra.length / size) * size);
    bytes.copy(out);
    extra.copy(out, count * size, 0, out.length - count * size);
    return [attr, out];
  }));
  for (const { attr } of shape.attrs)
    if (attr !== PNMTXIDX && attr !== CLR0 && attr !== CLR1 && !base.has(attr)) throw new Error('The donor lacks a vertex attribute the shape draws.');
  if ([...base].some(([attr, n]) => n + Math.floor(donorVertices.arrays.get(attr).length / entrySize(attr, donorVertices.formats.get(attr))) > 0xffff))
    throw new Error('Too many vertices for 16-bit indices.');

  // VTX1 again: its header and formats, then each array in its old order, 32-byte aligned
  const order = [...vertices.offsets.keys()].filter(slot => vertices.offsets[slot]).sort((a, b) => vertices.offsets[a] - vertices.offsets[b]);
  const head = Buffer.from(vtx.subarray(0, vertices.offsets[order[0]]));
  const pieces = [head];
  let size = head.length;
  for (const slot of order) {
    const attr = [...grown.keys()].find(a => VTX_SLOT(a) === slot);
    const bytes = attr !== undefined ? grown.get(attr) : vtx.subarray(vertices.offsets[slot], order.map(s => vertices.offsets[s]).find(o => o > vertices.offsets[slot]) || vtx.length);
    const pad = align(size, 32) - size;
    if (pad) pieces.push(Buffer.alloc(pad));
    size += pad;
    head.writeUInt32BE(size, 0x0c + slot * 4);
    pieces.push(bytes);
    size += bytes.length;
  }
  pieces.push(Buffer.alloc(align(size, 32) - size));
  const newVtx = Buffer.concat(pieces);
  newVtx.writeUInt32BE(newVtx.length, 4);

  // the donor's primitives in the target's attributes, as a display list of its own
  const dl = [];
  for (const { op, vertices: list } of primitives) {
    const prim = Buffer.alloc(3);
    prim[0] = op;
    prim.writeUInt16BE(list.length, 1);
    dl.push(prim);
    for (const vertex of list) {
      for (const { attr, type } of shape.attrs) {
        if (type === 0) continue;
        if (type === 1) { dl.push(Buffer.from([0])); continue; }   // the shape's one matrix
        const value = Buffer.alloc(2);
        value.writeUInt16BE(base.has(attr) ? base.get(attr) + vertex[attr] : (first[attr] ?? 0));
        dl.push(value);
      }
    }
  }
  // placed at the end of the display lists' part, before the tables after it, which move on: the game's
  // loader reads each part of SHP1 up to the next (the last to the end), so one placed after the
  // packets' table would be read as part of it
  const list = Buffer.concat(dl), listSize = align(list.length, 32);
  const sectionAt = Array.from({ length: 8 }, (_, k) => shp.readUInt32BE(0x0c + k * 4)), dlData = sectionAt[5];
  const listAt = sectionAt.filter(o => o > dlData).reduce((x, y) => Math.min(x, y), shp.length);
  if (listAt % 32) throw new Error('Display lists out of alignment.');
  const newShp = Buffer.concat([shp.subarray(0, listAt), list, Buffer.alloc(listSize - list.length), shp.subarray(listAt)]);
  newShp.writeUInt32BE(newShp.length, 4);
  sectionAt.forEach((o, k) => { if (o >= listAt) newShp.writeUInt32BE(o + listSize, 0x0c + k * 4); });
  const loc = shape.lists[0].loc + (shape.lists[0].loc >= listAt ? listSize : 0);
  newShp.writeUInt32BE(listSize, loc);
  newShp.writeUInt32BE(listAt - dlData, loc + 4);
  const entry = shape.entry + (shape.entry >= listAt ? listSize : 0);

  // on draw matrix `draw`: the shape takes the matrices of a packet (of one matrix) that's drawn on it
  const sections = Array.from({ length: 8 }, (_, k) => newShp.readUInt32BE(0x0c + k * 4));
  const matrixTable = sections[4], matrixData = sections[6], end = sections.filter(o => o > matrixData).reduce((x, y) => Math.min(x, y), newShp.length);
  let found = -1;
  for (let m = 0; matrixData + m * 8 + 8 <= end && found < 0; m++) {
    const md = matrixData + m * 8;
    if (newShp.readUInt16BE(md + 2) === 1 && newShp.readUInt16BE(matrixTable + newShp.readUInt32BE(md + 4) * 2) === draw) found = m;
  }
  if (found < 0) throw new Error('No packet of the model is drawn on that matrix.');
  newShp.writeUInt16BE(found, entry + 6);

  return writeFile(model, own.map(c => (c.type === 'VTX1' ? { type: 'VTX1', data: newVtx } : c.type === 'SHP1' ? { type: 'SHP1', data: newShp } : c)));
}

// The body (a .bmd on Mario's skeleton) as Shadow Mario: the files of a character's look/ folder. `hide`:
// the body's shapes left out (the game draws a look model whole).
function shadowLook(body, shadowBmd, shadowBtk, { hide = [] } = {}) {
  const { bmd: whole, materials } = shadowModel(body, shadowBmd);
  const bmd = withoutShapes(whole, hide);
  const shadowMat = chunks(shadowBmd).find(c => c.type === 'MAT3').data;
  const shadowNames = readNames(shadowMat, shadowMat.readUInt32BE(0x14));
  return { 'default.bmd': bmd, 'kagemario_scroll.btk': shadowScroll(shadowBtk, materials, shadowNames) };
}

module.exports = { shadowLook, withoutShapes, withShapeFrom, assign, chunks };
