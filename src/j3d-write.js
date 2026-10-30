'use strict';
// Writing the game's files for a character made in the launcher: J3D model
// sections (geometry, skinning, joints, textures) put in place of a template
// model's, a joint animation's translation keys, and a RARC archive with some
// of its files replaced. Section layouts as the game reads them (j3d.js reads
// them back).

const GX_TRIANGLES = 0x90;
const pad32 = buffer => (buffer.length % 32 ? Buffer.concat([buffer, Buffer.alloc(32 - buffer.length % 32)]) : buffer);

function section(tag, body) {
  body = pad32(body);
  const head = Buffer.alloc(8);
  head.write(tag, 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

const floats = values => {
  const out = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) out.writeFloatBE(values[i], i * 4);
  return out;
};

// Sections of a J3D file: tag -> [offset, size], in file order.
function sections(data) {
  const out = new Map();
  for (let at = 0x20, i = data.readUInt32BE(0x0c); i > 0 && at + 8 <= data.length; i--) {
    const size = data.readUInt32BE(at + 4);
    out.set(data.toString('ascii', at, at + 4), [at, size]);
    at += size;
  }
  return out;
}
const sectionOf = (data, tag) => { const [at, size] = sections(data).get(tag); return Buffer.from(data.subarray(at, at + size)); };

// Positions and normals (n x 3) and one set of texture coordinates (n x 2), shared by TEX0..2.
function vtx1(position, normal, uv) {
  const formats = [[9, 1, 4, 0], [10, 0, 4, 0], [13, 1, 4, 0], [14, 1, 4, 0], [15, 1, 4, 0], [0xff, 1, 0, 0]];
  const list = Buffer.alloc(formats.length * 16);
  formats.forEach(([a, b, c, d], i) => { list.writeUInt32BE(a, i * 16); list.writeUInt32BE(b, i * 16 + 4); list.writeUInt32BE(c, i * 16 + 8); list[i * 16 + 12] = d; });
  let body = pad32(Buffer.concat([Buffer.alloc(0x38), list]));
  const offsets = new Array(13).fill(0);
  const add = (slot, values) => { offsets[slot] = body.length + 8; body = Buffer.concat([body, pad32(floats(values))]); };
  add(0, position);
  add(1, normal);
  for (let k = 0; k < 3; k++) add(5 + k, uv);
  body.writeUInt32BE(0x40, 0);
  offsets.forEach((o, i) => body.writeUInt32BE(o, 4 + i * 4));
  return section('VTX1', body);
}

// envelopes: [[[joint, weight], ...], ...]; inverseBind: a row-major 4x4 per joint.
function evp1(envelopes, inverseBind) {
  if (!envelopes.length) {
    const body = Buffer.alloc(20);
    body.writeUInt16BE(0xffff, 2);
    return section('EVP1', body);
  }
  const counts = Buffer.from(envelopes.map(e => e.length));
  const joints = envelopes.flat();
  const indices = Buffer.alloc(joints.length * 2), weights = Buffer.alloc(joints.length * 4);
  joints.forEach(([j, w], i) => { indices.writeUInt16BE(j, i * 2); weights.writeFloatBE(w, i * 4); });
  const matrices = floats(inverseBind.flatMap(m => m.slice(0, 12)));
  let o = 0x1c;
  const oc = o; o += counts.length; o = (o + 1) & ~1;
  const oi = o; o += indices.length; o = (o + 3) & ~3;
  const ow = o; o += weights.length; o = (o + 31) & ~31;
  const om = o;
  const body = Buffer.alloc(om - 8 + matrices.length);
  body.writeUInt16BE(envelopes.length, 0); body.writeUInt16BE(0xffff, 2);
  [oc, oi, ow, om].forEach((v, i) => body.writeUInt32BE(v, 4 + i * 4));
  counts.copy(body, oc - 8); indices.copy(body, oi - 8); weights.copy(body, ow - 8); matrices.copy(body, om - 8);
  return section('EVP1', body);
}

// entries: [weighted, index]: a joint's matrix, or envelope `index`.
function drw1(entries) {
  const n = entries.length, oFlags = 0x14, oData = (oFlags + n + 1) & ~1;
  const body = Buffer.alloc(oData - 8 + 2 * n);
  body.writeUInt16BE(n, 0); body.writeUInt16BE(0xffff, 2); body.writeUInt32BE(oFlags, 4); body.writeUInt32BE(oData, 8);
  entries.forEach(([weighted, index], k) => { body[oFlags - 8 + k] = weighted ? 1 : 0; body.writeUInt16BE(index, oData - 8 + 2 * k); });
  return section('DRW1', body);
}

// shapes: [{ mtype (0 one matrix, 3 several), packets: [{ mtx: [drw...], tris: [[[slot, pos, nrm, uv] x3]...] }], bbox: [min, max], radius }].
function shp1(shapes) {
  const multiDesc = [[0, 1], [9, 3], [10, 3], [13, 3], [14, 3], [15, 3], [0xff, 0]];
  const descBuffer = list => { const b = Buffer.alloc(list.length * 8); list.forEach(([a, t], i) => { b.writeUInt32BE(a, i * 8); b.writeUInt32BE(t, i * 8 + 4); }); return b; };
  const single = descBuffer(multiDesc.slice(1)), multiOffset = single.length;
  const attrs = Buffer.concat([single, descBuffer(multiDesc)]);
  const records = [], matrixTable = [], matrixData = [], lists = [], locations = [];
  let packetsTotal = 0, listBytes = 0;
  for (const shape of shapes) {
    const multi = shape.mtype === 3, firstMatrix = matrixData.length, firstPacket = packetsTotal;
    for (const packet of shape.packets) {
      matrixData.push([packet.mtx[0], packet.mtx.length, matrixTable.length]);
      matrixTable.push(...packet.mtx);
      const vertexSize = (multi ? 1 : 0) + 10;
      let dl = Buffer.alloc(3 + packet.tris.length * 3 * vertexSize);
      dl[0] = GX_TRIANGLES; dl.writeUInt16BE(3 * packet.tris.length, 1);
      let q = 3;
      for (const tri of packet.tris) for (const [slot, p, n, t] of tri) {
        if (multi) dl[q++] = slot * 3;
        for (const v of [p, n, t, t, t]) { dl.writeUInt16BE(v, q); q += 2; }
      }
      dl = pad32(dl);
      locations.push([dl.length, listBytes]);
      lists.push(dl);
      listBytes += dl.length;
      packetsTotal++;
    }
    const record = Buffer.alloc(0x28);
    record[0] = shape.mtype; record[1] = 0xff; record.writeUInt16BE(shape.packets.length, 2);
    record.writeUInt16BE(multi ? multiOffset : 0, 4); record.writeUInt16BE(firstMatrix, 6); record.writeUInt16BE(firstPacket, 8);
    record.writeUInt16BE(0xffff, 10);
    [shape.radius, ...shape.bbox[0], ...shape.bbox[1]].forEach((v, i) => record.writeFloatBE(v, 12 + i * 4));
    records.push(record);
  }
  const n = shapes.length;
  const remap = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) remap.writeUInt16BE(i, i * 2);
  const table = Buffer.alloc(matrixTable.length * 2); matrixTable.forEach((m, i) => table.writeUInt16BE(m, i * 2));
  const mdata = Buffer.alloc(matrixData.length * 8);
  matrixData.forEach(([a, b, c], i) => { mdata.writeUInt16BE(a, i * 8); mdata.writeUInt16BE(b, i * 8 + 2); mdata.writeUInt32BE(c, i * 8 + 4); });
  const locs = Buffer.alloc(locations.length * 8);
  locations.forEach(([size, at], i) => { locs.writeUInt32BE(size, i * 8); locs.writeUInt32BE(at, i * 8 + 4); });
  const parts = [];
  let o = 0x2c;
  const place = (buffer, align = 4) => { o = (o + align - 1) & ~(align - 1); parts.push([o, buffer]); const at = o; o += buffer.length; return at; };
  const oShape = place(Buffer.concat(records)), oRemap = place(remap), oAttr = place(attrs), oTable = place(table);
  const oDl = place(Buffer.concat(lists), 32), oData = place(mdata), oPackets = place(locs);
  const body = Buffer.alloc(o - 8);
  body.writeUInt16BE(n, 0); body.writeUInt16BE(0xffff, 2);
  [oShape, oRemap, 0, oAttr, oTable, oDl, oData, oPackets].forEach((v, i) => body.writeUInt32BE(v, 4 + i * 4));
  for (const [at, buffer] of parts) buffer.copy(body, at - 8);
  return { section: section('SHP1', body), packets: packetsTotal };
}

