'use strict';

// Scene-file nodes for the world editor's tests, built byte by byte.
const sceneBin = require('../src/scene-bin');

// Shift-JIS for the game's Japanese names, from the decoder run backwards.
let sjisTable = null;
function sjis(text) {
  if (!sjisTable) {
    sjisTable = new Map();
    const decoder = new TextDecoder('shift_jis');
    for (const lead of [...Array(0x1f).keys()].map(i => 0x81 + i).concat([...Array(0x10).keys()].map(i => 0xe0 + i)))
      for (let trail = 0x40; trail <= 0xfc; trail++) {
        const char = decoder.decode(Uint8Array.of(lead, trail));
        if (char.length === 1 && char !== '\ufffd' && !sjisTable.has(char)) sjisTable.set(char, [lead, trail]);
      }
  }
  return Buffer.from([...text].flatMap(char => char.charCodeAt(0) < 0x80 ? [char.charCodeAt(0)] : sjisTable.get(char)));
}

const str = text => { const bytes = sjis(text); const out = Buffer.alloc(2 + bytes.length); out.writeUInt16BE(bytes.length); bytes.copy(out, 2); return out; };
function node(type, name, payload, children) {
  const typeBytes = Buffer.from(type, 'latin1'), nameBytes = sjis(name);
  const head = Buffer.concat([Buffer.alloc(4), u16(sceneBin.keyCode(typeBytes)), str(type), u16(sceneBin.keyCode(nameBytes)), str(name)]);
  const body = children ? Buffer.concat([payload, u32(children.length), ...children]) : payload;
  const out = Buffer.concat([head, body]);
  out.writeUInt32BE(out.length, 0);
  return out;
}
const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
const f32 = (...values) => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeFloatBE(v, i * 4)); return b; };

// An actor: transform, character name, an empty light map, then `extra`.
function actor(type, name, position, extra = Buffer.alloc(0)) {
  return node(type, name, Buffer.concat([f32(...position, 0, 90, 0, 1, 1, 1), str(`${name} chara`), u32(0), extra]));
}

module.exports = { node, actor, str, sjis, u16, u32, f32 };
