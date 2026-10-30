'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const j3d = require('../src/j3d');
const write = require('../src/j3d-write');
const { analyze, guessRole } = require('../src/character-convert');

test('bones are labelled from the names rigs give them', () => {
  const cases = {
    'mixamorig:Hips': 'hips', 'mixamorig:Spine1': 'spine', 'mixamorig:LeftForeArm': 'forearm', 'mixamorig:RightArm': 'upperarm',
    'mixamorig:LeftUpLeg': 'thigh', 'mixamorig:LeftLeg': 'shin', 'mixamorig:RightFoot': 'foot', 'mixamorig:LeftHandIndex1': null,
    'mixamorig:HeadTop_End': null, 'UpperArm.L': 'upperarm', 'LowerLeg.R': 'shin', 'thigh_l': 'thigh', 'clavicle_r': 'shoulder',
    'J_Bip_C_Head': 'head', 'J_Bip_L_LowerArm': 'forearm', 'Armature': null, 'Root': null, 'Hair_01': null, 'Neck': 'neck',
  };
  for (const [name, role] of Object.entries(cases)) assert.equal(guessRole(name), role, name);
});

// A one-triangle glTF skinned to a Mixamo-named skeleton, as a .glb.
function glb() {
  const names = ['Armature', 'mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Head', 'mixamorig:LeftUpLeg', 'mixamorig:LeftLeg',
    'mixamorig:RightUpLeg', 'mixamorig:RightLeg', 'mixamorig:LeftArm', 'mixamorig:LeftForeArm', 'mixamorig:LeftHandThumb1'];
  const parent = [-1, 0, 1, 2, 1, 4, 1, 6, 2, 8, 9];
  const at = [[0, 0, 0], [0, 1, 0], [0, 0.2, 0], [0, 0.4, 0], [0.1, 0, 0], [0, -0.45, 0], [-0.1, 0, 0], [0, -0.45, 0], [0.2, 0.3, 0], [0.25, 0, 0], [0.2, 0, 0]];
  const nodes = names.map((name, i) => ({ name, translation: at[i], children: parent.map((p, c) => (p === i ? c : -1)).filter(c => c >= 0) }));
  nodes.forEach(n => { if (!n.children.length) delete n.children; });
  nodes.push({ name: 'Body', mesh: 0, skin: 0 });
  const joints = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // positions (36 bytes), indices (6, padded to 8), joints (3 x 4 bytes), weights (3 x 4, normalized), inverse binds
  const bin = Buffer.alloc(68 + 64 * joints.length);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4));
  [0, 1, 2].forEach((v, i) => bin.writeUInt16LE(v, 36 + i * 2));
  for (let v = 0; v < 3; v++) bin[56 + v * 4] = 255;  // every vertex on joint 0 (the hips), weight 1
  joints.forEach((_, k) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].forEach((v, e) => bin.writeFloatLE(v, 68 + k * 64 + e * 4)));
  const view = (byteOffset, byteLength) => ({ buffer: 0, byteOffset, byteLength });
  const json = {
    asset: { version: '2.0' }, scenes: [{ nodes: [0, 11] }], nodes, skins: [{ joints, inverseBindMatrices: 4 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 2, WEIGHTS_0: 3 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [view(0, 36), view(36, 6), view(44, 12), view(56, 12), view(68, 64 * joints.length)],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
      { bufferView: 2, componentType: 5121, count: 3, type: 'VEC4' }, { bufferView: 3, componentType: 5121, count: 3, type: 'VEC4', normalized: true },
      { bufferView: 4, componentType: 5126, count: joints.length, type: 'MAT4' }],
  };
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 0x20)]);
  const chunk = (kind, data) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.write(kind, 4, 'latin1'); return Buffer.concat([h, data]); };
  const body = Buffer.concat([chunk('JSON', text), chunk('BIN\0', bin)]);
  const head = Buffer.alloc(12); head.write('glTF', 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([head, body]);
}