function jnt1Patch(template, translations) {
  const b = Buffer.from(template), data = b.readUInt32BE(0xc);
  translations.forEach((t, i) => { if (t) t.forEach((v, k) => b.writeFloatBE(v, data + i * 0x40 + 0x18 + k * 4)); });
  return b;
}

function inf1Patch(template, packets, vertices) {
  const b = Buffer.from(template);
  b.writeUInt32BE(packets, 0xc); b.writeUInt32BE(vertices, 0x10);
  return b;
}

// --- Textures -------------------------------------------------------------------

function rgba8({ width: w, height: h, rgba }) {
  const out = Buffer.alloc(w * h * 4);
  let o = 0;
  for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4) {
    for (let k = 0; k < 16; k++) { const i = ((by + (k >> 2)) * w + bx + (k & 3)) * 4; out[o++] = rgba[i + 3]; out[o++] = rgba[i]; }
    for (let k = 0; k < 16; k++) { const i = ((by + (k >> 2)) * w + bx + (k & 3)) * 4; out[o++] = rgba[i + 1]; out[o++] = rgba[i + 2]; }
  }
  return out;
}

const to565 = c => ((Math.max(0, Math.min(255, Math.round(c[0]))) >> 3) << 11) | ((Math.max(0, Math.min(255, Math.round(c[1]))) >> 2) << 5) | (Math.max(0, Math.min(255, Math.round(c[2]))) >> 3);
const from565 = v => { const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31; return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)]; };

