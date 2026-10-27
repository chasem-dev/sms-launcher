'use strict';

// The game's scene files (map/scene.bin in each data/scene/*.szs): a tree of
// JDrama nodes the game's factory turns into the stage's objects.
//
// A node is: u32 size (counting itself), u16 key + string type name, u16 key +
// string instance name, then data that depends on the type. Strings are a u16
// length and Shift-JIS bytes; keys are TNameRef::calcKeyCode of the bytes.
// Groups hold more nodes: a few bytes of their own, a u32 count, the children.
// Everything else stays as the bytes it was read from, so a scene that isn't
// edited writes back byte for byte.

const sjis = new TextDecoder('shift_jis');

// Group types, by how many bytes of their own come before the child count
// (given where those bytes start). MarScene's are its light map: a count,
// then that many u32 + string pairs.
const GROUPS = {
  GroupObj: () => 0, NameRefGrp: () => 0, LightAry: () => 0, AmbAry: () => 0, Strategy: () => 0,
  IdxGroup: () => 4,
  MarScene: (buffer, at) => {
    let p = at + 4;
    for (let n = buffer.readInt32BE(at); n > 0; n--) p += 4 + 2 + buffer.readUInt16BE(p + 4);
    return p - at;
  },
};

function keyCode(bytes) {
  let key = 0;
  for (const byte of bytes) key = (key * 3 + byte) & 0xffff;
  return key;
}

function parse(buffer) {
  const node = at => {
    const size = buffer.readUInt32BE(at), end = at + size;
    if (size < 8 || end > buffer.length) throw new Error('A scene file on the game disc appears to be damaged.');
    const readString = p => {
      const length = buffer.readUInt16BE(p);
      return { bytes: Buffer.from(buffer.subarray(p + 2, p + 2 + length)), next: p + 2 + length };
    };
    const typeKey = buffer.readUInt16BE(at + 4);
    const type = readString(at + 6);
    const nameKey = buffer.readUInt16BE(type.next);
    const name = readString(type.next + 2);
    const result = { type: type.bytes.toString('latin1'), typeKey, nameBytes: name.bytes, nameKey, data: null, children: null };
    const ownLength = GROUPS[result.type];
    if (!ownLength) {
      result.data = Buffer.from(buffer.subarray(name.next, end));
      return result;
    }
    const own = ownLength(buffer, name.next);
    result.data = Buffer.from(buffer.subarray(name.next, name.next + own));
    let p = name.next + own;
    const count = buffer.readUInt32BE(p);
    p += 4;
    result.children = [];
    for (let i = 0; i < count; i++) {
      if (p >= end) throw new Error('A scene file on the game disc appears to be damaged.');
      result.children.push(node(p));
      p += buffer.readUInt32BE(p);
    }
    return result;
  };
  return node(0);
}

function serialize(root) {
  const parts = [];
  const write = node => {
    const type = Buffer.from(node.type, 'latin1'), name = node.nameBytes;
    const head = Buffer.alloc(4 + 2 + 2 + type.length + 2 + 2 + name.length);
    let p = 4;
    head.writeUInt16BE(node.typeKey ?? keyCode(type), p); p += 2;
    head.writeUInt16BE(type.length, p); p += 2;
    type.copy(head, p); p += type.length;
    head.writeUInt16BE(node.nameKey ?? keyCode(name), p); p += 2;
    head.writeUInt16BE(name.length, p); p += 2;
    name.copy(head, p);
    const start = parts.length;
    parts.push(head, node.data || Buffer.alloc(0));
    if (node.children) {
      const count = Buffer.alloc(4);
      count.writeUInt32BE(node.children.length);
      parts.push(count);
      node.children.forEach(write);
    }
    let size = 0;
    for (let i = start; i < parts.length; i++) size += parts[i].length;
    head.writeUInt32BE(size, 0);
  };
  write(root);
  return Buffer.concat(parts);
}

const decodeName = bytes => sjis.decode(bytes);

// Shift-JIS bytes for a name typed in the editor. Names the editor makes are
// ASCII (a type name and a number), so that's all this needs to cover.
function encodeName(text) {
  return Buffer.from(String(text).replace(/[^\x20-\x7e]/g, '?'), 'latin1');
}

// Every node with an id: its path of child indexes from the root ("" is the root).
function walk(root, visit) {
  const go = (node, id, parent, depth) => {
    visit(node, id, parent, depth);
    node.children?.forEach((child, i) => go(child, id === '' ? String(i) : `${id}/${i}`, id, depth + 1));
  };
  go(root, '', null, 0);
}

function find(root, id) {
  if (id === '') return root;
  let node = root;
  for (const index of String(id).split('/')) {
    node = node?.children?.[Number(index)];
    if (!node) return null;
  }
  return node;
}

// The strings a node's data holds, in order, as { at, bytes, text }: where a
// u16 length is followed by that many printable Shift-JIS bytes. Model,
// manager and character names are among them.
function strings(data) {
  const out = [];
  for (let at = 0; at + 2 <= data.length;) {
    const length = data.readUInt16BE(at);
    if (length >= 1 && length <= 128 && at + 2 + length <= data.length && printable(data.subarray(at + 2, at + 2 + length))) {
      const bytes = data.subarray(at + 2, at + 2 + length);
      out.push({ at, bytes, text: sjis.decode(bytes) });
      at += 2 + length;
    } else at++;
  }
  return out;
}

function printable(bytes) {
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c >= 0x20 && c < 0x7f) continue;
    // A Shift-JIS lead byte and its trail byte.
    if (((c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc)) && i + 1 < bytes.length && bytes[i + 1] >= 0x40 && bytes[i + 1] <= 0xfc && bytes[i + 1] !== 0x7f) { i++; continue; }
    if (c >= 0xa1 && c <= 0xdf) continue;  // half-width katakana
    return false;
  }
  return true;
}

module.exports = { GROUPS, parse, serialize, keyCode, decodeName, encodeName, walk, find, strings };
