'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const assets = require('./tool-assets.json');
const TOOLSET = assets.toolset;
const macAssets = require('./mac-tool-assets.json');
const macTools = require('./mac-tools');
const { prependWindowsPath } = require('./windows-path');
const { retrying, httpError } = require('./retry');
let macInspection;
let macCheck;
let macCheckedAt = 0;

async function check(userData, { platform = process.platform, env = process.env, refresh = false, archives = false, rosetta = true } = {}) {
  if (platform !== 'darwin') return status(userData, platform, env);
  if (refresh || !macInspection || Date.now() - macCheckedAt > 15000) {
    if (!macCheck) macCheck = macTools.inspect(environment(userData, env, platform)).then(result => {
      macInspection = result;
      macCheckedAt = Date.now();
    }).finally(() => { macCheck = null; });
    await macCheck;
  }
  return status(userData, platform, env, { archives, rosetta });
}

function toolsetFor(platform = process.platform, arch = process.arch) {
  const manifest = platform === 'darwin' ? macAssets : assets;
  return manifest.platforms[platform === 'darwin' ? arch : platform]?.toolset || manifest.toolset;
}

function platformId(platform = process.platform, arch = process.arch) {
  return platform === 'darwin' ? `macos-${arch}` : platform === 'win32' ? 'windows-x64' : 'linux-x64';
}

function rootFor(userData, platform = process.platform) {
  const legacy = legacyRootFor(userData, platform);
  const expected = platform === 'darwin' ? macAssets.platforms[process.arch] : assets.platforms[platform];
  // Reuse an existing matching installation in place. Its compiled games may
  // embed this path. New archives get their own immutable location.
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(legacy, 'ready.json'), 'utf8'));
    if (marker.toolset === toolsetFor(platform) && marker.archiveSha256 === expected.sha256) return legacy;
  } catch (_) { /* new tool installation */ }
  return `${legacy}-${expected.sha256.slice(0, 12)}`;
}

function legacyRootFor(userData, platform = process.platform) {
  return path.join(userData, 'build-tools', platformId(platform));
}

// The Windows toolset's GCC version: GCC runs its compilers (cc1plus.exe) and
// linker driver from lib/gcc/<target>/<version>. A new toolset with another
// GCC fails scripts/smoke-build-tools.js until this changes with it.
const WINDOWS_GCC = '16.2.0';

// Files each private toolset must keep. Antivirus can delete an executable
// after unpacking (ninja.exe on Windows), or while the game builds (cc1plus.exe),
// which leaves CMake unable to build; a tool missing any of them is set up again.
const TOOL_FILES = {
  darwin: ['clang', 'clang++', 'git', 'cmake', 'ninja', 'python3', 'make', 'patch', 'llvm-objcopy', '7z']
    .map(name => path.join('env', 'bin', name)),
  win32: ['usr/bin/bash.exe', 'usr/bin/git.exe', 'usr/bin/patch.exe',
    'mingw64/bin/gcc.exe', 'mingw64/bin/g++.exe', 'mingw64/bin/clang.exe', 'mingw64/bin/clang++.exe',
    'mingw64/bin/as.exe', 'mingw64/bin/ld.exe', 'mingw64/bin/objcopy.exe',
    'mingw64/bin/cmake.exe', 'mingw64/bin/ninja.exe', 'mingw64/bin/python.exe', 'mingw64/bin/7z.exe',
    'mingw64/bin/SDL2.dll', 'mingw64/include/SDL2/SDL.h',
    'opt/bin/i686-w64-mingw32-gcc.exe', 'opt/bin/i686-w64-mingw32-g++.exe',
    'mingw32/bin/SDL2.dll', 'mingw32/include/SDL2/SDL.h',
    ...[['mingw64', 'x86_64-w64-mingw32'], ['opt', 'i686-w64-mingw32']].flatMap(([prefix, target]) => [
      ...['cc1.exe', 'cc1plus.exe', 'collect2.exe'].map(name => `${prefix}/lib/gcc/${target}/${WINDOWS_GCC}/${name}`),
      `${prefix}/${target}/bin/as.exe`, `${prefix}/${target}/bin/ld.exe`])].map(file => path.join('msys64', ...file.split('/'))),
  linux: [...['g++', 'git', 'cmake', 'python3', 'make', 'patch', 'objcopy', '7z'].map(name => path.join('env', 'bin', name)),
    path.join('env', 'lib', 'libSDL2-2.0.so.0'),
    path.join('env', 'targets', 'linux32', 'bin', 'i686-linux-g++'),
    path.join('env', 'targets', 'linux32', 'graphics', 'usr', 'lib', 'i386-linux-gnu', 'libSDL2-2.0.so.0')]
};

