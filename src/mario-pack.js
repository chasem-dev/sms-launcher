'use strict';

// Customize Mario in the game: Mario's textures repainted in the player's
// colours, written as a texture pack the game reads before every other one
// (SMS_MARIO_LOOK). Each image is named after the disc texture it replaces, as
// the game names pack textures; where an HD pack has that texture, its HD
// image is the one repainted, so Mario stays HD.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Disc } = require('./disc');
const { rarc } = require('./archive');
const j3d = require('./j3d');
const colors = require('./mario-colors');
const image = require('./texture-image');
const { xxh64 } = require('./xxh64');
const { partOf } = require('./mario-model');

// Bumped whenever baking changes, so older packs are made again.
const VERSION = 1;
// The parts' order when several cover one texel of the atlas.
const PRIORITY = ['cap', 'head', 'hands', 'feet', 'body', 'aloha', 'eye', 'mouth'];

// The game's pack name for a disc texture (gx_hires.cpp hiresName).
function packName({ width, height, mipmapped, level, format }) {
  return `tex1_${width}x${height}${mipmapped ? '_m' : ''}_${xxh64(level)}_${format}`;
}

// Every texture Mario's colours touch: its pack name, its disc pixels, and the
// parts (with their triangles) drawn with it. Eyes have five blink frames,
// drawn with the same triangles.
function targets(model) {
  const byName = new Map();
  const eyeFrames = model.textures.filter(t => /^H_ma_eye\d/i.test(t.name));
  model.shapes.forEach((shape, i) => {
    const part = partOf(shape, model, i);
    if (!colors.PARTS[part]) return;
    const material = model.materials[shape.material];
    const sources = part === 'eye' ? eyeFrames : [model.textures[material.textures[0]]];
    for (const source of sources) {
      const name = packName(source);
      if (!byName.has(name)) byName.set(name, { name, source, parts: new Map() });
      const parts = byName.get(name).parts;
      if (!parts.has(part)) parts.set(part, []);
      parts.get(part).push(shape);
    }
  });
  return [...byName.values()];
}

// The images the game would load for each name, from these pack folders, in
// the game's order (the first folder with a name wins).
function packIndex(directories) {
  const index = new Map();
  const walk = directory => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      // Folders linked into a pack count, as the game follows them.
      let folder = entry.isDirectory();
      if (entry.isSymbolicLink()) try { folder = fs.statSync(file).isDirectory(); } catch (_) { continue; }
      if (folder) { if (entry.name !== 'widescreen_stars_fix') walk(file); continue; }
      const match = /^(tex1_.+?)(_arb)?\.(png|dds)$/i.exec(entry.name);
      if (match && !index.has(match[1])) index.set(match[1], file);
    }
  };
  for (const directory of directories) walk(directory);
  return index;
}

// One texture's paint map, which the chosen colours don't change: each texel's
// region (255: kept as it is on the disc), the neighbouring region it blends
// into on a border and how much (blendEdges), and its lightness. A texel two
// parts cover is the first part's (by PRIORITY).
function paintMap({ width, height, rgba }, parts, references, { wrapS = 0, wrapT = 0 } = {}) {
  const lightness = colors.lightness(rgba), size = width * height;
  const mask = new Uint8Array(size).fill(255), second = new Uint8Array(size).fill(255), mix = new Uint8Array(size);
  const done = new Uint8Array(size);
  for (const [part, shapes] of [...parts.entries()].sort(([a], [b]) => PRIORITY.indexOf(a) - PRIORITY.indexOf(b))) {
    const covered = new Uint8Array(size);
    for (const shape of shapes) colors.coverage(width, height, shape.uv, shape.index, covered, wrapS, wrapT);
    const texture = { rgba, width, height, mask: colors.classify(rgba, width, height, part, covered), lightness };
    const edges = colors.blendEdges(texture, references);
    for (let i = 0; i < size; i++) {
      if (done[i] || texture.mask[i] === 255) continue;
      done[i] = 1;
      mask[i] = texture.mask[i];
      second[i] = edges.second[i];
      mix[i] = edges.mix[i];
    }
  }
  return { mask, second, mix, lightness };
}

// One texture repainted in the chosen colours.
function repaint(source, parts, references, chosen, wrap = {}) {
  const map = paintMap(source, parts, references, wrap);
  return Uint8Array.from(colors.recolor({ rgba: source.rgba, ...map }, references, chosen));
}

function stamp(file) {
  try { const s = fs.statSync(file); return [file, s.size, s.mtimeMs]; } catch (_) { return [file, 0, 0]; }
}

