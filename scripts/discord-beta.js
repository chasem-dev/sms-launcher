'use strict';

// Announces a newly published Beta in a Discord channel. build.yml runs it
// after the "beta" pre-release is replaced, with the channel's webhook URL in
// the DISCORD_BETA_WEBHOOK secret; without the secret it does nothing. The
// message has the launcher and game versions and Beta's notes from
// changelog.json, only those the last Beta did not already have when
// PREVIOUS_CHANGELOG names its changelog.json. Its changelog links open Beta's
// own notes: the "beta" lines of changelog.json at the commit this Beta built,
// not main's file, whose top is a release's notes once Beta's are released.
// A failed post is a warning: Beta is already published.
const fs = require('node:fs');
const path = require('node:path');

const FIELD = 1024;      // Discord's limit for an embed field's text
const COLOR = 0xf6b73c;  // the launcher's Play button

// Notes are plain text: keep Discord from reading them as formatting.
function escape(text) { return String(text).replace(/[\\*_~`|>[\]]/g, '\\$&'); }

// One bullet per note, cut to fit a field with a link to the rest.
function bullets(lines, more) {
  const rest = count => `…and ${count} more in [the changelog](${more})`;
  const kept = [];
  for (const [index, line] of lines.entries()) {
    const left = lines.length - index - 1;
    const text = [...kept, `• ${escape(line)}`, ...(left ? [rest(left)] : [])].join('\n');
    if (text.length > FIELD) return [...kept, rest(lines.length - index)].join('\n');
    kept.push(`• ${escape(line)}`);
  }
  return kept.join('\n');
}

// The first and last line (1-based) of the "beta": { ... } block in
// changelog.json's text, or null when it has none.
function betaLines(text) {
  const lines = String(text || '').split('\n');
  const first = lines.findIndex(line => /^\s*"beta"\s*:\s*\{/.test(line));
  if (first < 0) return null;
  let depth = 0, quoted = false, escaped = false;
  for (let index = first; index < lines.length; index++) {
    for (const char of lines[index].slice(index === first ? lines[index].indexOf('{') : 0)) {
      if (escaped) escaped = false;
      else if (quoted) { if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) return [first + 1, index + 1];
    }
  }
  return null;
}

function strings(value) { return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : []; }

// The webhook body. `game` has the repository, version and commit Beta built;
// `previous` is the last Beta's notes, left out so each post has only what is new.
// `lines` is where Beta's notes are in changelog.json (betaLines), to point the link at them.
function message({ launcherVersion, launcherSha, game, repository, beta, previous, lines, now = new Date() }) {
  const repo = `https://github.com/${repository}`;
  const gameRepo = String(game.repository || '').replace(/\.git$/, '');
  const changelog = `${repo}/blob/${launcherSha || 'main'}/changelog.json${lines ? `#L${lines[0]}-L${lines[1]}` : ''}`;
  const fields = [
    { name: 'Launcher', value: `[${launcherVersion}](${repo}/commit/${launcherSha})`, inline: true },
    { name: 'Game', value: gameRepo ? `[${game.version}](${gameRepo}/commit/${game.commit})` : game.version, inline: true }
  ];
  const added = key => {
    const seen = new Set(strings(previous?.[key]));
    return strings(beta?.[key]).filter(line => !seen.has(line));
  };
  const launcher = added('launcher'), gameNotes = added('game');
  if (launcher.length) fields.push({ name: 'Launcher changes', value: bullets(launcher, changelog) });
  if (gameNotes.length) fields.push({ name: 'Game changes', value: bullets(gameNotes, changelog) });
  if (previous && !launcher.length && !gameNotes.length)
    fields.push({ name: 'Changes', value: `Nothing new in [the changelog](${changelog}) since the last Beta.` });
  return {
    username: 'SMS Launcher',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `Beta ${launcherVersion} is out`,
      url: `${repo}/releases/tag/beta`,
      color: COLOR,
      description: 'Beta launchers update to it automatically. To join, open Settings → Launcher and choose **Beta** under **Launcher updates**. Beta builds are for testing and may break.',
      fields,
      timestamp: now.toISOString()
    }]
  };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

async function main(env = process.env, root = path.join(__dirname, '..')) {
  if (!env.DISCORD_BETA_WEBHOOK) {
    console.log('::notice::DISCORD_BETA_WEBHOOK is not set, so Discord was not told about this Beta.');
    return;
  }
  // Beta builds the newest game commit; the repository comes from the pin.
  const pinned = readJson(path.join(root, 'src', 'game-release.json'));
  if (!pinned) throw new Error('src/game-release.json is missing.');
  const game = { ...pinned, version: env.GAME_VERSION || pinned.version, commit: env.GAME_COMMIT || pinned.commit };
  let text = '';
  try { text = fs.readFileSync(path.join(root, 'changelog.json'), 'utf8'); } catch (_) { /* no notes */ }
  let beta;
  try { beta = JSON.parse(text).beta; } catch (_) { /* no notes */ }
  const body = message({ launcherVersion: env.LAUNCHER_VERSION, launcherSha: env.LAUNCHER_SHA, game,
    repository: env.GITHUB_REPOSITORY, beta, lines: betaLines(text),
    previous: env.PREVIOUS_CHANGELOG ? readJson(env.PREVIOUS_CHANGELOG)?.beta : undefined });
  try {
    const response = await fetch(env.DISCORD_BETA_WEBHOOK, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    console.log(`Told Discord about Beta ${env.LAUNCHER_VERSION} with game ${game.version}.`);
  } catch (error) {
    console.log(`::warning::Could not post the Beta to Discord: ${error.message}`);
  }
}

if (require.main === module) main().catch(error => { console.error(`::error::${error.message}`); process.exitCode = 1; });

module.exports = { message, escape, betaLines, main };
