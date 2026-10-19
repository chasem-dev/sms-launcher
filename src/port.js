'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeChannel } = require('./update-channel');
const bindings = require('./bindings');
const prompts = require('./prompts');
const presets = require('./presets');
const { prependWindowsPath } = require('./windows-path');

const PORT_URL = 'https://github.com/chasem-dev/sms-pc-port.git';
const ECLIPSE_ISO = path.join('mods', 'eclipse', 'Super Mario Eclipse v1.1.0.iso');

function platformInfo(platform = process.platform) {
  if (platform === 'linux') return { name: 'Linux', id: 'linux', arches: ['64', '32'], defaultArch: '64' };
  if (platform === 'darwin') return { name: 'macOS', id: 'macos', arches: ['64'], defaultArch: '64' };
  if (platform === 'win32') return { name: 'Windows', id: 'windows', arches: ['64', '32'], defaultArch: '64' };
  throw new Error(`This port does not support ${platform}.`);
}

function isPort(root) {
  return Boolean(root && ['CMakeLists.txt', 'build.sh', 'run.sh', 'clean.sh', path.join('tools', 'mods', 'get.py')]
    .every(file => fs.existsSync(path.join(root, file))));
}

function validateRom(file) {
  if (!file || typeof file !== 'string') throw new Error('Choose your own game disc file first.');
  const absolute = path.resolve(file);
  if (!['.iso', '.gcm', '.ciso'].includes(path.extname(absolute).toLowerCase()))
    throw new Error('Choose an ISO, GCM, or CISO game disc file.');
  let stat;
  try { stat = fs.statSync(absolute); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('That game file cannot be found. Choose it again.');
    throw error;
  }
  if (!stat.isFile()) throw new Error('Choose a game disc file, not a folder.');
  const fd = fs.openSync(absolute, 'r');
  try {
    const first = Buffer.alloc(0x20);
    if (fs.readSync(fd, first, 0, first.length, 0) !== first.length) throw new Error('This file is too small to be a game disc copy.');
    let offset = 0;
    if (first.toString('ascii', 0, 4) === 'CISO') {
      const blockSize = first.readUInt32LE(4);
      if (blockSize < 0x20 || blockSize > 0x200000 || first[8] !== 1)
        throw new Error('This compressed game disc file appears to be damaged.');
      offset = 0x8000;
      if (fs.readSync(fd, first, 0, first.length, offset) !== first.length) throw new Error('This compressed game disc file appears to be incomplete.');
    }
    if (first.toString('ascii', 0, 6) !== 'GMSE01' || first[7] !== 0 || first.readUInt32BE(0x1c) !== 0xc2339f3d)
      throw new Error('Use a copy of your own North American Super Mario Sunshine disc (GMSE01, original revision).');
    return absolute;
  } finally { fs.closeSync(fd); }
}

// A whole-number setting within lo..hi, or the fallback when unset or unreadable.
function numberSetting(value, fallback, lo, hi) {
  const number = value === null || value === '' || value === undefined ? NaN : Number(value);
  return Number.isFinite(number) ? Math.min(hi, Math.max(lo, Math.round(number))) : fallback;
}
function choiceSetting(value, choices, fallback) { return choices.includes(value) ? value : fallback; }
// The game's SMS_RUMBLE_STRENGTH (100 is the console's, up to 200) for the launcher's slider (50 is the console's).
function rumbleGameStrength(slider) { return numberSetting(slider, 50, 0, 100) * 2; }