// Writes the pack for `look` into `directory` (replacing what was there) and
// returns it, or removes it and returns null when no colour is chosen. A pack
// already made for the same look, disc and HD images is kept as it is.
// `references` are the regions' typical colours from loadMario, so the game
// matches the customizer's preview.
function bake({ rom, look, references, packDirectories = [], directory }) {
  const chosen = colors.normalize(look?.colors);
  if (!Object.keys(chosen).length) {
    fs.rmSync(directory, { recursive: true, force: true });
    return null;
  }
  const disc = new Disc(rom);
  let files;
  try { files = rarc(disc.file('data/mario.szs')); }
  finally { disc.close(); }
  const model = j3d.parseBmd(files.get('bmd/ma_mdl1.bmd'));
  const index = packIndex(packDirectories);
  const list = targets(model).map(target => ({ ...target, hd: index.get(target.name) || null }));
  const key = crypto.createHash('sha256').update(JSON.stringify({
    VERSION, chosen, rom: stamp(rom), hd: list.map(t => t.hd && stamp(t.hd)),
  })).digest('hex');
  try {
    if (JSON.parse(fs.readFileSync(path.join(directory, 'look.json'), 'utf8')).key === key) return directory;
  } catch (_) { /* not made yet */ }

  const temporary = `${directory}.making`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true });
  for (const target of list) {
    const source = target.hd ? image.readImage(target.hd) : target.source;
    const pixels = repaint(source, target.parts, references, chosen, target.source);
    fs.writeFileSync(path.join(temporary, `${target.name}.png`), image.writePng(source.width, source.height, pixels));
  }
  fs.writeFileSync(path.join(temporary, 'look.json'), JSON.stringify({ key, colors: chosen }, null, 2));
  fs.rmSync(directory, { recursive: true, force: true });
  fs.renameSync(temporary, directory);
  return directory;
}

// The look as multiplayer games pass it on: each chosen region and its colour,
// "hat=2fa846;shirt=2fa846", in the order of the regions (empty: Mario's own).
function lookText(look) {
  const chosen = colors.normalize(look?.colors);
  return colors.REGIONS.filter(({ id }) => chosen[id]).map(({ id }) => `${id}=${chosen[id].slice(1)}`).join(';');
}

// What a multiplayer game needs to paint the other players in their own
// colours (SMS_MARIO_PAINT, ext/multiplayer/sync/mp_look.cpp): for each texture
// Mario's colours touch, the picture the game shows (the HD one where a pack
// has it) and its paint map, in a .paint file, and paint.txt naming them and
// the regions. A .paint file: "SMSPAINT", then little-endian u32 version,
// width and height, then RGBA, region, blend region, blend share and lightness
// (one byte each) for every texel. Made again only when the disc or the HD
// images change.
const PAINT_VERSION = 1;
function paintFile({ width, height, rgba }, map) {
  const head = Buffer.alloc(20);
  head.write('SMSPAINT', 0, 'ascii');
  head.writeUInt32LE(PAINT_VERSION, 8);
  head.writeUInt32LE(width, 12);
  head.writeUInt32LE(height, 16);
  return Buffer.concat([head, Buffer.from(rgba.buffer, rgba.byteOffset, width * height * 4),
    map.mask, map.second, map.mix, map.lightness]);
}
function bakePaint({ rom, references, packDirectories = [], directory }) {
  const disc = new Disc(rom);
  let files;
  try { files = rarc(disc.file('data/mario.szs')); }
  finally { disc.close(); }
  const model = j3d.parseBmd(files.get('bmd/ma_mdl1.bmd'));
  const index = packIndex(packDirectories);
  const list = targets(model).map(target => ({ ...target, hd: index.get(target.name) || null }));
  const key = crypto.createHash('sha256').update(JSON.stringify({
    PAINT_VERSION, VERSION, rom: stamp(rom), hd: list.map(t => t.hd && stamp(t.hd)),
  })).digest('hex');
  try {
    if (fs.readFileSync(path.join(directory, 'paint.txt'), 'utf8').split('\n').includes(`key ${key}`)) return directory;
  } catch (_) { /* not made yet */ }

  const temporary = `${directory}.making`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true });
  const lines = [`sms-paint ${PAINT_VERSION}`, `key ${key}`];
  colors.REGIONS.forEach(({ id }, i) => {
    const ref = references[i];
    lines.push(`region ${i} ${id} ${ref ? ref.color.slice(1) : '-'} ${ref ? ref.lightness.toFixed(3) : 0}`);
  });
  list.forEach((target, n) => {
    const source = target.hd ? image.readImage(target.hd) : target.source;
    const file = `${n}.paint`;
    fs.writeFileSync(path.join(temporary, file), paintFile(source, paintMap(source, target.parts, references, target.source)));
    // every texture of the model with this picture (the game finds them by name)
    const names = new Set(model.textures.filter(texture => packName(texture) === target.name).map(texture => texture.name));
    for (const name of names) lines.push(`texture ${name} ${file}`);
  });
  fs.writeFileSync(path.join(temporary, 'paint.txt'), `${lines.join('\n')}\n`);
  fs.rmSync(directory, { recursive: true, force: true });
  fs.renameSync(temporary, directory);
  return directory;
}

module.exports = { bake, bakePaint, lookText, packName, targets, packIndex, paintMap, paintFile, repaint };
