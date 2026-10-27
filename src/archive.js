'use strict';

// Yaz0-compressed RARC archives (.szs/.arc), the game's packed asset folders.

// Far beyond any of the game's archives; a larger size means a damaged file.
const MAX_SIZE = 64 << 20;

function yaz0(src) {
  if (src.toString('ascii', 0, 4) !== 'Yaz0') return src;
  const size = src.readUInt32BE(4);
  if (size > MAX_SIZE) throw new Error('A file on the game disc appears to be damaged.');
  const out = Buffer.alloc(size);
  let s = 16, d = 0;
  while (d < out.length) {
    const header = src[s++];
    for (let bit = 7; bit >= 0 && d < out.length; bit--) {
      if (header & (1 << bit)) { out[d++] = src[s++]; continue; }
      const a = src[s++], b = src[s++];
      let back = d - (((a & 0xf) << 8) | b) - 1;
      let length = a >> 4 ? (a >> 4) + 2 : src[s++] + 0x12;
      while (length--) out[d++] = out[back++];
    }
  }
  return out;
}

// path (lower case, "/"-separated, without the archive's root folder) -> Buffer
function rarc(buffer) {
  const data = yaz0(buffer);
  if (data.toString('ascii', 0, 4) !== 'RARC') throw new Error('This is not a game archive.');
  const info = 0x20, dataStart = 0x20 + data.readUInt32BE(0x0c);
  const nodes = info + data.readUInt32BE(info + 4), entries = info + data.readUInt32BE(info + 0x0c);
  const strings = info + data.readUInt32BE(info + 0x14);
  const name = at => data.toString('latin1', strings + at, data.indexOf(0, strings + at));
  const files = new Map();
  const walk = (node, prefix) => {
    const n = nodes + node * 16, count = data.readUInt16BE(n + 10), first = data.readUInt32BE(n + 12);
    for (let i = 0; i < count; i++) {
      const e = entries + (first + i) * 20, flags = data[e + 4], entryName = name(data.readUInt32BE(e + 4) & 0xffffff);
      if (entryName === '.' || entryName === '..') continue;
      if (flags & 0x02) walk(data.readUInt32BE(e + 8), `${prefix}${entryName}/`);
      else {
        const start = dataStart + data.readUInt32BE(e + 8);
        files.set(`${prefix}${entryName}`.toLowerCase(), data.subarray(start, start + data.readUInt32BE(e + 12)));
      }
    }
  };
  walk(0, '');
  return files;
}

// An archive's folders and files as stored, for writing it back with changes:
// { name, entries: [{ dir }, { file: { name, flags, id, data } }] }, in the
// archive's own order and letter case.
function readTree(buffer) {
  const data = yaz0(buffer);
  if (data.toString('ascii', 0, 4) !== 'RARC') throw new Error('This is not a game archive.');
  const info = 0x20, dataStart = 0x20 + data.readUInt32BE(0x0c);
  const nodes = info + data.readUInt32BE(info + 4), entries = info + data.readUInt32BE(info + 0x0c);
  const strings = info + data.readUInt32BE(info + 0x14);
  const name = at => data.toString('latin1', strings + at, data.indexOf(0, strings + at));
  const read = node => {
    const n = nodes + node * 16, count = data.readUInt16BE(n + 10), first = data.readUInt32BE(n + 12);
    const dir = { name: name(data.readUInt32BE(n + 4)), entries: [] };
    for (let i = 0; i < count; i++) {
      const e = entries + (first + i) * 20, flags = data[e + 4], entryName = name(data.readUInt32BE(e + 4) & 0xffffff);
      if (entryName === '.' || entryName === '..') continue;
      if (flags & 0x02) dir.entries.push({ dir: read(data.readUInt32BE(e + 8)) });
      else {
        const start = dataStart + data.readUInt32BE(e + 8);
        dir.entries.push({ file: { name: entryName, flags, id: data.readUInt16BE(e), data: data.subarray(start, start + data.readUInt32BE(e + 12)) } });
      }
    }
    return dir;
  };
  return { root: read(0), syncIds: data[info + 0x1a] === 1 };
}

