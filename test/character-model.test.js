'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const roster = require('../src/character-roster');
const { ECLIPSE_ISO } = require('../src/port');

const { writeRarc } = require('../src/rarc-write');
const { rarc } = require('../src/archive');

// A disc whose data/ folder holds these files ({ 'mario.szs': data }).
function discWith(files) {
  const entries = Object.entries(files), table = Buffer.alloc((2 + entries.length) * 12);
  const names = Buffer.from(['data', ...entries.map(([name]) => name)].map(n => `${n}\0`).join(''), 'latin1');
  table.writeUInt32BE(0x01000000, 0); table.writeUInt32BE(2 + entries.length, 8);
  table.writeUInt32BE(0x01000000, 12); table.writeUInt32BE(2 + entries.length, 20);
  let at = 0x2000, name = 5;
  const data = [];
  entries.forEach(([file, bytes], i) => {
    table.writeUInt32BE(name, 24 + i * 12); table.writeUInt32BE(at, 28 + i * 12); table.writeUInt32BE(bytes.length, 32 + i * 12);
    data.push([at, bytes]);
    name += file.length + 1;
    at += (bytes.length + 0x7ff) & ~0x7ff;
  });
  const fst = Buffer.concat([table, names]), disc = Buffer.alloc(at);
  disc.write('GMSE01', 0, 'ascii');
  disc.writeUInt32BE(0x1000, 0x424); disc.writeUInt32BE(fst.length, 0x428);
  fst.copy(disc, 0x1000);
  for (const [offset, bytes] of data) bytes.copy(disc, offset);
  return disc;
}
// A Mario archive: { folder: { file: text } }.
const archive = folders => writeRarc({ name: 'mario', files: [],
  dirs: Object.entries(folders).map(([name, files]) => ({ name, dirs: [], files: Object.entries(files).map(([n, text]) => ({ name: n, data: Buffer.from(text), flags: 0x11 })) })) });

test('the roster is Mario, ready from the disc, then the characters made from it', () => {
  assert.deepEqual(roster.list(null).map(({ id, ready }) => [id, ready]), roster.ROSTER.map(c => [c.id, c.id === 'mario']));
  assert.throws(() => roster.find('waluigi'), /no character waluigi/);
});

