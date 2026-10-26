'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const tar = require('tar');
const tools = require('../src/build-tools');
const x64Tools = { skip: process.arch !== 'x64' && 'Linux/Windows tool archives require an x64 host.' };

test('Linux private Make builds a nested CMake project when the tools path contains spaces', {
  skip: process.platform !== 'linux'
}, t => {
  const cmake = spawnSync('sh', ['-c', 'command -v cmake'], { encoding: 'utf8' }).stdout.trim();
  const make = spawnSync('sh', ['-c', 'command -v make'], { encoding: 'utf8' }).stdout.trim();
  if (!cmake || !make) return t.skip('This integration check requires CMake and GNU Make.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms private tools with spaces-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'env', 'bin');
  const source = path.join(root, 'project');
  const child = path.join(source, 'child');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(child, { recursive: true });
  fs.symlinkSync(make, path.join(bin, 'make'));
  fs.writeFileSync(path.join(source, 'CMakeLists.txt'), `
    cmake_minimum_required(VERSION 3.20)
    project(path_probe NONE)
    include(ExternalProject)
    ExternalProject_Add(child SOURCE_DIR "\${CMAKE_CURRENT_SOURCE_DIR}/child"
      BINARY_DIR "\${CMAKE_CURRENT_BINARY_DIR}/child" INSTALL_COMMAND "")
  `);
  fs.writeFileSync(path.join(child, 'CMakeLists.txt'), `
    cmake_minimum_required(VERSION 3.20)
    project(child NONE)
    add_custom_target(path_probe ALL COMMAND "\${CMAKE_COMMAND}" -E touch "\${CMAKE_BINARY_DIR}/passed")
  `);
  const build = path.join(root, 'build');
  const env = tools.environmentAtRoot(root, { ...process.env, PATH: `${bin}:${process.env.PATH}` }, 'linux');
  for (const args of [
    ['-S', source, '-B', build, '-G', 'Unix Makefiles', `-DCMAKE_MAKE_PROGRAM:FILEPATH=${path.join(bin, 'make')}`],
    ['--build', build]
  ]) {
    const result = spawnSync(cmake, args, { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
  assert.ok(fs.existsSync(path.join(build, 'child', 'passed')));
});

test('a corrupt tool archive preserves the existing tools', x64Tools, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-tools-test-'));
  try {
    const root = tools.rootFor(dir, 'linux');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'keep.txt'), 'existing tools');
    const archive = path.join(dir, 'tools.tar.gz');
    fs.writeFileSync(archive, 'corrupt archive');
    await assert.rejects(tools.prepare(dir, { platform: 'linux', forcePrivate: true,
      archiveFile: archive, source: { name: 'tools.tar.gz', sha256: '0'.repeat(64) } }), /SHA-256/);
    assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'existing tools');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed archive relocation restores the previous tools', x64Tools, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-tools-test-'));
  try {
    const root = tools.rootFor(dir, 'linux');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'keep.txt'), 'existing tools');
    const staging = path.join(dir, 'fixture');
    fs.mkdirSync(path.join(staging, 'env'), { recursive: true });
    fs.writeFileSync(path.join(staging, 'env', 'payload'), 'new tools');
    const archive = path.join(dir, 'tools.tar.gz');
    await tar.c({ gzip: true, file: archive, cwd: staging }, ['env']);
    await assert.rejects(tools.prepare(dir, { platform: 'linux', forcePrivate: true,
      archiveFile: archive, source: { name: 'tools.tar.gz', sha256: await tools.hashFile(archive) },
      run: async () => { throw new Error('relocation failed'); } }), /relocation failed/);
    assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'existing tools');
    assert.equal(fs.existsSync(path.join(root, 'env')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// A matching tools installation with every required file, at rootFor's location.
function installedTools(dir, platform) {
  const root = tools.rootFor(dir, platform);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'ready.json'), JSON.stringify({ toolset: tools.toolsetFor(platform), archiveSha256: tools.assetFor(platform).sha256 }));
  for (const file of tools.missingTools(dir, platform)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'fixture');
  }
  return root;
}

