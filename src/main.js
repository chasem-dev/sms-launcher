'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, net, screen, Notification, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const port = require('./port');
const saves = require('./saves');
const gciSave = require('./gci-save');
const buildTools = require('./build-tools');
const compilerCache = require('./compiler-cache');
const windowsDlls = require('./windows-dlls');
const game = require('./game-version');
const updateChannel = require('./update-channel');
const steam = require('./steam');
const gcAdapter = require('./gc-adapter');
const appImageUpdate = require('./appimage-update');
const bindings = require('./bindings');
const savestates = require('./savestates');
const prompts = require('./prompts');
const gameSettings = require('./game-settings');
const gameSource = require('./game-source');
const portable = require('./portable');
const telemetry = require('./telemetry');
const discord = require('./discord');
const presence = require('./presence');
const achievements = require('./achievements');
const changelog = require('./changelog');
const multiplayer = require('./multiplayer');
const nat = require('./nat');
const rooms = require('./rooms');
const nativeMods = require('./native-mods');
const eclipseDisc = require('./eclipse-disc');
const { cleanOutputLine, createActivityReader } = require('./progress');
const { createActivityLog } = require('./activity-log');
const { observeProcess, exitDescription, failureMessage } = require('./process-output');
const { createSessionLog } = require('./session-log');
const displayScale = require('./display-scale');
const marioModel = require('./mario-model');
const marioColors = require('./mario-colors');
const marioPack = require('./mario-pack');
const { relaunchOptions } = require('./relaunch');
const { retrying, httpError } = require('./retry');
const vulkanStatus = require('./vulkan-status');

const DISCORD_INVITE = 'https://discord.gg/NvUXmm8dB9';
// Microsoft's free Windows HDR Calibration app (Microsoft Store product 9N7F2SM5D1LR).
const HDR_CALIBRATION_APP = 'https://apps.microsoft.com/detail/9n7f2sm5d1lr';
const ECLIPSE_GITHUB = 'https://github.com/JoshuaMKW/Super-Mario-Eclipse';

let window;
let config;
let active = null;
let preparingTools = false;
let operation = null;
// When the player last stopped a task (Stop), so a stopped build isn't tried again.
let stoppedAt = 0;
const wasStopped = since => stoppedAt >= since;
let appUpdate = { state: 'idle', message: '' };
let updater = null;
// Before anything reads userData: the single-instance lock is keyed on it too,
// so each portable folder runs independently of an installed launcher.
const portableRoot = portable.root();
if (portableRoot) {
  fs.mkdirSync(portableRoot, { recursive: true });
  app.setPath('userData', portableRoot);
  app.setPath('sessionData', path.join(portableRoot, 'Electron'));
}
// Customize Mario draws with WebGL. Where the GPU can't be used (a blocklisted
// driver, or Chromium turning hardware acceleration off after its GPU process
// keeps crashing, as on a Windows 7 PC with an old Intel driver), WebGL falls
// back to SwiftShader on the CPU instead of being missing. Chromium only gates
// that as unsafe for untrusted web pages; the launcher shows only its own files.
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
const activityLog = createActivityLog();
const partialOutput = new Map();
const sessionLog = createSessionLog(() => app.getPath('userData'), error =>
  logOutput(`Could not save the session log: ${error.message}`, 'launcher'));
let reporter = null;
let online = null;
let discordPresence = null;
// The running game's handler for its `[presence]` lines (src/presence.js).
let onPresence = null;
// The running game's handler for its `[achievement]` lines (src/achievements.js).
let onAchievement = null;
// The running game's handler for every other line it prints (noteRenderer).
let onGameLine = null;
// Discord started this launcher to join a friend's game (their invite, accepted while it was closed).
let launchedByDiscord = process.argv.some(arg => discord.isLaunchUrl(arg));
// `--play` (for a Steam shortcut's launch options) starts the game without the
// launcher's window and quits when the game closes.
const playOnStart = process.argv.includes('--play');
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', (_event, argv) => {
  if (argv.some(arg => discord.isLaunchUrl(arg))) startedByDiscord();
  showWindow();
});
// macOS hands the discord-<id>:// link Discord opened to the running launcher (or the one starting).
app.on('open-url', (event, url) => {
  if (!discord.isLaunchUrl(url)) return;
  event.preventDefault();
  startedByDiscord();
  showWindow();
});

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function broadcast(channel, data) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, data);
}

// The room code friends join with, while hosting (shown under Play, on Multiplayer and in the status bar).
let hostedRoom = null;

function activityState() {
  const task = active || operation;
  return task ? { label: task.label, detail: task.detail, percent: task.percent,
    startedAt: task.startedAt, canStop: Boolean(active?.child), room: hostedRoom } : null;
}

function log(message) {
  const lines = String(message).replace(/\r/g, '').split('\n');
  for (const line of lines) {
    if (!line) continue;
    logOutput(cleanOutputLine(line), 'launcher');
    sessionLog.write(cleanOutputLine(line), 'launcher');
  }
}

function logOutput(text, stream, previous) {
  const entry = activityLog.write(text, stream, previous);
  if (stream !== 'launcher') partialOutput.set(entry.id, entry);
  broadcast('log', entry);
  return entry;
}

function completeOutput(text, stream, entry) {
  sessionLog.write(text, stream);
  if (entry) partialOutput.delete(entry.id);
}

function flushPartialOutput() {
  for (const entry of partialOutput.values()) sessionLog.write(entry.text, entry.stream);
  partialOutput.clear();
}

// Monitoring preserves Node's normal fatal-error behavior while retaining the
// diagnostic on disk, even when the launcher cannot keep its window alive.
process.on('uncaughtExceptionMonitor', error => {
  log(`Uncaught launcher error: ${error.stack || error.message}`);
  flushPartialOutput();
});
process.on('warning', warning => log(`Launcher warning: ${warning.stack || warning.message}`));
app.on('render-process-gone', (_event, _contents, details) => {
  log(`Launcher renderer ${details.reason}: ${exitDescription('Renderer', details.exitCode, null)}`);
});
app.on('child-process-gone', (_event, details) => {
  log(`Launcher ${details.type} process ${details.reason}: ${exitDescription(details.name || details.type, details.exitCode, null)}`);
});

// A game source chosen under Settings, with the commits it resolved to.
function savedGameSource(saved) {
  try {
    const override = gameSource.normalizeOverride(saved?.override);
    const resolved = saved?.resolved;
    if (!override || !/^[a-f0-9]{40}$/.test(resolved?.commit) || !/^[a-f0-9]{40}$/.test(resolved?.decomp)) return null;
    return { override, resolved: { ...resolved, custom: true, override } };
  } catch (_) { return null; }
}

function currentSource() { return config.gameSource?.resolved || game.release; }

async function chooseGameSource(input) {
  await ensureBuildTools();
  const override = gameSource.normalizeOverride(input);
  if (!override) {
    config.gameSource = null;
    saveConfig();
    log(`Game source: this launcher release (${game.release.version}). Update game to switch back.`);
    return state();
  }
  const resolved = await gameSource.resolve(override, { capture, env: toolEnv() });
  config.gameSource = { override, resolved };
  saveConfig();
  log(`Game source: ${resolved.repository} at ${resolved.commit.slice(0, 12)}, decomp ${resolved.decompRepository || 'pinned by it'} at ${resolved.decomp.slice(0, 12)}. Update game to build it.`);
  return state();
}

// Update game follows a chosen branch to its newest commit.
async function refreshGameSource() {
  if (!config.gameSource) return;
  try {
    const resolved = await gameSource.resolve(config.gameSource.override, { capture, env: toolEnv() });
    if (resolved.commit !== config.gameSource.resolved.commit || resolved.decomp !== config.gameSource.resolved.decomp) {
      config.gameSource = { ...config.gameSource, resolved };
      saveConfig();
      log(`Game source moved to ${resolved.version}.`);
    }
  } catch (error) { log(`Could not check the chosen game source for changes: ${error.message}`); }
}

function configFile() { return path.join(app.getPath('userData'), 'preferences.json'); }

function defaultRepo() {
  const sibling = path.resolve(__dirname, '..', '..', 'sms-port');
  return !app.isPackaged && port.isPort(sibling)
    ? sibling : path.join(app.getPath('userData'), 'sms-pc-port');
}