function normalizeSettings(input = {}, platform = process.platform) {
  const info = platformInfo(platform);
  const arch = info.arches.includes(String(input.arch)) ? String(input.arch) : info.defaultArch;
  const widescreen = ['off', '16:9', '16:10', '21:9'].includes(input.widescreen) ? input.widescreen : '16:9';
  const resolution = [1, 2, 3, 4].includes(Number(input.resolution)) ? Number(input.resolution) : 4;
  // Migrate the previous 60 fps toggle without changing a saved preference.
  const frameRate = [30, 60, 120].includes(Number(input.frameRate))
    ? Number(input.frameRate) : input.fps60 === false ? 30 : 60;
  const volume = Number.isFinite(Number(input.volume)) && input.volume !== null && input.volume !== ''
    ? Math.min(100, Math.max(0, Math.round(Number(input.volume)))) : 100;
  const settings = {
    arch, widescreen, resolution,
    frameRate,
    hudEdges: input.hudEdges !== false,
    fullscreen: Boolean(input.fullscreen),
    // Borderless (desktop) fullscreen, or exclusive, which switches the display to exclusiveResolution.
    fullscreenMode: choiceSetting(input.fullscreenMode, ['desktop', 'exclusive'], 'desktop'),
    exclusiveResolution: /^\d{3,5}x\d{3,5}$/.test(String(input.exclusiveResolution)) ? String(input.exclusiveResolution) : 'desktop',
    // The monitor under the mouse (usually the launcher's), or the primary one.
    display: choiceSetting(input.display, ['launcher', 'primary'], 'launcher'),
    vsync: choiceSetting(input.vsync, ['off', 'on', 'adaptive'], 'off'),
    // Straight to the title screen, and the game's frame-time overlay at start.
    skipMovies: Boolean(input.skipMovies),
    // Straight to the title: no Nintendo and Dolby logos or opening movie; off unless turned on.
    skipIntro: Boolean(input.skipIntro),
    // The game's language: the disc's own English, or a language pack (French, German, Spanish, Italian).
    language: choiceSetting(input.language, LANGUAGES, 'en'),
    // The heat-wave shimmer in sunny areas; on unless turned off.
    heatHaze: input.heatHaze !== false,
    // The pause menu's Shine and blue coin tracker; on unless turned off (Eclipse has its own instead).
    pauseTracker: input.pauseTracker !== false,
    // Which buttons the game's text shows (src/prompts.js): the GameCube's own, or another controller's or the keys.
    buttonPrompts: prompts.normalizeStyle(input.buttonPrompts),
    promptPad: prompts.normalizePad(input.promptPad),
    // HDR output (Windows): off unless chosen. With hdrCalibration the game takes peak brightness from the
    // Windows HDR Calibration profile and paper white from Windows' SDR content brightness; otherwise these
    // nits. Contrast and saturation are percent (100 unchanged); highlights is how far whites reach toward the peak.
    hdr: Boolean(input.hdr),
    hdrCalibration: input.hdrCalibration !== false,
    hdrPaperWhite: numberSetting(input.hdrPaperWhite, 200, 80, 500),
    hdrPeak: numberSetting(input.hdrPeak, 1000, 400, 4000),
    hdrContrast: numberSetting(input.hdrContrast, 100, 50, 150),
    hdrSaturation: numberSetting(input.hdrSaturation, 100, 0, 200),
    hdrHighlights: numberSetting(input.hdrHighlights, 40, 0, 100),
    overlay: Boolean(input.overlay),
    invertCameraX: input.invertCameraX !== false,
    invertCameraY: input.invertCameraY !== false,
    // The camera stays where it is put instead of swinging back behind Mario; manual turning speed; mouse look.
    freeCamera: Boolean(input.freeCamera),
    // The C-stick turns (and aims FLUDD in) the close-up camera Y opens, as well as the control stick.
    cstickAim: Boolean(input.cstickAim),
    cameraSpeed: numberSetting(input.cameraSpeed, 100, 10, 400),
    mouseCamera: Boolean(input.mouseCamera),
    mouseSensitivity: numberSetting(input.mouseSensitivity, 100, 5, 1000),
    // Picture: anti-aliasing, texture filtering, sharpening, brightness (percent; 100 unchanged), fit and scaler.
    msaa: [0, 2, 4, 8].includes(Number(input.msaa)) ? Number(input.msaa) : 0,
    fxaa: Boolean(input.fxaa),
    anisotropic: [0, 2, 4, 8, 16].includes(Number(input.anisotropic)) ? Number(input.anisotropic) : 0,
    sharpen: numberSetting(input.sharpen, 0, 0, 100),
    brightness: numberSetting(input.brightness, 100, 50, 200),
    aspect: choiceSetting(input.aspect, ['keep', 'stretch', 'integer'], 'keep'),
    // fsr: AMD FSR 1, which upscales a low picture sharpness with clean edges (the game's sharpening sets its strength).
    presentFilter: choiceSetting(input.presentFilter, ['bilinear', 'sharp', 'nearest', 'fsr', 'nis'], 'bilinear'),
    // The game's graphics API; with Vulkan it falls back to OpenGL by itself when Vulkan cannot start.
    renderer: choiceSetting(input.renderer, ['opengl', 'vulkan'], 'opengl'),
    // With FSR 1: how far below the picture's size on screen the game renders (it sets the internal resolution).
    fsrMode: choiceSetting(input.fsrMode, ['native', 'quality', 'balanced', 'performance', 'ultraperformance'], 'quality'),
    // Master volume in percent; 100 leaves the game's sound as it is.
    volume,
    textures: input.textures !== false,
    // When HD textures load: while each level loads (stage), the whole pack over the first loading
    // screens and kept (all, for graphics cards with plenty of memory), or each when first drawn (play).
    textureLoading: choiceSetting(input.textureLoading, ['stage', 'all', 'play'], 'stage'),
    // The game compiles each level's shaders while it loads, and the rest in the background, instead
    // of when they are first drawn; on unless turned off.
    shaderWarmup: input.shaderWarmup !== false,
    // HD cutscenes are a separate 5 GB download, off unless chosen.
    cutscenes: Boolean(input.cutscenes),
    eclipse: Boolean(input.eclipse),
    autoUpdate: input.autoUpdate !== false,
    // Anonymous usage heartbeats (versions and OS only); see README Privacy.
    shareUsage: input.shareUsage !== false,
    // Show what you are playing on your Discord profile while the game runs.
    discordPresence: input.discordPresence !== false,
    // The launcher's own look: dark dialogs instead of light ones, off unless chosen.
    darkMode: Boolean(input.darkMode),
    // Keys the player changed in Settings → Controls; the rest stay the game's defaults.
    keyBindings: bindings.normalize(input.keyBindings),
    // Controller buttons the player changed in Settings → Controls.
    padBindings: bindings.normalizePads(input.padBindings),
    // How far the soft L / R bindings press the trigger, in percent (the game caps it below the click).
    softTrigger: numberSetting(input.softTrigger, 40, 5, 95),
    // Controller rumble in percent of the slider: 0 turns it off and 50, the default, is the console's rumble.
    // The game's own strength is twice it (rumbleGameStrength): above 100 it runs the motor more often.
    rumbleStrength: numberSetting(input.rumbleStrength, 50, 0, 100),
    updateChannel: normalizeChannel(input.updateChannel)
  };
  // The graphics preset chosen (src/presets.js), while the picture settings still match it; else Custom.
  settings.graphicsPreset = presets.reconcile({ ...settings, graphicsPreset: input.graphicsPreset });
  return settings;
}