test('Windows tools that lose an executable after setup are no longer ready, and a failed build names it', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-deleted-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(tools.missingTools(dir, 'win32'), null);
  assert.equal(tools.deletedToolsError(dir, 'win32'), null);
  const root = installedTools(dir, 'win32');
  assert.ok(['ninja.exe', 'cmake.exe', 'clang++.exe', 'python.exe', 'g++.exe']
    .every(name => fs.existsSync(path.join(root, 'msys64', 'mingw64', 'bin', name))));
  assert.equal(tools.privateReady(dir, 'win32'), true);
  assert.equal(tools.deletedToolsError(dir, 'win32'), null);
  fs.rmSync(path.join(root, 'msys64', 'mingw64', 'bin', 'ninja.exe'));
  assert.equal(tools.privateReady(dir, 'win32'), false);
  assert.deepEqual(tools.missingTools(dir, 'win32'), [path.join('msys64', 'mingw64', 'bin', 'ninja.exe')]);
  assert.deepEqual(tools.status(dir, 'win32', {}), { ready: false, mode: 'missing' });
  const message = tools.deletedToolsError(dir, 'win32').message;
  assert.match(message, /missing ninja\.exe\. Antivirus/);
  assert.ok(message.includes(path.dirname(root)));
  for (const name of ['cmake.exe', 'clang.exe', 'clang++.exe', 'python.exe', 'gcc.exe'])
    fs.rmSync(path.join(root, 'msys64', 'mingw64', 'bin', name));
  assert.match(tools.deletedToolsError(dir, 'win32').message, /missing gcc\.exe, clang\.exe, clang\+\+\.exe, cmake\.exe and 2 more\./);
  // Another toolset's files say nothing about this release's.
  fs.writeFileSync(path.join(root, 'ready.json'), JSON.stringify({ toolset: 'older', archiveSha256: tools.assetFor('win32').sha256 }));
  assert.equal(tools.missingTools(dir, 'win32'), null);
});

test('a Windows build that antivirus breaks names the tool, and a compiler it deleted counts as missing', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-blocked-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = installedTools(dir, 'win32');
  const cc1plus = path.join(root, 'msys64', 'mingw64', 'lib', 'gcc', 'x86_64-w64-mingw32', '16.2.0', 'cc1plus.exe');
  assert.ok(fs.existsSync(cc1plus));
  assert.equal(tools.privateReady(dir, 'win32'), true);
  // Quarantined while the game built: the failed build says so, and setup puts it back.
  fs.rmSync(cc1plus);
  assert.equal(tools.privateReady(dir, 'win32'), false);
  assert.match(tools.deletedToolsError(dir, 'win32').message, /missing cc1plus\.exe\. Antivirus/);

  const build = [
    '[608/665] Building CXX object platform/gx/CMakeFiles/sms_gx.dir/src/gx_fifo.cpp.obj',
    'FAILED: platform/gx/CMakeFiles/sms_gx.dir/src/gx_fifo.cpp.obj',
    "g++.exe: fatal error: cannot execute 'cc1plus': CreateProcess: No such file or directory",
    'compilation terminated.',
    'ninja: build stopped: subcommand failed.'
  ];
  const blocked = tools.blockedToolError(dir, build, 'win32');
  assert.match(blocked.message, /^Windows wouldn't run cc1plus\.exe while building the game \(No such file or directory\)\. Antivirus usually causes this: restore it from your antivirus's quarantine/);
  assert.ok(blocked.message.includes(path.dirname(tools.rootFor(dir, 'win32'))));
  assert.match(blocked.message, /Exclusions\), then try again: the launcher sets up any build tools that are missing again\.$/);
  assert.equal(blocked.blockedTool, 'cc1plus.exe');
  const tool = lines => tools.blockedToolError(dir, lines, 'win32')?.blockedTool;
  assert.equal(tool(['ninja: fatal: CreateProcess: Access is denied.']), 'one of the build tools');
  assert.equal(tool(['/usr/bin/bash: line 1: /c/Users/me/msys64/mingw64/bin/ninja.exe: Permission denied']), 'ninja.exe');
  assert.equal(tool(["clang++: error: unable to execute command: Couldn't execute program 'C:\\\\T\\\\msys64\\\\mingw64\\\\bin\\\\ld.lld.exe': Access is denied."]), 'ld.lld.exe');
  assert.match(tools.blockedToolError(dir, ['ninja: fatal: CreateProcess: Operation did not complete successfully because the file contains a virus or potentially unwanted software.'], 'win32').message,
    /contains a virus or potentially unwanted software\)\. Antivirus/);
  // An ordinary compile error, and other systems, are left as they are.
  assert.equal(tools.blockedToolError(dir, ["gx_fifo.cpp:12:3: error: expected ';' before '}' token", 'ninja: build stopped: subcommand failed.'], 'win32'), null);
  assert.equal(tools.blockedToolError(dir, build, 'linux'), null);
  assert.equal(tools.blockedToolError(dir, undefined, 'win32'), null);
});

