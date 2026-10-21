'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sceneBin = require('../src/scene-bin');
const archive = require('../src/archive');
const collision = require('../src/collision');

// --- scene.bin -----------------------------------------------------------------

const { node, actor, str, u32, f32 } = require('./world-fixture');

function sampleScene() {
  const lightMap = Buffer.concat([u32(1), u32(3), str('sun')]);
  return node('GroupObj', 'root', Buffer.alloc(0), [
    node('GroupObj', 'managers', Buffer.alloc(0), [node('ItemManager', 'items', Buffer.concat([str('items chara'), u32(2), u32(0)]))]),
    node('MarScene', 'scene', lightMap, [
      node('Strategy', 'strategy', Buffer.alloc(0), [
        node('IdxGroup', 'objects', u32(3), [actor('Coin', 'coin 0', [1, 2, 3], str('coin')), actor('Coin', 'coin 1', [4, 5, 6], str('coin'))]),
      ]),
    ]),
  ]);
}

test('scene files read into groups and nodes and write back byte for byte', () => {
  const buffer = sampleScene();
  const tree = sceneBin.parse(buffer);
  assert.equal(tree.type, 'GroupObj');
  assert.equal(tree.children.length, 2);
  const scene = tree.children[1];
  assert.equal(scene.type, 'MarScene');
  assert.equal(scene.data.length, 4 + 4 + 2 + 3, 'MarScene keeps its light map before its children');
  const coin = sceneBin.find(tree, '1/0/0/1');
  assert.equal(sceneBin.decodeName(coin.nameBytes), 'coin 1');
  assert.ok(sceneBin.serialize(tree).equals(buffer));
});

test('nodes edited or added get fresh sizes and key codes', () => {
  const tree = sceneBin.parse(sampleScene());
  const group = sceneBin.find(tree, '1/0/0');
  const copy = { ...group.children[0], nameBytes: sceneBin.encodeName('coin 2'), nameKey: undefined, data: Buffer.from(group.children[0].data) };
  group.children.push(copy);
  const again = sceneBin.parse(sceneBin.serialize(tree));
  const added = sceneBin.find(again, '1/0/0/2');
  assert.equal(sceneBin.decodeName(added.nameBytes), 'coin 2');
  assert.equal(added.nameKey, sceneBin.keyCode(Buffer.from('coin 2')));
  const ids = [];
  sceneBin.walk(again, (n, id) => ids.push(id));
  assert.deepEqual(ids, ['', '0', '0/0', '1', '1/0', '1/0/0', '1/0/0/0', '1/0/0/1', '1/0/0/2']);
});

test('strings in a node are found by their length prefix', () => {
  const data = Buffer.concat([f32(1, 2), str('palm chara'), u32(0), str('palmNormal')]);
  assert.deepEqual(sceneBin.strings(data.subarray(8)).map(s => s.text), ['palm chara', 'palmNormal']);
});

// --- RARC and Yaz0 -------------------------------------------------------------

function sampleArchive() {
  return {
    syncIds: true,
    root: { name: 'scene', entries: [
      { dir: { name: 'map', entries: [{ file: { name: 'scene.bin', flags: 0x11, id: 0, data: Buffer.from('scene') } }, { file: { name: 'map.col', flags: 0x11, id: 0, data: Buffer.alloc(40, 7) } }] } },
      { dir: { name: 'mapObj', entries: [{ file: { name: 'coin.bmd', flags: 0x11, id: 0, data: Buffer.from('coin model') } }] } },
    ] },
  };
}

test('archives write out and read back with their folders, names and files', () => {
  const written = archive.writeTree(sampleArchive());
  const files = archive.rarc(written);
  assert.deepEqual([...files.keys()], ['map/scene.bin', 'map/map.col', 'mapobj/coin.bmd']);
  assert.equal(files.get('mapobj/coin.bmd').toString(), 'coin model');
  // Writing what was read gives the same bytes.
  assert.ok(archive.writeTree(archive.readTree(written)).equals(written));
});

test('files go into an archive, making folders and keeping letter case', () => {
  const tree = archive.readTree(archive.writeTree(sampleArchive()));
  archive.treePut(tree, 'map/scene.bin', Buffer.from('edited'));
  archive.treePut(tree, 'kinopio/kinopio_body.bmd', Buffer.from('toad'));
  assert.equal(archive.treeFile(tree, 'MAPOBJ/COIN.BMD').file.name, 'coin.bmd');
  const files = archive.rarc(archive.writeTree(tree));
  assert.equal(files.get('map/scene.bin').toString(), 'edited');
  assert.equal(files.get('kinopio/kinopio_body.bmd').toString(), 'toad');
  assert.deepEqual(archive.readTree(archive.writeTree(tree)).root.entries.map(e => (e.dir || e.file).name), ['map', 'mapObj', 'kinopio']);
});

test('Yaz0 compression decompresses to the same bytes', () => {
  const repetitive = Buffer.from('Delfino Plaza '.repeat(2000));
  const random = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 2654435761 >>> 13) & 0xff));
  const long = Buffer.concat([Buffer.alloc(1000, 0), Buffer.from('xyz'), Buffer.alloc(300, 0)]);
  for (const data of [repetitive, random, long, Buffer.alloc(0), Buffer.from('ab')]) {
    const packed = archive.yaz0Encode(data);
    assert.equal(packed.toString('latin1', 0, 4), 'Yaz0');
    assert.ok(archive.yaz0(packed).equals(data));
  }
  assert.ok(archive.yaz0Encode(repetitive).length < repetitive.length / 10);
});

// --- Collision -----------------------------------------------------------------

