'use strict';

// A J3D model (j3d.parseBmd) posed at rest and flattened for the world
// editor: one mesh per material, positions already through the joints, plus
// the textures those meshes use. The editor draws stages and objects still,
// so nothing here needs the skeleton again.

// GX texture formats with real alpha: IA4, IA8, RGB5A3, RGBA8, CMPR and the palette ones.
const ALPHA_FORMATS = new Set([2, 3, 5, 6, 8, 9, 10, 14]);

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

// How a material looks, simplified to what a plain textured mesh can show:
// its first texture, blend mode and cut-outs.
function look(material, textures) {
  const blend = material?.blend || {};
  const alphaTest = material?.alphaTest || {};
  const first = material ? material.textures.find(t => t >= 0) ?? -1 : -1;
  // A cut-out needs an alpha test (GX_ALWAYS on both compares means none) on
  // alpha that comes from the first texture: every colour stage that reads a
  // texture's alpha (TEV input 4) reads that one, and it stores alpha.
  const texAlpha = (material?.stages || []).filter(stage => stage.alphaIn.includes(4)).map(stage => material.textures[stage.texMap] ?? -1);
  // And the texture is a real cut-out (leaves, fences, railings): atlases with
  // a few see-through seams would only speckle when drawn small.
  const cutout = !(alphaTest.comp0 === 7 && alphaTest.comp1 === 7) && texAlpha.length > 0 && texAlpha.every(t => t === first)
    && first >= 0 && ALPHA_FORMATS.has(textures[first]?.format) && seeThrough(textures[first]) > 0.08;
  return {
    // GX blend mode 1 blends with these factors (0 zero, 1 one, 2 colour, 3 one minus colour, 4 source alpha…).
    translucent: blend.type === 1,
    blendSrc: blend.src, blendDst: blend.dst,
    additive: blend.type === 1 && blend.dst === 1,
    cutout,
    alphaRef: cutout ? Math.max(alphaTest.ref0 || 0, alphaTest.ref1 || 0) / 255 : 0,
    // GX cull modes: 0 none, 1 front, 2 back.
    doubleSided: material?.cull === 0,
    color: material?.matColor?.[0] ? material.matColor[0].map(v => v / 255) : [1, 1, 1, 1],
  };
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

// GX texgen sources and matrices: TEX0 is 4; GX_TEXMTX0 is 30, then every 3.
const TG_TEX0 = 4, TEXMTX0 = 30;

// The texture matrix that maps the first texture's coordinates, as
// [a, b, c, d, e, f] for u' = a·u + b·v + c, v' = d·u + e·v + f; null for none.
function uvMatrix(material, first) {
  if (!material || first < 0) return null;
  const stage = material.stages.find(st => material.textures[st.texMap] === first);
  const gen = stage && material.texGens?.[stage.texCoord];
  if (!gen || gen.source !== TG_TEX0 || gen.matrix < TEXMTX0 || gen.matrix > TEXMTX0 + 27) return null;
  const m = material.texMatrices?.[(gen.matrix - TEXMTX0) / 3];
  if (!m) return null;
  const [sx, sy] = m.scale, [cx, cy] = m.center, cos = Math.cos(m.rotation), sin = Math.sin(m.rotation);
  // J3DGetTextureMtx: scale and rotate about the centre, then translate.
  const a = sx * cos, b = -sx * sin, d = sy * sin, e = sy * cos;
  return [a, b, m.translation[0] + cx - (a * cx + b * cy), d, e, m.translation[1] + cy - (d * cx + e * cy)];
}

// Options: `pose` as for restPose, `skipShapes` a set of shape indexes to leave out.
function bake(model, { pose = null, skipShapes = null } = {}) {
  const draw = restPose(model, pose);
  const groups = new Map();
  for (const [index, shape] of model.shapes.entries()) {
    if (skipShapes?.has(index)) continue;
    const material = model.materials[shape.material];
    const texture = material ? material.textures.find(t => t >= 0) ?? -1 : -1;
    const key = `${shape.material}`;
    let group = groups.get(key);
    if (!group) groups.set(key, group = { material: shape.material, texture, parts: [], uvMatrix: uvMatrix(material, texture), ...look(material, model.textures) });
    group.parts.push(shape);
  }
  const meshes = [];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const group of groups.values()) {
    const vertexCount = group.parts.reduce((n, s) => n + s.drawIndex.length, 0);
    const indexCount = group.parts.reduce((n, s) => n + s.index.length, 0);
    if (!vertexCount || !indexCount) continue;
    const position = new Float32Array(vertexCount * 3), normal = new Float32Array(vertexCount * 3);
    const uv = new Float32Array(vertexCount * 2), color = new Float32Array(vertexCount * 4);
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
        const u = shape.uv[k * 2], w = shape.uv[k * 2 + 1], t = group.uvMatrix;
        uv[v * 2] = t ? t[0] * u + t[1] * w + t[2] : u;
        uv[v * 2 + 1] = t ? t[3] * u + t[4] * w + t[5] : w;
        for (let c = 0; c < 4; c++) color[v * 4 + c] = shape.color[k * 4 + c];
      }
    }
    meshes.push({ position, normal, uv, color: hasColor ? color : null, index, texture: group.texture, hasNormal: group.parts.some(s => s.hasNormal),
      translucent: group.translucent, blendSrc: group.blendSrc, blendDst: group.blendDst, additive: group.additive,
      cutout: group.cutout, alphaRef: group.alphaRef, doubleSided: group.doubleSided, tint: group.color });
  }
  const used = new Set(meshes.map(m => m.texture).filter(t => t >= 0));
  const textures = model.textures.map((t, i) => used.has(i) ? { width: t.width, height: t.height, rgba: t.rgba, wrapS: t.wrapS, wrapT: t.wrapT, name: t.name, mipmapped: t.mipmapped } : null);
  if (!meshes.length) return { meshes, textures, bounds: { min: [0, 0, 0], max: [0, 0, 0] } };
  return { meshes, textures, bounds: { min, max } };
}

module.exports = { bake, compose, multiply };
