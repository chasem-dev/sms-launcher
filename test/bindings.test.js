'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bindings = require('../src/bindings');

test('every control has game defaults and a label', () => {
  assert.equal(bindings.CONTROLS.length, Object.keys(bindings.DEFAULTS).length);
  for (const { id, label } of bindings.CONTROLS) {
    assert.ok(label, id);
    assert.ok(Array.isArray(bindings.DEFAULTS[id]), id);
    // only the soft L press and the C-stick's zoom (the mouse wheel zooms) start without a key
    if (id !== 'L_SOFT' && id !== 'CAMERA_ZOOM') assert.ok(bindings.DEFAULTS[id].length, id);
    assert.ok(Array.isArray(bindings.CLASSIC[id]), id);
  }
});

test('browser key codes map to the key names the game reads', () => {
  assert.equal(bindings.keyFromCode('KeyW'), 'W');
  assert.equal(bindings.keyFromCode('Digit3'), '3');
  assert.equal(bindings.keyFromCode('Numpad8'), 'KP_8');
  assert.equal(bindings.keyFromCode('ArrowLeft'), 'LEFT');
  assert.equal(bindings.keyFromCode('ShiftRight'), 'RSHIFT');
  assert.equal(bindings.keyFromCode('Space'), 'SPACE');
  assert.equal(bindings.keyFromCode('F5'), 'F5');
  assert.equal(bindings.keyFromCode('F12'), 'F12');
  assert.equal(bindings.keyFromCode('F13'), null);
  assert.equal(bindings.keyFromCode('MetaLeft'), null);
});

test('normalize keeps only changed controls with known, distinct keys, at most eight', () => {
  assert.deepEqual(bindings.normalize(null), {});
  assert.deepEqual(bindings.normalize({ A: ['MOUSE_LEFT'] }), {});
  assert.deepEqual(bindings.normalize({ A: ['J', 'J', 'BOGUS'] }), { A: ['J'] });
  assert.deepEqual(bindings.normalize({ QUIT: 'ESCAPE', NOT_A_CONTROL: ['A'] }), {});
  assert.equal(bindings.normalize({ A: 'ABCDEFGHIJ'.split('') }).A.length, 8);
});

test('the bindings file lists every control, with changed keys replacing the defaults', () => {
  const text = bindings.fileText({ A: ['J', 'KP_0'] });
  const lines = text.trim().split('\n').filter(line => !line.startsWith('#'));
  assert.equal(lines.length, bindings.CONTROLS.length);
  assert.ok(lines.includes('A = J KP_0'));
  assert.ok(lines.includes('B = MOUSE_RIGHT'));
  assert.ok(lines.includes('QUIT = ESCAPE'));
});

test('controller buttons follow the browser standard gamepad order and the game names', () => {
  assert.equal(bindings.padFromIndex(0), 'PAD_A');
  assert.equal(bindings.padFromIndex(5), 'PAD_RB');
  assert.equal(bindings.padFromIndex(7), 'PAD_RT');
  assert.equal(bindings.padFromIndex(12), 'PAD_DPUP');
  assert.equal(bindings.padFromIndex(99), null);
  assert.equal(bindings.padLabel('PAD_LT'), 'LT');
  assert.deepEqual(bindings.padsFor({}, 'Z'), ['PAD_RB']);
  assert.deepEqual(bindings.padsFor({}, 'STICK_UP'), []);
});

test('normalizePads keeps only changed controls with known, distinct buttons, at most four', () => {
  assert.deepEqual(bindings.normalizePads(null), {});
  assert.deepEqual(bindings.normalizePads({ A: ['PAD_A'] }), {});
  assert.deepEqual(bindings.normalizePads({ A: ['PAD_Y', 'PAD_Y', 'PAD_BOGUS'] }), { A: ['PAD_Y'] });
  assert.deepEqual(bindings.normalizePads({ A: [] }), {});
  assert.deepEqual(bindings.normalizePads({ HALF_TILT: ['PAD_LB'] }), { HALF_TILT: ['PAD_LB'] });
  assert.equal(bindings.normalizePads({ A: ['PAD_A', 'PAD_B', 'PAD_X', 'PAD_Y', 'PAD_LB'] }).A.length, 4);
});

test('the bindings file adds controller buttons only to the controls changed', () => {
  const text = bindings.fileText({ A: ['J'] }, { A: ['PAD_Y'], Z: ['PAD_RT'] });
  const lines = text.trim().split('\n').filter(line => !line.startsWith('#'));
  assert.ok(lines.includes('A = J PAD_Y'));
  assert.ok(lines.includes('Z = TAB PAD_RT'));
  assert.ok(lines.includes('B = MOUSE_RIGHT'));
  assert.ok(bindings.fileText({}).includes('A = MOUSE_LEFT\n'));
});

test('the map defaults to M, and to Back on a controller', () => {
  assert.deepEqual(bindings.keysFor({}, 'MAP'), ['M']);
  assert.deepEqual(bindings.padsFor({}, 'MAP'), ['PAD_BACK']);
  assert.ok(bindings.fileText({}).includes('MAP = M\n'));
});

test('save states default to F5 and F6, and to L1 + R1 (LB + RB) held together on a controller', () => {
  assert.deepEqual(bindings.keysFor({}, 'SAVE_STATE'), ['F5']);
  assert.deepEqual(bindings.keysFor({}, 'LOAD_STATE'), ['F6']);
  assert.deepEqual(bindings.padsFor({}, 'SAVE_STATE'), ['PAD_LB+PAD_RB']);
  assert.deepEqual(bindings.padsFor({}, 'LOAD_STATE'), []);
  assert.equal(bindings.padLabel('PAD_LB+PAD_RB'), 'LB + RB');
  assert.equal(bindings.padLabel('PAD_A'), 'A');
});

