'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const game = require('../src/game-version');
const port = require('../src/port');
const tools = require('../src/build-tools');
const portable = require('../src/portable');
const settings = port.normalizeSettings();

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms game version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [folder, commit] of [['', game.release.commit], ['decomp', game.release.decomp]]) {
    fs.mkdirSync(path.join(root, folder, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, folder, '.git', 'HEAD'), `${commit}\n`);
  }
  const binary = port.binaryPath(root, settings);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'previous playable game');
  return { root, binary, directory: path.dirname(binary), backups: path.join(root, 'backups') };
}

test('legacy builds require one verified update; display settings and launcher versions do not require rebuilds', t => {
  const { root } = fixture(t);
  assert.equal(Boolean(game.isCurrent(root, settings)), false);
  fs.writeFileSync(path.join(path.dirname(port.binaryPath(root, settings)), 'launcher-build.json'),
    JSON.stringify({ ...game.identity(settings), launcherVersion: '0.0.1' }));
  assert.equal(game.isCurrent(root, { ...settings, resolution: 4, frameRate: 120, textures: true, fullscreen: true }), true);
  const marker = path.join(path.dirname(port.binaryPath(root, settings)), 'launcher-build.json');
  fs.writeFileSync(marker, JSON.stringify({ ...game.identity(settings), toolSha256: '0'.repeat(64) }));
  assert.equal(game.isCurrent(root, settings), false);
});

test('a Windows game picked to draw with Vulkan is built again once with the Vulkan backend', t => {
  const { root, directory } = fixture(t);
  const vulkan = { ...settings, renderer: 'vulkan' };
  assert.equal(game.needsVulkanBuild(root, vulkan, 'win32'), true);
  assert.equal(game.needsVulkanBuild(root, settings, 'win32'), false);
  assert.equal(game.needsVulkanBuild(root, vulkan, 'linux'), false);
  fs.writeFileSync(path.join(directory, 'CMakeCache.txt'), 'SMS_GX_VULKAN:BOOL=OFF\n');
  assert.equal(game.needsVulkanBuild(root, vulkan, 'win32'), true);
  fs.writeFileSync(path.join(directory, 'CMakeCache.txt'), 'SMS_GX_VULKAN:BOOL=ON\n');
  fs.mkdirSync(path.join(directory, 'platform', 'gx', 'CMakeFiles', 'sms_gx.dir', 'src', 'vk'), { recursive: true });
  assert.equal(game.needsVulkanBuild(root, vulkan, 'win32'), false);
});

test('a build whose Vulkan downloads failed is built again once, then plays with OpenGL and says so', t => {
  const { root, directory } = fixture(t);
  const vulkan = { ...settings, renderer: 'vulkan' };
  const record = path.join(directory, 'launcher-build.json');
  fs.writeFileSync(record, JSON.stringify(game.identity(vulkan)));
  // Configured for Vulkan (SMS_GX_VULKAN stays on in the cache), built without it.
  fs.writeFileSync(path.join(directory, 'CMakeCache.txt'), 'SMS_GX_VULKAN:BOOL=ON\nSMS_GX_VULKAN_BUILT:INTERNAL=OFF\n');
  assert.equal(game.vulkanBuiltIn(root, vulkan), false);
  assert.equal(game.needsVulkanBuild(root, vulkan, 'win32'), true);
  assert.equal(game.vulkanMissing(root, vulkan), false);
  // Built again and still without it: no more builds by themselves, and the Play page says why.
  fs.writeFileSync(record, JSON.stringify({ ...game.identity(vulkan), vulkanMissing: true }));
  assert.equal(game.needsVulkanBuild(root, vulkan, 'win32'), false);
  assert.equal(game.vulkanMissing(root, vulkan), true);
  assert.equal(game.vulkanMissing(root, settings), false);
  // The game's own entry wins over the compiled sources.
  fs.mkdirSync(path.join(directory, 'platform', 'gx', 'CMakeFiles', 'sms_gx.dir', 'src', 'vk'), { recursive: true });
  assert.equal(game.vulkanBuiltIn(root, vulkan), false);
  fs.writeFileSync(path.join(directory, 'CMakeCache.txt'), 'SMS_GX_VULKAN:BOOL=ON\nSMS_GX_VULKAN_BUILT:INTERNAL=ON\n');
  assert.equal(game.vulkanBuiltIn(root, vulkan), true);
  assert.equal(game.vulkanMissing(root, vulkan), false);
});

