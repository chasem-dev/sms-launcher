'use strict';

// Super Mario Eclipse is a patch for one exact disc image: the game's
// tools/mods/get.py refuses any other, but only deep into an update. The
// launcher checks the player's disc the same way before any work starts.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ECLIPSE["source_md5"] in the game's tools/mods/get.py (GMSE01, as Eclipse's
// own patcher requires), for when there is no game folder to read it from yet.
const SOURCE_MD5 = '0c6d2edae9fdf40dfc410ff1623e4119';

const WRONG_DISC = 'Super Mario Eclipse needs a full 1:1 copy of the North American (USA) disc. ' +
  'This one is a different copy (trimmed, compressed or another region), so Eclipse can\'t patch it. ' +
  'Sunshine still plays from it. To play Eclipse, make a full ISO of your own disc (CleanRip on a Wii makes one), ' +
  'choose it under Manage game, Files, and turn Eclipse on again.';

// The MD5 the game's own Eclipse installer requires, read from its get.py.
function expectedMd5(root) {
  try {
    const match = /"source_md5":\s*"([a-f0-9]{32})"/.exec(fs.readFileSync(path.join(root, 'tools', 'mods', 'get.py'), 'utf8'));
    if (match) return match[1];
  } catch (_) { /* no game folder yet */ }
  return SOURCE_MD5;
}

// Streamed in large chunks, so the launcher keeps answering while a 1.4 GB disc is read.
function md5File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const input = fs.createReadStream(file, { highWaterMark: 1 << 20 });
    input.on('data', chunk => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

// A disc's MD5, hashed once per file path, size and modification time.
// Checks of the same disc at once share one read.
function cachedMd5(cache, hash) {
  return file => {
    const stat = fs.statSync(file);
    const key = `${path.resolve(file)}\0${stat.size}\0${stat.mtimeMs}`;
    if (!cache.has(key)) cache.set(key, Promise.resolve().then(() => hash(file))
      .catch(error => { cache.delete(key); throw error; }));
    return cache.get(key);
  };
}

const sharedCache = new Map();

// Resolves when Eclipse can patch the disc, and throws WRONG_DISC when it can't.
async function check(file, { root = null, expected = root ? expectedMd5(root) : SOURCE_MD5,
  hash = md5File, cache = sharedCache } = {}) {
  const got = await cachedMd5(cache, hash)(file);
  if (got !== expected) throw Object.assign(new Error(WRONG_DISC), { eclipseDisc: true, md5: got, expected });
  return got;
}

module.exports = { SOURCE_MD5, WRONG_DISC, expectedMd5, md5File, check };
