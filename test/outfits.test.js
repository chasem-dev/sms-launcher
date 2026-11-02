'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const colors = require('../src/mario-colors');

test('a player from before outfits gets their look as the first outfit, worn', () => {
  const look = { colors: { hat: '#123456' }, inGame: false, sunglasses: true };
  const { slots, active } = colors.normalizeOutfits(undefined, look);
  assert.equal(slots.length, colors.SLOTS);
  assert.equal(active, 0);
  assert.deepEqual(slots[0], { name: 'Outfit 1', look: { colors: { hat: '#123456' }, aloha: false, sunglasses: true, fludd: false, nozzle: 'spray' } });
  assert.deepEqual(slots.slice(1), Array(5).fill(null));
  assert.deepEqual(colors.normalizeOutfits({ slots: 'nope', active: 3 }).slots[0].look.colors, {});
});

test('outfits keep six places, each empty or a named look without Use in the game', () => {
  const { slots } = colors.normalizeOutfits({ slots: [
    { name: '  Fire  ', look: { colors: { hat: '#FFFFFF', bogus: '#000000', shirt: 'red' }, inGame: false, aloha: true, nozzle: 'rocket' } },
    null,
    { look: {} },
    { name: 'x'.repeat(40), look: { colors: {} } },
    { name: 'no look' },
    null, { name: 'seventh', look: {} },
  ], active: 0 });
  assert.equal(slots.length, 6);
  assert.deepEqual(slots[0], { name: 'Fire', look: { colors: { hat: '#ffffff' }, aloha: true, sunglasses: false, fludd: false, nozzle: 'rocket' } });
  assert.equal(slots[1], null);
  assert.equal(slots[2].name, 'Outfit 3');
  assert.equal(slots[3].name.length, colors.SLOT_NAME_LENGTH);
  assert.equal(slots[4], null);
});

test('the worn outfit is always one that exists', () => {
  const slots = [null, { name: 'A', look: {} }, null, { name: 'B', look: {} }];
  assert.equal(colors.normalizeOutfits({ slots, active: 3 }).active, 3);
  assert.equal(colors.normalizeOutfits({ slots, active: 0 }).active, 1);
  assert.equal(colors.normalizeOutfits({ slots, active: 9 }).active, 1);
  assert.equal(colors.normalizeOutfits({ slots, active: '3' }).active, 1);
});
