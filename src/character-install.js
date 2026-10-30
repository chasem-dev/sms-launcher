'use strict';
// Adding character packs to the game's mods/characters/ from the Characters
// page: a pack's folder (<id>/ with model.szs, name.txt and voice/), a folder
// of packs, a zip of one or more, or a lone model archive (.szs/.arc). Each
// model is checked to be a whole Mario archive the game can play before it
// is put in place.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { unzip } = require('./native-mods');
const { rarc, yaz0 } = require('./archive');
const j3d = require('./j3d');

const MODEL = 'bmd/ma_mdl1.bmd';
const IDLE = 'bck/ma_wait.bck';
const MAX_SIZE = 256 << 20;
const MAX_VOICE = 8 << 20;
const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;

const slug = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'character';
const title = id => id.split(/[-_]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
const isModel = name => /\.(szs|arc)$/i.test(name);

// Throws unless `data` is a Mario archive with a body model on his 29 joints and his animations.
function checkModel(data, label) {
  let files, model;
  try {
    files = rarc(yaz0(data));
    model = files.has(MODEL) ? j3d.parseBmd(files.get(MODEL)) : null;
  } catch (_) { throw new Error(`${label} is not a game archive.`); }
  if (!model) throw new Error(`${label} has no ${MODEL}: it is not a character model.`);
  if (model.joints.length !== 29) throw new Error(`${label}'s model has ${model.joints.length} joints, not Mario's 29.`);
  if (!files.has(IDLE)) throw new Error(`${label} is not a whole Mario archive (it has no ${IDLE}).`);
}

// One pack from a list of { name, data } relative to the pack's folder.
function pack(id, entries, fallbackName) {
  const get = name => entries.find(entry => entry.name.toLowerCase() === name);
  const model = get('model.szs');
  const nameFile = get('name.txt');
  const voice = entries.filter(entry => /^voice\/[^/]+\.wav$/i.test(entry.name) && entry.data.length <= MAX_VOICE)
    .map(entry => ({ name: path.basename(entry.name), data: entry.data }));
  const named = nameFile && nameFile.data.toString('utf8').trim();
  return { id: slug(id), name: named || fallbackName || title(slug(id)), named: Boolean(named), model: model.data, voice };
}

// Every pack in a set of files ({ name: 'a/b/c', data }), as laid out in a zip or a folder:
// each folder with a model.szs is a pack, and any other .szs/.arc is a pack of its own.
function packsIn(files, baseName) {
  const out = [];
  const folders = files.filter(file => /(^|\/)model\.szs$/i.test(file.name)).map(file => file.name.slice(0, -'model.szs'.length));
  for (const folder of folders) {
    const entries = files.filter(file => file.name.startsWith(folder)).map(file => ({ name: file.name.slice(folder.length), data: file.data }));
    const id = folder.split('/').filter(Boolean).pop() || baseName;
    out.push(pack(id, entries));
  }
  for (const file of files) {
    if (!isModel(file.name) || /(^|\/)model\.szs$/i.test(file.name)) continue;
    if (folders.some(folder => file.name.startsWith(folder))) continue;
    const id = path.posix.basename(file.name).replace(/\.(szs|arc)$/i, '');
    out.push({ id: slug(id), name: title(slug(id)), named: false, model: file.data, voice: [] });
  }
  return out;
}

function readFolder(directory, prefix = '', depth = 0, out = []) {
  if (depth > 3) return out;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name), name = prefix + entry.name;
    if (entry.isDirectory()) readFolder(full, `${name}/`, depth + 1, out);
    else if (entry.isFile() && (isModel(entry.name) || /\.(txt|wav)$/i.test(entry.name)) && fs.statSync(full).size <= MAX_SIZE)
      out.push({ name, data: fs.readFileSync(full) });
  }
  return out;
}

// The packs in what the player picked or dropped.
function packsFrom(file) {
  const stat = fs.statSync(file);
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  if (stat.isDirectory()) return packsIn(readFolder(file, `${path.basename(file)}/`), path.basename(file));
  if (stat.size > MAX_SIZE) throw new Error(`${path.basename(file)} is too large to be a character.`);
  const data = fs.readFileSync(file);
  if (/\.zip$/i.test(file)) {
    const files = unzip(data).filter(entry => !entry.name.startsWith('__MACOSX/'))
      .map(entry => ({ name: entry.name.replace(/\\/g, '/'), data: entry.data }));
    if (files.some(entry => entry.name.split('/').includes('..'))) throw new Error('The zip file has a path outside its folder.');
    return packsIn(files, base);
  }
  if (isModel(file)) return [{ id: slug(base), name: title(slug(base)), named: false, model: data, voice: [] }];
  throw new Error(`${path.basename(file)} is not a character: choose a pack's folder, a .zip, or a .szs.`);
}

// A free id beside the installed ones: toad, toad-2, toad-3...
function freeId(directory, id) {
  let out = id;
  for (let n = 2; fs.existsSync(path.join(directory, out)) || fs.existsSync(path.join(directory, `${out}.szs`)); n++) out = `${id}-${n}`;
  return out;
}

// Puts one checked pack in place as mods/characters/<id>/, all at once.
function install(directory, item, id = item.id, check = checkModel) {
  if (!ID.test(id)) throw new Error(`${id} is not a usable character id.`);
  check(item.model, item.name);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, id);
  const staging = path.join(directory, `.staging-${id}-${crypto.randomUUID()}`);
  const old = `${target}.old-${crypto.randomUUID()}`;
  try {
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'model.szs'), item.model);
    // A new model for an installed character keeps its name and voice unless the new pack has its own.
    let name = item.name;
    if (!item.named) try { name = fs.readFileSync(path.join(target, 'name.txt'), 'utf8').trim() || name; } catch (_) {}
    fs.writeFileSync(path.join(staging, 'name.txt'), `${name}\n`);
    if (!item.voice.length && fs.existsSync(path.join(target, 'voice')))
      fs.cpSync(path.join(target, 'voice'), path.join(staging, 'voice'), { recursive: true });
    if (item.voice.length) {
      fs.mkdirSync(path.join(staging, 'voice'));
      for (const voice of item.voice) fs.writeFileSync(path.join(staging, 'voice', path.basename(voice.name)), voice.data);
    }
    // a loose <id>.szs would be a second character of the same id
    const loose = path.join(directory, `${id}.szs`);
    if (fs.existsSync(target)) fs.renameSync(target, old);
    fs.renameSync(staging, target);
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(loose)) fs.rmSync(loose, { force: true });
    return id;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (!fs.existsSync(target) && fs.existsSync(old)) fs.renameSync(old, target);
    throw error;
  }
}

module.exports = { packsFrom, packsIn, checkModel, install, freeId, slug, ID, MAX_SIZE };