test('setup unpacks tools that lost files again, and names files still missing after unpacking', x64Tools, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-deleted-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = installedTools(dir, 'linux');
  fs.rmSync(path.join(root, 'env', 'bin', 'cmake'));
  const staging = path.join(dir, 'fixture');
  fs.mkdirSync(path.join(staging, 'env', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'env', 'bin', 'g++'), 'fixture');
  const archive = path.join(dir, 'tools.tar.gz');
  await tar.c({ gzip: true, file: archive, cwd: staging }, ['env']);
  const details = [];
  await assert.rejects(tools.prepare(dir, { platform: 'linux', archiveFile: archive,
    source: { name: 'tools.tar.gz', sha256: await tools.hashFile(archive) }, run: async () => {},
    progress: (_percent, detail) => details.push(detail) }), error => {
    // Only g++ was in the archive: what's still missing after unpacking is named, for the alert.
    assert.match(error.message, /^The build tools are missing git, cmake, python3, make and \d+ more\. Then try again\.$/);
    assert.ok(error.missingTools.includes(path.join('env', 'bin', 'cmake')));
    return true;
  });
  assert.equal(details[0], 'The build tools are missing cmake. Setting them up again.');
  // The installation it replaced comes back.
  assert.equal(fs.existsSync(path.join(root, 'env', 'bin', 'git')), true);
});

test('matching legacy tools are reused, while changed archives get a separate root and leave old tools intact', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-tool-versions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const legacy = tools.legacyRootFor(dir, 'linux');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'ready.json'), JSON.stringify({ toolset: tools.toolsetFor('linux'), archiveSha256: tools.assetFor('linux').sha256 }));
  fs.writeFileSync(path.join(legacy, 'keep.txt'), 'libraries for my older game');
  assert.equal(tools.rootFor(dir, 'linux'), legacy);
  fs.writeFileSync(path.join(legacy, 'ready.json'), JSON.stringify({ toolset: 'older', archiveSha256: '0'.repeat(64) }));
  assert.notEqual(tools.rootFor(dir, 'linux'), legacy);
  assert.equal(fs.readFileSync(path.join(legacy, 'keep.txt'), 'utf8'), 'libraries for my older game');
});

test('fallback play can use a recorded older Windows toolset without downloading the current tools', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-old-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'msys64'));
  const env = tools.environmentAtRoot(dir, { PATH: 'existing path', SMS_ARCH: '32' }, 'win32');
  assert.equal(env.MSYS2_ROOT, path.join(dir, 'msys64'));
  assert.equal(env.MSYSTEM, 'MINGW32');
  assert.ok(env.PATH.includes(path.join(dir, 'msys64', 'usr', 'bin')));
  const current = tools.environmentAtRoot(dir, { PATH: 'existing path', SMS_ARCH: '64' }, 'win32');
  assert.equal(current.MSYSTEM, 'MINGW64');
  assert.ok(current.PATH.startsWith(path.join(dir, 'msys64', 'mingw64', 'bin')));
  assert.equal(current.PATH.includes(path.join(dir, 'msys64', 'mingw32', 'bin')), false);
});

test('an explicit SMS_MSYS2_ROOT replaces the bundled Windows tools without downloading them', t => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-own-msys2-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const own = path.join(userData, 'Win7 MSYS2');
  assert.deepEqual(tools.status(userData, 'win32', {}), { ready: false, mode: 'missing' });
  assert.deepEqual(tools.status(userData, 'win32', { SMS_MSYS2_ROOT: own }), { ready: true, mode: 'own' });
  assert.equal(tools.status(userData, 'linux', { SMS_MSYS2_ROOT: own }).mode, 'missing');
  const env = tools.environment(userData, { PATH: 'system', SMS_ARCH: '64', SMS_MSYS2_ROOT: own }, 'win32');
  assert.equal(env.MSYS2_ROOT, own);
  assert.equal(env.MSYSTEM, 'MINGW64');
  assert.ok(env.PATH.startsWith(`${path.join(own, 'mingw64', 'bin')};${path.join(own, 'usr', 'bin')};`));
  // Play's recorded toolset still yields to the player's choice.
  fs.mkdirSync(path.join(userData, 'recorded', 'msys64'), { recursive: true });
  assert.equal(tools.environmentAtRoot(path.join(userData, 'recorded'), { SMS_MSYS2_ROOT: own }, 'win32').MSYS2_ROOT, own);
});

test('Windows build keeps the system Path that a copied environment spells Path', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-path-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'msys64', 'usr', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'msys64', 'usr', 'bin', 'bash.exe'), '');
  // A copy of process.env on Windows, as port.buildEnvironment makes it.
  const env = tools.environmentAtRoot(root, { Path: 'C:\\WINDOWS\\system32', SMS_ARCH: '64' }, 'win32');
  assert.deepEqual(Object.keys(env).filter(key => key.toUpperCase() === 'PATH'), ['PATH']);
  assert.ok(env.PATH.startsWith(path.join(root, 'msys64', 'mingw64', 'bin')));
  assert.ok(env.PATH.endsWith(';C:\\WINDOWS\\system32'));
  const port = require('../src/port');
  for (const command of [port.commandFor(root, 'build', [], 'win32', { ...env, Path: 'stale' }),
    port.commandFor(root, 'build', [], 'win32', { Path: 'C:\\WINDOWS\\system32', MSYS2_ROOT: path.join(root, 'msys64') }),
    port.commandFor(root, 'run', ['disc.iso'], 'win32', { Path: 'C:\\WINDOWS\\system32', MSYS2_ROOT: path.join(root, 'msys64') })]) {
    assert.deepEqual(Object.keys(command.env).filter(key => key.toUpperCase() === 'PATH'), ['PATH']);
    assert.ok(command.env.PATH.endsWith(';C:\\WINDOWS\\system32'));
  }
});

