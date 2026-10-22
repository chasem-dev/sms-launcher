'use strict';

// The world editor's stage building: textures players paint onto a stage's
// own ground or build pieces from, pieces of stages (whole buildings) copied
// elsewhere, and writing all of it into the stage's model (map.bmd) and
// ground (map.col) when a level is exported.
//
// A stage's look and its ground are separate files: map.bmd is what's drawn,
// map.col what Mario stands on. Painting a texture changes the first; the
// ground brush changes the second. Built and copied pieces add to both.

const j3d = require('./j3d');
const levelModel = require('./level-model');
const collisionFile = require('./collision');
const build = require('./world-build');
const { BmdEdit, POS, NRM, CLR0, TEX0 } = require('./bmd-edit');

const MAP = 'map/map/map.bmd', COL = 'map/map.col', SEA = 'map/map/sea.bmd';

// Textures to paint and build with: each is a material of a stage's own
// ground, checked by its texture's name so another version of the game only
// loses the entries it doesn't have. `ground` is the footsteps they go with;
// `tile` (world units per repeat) where the stage stretches it over distant
// hills; `match` a material index where texture names repeat.
const PALETTE = [
  // Ground
  { id: 'delfino-sand', label: 'Delfino sand', group: 'ground', scene: 'dolpic0', texture: 'A_suna_sire02m4', ground: 'sand', tile: 1600 },
  { id: 'gelato-sand', label: 'Beach sand', group: 'ground', scene: 'ricco0', texture: 'A_suna_sire', ground: 'sand', tile: 1500 },
  { id: 'noki-sand', label: 'Shell sand', group: 'ground', scene: 'mare0', texture: 'mare_12', ground: 'sand' },
  { id: 'bianco-grass', label: 'Meadow grass', group: 'ground', scene: 'bianco0', texture: 'D_green_bia2', ground: 'grass', tile: 1500 },
  { id: 'gelato-grass', label: 'Lawn', group: 'ground', scene: 'mamma0', texture: 'D_green_man02', ground: 'grass', tile: 1500 },
  { id: 'sirena-grass', label: 'Short grass', group: 'ground', scene: 'sirena0', texture: 'greenMT_UV3', ground: 'grass', tile: 1200 },
  { id: 'delfino-tiles', label: 'Plaza tiles', group: 'ground', scene: 'dolpic0', texture: 'A_yuka_itimatu01', ground: 'stone' },
  { id: 'delfino-bricks', label: 'Brick paving', group: 'ground', scene: 'dolpic0', texture: 'A_yuka_renga', ground: 'stone' },
  { id: 'delfino-waves', label: 'Wave mosaic', group: 'ground', scene: 'dolpic0', texture: 'A_yuka_nami_n3', ground: 'stone' },
  { id: 'delfino-cobbles', label: 'Sandy cobbles', group: 'ground', scene: 'dolpic0', texture: 'A_dpt_ji03m2', ground: 'stone' },
  { id: 'bianco-rocks', label: 'Stone path', group: 'ground', scene: 'bianco0', texture: 'D_RockGround', ground: 'stone' },
  { id: 'bianco-pebbles', label: 'White pebbles', group: 'ground', scene: 'bianco0', texture: 'D_grey', ground: 'stone' },
  { id: 'ricco-cobbles', label: 'Cobblestones', group: 'ground', scene: 'ricco0', texture: 'A_isiita02', ground: 'stone' },
  { id: 'ricco-checker', label: 'Blue checks', group: 'ground', scene: 'ricco0', texture: 'A_heban2', ground: 'stone' },
  { id: 'gelato-bricks', label: 'Brown bricks', group: 'ground', scene: 'mamma0', texture: 'D_brock_ma', match: 2, ground: 'stone' },
  { id: 'pinna-mosaic', label: 'Round mosaic', group: 'ground', scene: 'pinnabeach0', texture: 'L_pina_', match: 13, ground: 'stone' },
  { id: 'pinna-flagstone', label: 'Flagstones', group: 'ground', scene: 'pinnabeach0', texture: 'L_pina_', match: 18, ground: 'stone', tile: 700 },
  { id: 'pinna-white-tiles', label: 'White tiles', group: 'ground', scene: 'pinnabeach0', texture: 'L_pina_', match: 19, ground: 'stone', tile: 500 },
  { id: 'sirena-pool', label: 'Pool tiles', group: 'ground', scene: 'sirena0', texture: 'TailPool', ground: 'stone', tile: 500 },
  { id: 'sirena-rocks', label: 'Rock tiles', group: 'ground', scene: 'sirena0', texture: 'D_rocktail_', ground: 'stone', tile: 500 },
  { id: 'sirena-diamonds', label: 'Diamond bricks', group: 'ground', scene: 'sirena0', texture: 'D_brock_sir', match: 17, ground: 'stone' },
  { id: 'monte-stones', label: 'Blue stones', group: 'ground', scene: 'monte0', texture: 'D_ishidatami', ground: 'stone' },
  { id: 'noki-checker', label: 'Faded checks', group: 'ground', scene: 'mare0', texture: 'mare_25', ground: 'stone' },
  { id: 'gelato-planks', label: 'Pink planks', group: 'ground', scene: 'mamma0', texture: 'D_woody_mam2', ground: 'wood' },
  { id: 'gelato-boards', label: 'Yellow boards', group: 'ground', scene: 'mamma0', texture: 'D_YellowWoody', ground: 'wood' },
  { id: 'pinna-planks', label: 'Boardwalk', group: 'ground', scene: 'pinnabeach0', texture: 'L_pina_', match: 14, ground: 'wood' },
  { id: 'sirena-wood', label: 'Dark wood', group: 'ground', scene: 'sirena0', texture: 'D_Woody_sir', ground: 'wood' },
  // Walls
  { id: 'delfino-white-wall', label: 'Delfino white wall', group: 'wall', scene: 'dolpic0', texture: 'A_white_wall01', ground: 'stone' },
  { id: 'gelato-brick-wall', label: 'Pink brick wall', group: 'wall', scene: 'mamma0', texture: 'D_wall04mam', ground: 'stone' },
  { id: 'pinna-stone-wall', label: 'Yellow stone wall', group: 'wall', scene: 'pinnabeach0', texture: 'L_pina_', match: 0, ground: 'stone', tile: 600 },
  { id: 'pinna-cobble-wall', label: 'White cobble wall', group: 'wall', scene: 'pinnabeach0', texture: 'L_pina_', match: 11, ground: 'stone' },
  { id: 'pinna-brick-wall', label: 'Orange brick wall', group: 'wall', scene: 'pinnabeach0', texture: 'L_pina_', match: 17, ground: 'stone' },
  { id: 'ricco-brick-wall', label: 'Harbor bricks', group: 'wall', scene: 'ricco0', texture: 'A_tank02', ground: 'stone' },
  { id: 'sirena-stucco', label: 'Stucco', group: 'wall', scene: 'sirena0', texture: 'D_WallHotel', ground: 'stone', tile: 900 },
  { id: 'sirena-plaster', label: 'Plaster', group: 'wall', scene: 'sirena0', texture: 'D_WhiteWall', ground: 'stone' },
  { id: 'sirena-stone-wall', label: 'Hotel stone wall', group: 'wall', scene: 'sirena0', texture: 'D_HotelWall', match: 28, ground: 'stone' },
  { id: 'noki-stone-wall', label: 'Old stone wall', group: 'wall', scene: 'mare0', texture: 'mare_01', ground: 'stone', tile: 900 },
  { id: 'monte-blue-boards', label: 'Blue boards', group: 'wall', scene: 'monte0', texture: 'A_ita01_mip', ground: 'wood' },
  // Roofs
  { id: 'gelato-shingles', label: 'Brown shingles', group: 'roof', scene: 'mamma0', texture: 'D_RoofTHouseB', ground: 'stone' },
  { id: 'gelato-thatch', label: 'Thatch', group: 'roof', scene: 'mamma0', texture: 'D_KayaRoofTHouseA', ground: 'grass' },
  { id: 'sirena-roof', label: 'Yellow roof tiles', group: 'roof', scene: 'sirena0', texture: 'D_RoofHotel', ground: 'stone' },
  { id: 'sirena-thatch', label: 'Straw roof', group: 'roof', scene: 'sirena0', texture: 'D_ShopRoof', ground: 'grass' },
  { id: 'bianco-shingles', label: 'Windmill shingles', group: 'roof', scene: 'bianco0', texture: 'D_roofWindmill', ground: 'stone' },
  // Edges: laid once over a side's height or a border's depth, keeping
  // their shape (`fit`, the texture's width to height); `cutout` ones have
  // see-through parts.
  { id: 'grass-fringe', label: 'Grass fringe', group: 'edge', scene: 'pinnabeach0', texture: 'D_pina_kusa01', ground: 'grass', fit: 2, cutout: true },
  { id: 'grassy-sand-bank', label: 'Grassy sand bank', group: 'edge', scene: 'mamma0', texture: 'D_sunagake_man02', ground: 'sand', fit: 1 },
  { id: 'grassy-rock-bank', label: 'Grassy rock bank', group: 'edge', scene: 'mamma0', texture: 'D_kusagake_man', ground: 'stone', fit: 1 },
  { id: 'grassy-cobble-bank', label: 'Grassy cobble bank', group: 'edge', scene: 'pinnabeach0', texture: 'L_pina_yama01', match: 20, ground: 'stone', fit: 1 },
  { id: 'grassy-stone-wall', label: 'Grassy stone wall', group: 'edge', scene: 'dolpic0', texture: 'A_dptwall03', ground: 'grass', fit: 0.25 },
];
const PALETTE_GROUPS = [{ id: 'ground', label: 'Ground' }, { id: 'wall', label: 'Walls' }, { id: 'roof', label: 'Roofs' }, { id: 'edge', label: 'Edges' }];

