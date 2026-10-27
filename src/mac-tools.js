'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function executable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); }
  catch (_) { return false; }
}

function find(command, env, exists = executable) {
  return (env.PATH || '').split(':').filter(Boolean)
    .map(directory => path.posix.join(directory, command)).find(exists);
}

// Finder launches apps with a minimal PATH, even after Homebrew is installed.
// Change only the environment of our children, never shell profiles or system files.
function environment(base = process.env, exists = executable) {
  const prefixes = [...new Set([base.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local'].filter(Boolean))];
  const llvm = prefixes.map(prefix => `${prefix}/opt/llvm/bin`)
    .filter(bin => exists(`${bin}/llvm-objcopy`));
  const bins = [base.SMS_BUILD_TOOLS_BIN, ...llvm, ...prefixes.map(prefix => `${prefix}/bin`),
    '/Applications/CMake.app/Contents/bin', ...(base.PATH || '').split(':'),
    '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return { ...base, PATH: [...new Set(bins.filter(Boolean))].join(':') };
}

// A failed probe says why in `problem` (it went to the activity log): which
// tool that is, and whether it timed out, was killed or exited with an error.
function probe(command, args, env, timeout = 10000) {
  const name = path.posix.basename(command);
  return new Promise(resolve => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    let settled = false;
    const finish = (ok, problem) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout: stdout.trim(), ...(ok ? {} : { problem: `${name} ${problem}` }) });
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(false, `did not start within ${timeout / 1000} s`); }, timeout);
    child.stdout.on('data', bytes => { if (stdout.length < 16384) stdout += bytes; });
    child.stderr.on('data', bytes => { if (stderr.length < 16384) stderr += bytes; });
    child.on('error', error => finish(false, `could not start: ${error.message}`));
    child.on('close', (code, signal) => {
      const said = stderr.trim().split('\n')[0].slice(0, 200);
      finish(code === 0, signal ? `was stopped by ${signal}` : `exited with code ${code}${said ? `: ${said}` : ''}`);
    });
  });
}

function listSdks(directory) {
  try { return fs.readdirSync(directory); }
  catch (_) { return []; }
}

function newerFirst(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++)
    if ((left[index] || 0) !== (right[index] || 0)) return (right[index] || 0) - (left[index] || 0);
  return 0;
}

