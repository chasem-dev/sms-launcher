'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const port = require('../src/port');
const { gcm } = require('./disc-fixture');

function fixture(t, { metadata = true, textures = false, eclipse = false, discordPresence = true, autoUpdate = true, exitCode = 0, marioLook, bake, tools } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sms installed game-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'port');
  const settings = port.normalizeSettings({ textures: true, cutscenes: true, autoUpdate, eclipse, discordPresence });
  for (const file of ['CMakeLists.txt', 'build.sh', 'run.sh', 'clean.sh', 'tools/mods/get.py']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'installed source');
  }
  const binary = port.binaryPath(root, settings);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'installed executable');
  const toolRoot = path.join(directory, 'old private tools');
  fs.mkdirSync(path.join(toolRoot, 'msys64', 'usr', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(toolRoot, 'msys64', 'usr', 'bin', 'bash.exe'), 'runtime');
  const record = path.join(path.dirname(binary), 'launcher-build.json');
  if (metadata) fs.writeFileSync(record, JSON.stringify({ gameVersion: 'older', toolRoot }));
  const rom = path.join(directory, 'own.iso');
  fs.writeFileSync(rom, gcm());
  if (eclipse) {
    fs.mkdirSync(path.dirname(path.join(root, port.ECLIPSE_ISO)), { recursive: true });
    fs.writeFileSync(path.join(root, port.ECLIPSE_ISO), 'already patched disc');
  }
  if (textures) {
    fs.mkdirSync(port.texturePackDirectory(root), { recursive: true });
    fs.writeFileSync(path.join(port.texturePackDirectory(root), 'tex1_fixture.png'), 'installed texture');
  }
  const config = { repo: root, rom, settings, completedSetup: true, saveDirectory: path.join(directory, 'saves'), marioLook };
  const starts = [], backups = [], handlers = new Map(), environments = [], activities = [], bakes = [];
  const sourcePath = path.resolve(__dirname, '../src/main.js');
  const nativeRequire = createRequire(sourcePath);
  const context = vm.createContext({ console, process, Buffer, setTimeout, setInterval, __dirname: path.dirname(sourcePath),
    require(name) {
      if (name === 'electron') return {
        app: { requestSingleInstanceLock: () => true, commandLine: { appendSwitch() {} }, whenReady: () => new Promise(() => {}), on() {}, getPath: () => directory, getVersion: () => '0.0.0' },
        ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, BrowserWindow: {} };
      if (name === './build-tools') return {
        environmentAtRoot(selected, env) {
          environments.push(selected);
          return { ...env, MSYS2_ROOT: path.join(selected, 'msys64') };
        },
        environment(_userData, env) { return { ...env, MSYS2_ROOT: path.join(toolRoot, 'msys64') }; },
        rootFor: userData => path.join(userData, 'build-tools'), toolsetFor: nativeRequire('./build-tools').toolsetFor,
        async ensure() { throw new Error('Playing must not prepare new tools'); },
        async check() { throw new Error('Playing must not prepare new tools'); },
        // `tools`: what the launcher's own status finds; preparing them still fails.
        status() { if (tools) return tools; throw new Error('Playing must not prepare new tools'); },
        async prepare() { throw new Error('Playing must not prepare new tools'); } };
      if (name === './discord') return { ...nativeRequire('./discord'),
        createPresence: () => ({ set: activity => activities.push(activity), stop() {}, listen() {}, reply() {} }) };
      if (name === './mario-model') return { loadMario: () => ({ references: ['disc references'] }) };
      if (name === './mario-pack') return { outfitEnvironment: nativeRequire('./mario-pack').outfitEnvironment,
        bake(options) { bakes.push(options); return bake ? bake(options) : options.directory; } };
      if (name === './saves') return {
        backupRoot: () => path.join(directory, 'backups'),
        backupSaves(_saves, _backups, reason) { backups.push(reason); return { empty: true, message: 'No saves yet' }; },
        prepareSaveDirectory: dir => dir.replaceAll('\\', '/'), listBackups: () => [] };
      if (name === 'node:child_process') return { spawn(command, args, options) {
        starts.push({ command, args, options });
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        setImmediate(() => child.emit('close', exitCode));
        return child;
      } };
      return nativeRequire(name);
    }, fixtureConfig: config });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8') + '\nconfig = fixtureConfig; registerHandlers();' +
    '\nglobalThis.logText = () => JSON.stringify(activityLog.snapshot());', context);
  return { config, starts, backups, environments, activities, bakes, directory, binary, record, toolRoot, root, play: () => handlers.get('play')(),
    invoke: name => handlers.get(name)(), playDirectly: () => context.playDirectly(), logText: () => context.logText() };
}

