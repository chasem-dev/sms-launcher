'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const colors = require('../src/mario-colors');

test('saved looks keep six places, each empty or a named look without Use in the game', () => {
  assert.deepEqual(colors.normalizeSlots(), Array(6).fill(null));
  assert.deepEqual(colors.normalizeSlots('nope'), Array(6).fill(null));
  const slots = colors.normalizeSlots([
    { name: '  Fire  ', look: { colors: { hat: '#FFFFFF', bogus: '#000000', shirt: 'red' }, inGame: false, aloha: true, nozzle: 'rocket' } },
    null,
    { look: {} },
    { name: 'x'.repeat(40), look: { colors: {} } },
    { name: 'no look' },
    null, { name: 'seventh', look: {} },
  ]);
  assert.equal(slots.length, 6);
  assert.deepEqual(slots[0], { name: 'Fire', look: { colors: { hat: '#ffffff' }, aloha: true, sunglasses: false, fludd: false, nozzle: 'rocket' } });
  assert.equal(slots[1], null);
  assert.equal(slots[2].name, 'Look 3');
  assert.equal(slots[3].name.length, colors.SLOT_NAME_LENGTH);
  assert.equal(slots[4], null);
});

test('a look matches a saved look by its colours, outfit and FLUDD, not Use in the game', () => {
  const saved = { colors: { hat: '#112233', shirt: '#445566' }, aloha: true, nozzle: 'hover' };
  assert.ok(colors.sameLook({ colors: { shirt: '#445566', hat: '#112233' }, inGame: false, aloha: true, nozzle: 'hover' }, saved));
  assert.ok(!colors.sameLook({ colors: { hat: '#112233' }, aloha: true, nozzle: 'hover' }, saved));
  assert.ok(!colors.sameLook({ colors: { hat: '#112233', shirt: '#445567' }, aloha: true, nozzle: 'hover' }, saved));
  assert.ok(!colors.sameLook({ ...saved, sunglasses: true }, saved));
  assert.ok(!colors.sameLook({ ...saved, nozzle: 'spray' }, saved));
});
