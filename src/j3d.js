'use strict';

// Reads the game's J3D models (.bmd) and joint animations (.bck) into plain
// arrays the customizer can draw: joints, skinning matrices, triangles per
// material, material colours and decoded RGBA textures.

const ANGLE = Math.PI / 0x8000;

function sections(data) {
  const out = {};
  for (let at = 0x20, i = data.readUInt32BE(0x0c); i > 0 && at + 8 <= data.length; i--) {
    out[data.toString('ascii', at, at + 4)] = at;
    at += data.readUInt32BE(at + 4);
  }
  return out;
}

function nameTable(data, at) {
  const names = [];
  for (let i = 0, count = data.readUInt16BE(at); i < count; i++) {
    const start = at + data.readUInt16BE(at + 4 + i * 4 + 2);
    names.push(data.toString('latin1', start, data.indexOf(0, start)));
  }
  return names;
}

// --- Vertex arrays -------------------------------------------------------

const POS = 9, NRM = 10, CLR0 = 11, TEX0 = 13, TEX1 = 14;
const VTX_SLOTS = { 9: 0, 10: 1, 11: 3, 12: 4, 13: 5, 14: 6, 15: 7, 16: 8, 17: 9, 18: 10, 19: 11, 20: 12 };

function readVtx(data, at, size) {
  const formats = new Map();
  for (let f = at + data.readUInt32BE(at + 8); data.readUInt32BE(f) !== 0xff; f += 16)
    formats.set(data.readUInt32BE(f), { count: data.readUInt32BE(f + 4), type: data.readUInt32BE(f + 8), frac: data[f + 12] });
  const offsets = Array.from({ length: 13 }, (_, i) => data.readUInt32BE(at + 0x0c + i * 4));
  const arrays = {};
  for (const [attr, format] of formats) {
    const slot = VTX_SLOTS[attr], start = offsets[slot];
    if (!start) continue;
    const next = offsets.slice(slot + 1).find(o => o) || size;
    const bytes = data.subarray(at + start, at + next);
    arrays[attr] = attr === CLR0 || attr === CLR0 + 1 ? readColors(bytes, format) : readComponents(bytes, attr, format);
  }
  return arrays;
}

function readComponents(bytes, attr, { count, type, frac }) {
  const width = attr === POS ? (count ? 3 : 2) : attr === NRM ? 3 : (count ? 2 : 1);
  const size = [1, 1, 2, 2, 4][type], scale = type === 4 ? 1 : 1 / (1 << frac);
  const total = Math.floor(bytes.length / (size * width)) * width, out = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const o = i * size;
    out[i] = (type === 0 ? bytes[o] : type === 1 ? bytes.readInt8(o) : type === 2 ? bytes.readUInt16BE(o)
      : type === 3 ? bytes.readInt16BE(o) : bytes.readFloatBE(o)) * scale;
  }
  return { width, values: out };
}

function readColors(bytes, { type }) {
  const size = [2, 3, 4, 2, 3, 4][type], count = Math.floor(bytes.length / size), out = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const o = i * size;
    let rgba;
    if (type === 0) { const v = bytes.readUInt16BE(o); rgba = [(v >> 11) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31, 255]; }
    else if (type === 1) rgba = [bytes[o], bytes[o + 1], bytes[o + 2], 255];
    else if (type === 2 || type === 5) rgba = [bytes[o], bytes[o + 1], bytes[o + 2], type === 5 ? bytes[o + 3] : 255];
    else if (type === 3) { const v = bytes.readUInt16BE(o); rgba = [(v >> 12) * 17, ((v >> 8) & 15) * 17, ((v >> 4) & 15) * 17, (v & 15) * 17]; }
    else { const v = (bytes[o] << 16) | (bytes[o + 1] << 8) | bytes[o + 2]; rgba = [(v >> 18) * 255 / 63, ((v >> 12) & 63) * 255 / 63, ((v >> 6) & 63) * 255 / 63, (v & 63) * 255 / 63]; }
    for (let c = 0; c < 4; c++) out[i * 4 + c] = rgba[c] / 255;
  }
  return { width: 4, values: out };
}

// --- Joints, envelopes, draw matrices -------------------------------------

