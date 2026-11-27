'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { gameArgument } = require('../src/game-argument');

test('--game takes the disc path from the next argument', () => {
  assert.equal(gameArgument(['app', '--game', 'D:\Games\sms.iso', '--play']), 'D:\Games\sms.iso');
});

test('--game=<path> works too', () => {
  assert.equal(gameArgument(['app', '--game=/games/sms.iso']), '/games/sms.iso');
});

test('no --game means no disc is passed in', () => {
  assert.equal(gameArgument(['app', '--play']), null);
});

test('--game without a path is ignored', () => {
  assert.equal(gameArgument(['app', '--game']), null);
  assert.equal(gameArgument(['app', '--game=']), null);
});
