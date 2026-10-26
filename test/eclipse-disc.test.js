'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eclipseDisc = require('../src/eclipse-disc');
const { gcm, ciso } = require('./disc-fixture');

const md5 = bytes => crypto.createHash('md5').update(bytes).digest('hex');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eclipse-disc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('takes the MD5 Eclipse needs from the game\'s get.py, or the one it ships with', t => {
  const root = scratch(t);
  assert.equal(eclipseDisc.expectedMd5(root), eclipseDisc.SOURCE_MD5);
  fs.mkdirSync(path.join(root, 'tools', 'mods'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'mods', 'get.py'),
    'ECLIPSE = {\n    "md5": "37c1805ab88b2a3bb2a96bcdf6884433",\n    "source_md5": "0123456789abcdef0123456789abcdef",  # GMSE01\n}\n');
  assert.equal(eclipseDisc.expectedMd5(root), '0123456789abcdef0123456789abcdef');
});

test('streams the disc through MD5', async t => {
  const file = path.join(scratch(t), 'disc.iso'), disc = gcm();
  fs.writeFileSync(file, disc);
  assert.equal(await eclipseDisc.md5File(file), md5(disc));
});

test('accepts the disc Eclipse patches and refuses another copy in plain words', async t => {
  const dir = scratch(t), full = path.join(dir, 'full.iso'), compressed = path.join(dir, 'disc.ciso');
  fs.writeFileSync(full, gcm());
  fs.writeFileSync(compressed, ciso(gcm()));
  const expected = md5(gcm());
  assert.equal(await eclipseDisc.check(full, { expected, cache: new Map() }), expected);
  await assert.rejects(eclipseDisc.check(compressed, { expected, cache: new Map() }), error =>
    error.eclipseDisc && error.expected === expected && error.md5 === md5(ciso(gcm())) &&
    /full 1:1 copy of the North American \(USA\) disc/.test(error.message) && /Sunshine still plays from it/.test(error.message));
  // With a game folder, the hash comes from its get.py.
  await assert.rejects(eclipseDisc.check(full, { root: dir, cache: new Map() }), /can't patch it/);
});

test('hashes a disc once per path, size and modification time', async t => {
  const file = path.join(scratch(t), 'disc.iso');
  fs.writeFileSync(file, gcm());
  const cache = new Map();
  let reads = 0;
  const hash = async () => { reads++; return 'aa'.repeat(16); };
  await Promise.all([eclipseDisc.check(file, { expected: 'aa'.repeat(16), hash, cache }),
    eclipseDisc.check(file, { expected: 'aa'.repeat(16), hash, cache })]);
  await assert.rejects(eclipseDisc.check(file, { expected: 'bb'.repeat(16), hash, cache }));
  assert.equal(reads, 1);
  // A replaced disc file at the same path is read again.
  fs.writeFileSync(file, Buffer.concat([gcm(), Buffer.alloc(16)]));
  await eclipseDisc.check(file, { expected: 'aa'.repeat(16), hash, cache });
  assert.equal(reads, 2);
  // A read that fails is tried again next time.
  const failing = async () => { reads++; throw new Error('read failed'); };
  const other = path.join(path.dirname(file), 'other.iso');
  fs.writeFileSync(other, gcm());
  await assert.rejects(eclipseDisc.check(other, { expected: 'aa'.repeat(16), hash: failing, cache }), /read failed/);
  await eclipseDisc.check(other, { expected: 'aa'.repeat(16), hash, cache });
  assert.equal(reads, 4);
});
