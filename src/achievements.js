'use strict';

// The game's achievements (sms-pc-port's ext/achievements). The game keeps
// unlocks in the file SMS_ACHIEVEMENTS names, a line `<id> <unix time>` each,
// and prints `[achievement] {"id":12,"time":1761170000,"game":"sunshine"}` as
// one happens, so the Achievements page updates while the game runs. The names
// and what to do come from the game's ext/achievements/achievements.json, the
// icons from assets/achievements (updateAchievementIcons). Super Mario Eclipse
// has achievements of its own, numbered from 1 too: eclipse.json, their own
// unlocks file and icons (assets/achievements/eclipse), shown while Eclipse is on.
const fs = require('node:fs');
const path = require('node:path');

const PREFIX = '[achievement] ';

function isLine(line) { return typeof line === 'string' && line.startsWith(PREFIX); }

// { id, time, eclipse } from an `[achievement]` line, or null. A game older than Eclipse's achievements says no game: Sunshine.
function parseLine(line) {
  if (!isLine(line)) return null;
  try {
    const { id, time, game } = JSON.parse(line.slice(PREFIX.length));
    if (!Number.isInteger(id) || id <= 0) return null;
    return { id, time: Number.isFinite(time) && time > 0 ? time : Math.floor(Date.now() / 1000), eclipse: game === 'eclipse' };
  } catch (_) { return null; }
}

// One file for the player, whichever save or game folder they play; Eclipse's are apart.
function file(userData, eclipse = false) { return path.join(userData, eclipse ? 'achievements-eclipse.txt' : 'achievements.txt'); }

// id -> unix time of each unlock.
function readUnlocks(fileName) {
  const unlocks = new Map();
  let text = '';
  try { text = fs.readFileSync(fileName, 'utf8'); } catch (_) { return unlocks; }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match && !unlocks.has(Number(match[1]))) unlocks.set(Number(match[1]), Number(match[2]));
  }
  return unlocks;
}

function listFile(root, eclipse = false) { return path.join(root, 'ext', 'achievements', eclipse ? 'eclipse.json' : 'achievements.json'); }

// The launcher's copy of the game's lists (npm run update:game keeps it to the pinned game's), for a game
// from before achievements, or none set up yet: the page shows them all the same.
function bundledFile(eclipse = false) { return path.join(__dirname, 'achievement-data', eclipse ? 'eclipse.json' : 'achievements.json'); }

function parseList(fileName) {
  try {
    const { achievements } = JSON.parse(fs.readFileSync(fileName, 'utf8'));
    if (!Array.isArray(achievements)) return null;
    return achievements.filter(item => Number.isInteger(item?.id) && typeof item.title === 'string')
      .map(({ id, title, description, stage }) => ({ id, title, description: String(description || ''), stage: String(stage || 'Anywhere') }));
  } catch (_) { return null; }
}

// The game's list (Eclipse's with `eclipse`), or the launcher's for a game without one.
function readList(root, eclipse = false) {
  return (root && parseList(listFile(root, eclipse))) || parseList(bundledFile(eclipse));
}

// The game unlocks them: its folder has the list for what is played (Sunshine, or Eclipse with it on).
function supported(root, settings) { return Boolean(root) && fs.existsSync(listFile(root, Boolean(settings.eclipse))); }

// What the Achievements page shows: every achievement with its unlock time (or null). `counted`: this
// game unlocks them; a game from before achievements shows them, but only its update can unlock any.
function state(root, settings, userData) {
  const eclipse = Boolean(settings.eclipse);
  const list = readList(root, eclipse);
  const counted = supported(root, settings);
  if (!list) return { supported: false, counted, eclipse, achievements: [], unlocked: 0, total: 0 };
  const unlocks = readUnlocks(file(userData, eclipse));
  const achievements = list.map(item => ({ ...item, unlockedAt: unlocks.get(item.id) ?? null }));
  return { supported: true, counted, eclipse, achievements, unlocked: achievements.filter(item => item.unlockedAt).length, total: achievements.length };
}

function iconFile(iconDirectory, id) { return path.join(iconDirectory, `${Number(id)}.png`); }

module.exports = { PREFIX, isLine, parseLine, file, bundledFile, readUnlocks, readList, supported, state, iconFile };