test('Windows build tools ignore another Python install\'s environment', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-python-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'msys64', 'usr', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'msys64', 'usr', 'bin', 'bash.exe'), '');
  const host = { Path: 'C:\\WINDOWS\\system32', PYTHONPATH: 'C:\\Python312\\DLLs', PythonHome: 'C:\\Python312',
    PYTHONSTARTUP: 'startup.py', PYTHONUSERBASE: 'C:\\Users\\me\\py', PythonNoUserSite: '', PYTHONUTF8: '1' };
  const python = env => Object.keys(env).filter(key => key.toUpperCase().startsWith('PYTHON')).sort();
  for (const arch of ['64', '32']) {
    const env = tools.environmentAtRoot(root, { ...host, SMS_ARCH: arch }, 'win32');
    assert.deepEqual(python(env), ['PYTHONNOUSERSITE', 'PYTHONUTF8']);
    assert.equal(env.PYTHONNOUSERSITE, '1');
    const command = require('../src/port').commandFor(root, 'textures', [], 'win32', env);
    assert.deepEqual(python(command.env), ['PYTHONNOUSERSITE', 'PYTHONUTF8']);
  }
  const cross = path.join(root, 'msys64', 'opt', 'bin', 'i686-w64-mingw32-g++.exe');
  fs.mkdirSync(path.dirname(cross), { recursive: true });
  fs.writeFileSync(cross, 'fixture');
  const env = tools.environmentAtRoot(root, { ...host, SMS_ARCH: '32' }, 'win32');
  assert.equal(env.SMS_WINDOWS_32_CROSS, '1');
  assert.deepEqual(python(env), ['PYTHONNOUSERSITE', 'PYTHONUTF8']);
  fs.mkdirSync(path.join(root, 'env'));
  assert.equal(tools.environmentAtRoot(root, { PYTHONPATH: 'kept' }, 'linux').PYTHONPATH, 'kept');
});

test('Windows tools give Python a non-empty CA bundle when MinGW\'s shipped empty', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-ca-bundle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const msys = path.join(root, 'msys64');
  const mingw = path.join(msys, 'mingw64', 'etc', 'ssl', 'cert.pem');
  const usr = path.join(msys, 'usr', 'ssl', 'certs', 'ca-bundle.crt');
  for (const file of [mingw, usr]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(msys, 'usr', 'bin'));
  fs.writeFileSync(path.join(msys, 'usr', 'bin', 'bash.exe'), '');
  // The 2026-10-05.1 archive: MinGW's bundle is 0 bytes, MSYS2's is complete.
  fs.writeFileSync(mingw, '');
  fs.writeFileSync(usr, '-----BEGIN CERTIFICATE-----\n');
  const env = tools.environmentAtRoot(root, { Path: 'C:\\WINDOWS\\system32', SMS_ARCH: '64' }, 'win32');
  assert.equal(env.SSL_CERT_FILE, usr);
  assert.equal(require('../src/port').commandFor(root, 'textures', [], 'win32', env).env.SSL_CERT_FILE, usr);
  // A repaired MinGW bundle is preferred.
  fs.writeFileSync(mingw, '-----BEGIN CERTIFICATE-----\n');
  assert.equal(tools.environmentAtRoot(root, { SMS_ARCH: '64' }, 'win32').SSL_CERT_FILE, mingw);
  // The player's own bundle wins, but not a stale setting naming nothing.
  const own = path.join(root, 'company.pem');
  fs.writeFileSync(own, '-----BEGIN CERTIFICATE-----\n');
  assert.equal(tools.environmentAtRoot(root, { ssl_cert_file: own, SMS_ARCH: '64' }, 'win32').ssl_cert_file, own);
  const stale = tools.environmentAtRoot(root, { ssl_cert_file: path.join(root, 'gone.pem'), SMS_ARCH: '64' }, 'win32');
  assert.deepEqual(Object.keys(stale).filter(key => key.toUpperCase() === 'SSL_CERT_FILE'), ['SSL_CERT_FILE']);
  assert.equal(stale.SSL_CERT_FILE, mingw);
  // Linux and Mac keep their own OpenSSL configuration.
  fs.mkdirSync(path.join(root, 'env'));
  assert.equal(tools.environmentAtRoot(root, {}, 'linux').SSL_CERT_FILE, undefined);
});