function saveConfig() {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(portable.storedPaths(config, portableRoot), null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function savedMultiplayer(saved) {
  const value = saved && typeof saved === 'object' ? saved : {};
  const portOr = text => { try { return multiplayer.parsePort(text); } catch (_) { return multiplayer.DEFAULT_PORT; } };
  const mostOr = text => { try { return multiplayer.parseMaxPlayers(text); } catch (_) { return multiplayer.DEFAULT_MAX_PLAYERS; } };
  const recent = (Array.isArray(value.recent) ? value.recent : [])
    .filter(item => item && typeof item.address === 'string' && item.address && Number.isInteger(item.port) && item.port > 0 && item.port < 65536)
    .slice(0, multiplayer.RECENT_HOSTS)
    .map(item => ({ address: item.address.slice(0, 255), port: item.port, name: multiplayer.playerName(item.name, '') }));
  return { name: multiplayer.playerName(value.name, ''), address: typeof value.address === 'string' ? value.address.slice(0, 255) : '',
    hostPort: portOr(value.hostPort), joinPort: portOr(value.joinPort), maxPlayers: mostOr(value.maxPlayers),
    public: value.public === true, collision: value.collision === true, recent };
}

function loadConfig() {
  let saved = {};
  try { saved = portable.resolvedPaths(JSON.parse(fs.readFileSync(configFile(), 'utf8')), portableRoot); } catch (_) { /* first run */ }
  config = {
    repo: typeof saved.repo === 'string' ? saved.repo : defaultRepo(),
    rom: typeof saved.rom === 'string' ? saved.rom : '',
    settings: port.normalizeSettings(port.savedSettings(saved.settings, typeof saved.repo === 'string' ? saved.repo : defaultRepo())),
    installRoot: typeof saved.installRoot === 'string' ? saved.installRoot : null,
    saveDirectory: typeof saved.saveDirectory === 'string' ? saved.saveDirectory : null,
    previousInstall: saved.previousInstall || null,
    completedSetup: Boolean(saved.completedSetup),
    gameSource: savedGameSource(saved.gameSource),
    // Random, made on first run, and only ever sent with usage heartbeats.
    installId: telemetry.validInstallId(saved.installId) ? saved.installId : crypto.randomUUID(),
    // The newest launcher version whose changelog the player has been shown.
    changelogSeen: changelog.baseVersion(saved.changelogSeen),
    // Which wording of Beta's notes a Beta build last showed.
    changelogBetaSeen: /^[a-f0-9]{16}$/.test(saved.changelogBetaSeen) ? saved.changelogBetaSeen : null,
    // Whether Play has offered Add to Steam on SteamOS yet (it does once).
    steamOffered: Boolean(saved.steamOffered),
    // Whether the launcher has offered to fix a Steam shortcut without --no-sandbox.
    steamFixOffered: Boolean(saved.steamFixOffered),
    // Whether the launcher has moved a Mac playing through Rosetta to the Apple Silicon build, once
    // for the game and once more for Super Mario Eclipse, whose game versions gained it later.
    appleSiliconSwitched: Boolean(saved.appleSiliconSwitched),
    eclipseAppleSiliconSwitched: Boolean(saved.eclipseAppleSiliconSwitched),
    // Whether the player has opened the Achievements tab, which is highlighted until then.
    achievementsSeen: Boolean(saved.achievementsSeen),
    // Why Vulkan couldn't start the last time the game was played with it (noteRenderer), or null.
    vulkanFailed: typeof saved.vulkanFailed === 'string' ? saved.vulkanFailed.slice(0, 300) : null,
    // Customize Mario: the colours the player chose and the Shine shirt.
    marioLook: marioColors.normalizeLook(saved.marioLook),
    // The Multiplayer window's fields, as last used.
    multiplayer: savedMultiplayer(saved.multiplayer)
  };
  if (config.installId !== saved.installId) {
    try { saveConfig(); } catch (error) { log(`Could not save preferences: ${error.message}`); }
  }
  for (const root of [config.repo, config.previousInstall?.repo].filter(Boolean))
    for (const arch of port.platformInfo().arches)
      for (const eclipse of [false, true]) {
        try { if (game.recoverBuild(root, { arch, eclipse })) log('Recovered your previous game after interrupted setup.'); }
        catch (error) { log(`Game recovery: ${error.message}`); }
      }
  config.completedSetup ||= fs.existsSync(port.binaryPath(config.repo, config.settings));
  if (portableRoot) settleMovedPortableFolder();
  keepGameSettings();
}

// A portable folder copied to another drive or computer plays from where it is
// now: its updates' links follow it, and when the chosen disc stayed behind, a
// disc kept in the folder or beside the .exe is used.
function settleMovedPortableFolder() {
  for (const root of [config.repo, config.previousInstall?.repo].filter(Boolean)) {
    try {
      const relinked = game.relinkUserFolders(root, file => portable.relocated(file, portableRoot));
      if (relinked.length) log(`Reconnected ${relinked.join(', ')} after the portable folder moved.`);
    } catch (error) { log(`Could not reconnect the game's files after the portable folder moved: ${error.message}`); }
  }
  try { port.validateRom(config.rom); return; } catch (_) { /* missing or never chosen */ }
  const disc = portable.findDisc(portableRoot, port.validateRom);
  if (!disc) return;
  config.rom = disc;
  log(`Using the game disc at ${disc}.`);
  try { saveConfig(); } catch (error) { log(`Could not save preferences: ${error.message}`); }
}

async function exclusive(label, callback, newLog = false) {
  if (operation || active || preparingTools) throw new Error('Wait for the current task to finish, or stop it first.');
  if (newLog) {
    activityLog.reset();
    partialOutput.clear();
    broadcast('log-reset', activityLog.resetSequence());
    sessionLog.reset();
  }
  operation = { label, detail: 'Starting…', percent: null, startedAt: Date.now() };
  broadcast('activity', operation);
  try {
    if (removingOldVersions) {
      removingOldVersions.stop = true;
      await removingOldVersions.done;
    }
    return await callback();
  }
  catch (caught) {
    // A full drive, or Windows' Mandatory ASLR breaking MSYS2's fork(), says
    // what to do about it instead of the raw ENOSPC or Git's fork error.
    const error = hintedError(caught) || caught;
    if (!error.activityLogged) {
      log(`✕ ${label}: ${error.message}`);
      error.activityLogged = true;
    }
    throw error;
  }
  finally { operation = null; broadcast('activity', null); }
}

// Add to Steam (steam.js). Steam reads non-Steam games only when it starts and
// writes them back when it closes, so an open Steam closes first (steam://exit).
// On Windows it opens again afterwards; on Linux the player opens it, since a
// Steam started from the AppImage runs in its environment (a Steam Deck player
// saw it open as Game Mode inside Desktop Mode).
function steamRunning() {
  const [command, args] = process.platform === 'win32' ? ['tasklist', ['/FI', 'IMAGENAME eq steam.exe', '/NH']] : ['pgrep', ['-x', 'steam']];
  return new Promise(resolve => execFile(command, args, { windowsHide: true },
    (error, stdout) => resolve(process.platform === 'win32' ? /steam\.exe/i.test(stdout || '') : !error)));
}

// Closed once it has stayed closed for several checks in a row: a Steam that
// starts again straight after exiting (as SteamOS can) would write its own copy
// of the list over the launcher's when it next closes.
async function waitForSteamToClose() {
  const deadline = Date.now() + 60000;
  for (let closed = 0; closed < 5;) {
    if (Date.now() > deadline) throw new Error("Steam didn't close. Close Steam yourself, then choose Add to Steam again.");
    closed = (await steamRunning()) ? 0 : closed + 1;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

function windowsSteamPath() {
  return new Promise(resolve => execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true },
    (error, stdout) => resolve(error ? null : steam.registrySteamPath(stdout))));
}

// Steam artwork comes straight from SteamGridDB into memory: no-store keeps it
// out of the launcher's web cache, so the only copy is the one in Steam's folder.
async function downloadImage(url) {
  return retrying(async () => {
    const response = await net.fetch(url, { cache: 'no-store' });
    if (!response.ok) throw httpError(`${url}: HTTP ${response.status}`, response.status);
    return Buffer.from(await response.arrayBuffer());
  });
}

// The file Steam starts: the installed launcher, or the AppImage on Linux.
// Not in development, and not on macOS.
function launcherExe() {
  if (!app.isPackaged || !['win32', 'linux'].includes(process.platform)) return null;
  return (process.platform === 'linux' ? process.env.APPIMAGE : process.execPath) || null;
}

const startedFromSteam = () => Boolean(process.env.SteamGameId || process.env.SteamAppId);

async function locateSteam() {
  const registryPath = process.platform === 'win32' ? await windowsSteamPath() : null;
  const root = steam.findSteam(steam.steamRoots({ registryPath }));
  return root ? { root, accounts: steam.steamAccounts(root) } : null;
}

// SteamOS, as on a Steam Deck (LCD or OLED alike): Play offers Add to Steam there once.
function onSteamOS() {
  if (process.platform !== 'linux') return false;
  const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
  return steam.isSteamOS({ osRelease: read('/etc/os-release'), vendor: read('/sys/devices/virtual/dmi/id/sys_vendor') });
}

// The home screen's Steam banner: Add to Steam while Steam is installed and the
// launcher is not in its library yet, and a tick once it is. `reason` says why,
// and goes in the log whenever it changes, so a player's saved log shows it.
// The AppImage needs `--no-sandbox` from Steam: without it, a shortcut opens
// the launcher in Desktop Mode but not in Game Mode. AppImages built with
// scripts/after-pack.js always pass it themselves (SMS_LAUNCHER_NO_SANDBOX), so
// for them a shortcut without it needs no fix; new shortcuts still get it.
const STEAM_LAUNCH_OPTIONS = process.platform === 'linux' ? '--no-sandbox' : '';
const sandboxAlwaysOff = process.env.SMS_LAUNCHER_NO_SANDBOX === '1';
delete process.env.SMS_LAUNCHER_NO_SANDBOX; // not passed on to the game or Steam

async function readSteamStatus() {
  const exe = launcherExe();
  if (!exe) return { available: false, reason: process.platform === 'linux' && app.isPackaged
    ? "Add to Steam isn't offered: the launcher isn't running from its AppImage." : null };
  if (startedFromSteam()) {
    // Steam's shortcut started this launcher, so its options are ours.
    const needsFix = !sandboxAlwaysOff && steam.missingOptions(process.argv.slice(1).join(' '), STEAM_LAUNCH_OPTIONS);
    return { available: false, inSteam: true, needsFix, reason: needsFix
      ? `Steam: the launcher was started from a Steam shortcut without ${STEAM_LAUNCH_OPTIONS}, so it won't open in Game Mode.`
      : 'Steam: the launcher was started from Steam, so it is in your Steam library.' };
  }
  const located = await locateSteam();
  if (!located) return { available: false, reason: "Add to Steam isn't offered: no signed-in Steam was found on this computer." };
  if (!located.accounts.length)
    return { available: false, reason: `Add to Steam isn't offered: nobody has signed in to Steam at ${located.root} yet.` };
  const options = steam.shortcutLaunchOptions({ ...located, exe });
  const inSteam = steam.hasShortcut({ ...located, exe });
  const steamOS = onSteamOS();
  const needsFix = inSteam && !sandboxAlwaysOff && steam.missingOptions(options, STEAM_LAUNCH_OPTIONS);
  return { available: true, inSteam, needsFix, skipLauncher: steam.skipsLauncher(options), steamOS,
    offer: steamOS && !inSteam && !config.steamOffered,
    offerFix: needsFix && !config.steamFixOffered,
    reason: needsFix ? `Steam: the launcher's shortcut in Steam is missing ${STEAM_LAUNCH_OPTIONS}, so it won't open in Game Mode (${located.root}).`
      : inSteam ? `Steam: the launcher is in your Steam library (${located.root}).`
      : `Steam: the launcher isn't in your Steam library yet (${located.root}${steamOS ? ', SteamOS' : ''}), so Add to Steam is offered.` };
}

let steamReasonLogged = null;
async function steamStatus() {
  let status;
  try { status = await readSteamStatus(); }
  catch (error) { status = { available: false, reason: `Add to Steam isn't offered: Steam could not be checked (${error.message}).` }; }
  if (status.reason && status.reason !== steamReasonLogged) log(status.reason);
  steamReasonLogged = status.reason;
  return status;
}

// GameCube adapter in Wii U mode (gc-adapter.js): Settings → Controls shows
// whether one is plugged in and the game can open it, and on Linux installs the
// udev rule that lets it. What it found goes in the log whenever that changes.
function commandOutput(command, args) {
  return new Promise(resolve => execFile(command, args, { windowsHide: true, timeout: 15000 }, (_error, stdout) => resolve(stdout || '')));
}

let gcAdapterLogged = null;
async function gcAdapterStatus() {
  let status = { present: false };
  if (process.platform === 'linux') status = gcAdapter.linuxStatus();
  else if (process.platform === 'win32') {
    status = gcAdapter.windowsStatus(await commandOutput('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', gcAdapter.WINDOWS_QUERY]));
  } else if (process.platform === 'darwin') status = gcAdapter.macStatus(await commandOutput('ioreg', ['-p', 'IOUSB', '-l', '-w0']));
  const line = !status.present ? 'GameCube adapter: none plugged in (Wii U mode).'
    : status.readable ? `GameCube adapter: plugged in, the game can read it${status.via ? ` (${status.via})` : status.driver ? ` (${status.driver} driver)` : ''}.`
    : status.fix === 'udev' ? `GameCube adapter: plugged in, but this user can't open it (${[status.hidraw?.file, status.usb?.file].filter(Boolean).join(', ')}); it needs a udev rule.`
    : status.fix === 'driver' ? `GameCube adapter: plugged in, but Windows has no working driver for it (${status.status || 'no status'}).`
    : 'GameCube adapter: plugged in, but libusb is not installed (brew install libusb).';
  if (line !== gcAdapterLogged && (status.present || gcAdapterLogged)) log(line);
  gcAdapterLogged = line;
  return status;
}

// pkexec asks for the password, then installs the rule and applies it to the
// adapter already plugged in. Without pkexec, or with no password to give (a
// Steam Deck's user has none until one is set with passwd), the player copies
// the terminal command instead.
async function allowGcAdapter() {
  if (process.platform !== 'linux') return { ok: false, status: await gcAdapterStatus() };
  const { command, args } = gcAdapter.allowCommand();
  const error = await new Promise(resolve => execFile(command, args, { timeout: 120000 }, resolve));
  if (error) {
    const reason = error.code === 'ENOENT' ? 'pkexec is not installed'
      : error.code === 126 ? 'the password prompt was closed' : error.code === 127 ? 'the password was not accepted' : error.message.split('\n')[0];
    log(`GameCube adapter: the udev rule was not installed (${reason}).`);
    return { ok: false, reason, status: await gcAdapterStatus() };
  }
  log(`GameCube adapter: installed ${gcAdapter.RULES_FILE}.`);
  await new Promise(resolve => setTimeout(resolve, 1500)); // for udev to apply it
  return { ok: true, status: await gcAdapterStatus() };
}

// Play offers Add to Steam on SteamOS only once, and opening the launcher
// offers to fix a shortcut without --no-sandbox only once, whatever the player chooses.
function markSteamOffered(prompt) {
  config[prompt === 'fix' ? 'steamFixOffered' : 'steamOffered'] = true;
  saveConfig();
}

// `play` (Skip Launcher) adds `--play`, so Steam starts the game without the launcher's window.
async function addToSteam({ play = false } = {}) {
  const exe = launcherExe();
  if (!exe) throw new Error(process.platform === 'linux' ? 'Add to Steam works from the launcher AppImage.' : 'Add to Steam works from the installed launcher on Windows and Linux.');
  if (startedFromSteam()) throw new Error('The launcher was started from Steam, so it is already in your Steam library.');
  const located = await locateSteam();
  if (!located) throw new Error("Steam isn't installed on this computer, or nobody has signed in to it yet.");
  const { root, accounts } = located;
  if (!accounts.length) throw new Error('Sign in to Steam once, then try again.');
  log('Downloading Steam artwork from SteamGridDB…');
  const artwork = await steam.downloadArtwork(downloadImage);
  const wasRunning = await steamRunning();
  const reopen = wasRunning && process.platform === 'win32';
  if (wasRunning) {
    const answer = await dialog.showMessageBox(window, {
      type: 'question', buttons: ['Cancel', 'Close Steam and add'], defaultId: 1, cancelId: 0,
      message: 'Close Steam to add the launcher?',
      detail: `Steam picks up new non-Steam games only when it starts, so it closes for a moment${reopen ? ' and opens again afterwards' : '. Open it again once the launcher says it was added'}.`
    });
    if (answer.response !== 1) return { cancelled: true };
  }
  // Each folder's list is backed up before Steam closes, since Steam writes its
  // own over it as it exits (see steam.snapshotShortcuts).
  const snapshot = steam.snapshotShortcuts({ root });
  log(`Steam's non-Steam games before ${wasRunning ? 'closing Steam' : 'adding'} (${root}): ${steam.describeShortcuts(snapshot)}. Adding to account ${accounts.join(', ')}.`);
  if (wasRunning) {
    log('Closing Steam…');
    await shell.openExternal('steam://exit');
    await waitForSteamToClose();
    log(`Steam's non-Steam games after Steam closed: ${steam.describeShortcuts(steam.snapshotShortcuts({ root, backUp: false }))}.`);
  }
  const results = steam.addShortcut({ root, accounts, exe, startDir: path.dirname(exe), artwork, snapshot,
    launchOptions: STEAM_LAUNCH_OPTIONS, play: Boolean(play) });
  const added = results.some(result => result.added);
  const images = Math.min(...results.map(result => result.artwork));
  log(`${added ? 'Added' : 'Updated'} ${steam.APP_NAME} in Steam${play ? ' with Skip Launcher' : ''} (${images} of ${steam.ARTWORK.length} artwork images, ${root}).`);
  for (const result of results)
    log(`Steam account ${result.account}: kept its ${result.kept} other non-Steam games${result.backup ? `; the list from before is saved as ${result.backup}` : ''}.`);
  if (reopen) shell.openExternal('steam://open/games').catch(() => {});
  return { added, play: Boolean(play), name: steam.APP_NAME, artwork: images, total: steam.ARTWORK.length, reopened: reopen };
}

function requireRepo() {
  if (!port.isPort(config.repo)) throw new Error('Download the setup files or choose a folder that already has them.');
  return config.repo;
}

function currentSaveDirectory() {
  return process.env.SMS_SAVE_DIR ? saves.saveDirectory(config.repo) : config.saveDirectory || saves.saveDirectory(config.repo);
}

// An older launcher's multiplayer guest save, inside the card folder, out of the way of backups.
function tidySaveDirectory() {
  if (!config.repo && !config.saveDirectory && !process.env.SMS_SAVE_DIR) return; // not set up: no card yet
  try { if (saves.moveOldGuestSaves(currentSaveDirectory())) log('Moved the multiplayer guest save out of your memory card folder.'); }
  catch (error) { log(`Couldn't move the multiplayer guest save out of your memory card folder: ${error.message}`); }
}

// The backups the launcher makes by itself, which Back up automatically (Saves) turns off. Back up saves, and the backups
// before a restore or a Dolphin import (which write over the card) or before moving a build the card is in, still happen.
const AUTOMATIC_BACKUPS = { 'before-play': 'before playing', 'after-play': 'after playing',
  'before-port-update': 'before the update', 'before-cleanup': 'before cleanup' };

function makeSaveBackup(reason) {
  if (active) throw new Error('Stop the running game or task before backing up saves.');
  tidySaveDirectory();
  if (AUTOMATIC_BACKUPS[reason] && config.settings.autoBackups === false) {
    log(`Saves not backed up ${AUTOMATIC_BACKUPS[reason]}: automatic backups are off under Saves.`);
    return { skipped: true };
  }
  const result = saves.backupSaves(currentSaveDirectory(), saves.backupRoot(), reason);
  log(result.empty ? result.message : `Saved ${result.count} memory card file(s)${result.mods ? ` and ${result.mods} mod save file(s)` : ''} to ${result.directory}`);
  return result;
}

async function launch(command, args, options = {}, label = 'Task', isGame = false) {
  if (active) throw new Error(`Wait for ${active.label} to finish, or stop it first.`);
  try {
    log(`▶ ${label}`);
    // Windows applies windowsHide's "start hidden" to a program's first window,
    // so the game would run with an invisible window. Detached instead, the game
    // (a console program) gets no console window and shows its own normally.
    const windowsGame = isGame && process.platform === 'win32';
    // Python writes UTF-8, as this log reads it: on Windows it otherwise uses
    // the system code page, and cp1251 can't print the "ñ" in "Español".
    const child = spawn(command, args, { ...options, detached: process.platform !== 'win32' || windowsGame,
      env: { ...(options.env || process.env), PYTHONUNBUFFERED: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: !windowsGame, stdio: ['ignore', 'pipe', 'pipe'] });
    active = { label, child, detail: label.includes('build tools') ? 'Downloading and preparing tools…' : 'Starting…',
      percent: null, startedAt: Date.now() };
    broadcast('activity', activityState());
    const recent = [], readActivity = createActivityReader();
    // The game's [presence] lines go to Discord, not the activity log; a
    // partial line that could become one waits for the rest.
    function output(text, stream, entry) {
      if (isGame && stream === 'stdout' && !entry && text
        && (presence.isPresenceLine(text) || presence.PREFIX.startsWith(text)
          || achievements.isLine(text) || achievements.PREFIX.startsWith(text))) return entry;
      return logOutput(text, stream, entry);
    }
    function line(value, stream, entry) {
      if (isGame && stream === 'stdout' && presence.isPresenceLine(value)) return onPresence?.(value);
      if (isGame && stream === 'stdout' && achievements.isLine(value)) return onAchievement?.(value);
      completeOutput(value, stream, entry);
      if (!value) return;
      if (isGame) onGameLine?.(value);
      if (recent.push(value) > 80) recent.shift();
      const progress = isGame ? null : readActivity(value);
      if (progress && active && active.child === child) {
        Object.assign(active, progress);
        broadcast('activity', activityState());
      }
    }
    const { error, code, signal } = await observeProcess(child, { output, line });
    active = null;
    broadcast('activity', activityState());
    if (error) throw error;
    if (code !== 0 || signal) {
      throw Object.assign(new Error(failureMessage(label, { code, signal }, recent, { game: isGame })), { exitCode: code, output: recent.slice() });
    }
    log(`✓ ${label} finished`);
    return { ok: true };
  } catch (error) {
    log(`✕ ${error.message}`);
    error.activityLogged = true;
    throw error;
  }
}

async function capture(command, args, cwd, env = process.env) {
  try {
    log(`▶ ${command} ${args.join(' ')}`);
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const { error, code, signal, stdout, stderr } = await observeProcess(child, { output: logOutput, line: completeOutput, capture: true });
    if (error) throw error;
    if (code !== 0 || signal) throw new Error(`${exitDescription(command, code, signal)}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
    return stdout.trim();
  } catch (error) {
    log(`✕ ${error.message}`);
    error.activityLogged = true;
    throw error;
  }
}

// The clearer error for a failed step that ran out of disk space or couldn't
// fork() on Windows, or null (build-tools.js hintedError). exclusive() logs it.
function hintedError(error) {
  try { return buildTools.hintedError(error, { dataFolder: app.getPath('userData'), gameFolder: config?.repo }); }
  catch (_) { return null; }
}

function toolEnv(base = process.env) {
  return buildTools.environment(app.getPath('userData'), base);
}

function toolOptions() {
  // The Apple Silicon build runs without Rosetta.
  return { archives: Boolean(config.settings.textures || config.settings.eclipse), rosetta: config.settings.arch !== 'arm64' };
}

function toolsStatus() {
  return buildTools.status(app.getPath('userData'), process.platform, process.env, toolOptions());
}

async function checkTools(refresh = false) {
  return buildTools.check(app.getPath('userData'), { ...toolOptions(), refresh });
}

// A Windows game folder or build tools too deep for the compiler fail deep
// into the build with "No such file or directory" for a file that is there.
// The launcher shows this when it opens, and stops before downloading the
// tools or building. root defaults to where the next game update builds.
function pathProblem(root = config.repo && game.snapshotPath(config.installRoot || config.repo, config.settings, currentSource()),
  settings = config.settings) {
  if (process.platform !== 'win32' || !root) return null;
  return port.longPathProblem(root, settings, { portable: Boolean(portableRoot),
    folder: portableRoot || path.dirname(config.installRoot || config.repo),
    msys: process.env.SMS_MSYS2_ROOT || path.join(buildTools.rootFor(app.getPath('userData')), 'msys64') });
}

// The last one that stopped a build, which the launcher shows in place of the
// next update's: a fresh build's folder is longer.
let blockedPath = null;
function requireShortPaths(root, settings) {
  const problem = blockedPath = pathProblem(root, settings);
  if (!problem) return;
  log(problem.message);
  throw new Error(problem.message);
}

async function ensureBuildTools() {
  await prepareBuildTools();
  shieldBuildTools();
}

// Another program's same-named DLLs in System32 stand in for the build tools'
// own (windows-dlls.js): the compiler then fails without a message, which
// CMake reports as "not able to compile a simple test program". The prepared
// tools get their DLLs beside each program that needs them; a player's own
// MSYS2 is left as it is, with the cause in the activity log.
let ownToolsWarned = false;
function shieldBuildTools() {
  if (process.platform !== 'win32') return;
  const own = toolsStatus().mode === 'own';
  if (own && ownToolsWarned) return;
  const msys = own ? process.env.SMS_MSYS2_ROOT : path.join(buildTools.rootFor(app.getPath('userData')), 'msys64');
  const result = windowsDlls.shieldToolchain(msys, { place: !own });
  for (const error of result.errors) log(`Could not give the build tools their own DLL: ${error}`);
  if (!result.conflicts.length) return;
  if (own) {
    ownToolsWarned = true;
    log(`Windows has its own copies of ${systemDllList(result.conflicts)}, which your MSYS2's compiler loads instead of MSYS2's. ` +
      'If the build says the compiler is not able to compile a simple test program, remove SMS_MSYS2_ROOT to use the prepared build tools.');
  } else if (result.placed.length) {
    log(`Windows has its own copies of ${systemDllList(result.conflicts)}. The build tools now use theirs instead.`);
  }
}

// The game loads its DLLs the same way: from its build folder before System32.
// Only from the tools it was built with: once they are removed (removeBuildTools),
// the DLLs beside it stay as they are, not replaced from some other C:\msys64.
function shieldGame(root, settings, env) {
  if (process.platform !== 'win32' || !env.MSYS2_ROOT) return;
  const result = windowsDlls.shield([port.binaryPath(root, settings)], port.gameRuntimeFolders(settings, env));
  for (const error of result.errors) log(`Could not give the game its own DLL: ${error}`);
  if (result.conflicts.length && result.placed.length)
    log(`Windows has its own copies of ${systemDllList(result.conflicts)}. The game now uses the ones it was built with.`);
}

// Windows stops a program before it starts when a DLL it needs is missing,
// lacks a function or fails to load, and says which only in a dialog.
const DLL_FAILURES = new Set([0xC0000135, 0xC0000139, 0xC0000142]);
function explainDllFailure(error, root, settings, env) {
  if (process.platform !== 'win32' || !Number.isInteger(error.exitCode) || !DLL_FAILURES.has(error.exitCode >>> 0)) return;
  const binary = port.binaryPath(root, settings);
  const { conflicts } = windowsDlls.shield([binary], port.gameRuntimeFolders(settings, env), { place: false });
  log('The game could not load one of its DLLs.' +
    (conflicts.length ? ` Windows has its own copies of ${systemDllList(conflicts)}; the game has its own beside it.` : '') +
    ` To see which DLL Windows means, open ${path.dirname(binary)} and double-click ${path.basename(binary)}, then send what it says with the activity log.`);
}

function systemDllList(files) {
  const names = [...new Set(files.map(file => path.basename(file)))];
  const folders = [...new Set(files.map(file => path.dirname(file)))];
  return `${names.join(', ')} in ${folders.join(' and ')}`;
}

async function prepareBuildTools() {
  requireShortPaths();
  if (preparingTools) throw new Error('Wait for build tools to finish preparing.');
  if (active) throw new Error(`Wait for ${active.label} to finish, or stop it first.`);
  const userData = app.getPath('userData');
  const forcePrivate = process.env.SMS_FORCE_PRIVATE_TOOLS === '1';
  if (process.platform === 'darwin') {
    preparingTools = true;
    try {
      const found = await checkTools(true);
      if (!found.appleReady) throw new Error(found.message);
      if (found.ready && !forcePrivate) return;
    } finally { preparingTools = false; }
  }
  const found = toolsStatus();
  if (found.mode === 'private' || (!forcePrivate && found.ready)) return;
  preparingTools = true;
  const startedAt = Date.now();
  log(`Downloading build tools to ${path.dirname(buildTools.rootFor(userData))}.`);
  active = { label: 'Download build tools', child: null, detail: 'Checking download…', percent: null, startedAt };
  broadcast('activity', { label: active.label, detail: active.detail, percent: null, startedAt });
  try {
    await buildTools.prepare(userData, {
      ...toolOptions(),
      forcePrivate,
      progress(percent, detail) {
        if (!active || active.child) return;
        if (detail && detail !== active.detail) log(detail);
        active.detail = detail || (percent === null ? 'Downloading tools…' : `Downloading tools: ${percent}%`);
        active.percent = percent;
        broadcast('activity', { label: active.label, detail: active.detail, percent, startedAt });
      },
      async run(command, args, options, label) {
        active = null;
        broadcast('activity', null);
        try { return await launch(command, args, options, label); }
        finally {
          if (preparingTools && !active) {
            active = { label: 'Download build tools', child: null, detail: 'Preparing build tools…', percent: null, startedAt };
            broadcast('activity', { label: active.label, detail: active.detail, percent: null, startedAt, canStop: false });
          }
        }
      }
    });
    log('Build tools are ready.');
  } catch (error) {
    // Rare, and the files go again on the next try unless the player acts, so
    // an alert rather than only a log line.
    if (error.missingTools && process.platform === 'win32' && window)
      void dialog.showMessageBox(window, { type: 'warning', buttons: ['OK'],
        message: 'Build tools are missing files after downloading', detail: error.message }).catch(() => {});
    throw error;
  } finally {
    preparingTools = false;
    if (active && !active.child && active.startedAt === startedAt) {
      active = null;
      broadcast('activity', null);
    }
  }
}

async function updatePort() {
  requireRepo();
  port.validateRom(config.rom);
  // Removed build tools download again only for a game that needs building.
  if (config.gameSource || !game.isCurrent(config.repo, config.settings, currentSource())) {
    await ensureBuildTools();
    await refreshGameSource();
  }
  if (game.isCurrent(config.repo, config.settings, currentSource())) {
    log(config.gameSource ? 'Your game is up to date with the chosen game source.' : 'Your game is up to date for this launcher release.');
    return state();
  }
  await build();
  return state();
}

async function installPort() {
  await ensureBuildTools();
  const destination = config.repo;
  if (port.isPort(destination)) return { ok: true };
  if (fs.existsSync(destination)) {
    if (!fs.statSync(destination).isDirectory() || fs.readdirSync(destination).length)
      throw new Error('That folder is not empty. Choose another download location.');
    fs.rmdirSync(destination);
  }
  await game.checkout(destination, { run: launch, capture, env: toolEnv(), source: currentSource(), stopped: wasStopped });
  return { ok: true };
}

// Eclipse patches only a 1:1 copy of the North American disc. Says so before
// any download or build, instead of the game's installer failing midway.
async function checkEclipseDisc(rom, root = config.repo) {
  log('Checking that Super Mario Eclipse can patch your disc…');
  try {
    await eclipseDisc.check(rom, { root: port.isPort(root) ? root : null });
  } catch (error) {
    if (error.eclipseDisc) log(`Your disc's MD5 is ${error.md5}; Super Mario Eclipse needs ${error.expected}.`);
    throw error;
  }
}

async function installEclipse(root = requireRepo()) {
  const rom = port.validateRom(config.rom);
  await checkEclipseDisc(rom, root);
  await ensureBuildTools();
  const cmd = port.commandFor(root, 'python', [rom], process.platform, toolEnv());
  return launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, 'Install Eclipse from your disc');
}

// Windows build tools removed under Manage game (removeBuildTools) or by hand,
// with a game that plays without them: the downloads that only add to it, and
// would otherwise download the tools first for their installers, wait for the
// next time the tools come back (a game update or rebuild). Says so in the log.
function toolsRemoved(what) {
  if (process.platform !== 'win32' || toolsStatus().ready) return false;
  log(`${what} wait for the next game update: their installer needs the build tools, which are removed, and the launcher downloads them again then.`);
  return true;
}

// Manage game → Remove build tools. Only Windows: its game has every DLL it
// imports beside it and plays without them (game.playsWithoutTools); on Linux
// and macOS the game loads libraries from the tools. Each kept game first gets
// its DLLs from the tools it was built with. The tools download again the next
// time the launcher builds or sets up the game (ensureBuildTools).
function buildToolsFolder() { return path.dirname(buildTools.rootFor(app.getPath('userData'))); }

async function removeBuildTools() {
  if (process.platform !== 'win32') throw new Error('On this computer the game runs with libraries from the build tools, so they stay.');
  if (toolsStatus().mode === 'own') throw new Error('The launcher builds with your own MSYS2 (SMS_MSYS2_ROOT) and never removes it.');
  requireRepo();
  for (const install of [{ repo: config.repo }, config.previousInstall].filter(item => item?.repo))
    for (const arch of port.platformInfo().arches)
      for (const eclipse of [false, true]) {
        const settings = { ...config.settings, arch, eclipse };
        if (!fs.existsSync(port.binaryPath(install.repo, settings))) continue;
        const recorded = game.toolRoot(install.repo, settings);
        const base = { ...process.env, SMS_ARCH: arch };
        shieldGame(install.repo, settings, recorded ? buildTools.environmentAtRoot(recorded, base) : toolEnv(base));
      }
  if (!binaryReady() || !game.playsWithoutTools(config.repo, config.settings))
    throw new Error('The game still needs DLLs from the build tools. Update or rebuild the game, then try again.');
  const folder = buildToolsFolder();
  if (operation) {
    Object.assign(operation, { detail: 'Removing build tools…', percent: null });
    broadcast('activity', activityState());
  }
  try { await fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch (error) {
    throw new Error(`Some build tools could not be removed (${error.message}). Close programs using files in ${folder}, then try again.`);
  }
  log(`Removed the build tools from ${folder}. The game plays without them; the launcher downloads them again the next time it builds or sets up the game.`);
  return state();
}

// The texture extras' pinned release, downloaded on its own (not the UHD pack
// again) when it is missing or a newer one is pinned. They only add to the UHD
// pack, so a failed download is logged and never stops setup or play.
async function updateTextureExtras(root, settings) {
  if (!port.textureExtrasWanted(root, settings) || toolsRemoved('HD texture extras')) return;
  try {
    await ensureBuildTools();
    const cmd = port.commandFor(root, 'texture-extras', [], process.platform, toolEnv());
    await launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, 'Install HD texture extras');
    if (!port.textureExtrasInstalled(root)) throw new Error('the installer finished without them');
  } catch (error) {
    log(`HD texture extras were not updated (${error.message}); the game plays without them and setup tries again next time.`);
  }
}

// The radar's maps of Eclipse's stages, when Eclipse is played with the radar
// and they are missing (an Eclipse install from before them) or another
// release is pinned. Only the radar needs them, so a failed download is logged
// and never stops setup or play.
async function updateEclipseMaps(root, settings) {
  if (!port.eclipseMapsWanted(root, settings) || !fs.existsSync(path.join(root, port.ECLIPSE_ISO)) ||
    toolsRemoved("Eclipse's radar maps")) return;
  try {
    await ensureBuildTools();
    const cmd = port.commandFor(root, 'eclipse-maps', [], process.platform, toolEnv());
    await launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, 'Install Eclipse radar maps');
    if (!port.eclipseMapsInstalled(root)) throw new Error('the installer finished without them');
  } catch (error) {
    log(`Eclipse's radar maps were not installed (${error.message}); its own stages have no radar until setup tries again next time.`);
  }
}

// The achievements' icons, when they are missing or not the pinned release: before the game plays, for every
// player. A failed download does not stop the game: it plays without them, and setup tries again next time.
async function updateAchievementIcons(root, settings) {
  if (!port.achievementIconsWanted(root, settings) || toolsRemoved('The achievement icons')) return;
  try { await installAchievementIcons(root, { tries: 2 }); }
  catch (error) {
    log(`The achievement icons were not installed (${error.message}); achievements still unlock, and setup tries again next time.`);
  }
}
// The installer resumes a dropped connection itself; a run that still fails is tried again
// a few times (not after Stop), each retry shown as the task's detail.
const ACHIEVEMENT_ICON_TRIES = 3;
async function installAchievementIcons(root, { tries = ACHIEVEMENT_ICON_TRIES } = {}) {
  const startedAt = Date.now();
  let attempts = 0;
  await retrying(async () => {
    attempts++;
    await ensureBuildTools();
    const cmd = port.commandFor(root, 'achievement-icons', [], process.platform, toolEnv());
    await launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, 'Install achievement icons');
    if (!port.achievementIconsInstalled(root)) throw new Error('the installer finished without them');
  }, { tries, permanent: () => wasStopped(startedAt), onRetry(error, n) {
    const seconds = n * 2;
    log(`The achievement icons didn't download (${error.message}); trying again in ${seconds} s (try ${n + 1} of ${tries}).`);
    if (operation) {
      Object.assign(operation, { detail: `Download failed, trying again in ${seconds} s (try ${n + 1} of ${tries})…`, percent: null });
      broadcast('activity', activityState());
    }
  } }).catch(error => {
    if (attempts > 1) error.message += ` (tried ${attempts} times)`;
    throw error;
  });
  achievementIconCache.clear();
  broadcast('achievement', null);
}
// The Achievements tab's Download icons, when its page opens without them: only the icons, then the page.
async function downloadAchievementIcons() {
  requireRepo();
  // Nothing to download them for: said in the popup, before any download.
  if (!achievements.supported(config.repo, config.settings)) throw new Error(config.settings.eclipse
    ? "Your game version has no Super Mario Eclipse achievements yet. Update the game on Play, then try again"
    : 'Your game version has no achievements yet. Update the game on Play, then try again');
  if (!port.achievementIconsWanted(config.repo, config.settings)) return achievementsState();
  try { await installAchievementIcons(config.repo); }
  catch (error) {
    if (!operation || wasStopped(operation.startedAt)) throw error;
    throw new Error(`The icons didn't download: ${error.message.replace(/\.$/, '')}. Check your internet connection and try again; the activity log has the details`);
  }
  return achievementsState();
}