test('skip update launches the older installed game, keeps preferences and saves, and never builds or downloads', async t => {
  const f = fixture(t);
  const before = JSON.stringify(f.config), recordBefore = fs.readFileSync(f.record, 'utf8');
  await f.play();
  assert.equal(f.starts.length, 1);
  const { command, options } = f.starts[0];
  assert.ok(process.platform === 'win32' ? command === f.binary : command.endsWith('run.sh'));
  assert.equal(options.cwd, f.root);
  assert.equal(options.env.SMS_TEXTURE_PACKS, '0');
  assert.equal(options.env.SMS_HD_CUTSCENES, '0');
  assert.equal(options.env.SMS_PRESENCE, '1');
  // the build's version, for the game's window title
  assert.equal(options.env.SMS_GAME_VERSION, 'older');
  assert.equal(options.env.SMS_SAVE_DIR, f.config.saveDirectory.replaceAll('\\', '/'));
  assert.deepEqual(f.environments, [f.toolRoot]);
  assert.deepEqual(f.backups, ['before-play', 'after-play']);
  assert.equal(JSON.stringify(f.config), before);
  assert.equal(fs.readFileSync(f.binary, 'utf8'), 'installed executable');
  assert.equal(fs.readFileSync(f.record, 'utf8'), recordBefore);
});

test('with Show on Discord off the game is not asked for presence and Discord is not contacted', async t => {
  const on = fixture(t);
  await on.play();
  assert.equal(on.starts[0].options.env.SMS_PRESENCE, '1');
  assert.equal(on.activities.length, 1);
  const off = fixture(t, { discordPresence: false });
  await off.play();
  assert.equal(off.starts[0].options.env.SMS_PRESENCE, undefined);
  assert.deepEqual(off.activities, []);
});

test('skip update supports legacy installs and keeps already installed textures enabled', async t => {
  const f = fixture(t, { metadata: false, textures: true });
  await f.play();
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].options.env.SMS_TEXTURE_PACKS, port.texturePackDirectory(f.root));
  assert.equal(f.starts[0].options.env.SMS_HD_CUTSCENES, '0');
  assert.equal(fs.existsSync(f.record), false);
  assert.equal(f.config.settings.autoUpdate, true);
});

test('skip update starts the installed Eclipse executable with the existing patched disc', async t => {
  const f = fixture(t, { eclipse: true });
  await f.play();
  assert.equal(f.starts.length, 1);
  const start = f.starts[0];
  assert.ok(start.command === f.binary || start.args.includes(f.binary));
  assert.ok(start.args.includes(path.join(f.root, port.ECLIPSE_ISO)));
});

test('skip update cannot start a missing executable or invalid disc', async t => {
  const f = fixture(t);
  fs.rmSync(f.binary);
  await assert.rejects(f.play(), /Set up this version/);
  fs.writeFileSync(f.binary, 'installed executable');
  fs.writeFileSync(f.config.rom, 'bad disc');
  await assert.rejects(f.play(), /isn't a GameCube disc/);
  fs.writeFileSync(f.config.rom, gcm().subarray(0, 0x3f00));
  await assert.rejects(f.play(), /incomplete/);
  assert.equal(f.starts.length, 0);
});

test('without automatic updates Play keeps the installed game, while Update & play builds the update first', async t => {
  const f = fixture(t, { autoUpdate: false, textures: true });
  await f.invoke('launch-game');
  assert.equal(f.starts.length, 1);
  assert.equal(fs.readFileSync(f.binary, 'utf8'), 'installed executable');
  await assert.rejects(f.invoke('update-and-play'), /Playing must not prepare new tools/);
  assert.equal(f.starts.length, 1);
});

// `--play`: a Steam shortcut starts the game without the launcher's window.
test('--play starts the installed game with the launcher settings when nothing needs doing', async t => {
  const f = fixture(t, { autoUpdate: false, textures: true });
  f.config.settings.cutscenes = false;
  assert.equal(await f.playDirectly(), true);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].options.env.SMS_TEXTURE_PACKS, port.texturePackDirectory(f.root));
  assert.equal(f.starts[0].options.env.SMS_SAVE_DIR, f.config.saveDirectory.replaceAll('\\', '/'));
  assert.deepEqual(f.backups, ['before-play', 'after-play']);
});

test('--play opens the launcher instead when a game update is ready, without building', async t => {
  const f = fixture(t, { textures: true });
  f.config.settings.cutscenes = false;
  assert.equal(await f.playDirectly(), false);
  assert.equal(f.starts.length, 0);
  assert.match(f.logText(), /instead of the game: a game update is ready/);
});