test('two controller buttons held together are one binding, written as the game reads it', () => {
  assert.equal(bindings.padCombo('PAD_LB', 'PAD_RT'), 'PAD_LB+PAD_RT');
  assert.equal(bindings.padCombo('PAD_A', 'PAD_A'), 'PAD_A');
  assert.deepEqual(bindings.normalizePads({ SAVE_STATE: ['PAD_LB+PAD_RB'] }), {});
  assert.deepEqual(bindings.normalizePads({ SAVE_STATE: ['PAD_BACK+PAD_Y', 'PAD_A+PAD_A', 'PAD_A+PAD_B+PAD_X', 'PAD_A+NOPE'] }),
    { SAVE_STATE: ['PAD_BACK+PAD_Y'] });
  assert.deepEqual(bindings.normalizePads({ LOAD_STATE: ['PAD_LB+PAD_RT'] }), { LOAD_STATE: ['PAD_LB+PAD_RT'] });
  const lines = bindings.fileText({}, { SAVE_STATE: ['PAD_BACK+PAD_Y'] }).split('\n');
  assert.ok(lines.includes('SAVE_STATE = F5 PAD_BACK+PAD_Y'));
  assert.ok(lines.includes('LOAD_STATE = F6'));
});

test('mouse buttons bind as keys, by MouseEvent.button, under the names the game reads', () => {
  assert.equal(bindings.keyFromMouse(0), 'MOUSE_LEFT');
  assert.equal(bindings.keyFromMouse(1), 'MOUSE_MIDDLE');
  assert.equal(bindings.keyFromMouse(2), 'MOUSE_RIGHT');
  assert.equal(bindings.keyFromMouse(3), 'MOUSE_BACK');
  assert.equal(bindings.keyFromMouse(4), 'MOUSE_FORWARD');
  assert.equal(bindings.keyFromMouse(5), null);
  assert.deepEqual(bindings.normalize({ A: ['SPACE', 'MOUSE_LEFT', 'MOUSE_BOGUS'] }), { A: ['SPACE', 'MOUSE_LEFT'] });
  assert.ok(bindings.fileText({ B: ['MOUSE_RIGHT'] }).includes('\nB = MOUSE_RIGHT\n'));
  assert.equal(bindings.keyLabel('MOUSE_LEFT'), 'Left click');
  assert.equal(bindings.keyLabel('KP_8'), 'KP 8');
  assert.ok(bindings.isMouse('MOUSE_BACK'));
  assert.ok(!bindings.isMouse('SPACE'));
});

test('the default keys are laid out for keyboard and mouse', () => {
  const keys = id => bindings.keysFor({}, id);
  assert.deepEqual([keys('A'), keys('B'), keys('X'), keys('Y'), keys('Z'), keys('L'), keys('R'), keys('R_SOFT'), keys('START')],
    [['MOUSE_LEFT'], ['MOUSE_RIGHT'], ['Q'], ['E'], ['TAB'], ['LSHIFT'], ['SPACE'], ['MOUSE_MIDDLE'], ['ENTER']]);
  assert.deepEqual([keys('STICK_UP'), keys('STICK_LEFT'), keys('STICK_DOWN'), keys('STICK_RIGHT')],
    [['W', 'UP'], ['A', 'LEFT'], ['S', 'DOWN'], ['D', 'RIGHT']]);
  // no key does two things
  const all = bindings.CONTROLS.flatMap(({ id }) => keys(id));
  assert.equal(new Set(all).size, all.length);
});

test('the classic keys are the keyboard-only layout from before, as changes from today\'s defaults', () => {
  const classic = bindings.fromClassic({});
  assert.deepEqual([classic.A, classic.B, classic.X, classic.Y, classic.Z, classic.L, classic.R, classic.R_SOFT],
    [['SPACE', 'X'], ['LSHIFT', 'RSHIFT', 'C'], ['V'], ['F'], ['Z'], ['Q'], ['E'], []]);
  assert.equal(classic.STICK_UP, undefined);
  // keys a player changed back then stay changed; the rest keep their classic keys
  const kept = bindings.fromClassic({ A: ['J'], MAP: ['N'] });
  assert.deepEqual([kept.A, kept.MAP, kept.B], [['J'], ['N'], ['LSHIFT', 'RSHIFT', 'C']]);
  const text = bindings.fileText(classic);
  assert.ok(text.includes('\nR_SOFT =\n') && text.includes('\nA = SPACE X\n'));
});

test('Switch controllers, and any with Nintendo button layout, read A and B, X and Y by their letters', () => {
  const pro = 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)';
  const xbox = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
  assert.equal(bindings.nintendoLetters(pro), true);
  assert.equal(bindings.nintendoLetters(xbox), false);
  assert.equal(bindings.nintendoLetters(xbox, true), true);
  assert.equal(bindings.nintendoLetters('Steam Deck (Vendor: 28de Product: 1205)', true), false);
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(index => bindings.letterIndex(index, true)), [1, 0, 3, 2, 4, 9]);
  assert.deepEqual([0, 1, 2, 3].map(index => bindings.letterIndex(index, false)), [0, 1, 2, 3]);
});
