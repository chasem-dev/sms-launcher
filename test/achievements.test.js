'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const achievements = require('../src/achievements');

function gameFolder(list) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-achievements-test-'));
  if (list) {
    fs.mkdirSync(path.join(root, 'ext', 'achievements'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ext', 'achievements', 'achievements.json'), JSON.stringify({ achievements: list }));
  }
  return root;
}

test('only the game\'s [achievement] lines are read', () => {
  assert.deepEqual(achievements.parseLine('[achievement] {"id":12,"time":1761170000}'), { id: 12, time: 1761170000, eclipse: false });
  assert.deepEqual(achievements.parseLine('[achievement] {"id":7,"time":1761170000,"game":"eclipse"}'),
    { id: 7, time: 1761170000, eclipse: true });
  assert.equal(achievements.isLine('[achievement] {"id":12}'), true);
  assert.equal(achievements.parseLine('[achievements] warning: achievement 63 can\'t find the 1-Up'), null);
  assert.equal(achievements.parseLine('[achievement] {"id":0,"time":1}'), null);
  assert.equal(achievements.parseLine('[achievement] {broken'), null);
  assert.ok(achievements.parseLine('[achievement] {"id":3}').time > 0);
});

test('the unlocks file keeps each achievement\'s first unlock and skips anything else', () => {
  const root = gameFolder(null), file = path.join(root, 'achievements.txt');
  fs.writeFileSync(file, '12 1761170000\r\n12 1761179999\nnot a line\n\n3 1761000000\n');
  assert.deepEqual([...achievements.readUnlocks(file)], [[12, 1761170000], [3, 1761000000]]);
  assert.equal(achievements.readUnlocks(path.join(root, 'missing.txt')).size, 0);
  fs.rmSync(root, { recursive: true });
});

test('the page lists the game\'s achievements with the player\'s unlocks', () => {
  const root = gameFolder([{ id: 1, title: 'Paint Job', description: 'Get the first Shine.', stage: 'Delfino Airstrip' },
    { id: 2, title: 'Guardian of the Statue', description: 'Clean the statue.', stage: 'Delfino Plaza' }, { title: 'no id' }]);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-achievements-user-'));
  fs.writeFileSync(achievements.file(userData), '2 1761170000\n');
  const state = achievements.state(root, { eclipse: false }, userData);
  assert.equal(state.supported, true);
  assert.equal(state.total, 2);
  assert.equal(state.unlocked, 1);
  assert.deepEqual(state.achievements.map(item => [item.id, item.unlockedAt]), [[1, null], [2, 1761170000]]);
  assert.equal(state.counted, true);
  // Eclipse's list is its own; a game without one (here, or older) shows the launcher's, but can't unlock them.
  const eclipse = achievements.state(root, { eclipse: true }, userData);
  assert.deepEqual([eclipse.supported, eclipse.counted, eclipse.total], [true, false, 128]);
  const old = gameFolder(null);
  assert.equal(achievements.supported(old, { eclipse: false }), false);
  const shown = achievements.state(old, { eclipse: false }, userData);
  assert.deepEqual([shown.supported, shown.counted, shown.total, shown.unlocked], [true, false, 148, 1]);
  assert.equal(shown.achievements[0].title, 'Paint Job');
  // No game set up yet: the same.
  assert.equal(achievements.state(null, { eclipse: false }, userData).total, 148);
  for (const folder of [root, userData, old]) fs.rmSync(folder, { recursive: true });
});

test('Super Mario Eclipse has its own list, unlocks file and icons', () => {
  const root = gameFolder([{ id: 1, title: 'Paint Job', description: 'Get the first Shine.', stage: 'Delfino Airstrip' }]);
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-achievements-user-'));
  // A game older than Eclipse's achievements: none while Eclipse is on.
  assert.equal(achievements.supported(root, { eclipse: true }), false);
  fs.writeFileSync(path.join(root, 'ext', 'achievements', 'eclipse.json'), JSON.stringify({ achievements: [
    { id: 1, title: 'Trials Passed', description: 'Clear every trial.', stage: 'Isle Delfino' },
    { id: 2, title: 'Seventh Heaven', description: 'Finish Episode 7 everywhere.', stage: 'Anywhere' }] }));
  assert.notEqual(achievements.file(userData, true), achievements.file(userData));
  fs.writeFileSync(achievements.file(userData), '1 1761170000\n');
  fs.writeFileSync(achievements.file(userData, true), '2 1761170001\n');
  const eclipse = achievements.state(root, { eclipse: true }, userData);
  assert.equal(eclipse.eclipse, true);
  assert.deepEqual(eclipse.achievements.map(item => [item.title, item.unlockedAt]), [['Trials Passed', null], ['Seventh Heaven', 1761170001]]);
  const sunshine = achievements.state(root, { eclipse: false }, userData);
  assert.deepEqual(sunshine.achievements.map(item => [item.title, item.unlockedAt]), [['Paint Job', 1761170000]]);
  for (const folder of [root, userData]) fs.rmSync(folder, { recursive: true });
});

test('online games earn achievements only when the player allows it; alone and split-screen always do', () => {
  assert.equal(achievements.earned(null), true);
  assert.equal(achievements.earned({ mode: 'coop', env: {} }), true);
  for (const mode of ['host', 'join']) {
    assert.equal(achievements.earned({ mode, env: {} }), false);
    assert.equal(achievements.earned({ mode, env: {} }, undefined), false);
    assert.equal(achievements.earned({ mode, env: {} }, true), true);
  }
});