test('--play opens the launcher instead when setup or HD visuals are unfinished', async t => {
  const missingVisuals = fixture(t, { autoUpdate: false });
  assert.equal(await missingVisuals.playDirectly(), false);
  assert.match(missingVisuals.logText(), /HD visuals need to be set up/);
  const notBuilt = fixture(t, { autoUpdate: false });
  fs.rmSync(notBuilt.binary);
  assert.equal(await notBuilt.playDirectly(), false);
  assert.match(notBuilt.logText(), /not set up yet/);
  assert.equal(missingVisuals.starts.length + notBuilt.starts.length, 0);
});

test('--play opens the launcher after the game fails so its log is visible', async t => {
  const f = fixture(t, { autoUpdate: false, exitCode: 3 });
  f.config.settings.textures = false;
  assert.equal(await f.playDirectly(), false);
  assert.equal(f.starts.length, 1);
  assert.deepEqual(f.backups, ['before-play', 'after-play']);
});

test('chosen Mario colours reach the game as a look pack, from the HD pack when HD textures are on', async t => {
  const look = { colors: { hat: '#00ff00' }, inGame: true, aloha: false, sunglasses: false, fludd: false, nozzle: 'spray' };
  const hd = fixture(t, { textures: true, marioLook: look });
  await hd.play();
  assert.equal(hd.bakes.length, 1);
  const plainCopy = value => JSON.parse(JSON.stringify(value));  // values made in main.js's context
  assert.deepEqual(plainCopy(hd.bakes[0].look), look);
  assert.deepEqual(plainCopy(hd.bakes[0].references), ['disc references']);
  assert.deepEqual(plainCopy(hd.bakes[0].packDirectories), [port.texturePackDirectory(hd.root)]);
  assert.equal(hd.starts[0].options.env.SMS_MARIO_LOOK, path.join(hd.directory, 'mario-look'));
  assert.equal(hd.bakes[0].rom, hd.config.rom, 'painted from the disc the game plays');

  const plain = fixture(t, { marioLook: look });
  await plain.play();
  assert.deepEqual(plainCopy(plain.bakes[0].packDirectories), [], 'HD textures off: the disc textures are repainted');
});

test('custom textures are read before the HD textures, alone with HD textures off, and repaint Mario too', async t => {
  const addCustom = f => {
    const folder = path.join(port.customTextureDirectory(f.directory), 'Load', 'Textures', 'GMSE01');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'tex1_custom.png'), 'custom texture');
    return port.customTextureDirectory(f.directory);
  };
  const look = { colors: { hat: '#00ff00' }, inGame: true };
  const plainCopy = value => JSON.parse(JSON.stringify(value));
  const hd = fixture(t, { textures: true, marioLook: look });
  const custom = addCustom(hd);
  await hd.play();
  assert.equal(hd.starts[0].options.env.SMS_TEXTURE_PACKS, `${custom};${port.texturePackDirectory(hd.root)}`);
  assert.deepEqual(plainCopy(hd.bakes[0].packDirectories), [custom, port.texturePackDirectory(hd.root)]);

  const alone = fixture(t, { marioLook: look });
  await alone.play();
  assert.equal(alone.starts[0].options.env.SMS_TEXTURE_PACKS, '0', 'no custom textures: packs stay off');
  const own = addCustom(alone);
  await alone.play();
  assert.equal(alone.starts[1].options.env.SMS_TEXTURE_PACKS, own);
  assert.deepEqual(plainCopy(alone.bakes[1].packDirectories), [own]);
});

test('with Eclipse, Mario is painted from the Eclipse disc the game plays', async t => {
  const eclipse = fixture(t, { eclipse: true, marioLook: { colors: { hat: '#00ff00' } } });
  await eclipse.play();
  assert.equal(eclipse.bakes.length, 1);
  assert.equal(eclipse.bakes[0].rom, path.join(eclipse.root, port.ECLIPSE_ISO));
  assert.deepEqual(JSON.parse(JSON.stringify(eclipse.bakes[0].references)), ['disc references'], 'the preview\'s colours, from the player\'s disc');
  assert.equal(eclipse.starts[0].options.env.SMS_MARIO_LOOK, path.join(eclipse.directory, 'mario-look'));
});