function cutscenePackDirectory(root) { return path.join(root, 'mods', 'hd-cutscenes'); }

function cutscenePackRequirements(root) {
  try {
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'media', 'cutscene-release.json'), 'utf8'));
    if (catalog.schema !== 1 || catalog.movies.length !== 21) return null;
    let downloadBytes = 0, installedBytes = 0, largestPatch = 0;
    for (const movie of catalog.movies) {
      if (![movie.patch_bytes, movie.target_bytes].every(size => Number.isSafeInteger(size) && size > 0)) return null;
      downloadBytes += movie.patch_bytes;
      installedBytes += movie.target_bytes;
      largestPatch = Math.max(largestPatch, movie.patch_bytes);
    }
    return { downloadBytes, freeBytes: installedBytes + largestPatch + 964 * 1024 * 1024 };
  } catch (_) { return null; }
}

function cutscenePackInstalled(root) {
  const folder = cutscenePackDirectory(root);
  try {
    const release = fs.readFileSync(path.join(root, 'tools', 'media', 'cutscene-release.json'), 'utf8');
    const installed = fs.readFileSync(path.join(folder, 'installed.json'), 'utf8');
    const expected = JSON.parse(release), actual = JSON.parse(installed);
    if (expected.schema !== 1 || expected.movies.length !== 21 ||
        JSON.stringify(actual) !== JSON.stringify(expected) ||
        fs.readFileSync(path.join(folder, 'sms-hd-cutscenes-v1.complete'), 'utf8').trim() !== expected.release) return false;
    return expected.movies.every(movie => {
      const stat = fs.statSync(path.join(folder, 'files', movie.disc_path));
      return stat.isFile() && stat.size === movie.target_bytes;
    });
  } catch (_) { return false; }
}

// HD textures the UHD pack lacks, from the port's own release
// (chasem-dev/sms-hd-texture-extras). The port pins that release in
// tools/mods/texture-extras.json and records the one it installed in the
// install's .release file; a new pin means downloading only the extras again.
function textureExtrasDirectory(root) { return path.join(texturePackDirectory(root), 'sms-hd-texture-extras'); }

