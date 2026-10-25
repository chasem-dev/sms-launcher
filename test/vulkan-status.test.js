'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vulkanStatus = require('../src/vulkan-status');

test('the game\'s lines say when it draws with OpenGL instead of the Vulkan picked', () => {
  assert.deepEqual(vulkanStatus.fromGameLine('[sms_gx] Vulkan was asked for, but this build has no Vulkan backend; OpenGL instead'),
    { state: 'missing' });
  assert.deepEqual(vulkanStatus.fromGameLine('[sms_gx] Vulkan could not start (no Vulkan 1.1 device); OpenGL instead'),
    { state: 'failed', reason: 'no Vulkan 1.1 device' });
  assert.deepEqual(vulkanStatus.fromGameLine('[sms_gx] headless: Vulkan could not start; OpenGL instead'), { state: 'failed', reason: '' });
  assert.deepEqual(vulkanStatus.fromGameLine('[sms_gx] desktop fullscreen on display 0 (windows), internal resolution scale 1, Vulkan device ready'),
    { state: 'ok' });
  assert.equal(vulkanStatus.fromGameLine('[sms_gx] desktop fullscreen on display 0 (windows), internal resolution scale 1, OpenGL context ready'), null);
  assert.equal(vulkanStatus.fromGameLine(''), null);
});
