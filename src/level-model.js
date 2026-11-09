'use strict';

// A J3D model (j3d.parseBmd) posed at rest and flattened for the world
// editor: one mesh per material, positions already through the joints, plus
// the textures those meshes use. The editor draws stages and objects still,
// so nothing here needs the skeleton again.

function mat4() { return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }

function multiply(a, b) {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
    out[c * 4 + r] = sum;
  }
  return out;
}

// Scale, then rotate X, Y, Z (J3D's order), then translate; column-major.
function compose(scale, rotation, translation) {
  const [x, y, z] = rotation;
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  const m = [
    cy * cz, cy * sz, -sy,
    sx * sy * cz - cx * sz, sx * sy * sz + cx * cz, sx * cy,
    cx * sy * cz + sx * sz, cx * sy * sz - sx * cz, cx * cy,
  ];
  return new Float64Array([
    m[0] * scale[0], m[1] * scale[0], m[2] * scale[0], 0,
    m[3] * scale[1], m[4] * scale[1], m[5] * scale[1], 0,
    m[6] * scale[2], m[7] * scale[2], m[8] * scale[2], 0,
    translation[0], translation[1], translation[2], 1,
  ]);
}

// Each joint's matrix in the model's rest (or given) pose.
function jointWorld(model, pose = null) {
  const world = new Array(model.joints.length);
  const visit = j => {
    if (world[j]) return world[j];
    const joint = { ...model.joints[j], ...pose?.[j] }, local = compose(joint.scale, joint.rotation, joint.translation);
    world[j] = joint.parent >= 0 ? multiply(visit(joint.parent), local) : local;
    return world[j];
  };
  model.joints.forEach((_, j) => visit(j));
  return world;
}

// A baked model with another put into it at `matrix` (a part on a joint).
function merge(base, part, matrix) {
  const offset = base.textures.length;
  base.textures.push(...part.textures);
  for (const mesh of part.meshes) {
    const p = mesh.position, n = mesh.normal, m = matrix;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      p[i] = m[0] * x + m[4] * y + m[8] * z + m[12]; p[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]; p[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
      const a = n[i], b = n[i + 1], c = n[i + 2];
      const tx = m[0] * a + m[4] * b + m[8] * c, ty = m[1] * a + m[5] * b + m[9] * c, tz = m[2] * a + m[6] * b + m[10] * c, l = Math.hypot(tx, ty, tz) || 1;
      n[i] = tx / l; n[i + 1] = ty / l; n[i + 2] = tz / l;
      for (let k = 0; k < 3; k++) { base.bounds.min[k] = Math.min(base.bounds.min[k], p[i + k]); base.bounds.max[k] = Math.max(base.bounds.max[k], p[i + k]); }
    }
    if (mesh.tev) for (const stage of mesh.tev.stages) if (stage.texMap >= 0) stage.texMap += offset;
    base.meshes.push(mesh);
  }
  return base;
}

// `pose` optionally replaces joints' local transforms ({ scale, rotation, translation } per joint).
function restPose(model, pose = null) {
  const world = new Array(model.joints.length);
  const visit = j => {
    if (world[j]) return world[j];
    const joint = { ...model.joints[j], ...pose?.[j] }, local = compose(joint.scale, joint.rotation, joint.translation);
    world[j] = joint.parent >= 0 ? multiply(visit(joint.parent), local) : local;
    return world[j];
  };
  model.joints.forEach((_, j) => visit(j));
  const draw = model.draw.map(entry => {
    if (!entry.weighted) return world[entry.index] || mat4();
    const out = new Float64Array(16);
    for (const { joint, weight } of model.envelopes[entry.index] || []) {
      const product = multiply(world[joint], Float64Array.from(model.inverseBind[joint] || mat4()));
      for (let e = 0; e < 16; e++) out[e] += product[e] * weight;
    }
    return out;
  });
  return draw;
}

// How a material draws: its blend mode and culling, and everything the
// renderer's TEV shader needs to combine its textures and colours the way the
// GameCube's colour combiner does.
function look(material, textures) {
  const blend = material?.blend || {};
  return {
    // GX blend mode 1 blends with these factors (0 zero, 1 one, 2 colour, 3 one minus colour, 4 source alpha…).
    translucent: blend.type === 1,
    blendSrc: blend.src, blendDst: blend.dst,
    // GX cull modes: 0 none, 1 front, 2 back.
    doubleSided: material?.cull === 0,
    tev: material ? tevOf(material, textures) : null,
  };
}

