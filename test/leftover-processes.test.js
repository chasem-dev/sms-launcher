'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { gameFolders, windowsCommand, stopLeftoverAddr2line } = require('../src/leftover-processes');

test('game folders: never a drive root, each once whatever its case', () => {
  assert.deepEqual(gameFolders(['C:\\', 'D:/', null, undefined, '', 'C:\\Games\\SMS', 'c:\\games\\sms\\', 'C:/Games/SMS/versions/abc']),
    ['C:\\Games\\SMS', 'C:\\Games\\SMS\\versions\\abc']);
});

test('the folders and the game go to PowerShell in its environment, not its command', () => {
  const { command, args, env } = windowsCommand({ parent: 4242, roots: ["C:\\Users\\O'Brien\\[SMS]", 'C:\\'] }, { PATH: 'x' });
  assert.equal(command, 'powershell.exe');
  assert.equal(args.at(-1).includes("O'Brien"), false);
  assert.equal(env.SMS_LEFTOVER_PARENT, '4242');
  assert.equal(env.SMS_LEFTOVER_ROOTS, "C:\\Users\\O'Brien\\[SMS]");
  assert.equal(env.PATH, 'x');
});

test('only Windows looks, only with something to look for, and reads the ended process IDs', async () => {
  const calls = [];
  const run = (command, args, options, done) => { calls.push(options.env); done(null, '1234\r\n\r\n5678\r\n'); };
  assert.deepEqual(await stopLeftoverAddr2line({ parent: 1, roots: ['C:\\SMS'] }, { run, platform: 'linux' }), []);
  assert.deepEqual(await stopLeftoverAddr2line({ roots: ['C:\\'] }, { run, platform: 'win32' }), []);
  assert.equal(calls.length, 0);
  assert.deepEqual(await stopLeftoverAddr2line({ roots: ['C:\\SMS'] }, { run, platform: 'win32' }), [1234, 5678]);
  const failed = (command, args, options, done) => done(new Error('no PowerShell'), '');
  assert.deepEqual(await stopLeftoverAddr2line({ parent: 9 }, { run: failed, platform: 'win32' }), []);
});

const running = pid => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };
async function until(check, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 100))) if (check()) return true;
  return check();
}

// Node, copied as addr2line.exe, stands in for the crash reporter's: it waits, with the game it "reads" in its command
// line (after --, which Node leaves to the script).
test('Windows: ends the addr2line reading a game in the launcher\'s folders, or left by the game, and no other',
  { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sms leftover [O'Brien]-"));
    const tools = path.join(root, 'tools'), games = path.join(root, 'games');
    fs.mkdirSync(tools);
    const addr2line = path.join(tools, 'addr2line.exe');
    fs.copyFileSync(process.execPath, addr2line);
    const wait = 'setTimeout(() => {}, 60000)';
    const started = [];
    const startAddr2line = executable => {
      const child = spawn(addr2line, ['-e', wait, '--', '-f', '-C', '-e', executable, '0x1400010a0'], { stdio: 'ignore', windowsHide: true });
      started.push(child.pid);
      return child.pid;
    };
    try {
      const reading = startAddr2line(path.join(games, 'versions', 'abc', 'build', 'sms.exe'));
      const other = startAddr2line(path.join(os.tmpdir(), 'some-other-program.exe'));
      // A game that started one and closed.
      const game = spawn(process.execPath, ['-e', `
        const child = require('node:child_process').spawn(${JSON.stringify(addr2line)}, ['-e', ${JSON.stringify(wait)}], { stdio: 'ignore', detached: true });
        console.log(child.pid);
        child.unref();`], { stdio: ['ignore', 'pipe', 'inherit'] });
      let text = '';
      game.stdout.on('data', data => { text += data; });
      await new Promise(resolve => game.on('close', resolve));
      const left = Number(text.trim());
      assert.ok(left > 0, `the game said ${JSON.stringify(text)}`);
      started.push(left);
      assert.ok(await until(() => [reading, other, left].every(running)));

      assert.deepEqual(await stopLeftoverAddr2line({ roots: [games] }), [reading]);
      assert.deepEqual(await stopLeftoverAddr2line({ parent: game.pid, roots: [games] }), [left]);
      assert.ok(await until(() => !running(reading) && !running(left)));
      assert.equal(running(other), true);
    } finally {
      for (const pid of started) { try { process.kill(pid); } catch (_) { /* already exited */ } }
      await until(() => !started.some(running));
      // Windows keeps a program's file locked for a moment after it ends (and an antivirus scans a new one):
      // a folder left in the temp directory is no reason to fail.
      try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
      catch (error) { t.diagnostic(`left ${root}: ${error.message}`); }
    }
  });