function readJoints(data, at) {
  const count = data.readUInt16BE(at + 8), entries = at + data.readUInt32BE(at + 0x0c);
  const remap = at + data.readUInt32BE(at + 0x10), names = nameTable(data, at + data.readUInt32BE(at + 0x14));
  return Array.from({ length: count }, (_, i) => {
    const e = entries + data.readUInt16BE(remap + i * 2) * 0x40;
    return {
      name: names[i], parent: -1,
      scale: [0, 1, 2].map(k => data.readFloatBE(e + 4 + k * 4)),
      rotation: [0, 1, 2].map(k => data.readInt16BE(e + 0x10 + k * 2) * ANGLE),
      translation: [0, 1, 2].map(k => data.readFloatBE(e + 0x18 + k * 4)),
    };
  });
}

function readEnvelopes(data, at) {
  if (at === undefined) return { envelopes: [], inverseBind: [] };
  const count = data.readUInt16BE(at + 8);
  const counts = at + data.readUInt32BE(at + 0x0c), indices = at + data.readUInt32BE(at + 0x10);
  const weights = at + data.readUInt32BE(at + 0x14), bind = data.readUInt32BE(at + 0x18);
  const envelopes = [];
  let maxJoint = -1;
  for (let i = 0, k = 0; i < count; i++) {
    const env = [];
    for (let n = data[counts + i]; n > 0; n--, k++) {
      const joint = data.readUInt16BE(indices + k * 2);
      maxJoint = Math.max(maxJoint, joint);
      env.push({ joint, weight: data.readFloatBE(weights + k * 4) });
    }
    envelopes.push(env);
  }
  const inverseBind = [];
  for (let j = 0; bind && j <= maxJoint; j++) {
    const m = at + bind + j * 48, r = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(x => data.readFloatBE(m + x * 4));
    inverseBind.push(mat3x4(r));
  }
  return { envelopes, inverseBind };
}

function readDraw(data, at) {
  const count = data.readUInt16BE(at + 8), weighted = at + data.readUInt32BE(at + 0x0c), index = at + data.readUInt32BE(at + 0x10);
  return Array.from({ length: count }, (_, i) => ({ weighted: data[weighted + i] === 1, index: data.readUInt16BE(index + i * 2) }));
}

// Parent links and the shape -> material pairing come from INF1's scene graph.
function readHierarchy(data, at, joints) {
  const shapeMaterial = new Map();
  const stack = [];
  let lastJoint = -1, lastMaterial = -1;
  for (let p = at + data.readUInt32BE(at + 0x14); ; p += 4) {
    const type = data.readUInt16BE(p), index = data.readUInt16BE(p + 2);
    if (type === 0) break;
    if (type === 1) stack.push({ joint: lastJoint, material: lastMaterial });
    else if (type === 2) ({ joint: lastJoint, material: lastMaterial } = stack.pop());
    else if (type === 0x10) {
      joints[index].parent = stack.length ? lastJointAbove(stack) : -1;
      lastJoint = index;
    } else if (type === 0x11) lastMaterial = index;
    else if (type === 0x12) shapeMaterial.set(index, { material: lastMaterial, joint: lastJoint });
  }
  return shapeMaterial;
}
function lastJointAbove(stack) {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].joint >= 0) return stack[i].joint;
  return -1;
}

// --- Shapes ---------------------------------------------------------------

