'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const icons = require('../src/achievement-icons');
const { zip } = require('./zip-fixture');

function temporary(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The release's layout: achievements/<id>.png, and Super Mario Eclipse's in achievements/eclipse/.
const release = (names = ['achievements/1.png', 'achievements/2.png', 'achievements/eclipse/1.png']) =>
  zip(names.map(name => ({ name, data: Buffer.from(`png ${name}`), deflate: true })));

// Stands in for build-tools' fetchVerified: "downloads" `data` to the destination and notes what it was asked for.
function fakeFetch(data, asked = []) {
  return async (url, destination, expected, onProgress, options) => {
    asked.push({ url, expected, ...options });
    onProgress(50);
    fs.writeFileSync(destination, data);
  };
}

function pinGame(root, pin) {
  fs.mkdirSync(path.join(root, 'tools', 'mods'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'mods', 'achievement-icons.json'), JSON.stringify(pin));
}

test('a game from before achievements, or none yet, gets the launcher\'s pin; a game with its own uses that', t => {
  const root = temporary(t, 'sms-icons-game-');
  assert.equal(icons.pinned(null), icons.BUNDLED);
  assert.equal(icons.pinned(root), icons.BUNDLED);
  assert.match(icons.BUNDLED.url, /^https:\/\/github\.com\/chasem-dev\/sms-hd-texture-extras\/releases\/download\//);
  assert.match(icons.BUNDLED.md5, /^[0-9a-f]{32}$/);
  const own = { name: 'newer icons', url: 'https://example.com/icons.zip', file: 'icons.zip', md5: 'a'.repeat(32) };
  pinGame(root, own);
  assert.deepEqual(icons.pinned(root), own);
  pinGame(root, { md5: 'not a sum' });                       // a broken pin: the launcher's
  assert.equal(icons.pinned(root), icons.BUNDLED);
});

test('the icons download into the launcher\'s folder, for any game version, and the game folder is left alone', async t => {
  const userData = temporary(t, 'sms-icons-user-'), root = temporary(t, 'sms-icons-game-');
  assert.equal(icons.wanted(userData, root), true);
  assert.equal(icons.folder(userData, root), null);
  const asked = [], progress = [];
  const target = await icons.install(userData, root, { fetch: fakeFetch(release(), asked), onProgress: percent => progress.push(percent),
    required: ['achievements/1.png', 'achievements/eclipse/1.png'] });
  assert.equal(target, icons.directory(userData));
  assert.deepEqual(asked, [{ url: icons.BUNDLED.url, expected: icons.BUNDLED.md5, wait: undefined, onRetry: undefined,
    algorithm: 'md5', name: 'achievement icon' }]);
  assert.deepEqual(progress, [50]);
  assert.equal(fs.readFileSync(path.join(target, '2.png'), 'utf8'), 'png achievements/2.png');
  assert.equal(fs.readFileSync(path.join(target, 'eclipse', '1.png'), 'utf8'), 'png achievements/eclipse/1.png');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, '.release'), 'utf8')),
    { name: icons.BUNDLED.name, file: icons.BUNDLED.file, md5: icons.BUNDLED.md5 });
  assert.equal(icons.wanted(userData, root), false);
  assert.equal(icons.folder(userData, root), target);
  assert.equal(icons.folder(userData, null, true), path.join(target, 'eclipse'));
  assert.equal(fs.existsSync(icons.gameDirectory(root)), false);
  // Only the icons stay: no zip, part file or staging folder beside them.
  assert.deepEqual(fs.readdirSync(userData), ['achievement-icons']);
  // A game version pinning another release wants that one.
  pinGame(root, { name: 'newer', url: 'https://example.com/i.zip', file: 'i.zip', md5: 'b'.repeat(32) });
  assert.equal(icons.wanted(userData, root), true);
});

test('a download missing an icon, or with a path outside its folder, leaves the installed icons as they were', async t => {
  const userData = temporary(t, 'sms-icons-user-');
  await icons.install(userData, null, { fetch: fakeFetch(release()) });
  await assert.rejects(icons.install(userData, null, { fetch: fakeFetch(release(['achievements/1.png'])), required: ['achievements/2.png'] }),
    /The download has no achievements\/2\.png\./);
  await assert.rejects(icons.install(userData, null, { fetch: fakeFetch(release(['achievements/1.png', 'achievements/../../evil.png'])) }),
    /not laid out as achievements\/<id>\.png/);
  await assert.rejects(icons.install(userData, null, { fetch: fakeFetch(release(['icons/1.png'])) }), /not laid out/);
  assert.equal(fs.readFileSync(path.join(icons.directory(userData), '2.png'), 'utf8'), 'png achievements/2.png');
  assert.equal(icons.wanted(userData, null), false);
  assert.deepEqual(fs.readdirSync(userData), ['achievement-icons']);
  assert.equal(fs.existsSync(path.join(path.dirname(userData), 'evil.png')), false);
});

test('icons an older launcher put in the game folder serve, and are copied into the launcher\'s instead of downloaded again', t => {
  const userData = temporary(t, 'sms-icons-user-'), root = temporary(t, 'sms-icons-game-');
  const old = icons.gameDirectory(root);
  fs.mkdirSync(path.join(old, 'eclipse'), { recursive: true });
  fs.writeFileSync(path.join(old, '1.png'), 'old png');
  fs.writeFileSync(path.join(old, 'eclipse', '1.png'), 'old eclipse png');
  fs.writeFileSync(path.join(old, '.release'), JSON.stringify({ md5: 'c'.repeat(32) }));
  // Another release than the pinned one: neither serves nor moves.
  assert.equal(icons.folder(userData, root), null);
  assert.equal(icons.adopt(userData, root), false);
  pinGame(root, { name: 'pinned', url: 'https://example.com/i.zip', file: 'i.zip', md5: 'c'.repeat(32) });
  assert.equal(icons.folder(userData, root), old);
  assert.equal(icons.folder(userData, root, true), path.join(old, 'eclipse'));
  assert.equal(icons.wanted(userData, root), false);
  assert.equal(icons.adopt(userData, root), true);
  assert.equal(icons.folder(userData, root), icons.directory(userData));
  assert.equal(fs.readFileSync(path.join(icons.directory(userData), 'eclipse', '1.png'), 'utf8'), 'old eclipse png');
  assert.equal(icons.adopt(userData, root), false, 'once');
});
