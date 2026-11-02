'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shadowLook, withoutShapes, withShapeFrom, assign, chunks } = require('../src/shadow-look');

const names = list => {
  const head = Buffer.alloc(4 + list.length * 4), strings = [];
  head.writeUInt16BE(list.length, 0);
  let offset = head.length;
  list.forEach((name, i) => { head.writeUInt16BE(offset, 6 + i * 4); strings.push(Buffer.from(`${name}\0`, 'latin1')); offset += name.length + 1; });
  return Buffer.concat([head, ...strings]);
};
const chunk = (type, body) => { const head = Buffer.alloc(8); head.write(type, 0, 'ascii'); head.writeUInt32BE(8 + body.length, 4); return Buffer.concat([head, body]); };
const file = (magic, list) => {
  const head = Buffer.alloc(0x20); head.write(magic, 0, 'ascii');
  const out = Buffer.concat([head, ...list]); out.writeUInt32BE(out.length, 8); out.writeUInt32BE(list.length, 0x0c);
  return out;
};
// MAT3: count, remap at 0x84, indirect texturing after it (0x138 bytes of i for material i), names last
// (offsets from the chunk's start).
function mat3(materialNames, remap) {
  const body = Buffer.alloc(0x84 - 8 + remap.length * 2);
  body.writeUInt16BE(materialNames.length, 0);
  body.writeUInt32BE(0x84, 0x10 - 8);
  remap.forEach((r, i) => body.writeUInt16BE(r, 0x84 - 8 + i * 2));
  const ind = Buffer.concat(materialNames.map((_, i) => Buffer.alloc(0x138, i)));
  body.writeUInt32BE(0x84 + remap.length * 2, 0x18 - 8);
  body.writeUInt32BE(0x84 + remap.length * 2 + ind.length, 0x14 - 8);
  return chunk('MAT3', Buffer.concat([body, ind, names(materialNames)]));
}
// INF1: material and shape nodes, one shape per material.
function inf1(count) {
  const body = Buffer.alloc(0x18 - 8 + count * 8 + 4);
  body.writeUInt32BE(0x18, 0x14 - 8);
  for (let i = 0; i < count; i++) {
    body.writeUInt16BE(0x11, 0x10 + i * 8); body.writeUInt16BE(i, 0x12 + i * 8);
    body.writeUInt16BE(0x12, 0x14 + i * 8); body.writeUInt16BE(i, 0x16 + i * 8);
  }
  return chunk('INF1', body);
}
// TTK1 with one animation per material: entry i is 54 bytes of i, center i is 12 bytes of i.
function ttk1(materialNames) {
  const n = materialNames.length, body = Buffer.alloc(0x60 - 8);
  body.writeUInt16BE(n * 3, 0x0c - 8);
  const table = Buffer.concat(materialNames.map((_, i) => Buffer.alloc(54, i)));
  const remap = Buffer.concat(materialNames.map((_, i) => { const b = Buffer.alloc(2); b.writeUInt16BE(i); return b; }));
  const nameTab = names(materialNames), tex = Buffer.from(materialNames.map(() => 2)), centers = Buffer.concat(materialNames.map((_, i) => Buffer.alloc(12, i)));
  let at = 0x60;
  for (const [field, part] of [[0x14, table], [0x18, remap], [0x1c, nameTab], [0x20, tex], [0x24, centers]]) { body.writeUInt32BE(at, field - 8); at += part.length; }
  return chunk('TTK1', Buffer.concat([body, table, remap, nameTab, tex, centers]));
}

test('each of the body\'s materials takes one of Shadow Mario\'s, eyes his eye, then copies after his own', () => {
  assert.deepEqual(assign(['_mat_head(8)', '_mat_eye_L', '_mat_mouse', '_mat_eye_R'], ['_mat_eye_R', '_mat_head', '_mat_head(2)']), {
    materials: [{ name: '_mat_eye_R', from: 0 }, { name: '_mat_head', from: 1 }, { name: '_mat_head(2)', from: 2 }, { name: '_mat_eye_R(2)', from: 0 }],
    of: [1, 0, 2, 3] });
  // fewer than his: his first ones
  assert.deepEqual(assign(['_mat_head'], ['_mat_eye_R', '_mat_head']), { materials: [{ name: '_mat_eye_R', from: 0 }], of: [0] });
});