// Pieces of stages to copy elsewhere: Delfino's buildings, as boxes over the
// plaza (x0, z0, x1, z1). What's inside, above the ground they stand on, is
// the building, with its walls and roofs as the stage draws them.
const PREFABS = [
  { id: 'delfino-bell-tower', label: 'Bell tower hall', scene: 'dolpic0', box: [-3700, -100, 3200, 2100] },
  { id: 'delfino-shine-gate', label: 'Shine Gate', scene: 'dolpic0', box: [-1700, -8050, 1600, -6950] },
  { id: 'delfino-boathouse', label: 'Boathouse row', scene: 'dolpic0', box: [-7100, -4100, -5900, 1800] },
  { id: 'delfino-green-hall', label: 'Green-roofed hall', scene: 'dolpic0', box: [3050, -9050, 7050, -7250] },
  { id: 'delfino-corner-house', label: 'Brick tower', scene: 'dolpic0', box: [5700, -6400, 7150, -5100] },
  { id: 'delfino-west-house', label: 'Brown-roofed house', scene: 'dolpic0', box: [-4050, -7100, -2950, -3950] },
  { id: 'delfino-south-shop', label: 'Plaza shop', scene: 'dolpic0', box: [-5050, -150, -3950, 2550] },
  { id: 'delfino-green-tower', label: 'Green-roofed tower', scene: 'dolpic0', box: [3950, 1550, 5050, 3250] },
  { id: 'delfino-harbor-house', label: 'Harbor tower', scene: 'dolpic0', box: [5950, 4350, 7050, 5650] },
  { id: 'delfino-bell-house', label: 'Spire tower', scene: 'dolpic0', box: [-7100, 4350, -5000, 5650] },
];

