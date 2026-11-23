'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Disc, parseFst } = require('../src/disc');
const { yaz0, rarc } = require('../src/archive');
const j3d = require('../src/j3d');
const colors = require('../src/mario-colors');
const { partOf, bake, fluddFiles, loadSunglasses, NOZZLES, FLUDD, SUNGLASSES } = require('../src/mario-model');

// A file system table: root, data/, data/mario.szs, opening.bnr.
function fst(files) {
  const names = Buffer.from('data\0mario.szs\0opening.bnr\0', 'latin1');
  const table = Buffer.alloc(4 * 12);
  table.writeUInt32BE(0x01000000, 0); table.writeUInt32BE(4, 8);
  table.writeUInt32BE(0x01000000, 12); table.writeUInt32BE(3, 20);
  table.writeUInt32BE(5, 24); table.writeUInt32BE(files[0].offset, 28); table.writeUInt32BE(files[0].size, 32);
  table.writeUInt32BE(15, 36); table.writeUInt32BE(files[1].offset, 40); table.writeUInt32BE(files[1].size, 44);
  return Buffer.concat([table, names]);
}

function gcm() {
  const disc = Buffer.alloc(0x3000);
  disc.write('GMSE01', 0, 'ascii');
  const table = fst([{ offset: 0x2000, size: 5 }, { offset: 0x2800, size: 3 }]);
  disc.writeUInt32BE(0x1000, 0x424); disc.writeUInt32BE(table.length, 0x428);
  table.copy(disc, 0x1000);
  disc.write('mario', 0x2000, 'ascii');
  disc.write('bnr', 0x2800, 'ascii');
  return disc;
}

test('the file system table gives each file its path, offset and size', () => {
  const files = parseFst(fst([{ offset: 10, size: 20 }, { offset: 30, size: 40 }]));
  assert.deepEqual([...files.keys()], ['data/mario.szs', 'opening.bnr']);
  assert.deepEqual(files.get('data/mario.szs'), { offset: 10, size: 20 });
});

test('files come straight off ISO and CISO disc images', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-disc-'));
  try {
    const plain = gcm();
    fs.writeFileSync(path.join(root, 'game.iso'), plain);
    const disc = new Disc(path.join(root, 'game.iso'));
    assert.equal(disc.gameId, 'GMSE01');
    assert.equal(disc.file('data/Mario.szs').toString(), 'mario');
    assert.throws(() => disc.file('data/luigi.szs'), /no data\/luigi\.szs/);
    disc.close();

    // CISO: 0x800-byte blocks, with the empty second block left out.
    const blockSize = 0x800, header = Buffer.alloc(0x8000);
    header.write('CISO', 0, 'ascii'); header.writeUInt32LE(blockSize, 4);
    const kept = [];
    for (let block = 0; block * blockSize < plain.length; block++) {
      const data = plain.subarray(block * blockSize, (block + 1) * blockSize);
      header[8 + block] = data.some(Boolean) ? 1 : 0;
      if (header[8 + block]) kept.push(data);
    }
    assert.ok(kept.length < plain.length / blockSize);
    fs.writeFileSync(path.join(root, 'game.ciso'), Buffer.concat([header, ...kept]));
    const compressed = new Disc(path.join(root, 'game.ciso'));
    assert.equal(compressed.file('opening.bnr').toString(), 'bnr');
    assert.equal(compressed.read(0x1800, 4).readUInt32BE(0), 0);
    compressed.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Yaz0 expands literals and back references', () => {
  // "abcabcabcX": three literals, a 6-byte copy from 3 back, then a literal.
  const body = Buffer.from([0b11101000, 0x61, 0x62, 0x63, 0x40, 0x02, 0x58]);
  const head = Buffer.alloc(16);
  head.write('Yaz0', 0, 'ascii'); head.writeUInt32BE(10, 4);
  assert.equal(yaz0(Buffer.concat([head, body])).toString(), 'abcabcabcX');
  const plain = Buffer.from('not compressed');
  assert.equal(yaz0(plain), plain);
});