const unit = rgba => rgba ? rgba.map(v => v / 255) : null;

function tevOf(material, textures) {
  const stages = material.stages.map(stage => ({
    ...stage, texMap: stage.texMap === 0xff ? -1 : material.textures[stage.texMap] ?? -1,
    texCoord: stage.texCoord === 0xff ? -1 : stage.texCoord,
  }));
  const kColors = material.kColors.map(c => unit(c) || [1, 1, 1, 1]);
  const alphaTest = material.alphaTest || { comp0: 7, ref0: 0, op: 0, comp1: 7, ref1: 0 };
  return {
    stages, kColors,
    // TEV registers C0..C2, then PREV's starting value; signed, so past 0..1.
    tevColors: material.tevColors.map(c => c ? c.map(v => v / 255) : [0, 0, 0, 0]),
    channels: material.channels.map(c => c || { lighting: false, matSource: 0, ambSource: 0, litMask: 0 }),
    matColors: [0, 1].map(i => unit(material.matColor[i]) || [1, 1, 1, 1]),
    ambColors: [0, 1].map(i => unit(material.ambColor[i]) || [0, 0, 0, 0]),
    texGens: material.texGens.map(gen => gen && { type: gen.type, source: gen.source, ...texGenMatrix(material, gen) }),
    alphaTest: { ...alphaTest, ref0: alphaTest.ref0 / 255, ref1: alphaTest.ref1 / 255, on: alphaTestOn(material, stages, textures, alphaTest) },
  };
}

// The alpha test, unless it would only speckle an atlas: textures whose alpha
// is a few see-through seams (no smaller levels on the disc to soften them).
function alphaTestOn(material, stages, textures, alphaTest) {
  if (alphaTest.comp0 === 7 && alphaTest.comp1 === 7) return false;
  const alphaTextures = stages.filter(stage => stage.alphaIn.includes(4)).map(stage => textures[stage.texMap]).filter(Boolean);
  return !alphaTextures.some(texture => !texture.mipmapped && seeThrough(texture) > 0 && seeThrough(texture) < 0.08);
}

// The share of a texture's texels that an alpha test would cut away.
const seeThroughCache = new WeakMap();
function seeThrough(texture) {
  if (!seeThroughCache.has(texture)) {
    let cut = 0;
    for (let i = 3; i < texture.rgba.length; i += 4) if (texture.rgba[i] < 128) cut++;
    seeThroughCache.set(texture, cut / (texture.rgba.length / 4 || 1));
  }
  return seeThroughCache.get(texture);
}

// GX texgen matrices: GX_TEXMTX0 is 30, then every 3; 60 is identity.
const TEXMTX0 = 30;

// A texgen's texture matrix as [a, b, c, d, e, f] for u' = a·u + b·v + c,
// v' = d·u + e·v + f, and whether it maps by the surface's facing (an
// environment map) rather than its texture coordinates.
function texGenMatrix(material, gen) {
  if (gen.matrix < TEXMTX0 || gen.matrix > TEXMTX0 + 27) return { matrix: null, env: gen.source === 1 };
  const m = material.texMatrices?.[(gen.matrix - TEXMTX0) / 3];
  if (!m) return { matrix: null, env: gen.source === 1 };
  const [sx, sy] = m.scale, [cx, cy] = m.center, cos = Math.cos(m.rotation), sin = Math.sin(m.rotation);
  // J3DGetTextureMtx: scale and rotate about the centre, then translate.
  const a = sx * cos, b = -sx * sin, d = sy * sin, e = sy * cos;
  const mode = m.info & 0x3f;
  return { matrix: [a, b, m.translation[0] + cx - (a * cx + b * cy), d, e, m.translation[1] + cy - (d * cx + e * cy)],
    env: gen.source === 1 || gen.source === 0 || [1, 2, 3, 6, 7, 8, 9].includes(mode) };
}