// The files an installation of this release's tools lacks, or null when
// there is none (not set up yet, or an older toolset).
function missingTools(userData, platform = process.platform) {
  const root = rootFor(userData, platform);
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(root, 'ready.json'), 'utf8'));
    if (installed.toolset !== toolsetFor(platform)) return null;
    const expected = platform === 'darwin' ? macAssets.platforms[process.arch] : assets.platforms[platform];
    if (expected && installed.archiveSha256 !== expected.sha256) return null;
  } catch (_) { return null; }
  return missingFiles(root, platform);
}

function missingFiles(root, platform) {
  return (TOOL_FILES[platform] || TOOL_FILES.linux).filter(file => !fs.existsSync(path.join(root, file)));
}

function privateReady(userData, platform = process.platform) {
  return missingTools(userData, platform)?.length === 0;
}

// Names the deleted files, and on Windows the likely cause and the folder to exclude.
function missingToolsMessage(userData, missing, platform = process.platform) {
  const names = missing.slice(0, 4).map(file => path.basename(file)).join(', ') +
    (missing.length > 4 ? ` and ${missing.length - 4} more` : '');
  return `The build tools are missing ${names}.` + (platform === 'win32'
    ? ` Antivirus usually deletes them: restore them from its quarantine, or exclude ${path.dirname(rootFor(userData, platform))} from scanning.`
    : '');
}

// The error to show for a failed build when the tools lost files since setup.
function deletedToolsError(userData, platform = process.platform) {
  const missing = missingTools(userData, platform);
  return missing?.length ? new Error(`${missingToolsMessage(userData, missing, platform)} Then try again: ` +
    'the launcher sets the build tools up again.') : null;
}