test('RARC archives list nested files by lower-case path', () => {
  const strings = Buffer.from('.\0..\0mario\0bmd\0MA_MDL1.bmd\0', 'latin1');
  const nodes = Buffer.alloc(32), entries = Buffer.alloc(5 * 20);
  // node 0 (root "mario"): ".", "..", "bmd"; node 1 ("bmd"): "MA_MDL1.bmd"
  nodes.writeUInt32BE(5, 4); nodes.writeUInt16BE(3, 10); nodes.writeUInt32BE(0, 12);
  nodes.writeUInt32BE(11, 20); nodes.writeUInt16BE(1, 26); nodes.writeUInt32BE(3, 28);
  const entry = (i, flags, name, data, size) => {
    entries.writeUInt32BE((flags << 24) | name, i * 20 + 4); entries.writeUInt32BE(data, i * 20 + 8); entries.writeUInt32BE(size, i * 20 + 12);
  };
  entry(0, 0x02, 0, 0, 0); entry(1, 0x02, 2, 0xffffffff, 0); entry(2, 0x02, 11, 1, 0); entry(3, 0x11, 15, 0, 4);
  const info = Buffer.alloc(0x20);
  const nodeAt = 0x20, entryAt = nodeAt + nodes.length, stringAt = entryAt + entries.length, dataAt = stringAt + strings.length;
  info.writeUInt32BE(2, 0); info.writeUInt32BE(nodeAt, 4); info.writeUInt32BE(5, 8); info.writeUInt32BE(entryAt, 12);
  info.writeUInt32BE(strings.length, 16); info.writeUInt32BE(stringAt, 20);
  const header = Buffer.alloc(0x20);
  header.write('RARC', 0, 'ascii'); header.writeUInt32BE(dataAt, 0x0c);
  const files = rarc(Buffer.concat([header, info, nodes, entries, strings, Buffer.from('J3D2')]));
  assert.deepEqual([...files.keys()], ['bmd/ma_mdl1.bmd']);
  assert.equal(files.get('bmd/ma_mdl1.bmd').toString(), 'J3D2');
});

test('textures decode from the GameCube formats Mario uses', () => {
  // CMPR: four 4x4 blocks; the first is red/blue with a mid colour, the rest black.
  const cmpr = Buffer.alloc(32);
  cmpr.writeUInt16BE(0xf800, 0); cmpr.writeUInt16BE(0x001f, 2); cmpr[4] = 0b00011011;
  const pixels = j3d.decodeTexture(cmpr, 14, 8, 8);
  assert.deepEqual([...pixels.subarray(0, 4)], [255, 0, 0, 255]);
  assert.deepEqual([...pixels.subarray(4, 8)], [0, 0, 255, 255]);
  assert.deepEqual([...pixels.subarray(8, 12)], [170, 0, 85, 255]);
  // with its first colour not above its second, a block's fourth texel is see-through in the third's colour,
  // as the hardware and the game decode it (not black)
  const clear = Buffer.alloc(32);
  clear.writeUInt16BE(0x001f, 0); clear.writeUInt16BE(0xf800, 2); clear[4] = 0b10110000;
  const seeThrough = j3d.decodeTexture(clear, 14, 8, 8);
  assert.deepEqual([...seeThrough.subarray(0, 4)], [127, 0, 127, 255]);
  assert.deepEqual([...seeThrough.subarray(4, 8)], [127, 0, 127, 0]);
  // I4: two texels per byte, high nibble first.
  const i4 = j3d.decodeTexture(Buffer.from([0xf0, ...Array(31).fill(0)]), 0, 8, 8);
  assert.deepEqual([...i4.subarray(0, 8)], [255, 255, 255, 255, 0, 0, 0, 0]);
  // RGB5A3, opaque and translucent.
  const rgb5a3 = j3d.decodeTexture(Buffer.from([0xfc, 0x00, 0x6f, 0x00, ...Array(28).fill(0)]), 5, 4, 4);
  assert.deepEqual([...rgb5a3.subarray(0, 8)], [255, 0, 0, 255, 255, 0, 0, 218]);
});

test('animation tracks pass through their keys and ease between them', () => {
  const keys = [{ time: 0, value: 0, in: 1, out: 1 }, { time: 10, value: 10, in: 1, out: 1 }];
  assert.equal(j3d.sampleTrack(keys, 0), 0);
  assert.equal(j3d.sampleTrack(keys, 10), 10);
  assert.ok(Math.abs(j3d.sampleTrack(keys, 5) - 5) < 1e-9);
  assert.equal(j3d.sampleTrack(keys, 20), 10);
  assert.equal(j3d.sampleTrack([{ time: 0, value: 3, in: 0, out: 0 }], 7), 3);
  const flat = [{ time: 0, value: 0, in: 0, out: 0 }, { time: 10, value: 10, in: 0, out: 0 }];
  assert.ok(j3d.sampleTrack(flat, 2) < 2);
});

