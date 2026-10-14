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
let macInspection;
let macCheck;
let macCheckedAt = 0;

async function check(userData, { platform = process.platform, env = process.env, refresh = false, archives = false } = {}) {
  if (platform !== 'darwin') return status(userData, platform, env);
  if (refresh || !macInspection || Date.now() - macCheckedAt > 15000) {
    if (!macCheck) macCheck = macTools.inspect(environment(userData, env, platform)).then(result => {
      macInspection = result;
      macCheckedAt = Date.now();
    }).finally(() => { macCheck = null; });
    await macCheck;
  }
  return status(userData, platform, env, { archives });
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

function toolsDirectory(userData) { return path.join(userData, 'build-tools'); }

function legacyRootFor(userData, platform = process.platform) {
  return path.join(toolsDirectory(userData), platformId(platform));
}

function privateReady(userData, platform = process.platform) {
  const root = rootFor(userData, platform);
  const marker = path.join(root, 'ready.json');
  try {
    const installed = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (installed.toolset !== toolsetFor(platform)) return false;
    const expected = platform === 'darwin' ? macAssets.platforms[process.arch] : assets.platforms[platform];
    if (expected && installed.archiveSha256 !== expected.sha256) return false;
    if (platform === 'darwin') return ['clang', 'clang++', 'git', 'cmake', 'ninja', 'python3', 'make', 'patch', 'llvm-objcopy', '7z']
      .every(name => fs.existsSync(path.join(root, 'env', 'bin', name)));
    return platform === 'win32'
      ? fs.existsSync(path.join(root, 'msys64', 'usr', 'bin', 'bash.exe')) &&
        fs.existsSync(path.join(root, 'msys64', 'mingw64', 'bin', 'g++.exe')) &&
        fs.existsSync(path.join(root, 'msys64', 'mingw64', 'include', 'SDL2', 'SDL.h')) &&
        fs.existsSync(path.join(root, 'msys64', 'opt', 'bin', 'i686-w64-mingw32-g++.exe')) &&
        fs.existsSync(path.join(root, 'msys64', 'mingw32', 'include', 'SDL2', 'SDL.h'))
      : ['g++', 'git', 'cmake', 'python3', 'make', 'patch', 'objcopy', '7z']
        .every(name => fs.existsSync(path.join(root, 'env', 'bin', name))) &&
        fs.existsSync(path.join(root, 'env', 'lib', 'libSDL2-2.0.so.0')) &&
        fs.existsSync(path.join(root, 'env', 'targets', 'linux32', 'bin', 'i686-linux-g++')) &&
        fs.existsSync(path.join(root, 'env', 'targets', 'linux32', 'graphics', 'usr', 'lib', 'i386-linux-gnu', 'libSDL2-2.0.so.0'));
  } catch (_) { return false; }
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
    const appleReady = found.checked && found.requirements.filter(item => ['apple', 'rosetta'].includes(item.id))
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
      result.SMS_LLVM_BIN = bin;
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
  if (base.SMS_ARCH === '32' && fs.existsSync(path.join(msys, 'opt', 'bin', 'i686-w64-mingw32-g++.exe'))) {
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

function fetchVerified(url, destination, expected, onProgress = () => {}, redirects = 0) {
  if (redirects > 8) return Promise.reject(new Error('Too many download redirects.'));
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'sms-launcher-build-tools' } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        return resolve(fetchVerified(new URL(response.headers.location, url).href, destination, expected, onProgress, redirects + 1));
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Build tool download returned HTTP ${response.statusCode}.`));
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
      response.on('error', reject);
      output.on('error', reject);
      output.on('finish', () => {
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

function unpackNative(tarPath, args, progress, { stallMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(tarPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const recent = [];
    let files = 0, pending = '', stalled = false, timer = null;
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
        (recent.length ? ` ${recent.slice(-5).join(' | ')}` : '')));
      resolve(files);
    });
  });
}

async function prepare(userData, { platform = process.platform, run, progress = () => {},
  forcePrivate = false, source = null, archiveFile = null, archives = false } = {}) {
  if (!['linux', 'win32', 'darwin'].includes(platform)) throw new Error('This operating system is not supported.');
  if (platform === 'darwin' ? !['x64', 'arm64'].includes(process.arch) : process.arch !== 'x64')
    throw new Error('Setup tools require a supported 64-bit computer.');
  if (platform === 'darwin') {
    const found = await check(userData, { platform, refresh: true, archives });
    if (!found.appleReady) throw new Error(found.message);
  }
  if (!forcePrivate && privateReady(userData, platform)) return status(userData, platform);
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
      await unpackNative(nativeTar, ['-xvzf', archive, '-C', staging, top], progress);
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
    if (!privateReady(userData, platform)) throw new Error('Downloaded build tools are incomplete or do not match this release.');
    const env = environment(userData, process.env, platform);
    const bin = platform === 'win32' ? path.join(root, 'msys64', 'mingw64', 'bin') : path.join(root, 'env', 'bin');
    if (!commandWorks(path.join(bin, platform === 'win32' ? 'g++.exe' : platform === 'darwin' ? 'clang++' : 'g++'), ['--version'], env))
      throw new Error('The downloaded compiler could not start on this computer.');
    if (platform === 'darwin') {
      const found = await check(userData, { platform, refresh: true, archives });
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

module.exports = { TOOLSET, toolsetFor, platformId, toolsDirectory, rootFor, legacyRootFor, privateReady, systemReady, status, environment, environmentAtRoot, check,
  fetchVerified, hashFile, assetFor, prepare, unpackNative, renameRetrying };