// Options: `pose` as for restPose, `skipShapes` a set of shape indexes to leave out.
function bake(model, { pose = null, skipShapes = null } = {}) {
  const draw = restPose(model, pose);
  const groups = new Map();
  for (const [index, shape] of model.shapes.entries()) {
    if (skipShapes?.has(index)) continue;
    const key = `${shape.material}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { material: shape.material, parts: [], ...look(model.materials[shape.material], model.textures) });
    group.parts.push(shape);
    (group.sources ||= []).push([index, shape.index.length / 3]);
  }
  const meshes = [];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const group of groups.values()) {
    const vertexCount = group.parts.reduce((n, s) => n + s.drawIndex.length, 0);
    const indexCount = group.parts.reduce((n, s) => n + s.index.length, 0);
    if (!vertexCount || !indexCount) continue;
    const position = new Float32Array(vertexCount * 3), normal = new Float32Array(vertexCount * 3);
    const uv = new Float32Array(vertexCount * 2), uv1 = new Float32Array(vertexCount * 2), color = new Float32Array(vertexCount * 4);
    const index = new Uint32Array(indexCount);
    let v = 0, i = 0, hasColor = false;
    for (const shape of group.parts) {
      for (let k = 0; k < shape.index.length; k++) index[i++] = shape.index[k] + v;
      hasColor ||= shape.hasColor;
      for (let k = 0; k < shape.drawIndex.length; k++, v++) {
        const m = draw[shape.drawIndex[k]] || mat4(), o = k * 3;
        const x = shape.position[o], y = shape.position[o + 1], z = shape.position[o + 2];
        const px = m[0] * x + m[4] * y + m[8] * z + m[12], py = m[1] * x + m[5] * y + m[9] * z + m[13], pz = m[2] * x + m[6] * y + m[10] * z + m[14];
        position[v * 3] = px; position[v * 3 + 1] = py; position[v * 3 + 2] = pz;
        if (px < min[0]) min[0] = px; if (py < min[1]) min[1] = py; if (pz < min[2]) min[2] = pz;
        if (px > max[0]) max[0] = px; if (py > max[1]) max[1] = py; if (pz > max[2]) max[2] = pz;
        const nx = shape.normal[o], ny = shape.normal[o + 1], nz = shape.normal[o + 2];
        const tx = m[0] * nx + m[4] * ny + m[8] * nz, ty = m[1] * nx + m[5] * ny + m[9] * nz, tz = m[2] * nx + m[6] * ny + m[10] * nz;
        const length = Math.hypot(tx, ty, tz) || 1;
        normal[v * 3] = tx / length; normal[v * 3 + 1] = ty / length; normal[v * 3 + 2] = tz / length;
        uv[v * 2] = shape.uv[k * 2]; uv[v * 2 + 1] = shape.uv[k * 2 + 1];
        // A second coordinate set where the model has one, else the first again.
        const second = shape.hasUv1 ? shape.uv1 : shape.uv;
        uv1[v * 2] = second[k * 2]; uv1[v * 2 + 1] = second[k * 2 + 1];
        for (let c = 0; c < 4; c++) color[v * 4 + c] = shape.color[k * 4 + c];
      }
    }
    // `material` and `sources` ([shape, triangle count] in face order) let
    // repainted faces be found again in the model file.
    meshes.push({ position, normal, uv, uv1, color: hasColor ? color : null, index, material: group.material, sources: group.sources,
      translucent: group.translucent, blendSrc: group.blendSrc, blendDst: group.blendDst, doubleSided: group.doubleSided, tev: group.tev });
  }
  const used = new Set(meshes.flatMap(m => m.tev ? m.tev.stages.map(stage => stage.texMap) : []).filter(t => t >= 0));
  const textures = model.textures.map((t, i) => used.has(i) ? { width: t.width, height: t.height, rgba: t.rgba, wrapS: t.wrapS, wrapT: t.wrapT, name: t.name, mipmapped: t.mipmapped } : null);
  if (!meshes.length) return { meshes, textures, bounds: { min: [0, 0, 0], max: [0, 0, 0] } };
  return { meshes, textures, bounds: { min, max } };
}

module.exports = { bake, compose, multiply, jointWorld, merge, restPose, look };