test('the idle animation is baked per frame, falling back to the rest pose', () => {
  const joints = [{ scale: [1, 1, 1], rotation: [0, 0, 0], translation: [1, 2, 3] }, { scale: [2, 2, 2], rotation: [0.5, 0, 0], translation: [0, 0, 0] }];
  const constant = value => [{ time: 0, value, in: 0, out: 0 }];
  const animation = { frames: 2, joints: [{
    scale: [constant(1), constant(1), constant(1)],
    rotation: [[{ time: 0, value: 0, in: 0, out: 0 }, { time: 1, value: 1, in: 0, out: 0 }], constant(0), constant(0)],
    translation: [constant(4), constant(5), constant(6)],
  }] };
  const { frames, fps, values } = bake(animation, joints);
  assert.equal(frames, 2); assert.equal(fps, 30);
  assert.deepEqual([...values.subarray(0, 9)], [1, 1, 1, 0, 0, 0, 4, 5, 6]);
  assert.equal(values[9 * 2 + 3], 1);
  assert.deepEqual([...values.subarray(9, 18)].map(v => Math.round(v * 10) / 10), [2, 2, 2, 0.5, 0, 0, 0, 0, 0]);
});

test('every nozzle the customizer offers has a model', () => {
  assert.deepEqual(Object.keys(NOZZLES), colors.NOZZLES.map(nozzle => nozzle.id));
});

test("FLUDD comes from Mario's archive, or Eclipse's common one", () => {
  const withFludd = new Map([[FLUDD, Buffer.alloc(0)]]), without = new Map();
  const disc = { files: new Map(), file: name => { throw new Error(`read ${name}`); } };
  assert.equal(fluddFiles(disc, withFludd), withFludd);
  assert.equal(fluddFiles(disc, without), without, 'a disc with neither keeps Mario\'s');
  disc.files.set('data/common.szs', {});
  assert.throws(() => fluddFiles(disc, without), /read data\/common\.szs/);
});

test("the sunglasses hang off Mario's head: a frame between its two TEV colours, cut out by alpha, and see-through lenses", t => {
  const shape = extra => ({ position: new Float32Array(3), normal: new Float32Array(3), uv: new Float32Array(2), index: new Uint16Array(1),
    drawIndex: new Uint8Array(1), color: new Float32Array([0, 0, 0.2, 0.9]), ...extra });
  const glasses = {
    joints: [{ name: 'sunglass_A', parent: -1 }], draw: [{ weighted: false, index: 0 }], envelopes: [], inverseBind: [],
    textures: [{ name: 'H_mario_sunglass_flame_ia4', width: 1, height: 2, rgba: Uint8Array.from([0, 0, 0, 255, 255, 255, 255, 0]) }],
    materials: [
      { name: '_mat_sunglass_A_flame', mode: 1, cull: 0, textures: [0], tevColors: [[84, 80, 230, 255], [238, 255, 255, 255]], alphaTest: { comp0: 6, ref0: 128 } },
      { name: '_mat_sunglass_A_lens', mode: 4, cull: 0, textures: [-1], tevColors: [[255, 255, 255, 255], [255, 255, 255, 255]], alphaTest: { comp0: 7, ref0: 0 } },
    ],
    shapes: [shape({ material: 0, hasColor: false }), shape({ material: 1, hasColor: true })],
  };
  t.mock.method(j3d, 'parseBmd', () => glasses);
  const mario = { joints: [{ name: 'jnt_root' }, { name: 'M_head' }] }, made = [];
  const textureFor = (source, part) => made.push({ source, part }) - 1;
  assert.equal(loadSunglasses(new Map(), mario, textureFor), null, 'a disc without them has none');
  const rig = loadSunglasses(new Map([[SUNGLASSES, Buffer.alloc(0)]]), mario, textureFor);
  assert.deepEqual(rig.attach, { joint: 1 });
  const [frame, lens] = rig.shapes;
  assert.equal(frame.part, 'sunglasses');
  assert.equal(frame.translucent, false);
  assert.ok(Math.abs(frame.alphaTest - 128 / 255) < 1e-9);
  assert.equal(frame.color, null);
  assert.deepEqual(Array.from(made[frame.texture].source.rgba), [84, 80, 230, 255, 238, 255, 255, 0]);
  assert.equal(made[frame.texture].part, 'sunglasses');
  assert.equal(lens.texture, -1);
  assert.equal(lens.translucent, true);
  assert.equal(lens.alphaTest, 0);
  assert.ok(lens.color, 'the lenses keep their vertex colours');
  assert.ok(!colors.PARTS.sunglasses, 'nothing on them takes Mario\'s colours');
});

