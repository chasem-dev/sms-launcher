'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mods = require('../src/native-mods');
const { zip } = require('./zip-fixture');

function temporary(t, prefix = 'sms-native-mods-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const MOD_INI = 'id = seamless-episodes\nname = Seamless Episodes\nversion = 1.0.0\nlibrary = seamless_episodes\n';
const ENTRY = mods.catalog().find(entry => entry.id === 'seamless-episodes');

function releaseZip(ini = MOD_INI, extra = []) {
  return zip([
    { name: 'seamless-episodes/', data: Buffer.alloc(0) },
    { name: 'seamless-episodes/mod.ini', data: Buffer.from(ini), deflate: true },
    { name: 'seamless-episodes/bin/linux-x86_64/seamless_episodes.so', data: Buffer.from('ELF') },
    ...extra
  ]);
}

function gameRoot(t, minor) {
  const root = temporary(t);
  fs.mkdirSync(path.join(root, 'sdk', 'include'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sdk', 'include', 'sms_mod.h'), `#define SMS_MOD_API_MAJOR 1\n#define SMS_MOD_API_MINOR ${minor}\n`);
  return root;
}

test('the catalog names Seamless Episodes, its repository and the mod API it needs', () => {
  assert.equal(ENTRY.repository, 'chasem-dev/sms-seamless-episodes');
  assert.equal(ENTRY.api, '1.4');
  for (const entry of mods.catalog()) assert.match(entry.id, /^[a-z0-9.-]+$/);
});

test('the game\'s settings folder is found as the game finds it', () => {
  assert.equal(mods.dataRoot({ SMS_NATIVE_MODS_DATA: '/d', XDG_DATA_HOME: '/x' }, 'linux'), '/d');
  assert.equal(mods.dataRoot({ XDG_DATA_HOME: '/x', HOME: '/h' }, 'linux'), path.join('/x', 'sms-port', 'mods'));
  assert.equal(mods.dataRoot({ APPDATA: 'C:/A', HOME: '/h' }, 'win32'), path.join('C:/A', 'sms-port', 'mods'));
  assert.equal(mods.dataRoot({ APPDATA: 'C:/A', HOME: '/h' }, 'linux'), path.join('/h', '.local', 'share', 'sms-port', 'mods'));
});

test('switching a mod off and on writes the game\'s own list, keeping what else it has', t => {
  const data = temporary(t);
  const env = { SMS_NATIVE_MODS_DATA: data };
  fs.writeFileSync(path.join(data, 'native-mods.ini'), '# native mods switched off in the Mods menu (F1)\noff = lua;other\n');
  assert.equal(mods.isEnabled('seamless-episodes', env), true);
  mods.setEnabled('seamless-episodes', false, env);
  assert.deepEqual(mods.offList(env), ['lua', 'other', 'seamless-episodes']);
  assert.match(fs.readFileSync(path.join(data, 'native-mods.ini'), 'utf8'), /^# native mods switched off in the Mods menu \(F1\)\noff = lua;other;seamless-episodes\n$/);
  mods.setEnabled('seamless-episodes', true, env);
  assert.deepEqual(mods.offList(env), ['lua', 'other']);
  assert.throws(() => mods.setEnabled('../x', false, env), /not a mod/);
});

test('a game folder\'s mod API comes from its SDK header, and decides what it runs', t => {
  assert.deepEqual(mods.gameApi(gameRoot(t, 4)), { major: 1, minor: 4 });
  assert.equal(mods.gameApi(temporary(t)), null);
  assert.equal(mods.supports({ major: 1, minor: 4 }, '1.4'), true);
  assert.equal(mods.supports({ major: 1, minor: 6 }, '1.4'), true);
  assert.equal(mods.supports({ major: 1, minor: 3 }, '1.4'), false);
  assert.equal(mods.supports({ major: 2, minor: 0 }, '1.4'), false);
  assert.equal(mods.supports(null, '1.4'), false);
  assert.equal(mods.supports(null, ''), true);
});

test('a release zip installs the mod\'s folder only, with its release noted', t => {
  const userData = temporary(t);
  const done = mods.installZip(userData, ENTRY, releaseZip(MOD_INI, [{ name: 'README.md', data: Buffer.from('x') }]), { tag: 'v1.0.0', asset: 'seamless-episodes-1.0.0.zip' });
  assert.equal(done.version, '1.0.0');
  const dir = path.join(mods.directory(userData), 'seamless-episodes');
  assert.equal(fs.readFileSync(path.join(dir, 'bin', 'linux-x86_64', 'seamless_episodes.so'), 'utf8'), 'ELF');
  assert.equal(fs.existsSync(path.join(mods.directory(userData), 'README.md')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.release.json'), 'utf8')).tag, 'v1.0.0');
  assert.deepEqual(mods.installed(userData).map(mod => [mod.id, mod.version]), [['seamless-episodes', '1.0.0']]);
  // an update replaces it
  mods.installZip(userData, ENTRY, releaseZip(MOD_INI.replace('1.0.0', '1.1.0')), { tag: 'v1.1.0' });
  assert.deepEqual(mods.installed(userData).map(mod => mod.version), ['1.1.0']);
  assert.deepEqual(fs.readdirSync(mods.directory(userData)), ['seamless-episodes']);
});

test('a zip that is not the mod, or reaches outside its folder, leaves the installed one alone', t => {
  const userData = temporary(t);
  mods.installZip(userData, ENTRY, releaseZip(), {});
  assert.throws(() => mods.installZip(userData, ENTRY, releaseZip(MOD_INI.replace('id = seamless-episodes', 'id = other')), {}), /not Seamless Episodes/);
  assert.throws(() => mods.installZip(userData, ENTRY, releaseZip(MOD_INI, [{ name: 'seamless-episodes/../../evil', data: Buffer.from('x') }]), {}), /outside/);
  assert.throws(() => mods.installZip(userData, ENTRY, Buffer.from('not a zip'), {}), /not a zip/);
  assert.deepEqual(fs.readdirSync(mods.directory(userData)), ['seamless-episodes']);
  assert.equal(mods.installed(userData)[0].version, '1.0.0');
  mods.remove(userData, 'seamless-episodes');
  assert.deepEqual(mods.installed(userData), []);
});

test('the game is told of the launcher\'s mods only when it has some and a mod API that reads the list', t => {
  const userData = temporary(t);
  const root = gameRoot(t, 4);
  assert.deepEqual(mods.environment(root, userData), {});
  mods.installZip(userData, ENTRY, releaseZip(), {});
  assert.deepEqual(mods.environment(root, userData), { SMS_NATIVE_MODS_DIR: `${path.join(root, 'mods')};${mods.directory(userData)}` });
  assert.deepEqual(mods.environment(gameRoot(t, 3), userData), {});
});

test('the newest release is downloaded from GitHub and installed', async t => {
  const userData = temporary(t);
  const asked = [];
  const fetch = async url => {
    asked.push(url);
    if (url.startsWith('https://api.github.com/'))
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v1.2.0', assets: [{ name: 'notes.txt' }, { name: 'seamless-episodes-1.2.0.zip', size: 100, browser_download_url: 'https://example.invalid/se.zip' }] }) };
    const data = releaseZip(MOD_INI.replace('1.0.0', '1.2.0'));
    return { ok: true, status: 200, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.length) };
  };
  const done = await mods.download(userData, ENTRY, fetch);
  assert.deepEqual(asked, ['https://api.github.com/repos/chasem-dev/sms-seamless-episodes/releases/latest', 'https://example.invalid/se.zip']);
  assert.equal(done.version, '1.2.0');
  await assert.rejects(mods.latestRelease(ENTRY, async () => ({ ok: false, status: 404 })), /no release yet/);
});

test('GitHub briefly down or a dropped download is asked again; a missing release is not', async t => {
  const userData = temporary(t);
  const asked = [];
  const fetch = async url => {
    asked.push(url);
    const tries = asked.filter(seen => seen === url).length;
    if (url.startsWith('https://api.github.com/')) {
      if (tries === 1) return { ok: false, status: 502 };
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v1.2.0', assets: [{ name: 'seamless-episodes-1.2.0.zip', size: 100, browser_download_url: 'https://example.invalid/se.zip' }] }) };
    }
    if (tries === 1) throw new TypeError('fetch failed');
    const data = releaseZip(MOD_INI.replace('1.0.0', '1.2.0'));
    return { ok: true, status: 200, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.length) };
  };
  const waits = [];
  const done = await mods.download(userData, ENTRY, fetch, { wait: async ms => waits.push(ms) });
  assert.equal(done.version, '1.2.0');
  assert.equal(asked.length, 4);
  assert.equal(waits.length, 2);
  let calls = 0;
  await assert.rejects(mods.latestRelease(ENTRY, async () => { calls++; return { ok: false, status: 404 }; }, { wait: async () => {} }), /no release yet/);
  assert.equal(calls, 1);
});

test('the Mods page lists the catalog with what is installed, on, and runnable', t => {
  const userData = temporary(t);
  const data = temporary(t);
  const env = { SMS_NATIVE_MODS_DATA: data };
  mods.installZip(userData, ENTRY, releaseZip(), {});
  mods.setEnabled('seamless-episodes', false, env);
  const page = mods.list(userData, gameRoot(t, 4), env);
  assert.equal(page.gameApi, '1.4');
  const row = page.mods.find(mod => mod.id === 'seamless-episodes');
  assert.equal(row.installed.version, '1.0.0');
  assert.equal(row.enabled, false);
  assert.equal(row.supported, true);
  assert.equal(mods.list(userData, gameRoot(t, 3), env).mods[0].supported, false);
  assert.equal(mods.newer('1.10.0', '1.9.2'), true);
  assert.equal(mods.newer('v1.0.0', '1.0.0'), false);
});
