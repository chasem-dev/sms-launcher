'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { convertGci, readGci, readGciFiles, importGci, cardProgress } = require('../src/gci-save');
const saves = require('../src/saves');

function fixture() {
  const bytes = Buffer.alloc(0x40 + 7 * 0x2000);
  bytes.write('GMSE01');
  bytes[7] = 1;
  bytes.write('super_mario_sunshine', 8);
  bytes.writeUInt32BE(0x12345678, 0x28);
  bytes.writeUInt32BE(0x44, 0x2c);
  bytes.writeUInt16BE(5, 0x30);
  bytes.writeUInt16BE(15, 0x32);
  bytes.writeUInt16BE(7, 0x38);
  bytes.writeUInt32BE(4, 0x3c);
  // Independent checksum fixture: one 0xffff word and 4093 zero words.
  // Sunshine stores the sum 0xffff unchanged; the complement sum is 0xf003.
  for (let block = 0; block < 7; block++) {
    const start = 0x40 + block * 0x2000;
    bytes.writeUInt16BE(0xffff, start);
    bytes.writeUInt16BE(0xffff, start + 0x1ffc);
    bytes.writeUInt16BE(0xf003, start + 0x1ffe);
  }
  // File A: a TFlagManager save (magic 4) with 3 Shines, written twice.
  setSector(bytes, 1, sector => { sector.writeUInt32BE(2, 0); sector.writeUInt32BE(4, 4); sector.writeUInt16BE(3, 0x1c); });
  return bytes;
}

function setSector(bytes, index, change) {
  const sector = bytes.subarray(0x40 + index * 0x2000, 0x40 + (index + 1) * 0x2000);
  sector.fill(0); change(sector);
  let sum = 0, inverted = 0;
  for (let offset = 0; offset < 0x1ffc; offset += 2) {
    sum = (sum + sector.readUInt16BE(offset)) & 0xffff;
    inverted = (inverted + (~sector.readUInt16BE(offset) & 0xffff)) & 0xffff;
  }
  sector.writeUInt16BE(sum, 0x1ffc); sector.writeUInt16BE(inverted, 0x1ffe);
}

// A European export: its ID, and its language in sector 0's options (stored plus one; 5 is Italian).
function pal(language = 5) {
  const bytes = fixture(); bytes.write('GMSP01');
  setSector(bytes, 0, sector => { sector.writeUInt32BE(2, 0x1844); sector[0x1848] = 0b101; sector.writeUInt32BE(language, 0x1849); });
  return bytes;
}

function eclipse() {
  const bytes = fixture(); bytes.write('04', 4);
  return bytes;
}

function temporary(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-dolphin-import-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, card: path.join(root, 'custom card'), backups: path.join(root, 'backups') };
}

function readCard(card) {
  return Object.fromEntries(fs.readdirSync(card).map(name => [name, fs.readFileSync(path.join(card, name))]));
}

test('GCI conversion preserves every payload byte and maps big-endian metadata to host CARDStat', () => {
  const bytes = fixture();
  const result = convertGci(bytes);
  assert.deepEqual(result.data, bytes.subarray(0x40));
  assert.deepEqual(result.badBlocks, []);
  assert.equal(result.stat.length, 108);
  assert.equal(result.stat.toString('ascii', 0, 20), 'super_mario_sunshine');
  assert.equal(result.stat.readUInt32LE(0x20), 57344);
  assert.equal(result.stat.readUInt32LE(0x24), 0x12345678);
  assert.equal(result.stat.toString('ascii', 0x28, 0x2e), 'GMSE01');
  assert.equal(result.stat[0x2e], 1);
  assert.equal(result.stat.readUInt32LE(0x30), 0x44);
  assert.equal(result.stat.readUInt16LE(0x34), 5);
  assert.equal(result.stat.readUInt16LE(0x36), 15);
  assert.equal(result.stat.readUInt32LE(0x38), 4);
  assert.equal(result.name, 'super_mario_sunshine');
  assert.deepEqual(result.shines, [3, null, null]);
  bytes[0x40] = 0;
  assert.equal(result.data[0], 0xff);
});

