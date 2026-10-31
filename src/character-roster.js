'use strict';
// The characters the launcher offers. Mario is the disc's own; each other one
// is made from the player's own disc, the first time it is chosen, into the
// game's mods/characters/<id>/ (model.szs, name.txt, and for some a look
// model the game draws in place of the body). Nothing of the game ships with
// the launcher: every file comes from the player's disc.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Disc } = require('./disc');
const { rarc, yaz0 } = require('./archive');

// A built character's version: made again when its builder changes.
const STAMP = '.launcher.json';

// Shadow Mario: Mario's own archive, and the plaza's Shadow Mario look (his model on Mario's skeleton
// and its scrolling texture), which the game draws in Mario's place (the port's look.bmd/look.btk).
function shadowMario(disc) {
  const plaza = rarc(yaz0(disc.file('data/scene/dolpic1.szs')));
  const look = plaza.get('kagemario/default.bmd'), scroll = plaza.get('kagemario/kagemario_scroll.btk');
  if (!look || !scroll) throw new Error('Your disc\'s Delfino Plaza has no Shadow Mario.');
  return { 'model.szs': disc.file('data/mario.szs'), 'look.bmd': look, 'look.btk': scroll };
}

const ROSTER = [
  { id: 'mario', name: 'Mario', about: 'As on your disc.' },
  { id: 'shadow-mario', name: 'Shadow Mario', about: 'The paintbrush impostor, see-through and shimmering, as he looks in Delfino Plaza.', version: 1, build: shadowMario },
];

function packsDirectory(root) { return path.join(root, 'mods', 'characters'); }

function builtVersion(root, id) {
  try { return JSON.parse(fs.readFileSync(path.join(packsDirectory(root), id, STAMP), 'utf8')).version; } catch (_) { return null; }
}

// The roster with what is built: [{ id, name, about, ready }].
function list(root) {
  return ROSTER.map(({ id, name, about, version }) => ({ id, name, about,
    ready: id === 'mario' || Boolean(root && builtVersion(root, id) === version && fs.existsSync(path.join(packsDirectory(root), id, 'model.szs'))) }));
}

function find(id) {
  const character = ROSTER.find(c => c.id === id);
  if (!character) throw new Error(`There is no character ${id}.`);
  return character;
}

// Makes a character from the disc into mods/characters/<id>/, all at once (a failed build leaves
// what was there).
function build(root, rom, id) {
  const character = find(id);
  if (!character.build) return;
  const disc = new Disc(rom);
  let files;
  try { files = character.build(disc); } finally { disc.close(); }
  install(root, character, files);
}

function install(root, character, files) {
  const id = character.id, directory = packsDirectory(root), target = path.join(directory, id);
  fs.mkdirSync(directory, { recursive: true });
  const staging = path.join(directory, `.staging-${id}-${crypto.randomUUID()}`), old = `${target}.old-${crypto.randomUUID()}`;
  try {
    fs.mkdirSync(staging);
    for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(staging, name), data);
    fs.writeFileSync(path.join(staging, 'name.txt'), `${character.name}\n`);
    fs.writeFileSync(path.join(staging, STAMP), JSON.stringify({ version: character.version, builtAt: new Date().toISOString() }));
    // a voice the player added stays
    if (fs.existsSync(path.join(target, 'voice'))) fs.cpSync(path.join(target, 'voice'), path.join(staging, 'voice'), { recursive: true });
    if (fs.existsSync(target)) fs.renameSync(target, old);
    fs.renameSync(staging, target);
    fs.rmSync(old, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (!fs.existsSync(target) && fs.existsSync(old)) fs.renameSync(old, target);
    throw error;
  }
}

// The archive the viewer draws for a character, and its look model if it has one.
function archive(root, rom, id) {
  if (id === 'mario') {
    const disc = new Disc(rom);
    try { return { model: disc.file('data/mario.szs'), look: null }; } finally { disc.close(); }
  }
  const folder = path.join(packsDirectory(root), id), lookFile = path.join(folder, 'look.bmd');
  return { model: fs.readFileSync(path.join(folder, 'model.szs')), look: fs.existsSync(lookFile) ? fs.readFileSync(lookFile) : null };
}

const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;

module.exports = { ROSTER, list, build, install, archive, find, packsDirectory, ID };