test('a made character is ready until its builder changes, and keeps a voice the player added', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
  try {
    const shadow = roster.find('shadow-mario'), folder = path.join(roster.packsDirectory(root), 'shadow-mario');
    roster.install(root, shadow, { 'model.szs': Buffer.from('archive'), 'extra.bin': Buffer.from('x') });
    assert.equal(roster.list(root).find(c => c.id === 'shadow-mario').ready, true);
    assert.equal(fs.readFileSync(path.join(folder, 'name.txt'), 'utf8'), 'Shadow Mario\n');
    fs.mkdirSync(path.join(folder, 'voice'));
    fs.writeFileSync(path.join(folder, 'voice', 'MV_JUMP.wav'), 'w');
    roster.install(root, shadow, { 'model.szs': Buffer.from('again') });
    assert.equal(fs.readFileSync(path.join(folder, 'model.szs'), 'utf8'), 'again');
    assert.equal(fs.existsSync(path.join(folder, 'extra.bin')), false);
    assert.equal(fs.readFileSync(path.join(folder, 'voice', 'MV_JUMP.wav'), 'utf8'), 'w');
    fs.writeFileSync(path.join(folder, '.launcher.json'), JSON.stringify({ version: shadow.version - 1 }));
    assert.equal(roster.list(root).find(c => c.id === 'shadow-mario').ready, false);
    assert.deepEqual(fs.readdirSync(roster.packsDirectory(root)), ['shadow-mario']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a made character\'s own voice replaces the one before it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
  try {
    const peach = roster.find('princess-peach'), voice = path.join(roster.packsDirectory(root), 'princess-peach', 'voice');
    roster.install(root, peach, { 'model.szs': Buffer.from('archive'), 'voice/MV21_JUMP_SMALL_01.wav': Buffer.from('made') });
    fs.writeFileSync(path.join(voice, 'MV_OLD.wav'), 'old');
    roster.install(root, peach, { 'model.szs': Buffer.from('again'), 'voice/MV21_JUMP_SMALL_01.wav': Buffer.from('remade') });
    assert.deepEqual(fs.readdirSync(voice), ['MV21_JUMP_SMALL_01.wav']);
    assert.equal(fs.readFileSync(path.join(voice, 'MV21_JUMP_SMALL_01.wav'), 'utf8'), 'remade');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('packs the launcher made of characters it no longer offers are removed, and no others', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
  try {
    const directory = roster.packsDirectory(root), pack = (id, stamped) => {
      fs.mkdirSync(path.join(directory, id), { recursive: true });
      fs.writeFileSync(path.join(directory, id, 'model.szs'), 'x');
      if (stamped) fs.writeFileSync(path.join(directory, id, '.launcher.json'), '{"version":4}');
    };
    pack('sunshine-toad', true);
    pack('luigi', false);
    pack('shadow-mario', true);
    pack('.staging-roxxy-1', true);
    assert.deepEqual(roster.removeRetired(root), ['sunshine-toad']);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['.staging-roxxy-1', 'luigi', 'shadow-mario']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a pack of the player\'s own is never replaced by a made character', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
  try {
    const own = path.join(roster.packsDirectory(root), 'shadow-mario');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'model.szs'), 'mine');
    assert.throws(() => roster.install(root, roster.find('shadow-mario'), { 'model.szs': Buffer.from('made') }), /of your own/);
    assert.equal(fs.readFileSync(path.join(own, 'model.szs'), 'utf8'), 'mine');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// A characters folder holding these files ({ 'waluigi/model.szs': text }), for `use`.
function withPacks(files, use) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
  try {
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(roster.packsDirectory(root), name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
    return use(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const own = root => roster.list(root).filter(c => c.own);

test('the player\'s own packs are listed after the launcher\'s, as the game finds them', () => withPacks({
  'waluigi/model.szs': 'pack', 'waluigi/name.txt': '\uFEFFWaluigi Deluxe  \r\nsecond line\n',
  'Dry Bones/model.szs': 'pack',
  'dark_mario-2.szs': 'loose',
  'wario.szs': 'loose', 'wario.txt': 'Wario\n',
}, root => {
  const list = roster.list(root);
  assert.deepEqual(list.slice(0, roster.ROSTER.length).map(c => c.id), roster.ROSTER.map(c => c.id));
  assert.deepEqual(own(root).map(({ id, name }) => [id, name]), [
    ['Dry Bones', 'Dry Bones'], ['dark_mario-2', 'Dark mario 2'], ['waluigi', 'Waluigi Deluxe'], ['wario', 'Wario']]);
  assert.ok(own(root).every(c => c.ready && c.makeable && c.about));
  assert.equal(roster.archive(root, null, 'waluigi').toString(), 'pack');
  assert.equal(roster.archive(root, null, 'wario').toString(), 'loose');
  assert.equal(roster.find('Dry Bones', root).name, 'Dry Bones');
  assert.throws(() => roster.find('Dry Bones'), /no character/, 'without a game folder there are no packs');
  assert.equal(roster.build(root, null, 'waluigi'), undefined, 'a pack has nothing to make');
}));

test('what isn\'t a pack of the player\'s own is left out', () => withPacks({
  'empty/name.txt': 'No model',
  '.staging-x/model.szs': 'being made',
  '.hidden.szs': 'dot',
  'mario/model.szs': 'the disc\'s', 'MARIO.szs': 'the disc\'s',
  'notes.txt': 'not a pack',
  'made/model.szs': 'launcher\'s', 'made/.launcher.json': '{"version":1}',
  'bad[name]/model.szs': 'settings can\'t keep this id',
}, root => assert.deepEqual(own(root), [])));

test('a folder and a loose pack of one id, or two ids in different case, are one character', () => withPacks({
  'twin/model.szs': 'folder', 'twin.szs': 'loose', 'Double/model.szs': 'first', 'double/model.szs': 'second',
}, root => {
  assert.deepEqual(own(root).map(c => c.id), ['Double', 'twin']);
  assert.equal(roster.archive(root, null, 'twin').toString(), 'folder');
  assert.equal(roster.archive(root, null, 'Double').toString(), 'first');
}));

test('a pack of the player\'s own in a character\'s place is shown there, with its name, and nothing is made', () => withPacks({
  'luigi/model.szs': 'mine', 'luigi/name.txt': 'My Luigi', 'Shadow-Mario/model.szs': 'mine too',
}, root => {
  const list = roster.list(root), luigi = list.find(c => c.id === 'luigi');
  assert.equal(list.length, roster.ROSTER.length);
  assert.deepEqual([luigi.name, luigi.ready, luigi.makeable, luigi.own], ['My Luigi', true, true, true]);
  assert.equal(list.find(c => c.id === 'shadow-mario').own, true, 'the game takes an id in any case');
  assert.equal(roster.archive(root, null, 'shadow-mario').toString(), 'mine too');
  assert.equal(roster.find('luigi', root).name, 'My Luigi');
  assert.equal(roster.build(root, null, 'luigi'), undefined);
  assert.equal(fs.readFileSync(path.join(roster.packsDirectory(root), 'luigi', 'model.szs'), 'utf8'), 'mine');
}));

test('a pack keeps its outfit, until it is gone from a folder that can be read', () => {
  assert.equal(roster.offers(null, 'waluigi'), true, 'no game folder: it can\'t be looked for');
  assert.equal(roster.offers(null, 'princess-peach'), true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
  try {
    assert.equal(roster.offers(root, 'waluigi'), true, 'no characters folder (a link to a drive that isn\'t there)');
    fs.mkdirSync(path.join(roster.packsDirectory(root), 'waluigi'), { recursive: true });
    assert.equal(roster.offers(root, 'waluigi'), false, 'its folder has no model');
    assert.equal(roster.offers(root, 'mario'), true);
    fs.writeFileSync(path.join(roster.packsDirectory(root), 'waluigi', 'model.szs'), 'pack');
    assert.equal(roster.offers(root, 'waluigi'), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Luigi is made from the Super Mario Eclipse set up once, on the disc\'s own Mario, and stays made without it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
  try {
    const luigi = () => roster.list(root).find(c => c.id === 'luigi');
    const rom = path.join(root, 'sunshine.iso');
    fs.writeFileSync(rom, discWith({ 'mario.szs': archive({ bmd: { 'ma_mdl1.bmd': 'Mario', 'ma_cap1.bmd': 'cap' }, bck: { 'ma_wait.bck': 'wait', 'ma_jump.bck': 'jump' }, watergun2: { 'wg.bmd': 'FLUDD' } }) }));
    assert.deepEqual([luigi().ready, luigi().makeable], [false, false]);
    assert.equal(roster.list(root).find(c => c.id === 'princess-peach').makeable, true);
    assert.throws(() => roster.build(root, rom, 'luigi'), /comes from Super Mario Eclipse/);
    // Eclipse's Mario and Luigi without the animations and FLUDD (in its common archive), Luigi with his own model and jump
    fs.mkdirSync(path.dirname(path.join(root, ECLIPSE_ISO)), { recursive: true });
    fs.writeFileSync(path.join(root, ECLIPSE_ISO), discWith({
      'mario.szs': archive({ bmd: { 'ma_mdl1.bmd': 'Mario', 'ma_cap1.bmd': 'cap' } }),
      'luigi.szs': archive({ bmd: { 'ma_mdl1.bmd': 'Luigi', 'ma_cap1.bmd': 'cap' }, bck: { 'ma_jump.bck': 'Luigi\'s jump' } }),
    }));
    assert.equal(luigi().makeable, true);
    // his voice (Mario's, as Eclipse voices him: character-voice.test.js) set aside: these discs have no sound
    const character = roster.find('luigi'), { voice } = character;
    assert.deepEqual([voice.mario, voice.pitch, voice.swap.MV21_JUMP_SMALL], [true, 0.95, 'MV41_JUMP_T_01']);
    delete character.voice;
    try { roster.build(root, rom, 'luigi'); } finally { character.voice = voice; }
    const folder = path.join(roster.packsDirectory(root), 'luigi');
    const made = rarc(fs.readFileSync(path.join(folder, 'model.szs')));
    assert.deepEqual(Object.fromEntries([...made].map(([name, data]) => [name, data.toString()])), {
      'bmd/ma_mdl1.bmd': 'Luigi', 'bmd/ma_cap1.bmd': 'cap', 'bck/ma_wait.bck': 'wait', 'bck/ma_jump.bck': 'Luigi\'s jump', 'watergun2/wg.bmd': 'FLUDD' });
    assert.equal(fs.readFileSync(path.join(folder, 'name.txt'), 'utf8'), 'Luigi\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(folder, '.launcher.json'), 'utf8')).version, '3-v1.1.0');
    fs.rmSync(path.join(root, ECLIPSE_ISO));
    assert.deepEqual([luigi().ready, luigi().makeable], [true, false]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a model with a normal of its own on each face is drawn smooth, and smooth models keep their normals', () => {
  const { smoothFacets } = require('../src/character-model');
  // two faces of a shallow roof meeting along an edge at 60 degrees, each corner with its face's normal
  const position = Float32Array.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, -1, -1, 0, 1, -1, 0]);
  const roof = (x, y) => Float32Array.from([-x, y, 0, -x, y, 0, x, y, 0, x, y, 0, -x, y, 0, x, y, 0]);
  const normal = roof(0.5, Math.sqrt(0.75)), drawIndex = new Uint16Array(6);
  const smoothed = smoothFacets({ position, normal, drawIndex });
  for (const v of [0, 1, 2, 3]) assert.deepEqual([...smoothed.subarray(v * 3, v * 3 + 3)].map(x => Math.round(x * 1000) / 1000 + 0), [0, 1, 0]);
  assert.deepEqual([...smoothed.subarray(12)], [...normal.subarray(12)]);
  // a sharp edge (90 degrees) stays sharp
  const sharp = roof(Math.SQRT1_2, Math.SQRT1_2);
  assert.deepEqual([...smoothFacets({ position, normal: sharp, drawIndex })], [...sharp]);
  // corners on different joints stay apart
  assert.equal(smoothFacets({ position, normal, drawIndex: Uint16Array.from([0, 0, 1, 1, 0, 1]) }), normal);
  // corners that already share their normals are left as they are
  const smooth = Float32Array.from({ length: 18 }, (_, i) => i % 3 === 1 ? 1 : 0);
  assert.equal(smoothFacets({ position, normal: smooth, drawIndex }), smooth);
});

test('the cap is the one the game draws: ma_cap1 on the head, in the body\'s texture, not the body\'s own cap shape', () => {
  const j3d = require('../src/j3d');
  const { loadCharacter } = require('../src/character-model');
  const shape = (material, drawIndex, tag) => ({ material, position: Float32Array.of(tag, 0, 0, tag, 1, 0, tag, 0, 1), normal: new Float32Array(9),
    uv: new Float32Array(6), color: new Float32Array(12), drawIndex: new Uint16Array(3).fill(drawIndex), index: Uint32Array.of(0, 1, 2) });
  const texture = name => ({ name, width: 1, height: 1, rgba: new Uint8Array(4), wrapS: 0, wrapT: 0 });
  const body = {
    joints: [{ name: 'jnt_center' }, { name: 'M_head' }, { name: 'M_head_cap1' }], draw: [{ weighted: false, index: 0 }, { weighted: false, index: 1 }],
    envelopes: [], inverseBind: [], textures: [texture('H_ma_new_main')], materials: [{ textures: [0] }],
    shapes: [0, 1, 2, 3, 4].map(i => shape(0, 0, i)),
  };
  const cap = { joints: [{ name: 'null_weight_A' }], draw: [{ weighted: false, index: 0 }], textures: [texture('H_ma_main_dummy')],
    materials: [{ textures: [0] }], shapes: [shape(0, 0, 9)] };
  const parse = j3d.parseBmd;
  j3d.parseBmd = data => (data.toString() === 'cap' ? cap : body);
  try {
    const files = new Map([['bmd/ma_mdl1.bmd', Buffer.from('body')], ['bmd/ma_cap1.bmd', Buffer.from('cap')]]);
    const { shapes, textures } = loadCharacter({ id: 'luigi', name: 'Luigi' }, files);
    assert.deepEqual(shapes.map(s => s.position[0]), [0, 1, 2, 3, 9]);
    const drawn = shapes.at(-1);
    assert.deepEqual([...drawn.drawIndex], [1, 1, 1]);
    assert.equal(textures[drawn.texture].name, 'H_ma_new_main');
    // without ma_cap1, the body's own cap shape stays
    files.delete('bmd/ma_cap1.bmd');
    assert.deepEqual(loadCharacter({ id: 'luigi', name: 'Luigi' }, files).shapes.map(s => s.position[0]), [0, 1, 2, 3, 4]);
  } finally { j3d.parseBmd = parse; }
});