test('reports each file\'s Shines from its newest intact copy', () => {
  const bytes = fixture();
  setSector(bytes, 2, sector => { sector.writeUInt32BE(3, 0); sector.writeUInt32BE(4, 4); sector.writeUInt16BE(5, 0x1c); });
  setSector(bytes, 6, sector => { sector.writeUInt32BE(1, 0); sector.writeUInt32BE(4, 4); });
  assert.deepEqual(convertGci(bytes).shines, [5, null, 0]);
  bytes[0x40 + 2 * 0x2000 + 0x100] = 1;
  assert.deepEqual(convertGci(bytes).shines, [3, null, 0]);
});

test('rejects a save with no progress in any file, pointing Sunshine exports at Eclipse\'s', () => {
  const bytes = fixture(); setSector(bytes, 1, () => {});
  assert.throws(() => convertGci(bytes), /no saved progress.*04-GMSE-super_mario_sunshine\.gci/);
  bytes.write('04', 4);
  assert.throws(() => convertGci(bytes), err => /Super Mario Eclipse save has no saved progress/.test(err.message) && !/04-GMSE/.test(err.message));
});

test('Super Mario Eclipse saves (GMSE04) keep their ID and go to the port\'s GMSE04 card file', context => {
  const result = convertGci(eclipse());
  assert.equal(result.name, 'GMSE04_super_mario_sunshine');
  assert.equal(result.title, 'Super Mario Eclipse');
  assert.equal(result.stat.toString('ascii', 0, 20), 'super_mario_sunshine');
  assert.equal(result.stat.toString('ascii', 0x28, 0x2e), 'GMSE04');
  const { card, backups } = temporary(context); fs.mkdirSync(card);
  fs.writeFileSync(path.join(card, 'index.txt'), 'super_mario_sunshine\nGMSE04_super_mario_eclipse\n');
  fs.writeFileSync(path.join(card, 'super_mario_sunshine.dat'), 'vanilla progress');
  fs.writeFileSync(path.join(card, 'super_mario_sunshine.stat'), Buffer.alloc(108));
  importGci(result, card, backups);
  assert.equal(fs.readFileSync(path.join(card, 'index.txt'), 'utf8'),
    'super_mario_sunshine\nGMSE04_super_mario_eclipse\nGMSE04_super_mario_sunshine\n');
  assert.equal(fs.readFileSync(path.join(card, 'super_mario_sunshine.dat'), 'utf8'), 'vanilla progress');
  assert.deepEqual(fs.readFileSync(path.join(card, 'GMSE04_super_mario_sunshine.dat')), eclipse().subarray(0x40));
  assert.deepEqual(fs.readFileSync(path.join(card, 'GMSE04_super_mario_sunshine.stat')), result.stat);
});

test('a European save (GMSP01) imports as the North American one, with its language cleared', () => {
  const source = pal(), before = Buffer.from(source);
  const result = convertGci(source);
  assert.deepEqual(source, before);
  assert.equal(result.name, 'super_mario_sunshine');
  assert.equal(result.game, 'sunshine');
  assert.equal(result.stat.toString('latin1', 0x28, 0x2e), 'GMSE01');
  assert.deepEqual(result.badBlocks, []);
  assert.deepEqual(result.shines, [3, null, null]);
  // Exactly the language's four bytes and sector 0's checksum change, and the other options stay.
  const sum = 0x1ffc;
  const changed = [...result.data.keys()].filter(offset => result.data[offset] !== before[0x40 + offset]);
  assert.ok(changed.every(offset => (offset >= 0x1849 && offset < 0x184d) || (offset >= sum && offset < sum + 4)), changed.join());
  assert.equal(result.data.readUInt32BE(0x1849), 0);
  assert.equal(result.data[0x1848], 0b101);
});

