'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const prompts = require('../src/prompts');

test('unknown prompt styles fall back to the GameCube glyphs', () => {
  assert.equal(prompts.normalizeStyle(undefined), 'gamecube');
  assert.equal(prompts.normalizeStyle('nes'), 'gamecube');
  assert.equal(prompts.normalizeStyle('playstation'), 'playstation');
});

test('the original prompts are the default, and a choice for controllers under Automatic', () => {
  assert.equal(prompts.STYLES[0].id, 'gamecube');
  assert.equal(prompts.normalizePad('gamecube'), 'gamecube');
  assert.equal(prompts.normalizePad(undefined), 'match');
  assert.equal(prompts.normalizePad('playstation'), 'playstation');
});

test('controller prompts follow the default layout in each style', () => {
  assert.deepEqual(prompts.icon('xbox', 'A', {}, {}), { kind: 'face', text: 'A', fill: '#107c10' });
  assert.equal(prompts.icon('playstation', 'A', {}, {}).symbol, 'cross');
  assert.equal(prompts.icon('playstation', 'Y', {}, {}).symbol, 'triangle');
  assert.deepEqual(prompts.icon('xbox', 'Z', {}, {}), { kind: 'shoulder', text: 'RB' });
  assert.deepEqual(prompts.icon('playstation', 'L', {}, {}), { kind: 'trigger', text: 'L2' });
  assert.deepEqual(prompts.icon('steamdeck', 'R', {}, {}), { kind: 'trigger', text: 'R2' });
  assert.equal(prompts.icon('xbox', 'CSTICK', {}, {}).kind, 'stick');
});

test('remapped controller buttons show as bound', () => {
  assert.equal(prompts.icon('playstation', 'A', {}, { A: ['PAD_B'] }).symbol, 'circle');
  assert.deepEqual(prompts.icon('xbox', 'Z', {}, { Z: ['PAD_LB', 'PAD_RB'] }), { kind: 'shoulder', text: 'LB' });
  assert.deepEqual(prompts.icon('xbox', 'B', {}, { B: ['PAD_DPLEFT'] }), { kind: 'dpad', direction: 'left' });
});

test('keyboard prompts show the first bound key, remapped or not', () => {
  assert.deepEqual(prompts.icon('keyboard', 'A', {}, {}), { kind: 'mouse', button: 'left' });
  assert.deepEqual(prompts.icon('keyboard', 'R', {}, {}), { kind: 'key', text: 'Space' });
  assert.deepEqual(prompts.icon('keyboard', 'L', {}, {}), { kind: 'key', text: 'Shift' });
  assert.deepEqual(prompts.icon('keyboard', 'A', { A: ['KP_0'] }, {}), { kind: 'key', text: 'Num0' });
  assert.deepEqual(prompts.icon('keyboard', 'Z', { Z: [] }, {}), { kind: 'none', text: 'Z' });
});

test('the keyboard C-stick prompt is the mouse with mouse look, else the camera keys', () => {
  assert.deepEqual(prompts.icon('keyboard', 'CSTICK', {}, {}, { mouseCamera: true }), { kind: 'mouse' });
  assert.deepEqual(prompts.icon('keyboard', 'CSTICK', {}, {}), { kind: 'key', text: 'IJKL' });
});

test('every style draws the eight button icons in the game\'s glyph order, then the save state binding', () => {
  assert.deepEqual(prompts.GLYPHS, ['A', 'B', 'X', 'Y', 'Z', 'L', 'R', 'CSTICK', 'SAVE_STATE_1', 'SAVE_STATE_2']);
  for (const style of prompts.DRAWN) assert.equal(prompts.icons(style, {}, {}).length, 10);
});

test('the strips end with the save state binding, for the pause menu\'s hint', () => {
  assert.equal(prompts.GLYPHS.length, prompts.BUTTON_GLYPHS + 2);
  const hint = style => prompts.icons(style, {}, {}).slice(prompts.BUTTON_GLYPHS);
  assert.deepEqual(hint('playstation'), [{ kind: 'shoulder', text: 'L1' }, { kind: 'shoulder', text: 'R1' }]);
  assert.deepEqual(hint('xbox'), [{ kind: 'shoulder', text: 'LB' }, { kind: 'shoulder', text: 'RB' }]);
  assert.deepEqual(hint('keyboard'), [{ kind: 'key', text: 'F5' }, { kind: 'empty' }]);
  assert.deepEqual(prompts.icons('xbox', {}, { SAVE_STATE: ['PAD_BACK+PAD_Y'] }).slice(prompts.BUTTON_GLYPHS),
    [{ kind: 'pill', text: 'View' }, { kind: 'face', text: 'Y', fill: '#e2a90b' }]);
  assert.deepEqual(prompts.icons('playstation', {}, { SAVE_STATE: ['PAD_RSTICK'] }).slice(prompts.BUTTON_GLYPHS),
    [{ kind: 'pill', text: 'R3' }, { kind: 'empty' }]);
});


test('keyboard prompts draw a bound mouse button as the mouse with that button', () => {
  assert.deepEqual(prompts.icon('keyboard', 'A', { A: ['MOUSE_LEFT', 'SPACE'] }, {}), { kind: 'mouse', button: 'left' });
  assert.deepEqual(prompts.icon('keyboard', 'B', { B: ['MOUSE_FORWARD'] }, {}), { kind: 'mouse', button: 'forward' });
  assert.deepEqual(prompts.icon('keyboard', 'CSTICK', { CSTICK_UP: ['MOUSE_MIDDLE'] }, {}), { kind: 'mouse', button: 'middle' });
  assert.deepEqual(prompts.icon('keyboard', 'SAVE_STATE_1', { SAVE_STATE: ['MOUSE_RIGHT'] }, {}), { kind: 'mouse', button: 'right' });
});

test('Nintendo Switch prompts show the letters, with L, R, ZL and ZR', () => {
  assert.equal(prompts.normalizeStyle('nintendo'), 'nintendo');
  assert.equal(prompts.normalizePad('nintendo'), 'nintendo');
  assert.ok(prompts.DRAWN.includes('nintendo'));
  assert.deepEqual(prompts.icon('nintendo', 'A', {}, {}), { kind: 'face', text: 'A', fill: '#1d1f23' });
  assert.deepEqual(prompts.icon('nintendo', 'Z', {}, {}), { kind: 'shoulder', text: 'R' });
  assert.deepEqual(prompts.icon('nintendo', 'L', {}, {}), { kind: 'trigger', text: 'ZL' });
  assert.deepEqual(prompts.icon('nintendo', 'SAVE_STATE_1', {}, {}), { kind: 'shoulder', text: 'L' });
});
