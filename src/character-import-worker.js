'use strict';
// Runs a model conversion (character-convert.js) off the launcher's main thread.
const { parentPort, workerData } = require('node:worker_threads');
const { convert } = require('./character-convert');

// Buffers come across as plain Uint8Arrays.
const buffer = data => Buffer.from(data.buffer, data.byteOffset, data.byteLength);

try {
  const { model, summary } = convert({ ...workerData, glbData: buffer(workerData.glbData), marioSzs: buffer(workerData.marioSzs), progress: text => parentPort.postMessage({ progress: text }) });
  parentPort.postMessage({ model, summary });
} catch (error) {
  parentPort.postMessage({ error: error.message || String(error) });
}
