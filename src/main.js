'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, net, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const port = require('./port');
const saves = require('./saves');
const gciSave = require('./gci-save');
const buildTools = require('./build-tools');
const game = require('./game-version');
const updateChannel = require('./update-channel');
const steam = require('./steam');
const gcAdapter = require('./gc-adapter');
const appImageUpdate = require('./appimage-update');
const bindings = require('./bindings');
const savestates = require('./savestates');
const prompts = require('./prompts');
const gameSource = require('./game-source');
const portable = require('./portable');
const telemetry = require('./telemetry');
const discord = require('./discord');
const presence = require('./presence');
const changelog = require('./changelog');
const multiplayer = require('./multiplayer');
const nat = require('./nat');
const rooms = require('./rooms');
const { cleanOutputLine, createActivityReader } = require('./progress');
const { createActivityLog } = require('./activity-log');
const { observeProcess, exitDescription, failureMessage } = require('./process-output');
const { createSessionLog } = require('./session-log');
const displayScale = require('./display-scale');
const marioModel = require('./mario-model');
const marioColors = require('./mario-colors');
const marioPack = require('./mario-pack');

const DISCORD_INVITE = 'https://discord.gg/NvUXmm8dB9';
// Microsoft's free Windows HDR Calibration app (Microsoft Store product 9N7F2SM5D1LR).
const HDR_CALIBRATION_APP = 'https://apps.microsoft.com/detail/9n7f2sm5d1lr';

let window;
let config;
let active = null;
let preparingTools = false;
let operation = null;
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
const activityLog = createActivityLog();
const partialOutput = new Map();
const sessionLog = createSessionLog(() => app.getPath('userData'), error =>
  logOutput(`Could not save the session log: ${error.message}`, 'launcher'));
let reporter = null;
let online = null;
let discordPresence = null;
// The running game's handler for its `[presence]` lines (src/presence.js).
let onPresence = null;
// `--play` (for a Steam shortcut's launch options) starts the game without the
// launcher's window and quits when the game closes.
const playOnStart = process.argv.includes('--play');
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on('second-instance', () => {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});

function broadcast(channel, data) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, data);
}