test('shapes are told apart by the joint they hang off or their material', () => {
  const model = {
    joints: [{ name: 'mdl1' }, { name: 'M_head_cap1' }, { name: 'M_head' }, { name: 'M_hand1_L' }, { name: 'M_foot_R' }],
    materials: [{ name: '_mat_head' }, { name: '_mat_eye_L' }, { name: '_mat_mouse' }],
  };
  const part = (joint, material, index = 0) => partOf({ joint, material }, model, index);
  assert.equal(part(1, 0), 'cap');
  assert.equal(part(2, 0), 'head');
  assert.equal(part(2, 1), 'eye');
  assert.equal(part(2, 2), 'mouth');
  assert.equal(part(3, 0), 'hands');
  assert.equal(part(4, 0), 'feet');
  assert.equal(part(0, 0), 'body');
  assert.equal(part(0, 0, 10), 'aloha');
});

// --- Colour regions ---------------------------------------------------------

const region = id => colors.REGIONS.findIndex(r => r.id === id);
function image(width, height, paint) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set([...paint(x, y), 255], (y * width + x) * 4);
  return rgba;
}

test('the same red is the cap on the cap and the shirt on the body', () => {
  const red = image(2, 1, () => [214, 22, 28]), blue = image(1, 1, () => [24, 64, 196]);
  assert.equal(colors.classify(red, 2, 1, 'cap')[0], region('hat'));
  assert.equal(colors.classify(red, 2, 1, 'body')[0], region('shirt'));
  assert.equal(colors.classify(blue, 1, 1, 'body')[0], region('overalls'));
  assert.equal(colors.classify(image(1, 1, () => [250, 250, 255]), 1, 1, 'eye')[0], 255);
  const covered = Uint8Array.of(0, 1);
  assert.deepEqual([...colors.classify(red, 2, 1, 'body', covered)], [255, region('shirt')]);
});

test('the cap letter is the red the emblem encloses, even where the emblem is cut off', () => {
  // A white ring cut off at the left edge with red inside it, on red cap.
  const size = 12;
  const rgba = image(size, size, (x, y) => {
    const d = Math.hypot(x - 1, y - 6);
    return d < 2 ? [214, 22, 28] : d < 4.5 ? [246, 246, 246] : [214, 22, 28];
  });
  const mask = colors.classify(rgba, size, size, 'cap');
  assert.equal(mask[6 * size + 1], region('emblemLetter'));
  assert.equal(mask[6 * size + 0], region('emblemLetter'));
  assert.equal(mask[6 * size + 3], region('emblem'));
  assert.equal(mask[0], region('hat'));
  assert.equal(mask[6 * size + 10], region('hat'));
});

test("FLUDD's texture sorts into its body, metal, straps and trim, keeping the gauge's dark dot", () => {
  // Shades from FLUDD's texture on the disc, the ochre shading by its screw among them.
  const shades = [[[246, 228, 56], 'fluddBody'], [[189, 109, 16], 'fluddBody'], [[192, 192, 208], 'fluddMetal'],
    [[96, 96, 112], 'fluddMetal'], [[128, 48, 0], 'fluddStraps'], [[96, 48, 16], 'fluddStraps'], [[64, 64, 230], 'fluddTrim']];
  const mask = colors.classify(image(shades.length, 1, x => shades[x][0]), shades.length, 1, 'fludd');
  shades.forEach(([rgb, id], x) => assert.equal(mask[x], region(id), `${rgb} is ${id}`));
  assert.equal(colors.classify(image(1, 1, () => [16, 16, 20]), 1, 1, 'fludd')[0], 255);
});

test("Mario's presets change only Mario's colours, FLUDD's only FLUDD's", () => {
  assert.deepEqual(colors.FLUDD_REGIONS, ['fluddBody', 'fluddMetal', 'fluddStraps', 'fluddTrim']);
  for (const preset of colors.PRESETS)
    assert.ok(Object.keys(preset.colors).every(id => !colors.FLUDD_REGIONS.includes(id)), preset.id);
  for (const preset of colors.FLUDD_PRESETS) {
    assert.ok(Object.keys(preset.colors).every(id => colors.FLUDD_REGIONS.includes(id)), preset.id);
    assert.deepEqual(colors.normalize(preset.colors), preset.colors, preset.id);
  }
});