test('32-bit Windows target uses x64 helpers and a cross compiler, with target DLLs first', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-cross-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cross = path.join(root, 'msys64', 'opt', 'bin', 'i686-w64-mingw32-g++.exe');
  fs.mkdirSync(path.dirname(cross), { recursive: true });
  fs.writeFileSync(cross, 'fixture');
  const env = tools.environmentAtRoot(root, { PATH: 'system', SMS_ARCH: '32' }, 'win32');
  assert.equal(env.MSYSTEM, 'MINGW64');
  assert.equal(env.SMS_WINDOWS_32_CROSS, '1');
  assert.equal(env.CXX, cross);
  assert.equal(env.CMAKE_PREFIX_PATH, path.join(root, 'msys64', 'mingw32'));
  assert.ok(env.PATH.startsWith(path.join(root, 'msys64', 'opt', 'i686-w64-mingw32', 'bin')));
  fs.mkdirSync(path.join(root, 'msys64', 'usr', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'msys64', 'usr', 'bin', 'bash.exe'), '');
  const command = require('../src/port').commandFor(root, 'build', [], 'win32', env);
  assert.equal(command.env.MSYSTEM, 'MINGW64');
  assert.equal(command.env.PATH, env.PATH);
});

test('32-bit Linux target selects the private SDK without changing the host helper library path', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-cross-tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdk = path.join(root, 'env', 'targets', 'linux32');
  fs.mkdirSync(path.join(sdk, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(sdk, 'bin', 'i686-linux-g++'), 'fixture');
  const env = tools.environmentAtRoot(root, { PATH: 'system', SMS_ARCH: '32' }, 'linux');
  assert.equal(env.CXX, path.join(sdk, 'bin', 'i686-linux-g++'));
  assert.equal(env.SMS_LINUX32_ROOT, sdk);
  assert.equal(env.LD_LIBRARY_PATH, undefined);
  assert.ok(env.PATH.startsWith(path.join(root, 'env', 'bin')));
  assert.ok(env.SMS_LINUX32_LIBRARY_PATH.includes('i386-linux-gnu'));
  const root64 = tools.environmentAtRoot(root, { SMS_ARCH: '64' }, 'linux');
  assert.equal(root64.CXX, path.join(root, 'env', 'bin', 'g++'));
  assert.equal(root64.SMS_LINUX32_ROOT, undefined);
});

const posixOnly = { skip: process.platform === 'win32' && 'Uses POSIX shell scripts and the system tar.' };

test('native unpacking counts the files tar names and reports progress', posixOnly, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-native-unpack-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source', 'msys64');
  fs.mkdirSync(source, { recursive: true });
  for (let i = 0; i < 2500; i++) fs.writeFileSync(path.join(source, `f${i}`), '');
  const archive = path.join(dir, 'tools.tar.gz');
  await tar.c({ gzip: true, file: archive, cwd: path.join(dir, 'source') }, ['msys64']);
  const staging = path.join(dir, 'staging');
  fs.mkdirSync(staging);
  const reports = [];
  const files = await tools.unpackNative('tar', ['-xvzf', archive, '-C', staging, 'msys64'],
    (percent, detail) => reports.push(detail));
  assert.ok(files >= 2500, `${files} files named`);
  assert.ok(reports.includes(`Unpacking build tools… ${(2000).toLocaleString()} files`), reports.join('\n'));
  assert.ok(fs.existsSync(path.join(staging, 'msys64', 'f2499')));
});

test('Windows tar is given the archive and staging folder by names without the folder above them', () => {
  // Windows' tar.exe gets "?" for an emoji in its arguments, and can't open the archive.
  const folder = 'C:\\Onedrive\\OD Games\\\u{1F3AE} PC Recomps\\SMS-Launcher-Portable\\build-tools';
  const { args, cwd } = tools.nativeUnpackArgs(`${folder}\\sms-build-tools-windows-x64.tar.gz`,
    `${folder}\\.unpack-a1B2c3`, 'msys64', folder, path.win32);
  assert.deepEqual(args, ['-xvzf', 'sms-build-tools-windows-x64.tar.gz', '-C', '.unpack-a1B2c3', 'msys64']);
  assert.equal(cwd, folder);
  assert.ok(args.every(arg => /^[\x20-\x7e]+$/.test(arg)), args.join(' '));
  // An archive chosen from elsewhere keeps its full path.
  assert.equal(tools.nativeUnpackArgs('D:\\tools.tar.gz', `${folder}\\.unpack-x`, 'msys64', folder, path.win32).args[1],
    'D:\\tools.tar.gz');
});

