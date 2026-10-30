'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { packsFrom, packsIn, checkModel, install, freeId } = require('../src/character-install');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'character-install-'));
const accept = () => {};
const file = (name, text) => ({ name, data: Buffer.from(text) });

// A zip of stored entries, enough for unzip().
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const n = Buffer.from(name), crc = zlib.crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data); centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test('packs are found in folders with a model.szs, and loose archives are packs of their own', () => {
  const packs = packsIn([
    file('chars/toad/model.szs', 'T'), file('chars/toad/name.txt', 'Toad\n'), file('chars/toad/voice/MV_JUMP.wav', 'w'),
    file('chars/toad/voice/notes.txt', 'x'), file('chars/Big Boo.szs', 'B'), file('readme.txt', 'r'),
  ], 'chars');
  assert.deepEqual(packs.map(({ id, name, named, model, voice }) => [id, name, named, String(model), voice.map(v => v.name)]), [
    ['toad', 'Toad', true, 'T', ['MV_JUMP.wav']],
    ['big-boo', 'Big Boo', false, 'B', []],
  ]);
  // a zip of one pack's own files (model.szs at its root) is named after the zip
  assert.equal(packsIn([file('model.szs', 'M')], 'Rivet')[0].id, 'rivet');
});

test('a zip, a folder and a lone .szs all give their packs', () => {
  const dir = temp();
  try {
    fs.writeFileSync(path.join(dir, 'pack.zip'), zip([file('peach/model.szs', 'P'), file('peach/name.txt', 'Peach')]));
    assert.deepEqual(packsFrom(path.join(dir, 'pack.zip')).map(p => [p.id, p.name]), [['peach', 'Peach']]);
    fs.mkdirSync(path.join(dir, 'daisy'));
    fs.writeFileSync(path.join(dir, 'daisy', 'model.szs'), 'D');
    assert.deepEqual(packsFrom(path.join(dir, 'daisy')).map(p => [p.id, p.name]), [['daisy', 'Daisy']]);
    fs.writeFileSync(path.join(dir, 'dry-bones.szs'), 'X');
    assert.deepEqual(packsFrom(path.join(dir, 'dry-bones.szs')).map(p => [p.id, p.name]), [['dry-bones', 'Dry Bones']]);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    assert.throws(() => packsFrom(path.join(dir, 'notes.txt')), /not a character/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('installing writes the pack; a new model for an installed character keeps its name and voice', () => {
  const dir = temp();
  try {
    install(dir, { id: 'toad', name: 'Toad', named: true, model: Buffer.from('v1'), voice: [{ name: 'MV_JUMP.wav', data: Buffer.from('w') }] }, 'toad', accept);
    install(dir, { id: 'toad', name: 'Toad Refined', named: false, model: Buffer.from('v2'), voice: [] }, 'toad', accept);
    assert.equal(fs.readFileSync(path.join(dir, 'toad', 'model.szs'), 'utf8'), 'v2');
    assert.equal(fs.readFileSync(path.join(dir, 'toad', 'name.txt'), 'utf8'), 'Toad\n');
    assert.equal(fs.readFileSync(path.join(dir, 'toad', 'voice', 'MV_JUMP.wav'), 'utf8'), 'w');
    assert.equal(freeId(dir, 'toad'), 'toad-2');
    assert.deepEqual(fs.readdirSync(dir), ['toad']);  // nothing left from staging
    assert.throws(() => install(dir, { id: 'x', name: 'X', model: Buffer.from('junk'), voice: [] }), /not a game archive/);
    assert.deepEqual(fs.readdirSync(dir), ['toad']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('only whole Mario archives pass the model check', () => {
  assert.throws(() => checkModel(Buffer.from('not an archive'), 'junk.szs'), /junk\.szs is not a game archive/);
});
