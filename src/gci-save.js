'use strict';

const fs = require('node:fs');
const path = require('node:path');
const saves = require('./saves');

const HEADER = 0x40;
const BLOCK = 0x2000;
const NAME = 'super_mario_sunshine';
const SIZE = 7 * BLOCK;
// Both keep their main save as super_mario_sunshine. The port stores files of
// games other than GMSE01 with the game ID first (sms-pc-port's disk_name).
const GAMES = {
  GMSE01: { game: 'sunshine', title: 'Super Mario Sunshine', file: NAME },
  GMSE04: { game: 'eclipse', title: 'Super Mario Eclipse', file: `GMSE04_${NAME}` },
};

// Eclipse's other card files, beside its game save.
const SETTINGS = {
  super_mario_eclipse: "Super Mario Eclipse's settings",
  better_sunshine_engine: "Super Mario Eclipse's engine settings",
  better_sunshine_moveset: "Super Mario Eclipse's moveset settings",
};

// A card file that is not a Sunshine or Eclipse game save; reason is the short form.
function otherFile(message, reason) {
  return Object.assign(new Error(message), { code: 'OTHER_FILE', reason });
}

// Each of the three save files' progress, or null for a file never saved: its Shines (the count the game
// writes in the file's header, Super Mario Eclipse's 240 included) and its blue coins (the flags the game
// counts for them, TFlagManager::correctFlag; Eclipse clears the ones past its own).
// Sector 0 holds the banner and options; each save file is a pair of sectors
// (1-2, 3-4, 5-6) and the game uses the intact one written last.
const BLUE_COIN_FLAGS = [0x78, 0x365];
function fileProgress(data, badBlocks = checksumFailures(data)) {
  return [0, 1, 2].map(file => {
    let newest = null;
    for (const sector of [1 + 2 * file, 2 + 2 * file]) {
      const start = sector * BLOCK;
      if (badBlocks.includes(sector + 1) || start + BLOCK > data.length) continue;
      if (data.readUInt32BE(start + 4) !== 4) continue; // TFlagManager's save magic
      const writes = data.readUInt32BE(start);
      if (!newest || writes > newest.writes) newest = { writes, start };
    }
    if (!newest) return null;
    // the card's flags (mCardBools) follow the 0x60-byte header, eight to a byte, lowest bit first
    const flags = newest.start + 0x60;
    let blueCoins = 0;
    for (let flag = BLUE_COIN_FLAGS[0]; flag <= BLUE_COIN_FLAGS[1]; flag++) blueCoins += (data[flags + (flag >> 3)] >> (flag & 7)) & 1;
    return { shines: data.readUInt16BE(newest.start + 0x1c), blueCoins };
  });
}

// The blocks (1 to 7) whose checksums don't match. Sunshine does not normalize 0xffff to zero (unlike card
// filesystem checksums).
function checksumFailures(data) {
  const bad = [];
  for (let block = 0; block * BLOCK + BLOCK <= data.length && block < 7; block++) {
    const start = block * BLOCK;
    let sum = 0, inverted = 0;
    for (let offset = 0; offset < BLOCK - 4; offset += 2) {
      const word = data.readUInt16BE(start + offset);
      sum = (sum + word) & 0xffff;
      inverted = (inverted + (word ^ 0xffff)) & 0xffff;
    }
    if (data.readUInt16BE(start + BLOCK - 4) !== sum ||
        data.readUInt16BE(start + BLOCK - 2) !== inverted) bad.push(block + 1);
  }
  return bad;
}

// The Sunshine and Eclipse saves in a memory card folder (the card or a backup's copy of it), each game's
// three files as fileProgress gives them. Games without a save there are left out.
function cardProgress(dir) {
  return Object.values(GAMES).flatMap(({ game, title, file }) => {
    let data;
    try { data = fs.readFileSync(path.join(dir, `${file}.dat`)); } catch (_) { return []; }
    if (data.length < SIZE) return [];
    return [{ game, title, files: fileProgress(data) }];
  });
}