// What a Windows build prints when Windows won't run one of its tools, as when
// antivirus quarantines or blocks ninja.exe or cc1plus.exe while the game
// builds: [pattern, the tool's group or null, the reason's group or null].
const BLOCKED_TOOL = [
  // g++.exe: fatal error: cannot execute 'cc1plus': CreateProcess: No such file or directory
  [/cannot execute '([^']+)': CreateProcess: (.+)/i, 1, 2],
  // clang++: error: unable to execute command: Couldn't execute program 'C:\...\ld.exe': Access is denied.
  [/unable to execute command: .*?'([^']+\.exe)'(?::\s*(.+))?/i, 1, 2],
  // ninja: fatal: CreateProcess: Access is denied
  [/CreateProcess(?: failed)?: (Access is denied|The system cannot find the file specified)/i, null, 1],
  // bash: /mingw64/bin/ninja.exe: Permission denied
  [/([^\s:'"]+\.exe): (Permission denied|Access is denied|cannot execute binary file)/i, 1, 2],
  // Windows' own refusal (ERROR_VIRUS_INFECTED)
  [/(Operation did not complete successfully because the file contains a virus or potentially unwanted software)/i, null, 1]
];

// The error to show for a failed Windows build whose output says Windows
// wouldn't run one of the build tools, or null.
function blockedToolError(userData, lines = [], platform = process.platform) {
  if (platform !== 'win32') return null;
  for (const line of [...lines].reverse()) {
    for (const [pattern, toolGroup, reasonGroup] of BLOCKED_TOOL) {
      const match = String(line).match(pattern);
      if (!match) continue;
      const named = toolGroup ? match[toolGroup] : String(line).match(/([^\s\\/:'"]+\.exe)\b/i)?.[1];
      const tool = named ? path.win32.basename(named.replace(/\//g, '\\')).replace(/^(?!.*\.\w+$)(.+)$/, '$1.exe') : 'one of the build tools';
      const reason = reasonGroup && match[reasonGroup] ? ` (${match[reasonGroup].trim().replace(/\.$/, '')})` : '';
      return Object.assign(new Error(`Windows wouldn't run ${tool} while building the game${reason}. Antivirus usually ` +
        `causes this: restore ${named ? 'it' : 'the build tools'} from your antivirus's quarantine if it took ${named ? 'it' : 'any'}, and allow ` +
        `${path.dirname(rootFor(userData, platform))} in your antivirus (in Windows Security: Virus & threat protection, ` +
        'Manage settings, Exclusions), then try again: the launcher sets up any build tools that are missing again.'),
      { blockedTool: tool });
    }
  }
  return null;
}

// Out of disk space, as Node (ENOSPC), Windows, MSYS2's pacman, Git, tar and
// the compilers say it.
const DISK_FULL = /\bENOSPC\b|No space left on device|There is not enough space on the disk|not enough free disk space|too full: \d+ blocks needed|\bdisk (?:is )?full\b|ERROR_DISK_FULL/i;

// MSYS2 starts programs with its own fork(), which copies the parent's DLL data
// into the child at the same addresses. Windows Security's "Force randomization
// for images (Mandatory ASLR)" loads the DLLs elsewhere, so every fork fails
// (git clone, bash, make), and trying again fails the same way:
//   0 [main] git-remote-https 1234 child_copy: dll data read copy failed, 0x…..0x…, done 0, windows pid 5678, Win32 error 299
//   error: cannot fork() for remote-https: Resource temporarily unavailable
const FORK_FAILED = /child_copy: .*copy failed|\bWin32 error 299\b|cannot fork\(\)|\bfork: (?:retry: )?Resource temporarily unavailable|died waiting for dll loading|address space needed by .+ is already occupied/i;

// The error's message and the output of the step that failed (launch()'s
// error.output), or the output lines themselves.
function errorLines(error) {
  if (!error) return [];
  if (Array.isArray(error)) return error.map(String);
  return [error.message, ...(Array.isArray(error.output) ? error.output : [])].filter(Boolean).map(String);
}

// The last line that matches, trimmed for the message.
function saidLine(pattern, error) {
  const line = errorLines(error).reverse().find(text => pattern.test(text));
  return line && line.trim().replace(/\s+/g, ' ').slice(0, 200).replace(/[.\s]+$/, '');
}

function outOfSpace(error) {
  return Boolean(error?.code === 'ENOSPC' || saidLine(DISK_FULL, error));
}

function forkFailed(error, platform = process.platform) {
  return platform === 'win32' && Boolean(saidLine(FORK_FAILED, error));
}

// The error to show for a Windows step whose MSYS2 programs couldn't fork(), or null.
function forkFailedError(error, platform = process.platform) {
  if (error?.buildHint || !forkFailed(error, platform)) return null;
  return Object.assign(new Error('Windows stopped the build tools from starting their own programs ' +
    `(${saidLine(FORK_FAILED, error)}). Windows Security's Mandatory ASLR setting usually causes this: open Windows Security, ` +
    'App & browser control, Exploit protection settings, and set "Force randomization for images (Mandatory ASLR)" ' +
    'back to "Use default (Off)". Then restart the computer and try again.'), { buildHint: 'mandatory-aslr' });
}

// Whether two folders are on one drive: by device when both exist, otherwise
// by drive letter (Windows) or root.
function sameDrive(a, b, platform) {
  try { return fs.statSync(a).dev === fs.statSync(b).dev; } catch (_) { /* not there yet */ }
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return paths.parse(paths.resolve(a)).root.toLowerCase() === paths.parse(paths.resolve(b)).root.toLowerCase();
}

function driveName(folder, platform) {
  return platform === 'win32' ? path.win32.parse(path.win32.resolve(folder)).root.replace(/[\\/]+$/, '') : '';
}

// The error to show for a step that ran out of disk space, or null. It names the
// launcher's data folder (where the build tools, compiler cache and, by default,
// the game go) and the game folder when that is on another drive.
function outOfSpaceError(error, { dataFolder, gameFolder, platform = process.platform } = {}) {
  if (error?.buildHint || !outOfSpace(error)) return null;
  const why = saidLine(DISK_FULL, error) || 'ENOSPC';
  const where = (folder, what) => {
    const drive = driveName(folder, platform);
    return drive ? `your ${drive} drive (${what}, ${folder})` : `the drive holding ${what} (${folder})`;
  };
  const folders = [where(dataFolder, "the launcher's data folder")];
  if (gameFolder && !sameDrive(dataFolder, gameFolder, platform)) folders.push(where(gameFolder, 'the game folder'));
  const full = folders.join(' or ');
  return Object.assign(new Error(`${full[0].toUpperCase()}${full.slice(1)} is full (${why}). Free up space on it, ` +
    'then try again: the build tools take a few GB, and HD textures need about 3 GB more. Settings, Manage game, ' +
    'Free up space removes old game versions the launcher no longer uses.'), { buildHint: 'disk-full' });
}

// A clearer error for a failed step whose cause the player can fix, or null.
function hintedError(error, { dataFolder, gameFolder, platform = process.platform } = {}) {
  return outOfSpaceError(error, { dataFolder, gameFolder, platform }) || forkFailedError(error, platform);
}

function commandWorks(command, args = [], env = process.env) {
  const result = spawnSync(command, args, { env, windowsHide: true, timeout: 15000, stdio: 'ignore' });
  return result.status === 0;
}

function systemReady(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return macTools.report(macInspection).ready;
  if (platform === 'linux') {
    const commands = ['git', 'cmake', 'make', 'patch', 'python3', 'objcopy', 'g++'];
    return commands.every(command => commandWorks(command, ['--version'], env)) &&
      commandWorks('7z', ['-h'], env) &&
      commandWorks('pkg-config', ['--exists', 'sdl2', 'egl', 'gl'], env);
  }
  if (platform === 'win32') {
    const root = env.MSYS2_ROOT || 'C:\\msys64';
    return ['usr/bin/bash.exe', 'usr/bin/git.exe', 'usr/bin/patch.exe',
      'mingw64/bin/g++.exe', 'mingw64/bin/cmake.exe', 'mingw64/bin/ninja.exe',
      'mingw64/bin/python.exe', 'mingw64/include/SDL2/SDL.h',
      'mingw64/lib/libSDL2.dll.a'].every(file => fs.existsSync(path.join(root, file))) &&
      (fs.existsSync(path.join(root, 'mingw64', 'bin', '7z.exe')) || commandWorks('7z', ['-h'], env));
  }
  return false;
}

function status(userData, platform = process.platform, env = process.env, options = {}) {
  if (platform === 'darwin') {
    const found = macTools.report(macInspection, { ...options, managed: true });
    const installed = privateReady(userData, platform);
    const appleReady = found.checked && found.requirements.filter(item => ['apple', 'rosetta'].includes(item.id) && !item.optional)
      .every(item => item.ready);
    return { ...found, ready: appleReady && installed && found.ready,
      mode: appleReady && installed && found.ready ? 'private' : 'missing',
      privateInstalled: installed, appleReady };
  }
  // Explicit opt-in for a player's own MSYS2 (e.g. the last Windows 7 one):
  // never download the bundled tools, and let the build report what's missing.
  if (platform === 'win32' && env.SMS_MSYS2_ROOT) return { ready: true, mode: 'own' };
  if (privateReady(userData, platform)) return { ready: true, mode: 'private' };
  return { ready: false, mode: 'missing' };
}

function environment(userData, base = process.env, platform = process.platform) {
  return environmentAtRoot(privateReady(userData, platform) ? rootFor(userData, platform) : null, base, platform);
}

function environmentAtRoot(root, base = process.env, platform = process.platform) {
  if (platform === 'darwin') {
    const bin = root && path.join(root, 'env', 'bin');
    const available = Boolean(bin && fs.existsSync(bin));
    const result = macTools.environment(available ? { ...base, SMS_BUILD_TOOLS_BIN: bin } : base);
    if (available) {
      // The Apple Silicon game compiles with LLVM's clang in env/llvm/bin (the
      // arm64 toolset's), beside the llvm-config its pass plugin builds with;
      // the x86_64 game with Apple's, through the wrappers in env/bin.
      const llvm = path.join(root, 'env', 'llvm', 'bin');
      result.SMS_LLVM_BIN = base.SMS_ARCH === 'arm64' && fs.existsSync(path.join(llvm, 'llvm-config')) ? llvm : bin;
      // GNU Make's recursive command cannot quote its own executable path.
      // Application Support always contains a space, so use Ninja on Mac.
      result.CMAKE_GENERATOR = 'Ninja';
    }
    if (macInspection?.sdkPath) result.SDKROOT = macInspection.sdkPath;
    return result;
  }
  const own = platform === 'win32' ? base.SMS_MSYS2_ROOT : null;
  if (!own && (!root || !fs.existsSync(path.join(root, platform === 'win32' ? 'msys64' : 'env')))) return { ...base };
  if (platform === 'linux') {
    const prefix = path.join(root, 'env');
    const bin = path.join(prefix, 'bin');
    const result = {
      ...base, PATH: [bin, base.PATH || ''].join(path.delimiter),
      CC: path.join(bin, 'gcc'), CXX: path.join(bin, 'g++'),
      // GNU Make cannot quote its absolute path in recursive commands.
      // Resolve recursive invocations through the private PATH, including spaces.
      MAKE: 'make',
      CMAKE_PREFIX_PATH: [prefix, base.CMAKE_PREFIX_PATH || ''].filter(Boolean).join(path.delimiter),
      PKG_CONFIG_PATH: [path.join(prefix, 'lib', 'pkgconfig'), base.PKG_CONFIG_PATH || ''].filter(Boolean).join(path.delimiter)
    };
    const sdk = path.join(prefix, 'targets', 'linux32');
    if (base.SMS_ARCH === '32' && fs.existsSync(path.join(sdk, 'bin', 'i686-linux-g++'))) {
      result.CC = path.join(sdk, 'bin', 'i686-linux-gcc');
      result.CXX = path.join(sdk, 'bin', 'i686-linux-g++');
      result.SMS_LINUX32_ROOT = sdk;
      result.SMS_LINUX32_LIBRARY_PATH = [path.join(sdk, 'i686-buildroot-linux-gnu', 'sysroot', 'lib'),
        path.join(sdk, 'i686-buildroot-linux-gnu', 'sysroot', 'usr', 'lib'),
        path.join(sdk, 'graphics', 'usr', 'lib', 'i386-linux-gnu'),
        path.join(sdk, 'graphics', 'lib', 'i386-linux-gnu'),
        path.join(sdk, 'graphics', 'usr', 'lib', 'i386-linux-gnu', 'pulseaudio')].join(':');
      result.LIBGL_DRIVERS_PATH = path.join(sdk, 'graphics', 'usr', 'lib', 'i386-linux-gnu', 'dri');
      result.__EGL_VENDOR_LIBRARY_FILENAMES = path.join(sdk, 'graphics', 'usr', 'share', 'glvnd', 'egl_vendor.d', '50_mesa.json');
    }
    return result;
  }
  const msys = own || path.join(root, 'msys64');
  base = withoutHostPython(base);
  const cross = base.SMS_ARCH === '32' && fs.existsSync(path.join(msys, 'opt', 'bin', 'i686-w64-mingw32-g++.exe'));
  base = withCertificates(base, msys, base.SMS_ARCH === '32' && !cross ? 'mingw32' : 'mingw64');
  if (cross) {
    return { ...prependWindowsPath(base, [path.join(msys, 'opt', 'i686-w64-mingw32', 'bin'), path.join(msys, 'mingw32', 'bin'),
      path.join(msys, 'mingw64', 'bin'), path.join(msys, 'usr', 'bin')]),
      MSYS2_ROOT: msys, MSYSTEM: 'MINGW64', CHERE_INVOKING: '1', SMS_WINDOWS_32_CROSS: '1',
      CC: path.join(msys, 'opt', 'bin', 'i686-w64-mingw32-gcc.exe'),
      CXX: path.join(msys, 'opt', 'bin', 'i686-w64-mingw32-g++.exe'),
      CMAKE_PREFIX_PATH: path.join(msys, 'mingw32') };
  }
  const target = base.SMS_ARCH === '32' ? 'mingw32' : 'mingw64';
  return { ...prependWindowsPath(base, [path.join(msys, target, 'bin'), path.join(msys, 'usr', 'bin')]),
    MSYS2_ROOT: msys, MSYSTEM: target === 'mingw32' ? 'MINGW32' : 'MINGW64', CHERE_INVOKING: '1' };
}

// Another Python's PYTHONPATH or PYTHONHOME makes the bundled Python load that
// install's extension modules, which crashes it with an access violation.
// Windows variable names ignore case, so match them that way.
const HOST_PYTHON = new Set(['PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONUSERBASE', 'PYTHONNOUSERSITE']);

function withoutHostPython(base) {
  const result = Object.fromEntries(Object.entries(base).filter(([key]) => !HOST_PYTHON.has(key.toUpperCase())));
  return { ...result, PYTHONNOUSERSITE: '1' };
}

// The 2026-10-05 Windows tools shipped MinGW's CA bundle empty (pacman's
// p11-kit extraction wrote nothing), so the bundled Python trusted only the
// roots Windows had already cached and failed texture downloads with
// CERTIFICATE_VERIFY_FAILED. Point OpenSSL at a bundle with certificates in it;
// Python still adds the Windows store, so antivirus and company roots work too.
// A player's own SSL_CERT_FILE wins while it names a real bundle.
function withCertificates(base, msys, target) {
  const nonEmpty = file => { try { return fs.statSync(file).size > 0; } catch { return false; } };
  const key = Object.keys(base).find(name => name.toUpperCase() === 'SSL_CERT_FILE');
  if (key && nonEmpty(base[key])) return base;
  const bundle = [path.join(msys, target, 'etc', 'ssl', 'cert.pem'), path.join(msys, 'mingw64', 'etc', 'ssl', 'cert.pem'),
    path.join(msys, 'usr', 'ssl', 'certs', 'ca-bundle.crt')].find(nonEmpty);
  if (!bundle) return base;
  const result = Object.fromEntries(Object.entries(base).filter(([name]) => name !== key));
  return { ...result, SSL_CERT_FILE: bundle };
}

// A download that drops, stalls or arrives cut short is tried again from the
// start (twice more); one the server refuses (a 404) is not.
function fetchVerified(url, destination, expected, onProgress = () => {}, { wait } = {}) {
  return retrying(() => fetchOnce(url, destination, expected, onProgress), { wait });
}

function fetchOnce(url, destination, expected, onProgress, redirects = 0) {
  if (redirects > 8) return Promise.reject(Object.assign(new Error('Too many download redirects.'), { permanent: true }));
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'sms-launcher-build-tools' } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        return resolve(fetchOnce(new URL(response.headers.location, url).href, destination, expected, onProgress, redirects + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(httpError(`Build tool download returned HTTP ${response.statusCode}.`, response.statusCode));
      }
      const part = `${destination}.part`;
      const output = fs.createWriteStream(part, { mode: 0o600 });
      const hash = crypto.createHash('sha256');
      const total = Number(response.headers['content-length']) || 0;
      let received = 0;
      let reported;
      response.on('data', chunk => {
        hash.update(chunk);
        received += chunk.length;
        const percent = total ? Math.min(99, Math.floor(100 * received / total)) : null;
        if (percent !== reported) { reported = percent; onProgress(percent); }
      });
      // Close the part file on a dropped connection, so the next try can replace it.
      response.on('error', error => { output.destroy(); reject(error); });
      output.on('error', reject);
      output.on('finish', () => {
        if (total && received !== total) {
          fs.rmSync(part, { force: true });
          return reject(new Error(`The build tool download stopped at ${received} of ${total} bytes.`));
        }
        const actual = hash.digest('hex');
        if (actual !== expected) {
          fs.rmSync(part, { force: true });
          return reject(new Error('Downloaded build tools failed their SHA-256 check.'));
        }
        renameRetrying(part, destination).then(() => resolve(destination), reject);
      });
      response.pipe(output);
    });
    req.setTimeout(30000, () => req.destroy(new Error('Build tool download timed out.')));
    req.on('error', reject);
  });
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(file);
    input.on('data', chunk => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function assetFor(platform = process.platform, arch = process.arch) {
  const source = platform === 'darwin' ? macAssets.platforms[arch] : assets.platforms[platform];
  if (!source || !/^https:\/\//.test(source.url) || !/^[a-f0-9]{64}$/.test(source.sha256) ||
      !/^[a-zA-Z0-9._-]+\.tar\.gz$/.test(source.name))
    throw new Error('The build tools for this release are not available yet.');
  return source;
}

// Runs the system tar (Windows' bsdtar) verbosely: it names each file as it
// goes, which drives the same "N files" progress as the JavaScript path. A tar
// that names no file for stallMs is stopped, so a stuck extraction ends with an
// explanation instead of staying on "Unpacking build tools…" for good.
// Windows: antivirus and the search indexer open newly written files for a
// moment, and a folder holding one can't be renamed then (EPERM, EACCES or
// EBUSY). Fast unpacking with tar.exe renames straight after writing tens of
// thousands of files, so keep trying for about a minute, as npm does.
const RENAME_BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
async function renameRetrying(from, to, { platform = process.platform, attempts = 40, delayMs = 250,
  rename = fs.renameSync, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return rename(from, to); }
    catch (error) {
      if (platform !== 'win32' || !RENAME_BUSY.has(error.code)) throw error;
      if (attempt >= attempts) {
        error.message = `Windows kept ${path.basename(from)} in use, so it couldn't be moved into place ` +
          `(${error.code}). Antivirus scanning new files usually causes this: try again, or exclude ` +
          `${path.dirname(to)} from scanning. (${error.message})`;
        throw error;
      }
      await sleep(Math.min(delayMs * attempt, 2000));
    }
  }
}

// What to do about the files tar couldn't write, from what it said about them
// (bsdtar: "x msys64/<file>: Can't create '…': <reason>"), naming the folder
// the tools go to.
function unpackAdvice(problems, folder) {
  const said = problems.join('\n');
  const where = folder || 'the build tools folder';
  if (/no space/i.test(said) || DISK_FULL.test(said)) return `The drive holding ${where} is full: free up space on it, then try again.`;
  if (/denied|EPERM|EACCES|virus|unwanted software|used by another process|locked/i.test(said))
    return `Antivirus, or Windows Security's Controlled folder access, blocked writing them: allow ${where} there ` +
      '(or move the launcher to a folder such as C:\\Games), then try again.';
  if (/too long|ENAMETOOLONG|No such file or directory|cannot find the path/i.test(said))
    return `Windows can't create a path of 260 characters or more, and ${where} is too deep for the build tools: ` +
      'move the launcher to a short folder such as C:\\Games, then try again.';
  return `Antivirus scanning or a long folder path can cause this: try again, or allow ${where} in your antivirus, ` +
    'or move the launcher to a short folder such as C:\\Games.';
}

function unpackNative(tarPath, args, progress, { stallMs = 5 * 60 * 1000, folder = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(tarPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // recent: the last lines; problems: the first that say why a file failed
    // (a file name alone has no ": "), which tar prints long before it exits.
    const recent = [], problems = [];
    let files = 0, failed = 0, pending = '', stalled = false, timer = null;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { stalled = true; child.kill(); }, stallMs);
    };
    const read = chunk => {
      const lines = (pending + chunk.toString()).split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        if (recent.push(line.trim()) > 20) recent.shift();
        if (/:\s/.test(line) && !/Error exit delayed/i.test(line) && ++failed <= 3) problems.push(line.trim());
        if (++files % 1000 === 0) progress(null, `Unpacking build tools… ${files.toLocaleString()} files`);
      }
      arm();
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    arm();
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const waited = stallMs >= 60000 ? `${Math.round(stallMs / 60000)} min` : `${Math.round(stallMs / 1000)} s`;
      if (stalled) return reject(new Error(`Unpacking the build tools stopped: tar named no new file for ${waited} ` +
        `(after ${files.toLocaleString()} files). Antivirus scanning or a long folder path can cause this; try again, ` +
        'or move the launcher to a short folder such as C:\\Games.' + (recent.length ? ` Last file: ${recent[recent.length - 1]}` : '')));
      if (code !== 0 || signal) return reject(new Error(`Unpacking the build tools failed (tar ${signal || `exit code ${code}`}).` +
        (problems.length ? ` ${failed > problems.length ? `${failed.toLocaleString()} files failed, the first: ` : ''}` +
          `${problems.join(' | ').replace(/\.$/, '')}. ${unpackAdvice(problems, folder)}`
          : recent.length ? ` ${recent.slice(-5).join(' | ')}. ${unpackAdvice([], folder)}` : ` ${unpackAdvice([], folder)}`)));
      resolve(files);
    });
  });
}

