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
    assert.equal(roster.list(root).find(c => c.id === 'shadow-mario').ready, false);
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