test("Mario's mouth is painted for a game that keeps Eclipse's other characters out of his look", async t => {
  const older = fixture(t, { eclipse: true, marioLook: { colors: { skin: '#3150c0' } } });
  await older.play();
  assert.equal(older.bakes[0].othersKeepOwn, false, 'an older game would paint Luigi\'s mouth too');
  const current = fixture(t, { eclipse: true, marioLook: { colors: { skin: '#3150c0' } } });
  fs.mkdirSync(path.join(current.root, 'ext', 'look', 'game'), { recursive: true });
  fs.writeFileSync(path.join(current.root, 'ext', 'look', 'game', 'look_game.cpp'), '// ext/look\n');
  await current.play();
  assert.equal(current.bakes[0].othersKeepOwn, true);
});

test('the Shine shirt and the sunglasses reach the game each on its own, with or without chosen colours, in Eclipse too', async t => {
  const shirt = fixture(t, { marioLook: { colors: {}, aloha: true } });
  await shirt.play();
  assert.equal(shirt.starts[0].options.env.SMS_MARIO_SHIRT, '1');
  assert.equal(shirt.starts[0].options.env.SMS_MARIO_SUNGLASSES, undefined);
  assert.deepEqual(shirt.bakes, [], 'no colours to paint');

  const both = fixture(t, { marioLook: { colors: { hat: '#00ff00' }, aloha: true, sunglasses: true } });
  await both.play();
  assert.equal(both.starts[0].options.env.SMS_MARIO_SHIRT, '1');
  assert.equal(both.starts[0].options.env.SMS_MARIO_SUNGLASSES, '1');
  assert.equal(both.starts[0].options.env.SMS_MARIO_LOOK, path.join(both.directory, 'mario-look'));

  const eclipse = fixture(t, { eclipse: true, marioLook: { colors: {}, aloha: true, sunglasses: true } });
  await eclipse.play();
  assert.equal(eclipse.starts[0].options.env.SMS_MARIO_SHIRT, '1', 'Super Mario Eclipse gets them too');
  assert.equal(eclipse.starts[0].options.env.SMS_MARIO_SUNGLASSES, '1');

  const off = fixture(t, { marioLook: { aloha: true, sunglasses: true, inGame: false } });
  await off.play();
  assert.equal(off.starts[0].options.env.SMS_MARIO_SHIRT, undefined, 'Use in the game off: Mario as usual');
  assert.equal(off.starts[0].options.env.SMS_MARIO_SUNGLASSES, undefined);
});

test('without chosen colours, or when painting fails, Mario plays as he is', async t => {
  const none = fixture(t);
  fs.mkdirSync(path.join(none.directory, 'mario-look'));
  await none.play();
  assert.deepEqual(none.bakes, []);
  assert.equal(none.starts[0].options.env.SMS_MARIO_LOOK, undefined);
  assert.equal(fs.existsSync(path.join(none.directory, 'mario-look')), false, 'an old look pack is removed');

  const off = fixture(t, { marioLook: { colors: { hat: '#00ff00' }, inGame: false } });
  fs.mkdirSync(path.join(off.directory, 'mario-look'));
  await off.play();
  assert.deepEqual(off.bakes, [], 'Use in the game off: nothing is painted');
  assert.equal(off.starts[0].options.env.SMS_MARIO_LOOK, undefined);
  assert.equal(fs.existsSync(path.join(off.directory, 'mario-look')), false);
  assert.match(off.logText(), /Use in the game is off/);

  const classic = fixture(t, { marioLook: { colors: {}, inGame: true } });
  await classic.play();
  assert.deepEqual(classic.bakes, [], 'the Classic preset chooses no colours, so nothing is painted');
  assert.equal(classic.starts[0].options.env.SMS_MARIO_LOOK, undefined);

  const failing = fixture(t, { marioLook: { colors: { hat: '#00ff00' } }, bake() { throw new Error('disc unreadable'); } });
  await failing.play();
  assert.equal(failing.starts.length, 1);
  assert.equal(failing.starts[0].options.env.SMS_MARIO_LOOK, undefined);
  assert.match(failing.logText(), /Mario keeps his usual colours: disc unreadable/);
});

test('Update game with the game up to date says so without preparing build tools, which may have been removed', async t => {
  const f = fixture(t, { tools: { ready: false, mode: 'missing' } });
  const game = require('../src/game-version');
  for (const [folder, commit] of [['', game.release.commit], ['decomp', game.release.decomp]]) {
    fs.mkdirSync(path.join(f.root, folder, '.git'), { recursive: true });
    fs.writeFileSync(path.join(f.root, folder, '.git', 'HEAD'), `${commit}\n`);
  }
  fs.writeFileSync(f.record, JSON.stringify(game.identity(f.config.settings)));
  // preparing tools fails in this fixture, as would downloading them again
  await f.invoke('update-port');
  assert.equal(f.starts.length, 0);
  assert.match(f.logText(), /up to date/);
});