// GCI is a big-endian GameCube directory entry followed by the unchanged
// card file data. CARDStat is the port's 108-byte, little-endian host struct.
// Format references: Dolphin's GCMemcard.h and sms-pc-port/platform/card/card.cpp.
function convertGci(bytes) {
  const sizeError = () => new Error('Choose a Super Mario Sunshine .gci export (64-byte header and seven save blocks).');
  if (!Buffer.isBuffer(bytes) || bytes.length < HEADER) throw sizeError();
  const game = GAMES[bytes.toString('latin1', 0, 6)];
  const filename = bytes.subarray(8, 40);
  const end = filename.indexOf(0);
  const name = filename.subarray(0, end < 0 ? 32 : end).toString('latin1');
  // A whole export of another card file (its size matches its block count), or
  // one the size of a game save: say what it is rather than only that it is the wrong size.
  if (bytes.length === HEADER + SIZE || bytes.length === HEADER + bytes.readUInt16BE(0x38) * BLOCK) {
    if (game && Object.hasOwn(SETTINGS, name))
      throw otherFile(`This file holds ${SETTINGS[name]}, not game progress. Super Mario Eclipse keeps its progress in 04-GMSE-super_mario_sunshine.gci.`, 'Eclipse settings, not a game save');
    if (!game)
      throw otherFile('This importer supports North American Super Mario Sunshine (01-GMSE) and Super Mario Eclipse (04-GMSE) saves. Export the matching save from Dolphin.', 'not a Sunshine or Eclipse save');
    if (name !== NAME)
      throw otherFile('This is not the super_mario_sunshine save. Choose the Sunshine game save exported from Dolphin.', 'not a Sunshine or Eclipse game save');
  }
  if (bytes.length !== HEADER + SIZE) throw sizeError();
  if (bytes.readUInt16BE(0x38) !== 7)
    throw new Error('The GCI block count does not match its save data. Export the save again from Dolphin.');
  const icon = bytes.readUInt32BE(0x2c), comment = bytes.readUInt32BE(0x3c);
  if (icon === 0xffffffff || icon >= BLOCK || comment === 0xffffffff || comment > BLOCK - 64)
    throw new Error('The GCI banner or comment metadata is invalid. Export the save again from Dolphin.');

  const data = Buffer.from(bytes.subarray(HEADER));
  const badBlocks = checksumFailures(data);
  const shines = fileProgress(data, badBlocks).map(file => file && file.shines);
  if (shines.every(count => count === null))
    throw Object.assign(new Error(`This ${game.title} save has no saved progress in any of its three files.` +
      (game === GAMES.GMSE01 ? ' If you play Super Mario Eclipse in Dolphin, choose its 04-GMSE-super_mario_sunshine.gci instead.' : '')),
    { code: 'NO_PROGRESS', reason: `${game.title} save with no saved progress` });
  const stat = Buffer.alloc(0x6c);
  stat.write(NAME, 0);
  stat.writeUInt32LE(data.length, 0x20);
  stat.writeUInt32LE(bytes.readUInt32BE(0x28), 0x24);
  bytes.copy(stat, 0x28, 0, 6);
  stat[0x2e] = bytes[7];
  stat.writeUInt32LE(icon, 0x30);
  stat.writeUInt16LE(bytes.readUInt16BE(0x30), 0x34);
  stat.writeUInt16LE(bytes.readUInt16BE(0x32), 0x36);
  stat.writeUInt32LE(comment, 0x38);
  // The host card backend leaves derived icon offsets zero when creating saves.
  return { name: game.file, game: game.game, title: game.title, data, stat, badBlocks, shines };
}

function readGci(file) {
  if (typeof file !== 'string' || path.extname(file).toLowerCase() !== '.gci')
    throw new Error('Choose a Dolphin .gci save file.');
  const fd = fs.openSync(file, 'r');
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Choose a Dolphin .gci save file.');
    const bytes = Buffer.alloc(HEADER + SIZE + 1);
    let length = 0, received;
    while (length < bytes.length && (received = fs.readSync(fd, bytes, length, bytes.length - length, null)))
      length += received;
    return convertGci(bytes.subarray(0, length));
  } finally { fs.closeSync(fd); }
}