test('older game versions without SMS_GX_VULKAN_BUILT have Vulkan when its sources were compiled', t => {
  const { root, directory } = fixture(t);
  const vulkan = { ...settings, renderer: 'vulkan' };
  fs.writeFileSync(path.join(directory, 'CMakeCache.txt'), 'SMS_GX_VULKAN:BOOL=ON\n');
  assert.equal(game.vulkanBuiltIn(root, vulkan), false);
  assert.equal(game.needsVulkanBuild(root, vulkan, 'win32'), true);
  fs.mkdirSync(path.join(directory, 'platform', 'gx', 'CMakeFiles', 'sms_gx.dir', 'src', 'vk'), { recursive: true });
  assert.equal(game.vulkanBuiltIn(root, vulkan), true);
});

test('Linux and Mac builds missing Vulkan are built again only when the game version has it', t => {
  const { root, directory } = fixture(t);
  const vulkan = { ...settings, renderer: 'vulkan' };
  fs.writeFileSync(path.join(directory, 'CMakeCache.txt'), 'SMS_GX_VULKAN:BOOL=ON\nSMS_GX_VULKAN_BUILT:INTERNAL=OFF\n');
  assert.equal(game.needsVulkanBuild(root, vulkan, 'linux'), false);
  fs.mkdirSync(path.join(root, 'platform', 'gx', 'src', 'vk'), { recursive: true });
  assert.equal(game.needsVulkanBuild(root, vulkan, 'linux'), true);
  assert.equal(game.needsVulkanBuild(root, vulkan, 'darwin'), true);
});

test('buildSafely records a Vulkan build that came out without Vulkan', async t => {
  const { root, directory, backups } = fixture(t);
  const vulkan = { ...settings, renderer: 'vulkan' };
  await game.buildSafely(root, vulkan, path.join(root, 'saves'), async () => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(port.binaryPath(root, vulkan), 'new game');
    fs.writeFileSync(path.join(directory, 'CMakeCache.txt'), 'SMS_GX_VULKAN:BOOL=ON\nSMS_GX_VULKAN_BUILT:INTERNAL=OFF\n');
  }, backups);
  assert.equal(game.installed(root, vulkan).vulkanMissing, true);
  await game.buildSafely(root, vulkan, path.join(root, 'saves'), async () => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(port.binaryPath(root, vulkan), 'new game');
    fs.writeFileSync(path.join(directory, 'CMakeCache.txt'), 'SMS_GX_VULKAN:BOOL=ON\nSMS_GX_VULKAN_BUILT:INTERNAL=ON\n');
  }, backups);
  assert.equal(game.installed(root, vulkan).vulkanMissing, undefined);
});

test('changed source and decomp revisions invalidate a build independently', t => {
  const { root, directory } = fixture(t);
  fs.writeFileSync(path.join(directory, 'launcher-build.json'), JSON.stringify(game.identity(settings)));
  fs.writeFileSync(path.join(root, 'decomp', '.git', 'HEAD'), '0'.repeat(40));
  assert.equal(game.isCurrent(root, settings), false);
  fs.writeFileSync(path.join(root, 'decomp', '.git', 'HEAD'), game.release.decomp);
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), '1'.repeat(40));
  assert.equal(game.isCurrent(root, settings), false);
});

test('failed rebuild restores the playable binary, metadata, and custom saves inside its build folder', async t => {
  const { root, binary, directory, backups } = fixture(t);
  const card = path.join(directory, 'card');
  fs.mkdirSync(card);
  fs.writeFileSync(path.join(card, 'index.txt'), 'all my progress');
  fs.writeFileSync(path.join(directory, 'launcher-build.json'), '{"gameVersion":"old"}');
  await assert.rejects(game.buildSafely(root, settings, card, async () => {
    fs.writeFileSync(binary, 'partial executable');
    throw new Error('compiler failed');
  }, backups), /compiler failed/);
  assert.equal(fs.readFileSync(binary, 'utf8'), 'previous playable game');
  assert.equal(fs.readFileSync(path.join(card, 'index.txt'), 'utf8'), 'all my progress');
  assert.equal(game.installed(root, settings).gameVersion, 'old');
  assert.equal(fs.existsSync(`${directory}.launcher-transaction.json`), false);
});

