'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { unzip } = require('./native-mods');
const { fetchVerified } = require('./build-tools');

// The achievements' icons: the Achievements page shows them, and the game's
// unlock banner draws them from the folder in SMS_ACHIEVEMENT_ICONS. They are
// one release of sms-hd-texture-extras (achievements/<id>.png and
// achievements/eclipse/<id>.png), kept in the launcher's data folder for every
// game version: a game from before achievements still gets the page, and an
// update doesn't copy them into each new version.
const BUNDLED = require('./achievement-data/icons.json');
const MD5 = /^[0-9a-f]{32}$/;

function directory(userData) { return path.join(userData, 'achievement-icons'); }

// Older launchers installed them in the game folder, through the game's own installer.
function gameDirectory(root) { return path.join(root, 'assets', 'achievements'); }

const valid = pin => Boolean(pin && typeof pin.url === 'string' && /^https:\/\//.test(pin.url) && MD5.test(pin.md5));

// The release to have: the game's own pin (a game version can bring new
// icons), or the launcher's copy of it, for a game from before achievements.
function pinned(root) {
  if (root) {
    try {
      const own = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'mods', 'achievement-icons.json'), 'utf8'));
      if (valid(own)) return own;
    } catch (_) { /* none in this game version */ }
  }
  return BUNDLED;
}

// Whether `folder` holds `pin`, by the MD5 its .release records.
function holds(folder, pin) {
  try { return JSON.parse(fs.readFileSync(path.join(folder, '.release'), 'utf8')).md5 === pin.md5; }
  catch (_) { return false; }
}

// The folder with the pinned icons (Super Mario Eclipse's in its eclipse/), or null without them.
function folder(userData, root, eclipse = false) {
  const pin = pinned(root);
  const found = [directory(userData), root && gameDirectory(root)].find(item => item && holds(item, pin));
  return found ? (eclipse ? path.join(found, 'eclipse') : found) : null;
}

function wanted(userData, root) { return !folder(userData, root); }

// Puts `files` (the zip's achievements/...) in place of the installed icons all at once, so a failed
// install leaves the old ones. `required`: the icons the lists name, as achievements/<id>.png paths.
function place(userData, files, pin, required = []) {
  const names = new Set(files.map(file => file.name));
  const missing = required.filter(name => !names.has(name));
  if (missing.length) throw new Error(`The download has no ${missing[0]}.`);
  const target = directory(userData);
  const staging = `${target}.staging-${crypto.randomUUID()}`;
  const old = `${target}.old-${crypto.randomUUID()}`;
  try {
    for (const file of files) {
      const parts = file.name.split('/');
      if (file.name.endsWith('/')) continue;
      if (parts[0] !== 'achievements' || parts.length < 2 || parts.some(part => !part || part === '.' || part === '..' || part.includes('\\')))
        throw new Error('The download is not laid out as achievements/<id>.png.');
      const destination = path.join(staging, ...parts.slice(1));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.data);
    }
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, '.release'), JSON.stringify({ name: pin.name, file: pin.file, md5: pin.md5 }, null, 2));
    if (fs.existsSync(target)) fs.renameSync(target, old);
    fs.renameSync(staging, target);
    fs.rmSync(old, { recursive: true, force: true });
    return target;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (!fs.existsSync(target) && fs.existsSync(old)) fs.renameSync(old, target);
    throw error;
  }
}

// The game folder's icons from an older launcher, when they are the pinned release: copied into the
// launcher's folder instead of downloaded again. True when that is done.
function adopt(userData, root) {
  const pin = pinned(root);
  if (!root || holds(directory(userData), pin) || !holds(gameDirectory(root), pin)) return false;
  const target = directory(userData);
  const staging = `${target}.staging-${crypto.randomUUID()}`;
  try {
    fs.cpSync(gameDirectory(root), staging, { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);
    return true;
  } catch (_) {
    fs.rmSync(staging, { recursive: true, force: true });
    return false;
  }
}

// Downloads the pinned release and installs it, a download that drops tried again (onRetry(error, n)).
// `onProgress(percent)`; `required` as in place().
async function install(userData, root, { required = [], onProgress = () => {}, onRetry, fetch = fetchVerified, wait } = {}) {
  const pin = pinned(root);
  fs.mkdirSync(userData, { recursive: true });
  const zip = path.join(userData, `achievement-icons-${pin.md5}.zip`);
  try {
    await fetch(pin.url, zip, pin.md5, onProgress, { wait, onRetry, algorithm: 'md5', name: 'achievement icon' });
    return place(userData, unzip(fs.readFileSync(zip)), pin, required);
  } finally {
    fs.rmSync(zip, { force: true });
    fs.rmSync(`${zip}.part`, { force: true });
  }
}

module.exports = { BUNDLED, directory, gameDirectory, pinned, holds, folder, wanted, place, adopt, install };
