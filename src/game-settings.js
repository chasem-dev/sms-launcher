'use strict';
// Settings changed in the game's own settings menu (pause, then Y). The game
// writes the ones the player changed to the file SMS_SETTINGS_SAVE names, as
// JSON in the launcher's own words ({ "settings": { "msaa": 4, ... } }), each
// time one changes. When the game closes the launcher takes them into its
// settings, so they are what the next game starts with and what Settings shows.
const fs = require('fs');
const path = require('path');

// The settings the game's menu can change; anything else in the file is ignored.
const KEYS = [
  'graphicsPreset', 'resolution', 'msaa', 'fxaa', 'anisotropic', 'sharpen', 'presentFilter', 'fsrMode', 'heatHaze',
  'textures', 'textureLoading', 'shaderWarmup',
  'fullscreen', 'fullscreenMode', 'exclusiveResolution', 'display', 'widescreen', 'hudEdges', 'aspect', 'brightness',
  'colorSpace', 'gameGamma', 'displayGamma',
  'frameRate', 'vsync', 'overlay',
  'hdr', 'hdrCalibration', 'hdrPaperWhite', 'hdrPeak', 'hdrContrast', 'hdrSaturation', 'hdrHighlights',
  'skipMovies', 'volume', 'musicVolume', 'sfxVolume', 'invertCameraX', 'invertCameraY', 'invertFluddAimY', 'freeCamera', 'cstickOrbit', 'cameraSpeed',
  'mouseCamera', 'closeCameraMouse', 'mouseSensitivity', 'rawMouse',
  'softTrigger', 'stickDeadzone', 'rumbleStrength', 'fluddTrigger', 'buttonPrompts', 'promptPad'
];

function file(userData) { return path.join(userData, 'game-settings.json'); }

// The changes in the file: only known keys with a plain value (normalizeSettings checks each value).
// Empty when there is no file or it cannot be read.
function read(name) {
  let data;
  try { data = JSON.parse(fs.readFileSync(name, 'utf8')); } catch (_) { return {}; }
  const settings = data && typeof data.settings === 'object' && !Array.isArray(data.settings) ? data.settings : {};
  return Object.fromEntries(Object.entries(settings).filter(([key, value]) =>
    KEYS.includes(key) && ['boolean', 'number', 'string'].includes(typeof value)));
}

// `settings` with the game's changes; a changed picture setting makes the preset Custom unless the
// game chose the preset too (normalizeSettings works that out).
function merge(settings, changes) { return { ...settings, ...changes }; }

// The keys whose value differs between two sets of normalized settings, for the activity log.
function changedKeys(before, after) {
  return KEYS.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

function remove(name) { fs.rmSync(name, { force: true }); }

// The host's Player Collision as the game's menu left it (`mpCollision`): true or false, null when it was not changed.
// A multiplayer setting, kept with the Online tab's rather than the game's settings.
function readCollision(name) {
  let data;
  try { data = JSON.parse(fs.readFileSync(name, 'utf8')); } catch (_) { return null; }
  const value = data && typeof data.settings === 'object' && data.settings ? data.settings.mpCollision : undefined;
  return typeof value === 'boolean' ? value : null;
}

module.exports = { KEYS, file, read, merge, changedKeys, remove, readCollision };
