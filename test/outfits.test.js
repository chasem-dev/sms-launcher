'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const colors = require('../src/mario-colors');

test('a player from before outfits gets their look as the first outfit, worn', () => {
  const look = { colors: { hat: '#123456' }, inGame: false, sunglasses: true };
  const { slots, active } = colors.normalizeOutfits(undefined, look);
  assert.equal(slots.length, 1);
  assert.equal(active, 0);
  assert.deepEqual(slots[0], { name: 'Mario', character: 'mario', look: { colors: { hat: '#123456' }, aloha: false, sunglasses: true, fludd: false, nozzle: 'spray' } });
  assert.deepEqual(colors.normalizeOutfits({ slots: 'nope', active: 3 }).slots[0].look.colors, {});
});

test('outfits keep their places, each empty or a named character and look without Use in the game', () => {
  const { slots } = colors.normalizeOutfits({ slots: [
    { name: '  Fire  ', look: { colors: { hat: '#FFFFFF', bogus: '#000000', shirt: 'red' }, inGame: false, aloha: true, nozzle: 'rocket' } },
    null,
    { look: {}, character: 'princess-peach' },
    { name: 'x'.repeat(40), look: { colors: {} } },
    { name: 'no look' },
    null, { name: 'seventh', look: {} }, null, 'nope',
  ], active: 0 });
  assert.equal(slots.length, 7, 'no limit of six, and empty places at the end are dropped');
  assert.equal(slots[6].name, 'seventh');
  assert.deepEqual(slots[0], { name: 'Fire', character: 'mario', look: { colors: { hat: '#ffffff' }, aloha: true, sunglasses: false, fludd: false, nozzle: 'rocket' } });
  assert.equal(slots[1], null);
  assert.equal(slots[2].name, 'Outfit 3');
  assert.equal(slots[2].character, 'princess-peach');
  const character = id => colors.normalizeOutfits({ slots: [{ look: {}, character: id }] }).slots[0].character;
  for (const path of ['../Luigi', '..', '.hidden', 'a/b', 'a\\\\b', 'x'.repeat(49)]) assert.equal(character(path), 'mario', path);
  for (const pack of ['Dry Bones', 'wario_2', "Toad's (red)"]) assert.equal(character(pack), pack);
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

test('a character chosen elsewhere puts on their first outfit, or a new one when there is room', () => {
  const look = { colors: { hat: '#00ff00' } };
  const outfits = colors.normalizeOutfits({ slots: [{ name: 'Mario', look: {} }, { name: 'Pink', character: 'princess-peach', look: {} }], active: 0 });
  assert.equal(colors.wearCharacter(outfits, 'mario', 'Mario', look), outfits);
  assert.equal(colors.wearCharacter(outfits, 'princess-peach', 'Princess Peach', look).active, 1);
  const luigi = colors.wearCharacter(outfits, 'luigi', 'Luigi', look);
  assert.equal(luigi.active, 2);
  assert.deepEqual(luigi.slots[2], { name: 'Luigi', character: 'luigi', look: colors.slotLook(look) });
  assert.equal(outfits.slots.length, 2, 'the outfits given are left as they were');
  const six = colors.normalizeOutfits({ slots: Array.from({ length: 6 }, (_, i) => ({ name: `M${i}`, look: {} })), active: 3 });
  assert.equal(colors.wearCharacter(six, 'luigi', 'Luigi', look).active, 6, 'six outfits is not full');
  const full = colors.normalizeOutfits({ slots: Array.from({ length: colors.MAX_OUTFITS + 5 }, (_, i) => ({ name: `M${i}`, look: {} })), active: 3 });
  assert.equal(full.slots.length, colors.MAX_OUTFITS);
  assert.equal(colors.wearCharacter(full, 'luigi', 'Luigi', look), full);
});

test('a new outfit goes in the first empty place, else after the last', () => {
  assert.equal(colors.freeSlot([{}, null, {}]), 1);
  assert.equal(colors.freeSlot(Array(6).fill({})), 6);
  assert.equal(colors.freeSlot(Array(colors.MAX_OUTFITS).fill({})), -1);
});

test('a new outfit gets its character\'s name, numbered when it is taken', () => {
  const slots = [{ name: 'Luigi' }, null, { name: 'luigi 2' }];
  assert.equal(colors.uniqueName(slots, 'Mario'), 'Mario');
  assert.equal(colors.uniqueName(slots, 'Luigi'), 'Luigi 3');
  assert.equal(colors.uniqueName(slots, 'Luigi', 0), 'Luigi');
  assert.equal(colors.uniqueName([{ name: 'x'.repeat(24) }], 'x'.repeat(24)).length, 24);
});

test('player 2 in co-op is an outfit that exists, or none', () => {
  const slots = [{ name: 'A', look: {} }, null, { name: 'B', character: 'princess-peach', look: {} }];
  assert.equal(colors.normalizeOutfits({ slots }).coop, null);
  assert.equal(colors.normalizeOutfits({ slots, coop: 2 }).coop, 2);
  assert.equal(colors.normalizeOutfits({ slots, active: 0, coop: 0 }).coop, 0, 'the outfit worn can be player 2 too');
  assert.equal(colors.normalizeOutfits({ slots, coop: 1 }).coop, null);
  assert.equal(colors.normalizeOutfits({ slots, coop: '2' }).coop, null);
  assert.equal(colors.normalizeOutfits({ slots, coop: 9 }).coop, null);
  assert.equal(colors.normalizeOutfits(undefined, {}).coop, null);
  const outfits = colors.normalizeOutfits({ slots, active: 0, coop: 2 });
  assert.equal(colors.wearCharacter(outfits, 'princess-peach', 'Princess Peach', {}).coop, 2);
  assert.equal(colors.wearCharacter(outfits, 'luigi', 'Luigi', {}).coop, 2);
});