function readShapes(data, at, vtx) {
  const count = data.readUInt16BE(at + 8), off = k => at + data.readUInt32BE(at + 0x0c + k * 4);
  const entries = off(0), remap = off(1), descs = off(3), matrixTable = off(4), dlData = off(5), matrixData = off(6), packets = off(7);
  return Array.from({ length: count }, (_, s) => {
    const e = entries + data.readUInt16BE(remap + s * 2) * 0x28;
    const packetCount = data.readUInt16BE(e + 2), attrAt = descs + data.readUInt16BE(e + 4);
    const firstMatrix = data.readUInt16BE(e + 6), firstPacket = data.readUInt16BE(e + 8);
    const attrs = [];
    for (let a = attrAt; data.readUInt32BE(a) !== 0xff; a += 8) attrs.push({ attr: data.readUInt32BE(a), type: data.readUInt32BE(a + 4) });
    const vertices = [];  // { pos, nrm, clr, uv, drw }
    const triangles = [];
    const current = [];   // draw-matrix slot -> DRW1 index, carried across packets
    for (let p = 0; p < packetCount; p++) {
      const md = matrixData + (firstMatrix + p) * 8, mCount = data.readUInt16BE(md + 2), mFirst = data.readUInt32BE(md + 4);
      for (let i = 0; i < mCount; i++) {
        const v = data.readUInt16BE(matrixTable + (mFirst + i) * 2);
        if (v !== 0xffff) current[i] = v;
      }
      const loc = packets + (firstPacket + p) * 8, size = data.readUInt32BE(loc), start = dlData + data.readUInt32BE(loc + 4);
      for (let q = start; q < start + size;) {
        const op = data[q++];
        if (op !== 0x90 && op !== 0x98 && op !== 0xa0) { if (op === 0) continue; break; }
        const n = data.readUInt16BE(q); q += 2;
        const strip = [];
        for (let v = 0; v < n; v++) {
          const vert = { pnmtx: 0 };
          for (const { attr, type } of attrs) {
            const value = type === 1 ? data[q] : type === 2 ? data[q] : data.readUInt16BE(q);
            q += type === 3 ? 2 : 1;
            if (attr === 0) vert.pnmtx = value / 3;
            else if (attr === POS) vert.pos = value;
            else if (attr === NRM) vert.nrm = value;
            else if (attr === CLR0) vert.clr = value;
            else if (attr === TEX0) vert.uv = value;
            else if (attr === TEX1) vert.uv1 = value;
          }
          vert.drw = current[vert.pnmtx] ?? current[0];
          strip.push(vertices.push(vert) - 1);
        }
        // GX faces clockwise triangles forward; these come out counter-clockwise, as WebGL expects.
        if (op === 0x90) for (let i = 0; i + 2 < n; i += 3) triangles.push(strip[i], strip[i + 2], strip[i + 1]);
        else if (op === 0x98) for (let i = 2; i < n; i++) triangles.push(...(i & 1 ? [strip[i - 1], strip[i], strip[i - 2]] : [strip[i - 2], strip[i], strip[i - 1]]));
        else for (let i = 2; i < n; i++) triangles.push(strip[0], strip[i], strip[i - 1]);
      }
    }
    return flattenShape(vertices, triangles, vtx);
  });
}

function flattenShape(vertices, triangles, vtx) {
  const n = vertices.length;
  const position = new Float32Array(n * 3), normal = new Float32Array(n * 3), uv = new Float32Array(n * 2), uv1 = new Float32Array(n * 2);
  const color = new Float32Array(n * 4).fill(1), drawIndex = new Uint16Array(n);
  const pick = (array, index, width, out, o) => {
    for (let c = 0; c < width; c++) out[o + c] = array.values[index * array.width + c] ?? 0;
  };
  vertices.forEach((v, i) => {
    if (vtx[POS] && v.pos !== undefined) pick(vtx[POS], v.pos, 3, position, i * 3);
    if (vtx[NRM] && v.nrm !== undefined) pick(vtx[NRM], v.nrm, 3, normal, i * 3);
    if (vtx[CLR0] && v.clr !== undefined) pick(vtx[CLR0], v.clr, 4, color, i * 4);
    if (vtx[TEX0] && v.uv !== undefined) pick(vtx[TEX0], v.uv, 2, uv, i * 2);
    if (vtx[TEX1] && v.uv1 !== undefined) pick(vtx[TEX1], v.uv1, 2, uv1, i * 2);
    drawIndex[i] = v.drw ?? 0;
  });
  return {
    position, normal, uv, color, drawIndex, index: Uint32Array.from(triangles),
    hasColor: vertices.some(v => v.clr !== undefined), hasNormal: vertices.some(v => v.nrm !== undefined),
    hasUv: vertices.some(v => v.uv !== undefined), hasUv1: vertices.some(v => v.uv1 !== undefined), uv1,
  };
}

// --- Materials --------------------------------------------------------------