test('a European save converts to what the North American game would have written', () => {
  const northAmerican = fixture();
  setSector(northAmerican, 0, sector => { sector.writeUInt32BE(2, 0x1844); sector[0x1848] = 0b101; });
  for (const language of [0, 1, 5, 0xd9e01]) // the console's language, English, Italian, and shinehax's value
    assert.deepEqual(convertGci(pal(language)).data, convertGci(northAmerican).data);
});

test('a European save with a damaged options sector still warns', () => {
  const bytes = pal(); bytes[0x40 + 10] ^= 1;
  assert.deepEqual(convertGci(bytes).badBlocks, [1]);
});

test('a European save goes onto the card as Sunshine\'s save, and counts as the same game as a North American one', context => {
  const { root, card, backups } = temporary(context);
  importGci(convertGci(pal()), card, backups);
  assert.deepEqual(cardProgress(card).map(save => [save.game, save.files[0].shines]), [['sunshine', 3]]);
  assert.equal(fs.readFileSync(path.join(card, 'index.txt'), 'utf8'), 'super_mario_sunshine\n');
  const european = path.join(root, '01-GMSP-super_mario_sunshine.gci'), american = path.join(root, '01-GMSE-super_mario_sunshine.gci');
  fs.writeFileSync(european, pal()); fs.writeFileSync(american, fixture());
  assert.throws(() => readGciFiles([european, american]), /two saves for the same game/);
});

test('a European save with nothing in it is not imported', () => {
  const bytes = pal();
  setSector(bytes, 1, () => {});
  assert.throws(() => convertGci(bytes), error => error.code === 'NO_PROGRESS');
});

test('corrupt block checksums warn without changing or repairing save data', () => {
  const bytes = fixture(); bytes[0x40 + 2 * 0x2000 + 10] = 1;
  const result = convertGci(bytes);
  assert.deepEqual(result.badBlocks, [3]);
  assert.deepEqual(result.data, bytes.subarray(0x40));
});

test('rejects raw cards, truncated files, foreign games/regions, unsafe names and malformed metadata', () => {
  const bytes = fixture();
  for (const input of [Buffer.alloc(0), bytes.subarray(0x40), bytes.subarray(0, bytes.length - 1),
    Buffer.concat([bytes, Buffer.alloc(1)])]) assert.throws(() => convertGci(input), /seven save blocks/);
  for (const [offset, value, message] of [[0, 'GZLE01', /North American/], [0, 'GMSJ01', /North American/], [0, 'GMSE02', /North American/],
    [8, '../../outside', /not the super/]]) {
    const input = Buffer.from(bytes); input.write(value, offset);
    assert.throws(() => convertGci(input), message);
  }
  const count = Buffer.from(bytes); count.writeUInt16BE(8, 0x38);
  assert.throws(() => convertGci(count), /block count/);
  for (const offset of [0x2c, 0x3c]) {
    const input = Buffer.from(bytes); input.writeUInt32BE(0xffffffff, offset);
    assert.throws(() => convertGci(input), /metadata/);
  }
});

test('reads a .GCI file with spaces and leaves the source unchanged', context => {
  const { root } = temporary(context);
  const file = path.join(root, 'Dolphin exported save.GCI');
  const bytes = fixture(); fs.writeFileSync(file, bytes);
  assert.deepEqual(readGci(file).data, bytes.subarray(0x40));
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.throws(() => readGci(path.join(root, 'save.raw')), /\.gci/);
});

test('fresh custom card gets the payload, host metadata and a discoverable index', context => {
  const { card, backups } = temporary(context);
  const result = importGci(convertGci(fixture()), card, backups);
  assert.equal(result.previous, null);
  assert.equal(fs.readFileSync(path.join(card, 'index.txt'), 'utf8'), 'super_mario_sunshine\n');
  assert.deepEqual(fs.readFileSync(path.join(card, 'super_mario_sunshine.dat')), fixture().subarray(0x40));
  assert.equal(fs.statSync(path.join(card, 'super_mario_sunshine.stat')).size, 108);
  assert.equal(fs.readdirSync(card).length, 3);
});

