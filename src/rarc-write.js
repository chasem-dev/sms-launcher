'use strict';
// Writing RARC archives (the game's packed folders) laid out as Nintendo's
// tools lay them out: folders breadth first, each folder's entries together
// with "." and ".." last, file data in entry order on 32-byte boundaries,
// file IDs matching entry indices. Used to add a folder to a copy of the
// player's own Mario archive (a character's look model).
const { yaz0 } = require('./archive');

const align = (n, a = 32) => (n + a - 1) & ~(a - 1);
const hash = name => { let h = 0; for (const c of Buffer.from(name, 'latin1')) h = (h * 3 + c) & 0xffff; return h; };

// An archive's folder tree: { name, dirs: [tree], files: [{ name, data, flags }] }, in its own order.
function readTree(source) {
  const d = yaz0(source), info = 0x20;
  const nodes = info + d.readUInt32BE(info + 4), entries = info + d.readUInt32BE(info + 0x0c), strings = info + d.readUInt32BE(info + 0x14);
  const dataStart = 0x20 + d.readUInt32BE(0x0c);
  const name = at => d.toString('latin1', strings + at, d.indexOf(0, strings + at));
  const node = index => {
    const n = nodes + index * 16, count = d.readUInt16BE(n + 10), first = d.readUInt32BE(n + 12);
    const tree = { name: name(d.readUInt32BE(n + 4)), dirs: [], files: [] };
    for (let e = first; e < first + count; e++) {
      const at = entries + e * 20, flags = d[at + 4], entryName = name(d.readUInt32BE(at + 4) & 0xffffff);
      if (entryName === '.' || entryName === '..') continue;
      if (flags & 2) tree.dirs.push(node(d.readUInt32BE(at + 8)));
      else {
        const start = dataStart + d.readUInt32BE(at + 8);
        tree.files.push({ name: entryName, flags, data: d.subarray(start, start + d.readUInt32BE(at + 12)) });
      }
    }
    // the order entries came in, files and folders mixed
    tree.order = [];
    for (let e = first; e < first + count; e++) {
      const entryName = name(d.readUInt32BE(entries + e * 20 + 4) & 0xffffff);
      if (entryName !== '.' && entryName !== '..') tree.order.push(entryName);
    }
    return tree;
  };
  return node(0);
}

// A plain (not Yaz0) RARC of the tree.
function writeRarc(root) {
  // folders breadth first: the root, then each folder's subfolders in its entry order
  const folders = [root];
  for (let i = 0; i < folders.length; i++) folders[i].index = i, folders.push(...orderOf(folders[i]).filter(x => x.dirs).map(x => x.item));
  // names as Nintendo's tools store them: ".", "..", then each folder's name followed by its files' names
  const strings = [Buffer.from('.\0..\0', 'latin1')];
  let stringSize = 5;
  const append = s => { const at = stringSize; strings.push(Buffer.from(`${s}\0`, 'latin1')); stringSize += Buffer.byteLength(s, 'latin1') + 1; return at; };
  const offsets = new Map([['.', 0], ['..', 2]]);
  const nameAt = new Map();
  for (const folder of folders) {
    nameAt.set(folder, append(folder.name));
    for (const { item, dirs } of orderOf(folder)) if (!dirs) nameAt.set(item, append(item.name));
  }
  const string = item => nameAt.get(item);
  const entries = [], blobs = [];
  let dataSize = 0;
  const parentOf = new Map();
  for (const folder of folders) for (const sub of folder.dirs) parentOf.set(sub, folder.index);
  const nodeRecords = folders.map(folder => {
    const first = entries.length;
    for (const { item, dirs } of orderOf(folder)) {
      if (dirs) entries.push({ id: 0xffff, hash: hash(item.name), flags: 2, name: string(item), offset: item.index, size: 0x10 });
      else {
        const id = entries.length;
        entries.push({ id, hash: hash(item.name), flags: item.flags || 0x11, name: string(item), offset: dataSize, size: item.data.length });
        blobs.push(item.data, Buffer.alloc(align(item.data.length) - item.data.length));
        dataSize += align(item.data.length);
      }
    }
    entries.push({ id: 0xffff, hash: hash('.'), flags: 2, name: offsets.get('.'), offset: folder.index, size: 0x10 });
    entries.push({ id: 0xffff, hash: hash('..'), flags: 2, name: offsets.get('..'), offset: folder === root ? 0xffffffff : parentOf.get(folder), size: 0x10 });
    const type = folder === root ? 'ROOT' : folder.name.toUpperCase().padEnd(4, ' ').slice(0, 4);
    return { type, nameAt: string(folder), hash: hash(folder.name), count: entries.length - first, first };
  });
  const nodesAt = 0x40, entriesAt = align(nodesAt + folders.length * 16), stringsAt = align(entriesAt + entries.length * 20);
  const stringsPadded = align(stringSize), dataAt = stringsAt + stringsPadded;
  const head = Buffer.alloc(dataAt);
  head.write('RARC', 0, 'ascii');
  head.writeUInt32BE(dataAt + dataSize, 4); head.writeUInt32BE(0x20, 8); head.writeUInt32BE(dataAt - 0x20, 0x0c);
  head.writeUInt32BE(dataSize, 0x10); head.writeUInt32BE(dataSize, 0x14);
  const info = 0x20;
  [folders.length, nodesAt - 0x20, entries.length, entriesAt - 0x20, stringsPadded, stringsAt - 0x20].forEach((v, i) => head.writeUInt32BE(v, info + i * 4));
  head.writeUInt16BE(entries.length, info + 0x18); head[info + 0x1a] = 1;
  nodeRecords.forEach((n, i) => {
    const at = nodesAt + i * 16;
    head.write(n.type, at, 'latin1'); head.writeUInt32BE(n.nameAt, at + 4); head.writeUInt16BE(n.hash, at + 8);
    head.writeUInt16BE(n.count, at + 10); head.writeUInt32BE(n.first, at + 12);
  });
  entries.forEach((e, i) => {
    const at = entriesAt + i * 20;
    head.writeUInt16BE(e.id, at); head.writeUInt16BE(e.hash, at + 2);
    head.writeUInt32BE((e.flags << 24 | e.name) >>> 0, at + 4); head.writeUInt32BE(e.offset >>> 0, at + 8); head.writeUInt32BE(e.size, at + 12);
  });
  Buffer.concat(strings).copy(head, stringsAt);
  return Buffer.concat([head, ...blobs]);
}

// A folder's entries in order: [{ item, dirs }] (dirs: whether the item is a folder).
function orderOf(folder) {
  const byName = new Map([...folder.dirs.map(d => [d.name, { item: d, dirs: true }]), ...folder.files.map(f => [f.name, { item: f, dirs: false }])]);
  const order = folder.order ? folder.order.filter(n => byName.has(n)) : [];
  for (const n of byName.keys()) if (!order.includes(n)) order.push(n);
  return order.map(n => byName.get(n));
}

// A copy of an archive with a folder added (or replaced) at its root: files { name: data }.
function withFolder(source, folderName, files) {
  const tree = readTree(source);
  tree.dirs = tree.dirs.filter(d => d.name !== folderName);
  tree.dirs.push({ name: folderName, dirs: [], files: Object.entries(files).map(([name, data]) => ({ name, data, flags: 0x11 })) });
  return writeRarc(tree);
}

module.exports = { readTree, writeRarc, withFolder, hash };