function readMaterials(data, at) {
  const count = data.readUInt16BE(at + 8), off = k => data.readUInt32BE(at + 0x0c + k * 4);
  const base = k => at + off(k);
  const names = nameTable(data, base(2));
  const rgba8 = (k, i) => { const o = base(k) + i * 4; return [data[o], data[o + 1], data[o + 2], data[o + 3]]; };
  const s16x4 = (k, i) => { const o = base(k) + i * 8; return [0, 1, 2, 3].map(c => data.readInt16BE(o + c * 2)); };
  const texRemap = i => data.readUInt16BE(base(15) + i * 2);
  return Array.from({ length: count }, (_, m) => {
    const e = base(0) + data.readUInt16BE(base(1) + m * 2) * 0x14c;
    const u16 = (o, n) => Array.from({ length: n }, (_, i) => data.readUInt16BE(e + o + i * 2));
    const chan = u16(0x0c, 4).map(i => i === 0xffff ? null : (() => {
      const o = base(7) + i * 8;
      return { lighting: data[o] === 1, matSource: data[o + 1], litMask: data[o + 2], ambSource: data[o + 5] };
    })());
    const stageCount = data[base(19) + data[e + 4]];
    const stages = u16(0xe4, 16).slice(0, stageCount).map((i, s) => {
      const o = base(20) + i * 0x14, order = u16(0xbc, 16)[s], oo = base(16) + order * 4;
      return {
        colorIn: [...data.subarray(o + 1, o + 5)], colorOp: data[o + 5], colorBias: data[o + 6], colorScale: data[o + 7], colorClamp: data[o + 8] === 1, colorReg: data[o + 9],
        alphaIn: [...data.subarray(o + 10, o + 14)], alphaOp: data[o + 14], alphaBias: data[o + 15], alphaScale: data[o + 16], alphaClamp: data[o + 17] === 1, alphaReg: data[o + 18],
        texCoord: data[oo], texMap: data[oo + 1], channel: data[oo + 2],
        kColorSel: data[e + 0x9c + s], kAlphaSel: data[e + 0xac + s],
      };
    });
    // Texture coordinate generators and their texture matrices (scale, rotate,
    // translate about a centre), which pick a part of a texture or scroll it.
    const texGens = u16(0x28, 8).map(i => {
      if (i === 0xffff || !off(11)) return null;
      const o = base(11) + i * 4;
      return { type: data[o], source: data[o + 1], matrix: data[o + 2] };
    });
    const texMatrices = u16(0x48, 10).map(i => {
      if (i === 0xffff || !off(13)) return null;
      const o = base(13) + i * 0x64;
      return {
        projection: data[o], info: data[o + 1], center: [0, 1, 2].map(k => data.readFloatBE(o + 4 + k * 4)),
        scale: [data.readFloatBE(o + 0x10), data.readFloatBE(o + 0x14)], rotation: data.readInt16BE(o + 0x18) * ANGLE,
        translation: [data.readFloatBE(o + 0x1c), data.readFloatBE(o + 0x20)],
      };
    });
    const blendAt = data.readUInt16BE(e + 0x148), blend = base(25) + blendAt * 4;
    const alphaAt = base(24) + data.readUInt16BE(e + 0x146) * 8;
    return {
      name: names[m], mode: data[e],
      cull: data.readUInt32BE(base(4) + data[e + 1] * 4),
      matColor: u16(0x08, 2).map(i => i === 0xffff ? null : rgba8(5, i)),
      ambColor: u16(0x14, 2).map(i => i === 0xffff ? null : rgba8(8, i)),
      channels: chan,
      textures: u16(0x84, 8).map(i => i === 0xffff ? -1 : texRemap(i)),
      kColors: u16(0x94, 4).map(i => i === 0xffff ? null : rgba8(18, i)),
      tevColors: u16(0xdc, 4).map(i => i === 0xffff ? null : s16x4(17, i)),
      stages, texGens, texMatrices,
      blend: { type: data[blend], src: data[blend + 1], dst: data[blend + 2] },
      alphaTest: { comp0: data[alphaAt], ref0: data[alphaAt + 1], op: data[alphaAt + 2], comp1: data[alphaAt + 3], ref1: data[alphaAt + 4] },
    };
  });
}

// --- Textures ---------------------------------------------------------------

const BLOCK = { 0: [8, 8, 4], 1: [8, 4, 8], 2: [8, 4, 8], 3: [4, 4, 16], 4: [4, 4, 16], 5: [4, 4, 16], 6: [4, 4, 32], 8: [8, 8, 4], 9: [8, 4, 8], 10: [4, 4, 16], 14: [8, 8, 4] };

function readTextures(data, at) {
  if (at === undefined) return [];
  const count = data.readUInt16BE(at + 8), headers = at + data.readUInt32BE(at + 0x0c);
  const names = nameTable(data, at + data.readUInt32BE(at + 0x10));
  return Array.from({ length: count }, (_, i) => {
    const h = headers + i * 0x20;
    return { name: names[i], ...decodeBti(data, h) };
  });
}