// One 4x4 DXT1 block: endpoints on the block's main colour axis; cut-out texels use the
// three-colour mode with index 3 see-through.
function cmprBlock(texels, out, at) {
  const opaque = texels.filter(t => t[3] >= 128), cut = opaque.length < 16;
  const mean = [0, 1, 2].map(c => texels.reduce((s, t) => s + t[c], 0) / 16);
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const t of texels) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) cov[a * 3 + b] += (t[a] - mean[a]) * (t[b] - mean[b]);
  let axis = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
  for (let i = 0; i < 8; i++) {
    const n = [0, 1, 2].map(r => cov[r * 3] * axis[0] + cov[r * 3 + 1] * axis[1] + cov[r * 3 + 2] * axis[2]);
    const l = Math.hypot(...n) + 1e-9; axis = n.map(v => v / l);
  }
  let lo = Infinity, hi = -Infinity;
  for (const t of opaque) { const p = (t[0] - mean[0]) * axis[0] + (t[1] - mean[1]) * axis[1] + (t[2] - mean[2]) * axis[2]; lo = Math.min(lo, p); hi = Math.max(hi, p); }
  if (!opaque.length) lo = hi = 0;
  let c0 = to565(mean.map((m, k) => m + hi * axis[k])), c1 = to565(mean.map((m, k) => m + lo * axis[k]));
  if (cut ? c0 > c1 : c0 < c1) [c0, c1] = [c1, c0];
  if (c0 === c1 && !cut) { if (c0 > 0) c1 = c0 - 1; else c0 = 1; }
  const p0 = from565(c0), p1 = from565(c1);
  const palette = cut ? [p0, p1, p0.map((v, k) => (v + p1[k]) / 2), null]
    : [p0, p1, p0.map((v, k) => (2 * v + p1[k]) / 3), p0.map((v, k) => (v + 2 * p1[k]) / 3)];
  out.writeUInt16BE(c0, at); out.writeUInt16BE(c1, at + 2);
  for (let row = 0; row < 4; row++) {
    let bits = 0;
    for (let col = 0; col < 4; col++) {
      const t = texels[row * 4 + col];
      let best = 3;
      if (!(cut && t[3] < 128)) {
        let d = Infinity;
        palette.forEach((p, k) => { if (!p) return; const e = (t[0] - p[0]) ** 2 + (t[1] - p[1]) ** 2 + (t[2] - p[2]) ** 2; if (e < d) { d = e; best = k; } });
      }
      bits |= best << (6 - col * 2);
    }
    out[at + 4 + row] = bits;
  }
}