async function prepare(userData, { platform = process.platform, run, progress = () => {},
  forcePrivate = false, source = null, archiveFile = null, archives = false, rosetta = true } = {}) {
  if (!['linux', 'win32', 'darwin'].includes(platform)) throw new Error('This operating system is not supported.');
  if (platform === 'darwin' ? !['x64', 'arm64'].includes(process.arch) : process.arch !== 'x64')
    throw new Error('Setup tools require a supported 64-bit computer.');
  if (platform === 'darwin') {
    const found = await check(userData, { platform, refresh: true, archives, rosetta });
    if (!found.appleReady) throw new Error(found.message);
  }
  if (!forcePrivate && privateReady(userData, platform)) return status(userData, platform);
  const deleted = missingTools(userData, platform);
  if (deleted?.length) progress(null, `${missingToolsMessage(userData, deleted, platform)} Setting them up again.`);
  source = source || assetFor(platform);
  if (!/^[a-f0-9]{64}$/.test(source.sha256) || !/^[a-zA-Z0-9._-]+\.tar\.gz$/.test(source.name))
    throw new Error('Invalid build tool archive information.');
  const root = rootFor(userData, platform);
  const parent = path.dirname(root);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const archive = archiveFile || path.join(parent, source.name);
  if (!archiveFile) await fetchVerified(source.url, archive, source.sha256, progress);
  if (await hashFile(archive) !== source.sha256) throw new Error('Downloaded build tools failed their SHA-256 check.');
  const staging = fs.mkdtempSync(path.join(parent, '.unpack-'));
  const previous = `${root}.previous-${crypto.randomUUID()}`;
  let replaced = false;
  let keptPrevious = false;
  try {
    progress(null, 'Unpacking build tools…');
    const top = platform === 'win32' ? 'msys64' : 'env';
    const nativeTar = platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : null;
    if (nativeTar && fs.existsSync(nativeTar) && commandWorks(nativeTar, ['--version'])) {
      // Windows includes bsdtar; its native extraction avoids slow per-file JS filesystem work.
      await unpackNative(nativeTar, ['-xvzf', archive, '-C', staging, top], progress, { folder: parent });
    } else {
      let entries = 0;
      await require('tar').x({ file: archive, cwd: staging, strict: true,
        onReadEntry() {
          if (++entries % 1000 === 0) progress(null, `Unpacking build tools… ${entries.toLocaleString()} files`);
        },
        filter(name) {
          const entry = name.replace(/^\.\//, '');
          return entry === top || entry.startsWith(`${top}/`) || entry === 'THIRD-PARTY-NOTICES.md' ||
            entry.startsWith('package-sources/');
        }
      });
    }
    if (!fs.existsSync(path.join(staging, top))) throw new Error('Build tool archive is incomplete.');
    if (fs.existsSync(root)) { await renameRetrying(root, previous); keptPrevious = true; }
    await renameRetrying(staging, root);
    replaced = true;
    if (platform !== 'win32') {
      const prefix = path.join(root, 'env');
      await run(path.join(prefix, 'bin', 'python3'), [path.join(prefix, 'bin', 'conda-unpack')],
        { env: { ...process.env, PATH: path.join(prefix, 'bin') } }, 'Prepare build tools');
      if (platform === 'linux') await run(path.join(prefix, 'bin', 'bash'),
        [path.join(prefix, 'targets', 'linux32', 'relocate-sdk.sh')],
        { env: { ...process.env, PATH: path.join(prefix, 'bin') } }, 'Prepare 32-bit game support');
      if (platform === 'linux') require('./linux-tool-paths').repairGccSpecs(prefix);
    } else {
      // Machine-specific contents are excluded from the archive; MSYS2 still needs these folders.
      for (const directory of ['tmp', 'home'])
        fs.mkdirSync(path.join(root, 'msys64', directory), { recursive: true });
    }
    fs.writeFileSync(path.join(root, 'ready.json'), JSON.stringify({ toolset: toolsetFor(platform), platform,
      archiveSha256: source.sha256 }), { mode: 0o600 });
    progress(null, 'Checking build tools…');
    // Files gone straight after unpacking were most likely removed by
    // antivirus; the launcher shows this error as an alert on Windows.
    const missing = missingFiles(root, platform);
    if (missing.length) throw Object.assign(new Error(`${missingToolsMessage(userData, missing, platform)} ` +
      'Then try again.'), { missingTools: missing });
    if (!privateReady(userData, platform)) throw new Error('Downloaded build tools do not match this release.');
    const env = environment(userData, process.env, platform);
    const bin = platform === 'win32' ? path.join(root, 'msys64', 'mingw64', 'bin') : path.join(root, 'env', 'bin');
    if (!commandWorks(path.join(bin, platform === 'win32' ? 'g++.exe' : platform === 'darwin' ? 'clang++' : 'g++'), ['--version'], env))
      throw new Error('The downloaded compiler could not start on this computer.');
    if (platform === 'darwin') {
      const found = await check(userData, { platform, refresh: true, archives, rosetta });
      if (!found.ready) throw new Error(found.message);
    }
    if (keptPrevious) void fs.promises.rm(previous, { recursive: true, force: true,
      maxRetries: 5, retryDelay: 200 }).catch(() => {});
    return status(userData, platform);
  } catch (error) {
    if (replaced) await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (keptPrevious) await renameRetrying(previous, root);
    throw error;
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (!archiveFile) fs.rmSync(archive, { force: true });
  }
}

// Removes this computer's toolsets other than this release's and those in
// `keep` (the ones the kept game versions were built with: a game loads its
// runtime libraries from them), and what interrupted downloads and unpacking
// left behind. `leftoversOnly` keeps every toolset, for when a kept game's
// tools aren't known. Returns the paths removed.
async function pruneToolsets(userData, keep = [], { platform = process.platform, leftoversOnly = false, onError = () => {} } = {}) {
  const parent = path.join(userData, 'build-tools');
  let names;
  try { names = fs.readdirSync(parent); } catch (_) { return []; }
  const same = item => platform === 'win32' ? path.resolve(item).toLowerCase() : path.resolve(item);
  const kept = new Set([rootFor(userData, platform), ...keep.filter(Boolean)].map(same));
  const id = platformId(platform);
  const toolset = new RegExp(`^${id}(?:-[a-f0-9]{12})?$`);
  const leftover = new RegExp(`^(?:${id}(?:-[a-f0-9]{12})?\\.previous-[0-9a-f-]{36}|\\.unpack-.+|sms-build-tools-[A-Za-z0-9._-]+\\.tar\\.gz(?:\\.part)?)$`);
  const removed = [];
  for (const name of names) {
    const item = path.join(parent, name);
    if (!(leftover.test(name) || (!leftoversOnly && toolset.test(name))) || kept.has(same(item))) continue;
    // Not rmSync, which can't remove read-only files on Windows.
    try { await fs.promises.rm(item, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); removed.push(item); }
    catch (error) { onError(error, item); }
  }
  return removed;
}

module.exports = { TOOLSET, toolsetFor, platformId, rootFor, legacyRootFor, privateReady, missingTools, deletedToolsError, blockedToolError,
  outOfSpace, forkFailed, outOfSpaceError, forkFailedError, hintedError, systemReady, status, environment, environmentAtRoot, check,
  fetchVerified, hashFile, assetFor, prepare, pruneToolsets, unpackNative, renameRetrying };