// A BTI header at `h` with offsets relative to it -> { width, height, rgba, wrapS, wrapT }.
// `level` is the first level's bytes as stored, which the game hashes to name
// pack replacements; `mipmapped` is whether it has more levels.
function decodeBti(data, h) {
  const format = data[h], width = data.readUInt16BE(h + 2), height = data.readUInt16BE(h + 4);
  const palette = { format: data[h + 9], count: data.readUInt16BE(h + 10), at: h + data.readUInt32BE(h + 12) };
  const start = h + data.readUInt32BE(h + 0x1c);
  const rgba = decodeTexture(data.subarray(start), format, width, height, data, palette);
  const [bw, bh, bits] = BLOCK[format] || BLOCK[6];
  const bytes = Math.ceil(width / bw) * bw * Math.ceil(height / bh) * bh * bits / 8;
  return { width, height, rgba, format, wrapS: data[h + 6], wrapT: data[h + 7],
    level: data.subarray(start, start + bytes), mipmapped: data[h + 0x18] > 1 };
}

function decodeTexture(src, format, width, height, file, palette) {
  const out = new Uint8Array(width * height * 4);
  const [bw, bh, bits] = BLOCK[format] || BLOCK[6];
  const put = (x, y, r, g, b, a) => {
    if (x >= width || y >= height) return;
    const o = (y * width + x) * 4; out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
  };
  const lut = format >= 8 && format <= 10 ? paletteColors(file, palette) : null;
  let s = 0;
  for (let by = 0; by < height; by += bh) for (let bx = 0; bx < width; bx += bw) {
    if (format === 14) { s = decodeCmprBlock(src, s, bx, by, put); continue; }
    if (format === 6) {
      for (let p = 0; p < 16; p++) {
        const x = bx + (p & 3), y = by + (p >> 2);
        put(x, y, src[s + p * 2 + 1], src[s + 32 + p * 2], src[s + 32 + p * 2 + 1], src[s + p * 2]);
      }
      s += 64; continue;
    }
    for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) {
      let v;
      if (bits === 4) { v = (src[s >> 1] >> (s & 1 ? 0 : 4)) & 15; s++; } // s counts nibbles here
      else if (bits === 8) v = src[s++];
      else { v = (src[s] << 8) | src[s + 1]; s += 2; }
      if (lut) { const c = lut[format === 10 ? v & 0x3fff : v] || [0, 0, 0, 0]; put(x, y, ...c); continue; }
      if (format === 0) put(x, y, v * 17, v * 17, v * 17, v * 17);
      else if (format === 1) put(x, y, v, v, v, v);
      else if (format === 2) put(x, y, (v & 15) * 17, (v & 15) * 17, (v & 15) * 17, (v >> 4) * 17);
      else if (format === 3) put(x, y, v & 255, v & 255, v & 255, v >> 8);
      else if (format === 4) put(x, y, ...rgb565(v), 255);
      else if (format === 5) put(x, y, ...rgb5a3(v));
    }
  }
  return out;
}

function paletteColors(file, { format, count, at }) {
  return Array.from({ length: count }, (_, i) => {
    const v = file.readUInt16BE(at + i * 2);
    return format === 0 ? [v & 255, v & 255, v & 255, v >> 8] : format === 1 ? [...rgb565(v), 255] : rgb5a3(v);
  });
}
const rgb565 = v => [(v >> 11) * 255 / 31 | 0, ((v >> 5) & 63) * 255 / 63 | 0, (v & 31) * 255 / 31 | 0];
const rgb5a3 = v => v & 0x8000
  ? [((v >> 10) & 31) * 255 / 31 | 0, ((v >> 5) & 31) * 255 / 31 | 0, (v & 31) * 255 / 31 | 0, 255]
  : [((v >> 8) & 15) * 17, ((v >> 4) & 15) * 17, (v & 15) * 17, ((v >> 12) & 7) * 255 / 7 | 0];

function decodeCmprBlock(src, s, bx, by, put) {
  for (let sub = 0; sub < 4; sub++, s += 8) {
    const c0 = src.readUInt16BE(s), c1 = src.readUInt16BE(s + 2);
    const a = rgb565(c0), b = rgb565(c1);
    const palette = c0 > c1
      ? [[...a, 255], [...b, 255], [...a.map((v, i) => (2 * v + b[i]) / 3 | 0), 255], [...a.map((v, i) => (v + 2 * b[i]) / 3 | 0), 255]]
      : [[...a, 255], [...b, 255], [...a.map((v, i) => (v + b[i]) >> 1), 255], [0, 0, 0, 0]];
    const ox = bx + (sub & 1) * 4, oy = by + (sub >> 1) * 4;
    for (let y = 0; y < 4; y++) {
      const row = src[s + 4 + y];
      for (let x = 0; x < 4; x++) put(ox + x, oy + y, ...palette[(row >> (6 - x * 2)) & 3]);
    }
  }
  return s;
}

