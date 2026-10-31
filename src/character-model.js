'use strict';
// The Characters page's models: each character of the roster (character-roster.js) as the game
// draws it, from its archive (Mario's from the disc), with all of the animations in it. A
// character with a look model (Shadow Mario) is drawn as that model, posed by the same joints.
const { rarc, yaz0 } = require('./archive');
const j3d = require('./j3d');
const mm = require('./mario-model');
const { bake } = mm;
const { Disc } = require('./disc');

const MODEL = 'bmd/ma_mdl1.bmd';
// A look model, drawn in the body's place (Shadow Mario).
const LOOK = 'look/default.bmd';
// A character's FLUDD size and place (the port's patch zzzzzz-character-05): big-endian floats scale,
// x y z offset in the chest joint's frame, tilt back in degrees.
const FLUDD_PLACE = 'character/fludd.bin';
function fluddPlace(data) {
  if (!data || data.length < 16) return { scale: 1, offset: [0, 0, 0], tilt: 0 };
  const f = i => data.readFloatBE(i * 4);
  return { scale: f(0), offset: [f(1), f(2), f(3)], tilt: data.length >= 20 ? f(4) : 0 };
}
// From the body's directions (up, forward, side, as the roster gives them) to the chest joint's frame,
// which for Sunshine's chest is x up the spine, y forward, z to the side.
function writeFluddPlace({ scale = 1, up = 0, forward = 0, side = 0, tilt = 0 }) {
  const b = Buffer.alloc(20);
  [scale, up, forward, side, tilt].forEach((v, i) => b.writeFloatBE(v, i * 4));
  return b;
}

// FLUDD as the viewer draws it on a character: its pack and spray nozzle, from the disc.
function loadFluddRig(rom) {
  const disc = new Disc(rom);
  let files;
  try { files = mm.fluddFiles(disc, rarc(disc.file('data/mario.szs'))); } finally { disc.close(); }
  const { pack, packTexture, nozzles } = mm.loadFludd(files);
  const textures = [], byName = new Map();
  const textureFor = source => {
    if (!source) return -1;
    if (!byName.has(source.name)) { byName.set(source.name, textures.length); textures.push({ name: source.name, width: source.width, height: source.height, rgba: source.rgba, wrapS: source.wrapS, wrapT: source.wrapT }); }
    return byName.get(source.name);
  };
  const rigOf = (model, attach) => mm.rig(model, mm.fluddShapes(model, packTexture).map(({ shape, material, source }) =>
    ({ ...shape, texture: textureFor(source), doubleSided: material.cull === 0, translucent: material.mode === 4 })), attach);
  return { textures, pack: rigOf(pack, null), nozzle: rigOf(nozzles.spray, { joint: pack.joints.findIndex(j => j.name === 'nozzle_center') }) };
}
// The body model's Shine shirt, shown only once Mario has it.
const ALOHA_SHAPE = 10;

// The body model as the viewer draws it, and the names of the animations.
function loadCharacter(character, files, look = null) {
  if (!files.has(MODEL)) throw new Error(`${character.name}'s archive has no ${MODEL}.`);
  const model = j3d.parseBmd(look || files.get(MODEL));
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
  const shapes = [], shadow = Boolean(look) && model.textures.some(t => /kagemario/i.test(t.name));
  model.shapes.forEach((shape, i) => {
    if ((!look && i === ALOHA_SHAPE) || !shape.index.length) return;
    const material = model.materials[shape.material] || {};
    const texture = material.textures ? textureFor(material.textures[0]) : -1;
    shapes.push({ position: shape.position, normal: shape.normal, uv: shape.uv, color: texture < 0 && shape.hasColor ? shape.color : null,
      drawIndex: shape.drawIndex, index: shape.index, texture, doubleSided: material.cull === 0, translucent: shadow || material.mode === 4,
      // Shadow Mario's colours come from the screen behind him in the game: a deep blue here
      tint: shadow ? 0x3d4fb8 : null,
      alphaTest: material.alphaTest?.comp0 === 6 ? material.alphaTest.ref0 / 255 : 0 });
  });
  const toon = model.textures.find(t => /toon/i.test(t.name));
  // Mario's body animations: the ones for his 29 joints (not FLUDD's or the hands' own).
  const animations = [...files.keys()].filter(name => /^bck\/.*\.bck$/.test(name) && jointCount(files.get(name)) === model.joints.length)
    .map(name => name.slice(4, -4)).sort();
  return {
    fludd: fluddPlace(files.get(FLUDD_PLACE)), chest: model.joints.findIndex(j => j.name === 'jnt_chest'),
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

// Characters read once while the launcher runs, made again when their archive changes (a new build).
function createCache() {
  const cache = new Map();
  return {
    // `read` gives the character's archive when it isn't held yet
    get(character, stamp, read) {
      const key = `${character.id}:${stamp}`;
      if (!cache.has(key)) {
        for (const k of cache.keys()) if (k.startsWith(`${character.id}:`)) cache.delete(k);
        const files = rarc(yaz0(read()));
        cache.set(key, { files, model: loadCharacter(character, files, files.get(LOOK) || null) });
      }
      return cache.get(key);
    },
    clear() { cache.clear(); },
  };
}

module.exports = { loadCharacter, loadAnimation, createCache, loadFluddRig, fluddPlace, writeFluddPlace, FLUDD_PLACE };
