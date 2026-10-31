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
// How her gown moves (character-convert.js: GOWN_SWAY, GOWN_LEGS). Her gown has few polygons and swings
// far from the hips: the hem follows the thighs a little, bending across its whole width (not creasing
// at the front into a point), and her legs swing much less than Mario's, so running and jumping they
// stay inside it (more and the gown split at the front with a leg through it).
const PEACH_GOWN = { wide: true, sway: 0.35,
  legs: { jnt_leg_L1: 0.3, jnt_leg_R1: 0.3, jnt_leg_L2: 0.15, jnt_leg_R2: 0.15, jnt_foot_L: 0.5, jnt_foot_R: 0.5 } };
function peach(disc, progress, options = {}) {
  const plaza = rarc(yaz0(disc.file('data/scene/dolpic1.szs')));
  const get = name => {
    const data = plaza.get(`peach/${name}`);
    if (!data) throw new Error(`Your disc's Delfino Plaza has no ${name}.`);
    return data;
  };
  const { model } = convertSunshine({
    body: get('peach_model.bmd'), labels: PEACH_LABELS, marioSzs: disc.file('data/mario.szs'), gown: options.gown || PEACH_GOWN, progress, inspect: options.inspect,
    parts: [
      { data: get('peach_hair_normal.bmd'), joint: 'kubi' },
      { data: get('peach_hand2_l.bmd'), joint: 'jnt_hand_L' }, { data: get('peach_hand2_r.bmd'), joint: 'jnt_hand_R' },
      { data: get('peach_hand1_l.bmd'), joint: 'jnt_hand_L', part: 'open', side: 'L' },
      { data: get('peach_hand1_r.bmd'), joint: 'jnt_hand_R', part: 'open', side: 'R' },
    ],
  });
  return { 'model.szs': model };
}

// Characters of the game's own on Mario's skeleton (character-convert.js: convertSunshine), each read
// from the stage archive that has it; labels name the joints that move each part of the body.
const sideLabels = (map) => Object.fromEntries(Object.entries(map).flatMap(([role, [l, r]]) => [[l, `${role}.L`], [r, `${role}.R`]]));
function sunshineCharacter(stage, folder, body, labels, { parts = [], tints = {} } = {}) {
  return (disc, progress) => {
    const files = rarc(yaz0(disc.file(`data/scene/${stage}.szs`)));
    const get = name => {
      const data = files.get(`${folder}/${name}`);
      if (!data) throw new Error(`Your disc has no ${folder}/${name} in ${stage}.`);
      return data;
    };
    const { model } = convertSunshine({ body: get(body), labels, marioSzs: disc.file('data/mario.szs'), progress, tints,
      parts: parts.map(p => ({ ...p, data: get(p.file) })) });
    return { 'model.szs': model };
  };
}

// Toad and Toadsworth share a rig: arms of two joints and a hand with fingers, a leg of one joint.
const TOAD_LABELS = { jnt_lumber: 'hips', jnt_body: 'spine', kubi: 'head',
  ...sideLabels({ upperarm: ['jnt_larm_1', 'jnt_rarm_1'], forearm: ['jnt_larm_2', 'jnt_rarm_2'], hand: ['jnt_lhand', 'jnt_rhand'], thigh: ['jnt_lleg', 'jnt_rleg'] }) };
// The game colours each Toad's spots and vest (NpcInitData.cpp: sKinopio_BodyColor, sKinopio_ClothColor);
// this is the classic Toad: red spots on white, a blue vest with orange trim.
const TOAD_COLOURS = { _mat_cap: [[230, 0, 0], [230, 230, 230]], _mat_cloth: [[250, 150, 0], [30, 30, 200]] };
const BOWSER_JR_LABELS = { bum_jnt: 'hips', chest_jnt: 'spine', head_jnt: 'head',
  ...sideLabels({ upperarm: ['armupL_jnt', 'armupR_jnt'], forearm: ['armlowL_jnt', 'armlowR_jnt'], hand: ['handL_jnt', 'handR_jnt'],
    thigh: ['legupL_jnt', 'legupR_jnt'], shin: ['leglowL_jnt', 'leglowR_jnt4'], foot: ['footL_jnt', 'footR_jnt'] }) };

// Il Piantissimo: the game draws him on Mario's own skeleton (TEnemyMario's special model), so he is a
// look model, as Shadow Mario is.
function piantissimo(disc) {
  const course = rarc(yaz0(disc.file('data/scene/monte5.szs')));
  const look = course.get('map/map/pad/monteman_model.bmd');
  if (!look) throw new Error('Your disc\'s Pianta Village has no Il Piantissimo.');
  return { 'model.szs': withFolder(disc.file('data/mario.szs'), 'look', { 'default.bmd': look }) };
}

const ROSTER = [
  { id: 'mario', name: 'Mario', about: 'As on your disc.' },
  { id: 'princess-peach', name: 'Princess Peach', about: 'Delfino\'s Peach, gown and all, on Mario\'s moves.', version: 2, build: peach },
  { id: 'shadow-mario', name: 'Shadow Mario', about: 'The paintbrush impostor, see-through and shimmering, as he looks in Delfino Plaza.', version: 2, build: shadowMario },
  { id: 'il-piantissimo', name: 'Il Piantissimo', about: 'The racer from Pianta Village, on Mario\'s skeleton as the game moves him.', version: 1, build: piantissimo },
  { id: 'bowser-jr', name: 'Bowser Jr.', about: 'Bowser\'s son, bandana and all, from Corona Mountain.', version: 1,
    build: sunshineCharacter('coronaBoss', 'koopajr', 'koopajr_model.bmd', BOWSER_JR_LABELS) },
  { id: 'sunshine-toad', name: 'Toad', about: 'A Toad from Delfino Plaza.', version: 1,
    build: sunshineCharacter('dolpic0', 'kinopio', 'kinopio_body.bmd', TOAD_LABELS, { tints: TOAD_COLOURS }) },
  { id: 'toadsworth', name: 'Toadsworth', about: 'The princess\'s steward, from Delfino Plaza.', version: 1,
    build: sunshineCharacter('dolpic0', 'kinojii', 'kinoji_body.bmd', TOAD_LABELS) },
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