test('a body drawn as Shadow Mario: its scene graph and shapes, his materials and textures, his scroll on every material', () => {
  const body = file('J3D2bmd3', [inf1(3), chunk('SHP1', Buffer.from('shapes!!')), mat3(['a', 'eye_L', 'b'], [0, 1, 2]), chunk('TEX1', Buffer.from('mine'))]);
  const shadow = file('J3D2bmd3', [inf1(2), mat3(['_mat_eye_R', '_mat_head'], [0, 1]), chunk('TEX1', Buffer.from('his texture'))]);
  const look = shadowLook(body, shadow, file('J3D1btk1', [ttk1(['_mat_eye_R', '_mat_head'])]));
  const bmd = look['default.bmd'], parts = chunks(bmd);
  assert.deepEqual(parts.map(c => c.type), ['INF1', 'SHP1', 'MAT3', 'TEX1']);
  assert.equal(bmd.readUInt32BE(8), bmd.length);
  assert.equal(parts[1].data.toString('latin1', 8), 'shapes!!');
  assert.equal(parts[3].data.toString('latin1', 8), 'his texture');
  // the shapes' materials: a his body's, eye_L his eye's, b a copy of his body's after his own
  const graph = parts[0].data;
  assert.deepEqual([0, 1, 2].map(i => graph.readUInt16BE(0x18 + i * 8 + 2)), [1, 0, 2]);
  const mat = parts[2].data, remapAt = mat.readUInt32BE(0x10);
  assert.equal(mat.readUInt16BE(8), 3);
  assert.deepEqual([0, 1, 2].map(i => mat.readUInt16BE(remapAt + i * 2)), [0, 1, 1]);   // his own at their entries, then the copy
  const at = mat.readUInt32BE(0x14), materialNames = [0, 1, 2].map(i => { const s = at + mat.readUInt16BE(at + 6 + i * 4); return mat.toString('latin1', s, mat.indexOf(0, s)); });
  assert.deepEqual(materialNames, ['_mat_eye_R', '_mat_head', 'b']);
  assert.deepEqual([0, 1, 2].map(i => mat[mat.readUInt32BE(0x18) + i * 0x138]), [0, 1, 1]);   // each its own indirect texturing
  assert.ok(mat.readUInt32BE(0x18) > mat.readUInt32BE(0x14) + 4);
  const ttk = chunks(look['kagemario_scroll.btk'])[0].data;
  assert.equal(ttk.readUInt16BE(0x0c), 9);
  const table = ttk.readUInt32BE(0x14);
  assert.deepEqual([0, 1, 2].map(i => ttk[table + i * 54]), [0, 1, 1]);
  assert.deepEqual([0, 1, 2].map(i => ttk[ttk.readUInt32BE(0x24) + i * 12]), [0, 1, 1]);
  assert.equal(ttk.length % 32, 0);
});

// SHP1 with two shapes of one packet each, their display lists 'AAAA' and 'BBBB' (shape 1 first in the data).
function shp1() {
  const head = Buffer.alloc(0x30 - 8), entries = Buffer.alloc(2 * 0x28), remap = Buffer.from([0, 0, 0, 1]);   // u16 0, 1
  const dl = Buffer.from('BBBBAAAA'), packets = Buffer.alloc(16);
  entries.writeUInt16BE(1, 2); entries.writeUInt16BE(0, 8);            // shape 0: packet 0
  entries.writeUInt16BE(1, 0x28 + 2); entries.writeUInt16BE(1, 0x28 + 8); // shape 1: packet 1
  packets.writeUInt32BE(4, 0); packets.writeUInt32BE(4, 4);             // packet 0: 'AAAA'
  packets.writeUInt32BE(4, 8); packets.writeUInt32BE(0, 12);            // packet 1: 'BBBB'
  head.writeUInt16BE(2, 0);
  const at = { entries: 0x30, remap: 0x30 + entries.length, dl: 0x30 + entries.length + remap.length };
  at.packets = at.dl + dl.length;
  head.writeUInt32BE(at.entries, 0x0c - 8); head.writeUInt32BE(at.remap, 0x10 - 8);
  head.writeUInt32BE(at.dl, 0x20 - 8); head.writeUInt32BE(at.packets, 0x28 - 8);
  return chunk('SHP1', Buffer.concat([head, entries, remap, dl, packets]));
}