// --- Palette ---------------------------------------------------------------------

// The game's GX texgen matrix scale for a material's first coordinates.
function texScale(material) {
  const gen = material.texGens?.[0];
  const m = gen && gen.matrix >= 30 && gen.matrix <= 57 ? material.texMatrices?.[(gen.matrix - 30) / 3] : null;
  return m ? [Math.abs(m.scale[0]) || 1, Math.abs(m.scale[1]) || 1] : [1, 1];
}

// How a material is laid on a stage: world units per texture repeat, its
// usual vertex colour (the light baked into the stage) and how much it covers.
function materialUsage(model, material) {
  let area = 0, uvArea = 0, floor = 0;
  const color = [0, 0, 0], count = { n: 0 };
  for (const shape of model.shapes) {
    if (shape.material !== material) continue;
    const P = shape.position, U = shape.uv, I = shape.index, C = shape.color;
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, c] = [I[t], I[t + 1], I[t + 2]];
      const e1 = [0, 1, 2].map(k => P[b * 3 + k] - P[a * 3 + k]), e2 = [0, 1, 2].map(k => P[c * 3 + k] - P[a * 3 + k]);
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const A = Math.hypot(...n) / 2;
      area += A;
      if (A && n[1] / (2 * A) > 0.7) floor += A;
      const u1 = [U[b * 2] - U[a * 2], U[b * 2 + 1] - U[a * 2 + 1]], u2 = [U[c * 2] - U[a * 2], U[c * 2 + 1] - U[a * 2 + 1]];
      uvArea += Math.abs(u1[0] * u2[1] - u1[1] * u2[0]) / 2;
    }
    if (shape.hasColor) for (let i = 0; i < C.length; i += 4) { color[0] += C[i]; color[1] += C[i + 1]; color[2] += C[i + 2]; count.n++; }
  }
  const tile = uvArea > 0 ? Math.sqrt(area / uvArea) : 600;
  return {
    area, floor, tile: Math.max(150, Math.min(6000, tile)),
    base: count.n ? color.map(v => Math.round(Math.min(1, v / count.n) * 255)) : [255, 255, 255],
  };
}

// The material a palette entry uses in its stage, or null where this disc lacks it.
function paletteSource(library, entry) {
  let files;
  try { files = library.files(entry.scene); } catch (_) { return null; }
  const data = files.get(MAP);
  if (!data) return null;
  const model = library.parsed(entry.scene, MAP);
  const want = entry.texture.toLowerCase();
  const candidates = [];
  model.materials.forEach((material, index) => {
    const texture = model.textures[material.textures[0]];
    if (!texture) return;
    const name = texture.name.toLowerCase();
    if (entry.match !== undefined ? index === entry.match && name.startsWith(want) : name === want || name.startsWith(want)) candidates.push(index);
  });
  if (!candidates.length) return null;
  // The material that covers the most of the stage with it.
  let best = null;
  for (const index of candidates) {
    const usage = materialUsage(model, index);
    if (!best || usage.area > best.usage.area) best = { index, usage };
  }
  return { model, data, material: best.index, ...best.usage, scale: texScale(model.materials[best.index]) };
}

function thumbnail(texture, size = 48) {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = Math.floor(x * texture.width / size), sy = Math.floor(y * texture.height / size), o = (sy * texture.width + sx) * 4, p = (y * size + x) * 4;
    out[p] = texture.rgba[o]; out[p + 1] = texture.rgba[o + 1]; out[p + 2] = texture.rgba[o + 2]; out[p + 3] = 255;
  }
  return { width: size, height: size, rgba: out };
}

// Light for new faces, as vertex colours: the stages' materials multiply
// their texture by it, and Delfino's open ground carries about this much.
const DAYLIGHT = [235, 238, 242];

// The palette as this disc has it.
function palette(library) {
  if (library.paletteCache) return library.paletteCache;
  const list = [];
  for (const entry of PALETTE) {
    const source = paletteSource(library, entry);
    if (!source) continue;
    const texture = source.model.textures[source.model.materials[source.material].textures[0]];
    list.push({ id: entry.id, label: entry.label, group: entry.group, ground: entry.ground, scene: entry.scene, tile: entry.tile || Math.round(source.tile),
      fit: entry.fit || 0, cutout: Boolean(entry.cutout), base: DAYLIGHT, thumb: thumbnail(texture) });
  }
  library.paletteCache = list;
  return list;
}
const paletteEntry = (library, id) => {
  const entry = PALETTE.find(e => e.id === id);
  return entry ? { entry, info: palette(library).find(p => p.id === id) || null } : null;
};

