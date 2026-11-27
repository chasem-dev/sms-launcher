'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { updateNotice } = require('../src/recomplauncher');

test('started by RecompLauncher, the launcher leaves updates to it', () => {
  assert.deepEqual(updateNotice({ RECOMPLAUNCHER: '1' }),
    { state: 'unconfigured', message: 'RecompLauncher keeps SMS Launcher up to date.' });
});

test('started any other way, the launcher updates itself as before', () => {
  assert.equal(updateNotice({}), null);
  assert.equal(updateNotice({ RECOMPLAUNCHER: '0' }), null);
  assert.equal(updateNotice({ RECOMPLAUNCHER: '' }), null);
});