// The chosen language's pack, when it is missing or not the pinned release. A
// failed download does not stop the game: it plays in English, and setup tries
// again next time.
async function updateLanguagePack(root, settings) {
  if (!port.languagePackWanted(root, settings)) return;
  const name = port.LANGUAGE_PACKS[settings.language]?.english || settings.language;
  try {
    await ensureBuildTools();
    const cmd = port.commandFor(root, 'language', [settings.language], process.platform, toolEnv());
    await launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, 'Install language pack');
    if (!port.languagePackInstalled(root, settings.language)) throw new Error('the installer finished without it');
  } catch (error) {
    log(`The ${name} language pack was not installed (${error.message}); the game plays in English and setup tries again next time.`);
  }
}

async function installTextures(root = requireRepo()) {
  await ensureBuildTools();
  if (config.settings.textures && !port.texturePackInstalled(root)) {
    const cmd = port.commandFor(root, 'textures', [], process.platform, toolEnv());
    await launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, 'Install UHD textures');
    if (!port.texturePackInstalled(root)) throw new Error('Texture installer finished without a usable texture pack.');
  } else if (config.settings.textures) log('HD textures are already installed.');
  await updateTextureExtras(root, config.settings);
  if (port.wantsCutscenes(config.settings) && port.cutscenePackSupported(root) && !port.cutscenePackInstalled(root)) {
    const rom = port.validateRom(config.rom);
    const cmd = port.commandFor(root, 'cutscenes', [rom], process.platform, toolEnv());
    await launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, 'Install HD cutscenes');
    if (!port.cutscenePackInstalled(root)) throw new Error('HD cutscene setup finished without a complete movie pack. Please retry.');
  }
  log('HD visuals are ready for the next game launch.');
  return { installed: true };
}