// A one-quad model drawn with a palette material, for the editor to take the
// material from (its colour combiner and textures) for painted and built faces.
function paletteModel(library, id) {
  const found = paletteEntry(library, id);
  if (!found?.info) throw new Error('That texture isn\'t on your disc.');
  const source = paletteSource(library, found.entry);
  const tile = found.info.tile;
  const quad = {
    position: Float32Array.from([0, 0, 0, tile, 0, 0, tile, 0, tile, 0, 0, tile]),
    normal: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uv: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]), uv1: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
    color: new Float32Array(16).fill(1), drawIndex: new Uint16Array(4), index: Uint32Array.from([0, 2, 1, 0, 3, 2]),
    hasColor: true, hasNormal: true, hasUv: true, hasUv1: false, material: source.material,
  };
  const model = { ...source.model, joints: [{ scale: [1, 1, 1], rotation: [0, 0, 0], translation: [0, 0, 0], parent: -1 }], draw: [{ weighted: false, index: 0 }], envelopes: [], inverseBind: [], shapes: [quad] };
  return levelModel.bake(model);
}

// --- Copied pieces ------------------------------------------------------------------

// A box over a stage (x0, z0, x1, z1): the ground it stands on (the lowest
// floor inside it) and what's above that.
function prefabFrame(library, scene, box) {
  const [x0, z0, x1, z1] = box;
  const col = library.files(scene).get(COL);
  // The ground the piece stands on: the lowest floor height that covers a
  // fair share of the box (not a drain or an underpass below it).
  const levels = new Map();
  if (col) {
    const { position: p } = collisionFile.parse(col);
    for (let t = 0; t < p.length; t += 9) {
      const cx = (p[t] + p[t + 3] + p[t + 6]) / 3, cz = (p[t + 2] + p[t + 5] + p[t + 8]) / 3;
      if (cx < x0 || cx > x1 || cz < z0 || cz > z1) continue;
      const e1 = [p[t + 3] - p[t], p[t + 4] - p[t + 1], p[t + 5] - p[t + 2]], e2 = [p[t + 6] - p[t], p[t + 7] - p[t + 1], p[t + 8] - p[t + 2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const length = Math.hypot(...n) || 1;
      if (n[1] / length < 0.7) continue;
      const level = Math.round((p[t + 1] + p[t + 4] + p[t + 7]) / 3 / 25) * 25;
      levels.set(level, (levels.get(level) || 0) + length / 2);
    }
  }
  const footprint = (x1 - x0) * (z1 - z0), sorted = [...levels].sort((a, b) => a[0] - b[0]);
  const floor = (sorted.find(([, area]) => area >= footprint * 0.06) || sorted[0] || [0])[0];
  // What's copied stands where it starts: a hall over an underpass sits on
  // the ground it stands on, not on the passage below it.
  const cut = floor + 15;
  let lowest = Infinity;
  for (const mesh of library.model(`${scene}|${MAP}`).meshes) {
    if (!copiedLayer(mesh)) continue;
    const P = mesh.position;
    for (const f of facesInBox(mesh, box, cut)) for (let k = 0; k < 3; k++) lowest = Math.min(lowest, P[mesh.index[f * 3 + k] * 3 + 1]);
  }
  const base = Number.isFinite(lowest) ? Math.max(floor, lowest) : floor;
  // Its ground likewise, without the floors below it.
  return { anchor: [(x0 + x1) / 2, base, (z0 + z1) / 2], cut, groundCut: Math.max(cut, base - 30) };
}
const inBox = (box, cut, x, y, z) => x >= box[0] && x <= box[2] && z >= box[1] && z <= box[3] && y > cut;

// Built-in pieces with their size, for the catalog.
function prefabs(library) {
  return PREFABS.filter(p => library.scenes().includes(p.scene)).map(p => ({ id: p.id, label: p.label, scene: p.scene, box: p.box, ref: prefabRef(p.scene, p.box) }));
}
const prefabRef = (scene, box) => `prefab|${scene}|${box.map(v => Math.round(v)).join(',')}`;
function parsePrefabRef(ref) {
  const [kind, scene, box] = String(ref).split('|');
  const values = String(box || '').split(',').map(Number);
  if (kind !== 'prefab' || values.length !== 4 || !values.every(Number.isFinite) || values[2] <= values[0] || values[3] <= values[1]) return null;
  if ((values[2] - values[0]) * (values[3] - values[1]) > 4e8) return null;
  return { scene, box: values };
}

// The faces of a stage inside a box, as a baked model standing on its anchor.
function prefabModel(library, ref) {
  const parsed = parsePrefabRef(ref);
  if (!parsed || !library.scenes().includes(parsed.scene)) throw new Error('That piece isn\'t on your disc.');
  const { scene, box } = parsed;
  const stage = library.model(`${scene}|${MAP}`);
  const { anchor, cut, groundCut } = prefabFrame(library, scene, box);
  const meshes = [];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of stage.meshes) {
    if (!copiedLayer(mesh)) continue;
    const faces = facesInBox(mesh, box, cut);
    if (!faces.length) continue;
    const out = subMesh(mesh, faces, anchor);
    for (let i = 0; i < out.position.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], out.position[i + k]); max[k] = Math.max(max[k], out.position[i + k]); }
    meshes.push(out);
  }
  const ground = prefabGround(library, scene, box, anchor, groundCut);
  if (!meshes.length) return { meshes, textures: stage.textures, bounds: { min: [0, 0, 0], max: [0, 0, 0] }, ground };
  return { meshes, textures: stage.textures, bounds: { min, max }, ground };
}
// The piece's ground (collision) triangles, standing on its anchor.
function prefabGround(library, scene, box, anchor, cut) {
  const col = library.files(scene).get(COL), position = [], codes = [];
  if (col) {
    const { position: p, codes: all } = collisionFile.parse(col);
    for (let t = 0; t < p.length; t += 9) {
      if (!inBox(box, cut, (p[t] + p[t + 3] + p[t + 6]) / 3, (p[t + 1] + p[t + 4] + p[t + 7]) / 3, (p[t + 2] + p[t + 5] + p[t + 8]) / 3)) continue;
      for (let k = 0; k < 9; k++) position.push(p[t + k] - anchor[k % 3]);
      codes.push(all[t / 9]);
    }
  }
  return { position: Float32Array.from(position), codes: Uint32Array.from(codes) };
}
// What a copied piece takes from its stage: not shadows and decals, which
// belong to the ground they lay on, nor untextured filler (the dark backs of
// walls no camera sees).
const copiedLayer = mesh => !mesh.translucent && mesh.tev?.stages.some(stage => stage.texMap >= 0);
function facesInBox(mesh, box, cut) {
  const P = mesh.position, I = mesh.index, faces = [];
  for (let f = 0; f < I.length / 3; f++) {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 3; k++) { const v = I[f * 3 + k]; x += P[v * 3]; y += P[v * 3 + 1]; z += P[v * 3 + 2]; }
    if (inBox(box, cut, x / 3, y / 3, z / 3)) faces.push(f);
  }
  return faces;
}
// Some faces of a baked mesh as their own mesh, moved by -offset.
function subMesh(mesh, faces, offset = [0, 0, 0]) {
  const n = faces.length * 3;
  const out = {
    position: new Float32Array(n * 3), normal: new Float32Array(n * 3), uv: new Float32Array(n * 2), uv1: new Float32Array(n * 2),
    color: mesh.color ? new Float32Array(n * 4) : null, index: new Uint32Array(n),
    translucent: mesh.translucent, blendSrc: mesh.blendSrc, blendDst: mesh.blendDst, doubleSided: mesh.doubleSided, tev: mesh.tev, material: mesh.material,
  };
  faces.forEach((f, i) => {
    for (let k = 0; k < 3; k++) {
      const v = mesh.index[f * 3 + k], o = i * 3 + k;
      for (let c = 0; c < 3; c++) { out.position[o * 3 + c] = mesh.position[v * 3 + c] - offset[c]; out.normal[o * 3 + c] = mesh.normal[v * 3 + c]; }
      for (let c = 0; c < 2; c++) { out.uv[o * 2 + c] = mesh.uv[v * 2 + c]; out.uv1[o * 2 + c] = mesh.uv1[v * 2 + c]; }
      if (out.color) for (let c = 0; c < 4; c++) out.color[o * 4 + c] = mesh.color[v * 4 + c];
      out.index[o] = o;
    }
  });
  return out;
}

