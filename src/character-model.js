'use strict';
// The Characters page's models: each character of the roster (character-roster.js) as the game
// draws it, from its archive (Mario's from the disc), with all of the animations in it. A
// character with a look model (Shadow Mario) is drawn as that model, posed by the same joints.
const { rarc, yaz0 } = require('./archive');
const j3d = require('./j3d');
const { bake } = require('./mario-model');

const MODEL = 'bmd/ma_mdl1.bmd';
// A look model, drawn in the body's place (Shadow Mario).
const LOOK = 'look/default.bmd';
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
  const shapes = [];
  model.shapes.forEach((shape, i) => {
    if ((!look && i === ALOHA_SHAPE) || !shape.index.length) return;
    const material = model.materials[shape.material] || {};
    const texture = material.textures ? textureFor(material.textures[0]) : -1;
    shapes.push({ position: shape.position, normal: shape.normal, uv: shape.uv, color: texture < 0 && shape.hasColor ? shape.color : null,
      drawIndex: shape.drawIndex, index: shape.index, texture, doubleSided: material.cull === 0, translucent: Boolean(look) || material.mode === 4,
      // a look model's own colours come from the screen behind it in the game (Shadow Mario): a deep blue here
      tint: look ? 0x3d4fb8 : null,
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

module.exports = { loadCharacter, loadAnimation, createCache };
