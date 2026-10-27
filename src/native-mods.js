'use strict';

// Native mods: libraries the game loads from mods/<id>/ (the mod SDK,
// https://github.com/chasem-dev/sms-mod-sdk). The launcher offers the ones in
// native-mods.json: it downloads a mod's newest GitHub release into a folder of
// its own, which the game is told about (SMS_NATIVE_MODS_DIR), and switches it
// on and off in the game's own list (native-mods.ini, which the game's Mods
// menu, F1, also changes), so the launcher and the game always agree.
// The list itself is read again from mods.json on the launcher repository's
// main branch, so a mod added there is offered without a launcher update.
// native-mods.json is the copy built in, for when GitHub cannot be reached.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const CATALOG = require('./native-mods.json');
const { retrying, httpError } = require('./retry');
const MAX_SIZE = 64 << 20; // far beyond a mod's zip: a larger one is not a mod
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // a folder name, never . or ..
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const MAX_MODS = 100;

function catalogUrl(env = process.env) {
  return env.SMS_NATIVE_MODS_CATALOG_URL || 'https://raw.githubusercontent.com/chasem-dev/sms-launcher/main/mods.json';
}

function text(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }

// Untrusted JSON -> the mods a launcher of version `launcher` ("0.1.68") can
// offer: a mod with a newer minLauncher needs something only newer launchers do.
// Without a version (the bundled list, which this launcher was built with) all stay.
function normalizeCatalog(data, launcher) {
  const check = launcher !== undefined;
  launcher = String(launcher || '').split(/[-+]/)[0];
  const seen = new Set();
  const entries = [];
  for (const entry of Array.isArray(data) ? data : []) {
    if (!entry || typeof entry !== 'object' || !ID.test(entry.id) || seen.has(entry.id) || !REPOSITORY.test(entry.repository)) continue;
    if (entry.api !== undefined && !parseApi(entry.api)) continue;
    if (entry.minLauncher !== undefined && (!VERSION.test(entry.minLauncher) || (check && (!VERSION.test(launcher) || newer(entry.minLauncher, launcher))))) continue;
    seen.add(entry.id);
    entries.push({ id: entry.id, name: text(entry.name, 80) || entry.id, author: text(entry.author, 60), description: text(entry.description, 600),
      repository: entry.repository, api: entry.api === undefined ? '' : String(entry.api) });
    if (entries.length >= MAX_MODS) break;
  }
  return entries;
}

const BUNDLED = normalizeCatalog(CATALOG);
let current = BUNDLED;
let published = null; // the list last read from GitHub (or the copy saved from it), or null

// The published list wins for each mod it has, so a mod's text or repository
// can change; mods only this launcher has (a preview's new one) stay.
function mergeCatalog(published, bundled = BUNDLED) {
  const ids = new Set(published.map(entry => entry.id));
  return published.concat(bundled.filter(entry => !ids.has(entry.id)));
}

function catalog() { return current.map(entry => ({ ...entry })); }

function usePublished(entries) {
  published = entries;
  current = mergeCatalog(entries);
}

// Identifies one version of the published list, as this launcher offers it:
// the Mods tab shows a dot until the player has seen the list with this key.
function listKey(entries = published) {
  return entries ? crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16) : null;
}

// The published list as last downloaded, kept so the launcher offers it, and
// knows whether it changed, without GitHub.
function listFile(userData) { return path.join(userData, 'native-mods-list.json'); }

function loadSavedCatalog(userData, launcher) {
  try { usePublished(normalizeCatalog(JSON.parse(fs.readFileSync(listFile(userData), 'utf8')), launcher)); return true; }
  catch (_) { return false; }
}

// Reads the published list (mods.json on main) and offers it from then on,
// saving a copy in `userData`; when GitHub cannot be reached the last list read stays.
async function refreshCatalog(fetch, { launcher, url = catalogUrl(), userData } = {}) {
  const response = await fetch(url, { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`GitHub did not send the mod list (${response.status}).`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('GitHub sent a mod list the launcher cannot read.');
  usePublished(normalizeCatalog(data, launcher));
  if (userData) {
    const file = listFile(userData), temporary = `${file}.tmp`;
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(data.slice(0, MAX_MODS)));
    fs.renameSync(temporary, file);
  }
  return catalog();
}

function directory(userData) { return path.join(userData, 'native-mods'); }

// Where the game keeps its mods' settings and native-mods.ini, as the game
// finds it (ext/modapi/host/mod_runtime.cpp, dataRoot).
function dataRoot(env = process.env, platform = process.platform) {
  if (env.SMS_NATIVE_MODS_DATA) return env.SMS_NATIVE_MODS_DATA;
  if (env.XDG_DATA_HOME) return path.join(env.XDG_DATA_HOME, 'sms-port', 'mods');
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'sms-port', 'mods');
  return path.join(env.HOME || '.', '.local', 'share', 'sms-port', 'mods');
}