// Models the editor asks for by these refs: palette materials and copied pieces.
function stageModel(library, ref) {
  if (String(ref).startsWith('palette|')) return library.cached(ref, () => paletteModel(library, String(ref).slice('palette|'.length)));
  if (String(ref).startsWith('prefab|')) return library.cached(ref, () => prefabModel(library, ref));
  return null;
}

// --- Writing the stage ----------------------------------------------------------------

// The shape of textures laid once over a side or border (build.faces).
const fitOf = id => PALETTE.find(entry => entry.id === id)?.fit || 0;

// Pieces and paint as a project holds them, checked.
const ID = /^[a-z0-9-]{1,40}$/;
const finite = (v, limit = 1e6) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < limit;
function cleanStage(input, scenes) {
  const texturePaint = {};
  let count = 0;
  for (const [key, id] of Object.entries(input?.texturePaint || {})) {
    if (!/^\d{1,4}:\d{1,7}$/.test(key) || !ID.test(String(id)) || ++count > 400000) continue;
    texturePaint[key] = String(id);
  }
  const pieces = (Array.isArray(input?.pieces) ? input.pieces : []).slice(0, 4000).flatMap(piece => {
    if (!piece || !Array.isArray(piece.position) || piece.position.length !== 3 || !piece.position.every(v => finite(v))) return [];
    const uid = String(piece.uid || '').slice(0, 80), yaw = finite(piece.yaw, 1e4) ? piece.yaw : 0;
    const label = String(piece.label || '').slice(0, 80);
    if (piece.kind === 'prefab') {
      const parsed = parsePrefabRef(piece.ref);
      if (!parsed || !scenes.includes(parsed.scene)) return [];
      return [{ uid, kind: 'prefab', ref: prefabRef(parsed.scene, parsed.box), label, position: [...piece.position], yaw }];
    }
    if (!build.KIND[piece.kind]) return [];
    const textures = { top: ID.test(piece.textures?.top) ? piece.textures.top : 'delfino-tiles', side: ID.test(piece.textures?.side) ? piece.textures.side : 'delfino-white-wall' };
    return [{ uid, kind: piece.kind, label, position: [...piece.position], yaw, size: build.cleanSize(piece.kind, piece.size), textures, ground: ID.test(piece.ground) ? piece.ground : null }];
  });
  return { texturePaint, pieces, blank: Boolean(input?.blank) };
}
const hasStageEdits = project => project.blank || Object.keys(project.texturePaint || {}).length > 0 || (project.pieces || []).length > 0;