test('successful build records exact revisions and preserves saves', async t => {
  const { root, binary, directory, backups } = fixture(t);
  const card = path.join(directory, 'card');
  fs.mkdirSync(card);
  fs.writeFileSync(path.join(card, 'index.txt'), 'my saves');
  await game.buildSafely(root, settings, card, async () => {
    fs.writeFileSync(binary, 'new playable game');
  }, backups);
  assert.equal(game.isCurrent(root, settings), true);
  assert.equal(fs.readFileSync(path.join(card, 'index.txt'), 'utf8'), 'my saves');
});

test('setup interrupted by closing the app recovers its earlier playable build on next start', t => {
  const { root, binary, directory } = fixture(t);
  const previous = `${directory}.previous-fixture`;
  fs.writeFileSync(`${directory}.launcher-transaction.json`, JSON.stringify({ directory, previous }));
  fs.renameSync(directory, previous);
  fs.mkdirSync(directory);
  fs.writeFileSync(binary, 'incomplete output');
  assert.equal(game.recoverBuild(root, settings), true);
  assert.equal(fs.readFileSync(binary, 'utf8'), 'previous playable game');
  assert.equal(game.recoverBuild(root, settings), false);
});

test('new source snapshots share optional downloads and keep user settings in the original folder', t => {
  const { root } = fixture(t);
  const next = path.join(root, 'next');
  fs.mkdirSync(path.join(next, 'mods'), { recursive: true });
  fs.mkdirSync(path.join(root, 'mods', 'textures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'mods', 'textures', 'tex1_test.png'), 'textures');
  fs.mkdirSync(path.join(root, 'mods', 'hd-cutscenes', 'files', 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'mods', 'hd-cutscenes', 'files', 'data', 'openingA.thp'), 'installed HD movie');
  fs.writeFileSync(path.join(root, 'settings.txt'), 'save_dir=./custom-saves');
  game.carryUserFiles(root, next);
  assert.equal(fs.readFileSync(path.join(next, 'settings.txt'), 'utf8'), 'save_dir=./custom-saves');
  assert.equal(fs.realpathSync(path.join(next, 'mods', 'textures')), fs.realpathSync(path.join(root, 'mods', 'textures')));
  assert.equal(fs.realpathSync(path.join(next, 'mods', 'hd-cutscenes')), fs.realpathSync(path.join(root, 'mods', 'hd-cutscenes')));
  assert.equal(fs.readFileSync(path.join(next, 'mods', 'hd-cutscenes', 'files', 'data', 'openingA.thp'), 'utf8'), 'installed HD movie');
  assert.equal(fs.readFileSync(path.join(root, 'settings.txt'), 'utf8'), 'save_dir=./custom-saves');
});

test('a new version copies the radar maps, achievement icons and language packs it pins the same release of', t => {
  const { root } = fixture(t);
  const next = path.join(root, 'next');
  const md5 = digit => digit.repeat(32);
  const pin = (version, file, sum) => {
    fs.mkdirSync(path.join(version, 'tools', 'mods'), { recursive: true });
    fs.writeFileSync(path.join(version, 'tools', 'mods', file), JSON.stringify({ md5: sum }));
  };
  const install = (directory, sum, file) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, '.release'), JSON.stringify({ md5: sum }));
    fs.writeFileSync(path.join(directory, file), 'downloaded');
  };
  fs.mkdirSync(path.join(next, 'mods'), { recursive: true });
  pin(root, 'eclipse-maps.json', md5('a'));
  pin(next, 'eclipse-maps.json', md5('a'));
  pin(root, 'achievement-icons.json', md5('b'));
  pin(next, 'achievement-icons.json', md5('c'));
  const [code] = Object.keys(port.LANGUAGE_PACKS);
  install(port.eclipseMapsDirectory(root), md5('a'), 'bianco.jpg');
  install(port.achievementIconsDirectory(root), md5('b'), '1.png');
  install(port.languagePackDirectory(root, code), port.LANGUAGE_PACKS[code].md5, 'text.bmg');
  game.carryUserFiles(root, next);
  // The same pin: a copy of its own, not a link into the last version.
  assert.ok(port.eclipseMapsInstalled(next));
  assert.ok(!fs.lstatSync(port.eclipseMapsDirectory(next)).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(port.eclipseMapsDirectory(next), 'bianco.jpg'), 'utf8'), 'downloaded');
  assert.ok(port.languagePackInstalled(next, code));
  // A new pin: left for the update to download, the last version's untouched.
  assert.ok(!fs.existsSync(port.achievementIconsDirectory(next)));
  assert.ok(port.achievementIconsInstalled(root));
  assert.ok(!fs.readdirSync(path.join(next, 'mods', 'maps')).some(name => name.endsWith('.carry-part')));
});

