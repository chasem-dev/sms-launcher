'use strict';
// The Characters page's models: Mario from the player's disc and each
// character pack in the game's mods/characters/ (a folder <id>/ with
// model.szs and name.txt, or a loose <id>.szs), each with all of the
// animations in its archive.
const fs = require('node:fs');
const path = require('node:path');
const { Disc } = require('./disc');
const { rarc, yaz0 } = require('./archive');
const j3d = require('./j3d');
const { bake } = require('./mario-model');

const MODEL = 'bmd/ma_mdl1.bmd';
// The body model's Shine shirt, shown only once Mario has it.
const ALOHA_SHAPE = 10;

function packsDirectory(root) { return path.join(root, 'mods', 'characters'); }

// Mario first, then the packs by name. `file` is the pack's archive (none for Mario).
function listCharacters(root) {
  const list = [{ id: 'mario', name: 'Mario', file: null }];
  const directory = root ? packsDirectory(root) : null;
  if (!directory || !fs.existsSync(directory)) return list;
  const packs = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const file = path.join(directory, entry.name, 'model.szs');
      if (!fs.existsSync(file)) continue;
      let name = entry.name;
      try { name = fs.readFileSync(path.join(directory, entry.name, 'name.txt'), 'utf8').trim() || name; } catch (_) {}
      packs.push({ id: entry.name, name, file });
    } else if (/\.szs$/i.test(entry.name)) {
      const id = entry.name.replace(/\.szs$/i, '');
      if (!packs.some(pack => pack.id === id)) packs.push({ id, name: id, file: path.join(directory, entry.name) });
    }
  }
  packs.sort((a, b) => a.name.localeCompare(b.name));
  return list.concat(packs);
}

function readFiles(rom, character) {
  if (character.file) return rarc(yaz0(fs.readFileSync(character.file)));
  const disc = new Disc(rom);
  try { return rarc(disc.file('data/mario.szs')); }
  finally { disc.close(); }
}

// The body model as the viewer draws it, and the names of the animations.
function loadCharacter(character, files) {
  if (!files.has(MODEL)) throw new Error(`${character.name}'s archive has no ${MODEL}.`);
  const model = j3d.parseBmd(files.get(MODEL));
  const textures = [], byIndex = new Map();
  const textureFor = index => {
    const source = model.textures[index];
    if (!source) return -1;
    if (!byIndex.has(index)) {
      byIndex.set(index, textures.length);
      textures.push({ name: source.name, width: source.width, height: source.height, rgba: source.rgba, wrapS: source.wrapS, wrapT: source.wrapT });
    }
    return byIndex.get(index);
  };
  const shapes = [];
  model.shapes.forEach((shape, i) => {
    if (i === ALOHA_SHAPE || !shape.index.length) return;
    const material = model.materials[shape.material] || {};
    const texture = material.textures ? textureFor(material.textures[0]) : -1;
    shapes.push({ position: shape.position, normal: shape.normal, uv: shape.uv, color: texture < 0 && shape.hasColor ? shape.color : null,
      drawIndex: shape.drawIndex, index: shape.index, texture, doubleSided: material.cull === 0, translucent: material.mode === 4,
      alphaTest: material.alphaTest?.comp0 === 6 ? material.alphaTest.ref0 / 255 : 0 });
  });
  const toon = model.textures.find(t => /toon/i.test(t.name));
  // Mario's body animations: the ones for his 29 joints (not FLUDD's or the hands' own).
  const animations = [...files.keys()].filter(name => /^bck\/.*\.bck$/.test(name) && jointCount(files.get(name)) === model.joints.length)
    .map(name => name.slice(4, -4)).sort();
  return {
    id: character.id, name: character.name,
    joints: model.joints, draw: model.draw, envelopes: model.envelopes, inverseBind: model.inverseBind, shapes, textures,
    toon: toon ? toonBands(toon) : [0.72, 1], animations,
  };
}

// One animation sampled at every frame for this character's joints.
function loadAnimation(files, joints, name) {
  const data = files.get(`bck/${name}.bck`);
  if (!data) throw new Error(`There is no animation ${name}.`);
  const animation = j3d.parseBck(data);
  return { name, loop: animation.loop, ...bake(animation, joints) };
}

function jointCount(data) {
  try { return data.readUInt16BE(0x20 + 0x0c); } catch (_) { return -1; }
}

function toonBands({ rgba }) {
  let low = 255, high = 0;
  for (let i = 0; i < rgba.length; i += 4) { low = Math.min(low, rgba[i]); high = Math.max(high, rgba[i]); }
  return [low / 255, high / 255];
}

// Characters read once while the launcher runs, by archive and its time stamp
// (a pack made again is read again).
function createCache() {
  const cache = new Map();
  const key = (rom, character) => {
    if (!character.file) return `disc:${rom}`;
    return `${character.file}:${fs.statSync(character.file).mtimeMs}`;
  };
  return {
    get(rom, character) {
      const k = key(rom, character);
      if (!cache.has(k)) {
        const files = readFiles(rom, character);
        cache.set(k, { files, model: loadCharacter(character, files) });
      }
      return cache.get(k);
    },
    clear() { cache.clear(); },
  };
}

module.exports = { listCharacters, readFiles, loadCharacter, loadAnimation, createCache, packsDirectory };
