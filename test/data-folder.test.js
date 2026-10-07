'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { dataFolder, locations, savedDataFolder } = require('../src/data-folder');

const userData = path.resolve('/data/sms-launcher');
const chosen = path.resolve('/games');

test('everything goes in the chosen folder, or else the launcher data folder', () => {
  assert.equal(dataFolder({ dataFolder: chosen }, userData), chosen);
  assert.equal(dataFolder({ dataFolder: null }, userData), userData);
  assert.deepEqual(locations(chosen), { saves: path.join(chosen, 'saves'), backups: path.join(chosen, 'save-backups'),
    bindings: path.join(chosen, 'bindings.txt') });
});

test('saved preferences keep their data folder, including the launcher data folder', () => {
  assert.equal(savedDataFolder({ dataFolder: chosen, repo: path.join(userData, 'sms-pc-port') }, userData), chosen);
  assert.equal(savedDataFolder({ dataFolder: null, repo: path.join(chosen, 'sms-pc-port') }, userData), null);
});

test('a folder chosen before everything followed it becomes the data folder until a game is built', () => {
  assert.equal(savedDataFolder({ repo: path.join(chosen, 'sms-pc-port') }, userData), chosen);
  assert.equal(savedDataFolder({ repo: path.join(chosen, 'sms-pc-port'), completedSetup: true }, userData), null);
  assert.equal(savedDataFolder({ repo: path.join(chosen, 'sms-pc-port'), previousInstall: { repo: 'x' } }, userData), null);
  assert.equal(savedDataFolder({ repo: path.join(userData, 'sms-pc-port') }, userData), null);
  assert.equal(savedDataFolder({ repo: path.join(chosen, 'my-own-port-checkout') }, userData), null);
  assert.equal(savedDataFolder({}, userData), null);
});