test('a mod folder link left pointing at a removed version is replaced, not tripped over', t => {
  const { root } = fixture(t);
  const next = path.join(root, 'next');
  const gone = path.join(root, 'removed-version', 'mods', 'textures');
  fs.mkdirSync(path.join(next, 'mods'), { recursive: true });
  fs.mkdirSync(gone, { recursive: true });
  fs.symlinkSync(gone, path.join(next, 'mods', 'textures'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.rmSync(path.join(root, 'removed-version'), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'mods', 'textures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'mods', 'textures', 'tex1_test.png'), 'textures');
  game.carryUserFiles(root, next);
  assert.equal(fs.readFileSync(path.join(next, 'mods', 'textures', 'tex1_test.png'), 'utf8'), 'textures');
});

test('old game versions are removed, keeping the current and previous ones and HD packs they link to', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sms prune-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = path.join(home, 'sms-pc-port');
  const version = name => {
    const root = path.join(`${base}.releases`, name);
    fs.mkdirSync(path.join(root, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(root, 'game'), name);
    return root;
  };
  fs.mkdirSync(path.join(base, 'mods'), { recursive: true });
  const oldest = version('a-oldest');
  fs.mkdirSync(path.join(oldest, 'mods', 'textures'));
  fs.writeFileSync(path.join(oldest, 'mods', 'textures', 'tex1_test.png'), 'textures');
  const older = version('b-older');
  game.carryUserFiles(oldest, older);
  const previous = version('c-previous');
  game.carryUserFiles(older, previous);
  const current = version('d-current');
  game.carryUserFiles(previous, current);
  const withSaves = version('e-saves');
  fs.mkdirSync(path.join(withSaves, 'custom-saves'));
  const interrupted = version('f-current.download-123');

  const errors = [];
  const removed = await game.pruneSnapshots(base, [current, previous],
    [path.join(withSaves, 'custom-saves'), null], error => errors.push(error));
  assert.deepEqual(errors, []);
  assert.deepEqual(removed.sort(), [oldest, older, interrupted].sort());
  for (const folder of [oldest, older, interrupted]) assert.equal(fs.existsSync(folder), false);
  for (const folder of [previous, current, withSaves, base]) assert.equal(fs.existsSync(folder), true);
  // The texture pack now lives in a kept version, and both kept versions still see it.
  assert.equal(fs.lstatSync(path.join(current, 'mods', 'textures')).isDirectory(), true);
  for (const root of [previous, current])
    assert.equal(fs.readFileSync(path.join(root, 'mods', 'textures', 'tex1_test.png'), 'utf8'), 'textures');
  assert.deepEqual(await game.pruneSnapshots(base, [current, previous]), [withSaves]);
  assert.deepEqual(await game.pruneSnapshots(path.join(home, 'missing'), [current]), []);
});

test('an old game version with a file another program has open loses everything else, and pruning can stop partway', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sms prune locked-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = path.join(home, 'sms-pc-port');
  const current = path.join(`${base}.releases`, 'c-current');
  fs.mkdirSync(current, { recursive: true });
  const version = name => {
    const root = path.join(`${base}.releases`, name);
    for (const folder of ['build', path.join('mods', 'eclipse')]) fs.mkdirSync(path.join(root, folder), { recursive: true });
    fs.writeFileSync(path.join(root, 'build', 'sms.exe'), name);
    fs.writeFileSync(path.join(root, port.ECLIPSE_ISO), name);
    return root;
  };
  const locked = version('a-locked');
  const later = version('b-later');
  // Windows refuses to delete a file another program opened without sharing delete.
  const rm = fs.promises.rm;
  t.after(() => { fs.promises.rm = rm; });
  fs.promises.rm = async (item, options) => {
    if (item === path.join(locked, port.ECLIPSE_ISO))
      throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${item}'`), { code: 'EBUSY', path: item });
    return rm(item, options);
  };
  const errors = [];
  assert.deepEqual(await game.pruneSnapshots(base, [current], [], (error, folder) => errors.push([error.code, folder])), [later]);
  assert.deepEqual(errors, [['EBUSY', locked]]);
  assert.equal(fs.existsSync(path.join(locked, port.ECLIPSE_ISO)), true);
  assert.equal(fs.existsSync(path.join(locked, 'build')), false);
  assert.equal(fs.existsSync(later), false);

  // A task the player starts stops it; what's left goes next time.
  fs.promises.rm = rm;
  const stopped = version('b-later');
  let checks = 0;
  assert.deepEqual(await game.pruneSnapshots(base, [current], [], () => {}, () => ++checks > 3), []);
  assert.equal(fs.existsSync(stopped), true);
  assert.deepEqual((await game.pruneSnapshots(base, [current])).sort(), [locked, stopped].sort());
  assert.equal(fs.existsSync(current), true);
});

test('each OS and Mac architecture has its own tool version without changing existing archive hashes', () => {
  for (const [platform, arch] of [['linux','x64'],['win32','x64'],['darwin','x64'],['darwin','arm64']])
    assert.equal(tools.toolsetFor(platform, arch), tools.assetFor(platform, arch).toolset);
});

test('download selects exact port and decomp commits even when the branch has newer changes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms checkout pin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };
  const git = (cwd, args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  function repo(name) {
    const dir = path.join(root, name); fs.mkdirSync(dir);
    git(dir, ['init', '-b', game.release.branch]);
    git(dir, ['config','user.name','CI']); git(dir, ['config','user.email','ci@example.invalid']);
    fs.writeFileSync(path.join(dir,'file.txt'),'one'); git(dir,['add','.']); git(dir,['commit','-m','first']);
    return dir;
  }
  const decomp = repo('decomp');
  const origin = repo('origin');
  git(origin, ['submodule','add',decomp,'decomp']); git(origin,['commit','-am','pin decomp']);
  const source = { ...game.release, repository: origin, commit: git(origin,['rev-parse','HEAD']), decomp: git(decomp,['rev-parse','HEAD']) };
  fs.writeFileSync(path.join(origin,'file.txt'),'newer'); git(origin,['commit','-am','later untested change']);
  const capture = async (command,args,cwd,environment) => execFileSync(command,args,{cwd,env:environment,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const run = async (command,args,options) => capture(command,args,options.cwd,options.env);
  const destination = path.join(root,'installed');
  // Windows rejects mkdir on an existing drive root, even with recursive=true.
  const mkdirSync = fs.mkdirSync;
  fs.mkdirSync = (directory, options) => {
    if (directory === root) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    return mkdirSync(directory, options);
  };
  try { await game.checkout(destination, { source, env, run, capture }); }
  finally { fs.mkdirSync = mkdirSync; }
  assert.equal(game.gitRevision(destination), source.commit);
  assert.equal(game.gitRevision(path.join(destination,'decomp')), source.decomp);
  assert.equal(git(destination, ['submodule', 'status']).trim().slice(0, 40), source.decomp);
  assert.equal(fs.readFileSync(path.join(destination,'file.txt'),'utf8'),'one');
  // Initialized and at the pinned commit, so the port's own update is a no-op.
  const status = execFileSync('git', ['submodule', 'status'], { cwd: destination, env, encoding: 'utf8' });
  assert.equal(status[0], ' ');
  git(destination, ['submodule', 'update', '--init', 'decomp']);  // what build.sh runs
  assert.equal(game.gitRevision(path.join(destination,'decomp')), source.decomp);
  assert.equal(git(destination, ['status', '--porcelain', '--untracked-files=no']), '');
  const failed = path.join(root,'failed');
  await assert.rejects(game.checkout(failed, { source: { ...source, decomp:'0'.repeat(40) }, env, run, capture }), /did not match/);
  assert.equal(fs.existsSync(failed),false);
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('failed.download-')),false);
});

test('an update reuses an older install\'s submodule decomp and a fork\'s relative decomp URL still works', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms checkout reuse-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };
  const git = (cwd, args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  function repo(name) {
    const dir = path.join(root, name); fs.mkdirSync(dir);
    git(dir, ['init', '-b', game.release.branch]);
    git(dir, ['config','user.name','CI']); git(dir, ['config','user.email','ci@example.invalid']);
    fs.writeFileSync(path.join(dir,'file.txt'),'one'); git(dir,['add','.']); git(dir,['commit','-m','first']);
    return dir;
  }
  const decomp = repo('decomp');
  const origin = repo('origin');
  git(origin, ['submodule','add',decomp,'decomp']); git(origin,['commit','-am','pin decomp']);
  const source = { ...game.release, repository: origin, commit: git(origin,['rev-parse','HEAD']), decomp: git(decomp,['rev-parse','HEAD']) };
  const capture = async (command,args,cwd,environment) => execFileSync(command,args,{cwd,env:environment,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const run = async (command,args,options) => capture(command,args,options.cwd,options.env);
  // An install made by earlier launchers: decomp's Git folder lives in .git/modules.
  const older = path.join(root, 'older');
  git(root, ['clone', '-q', origin, older]);
  git(older, ['submodule', 'update', '--init']);
  assert.ok(fs.statSync(path.join(older, 'decomp', '.git')).isFile());
  const updated = path.join(root, 'updated');
  const calls = [];
  const recording = async (command, args, options) => { calls.push(args); return run(command, args, options); };
  await game.checkout(updated, { source, env, run: recording, capture, reference: older });
  assert.equal(game.matchesSource(updated, source), true);
  assert.ok(calls.some(args => args.includes('--reference-if-able') && args.includes(path.join(older, '.git', 'modules', 'decomp'))));
  assert.equal(fs.existsSync(path.join(updated, 'decomp', '.git', 'objects', 'info', 'alternates')), false);
  fs.rmSync(older, { recursive: true, force: true });
  assert.equal(git(path.join(updated, 'decomp'), ['fsck', '--connectivity-only']), '');
  // A previous install whose decomp Git folder is gone is skipped, not fatal.
  const broken = path.join(root, 'broken');
  git(root, ['clone', '-q', origin, broken]);
  fs.mkdirSync(path.join(broken, 'decomp'), { recursive: true });
  fs.writeFileSync(path.join(broken, 'decomp', '.git'), `gitdir: ${path.join(root, 'missing')}\n`);
  await game.checkout(path.join(root, 'after-broken'), { source, env, run, capture, reference: broken });
  assert.equal(game.matchesSource(path.join(root, 'after-broken'), source), true);

  // A fork whose .gitmodules names decomp relative to the port's remote.
  git(origin, ['config', '--file', '.gitmodules', 'submodule.decomp.url', '../decomp']);
  git(origin, ['commit', '-qam', 'relative decomp']);
  const relative = { ...source, commit: git(origin, ['rev-parse', 'HEAD']) };
  const forked = path.join(root, 'forked');
  await game.checkout(forked, { source: relative, env, run, capture });
  assert.equal(game.matchesSource(forked, relative), true);
});

test('a download GitHub drops partway is tried again over HTTP/1.1, unless the player stopped it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms checkout retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };
  const git = (cwd, args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  function repo(name) {
    const dir = path.join(root, name); fs.mkdirSync(dir);
    git(dir, ['init', '-b', game.release.branch]);
    git(dir, ['config','user.name','CI']); git(dir, ['config','user.email','ci@example.invalid']);
    fs.writeFileSync(path.join(dir,'file.txt'),'one'); git(dir,['add','.']); git(dir,['commit','-m','first']);
    return dir;
  }
  const decomp = repo('decomp');
  const origin = repo('origin');
  git(origin, ['submodule','add',decomp,'decomp']); git(origin,['commit','-am','pin decomp']);
  const source = { ...game.release, repository: origin, commit: git(origin,['rev-parse','HEAD']), decomp: git(decomp,['rev-parse','HEAD']) };
  const capture = async (command,args,cwd,environment) => execFileSync(command,args,{cwd,env:environment,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const waits = [], wait = async ms => { waits.push(ms); };
  // Each clone fails once after leaving a partial folder behind, as Git does.
  function flaky(calls) {
    const failed = new Set();
    return async (command, args, options, label) => {
      calls.push({ args, label });
      if (args.includes('clone') && !failed.has(args.at(-1))) {
        failed.add(args.at(-1));
        fs.mkdirSync(path.join(args.at(-1), '.git'), { recursive: true });
        throw new Error(`${label} exited with code 128: fatal: fetch-pack: invalid index-pack output. See the activity log.`);
      }
      return capture(command, args, options.cwd, options.env);
    };
  }
  const calls = [];
  const destination = path.join(root, 'installed');
  await game.checkout(destination, { source, env, run: flaky(calls), capture, wait });
  assert.equal(game.matchesSource(destination, source), true);
  const retried = calls.filter(call => call.label.includes('(try 2 of 3)'));
  assert.deepEqual(retried.map(call => call.label), ['Download port source (try 2 of 3)', 'Download decomp source (try 2 of 3)']);
  for (const call of retried) assert.deepEqual(call.args.slice(0, 3), ['-c', 'http.version=HTTP/1.1', 'clone']);
  assert.equal(calls.filter(call => !call.label.includes('(try')).some(call => call.args.includes('http.version=HTTP/1.1')), false);
  assert.deepEqual(waits, [3000, 3000]);

  // Stopped, or still failing on the last try: the error stands, with nothing left behind.
  const stoppedCalls = [];
  const stopped = path.join(root, 'stopped');
  await assert.rejects(game.checkout(stopped, { source, env, run: flaky(stoppedCalls), capture, wait, stopped: () => true }), /invalid index-pack/);
  assert.equal(stoppedCalls.length, 1);
  const always = async (command, args, options, label) => { throw new Error(`${label} exited with code 128: fatal: early EOF`); };
  const broken = path.join(root, 'broken');
  await assert.rejects(game.checkout(broken, { source, env, run: always, capture, wait }), /\(try 3 of 3\) exited with code 128: fatal: early EOF/);
  assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('stopped') || name.startsWith('broken')), []);
});

test('a decomp from another fork and commit survives the port\'s own submodule update', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms checkout fork-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' };
  const git = (cwd, args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  function repo(name) {
    const dir = path.join(root, name); fs.mkdirSync(dir);
    git(dir, ['init', '-b', game.release.branch]);
    git(dir, ['config','user.name','CI']); git(dir, ['config','user.email','ci@example.invalid']);
    fs.writeFileSync(path.join(dir,'file.txt'),'one'); git(dir,['add','.']); git(dir,['commit','-m','first']);
    return dir;
  }
  const decomp = repo('decomp');
  const origin = repo('origin');
  git(origin, ['submodule','add',decomp,'decomp']); git(origin,['commit','-am','pin decomp']);
  // The fork has a commit the port does not pin.
  const fork = path.join(root, 'fork');
  git(root, ['clone', '-q', decomp, fork]);
  git(fork, ['config','user.name','CI']); git(fork, ['config','user.email','ci@example.invalid']);
  fs.writeFileSync(path.join(fork,'file.txt'),'fork'); git(fork,['commit','-qam','fork change']);
  const source = { ...game.release, custom: true, repository: origin, commit: git(origin,['rev-parse','HEAD']),
    decomp: git(fork,['rev-parse','HEAD']), decompRepository: fork };
  const capture = async (command,args,cwd,environment) => execFileSync(command,args,{cwd,env:environment,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const run = async (command,args,options) => capture(command,args,options.cwd,options.env);
  const destination = path.join(root,'installed');
  await game.checkout(destination, { source, env, run, capture });
  assert.equal(game.matchesSource(destination, source), true);
  assert.equal(fs.readFileSync(path.join(destination,'decomp','file.txt'),'utf8'),'fork');
  git(destination, ['submodule', 'update', '--init', 'decomp']);  // what build.sh runs
  assert.equal(game.gitRevision(path.join(destination,'decomp')), source.decomp);
  assert.notEqual(game.snapshotPath('/x/sms', { arch: '64', eclipse: false }, source),
    game.snapshotPath('/x/sms', { arch: '64', eclipse: false }));
});

test('build records the matching tool location and requests preparation again if those tools are removed', async t => {
  const { root, directory, binary, backups } = fixture(t);
  const toolRoot = path.join(root, 'private-tools');
  fs.mkdirSync(toolRoot);
  await game.buildSafely(root, settings, path.join(root, 'saves'), async () => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(binary, 'new executable');
    fs.writeFileSync(path.join(directory, 'CMakeCache.txt'), `CMAKE_CXX_COMPILER:FILEPATH=${toolRoot.replaceAll('\\','/')}/env/bin/clang++\n`);
  }, backups);
  assert.equal(game.installed(root, settings).toolRoot, toolRoot.replaceAll('\\','/'));
  assert.equal(game.isCurrent(root, settings), true);
  fs.rmSync(toolRoot, { recursive: true });
  assert.equal(game.isCurrent(root, settings), false);
});

test('a moved portable folder keeps its build current, plays with its own tools, and relinks its packs', t => {
  const { root: home } = fixture(t);
  const old = path.join(home, 'old', 'SMS-Launcher-Portable');
  const moved = path.join(home, 'new', 'SMS-Launcher-Portable');
  const repo = path.join(moved, 'sms-pc-port');
  for (const [folder, commit] of [['', game.release.commit], ['decomp', game.release.decomp]]) {
    fs.mkdirSync(path.join(repo, folder, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, folder, '.git', 'HEAD'), `${commit}\n`);
  }
  const binary = port.binaryPath(repo, settings);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'built before the move');
  fs.mkdirSync(path.join(moved, 'build-tools', 'windows-x64', 'msys64'), { recursive: true });
  // Recorded on the computer it was built on, with its slashes.
  const record = { ...game.identity(settings), toolRoot: 'D:\\Games\\SMS-Launcher-Portable\\build-tools\\windows-x64' };
  fs.writeFileSync(path.join(path.dirname(binary), 'launcher-build.json'), JSON.stringify(record));
  assert.equal(game.isCurrent(repo, settings, undefined, null), false);
  assert.equal(game.isCurrent(repo, settings, undefined, moved), true);
  assert.equal(game.toolRoot(repo, settings, moved), path.join(moved, 'build-tools', 'windows-x64'));
  assert.equal(game.toolRoot(repo, settings, null), record.toolRoot);

  const packs = path.join(moved, 'sms-pc-port.releases', 'abc1234-0000', 'mods', 'textures');
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(path.join(packs, 'tex1_test.png'), 'textures');
  fs.mkdirSync(path.join(repo, 'mods'), { recursive: true });
  fs.symlinkSync(path.join(old, 'sms-pc-port.releases', 'abc1234-0000', 'mods', 'textures'), path.join(repo, 'mods', 'textures'),
    process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(game.relinkUserFolders(repo, file => portable.relocated(file, moved)), ['textures']);
  assert.equal(fs.readFileSync(path.join(repo, 'mods', 'textures', 'tex1_test.png'), 'utf8'), 'textures');
  assert.deepEqual(game.relinkUserFolders(repo, file => portable.relocated(file, moved)), []);
});

test('records the toolset root for x64-host cross compilers as well as native compilers', t => {
  const { root, directory } = fixture(t);
  for (const suffix of ['env/bin/g++', 'env/targets/linux32/bin/i686-linux-g++',
    'msys64/opt/bin/i686-w64-mingw32-g++.exe', 'msys64/mingw64/bin/g++.exe']) {
    fs.writeFileSync(path.join(directory, 'CMakeCache.txt'), `CMAKE_CXX_COMPILER:FILEPATH=/private/tools/${suffix}\n`);
    assert.equal(game.compilerToolRoot(root, settings), '/private/tools');
  }
});

test('Eclipse source downloads stay on the game folder\'s drive, which the game can fetch them from', () => {
  const win = path.win32;
  const userData = 'C:\\Users\\j\\AppData\\Roaming\\sms-launcher';
  assert.equal(game.eclipseSourcesPath(userData, 'C:\\Games\\sms-pc-port', win), win.join(userData, 'eclipse-sources'));
  assert.equal(game.eclipseSourcesPath(userData, 'c:\\Games\\sms-pc-port', win), win.join(userData, 'eclipse-sources'));
  assert.equal(game.eclipseSourcesPath(userData, 'D:\\aa\\0\\sms-pc-port', win), 'D:\\aa\\0\\sms-pc-port.eclipse-sources');
  assert.equal(game.eclipseSourcesPath(userData, '\\\\nas\\games\\sms-pc-port', win), '\\\\nas\\games\\sms-pc-port.eclipse-sources');
  assert.equal(game.eclipseSourcesPath(userData, null, win), win.join(userData, 'eclipse-sources'));
  assert.equal(game.eclipseSourcesPath('/home/j/.config/sms-launcher', '/mnt/games/sms-pc-port'),
    path.join('/home/j/.config/sms-launcher', 'eclipse-sources'));
});

test('game folders are named by a short commit and a hash of the rest, to keep Windows paths short', () => {
  const snapshot = game.snapshotPath('/x/sms', { arch: '64', eclipse: false });
  assert.equal(path.dirname(snapshot), path.join('/x', 'sms.releases'));
  assert.match(path.basename(snapshot), new RegExp(`^${game.release.commit.slice(0, 7)}-[0-9a-f]{4}$`));
  assert.equal(game.snapshotPath('/x/sms', { arch: '64', eclipse: false }), snapshot);
  const custom = { ...game.release, custom: true, decomp: 'f'.repeat(40) };
  assert.notEqual(game.snapshotPath('/x/sms', { arch: '64', eclipse: false }, custom), snapshot);
});