function textureExtrasSupported(root) {
  return fs.existsSync(path.join(root, 'tools', 'mods', 'texture-extras.json'));
}

function textureExtrasInstalled(root) {
  try {
    const pinned = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'mods', 'texture-extras.json'), 'utf8'));
    const installed = JSON.parse(fs.readFileSync(path.join(textureExtrasDirectory(root), '.release'), 'utf8'));
    return typeof pinned.md5 === 'string' && /^[0-9a-f]{32}$/.test(pinned.md5) && installed.md5 === pinned.md5;
  } catch (_) { return false; }
}

// Extras to download for these settings: HD textures on, a port that knows
// them, and not the pinned release installed.
function textureExtrasWanted(root, settings) {
  return Boolean(settings.textures) && textureExtrasSupported(root) && !textureExtrasInstalled(root);
}

// Languages other than the disc's English come from language packs (the
// European release's four and community translations, published with the
// texture extras). The launcher's own catalog, language-packs.json, says
// which packs exist and which release of each to install, so a new language
// needs a new release and a launcher update, not a game update. Installed
// packs record their release in mods/languages/<code>/.release.
const LANGUAGE_PACKS = require('./language-packs.json').languages;
const LANGUAGES = ['en', ...Object.keys(LANGUAGE_PACKS)];
function languagePackDirectory(root, code) { return path.join(root, 'mods', 'languages', code); }

// The game's own list (tools/mods/language-packs.json): present when it plays
// language packs at all; "any_language" when it plays any installed pack,
// not only the ones it lists.
function gameLanguagePacks(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'tools', 'mods', 'language-packs.json'), 'utf8')); }
  catch (_) { return null; }
}

function languagePacksSupported(root) { return Boolean(gameLanguagePacks(root)); }

// Whether the game in `root` can play `code`'s pack.
function languageAvailable(root, code) {
  if (code === 'en') return true;
  const game = gameLanguagePacks(root);
  return Boolean(LANGUAGE_PACKS[code] && game && (game.any_language || game.languages?.[code]));
}

function languagePackInstalled(root, code) {
  try {
    const pinned = LANGUAGE_PACKS[code];
    const installed = JSON.parse(fs.readFileSync(path.join(languagePackDirectory(root, code), '.release'), 'utf8'));
    return typeof pinned.md5 === 'string' && /^[0-9a-f]{32}$/.test(pinned.md5) && installed.md5 === pinned.md5;
  } catch (_) { return false; }
}

// The languages for the Settings list: code, name in its own language, and
// whether the game set up in `root` plays it.
function languageChoices(root) {
  return LANGUAGES.map(code => code === 'en' ? { code, name: 'English', available: true }
    : { code, name: LANGUAGE_PACKS[code].name, english: LANGUAGE_PACKS[code].english,
      community: Boolean(LANGUAGE_PACKS[code].community), available: !root || languageAvailable(root, code) });
}

// The language the game plays in. Eclipse has no language packs and its own
// text is English, so it always plays in English; the chosen language is kept
// for Super Mario Sunshine.
function gameLanguage(settings) {
  return !settings.eclipse && LANGUAGES.includes(settings.language) ? settings.language : 'en';
}

// The pack to download for these settings: a language other than English
// that the game plays, and not the catalog's release installed.
function languagePackWanted(root, settings) {
  const code = gameLanguage(settings);
  return code !== 'en' && languageAvailable(root, code) && !languagePackInstalled(root, code);
}

function cutscenePackSupported(root) {
  return ['install_cutscenes.py', 'cutscene-release.json'].some(file =>
    fs.existsSync(path.join(root, 'tools', 'media', file)));
}

// Settings from preferences.json. Before HD cutscenes had their own setting, HD
// textures brought them: players who already have the movie pack keep it.
function savedSettings(saved, repo) {
  if (!saved) return { textures: true };
  if ('cutscenes' in saved) return saved;
  return { ...saved, cutscenes: Boolean(saved.textures && repo && cutscenePackInstalled(repo)) };
}

// Eclipse plays its own movies, so HD cutscenes apply to Sunshine only. The
// game also only plays them with HD textures on (platform/thp/hd_movie_pack.cpp
// takes SMS_TEXTURE_PACKS=0 to mean no HD movies either).
function wantsCutscenes(settings) { return Boolean(settings.cutscenes && settings.textures && !settings.eclipse); }