function binaryReady(root = config.repo, settings = config.settings) {
  return port.isPort(root) && fs.existsSync(port.binaryPath(root, settings));
}

// Playable as the settings are, without an update: a Windows game picked to
// draw with Vulkan needs a build with the Vulkan backend in.
function buildReady() {
  return binaryReady() && !game.needsVulkanBuild(config.repo, config.settings);
}

async function build(forceFresh = false) {
  const original = requireRepo();
  const settings = { ...config.settings };
  const rom = port.validateRom(config.rom);
  if (settings.eclipse && !fs.existsSync(path.join(original, port.ECLIPSE_ISO))) await checkEclipseDisc(rom, original);
  const saveDirectory = currentSaveDirectory();
  makeSaveBackup('before-port-update');
  await ensureBuildTools();
  const source = currentSource();
  let root = original;
  const sourceMarker = path.join(root, 'launcher-source.json');
  const freshPinnedSource = fs.existsSync(sourceMarker) && !binaryReady(root, settings) && game.matchesSource(root, source);
  if (forceFresh || (!game.isCurrent(root, settings, source) && !freshPinnedSource)) {
    root = game.snapshotPath(config.installRoot || original, settings, source);
    if (forceFresh || (fs.existsSync(root) && !game.matchesSource(root, source))) root += `.fresh-${Date.now()}`;
    if (!fs.existsSync(root)) await game.checkout(root, { run: launch, capture, env: toolEnv(), reference: original, source, stopped: wasStopped });
    if (!game.matchesSource(root, source))
      throw new Error('The update folder has changed. Choose another setup location in Settings and try again.');
    game.carryUserFiles(original, root);
  }
  if (settings.arch === 'arm64' && !port.gameFeatures(root).appleSilicon)
    throw new Error('This game version has no Apple Silicon build. Turn off Apple Silicon build under Manage game, Files, or update the game.');
  if (settings.arch === 'arm64' && settings.eclipse && !port.gameFeatures(root).eclipseAppleSilicon)
    throw new Error('This game version plays Super Mario Eclipse through Rosetta only. Turn off Apple Silicon build under Manage game, Files, or update the game.');
  // A fresh build's folder is longer than the one ensureBuildTools checked.
  requireShortPaths(root, settings);
  if (!port.hdVisualsInstalled(root, settings)) await installTextures(root);
  else await updateTextureExtras(root, settings);
  await updateLanguagePack(root, settings);
  if (settings.eclipse && !fs.existsSync(path.join(root, port.ECLIPSE_ISO))) await installEclipse(root);
  await updateEclipseMaps(root, settings);
  const disc = port.gameDisc(root, rom, settings.eclipse);
  const env = await withBuildCaches(toolEnv(port.buildEnvironment(settings, disc, root)), root);
  env.NINJA_STATUS = '[%f/%t] ';
  const compile = buildEnv => {
    const cmd = settings.eclipse
      ? port.eclipseBuildCommand(root, settings, process.platform, buildEnv)
      : port.commandFor(root, 'build', [disc], process.platform, buildEnv);
    return game.buildSafely(root, settings, saveDirectory,
      // A build that fails because antivirus deleted or blocked a tool says so instead of CMake's error.
      () => launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, settings.eclipse ? 'Build Eclipse port' : 'Build Sunshine port')
        .catch(error => {
          const userData = app.getPath('userData');
          throw hintedError(error) || buildTools.deletedToolsError(userData) || buildTools.blockedToolError(userData, error.output) || error;
        }),
      undefined, source);
  };
  const startedAt = Date.now();
  let result;
  try { result = await compile(env); }
  catch (error) {
    // A failed build through the compiler cache is tried once more without it,
    // unless the player stopped it, the build tools lost files, or the drive is
    // full or Windows won't let them fork (which fail the same way again).
    if (!usesCompilerCache(env) || stoppedAt >= startedAt || error.blockedTool || error.buildHint || buildTools.missingTools(app.getPath('userData'))?.length) throw error;
    log('The build failed with the compiler cache. Building again without it…');
    result = await compile(Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'SMS_COMPILER_CACHE' && !/^CCACHE_/i.test(key))));
  }
  // Ready for sms-standalone.exe, which players can also start from Explorer.
  shieldGame(root, settings, env);
  if (settings.renderer === 'vulkan' && game.vulkanBuiltIn(root, settings) === false)
    log('⚠ The game was built without Vulkan: its Vulkan downloads from github.com failed (the build\'s warnings above say which). '
      + 'It will draw with OpenGL, which can be much slower. Check your internet connection, firewall or antivirus, '
      + 'then choose Rebuild game under Settings → Manage game.');
  // Preferences switch only after a successful build. Closing the app or a
  // failed download/build leaves the last installation selected and playable.
  const earlier = { ...config };
  config = { ...config, repo: root, installRoot: config.installRoot || original,
    saveDirectory, completedSetup: true,
    previousInstall: root !== original && binaryReady(original, settings)
      ? { repo: original, settings, rom, saveDirectory } : config.previousInstall };
  try { saveConfig(); }
  catch (error) { config = earlier; throw error; }
  log(`Game ${source.version} is ready. Your saved games stay in the same folder.`);
  await removeOldVersions();
  await removeOldBuildTools();
  return result;
}

// What every game version's build shares: the compiler cache (compiler-cache.js),
// and the Eclipse sources' downloads (the game's SMS_ECLIPSE_GIT_CACHE, on the
// game's drive: game.eclipseSourcesPath). A player's own SMS_COMPILER_CACHE
// (empty for none) or SMS_ECLIPSE_GIT_CACHE is used instead. Without the cache
// the game builds as before.
function eclipseSourcesDirectory() {
  return game.eclipseSourcesPath(app.getPath('userData'), config.installRoot || config.repo);
}

function usesCompilerCache(env) { return Boolean(env.SMS_COMPILER_CACHE) && !('SMS_COMPILER_CACHE' in process.env); }

async function withBuildCaches(env, root) {
  const userData = app.getPath('userData');
  if (!('SMS_ECLIPSE_GIT_CACHE' in process.env))
    env = { ...env, SMS_ECLIPSE_GIT_CACHE: eclipseSourcesDirectory().replaceAll(path.sep, '/') };
  if ('SMS_COMPILER_CACHE' in process.env) return env;
  try { return compilerCache.environment(env, await compilerCache.prepare(userData, { log }), { userData, root }); }
  catch (error) {
    log(`Building without the compiler cache: ${error.message}.`);
    return env;
  }
}

// Build tools no kept game version was built with: an update's newer tools
// replaced them. A kept game loads its runtime libraries from its own.
async function removeOldBuildTools() {
  const keep = [];
  let unknown = false;
  for (const root of [config.repo, config.previousInstall?.repo].filter(Boolean))
    for (const arch of port.platformInfo().arches)
      for (const eclipse of [false, true]) {
        if (!fs.existsSync(port.binaryPath(root, { arch, eclipse }))) continue;
        const tools = game.toolRoot(root, { arch, eclipse });
        if (tools) keep.push(tools);
        else unknown = true;
      }
  const removed = await buildTools.pruneToolsets(app.getPath('userData'), keep, { leftoversOnly: unknown,
    onError: (error, item) => log(`Could not remove old build tools ${item}: ${error.message}`) });
  if (removed.length) log(`Removed ${removed.length === 1 ? 'old build tools' : `${removed.length} old build tool folders`} ` +
    'that no game version uses any more, to free up disk space.');
}

// Keep the current and previous game versions; older ones only take up space.
async function removeOldVersions(shouldStop) {
  if (!config.installRoot || !binaryReady()) return;
  const removed = await game.pruneSnapshots(config.installRoot, [config.repo, config.previousInstall?.repo],
    [currentSaveDirectory(), config.previousInstall?.saveDirectory, config.rom, config.previousInstall?.rom],
    (error, folder) => log(['EBUSY', 'EPERM', 'EACCES'].includes(error.code) && error.path
      ? `Could not remove all of old game version ${folder}: another program has ` +
        `${path.basename(error.path)} open. The launcher tries again the next time it starts.`
      : `Could not remove old game version ${folder}: ${error.message}`), shouldStop);
  if (removed.length) log(`Removed ${removed.length} old game version${removed.length === 1 ? '' : 's'} to free up disk space.`);
}

// At startup old game versions are removed beside the window rather than as a
// task: on Windows that can take minutes, and Play or Update & play would have
// to wait for it. A task stops it after the file it is on (exclusive); the rest
// goes after the next update or start.
let removingOldVersions = null;
function removeOldVersionsInBackground() {
  const job = { stop: false };
  job.done = removeOldVersions(() => job.stop)
    .catch(error => log(`Could not remove old game versions: ${error.message}`))
    .finally(() => { if (removingOldVersions === job) removingOldVersions = null; });
  removingOldVersions = job;
}

async function setupGame() {
  requireRepo();
  port.validateRom(config.rom);
  if (!game.isCurrent(config.repo, config.settings, currentSource())) await build();
  else if (!port.hdVisualsInstalled(config.repo, config.settings)) await installTextures();
  else await updateTextureExtras(config.repo, config.settings);
  await updateLanguagePack(config.repo, config.settings);
  await updateEclipseMaps(config.repo, config.settings);
  await updateAchievementIcons(config.repo, config.settings);
  return state();
}

const PLAYER_SETTINGS = [
  'volume', 'musicVolume', 'sfxVolume', 'invertCameraX', 'invertCameraY', 'invertFluddAimY', 'keyBindings', 'padBindings', 'softTrigger', 'rumbleStrength', 'freeCamera', 'cstickAim', 'cstickOrbit', 'cameraSpeed', 'mouseCamera', 'closeCameraMouse',
  'coopSplit', 'mouseSensitivity', 'rawMouse', 'skipMovies', 'skipIntro', 'language', 'heatHaze', 'pauseTracker', 'radar', 'autoSave', 'buttonPrompts', 'promptPad', 'hdr', 'hdrCalibration', 'hdrPaperWhite', 'hdrPeak', 'hdrContrast', 'hdrSaturation', 'hdrHighlights', 'overlay', 'fullscreenMode', 'exclusiveResolution', 'display', 'vsync',
  'msaa', 'fxaa', 'anisotropic', 'sharpen', 'fsrMode', 'brightness', 'colorSpace', 'gameGamma', 'displayGamma', 'aspect', 'presentFilter',
  'renderer', 'eclipseSunshineMovies'
];
function promptDirectory() { return path.join(app.getPath('userData'), 'prompts'); }

// Settings the player changed in the game's own settings menu (game-settings.js) become the launcher's,
// after the game closes (and at start, should the launcher have closed while the game ran). The file
// stays until they are saved, so a failed save is tried again.
function keepGameSettings() {
  const file = gameSettings.file(app.getPath('userData'));
  if (!fs.existsSync(file)) return;
  try {
    // the host's Player Collision, changed in its game: the Online tab's switch for next time
    const collision = gameSettings.readCollision(file);
    if (collision !== null && collision !== (config.multiplayer.collision === true)) {
      config.multiplayer = { ...config.multiplayer, collision };
      saveConfig();
      log(`Kept Player Collision ${collision ? 'on' : 'off'}, as you set it in the game.`);
    }
    const settings = port.normalizeSettings(gameSettings.merge(config.settings, gameSettings.read(file)),
      process.platform, process.arch, port.gameFeatures(port.isPort(config.repo) ? config.repo : null));
    const changed = gameSettings.changedKeys(config.settings, settings);
    if (changed.length) {
      config.settings = settings;
      saveConfig();
      log(`Kept ${changed.length === 1 ? 'the setting' : `${changed.length} settings`} you changed in the game (${changed.join(', ')}).`);
    }
    gameSettings.remove(file);
  } catch (error) { log(`Could not keep the settings you changed in the game: ${error.message}`); }
}

function playerSettings(settings) { return Object.fromEntries(PLAYER_SETTINGS.map(key => [key, settings[key]])); }

// What Windows reports about each display's HDR: the game's --display-info (its peak brightness as calibrated,
// SDR content brightness and HDR calibration profile), for Settings → HDR.
async function displayInfo() {
  if (process.platform !== 'win32') return { displays: [], error: 'HDR settings are for Windows.' };
  const root = config.repo, settings = config.settings;
  if (!root || !binaryReady(root, settings)) return { displays: [], error: 'Set up the game first to read your display.' };
  const recordedTools = game.toolRoot(root, settings);
  const base = { ...process.env, SMS_ARCH: settings.arch };
  const env = recordedTools ? buildTools.environmentAtRoot(recordedTools, base) : toolEnv(base);
  shieldGame(root, settings, env);
  const cmd = port.commandFor(root, 'run', ['--display-info'], process.platform, env);
  const stdout = await new Promise(resolve => execFile(cmd.command, cmd.args,
    { cwd: cmd.cwd, env: cmd.env, timeout: 15000, windowsHide: true }, (_error, out) => resolve(String(out || ''))));
  const line = stdout.split(/\r?\n/).find(text => text.startsWith('{"displays"'));
  if (!line) return { displays: [], error: 'This game version cannot read your display yet. Update the game to see it.' };
  try { return { displays: JSON.parse(line).displays || [] }; }
  catch (_) { return { displays: [], error: 'The game reported your display in a way the launcher did not understand.' }; }
}

// `session`: a multiplayer game to host or join ({ mode: 'host' or 'join', env }: hostGame, joinGame), or null to play alone.
// The Mods page: the launcher's mods, and whether this game can run them.
function nativeModsState() {
  const root = config.repo && fs.existsSync(config.repo) ? config.repo : null;
  return nativeMods.list(app.getPath('userData'), root);
}

// Each mod's newest release, for the page's Update buttons; a mod GitHub
// cannot answer about just shows none.
async function nativeModsLatest() {
  const latest = {};
  await Promise.all(nativeMods.catalog().map(async entry => {
    try { latest[entry.id] = await nativeMods.latestRelease(entry, (url, options) => net.fetch(url, options)); }
    catch (error) { latest[entry.id] = { error: error.message }; }
  }));
  return latest;
}

async function installNativeMod(id) {
  const entry = nativeMods.catalog().find(item => item.id === id);
  if (!entry) throw new Error('That mod is not one the launcher offers.');
  const done = await nativeMods.download(app.getPath('userData'), entry, (url, options) => net.fetch(url, options));
  log(`Installed ${entry.name} ${done.version} in ${done.dir}.`);
  return nativeModsState();
}

// The game drawing with OpenGL though the player picked Vulkan, which can make it much slower: said
// plainly in the activity log, as the game's own line is easy to miss, and shown on the Play page
// (state: renderer) until Vulkan draws again.
function noteRenderer(line, settings) {
  if (settings.renderer !== 'vulkan') return;
  const seen = vulkanStatus.fromGameLine(line);
  if (!seen) return;
  const failed = seen.state === 'failed' ? seen.reason || 'Vulkan could not start' : null;
  if (seen.state === 'missing')
    log('⚠ The game is drawing with OpenGL, not the Vulkan you picked: this build of the game has no Vulkan backend, '
      + 'because its downloads failed when it was built. OpenGL can be much slower. Rebuild game, under Settings → Manage game, tries again.');
  if (seen.state === 'failed')
    log(`⚠ Vulkan could not start${seen.reason ? ` (${seen.reason})` : ''}, so the game is drawing with OpenGL, which can be much slower. `
      + 'Updating your graphics driver often fixes this; or choose OpenGL under Settings → Graphics.');
  if (seen.state !== 'missing' && config.vulkanFailed !== failed) {
    config.vulkanFailed = failed;
    try { saveConfig(); } catch (error) { log(`Could not save preferences: ${error.message}`); }
  }
}