test('replacement backs up all current saves, preserves other games and index slots, and is restorable', context => {
  const { card, backups } = temporary(context);
  fs.mkdirSync(card);
  fs.writeFileSync(path.join(card, 'index.txt'), 'other_game\n\nsuper_mario_sunshine\n');
  fs.writeFileSync(path.join(card, 'other_game.dat'), Buffer.from('other progress'));
  fs.writeFileSync(path.join(card, 'other_game.stat'), Buffer.alloc(108));
  fs.writeFileSync(path.join(card, 'super_mario_sunshine.dat'), 'previous Sunshine progress');
  fs.writeFileSync(path.join(card, 'super_mario_sunshine.stat'), Buffer.alloc(108, 42));
  const original = readCard(card);
  const result = importGci(convertGci(fixture()), card, backups);
  assert.ok(result.previous);
  assert.deepEqual(fs.readFileSync(path.join(card, 'other_game.dat')), original['other_game.dat']);
  assert.deepEqual(fs.readFileSync(path.join(card, 'index.txt')), original['index.txt']);
  const backup = saves.listBackups(backups)[0];
  assert.equal(backup.reason, 'before-dolphin-import');
  saves.restoreBackup(backup.id, card, backups);
  assert.deepEqual(readCard(card), original);
});

test('adds a new save into an empty index slot without moving other saves', context => {
  const { card, backups } = temporary(context); fs.mkdirSync(card);
  fs.writeFileSync(path.join(card, 'index.txt'), 'other_game\n\nsecond_game\n');
  importGci(convertGci(fixture()), card, backups);
  assert.equal(fs.readFileSync(path.join(card, 'index.txt'), 'utf8'), 'other_game\nsuper_mario_sunshine\nsecond_game\n');
});

test('backup failure prevents any card mutation', context => {
  const { card, backups } = temporary(context); fs.mkdirSync(card);
  fs.writeFileSync(path.join(card, 'super_mario_sunshine.dat'), 'current');
  fs.writeFileSync(backups, 'cannot be a backup folder');
  const original = readCard(card);
  assert.throws(() => importGci(convertGci(fixture()), card, backups));
  assert.deepEqual(readCard(card), original);
});

for (const fresh of [false, true]) test(`failed publication rolls back ${fresh ? 'fresh' : 'existing'} card`, context => {
  const { card, backups } = temporary(context); fs.mkdirSync(card);
  if (!fresh) {
    fs.writeFileSync(path.join(card, 'super_mario_sunshine.dat'), 'current');
    fs.writeFileSync(path.join(card, 'super_mario_sunshine.stat'), 'metadata');
    fs.writeFileSync(path.join(card, 'index.txt'), 'super_mario_sunshine\n');
  }
  const original = readCard(card), rename = fs.renameSync;
  context.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from).includes('.dolphin-import-') && String(to).endsWith('.stat'))
      throw new Error('injected write failure');
    return rename(from, to);
  });
  assert.throws(() => importGci(convertGci(fixture()), card, backups), /injected write failure/);
  assert.deepEqual(readCard(card), original);
});

test('full or malformed cards and symlink entries are rejected without changing progress', context => {
  const { card, backups } = temporary(context); fs.mkdirSync(card);
  fs.writeFileSync(path.join(card, 'index.txt'), 'other_game\n');
  fs.writeFileSync(path.join(card, 'other_game.dat'), Buffer.alloc(53 * 0x2000));
  const original = readCard(card);
  assert.throws(() => importGci(convertGci(fixture()), card, backups), /seven free blocks/);
  assert.deepEqual(readCard(card), original);
  fs.writeFileSync(path.join(card, 'index.txt'), '../outside\n');
  assert.throws(() => importGci(convertGci(fixture()), card, backups), /index is invalid/);
  fs.writeFileSync(path.join(card, 'index.txt'), Array.from({ length: 127 }, (_, i) => `file${i}`).join('\n'));
  assert.throws(() => importGci(convertGci(fixture()), card, backups), /no free file slots/);
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join(card, 'other_game.dat'), path.join(card, 'link.dat'));
    assert.throws(() => importGci(convertGci(fixture()), card, backups), /symbolic link/);
  }
});

