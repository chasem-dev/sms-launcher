'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const port = require('./port');
const tools = require('./build-tools');
const saves = require('./saves');
const portable = require('./portable');
const windowsDlls = require('./windows-dlls');
const release = require('./game-release.json');
const { GIT_PERMANENT } = require('./retry');

// A checkout's Git folder, following a submodule's `gitdir:` file.
function gitDirectory(root) {
  const directory = path.join(root, '.git');
  if (!fs.statSync(directory).isFile()) return directory;
  const match = fs.readFileSync(directory, 'utf8').match(/^gitdir: (.+)\s*$/);
  if (!match) return null;
  let location = match[1];
  // MSYS Git can write absolute /c/... paths, while Electron uses native
  // Windows paths. Relative and native Git paths work without conversion.
  if (process.platform === 'win32') location = location.replace(/^\/([a-zA-Z])\//, '$1:/');
  return path.resolve(root, location);
}

function gitRevision(root) {
  try {
    const directory = gitDirectory(root);
    if (!directory) return null;
    const head = fs.readFileSync(path.join(directory, 'HEAD'), 'utf8').trim();
    if (/^[a-f0-9]{40}$/.test(head)) return head;
    const ref = head.match(/^ref: (refs\/.+)$/)?.[1];
    if (!ref || ref.includes('..')) return null;
    try { return fs.readFileSync(path.join(directory, ref), 'utf8').trim(); }
    catch (_) {
      return fs.readFileSync(path.join(directory, 'packed-refs'), 'utf8').split('\n')
        .find(line => line.endsWith(` ${ref}`))?.split(' ')[0] || null;
    }
  } catch (_) { return null; }
}

// `source` is the game the launcher sets up: this release's (game-release.json)
// or one chosen under Settings (src/game-source.js), with the same fields.
function identity(settings, platform = process.platform, arch = process.arch, source = release) {
  const asset = tools.assetFor(platform, arch);
  return { schema: 1, gameVersion: source.version, commit: source.commit, decomp: source.decomp,
    platform, hostArch: arch, gameArch: settings.arch, eclipse: Boolean(settings.eclipse),
    toolVersion: tools.toolsetFor(platform, arch), toolSha256: asset.sha256 };
}

function metadataPath(root, settings) {
  return path.join(path.dirname(port.binaryPath(root, settings)), 'launcher-build.json');
}

function installed(root, settings) {
  try { return JSON.parse(fs.readFileSync(metadataPath(root, settings), 'utf8')); }
  catch (_) { return null; }
}

function cmakeCache(root, settings) {
  return fs.readFileSync(path.join(path.dirname(port.binaryPath(root, settings)), 'CMakeCache.txt'), 'utf8');
}

function compilerToolRoot(root, settings) {
  try {
    const cache = cmakeCache(root, settings);
    const compiler = cache.match(/^CMAKE_CXX_COMPILER:[^=]*=(.+)$/m)?.[1].trim().replaceAll('\\', '/');
    return compiler?.match(/^(.*)\/(?:env\/bin|env\/targets\/linux32\/bin|msys64\/(?:mingw(?:32|64)|opt)\/bin)\/[^/]+$/)?.[1] || null;
  } catch (_) { return null; }
}

// The tools a build was made with, whose runtime libraries the game loads: its
// record's, or its CMake cache's for builds from before records. A portable
// folder that moved to another drive or computer took them along.
function toolRoot(root, settings, base = portable.root()) {
  const recorded = installed(root, settings)?.toolRoot || compilerToolRoot(root, settings);
  return recorded ? portable.relocated(recorded, base) : null;
}

// A Windows game plays without its build tools once every DLL it imports is
// beside it, as shieldGame (main.js) puts them after each build and before each
// play. Elsewhere the game loads libraries from the tools themselves (Linux's
// RUNPATH and 32-bit loader, the Mac's), so it never does.
function playsWithoutTools(root, settings, platform = process.platform, environment = process.env) {
  if (platform !== 'win32') return false;
  const binary = port.binaryPath(root, settings, platform);
  return windowsDlls.unresolved(binary, [path.dirname(binary)], { environment })?.length === 0;
}

// Whether a build has the Vulkan backend in, or null when it can't tell (no
// CMake cache). A build configured for it (SMS_GX_VULKAN on) is built without it
// when its dependencies can't be downloaded, and the game then draws with OpenGL
// though the player chose Vulkan, which can make it much slower. The game's
// cache says which in SMS_GX_VULKAN_BUILT; older game versions only compiled
// the backend's sources (src/vk) when they had them.
function vulkanBuiltIn(root, settings) {
  let cache;
  try { cache = cmakeCache(root, settings); }
  catch (_) { return null; }
  if (!/^SMS_GX_VULKAN:BOOL=(ON|TRUE|1)$/mi.test(cache)) return false;
  const built = cache.match(/^SMS_GX_VULKAN_BUILT:INTERNAL=(.*)$/m);
  if (built) return /^(ON|TRUE|1)$/i.test(built[1].trim());
  return fs.existsSync(path.join(path.dirname(port.binaryPath(root, settings)), 'platform', 'gx', 'CMakeFiles', 'sms_gx.dir', 'src', 'vk'));
}

// A game picked to draw with Vulkan whose build has no Vulkan backend: from a
// Windows build made before the player picked Vulkan (Windows builds it in only
// for them, port.buildEnvironment), or one whose downloads for it failed. Such a
// build is made again, once: a build that still came out without it (its
// record's vulkanMissing, as buildSafely writes it) plays with OpenGL until the
// player rebuilds, instead of building on every Play while GitHub can't be had.
function needsVulkanBuild(root, settings, platform = process.platform) {
  if (settings.renderer !== 'vulkan' || !fs.existsSync(port.binaryPath(root, settings))) return false;
  // Linux and Mac builds have it whenever the game version does (on by default there).
  if (platform !== 'win32' && !port.gameFeatures(root).vulkan) return false;
  const builtIn = vulkanBuiltIn(root, settings);
  if (builtIn) return false;
  return builtIn === null || !installed(root, settings)?.vulkanMissing;
}

// The game draws with OpenGL though Vulkan was picked, as its build has no
// Vulkan backend, and building again once didn't bring it (needsVulkanBuild).
function vulkanMissing(root, settings) {
  return settings.renderer === 'vulkan' && fs.existsSync(port.binaryPath(root, settings)) &&
    vulkanBuiltIn(root, settings) === false && Boolean(installed(root, settings)?.vulkanMissing);
}

function matchesSource(root, source = release) {
  return gitRevision(root) === source.commit && gitRevision(path.join(root, 'decomp')) === source.decomp;
}

function isCurrent(root, settings, source = release, base = portable.root()) {
  if (!fs.existsSync(port.binaryPath(root, settings))) return false;
  const record = installed(root, settings);
  const expected = identity(settings, undefined, undefined, source);
  return Boolean(record && Object.keys(expected).every(key => record[key] === expected[key]) && !needsVulkanBuild(root, settings) &&
    (!record.toolRoot || fs.existsSync(portable.relocated(record.toolRoot, base)) || playsWithoutTools(root, settings)) &&
    matchesSource(root, source));
}

// Short, since Windows builds can't use paths of 260 characters or more
// (port.windowsPathLimit): the game's commit, then a hash of what else
// tells versions apart (a custom decomp, the computer's system, the tools).
function snapshotPath(base, settings, source = release) {
  const expected = identity(settings, undefined, undefined, source);
  const variant = [source.custom ? source.decomp : '', tools.platformId(), expected.toolSha256].join('|');
  const hash = crypto.createHash('sha256').update(variant).digest('hex').slice(0, 4);
  return path.join(`${base}.releases`, `${source.commit.slice(0, 7)}-${hash}`);
}

// Where Super Mario Eclipse's source downloads are kept for every game version
// (the game's SMS_ECLIPSE_GIT_CACHE): the launcher's data folder. A build folder
// fetches them by a relative path, since MSYS Git reads C:/... as a host name,
// and there is none to another drive, so a game on another drive keeps them
// beside <base>.releases instead.
function eclipseSourcesPath(userData, base, paths = path) {
  const shared = paths.join(userData, 'eclipse-sources');
  const drive = folder => paths.parse(paths.resolve(folder)).root.toLowerCase();
  return !base || drive(base) === drive(userData) ? shared : `${base}.eclipse-sources`;
}

// GitHub sometimes drops a long download partway ("RPC failed; curl 92 HTTP/2
// stream 11 reset by server", "early EOF"). A download that fails is tried
// again over HTTP/1.1, which those stream resets don't happen on, unless the
// player stopped it or what it asked for isn't there. `clear` removes what a
// failed clone left, since Git won't clone into a folder that isn't empty.
// A full drive, or Git unable to fork() its HTTPS helper on Windows (Mandatory
// ASLR), fails the same way every time, so it isn't tried again.
const DOWNLOAD_TRIES = 3;

async function download(git, args, options, label, { run, stopped = () => false, wait, clear } = {}) {
  for (let attempt = 1; ; attempt++) {
    const startedAt = Date.now();
    try {
      return await run(git, attempt === 1 ? args : ['-c', 'http.version=HTTP/1.1', ...args], options,
        attempt === 1 ? label : `${label} (try ${attempt} of ${DOWNLOAD_TRIES})`);
    } catch (error) {
      if (attempt >= DOWNLOAD_TRIES || stopped(startedAt) || GIT_PERMANENT.test(error.message) ||
        tools.outOfSpace(error) || tools.forkFailed(error)) throw error;
      await wait(attempt * 3000);
      if (clear) await fs.promises.rm(clear, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
}

async function checkout(root, { git = 'git', run, capture, env, source = release, reference,
  stopped, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const fetch = (args, options, label, clear) => download(git, args, options, label, { run, stopped, wait, clear });
  const parent = path.dirname(root);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  const temporary = `${root}.download-${crypto.randomUUID()}`;
  let promoted = false;
  try {
    const args = ['clone', '--config', 'core.longpaths=true', '--no-checkout', ...(source.branch ? ['--branch', source.branch] : [])];
    if (reference && fs.existsSync(path.join(reference, '.git')))
      args.push('--reference-if-able', reference, '--dissociate');
    args.push(source.repository, temporary);
    await fetch(args, { env }, 'Download port source', temporary);
    await fetch(['fetch', 'origin', source.commit], { cwd: temporary, env }, 'Get game release');
    await run(git, ['checkout', '--detach', source.commit], { cwd: temporary, env }, 'Select game release');
    const actual = await capture(git, ['rev-parse', 'HEAD'], temporary, env);
    const tree = await capture(git, ['ls-tree', 'HEAD', 'decomp'], temporary, env);
    if (actual !== source.commit || (!source.decompRepository && !tree.startsWith(`160000 commit ${source.decomp}\t`)))
      throw new Error('The downloaded game files did not match this release. Please retry.');
    // MSYS submodules may use absolute gitdir/worktree paths. Initialize them
    // after promotion so none of their paths refer to the temporary checkout.
    fs.renameSync(temporary, root);
    promoted = true;
    // Clone decomp as plain commands rather than `git submodule update`, which
    // older Git for Windows runs as a shell script whose forks can fail (e.g.
    // on Windows 7). Git treats this clone as the populated submodule, and
    // recording its URL initializes it as `git submodule init` would.
    const url = source.decompRepository || await capture(git, ['config', '--file', '.gitmodules', 'submodule.decomp.url'], root, env);
    if (/^\.\.?\//.test(url)) {
      // A fork's relative URL: let Git resolve it against the port's remote.
      await fetch(['-c', 'core.longpaths=true', 'submodule', 'update', '--init', '--recursive'], { cwd: root, env }, 'Prepare game release');
    } else {
      const decompPath = path.join(root, 'decomp');
      // Borrow objects from the previous install's decomp by its resolved Git
      // folder: Git stops on a submodule `gitdir:` file it cannot follow.
      let previous = null;
      try { previous = reference && gitDirectory(path.join(reference, 'decomp')); } catch (_) { /* none */ }
      const clone = ['clone', '--config', 'core.longpaths=true', '--no-checkout'];
      if (previous && fs.existsSync(path.join(previous, 'objects')))
        clone.push('--reference-if-able', previous, '--dissociate');
      await fetch([...clone, url, decompPath], { env }, 'Download decomp source', decompPath);
      await fetch(['fetch', 'origin', source.decomp], { cwd: decompPath, env }, 'Get decomp release');
      await run(git, ['checkout', '--detach', source.decomp], { cwd: decompPath, env }, 'Select decomp release');
      await run(git, ['config', 'submodule.decomp.url', url], { cwd: root, env }, 'Prepare game release');
    }
    // Another decomp: record its commit in the index so the port's own
    // `git submodule update` keeps it.
    if (source.decompRepository)
      await run(git, ['update-index', '--cacheinfo', `160000,${source.decomp},decomp`], { cwd: root, env }, 'Choose decomp commit');
    const decomp = await capture(git, ['rev-parse', 'HEAD'], path.join(root, 'decomp'), env);
    if (decomp !== source.decomp || gitRevision(root) !== source.commit || gitRevision(path.join(root, 'decomp')) !== source.decomp)
      throw new Error('The downloaded game files did not match this release. Please retry.');
    fs.writeFileSync(path.join(root, 'launcher-source.json'), JSON.stringify(source, null, 2));
  } catch (error) {
    // Not rmSync, which cannot remove Git's read-only object files on Windows,
    // and never in place of the error that brought us here.
    if (promoted) await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    throw error;
  } finally { await fs.promises.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {}); }
}

const USER_FOLDERS = ['textures', 'hd-cutscenes', 'eclipse'];

function carryUserFiles(previous, next) {
  if (previous === next) return;
  const settings = path.join(previous, 'settings.txt');
  if (fs.existsSync(settings)) fs.copyFileSync(settings, path.join(next, 'settings.txt'));
  for (const folder of USER_FOLDERS) {
    const origin = path.join(previous, 'mods', folder);
    const target = path.join(next, 'mods', folder);
    if (!fs.existsSync(origin)) continue;
    const existing = fs.lstatSync(target, { throwIfNoEntry: false });
    if (existing) {
      // A link from an older update can point at a version that has since been
      // removed. existsSync follows it and says there is nothing there, but
      // creating the new link over it fails (EISDIR on Windows), so replace it.
      if (!existing.isSymbolicLink() || fs.existsSync(target)) continue;
      fs.unlinkSync(target);
    }
    // A Windows directory junction requires no administrator/developer mode.
    fs.symlinkSync(fs.realpathSync(origin), target, process.platform === 'win32' ? 'junction' : 'dir');
  }
  carryPinnedDownloads(previous, next);
}

// Copy the radar maps, achievement icons and language packs the last version
// downloaded when the new one pins the same release, so changing channel or
// updating doesn't download them again. Each version keeps its own copy, so
// one that pins a different release replaces only its own. A copy that fails
// is dropped and the update downloads it as before.
function carryPinnedDownloads(previous, next) {
  for (const { directory, pinned } of port.pinnedDownloads(next)) {
    const origin = path.join(previous, path.relative(next, directory));
    if (fs.existsSync(directory) || !port.holdsRelease(origin, pinned)) continue;
    const part = `${directory}.carry-part`;
    try {
      fs.rmSync(part, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(directory), { recursive: true });
      fs.cpSync(origin, part, { recursive: true });
      fs.renameSync(part, directory);
    } catch (_) { fs.rmSync(part, { recursive: true, force: true }); }
  }
}

// Links to an earlier version's packs keep its absolute path (Windows junctions
// must), so after a portable folder moves they point where it used to be.
// Point them at the same folders in its new place.
function relinkUserFolders(root, relocate) {
  const relinked = [];
  for (const folder of USER_FOLDERS) {
    const link = path.join(root, 'mods', folder);
    if (!fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() || fs.existsSync(link)) continue;
    const target = relocate(path.resolve(path.dirname(link), fs.readlinkSync(link)));
    if (!fs.existsSync(target)) continue;
    fs.unlinkSync(link);
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    relinked.push(folder);
  }
  return relinked;
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

// Remove a folder an entry at a time, so `shouldStop` can end it partway: a game
// version holds tens of thousands of files, which Windows can take minutes to
// delete. Links are removed, never followed (lstat sees a Windows junction as
// one). A file another program has open stays; the rest is still removed and
// the first such error is thrown at the end, with the folder left for next time.
async function removeTree(folder, shouldStop) {
  let failure = null, stopped = false;
  // Whether `item` is gone. A folder whose files weren't all removed stays.
  const remove = async item => {
    if (stopped || (stopped = shouldStop())) return false;
    const stats = fs.lstatSync(item, { throwIfNoEntry: false });
    let empty = true;
    if (stats?.isDirectory() && !stats.isSymbolicLink())
      for (const name of fs.readdirSync(item)) empty = await remove(path.join(item, name)) && empty;
    if (!empty) return false;
    try { await fs.promises.rm(item, { recursive: true, force: true, maxRetries: 3 }); return true; }
    catch (error) { failure ||= error; return false; }
  };
  const gone = await remove(folder);
  if (failure) throw failure;
  return gone;
}

// Each update checks the new game out beside the last one in <base>.releases.
// Remove the versions `keep` doesn't name, unless one holds a `protect` path
// (a memory card or disc file). A kept version's HD packs may be linked from
// an old one (carryUserFiles), so move those into the kept version first.
// `shouldStop` ends it early, leaving the rest for next time.
async function pruneSnapshots(base, keep, protect = [], onError = () => {}, shouldStop = () => false) {
  const releases = `${base}.releases`;
  let names;
  try { names = fs.readdirSync(releases); } catch (_) { return []; }
  const kept = keep.filter(Boolean).map(root => path.resolve(root));
  const guarded = [...kept, ...protect.filter(Boolean).map(item => path.resolve(item))];
  const moved = new Map();
  const removed = [];
  for (const name of names) {
    if (shouldStop()) break;
    const candidate = path.join(releases, name);
    try {
      if (!fs.lstatSync(candidate).isDirectory()) continue;
      const real = fs.realpathSync(candidate);
      const within = item => contains(candidate, item) || contains(real, item);
      if (guarded.some(item => within(item) || (fs.existsSync(item) && within(fs.realpathSync(item))))) continue;
      for (const root of kept) for (const folder of USER_FOLDERS) {
        const link = path.join(root, 'mods', folder);
        if (!fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) continue;
        const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
        if (!within(target)) continue;
        const type = process.platform === 'win32' ? 'junction' : 'dir';
        fs.unlinkSync(link);
        if (moved.has(target)) fs.symlinkSync(moved.get(target), link, type);
        else if (fs.existsSync(target)) {
          try { fs.renameSync(target, link); } catch (error) { fs.symlinkSync(target, link, type); throw error; }
          moved.set(target, link);
        }
      }
      // Unlink this version's own links so removing it can't reach through them.
      for (const folder of USER_FOLDERS) {
        const link = path.join(candidate, 'mods', folder);
        if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(link);
      }
      if (await removeTree(candidate, shouldStop)) removed.push(candidate);
    } catch (error) { onError(error, candidate); }
  }
  return removed;
}

async function buildSafely(root, settings, saveDir, compile, backups = saves.backupRoot(), source = release) {
  const directory = path.dirname(port.binaryPath(root, settings));
  const previous = `${directory}.previous-${crypto.randomUUID()}`;
  const hadBuild = fs.existsSync(directory);
  const journal = `${directory}.launcher-transaction.json`;
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  if (hadBuild) fs.writeFileSync(journal, JSON.stringify({ directory, previous }), { flag: 'wx' });
  try {
    if (hadBuild) saves.moveBuildKeepingSaves(directory, previous, saveDir, backups);
    const result = await compile();
    if (!fs.existsSync(port.binaryPath(root, settings))) throw new Error('Setup finished without a playable game. Please retry.');
    if (!matchesSource(root, source))
      throw new Error('Game files changed during setup. Please retry.');
    const record = { ...identity(settings, undefined, undefined, source), toolRoot: compilerToolRoot(root, settings), builtAt: new Date().toISOString() };
    // Built for Vulkan, but without it (its downloads failed): needsVulkanBuild doesn't build it again by itself.
    if (settings.renderer === 'vulkan' && vulkanBuiltIn(root, settings) === false) record.vulkanMissing = true;
    const file = metadataPath(root, settings);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2));
    fs.renameSync(`${file}.tmp`, file);
    fs.rmSync(journal, { force: true });
    return result;
  } catch (error) {
    // Keep partial output for diagnosis; never delete a custom memory card.
    if (hadBuild && fs.existsSync(previous)) {
      if (fs.existsSync(directory)) fs.renameSync(directory, `${directory}.failed-${crypto.randomUUID()}`);
      fs.renameSync(previous, directory);
    }
    fs.rmSync(journal, { force: true });
    throw error;
  }
}

function recoverBuild(root, settings) {
  const directory = path.dirname(port.binaryPath(root, settings));
  const journal = `${directory}.launcher-transaction.json`;
  if (!fs.existsSync(journal)) return false;
  const record = JSON.parse(fs.readFileSync(journal, 'utf8'));
  if (record.directory !== directory || !record.previous?.startsWith(`${directory}.previous-`) ||
      path.dirname(record.previous) !== path.dirname(directory)) throw new Error('The recovery record is invalid.');
  if (fs.existsSync(record.previous)) {
    if (fs.existsSync(directory)) fs.renameSync(directory, `${directory}.interrupted-${crypto.randomUUID()}`);
    fs.renameSync(record.previous, directory);
  }
  fs.rmSync(journal, { force: true });
  return true;
}

module.exports = { release, gitRevision, matchesSource, identity, installed, compilerToolRoot, toolRoot, playsWithoutTools, vulkanBuiltIn, needsVulkanBuild, vulkanMissing, isCurrent, snapshotPath, eclipseSourcesPath, checkout, carryUserFiles, relinkUserFolders, pruneSnapshots, buildSafely, recoverBuild };