// The room code friends join with, while hosting (shown under the play button).
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
  const recent = (Array.isArray(value.recent) ? value.recent : [])
    .filter(item => item && typeof item.address === 'string' && item.address && Number.isInteger(item.port) && item.port > 0 && item.port < 65536)
    .slice(0, multiplayer.RECENT_HOSTS)
    .map(item => ({ address: item.address.slice(0, 255), port: item.port, name: multiplayer.playerName(item.name, '') }));
  return { name: multiplayer.playerName(value.name, ''), address: typeof value.address === 'string' ? value.address.slice(0, 255) : '',
    hostPort: portOr(value.hostPort), joinPort: portOr(value.joinPort), recent };
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
  try { return await callback(); }
  catch (error) {
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
  const response = await net.fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
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

function makeSaveBackup(reason) {
  if (active) throw new Error('Stop the running game or task before backing up saves.');
  const result = saves.backupSaves(currentSaveDirectory(), saves.backupRoot(), reason);
  log(result.empty ? result.message : `Saved ${result.count} memory card file(s) to ${result.directory}`);
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
        && (presence.isPresenceLine(text) || presence.PREFIX.startsWith(text))) return entry;
      return logOutput(text, stream, entry);
    }
    function line(value, stream, entry) {
      if (isGame && stream === 'stdout' && presence.isPresenceLine(value)) return onPresence?.(value);
      completeOutput(value, stream, entry);
      if (!value) return;
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
      throw new Error(failureMessage(label, { code, signal }, recent, { game: isGame }));
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

function toolEnv(base = process.env) {
  return buildTools.environment(app.getPath('userData'), base);
}

function toolOptions() {
  return { archives: Boolean(config.settings.textures || config.settings.eclipse) };
}

function toolsStatus() {
  return buildTools.status(app.getPath('userData'), process.platform, process.env, toolOptions());
}

async function checkTools(refresh = false) {
  return buildTools.check(app.getPath('userData'), { ...toolOptions(), refresh });
}

async function ensureBuildTools() {
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
  active = { label: 'Download build tools', child: null, detail: 'Checking download…', percent: null, startedAt };
  broadcast('activity', { label: active.label, detail: active.detail, percent: null, startedAt });
  try {
    await buildTools.prepare(userData, {
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
  await ensureBuildTools();
  await refreshGameSource();
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
  await game.checkout(destination, { run: launch, capture, env: toolEnv(), source: currentSource() });
  return { ok: true };
}

async function installEclipse(root = requireRepo()) {
  await ensureBuildTools();
  const rom = port.validateRom(config.rom);
  const cmd = port.commandFor(root, 'python', [rom], process.platform, toolEnv());
  return launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, 'Install Eclipse from your disc');
}

// The texture extras' pinned release, downloaded on its own (not the UHD pack
// again) when it is missing or a newer one is pinned. They only add to the UHD
// pack, so a failed download is logged and never stops setup or play.
async function updateTextureExtras(root, settings) {
  if (!port.textureExtrasWanted(root, settings)) return;
  try {
    await ensureBuildTools();
    const cmd = port.commandFor(root, 'texture-extras', [], process.platform, toolEnv());
    await launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, 'Install HD texture extras');
    if (!port.textureExtrasInstalled(root)) throw new Error('the installer finished without them');
  } catch (error) {
    log(`HD texture extras were not updated (${error.message}); the game plays without them and setup tries again next time.`);
  }
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

async function build(forceFresh = false) {
  const original = requireRepo();
  const settings = { ...config.settings };
  const rom = port.validateRom(config.rom);
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
    if (!fs.existsSync(root)) await game.checkout(root, { run: launch, capture, env: toolEnv(), reference: original, source });
    if (!game.matchesSource(root, source))
      throw new Error('The update folder has changed. Choose another setup location in Settings and try again.');
    game.carryUserFiles(original, root);
  }
  // A path too long for Windows' compiler fails deep into the build with
  // "No such file or directory": say why before it starts, and again if it fails.
  const longPath = port.longPathProblem(root, settings, { portable: Boolean(portableRoot) });
  if (longPath) {
    log(longPath);
    if (window) void dialog.showMessageBox(window, { type: 'warning', buttons: ['OK'],
      message: 'The game folder is too deep for Windows', detail: longPath }).catch(() => {});
  }
  if (!port.hdVisualsInstalled(root, settings)) await installTextures(root);
  else await updateTextureExtras(root, settings);
  await updateLanguagePack(root, settings);
  if (settings.eclipse && !fs.existsSync(path.join(root, port.ECLIPSE_ISO))) await installEclipse(root);
  const disc = port.gameDisc(root, rom, settings.eclipse);
  const env = toolEnv(port.buildEnvironment(settings, disc, root));
  env.NINJA_STATUS = '[%f/%t] ';
  const cmd = settings.eclipse
    ? port.eclipseBuildCommand(root, settings, process.platform, env)
    : port.commandFor(root, 'build', [disc], process.platform, env);
  const result = await game.buildSafely(root, settings, saveDirectory,
    // A build that fails because antivirus deleted a tool, or in a folder too
    // deep for Windows, says so instead of CMake's error.
    () => launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, settings.eclipse ? 'Build Eclipse port' : 'Build Sunshine port')
      .catch(error => { throw buildTools.deletedToolsError(app.getPath('userData')) || (longPath && new Error(longPath)) || error; }),
    undefined, source);
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
  return result;
}

// Keep the current and previous game versions; older ones only take up space.
async function removeOldVersions() {
  if (!config.installRoot || !binaryReady()) return;
  const removed = await game.pruneSnapshots(config.installRoot, [config.repo, config.previousInstall?.repo],
    [currentSaveDirectory(), config.previousInstall?.saveDirectory, config.rom, config.previousInstall?.rom],
    (error, folder) => log(`Could not remove old game version ${folder}: ${error.message}`));
  if (removed.length) log(`Removed ${removed.length} old game version${removed.length === 1 ? '' : 's'} to free up disk space.`);
}

async function setupGame() {
  requireRepo();
  port.validateRom(config.rom);
  if (!game.isCurrent(config.repo, config.settings, currentSource())) await build();
  else if (!port.hdVisualsInstalled(config.repo, config.settings)) await installTextures();
  else await updateTextureExtras(config.repo, config.settings);
  await updateLanguagePack(config.repo, config.settings);
  return state();
}

const PLAYER_SETTINGS = [
  'volume', 'invertCameraX', 'invertCameraY', 'keyBindings', 'padBindings', 'softTrigger', 'rumbleStrength', 'freeCamera', 'cameraSpeed', 'mouseCamera',
  'mouseSensitivity', 'skipMovies', 'language', 'heatHaze', 'buttonPrompts', 'promptPad', 'hdr', 'hdrCalibration', 'hdrPaperWhite', 'hdrPeak', 'hdrContrast', 'hdrSaturation', 'hdrHighlights', 'overlay', 'fullscreenMode', 'exclusiveResolution', 'display', 'vsync',
  'msaa', 'fxaa', 'anisotropic', 'sharpen', 'fsrMode', 'brightness', 'aspect', 'presentFilter'
];
function promptDirectory() { return path.join(app.getPath('userData'), 'prompts'); }

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
  const cmd = port.commandFor(root, 'run', ['--display-info'], process.platform, env);
  const stdout = await new Promise(resolve => execFile(cmd.command, cmd.args,
    { cwd: cmd.cwd, env: cmd.env, timeout: 15000, windowsHide: true }, (_error, out) => resolve(String(out || ''))));
  const line = stdout.split(/\r?\n/).find(text => text.startsWith('{"displays"'));
  if (!line) return { displays: [], error: 'This game version cannot read your display yet. Update the game to see it.' };
  try { return { displays: JSON.parse(line).displays || [] }; }
  catch (_) { return { displays: [], error: 'The game reported your display in a way the launcher did not understand.' }; }
}