// Reads every .gci among files, a dropped folder standing for the .gci files in
// it. Among several, other card files and empty saves are skipped (a player's
// card folder holds both, beside the save with progress); a broken file, or a
// single file that cannot be imported, stops the import.
function readGciFiles(files) {
  files = files.flatMap(file => typeof file === 'string' && fs.statSync(file, { throwIfNoEntry: false })?.isDirectory()
    ? fs.readdirSync(file).filter(name => /\.gci$/i.test(name)).sort().map(name => path.join(file, name)) : [file]);
  if (!files.length) throw new Error('That folder has no Dolphin .gci save files.');
  const found = [], skipped = [];
  for (const file of files) {
    try { found.push({ file, converted: readGci(file) }); }
    catch (error) {
      if (files.length === 1) throw error;
      if (!['NO_PROGRESS', 'OTHER_FILE'].includes(error.code))
        throw new Error(`${path.basename(String(file))}: ${error.message}`, { cause: error });
      skipped.push({ file: path.basename(file), reason: error.reason });
    }
  }
  if (!found.length) throw new Error('None of these files has Sunshine or Eclipse progress to import. Super Mario Eclipse keeps its progress in 04-GMSE-super_mario_sunshine.gci.');
  if (new Set(found.map(save => save.converted.name)).size !== found.length)
    throw new Error('Choose one Dolphin save for each game: these include two saves for the same game.');
  return { found, skipped };
}

function importGci(converted, saveDir, backups = saves.backupRoot()) {
  return writeCardFile(converted, saveDir, backups, 'before-dolphin-import');
}