test('a model\'s bones come as a tree with their guessed labels, sides from their names', () => {
  const { bones, triangles } = analyze(glb());
  assert.equal(triangles, 1);
  assert.deepEqual(bones.map(b => [b.name, b.label, b.depth]), [
    ['Armature', '', 0], ['mixamorig:Hips', 'hips', 1], ['mixamorig:Spine', 'spine', 2], ['mixamorig:Head', 'head', 3],
    ['mixamorig:LeftArm', 'upperarm.L', 3], ['mixamorig:LeftForeArm', 'forearm.L', 4], ['mixamorig:LeftHandThumb1', '', 5],
    ['mixamorig:LeftUpLeg', 'thigh.L', 2], ['mixamorig:LeftLeg', 'shin.L', 3], ['mixamorig:RightUpLeg', 'thigh.R', 2], ['mixamorig:RightLeg', 'shin.R', 3],
  ]);
  assert.equal(bones.find(b => b.name === 'mixamorig:LeftHandThumb1').minor, true);
  assert.throws(() => analyze(Buffer.from('not a model at all')), /not a binary glTF/);
});

test('the game\'s compressed texture format reads back close to the picture written', () => {
  const width = 16, height = 8, rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set([x * 16, 64 + y * 2, 128, 255], (y * width + x) * 4);
  const back = j3d.decodeTexture(write.cmpr({ width, height, rgba }), 14, width, height);
  let worst = 0;
  for (let i = 0; i < rgba.length; i++) if (i % 4 !== 3) worst = Math.max(worst, Math.abs(back[i] - rgba[i]));
  assert.ok(worst <= 12, `largest difference ${worst}`);
});

// A joint animation of one joint whose X translation has two keys.
function bck() {
  const ank = Buffer.alloc(0x60);
  ank.write('ANK1', 0); ank[8] = 0; ank[9] = 0; ank.writeUInt16BE(10, 0x0a); ank.writeUInt16BE(1, 0x0c);
  ank.writeUInt16BE(1, 0x0e); ank.writeUInt16BE(1, 0x10); ank.writeUInt16BE(9, 0x12);
  ank.writeUInt32BE(0x24, 0x14); ank.writeUInt32BE(0x5c, 0x18); ank.writeUInt32BE(0x5c, 0x1c); ank.writeUInt32BE(0x60, 0x20);
  // per axis: scale (count 1 at 0), rotation (count 1 at 0), translation
  for (let axis = 0; axis < 3; axis++) {
    const o = 0x24 + axis * 18;
    ank.writeUInt16BE(1, o); ank.writeUInt16BE(1, o + 6);
    ank.writeUInt16BE(axis === 0 ? 2 : 1, o + 12); ank.writeUInt16BE(axis === 0 ? 0 : 8, o + 14); ank.writeUInt16BE(axis === 0 ? 1 : 0, o + 16);
  }
  ank.writeFloatBE(1, 0x5c);  // the scale table (the rotation table's one 0 overlaps it: read as 0x3f80, unused here)
  const trans = Buffer.alloc(9 * 4);
  [0, 5, 0, 0, 10, 15, 0, 0, 7].forEach((v, i) => trans.writeFloatBE(v, i * 4));
  const section = Buffer.concat([ank, trans, Buffer.alloc(28)]);
  section.writeUInt32BE(section.length, 4);
  const head = Buffer.alloc(0x20); head.write('J3D1bck1', 0); head.writeUInt32BE(0x20 + section.length, 8); head.writeUInt32BE(1, 0x0c);
  return Buffer.concat([head, section]);
}

test('an animation\'s translation keys can be read and written back', () => {
  const data = bck(), { tracks, write: rewrite } = write.bckTranslations(data);
  assert.deepEqual(tracks[0][0].map(k => [k.time, k.value]), [[0, 5], [10, 15]]);
  assert.equal(tracks[0][2][0].value, 7);
  const moved = rewrite(tracks.map(axes => axes.map(keys => keys.map(k => ({ ...k, value: k.value + 100 })))));
  const parsed = j3d.parseBck(moved);
  assert.equal(j3d.sampleTrack(parsed.joints[0].translation[0], 0), 105);
  assert.equal(j3d.sampleTrack(parsed.joints[0].translation[0], 10), 115);
  assert.equal(j3d.sampleTrack(parsed.joints[0].translation[2], 3), 107);
  assert.equal(parsed.frames, 10);
});