test('a shape left out draws nothing: its display lists are all no-ops, the others as they were', () => {
  const model = file('J3D2bmd3', [shp1()]);
  const out = withoutShapes(model, [0]), dl = chunks(out)[0].data.subarray(0x30 + 0x50 + 4, 0x30 + 0x50 + 12);
  assert.equal(dl.toString('latin1'), 'BBBB\0\0\0\0');
  assert.equal(out.length, model.length);
  assert.equal(chunks(model)[0].data.subarray(0x84, 0x8c).toString('latin1'), 'BBBBAAAA');   // the model given is kept
});

// A model of one shape: VTX1 with float positions, SHP1 with one triangle of positions 0, 1, 2 on draw matrix 0.
function oneShape(positions) {
  const vtx = Buffer.alloc(0x60 + positions.length * 4);
  vtx.write('VTX1', 0, 'ascii'); vtx.writeUInt32BE(vtx.length, 4); vtx.writeUInt32BE(0x40, 8); vtx.writeUInt32BE(0x60, 0x0c);
  vtx.writeUInt32BE(9, 0x40); vtx.writeUInt32BE(1, 0x44); vtx.writeUInt32BE(4, 0x48); vtx.writeUInt32BE(0xff, 0x50);
  positions.forEach((v, i) => vtx.writeFloatBE(v, 0x60 + i * 4));
  const shp = Buffer.alloc(0xd0);
  shp.write('SHP1', 0, 'ascii'); shp.writeUInt32BE(shp.length, 4); shp.writeUInt16BE(1, 8);
  [0x40, 0x68, 0, 0x70, 0x80, 0xa0, 0xc0, 0xc8].forEach((o, k) => shp.writeUInt32BE(o, 0x0c + k * 4));
  shp[0x40] = 3; shp.writeUInt16BE(1, 0x42);                                  // one packet, its matrices 0, its list 0
  shp.writeUInt32BE(9, 0x70); shp.writeUInt32BE(3, 0x74); shp.writeUInt32BE(0xff, 0x78);   // positions by 16-bit index
  Buffer.from([0x90, 0, 3, 0, 0, 0, 1, 0, 2]).copy(shp, 0xa0);
  shp.writeUInt16BE(1, 0xc2);                                                  // matrices: one, table entry 0 (draw 0)
  shp.writeUInt32BE(32, 0xc8);                                                 // list: 32 bytes at 0
  return file('J3D2bmd3', [vtx, shp]);
}

test('a shape drawn as another model\'s: its vertices added, its own display list among the others, the tables after it moved on', () => {
  const model = oneShape([0, 0, 0, 1, 0, 0, 0, 1, 0]), donor = oneShape([5, 5, 5, 6, 5, 5, 5, 6, 5]);
  const out = withShapeFrom(model, 0, donor, { draw: 0 });
  const [vtx, shp] = chunks(out).map(c => c.data);
  const positions = Array.from({ length: 18 }, (_, i) => vtx.readFloatBE(vtx.readUInt32BE(0x0c) + i * 4));
  assert.deepEqual(positions, [0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5, 6, 5, 5, 5, 6, 5]);
  assert.equal(shp.readUInt32BE(0x0c + 5 * 4), 0xa0);                         // the lists where they were
  assert.equal(shp.readUInt32BE(0x0c + 6 * 4), 0xc0 + 32);                    // the matrices and packets after the new one
  assert.equal(shp.readUInt32BE(0x0c + 7 * 4), 0xc8 + 32);
  const packet = shp.readUInt32BE(0x0c + 7 * 4);
  assert.equal(shp.readUInt32BE(packet), 32);
  assert.equal(shp.readUInt32BE(packet + 4), 32);                              // right after the old list
  assert.deepEqual([...shp.subarray(0xa0 + 32, 0xa0 + 41)], [0x90, 0, 3, 0, 3, 0, 4, 0, 5]);
  assert.deepEqual([...shp.subarray(0xa0, 0xa0 + 9)], [0x90, 0, 3, 0, 0, 0, 1, 0, 2]);   // the old list kept
  assert.equal(shp.readUInt32BE(4), shp.length);
  assert.equal(out.readUInt32BE(8), out.length);
  assert.throws(() => withShapeFrom(model, 0, donor, { draw: 7 }), /matrix/);
});