// A square floor of two triangles (ground type 0) and a wall triangle with a
// per-triangle value (type 0x8000, flags 1).
function sampleCollision() {
  const vertices = [[0, 0, 0], [100, 0, 0], [100, 0, 100], [0, 0, 100], [0, 100, 0]];
  const groups = [
    { type: 0, flags: 0, tris: [[0, 1, 2, 0x1c, 0], [0, 2, 3, 0x1c, 0]] },
    { type: 0x8000, flags: 1, tris: [[0, 1, 4, 5, 0, -3]] },
  ];
  const tris = groups.flatMap(g => g.tris.map(([a, b, c, byteA, byteB, value = 0]) => ({ a, b, c, byteA, byteB, value, type: g.type, flags: g.flags, pad: 0xffff })));
  const vertexBytes = Buffer.alloc(vertices.length * 12);
  vertices.flat().forEach((v, i) => vertexBytes.writeFloatBE(v, i * 4));
  return { vertexBytes, vertexCount: vertices.length, tris };
}

test('collision reads as triangles with their ground types', () => {
  const { vertexBytes, vertexCount, tris } = sampleCollision();
  const file = collision.paint(collisionFile(vertexBytes, vertexCount, tris), {});
  const parsed = collision.parse(file);
  assert.deepEqual([...parsed.codes], [0x1c, 0x1c, 0x800005]);
  assert.deepEqual([...parsed.position.subarray(0, 9)], [0, 0, 0, 100, 0, 0, 100, 0, 100]);
});

test('painting moves triangles to their new ground type and leaves the rest alone', () => {
  const { vertexBytes, vertexCount, tris } = sampleCollision();
  const file = collisionFile(vertexBytes, vertexCount, tris);
  const painted = collision.paint(file, { 1: collision.surfaceCode(1, 0x0d) });
  const after = collision.triangles(painted);
  assert.deepEqual(after.map(t => t.type), [0, 1, 0x8000]);
  const moved = after.find(t => t.type === 1);
  assert.deepEqual([moved.a, moved.b, moved.c, moved.flags, moved.byteA], [0, 2, 3, 0, 0x0d]);
  // A new sound on the same type keeps the triangle in its group.
  assert.deepEqual(collision.triangles(collision.paint(file, { 0: 0x10 })).map(t => [t.type, t.byteA]), [[0, 0x10], [0, 0x1c], [0x8000, 5]]);
  const wall = after.find(t => t.type === 0x8000);
  assert.equal(wall.value, -3, 'per-triangle values stay with their triangles');
  // A triangle painted to a type the file already has takes that type's bytes.
  const again = collision.triangles(collision.paint(file, { 0: collision.surfaceCode(0x8000, 5) }));
  assert.deepEqual(again.filter(t => t.type === 0x8000).map(t => [t.flags, t.byteA, t.value]), [[1, 5, -3], [1, 5, -3]]);
  // A type the file doesn't have yet takes the defaults it's given.
  const fresh = collision.triangles(collision.paint(file, { 0: collision.surfaceCode(7, 23) }, { 7: { flags: 1, value: 8000 } }));
  assert.deepEqual(fresh.filter(t => t.type === 7).map(t => [t.flags, t.byteA, t.value]), [[1, 23, 8000]]);
  // No changes: the same file.
  assert.ok(collision.paint(file, {}).equals(file));
});

// The writer is the reference layout: it's what paint() produces for no changes.
function collisionFile(vertexBytes, vertexCount, tris) {
  const groups = [];
  for (const t of tris) {
    let g = groups.find(x => x.type === t.type && x.flags === t.flags);
    if (!g) groups.push(g = { type: t.type, flags: t.flags, tris: [] });
    g.tris.push(t);
  }
  const groupAt = 0x10, vertexAt = groupAt + groups.length * 0x18;
  let at = vertexAt + vertexCount * 12;
  for (const g of groups) { g.indexAt = at; at += g.tris.length * 6; }
  for (const g of groups) { g.aAt = at; at += g.tris.length; }
  for (const g of groups) { g.bAt = at; at += g.tris.length; }
  at = Math.ceil(at / 2) * 2;
  for (const g of groups) { g.vAt = g.flags & 1 ? at : 0; if (g.vAt) at += g.tris.length * 2; }
  const out = Buffer.alloc(Math.ceil(at / 4) * 4);
  out.writeUInt32BE(vertexCount, 0); out.writeUInt32BE(vertexAt, 4); out.writeUInt32BE(groups.length, 8); out.writeUInt32BE(groupAt, 12);
  vertexBytes.copy(out, vertexAt);
  groups.forEach((g, n) => {
    const o = groupAt + n * 0x18;
    out.writeUInt16BE(g.type, o); out.writeInt16BE(g.tris.length, o + 2); out.writeUInt16BE(g.flags, o + 4); out.writeUInt16BE(0xffff, o + 6);
    out.writeUInt32BE(g.indexAt, o + 8); out.writeUInt32BE(g.aAt, o + 12); out.writeUInt32BE(g.bAt, o + 16); out.writeUInt32BE(g.vAt, o + 20);
    g.tris.forEach((t, i) => {
      out.writeUInt16BE(t.a, g.indexAt + i * 6); out.writeUInt16BE(t.b, g.indexAt + i * 6 + 2); out.writeUInt16BE(t.c, g.indexAt + i * 6 + 4);
      out[g.aAt + i] = t.byteA; out[g.bAt + i] = t.byteB;
      if (g.vAt) out.writeInt16BE(t.value, g.vAt + i * 2);
    });
  });
  return out;
}

