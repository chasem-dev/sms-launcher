'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const port = require('./port');
const tools = require('./build-tools');
const saves = require('./saves');
const release = require('./game-release.json');

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

function compilerToolRoot(root, settings) {
  try {
    const cache = fs.readFileSync(path.join(path.dirname(port.binaryPath(root, settings)), 'CMakeCache.txt'), 'utf8');
    const compiler = cache.match(/^CMAKE_CXX_COMPILER:[^=]*=(.+)$/m)?.[1].trim().replaceAll('\\', '/');
    return compiler?.match(/^(.*)\/(?:env\/bin|env\/targets\/linux32\/bin|msys64\/(?:mingw(?:32|64)|opt)\/bin)\/[^/]+$/)?.[1] || null;
  } catch (_) { return null; }
}

function matchesSource(root, source = release) {
  return gitRevision(root) === source.commit && gitRevision(path.join(root, 'decomp')) === source.decomp;
}

function isCurrent(root, settings, source = release) {
  if (!fs.existsSync(port.binaryPath(root, settings))) return false;
  const record = installed(root, settings);
  const expected = identity(settings, undefined, undefined, source);
  return Boolean(record && Object.keys(expected).every(key => record[key] === expected[key]) &&
    (!record.toolRoot || fs.existsSync(record.toolRoot)) && matchesSource(root, source));
}

function snapshotPath(base, settings, source = release) {
  const expected = identity(settings, undefined, undefined, source);
  const decomp = source.custom ? `-${source.decomp.slice(0, 12)}` : '';
  return path.join(`${base}.releases`, `${source.commit.slice(0, 12)}${decomp}-${tools.platformId()}-${expected.toolSha256.slice(0, 12)}`);
}

async function checkout(root, { git = 'git', run, capture, env, source = release, reference } = {}) {
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const temporary = `${root}.download-${crypto.randomUUID()}`;
  let promoted = false;
  try {
    const args = ['clone', '--config', 'core.longpaths=true', '--no-checkout', ...(source.branch ? ['--branch', source.branch] : [])];
    if (reference && fs.existsSync(path.join(reference, '.git')))
      args.push('--reference-if-able', reference, '--dissociate');
    args.push(source.repository, temporary);
    await run(git, args, { env }, 'Download port source');
    await run(git, ['fetch', 'origin', source.commit], { cwd: temporary, env }, 'Get game release');
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
      await run(git, ['-c', 'core.longpaths=true', 'submodule', 'update', '--init', '--recursive'], { cwd: root, env }, 'Prepare game release');
    } else {
      const decompPath = path.join(root, 'decomp');
      // Borrow objects from the previous install's decomp by its resolved Git
      // folder: Git stops on a submodule `gitdir:` file it cannot follow.
      let previous = null;
      try { previous = reference && gitDirectory(path.join(reference, 'decomp')); } catch (_) { /* none */ }
      const clone = ['clone', '--config', 'core.longpaths=true', '--no-checkout'];
      if (previous && fs.existsSync(path.join(previous, 'objects')))
        clone.push('--reference-if-able', previous, '--dissociate');
      await run(git, [...clone, url, decompPath], { env }, 'Download decomp source');
      await run(git, ['fetch', 'origin', source.decomp], { cwd: decompPath, env }, 'Get decomp release');
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
    if (promoted) fs.rmSync(root, { recursive: true, force: true });
    throw error;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

const USER_FOLDERS = ['textures', 'hd-cutscenes', 'eclipse'];

function carryUserFiles(previous, next) {
  if (previous === next) return;
  const settings = path.join(previous, 'settings.txt');
  if (fs.existsSync(settings)) fs.copyFileSync(settings, path.join(next, 'settings.txt'));
  for (const folder of USER_FOLDERS) {
    const origin = path.join(previous, 'mods', folder);
    const target = path.join(next, 'mods', folder);
    if (!fs.existsSync(origin) || fs.existsSync(target)) continue;
    // A Windows directory junction requires no administrator/developer mode.
    fs.symlinkSync(fs.realpathSync(origin), target, process.platform === 'win32' ? 'junction' : 'dir');
  }
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

// Each update checks the new game out beside the last one in <base>.releases.
// Remove the versions `keep` doesn't name, unless one holds a `protect` path
// (a memory card or disc file). A kept version's HD packs may be linked from
// an old one (carryUserFiles), so move those into the kept version first.
async function pruneSnapshots(base, keep, protect = [], onError = () => {}) {
  const releases = `${base}.releases`;
  let names;
  try { names = fs.readdirSync(releases); } catch (_) { return []; }
  const kept = keep.filter(Boolean).map(root => path.resolve(root));
  const guarded = [...kept, ...protect.filter(Boolean).map(item => path.resolve(item))];
  const moved = new Map();
  const removed = [];
  for (const name of names) {
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
      await fs.promises.rm(candidate, { recursive: true, force: true, maxRetries: 3 });
      removed.push(candidate);
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

module.exports = { release, gitRevision, matchesSource, identity, installed, compilerToolRoot, isCurrent, snapshotPath, checkout, carryUserFiles, pruneSnapshots, buildSafely, recoverBuild };