test('a part covers the texels its triangles reach, wrapping round a repeating texture', () => {
  const covered = colors.coverage(8, 8, Float32Array.of(0, 0, 0.5, 0, 0, 0.5), Uint32Array.of(0, 1, 2), undefined, 1, 1);
  assert.equal(covered[0], 1);
  assert.equal(covered[1 * 8 + 1], 1);
  assert.equal(covered[7 * 8 + 7], 1);  // one texel of margin wraps to the far corner
  assert.equal(covered[5 * 8 + 5], 0);
});

test('repainting keeps the shading and leaves unchosen regions alone', () => {
  // Shirt red in three shades beside overalls blue.
  const rgba = image(4, 1, x => [[214, 22, 28], [107, 11, 14], [240, 120, 120], [24, 64, 196]][x]);
  const texture = { rgba, width: 4, height: 1, mask: colors.classify(rgba, 4, 1, 'body'), lightness: colors.lightness(rgba) };
  const refs = colors.references([texture]);
  Object.assign(texture, { second: new Uint8Array(4).fill(255), mix: new Uint8Array(4) });
  assert.deepEqual([...colors.recolor(texture, refs, {})], [...rgba]);
  const green = colors.recolor(texture, refs, { shirt: '#20c040' });
  const [mid, dark, light] = [0, 1, 2].map(i => [...green.subarray(i * 4, i * 4 + 3)]);
  assert.ok(Math.abs(mid[0] - 0x20) < 30 && Math.abs(mid[1] - 0xc0) < 30 && Math.abs(mid[2] - 0x40) < 30, `mid ${mid}`);
  assert.ok(dark[1] < mid[1] && light[1] > mid[1], `shading ${dark} ${mid} ${light}`);
  assert.ok(light[0] > mid[0] && light[2] > mid[2], 'lighter texels move towards white');
  assert.deepEqual([...green.subarray(12, 16)], [24, 64, 196, 255]);
});

test('border texels blend the two regions they sit between', () => {
  const rgba = image(3, 1, x => [[214, 22, 28], [119, 43, 112], [24, 64, 196]][x]);
  const texture = { rgba, width: 3, height: 1, mask: colors.classify(rgba, 3, 1, 'body'), lightness: colors.lightness(rgba) };
  const refs = colors.references([texture]);
  const { second, mix } = colors.blendEdges(texture, refs);
  assert.ok(second[1] === region('shirt') || second[1] === region('overalls'));
  assert.ok(mix[1] > 60 && mix[1] < 200, `mix ${mix[1]}`);
  assert.equal(second[0], 255);
});

test('saved looks keep only known regions, #rrggbb colours and real nozzles', () => {
  assert.deepEqual(colors.normalizeLook({ colors: { hat: '#00FF00', shirt: 'green', cape: '#ffffff' }, aloha: 'yes', fludd: 1, nozzle: 'yoshi' }),
    { colors: { hat: '#00ff00' }, inGame: true, aloha: false, sunglasses: false, fludd: false, nozzle: 'spray' });
  assert.deepEqual(colors.normalizeLook(undefined), { colors: {}, inGame: true, aloha: false, sunglasses: false, fludd: false, nozzle: 'spray' });
  assert.deepEqual(colors.normalizeLook({ aloha: true, fludd: true, nozzle: 'hover' }), { colors: {}, inGame: true, aloha: true, sunglasses: false, fludd: true, nozzle: 'hover' });
  assert.equal(colors.normalizeLook({ sunglasses: true }).sunglasses, true);
  assert.equal(colors.normalizeLook({ sunglasses: 'yes' }).sunglasses, false, 'only an explicit true puts them on');
  assert.equal(colors.normalizeLook({ inGame: false }).inGame, false);
  assert.equal(colors.normalizeLook({ inGame: 'no' }).inGame, true, 'only an explicit false turns it off');
  for (const preset of colors.PRESETS) assert.deepEqual(colors.normalize(preset.colors), preset.colors, preset.id);
});

test('a damaged archive is refused before it can claim huge sizes', () => {
  const head = Buffer.alloc(16);
  head.write('Yaz0', 0, 'ascii'); head.writeUInt32BE(0xffffffff, 4);
  assert.throws(() => yaz0(head), /damaged/);
});
