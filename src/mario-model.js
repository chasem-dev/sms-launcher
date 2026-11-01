'use strict';

// Mario for the customizer, read from the player's own disc: his model, his
// idle animation, his textures and the colour regions found in them.

const { Disc } = require('./disc');
const { rarc } = require('./archive');
const j3d = require('./j3d');
const colors = require('./mario-colors');

const MODEL = 'bmd/ma_mdl1.bmd';
const IDLE = 'bck/ma_wait.bck';

// The body model's Shine shirt, shown only once Mario has it (TMario::thinkAloha).
const ALOHA_SHAPE = 10;
// His sunglasses, which the game hangs off his M_head joint (TMarioCap).
const SUNGLASSES = 'bmd/ma_glass1.bmd';

// Which part of Mario a shape is, from the joint it hangs off or its material.
function partOf(shape, model, index) {
  if (index === ALOHA_SHAPE) return 'aloha';
  const material = model.materials[shape.material]?.name || '', joint = model.joints[shape.joint]?.name || '';
  if (/eye/i.test(material)) return 'eye';
  if (/mouse/i.test(material)) return 'mouth';
  if (/cap/i.test(joint)) return 'cap';
  if (/^M_head/i.test(joint)) return 'head';
  if (/hand/i.test(joint)) return 'hands';
  if (/foot/i.test(joint)) return 'feet';
  return 'body';
}

// FLUDD's pack and its nozzles. The game draws one nozzle at a time on the
// pack's nozzle_center joint, painted with the pack's texture (TWaterGun::init).
const FLUDD = 'watergun2/body/wg_mdl1.bmd';
const NOZZLES = {
  spray: 'watergun2/normal_wg/normal_wg.bmd',
  hover: 'watergun2/hover_wg/hover_wg.bmd',
  rocket: 'watergun2/rocket_wg/rocket_wg.bmd',
  turbo: 'watergun2/back_wg/back_wg.bmd',
};

// FLUDD's files: in Mario's archive on the Sunshine disc; Super Mario Eclipse
// moves them to the common one.
function fluddFiles(disc, files) {
  if (files.has(FLUDD)) return files;
  const common = disc.files.has('data/common.szs') ? rarc(disc.file('data/common.szs')) : new Map();
  return common.has(FLUDD) ? common : files;
}

// FLUDD as it is worn when not spraying: TWaterGun::calcAnimation holds wg_house at its end (the
// handles folded in), and brings them out to Mario's hands only while he sprays.
const FLUDD_STOWED = 'watergun2/body/wg_house.bck';
function stowed(joints, data) {
  if (!data) return joints;
  const animation = j3d.parseBck(data);
  return joints.map((joint, j) => {
    const track = animation.joints[j];
    if (!track) return joint;
    const at = key => [0, 1, 2].map(axis => j3d.sampleTrack(track[key][axis], animation.frames));
    return { ...joint, scale: at('scale'), rotation: at('rotation'), translation: at('translation') };
  });
}

// FLUDD's pack and its nozzles, parsed. The nozzles' dummy texture is the
// pack's, which TWaterGun swaps in for H_watergun_main_dummy.
function loadFludd(files) {
  const loose = j3d.parseBmd(files.get(FLUDD)), pack = { ...loose, joints: stowed(loose.joints, files.get(FLUDD_STOWED)) };
  return {
    pack, packTexture: pack.textures.find(texture => /watergun_main/i.test(texture.name) && !/dummy/i.test(texture.name)) || pack.textures[1],
    nozzles: Object.fromEntries(Object.entries(NOZZLES).map(([id, file]) => [id, j3d.parseBmd(files.get(file))])),
  };
}

// The shapes FLUDD draws with a texture of its own (not the water inside the
// tank), with the texture each is painted with.
function fluddShapes(model, packTexture) {
  return model.shapes.flatMap(shape => {
    const material = model.materials[shape.material];
    if (/waterline/i.test(material.name)) return [];  // the water level inside the tank
    const source = model.textures[material.textures[0]];
    return [{ shape, material, source: source && /dummy/i.test(source.name) ? packTexture : source }];
  });
}

// The sunglasses: a frame drawn from an intensity/alpha texture between two
// TEV colours (the alpha cutting its shape out), and see-through lenses
// coloured by their vertices. Nothing on them takes Mario's colours.
function loadSunglasses(files, model, textureFor) {
  if (!files.has(SUNGLASSES)) return null;
  const glasses = j3d.parseBmd(files.get(SUNGLASSES));
  return rig(glasses, glasses.shapes.map(shape => {
    const material = glasses.materials[shape.material], source = glasses.textures[material.textures[0]];
    let texture = -1;
    if (source) {
      const [dark, light] = material.tevColors, rgba = new Uint8Array(source.rgba);
      for (let i = 0; i < rgba.length; i += 4) for (let c = 0; c < 3; c++)
        rgba[i + c] = Math.round(dark[c] + (light[c] - dark[c]) * source.rgba[i] / 255);
      texture = textureFor({ ...source, rgba }, 'sunglasses');
    }
    return { ...shape, part: 'sunglasses', texture, doubleSided: material.cull === 0, translucent: material.mode === 4,
      alphaTest: material.alphaTest?.comp0 === 6 ? material.alphaTest.ref0 / 255 : 0 };
  }), { joint: jointIndex(model, 'M_head') });
}