function otherCardFile(id, name) {
  const bytes = Buffer.alloc(0x40 + 0x2000);
  bytes.write(id); bytes[6] = 0xff; bytes[7] = 1; bytes.write(name, 8);
  bytes.writeUInt32BE(0x44, 0x2c); bytes.writeUInt16BE(1, 0x38); bytes.writeUInt32BE(4, 0x3c);
  return bytes;
}

test('names Eclipse settings files and other games\' card files instead of reporting a size problem', () => {
  for (const name of ['super_mario_eclipse', 'better_sunshine_engine', 'better_sunshine_moveset'])
    assert.throws(() => convertGci(otherCardFile('GMSE04', name)),
      error => error.code === 'OTHER_FILE' && /settings, not game progress.*04-GMSE-super_mario_sunshine\.gci/.test(error.message));
  assert.throws(() => convertGci(otherCardFile('GMSM01', 'sunshine_mirror_mode')), error => error.code === 'OTHER_FILE' && /North American/.test(error.message));
  assert.throws(() => convertGci(otherCardFile('GMSE04', 'super_mario_eclipse').subarray(0, 100)), error => !error.code && /seven save blocks/.test(error.message));
});

test('a dropped card folder imports the save with progress and skips the other files', context => {
  const { root } = temporary(context);
  const folder = path.join(root, 'Card A'); fs.mkdirSync(folder);
  const empty = fixture(); setSector(empty, 1, () => {});
  fs.writeFileSync(path.join(folder, '01-GMSE-super_mario_sunshine.gci'), empty);
  fs.writeFileSync(path.join(folder, '04-GMSE-super_mario_sunshine.gci'), eclipse());
  fs.writeFileSync(path.join(folder, '04-GMSE-super_mario_eclipse.gci'), otherCardFile('GMSE04', 'super_mario_eclipse'));
  fs.writeFileSync(path.join(folder, '01-GMSM-sunshine_mirror_mode_0.gci'), otherCardFile('GMSM01', 'sunshine_mirror_mode'));
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'not a save');
  const { found, skipped } = readGciFiles([folder]);
  assert.deepEqual(found.map(save => [path.basename(save.file), save.converted.name, save.converted.shines]),
    [['04-GMSE-super_mario_sunshine.gci', 'GMSE04_super_mario_sunshine', [3, null, null]]]);
  assert.deepEqual(skipped, [
    { file: '01-GMSE-super_mario_sunshine.gci', reason: 'Super Mario Sunshine save with no saved progress' },
    { file: '01-GMSM-sunshine_mirror_mode_0.gci', reason: 'not a Sunshine or Eclipse save' },
    { file: '04-GMSE-super_mario_eclipse.gci', reason: 'Eclipse settings, not a game save' }]);
  // Alone, a file that cannot be imported says why; with others, a broken file stops the import.
  assert.throws(() => readGciFiles([path.join(folder, '04-GMSE-super_mario_eclipse.gci')]), /Eclipse's settings/);
  fs.writeFileSync(path.join(folder, 'broken.gci'), Buffer.alloc(10));
  assert.throws(() => readGciFiles([folder]), /^Error: broken\.gci: Choose a Super Mario Sunshine/);
  fs.rmSync(path.join(folder, 'broken.gci'));
  fs.writeFileSync(path.join(folder, 'copy of 04.gci'), eclipse());
  assert.throws(() => readGciFiles([folder]), /two saves for the same game/);
  const emptyFolder = path.join(root, 'empty'); fs.mkdirSync(emptyFolder);
  assert.throws(() => readGciFiles([emptyFolder]), /no Dolphin \.gci/);
  assert.throws(() => readGciFiles([path.join(folder, '01-GMSE-super_mario_sunshine.gci'), path.join(folder, '04-GMSE-super_mario_eclipse.gci')]), /None of these files has Sunshine or Eclipse progress/);
});