test('native unpacking runs tar in the given folder, with names relative to it', posixOnly, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-native-cwd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = path.join(dir, '\u{1F3AE} Games', 'build-tools');
  fs.mkdirSync(path.join(folder, 'source', 'msys64'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'source', 'msys64', 'ok'), '');
  const archive = path.join(folder, 'tools.tar.gz');
  await tar.c({ gzip: true, file: archive, cwd: path.join(folder, 'source') }, ['msys64']);
  const staging = fs.mkdtempSync(path.join(folder, '.unpack-'));
  const { args, cwd } = tools.nativeUnpackArgs(archive, staging, 'msys64', folder);
  assert.ok(args.every(arg => !arg.includes(dir)), args.join(' '));
  await tools.unpackNative('tar', args, () => {}, { folder, cwd });
  assert.ok(fs.existsSync(path.join(staging, 'msys64', 'ok')));
});

test('native unpacking stops a tar that names no file for the stall time', posixOnly, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-native-stall-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'tar');
  fs.writeFileSync(fake, '#!/bin/sh\necho msys64/first\nexec sleep 30\n', { mode: 0o755 });
  const started = Date.now();
  await assert.rejects(tools.unpackNative(fake, [], () => {}, { stallMs: 1000 }),
    /stopped: tar named no new file for 1 s \(after 1 files\).*Last file: msys64\/first/);
  assert.ok(Date.now() - started < 10000, 'the stalled tar was stopped');
});

test('native unpacking reports what a failing tar said', posixOnly, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-native-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'tar');
  fs.writeFileSync(fake, '#!/bin/sh\necho "tar: msys64/x: Path too long" >&2\nexit 2\n', { mode: 0o755 });
  await assert.rejects(tools.unpackNative(fake, [], () => {}), /failed \(tar exit code 2\)\. tar: msys64\/x: Path too long/);
});

