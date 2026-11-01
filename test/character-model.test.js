'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const roster = require('../src/character-roster');

test('the roster is Mario, ready from the disc, then the characters made from it', () => {
  assert.deepEqual(roster.list(null).map(({ id, ready }) => [id, ready]), roster.ROSTER.map(c => [c.id, c.id === 'mario']));
  assert.throws(() => roster.find('luigi'), /no character luigi/);
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