function loadMario(rom) {
  const disc = new Disc(rom);
  let files, fluddArchive;
  try {
    files = rarc(disc.file('data/mario.szs'));
    fluddArchive = fluddFiles(disc, files);
  } finally { disc.close(); }
  const model = j3d.parseBmd(files.get(MODEL));
  const idle = j3d.parseBck(files.get(IDLE));

  // One texture per (texture, part): parts share the atlas but not its regions.
  const textures = [], byKey = new Map();
  const textureFor = (source, part) => {
    const key = `${source.name}:${part}`;
    if (!byKey.has(key)) {
      byKey.set(key, textures.length);
      textures.push({ name: source.name, part, width: source.width, height: source.height, rgba: source.rgba,
        wrapS: source.wrapS, wrapT: source.wrapT, covered: new Uint8Array(source.width * source.height) });
    }
    return byKey.get(key);
  };
  const mario = rig(model, model.shapes.map((shape, i) => {
    const part = partOf(shape, model, i), material = model.materials[shape.material];
    const texture = textureFor(model.textures[material.textures[0]], part);
    const { width, height, covered, wrapS, wrapT } = textures[texture];
    colors.coverage(width, height, shape.uv, shape.index, covered, wrapS, wrapT);
    return { ...shape, part, texture, doubleSided: material.cull === 0 };
  }));

  const { pack, packTexture, nozzles } = loadFludd(fluddArchive);
  const fluddRig = (data, attach) => rig(data, fluddShapes(data, packTexture).map(({ shape, material, source }) => {
    const texture = source ? textureFor(source, 'fludd') : -1;
    if (texture >= 0) {
      const { width, height, covered, wrapS, wrapT } = textures[texture];
      colors.coverage(width, height, shape.uv, shape.index, covered, wrapS, wrapT);
    }
    return { ...shape, part: 'fludd', texture, doubleSided: material.cull === 0, translucent: material.mode === 4 };
  }), attach);
  const fludd = {
    pack: fluddRig(pack, { joint: jointIndex(model, 'jnt_chest'), tilt: true }),
    nozzles: Object.fromEntries(Object.entries(nozzles).map(([id, data]) =>
      [id, fluddRig(data, { joint: jointIndex(pack, 'nozzle_center') })])),
  };

  const sunglasses = loadSunglasses(files, model, textureFor);

  for (const texture of textures) {
    texture.mask = colors.PARTS[texture.part]
      ? colors.classify(texture.rgba, texture.width, texture.height, texture.part, texture.covered)
      : new Uint8Array(texture.width * texture.height).fill(255);
    texture.lightness = colors.lightness(texture.rgba);
    delete texture.covered;
  }
  const references = colors.references(textures);
  for (const texture of textures) Object.assign(texture, colors.blendEdges(texture, references));
  // The game's toon ramp: its darkest and brightest grey shade the cel bands.
  const toon = model.textures.find(t => /toon/i.test(t.name));
  return {
    ...mario, fludd, sunglasses, textures, references,
    toon: toon ? toonBands(toon) : [0.72, 1],
    idle: bake(idle, model.joints),
  };
}

function jointIndex(model, name) {
  const index = model.joints.findIndex(joint => joint.name === name);
  if (index < 0) throw new Error(`The game's model has no ${name} joint.`);
  return index;
}

// What the customizer needs to pose and draw one model. `attach` hangs it off
// a joint of the model before it (FLUDD off Mario's chest, a nozzle off FLUDD).
function rig(model, shapes, attach = null) {
  return {
    joints: model.joints, draw: model.draw, envelopes: model.envelopes, inverseBind: model.inverseBind, attach,
    shapes: shapes.map(({ position, normal, uv, color, hasColor, drawIndex, index, part, texture, doubleSided, translucent = false, alphaTest = 0 }) =>
      ({ position, normal, uv, color: texture < 0 && hasColor ? color : null, drawIndex, index, part, texture, doubleSided, translucent, alphaTest })),
  };
}

// The animation sampled at every frame: per frame and joint, scale, rotation
// (radians, applied X then Y then Z) and translation, so the customizer only
// blends neighbouring frames.
function bake(animation, joints) {
  const values = new Float32Array(animation.frames * joints.length * 9);
  for (let frame = 0, o = 0; frame < animation.frames; frame++) joints.forEach((joint, j) => {
    const track = animation.joints[j];
    for (const key of ['scale', 'rotation', 'translation']) for (let axis = 0; axis < 3; axis++)
      values[o++] = track ? j3d.sampleTrack(track[key][axis], frame) : joint[key][axis];
  });
  return { frames: animation.frames, fps: 30, values };
}

function toonBands({ rgba }) {
  let low = 255, high = 0;
  for (let i = 0; i < rgba.length; i += 4) { low = Math.min(low, rgba[i]); high = Math.max(high, rgba[i]); }
  return [low / 255, high / 255];
}

module.exports = { loadMario, partOf, bake, rig, fluddFiles, loadFludd, fluddShapes, loadSunglasses, NOZZLES, FLUDD, SUNGLASSES };