// Every HD download the settings ask for is in place. Older playable
// installations (without the movie pack's files) keep playing until updated.
function hdVisualsInstalled(root, settings) {
  return (!settings.textures || texturePackInstalled(root)) &&
    (!wantsCutscenes(settings) || !cutscenePackSupported(root) || cutscenePackInstalled(root));
}

function texturePackDirectory(root) { return path.join(root, 'mods', 'textures'); }

function texturePackInstalled(root) {
  const pending = [texturePackDirectory(root)];
  while (pending.length) {
    let entries;
    const directory = pending.pop();
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      if (entry.isFile() && /^tex1_.*\.(?:dds|png)$/i.test(entry.name)) return true;
      if (entry.isDirectory()) pending.push(path.join(directory, entry.name));
    }
  }
  return false;
}

function buildEnvironment(settings, disc, root) {
  if (!root) throw new Error('The port folder is required to configure texture packs.');
  const env = {
    ...process.env,
    SMS_ARCH: settings.arch,
    SMS_ECLIPSE: settings.eclipse ? '1' : '0',
    SMS_DISC_IMAGE: disc,
    // The launcher runs sms with the disc, so skip build.sh's 1.1 GiB sms-standalone copy.
    SMS_STANDALONE: '0',
    SMS_WIDESCREEN: settings.widescreen,
    SMS_WIDESCREEN_HUD: settings.hudEdges ? 'edges' : 'centre',
    SMS_FRAME_RATE: String(normalizeSettings(settings).frameRate),
    SMS_FULLSCREEN: settings.fullscreen ? (settings.fullscreenMode === 'exclusive' ? 'exclusive' : '1') : '0',
    SMS_VSYNC: settings.vsync === 'adaptive' ? 'adaptive' : settings.vsync === 'on' ? '1' : '0',
    SMS_SKIP_MOVIES: settings.skipMovies ? '1' : '0',
    SMS_SKIP_INTRO: settings.skipIntro ? '1' : '0',
    SMS_LANGUAGE: root && !languageAvailable(root, gameLanguage(settings)) ? 'en' : gameLanguage(settings),
    SMS_SOFT_TRIGGER: String(settings.softTrigger ?? 40),
    SMS_RUMBLE: settings.rumbleStrength === 0 ? '0' : '1',
    SMS_RUMBLE_STRENGTH: String(rumbleGameStrength(settings.rumbleStrength)),
    SMS_HEAT_HAZE: settings.heatHaze === false ? '0' : '1',
    SMS_PAUSE_TRACKER: settings.pauseTracker === false ? '0' : '1',
    SMS_BUTTON_PROMPTS: prompts.normalizeStyle(settings.buttonPrompts),
    SMS_BUTTON_PROMPT_PAD: prompts.normalizePad(settings.promptPad),
    SMS_HDR: settings.hdr ? '1' : '0',
    ...(settings.hdr ? {
      SMS_HDR_PAPER_WHITE: settings.hdrCalibration === false ? String(settings.hdrPaperWhite ?? 200) : 'auto',
      SMS_HDR_PEAK: settings.hdrCalibration === false ? String(settings.hdrPeak ?? 1000) : 'auto',
      SMS_HDR_CONTRAST: String(settings.hdrContrast ?? 100),
      SMS_HDR_SATURATION: String(settings.hdrSaturation ?? 100),
      SMS_HDR_HIGHLIGHTS: String(settings.hdrHighlights ?? 40)
    } : {}),
    SMS_OVERLAY: settings.overlay ? '1' : '0',
    SMS_CAMERA_INVERT_X: settings.invertCameraX ? '1' : '0',
    SMS_CAMERA_INVERT_Y: settings.invertCameraY ? '1' : '0',
    SMS_FREE_CAMERA: settings.freeCamera ? '1' : '0',
    SMS_CLOSE_CAMERA_CSTICK: settings.cstickAim ? '1' : '0',
    SMS_CAMERA_SPEED: String(settings.cameraSpeed ?? 100),
    SMS_MOUSE_CAMERA: settings.mouseCamera ? '1' : '0',
    SMS_MOUSE_SENSITIVITY: String(settings.mouseSensitivity ?? 100),
    SMS_MSAA: String(settings.msaa ?? 0),
    SMS_FXAA: settings.fxaa ? '1' : '0',
    SMS_ANISO: String(settings.anisotropic ?? 0),
    SMS_SHARPEN: String(settings.sharpen ?? 0),
    SMS_GAMMA: ((settings.brightness ?? 100) / 100).toFixed(2),
    SMS_ASPECT: settings.aspect || 'keep',
    SMS_PRESENT_FILTER: settings.presentFilter || 'bilinear',
    // game versions without the Vulkan backend ignore it and draw with OpenGL
    SMS_GX_BACKEND: settings.renderer === 'vulkan' ? 'vulkan' : 'opengl',
    // the upscaling quality, for FSR 1 or NIS (NVIDIA Image Scaling)
    ...(['fsr', 'nis'].includes(settings.presentFilter) ? { SMS_FSR_MODE: settings.fsrMode || 'quality' } : {}),
    SMS_VOLUME: String(settings.volume ?? 100),
    SMS_GX_SCALE: String(settings.resolution),
    SMS_TEXTURE_PACKS: settings.textures ? texturePackDirectory(root) : '0',
    SMS_TEXTURE_PACK_PRELOAD: { all: 'all', play: '0' }[settings.textureLoading] || '1',
    SMS_GX_SHADER_WARMUP: settings.shaderWarmup === false ? '0' : '1',
    SMS_MOD: 'none',
    SMS_HD_CUTSCENES: wantsCutscenes(settings) ? cutscenePackDirectory(root) : '0'
  };
  if (settings.fullscreen && settings.fullscreenMode === 'exclusive' && /^\d+x\d+$/.test(settings.exclusiveResolution || ''))
    env.SMS_FULLSCREEN_MODE = settings.exclusiveResolution;
  if (settings.display === 'primary') env.SMS_DISPLAY = '0';
  return env;
}