// A game save file (name, data, stat) put on the card, with its index entry, after a verified backup.
function writeCardFile(converted, saveDir, backups, reason) {
  // Complete all validation and a verified backup before changing the card.
  const previous = saves.backupSaves(saveDir, backups, reason);
  const indexFile = path.join(saveDir, 'index.txt');
  const index = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
  const entries = index ? index.split('\n') : [];
  while (entries.length && entries.at(-1) === '') entries.pop();
  if (entries.length > 127 || entries.some(name => name && !/^[A-Za-z0-9_.-]+$/.test(name)))
    throw new Error('The memory card index is invalid. Your current saves have been kept.');
  if (!entries.includes(converted.name)) {
    const empty = entries.indexOf('');
    if (empty >= 0) entries[empty] = converted.name;
    else {
      if (entries.length >= 127) throw new Error('The memory card has no free file slots.');
      entries.push(converted.name);
    }
  }
  const blocks = entries.filter(name => name && name !== converted.name).reduce((total, name) => {
    const file = path.join(saveDir, `${name}.dat`);
    return total + (fs.existsSync(file) ? Math.ceil(fs.statSync(file).size / BLOCK) : 0);
  }, 7);
  if (blocks > 59) throw new Error('The memory card needs seven free blocks for this save.');
  const files = new Map([[`${converted.name}.dat`, converted.data], [`${converted.name}.stat`, converted.stat],
    ['index.txt', Buffer.from(`${entries.join('\n')}\n`)]]);
  fs.mkdirSync(saveDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(saveDir, '.dolphin-import-'));
  const replaced = [];
  const originals = new Map();
  try {
    for (const [name, bytes] of files) {
      const target = path.join(saveDir, name);
      originals.set(name, fs.existsSync(target) ? fs.readFileSync(target) : null);
      fs.writeFileSync(path.join(staging, name), bytes, { flag: 'wx', mode: 0o600 });
    }
    // Publish the index last, after both files are ready for the card backend.
    for (const name of files.keys()) {
      fs.renameSync(path.join(staging, name), path.join(saveDir, name));
      replaced.push(name);
    }
  } catch (error) {
    try {
      for (const name of replaced.reverse()) {
        const original = originals.get(name), target = path.join(saveDir, name);
        if (original === null) fs.rmSync(target);
        else fs.writeFileSync(target, original);
      }
    } catch (rollback) {
      throw new Error(`Import failed and could not restore every file: ${rollback.message}. Your backup is at ${previous.directory || backups}.`, { cause: error });
    }
    throw error;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  return { name: converted.name, directory: saveDir, previous: previous.directory || null };
}

// Sets a block's two checksums (the game's TCardSector::setCheckSum, as checksumFailures reads them).
function writeChecksum(block) {
  let sum = 0, inverted = 0;
  for (let offset = 0; offset < BLOCK - 4; offset += 2) {
    const word = block.readUInt16BE(offset);
    sum = (sum + word) & 0xffff;
    inverted = (inverted + (word ^ 0xffff)) & 0xffff;
  }
  block.writeUInt16BE(sum, BLOCK - 4);
  block.writeUInt16BE(inverted, BLOCK - 2);
}

function readCardSave(saveDir, game) {
  const base = path.join(saveDir, game.file);
  let data;
  try { data = fs.readFileSync(`${base}.dat`); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (data.length !== SIZE) throw new Error(`Your ${game.title} save is not a ${SIZE / BLOCK}-block game save, so it was left as it is.`);
  let stat;
  try { stat = fs.readFileSync(`${base}.stat`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!stat || stat.length !== 0x6c) throw new Error(`Your ${game.title} save has no valid card status file, so it was left as it is.`);
  return { data, stat, files: fileProgress(data) };
}

// Both games' saves on the card, for copying Sunshine progress into Eclipse: each one's three files
// (fileProgress), or null for a game with no save there.
function eclipseCopyInfo(saveDir) {
  const sunshine = readCardSave(saveDir, GAMES.GMSE01), eclipse = readCardSave(saveDir, GAMES.GMSE04);
  return { sunshine: sunshine && sunshine.files, eclipse: eclipse && eclipse.files };
}

// Super Mario Eclipse keeps Sunshine's save layout: Shines 0-119, the blue coins and the other flags mean the same in
// both games, and Eclipse's own Shines are in bytes Sunshine leaves zero (BetterSMS extendcount.cpp). So Sunshine's file
// `from` (0-2 for A-C) copies into Eclipse's file `to` whole: both sectors of the pair, as written, with their write counts.
// Eclipse's other files and its options stay. Without an Eclipse save yet, one is made from Sunshine's: its options
// sector (Eclipse writes its own banner over it with its next save), the copied file, and two empty files.
function sunshineToEclipse(saveDir, from, to) {
  if (![0, 1, 2].includes(from) || ![0, 1, 2].includes(to)) throw new Error('Choose files A, B or C.');
  const sunshine = readCardSave(saveDir, GAMES.GMSE01);
  if (!sunshine) throw new Error('There is no Super Mario Sunshine save on this memory card to copy.');
  if (!sunshine.files[from]) throw new Error(`Super Mario Sunshine's file ${'ABC'[from]} has no saved progress to copy.`);
  const eclipse = readCardSave(saveDir, GAMES.GMSE04);
  let data, stat;
  if (eclipse) {
    data = Buffer.from(eclipse.data);
    stat = eclipse.stat;
  } else {
    data = Buffer.alloc(SIZE);
    sunshine.data.copy(data, 0, 0, BLOCK);
    for (let sector = 1; sector < 7; sector++) writeChecksum(data.subarray(sector * BLOCK, (sector + 1) * BLOCK));
    // The card file's owner (GMSE, maker 04) is what keeps Eclipse's save apart on the card.
    stat = Buffer.from(sunshine.stat);
    stat.write('04', 0x2c, 'latin1');
  }
  sunshine.data.copy(data, (1 + 2 * to) * BLOCK, (1 + 2 * from) * BLOCK, (3 + 2 * from) * BLOCK);
  return { name: GAMES.GMSE04.file, game: 'eclipse', title: GAMES.GMSE04.title, data, stat,
    copied: sunshine.files[from], replaced: eclipse ? eclipse.files[to] : null };
}

function copyToEclipse(saveDir, from, to, backups = saves.backupRoot()) {
  const copy = sunshineToEclipse(saveDir, from, to);
  const result = writeCardFile(copy, saveDir, backups, 'before-eclipse-copy');
  return { ...result, copied: copy.copied, replaced: copy.replaced };
}

module.exports = { convertGci, readGci, readGciFiles, importGci, fileProgress, cardProgress, eclipseCopyInfo, sunshineToEclipse, copyToEclipse };
