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
// A look model, drawn in the body's place (Shadow Mario), and the texture animation the game plays on it.
const LOOK = 'look/default.bmd';
const LOOK_SCROLL = /^look\/[^/]+\.btk$/;
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
// The cap: the game hides the body model's own cap shape (TMario::initModel) and draws ma_cap1.bmd on the
// M_head joint instead, painted with the body's first texture (TMarioCap). Mario's two caps look alike,
// but Super Mario Eclipse's Luigi's body cap is a broken leftover: his cap is the one in ma_cap1.
const BODY_CAP_SHAPE = 4;
const CAP = 'bmd/ma_cap1.bmd';

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
  // Shadow Mario's shimmer: his third texture (an indirect warp the game bends the screen behind him with),
  // moved by his texture animation; the viewer bends and lights his colour with it.
  const scrollName = shadow ? [...files.keys()].find(name => LOOK_SCROLL.test(name)) : null;
  let shimmer = null;
  if (scrollName) {
    try {
      // sampled at each of its frames: scale u, scale v, move u, move v
      const scroll = j3d.parseBtk(files.get(scrollName)), anim = scroll.materials[0];
      if (anim && scroll.frames > 0) {
        const st = new Float32Array(scroll.frames * 4);
        for (let f = 0; f < scroll.frames; f++)
          st.set([anim.u.scale, anim.v.scale, anim.u.translation, anim.v.translation].map(t => j3d.sampleTrack(t, f)), f * 4);
        shimmer = { frames: scroll.frames, st };
      }
    } catch (_) { shimmer = null; }
  }
  const shadowFor = material => {
    const key = `shadow ${model.materials.indexOf(material)}`;
    if (!byIndex.has(key)) {
      byIndex.set(key, textures.length);
      textures.push(shadowTexture(model.textures[material.textures[1]], material.tevColors));
    }
    return byIndex.get(key);
  };
  // ma_cap1's one joint sits on M_head as it stands, so its corners are drawn as the head's own
  const head = model.joints.findIndex(j => j.name === 'M_head');
  const headDraw = model.draw.findIndex(d => !d.weighted && d.index === head);
  const cap = !look && head >= 0 && headDraw >= 0 && files.has(CAP) ? j3d.parseBmd(files.get(CAP)) : null;
  model.shapes.forEach((shape, i) => {
    if ((!look && i === ALOHA_SHAPE) || (cap && i === BODY_CAP_SHAPE) || !shape.index.length) return;
    const material = model.materials[shape.material] || {};
    const texture = !material.textures ? -1 : shadow ? shadowFor(material) : textureFor(material.textures[0]);
    const warp = shimmer && material.textures && material.textures[2] >= 0 ? textureFor(material.textures[2]) : -1;
    shapes.push({ position: shape.position, normal: smoothFacets(shape), uv: shape.uv, color: texture < 0 && shape.hasColor ? shape.color : null, warp,
      drawIndex: shape.drawIndex, index: shape.index, texture, doubleSided: material.cull === 0, translucent: !shadow && material.mode === 4,
      // Shadow Mario is lit only by his shine (his colours are his texture's, unlit)
      shine: shadow,
      alphaTest: material.alphaTest?.comp0 === 6 ? material.alphaTest.ref0 / 255 : 0 });
  });
  for (const shape of cap?.shapes || []) {
    if (!shape.index.length) continue;
    const material = cap.materials[shape.material] || {};
    // its first texture is a stand-in for the body's
    const texture = material.textures?.[0] === 0 ? textureFor(0) : -1;
    shapes.push({ position: shape.position, normal: smoothFacets(shape), uv: shape.uv, color: texture < 0 && shape.hasColor ? shape.color : null,
      warp: -1, drawIndex: new Uint16Array(shape.drawIndex.length).fill(headDraw), index: shape.index, texture,
      doubleSided: material.cull === 0, translucent: material.mode === 4, shine: false,
      alphaTest: material.alphaTest?.comp0 === 6 ? material.alphaTest.ref0 / 255 : 0 });
  }
  const toon = model.textures.find(t => /toon/i.test(t.name));
  // Mario's body animations: the ones for his 29 joints (not FLUDD's or the hands' own).
  const animations = [...files.keys()].filter(name => /^bck\/.*\.bck$/.test(name) && jointCount(files.get(name)) === model.joints.length)
    .map(name => name.slice(4, -4)).sort();
  return {
    fludd: fluddPlace(files.get(FLUDD_PLACE)), chest: model.joints.findIndex(j => j.name === 'jnt_chest'),
    id: character.id, name: character.name,
    joints: model.joints, draw: model.draw, envelopes: model.envelopes, inverseBind: model.inverseBind, shapes, textures,
    toon: toon ? toonBands(toon) : [0.72, 1], animations, shimmer,
  };
}

