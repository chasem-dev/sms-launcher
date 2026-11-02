'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const portraits = require('../src/outfit-portraits');

// A 1×1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('portraits are kept by key and read back; unknown ones are null and bad keys ignored', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portraits-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  portraits.save(directory, 'mario-0123abcd-89abcdef', PNG);
  assert.deepEqual(portraits.read(directory, ['mario-0123abcd-89abcdef', 'luigi-00000000', '../x', 5]),
    { 'mario-0123abcd-89abcdef': PNG, 'luigi-00000000': null });
});

test('only PNGs with plain names are kept', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portraits-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => portraits.save(directory, '../escape', PNG));
  assert.throws(() => portraits.save(directory, 'mario', 'data:image/jpeg;base64,AAAA'));
  assert.throws(() => portraits.save(directory, 'mario', 'data:image/png;base64,' + Buffer.from('not a png').toString('base64')));
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('the oldest portraits beyond the limit are removed', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portraits-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const png = Buffer.from(PNG.split(',')[1], 'base64');
  for (let i = 0; i < portraits.MAX + 3; i++) {
    const file = path.join(directory, `p-${i}.png`);
    fs.writeFileSync(file, png);
    fs.utimesSync(file, 1000 + i, 1000 + i);
  }
  portraits.prune(directory);
  const left = fs.readdirSync(directory);
  assert.equal(left.length, portraits.MAX);
  assert.ok(!left.includes('p-0.png') && !left.includes('p-2.png') && left.includes('p-3.png'));
});
