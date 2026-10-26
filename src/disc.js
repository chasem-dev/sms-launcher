'use strict';

// Reads files straight out of the player's GameCube disc image (ISO/GCM or CISO)
// without unpacking the whole disc.

const fs = require('node:fs');

class Disc {
  constructor(file) {
    this.fd = fs.openSync(file, 'r');
    try {
      const head = this.readRaw(0, 0x20);
      this.blocks = null;
      if (head.toString('ascii', 0, 4) === 'CISO') {
        // CISO: a 0x8000-byte header whose map marks which blocks of the disc are stored, in order.
        this.blockSize = head.readUInt32LE(4);
        const map = this.readRaw(8, 0x8000 - 8);
        this.blocks = new Int32Array(map.length).fill(-1);
        for (let i = 0, stored = 0; i < map.length; i++) if (map[i]) this.blocks[i] = stored++;
      }
      const header = this.read(0, 0x440);
      this.gameId = header.toString('ascii', 0, 6);
      const fstOffset = header.readUInt32BE(0x424), fstSize = header.readUInt32BE(0x428);
      if (fstSize > 0x1000000) throw new Error('The game disc\'s file table appears to be damaged.');
      this.files = parseFst(this.read(fstOffset, fstSize));
    } catch (error) { this.close(); throw error; }
  }

  readRaw(offset, length) {
    const out = Buffer.alloc(length);
    const got = fs.readSync(this.fd, out, 0, length, offset);
    if (got !== length) throw new Error('The game disc file ended early.');
    return out;
  }

  // Bytes at a disc offset, mapping through the CISO block table when compressed.
  read(offset, length) {
    if (!this.blocks) return this.readRaw(offset, length);
    const out = Buffer.alloc(length);
    for (let done = 0; done < length;) {
      const block = Math.floor((offset + done) / this.blockSize), within = (offset + done) % this.blockSize;
      const take = Math.min(length - done, this.blockSize - within);
      if (this.blocks[block] >= 0)
        out.set(this.readRaw(0x8000 + this.blocks[block] * this.blockSize + within, take), done);
      done += take;
    }
    return out;
  }

  file(name) {
    const entry = this.files.get(name.toLowerCase());
    if (!entry) throw new Error(`The game disc has no ${name}.`);
    return this.read(entry.offset, entry.size);
  }

  // The disc offset where the last data the game reads ends: the boot files
  // and apploader, main.dol, the file system table and every file in it.
  dataEnd() {
    const header = this.read(0, 0x440), apploader = this.read(0x2440, 0x20);
    let end = 0x2460 + apploader.readUInt32BE(0x14) + apploader.readUInt32BE(0x18);
    const dolOffset = header.readUInt32BE(0x420), dol = this.read(dolOffset, 0x100);
    for (let i = 0; i < 18; i++) end = Math.max(end, dolOffset + dol.readUInt32BE(i * 4) + dol.readUInt32BE(0x90 + i * 4));
    end = Math.max(end, header.readUInt32BE(0x424) + header.readUInt32BE(0x428));
    for (const { offset, size } of this.files.values()) end = Math.max(end, offset + size);
    return end;
  }

  // How long the image file must be to hold the disc up to `end`. A CISO
  // stores its blocks in order, so that's up to the last stored block before it.
  storedSize(end) {
    if (!this.blocks) return end;
    for (let block = Math.min(Math.ceil(end / this.blockSize), this.blocks.length) - 1; block >= 0; block--)
      if (this.blocks[block] >= 0)
        return 0x8000 + this.blocks[block] * this.blockSize + Math.min(this.blockSize, end - block * this.blockSize);
    return 0x8000;
  }

  close() { fs.closeSync(this.fd); }
}

// Disc image and archive formats the game can't read, by their first bytes.
// An NKit .iso isn't here: it's a GameCube image whose file table points at
// every file (only the junk between them is gone), so the game reads it, and
// the checks below treat it like any trimmed image.
const OTHER_FORMATS = [
  ['rvz', head => head.toString('latin1', 0, 4) === 'RVZ\x01'],
  ['wia', head => head.toString('latin1', 0, 4) === 'WIA\x01'],
  ['gcz', head => head.length >= 4 && head.readUInt32LE(0) === 0xb10bc001],
  ['wbfs', head => head.toString('latin1', 0, 4) === 'WBFS'],
  ['zip', head => head.toString('latin1', 0, 4) === 'PK\x03\x04'],
  ['7z', head => head.toString('latin1', 0, 6) === '7z\xbc\xaf\x27\x1c'],
  ['rar', head => head.toString('latin1', 0, 4) === 'Rar!']
];

// What a disc image file holds, without reading more than its headers and file
// system table: { format } for a format the game can't read, or for a GameCube
// image ('iso' or 'ciso') its game ID, revision and title, its size, and the
// size it needs to hold everything the game reads (null when that can't be read).
function describe(file) {
  const fd = fs.openSync(file, 'r');
  let head, size, ciso = false;
  try {
    size = fs.fstatSync(fd).size;
    head = Buffer.alloc(0x440);
    head = head.subarray(0, fs.readSync(fd, head, 0, head.length, 0));
    if (head.toString('latin1', 0, 4) === 'CISO' && head.length >= 9) {
      const blockSize = head.readUInt32LE(4);
      if (blockSize < 0x20 || blockSize > 0x200000 || head[8] !== 1) return { format: 'damaged-ciso', size };
      ciso = true;
      head = Buffer.alloc(0x440);
      head = head.subarray(0, fs.readSync(fd, head, 0, head.length, 0x8000));
      if (head.length < 0x440) return { format: 'ciso', size, needed: null };
    }
  } finally { fs.closeSync(fd); }
  const other = OTHER_FORMATS.find(([, matches]) => head.length >= 4 && matches(head));
  if (other) return { format: other[0], size };
  if (head.length >= 0x20 && head.readUInt32BE(0x18) === 0x5d1c9ea3) return { format: 'wii', size };
  if (head.length < 0x20 || head.readUInt32BE(0x1c) !== 0xc2339f3d) return { format: 'unknown', size };
  const nul = head.indexOf(0, 0x20);
  const result = { format: ciso ? 'ciso' : 'iso', size,
    gameId: head.toString('latin1', 0, 6), revision: head[7],
    title: head.toString('latin1', 0x20, nul < 0 ? head.length : nul).trim(), needed: null };
  let disc;
  try {
    disc = new Disc(file);
    result.needed = disc.storedSize(disc.dataEnd());
  } catch (_) { /* the file ends before its file system table, or the table is damaged */ }
  finally { disc?.close(); }
  return result;
}

// The disc's file system table: path (lower case, "/"-separated) -> { offset, size }.
function parseFst(fst) {
  const count = fst.readUInt32BE(8), strings = count * 12;
  const files = new Map();
  const name = at => { const start = strings + at; return fst.toString('latin1', start, fst.indexOf(0, start)); };
  const dirs = [{ end: count, path: '' }];
  for (let i = 1; i < count; i++) {
    while (i >= dirs[dirs.length - 1].end) dirs.pop();
    const word = fst.readUInt32BE(i * 12), isDir = word >>> 24 === 1;
    const full = dirs[dirs.length - 1].path + name(word & 0xffffff);
    if (isDir) dirs.push({ end: fst.readUInt32BE(i * 12 + 8), path: `${full}/` });
    else files.set(full.toLowerCase(), { offset: fst.readUInt32BE(i * 12 + 4), size: fst.readUInt32BE(i * 12 + 8) });
  }
  return files;
}

module.exports = { Disc, parseFst, describe };