test('native unpacking reports the files bsdtar could not write, not the last names it listed, and what to do', posixOnly, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-native-errors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // As Windows' tar.exe does: errors follow their file's name, long before it exits.
  const bsdtar = (name, reason) => {
    const fake = path.join(dir, name);
    fs.writeFileSync(fake, `#!/bin/sh
echo "x msys64/usr/bin/ok.exe" >&2
for n in 1 2 3 4 5; do echo "x msys64/opt/deep/file$n.hpp: Can't create '\\\\?\\C:\\Users\\me\\Downloads\\SMS-Launcher-Portable\\build-tools\\file$n.hpp': ${reason}" >&2; done
for n in 1 2 3 4 5 6; do echo "x msys64/opt/last$n.hpp" >&2; done
echo "tar.exe: Error exit delayed from previous errors." >&2
exit 1
`, { mode: 0o755 });
    return fake;
  };
  const folder = 'C:\\Users\\me\\Downloads\\SMS-Launcher-Portable\\build-tools';
  const failure = async reason => {
    try { await tools.unpackNative(bsdtar(`tar-${reason.length}`, reason), [], () => {}, { folder }); }
    catch (error) { return error.message; }
    assert.fail('tar failed');
  };
  const denied = await failure('Permission denied');
  assert.match(denied, /^Unpacking the build tools failed \(tar exit code 1\)\. 5 files failed, the first: x msys64\/opt\/deep\/file1\.hpp: Can't create .*Permission denied \| x msys64\/opt\/deep\/file2\.hpp/);
  assert.doesNotMatch(denied, /file4\.hpp|last\d|Error exit delayed/);
  assert.match(denied, /Antivirus, or Windows Security's Controlled folder access, blocked writing them: allow C:\\Users\\me\\Downloads\\SMS-Launcher-Portable\\build-tools there/);
  assert.match(await failure('Filename too long'), /Windows can't create a path of 260 characters or more, and C:\\Users\\me\\Downloads\\SMS-Launcher-Portable\\build-tools is too deep for the build tools: move the launcher to a short folder such as C:\\Games/);
  assert.match(await failure('No space left on device'), /The drive holding C:\\Users\\me\\Downloads\\SMS-Launcher-Portable\\build-tools is full/);
  assert.match(await failure('There is not enough space on the disk.'), /The drive holding C:\\Users\\me\\Downloads\\SMS-Launcher-Portable\\build-tools is full/);
});

test('Windows retries a rename that antivirus blocks for a moment', async () => {
  let calls = 0;
  const waits = [];
  const busy = code => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
  const rename = () => { if (++calls < 4) throw busy(calls === 2 ? 'EBUSY' : 'EPERM'); };
  await tools.renameRetrying('a', 'b', { platform: 'win32', rename, sleep: async ms => { waits.push(ms); } });
  assert.equal(calls, 4);
  assert.deepEqual(waits, [250, 500, 750]);
});

test('a rename that stays blocked says why; other errors and systems fail at once', async () => {
  const sleep = async () => {};
  const blocked = () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); };
  await assert.rejects(tools.renameRetrying('C:\\tools\\.unpack-x', 'C:\\tools\\windows-x64', { platform: 'win32', attempts: 3, rename: blocked, sleep }),
    error => error.code === 'EPERM' && /couldn't be moved into place \(EPERM\)\. Antivirus/.test(error.message));
  let calls = 0;
  const missing = () => { calls++; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  await assert.rejects(tools.renameRetrying('a', 'b', { platform: 'win32', rename: missing, sleep }), { code: 'ENOENT' });
  await assert.rejects(tools.renameRetrying('a', 'b', { platform: 'linux', rename: blocked, sleep }), { code: 'EPERM' });
  assert.equal(calls, 1);
});

test('a real rename goes through on the first try', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-'));
  try {
    fs.mkdirSync(path.join(dir, 'from'));
    await tools.renameRetrying(path.join(dir, 'from'), path.join(dir, 'to'));
    assert.ok(fs.existsSync(path.join(dir, 'to')) && !fs.existsSync(path.join(dir, 'from')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pruning removes toolsets no kept game uses and interrupted downloads, and keeps the rest', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-tool-prune-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const parent = path.join(dir, 'build-tools');
  const id = tools.platformId('linux');
  const current = tools.rootFor(dir, 'linux');
  const make = (name, file = 'ready.json') => {
    fs.mkdirSync(path.join(parent, name), { recursive: true });
    fs.writeFileSync(path.join(parent, name, file), '{}');
  };
  make(path.basename(current));
  make(`${id}-aaaaaaaaaaaa`);
  make(`${id}-bbbbbbbbbbbb`);
  make(id);
  make(`${id}-aaaaaaaaaaaa.previous-0f8fad5b-d9cb-469f-a165-70867728950e`);
  make('.unpack-x1y2z3');
  make('notes', 'mine.txt');
  make('windows-x64');
  fs.writeFileSync(path.join(parent, 'sms-build-tools-linux-x64-2026-10-05.1.tar.gz.part'), 'half a download');
  fs.writeFileSync(path.join(parent, 'readme.txt'), 'mine');
  const errors = [];
  const removed = await tools.pruneToolsets(dir, [path.join(parent, `${id}-bbbbbbbbbbbb`)],
    { platform: 'linux', onError: error => errors.push(error) });
  assert.deepEqual(errors, []);
  assert.deepEqual(removed.map(item => path.basename(item)).sort(), [`.unpack-x1y2z3`, id, `${id}-aaaaaaaaaaaa`,
    `${id}-aaaaaaaaaaaa.previous-0f8fad5b-d9cb-469f-a165-70867728950e`, 'sms-build-tools-linux-x64-2026-10-05.1.tar.gz.part'].sort());
  assert.deepEqual(fs.readdirSync(parent).sort(), [path.basename(current), `${id}-bbbbbbbbbbbb`, 'notes', 'readme.txt', 'windows-x64'].sort());
  assert.deepEqual(await tools.pruneToolsets(path.join(dir, 'none'), [], { platform: 'linux' }), []);
});

test('pruning keeps every toolset when a kept game\'s tools are not known', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-tool-prune-unknown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = tools.platformId('linux');
  fs.mkdirSync(path.join(dir, 'build-tools', `${id}-aaaaaaaaaaaa`), { recursive: true });
  fs.mkdirSync(path.join(dir, 'build-tools', '.unpack-abc'));
  const removed = await tools.pruneToolsets(dir, [], { platform: 'linux', leftoversOnly: true });
  assert.deepEqual(removed.map(item => path.basename(item)), ['.unpack-abc']);
  assert.ok(fs.existsSync(path.join(dir, 'build-tools', `${id}-aaaaaaaaaaaa`)));
});

test('a Windows step whose MSYS2 programs cannot fork() points to Mandatory ASLR', () => {
  // wariie's clone, which failed the same way on every try.
  const clone = [
    "Cloning into 'C:/Users/me/AppData/Roaming/sms-launcher/sms-pc-port.download-1'...",
    '      0 [main] git-remote-https 1234 child_copy: dll data read copy failed, 0x7FFE0000..0x7FFE1000, done 0, windows pid 5678, Win32 error 299',
    'error: cannot fork() for remote-https: Resource temporarily unavailable'
  ];
  const failed = Object.assign(new Error('Download port source exited with code 128: error: cannot fork() for remote-https: Resource temporarily unavailable. See the activity log.'), { output: clone });
  const hint = tools.forkFailedError(failed, 'win32');
  assert.match(hint.message, /^Windows stopped the build tools from starting their own programs \(error: cannot fork\(\) for remote-https: Resource temporarily unavailable\)\. /);
  assert.match(hint.message, /Exploit protection settings, and set "Force randomization for images \(Mandatory ASLR\)" back to "Use default \(Off\)"\. Then restart the computer and try again\.$/);
  assert.equal(hint.buildHint, 'mandatory-aslr');
  assert.equal(tools.hintedError(failed, { dataFolder: 'C:\\Users\\me\\AppData\\Roaming\\sms-launcher', platform: 'win32' }).buildHint, 'mandatory-aslr');
  for (const line of [clone[1], 'bash: fork: retry: Resource temporarily unavailable', 'make: fork: Resource temporarily unavailable',
    '      1 [main] bash 99 child_copy: cygheap read copy failed, 0x0..0x0, done 0, windows pid 1, Win32 error 299',
    '      0 [main] sh 3 dofork: child -1 - died waiting for dll loading, errno 11'])
    assert.ok(tools.forkFailed([line], 'win32'), line);
  // Other errors, other systems, and an error that already says this, are left as they are.
  assert.equal(tools.forkFailedError(new Error('fatal: early EOF'), 'win32'), null);
  assert.equal(tools.forkFailedError({ message: 'x', output: ["gx_fifo.cpp:12:3: error: expected ';' before '}' token"] }, 'win32'), null);
  assert.equal(tools.forkFailedError(failed, 'linux'), null);
  assert.equal(tools.forkFailedError(hint, 'win32'), null);
  assert.equal(tools.forkFailedError(undefined, 'win32'), null);
});

test('a step that runs out of disk space says which drive is full instead of blaming antivirus', () => {
  const dataFolder = 'C:\\Users\\me\\AppData\\Roaming\\sms-launcher';
  // dewarq's and gustavo_07288's: the port source download, as Node reports it.
  const node = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  const hint = tools.outOfSpaceError(node, { dataFolder, gameFolder: `${dataFolder}\\sms-pc-port`, platform: 'win32' });
  assert.equal(hint.message, `Your C: drive (the launcher's data folder, ${dataFolder}) is full (ENOSPC: no space left on device, write). ` +
    'Free up space on it, then try again: the build tools take a few GB, and HD textures need about 3 GB more. ' +
    'Settings, Manage game, Free up space removes old game versions the launcher no longer uses.');
  assert.doesNotMatch(hint.message, /antivirus/i);
  assert.equal(hint.buildHint, 'disk-full');
  assert.match(tools.outOfSpaceError(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }), { dataFolder, platform: 'win32' }).message, /\(ENOSPC\)\./);
  // A game folder on another drive is named too.
  assert.match(tools.outOfSpaceError(node, { dataFolder, gameFolder: 'D:\\Games\\sms-pc-port', platform: 'win32' }).message,
    /^Your C: drive \(the launcher's data folder, .+\) or your D: drive \(the game folder, D:\\Games\\sms-pc-port\) is full/);
  // Elsewhere, the folder alone.
  assert.match(tools.outOfSpaceError(node, { dataFolder: '/home/me/.config/sms-launcher', platform: 'linux' }).message,
    /^The drive holding the launcher's data folder \(\/home\/me\/\.config\/sms-launcher\) is full/);
  // Git, Windows, MSYS2's pacman and the compilers, in a failed step's output.
  for (const line of ['fatal: write error: No space left on device', 'There is not enough space on the disk.',
    'error: Partition C:/Users/me/msys64 too full: 63379 blocks needed, 1024 blocks free', 'error: not enough free disk space',
    'cc1plus.exe: fatal error: error writing to C:\\Users\\me\\AppData\\Local\\Temp\\ccA1.s: No space left on device']) {
    const failed = Object.assign(new Error('Build Sunshine port exited with code 1. See the activity log.'), { output: ['[1/9] Building', line] });
    assert.ok(tools.outOfSpace(failed), line);
    assert.equal(tools.hintedError(failed, { dataFolder, platform: 'win32' }).buildHint, 'disk-full', line);
  }
  // A full drive wins over a fork failure, which it can cause.
  assert.equal(tools.hintedError({ message: 'x', output: ['bash: fork: Resource temporarily unavailable', 'No space left on device'] },
    { dataFolder, platform: 'win32' }).buildHint, 'disk-full');
  // Other errors, and one that already says this, are left as they are.
  assert.equal(tools.outOfSpaceError(new Error('fatal: early EOF'), { dataFolder, platform: 'win32' }), null);
  assert.equal(tools.outOfSpaceError(hint, { dataFolder, platform: 'win32' }), null);
  assert.equal(tools.hintedError(new Error('Access is denied.'), { dataFolder, platform: 'win32' }), null);
});