// Command Line Tools can install an SDK newer than their linker can read
// (ld: tapi error: malformed file). Keep the default SDK when Apple's linker
// accepts it; otherwise use the newest versioned SDK beside it that links.
async function linkableSdk(defaultSdk, env, run, list) {
  const directory = path.posix.dirname(defaultSdk);
  const versioned = list(directory).map(name => name.match(/^MacOSX(\d+(?:\.\d+)*)\.sdk$/)).filter(Boolean)
    .sort((a, b) => newerFirst(a[1], b[1])).map(match => path.posix.join(directory, match[0]));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-sdk-'));
  try {
    for (const sdk of [...new Set([defaultSdk, ...versioned])]) {
      // The game is x86_64 C++, so link libc++ and libSystem the same way.
      const linked = await run('/usr/bin/clang++', ['-arch', 'x86_64', '-isysroot', sdk, '-dynamiclib',
        '-x', 'c++', '/dev/null', '-o', path.join(scratch, 'probe.dylib')], { ...env, SDKROOT: sdk });
      if (linked.ok) return sdk;
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  return defaultSdk;
}

// timeout: how long each tool may take to start. Freshly unpacked programs can
// take seconds the first time, while macOS checks them.
async function inspect(base = process.env, { run = probe, exists = executable, list = listSdks, timeout = 10000 } = {}) {
  const env = environment(base, exists);
  const runTool = (command, args) => {
    const file = find(command, env, exists);
    return file ? run(file, args, env, timeout) : { ok: false, stdout: '', problem: `${command} not found` };
  };
  const [sdk, silicon, cmake, objcopy, brew] = await Promise.all([
    run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], env, timeout),
    run('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], env, timeout),
    runTool('cmake', ['--version']), runTool('llvm-objcopy', ['--version']),
    // Homebrew is useful for fixing missing packages, but is not itself required.
    Promise.resolve(Boolean(find('brew', env, exists)))
  ]);
  const [appleCommands, python, zip, rosetta, compilers] = await Promise.all([
    sdk.ok ? Promise.all(['git', 'make', 'patch'].map(command => runTool(command, ['--version']))) : [],
    // Apple's Python stub can trigger an installation prompt without an SDK.
    sdk.ok || find('python3', env, exists) !== '/usr/bin/python3'
      ? runTool('python3', ['--version']) : { ok: false },
    Promise.all(['7zz', '7z', '7za'].map(command => runTool(command, ['-h']))),
    silicon.stdout === '1' ? run('/usr/bin/arch', ['-x86_64', '/usr/bin/true'], env, timeout) : { ok: true },
    Promise.all(['clang', 'clang++'].map(command => sdk.ok || find(command, env, exists) !== `/usr/bin/${command}`
      ? runTool(command, ['--version']) : { ok: false }))
  ]);
  const sdkPath = sdk.ok && sdk.stdout ? await linkableSdk(sdk.stdout, env, (...args) => run(...args, timeout), list) : '';
  const cmakeVersion = cmake.stdout.match(/cmake version (\d+)\.(\d+)/);
  const cmakeReady = cmake.ok && Boolean(cmakeVersion) &&
    (Number(cmakeVersion[1]) > 3 || Number(cmakeVersion[1]) === 3 && Number(cmakeVersion[2]) >= 20);
  const problem = (...results) => results.find(result => !result.ok)?.problem;
  return {
    checked: true, homebrew: brew, sdkPath,
    requirements: [
      { id: 'apple', label: 'Apple Command Line Tools', ready: sdk.ok && Boolean(sdk.stdout) &&
        appleCommands.length === 3 && appleCommands.every(result => result.ok) &&
        ['curl', 'hdiutil'].every(command => find(command, env, exists)) },
      { id: 'cmake', label: 'CMake 3.20 or newer', package: 'cmake', ready: cmakeReady,
        problem: cmakeReady ? undefined : problem(cmake) || `cmake is too old: ${cmake.stdout.split('\n')[0]}` },
      { id: 'python', label: 'Python 3', package: 'python3', ready: python.ok, problem: problem(python) },
      { id: 'llvm', label: 'LLVM build tools', package: 'llvm', ready: objcopy.ok && compilers.every(result => result.ok),
        problem: problem(objcopy, ...compilers) },
      ...(silicon.stdout === '1' ? [{ id: 'rosetta', label: 'Rosetta 2', ready: rosetta.ok }] : []),
      { id: 'zip', label: '7-Zip (HD textures and Eclipse)', package: 'sevenzip', optional: true,
        ready: zip.some(result => result.ok), problem: zip.some(result => result.ok) ? undefined : problem(...zip) }
    ]
  };
}

// rosetta: whether the game is built for x86_64 (Rosetta runs it); the Apple
// Silicon build does not need it.
function report(inspection = { checked: false, requirements: [] }, { archives = false, managed = false, rosetta = true } = {}) {
  const requirements = inspection.requirements.map(item => ({ ...item,
    optional: item.id === 'zip' && !archives || item.id === 'rosetta' && !rosetta }));
  const missing = requirements.filter(item => !item.ready && !item.optional);
  const commands = [];
  if (missing.some(item => item.id === 'apple')) commands.push('xcode-select --install');
  if (missing.some(item => item.id === 'rosetta')) commands.push('softwareupdate --install-rosetta');
  const packages = managed ? [] : missing.filter(item => item.package).map(item => item.package);
  if (packages.length) commands.push(`brew install ${packages.join(' ')}`);
  return { ...inspection, requirements, ready: inspection.checked && missing.length === 0,
    mode: inspection.checked && missing.length === 0 ? 'system' : 'missing', managed,
    needsHomebrew: packages.length > 0 && !inspection.homebrew, commands: commands.join('\n'),
    message: inspection.checked ? message(missing, managed) : 'Check the tools needed to prepare your game on this Mac.' };
}

// With the launcher's own tools, a missing package means one of them did not
// run: name each one and why, as only Apple's installs are the player's to do.
function message(missing, managed) {
  if (!missing.length) return 'Mac tools are ready.';
  const install = missing.filter(item => !managed || !item.package);
  if (install.length) return `Install ${install.map(item => item.label).join(', ')} to continue. Open Mac setup help in Step 1.`;
  return `The downloaded build tools did not run: ${missing.map(item => item.problem ? `${item.label} (${item.problem})` : item.label)
    .join('; ')}. Try again, and if it happens again, share the activity log.`;
}

module.exports = { environment, probe, inspect, report };
