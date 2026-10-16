'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { designatedRequirement, fileOptions } = require('../scripts/mac-sign');

test('updates must come from the release certificate or a Developer ID build of the same app', () => {
  const requirement = designatedRequirement('B303A7E3C80C3747D36D0E8C5BFE699AE7B4C7AD');
  assert.match(requirement, /^=designated => identifier "dev\.chasem\.smslauncher" and \(/);
  assert.match(requirement, /certificate leaf = H"b303a7e3c80c3747d36d0e8c5bfe699ae7b4c7ad" or \(anchor apple generic and /);
  assert.match(requirement, /certificate 1\[field\.1\.2\.840\.113635\.100\.6\.2\.6\] exists/);
});

test('every file is signed without a secure timestamp, and the app with its designated requirement', () => {
  const app = '/dist/SMS Launcher.app', identity = 'B303A7E3C80C3747D36D0E8C5BFE699AE7B4C7AD';
  const base = () => ({ hardenedRuntime: true, timestamp: 'http://timestamp.apple.com' });
  const helper = fileOptions(`${app}/Contents/Frameworks/Electron Framework.framework`, { app, identity, base });
  assert.deepEqual(helper, { hardenedRuntime: true, timestamp: 'none' });
  const whole = fileOptions(app, { app, identity, base });
  assert.equal(whole.timestamp, 'none');
  assert.equal(whole.requirements, designatedRequirement(identity));
});
