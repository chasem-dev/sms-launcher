// Pieces players build stages from in the world editor: floors, blocks,
// walls, ramps, stairs, pillars, roofs and simple houses, each textured with
// textures from the game's own stages. Shared by the editor's 3D view (as a
// plain script, window.smsWorldBuild) and the export (require), so what's
// drawn is what's written into the stage.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.smsWorldBuild = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const KINDS = [
    { id: 'floor', label: 'Floor', detail: 'A flat slab to walk on: lay down ground, paths and plazas.', size: [1600, 100, 1600], faces: ['top', 'side'] },
    { id: 'block', label: 'Block', detail: 'A solid box: platforms, crates of stone, the body of a building.', size: [600, 600, 600], faces: ['top', 'side'] },
    { id: 'wall', label: 'Wall', detail: 'A thin wall to fence things in or build rooms from.', size: [1200, 600, 80], faces: ['top', 'side'] },
    { id: 'ramp', label: 'Ramp', detail: 'A slope up to a higher floor.', size: [600, 300, 1200], faces: ['top', 'side'] },
    { id: 'stairs', label: 'Stairs', detail: 'Steps up, about Mario\'s stride each.', size: [600, 400, 1000], faces: ['top', 'side'] },
    { id: 'pillar', label: 'Pillar', detail: 'A round column.', size: [200, 900, 200], faces: ['top', 'side'] },
    { id: 'roof', label: 'Roof', detail: 'A pitched roof to put on walls or blocks.', size: [1200, 400, 1000], faces: ['top', 'side'] },
    { id: 'house', label: 'House', detail: 'Four walls and a pitched roof in one piece.', size: [1200, 1000, 1000], faces: ['top', 'side'] },
    { id: 'border', label: 'Border', detail: 'A flat strip laid on the ground, such as grass fringing onto sand. Its top texture runs once across it, from the back edge.', size: [2000, 20, 300], faces: ['top'] },
  ];
  const KIND = Object.fromEntries(KINDS.map(k => [k.id, k]));
  const MIN_SIZE = 20, MAX_SIZE = 40000;

  // Faces as triangles: [x, y, z] corners in counter-clockwise order seen
  // from outside, and which texture they take ('top' or 'side').
  function quad(out, face, a, b, c, d) { out.push({ face, p: [a, b, c] }, { face, p: [a, c, d] }); }
  function box(out, x0, y0, z0, x1, y1, z1, { bottom = false, top = 'top' } = {}) {
    quad(out, top, [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
    if (bottom) quad(out, 'side', [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    quad(out, 'side', [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);  // +z
    quad(out, 'side', [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);  // -z
    quad(out, 'side', [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);  // +x
    quad(out, 'side', [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);  // -x
  }
  // A pitched roof over [x0, x1] × [z0, z1], its ridge along x at height h
  // above y, its eaves reaching `overhang` past the walls.
  function roof(out, x0, x1, y, z0, z1, h, overhang = 0) {
    const zm = (z0 + z1) / 2, a = x0 - overhang, b = x1 + overhang, f = z0 - overhang, g = z1 + overhang;
    const eave = y - h * overhang / (zm - z0);  // eaves dip below the wall tops
    quad(out, 'top', [a, eave, g], [b, eave, g], [b, y + h, zm], [a, y + h, zm]);
    quad(out, 'top', [b, eave, f], [a, eave, f], [a, y + h, zm], [b, y + h, zm]);
    out.push({ face: 'side', p: [[x1, y, z1], [x1, y, z0], [x1, y + h, zm]] });
    out.push({ face: 'side', p: [[x0, y, z0], [x0, y, z1], [x0, y + h, zm]] });
    // The eaves' undersides, so they aren't see-through from below.
    if (overhang) {
      quad(out, 'top', [b, eave, g], [a, eave, g], [a, y, z1], [b, y, z1]);
      quad(out, 'top', [a, eave, f], [b, eave, f], [b, y, z0], [a, y, z0]);
    }
  }

  // A piece's triangles in its own space: x across, y up, z deep, centred
  // on x and z, standing on y = 0 (floors: top at 0).
  function localFaces(kind, [w, h, d]) {
    const out = [], x0 = -w / 2, x1 = w / 2, z0 = -d / 2, z1 = d / 2;
    if (kind === 'floor') box(out, x0, -h, z0, x1, 0, z1);
    else if (kind === 'block' || kind === 'wall') box(out, x0, 0, z0, x1, h, z1);
    else if (kind === 'ramp') {
      quad(out, 'top', [x0, 0, z1], [x1, 0, z1], [x1, h, z0], [x0, h, z0]);
      quad(out, 'side', [x1, 0, z0], [x0, 0, z0], [x0, h, z0], [x1, h, z0]);
      out.push({ face: 'side', p: [[x1, 0, z1], [x1, 0, z0], [x1, h, z0]] });
      out.push({ face: 'side', p: [[x0, 0, z0], [x0, 0, z1], [x0, h, z0]] });
    } else if (kind === 'stairs') {
      const steps = Math.max(1, Math.min(40, Math.round(h / 45))), rise = h / steps, run = d / steps;
      for (let i = 0; i < steps; i++) box(out, x0, 0, z1 - run * (i + 1), x1, rise * (i + 1), z1 - run * i);
    } else if (kind === 'pillar') {
      const sides = 16, rx = w / 2, rz = d / 2;
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2, b = ((i + 1) / sides) * Math.PI * 2;
        const pa = [Math.sin(a) * rx, Math.cos(a) * rz], pb = [Math.sin(b) * rx, Math.cos(b) * rz];
        quad(out, 'side', [pa[0], 0, pa[1]], [pb[0], 0, pb[1]], [pb[0], h, pb[1]], [pa[0], h, pa[1]]);
        out.push({ face: 'top', p: [[0, h, 0], [pa[0], h, pa[1]], [pb[0], h, pb[1]]] });
      }
    } else if (kind === 'roof') roof(out, x0, x1, 0, z0, z1, h, 0);
    else if (kind === 'border') quad(out, 'top', [x0, 3, z1], [x1, 3, z1], [x1, 3, z0], [x0, 3, z0]);
    else if (kind === 'house') {
      const wallHeight = h * 0.62;
      box(out, x0, 0, z0, x1, wallHeight, z1, { top: 'side' });
      roof(out, x0, x1, wallHeight, z0, z1, h - wallHeight, Math.min(w, d) * 0.06);
    }
    return out;
  }

  const DEG = Math.PI / 180;
  function cleanSize(kind, size) {
    const base = KIND[kind]?.size || [400, 400, 400];
    return [0, 1, 2].map(i => {
      const v = Number(size?.[i]);
      return Number.isFinite(v) ? Math.max(MIN_SIZE, Math.min(MAX_SIZE, v)) : base[i];
    });
  }

  // A piece in the world: { kind, position, yaw, size, textures: { top, side } }
  // -> triangles with world corners, normals and which texture each takes.
  // `fit(texture)` gives the width-to-height ratio of textures laid once
  // across a side's height (a grassy bank: grass at the top, earth below)
  // or a border's depth, each repeat keeping that shape; 0 for textures
  // laid over the world.
  function faces(piece, fit = () => 0) {
    const kind = KIND[piece.kind] ? piece.kind : 'block';
    const size = cleanSize(kind, piece.size);
    const yaw = (Number(piece.yaw) || 0) * DEG, c = Math.cos(yaw), s = Math.sin(yaw);
    const [px, py, pz] = piece.position;
    const place = ([x, y, z]) => [px + x * c + z * s, py + y, pz - x * s + z * c];
    const bottom = kind === 'floor' ? py - size[1] : py, top = kind === 'floor' ? py : py + size[1];
    return localFaces(kind, size).map(({ face, p }) => {
      const q = p.map(place);
      const e1 = [q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]], e2 = [q[2][0] - q[0][0], q[2][1] - q[0][1], q[2][2] - q[0][2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const length = Math.hypot(n[0], n[1], n[2]) || 1;
      const texture = piece.textures?.[face] || piece.textures?.top, unit = n.map(v => v / length);
      const aspect = fit(texture);
      let uv;
      const width = aspect * (kind === 'border' ? size[2] : Math.max(1, top - bottom));
      if (aspect && kind === 'border') uv = p.map(([x, , z]) => [(x + size[0] / 2) / width, inset((z + size[2] / 2) / size[2])]);
      else if (aspect && Math.abs(unit[1]) < 0.3) {
        // Across the side as it faces, and from the piece's top down.
        const across = [-unit[2], 0, unit[0]];
        uv = q.map(v => [(v[0] * across[0] + v[2] * across[2]) / width, inset((top - v[1]) / Math.max(1, top - bottom))]);
      }
      return { texture, face, p: q, n: unit, ...(uv ? { uv } : {}) };
    }).filter(f => Math.hypot(...f.n) > 0.5);
  }

  // Just inside the texture's own rows, so filtering doesn't bleed in the
  // other edge of a texture that repeats.
  function inset(v) { return 0.01 + 0.98 * v; }

  // Pieces that are only a surface laid on others, not ground to stand on.
  const solid = piece => piece.kind !== 'border';

  // Texture coordinates laid over the world, so neighbouring pieces and
  // repainted ground line up: floors from above, walls from the side they face.
  function planarUv(p, n, tile) {
    const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
    if (ay >= ax && ay >= az) return [p[0] / tile, p[2] / tile];
    if (ax >= az) return [p[2] / tile * Math.sign(n[0] || 1), -p[1] / tile];
    return [-p[0] / tile * Math.sign(n[2] || 1), -p[1] / tile];
  }

  // Light baked into vertex colours as the game's stages do: full on top,
  // a little darker on walls facing away from the sun.
  const SUN = (() => { const v = [0.4, 1, 0.3], l = Math.hypot(...v); return v.map(x => x / l); })();
  function shade(n, base = [255, 255, 255]) {
    const lit = 0.72 + 0.28 * Math.max(0, n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2]);
    return [base[0] * lit, base[1] * lit, base[2] * lit, 255];
  }

  // Floors get the piece's ground; walls and undersides ordinary ground.
  const isFloor = n => n[1] > 0.2;

  return { KINDS, KIND, MIN_SIZE, MAX_SIZE, faces, planarUv, shade, isFloor, cleanSize, solid };
});
