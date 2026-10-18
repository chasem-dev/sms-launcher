'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const image = require('../src/texture-image');
const { xxh64 } = require('../src/xxh64');
const pack = require('../src/mario-pack');
const colors = require('../src/mario-colors');

// Bits written least significant first, as BC7 reads them.
function bits(fields) {
  const out = Buffer.alloc(16);
  let at = 0;
  for (const [value, count] of fields) for (let k = 0; k < count; k++, at++) if ((value >> k) & 1) out[at >> 3] |= 1 << (at & 7);
  assert.equal(at, 128);
  return out;
}

function dds(width, height, fourCC, body, dxgi = null) {
  const head = Buffer.alloc(128);
  head.write('DDS ', 0, 'ascii'); head.writeUInt32LE(124, 4); head.writeUInt32LE(height, 12); head.writeUInt32LE(width, 16);
  head.writeUInt32LE(32, 76); head.writeUInt32LE(4, 80); head.write(fourCC, 84, 'ascii');
  const dx10 = Buffer.alloc(dxgi === null ? 0 : 20);
  if (dxgi !== null) dx10.writeUInt32LE(dxgi, 0);
  return Buffer.concat([head, dx10, body]);
}

test('XXH64 matches its reference values', () => {
  assert.equal(xxh64(Buffer.alloc(0)), 'ef46db3751d8e999');
  assert.equal(xxh64(Buffer.from('abc')), '44bc2cf5ad770999');
  assert.equal(xxh64(Buffer.alloc(100, 7)).length, 16);
});

test('pack names follow the game: size, mip mark, data hash and format', () => {
  const level = Buffer.from('mario');
  assert.equal(pack.packName({ width: 256, height: 256, mipmapped: false, level, format: 14 }), `tex1_256x256_${xxh64(level)}_14`);
  assert.equal(pack.packName({ width: 16, height: 32, mipmapped: true, level, format: 5 }), `tex1_16x32_m_${xxh64(level)}_5`);
});

test('BC7 blocks decode: a solid mode 6 block and a two-subset mode 1 block', () => {
  // Mode 6: endpoints (R 100, G 0, B 64, A 127 with p-bit 1), every index 0.
  const solid = bits([[1 << 6, 7], [100, 7], [100, 7], [0, 7], [0, 7], [64, 7], [64, 7], [127, 7], [127, 7], [1, 1], [1, 1], [0, 3], [0, 60]]);
  const out = image.readDds(dds(4, 4, 'DX10', solid, 98));
  assert.deepEqual([...out.rgba.subarray(0, 4)], [201, 1, 129, 255]);
  assert.deepEqual([...out.rgba.subarray(60, 64)], [201, 1, 129, 255]);
  // Mode 1, partition 0 (texel 0 in subset 0, texel 3 in subset 1): red, then blue,
  // all at index 0; the shared p-bit 1 makes the zeros 2 once expanded.
  const two = bits([[1 << 1, 2], [0, 6], [63, 6], [63, 6], [0, 6], [0, 6], [0, 6], [0, 6], [0, 6], [0, 6], [0, 6], [0, 6], [63, 6], [63, 6], [1, 1], [1, 1], [0, 46]]);
  const split = image.readDds(dds(4, 4, 'DX10', two, 98));
  assert.deepEqual([...split.rgba.subarray(0, 4)], [255, 2, 2, 255]);
  assert.deepEqual([...split.rgba.subarray(12, 16)], [2, 2, 255, 255]);
});

test('BC1 and uncompressed DDS decode; other formats are refused', () => {
  const block = Buffer.alloc(8);
  block.writeUInt16LE(0xf800, 0); block.writeUInt16LE(0x001f, 2); block.writeUInt32LE(0b01, 4);
  const bc1 = image.readDds(dds(4, 4, 'DXT1', block));
  assert.deepEqual([...bc1.rgba.subarray(0, 8)], [0, 0, 255, 255, 255, 0, 0, 255]);
  const rgba = image.readDds(dds(1, 1, 'DX10', Buffer.from([1, 2, 3, 4]), 28));
  assert.deepEqual([...rgba.rgba], [1, 2, 3, 4]);
  assert.throws(() => image.readDds(dds(4, 4, 'DX10', Buffer.alloc(16), 95)), /cannot read/);
});

