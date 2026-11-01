'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shadowLook, assign, chunks } = require('../src/shadow-look');

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