function gameDisc(root, rom, eclipse) {
  if (!eclipse) return validateRom(rom);
  const modDisc = path.join(root, ECLIPSE_ISO);
  if (!fs.existsSync(modDisc)) throw new Error('Set up Eclipse using your own game disc file first.');
  return modDisc;
}

function binaryPath(root, settings, platform = process.platform) {
  const info = platformInfo(platform);
  const suffix = settings.eclipse ? '-eclipse' : '';
  return path.join(root, 'build', `${info.id}-${settings.arch}${suffix}`, platform === 'win32' ? 'sms.exe' : 'sms');
}

// MinGW's compiler can't open a path of 260 characters or more. The deepest
// file a Windows build writes is an object's dependency file, in a folder
// CMake shortens to a 32-character hash: 109 characters below the game
// folder for Sunshine (build/windows-64/CMakeFiles/sms_game.dir/<hash>/
// MarDirectorCreateObjects.cpp.obj.d), 129 for Eclipse's mods
// (…-eclipse/eclipse-build/CMakeFiles/eclipse_objs.dir/./<hash>/character_select.cpp.obj.d).
function windowsPathLimit(settings) { return settings.eclipse ? 130 : 150; }

// The compiler's own headers count too. GCC opens them through its install
// prefix as is (mingw64/bin/../lib/gcc/x86_64-w64-mingw32/16.2.0/../../../../
// include/c++/16.2.0/…) and only its errors show the shortened path, so a
// header that is there fails with "No such file or directory". The deepest
// one a build includes, …/x86_64-w64-mingw32/bits/messages_members.h, is 123
// characters below the MSYS2 folder that way; c++config.h, which every C++
// file includes, 116.
const WINDOWS_MSYS2_PATH_LIMIT = 136;
const WINDOWS_MAX_PATH = 259;

// When a Windows build would fail because a path is too long: the folder the
// player can move (the portable folder) or choose (the one holding the setup
// files), how long its path is and may be, and what to do; otherwise null.
// The limit is the tightest of the game folder's and, when they're inside
// that folder, the MSYS2 build tools'.
function longPathProblem(root, settings, { platform = process.platform, portable = false,
  folder = path.win32.dirname(root), msys = '' } = {}) {
  if (platform !== 'win32' || !root) return null;
  const inside = file => file.length > folder.length && file.startsWith(folder) && /[\\/]/.test(file[folder.length]);
  const limit = Math.min(...[[root, windowsPathLimit(settings)], [msys, WINDOWS_MSYS2_PATH_LIMIT]]
    .filter(([file]) => file && inside(file)).map(([file, most]) => most - (file.length - folder.length)));
  if (folder.length <= limit) return null;
  const name = portable ? 'The SMS-Launcher-Portable folder' : 'The folder holding the setup files';
  const fix = portable
    ? 'Move the launcher and its SMS-Launcher-Portable folder together to a short folder such as C:\\Games, and open it from there.'
    : 'Choose a shorter folder for Setup files in Settings, such as C:\\Games.';
  return { folder, length: folder.length, limit, deepest: WINDOWS_MAX_PATH - limit, portable,
    message: `${name}'s path is ${folder.length} characters long, more than the ${limit} Windows can build ` +
      `${settings.eclipse ? 'Super Mario Eclipse' : 'the game'} in, so the build would fail: Windows' compiler can't open paths of ` +
      `260 characters or more, and the build reaches ${WINDOWS_MAX_PATH - limit} characters deeper than this folder. ${fix}` };
}