// The file at a "/"-separated path (letter case ignored), its folder, and
// that folder's entry list index; null when it isn't there.
function treeFile(tree, file) {
  const parts = file.toLowerCase().split('/');
  let dir = tree.root;
  for (let i = 0; i < parts.length; i++) {
    const index = dir.entries.findIndex(entry => (entry.dir || entry.file).name.toLowerCase() === parts[i]);
    if (index < 0) return null;
    const entry = dir.entries[index];
    if (i === parts.length - 1) return entry.file ? { dir, index, file: entry.file } : null;
    if (!entry.dir) return null;
    dir = entry.dir;
  }
  return null;
}

// Puts `data` at a path, making folders as needed; an existing file keeps its place.
function treePut(tree, file, data) {
  const parts = file.split('/');
  let dir = tree.root;
  for (const part of parts.slice(0, -1)) {
    let entry = dir.entries.find(e => e.dir && e.dir.name.toLowerCase() === part.toLowerCase());
    if (!entry) {
      entry = { dir: { name: part, entries: [] } };
      // Folders come before files, as the game's own archives list them.
      const firstFile = dir.entries.findIndex(e => e.file);
      dir.entries.splice(firstFile < 0 ? dir.entries.length : firstFile, 0, entry);
    }
    dir = entry.dir;
  }
  const name = parts[parts.length - 1];
  const existing = dir.entries.find(e => e.file && e.file.name.toLowerCase() === name.toLowerCase());
  if (existing) existing.file.data = data;
  else dir.entries.push({ file: { name, flags: 0x11, id: 0, data } });
}

const hash = text => { let h = 0; for (let i = 0; i < text.length; i++) h = (h * 3 + text.charCodeAt(i)) & 0xffff; return h; };
const align = (n, to) => Math.ceil(n / to) * to;

// An uncompressed RARC from readTree's shape. Folders are numbered depth
// first, each folder's entries end with "." and "..", and file data is in
// entry order, 32-byte aligned, as the game's archives are laid out.
function writeTree(tree) {
  const dirs = [];
  const number = dir => { dir.index = dirs.push(dir) - 1; for (const e of dir.entries) if (e.dir) { e.dir.parent = dir.index; number(e.dir); } };
  tree.root.parent = -1;
  number(tree.root);

  // Names in the order the game's tools wrote them, each once per entry: "."
  // and "..", then each folder's name and its entries, going into each
  // subfolder as it comes.
  const strings = [];
  let stringSize0 = 0;
  const addString = text => { const at = stringSize0; strings.push(Buffer.from(`${text}\0`, 'latin1')); stringSize0 += strings[strings.length - 1].length; return at; };
  const dot = addString('.'), dotDot = addString('..');
  const addNames = dir => {
    dir.nameAt = addString(dir.name);
    for (const e of dir.entries) if (e.dir) addNames(e.dir); else e.file.nameAt = addString(e.file.name);
  };
  addNames(tree.root);

  const entryList = [];
  for (const dir of dirs) {
    dir.first = entryList.length;
    for (const e of dir.entries) entryList.push(e.dir ? { kind: 'dir', name: e.dir.name, nameAt: e.dir.nameAt, node: e.dir.index } : { kind: 'file', ...e.file });
    entryList.push({ kind: 'dir', name: '.', nameAt: dot, node: dir.index }, { kind: 'dir', name: '..', nameAt: dotDot, node: dir.parent });
    dir.count = entryList.length - dir.first;
  }

  let dataSize = 0;
  entryList.forEach((e, i) => {
    if (e.kind !== 'file') return;
    e.offset = dataSize;
    dataSize += align(e.data.length, 32);
    if (tree.syncIds !== false) e.id = i;
  });

  const nodesAt = 0x20, entriesAt = align(nodesAt + dirs.length * 16, 32);
  const stringsAt = align(entriesAt + entryList.length * 20, 32);
  const stringBytes = Buffer.concat(strings), stringSize = align(stringBytes.length, 32);
  const dataAt = stringsAt + stringSize;
  const out = Buffer.alloc(0x20 + dataAt + dataSize);
  out.write('RARC', 0, 'latin1');
  out.writeUInt32BE(out.length, 4);
  out.writeUInt32BE(0x20, 8);
  out.writeUInt32BE(dataAt, 0x0c);
  out.writeUInt32BE(dataSize, 0x10);
  out.writeUInt32BE(dataSize, 0x14);
  const info = 0x20;
  out.writeUInt32BE(dirs.length, info);
  out.writeUInt32BE(nodesAt, info + 4);
  out.writeUInt32BE(entryList.length, info + 8);
  out.writeUInt32BE(entriesAt, info + 0x0c);
  out.writeUInt32BE(stringSize, info + 0x10);
  out.writeUInt32BE(stringsAt, info + 0x14);
  out.writeUInt16BE(entryList.length, info + 0x18);
  out[info + 0x1a] = tree.syncIds === false ? 0 : 1;
  dirs.forEach((dir, i) => {
    const n = info + nodesAt + i * 16;
    out.write(i === 0 ? 'ROOT' : dir.name.toUpperCase().padEnd(4, ' ').slice(0, 4), n, 'latin1');
    out.writeUInt32BE(dir.nameAt, n + 4);
    out.writeUInt16BE(hash(dir.name), n + 8);
    out.writeUInt16BE(dir.count, n + 10);
    out.writeUInt32BE(dir.first, n + 12);
  });
  entryList.forEach((e, i) => {
    const o = info + entriesAt + i * 20;
    out.writeUInt16BE(e.kind === 'file' ? e.id : 0xffff, o);
    out.writeUInt16BE(hash(e.name), o + 2);
    out.writeUInt32BE(((e.kind === 'file' ? e.flags : 0x02) << 24 | e.nameAt) >>> 0, o + 4);
    if (e.kind === 'file') {
      out.writeUInt32BE(e.offset, o + 8);
      out.writeUInt32BE(e.data.length, o + 12);
      e.data.copy(out, info + dataAt + e.offset);
    } else {
      out.writeUInt32BE(e.node >>> 0, o + 8);
      out.writeUInt32BE(0x10, o + 12);
    }
  });
  stringBytes.copy(out, info + stringsAt);
  return out;
}