// GX CMPR: DXT1 blocks in 8x8 tiles of 2x2 blocks. Width and height multiples of 8.
function cmpr({ width: w, height: h, rgba }) {
  const out = Buffer.alloc(w * h / 2);
  let o = 0;
  for (let ty = 0; ty < h; ty += 8) for (let tx = 0; tx < w; tx += 8) for (let sy = 0; sy < 8; sy += 4) for (let sx = 0; sx < 8; sx += 4) {
    const texels = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const i = ((ty + sy + y) * w + tx + sx + x) * 4;
      texels.push([rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]);
    }
    cmprBlock(texels, out, o);
    o += 8;
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

function textureSize(format, w, h, mips) {
  const bpp = { 0: 4, 1: 8, 2: 8, 3: 16, 4: 16, 5: 16, 6: 32, 8: 4, 9: 8, 10: 16, 14: 4 }[format];
  const [bw, bh] = { 4: [8, 8], 8: [8, 4], 16: [4, 4], 32: [4, 4] }[bpp];
  let total = 0;
  for (let m = 0; m < Math.max(mips, 1); m++) {
    total += Math.ceil(w / bw) * bw * Math.ceil(h / bh) * bh * bpp / 8;
    w = Math.max(w >> 1, 1); h = Math.max(h >> 1, 1);
  }
  return total;
}

// TEX1 with some textures replaced by name: { name: { format: 6 (RGBA8) | 14 (CMPR), width, height, rgba } }.
function tex1(template, replacements) {
  const t = template, n = t.readUInt16BE(8), headersAt = t.readUInt32BE(0xc), namesAt = t.readUInt32BE(0x10);
  const names = nameTable(t, namesAt);
  const headers = [], keys = [], blobs = new Map();
  for (let i = 0; i < n; i++) {
    const h = Buffer.from(t.subarray(headersAt + i * 0x20, headersAt + (i + 1) * 0x20));
    const replacement = replacements[names[i]];
    if (replacement) {
      const key = `new:${names[i]}`;
      if (!blobs.has(key)) blobs.set(key, replacement.format === 14 ? cmpr(replacement) : rgba8(replacement));
      h[0] = replacement.format; h.writeUInt16BE(replacement.width, 2); h.writeUInt16BE(replacement.height, 4);
      h[0x08] = 0; h[0x09] = 0; h.writeUInt16BE(0, 0x0a); h.writeUInt32BE(0, 0x0c);
      h[0x10] = 0; h[0x14] = 1; h[0x15] = 1; h[0x16] = 0; h[0x17] = 0; h[0x18] = 1;
      keys.push(key);
    } else {
      const src = headersAt + i * 0x20 + h.readUInt32BE(0x1c), key = `old:${src}`;
      if (!blobs.has(key)) blobs.set(key, t.subarray(src, src + textureSize(h[0], h.readUInt16BE(2), h.readUInt16BE(4), h[0x18])));
      keys.push(key);
    }
    headers.push(h);
  }
  const oHeaders = 0x20, oData = oHeaders + 0x20 * n, placed = new Map(), data = [];
  let size = 0;
  for (const key of keys) if (!placed.has(key)) { placed.set(key, size); const b = pad32(Buffer.from(blobs.get(key))); data.push(b); size += b.length; }
  const head = Buffer.alloc(0x20);
  head.write('TEX1', 0, 'ascii'); head.writeUInt16BE(n, 8); head.writeUInt16BE(0xffff, 10);
  head.writeUInt32BE(oHeaders, 0xc); head.writeUInt32BE(oData + size, 0x10);
  headers.forEach((h, i) => h.writeUInt32BE(oData + placed.get(keys[i]) - (oHeaders + i * 0x20), 0x1c));
  const out = pad32(Buffer.concat([head, ...headers, ...data, t.subarray(namesAt)]));
  out.writeUInt32BE(out.length, 4);
  return out;
}

// The template model with some of its sections replaced ({ tag: section }), in its own order.
function assemble(template, replaced) {
  const parts = [template.subarray(0, 0x20)];
  for (const [tag, [at, size]] of sections(template)) parts.push(replaced[tag] || template.subarray(at, at + size));
  const out = Buffer.concat(parts);
  out.writeUInt32BE(out.length, 8);
  return out;
}

// --- Joint animations -----------------------------------------------------------------

// A BCK's translation tracks: tracks[joint][axis] = [{ time, value, in, out }] (one key without a
// time for a constant), and a function writing the animation back with new ones.
function bckTranslations(data) {
  const a = 0x20;
  const count = data.readUInt16BE(a + 0x0c), jointsAt = a + data.readUInt32BE(a + 0x14), transAt = a + data.readUInt32BE(a + 0x20);
  const read = i => data.readFloatBE(transAt + i * 4);
  const tracks = Array.from({ length: count }, (_, j) => [0, 1, 2].map(axis => {
    const o = jointsAt + j * 54 + axis * 18 + 12;
    const n = data.readUInt16BE(o), index = data.readUInt16BE(o + 2), stride = data.readUInt16BE(o + 4) === 1 ? 4 : 3;
    if (n <= 1) return [{ value: read(index) }];
    return Array.from({ length: n }, (_, k) => {
      const b = index + k * stride;
      return { time: read(b), value: read(b + 1), in: read(b + 2), out: read(b + stride - 1) };
    });
  }));
  const write = next => {
    // the translation table is the section's last: written again after the rest
    const head = Buffer.from(data.subarray(0, transAt));
    const values = [];
    next.forEach((axes, j) => axes.forEach((keys, axis) => {
      const o = jointsAt + j * 54 + axis * 18 + 12;
      head.writeUInt16BE(keys.length, o); head.writeUInt16BE(values.length, o + 2);
      if (keys.length === 1) { head.writeUInt16BE(0, o + 4); values.push(keys[0].value); }
      else { head.writeUInt16BE(1, o + 4); for (const k of keys) values.push(k.time, k.value, k.in, k.out); }
    }));
    const out = pad32(Buffer.concat([head, floats(values)]));
    out.writeUInt16BE(values.length, a + 0x12);
    out.writeUInt32BE(out.length - a, a + 4);
    out.writeUInt32BE(out.length, 8);
    return out;
  };
  return { count, tracks, write };
}

// --- Archives -------------------------------------------------------------------

// A RARC archive (already out of Yaz0) with some files replaced by path ('bmd/ma_mdl1.bmd'); every
// other file and the folder tree stay as they were.
function repackRarc(src, replacements) {
  const d = Buffer.from(src);
  const nodes = d.readUInt32BE(0x24) + 0x20, entries = d.readUInt32BE(0x2c) + 0x20, strings = d.readUInt32BE(0x34) + 0x20;
  const dataStart = d.readUInt32BE(0x0c) + 0x20;
  const name = at => d.toString('latin1', strings + at, d.indexOf(0, strings + at));
  const files = new Map();
  const walk = (node, prefix) => {
    const n = nodes + node * 16, count = d.readUInt16BE(n + 10), first = d.readUInt32BE(n + 12);
    for (let e = first; e < first + count; e++) {
      const at = entries + e * 20, flags = d[at + 4], entryName = name(d.readUInt32BE(at + 4) & 0xffffff);
      if (entryName === '.' || entryName === '..') continue;
      if (flags & 2) walk(d.readUInt32BE(at + 8), `${prefix}${entryName}/`);
      else files.set(`${prefix}${entryName}`.toLowerCase(), e);
    }
  };
  walk(0, '');
  for (const key of Object.keys(replacements)) if (!files.has(key.toLowerCase())) throw new Error(`The game's Mario archive has no ${key}.`);
  const byPath = new Map(Object.entries(replacements).map(([k, v]) => [k.toLowerCase(), v]));
  const order = [...files.entries()].sort((x, y) => d.readUInt32BE(entries + x[1] * 20 + 8) - d.readUInt32BE(entries + y[1] * 20 + 8));
  const blobs = [];
  let size = 0;
  for (const [file, e] of order) {
    const at = entries + e * 20, off = d.readUInt32BE(at + 8), length = d.readUInt32BE(at + 12);
    const content = byPath.get(file) || d.subarray(dataStart + off, dataStart + off + length);
    d.writeUInt32BE(size, at + 8); d.writeUInt32BE(content.length, at + 12);
    const padded = pad32(Buffer.from(content));
    blobs.push(padded); size += padded.length;
  }
  const out = Buffer.concat([d.subarray(0, dataStart), ...blobs]);
  out.writeUInt32BE(out.length, 4);
  out.writeUInt32BE(size, 0x10); out.writeUInt32BE(size, 0x14); out.writeUInt32BE(0, 0x18);
  return out;
}

module.exports = { sections, sectionOf, vtx1, evp1, drw1, shp1, jnt1Patch, inf1Patch, tex1, cmpr, rgba8, assemble, bckTranslations, repackRarc };