// --- Model ------------------------------------------------------------------

function parseBmd(data) {
  const magic = data.toString('ascii', 0, 8);
  if (magic !== 'J3D2bmd3' && magic !== 'J3D2bdl4') throw new Error('This is not a game model.');
  const at = sections(data);
  const vtx = readVtx(data, at.VTX1, data.readUInt32BE(at.VTX1 + 4));
  const joints = readJoints(data, at.JNT1);
  const shapeMaterial = readHierarchy(data, at.INF1, joints);
  const { envelopes, inverseBind } = readEnvelopes(data, at.EVP1);
  const draw = readDraw(data, at.DRW1);
  const shapes = readShapes(data, at.SHP1, vtx).map((shape, i) => ({ ...shape, ...shapeMaterial.get(i) }));
  return { joints, envelopes, inverseBind, draw, shapes, materials: readMaterials(data, at.MAT3), textures: readTextures(data, at.TEX1) };
}

// A material table (.bmt): materials and their textures, which the game puts
// over a model's own (Nokis' parts take theirs from mareCommon/mare.bmt).
function parseBmt(data) {
  if (data.toString('ascii', 0, 8) !== 'J3D2bmt3') throw new Error('This is not a game material table.');
  // Some tables hold only textures.
  const at = sections(data);
  return { materials: at.MAT3 === undefined ? [] : readMaterials(data, at.MAT3), textures: readTextures(data, at.TEX1) };
}

// --- Joint animation ----------------------------------------------------------

function parseBck(data) {
  if (data.toString('ascii', 0, 8) !== 'J3D1bck1') throw new Error('This is not a game animation.');
  const a = sections(data).ANK1;
  const loop = data[a + 8], frames = data.readUInt16BE(a + 0x0a), count = data.readUInt16BE(a + 0x0c);
  const rotScale = Math.pow(2, data[a + 9]) * ANGLE;
  const jointsAt = a + data.readUInt32BE(a + 0x14);
  const scaleAt = a + data.readUInt32BE(a + 0x18), rotAt = a + data.readUInt32BE(a + 0x1c), transAt = a + data.readUInt32BE(a + 0x20);
  const f32 = base => i => data.readFloatBE(base + i * 4);
  const s16 = i => data.readInt16BE(rotAt + i * 2);
  // A track: one constant value, or keys of (frame, value, tangent in, tangent out).
  const track = (o, read, scale = 1) => {
    const n = data.readUInt16BE(o), index = data.readUInt16BE(o + 2), stride = data.readUInt16BE(o + 4) ? 4 : 3;
    if (n <= 1) return [{ time: 0, value: read(index) * scale, in: 0, out: 0 }];
    return Array.from({ length: n }, (_, k) => {
      const b = index + k * stride;
      return { time: read(b), value: read(b + 1) * scale, in: read(b + 2) * scale, out: read(b + stride - 1) * scale };
    });
  };
  const joints = Array.from({ length: count }, (_, j) => {
    const o = jointsAt + j * 54;
    return {
      scale: [0, 1, 2].map(k => track(o + k * 18, f32(scaleAt))),
      rotation: [0, 1, 2].map(k => track(o + k * 18 + 6, s16, rotScale)),
      translation: [0, 1, 2].map(k => track(o + k * 18 + 12, f32(transAt))),
    };
  });
  return { loop, frames, joints };
}

// Hermite between keys, as the game's J3D animation player does.
function sampleTrack(keys, frame) {
  if (keys.length === 1 || frame <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (frame >= last.time) return last.value;
  let i = 0;
  while (keys[i + 1].time < frame) i++;
  const k0 = keys[i], k1 = keys[i + 1], span = k1.time - k0.time;
  const t = (frame - k0.time) / span, t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * k0.value + (t3 - 2 * t2 + t) * k0.out * span
    + (-2 * t3 + 3 * t2) * k1.value + (t3 - t2) * k1.in * span;
}

function mat3x4(r) {
  // row-major 3x4 -> column-major 4x4 (three.js / WebGL order)
  return [r[0], r[4], r[8], 0, r[1], r[5], r[9], 0, r[2], r[6], r[10], 0, r[3], r[7], r[11], 1];
}

module.exports = { parseBmd, parseBmt, parseBck, sampleTrack, decodeTexture, decodeBti };