test('PNG files round-trip, and filtered PNGs read back', () => {
  const pixels = Uint8Array.from({ length: 3 * 2 * 4 }, (_, i) => (i * 37) & 255);
  const back = image.readPng(image.writePng(3, 2, pixels));
  assert.deepEqual([back.width, back.height], [3, 2]);
  assert.deepEqual([...back.rgba], [...pixels]);
  // An RGB PNG whose second row uses the Up filter.
  const zlib = require('node:zlib');
  const raw = Buffer.from([0, 10, 20, 30, 2, 5, 5, 5]);
  const chunk = (name, body) => { const h = Buffer.alloc(8); h.writeUInt32BE(body.length, 0); h.write(name, 4, 'ascii'); return Buffer.concat([h, body, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  assert.deepEqual([...image.readPng(png).rgba], [10, 20, 30, 255, 15, 25, 35, 255]);
});

test('pack folders are searched like the game: the first folder with a name wins', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-mario-pack-'));
  try {
    for (const [dir, file] of [['a/mario', 'tex1_8x8_aa_14.dds'], ['b', 'tex1_8x8_aa_14.png'], ['b', 'tex1_8x8_bb_14_arb.png'],
      ['b/widescreen_stars_fix', 'tex1_8x8_cc_0.png'], ['b', 'notes.txt']]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, file), '');
    }
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.writeFileSync(path.join(root, 'elsewhere', 'tex1_8x8_dd_14.png'), '');
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'b', 'linked'), 'dir');
    const index = pack.packIndex([path.join(root, 'a'), path.join(root, 'b'), path.join(root, 'missing')]);
    assert.equal(index.get('tex1_8x8_dd_14'), path.join(root, 'b', 'linked', 'tex1_8x8_dd_14.png'), 'linked folders are followed');
    index.delete('tex1_8x8_dd_14');
    assert.equal(index.get('tex1_8x8_aa_14'), path.join(root, 'a', 'mario', 'tex1_8x8_aa_14.dds'));
    assert.equal(index.get('tex1_8x8_bb_14'), path.join(root, 'b', 'tex1_8x8_bb_14_arb.png'));
    assert.equal(index.has('tex1_8x8_cc_0'), false);
    assert.equal(index.size, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('edge texels of a clamped texture are not covered from its far side, of a repeating one they are', () => {
  const tri = Float32Array.of(0, 0, 0.25, 0, 0, 1), index = Uint32Array.of(0, 1, 2);
  assert.equal(colors.coverage(8, 8, tri, index)[4 * 8 + 7], 0);
  assert.equal(colors.coverage(8, 8, tri, index, undefined, 1, 1)[4 * 8 + 7], 1);
  assert.equal(colors.coverage(8, 8, tri, index, undefined, 2, 2)[4 * 8 + 7], 0, 'a mirror reflects back onto the near edge');
});

test('one texture shared by two parts is repainted per part and merged', () => {
  // Left column red and right column red: the cap's triangle covers the left, the body's the right.
  const width = 8, height = 8, rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) rgba.set([214, 22, 28, 255], i * 4);
  const tri = (x0, x1) => ({ uv: Float32Array.of(x0, 0, x1, 0, x0, 1, x1, 1), index: Uint32Array.of(0, 2, 1, 1, 2, 3) });
  const parts = new Map([['body', [tri(0.75, 1)]], ['cap', [tri(0, 0.25)]]]);
  const references = colors.REGIONS.map(region => region.id === 'hat' || region.id === 'shirt' ? { color: '#d6161c', lightness: 47 } : null);
  const out = pack.repaint({ width, height, rgba }, parts, references, { hat: '#00ff00', shirt: '#0000ff' });
  const at = (x, y) => [...out.subarray((y * width + x) * 4, (y * width + x) * 4 + 3)];
  assert.ok(at(0, 4)[1] > 150 && at(0, 4)[2] < 80, `cap texel ${at(0, 4)}`);
  assert.ok(at(7, 4)[2] > 150 && at(7, 4)[1] < 80, `body texel ${at(7, 4)}`);
  assert.deepEqual(at(4, 4), [214, 22, 28], 'texels no part covers keep the disc colour');
});

test('a look goes to other players as its chosen regions in order, only real regions with colours', () => {
  assert.equal(pack.lookText({ colors: { shirt: '#2FA846', hat: '#2fa846', overalls: '#21338c', nonsense: '#000000', shoes: 'red' } }),
    'hat=2fa846;shirt=2fa846;overalls=21338c');
  assert.equal(pack.lookText({ colors: {} }), '');
  assert.equal(pack.lookText(null), '');
});

test('a paint file holds the picture and, per texel, region, blend region, blend share and lightness', () => {
  const rgba = Uint8Array.from([1, 2, 3, 255, 4, 5, 6, 255]);
  const map = { mask: Uint8Array.from([0, 255]), second: Uint8Array.from([255, 255]), mix: Uint8Array.from([0, 0]),
    lightness: Uint8Array.from([10, 20]) };
  const file = pack.paintFile({ width: 2, height: 1, rgba }, map);
  assert.equal(file.toString('ascii', 0, 8), 'SMSPAINT');
  assert.deepEqual([file.readUInt32LE(8), file.readUInt32LE(12), file.readUInt32LE(16)], [1, 2, 1]);
  assert.equal(file.length, 20 + 2 * 8);
  assert.deepEqual([...file.subarray(20, 28)], [...rgba]);
  assert.deepEqual([...file.subarray(28)], [0, 255, 255, 255, 0, 0, 10, 20]);
});
