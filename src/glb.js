'use strict';
// Reads binary glTF (.glb) models: the JSON, typed accessors, node matrices
// and embedded images (left encoded; the caller decodes them).

const COMPONENTS = { 5120: [1, 'getInt8'], 5121: [1, 'getUint8'], 5122: [2, 'getInt16'], 5123: [2, 'getUint16'], 5125: [4, 'getUint32'], 5126: [4, 'getFloat32'] };
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const NORMALIZED = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

class Glb {
  constructor(data) {
    if (data.length < 20 || data.toString('ascii', 0, 4) !== 'glTF') throw new Error('This is not a binary glTF (.glb) model.');
    this.bin = Buffer.alloc(0);
    for (let p = 12; p + 8 <= data.length;) {
      const length = data.readUInt32LE(p), kind = data.toString('ascii', p + 4, p + 8);
      if (kind === 'JSON') this.json = JSON.parse(data.toString('utf8', p + 8, p + 8 + length));
      else if (kind === 'BIN\0') this.bin = data.subarray(p + 8, p + 8 + length);
      p += 8 + length;
    }
    if (!this.json) throw new Error('The model has no glTF description.');
    const g = this.json;
    for (const key of ['nodes', 'meshes', 'skins', 'materials', 'textures', 'images', 'accessors', 'bufferViews']) g[key] ||= [];
    if (g.buffers?.some((b, i) => i > 0 || b.uri)) throw new Error('The model keeps its data in separate files: export it as a single .glb.');
  }

  view(index) {
    const v = this.json.bufferViews[index];
    const start = v.byteOffset || 0;
    return { bytes: this.bin.subarray(start, start + v.byteLength), stride: v.byteStride || 0 };
  }

  // An accessor's values as a Float64Array of count x width.
  accessor(index) {
    const a = this.json.accessors[index];
    const width = WIDTH[a.type], [size, getter] = COMPONENTS[a.componentType];
    const out = new Float64Array(a.count * width);
    if (a.bufferView === undefined) return out;
    const { bytes, stride } = this.view(a.bufferView);
    const step = stride || size * width, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const base = a.byteOffset || 0, scale = a.normalized && NORMALIZED[a.componentType] ? 1 / NORMALIZED[a.componentType] : 1;
    for (let i = 0; i < a.count; i++)
      for (let c = 0; c < width; c++) out[i * width + c] = view[getter](base + i * step + c * size, true) * scale;
    return out;
  }

  // An embedded image: { bytes, mimeType }.
  image(index) {
    const image = this.json.images[index];
    if (image.bufferView !== undefined) return { bytes: Buffer.from(this.view(image.bufferView).bytes), mimeType: image.mimeType || '' };
    if (image.uri?.startsWith('data:')) return { bytes: Buffer.from(image.uri.split(',', 2)[1], 'base64'), mimeType: image.uri.slice(5, image.uri.indexOf(';')) };
    throw new Error(`The model's image ${image.uri || index} is a separate file: export it as a single .glb with its textures.`);
  }
}

// A node's local matrix, row-major 4x4.
function nodeLocal(node) {
  if (node.matrix) {
    const m = node.matrix;  // column-major
    return [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]];
  }
  const [x, y, z, w] = node.rotation || [0, 0, 0, 1], [sx, sy, sz] = node.scale || [1, 1, 1], [tx, ty, tz] = node.translation || [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y - z * w) * sy, 2 * (x * z + y * w) * sz, tx,
    2 * (x * y + z * w) * sx, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z - x * w) * sz, ty,
    2 * (x * z - y * w) * sx, 2 * (y * z + x * w) * sy, (1 - 2 * (x * x + y * y)) * sz, tz,
    0, 0, 0, 1,
  ];
}

module.exports = { Glb, nodeLocal };
