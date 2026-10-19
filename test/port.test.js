'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const port = require('../src/port');

function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(), 'sms-launcher-test-')); }
function header() {
  const bytes = Buffer.alloc(0x20);
  bytes.write('GMSE01', 0, 'ascii');
  bytes[7] = 0;
  bytes.writeUInt32BE(0xc2339f3d, 0x1c);
  return bytes;
}

test('frame rate defaults to 60, migrates the old toggle, and passes all three rates to the game', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.equal(port.normalizeSettings({}, platform).frameRate, 60);
    assert.equal(port.normalizeSettings({ fps60: true }, platform).frameRate, 60);
    assert.equal(port.normalizeSettings({ fps60: false }, platform).frameRate, 30);
    for (const frameRate of [30, 60, 120]) {
      const settings = port.normalizeSettings({ frameRate: String(frameRate), fps60: false }, platform);
      assert.equal(settings.frameRate, frameRate);
      assert.equal(port.buildEnvironment(settings, '/my/disc.iso', '/port').SMS_FRAME_RATE, String(frameRate));
      assert.equal(port.normalizeSettings(JSON.parse(JSON.stringify(settings)), platform).frameRate, frameRate);
    }
    for (const frameRate of [0, 90, 144, '120fps', null])
      assert.equal(port.normalizeSettings({ frameRate }, platform).frameRate, 60);
  }
  assert.equal(port.buildEnvironment({ fps60: false }, '/my/disc.iso', '/port').SMS_FRAME_RATE, '30');
});

