'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const portable = require('./portable');

function configuredSaveDir(root, env) {
  if (env.SMS_SAVE_DIR) return env.SMS_SAVE_DIR;
  try {
    const settingsPath = env.SMS_SETTINGS ? path.resolve(root, env.SMS_SETTINGS) : path.join(root, 'settings.txt');
    const settings = fs.readFileSync(settingsPath, 'utf8');
    for (const line of settings.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:save_dir|SMS_SAVE_DIR)\s*=\s*(.*?)\s*$/);
      if (match) {
        const value = match[1].replace(/\s+#.*$/, '').trim();
        if (value && !value.startsWith('#')) return value;
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return '';
}

function saveDirectory(root, env = process.env, platform = process.platform) {
  const configured = configuredSaveDir(root, env);
  if (configured) return path.resolve(root, configured);
  const portableRoot = portable.root(env, platform);
  if (portableRoot) return path.join(portableRoot, 'saves', 'card-a');
  if (env.XDG_DATA_HOME) return path.resolve(env.XDG_DATA_HOME, 'sms-port', 'card-a');
  if (platform === 'win32' && env.APPDATA) return path.resolve(env.APPDATA, 'sms-port', 'card-a');
  return path.resolve(env.HOME || os.homedir(), '.local', 'share', 'sms-port', 'card-a');
}

// The game makes the card folder one '/'-separated level at a time and Windows
// mkdir fails on a missing parent, so a backslash path never gets created.
function gameSaveDirectory(dir, platform = process.platform) {
  return platform === 'win32' ? dir.replace(/\\/g, '/') : dir;
}

function prepareSaveDirectory(dir, platform = process.platform) {
  fs.mkdirSync(dir, { recursive: true });
  return gameSaveDirectory(dir, platform);
}

// A joining player's copy of the host's save (multiplayer): beside the memory card, like save states, so the
// card folder holds only the player's own card files.
const GUEST_FOLDER = 'multiplayer-guest';
function guestSaveDirectory(saveDir) {
  return path.join(path.dirname(saveDir), GUEST_FOLDER);
}

// Launchers before this one kept the guest copy inside the card folder, where backups refuse a folder: move it out
// (or drop it, if there is one beside the card already: it is only a copy of a host's save). True when it moved.
function moveOldGuestSaves(saveDir) {
  const old = path.join(saveDir, GUEST_FOLDER);
  let stat;
  try { stat = fs.lstatSync(old); } catch (_) { return false; }
  if (!stat.isDirectory()) return false;
  const target = guestSaveDirectory(saveDir);
  if (fs.existsSync(target)) fs.rmSync(old, { recursive: true, force: true });
  else fs.renameSync(old, target);
  return true;
}

function backupRoot(env = process.env, platform = process.platform) {
  const portableRoot = portable.root(env, platform);
  return portableRoot ? path.join(portableRoot, 'Save Backups') : path.join(os.homedir(), 'SMS Launcher Backups');
}

// What sync tools and file browsers leave in a folder they look after (Syncthing's marker, ignore list, old versions
// and partial downloads; Resilio Sync; macOS and Windows Explorer metadata): kept where it is, never a save.
function isSyncMetadata(name) {
  return ['.stfolder', '.stignore', '.stversions', '.sync', '.DS_Store', 'desktop.ini', 'Thumbs.db'].includes(name) ||
    /^\.syncthing\..*\.tmp$/.test(name) || /^~syncthing~.*\.tmp$/.test(name) || name.startsWith('._');
}

function isCardFile(name) { return name === 'index.txt' || /\.(dat|stat)$/.test(name); }

function cleanupWouldRemoveSaves(root, saveDir) {
  return ['build', 'build-64', 'build-mac', 'build32'].some(name => {
    const relative = path.relative(path.join(root, name), saveDir);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

function saveFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  if (!fs.statSync(dir).isDirectory()) throw new Error(`Memory card path is not a folder: ${dir}`);
  return fs.readdirSync(dir, { withFileTypes: true }).filter(entry => {
    if (isSyncMetadata(entry.name)) return false;
    if (entry.isSymbolicLink()) throw new Error(`Memory card contains a symbolic link: ${entry.name}`);
    if (!entry.isFile()) throw new Error(`Memory card contains an unexpected folder: ${entry.name}`);
    return isCardFile(entry.name);
  }).map(entry => entry.name);
}

// Mods' files beside the memory card (the game's mod API, api->files): <card folder>-mods, kept with the card.
function modSaveDirectory(saveDir) {
  return `${String(saveDir).replace(/[\\/]+$/, '')}-mods`;
}

// Every file below the mods' folder, as '/'-separated paths relative to it.
function modSaveFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  if (!fs.statSync(dir).isDirectory()) throw new Error(`Mod saves path is not a folder: ${dir}`);
  const walk = (folder, prefix) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (isSyncMetadata(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Mod saves contain a symbolic link: ${prefix}${entry.name}`);
      if (entry.isDirectory()) walk(path.join(folder, entry.name), `${prefix}${entry.name}/`);
      else if (entry.isFile() && !entry.name.endsWith('.tmp')) out.push(`${prefix}${entry.name}`);
    }
  };
  walk(dir, '');
  return out.sort();
}

// A mod save's relative path from a manifest: names the game allows, no way out of the folder.
function isModSavePath(name) {
  return typeof name === 'string' && name.length <= 512 &&
    name.split('/').every(part => /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(part));
}

function digest(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function backupSaves(saveDir, destination = backupRoot(), reason = 'manual') {
  const files = saveFiles(saveDir);
  if (!files.length) return { empty: true, message: 'No memory card files to back up yet.' };
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  // Written in place, manifest last: a folder without a manifest isn't a backup (listBackups skips it).
  // Renaming a finished folder into place failed on Windows (EPERM) while something still had a new file open.
  const complete = path.join(destination, id);
  fs.mkdirSync(path.join(complete, 'files'), { recursive: true, mode: 0o700 });
  try {
    const records = files.map(name => {
      const source = path.join(saveDir, name);
      const target = path.join(complete, 'files', name);
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      const hash = digest(source);
      if (digest(target) !== hash) throw new Error(`Backup verification failed for ${name}`);
      return { name, hash };
    });
    const modDir = modSaveDirectory(saveDir);
    const mods = modSaveFiles(modDir).map(name => {
      const source = path.join(modDir, ...name.split('/'));
      const target = path.join(complete, 'mods', ...name.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      const hash = digest(source);
      if (digest(target) !== hash) throw new Error(`Backup verification failed for ${name}`);
      return { name, hash };
    });
    fs.writeFileSync(path.join(complete, 'manifest.json'), JSON.stringify({ version: 1, reason,
      createdAt: new Date().toISOString(), source: saveDir, files: records, mods }, null, 2), { flag: 'wx' });
    return { id, directory: complete, count: files.length, mods: mods.length };
  } catch (error) {
    try { fs.rmSync(complete, { recursive: true, force: true, maxRetries: 5 }); } catch (_) { /* the backup error matters more */ }
    throw error;
  }
}

function listBackups(destination = backupRoot()) {
  if (!fs.existsSync(destination)) return [];
  return fs.readdirSync(destination, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(destination, entry.name, 'manifest.json'), 'utf8'));
        return manifest.version === 1 ? { id: entry.name, reason: manifest.reason,
          createdAt: manifest.createdAt, count: manifest.files.length,
          mods: Array.isArray(manifest.mods) ? manifest.mods.length : 0, source: manifest.source } : null;
      } catch (_) { return null; }
    }).filter(Boolean).sort((a, b) => b.id.localeCompare(a.id));
}

function restoreBackup(id, saveDir, destination = backupRoot()) {
  if (!/^[0-9TZ-]+-[a-f0-9]{6}$/.test(id)) throw new Error('Invalid backup selection.');
  const folder = path.join(destination, id);
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length)
    throw new Error('Backup manifest is invalid.');
  for (const file of manifest.files) {
    if (typeof file.name !== 'string' || file.name !== path.basename(file.name) || !isCardFile(file.name) ||
      !/^[a-f0-9]{64}$/.test(file.hash) || digest(path.join(folder, 'files', file.name)) !== file.hash)
      throw new Error(`Backup verification failed for ${file.name}.`);
  }
  // Mods' files (backups since they were kept): absent from older backups, which leave the current ones as they are.
  const mods = manifest.mods;
  if (mods !== undefined && !Array.isArray(mods)) throw new Error('Backup manifest is invalid.');
  for (const file of mods || []) {
    if (!file || !isModSavePath(file.name) || !/^[a-f0-9]{64}$/.test(file.hash) ||
      digest(path.join(folder, 'mods', ...file.name.split('/'))) !== file.hash)
      throw new Error(`Backup verification failed for ${file && file.name}.`);
  }
  const current = backupSaves(saveDir, destination, 'before-restore');
  fs.mkdirSync(saveDir, { recursive: true });
  for (const file of manifest.files) {
    const temporary = path.join(saveDir, `.${file.name}.restore-${process.pid}`);
    try {
      fs.copyFileSync(path.join(folder, 'files', file.name), temporary);
      fs.renameSync(temporary, path.join(saveDir, file.name));
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  if (mods) {
    // the mods' folder as it was then: built beside it, then put in its place (the current one is in the backup above)
    const modDir = modSaveDirectory(saveDir);
    const staging = `${modDir}.restore-${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    try {
      fs.mkdirSync(staging, { recursive: true });
      for (const file of mods) {
        const target = path.join(staging, ...file.name.split('/'));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(folder, 'mods', ...file.name.split('/')), target);
      }
      // a sync tool's marker and settings stay with the folder (Syncthing stops syncing a folder whose marker went)
      let kept = 0;
      try {
        for (const name of fs.readdirSync(modDir).filter(isSyncMetadata)) {
          fs.renameSync(path.join(modDir, name), path.join(staging, name));
          kept++;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.rmSync(modDir, { recursive: true, force: true });
      if (mods.length || kept) fs.renameSync(staging, modDir);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  return { restored: manifest.files.length, restoredMods: mods ? mods.length : 0, previous: current.directory || null };
}

function moveBuildKeepingSaves(buildDirectory, destination, saveDir, backups = backupRoot()) {
  const relative = path.relative(path.resolve(buildDirectory), path.resolve(saveDir));
  const inside = relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  const backup = inside ? backupSaves(saveDir, backups, 'before-tools-change') : null;
  fs.renameSync(buildDirectory, destination);
  try {
    if (backup && !backup.empty) restoreBackup(backup.id, saveDir, backups);
  } catch (error) {
    // Preserve any partly restored files as well as the untouched previous build.
    if (fs.existsSync(buildDirectory)) fs.renameSync(buildDirectory, `${buildDirectory}.restore-failed-${crypto.randomUUID()}`);
    fs.renameSync(destination, buildDirectory);
    throw error;
  }
  return backup;
}

module.exports = { saveDirectory, gameSaveDirectory, prepareSaveDirectory, guestSaveDirectory, moveOldGuestSaves, backupRoot, modSaveDirectory,
  cleanupWouldRemoveSaves, backupSaves, listBackups, restoreBackup, moveBuildKeepingSaves };
