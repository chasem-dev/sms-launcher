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
    roster.install(root, shadow, { 'model.szs': Buffer.from('archive'), 'look.bmd': Buffer.from('look') });
    assert.equal(roster.list(root).find(c => c.id === 'shadow-mario').ready, true);
    assert.equal(fs.readFileSync(path.join(folder, 'name.txt'), 'utf8'), 'Shadow Mario\n');
    fs.mkdirSync(path.join(folder, 'voice'));
    fs.writeFileSync(path.join(folder, 'voice', 'MV_JUMP.wav'), 'w');
    roster.install(root, shadow, { 'model.szs': Buffer.from('again') });
    assert.equal(fs.readFileSync(path.join(folder, 'model.szs'), 'utf8'), 'again');
    assert.equal(fs.existsSync(path.join(folder, 'look.bmd')), false);
    assert.equal(fs.readFileSync(path.join(folder, 'voice', 'MV_JUMP.wav'), 'utf8'), 'w');
    fs.writeFileSync(path.join(folder, '.launcher.json'), JSON.stringify({ version: shadow.version - 1 }));
    assert.equal(roster.list(root).find(c => c.id === 'shadow-mario').ready, false);
    assert.deepEqual(fs.readdirSync(roster.packsDirectory(root)), ['shadow-mario']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