// `session`: a multiplayer game to host or join ({ mode: 'host' or 'join', env }: hostGame, joinGame), or null to play alone.
async function play(installation = null, session = null) {
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
    ? path.join(currentSaveDirectory(), 'multiplayer-guest') : currentSaveDirectory());
  const recordedTools = game.toolRoot(root, settings);
  const env = recordedTools
    ? buildTools.environmentAtRoot(recordedTools, { ...port.buildEnvironment(settings, disc, root), SMS_SAVE_DIR: saveDir })
    : toolEnv({ ...port.buildEnvironment(settings, disc, root), SMS_SAVE_DIR: saveDir });
  // Changed keys go to a file of the launcher's own, so a bindings.txt kept by hand in the game folder is left alone.
  if (Object.keys(settings.keyBindings || {}).length || Object.keys(settings.padBindings || {}).length) {
    const file = path.join(app.getPath('userData'), 'bindings.txt');
    fs.writeFileSync(file, bindings.fileText(settings.keyBindings, settings.padBindings));
    env.SMS_BINDINGS = file;
  }
  // The prompt images the Controls page drew from these bindings (save-prompts).
  // Every style's images, Original prompts included: the pause menu's save state hint draws the buttons from them.
  env.SMS_BUTTON_PROMPT_DIR = promptDirectory();
  if (config.settings.discordPresence) env.SMS_PRESENCE = '1';
  const look = marioLookPack(rom, root, settings);
  if (look) env.SMS_MARIO_LOOK = look;
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
  try {
    return await launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, 'Play Super Mario Sunshine', true);
  } finally {
    stopPresence(startedAt);
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
// pack the game reads before its texture packs (SMS_MARIO_LOOK). Made again
// only when the colours, the disc or the HD images change; never in the way
// of playing.
function marioLookPack(rom, root, settings) {
  const directory = path.join(app.getPath('userData'), 'mario-look');
  const look = marioColors.normalizeLook(config.marioLook);
  if (settings.eclipse || !Object.keys(look.colors).length) {
    fs.rmSync(directory, { recursive: true, force: true });
    return null;
  }
  try {
    const started = Date.now();
    const made = marioPack.bake({ rom, look, references: marioFrom(rom).references, directory,
      packDirectories: settings.textures ? [port.texturePackDirectory(root)] : [] });
    if (Date.now() - started > 250) log(`Painted Mario in your colours in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
    return made;
  } catch (error) {
    log(`Mario keeps his usual colours: ${error.message}`);
    return null;
  }
}

// Time spent in the game, in milliseconds, for Discord; kept apart from preferences.
function playtimeFile() { return path.join(app.getPath('userData'), 'playtime.json'); }

function playtime() {
  try {
    const { ms } = JSON.parse(fs.readFileSync(playtimeFile(), 'utf8'));
    return Number.isFinite(ms) && ms > 0 ? ms : 0;
  } catch (_) { return 0; }
}

// Discord shows the game only while it runs, and only with the setting on.
function startPresence(startedAt, eclipse) {
  if (!config.settings.discordPresence) return;
  discordPresence ||= discord.createPresence({ log });
  const before = playtime();
  const show = game => discordPresence.set(presence.activity(game,
    { startedAt, eclipse, playtime: before + Date.now() - startedAt }));
  onPresence = line => { const game = presence.parseLine(line); if (game) show(game); };
  show(null);
}

function stopPresence(startedAt) {
  onPresence = null;
  discordPresence?.stop();
  try { fs.writeFileSync(playtimeFile(), JSON.stringify({ ms: playtime() + Date.now() - startedAt })); }
  catch (error) { log(`Could not save play time: ${error.message}`); }
}

// Update & play asks for the update even when updates are not automatic.
async function launchGame(session = null, update = config.settings.autoUpdate) {
  requireRepo();
  port.validateRom(config.rom);
  if (!binaryReady() || (update && !game.isCurrent(config.repo, config.settings, currentSource()))) await build();
  if (!port.hdVisualsInstalled(config.repo, config.settings)) await installTextures();
  else await updateTextureExtras(config.repo, config.settings);
  await updateLanguagePack(config.repo, config.settings);
  // last checks, with the game as it will run (multiplayer: the network check is done, the host's version matches)
  if (session?.beforePlay) await session.beforePlay();
  return play(null, session);
}

// The Multiplayer window's fields, kept for next time. Host Game and Join throw a sentence for a field that is wrong
// (`strict`); saving as the player types keeps the last good port instead, so the other fields are still kept.
function saveMultiplayer(input = {}, { strict = true } = {}) {
  const portField = (text, previous) => {
    if (text === undefined) return previous;
    try { return multiplayer.parsePort(text); } catch (error) { if (strict) throw error; return previous; }
  };
  const value = { name: multiplayer.playerName(input.name, ''), address: String(input.address ?? config.multiplayer.address).trim().slice(0, 255),
    hostPort: portField(input.hostPort, config.multiplayer.hostPort), joinPort: portField(input.joinPort, config.multiplayer.joinPort),
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

// Host Game: plays like Play, with the game listening for players on this computer and the launcher passing their
// packets on from the chosen port (src/rooms.js), so friends can join with a room code and no port forwarding.
async function hostGame(input) {
  const settings = saveMultiplayer(input);
  const name = multiplayer.playerName(settings.name, 'Host');
  let room = null;
  const showRoom = (code, changed) => {
    hostedRoom = rooms.formatRoomCode(code);
    clipboard.writeText(hostedRoom);
    log(changed ? `Your room code changed to ${hostedRoom} (copied). Give friends the new one.`
      : `Room code ${hostedRoom} (copied): friends join with it from their Multiplayer window.`);
    broadcast('activity', activityState());
  };
  const session = { mode: 'host', env: multiplayer.environment('host', { port: settings.hostPort, name }),
    beforePlay: async () => {
      await natCheck?.catch(() => {});
      room = await rooms.host({ port: settings.hostPort, name, build: localGameBuild(), log, onRoom: showRoom });
      Object.assign(session.env, { SMS_MULTIPLAYER_PORT: String(room.gamePort), SMS_MULTIPLAYER_LOCAL: '1',
        SMS_MULTIPLAYER_ROOM: room.code ? rooms.formatRoomCode(room.code) : '' });
    } };
  log(`Hosting a multiplayer game on UDP port ${settings.hostPort}.`);
  try { return await launchGame(session); }
  finally {
    room?.close();
    hostedRoom = null;
    broadcast('activity', activityState());
  }
}

// Join with a room code: the room server says whose game it is and which build it runs, then the launcher connects
// to the host's launcher (src/rooms.js) and the game joins through it, on this computer.
async function joinRoom(code, settings) {
  const shown = rooms.formatRoomCode(code);
  const check = async build => {
    const info = await rooms.lookup(code);
    const problem = multiplayer.joinProblem({ ...info, open: true, players: 0, maxPlayers: 4 }, build);
    if (problem) throw new Error(problem);
    return info;
  };
  log(`Looking for room ${shown}…`);
  const updateDue = !binaryReady() || (config.settings.autoUpdate && !game.isCurrent(config.repo, config.settings, currentSource()));
  const info = await check(updateDue ? null : localGameBuild());
  log(`Found ${info.name || 'the host'}'s room. ${updateDue ? 'Updating the game first, then joining it.' : 'Connecting…'}`);
  const name = multiplayer.playerName(settings.name);
  let link = null;
  const session = { mode: 'join', env: {},
    beforePlay: async () => {
      if (updateDue) await check(localGameBuild());
      link = await rooms.join({ code, name, log });
      log(link.mode === 'relay' ? 'Connected through the relay: your networks couldn\'t reach each other directly.'
        : `Connected ${link.mode === 'lan' ? 'over your local network' : 'directly over the internet'}.`);
      let hosted;
      try { hosted = await multiplayer.probe('127.0.0.1', link.localPort); }
      catch (_) { throw new Error('Reached the host, but their game didn\'t answer. Check that it\'s still running.'); }
      const problem = multiplayer.joinProblem(hosted, localGameBuild());
      if (problem) throw new Error(problem);
      log(`${hosted.name || 'The host'}'s game: ${hosted.players} of ${hosted.maxPlayers} players`
        + `${hosted.status ? `, in ${hosted.status}` : ''}. Starting the game to join it.`);
      session.env = multiplayer.environment('join', { host: '127.0.0.1', port: link.localPort, name });
    } };
  try { return await launchGame(session); }
  finally { link?.close(); }
}

// Join: finds the host's game first, so a wrong address or a full game is reported before anything else happens.
// The versions are compared with the game as it will run: after an update, if one is due, the host is asked again.
async function joinGame(input) {
  const settings = saveMultiplayer(input);
  const code = rooms.parseRoomCode(settings.address);
  if (code) return joinRoom(code, settings);
  const target = multiplayer.parseAddress(settings.address, settings.joinPort);
  const find = async build => {
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
    const problem = multiplayer.joinProblem(info, build);
    if (problem) throw new Error(problem);
    return info;
  };
  const updateDue = !binaryReady() || (config.settings.autoUpdate && !game.isCurrent(config.repo, config.settings, currentSource()));
  const info = await find(updateDue ? null : localGameBuild());
  config.multiplayer.recent = multiplayer.rememberHost(config.multiplayer.recent, { ...target, name: info.name });
  saveConfig();
  log(`Found ${info.name || 'the host'}'s game: ${info.players} of ${info.maxPlayers} players${info.status ? `, in ${info.status}` : ''}. `
    + (updateDue ? 'Updating the game first, then joining it.' : 'Starting the game to join it.'));
  return launchGame({ mode: 'join', env: multiplayer.environment('join', { ...target, name: multiplayer.playerName(settings.name) }),
    beforePlay: updateDue ? () => find(localGameBuild()) : null });
}

// Why `--play` opens the launcher instead of the game, or null if the game can start as it is.
function directPlayBlocker() {
  if (!port.isPort(config.repo) || !binaryReady()) return 'the game is not set up yet.';
  try { port.validateRom(config.rom); } catch (error) { return error.message; }
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
  return launch(cmd.command, cmd.args, { cwd: cmd.cwd, env: cmd.env }, dryRun ? 'Preview cleanup' : 'Clean build output');
}

function state() {
  const info = port.platformInfo();
  let romError = '';
  if (config.rom) { try { port.validateRom(config.rom); } catch (error) { romError = error.message; } }
  const repoReady = port.isPort(config.repo);
  const ready = repoReady && binaryReady();
  const installedBuild = ready ? game.installed(config.repo, config.settings) : null;
  return {
    config, platform: info, repoReady, portable: Boolean(portableRoot),
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
    tools: toolsStatus(),
    gameSource: config.gameSource ? { override: config.gameSource.override, version: config.gameSource.resolved.version } : null,
    game: { launcherVersion: app.getVersion(), availableVersion: currentSource().version,
      installedVersion: installedBuild?.gameVersion || null,
      installedToolVersion: installedBuild?.toolVersion || null,
      toolVersion: buildTools.toolsetFor(), needsUpdate: repoReady && !game.isCurrent(config.repo, config.settings, currentSource()),
      previousReady: Boolean(config.previousInstall && binaryReady(config.previousInstall.repo, config.previousInstall.settings)) },
    active: activityState(), appUpdate, online, logs: activityLog.snapshot(), logResetSequence: activityLog.resetSequence(),
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
    appUpdate = { state: 'unconfigured', message: 'Portable launcher: download new versions from the releases page.' };
    ipcMain.handle('check-app-update', () => appUpdate);
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
  ipcMain.handle('save-settings', (_event, input) => {
    if (operation || active) throw new Error('Finish the current task before changing settings.');
    const settings = port.normalizeSettings(input);
    if (settings.arch !== config.settings.arch || settings.eclipse !== config.settings.eclipse)
      config.previousInstall = port.playableInstall({ ...config, saveDirectory: currentSaveDirectory() }) || config.previousInstall;
    const channelChanged = settings.updateChannel !== config.settings.updateChannel;
    const sharingChanged = settings.shareUsage !== config.settings.shareUsage;
    config.settings = settings;
    saveConfig();
    if (sharingChanged) reporter?.tick();
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
      properties: ['openFile'], filters: [{ name: 'Game disc files', extensions: ['iso', 'gcm', 'ciso'] }]
    });
    if (chosen.canceled) return state();
    config.rom = port.validateRom(chosen.filePaths[0]);
    saveConfig();
    return state();
  });
  ipcMain.handle('mario-model', () => ({ model: marioFrom(port.validateRom(config.rom)), look: config.marioLook }));
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
    'play-previous': ['Play Super Mario Sunshine', () => {
      if (!config.previousInstall) throw new Error('There is no previous version available.');
      return play(config.previousInstall);
    }] };
  for (const [channel, [label, callback]] of Object.entries(actions))
    ipcMain.handle(channel, () => exclusive(label, callback, ['play', 'launch-game', 'update-and-play', 'play-previous'].includes(channel)));
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
  ipcMain.handle('host-game', (_event, input) => exclusive('Host multiplayer game', () => hostGame(input), true));
  ipcMain.handle('join-game', (_event, input) => exclusive('Join multiplayer game', () => joinGame(input), true));
  ipcMain.handle('clean-preview', () => exclusive('Preview cleanup', () => clean(true)));
  ipcMain.handle('backup-saves', () => exclusive('Back up saves', () => makeSaveBackup('manual')));
  ipcMain.handle('steam-status', () => steamStatus());
  ipcMain.handle('gc-adapter-status', () => gcAdapterStatus());
  ipcMain.handle('gc-adapter-allow', () => allowGcAdapter());
  ipcMain.handle('gc-adapter-copy-command', () => clipboard.writeText(gcAdapter.terminalCommand()));
  ipcMain.handle('steam-offered', (_event, prompt) => markSteamOffered(prompt));
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
  ipcMain.handle('open-backups', () => {
    fs.mkdirSync(saves.backupRoot(), { recursive: true, mode: 0o700 });
    return shell.openPath(saves.backupRoot());
  });
  // Save states: files the game keeps in a savestates folder beside the memory card (src/savestates.js).
  const stateDirectory = () => savestates.stateDirectory(currentSaveDirectory());
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
  ipcMain.handle('stop', () => {
    if (!active) return false;
    if (!active.child) return false;
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
  window.loadFile(path.join(__dirname, 'index.html'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('console-message', details => {
    if (details.level === 'error' || details.level === 'warning')
      log(`Renderer ${details.level}: ${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
}

if (ownsInstance) app.whenReady().then(async () => {
  loadConfig();
  registerHandlers();
  setupTelemetry();
  if (playOnStart && await playDirectly()) return app.quit();
  createWindow();
  // Only with the window: a launcher update installs on quit, which `--play` does as the game closes.
  setupAppUpdater();
  exclusive('Remove old game versions', removeOldVersions).catch(() => {});
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
