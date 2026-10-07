'use strict';

const path = require('node:path');

// Game files, updates, build tools, saves and backups all live in one folder:
// the one chosen during setup, or else the launcher's own data folder.
function dataFolder(config, userData) { return config.dataFolder || userData; }

function locations(folder) {
  return { saves: path.join(folder, 'saves'), backups: path.join(folder, 'save-backups'),
    bindings: path.join(folder, 'bindings.txt') };
}

// Choosing a folder used to move only the game files. A setup that has not
// built a game yet moves everything else there too. A built game keeps the
// folder it has, because it was built with the tools in it.
function savedDataFolder(saved, userData) {
  if (Object.hasOwn(saved, 'dataFolder')) return typeof saved.dataFolder === 'string' ? saved.dataFolder : null;
  if (typeof saved.repo !== 'string' || path.basename(saved.repo) !== 'sms-pc-port' ||
      saved.completedSetup || saved.previousInstall) return null;
  const folder = path.dirname(saved.repo);
  return path.relative(userData, folder) ? folder : null;
}

module.exports = { dataFolder, locations, savedDataFolder };