async function play(installation = null, session = null) {
  keepGameSettings();
  const root = installation?.repo || requireRepo();
  // Controls, sound, display and picture choices are the player's, not the build's: an earlier install plays with them too.
  const settings = installation ? { ...installation.settings, ...playerSettings(config.settings) } : config.settings;
  const rom = port.validateRom(installation?.rom || config.rom);
  if (!binaryReady(root, settings)) throw new Error('Set up this version of the game before playing.');
  if (!port.hdVisualsInstalled(root, settings))
    throw new Error('HD visuals need to be set up. Return to the main screen to finish setup, or turn them off in Settings.');
  const disc = port.gameDisc(root, rom, settings.eclipse);
  makeSaveBackup('before-play');
  // A player who joins plays the host's save: their own memory card stays out of it.
  const saveDir = saves.prepareSaveDirectory(session?.mode === 'join'
    ? saves.guestSaveDirectory(currentSaveDirectory()) : currentSaveDirectory());
  const recordedTools = game.toolRoot(root, settings);
  const playEnv = port.buildEnvironment(settings, disc, root, { customTextures: customTextureDirectory() });
  const env = recordedTools
    ? buildTools.environmentAtRoot(recordedTools, { ...playEnv, SMS_SAVE_DIR: saveDir })
    : toolEnv({ ...playEnv, SMS_SAVE_DIR: saveDir });
  Object.assign(env, port.eclipseMovieEnvironment(root, settings, rom));
  shieldGame(root, settings, env);
  // Changed keys go to a file of the launcher's own, so a bindings.txt kept by hand in the game folder is left alone.
  // A game older than the keyboard and mouse keys gets the whole layout the Controls page shows that way too.
  if (Object.keys(settings.keyBindings || {}).length || Object.keys(settings.padBindings || {}).length ||
      !port.gameFeatures(root).mouseKeys) {
    const file = path.join(app.getPath('userData'), 'bindings.txt');
    fs.writeFileSync(file, bindings.fileText(settings.keyBindings, settings.padBindings));
    env.SMS_BINDINGS = file;
  }
  // The prompt images the Controls page drew from these bindings (save-prompts).
  // Every style's images, Original prompts included: the pause menu's save state hint draws the buttons from them.
  env.SMS_BUTTON_PROMPT_DIR = promptDirectory();
  // What the player changes in the game's settings menu comes back to the launcher (keepGameSettings).
  env.SMS_SETTINGS_SAVE = gameSettings.file(app.getPath('userData'));
  // Unlocks are the player's, in the launcher's folder, so they survive a new game folder.
  // Eclipse's are its own (achievements-eclipse.txt), as are its icons.
  if (achievements.supported(root, settings)) env.SMS_ACHIEVEMENTS = achievements.file(app.getPath('userData'), settings.eclipse);
  // The achievements' icons (updateAchievementIcons), for the game's banner.
  if (port.achievementIconsInstalled(root)) env.SMS_ACHIEVEMENT_ICONS = port.achievementIconsDirectory(root, settings.eclipse);
  if (config.settings.discordPresence) env.SMS_PRESENCE = '1';
  const look = marioLookPack(rom, disc, root, settings);
  if (look) env.SMS_MARIO_LOOK = look;
  Object.assign(env, marioPack.outfitEnvironment(config.marioLook));
  // Together, each game paints the others in their own colours (theirs come over the network).
  if (session && session.mode !== 'coop') Object.assign(env, marioPaintEnvironment(rom, disc, root, settings));
  // The game puts its version in the window title: the launcher's name for the build being played.
  const gameVersion = game.installed(root, settings)?.gameVersion;
  if (gameVersion) env.SMS_GAME_VERSION = String(gameVersion);
  // Mods from the Mods page, beside the game's own mods/ folder.
  Object.assign(env, nativeMods.environment(root, app.getPath('userData')));
  if (session) Object.assign(env, session.env);
  if (portableRoot && !env.SMS_GX_SHADER_CACHE) {
    // The game only makes the folder for its default location.
    env.SMS_GX_SHADER_CACHE = portable.shaderCache(portableRoot, settings.arch);
    fs.mkdirSync(path.dirname(env.SMS_GX_SHADER_CACHE), { recursive: true });
  }
  if (portableRoot && !env.SMS_TEXTURE_PACK_CACHE) env.SMS_TEXTURE_PACK_CACHE = portable.textureCache(portableRoot);
  const cmd = settings.eclipse
    ? port.eclipseRunCommand(root, settings, disc, process.platform, env)
    : port.commandFor(root, 'run', [disc], process.platform, env);
  const startedAt = Date.now();
  startPresence(startedAt, settings.eclipse);
  onAchievement = line => announceAchievement(root, line);
  onGameLine = line => noteRenderer(line, settings);
  try {
    return await launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, 'Play Super Mario Sunshine', true);
  } catch (error) {
    explainDllFailure(error, root, settings, env);
    throw error;
  } finally {
    stopPresence(startedAt);
    onAchievement = null;
    onGameLine = null;
    keepGameSettings();
    try { makeSaveBackup('after-play'); }
    catch (error) { log(`Save backup failed: ${error.message}`); }
  }
}

// Mario's model from the chosen disc, read once per disc while the launcher runs.
let marioCache = null;
function marioFrom(rom) {
  if (marioCache?.rom !== rom) marioCache = { rom, model: marioModel.loadMario(rom) };
  return marioCache.model;
}

// Customize Mario's colours for the game: Mario's textures repainted, as a
// pack the game reads before its texture packs (SMS_MARIO_LOOK). Painted from
// the disc the game plays (Eclipse's own, with Eclipse on), so the names match
// what the game loads, with the preview's colours from the player's disc.
// Made again only when the colours, the disc or the HD images change; never in
// the way of playing. Mario's mouth, which Eclipse's Luigi and Il Piantissimo
// draw too, is painted only for a game that keeps them out of the look.
function marioLookPack(rom, disc, root, settings) {
  const directory = path.join(app.getPath('userData'), 'mario-look');
  const look = marioColors.normalizeLook(config.marioLook);
  if (!look.inGame || !Object.keys(look.colors).length) {
    if (!look.inGame && Object.keys(look.colors).length) log('Mario keeps his usual colours: Use in the game is off in Customize Mario.');
    fs.rmSync(directory, { recursive: true, force: true });
    return null;
  }
  try {
    const started = Date.now();
    const made = marioPack.bake({ rom: disc, look, references: marioFrom(rom).references, directory,
      packDirectories: port.texturePackFolders(settings, root, customTextureDirectory()),
      othersKeepOwn: port.gameFeatures(root).characterLook });
    if (Date.now() - started > 250) log(`Painted Mario in your colours in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
    return made;
  } catch (error) {
    log(`Mario keeps his usual colours: ${error.message}`);
    return null;
  }
}

// Multiplayer: what the game needs to paint the other players in their colours (SMS_MARIO_PAINT, a folder of
// Mario's pictures and their paint maps) and to send its own (SMS_MULTIPLAYER_LOOK). Without them everyone keeps
// their character's colours; never in the way of playing. Painted from the disc the game plays, as marioLookPack
// is (Eclipse's Mario with Eclipse on, in a folder of its own so switching doesn't paint him again).
function marioPaintEnvironment(rom, disc, root, settings) {
  const env = { SMS_MULTIPLAYER_LOOK: marioPack.lookText(config.marioLook) };
  try {
    const started = Date.now();
    env.SMS_MARIO_PAINT = marioPack.bakePaint({ rom: disc, references: marioFrom(rom).references,
      directory: path.join(app.getPath('userData'), settings.eclipse ? 'mario-paint-eclipse' : 'mario-paint'),
      packDirectories: port.texturePackFolders(settings, root, customTextureDirectory()) });
    if (Date.now() - started > 250) log(`Got Mario ready to paint the other players in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  } catch (error) {
    log(`The other players keep their characters' colours: ${error.message}`);
  }
  return env;
}

// Custom textures (port.customTextureDirectory): the player's own texture packs, in the launcher's folder
// (the portable folder for the portable launcher).
function customTextureDirectory() { return port.customTextureDirectory(app.getPath('userData')); }

// Time spent in the game, in milliseconds, for Discord; kept apart from preferences.
function playtimeFile() { return path.join(app.getPath('userData'), 'playtime.json'); }

function playtime() {
  try {
    const { ms } = JSON.parse(fs.readFileSync(playtimeFile(), 'utf8'));
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  } catch (_) { return 0; }
}

// The Achievements page: every achievement of the game folder's list, and the player's unlocks;
// without the icons, the tab offers to download them first.
function achievementsState() {
  const root = config.repo && fs.existsSync(config.repo) ? config.repo : null;
  const seen = config.achievementsSeen;
  if (!root) return { supported: false, achievements: [], unlocked: 0, total: 0, iconsNeeded: false, seen };
  return { ...achievements.state(root, config.settings, app.getPath('userData')),
    iconsNeeded: port.achievementIconsWanted(root, config.settings), seen };
}
// The Achievements tab stands out until it is first opened.
function markAchievementsSeen() {
  if (config.achievementsSeen) return;
  config.achievementsSeen = true;
  saveConfig();
}

// Small copies of the icons for the page (the files are 512 px), made once each.
const achievementIconCache = new Map();
function achievementIcons() {
  const root = config.repo && fs.existsSync(config.repo) ? config.repo : null;
  if (!root || !port.achievementIconsInstalled(root)) return {};
  const eclipse = Boolean(config.settings.eclipse);
  const directory = port.achievementIconsDirectory(root, eclipse), icons = {};
  for (const { id } of achievements.readList(root, eclipse) || []) {
    const fileName = achievements.iconFile(directory, id);
    if (!achievementIconCache.has(fileName)) {
      const image = nativeImage.createFromPath(fileName);
      achievementIconCache.set(fileName, image.isEmpty() ? null : image.resize({ width: 128, quality: 'best' }).toDataURL());
    }
    if (achievementIconCache.get(fileName)) icons[id] = achievementIconCache.get(fileName);
  }
  return icons;
}

// An unlock as it happens: the page marks it at once, and the log says which.
function announceAchievement(root, line) {
  const unlock = achievements.parseLine(line);
  if (!unlock) return;
  const item = (achievements.readList(root, unlock.eclipse) || []).find(entry => entry.id === unlock.id);
  log(`🏆 Achievement unlocked: ${item ? item.title : `#${unlock.id}`}`);
  broadcast('achievement', unlock);
}

// Discord shows the game only while it runs, and only with the setting on. In a room game (hosted or joined) it is
// one friends can be invited to from Discord: `discordParty`, { code, players, maxPlayers, public }.
let presenceShown = null, discordParty = null;
function showPresence() {
  if (!presenceShown || !discordPresence) return;
  const { game, startedAt, eclipse, before } = presenceShown;
  discordPresence.set(presence.activity(game, { startedAt, eclipse, playtime: before + Date.now() - startedAt, party: discordParty }));
}

function setDiscordParty(party) {
  discordParty = party;
  showPresence();
}

function startPresence(startedAt, eclipse) {
  if (!config.settings.discordPresence) return;
  discordClient();
  presenceShown = { game: null, startedAt, eclipse, before: playtime() };
  onPresence = line => {
    const game = presence.parseLine(line);
    if (game && presenceShown) { presenceShown.game = game; showPresence(); }
  };
  showPresence();
}

function stopPresence(startedAt) {
  onPresence = null;
  presenceShown = null;
  discordPresence?.stop();
  try { fs.writeFileSync(playtimeFile(), JSON.stringify({ ms: playtime() + Date.now() - startedAt })); }
  catch (error) { log(`Could not save play time: ${error.message}`); }
}

// Update & play asks for the update even when updates are not automatic.
async function launchGame(session = null, update = config.settings.autoUpdate) {
  requireRepo();
  port.validateRom(config.rom);
  if (!buildReady() || (update && !game.isCurrent(config.repo, config.settings, currentSource()))) await build();
  if (!port.hdVisualsInstalled(config.repo, config.settings)) await installTextures();
  else await updateTextureExtras(config.repo, config.settings);
  await updateLanguagePack(config.repo, config.settings);
  await updateEclipseMaps(config.repo, config.settings);
  await updateAchievementIcons(config.repo, config.settings);
  // last checks, with the game as it will run (multiplayer: the network check is done, the host's version matches)
  if (session?.beforePlay) await session.beforePlay();
  return play(null, session);
}

// The Multiplayer window's fields, kept for next time. Host Game and Join throw a sentence for a field that is wrong
// (`strict`); saving as the player types keeps the last good port or player count instead, so the other fields are
// still kept.
function saveMultiplayer(input = {}, { strict = true } = {}) {
  const checked = parse => (text, previous) => {
    if (text === undefined) return previous;
    try { return parse(text); } catch (error) { if (strict) throw error; return previous; }
  };
  const portField = checked(multiplayer.parsePort), mostField = checked(multiplayer.parseMaxPlayers);
  const value = { name: multiplayer.playerName(input.name, ''), address: String(input.address ?? config.multiplayer.address).trim().slice(0, 255),
    hostPort: portField(input.hostPort, config.multiplayer.hostPort), joinPort: portField(input.joinPort, config.multiplayer.joinPort),
    maxPlayers: mostField(input.maxPlayers, config.multiplayer.maxPlayers ?? multiplayer.DEFAULT_MAX_PLAYERS),
    public: typeof input.public === 'boolean' ? input.public : config.multiplayer.public === true,
    collision: typeof input.collision === 'boolean' ? input.collision : config.multiplayer.collision === true,
    recent: config.multiplayer.recent || [] };
  config.multiplayer = value;
  saveConfig();
  return value;
}

// The game build a host must also be running for this game to join it: the
// game's commit (as the game names its build), with Eclipse marked.
function localGameBuild() {
  const installed = config.repo && game.installed(config.repo, config.settings);
  if (!installed?.commit) return null;
  return `${installed.commit.slice(0, 12)}${config.settings.eclipse ? '-eclipse' : ''}`;
}

// This player's game build, game version and launcher version, to compare with a host's and to show both when they
// differ. `built` false: the game is about to be built or updated, so its build is compared after that (null here).
function localVersions(built = true) {
  const installed = built && config.repo && game.installed(config.repo, config.settings);
  return { build: built ? localGameBuild() : null, version: installed?.gameVersion || currentSource().version || null,
    launcher: app.getVersion() };
}

// The network check (src/nat.js) holds the port a hosted game listens on for a few seconds: one runs at a time, and
// Host Game waits for it to let go of the port.
let natCheck = null, lastNat = null;
function checkNat(input) {
  if (!natCheck) {
    let port = multiplayer.DEFAULT_PORT;
    try { port = multiplayer.parsePort(input?.port); } catch (_) { /* the default */ }
    natCheck = nat.detect({ port }).then(result => {
      // what to give friends: the public address with the port players reach (the hosting port, or the router's
      // own when it showed the port open under another number), as an invite code too, and the address on this network
      const reach = result.canHost && result.publicPort && !result.portBusy ? result.publicPort : port;
      const lan = multiplayer.lanAddresses()[0] || null;
      result.share = result.publicAddress ? { address: result.publicAddress, port: reach,
        invite: multiplayer.inviteCode(result.publicAddress, reach), lan: lan && `${lan}:${port}` } : null;
      lastNat = result;
      return result;
    }).finally(() => { natCheck = null; });
  }
  return natCheck;
}

// Discord game invites. The launcher stays connected to Discord while it is open (with the Discord setting on), so a
// friend's invite accepted in Discord joins their room here; with the launcher closed, Discord starts it first.
function discordClient() {
  return discordPresence ||= discord.createPresence({ log, onJoin: joinFromDiscord, onJoinRequest: discordJoinRequest });
}

function syncDiscord() {
  if (config.settings.discordPresence) registerDiscordLaunch();
  if (config.settings.discordPresence || launchedByDiscord) discordClient().listen(true);
  else discordPresence?.listen(false);
}

function startedByDiscord() {
  launchedByDiscord = true;
  if (app.isReady() && config) syncDiscord();
}

// What Discord runs to start the launcher: the installed launcher, the portable .exe or the AppImage (Linux, like
// Steam's shortcut, with --no-sandbox). Not in development, where it would start Electron.
let discordLaunchRegistered = false;
function registerDiscordLaunch() {
  if (discordLaunchRegistered || !app.isPackaged) return;
  discordLaunchRegistered = true;
  const { execPath } = relaunchOptions({ argv: [], env: process.env, packaged: true, platform: process.platform, execPath: process.execPath });
  try {
    discord.registerLaunch({ execPath, args: process.platform === 'linux' ? ['--no-sandbox'] : [],
      setProtocolClient: (scheme, file, args) => app.setAsDefaultProtocolClient(scheme, file, args) });
  } catch (error) { log(`Discord can't start the launcher from a game invite: ${error.message}`); }
}

// An accepted invite: the Multiplayer page joins the room (the renderer takes it, now or once it has loaded).
let discordJoin = null;
function joinFromDiscord(secret) {
  const code = rooms.parseRoomCode(presence.secretRoom(secret));
  if (!code) return log("Discord sent a game invite this launcher can't read: is the launcher up to date?");
  discordJoin = rooms.formatRoomCode(code);
  log(`Joining room ${discordJoin} from a Discord invite.`);
  showWindow();
  broadcast('discord-join');
}

// A friend's "Ask to Join" on Discord: let in at once to a public game (anyone can join it from the list), otherwise
// when the player clicks the notification. Notifications are kept until they close, so their click still arrives.
const joinNotifications = new Set();
function discordJoinRequest(user) {
  const who = multiplayer.playerName(user.global_name || user.username, 'A friend');
  if (!discordParty) return discordPresence.reply(user.id, false);
  if (discordParty.public) {
    log(`${who} asked on Discord to join your public game: invited.`);
    return discordPresence.reply(user.id, true);
  }
  log(`${who} asked on Discord to join your game.`);
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: `${who} asks to join your game`, body: 'Click to invite them through Discord.' });
  joinNotifications.add(note);
  note.on('click', () => {
    if (discordParty && discordPresence?.reply(user.id, true)) log(`Invited ${who} through Discord.`);
  });
  note.on('close', () => joinNotifications.delete(note));
  note.show();
}