// Yaz0 compression the game's decompressor reads. A greedy LZ77 over a 4 KiB
// window with hash chains: not as small as Nintendo's encoder, but quick.
function yaz0Encode(src) {
  const out = [Buffer.from('Yaz0'), Buffer.alloc(12)];
  out[1].writeUInt32BE(src.length, 0);
  const chunks = Buffer.alloc(src.length + Math.ceil(src.length / 8) + 16);
  const head = new Int32Array(1 << 15).fill(-1), prev = new Int32Array(src.length);
  const key = i => ((src[i] << 10) ^ (src[i + 1] << 5) ^ src[i + 2]) & 0x7fff;
  const insert = i => { if (i + 2 < src.length) { const k = key(i); prev[i] = head[k]; head[k] = i; } };
  let s = 0, d = 0;
  while (s < src.length) {
    const flagAt = d++;
    let flags = 0;
    for (let bit = 7; bit >= 0 && s < src.length; bit--) {
      let bestLength = 0, bestDistance = 0;
      if (s + 2 < src.length) {
        const max = Math.min(0x111, src.length - s);
        for (let c = head[key(s)], tries = 0; c >= 0 && s - c <= 0x1000 && tries < 64; c = prev[c], tries++) {
          let length = 0;
          while (length < max && src[c + length] === src[s + length]) length++;
          if (length > bestLength) { bestLength = length; bestDistance = s - c; if (length === max) break; }
        }
      }
      if (bestLength >= 3) {
        const distance = bestDistance - 1;
        if (bestLength >= 0x12) {
          chunks[d++] = distance >> 8; chunks[d++] = distance & 0xff; chunks[d++] = bestLength - 0x12;
        } else {
          chunks[d++] = ((bestLength - 2) << 4) | (distance >> 8); chunks[d++] = distance & 0xff;
        }
        for (let k = 0; k < bestLength; k++) insert(s + k);
        s += bestLength;
      } else {
        flags |= 1 << bit;
        insert(s);
        chunks[d++] = src[s++];
      }
    }
    chunks[flagAt] = flags;
  }
  out.push(chunks.subarray(0, d));
  return Buffer.concat(out);
}

// Takes a file out of an archive tree (lower-case path); true if it was there.
function treeRemove(tree, file) {
  const found = treeFile(tree, file);
  if (!found) return false;
  found.dir.entries.splice(found.index, 1);
  return true;
}

module.exports = { yaz0, rarc, readTree, treeFile, treePut, treeRemove, writeTree, yaz0Encode };
