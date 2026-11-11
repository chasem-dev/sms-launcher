'use strict';

// `--game <disc>` (or `--game=<disc>`): the disc image a launcher such as RecompLauncher
// already holds for the player. Without it the launcher starts exactly as before.
function gameArgument(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--game=')) return arg.slice('--game='.length) || null;
    if (arg === '--game') return argv[i + 1] || null;
  }
  return null;
}

module.exports = { gameArgument };