// Host Game: plays like Play, with the game listening for players on this computer and the launcher passing their
// packets on from the chosen port (src/rooms.js), so friends can join with a room code and no port forwarding.
async function hostGame(input) {
  const settings = saveMultiplayer(input);
  const name = multiplayer.playerName(settings.name, 'Host');
  let room = null;
  const showRoom = (code, changed) => {
    hostedRoom = rooms.formatRoomCode(code);
    setDiscordParty({ code, players: discordParty?.players || 1, maxPlayers: settings.maxPlayers, public: settings.public });
    clipboard.writeText(hostedRoom);
    log(changed ? `Your room code changed to ${hostedRoom} (copied). Give friends the new one.`
      : `Room code ${hostedRoom} (copied): friends join with it from their Multiplayer window.`);
    broadcast('activity', activityState());
  };
  const session = { mode: 'host', env: multiplayer.environment('host', { port: settings.hostPort, name, maxPlayers: settings.maxPlayers,
    collision: settings.collision, versions: localVersions() }),
    beforePlay: async () => {
      await natCheck?.catch(() => {});
      const { build, version, launcher } = localVersions();
      room = await rooms.host({ port: settings.hostPort, name, build, version, launcher, isPublic: settings.public, log,
        onRoom: showRoom, onStatus: config.settings.discordPresence ? info => discordParty
          && setDiscordParty({ ...discordParty, players: info.players, maxPlayers: info.maxPlayers }) : null });
      Object.assign(session.env, { SMS_MULTIPLAYER_PORT: String(room.gamePort), SMS_MULTIPLAYER_LOCAL: '1',
        SMS_MULTIPLAYER_ROOM: room.code ? rooms.formatRoomCode(room.code) : '' });
    } };
  log(`Hosting a multiplayer game for up to ${settings.maxPlayers} players on UDP port ${settings.hostPort}${settings.public ? ', listed publicly' : ''}.`);
  try { return await launchGame(session); }
  finally {
    room?.close();
    hostedRoom = null;
    setDiscordParty(null);
    broadcast('activity', activityState());
  }
}

// The public list, for the Multiplayer window: each game with why it can't be joined from here (another version, or
// full), or null. A game whose host may take this build (the room server didn't say) can be tried: its game decides.
async function publicGames() {
  const list = await rooms.listPublic();
  setPublicOnline(list);
  const mine = localVersions();
  return list.map(room => ({ code: rooms.formatRoomCode(room.code), name: multiplayer.playerName(room.name, 'Host'),
    status: String(room.status || '').slice(0, 63), players: room.players, maxPlayers: room.maxPlayers, minutes: room.minutes,
    problem: multiplayer.hostDecides(room, mine) ? null : multiplayer.joinProblem(room, mine) }));
}

// Players in public games right now, shown on the Multiplayer tab (hidden at 0) as a sign someone is playing. The
// list is checked every two minutes while the window shows, and whenever the Multiplayer page loads it; a check
// is skipped when the page's own refresh has just loaded the list.
const PUBLIC_ONLINE_EVERY = 2 * 60 * 1000;
let publicOnline = null, publicOnlineTimer = null, publicOnlineAt = 0;
function setPublicOnline(list) {
  if (list) publicOnlineAt = Date.now();
  const value = list && rooms.publicPlayers(list, rooms.parseRoomCode(hostedRoom));
  if (JSON.stringify(value) === JSON.stringify(publicOnline)) return;
  publicOnline = value;
  broadcast('public-online', publicOnline);
}
async function checkPublicOnline({ fresh = PUBLIC_ONLINE_EVERY / 2 } = {}) {
  if (!window || window.isDestroyed() || !window.isVisible() || window.isMinimized()) return;
  if (Date.now() - publicOnlineAt < fresh) return;
  // Offline, or the server can't answer: no count rather than an old one.
  try { setPublicOnline(await rooms.listPublic()); } catch (_) { setPublicOnline(null); }
}
function watchPublicOnline() {
  clearInterval(publicOnlineTimer);
  publicOnlineTimer = setInterval(checkPublicOnline, PUBLIC_ONLINE_EVERY);
  checkPublicOnline();
}

// "Ping": how long a host's game takes to answer, the way a join would reach it (for a room code: connected like a
// join, directly or through the relay, then let go). Pings of the same game share one check.
const pings = new Map();
function pingGame(input = {}) {
  const code = rooms.parseRoomCode(input.address);
  const target = code ? null : multiplayer.parseAddress(input.address, input.port);
  const id = code || `${target.host}:${target.port}`;
  if (!pings.has(id)) pings.set(id, (async () => {
    const mine = localVersions();
    let info, mode = null;
    if (code) {
      const room = await rooms.lookup(code);
      const link = await rooms.join({ code, name: multiplayer.playerName(config.multiplayer.name), check: true });
      try { info = { ...room, ...await multiplayer.probe('127.0.0.1', link.localPort, { timeout: 3000 }) }; }
      catch (_) { throw new Error('Reached the host, but their game didn\'t answer. Check that it\'s still running.'); }
      finally { link.close(); }
      mode = link.mode;
    } else {
      info = await multiplayer.probe(target.host, target.port, { timeout: 3000 });
    }
    return { name: multiplayer.playerName(info.name, 'Host'), players: info.players, maxPlayers: info.maxPlayers,
      status: String(info.status || '').slice(0, 63), ping: info.ping, mode, problem: multiplayer.joinProblem(info, mine) };
  })().finally(() => pings.delete(id)));
  return pings.get(id);
}

// The log's line for a host's game: "Chase's game: 2 of 8 players, in Bianco Hills, ping 42 ms".
function hostedLine(info, nobody = 'The host') {
  return `${info.name || nobody}'s game: ${info.players} of ${info.maxPlayers} players${info.status ? `, in ${info.status}` : ''}`
    + (Number.isFinite(info.ping) ? `, ping ${multiplayer.formatPing(info.ping)}` : '');
}

// Join with a room code: the room server says whose game it is and which build it runs, then the launcher connects
// to the host's launcher (src/rooms.js) and the game joins through it, on this computer.
async function joinRoom(code, settings) {
  const shown = rooms.formatRoomCode(code);
  const check = async mine => {
    const info = await rooms.lookup(code);
    const room = { ...info, open: true, players: 0, maxPlayers: multiplayer.MAX_PLAYERS };
    // another build the host may take (the room server didn't say): its game's answer, once connected, decides
    const problem = multiplayer.hostDecides(room, mine) ? null : multiplayer.joinProblem(room, mine);
    if (problem) throw new Error(problem);
    return info;
  };
  log(`Looking for room ${shown}…`);
  const updateDue = !buildReady() || (config.settings.autoUpdate && !game.isCurrent(config.repo, config.settings, currentSource()));
  const info = await check(localVersions(!updateDue));
  log(`Found ${info.name || 'the host'}'s room. ${updateDue ? 'Updating the game first, then joining it.' : 'Connecting…'}`);
  const name = multiplayer.playerName(settings.name);
  let link = null;
  const session = { mode: 'join', env: {},
    beforePlay: async () => {
      if (updateDue) await check(localVersions());
      link = await rooms.join({ code, name, log });
      log(link.mode === 'relay' ? 'Connected through the relay, which adds a little delay: your networks couldn\'t connect '
        + 'directly. If the host forwards their UDP port on their router, you\'ll connect directly.'
        : `Connected ${link.mode === 'lan' ? 'over your local network' : 'directly over the internet'}.`);
      let hosted;
      try { hosted = await multiplayer.probe('127.0.0.1', link.localPort); }
      catch (_) { throw new Error('Reached the host, but their game didn\'t answer. Check that it\'s still running.'); }
      // the room server's word on the host's versions, for a message about a different one
      const problem = multiplayer.joinProblem({ ...info, ...hosted }, localVersions());
      if (problem) throw new Error(problem);
      log(`${hostedLine(hosted)}. Starting the game to join it.`);
      session.env = multiplayer.environment('join', { host: '127.0.0.1', port: link.localPort, name, versions: localVersions() });
      // friends can be invited from Discord too (the count is the one at joining)
      setDiscordParty({ code, players: hosted.players + 1, maxPlayers: hosted.maxPlayers, public: false });
    } };
  try { return await launchGame(session); }
  finally { link?.close(); setDiscordParty(null); }
}

// Join: finds the host's game first, so a wrong address or a full game is reported before anything else happens.
// The versions are compared with the game as it will run: after an update, if one is due, the host is asked again.
async function joinGame(input) {
  const settings = saveMultiplayer(input);
  const code = rooms.parseRoomCode(settings.address);
  if (code) return joinRoom(code, settings);
  const target = multiplayer.parseAddress(settings.address, settings.joinPort);
  const find = async mine => {
    // the log is often pasted in public: the host's address is not written out in full
    log(`Looking for a multiplayer game at ${multiplayer.maskAddress(target.host)}:${target.port}…`);
    let info;
    try { info = await multiplayer.probe(target.host, target.port); }
    catch (error) {
      // from inside the host's own network their public address usually doesn't answer (the router won't loop it back)
      if (lastNat?.publicAddress && lastNat.publicAddress === target.host)
        throw new Error(`${error.message} You and the host seem to be on the same network: use the "Same Wi-Fi" address `
          + 'from their Multiplayer window instead.');
      throw error;
    }
    const problem = multiplayer.joinProblem(info, mine);
    if (problem) throw new Error(problem);
    return info;
  };
  const updateDue = !buildReady() || (config.settings.autoUpdate && !game.isCurrent(config.repo, config.settings, currentSource()));
  const info = await find(localVersions(!updateDue));
  config.multiplayer.recent = multiplayer.rememberHost(config.multiplayer.recent, { ...target, name: info.name });
  saveConfig();
  log(`Found ${hostedLine(info, 'the host')}. `
    + (updateDue ? 'Updating the game first, then joining it.' : 'Starting the game to join it.'));
  return launchGame({ mode: 'join', env: multiplayer.environment('join', { ...target, name: multiplayer.playerName(settings.name), versions: localVersions() }),
    beforePlay: updateDue ? () => find(localVersions()) : null });
}

// Why `--play` opens the launcher instead of the game, or null if the game can start as it is.
function directPlayBlocker() {
  if (!port.isPort(config.repo) || !binaryReady()) return 'the game is not set up yet.';
  try { port.validateRom(config.rom); } catch (error) { return error.message; }
  if (!buildReady()) return 'the game needs building again to draw with Vulkan.';
  if (config.settings.autoUpdate && !game.isCurrent(config.repo, config.settings, currentSource()))
    return 'a game update is ready.';
  if (!port.hdVisualsInstalled(config.repo, config.settings)) return 'HD visuals need to be set up.';
  return null;
}

// Plays with the launcher's settings, without downloading or building anything.
// False when the launcher should open: the game needs setup or an update, or it
// failed (the activity log shows why).
async function playDirectly() {
  const blocker = directPlayBlocker();
  if (blocker) {
    log(`Opened the launcher instead of the game: ${blocker}`);
    return false;
  }
  try { await exclusive('Play Super Mario Sunshine', () => play(), true); }
  catch (_) { return false; }
  return true;
}

// Split-screen co-op: one game, two players on this computer. The game runs as ever with the first player
// on the keyboard or a controller; a second player joins by pressing Start on another controller (SMS_COOP).
// Plain Play never takes a second player, so a controller's Start there is only ever the pause menu.
async function playCoop() {
  const root = requireRepo();
  if (fs.existsSync(port.binaryPath(root, config.settings)) && !port.gameFeatures(root).coop && !config.settings.autoUpdate)
    throw new Error('This game version has no co-op yet. Update the game (Update & play) to play co-op.');
  log('Co-op: player 2 presses START on another controller to join as Luigi, and holds START to leave.');
  return launchGame({ mode: 'coop', env: { SMS_COOP: '1' },
    beforePlay: async () => {
      if (!port.gameFeatures(config.repo).coop) throw new Error('This game version has no co-op yet. Update the game to play co-op.');
    } });
}

async function playInstalled() {
  const root = requireRepo();
  // Playing without setup uses only packs already on disk. Keep the player's
  // preferences so choosing setup later still installs the requested visuals.
  const settings = { ...config.settings,
    textures: config.settings.textures && port.texturePackInstalled(root),
    cutscenes: config.settings.cutscenes && port.cutscenePackInstalled(root) };
  if (settings.textures !== config.settings.textures || settings.cutscenes !== config.settings.cutscenes)
    log('Playing the installed game without missing HD downloads. Your visual settings are saved for later setup.');
  return play({ repo: root, settings });
}

async function clean(dryRun) {
  await ensureBuildTools();
  const root = requireRepo();
  if (!dryRun && saves.cleanupWouldRemoveSaves(root, currentSaveDirectory()))
    throw new Error('Your memory card is inside a build folder. Move it outside the build folders before cleanup.');
  if (!dryRun) makeSaveBackup('before-cleanup');
  const env = toolEnv();
  delete env.SMS_ARCH;
  const cmd = port.commandFor(root, 'clean', dryRun ? ['--dry-run'] : [], process.platform, env);
  const result = await launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, dryRun ? 'Preview cleanup' : 'Clean build output');
  if (dryRun) return result;
  // The compiler cache and the Eclipse downloads are made again by the next builds too.
  try {
    await compilerCache.clear(app.getPath('userData'));
    for (const folder of new Set([game.eclipseSourcesPath(app.getPath('userData')), eclipseSourcesDirectory()]))
      await fs.promises.rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    log('Removed the compiler cache and the downloaded Super Mario Eclipse sources.');
  } catch (error) { log(`Could not remove the compiler cache: ${error.message}`); }
  await removeOldBuildTools();
  return result;
}

