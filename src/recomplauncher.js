'use strict';

// RecompLauncher sets RECOMPLAUNCHER=1 and installs each release itself, so the
// launcher doesn't download or install its own updates then. Returns the
// notice the status bar shows instead, or null when started any other way.
function updateNotice(env = process.env) {
  if (env.RECOMPLAUNCHER !== '1') return null;
  return { state: 'unconfigured', message: 'RecompLauncher keeps SMS Launcher up to date.' };
}

module.exports = { updateNotice };
