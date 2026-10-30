'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listCharacters } = require('../src/character-model');

test('the Characters page lists Mario, then each pack in mods/characters by its shown name', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'characters-'));
  try {
    const packs = path.join(root, 'mods', 'characters');
    const pack = (id, name) => {
      fs.mkdirSync(path.join(packs, id), { recursive: true });
      fs.writeFileSync(path.join(packs, id, 'model.szs'), '');
      if (name) fs.writeFileSync(path.join(packs, id, 'name.txt'), `${name}\n`);
    };
    pack('toad', 'Toad');
    pack('dk', 'Donkey Kong');
    pack('nameless');
    fs.mkdirSync(path.join(packs, 'voice-only'));            // no model: not a character
    fs.writeFileSync(path.join(packs, 'yoshi.szs'), '');      // a loose archive
    fs.writeFileSync(path.join(packs, 'readme.txt'), '');
    assert.deepEqual(listCharacters(root).map(({ id, name, file }) => [id, name, file && path.relative(packs, file)]), [
      ['mario', 'Mario', null],
      ['dk', 'Donkey Kong', path.join('dk', 'model.szs')],
      ['nameless', 'nameless', path.join('nameless', 'model.szs')],
      ['toad', 'Toad', path.join('toad', 'model.szs')],
      ['yoshi', 'yoshi', 'yoshi.szs'],
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('without a game folder or packs, only Mario is listed', () => {
  assert.deepEqual(listCharacters(null).map(c => c.id), ['mario']);
  assert.deepEqual(listCharacters(path.join(os.tmpdir(), 'no-such-game-folder')).map(c => c.id), ['mario']);
});
