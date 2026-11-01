'use strict';
// Makes one of the launcher's characters from the disc (character-roster.js) off the main thread.
const { parentPort, workerData } = require('node:worker_threads');
const roster = require('./character-roster');

try {
  roster.build(workerData.root, workerData.rom, workerData.id, text => parentPort.postMessage({ progress: text }));
  parentPort.postMessage({ done: true });
} catch (error) {
  parentPort.postMessage({ error: error.message || String(error) });
}