// key = value lines; # and ; start comments (the game's readIni)
function parseIni(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || '#;['.includes(line[0])) continue;
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function readIni(file) {
  try { return parseIni(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}

function splitList(value) { return String(value || '').split(/[,; \t]+/).filter(Boolean); }

function offListFile(env, platform) { return path.join(dataRoot(env, platform), 'native-mods.ini'); }

// The mods the game's Mods menu (or the launcher) switched off.
function offList(env = process.env, platform = process.platform) {
  return splitList(readIni(offListFile(env, platform)).off);
}

function isEnabled(id, env = process.env, platform = process.platform) { return !offList(env, platform).includes(id); }

// Writes the list as the game does: its other keys kept, one header line.
function setEnabled(id, on, env = process.env, platform = process.platform) {
  if (!ID.test(id)) throw new Error('That is not a mod.');
  const file = offListFile(env, platform);
  const ini = readIni(file);
  const off = new Set(splitList(ini.off));
  if (on) off.delete(id); else off.add(id);
  ini.off = [...off].sort().join(';');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = ['# native mods switched off in the Mods menu (F1)', ...Object.keys(ini).sort().map(key => `${key} = ${ini[key]}`)];
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${lines.join('\n')}\n`);
  fs.renameSync(temporary, file);
  return on;
}

// The mod API a game folder was built with (its sdk/ submodule), or null.
function gameApi(root) {
  try {
    const header = fs.readFileSync(path.join(root, 'sdk', 'include', 'sms_mod.h'), 'utf8');
    const major = /#define\s+SMS_MOD_API_MAJOR\s+(\d+)/.exec(header);
    const minor = /#define\s+SMS_MOD_API_MINOR\s+(\d+)/.exec(header);
    return major && minor ? { major: Number(major[1]), minor: Number(minor[1]) } : null;
  } catch (_) { return null; }
}

function parseApi(text) {
  const match = /^(\d+)\.(\d+)$/.exec(String(text || '').trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

// Whether a game with mod API `have` runs a mod that needs `need` ("1.4").
function supports(have, need) {
  const want = typeof need === 'string' ? parseApi(need) : need;
  if (!want) return true;
  return Boolean(have) && have.major === want.major && have.minor >= want.minor;
}

// The mods in the launcher's folder: { id, name, version, dir, release }.
function installed(userData) {
  const root = directory(userData);
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name); } catch (_) { return []; }
  const mods = [];
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const dir = path.join(root, name);
    const ini = readIni(path.join(dir, 'mod.ini'));
    if (!Object.keys(ini).length) continue;
    let release = null;
    try { release = JSON.parse(fs.readFileSync(path.join(dir, '.release.json'), 'utf8')); } catch (_) {}
    mods.push({ id: ini.id || name, name: ini.name || ini.id || name, version: ini.version || '', author: ini.author || '', description: ini.description || '', dir, release });
  }
  return mods;
}

// What the game is told at launch: the game's own mods/ and the launcher's
// folder. Only for games whose mod API is 1.4 or newer, which take a list with
// spaces in its paths (older ones split it at spaces too, and would lose their
// own mods/ in a folder named with spaces).
function environment(root, userData) {
  if (!installed(userData).length || !supports(gameApi(root), '1.4')) return {};
  return { SMS_NATIVE_MODS_DIR: [path.join(root, 'mods'), directory(userData)].join(';') };
}

function versionOf(tag) { return String(tag || '').replace(/^v/i, ''); }

// Is version `a` newer than `b`? ("1.10.0" > "1.9.2")
function newer(a, b) {
  const split = value => versionOf(value).split(/[.+-]/).map(part => Number.parseInt(part, 10) || 0);
  const x = split(a), y = split(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// A mod's newest release: its tag, version and the zip to download.
// Both ask GitHub again when the connection fails or it is briefly down.
async function latestRelease(entry, fetch, { wait } = {}) {
  const release = await retrying(async () => {
    const response = await fetch(`https://api.github.com/repos/${entry.repository}/releases/latest`,
      { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (response.status === 404) throw httpError(`${entry.name} has no release yet.`, 404);
    if (!response.ok) throw httpError(`GitHub did not answer about ${entry.name} (${response.status}).`, response.status);
    return response.json();
  }, { wait });
  const zips = (release.assets || []).filter(asset => /\.zip$/i.test(asset.name));
  const asset = zips.find(item => item.name.startsWith(`${entry.id}-`)) || zips[0];
  if (!asset) throw new Error(`${entry.name}'s newest release has no zip.`);
  return { tag: release.tag_name, version: versionOf(release.tag_name), url: asset.browser_download_url, asset: asset.name, size: asset.size };
}

// Every file of a zip archive: [{ name, data }], stored or deflated entries.
function unzip(data) {
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('The download is not a zip file.');
  const files = [];
  let at = data.readUInt32LE(end + 16);
  for (let index = data.readUInt16LE(end + 10); index > 0; index--) {
    if (data.readUInt32LE(at) !== 0x02014b50) throw new Error('The zip file is damaged.');
    const method = data.readUInt16LE(at + 10), packed = data.readUInt32LE(at + 20), size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28), extra = data.readUInt16LE(at + 30), comment = data.readUInt16LE(at + 32);
    const local = data.readUInt32LE(at + 42);
    const name = data.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra + comment;
    if (name.endsWith('/')) continue;
    if (data.readUInt32LE(local) !== 0x04034b50) throw new Error('The zip file is damaged.');
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const stored = data.subarray(start, start + packed);
    const file = method === 0 ? stored : method === 8 ? zlib.inflateRawSync(stored) : null;
    if (!file || file.length !== size) throw new Error(`Could not unpack ${name}.`);
    files.push({ name, data: file });
  }
  return files;
}