test('a card\'s saves give each file\'s Shines and blue coins, from the copy the game would load', () => {
  const { fileProgress, cardProgress } = require('../src/gci-save');
  const bytes = fixture();
  // File A's newer copy: 12 Shines and blue coins at the first and last of their flags (and one flag either side, not theirs)
  setSector(bytes, 2, sector => {
    sector.writeUInt32BE(3, 0); sector.writeUInt32BE(4, 4); sector.writeUInt16BE(12, 0x1c);
    for (const flag of [0x77, 0x78, 0x100, 0x365, 0x366]) sector[0x60 + (flag >> 3)] |= 1 << (flag & 7);
  });
  // File B: a newer copy whose checksum fails, so the older one counts
  setSector(bytes, 3, sector => { sector.writeUInt32BE(1, 0); sector.writeUInt32BE(4, 4); sector.writeUInt16BE(5, 0x1c); });
  setSector(bytes, 4, sector => { sector.writeUInt32BE(2, 0); sector.writeUInt32BE(4, 4); sector.writeUInt16BE(9, 0x1c); });
  bytes[0x40 + 4 * 0x2000 + 0x1c] ^= 0xff;
  const data = bytes.subarray(0x40);
  assert.deepEqual(fileProgress(data), [{ shines: 12, blueCoins: 3 }, { shines: 5, blueCoins: 0 }, null]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'card-progress-'));
  try {
    assert.deepEqual(cardProgress(dir), []);
    fs.writeFileSync(path.join(dir, 'GMSE04_super_mario_sunshine.dat'), data);
    fs.writeFileSync(path.join(dir, 'super_mario_sunshine.dat'), data.subarray(0, 0x2000));  // cut short: left out
    assert.deepEqual(cardProgress(dir), [{ game: 'eclipse', title: 'Super Mario Eclipse', files: fileProgress(data) }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('copies a Sunshine file into Eclipse whole, making Eclipse\'s save when it has none', context => {
  const { eclipseCopyInfo, copyToEclipse, fileProgress } = require('../src/gci-save');
  const { card, backups } = temporary(context);
  const sunshine = fixture();
  // File B: 20 Shines, both copies intact (the newer one is the second)
  setSector(sunshine, 3, sector => { sector.writeUInt32BE(5, 0); sector.writeUInt32BE(4, 4); sector.writeUInt16BE(19, 0x1c); });
  setSector(sunshine, 4, sector => { sector.writeUInt32BE(6, 0); sector.writeUInt32BE(4, 4); sector.writeUInt16BE(20, 0x1c); });
  importGci(convertGci(sunshine), card, backups);
  const before = readCard(card);
  assert.deepEqual(eclipseCopyInfo(card), { sunshine: [{ shines: 3, blueCoins: 0 }, { shines: 20, blueCoins: 0 }, null], eclipse: null });

  const result = copyToEclipse(card, 1, 0, backups);
  assert.deepEqual(result.copied, { shines: 20, blueCoins: 0 });
  assert.equal(result.replaced, null);
  const after = readCard(card);
  const data = after['GMSE04_super_mario_sunshine.dat'], source = before['super_mario_sunshine.dat'];
  assert.equal(data.length, 7 * 0x2000);
  assert.deepEqual(data.subarray(0, 0x2000), source.subarray(0, 0x2000));  // Sunshine's options sector
  assert.deepEqual(data.subarray(0x2000, 0x6000), source.subarray(0x6000, 0xa000));  // file B's pair, as written
  // files B and C empty, as the game makes them: zeros and a valid checksum
  for (let sector = 3; sector < 7; sector++) {
    const block = data.subarray(sector * 0x2000, (sector + 1) * 0x2000);
    assert.ok(block.subarray(0, 0x1ffc).every(byte => byte === 0));
    assert.equal(block.readUInt32BE(0x1ffc), 0x0000f002);
  }
  assert.deepEqual(fileProgress(data), [{ shines: 20, blueCoins: 0 }, null, null]);
  const stat = after['GMSE04_super_mario_sunshine.stat'];
  assert.equal(stat.toString('latin1', 0x28, 0x2e), 'GMSE04');
  assert.deepEqual(Buffer.concat([stat.subarray(0, 0x2c), stat.subarray(0x2e)]),
    Buffer.concat([before['super_mario_sunshine.stat'].subarray(0, 0x2c), before['super_mario_sunshine.stat'].subarray(0x2e)]));
  assert.equal(after['index.txt'].toString(), 'super_mario_sunshine\nGMSE04_super_mario_sunshine\n');
  // Sunshine's save is untouched, and the card as it was is in a backup
  assert.deepEqual(after['super_mario_sunshine.dat'], source);
  const backup = saves.listBackups(backups).find(item => item.id === path.basename(result.previous));
  assert.equal(backup.reason, 'before-eclipse-copy');
});

test('copying into an existing Eclipse save replaces only the chosen file', context => {
  const { eclipseCopyInfo, copyToEclipse } = require('../src/gci-save');
  const { card, backups } = temporary(context);
  const ecl = eclipse();
  setSector(ecl, 0, sector => sector.write('Eclipse options', 0));
  setSector(ecl, 3, sector => { sector.writeUInt32BE(9, 0); sector.writeUInt32BE(4, 4); sector.writeUInt16BE(150, 0x1c); });
  importGci(convertGci(ecl), card, backups);
  importGci(convertGci(fixture()), card, backups);
  const before = readCard(card);
  assert.deepEqual(eclipseCopyInfo(card).eclipse, [{ shines: 3, blueCoins: 0 }, { shines: 150, blueCoins: 0 }, null]);

  const result = copyToEclipse(card, 0, 2, backups);
  assert.equal(result.replaced, null);
  const after = readCard(card);
  const data = after['GMSE04_super_mario_sunshine.dat'], old = before['GMSE04_super_mario_sunshine.dat'];
  assert.deepEqual(data.subarray(0, 0xa000), old.subarray(0, 0xa000));  // options, files A and B kept
  assert.deepEqual(data.subarray(0xa000), before['super_mario_sunshine.dat'].subarray(0x2000, 0x6000));
  assert.deepEqual(after['GMSE04_super_mario_sunshine.stat'], before['GMSE04_super_mario_sunshine.stat']);
  assert.deepEqual(after['index.txt'], before['index.txt']);
  assert.deepEqual(eclipseCopyInfo(card).eclipse, [{ shines: 3, blueCoins: 0 }, { shines: 150, blueCoins: 0 }, { shines: 3, blueCoins: 0 }]);
  assert.deepEqual(copyToEclipse(card, 0, 1, backups).replaced, { shines: 150, blueCoins: 0 });
});

test('copying to Eclipse needs a Sunshine file with progress and leaves the card alone otherwise', context => {
  const { sunshineToEclipse, copyToEclipse } = require('../src/gci-save');
  const { card, backups } = temporary(context);
  fs.mkdirSync(card);
  assert.throws(() => copyToEclipse(card, 0, 0, backups), /no Super Mario Sunshine save/);
  importGci(convertGci(fixture()), card, backups);
  const before = readCard(card);
  assert.throws(() => copyToEclipse(card, 1, 1, backups), /file B has no saved progress/);
  assert.throws(() => sunshineToEclipse(card, 3, 0), /A, B or C/);
  assert.throws(() => sunshineToEclipse(card, 0, '0'), /A, B or C/);
  fs.writeFileSync(path.join(card, 'GMSE04_super_mario_sunshine.dat'), Buffer.alloc(0x2000));
  assert.throws(() => copyToEclipse(card, 0, 0, backups), /not a 7-block game save/);
  fs.rmSync(path.join(card, 'GMSE04_super_mario_sunshine.dat'));
  assert.deepEqual(readCard(card), before);
});
