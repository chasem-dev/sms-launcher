'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createActivityLog } = require('../src/activity-log');
const { observeProcess, exitDescription, failureMessage, codePageDecoder } = require('../src/process-output');

function start(script, output, options = {}, stdio = ['ignore', 'pipe', 'pipe']) {
  const child = spawn(process.execPath, ['-e', script], { stdio });
  const result = observeProcess(child, { output, ...options });
  return { child, result };
}

test('captures both pipes, blank lines, CRLF, carriage-return progress and final unterminated diagnostics', async () => {
  const log = createActivityLog(), lines = [];
  const { result } = start(`
    process.stdin.on('end', () => {
      process.stdout.write('stdin closed\\n\\n[1/2] Building\\r\\n[2/2] Linking\\rstdout tail');
      process.stderr.write('\\x1b[31m[OSPanic] Café failed\\x1b[0m');
      process.exitCode = 7;
    });
    process.stdin.resume();
  `, log.write, { capture: true, line: (text, stream) => lines.push({ text, stream }) });
  const status = await result;
  assert.equal(status.code, 7);
  assert.equal(status.signal, null);
  assert.equal(status.error, null);
  assert.equal(status.stdout, 'stdin closed\n\n[1/2] Building\r\n[2/2] Linking\rstdout tail');
  assert.equal(status.stderr, '\x1b[31m[OSPanic] Café failed\x1b[0m');
  assert.deepEqual(log.snapshot().filter(entry => entry.stream === 'stdout').map(entry => entry.text),
    ['stdin closed', '', '[1/2] Building', '[2/2] Linking', 'stdout tail']);
  assert.deepEqual(log.snapshot().filter(entry => entry.stream === 'stderr').map(entry => entry.text), ['[OSPanic] Café failed']);
  assert.ok(lines.some(entry => entry.text === 'stdout tail'));
  assert.ok(lines.some(entry => entry.text === '[OSPanic] Café failed'));
});

test('partial output appears before process exit and split UTF-8 remains intact in log and capture', { timeout: 5000 }, async t => {
  const log = createActivityLog();
  let signalPartial;
  const partialReady = new Promise(resolve => { signalPartial = resolve; });
  const { child, result } = start(`
    const bytes = Buffer.from('Café 🌞');
    process.on('message', () => {
      process.stdout.write(bytes.subarray(4));
      process.stderr.write('last error');
      process.disconnect();
    });
    process.stdout.write(bytes.subarray(0, 4));
  `, (text, stream, previous) => {
    const entry = log.write(text, stream, previous);
    if (text === 'Caf') signalPartial();
    return entry;
  }, { capture: true }, ['ignore', 'pipe', 'pipe', 'ipc']);
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await partialReady;
  assert.equal(child.exitCode, null);
  assert.deepEqual(log.snapshot().map(entry => entry.text), ['Caf']);
  child.send('finish');
  const status = await result;
  assert.equal(status.stdout, 'Café 🌞');
  assert.equal(status.stderr, 'last error');
  assert.deepEqual(log.snapshot().filter(entry => entry.stream === 'stdout').map(entry => entry.text), ['Café 🌞']);
});

test('lines in the Windows code page read as such beside UTF-8 lines', async () => {
  const log = createActivityLog(), lines = [];
  // The game's paths from getenv in CP1251, addr2line's in UTF-8, as in a Windows crash report.
  const { result } = start(`
    const cp1251 = Buffer.from([0xC8, 0xE2, 0xE0, 0xED]);  // Иван
    process.stderr.write(Buffer.concat([Buffer.from('[card] slot A: C:/Users/'), cp1251, Buffer.from(' 1488/card-a\\r\\n')]));
    process.stderr.write('at C:/Users/Иван 1488/msys64/fs_path.h:785\\n');
    process.stderr.write(Buffer.concat([Buffer.from('[sms_gx] shader cache: C:\\\\Users\\\\'), cp1251.subarray(0, 2)]));
    setTimeout(() => process.stderr.write(Buffer.concat([cp1251.subarray(2), Buffer.from(' 1488')])), 50);
  `, log.write, { capture: true, codePage: codePageDecoder(1251), line: text => lines.push(text) });
  const status = await result;
  assert.equal(status.stderr, '[card] slot A: C:/Users/Иван 1488/card-a\r\nat C:/Users/Иван 1488/msys64/fs_path.h:785\n' +
    '[sms_gx] shader cache: C:\\Users\\Иван 1488');
  assert.deepEqual(log.snapshot().map(entry => entry.text), ['[card] slot A: C:/Users/Иван 1488/card-a',
    'at C:/Users/Иван 1488/msys64/fs_path.h:785', '[sms_gx] shader cache: C:\\Users\\Иван 1488']);
  assert.deepEqual(lines, log.snapshot().map(entry => entry.text));
});