function playableInstall(saved, platform = process.platform) {
  if (!saved.repo || !saved.settings) return null;
  const settings = normalizeSettings(saved.settings, platform);
  if (!fs.existsSync(binaryPath(saved.repo, settings, platform))) return null;
  return { repo: saved.repo, settings, rom: saved.rom, saveDirectory: saved.saveDirectory || null };
}

// The MSYS shell's environment: the MinGW tools ahead of the Windows path.
function msysEnvironment(msys, environment) {
  const bins = environment.SMS_WINDOWS_32_CROSS ? []
    : [path.join(msys, environment.SMS_ARCH === '32' ? 'mingw32' : 'mingw64', 'bin'), path.join(msys, 'usr', 'bin')];
  return { ...prependWindowsPath(environment, bins),
    MSYSTEM: environment.SMS_ARCH === '32' && !environment.SMS_WINDOWS_32_CROSS ? 'MINGW32' : 'MINGW64', CHERE_INVOKING: '1' };
}

function commandFor(root, action, args = [], platform = process.platform, environment = process.env) {
  if (platform === 'win32' && action === 'run')
    return gameRunCommand(root, { arch: environment.SMS_ARCH || '64' }, args[0], platform, environment);
  const textureProgress = __dirname.includes('app.asar')
    ? path.join(process.resourcesPath, 'scripts', 'texture-progress.py')
    : path.resolve(__dirname, '..', 'scripts', 'texture-progress.py');
  const installLanguage = path.join(path.dirname(textureProgress), 'install-language.py');
  // a language pack: [code, name, url, md5, size] from the catalog
  const pack = action === 'language' ? LANGUAGE_PACKS[args[0]] : null;
  if (action === 'language' && !pack) throw new Error(`There is no language pack "${args[0]}".`);
  const packArgs = pack ? [args[0], pack.name, pack.url, pack.md5, String(pack.size)] : [];
  if (platform !== 'win32') {
    const file = ['python', 'textures', 'texture-extras', 'language', 'cutscenes'].includes(action) ? 'python3' : path.join(root, `${action}.sh`);
    const commandArgs = action === 'python' ? [textureProgress, path.join(root, 'tools', 'mods', 'get.py'), 'eclipse', '--iso', ...args]
      : action === 'textures' ? [textureProgress, path.join(root, 'tools', 'mods', 'get.py')]
        : action === 'texture-extras' ? [textureProgress, path.join(root, 'tools', 'mods', 'get.py'), 'extras', '--if-outdated']
        : action === 'language' ? [textureProgress, installLanguage, ...packArgs]
        : action === 'cutscenes' ? ['tools/media/install_cutscenes.py', '--iso', ...args] : args;
    return { command: file, args: commandArgs, cwd: root, env: environment };
  }
  const msys = environment.MSYS2_ROOT || 'C:\\msys64';
  const bash = path.join(msys, 'usr', 'bin', 'bash.exe');
  if (!fs.existsSync(bash)) throw new Error(`The Windows build tools are missing. Install it at ${msys} or set MSYS2_ROOT.`);
  const script = action === 'python'
    ? 'cd "$(cygpath -u "$1")" && python "$(cygpath -u "$2")" tools/mods/get.py eclipse --iso "$(cygpath -u "$3")"'
    : action === 'cutscenes'
      ? 'cd "$(cygpath -u "$1")" && python tools/media/install_cutscenes.py --iso "$(cygpath -u "$2")"'
    : action === 'textures'
      ? 'cd "$(cygpath -u "$1")" && python "$(cygpath -u "$2")" tools/mods/get.py'
    : action === 'texture-extras'
      ? 'cd "$(cygpath -u "$1")" && python "$(cygpath -u "$2")" tools/mods/get.py extras --if-outdated'
    : action === 'language'
      ? 'cd "$(cygpath -u "$1")" && python "$(cygpath -u "$2")" "$(cygpath -u "$3")" "${@:4}"'
    : action === 'clean'
      ? 'cd "$(cygpath -u "$1")" && ./clean.sh "${@:2}"'
      : `cd "$(cygpath -u "$1")" && ./${action}.sh "$(cygpath -u "$2")"`;
  return {
    command: bash,
    args: ['-c', script, 'sms-launcher', root, ...(action === 'textures' || action === 'texture-extras' ? [textureProgress]
      : action === 'language' ? [textureProgress, installLanguage, ...packArgs]
      : action === 'python' ? [textureProgress, args[0]] : args)], cwd: root,
    env: msysEnvironment(msys, environment)
  };
}