function state() {
  const info = port.platformInfo();
  let romError = '';
  if (config.rom) { try { port.validateRom(config.rom); } catch (error) { romError = error.message; } }
  const repoReady = port.isPort(config.repo);
  const ready = repoReady && binaryReady();
  const installedBuild = ready ? game.installed(config.repo, config.settings) : null;
  const features = port.gameFeatures(repoReady ? config.repo : null);
  return {
    config, platform: info, repoReady, portable: Boolean(portableRoot), pathProblem: blockedPath || pathProblem(),
    // Where the build tools download: the launcher's data folder, wherever the game is installed.
    toolsFolder: path.dirname(buildTools.rootFor(app.getPath('userData'))),
    features,
    // A Mac with Apple Silicon playing through Rosetta moves to the native build, as a new setup has it,
    // once its game has that build (for Eclipse, once it builds Eclipse too).
    switchAppleSilicon: info.arches.includes('arm64') && config.completedSetup && config.settings.arch === '64' && features.appleSilicon &&
      (config.settings.eclipse ? !config.eclipseAppleSiliconSwitched && features.eclipseAppleSilicon : !config.appleSiliconSwitched),
    romReady: Boolean(config.rom) && !romError, romError,
    eclipseInstalled: repoReady && fs.existsSync(path.join(config.repo, port.ECLIPSE_ISO)),
    hdVisualsReady: repoReady && port.hdVisualsInstalled(config.repo, config.settings),
    texturesInstalled: repoReady && port.texturePackInstalled(config.repo),
    cutscenesInstalled: repoReady && port.cutscenePackInstalled(config.repo),
    cutscenesSupported: repoReady && port.cutscenePackSupported(config.repo),
    languagesSupported: repoReady && port.languagePacksSupported(config.repo),
    languages: port.languageChoices(repoReady ? config.repo : null),
    languageInstalled: repoReady && config.settings.language !== 'en' && port.languagePackInstalled(config.repo, config.settings.language),
    cutsceneRequirements: repoReady ? port.cutscenePackRequirements(config.repo) : null,
    binaryReady: ready,
    // Vulkan was picked but the game draws with OpenGL: its build has none (building again didn't bring it),
    // or Vulkan couldn't start the last time it was played (why).
    renderer: config.settings.renderer === 'vulkan'
      ? { vulkanMissing: ready && game.vulkanMissing(config.repo, config.settings), vulkanFailed: config.vulkanFailed }
      : { vulkanMissing: false, vulkanFailed: null },
    tools: toolsStatus(),
    gameSource: config.gameSource ? { override: config.gameSource.override, version: config.gameSource.resolved.version } : null,
    game: { launcherVersion: app.getVersion(), availableVersion: currentSource().version,
      installedVersion: installedBuild?.gameVersion || null,
      installedToolVersion: installedBuild?.toolVersion || null,
      toolVersion: buildTools.toolsetFor(), needsUpdate: repoReady && !game.isCurrent(config.repo, config.settings, currentSource()),
      previousReady: Boolean(config.previousInstall && binaryReady(config.previousInstall.repo, config.previousInstall.settings)) },
    active: activityState(), appUpdate, online, publicOnline, logs: activityLog.snapshot(), logResetSequence: activityLog.resetSequence(),
    saveDirectory: currentSaveDirectory(), backupDirectory: saves.backupRoot(),
    backups: saves.listBackups().filter(item => item.source === currentSaveDirectory())
  };
}

// Stable never sees a pre-release. Beta and pull request previews are opt-in,
// and may be older than what is installed, so leaving one can go back down.
function applyUpdateChannel() {
  if (!updater) return;
  const channel = config.settings.updateChannel;
  const url = process.env.SMS_LAUNCHER_UPDATE_URL;
  updater.setFeedURL(url ? { provider: 'generic', url } : updateChannel.feedFor(channel));
  updater.channel = 'latest';
  updater.allowPrerelease = channel !== 'stable';
  updater.allowDowngrade = channel !== 'stable' || app.getVersion().includes('-');
}

async function checkAppUpdate() {
  if (!updater) return appUpdate;
  try { await updater.checkForUpdates(); }
  catch (error) {
    const missing = config.settings.updateChannel !== 'stable' && /\b404\b/.test(error.message);
    appUpdate = { state: 'error', message: missing
      ? `${updateChannel.channelLabel(config.settings.updateChannel)} is no longer available. Choose another update channel in Settings.`
      : `Launcher update check failed: ${error.message}` };
    broadcast('app-update', appUpdate);
    log(appUpdate.message);
  }
  return appUpdate;
}

async function updateChannels() {
  let releases = null;
  try {
    const response = await net.fetch(`https://api.github.com/repos/${updateChannel.REPOSITORY}/releases?per_page=100`,
      { headers: { Accept: 'application/vnd.github+json' } });
    if (response.ok) releases = await response.json();
  } catch (_) { /* offline: Stable, Beta and the current choice are still offered */ }
  const channels = updateChannel.channelsFromReleases(releases);
  const chosen = config.settings.updateChannel;
  if (!channels.some(item => item.id === chosen))
    channels.push({ id: chosen, label: updateChannel.channelLabel(chosen), detail: 'No longer available', missing: true });
  return channels;
}

