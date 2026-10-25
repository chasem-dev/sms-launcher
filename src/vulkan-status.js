'use strict';

// What the game's log says about the Vulkan renderer a player picked. When it
// draws with OpenGL instead, players only notice the game got slower, so the
// launcher says why (main.js, noteRenderer). The lines are the game's own
// (sms_gx's gx_platform.cpp), the same in every game version that has Vulkan.

// The build has no Vulkan backend: its downloads failed when it was built.
const NOT_BUILT = 'Vulkan was asked for, but this build has no Vulkan backend';

// { state: 'missing' }, { state: 'failed', reason } (Vulkan is built in but
// couldn't start: no driver, too old a GPU), { state: 'ok' } (Vulkan draws), or
// null for any other line.
function fromGameLine(line) {
  const text = String(line || '');
  if (text.includes(NOT_BUILT)) return { state: 'missing' };
  const failed = text.match(/Vulkan could not start(?: \((.*)\))?; OpenGL instead/);
  if (failed) return { state: 'failed', reason: (failed[1] || '').trim().slice(0, 300) };
  if (/\bVulkan device ready\b/.test(text)) return { state: 'ok' };
  return null;
}

module.exports = { NOT_BUILT, fromGameLine };
