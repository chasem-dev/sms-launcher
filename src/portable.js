'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { baseVersion, compareVersions } = require('./changelog');

// The Windows portable build keeps everything in this folder beside its .exe.
const FOLDER = 'SMS-Launcher-Portable';
const PATH_KEYS = ['repo', 'rom', 'installRoot', 'saveDirectory'];

// electron-builder's portable stub runs the app from a temporary copy and
// passes the folder the .exe was opened from.
function root(env = process.env, platform = process.platform) {
  const directory = env.PORTABLE_EXECUTABLE_DIR;
  return platform === 'win32' && directory ? path.join(directory, FOLDER) : null;
}

function inside(base, file) {
  const relative = path.relative(base, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function mapPaths(saved, convert) {
  if (!saved || typeof saved !== 'object') return saved;
  const mapped = { ...saved };
  for (const key of PATH_KEYS) if (typeof mapped[key] === 'string' && mapped[key]) mapped[key] = convert(mapped[key]);
  if (mapped.previousInstall) mapped.previousInstall = mapPaths(mapped.previousInstall, convert);
  return mapped;
}

// Paths inside the portable folder are saved relative to it, so the folder
// still works after it moves to another drive or computer.
function storedPaths(config, base) {
  if (!base) return config;
  return mapPaths(config, value => path.isAbsolute(value) && inside(base, value) ? path.relative(base, value) || '.' : value);
}

function resolvedPaths(saved, base) {
  if (!base) return saved;
  return mapPaths(saved, value => path.isAbsolute(value) ? value : path.resolve(base, value));
}

// A path recorded inside the portable folder before it moved, such as the
// build tools a game was built with, moved to where the folder is now.
function relocated(file, base) {
  if (!base || typeof file !== 'string' || !(path.isAbsolute(file) || path.win32.isAbsolute(file)) || fs.existsSync(file)) return file;
  const parts = file.split(/[\\/]+/);
  const index = parts.map(part => part.toLowerCase()).lastIndexOf(FOLDER.toLowerCase());
  if (index < 0) return file;
  const moved = path.join(base, ...parts.slice(index + 1));
  return fs.existsSync(moved) ? moved : file;
}

// The game reads the player's disc whenever it runs. A disc in the portable
// folder, or beside the launcher's .exe, for a folder whose chosen disc
// stayed on the computer it came from.
function findDisc(base, validate) {
  for (const directory of [base, path.dirname(base)]) {
    let names;
    try { names = fs.readdirSync(directory).sort(); } catch (_) { continue; }
    for (const name of names) {
      if (!/\.(?:iso|gcm|ciso)$/i.test(name)) continue;
      try { return validate(path.join(directory, name)); } catch (_) { /* not this game's disc */ }
    }
  }
  return null;
}

// The game keeps its compiled shaders in %LOCALAPPDATA%\sms-port unless told
// otherwise; the portable build keeps them with everything else.
function shaderCache(base, arch) {
  return path.join(base, 'cache', `gx-programs-${arch === '32' ? '32' : '64'}.bin`);
}

// The same for the mip levels the game makes for HD textures (texture-mips beside the shaders).
function textureCache(base) { return path.join(base, 'cache', 'texture-mips'); }

// A portable launcher never updates itself (the updater would swap it for the
// installer build), so the status bar says when a newer Stable release is out.
// latestTag is GitHub's latest release tag ("v0.1.65"), or null when unknown.
function updateNotice(current, latestTag) {
  const latest = baseVersion(String(latestTag || '').replace(/^v/, '')), installed = baseVersion(current);
  if (latest && installed && compareVersions(latest, installed) > 0)
    return { state: 'available', latest,
      message: `Launcher ${latest} is out. Portable launchers don't update themselves: download it from the releases page.` };
  return { state: 'unconfigured', message: 'Portable launcher: download new versions from the releases page.' };
}

// The launcher's scripts, copied out of its resources. The portable stub
// unpacks the launcher to the same temporary folder at every start and deletes
// it when that start ends, so a second start (opening the .exe again, a Discord
// invite), which hands over to the running launcher and quits, deletes the
// scripts out from under it. Returns the copy's folder, or null without one.
function copyScripts(from, base) {
  const directory = path.join(base, 'launcher-scripts');
  try {
    fs.mkdirSync(directory, { recursive: true });
    for (const name of fs.readdirSync(from)) {
      const temporary = path.join(directory, `${name}.${process.pid}.tmp`);
      fs.copyFileSync(path.join(from, name), temporary);
      fs.renameSync(temporary, path.join(directory, name));
    }
  } catch (_) { /* a copy from an earlier start still serves */ }
  return fs.existsSync(directory) ? directory : null;
}

module.exports = { FOLDER, root, inside, storedPaths, resolvedPaths, relocated, findDisc, shaderCache, textureCache, updateNotice, copyScripts };