let releaseNotes = null;
// The published changelog, or the copy bundled with this launcher when GitHub
// cannot be reached. Development runs read the local file so edits show.
async function loadChangelog() {
  if (releaseNotes) return releaseNotes;
  let bundled = changelog.normalize(null);
  try { bundled = changelog.normalize(JSON.parse(fs.readFileSync(path.join(__dirname, '..', changelog.FILE), 'utf8'))); }
  catch (error) { log(`Could not read the bundled changelog: ${error.message}`); }
  if (!app.isPackaged && !process.env.SMS_CHANGELOG_URL) return (releaseNotes = bundled);
  try {
    const response = await net.fetch(changelog.url(), { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    releaseNotes = changelog.merge(changelog.normalize(await response.json()), bundled);
    return releaseNotes;
  } catch (error) {
    log(`Showing the changelog bundled with this launcher: ${error.message}`);
    return bundled;
  }
}

let betaShown = null;
async function changelogState() {
  const { releases, beta } = await loadChangelog();
  const options = { current: app.getVersion(), returning: config.completedSetup };
  betaShown = changelog.isBeta(app.getVersion()) ? beta : null;
  return { releases, current: changelog.baseVersion(app.getVersion()),
    unseen: changelog.unseen(releases, { ...options, seen: config.changelogSeen }).map(release => release.version),
    beta: betaShown && { ...betaShown, unseen: changelog.unseenBeta(betaShown, { ...options, seen: config.changelogBetaSeen }) } };
}

// The release only moves forward, so leaving a preview for an older release
// and coming back does not repeat notes already shown.
function markChangelogSeen() {
  const version = changelog.baseVersion(app.getVersion());
  const betaKey = changelog.betaKey(betaShown);
  const newer = version && (!config.changelogSeen || changelog.compareVersions(version, config.changelogSeen) > 0);
  if (!newer && (!betaKey || betaKey === config.changelogBetaSeen)) return;
  if (newer) config.changelogSeen = version;
  if (betaKey) config.changelogBetaSeen = betaKey;
  saveConfig();
}

function heartbeatPayload() {
  const installed = port.isPort(config.repo) && binaryReady() ? game.installed(config.repo, config.settings) : null;
  return telemetry.payload({ installId: config.installId, launcherVersion: app.getVersion(),
    gameVersion: installed?.gameVersion, availableVersion: currentSource().version,
    channel: config.settings.updateChannel, playing: active?.label === 'Play Super Mario Sunshine' });
}

// Development runs stay out of the numbers unless pointed at a test API.
function setupTelemetry() {
  const url = telemetry.endpoint();
  if (!url || (!app.isPackaged && !process.env.SMS_TELEMETRY_URL)) return;
  reporter = telemetry.createReporter({
    url, fetch: (target, options) => net.fetch(target, options),
    sharing: () => config.settings.shareUsage, getPayload: heartbeatPayload,
    onCount: count => { online = count; broadcast('online', online); }
  });
  reporter.start();
}

function setupAppUpdater() {
  const url = process.env.SMS_LAUNCHER_UPDATE_URL;
  const bundledFeed = fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
  // The updater would replace a portable launcher with the installer build.
  if (portableRoot) {
    appUpdate = portable.updateNotice(app.getVersion(), null);
    const check = async () => {
      try {
        const response = await net.fetch(`https://api.github.com/repos/${updateChannel.REPOSITORY}/releases/latest`,
          { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
        if (response.ok) {
          const before = appUpdate.state;
          appUpdate = portable.updateNotice(app.getVersion(), (await response.json())?.tag_name);
          broadcast('app-update', appUpdate);
          if (appUpdate.state === 'available' && before !== 'available') log(appUpdate.message);
        }
      } catch (_) { /* offline, or GitHub's hourly limit: keep the last notice */ }
      return appUpdate;
    };
    if (app.isPackaged) setTimeout(() => { if (config.settings.autoUpdate) check(); }, 10000);
    ipcMain.handle('check-app-update', check);
    return;
  }
  if (!app.isPackaged || (!url && !bundledFeed) || (process.platform === 'linux' && !process.env.APPIMAGE)) {
    appUpdate = { state: 'unconfigured', message: app.isPackaged ? 'Launcher updates are unavailable for this install.' : 'Launcher updates come with new releases.' };
    ipcMain.handle('check-app-update', () => appUpdate);
    return;
  }
  ({ autoUpdater: updater } = require('electron-updater'));
  // Updates keep the AppImage's name and folder, so Steam shortcuts to it keep working
  if (process.platform === 'linux') appImageUpdate.keepAppImagePath(updater);
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  applyUpdateChannel();
  const set = (state, message) => {
    appUpdate = { state, message }; broadcast('app-update', appUpdate);
    if (state !== 'downloading' || !message.startsWith('Downloading launcher update:')) log(message);
  };
  updater.on('checking-for-update', () => set('checking', 'Checking launcher updates…'));
  updater.on('update-available', info => set('downloading', `Downloading launcher ${info.version}…`));
  updater.on('update-not-available', () => set('current', 'Launcher is up to date.'));
  updater.on('download-progress', progress => set('downloading', `Downloading launcher update: ${Math.round(progress.percent)}%`));
  updater.on('update-downloaded', info => set('ready', `Launcher ${info.version} downloaded; it will install when you quit.`));
  updater.on('error', error => set('error', `Launcher update check failed: ${error.message}`));
  const check = () => { if (config.settings.autoUpdate) checkAppUpdate(); };
  setTimeout(check, 10000);
  setInterval(check, 30 * 60 * 1000);
  ipcMain.handle('check-app-update', () => checkAppUpdate());
  ipcMain.handle('install-app-update', () => {
    if (appUpdate.state !== 'ready') throw new Error('No launcher update is ready to install.');
    if (operation || active) throw new Error('Finish the current task or close the game before installing the update.');
    // Install silently, then relaunch from the installer itself. Opening the
    // launcher by hand while the installer still runs gets that copy closed.
    updater.quitAndInstall(true, true);
  });
}

function registerHandlers() {
  ipcMain.handle('copy-activity-log', () => {
    clipboard.writeText(sessionLog.read([...partialOutput.values()].sort((a, b) => a.id - b.id)));
    return { copied: true };
  });
  ipcMain.handle('save-activity-log', async () => {
    const chosen = await dialog.showSaveDialog(window, { title: 'Save activity log',
      defaultPath: path.join(app.getPath('downloads'), 'SMS-activity.log'),
      filters: [{ name: 'Activity log', extensions: ['log'] }] });
    if (chosen.canceled || !chosen.filePath) return { cancelled: true };
    sessionLog.save(chosen.filePath, [...partialOutput.values()].sort((a, b) => a.id - b.id));
    return { saved: true };
  });
  const senderWindow = event => BrowserWindow.fromWebContents(event.sender);
  ipcMain.handle('window-state', event => {
    const target = senderWindow(event);
    return { fullscreen: target?.isFullScreen() || false, minimized: target?.isMinimized() || false };
  });
  ipcMain.handle('window-minimize', event => {
    const target = senderWindow(event);
    target?.minimize();
    return { minimized: target?.isMinimized() || false };
  });
  ipcMain.handle('window-toggle-full-screen', event => {
    const target = senderWindow(event);
    if (!target) return { fullscreen: false };
    target.setFullScreen(!target.isFullScreen());
    return { fullscreen: target.isFullScreen() };
  });
  ipcMain.handle('window-close', event => senderWindow(event)?.close());
  ipcMain.handle('state', async () => { await checkTools(); return state(); });
  ipcMain.handle('check-tools', async () => { await checkTools(true); return state(); });
  ipcMain.handle('copy-mac-command', (_event, index) => {
    if (process.platform !== 'darwin') throw new Error('This help is for macOS.');
    const commands = toolsStatus().commands.split('\n').filter(Boolean);
    if (!Number.isInteger(index) || !commands[index]) throw new Error('Check your Mac tools again.');
    clipboard.writeText(commands[index]);
  });
  // The button prompt strips the renderer drew (src/prompts.js), one PNG per style.
  ipcMain.handle('save-prompts', (_event, images) => {
    const dir = promptDirectory();
    fs.mkdirSync(dir, { recursive: true });
    for (const style of prompts.DRAWN) {
      const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(images?.[style] || '');
      if (match) fs.writeFileSync(path.join(dir, `${style}.png`), Buffer.from(match[1], 'base64'));
    }
  });
  ipcMain.handle('save-settings', async (_event, input) => {
    if (operation || active) throw new Error('Finish the current task before changing settings.');
    const settings = port.normalizeSettings(input, process.platform, process.arch, port.gameFeatures(port.isPort(config.repo) ? config.repo : null));
    // Turning Eclipse on with a disc it can't patch says so now, not midway through setup.
    if (settings.eclipse && !config.settings.eclipse && !fs.existsSync(path.join(config.repo, port.ECLIPSE_ISO))) {
      let rom = null;
      try { rom = port.validateRom(config.rom); } catch (_) { /* no usable disc yet: setup checks it later */ }
      if (rom) await checkEclipseDisc(rom);
      if (operation || active) throw new Error('Finish the current task before changing settings.');
    }
    if (settings.arch !== config.settings.arch || settings.eclipse !== config.settings.eclipse)
      config.previousInstall = port.playableInstall({ ...config, saveDirectory: currentSaveDirectory() }) || config.previousInstall;
    const channelChanged = settings.updateChannel !== config.settings.updateChannel;
    const sharingChanged = settings.shareUsage !== config.settings.shareUsage;
    const discordChanged = settings.discordPresence !== config.settings.discordPresence;
    config.settings = settings;
    saveConfig();
    if (sharingChanged) reporter?.tick();
    if (discordChanged) syncDiscord();
    if (channelChanged) {
      applyUpdateChannel();
      log(`Launcher updates now follow ${updateChannel.channelLabel(settings.updateChannel)}.`);
      checkAppUpdate();
    }
    return state();
  });
  ipcMain.handle('update-channels', () => updateChannels());
  ipcMain.handle('choose-rom', async () => {
    if (operation || active) throw new Error('Finish the current task before changing game files.');
    const chosen = await dialog.showOpenDialog(window, {
      title: 'Choose a file from your own Super Mario Sunshine disc',
      properties: ['openFile'],
      filters: [{ name: 'Game disc files', extensions: ['iso', 'gcm', 'ciso'] }, { name: 'All files', extensions: ['*'] }]
    });
    if (chosen.canceled) return state();
    config.rom = port.validateRom(chosen.filePaths[0]);
    saveConfig();
    return state();
  });
  ipcMain.handle('mario-model', () => ({ model: marioFrom(port.validateRom(config.rom)), look: config.marioLook }));
  // Customize Mario's way out when its 3D view can't start: a new launcher
  // gets a new GPU process. Not while the game or a task runs.
  ipcMain.handle('relaunch-launcher', () => {
    if (operation || active) throw new Error('Close the game and let the current task finish before restarting the launcher.');
    log('Restarting the launcher to reset its graphics.');
    app.relaunch(relaunchOptions({ argv: process.argv, env: process.env, packaged: app.isPackaged,
      platform: process.platform, execPath: process.execPath }));
    app.quit();
  });
  ipcMain.handle('save-mario-look', (_event, look) => {
    config.marioLook = marioColors.normalizeLook(look);
    saveConfig();
  });
  ipcMain.handle('choose-repo', async () => {
    if (portableRoot) throw new Error('The portable launcher keeps its setup files in its own folder.');
    if (operation || active) throw new Error('Finish the current task before changing game files.');
    const chosen = await dialog.showOpenDialog(window, { title: 'Choose a folder with setup files', properties: ['openDirectory'] });
    if (chosen.canceled) return state();
    if (!port.isPort(chosen.filePaths[0])) throw new Error('That folder does not have the setup files this launcher needs.');
    config.repo = chosen.filePaths[0];
    config.installRoot = null;
    config.saveDirectory = null;
    config.previousInstall = null;
    config.completedSetup = fs.existsSync(port.binaryPath(config.repo, config.settings));
    saveConfig();
    return state();
  });
  ipcMain.handle('choose-location', async () => {
    if (portableRoot) throw new Error('The portable launcher keeps its setup files in its own folder.');
    if (operation || active) throw new Error('Finish the current task before changing game files.');
    const chosen = await dialog.showOpenDialog(window, { title: 'Choose where to download setup files', properties: ['openDirectory'] });
    if (chosen.canceled) return state();
    const destination = path.join(chosen.filePaths[0], 'sms-pc-port');
    if (fs.existsSync(destination) && (!fs.statSync(destination).isDirectory() || fs.readdirSync(destination).length))
      throw new Error('That location already has a game setup folder. Choose another location.');
    config.repo = destination;
    config.installRoot = null;
    config.saveDirectory = null;
    config.previousInstall = null;
    config.completedSetup = fs.existsSync(port.binaryPath(config.repo, config.settings));
    saveConfig();
    return state();
  });
  const actions = { 'install-port': ['Download port source', installPort],
    'update-port': ['Update game', updatePort], 'install-eclipse': ['Install Eclipse', () => installEclipse()],
    'install-textures': ['Install UHD textures', () => installTextures()], 'build': ['Build game', () => build(true)],
    'setup-game': ['Build game', setupGame], 'play': ['Play Super Mario Sunshine', playInstalled],
    'launch-game': ['Prepare game', () => launchGame()], 'update-and-play': ['Prepare game', () => launchGame(null, true)],
    'play-coop': ['Play co-op', playCoop],
    'play-previous': ['Play Super Mario Sunshine', () => {
      if (!config.previousInstall) throw new Error('There is no previous version available.');
      return play(config.previousInstall);
    }] };
  for (const [channel, [label, callback]] of Object.entries(actions))
    ipcMain.handle(channel, () => exclusive(label, callback, ['play', 'launch-game', 'update-and-play', 'play-previous', 'play-coop'].includes(channel)));
  ipcMain.handle('set-game-source', (_event, input) => exclusive('Choose game source', () => chooseGameSource(input)));
  ipcMain.handle('save-multiplayer', (_event, input) => saveMultiplayer(input, { strict: false }));
  ipcMain.handle('forget-multiplayer-host', (_event, input) => {
    config.multiplayer.recent = (config.multiplayer.recent || [])
      .filter(item => !(item.address === input?.address && item.port === input?.port));
    saveConfig();
    return config.multiplayer;
  });
  ipcMain.handle('copy-text', (_event, text) => { clipboard.writeText(String(text ?? '').slice(0, 1000)); });
  // NAT type, checked from the port the player would host on (src/nat.js).
  ipcMain.handle('check-nat', (_event, input) => checkNat(input));
  ipcMain.handle('public-games', () => publicGames());
  ipcMain.handle('ping-game', (_event, input) => pingGame(input));
  // the room of a Discord invite accepted since the last ask, once
  ipcMain.handle('take-discord-join', () => { const code = discordJoin; discordJoin = null; return code; });
  ipcMain.handle('host-game', (_event, input) => exclusive('Host multiplayer game', () => hostGame(input), true));
  ipcMain.handle('join-game', (_event, input) => exclusive('Join multiplayer game', () => joinGame(input), true));
  ipcMain.handle('clean-preview', () => exclusive('Preview cleanup', () => clean(true)));
  ipcMain.handle('backup-saves', () => exclusive('Back up saves', () => makeSaveBackup('manual')));
  ipcMain.handle('steam-status', () => steamStatus());
  ipcMain.handle('gc-adapter-status', () => gcAdapterStatus());
  ipcMain.handle('gc-adapter-allow', () => allowGcAdapter());
  ipcMain.handle('gc-adapter-copy-command', () => clipboard.writeText(gcAdapter.terminalCommand()));
  ipcMain.handle('steam-offered', (_event, prompt) => markSteamOffered(prompt));
  // Keeping Rosetta keeps it for Eclipse too.
  ipcMain.handle('apple-silicon-switched', (_event, keptRosetta) => {
    config.appleSiliconSwitched = true;
    if (config.settings.eclipse || keptRosetta) config.eclipseAppleSiliconSwitched = true;
    saveConfig();
  });
  ipcMain.handle('add-to-steam', (_event, options) => exclusive('Add to Steam', () => addToSteam(options)));
  // Takes one or more .gci files: a player's Dolphin card often has both the
  // Sunshine (01-GMSE) and the Eclipse (04-GMSE) save, and either may be empty.
  ipcMain.handle('import-dolphin-save', (_event, files) => exclusive('Import Dolphin save', async () => {
    if (files == null) {
      const chosen = await dialog.showOpenDialog(window, { title: 'Import Dolphin save',
        properties: ['openFile', 'multiSelections'], filters: [{ name: 'Dolphin save', extensions: ['gci'] }] });
      if (chosen.canceled || !chosen.filePaths.length) return { cancelled: true };
      files = chosen.filePaths;
    }
    if (!Array.isArray(files) || !files.length) throw new Error('Choose a Dolphin .gci save file.');
    const { found, skipped } = gciSave.readGciFiles(files);
    const directory = currentSaveDirectory();
    const existing = found.some(({ converted }) => fs.existsSync(path.join(directory, `${converted.name}.dat`)));
    const bad = found.filter(({ converted }) => converted.badBlocks.length);
    const warning = bad.map(({ file, converted }) => `\n\n${path.basename(file)}: save checksums failed in block(s) ${converted.badBlocks.join(', ')}. Some blocks may be unused or damaged; the game may be unable to load this save.`).join('');
    const summary = found.map(({ file, converted }) => `${converted.title} (${path.basename(file)})\n` +
      converted.shines.map((count, i) => `File ${'ABC'[i]}: ${count === null ? 'empty' : `${count} Shine${count === 1 ? '' : 's'}`}`).join('\n')).join('\n\n');
    const skippedNote = skipped.length ? `\n\nSkipping ${skipped.map(save => `${save.file} (${save.reason})`).join(', ')}.` : '';
    const titles = found.map(save => save.converted.title).join(' and ');
    const answer = await dialog.showMessageBox(window, {
      type: existing || warning ? 'warning' : 'question',
      buttons: ['Cancel', found.length > 1 ? 'Import saves' : 'Import save'], defaultId: 0, cancelId: 0,
      message: existing ? `Replace your ${titles} save${found.length > 1 ? 's' : ''} with ${found.length > 1 ? 'these Dolphin saves' : 'this Dolphin save'}?`
        : `Import ${found.length > 1 ? 'these' : 'this'} ${titles} save${found.length > 1 ? 's' : ''} from Dolphin?`,
      detail: `${summary}${skippedNote}\n\nDestination: ${directory}\n\nEach save is imported whole, including all three save files. Your current memory card will be backed up first. The original .gci files are kept.${warning}`
    });
    if (answer.response !== 1) return { cancelled: true };
    const imported = [];
    for (const { file, converted } of found) {
      const result = gciSave.importGci(converted, directory);
      log(`Imported Dolphin ${converted.title} save into ${directory}.${result.previous ? ` Previous saves: ${result.previous}` : ''}`);
      imported.push({ ...result, game: converted.game, title: converted.title, shines: converted.shines, file: path.basename(file) });
    }
    return { imported, skipped };
  }));
  ipcMain.handle('restore-saves', async (_event, id) => {
    if (operation || active) throw new Error('Stop the running game or task before restoring saves.');
    if (!saves.listBackups().some(item => item.id === id && item.source === currentSaveDirectory()))
      throw new Error('Choose a backup for this memory card.');
    const answer = await dialog.showMessageBox(window, {
      type: 'warning', buttons: ['Cancel', 'Restore memory card'], defaultId: 0, cancelId: 0,
      message: 'Restore this backup?',
      detail: "We'll back up your current saves first, then replace matching files."
    });
    if (answer.response !== 1) return { cancelled: true };
    const result = saves.restoreBackup(id, currentSaveDirectory());
    log(`Restored ${result.restored} memory card file(s) from ${id}.`);
    return result;
  });
  ipcMain.handle('show-path-folder', () => { const problem = blockedPath || pathProblem(); if (problem) shell.showItemInFolder(problem.folder); });
  ipcMain.handle('open-backups', () => {
    fs.mkdirSync(saves.backupRoot(), { recursive: true, mode: 0o700 });
    return shell.openPath(saves.backupRoot());
  });
  // Save states: files the game keeps in a savestates folder beside the memory card (src/savestates.js).
  const stateDirectory = () => savestates.stateDirectory(currentSaveDirectory());
  ipcMain.handle('native-mods', () => nativeModsState());
  ipcMain.handle('native-mods-latest', () => nativeModsLatest());
  ipcMain.handle('native-mod-install', (_event, id) => exclusive('Download mod', () => installNativeMod(id)));
  ipcMain.handle('native-mod-remove', (_event, id) => { nativeMods.remove(app.getPath('userData'), String(id)); return nativeModsState(); });
  ipcMain.handle('native-mod-enable', (_event, id, on) => { nativeMods.setEnabled(String(id), Boolean(on)); return nativeModsState(); });
  ipcMain.handle('open-native-mods', () => {
    fs.mkdirSync(nativeMods.directory(app.getPath('userData')), { recursive: true });
    return shell.openPath(nativeMods.directory(app.getPath('userData')));
  });
  ipcMain.handle('open-custom-textures', () => {
    fs.mkdirSync(customTextureDirectory(), { recursive: true });
    return shell.openPath(customTextureDirectory());
  });
  ipcMain.handle('achievements', () => achievementsState());
  ipcMain.handle('achievement-icons', () => achievementIcons());
  ipcMain.handle('download-achievement-icons', () => exclusive('Install achievement icons', downloadAchievementIcons));
  ipcMain.handle('achievements-seen', () => markAchievementsSeen());
  ipcMain.handle('save-states', () => ({ directory: stateDirectory(), states: savestates.listStates(stateDirectory()) }));
  ipcMain.handle('open-save-states', () => {
    fs.mkdirSync(stateDirectory(), { recursive: true });
    return shell.openPath(stateDirectory());
  });
  ipcMain.handle('show-save-state', (_event, name) => shell.showItemInFolder(savestates.statePath(stateDirectory(), name)));
  ipcMain.handle('import-save-state', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Import save states', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Super Mario Sunshine save states', extensions: ['smsstate'] }]
    });
    if (result.canceled || !result.filePaths.length) return { cancelled: true };
    const imported = result.filePaths.map(file => savestates.importState(file, stateDirectory()));
    log(`Imported ${imported.length} save state(s) into ${stateDirectory()}.`);
    return { imported: imported.length };
  });
  ipcMain.handle('delete-save-state', async (_event, name) => {
    const file = savestates.statePath(stateDirectory(), name);
    const answer = await dialog.showMessageBox(window, {
      type: 'warning', buttons: ['Cancel', 'Delete state'], defaultId: 0, cancelId: 0,
      message: 'Delete this save state?', detail: path.basename(file)
    });
    if (answer.response !== 1) return { cancelled: true };
    savestates.deleteState(stateDirectory(), name);
    return { deleted: true };
  });
  ipcMain.handle('clean', () => exclusive('Clean build output', async () => {
    const answer = await dialog.showMessageBox(window, {
      type: 'warning', buttons: ['Cancel', 'Free up space'], defaultId: 0, cancelId: 0,
      message: 'Remove files the launcher can make again?', detail: 'The next play may take longer. Your disc file and saved games will be kept.'
    });
    return answer.response === 1 ? clean(false) : { cancelled: true };
  }));
  ipcMain.handle('remove-build-tools', () => exclusive('Remove build tools', async () => {
    const answer = await dialog.showMessageBox(window, {
      type: 'warning', buttons: ['Cancel', 'Remove build tools'], defaultId: 0, cancelId: 0,
      message: 'Remove the build tools?',
      detail: `They take a few GB in ${buildToolsFolder()} and are only needed to build the game, which plays without them. ` +
        'The launcher downloads them again when it next needs them: to update or rebuild the game, or to set up HD visuals, ' +
        'a language or Super Mario Eclipse. Your game, disc file and saved games are kept.'
    });
    return answer.response === 1 ? removeBuildTools() : { cancelled: true };
  }));
  ipcMain.handle('stop', () => {
    if (!active) return false;
    if (!active.child) return false;
    stoppedAt = Date.now();
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(active.child.pid), '/T', '/F'], { windowsHide: true });
    else { try { process.kill(-active.child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    return true;
  });
  ipcMain.handle('open-docs', () => shell.openPath(path.join(requireRepo(), 'BUILD.md')));
  // Only this fixed invite opens: the page never chooses a URL.
  ipcMain.handle('open-discord', () => shell.openExternal(DISCORD_INVITE));
  ipcMain.handle('changelog', () => changelogState());
  ipcMain.handle('changelog-seen', () => markChangelogSeen());
  ipcMain.handle('open-changelog-page', () => shell.openExternal(changelog.PAGE_URL));
  ipcMain.handle('open-hdr-calibration', () => shell.openExternal(HDR_CALIBRATION_APP));
  ipcMain.handle('open-eclipse-github', () => shell.openExternal(ECLIPSE_GITHUB));
  ipcMain.handle('display-info', () => displayInfo());
}

const WINDOW_SIZE = { width: 1080, height: 760, minWidth: 900, minHeight: 600 };

function createWindow() {
  // Only Windows display scaling is capped: a Mac's Retina 2x is its normal size.
  const windowsScaling = process.platform === 'win32';
  const zoom = windowsScaling ? displayScale.displayZoom(screen.getPrimaryDisplay()) : 1;
  window = new BrowserWindow({
    ...displayScale.scaledSize(WINDOW_SIZE, zoom),
    frame: false, backgroundColor: '#0a3045', title: 'SMS Launcher',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  if (windowsScaling) displayScale.followDisplayScale(window, screen, WINDOW_SIZE, zoom);
  window.setMenuBarVisibility(false);
  const sendWindowState = () => broadcast('window-state', { fullscreen: window.isFullScreen() });
  window.on('enter-full-screen', sendWindowState);
  window.on('leave-full-screen', sendWindowState);
  // Back from the taskbar: the online count catches up at once rather than at the next minute.
  window.on('restore', () => checkPublicOnline({ fresh: 30 * 1000 }));
  window.loadFile(path.join(__dirname, 'index.html'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('console-message', details => {
    if (details.level === 'error' || details.level === 'warning')
      log(`Renderer ${details.level}: ${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
}

if (ownsInstance) app.whenReady().then(async () => {
  loadConfig();
  tidySaveDirectory();
  registerHandlers();
  setupTelemetry();
  if (playOnStart && await playDirectly()) return app.quit();
  createWindow();
  watchPublicOnline();
  syncDiscord();
  // Only with the window: a launcher update installs on quit, which `--play` does as the game closes.
  setupAppUpdater();
  removeOldVersionsInBackground();
  // The bundled manifest is the update check. Source downloads and builds
  // start with Update & play, so opening the launcher never changes a game.
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

app.on('before-quit', () => {
  flushPartialOutput();
  // Stop an in-flight compiler before another launcher process can recover it.
  if (!active?.child || active.label === 'Play Super Mario Sunshine') return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(active.child.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-active.child.pid, 'SIGTERM'); } catch (_) { /* already exited */ } }
});