// The stage's model with painted ground, built pieces and copied pieces in it.
function buildMap(library, project) {
  if (!hasStageEdits(project)) return null;
  const base = project.base, data = library.files(base).get(MAP);
  if (!data) throw new Error('This stage has no model to build into.');
  const edit = new BmdEdit(data);
  const model = library.parsed(base, MAP);
  const draw = levelModel.restPose(model);
  const baked = library.model(`${base}|${MAP}`);
  const plain = plainTemplate(model);
  const textures = new Map();  // palette id or "scene:texture" -> texture index here

  // Where new geometry goes: under the joint holding the most of the stage,
  // drawn with that shape's matrix (positions are in its space).
  const host = model.shapes.reduce((best, shape, i) => shape.index.length > (model.shapes[best]?.index.length || 0) ? i : best, 0);
  const hostShape = edit.shapes[host], hostMatrices = hostShape.packets[0].matrices;
  const toHost = invert(draw[hostMatrices[0]] || identity());

  // The material for a new shape painted or built with a palette texture,
  // and the factor from the editor's coordinates to that material's.
  const materialFor = paletteId => {
    const found = paletteEntry(library, paletteId);
    const source = found?.info && paletteSource(library, found.entry);
    if (!source) return null;
    if (source.data.equals(data)) return { material: edit.cloneMaterial(source.material), factor: [1, 1], base: DAYLIGHT, tile: found.info.tile };
    if (plain === null) return null;
    if (!textures.has(paletteId)) {
      const from = new BmdEdit(source.data), slot = from.materialTexture(source.material);
      textures.set(paletteId, importTexture(edit, from, slot, `${found.entry.id}`));
    }
    const scale = texScale(model.materials[plain.index]);
    return { material: edit.cloneMaterial(plain.index, { texture: textures.get(paletteId), cutout: Boolean(found.entry.cutout) }), factor: [source.scale[0] / scale[0], source.scale[1] / scale[1]], base: DAYLIGHT, tile: found.info.tile };
  };

  const attrsOf = list => [...list].sort((a, b) => a.attr - b.attr);
  const newAttrs = () => attrsOf([{ attr: POS, type: 3 }, ...(edit.hasArray(NRM) ? [{ attr: NRM, type: 3 }] : []), ...(edit.hasArray(CLR0) ? [{ attr: CLR0, type: 3 }] : []), { attr: TEX0, type: 3 }]);
  const bounds = points => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const p of points) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
    return { min, max };
  };

  // 1. The stage's own faces: all gone on an empty stage, else repainted ones moved to new shapes.
  if (project.blank) for (let s = 0; s < edit.shapes.length; s++) edit.removeTriangles(s, edit.shapeTriangles(s).map((_, i) => i));
  else {
    const byShape = new Map();  // shape -> Map(paletteId -> [{ local, face, mesh }])
    for (const [key, paletteId] of Object.entries(project.texturePaint || {})) {
      const [materialIndex, face] = key.split(':').map(Number);
      const mesh = baked.meshes.find(m => m.material === materialIndex);
      if (!mesh || face * 3 >= mesh.index.length) continue;
      let at = face, source = null;
      for (const [shape, count] of mesh.sources) { if (at < count) { source = shape; break; } at -= count; }
      if (source === null) continue;
      if (!byShape.has(source)) byShape.set(source, new Map());
      const groups = byShape.get(source);
      if (!groups.has(paletteId)) groups.set(paletteId, []);
      groups.get(paletteId).push({ local: at, face, mesh });
    }
    for (const [shape, groups] of byShape) {
      const all = edit.shapeTriangles(shape);
      const source = edit.shapes[shape];
      edit.removeTriangles(shape, [...groups.values()].flat().map(g => g.local));
      for (const [paletteId, list] of groups) {
        const look = materialFor(paletteId);
        if (!look) continue;
        const attrs = attrsOf([...source.attrs.filter(a => a.attr !== TEX0).map(a => a.attr === 0 ? a : { ...a, type: a.type === 1 ? 1 : 3 }), { attr: TEX0, type: 3 }]);
        const packets = new Map(), points = [];
        for (const { local, face, mesh } of list) {
          const { packet, tri } = all[local];
          // Baked faces list a triangle's corners as (a, c, b).
          const corner = [0, 2, 1].map(k => mesh.index[face * 3 + k]);
          const record = tri.map((vertex, k) => {
            const v = corner[k], p = [mesh.position[v * 3], mesh.position[v * 3 + 1], mesh.position[v * 3 + 2]];
            points.push(p);
            const uv = build.planarUv(p, faceNormal(mesh, face), look.tile);
            return { ...vertex, [TEX0]: edit.addVertex(TEX0, [uv[0] * look.factor[0], uv[1] * look.factor[1]]) };
          });
          if (!packets.has(packet)) packets.set(packet, []);
          packets.get(packet).push(record);
        }
        edit.addShape({ attrs, packets: [...packets].map(([p, triangles]) => ({ matrices: source.packets[p].matrices, triangles })), joint: source.joint, material: look.material, bounds: bounds(points) });
      }
    }
  }

  // 2. Built pieces, a shape per texture each.
  const addFaces = (faces, look, colorOf) => {
    const triangles = [], points = [];
    for (const face of faces) {
      const records = face.p.map((world, k) => {
        const local = transform(toHost, world), n = rotate(toHost, face.n);
        points.push(local);
        const uv = face.uv ? face.uv[k] : build.planarUv(world, face.n, look.tile);
        const record = { [POS]: edit.addVertex(POS, local), [TEX0]: edit.addVertex(TEX0, [uv[0] * look.factor[0], uv[1] * look.factor[1]]) };
        if (edit.hasArray(NRM)) record[NRM] = edit.addVertex(NRM, n);
        if (edit.hasArray(CLR0)) record[CLR0] = edit.addVertex(CLR0, colorOf(face, k));
        return record;
      });
      // Counter-clockwise corners (a, b, c) are drawn by the game as (a, c, b).
      triangles.push([records[0], records[2], records[1]]);
    }
    if (!triangles.length) return;
    edit.addShape({ attrs: newAttrs(), packets: [{ matrices: hostMatrices, triangles }], joint: hostShape.joint, material: look.material, bounds: bounds(points) });
  };
  for (const piece of project.pieces || []) {
    if (piece.kind === 'prefab') { addPrefab(library, edit, piece, { data, materialFor: null, plain, model, addFaces, textures, toHost, hostMatrices, hostShape, bounds }); continue; }
    const groups = new Map();
    for (const face of build.faces(piece, fitOf)) {
      if (!groups.has(face.texture)) groups.set(face.texture, []);
      groups.get(face.texture).push(face);
    }
    for (const [paletteId, faces] of groups) {
      const look = materialFor(paletteId);
      if (look) addFaces(faces, look, face => build.shade(face.n, look.base));
    }
  }
  return edit.write();
}