function eclipseBuildCommand(root, settings, platform = process.platform, environment = process.env) {
  const script = __dirname.includes('app.asar')
    ? path.join(process.resourcesPath, 'scripts', 'build-eclipse.sh')
    : path.resolve(__dirname, '..', 'scripts', 'build-eclipse.sh');
  if (platform !== 'win32') return { command: script, args: [root, settings.arch], cwd: root, env: environment };
  const msys = environment.MSYS2_ROOT || 'C:\\msys64';
  const bash = path.join(msys, 'usr', 'bin', 'bash.exe');
  if (!fs.existsSync(bash)) throw new Error(`The Windows build tools are missing. Install it at ${msys} or set MSYS2_ROOT.`);
  return {
    command: bash,
    args: ['-c', 'exec "$(cygpath -u "$1")" "$(cygpath -u "$2")" "$3"', 'sms-launcher', script, root, settings.arch],
    cwd: root,
    env: msysEnvironment(msys, environment)
  };
}

// Spawn the Windows executable directly: MSYS bash translates many native
// exception statuses to 127, which hides the cause of a game crash.
function gameRunCommand(root, settings, disc, platform = process.platform, environment = process.env) {
  const binary = binaryPath(root, settings, platform);
  if (platform === 'linux' && settings.arch === '32' && environment.SMS_LINUX32_ROOT)
    return { command: path.join(environment.SMS_LINUX32_ROOT, 'i686-buildroot-linux-gnu', 'sysroot', 'lib', 'ld-linux.so.2'),
      args: ['--library-path', environment.SMS_LINUX32_LIBRARY_PATH, binary, disc], cwd: root,
      env: { ...environment, SMS_GAME_EXECUTABLE: binary } };
  if (platform !== 'win32') return { command: binary, args: [disc], cwd: root, env: environment };
  return {
    command: binary, args: [disc], cwd: root,
    env: prependWindowsPath(environment, gameRuntimeFolders(settings, environment))
  };
}

// Where the Windows game's DLLs come from: the runtime of the compiler that built it.
function gameRuntimeFolders(settings, environment = process.env) {
  const msys = environment.MSYS2_ROOT || 'C:\\msys64';
  const runtime = settings.arch === '32' ? 'mingw32' : 'mingw64';
  return settings.arch === '32' && environment.SMS_WINDOWS_32_CROSS
    ? [path.join(msys, 'opt', 'i686-w64-mingw32', 'bin'), path.join(msys, runtime, 'bin')]
    : [path.join(msys, runtime, 'bin')];
}

function eclipseRunCommand(...args) { return gameRunCommand(...args); }

module.exports = { PORT_URL, ECLIPSE_ISO, platformInfo, isPort, validateRom, normalizeSettings, savedSettings,
  texturePackDirectory, texturePackInstalled, textureExtrasDirectory, textureExtrasSupported, textureExtrasInstalled, textureExtrasWanted,
  LANGUAGES, LANGUAGE_PACKS, gameLanguage, languagePackDirectory, languagePacksSupported, languageAvailable, languageChoices,
  languagePackInstalled, languagePackWanted,
  cutscenePackDirectory, cutscenePackInstalled, cutscenePackSupported, cutscenePackRequirements, wantsCutscenes, hdVisualsInstalled, buildEnvironment, gameDisc, binaryPath,
  commandFor, eclipseBuildCommand, eclipseRunCommand, gameRuntimeFolders, playableInstall, windowsPathLimit, longPathProblem };