// Puts a release's zip (<id>/ with mod.ini and its libraries) in place of the
// installed copy, all at once: a failed download leaves the old one.
function installZip(userData, entry, data, release = {}) {
  if (!ID.test(entry.id)) throw new Error('That is not a mod.');
  const root = directory(userData);
  fs.mkdirSync(root, { recursive: true });
  const staging = path.join(root, `.staging-${entry.id}-${crypto.randomUUID()}`);
  const target = path.join(root, entry.id);
  const old = `${target}.old-${crypto.randomUUID()}`;
  try {
    let wrote = 0;
    for (const file of unzip(data)) {
      const parts = file.name.split(/[\\/]+/).filter(Boolean);
      if (parts[0] !== entry.id || parts.length < 2) continue; // only the mod's folder
      if (parts.some(part => part === '..' || part === '.') || path.isAbsolute(file.name)) throw new Error('The zip file has a path outside its folder.');
      const destination = path.join(staging, ...parts.slice(1));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, file.data);
      wrote++;
    }
    const ini = readIni(path.join(staging, 'mod.ini'));
    if (!wrote || ini.id !== entry.id) throw new Error(`The download is not ${entry.name}.`);
    fs.writeFileSync(path.join(staging, '.release.json'), JSON.stringify({ tag: release.tag || '', asset: release.asset || '', installedAt: new Date().toISOString() }, null, 2));
    if (fs.existsSync(target)) fs.renameSync(target, old);
    fs.renameSync(staging, target);
    fs.rmSync(old, { recursive: true, force: true });
    return { id: entry.id, version: ini.version || release.version || '', dir: target };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (!fs.existsSync(target) && fs.existsSync(old)) fs.renameSync(old, target);
    throw error;
  }
}

async function download(userData, entry, fetch, { wait } = {}) {
  const release = await latestRelease(entry, fetch, { wait });
  if (release.size > MAX_SIZE) throw new Error(`${entry.name}'s download is too large to be a mod.`);
  const data = await retrying(async () => {
    const response = await fetch(release.url, { cache: 'no-store', signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw httpError(`Could not download ${entry.name} (${response.status}).`, response.status);
    return Buffer.from(await response.arrayBuffer());
  }, { wait });
  if (data.length > MAX_SIZE) throw new Error(`${entry.name}'s download is too large to be a mod.`);
  return installZip(userData, entry, data, release);
}

// A mod's page on GitHub, for its credit link: only the repositories the list names.
function pageUrl(id) {
  const entry = current.find(item => item.id === id);
  return entry ? `https://github.com/${entry.repository}` : null;
}

function remove(userData, id) {
  if (!ID.test(id)) throw new Error('That is not a mod.');
  fs.rmSync(path.join(directory(userData), id), { recursive: true, force: true });
}

// What the Mods page shows: the launcher's mods and any other in its folder,
// each with whether it is on and whether this game can run it.
function list(userData, root, env = process.env, platform = process.platform) {
  const have = root ? gameApi(root) : null;
  const off = offList(env, platform);
  const present = installed(userData);
  const rows = catalog().map(entry => ({ ...entry, installed: present.find(mod => mod.id === entry.id) || null }));
  for (const mod of present) if (!rows.some(row => row.id === mod.id)) rows.push({ id: mod.id, name: mod.name, author: '', description: mod.description, repository: '', api: '', installed: mod });
  return {
    folder: directory(userData),
    gameApi: have ? `${have.major}.${have.minor}` : null,
    // Who made each mod: the list's credit, else its own mod.ini's author.
    mods: rows.map(row => ({ ...row, author: row.author || row.installed?.author || '', enabled: !off.includes(row.id), supported: supports(have, row.api) }))
  };
}

module.exports = { MAX_SIZE, catalogUrl, normalizeCatalog, mergeCatalog, refreshCatalog, loadSavedCatalog, listKey, listFile, catalog, directory, dataRoot, parseIni, offList, isEnabled, setEnabled, gameApi, supports, installed, environment, newer, latestRelease, unzip, installZip, download, pageUrl, remove, list };