// A copied piece: same-stage pieces keep their own materials; pieces from
// another stage take its textures, drawn with this stage's plain material.
function addPrefab(library, edit, piece, context) {
  const parsed = parsePrefabRef(piece.ref);
  if (!parsed) return;
  const { scene, box } = parsed;
  const sourceData = library.files(scene).get(MAP);
  if (!sourceData) return;
  const stage = library.model(`${scene}|${MAP}`);
  const { anchor, cut } = prefabFrame(library, scene, box);
  const yaw = (piece.yaw || 0) * Math.PI / 180, c = Math.cos(yaw), s = Math.sin(yaw);
  const place = p => { const x = p[0] - anchor[0], y = p[1] - anchor[1], z = p[2] - anchor[2]; return [piece.position[0] + x * c + z * s, piece.position[1] + y, piece.position[2] - x * s + z * c]; };
  const turn = n => [n[0] * c + n[2] * s, n[1], -n[0] * s + n[2] * c];
  const same = sourceData.equals(context.data);
  const from = same ? null : new BmdEdit(sourceData);
  const sourceModel = library.parsed(scene, MAP);
  for (const mesh of stage.meshes) {
    if (!copiedLayer(mesh)) continue;
    const faces = facesInBox(mesh, box, cut);
    if (!faces.length || mesh.material === undefined) continue;
    let look;
    if (same) look = { material: edit.cloneMaterial(mesh.material), factor: [1, 1] };
    else {
      const slot = from.materialTexture(mesh.material);
      if (slot < 0 || context.plain === null) continue;
      const key = `${scene}:${slot}`;
      if (!context.textures.has(key)) context.textures.set(key, importTexture(edit, from, slot, `${scene}_${from.textureName(slot)}`.slice(0, 60)));
      const scale = texScale(context.model.materials[context.plain.index]), own = texScale(sourceModel.materials[mesh.material]);
      look = { material: edit.cloneMaterial(context.plain.index, { texture: context.textures.get(key) }), factor: [own[0] / scale[0], own[1] / scale[1]] };
    }
    const list = faces.map(f => {
      const corners = [0, 1, 2].map(k => mesh.index[f * 3 + k]);
      return {
        p: corners.map(v => place([mesh.position[v * 3], mesh.position[v * 3 + 1], mesh.position[v * 3 + 2]])),
        n: turn(faceNormal(mesh, f)),
        uv: corners.map(v => [mesh.uv[v * 2], mesh.uv[v * 2 + 1]]),
        color: corners.map(v => mesh.color ? [0, 1, 2, 3].map(k => mesh.color[v * 4 + k] * 255) : [255, 255, 255, 255]),
      };
    });
    context.addFaces(list, look, (face, k) => face.color[k]);
  }
}

// An emptied stage's sea: just the open water, without the canals,
// waterfalls and shore foam that went with the stage's land.
function buildSea(library, project) {
  const data = project.blank && library.files(project.base).get(SEA);
  if (!data) return null;
  const edit = new BmdEdit(data), baked = library.model(`${project.base}|${SEA}`);
  const open = openSea(baked);
  const keep = new Set(baked.meshes[open]?.sources?.map(([shape]) => shape) || []);
  for (let s = 0; s < edit.shapes.length; s++) if (!keep.has(s)) edit.removeTriangles(s, edit.shapeTriangles(s).map((_, i) => i));
  return edit.write();
}
// The sea model's mesh that spreads furthest: the open water.
function openSea(baked) {
  let best = -1, area = -1;
  baked.meshes.forEach((mesh, i) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < mesh.position.length; k += 3) { x0 = Math.min(x0, mesh.position[k]); x1 = Math.max(x1, mesh.position[k]); z0 = Math.min(z0, mesh.position[k + 2]); z1 = Math.max(z1, mesh.position[k + 2]); }
    if ((x1 - x0) * (z1 - z0) > area) { area = (x1 - x0) * (z1 - z0); best = i; }
  });
  return best;
}