test('requires an owned GMSE01 Rev 0 image and supports plain and CISO headers', () => {
  const dir = temporary();
  try {
    const iso = path.join(dir, 'my disc.iso');
    fs.writeFileSync(iso, header());
    assert.equal(port.validateRom(iso), iso);
    const ciso = path.join(dir, 'my disc.ciso');
    const bytes = Buffer.alloc(0x8000 + 0x20);
    bytes.write('CISO'); bytes.writeUInt32LE(0x8000, 4); bytes[8] = 1;
    header().copy(bytes, 0x8000);
    fs.writeFileSync(ciso, bytes);
    assert.equal(port.validateRom(ciso), ciso);
    bytes.write('GMSE04', 0x8000, 'ascii');
    fs.writeFileSync(ciso, bytes);
    assert.throws(() => port.validateRom(ciso), /GMSE01/);
    assert.throws(() => port.validateRom(''), /Choose your own/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('offers only platform-supported architectures and keeps builds separate', () => {
  assert.deepEqual(port.platformInfo('linux').arches, ['64', '32']);
  assert.deepEqual(port.platformInfo('darwin').arches, ['64']);
  assert.deepEqual(port.platformInfo('win32').arches, ['64', '32']);
  const windows = port.normalizeSettings({ arch: '64' }, 'win32');
  assert.equal(windows.arch, '64');
  assert.equal(port.normalizeSettings({ arch: '32' }, 'win32').arch, '32');
  assert.equal(port.normalizeSettings({ arch: '32' }, 'linux').arch, '32');
  assert.match(port.binaryPath('/port', windows, 'win32'), /windows-64[\\/]sms.exe$/);
  const settings = port.normalizeSettings({ eclipse: true, arch: '64', textures: false }, 'linux');
  assert.match(port.binaryPath('/port', settings, 'linux'), /linux-64-eclipse[\\/]sms$/);
  assert.equal(port.buildEnvironment(settings, '/my/disc.iso', '/port').SMS_DISC_IMAGE, '/my/disc.iso');
  assert.equal(port.buildEnvironment(settings, '/my/disc.iso', '/port').SMS_MOD, 'none');
  assert.equal(port.buildEnvironment(settings, '/my/disc.iso', '/port').SMS_STANDALONE, '0');
  assert.equal(settings.fullscreen, false);
  assert.equal(port.buildEnvironment(settings, '/my/disc.iso', '/port').SMS_FULLSCREEN, '0');
  assert.equal(port.buildEnvironment(port.normalizeSettings({ fullscreen: true }), '/my/disc.iso', '/port').SMS_FULLSCREEN, '1');
  assert.equal(settings.invertCameraX, true);
  assert.equal(settings.invertCameraY, true);
  assert.equal(port.buildEnvironment(settings, '/my/disc.iso', '/port').SMS_CAMERA_INVERT_X, '1');
  assert.equal(port.buildEnvironment(settings, '/my/disc.iso', '/port').SMS_CAMERA_INVERT_Y, '1');
  const inverted = port.normalizeSettings({ invertCameraX: false, invertCameraY: false });
  assert.equal(port.buildEnvironment(inverted, '/my/disc.iso', '/port').SMS_CAMERA_INVERT_X, '0');
  assert.equal(port.buildEnvironment(inverted, '/my/disc.iso', '/port').SMS_CAMERA_INVERT_Y, '0');
  assert.equal(port.buildEnvironment(settings, '/my/disc.iso', '/port').SMS_TEXTURE_PACKS, '0');
  assert.equal(port.buildEnvironment({ ...settings, textures: true }, '/my/disc.iso', '/port').SMS_TEXTURE_PACKS,
    path.join('/port', 'mods', 'textures'));
});

test('master volume defaults to full, is clamped to 0-100, and reaches the game as SMS_VOLUME', () => {
  assert.equal(port.normalizeSettings({}).volume, 100);
  assert.equal(port.normalizeSettings({ volume: 40 }).volume, 40);
  assert.equal(port.normalizeSettings({ volume: '65' }).volume, 65);
  assert.equal(port.normalizeSettings({ volume: 150 }).volume, 100);
  assert.equal(port.normalizeSettings({ volume: -5 }).volume, 0);
  assert.equal(port.normalizeSettings({ volume: 'loud' }).volume, 100);
  assert.equal(port.normalizeSettings({ volume: null }).volume, 100);
  assert.equal(port.buildEnvironment(port.normalizeSettings({}), '/my/disc.iso', '/port').SMS_VOLUME, '100');
  assert.equal(port.buildEnvironment(port.normalizeSettings({ volume: 0 }), '/my/disc.iso', '/port').SMS_VOLUME, '0');
});

test('usage sharing is on unless turned off', () => {
  assert.equal(port.normalizeSettings({}).shareUsage, true);
  assert.equal(port.normalizeSettings({ shareUsage: false }).shareUsage, false);
  assert.equal(port.normalizeSettings({ shareUsage: 'no' }).shareUsage, true);
  assert.equal(port.normalizeSettings({}).discordPresence, true);
  assert.equal(port.normalizeSettings({ discordPresence: false }).discordPresence, false);
});

test('settings keep only changed, known key bindings', () => {
  assert.deepEqual(port.normalizeSettings({}).keyBindings, {});
  const settings = port.normalizeSettings({ keyBindings: { A: ['J'], B: ['LSHIFT', 'RSHIFT', 'C'], R: ['NOPE', 'K', 'K'], JUMP: ['A'] } });
  assert.deepEqual(settings.keyBindings, { A: ['J'], R: ['K'] });
});

test('new settings default to the game as it was, so updating changes nothing until chosen', () => {
  const s = port.normalizeSettings({});
  assert.deepEqual([s.freeCamera, s.cstickAim, s.cameraSpeed, s.mouseCamera, s.mouseSensitivity], [false, false, 100, false, 100]);
  assert.deepEqual([s.fullscreenMode, s.exclusiveResolution, s.display, s.vsync, s.skipMovies, s.overlay],
    ['desktop', 'desktop', 'launcher', 'off', false, false]);
  assert.deepEqual([s.msaa, s.fxaa, s.anisotropic, s.sharpen, s.brightness, s.aspect, s.presentFilter],
    [0, false, 0, 0, 100, 'keep', 'bilinear']);
  const env = port.buildEnvironment(s, '/my/disc.iso', '/port');
  assert.deepEqual([env.SMS_FREE_CAMERA, env.SMS_CLOSE_CAMERA_CSTICK, env.SMS_CAMERA_SPEED, env.SMS_MOUSE_CAMERA, env.SMS_MOUSE_SENSITIVITY], ['0', '0', '100', '0', '100']);
  assert.deepEqual([env.SMS_FULLSCREEN, env.SMS_VSYNC, env.SMS_SKIP_MOVIES, env.SMS_OVERLAY], ['0', '0', '0', '0']);
  assert.deepEqual([env.SMS_MSAA, env.SMS_FXAA, env.SMS_ANISO, env.SMS_SHARPEN, env.SMS_GAMMA, env.SMS_ASPECT, env.SMS_PRESENT_FILTER],
    ['0', '0', '0', '0', '1.00', 'keep', 'bilinear']);
  for (const key of ['SMS_FULLSCREEN_MODE', 'SMS_DISPLAY']) assert.equal(env[key], undefined, key);
});

test('chosen settings reach the game as its environment variables', () => {
  const env = port.buildEnvironment(port.normalizeSettings({
    freeCamera: true, cstickAim: true, cameraSpeed: '150', mouseCamera: true, mouseSensitivity: 250,
    fullscreen: true, fullscreenMode: 'exclusive', exclusiveResolution: '1920x1080', display: 'primary', vsync: 'adaptive',
    skipMovies: true, overlay: true, msaa: 4, fxaa: true, anisotropic: '16', sharpen: 40, brightness: 115,
    aspect: 'integer', presentFilter: 'sharp'
  }), '/my/disc.iso', '/port');
  assert.deepEqual([env.SMS_FREE_CAMERA, env.SMS_CLOSE_CAMERA_CSTICK, env.SMS_CAMERA_SPEED, env.SMS_MOUSE_CAMERA, env.SMS_MOUSE_SENSITIVITY], ['1', '1', '150', '1', '250']);
  assert.deepEqual([env.SMS_FULLSCREEN, env.SMS_FULLSCREEN_MODE, env.SMS_DISPLAY, env.SMS_VSYNC], ['exclusive', '1920x1080', '0', 'adaptive']);
  assert.deepEqual([env.SMS_SKIP_MOVIES, env.SMS_OVERLAY], ['1', '1']);
  assert.deepEqual([env.SMS_MSAA, env.SMS_FXAA, env.SMS_ANISO, env.SMS_SHARPEN, env.SMS_GAMMA, env.SMS_ASPECT, env.SMS_PRESENT_FILTER],
    ['4', '1', '16', '40', '1.15', 'integer', 'sharp']);
  // borderless keeps today's value, and windowed never sends a display mode
  assert.equal(port.buildEnvironment(port.normalizeSettings({ fullscreen: true }), '/d', '/port').SMS_FULLSCREEN, '1');
  assert.equal(port.buildEnvironment(port.normalizeSettings({ fullscreenMode: 'exclusive', exclusiveResolution: '1920x1080' }), '/d', '/port').SMS_FULLSCREEN_MODE, undefined);
});

test('saved values outside what the game accepts fall back or are clamped', () => {
  const s = port.normalizeSettings({ cameraSpeed: 9000, mouseSensitivity: 'fast', msaa: 3, anisotropic: 5, sharpen: -4,
    brightness: 900, aspect: 'wide', presentFilter: 'cubic', vsync: 'sometimes', fullscreenMode: 'window',
    exclusiveResolution: '1920x1080; rm', display: 2 });
  assert.deepEqual([s.cameraSpeed, s.mouseSensitivity, s.msaa, s.anisotropic, s.sharpen, s.brightness], [400, 100, 0, 0, 0, 200]);
  assert.deepEqual([s.aspect, s.presentFilter, s.vsync, s.fullscreenMode, s.exclusiveResolution, s.display],
    ['keep', 'bilinear', 'off', 'desktop', 'desktop', 'launcher']);
});

test('the graphics API is OpenGL unless Vulkan is chosen, and reaches the game as SMS_GX_BACKEND', () => {
  assert.equal(port.normalizeSettings({}).renderer, 'opengl');
  assert.equal(port.buildEnvironment(port.normalizeSettings({}), '/d', '/port').SMS_GX_BACKEND, 'opengl');
  const vulkan = port.normalizeSettings({ renderer: 'vulkan' });
  assert.equal(vulkan.renderer, 'vulkan');
  assert.equal(port.buildEnvironment(vulkan, '/d', '/port').SMS_GX_BACKEND, 'vulkan');
  assert.equal(port.normalizeSettings({ renderer: 'directx' }).renderer, 'opengl');
});

test('FSR 1 is a scaling choice and reaches the game as SMS_PRESENT_FILTER=fsr', () => {
  const s = port.normalizeSettings({ presentFilter: 'fsr', resolution: 1, sharpen: 30 });
  assert.equal(s.presentFilter, 'fsr');
  const env = port.buildEnvironment(s, '/my/disc.iso', '/port');
  assert.deepEqual([env.SMS_PRESENT_FILTER, env.SMS_GX_SCALE, env.SMS_SHARPEN], ['fsr', '1', '30']);
  assert.equal(env.SMS_FSR_MODE, 'quality');
  const performance = port.buildEnvironment(port.normalizeSettings({ presentFilter: 'fsr', fsrMode: 'performance' }), '/d', '/port');
  assert.equal(performance.SMS_FSR_MODE, 'performance');
  assert.equal(port.normalizeSettings({ fsrMode: 'turbo' }).fsrMode, 'quality');
  // without FSR 1 the game keeps Picture sharpness
  assert.equal(port.buildEnvironment(port.normalizeSettings({ fsrMode: 'performance' }), '/d', '/port').SMS_FSR_MODE, undefined);
});

test('NIS is a scaling choice that takes the same upscaling quality', () => {
  const s = port.normalizeSettings({ presentFilter: 'nis', fsrMode: 'balanced' });
  assert.equal(s.presentFilter, 'nis');
  const env = port.buildEnvironment(s, '/d', '/port');
  assert.deepEqual([env.SMS_PRESENT_FILTER, env.SMS_FSR_MODE], ['nis', 'balanced']);
});

test('HDR is off unless chosen; on, it follows Windows calibration or the chosen nits', () => {
  const off = port.normalizeSettings({});
  assert.deepEqual([off.hdr, off.hdrCalibration, off.hdrPaperWhite, off.hdrPeak, off.hdrContrast, off.hdrSaturation, off.hdrHighlights],
    [false, true, 200, 1000, 100, 100, 40]);
  const offEnv = port.buildEnvironment(off, '/d', '/port');
  assert.equal(offEnv.SMS_HDR, '0');
  assert.equal(offEnv.SMS_HDR_PEAK, undefined);
  const calibrated = port.buildEnvironment(port.normalizeSettings({ hdr: true, hdrContrast: 110 }), '/d', '/port');
  assert.deepEqual([calibrated.SMS_HDR, calibrated.SMS_HDR_PAPER_WHITE, calibrated.SMS_HDR_PEAK, calibrated.SMS_HDR_CONTRAST,
    calibrated.SMS_HDR_SATURATION, calibrated.SMS_HDR_HIGHLIGHTS], ['1', 'auto', 'auto', '110', '100', '40']);
  const manual = port.buildEnvironment(port.normalizeSettings({ hdr: true, hdrCalibration: false, hdrPaperWhite: 250, hdrPeak: 800 }), '/d', '/port');
  assert.deepEqual([manual.SMS_HDR_PAPER_WHITE, manual.SMS_HDR_PEAK], ['250', '800']);
  const clamped = port.normalizeSettings({ hdrPaperWhite: 5, hdrPeak: 99999, hdrSaturation: -3, hdrHighlights: 400 });
  assert.deepEqual([clamped.hdrPaperWhite, clamped.hdrPeak, clamped.hdrSaturation, clamped.hdrHighlights], [80, 4000, 0, 100]);
});

test('HD textures load before each level unless another loading is chosen', () => {
  const env = settings => port.buildEnvironment(port.normalizeSettings(settings), '/my/disc.iso', '/port');
  assert.equal(port.normalizeSettings({}).textureLoading, 'stage');
  assert.equal(port.normalizeSettings({ textureLoading: 'sometimes' }).textureLoading, 'stage');
  assert.equal(env({}).SMS_TEXTURE_PACK_PRELOAD, '1');
  assert.equal(env({ textureLoading: 'all' }).SMS_TEXTURE_PACK_PRELOAD, 'all');
  assert.equal(env({ textureLoading: 'play' }).SMS_TEXTURE_PACK_PRELOAD, '0');
});

test('shader warm-up stays on unless turned off, and reaches the game as SMS_GX_SHADER_WARMUP', () => {
  const env = settings => port.buildEnvironment(port.normalizeSettings(settings), '/my/disc.iso', '/port');
  assert.equal(port.normalizeSettings({}).shaderWarmup, true);
  assert.equal(port.normalizeSettings({ shaderWarmup: false }).shaderWarmup, false);
  assert.equal(env({}).SMS_GX_SHADER_WARMUP, '1');
  assert.equal(env({ shaderWarmup: false }).SMS_GX_SHADER_WARMUP, '0');
});

test('the heat-wave effect stays on unless turned off, and reaches the game as SMS_HEAT_HAZE', () => {
  assert.equal(port.normalizeSettings({}).heatHaze, true);
  assert.equal(port.normalizeSettings({}).buttonPrompts, 'gamecube');
  assert.equal(port.normalizeSettings({}).promptPad, 'match');
  assert.equal(port.normalizeSettings({ promptPad: 'snes' }).promptPad, 'match');
  assert.equal(port.buildEnvironment(port.normalizeSettings({ buttonPrompts: 'auto', promptPad: 'playstation' }), '/my/disc.iso', '/port').SMS_BUTTON_PROMPT_PAD, 'playstation');
  assert.equal(port.normalizeSettings({ buttonPrompts: 'playstation' }).buttonPrompts, 'playstation');
  assert.equal(port.buildEnvironment(port.normalizeSettings({ buttonPrompts: 'auto' }), '/my/disc.iso', '/port').SMS_BUTTON_PROMPTS, 'auto');
  assert.equal(port.normalizeSettings({ heatHaze: false }).heatHaze, false);
  assert.equal(port.buildEnvironment(port.normalizeSettings({}), '/my/disc.iso', '/port').SMS_HEAT_HAZE, '1');
  assert.equal(port.buildEnvironment(port.normalizeSettings({ heatHaze: false }), '/my/disc.iso', '/port').SMS_HEAT_HAZE, '0');
});

test('skip intro stays off unless turned on, and reaches the game as SMS_SKIP_INTRO', () => {
  assert.equal(port.normalizeSettings({}).skipIntro, false);
  assert.equal(port.normalizeSettings({ skipIntro: true }).skipIntro, true);
  assert.equal(port.buildEnvironment(port.normalizeSettings({}), '/my/disc.iso', '/port').SMS_SKIP_INTRO, '0');
  assert.equal(port.buildEnvironment(port.normalizeSettings({ skipIntro: true }), '/my/disc.iso', '/port').SMS_SKIP_INTRO, '1');
});

test('the pause menu tracker stays on unless turned off, and reaches the game as SMS_PAUSE_TRACKER', () => {
  assert.equal(port.normalizeSettings({}).pauseTracker, true);
  assert.equal(port.normalizeSettings({ pauseTracker: false }).pauseTracker, false);
  assert.equal(port.buildEnvironment(port.normalizeSettings({}), '/my/disc.iso', '/port').SMS_PAUSE_TRACKER, '1');
  assert.equal(port.buildEnvironment(port.normalizeSettings({ pauseTracker: false }), '/my/disc.iso', '/port').SMS_PAUSE_TRACKER, '0');
});

test('Windows upgrade keeps the existing 32-bit game available with its original settings and tools', t => {
  const root = temporary();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const saved = { repo: root, rom: 'own-disc.iso', settings: { arch: '32', textures: true }, saveDirectory: 'my-saves' };
  assert.equal(port.playableInstall(saved, 'win32'), null);
  const binary = port.binaryPath(root, saved.settings, 'win32');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, 'previous 32-bit game');
  const previous = port.playableInstall(saved, 'win32');
  assert.equal(previous.settings.arch, '32');
  assert.equal(previous.settings.textures, true);
  assert.equal(previous.saveDirectory, saved.saveDirectory);
  assert.equal(fs.readFileSync(binary, 'utf8'), 'previous 32-bit game');
  const msys = path.join(root, 'tools');
  fs.mkdirSync(path.join(msys, 'usr', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(msys, 'usr', 'bin', 'bash.exe'), '');
  const cmd = port.commandFor(root, 'run', [saved.rom], 'win32', { SMS_ARCH: previous.settings.arch, MSYS2_ROOT: msys });
  assert.equal(cmd.command, binary);
  assert.ok(cmd.env.PATH.startsWith(path.join(msys, 'mingw32', 'bin')));
  assert.equal(port.playableInstall({ ...saved, settings: { arch: '64' } }, 'win32'), null);
  assert.equal(port.normalizeSettings({ arch: '32' }, 'darwin').arch, '64');
  assert.equal(port.normalizeSettings({}, 'win32').arch, '64');
  const x64 = port.binaryPath(root, { arch: '64' }, 'win32');
  fs.mkdirSync(path.dirname(x64), { recursive: true });
  fs.writeFileSync(x64, 'previous 64-bit game');
  assert.equal(port.playableInstall({ ...saved, settings: { arch: '64' } }, 'win32').settings.arch, '64');
});

test('recognizes an installed texture pack and points the game at its folder', () => {
  const dir = temporary();
  try {
    assert.equal(port.texturePackInstalled(dir), false);
    const textures = port.texturePackDirectory(dir);
    fs.mkdirSync(path.join(textures, 'GMS', 'stage'), { recursive: true });
    fs.writeFileSync(path.join(textures, 'GMS', 'stage', 'tex1_abcdef.dds'), 'texture');
    assert.equal(port.texturePackInstalled(dir), true);
    const settings = port.normalizeSettings({ textures: true });
    assert.equal(port.buildEnvironment(settings, '/my/disc.iso', dir).SMS_TEXTURE_PACKS, textures);
    const progressScript = path.resolve(__dirname, '..', 'scripts', 'texture-progress.py');
    for (const platform of ['linux', 'darwin'])
      assert.deepEqual(port.commandFor(dir, 'textures', [], platform).args,
        [progressScript, path.join(dir, 'tools', 'mods', 'get.py')]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('texture extras are downloaded again only when the port pins another release', t => {
  const root = temporary(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const on = port.normalizeSettings({ textures: true }), off = port.normalizeSettings({ textures: false });
  const pin = md5 => {
    fs.mkdirSync(path.join(root, 'tools', 'mods'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tools', 'mods', 'texture-extras.json'), JSON.stringify({ md5 }));
  };
  const record = md5 => {
    fs.mkdirSync(port.textureExtrasDirectory(root), { recursive: true });
    fs.writeFileSync(path.join(port.textureExtrasDirectory(root), '.release'), JSON.stringify({ md5 }));
  };
  // An older port without the extras: nothing to download, HD setup unchanged.
  assert.equal(port.textureExtrasSupported(root), false);
  assert.equal(port.textureExtrasWanted(root, on), false);
  pin('9352b8c1462182ca1a5493eef4062f1e');
  assert.equal(port.textureExtrasWanted(root, on), true);   // existing UHD-only install
  assert.equal(port.textureExtrasWanted(root, off), false); // HD textures off
  record('9352b8c1462182ca1a5493eef4062f1e');
  assert.equal(port.textureExtrasInstalled(root), true);
  assert.equal(port.textureExtrasWanted(root, on), false);
  pin('0123456789abcdef0123456789abcdef');                   // a newer release pinned
  assert.equal(port.textureExtrasWanted(root, on), true);
  fs.writeFileSync(path.join(port.textureExtrasDirectory(root), '.release'), 'not json');
  assert.equal(port.textureExtrasWanted(root, on), true);
  // The extras never hold up HD setup or play: they are not part of hdVisualsInstalled.
  fs.writeFileSync(path.join(port.texturePackDirectory(root), 'tex1_existing.png'), 'texture');
  assert.equal(port.hdVisualsInstalled(root, on), true);
  const progressScript = path.resolve(__dirname, '..', 'scripts', 'texture-progress.py');
  for (const platform of ['linux', 'darwin'])
    assert.deepEqual(port.commandFor(root, 'texture-extras', [], platform).args,
      [progressScript, path.join(root, 'tools', 'mods', 'get.py'), 'extras', '--if-outdated']);
});

// A game folder whose tools/mods/language-packs.json says what it plays.
function gameWithLanguages(t, list) {
  const root = temporary(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  if (list) {
    fs.mkdirSync(path.join(root, 'tools', 'mods'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tools', 'mods', 'language-packs.json'), JSON.stringify(list));
  }
  return root;
}
const ANY = { any_language: true, languages: {} };

test('the game plays in English unless another language is chosen', t => {
  const root = gameWithLanguages(t, ANY);
  assert.equal(port.normalizeSettings({}).language, 'en');
  assert.equal(port.normalizeSettings({ language: 'klingon' }).language, 'en');
  assert.deepEqual(port.LANGUAGES, ['en', 'fr', 'de', 'es', 'it', 'pl']);
  for (const code of port.LANGUAGES) {
    const settings = port.normalizeSettings({ language: code });
    assert.equal(settings.language, code);
    assert.equal(port.buildEnvironment(settings, '/my/disc.iso', root).SMS_LANGUAGE, code);
  }
});

test('Eclipse always plays in English and keeps the chosen language for Super Mario Sunshine', t => {
  const root = gameWithLanguages(t, ANY);
  for (const code of port.LANGUAGES) {
    const eclipse = port.normalizeSettings({ language: code, eclipse: true });
    assert.equal(eclipse.language, code);
    assert.equal(port.buildEnvironment(eclipse, '/my/disc.iso', root).SMS_LANGUAGE, 'en');
    assert.equal(port.buildEnvironment({ ...eclipse, eclipse: false }, '/my/disc.iso', root).SMS_LANGUAGE, code);
  }
});

test('the catalog lists every language with a release to install', () => {
  for (const [code, pack] of Object.entries(port.LANGUAGE_PACKS)) {
    assert.match(code, /^[a-z]{2,3}$/);
    assert.ok(pack.name && pack.english, code);
    assert.match(pack.url, /^https:\/\/github\.com\/chasem-dev\/sms-hd-texture-extras\/releases\/download\//);
    assert.match(pack.md5, /^[0-9a-f]{32}$/);
    assert.ok(Number.isInteger(pack.size) && pack.size > 0, code);
  }
  assert.equal(port.LANGUAGE_PACKS.pl.community, true);
});

test('a language plays only in a game that has it, and older games stay in English', t => {
  const older = gameWithLanguages(t, null);                                     // before language packs
  const first = gameWithLanguages(t, { languages: { fr: {}, de: {}, es: {}, it: {} } }); // the official four only
  const any = gameWithLanguages(t, ANY);                                        // any installed pack
  const polish = port.normalizeSettings({ language: 'pl' }), french = port.normalizeSettings({ language: 'fr' });
  assert.equal(port.languageAvailable(older, 'fr'), false);
  assert.equal(port.languageAvailable(first, 'fr'), true);
  assert.equal(port.languageAvailable(first, 'pl'), false);
  assert.equal(port.languageAvailable(any, 'pl'), true);
  assert.equal(port.languageAvailable(any, 'xx'), false);                       // not in the catalog
  assert.equal(port.buildEnvironment(polish, '/my/disc.iso', first).SMS_LANGUAGE, 'en');
  assert.equal(port.buildEnvironment(french, '/my/disc.iso', older).SMS_LANGUAGE, 'en');
  assert.equal(port.languagePackWanted(first, polish), false);                  // nothing to download for it
  assert.deepEqual(port.languageChoices(first).map(l => [l.code, l.available]),
    [['en', true], ['fr', true], ['de', true], ['es', true], ['it', true], ['pl', false]]);
  assert.ok(port.languageChoices(null).every(l => l.available));               // before setup: offer them all
});

test('a language pack is downloaded when that language is chosen and the catalog\'s release is missing', t => {
  const root = gameWithLanguages(t, ANY);
  const french = port.normalizeSettings({ language: 'fr' }), english = port.normalizeSettings({});
  const record = md5 => {
    fs.mkdirSync(port.languagePackDirectory(root, 'fr'), { recursive: true });
    fs.writeFileSync(path.join(port.languagePackDirectory(root, 'fr'), '.release'), JSON.stringify({ md5 }));
  };
  assert.equal(port.languagePackWanted(root, french), true);
  assert.equal(port.languagePackWanted(root, english), false); // English is the disc's own
  assert.equal(port.languagePackWanted(root, { ...french, eclipse: true }), false); // Eclipse plays in English
  record(port.LANGUAGE_PACKS.fr.md5);
  assert.equal(port.languagePackInstalled(root, 'fr'), true);
  assert.equal(port.languagePackWanted(root, french), false);
  assert.equal(port.languagePackInstalled(root, 'de'), false);
  record('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');                   // an older release installed
  assert.equal(port.languagePackWanted(root, french), true);
  const scripts = path.resolve(__dirname, '..', 'scripts');
  const pl = port.LANGUAGE_PACKS.pl;
  for (const platform of ['linux', 'darwin'])
    assert.deepEqual(port.commandFor(root, 'language', ['pl'], platform).args,
      [path.join(scripts, 'texture-progress.py'), path.join(scripts, 'install-language.py'), 'pl', pl.name, pl.url, pl.md5, String(pl.size)]);
  assert.throws(() => port.commandFor(root, 'language', ['xx'], 'linux'), /no language pack "xx"/);
  for (const platform of ['linux', 'darwin'])
    assert.deepEqual(port.commandFor(root, 'python', ['/games/sms.iso'], platform).args,
      [path.join(scripts, 'texture-progress.py'), path.join(root, 'tools', 'mods', 'get.py'), 'eclipse', '--iso', '/games/sms.iso']);
});

test('Eclipse builder uses its own CMake tree without bundling the patched disc', () => {
  if (process.platform !== 'linux') return;
  const dir = temporary();
  try {
    const repo = path.join(dir, 'port');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(path.join(repo, 'cmake'), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(repo, 'cmake', 'eclipse.cmake'), '');
    for (const name of ['git', 'cmake', 'clang', 'clang++']) {
      const file = path.join(bin, name);
      fs.writeFileSync(file, '#!/bin/sh\nprintf "%s\\n" "$0 $*" >> "$CALL_LOG"\n');
      fs.chmodSync(file, 0o755);
    }
    const callLog = path.join(dir, 'calls.txt');
    const result = spawnSync(path.join(__dirname, '..', 'scripts', 'build-eclipse.sh'), [repo, '64'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: callLog }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = fs.readFileSync(callLog, 'utf8');
    assert.match(calls, /-DSMS_ECLIPSE=ON/);
    assert.match(calls, /-DSMS_BUNDLE_DISC=/);
    assert.match(calls, /build\/linux-64-eclipse/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Eclipse builder explains a missing clang before configuring', () => {
  if (process.platform !== 'linux') return;
  const dir = temporary();
  try {
    const repo = path.join(dir, 'port');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(path.join(repo, 'cmake'), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(repo, 'cmake', 'eclipse.cmake'), '');
    fs.symlinkSync(spawnSync('sh', ['-c', 'command -v uname'], { encoding: 'utf8' }).stdout.trim(), path.join(bin, 'uname'));
    const result = spawnSync('/bin/bash', [path.join(__dirname, '..', 'scripts', 'build-eclipse.sh'), repo, '64'], {
      env: { PATH: bin }, encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Eclipse needs clang and clang\+\+/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Windows command passes an image path as data to MSYS2 Bash', () => {
  const dir = temporary();
  const old = process.env.MSYS2_ROOT;
  try {
    fs.mkdirSync(path.join(dir, 'usr', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'usr', 'bin', 'bash.exe'), '');
    process.env.MSYS2_ROOT = dir;
    const rom = 'C:\\Games\\Sunshine (own copy).iso';
    const cmd = port.commandFor('C:\\port', 'build', [rom], 'win32', { PATH: 'C:\\Windows', MSYS2_ROOT: dir });
    assert.equal(cmd.args.at(-1), rom);
    assert.doesNotMatch(cmd.args[1], /Sunshine/);
    assert.match(cmd.env.PATH, /mingw64/);
    const textures = port.commandFor('C:\\port', 'textures', [], 'win32', { PATH: 'C:\\Windows', MSYS2_ROOT: dir });
    assert.match(textures.args[1], /python "\$\(cygpath -u "\$2"\)" tools\/mods\/get\.py/);
    assert.equal(textures.args[3], 'C:\\port');
    assert.equal(textures.args[4], path.resolve(__dirname, '..', 'scripts', 'texture-progress.py'));
    const extras = port.commandFor('C:\\port', 'texture-extras', [], 'win32', { PATH: 'C:\\Windows', MSYS2_ROOT: dir });
    assert.match(extras.args[1], /tools\/mods\/get\.py extras --if-outdated$/);
    assert.equal(extras.args[4], path.resolve(__dirname, '..', 'scripts', 'texture-progress.py'));
    const language = port.commandFor('C:\\port', 'language', ['es'], 'win32', { PATH: 'C:\\Windows', MSYS2_ROOT: dir });
    assert.match(language.args[1], /python "\$\(cygpath -u "\$2"\)" "\$\(cygpath -u "\$3"\)" "\$\{@:4\}"$/);
    const es = port.LANGUAGE_PACKS.es;
    assert.deepEqual(language.args.slice(3), ['C:\\port', path.resolve(__dirname, '..', 'scripts', 'texture-progress.py'),
      path.resolve(__dirname, '..', 'scripts', 'install-language.py'), 'es', es.name, es.url, es.md5, String(es.size)]);
    // The Eclipse install reports its 900 MB download through the same wrapper.
    const eclipse = port.commandFor('C:\\port', 'python', ['C:\\Games\\Sunshine.iso'], 'win32', { PATH: 'C:\\Windows', MSYS2_ROOT: dir });
    assert.match(eclipse.args[1], /python "\$\(cygpath -u "\$2"\)" tools\/mods\/get\.py eclipse --iso "\$\(cygpath -u "\$3"\)"$/);
    assert.deepEqual(eclipse.args.slice(3), ['C:\\port', path.resolve(__dirname, '..', 'scripts', 'texture-progress.py'), 'C:\\Games\\Sunshine.iso']);
  } finally {
    if (old === undefined) delete process.env.MSYS2_ROOT;
    else process.env.MSYS2_ROOT = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('Windows games start directly with the target DLL paths and literal disc arguments', () => {
  const root = 'C:\\Games\\Sunshine', disc = 'C:\\Discs\\My Sunshine & own.iso';
  for (const arch of ['32', '64']) for (const eclipse of [false, true]) {
    const settings = { arch, eclipse };
    const env = { MSYS2_ROOT: 'C:\\Private tools\\msys64', SMS_ARCH: arch,
      SMS_WINDOWS_32_CROSS: arch === '32' ? '1' : undefined, PATH: 'C:\\Windows' };
    const command = eclipse ? port.eclipseRunCommand(root, settings, disc, 'win32', env)
      : port.commandFor(root, 'run', [disc], 'win32', env);
    assert.equal(command.command, port.binaryPath(root, settings, 'win32'));
    assert.deepEqual(command.args, [disc]);
    assert.equal(command.cwd, root);
    const bins = command.env.PATH.split(';');
    assert.ok(bins.includes(path.join(env.MSYS2_ROOT, arch === '32' ? 'mingw32' : 'mingw64', 'bin')));
    if (arch === '32') assert.equal(bins[0], path.join(env.MSYS2_ROOT, 'opt', 'i686-w64-mingw32', 'bin'));
    assert.equal(bins.at(-1), env.PATH);
    assert.equal(env.PATH, 'C:\\Windows');
  }
});

test('HD movies have their own setting and only complete packs are recognized', t => {
  const root = temporary();t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = port.cutscenePackDirectory(root);
  const movies = Array.from({ length: 21 }, (_, i) => ({ disc_path: `data/movie${i}.thp`, target_bytes: 8 }));
  const catalog = { schema: 1, release: 'test-v1', movies };
  fs.mkdirSync(path.join(root, 'tools', 'media'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tools', 'media', 'cutscene-release.json'), JSON.stringify(catalog));
  fs.mkdirSync(path.join(folder, 'files', 'data'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'installed.json'), JSON.stringify(catalog));
  assert.equal(port.cutscenePackInstalled(root), false);
  // An older preferences.json with HD textures on but no movie pack: movies stay off.
  assert.equal(port.savedSettings({ textures: true }, root).cutscenes, false);
  fs.writeFileSync(path.join(folder, 'sms-hd-cutscenes-v1.complete'), 'test-v1\n');
  for (const movie of movies) fs.writeFileSync(path.join(folder, 'files', movie.disc_path), 'HD movie');
  assert.equal(port.cutscenePackInstalled(root), true);
  // ...and with the pack already set up, they stay on.
  assert.equal(port.savedSettings({ textures: true }, root).cutscenes, true);
  assert.equal(port.savedSettings({ textures: true, cutscenes: false }, root).cutscenes, false);
  assert.equal(port.savedSettings({ textures: false }, root).cutscenes, false);
  assert.deepEqual(port.savedSettings(undefined, root), { textures: true });
  assert.equal(port.normalizeSettings({ textures: true }).cutscenes, false);
  assert.equal(port.hdVisualsInstalled(root, port.normalizeSettings({ textures: true, cutscenes: true })), false);
  fs.writeFileSync(path.join(folder, 'files', movies[20].disc_path), 'damaged');
  assert.equal(port.cutscenePackInstalled(root), false);
  assert.equal(port.hdVisualsInstalled(root, port.normalizeSettings({ textures: false, cutscenes: true })), true);
  assert.equal(port.hdVisualsInstalled(root, port.normalizeSettings({ textures: false, cutscenes: true, eclipse: true })), true);
  assert.equal(port.hdVisualsInstalled(root, port.normalizeSettings({})), false);
  const settings = port.normalizeSettings({ textures: true, cutscenes: true, eclipse: false });
  assert.equal(port.buildEnvironment(settings, '/my/disc.iso', root).SMS_HD_CUTSCENES, folder);
  // The game plays HD movies only with HD textures on, so none are set up or passed without them.
  assert.equal(port.buildEnvironment({ ...settings, textures: false }, '/my/disc.iso', root).SMS_HD_CUTSCENES, '0');
  assert.equal(port.buildEnvironment({ ...settings, cutscenes: false, textures: true }, '/my/disc.iso', root).SMS_HD_CUTSCENES, '0');
  assert.equal(port.buildEnvironment({ ...settings, eclipse: true }, '/my/disc.iso', root).SMS_HD_CUTSCENES, '0');
  for (const platform of ['linux', 'darwin']) assert.deepEqual(port.commandFor(root, 'cutscenes', ['/my/disc.iso'], platform).args,
    ['tools/media/install_cutscenes.py', '--iso', '/my/disc.iso']);
  const msys = path.join(root, 'MSYS2');fs.mkdirSync(path.join(msys, 'usr', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(msys, 'usr', 'bin', 'bash.exe'), '');
  const cmd = port.commandFor(root, 'cutscenes', ['C:\\own game.iso'], 'win32', { MSYS2_ROOT: msys });
  assert.match(cmd.args[1], /install_cutscenes.py --iso/);
  assert.equal(cmd.args.at(-1), 'C:\\own game.iso');
});


test('older installed games remain playable with HD cutscenes on until updated', t => {
  const root = temporary(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = port.normalizeSettings({ textures: true, cutscenes: true, eclipse: false, autoUpdate: false });
  const textures = port.texturePackDirectory(root);
  fs.mkdirSync(textures, { recursive: true });
  fs.writeFileSync(path.join(textures, 'tex1_existing.png'), 'texture');
  assert.equal(port.cutscenePackSupported(root), false);
  assert.equal(port.hdVisualsInstalled(root, settings), true);
  const media = path.join(root, 'tools', 'media'); fs.mkdirSync(media, { recursive: true });
  fs.writeFileSync(path.join(media, 'install_cutscenes.py'), 'installer');
  assert.equal(port.cutscenePackSupported(root), true);
  assert.equal(port.hdVisualsInstalled(root, settings), false);
  assert.equal(port.hdVisualsInstalled(root, { ...settings, eclipse: true }), true);
});

test('soft L / R bindings start unbound and their depth reaches the game as SMS_SOFT_TRIGGER', () => {
  assert.equal(port.normalizeSettings({}).softTrigger, 40);
  assert.equal(port.normalizeSettings({ softTrigger: 300 }).softTrigger, 95);
  assert.equal(port.normalizeSettings({ softTrigger: 'deep' }).softTrigger, 40);
  assert.equal(port.buildEnvironment(port.normalizeSettings({ softTrigger: 30 }), '/my/disc.iso', '/port').SMS_SOFT_TRIGGER, '30');
  assert.deepEqual(port.normalizeSettings({ keyBindings: { R_SOFT: ['K'] } }).keyBindings, { R_SOFT: ['K'] });
  assert.deepEqual(port.normalizeSettings({ keyBindings: { R_SOFT: [] } }).keyBindings, {});
});

test('the rumble slider reaches the game at twice its value, 50% the console\'s, and 0 turns rumble off', () => {
  assert.equal(port.normalizeSettings({}).rumbleStrength, 50);
  assert.equal(port.normalizeSettings({ rumbleStrength: 500 }).rumbleStrength, 100);
  assert.equal(port.normalizeSettings({ rumbleStrength: 'strong' }).rumbleStrength, 50);
  const env = settings => port.buildEnvironment(port.normalizeSettings(settings), '/my/disc.iso', '/port');
  assert.deepEqual([env({}).SMS_RUMBLE, env({}).SMS_RUMBLE_STRENGTH], ['1', '100']);
  assert.deepEqual([env({ rumbleStrength: 25 }).SMS_RUMBLE, env({ rumbleStrength: 25 }).SMS_RUMBLE_STRENGTH], ['1', '50']);
  assert.equal(env({ rumbleStrength: 100 }).SMS_RUMBLE_STRENGTH, '200');
  assert.deepEqual([env({ rumbleStrength: 0 }).SMS_RUMBLE, env({ rumbleStrength: 0 }).SMS_RUMBLE_STRENGTH], ['0', '0']);
});

test('settings keep only changed, known controller buttons', () => {
  assert.deepEqual(port.normalizeSettings({}).padBindings, {});
  assert.deepEqual(port.normalizeSettings({ padBindings: { A: ['PAD_Y'], B: ['PAD_B'], JUMP: ['PAD_A'], X: ['NOPE'] } }).padBindings,
    { A: ['PAD_Y'] });
});

test('a Windows game folder too deep for the compiler is explained, with what to do', () => {
  // A player's portable launcher: the old folder name made the Eclipse build's deepest path 261 characters.
  const base = 'E:\\Spel\\Emulation\\Recomps, Decomp and other ports\\Super Mario Sunshine\\SMS-Launcher-Portable\\sms-pc-port.releases\\';
  const before = `${base}c1da79da5dc5-windows-x64-9d02b4b55bfc`, now = `${base}c1da79d-3f2a`;
  assert.equal(before.length, 151);
  const eclipse = { eclipse: true }, sunshine = { eclipse: false };
  const problem = port.longPathProblem(before, eclipse, { platform: 'win32', portable: true });
  assert.deepEqual([problem.folder, problem.length, problem.limit, problem.deepest], [base.slice(0, -1), 113, 92, 167]);
  assert.match(problem.message, /^The SMS-Launcher-Portable folder's path is 113 characters long, more than the 92 Windows can build Super Mario Eclipse in/);
  assert.match(problem.message, /Move the launcher and its SMS-Launcher-Portable folder together/);
  assert.match(port.longPathProblem(before, eclipse, { platform: 'win32' }).message,
    /^The folder holding the setup files's path .* Choose a shorter folder for Setup files in Settings/);
  // Sunshine's shallower build was one character over too; the shorter folder names fit both.
  assert.match(port.longPathProblem(before, sunshine, { platform: 'win32' }).message, /113 characters long, more than the 112 Windows can build the game in/);
  assert.equal(port.longPathProblem(now, eclipse, { platform: 'win32', portable: true }), null);
  assert.equal(port.longPathProblem(now, sunshine, { platform: 'win32', portable: true }), null);
  // The 260-character limit is Windows'.
  assert.equal(port.longPathProblem(before, eclipse, { platform: 'linux' }), null);
});

test('build tools too deep in a portable folder for their own headers are explained', () => {
  // A player's portable launcher inside another launcher's Apps folder: GCC opened
  // …\msys64\mingw64\bin\..\lib\gcc\…\..\..\..\..\include\c++\16.2.0\x86_64-w64-mingw32\bits\c++config.h
  // at 275 characters, and every C++ file failed to find it.
  const folder = 'C:\\Users\\leona\\Desktop\\Quiver\\QuiverLauncher-win-Portable\\Apps\\SuperMarioSunshine-SMSLauncher\\SMS-Launcher-Portable';
  const msys = `${folder}\\build-tools\\windows-x64-9d02b4b55bfc\\msys64`;
  const root = `${folder}\\sms-pc-port`, sunshine = { eclipse: false };
  assert.equal(folder.length, 115);
  // The game folder alone fits, so only the tools' headers show the problem.
  assert.equal(port.longPathProblem(root, sunshine, { platform: 'win32', portable: true, folder }), null);
  const problem = port.longPathProblem(root, sunshine, { platform: 'win32', portable: true, folder, msys });
  assert.deepEqual([problem.length, problem.limit, problem.deepest], [115, 92, 167]);
  assert.match(problem.message, /^The SMS-Launcher-Portable folder's path is 115 characters long, more than the 92 Windows can build the game in, so the build would fail/);
  // Moved to C:\Games, both fit; a player's own MSYS2 elsewhere doesn't count against the folder.
  const games = 'C:\\Games\\SMS-Launcher-Portable';
  assert.equal(port.longPathProblem(`${games}\\sms-pc-port`, sunshine,
    { platform: 'win32', portable: true, folder: games, msys: `${games}\\build-tools\\windows-x64-9d02b4b55bfc\\msys64` }), null);
  assert.equal(port.longPathProblem(root, sunshine, { platform: 'win32', portable: true, folder, msys: 'C:\\msys64' }), null);
});
