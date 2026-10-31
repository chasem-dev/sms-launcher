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