// The stage's ground with painted surfaces, built pieces and copied pieces.
function buildGround(library, project, surfaces, defaults) {
  const col = library.files(project.base).get(COL);
  if (!col && !project.blank && !(project.pieces || []).length) throw new Error('This stage has no ground file.');
  const add = [];
  const codeOf = id => { const s = surfaces.find(x => x.id === id) || surfaces[0]; return s.type * 256 + s.sound; };
  const stone = codeOf('stone');
  for (const piece of project.pieces || []) {
    if (piece.kind === 'prefab') {
      const parsed = parsePrefabRef(piece.ref);
      const source = parsed && library.files(parsed.scene).get(COL);
      if (!source) continue;
      const { anchor, groundCut } = prefabFrame(library, parsed.scene, parsed.box);
      const yaw = (piece.yaw || 0) * Math.PI / 180, c = Math.cos(yaw), s = Math.sin(yaw);
      const place = (x, y, z) => { x -= anchor[0]; y -= anchor[1]; z -= anchor[2]; return [piece.position[0] + x * c + z * s, piece.position[1] + y, piece.position[2] - x * s + z * c]; };
      const { position: p, codes } = collisionFile.parse(source);
      for (let t = 0; t < p.length; t += 9) {
        const cx = (p[t] + p[t + 3] + p[t + 6]) / 3, cy = (p[t + 1] + p[t + 4] + p[t + 7]) / 3, cz = (p[t + 2] + p[t + 5] + p[t + 8]) / 3;
        if (!inBox(parsed.box, groundCut, cx, cy, cz)) continue;
        add.push({ p: [0, 3, 6].map(k => place(p[t + k], p[t + k + 1], p[t + k + 2])), code: codes[t / 9] });
      }
      continue;
    }
    if (!build.solid(piece)) continue;
    const groundId = piece.ground || palette(library).find(p => p.id === piece.textures.top)?.ground || 'stone';
    for (const face of build.faces(piece)) add.push({ p: face.p, code: build.isFloor(face.n) ? codeOf(groundId) : stone });
  }
  if (!project.blank && !add.length) return Object.keys(project.paint || {}).length ? collisionFile.paint(col, project.paint, defaults) : null;
  return collisionFile.compose(col || null, { changes: project.paint || {}, defaults, clear: project.blank, keep: keepsOnEmpty, add });
}

// What an emptied stage keeps of its ground: the sea's surface and floor and
// the plane below that ends a fall (camera and shadow bits aside).
const EMPTY_KEEPS = new Set([0x0102, 0x0700, 0x0800]);
const keepsOnEmpty = type => EMPTY_KEEPS.has(type & 0x1fff);

// The stage's plainest material: one texture, one stage, opaque, the most
// ground covered. Textures from other stages are drawn with it.
function plainTemplate(model) {
  let best = null;
  model.materials.forEach((material, index) => {
    if (material.stages.length !== 1 || material.textures[0] < 0 || material.textures.slice(1).some(t => t >= 0) || material.blend.type !== 0) return;
    const usage = materialUsage(model, index);
    if (!best || usage.floor > best.floor) best = { index, floor: usage.floor, base: usage.base };
  });
  return best;
}

// A texture from another model file, added once.
function importTexture(edit, from, slot, name) {
  const headersAt = from.tex.readUInt32BE(0x0c);
  return edit.addTexture(from.tex, headersAt + slot * 0x20, name);
}

function faceNormal(mesh, f) {
  const P = mesh.position, [a, b, c] = [0, 1, 2].map(k => mesh.index[f * 3 + k]);
  const e1 = [0, 1, 2].map(k => P[b * 3 + k] - P[a * 3 + k]), e2 = [0, 1, 2].map(k => P[c * 3 + k] - P[a * 3 + k]);
  const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const length = Math.hypot(...n) || 1;
  return n.map(v => v / length);
}

const identity = () => Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function transform(m, [x, y, z]) { return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]; }
function rotate(m, [x, y, z]) {
  const v = [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z], l = Math.hypot(...v) || 1;
  return v.map(c => c / l);
}
// An affine 4×4 (column-major) inverse.
function invert(m) {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return identity();
  const r = [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det, (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det, (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
  const t = [m[12], m[13], m[14]];
  const out = identity();
  out[0] = r[0]; out[4] = r[1]; out[8] = r[2]; out[1] = r[3]; out[5] = r[4]; out[9] = r[5]; out[2] = r[6]; out[6] = r[7]; out[10] = r[8];
  out[12] = -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]); out[13] = -(r[3] * t[0] + r[4] * t[1] + r[5] * t[2]); out[14] = -(r[6] * t[0] + r[7] * t[1] + r[8] * t[2]);
  return out;
}

module.exports = {
  PALETTE, PALETTE_GROUPS, PREFABS, palette, paletteModel, prefabs, prefabModel, prefabRef, parsePrefabRef, stageModel,
  cleanStage, hasStageEdits, buildMap, buildGround, buildSea, openSea, plainTemplate, EMPTY_KEEPS,
};
