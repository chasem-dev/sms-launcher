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
const { withFolder } = require('./rarc-write');
const { convertSunshine } = require('./character-convert');

// A built character's version: made again when its builder changes.
const STAMP = '.launcher.json';

// Shadow Mario: Mario's own archive with a look/ folder added, the plaza's Shadow Mario look (his
// model on Mario's skeleton and its scrolling texture), which the game draws in Mario's place as it
// draws Shadow Mario (the port's character look, patch zzzzzz-character-04).
function shadowMario(disc) {
  const plaza = rarc(yaz0(disc.file('data/scene/dolpic1.szs')));
  const look = plaza.get('kagemario/default.bmd'), scroll = plaza.get('kagemario/kagemario_scroll.btk');
  if (!look || !scroll) throw new Error('Your disc\'s Delfino Plaza has no Shadow Mario.');
  return { 'model.szs': withFolder(disc.file('data/mario.szs'), 'look', { 'default.bmd': look, 'kagemario_scroll.btk': scroll }) };
}

// Princess Peach: the plaza's Peach (her body, hair and hands) on Mario's skeleton, at her own height,
// with every one of his animations fitted to her and her gown (character-convert.js). Her fists are her
// closed hands (hand2), the models Mario opens his hands into are her open ones (hand1).
const PEACH_LABELS = {
  jnt_waist: 'hips', jnt_skirt: 'skirt', koshi_null: 'skirt', skirt_null: 'skirt', jnt_chest: 'spine', kubi: 'head',
  jnt_sldr_L: 'shoulder.L', jnt_arm_L1: 'upperarm.L', jnt_arm_L2: 'forearm.L', jnt_hand_L: 'hand.L',
  jnt_sldr_R: 'shoulder.R', jnt_arm_R1: 'upperarm.R', jnt_arm_R2: 'forearm.R', jnt_hand_R: 'hand.R',
  jnt_leg_L1: 'thigh.L', jnt_leg_L2: 'shin.L', jnt_foot_L: 'foot.L', jnt_leg_R1: 'thigh.R', jnt_leg_R2: 'shin.R', jnt_foot_R: 'foot.R',
};
function peach(disc, progress) {
  const plaza = rarc(yaz0(disc.file('data/scene/dolpic1.szs')));
  const get = name => {
    const data = plaza.get(`peach/${name}`);
    if (!data) throw new Error(`Your disc's Delfino Plaza has no ${name}.`);
    return data;
  };
  const { model } = convertSunshine({
    body: get('peach_model.bmd'), labels: PEACH_LABELS, marioSzs: disc.file('data/mario.szs'), gown: true, progress,
    parts: [
      { data: get('peach_hair_normal.bmd'), joint: 'kubi' },
      { data: get('peach_hand2_l.bmd'), joint: 'jnt_hand_L' }, { data: get('peach_hand2_r.bmd'), joint: 'jnt_hand_R' },
      { data: get('peach_hand1_l.bmd'), joint: 'jnt_hand_L', part: 'open', side: 'L' },
      { data: get('peach_hand1_r.bmd'), joint: 'jnt_hand_R', part: 'open', side: 'R' },
    ],
  });
  return { 'model.szs': model };
}

const ROSTER = [
  { id: 'mario', name: 'Mario', about: 'As on your disc.' },
  { id: 'princess-peach', name: 'Princess Peach', about: 'Delfino\'s Peach, gown and all, on Mario\'s moves.', version: 1, build: peach },
  { id: 'shadow-mario', name: 'Shadow Mario', about: 'The paintbrush impostor, see-through and shimmering, as he looks in Delfino Plaza.', version: 2, build: shadowMario },
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
function build(root, rom, id, progress = () => {}) {
  const character = find(id);
  if (!character.build) return;
  const disc = new Disc(rom);
  let files;
  try { files = character.build(disc, progress); } finally { disc.close(); }
  install(root, character, files);
}

function install(root, character, files) {
  const id = character.id, directory = packsDirectory(root), target = path.join(directory, id);
  fs.mkdirSync(directory, { recursive: true });
  // a pack the launcher didn't make (a player's own) is never replaced
  if (fs.existsSync(target) && !fs.existsSync(path.join(target, STAMP)))
    throw new Error(`mods/characters/${id} is a character pack of your own: move it to make ${character.name} there.`);
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

// The archive the viewer draws for a character (its look model, if it has one, is inside it).
function archive(root, rom, id) {
  if (id === 'mario') {
    const disc = new Disc(rom);
    try { return disc.file('data/mario.szs'); } finally { disc.close(); }
  }
  return fs.readFileSync(path.join(packsDirectory(root), id, 'model.szs'));
}

const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;

module.exports = { ROSTER, list, build, install, archive, find, packsDirectory, ID };