// A shape modelled with a normal of its own on each face (Super Mario Eclipse's Luigi's gloves)
// shows every face apart in the viewer's soft light, where the game's two shades of light hide them: such
// a shape gets each corner's normal blended with the faces around it that meet it at under CREASE degrees.
// Faces count as meeting where their corners share a place and joint. Shapes with smooth normals already
// (Mario's own) keep theirs, hard edges and all.
const CREASE = Math.cos(70 * Math.PI / 180);
function smoothFacets({ position, normal, drawIndex }) {
  const places = new Map();
  for (let v = 0; v < drawIndex.length; v++) {
    const key = `${drawIndex[v]} ${position[v * 3].toFixed(3)} ${position[v * 3 + 1].toFixed(3)} ${position[v * 3 + 2].toFixed(3)}`;
    const place = places.get(key);
    if (place) place.push(v); else places.set(key, [v]);
  }
  const dot = (a, b) => normal[a * 3] * normal[b * 3] + normal[a * 3 + 1] * normal[b * 3 + 1] + normal[a * 3 + 2] * normal[b * 3 + 2];
  let shared = 0, split = 0;
  for (const place of places.values()) {
    if (place.length < 2) continue;
    shared++;
    if (place.some(v => dot(v, place[0]) < 0.999)) split++;
  }
  if (!shared || split * 2 < shared) return normal;
  const out = Float32Array.from(normal);
  for (const place of places.values()) {
    if (place.length < 2) continue;
    for (const v of place) {
      let x = 0, y = 0, z = 0;
      for (const w of place) if (dot(v, w) >= CREASE) { x += normal[w * 3]; y += normal[w * 3 + 1]; z += normal[w * 3 + 2]; }
      const length = Math.hypot(x, y, z);
      if (length > 1e-6) out.set([x / length, y / length, z / length], v * 3);
    }
  }
  return out;
}

// Shadow Mario's colour, as his material makes it in the game: the screen behind him (his first
// texture is a stand-in for it) between his first two colours, then his body texture between his
// third colour and that. The screen here is a bright plaza, as the viewer's backdrop is.
const SHADOW_SCREEN = 0.6;
function shadowTexture(main, colours) {
  const [c0, c1, c2] = colours.map(c => c || [0, 0, 0, 255]);
  const screen = [0, 1, 2].map(k => c0[k] + (c1[k] - c0[k]) * SHADOW_SCREEN);
  const rgba = new Uint8Array(main.width * main.height * 4);
  for (let p = 0; p < rgba.length; p += 4) {
    const m = main.rgba[p] / 255;
    for (let k = 0; k < 3; k++) rgba[p + k] = Math.round(c2[k] + (screen[k] - c2[k]) * m);
    rgba[p + 3] = 255;
  }
  return { name: `${main.name} (shadow)`, width: main.width, height: main.height, rgba, wrapS: main.wrapS, wrapT: main.wrapT };
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

module.exports = { smoothFacets, loadCharacter, loadAnimation, createCache, loadFluddRig, fluddPlace, writeFluddPlace, FLUDD_PLACE };