test('without a code page, a line that is not UTF-8 still shows', async () => {
  const log = createActivityLog();
  const { result } = start(`process.stdout.write(Buffer.from([0x41, 0xC8, 0xE2, 0x0A]))`, log.write, { codePage: null });
  await result;
  assert.deepEqual(log.snapshot().map(entry => entry.text), ['A\uFFFD\uFFFD']);
});

test('Windows code pages map to their decoders', () => {
  assert.equal(codePageDecoder(1251).decode(Buffer.from([0xC8, 0xE2, 0xE0, 0xED])), 'Иван');
  assert.equal(codePageDecoder(1252).decode(Buffer.from([0x43, 0x61, 0x66, 0xE9])), 'Café');
  assert.equal(codePageDecoder(932).decode(Buffer.from([0x83, 0x7D, 0x83, 0x8A, 0x83, 0x49])), 'マリオ');
  assert.equal(codePageDecoder(936).decode(Buffer.from([0xC2, 0xED, 0xC0, 0xEF, 0xB0, 0xC2])), '马里奥');
  assert.equal(codePageDecoder(65001), null);
  assert.equal(codePageDecoder(NaN), null);
  assert.equal(codePageDecoder(12345), null);
});

test('signal termination and spawn failure retain their actual cause', { timeout: 5000 }, async () => {
  const log = createActivityLog();
  const { child, result } = start('setInterval(() => {}, 1000)', log.write);
  child.kill('SIGTERM');
  const status = await result;
  assert.equal(status.code, null);
  assert.equal(status.signal, 'SIGTERM');
  assert.equal(exitDescription('Game', status.code, status.signal), 'Game terminated by SIGTERM');
  assert.equal(exitDescription('Build', 7, null), 'Build exited with code 7');

  const missing = spawn('/sms-launcher-nonexistent-command', [], { stdio: ['ignore', 'pipe', 'pipe'] });
  const failed = await observeProcess(missing, { output: log.write });
  assert.equal(failed.error.code, 'ENOENT');
});

// As the game's crash reporter's addr2line did: started with the game's pipes, and still running after it.
test('a child ends when it exits, after settleAfterExit, though a program it started holds its pipes', { timeout: 10000 }, async () => {
  const lines = [];
  let lingered = 0, holder = 0;
  const { result } = start(`
    const { spawn } = require('node:child_process');
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit', detached: true });
    holder.unref();
    console.log('holder ' + holder.pid);
    console.error('crashed');
    process.exit(3);
  `, () => null, { line: value => { lines.push(value); holder ||= Number(/^holder (\d+)$/.exec(value)?.[1] || 0); },
    settleAfterExit: 300, lingering: () => { lingered++; } });
  try {
    const started = Date.now();
    const status = await result;
    assert.equal(status.code, 3);
    assert.equal(lingered, 1);
    assert.ok(Date.now() - started < 5000);
    assert.ok(lines.includes('crashed'));
    assert.ok(holder > 0);
    assert.doesNotThrow(() => process.kill(holder, 0), 'the holder still runs: only the launcher stopped waiting');
  } finally {
    try { process.kill(holder, 'SIGKILL'); } catch (_) { /* already exited */ }
  }
});

test('a child whose pipes close as it exits is not lingering', async () => {
  let lingered = 0;
  const { result } = start('console.log("done")', () => null, { settleAfterExit: 50, lingering: () => { lingered++; } });
  assert.equal((await result).code, 0);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(lingered, 0);
});

test('Windows native statuses use hexadecimal and signed or unsigned codes mean the same exception', () => {
  for (const [code, name] of [[0xC0000374, 'heap corruption'], [0xC0000409, 'fast-fail'],
    [0xC00000FD, 'stack overflow'], [0xC0000005, 'access violation']]) {
    const hex = code.toString(16).toUpperCase();
    for (const value of [code, code | 0])
      assert.ok(exitDescription('Game', value, null, 'win32').includes(`(0x${hex}: ${name})`));
  }
});

test('game failure messages never blame normal resource warnings or stage context', () => {
  for (const lines of [['Could not find customStages.bin', 'Delay Context: 5'], ['Delay Context: 10']]) {
    assert.equal(failureMessage('Game', { code: 127, signal: null }, lines, { game: true, platform: 'win32' }),
      'Game exited with code 127. See the activity log.');
    assert.equal(failureMessage('Game', { code: 0xC0000374, signal: null }, lines, { game: true, platform: 'win32' }),
      'Game exited with code 3221226356 (0xC0000374: heap corruption). See the activity log.');
  }
  assert.match(failureMessage('Build', { code: 1, signal: null }, ['fatal error: missing header']), /missing header/);
});
