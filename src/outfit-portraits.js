'use strict';
// The outfit portraits the Character tab draws (portraits.js), kept as PNG files so each is drawn
// once: <userData>/outfit-portraits/<key>.png. A key names the character, its model and the look,
// so a changed one gets a new file; the oldest beyond MAX are removed.
const fs = require('fs');
const path = require('path');

const KEY = /^[a-z0-9-]{1,120}$/;
const PNG_URL = 'data:image/png;base64,';
const MAX = 200, MAX_BYTES = 512 * 1024;

// { key: data URL or null } for each valid key.
function read(directory, keys) {
  const found = {};
  for (const key of Array.isArray(keys) ? keys : []) {
    if (typeof key !== 'string' || !KEY.test(key)) continue;
    try { found[key] = PNG_URL + fs.readFileSync(path.join(directory, `${key}.png`)).toString('base64'); } catch (_) { found[key] = null; }
  }
  return found;
}

function save(directory, key, url) {
  if (typeof key !== 'string' || !KEY.test(key)) throw new Error('That is not a portrait name.');
  if (typeof url !== 'string' || !url.startsWith(PNG_URL)) throw new Error('A portrait must be a PNG.');
  const png = Buffer.from(url.slice(PNG_URL.length), 'base64');
  if (png.length > MAX_BYTES || png.subarray(1, 4).toString('latin1') !== 'PNG') throw new Error('That is not a portrait.');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${key}.png`), temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, png);
  fs.renameSync(temporary, file);
  prune(directory);
}

// Only the newest MAX portraits stay.
function prune(directory) {
  let files;
  try { files = fs.readdirSync(directory).filter(name => name.endsWith('.png')); } catch (_) { return; }
  if (files.length <= MAX) return;
  const dated = files.map(name => {
    try { return { name, time: fs.statSync(path.join(directory, name)).mtimeMs }; } catch (_) { return { name, time: 0 }; }
  }).sort((a, b) => b.time - a.time);
  for (const { name } of dated.slice(MAX)) fs.rmSync(path.join(directory, name), { force: true });
}

module.exports = { read, save, prune, KEY, MAX };
