'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const port = require('../src/port');

function state() {
  return {
    config: { repo: '/installed/port', settings: port.normalizeSettings({ autoUpdate: true }), completedSetup: true },
    platform: port.platformInfo(), tools: { ready: true, appleReady: true },
    repoReady: true, romReady: true, binaryReady: true, hdVisualsReady: true,
    game: { needsUpdate: true, installedVersion: 'older', availableVersion: 'newer', launcherVersion: '0.1.39' },
    appUpdate: { message: '' }, backups: [], logs: [], active: null,
    locations: { folder: '/installed', data: '/installed', tools: '/installed/build-tools', dataInFolder: true, toolsDownloaded: true, toolDownloadBytes: 766490376 }
  };
}

function firstRun(locations) {
  const data = state();
  Object.assign(data, { repoReady: false, romReady: false, binaryReady: false, hdVisualsReady: false });
  data.config = { ...data.config, repo: '/games/sms-pc-port', completedSetup: false };
  data.tools = { ready: false, appleReady: true };
  data.locations = { folder: '/games', data: '/games', tools: '/games/build-tools', dataInFolder: true, toolsDownloaded: false,
    toolDownloadBytes: 766490376, ...locations };
  return data;
}

async function renderer(data = state(), copyError = null, notes = { releases: [], unseen: [], current: '0.1.39' }, steam = {}) {
  const importResult = { imported: [{ name: 'GMSE04_super_mario_sunshine', game: 'eclipse', title: 'Super Mario Eclipse',
    shines: [3, null, 1], file: '04-GMSE-super_mario_sunshine.gci' }],
  skipped: [{ file: '01-GMSE-super_mario_sunshine.gci', reason: 'Super Mario Sunshine save with no saved progress' },
    { file: '04-GMSE-super_mario_eclipse.gci', reason: 'Eclipse settings, not a game save' }] };
  const changelogSeen = [], calls = [], elements = new Map(), droppedFiles = [], listeners = {}, gamepad = {};
  let logCallback, resetCallback, activityCallback;
  const text = node => node.textContent + node.children.map(text).join(' ');
  function element(classes = '') {
    const names = new Set(classes.split(' ')), listeners = new Map();
    return { hidden: false, disabled: false, textContent: '', value: '', style: {}, open: false,
      classList: { contains: name => names.has(name), add: name => names.add(name), remove: name => names.delete(name), toggle(name, enabled) {
        if (enabled) names.add(name); else names.delete(name);
      } },
      addEventListener: (event, callback) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(callback); },
      click() { if (!this.disabled) for (const callback of listeners.get('click') || []) callback(); },
      dispatch(event, value) { for (const callback of listeners.get(event) || []) callback(value); },
      setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
      replaceChildren(...children) { this.textContent = children.map(text).join(''); }, append() {}, focus() {},
      children: [], appendChild(child) { this.children.push(child); return child; },
      close() { this.open = false; }, showModal() { this.open = true; } };
  }
  const html = fs.readFileSync(path.resolve(__dirname, '../src/index.html'), 'utf8');
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const node = element(match[0].match(/class="([^"]+)"/)?.[1]);
    node.hidden = /\bhidden\b/.test(match[0]);
    node.id = match[1];
    elements.set(match[1], node);
  }
  const sms = {
    state: async () => data, windowState: async () => ({}), zoomFactor: () => 1,
    importDolphinSave: async file => { calls.push('importDolphinSave'); droppedFiles.push(file); return importResult; },
    onLog(callback) { logCallback = callback; }, onActivity(callback) { activityCallback = callback; }, onAppUpdate() {}, onWindowState() {}, onOnline(callback) { listeners.online = callback; },
    onLogReset(callback) { resetCallback = callback; },
    saveActivityLog: async () => { calls.push('saveActivityLog'); },
    copyActivityLog: async () => { calls.push('copyActivityLog'); if (copyError) throw copyError; },
    saveSettings: async value => { calls.push(['saveSettings', value]); return { ...data, config: { ...data.config, settings: port.normalizeSettings(value) } }; },
    changelog: async () => notes, markChangelogSeen: async () => { changelogSeen.push(true); },
    play: async () => { calls.push('play'); }, launchGame: async () => { calls.push('launchGame'); },
    steamStatus: async () => ({ ...steam }), steamOffered: async prompt => { calls.push(`steamOffered:${prompt}`); },
    addToSteam: async options => { calls.push(['addToSteam', options]); steam = { ...steam, inSteam: true, needsFix: false, offer: false, offerFix: false };
      return { added: true, play: options.play, name: 'Super Mario Sunshine', artwork: 5, total: 5 }; }
  };
  const context = vm.createContext({ console, setInterval() {}, requestAnimationFrame: callback => setImmediate(callback),
    window: { sms, smsActivityLog: require('../src/activity-log'), smsRumble: require('../src/rumble'), smsGamepadNav: { start: options => Object.assign(gamepad, options) },
      addEventListener() {} }, document: {
    getElementById(id) { assert.ok(elements.has(id), `Missing HTML element ${id}`); return elements.get(id); },
    querySelectorAll(selector) {
      const modals = ['page-settings', 'changelog', 'mac-tools-help'].map(id => elements.get(id));
      return selector === '.launcher-modal' ? modals : selector === '.launcher-modal[open]' ? modals.filter(modal => modal.open) : [];
    }, createElement: () => element()
  } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/renderer.js'), 'utf8'), context);
  await new Promise(setImmediate);
  return { elements, calls, droppedFiles, listeners, changelogSeen, gamepad,
    async emitLog(entry) { logCallback(entry); await new Promise(setImmediate); },
    async resetLog(sequence) { resetCallback(sequence); await new Promise(setImmediate); },
    async emitActivity(active) { activityCallback(active); await new Promise(setImmediate); },
    async refresh() { vm.runInContext('refresh(current)', context); },
    async click(id) { elements.get(id).click(); await new Promise(setImmediate); } };
}

test('home screen offers update or installed play and skip calls the launch-only IPC', async () => {
  const ui = await renderer();
  assert.equal(ui.elements.get('installed-play-option').hidden, false);
  assert.match(ui.elements.get('play').textContent, /Update & play/);
  assert.equal(ui.elements.get('skip-update-play').textContent, 'Skip update & play');
  assert.match(ui.elements.get('installed-play-note').textContent, /game older/);
  await ui.click('skip-update-play');
  assert.deepEqual(ui.calls, ['play']);
  await ui.click('play');
  assert.deepEqual(ui.calls, ['play', 'launchGame']);
});

test('Update & play shows the newly built game version once the game starts', async () => {
  const data = state(), ui = await renderer(data);
  assert.match(ui.elements.get('version-summary').textContent, /Game older/);
  const startedAt = Date.now();
  await ui.emitActivity({ label: 'Prepare game', startedAt });
  await ui.emitActivity({ label: 'Build Sunshine port', startedAt, canStop: true });
  data.game = { ...data.game, installedVersion: 'newer', needsUpdate: false };
  await ui.emitActivity({ label: 'Play Super Mario Sunshine', startedAt, canStop: true });
  assert.match(ui.elements.get('version-summary').textContent, /Game newer/);
  assert.equal(ui.elements.get('installed-game-version').textContent, 'newer');
});

test('Dolphin save import offers a chooser and drop of one or more saves, reports each, and refuses while busy', async () => {
  const data = state(), ui = await renderer(data);
  await ui.click('import-dolphin-save');
  assert.deepEqual(ui.calls, ['importDolphinSave']);
  const summary = ui.elements.get('dolphin-import-result').textContent;
  for (const part of [/Super Mario Eclipse save imported/, /04-GMSE-super_mario_sunshine\.gci/, /Eclipse/,
    /File A ★ 3 Shines/, /File B – Empty/, /File C ★ 1 Shine\b/, /Turn on Super Mario Eclipse under Gameplay/,
    /Skipped 01-GMSE-super_mario_sunshine\.gci \(Super Mario Sunshine save with no saved progress\), 04-GMSE-super_mario_eclipse\.gci \(Eclipse settings, not a game save\)\./])
    assert.match(summary, part);
  const file = { name: 'Sunshine.gci' }, drop = ui.elements.get('dolphin-save-drop');
  let prevented = false;
  const event = files => ({ preventDefault() { prevented = true; }, dataTransfer: { files } });
  drop.dispatch('drop', event([file]));
  await new Promise(setImmediate);
  assert.equal(prevented, true);
  assert.deepEqual([...ui.droppedFiles[1]], [file]);
  const other = { name: 'Eclipse.gci' };
  drop.dispatch('drop', event([file, other]));
  await new Promise(setImmediate);
  assert.deepEqual([...ui.droppedFiles[2]], [file, other]);
  assert.equal(ui.calls.length, 3);
  data.active = { label: 'Play Super Mario Sunshine' };
  await ui.refresh();
  assert.equal(ui.elements.get('import-dolphin-save').disabled, true);
  await ui.click('import-dolphin-save');
  drop.dispatch('drop', event([file]));
  await new Promise(setImmediate);
  assert.equal(ui.calls.length, 3);
});

test('installed play is unavailable before setup, without a disc, or while busy', async () => {
  for (const patch of [{ binaryReady: false }, { romReady: false }]) {
    const ui = await renderer({ ...state(), ...patch });
    assert.equal(ui.elements.get('installed-play-option').hidden, true);
  }
  const data = state(), ui = await renderer(data);
  data.active = { label: 'Build Sunshine port' };
  await ui.refresh();
  assert.equal(ui.elements.get('skip-update-play').disabled, true);
  await ui.click('skip-update-play');
  assert.deepEqual(ui.calls, []);
});

test('pending HD setup offers installed play, while current complete installs show only Play', async () => {
  const data = state(); data.game.needsUpdate = false; data.game.installedVersion = null;
  const ui = await renderer(data);
  assert.equal(ui.elements.get('installed-play-option').hidden, true);
  data.hdVisualsReady = false;
  await ui.refresh();
  assert.equal(ui.elements.get('installed-play-option').hidden, false);
  assert.equal(ui.elements.get('skip-update-play').textContent, 'Play installed version');
  assert.match(ui.elements.get('installed-play-note').textContent, /your installed game/);
  await ui.click('skip-update-play');
  assert.deepEqual(ui.calls, ['play']);
});

test('activity log renders stream labels, updates partial lines once and saves the full session', async () => {
  const data = state();
  data.logs = [{ id: 1, sequence: 1, stream: 'launcher', text: 'Started' },
    { id: 2, sequence: 2, stream: 'stderr', text: 'partial' }];
  const ui = await renderer(data);
  await ui.emitLog({ id: 2, sequence: 3, stream: 'stderr', text: 'complete diagnostic' });
  await ui.emitLog(data.logs[1]);
  assert.equal(ui.elements.get('log').textContent, '[launcher] Started\n[stderr] complete diagnostic\n');
  await ui.click('save-activity-log');
  assert.deepEqual(ui.calls, ['saveActivityLog']);
  await ui.click('copy-activity-log');
  assert.deepEqual(ui.calls, ['saveActivityLog', 'copyActivityLog']);
  assert.equal(ui.elements.get('copy-log-result').textContent, 'Full session copied.');
  assert.equal(ui.elements.get('copy-activity-log').disabled, false);
});

test('Copy log reports failures in the activity panel and allows retry', async () => {
  const ui = await renderer(state(), new Error('clipboard unavailable'));
  await ui.click('copy-activity-log');
  assert.equal(ui.elements.get('copy-log-result').textContent, 'Could not copy log: clipboard unavailable');
  assert.equal(ui.elements.get('copy-activity-log').disabled, false);
});

test('the dock is always accessible, opens for tasks, and respects collapse until the next task', async () => {
  const ui = await renderer();
  assert.equal(ui.elements.get('console-body').hidden, true);
  await ui.click('toggle-activity-log');
  assert.equal(ui.elements.get('console-body').hidden, false);
  assert.equal(ui.elements.get('toggle-activity-log')['aria-expanded'], 'true');
  await ui.click('toggle-activity-log');
  const task = { label: 'Build Sunshine port', startedAt: Date.now(), canStop: true };
  await ui.emitActivity(task);
  assert.equal(ui.elements.get('console-body').hidden, false);
  assert.equal(ui.elements.get('console-state').textContent, 'Live');
  assert.equal(ui.elements.get('stop').hidden, false);
  await ui.click('toggle-activity-log');
  await ui.emitActivity({ ...task, detail: 'Compiling…' });
  assert.equal(ui.elements.get('console-body').hidden, true);
  await ui.emitActivity(null);
  await ui.emitActivity(task);
  assert.equal(ui.elements.get('console-body').hidden, false);
});

test('the dock opens for reported failures and expands without treating stderr as a crash', async () => {
  const ui = await renderer();
  await ui.emitLog({ id: 1, sequence: 1, stream: 'stderr', text: 'Could not find customStages.bin' });
  assert.equal(ui.elements.get('console-state').textContent, 'Idle');
  assert.equal(ui.elements.get('console-body').hidden, true);
  await ui.emitLog({ id: 2, sequence: 2, stream: 'launcher', text: '✕ Game exited with code 7.' });
  assert.equal(ui.elements.get('console-state').textContent, 'Error');
  assert.equal(ui.elements.get('console-body').hidden, false);
  await ui.click('expand-activity-log');
  assert.equal(ui.elements.get('activity-log').classList.contains('is-expanded'), true);
  assert.equal(ui.elements.get('expand-activity-log')['aria-label'], 'Restore activity log');
  await ui.click('toggle-activity-log');
  assert.equal(ui.elements.get('activity-log').classList.contains('is-expanded'), false);
  await ui.resetLog(3);
  assert.equal(ui.elements.get('console-state').textContent, 'Idle');
});

test('a fresh Play clears rendered history and ignores delayed output from the previous run', async () => {
  const data = state();
  const old = { id: 1, sequence: 1, stream: 'stderr', text: 'old error' };
  data.logs = [old];
  const ui = await renderer(data);
  await ui.click('copy-activity-log');
  await ui.resetLog(2);
  assert.equal(ui.elements.get('log').textContent, '');
  assert.equal(ui.elements.get('copy-log-result').textContent, '');
  await ui.emitLog(old);
  await ui.emitLog({ id: 2, sequence: 3, stream: 'stdout', text: 'new run' });
  assert.equal(ui.elements.get('log').textContent, '[stdout] new run\n');
});

test('usage sharing toggle shows the setting and is saved with the others', async () => {
  const data = state(); data.config.settings = port.normalizeSettings({ shareUsage: false });
  const ui = await renderer(data);
  assert.equal(ui.elements.get('shareUsage').checked, false);
  ui.elements.get('shareUsage').checked = true;
  ui.elements.get('shareUsage').dispatch('change');
  await new Promise(setImmediate);
  assert.equal(ui.calls.at(-1)[1].shareUsage, true);
});

test('the Discord toggle shows the setting and is saved with the others', async () => {
  const data = state(); data.config.settings = port.normalizeSettings({});
  const ui = await renderer(data);
  assert.equal(ui.elements.get('discordPresence').checked, true);
  ui.elements.get('discordPresence').checked = false;
  ui.elements.get('discordPresence').dispatch('change');
  await new Promise(setImmediate);
  assert.equal(ui.calls.at(-1)[1].discordPresence, false);
});

test('dark mode is off by default, switches the theme at once and is saved with the others', async () => {
  const ui = await renderer(state());
  const shell = ui.elements.get('shell');
  assert.equal(ui.elements.get('darkMode').checked, false);
  assert.equal(shell.classList.contains('dark'), false);
  ui.elements.get('darkMode').checked = true;
  ui.elements.get('darkMode').dispatch('input');
  assert.equal(shell.classList.contains('dark'), true);
  ui.elements.get('darkMode').dispatch('change');
  await new Promise(setImmediate);
  assert.equal(ui.calls.at(-1)[1].darkMode, true);
  assert.equal(shell.classList.contains('dark'), true);
  const saved = state(); saved.config.settings = port.normalizeSettings({ darkMode: true });
  assert.equal((await renderer(saved)).elements.get('shell').classList.contains('dark'), true);
});

test('the top bar shows the online count once the usage API answers', async () => {
  const data = state(), ui = await renderer(data);
  assert.equal(ui.elements.get('online-number').textContent, '');
  ui.listeners.online({ online: 1, playing: 0 });
  assert.equal(ui.elements.get('online-count').hidden, false);
  assert.equal(ui.elements.get('online-number').textContent, '1 online');
  assert.equal(ui.elements.get('online-count').title, '1 player has the launcher open · 0 playing now');
  data.online = { online: 42, playing: 7 };
  await ui.refresh();
  assert.equal(ui.elements.get('online-number').textContent, '42 online');
  assert.equal(ui.elements.get('online-count').title, '42 players have the launcher open · 7 playing now');
});

const notes = {
  current: '0.1.39', unseen: ['0.1.39'],
  releases: [
    { version: '0.1.39', date: '2026-10-09', title: '', launcher: ['Launcher change'],
      game: { version: '2026.10.09.1', commit: null, changes: ['Game change'] } },
    { version: '0.1.38', date: '2026-10-08', title: '', launcher: ['Older change'], game: null }
  ]
};

test('the changelog opens once after an update with only the new releases', async () => {
  const ui = await renderer(state(), null, notes);
  assert.equal(ui.elements.get('changelog').open, true);
  assert.equal(ui.elements.get('changelog-title').textContent, 'Updated to v0.1.39');
  assert.equal(ui.elements.get('changelog-show-all').hidden, false);
  assert.equal(ui.changelogSeen.length, 1);
  await ui.click('changelog-show-all');
  assert.equal(ui.elements.get('changelog-title').textContent, 'Changelog');
  assert.equal(ui.elements.get('changelog-show-all').hidden, true);
});

test('nothing new means no popup, and a running task postpones it to the next start', async () => {
  const quiet = await renderer(state(), null, { ...notes, unseen: [] });
  assert.equal(quiet.elements.get('changelog').open, false);
  assert.equal(quiet.changelogSeen.length, 1);
  const busy = await renderer({ ...state(), active: { label: 'Build Sunshine port', startedAt: Date.now() } }, null, notes);
  assert.equal(busy.elements.get('changelog').open, false);
  assert.equal(busy.changelogSeen.length, 0);
});

test('the main menu changelog button shows every release', async () => {
  const ui = await renderer(state(), null, { ...notes, unseen: [] });
  await ui.click('open-changelog');
  assert.equal(ui.elements.get('changelog').open, true);
  assert.equal(ui.elements.get('changelog-title').textContent, 'Changelog');
  assert.equal(ui.elements.get('changelog-show-all').hidden, true);
});

test('Beta builds see new Beta notes first, and only Beta notes when no release is new', async () => {
  const beta = { launcher: ['Beta launcher change'], game: ['Beta game change'], unseen: true };
  const ui = await renderer(state(), null, { ...notes, unseen: [], beta });
  assert.equal(ui.elements.get('changelog').open, true);
  assert.equal(ui.elements.get('changelog-title').textContent, "What's new in Beta");
  assert.equal(ui.elements.get('changelog-show-all').hidden, false);
  assert.equal(ui.changelogSeen.length, 1);
  const seen = await renderer(state(), null, { ...notes, unseen: [], beta: { ...beta, unseen: false } });
  assert.equal(seen.elements.get('changelog').open, false);
  await seen.click('open-changelog');
  assert.equal(seen.elements.get('changelog-title').textContent, 'Changelog');
});

test('controller buttons open settings, step through its tabs, go back and pause while the game runs', async () => {
  const view = await renderer(state());
  const { elements, gamepad } = view;
  const tabs = ['gameplay', 'display', 'graphics', 'controls', 'manage', 'saves', 'launcher'];
  const shown = () => tabs.filter(name => !elements.get(`pane-${name}`).hidden);
  assert.equal(gamepad.paused(), false);
  gamepad.actions.menu();
  assert.equal(elements.get('page-settings').open, true);
  assert.deepEqual(shown(), ['gameplay']);
  gamepad.actions.previous();
  assert.deepEqual(shown(), ['gameplay']);
  gamepad.actions.next();
  assert.deepEqual(shown(), ['display']);
  for (let i = 0; i < 10; i++) gamepad.actions.next();
  assert.deepEqual(shown(), ['launcher']);
  assert.equal(elements.get('tab-launcher')['aria-selected'], 'true');
  assert.equal(elements.get('tab-gameplay')['aria-selected'], 'false');
  gamepad.actions.previous();
  assert.deepEqual(shown(), ['saves']);
  gamepad.actions.back();
  assert.equal(elements.get('page-settings').open, false);
  // Settings reopens on the tab it closed on.
  gamepad.actions.menu();
  assert.deepEqual(shown(), ['saves']);
  await view.click('tab-controls');
  assert.deepEqual(shown(), ['controls']);
  gamepad.actions.back();
  assert.equal(elements.get('page-settings').open, false);
  gamepad.actions.view();
  assert.equal(elements.get('console-body').hidden, false);
  gamepad.actions.back();
  assert.equal(elements.get('console-body').hidden, true);
  await view.emitActivity({ label: 'Play Super Mario Sunshine', startedAt: Date.now() });
  assert.equal(gamepad.paused(), true);
});

test('the Steam banner offers Add to Steam, then shows a tick once the launcher is in the library', async () => {
  const hidden = await renderer();
  assert.equal(hidden.elements.get('add-to-steam').hidden, true);
  const add = await renderer(state(), null, undefined, { available: true, inSteam: false });
  assert.equal(add.elements.get('add-to-steam').hidden, false);
  assert.equal(add.elements.get('steam-banner-title').textContent, 'Add to Steam');
  assert.equal(add.elements.get('steam-banner-mark').textContent, '+');
  // Started from Steam (Game Mode): in the library, with nothing to do.
  const fromSteam = await renderer(state(), null, undefined, { available: false, inSteam: true });
  const banner = fromSteam.elements.get('add-to-steam');
  assert.equal(banner.hidden, false);
  assert.equal(banner.disabled, true);
  assert.ok(banner.classList.contains('in-steam'));
  assert.equal(fromSteam.elements.get('steam-banner-title').textContent, 'In your Steam library');
  assert.equal(fromSteam.elements.get('steam-banner-mark').textContent, '✓');
  // Added by hand or before: selecting the tick updates it, keeping Skip Launcher as Steam has it.
  const update = await renderer(state(), null, undefined, { available: true, inSteam: true, skipLauncher: true });
  assert.equal(update.elements.get('add-to-steam').disabled, false);
  await update.click('add-to-steam');
  assert.equal(update.elements.get('steam-add').open, true);
  assert.equal(update.elements.get('steam-add-confirm').textContent, 'Update in Steam');
  assert.equal(update.elements.get('steam-skip-launcher').checked, true);
});

test('Play on SteamOS offers Add to Steam once, and plays whatever the player chooses', async () => {
  const offer = { available: true, inSteam: false, steamOS: true, offer: true };
  const ui = await renderer({ ...state(), game: { ...state().game, needsUpdate: false } }, null, undefined, offer);
  await ui.click('play');
  assert.equal(ui.elements.get('steam-add').open, true);
  assert.equal(ui.elements.get('steam-add-cancel').textContent, 'Not now');
  assert.deepEqual(ui.calls, ['steamOffered:play']);
  ui.elements.get('steam-add').close();
  ui.elements.get('steam-add').dispatch('close');
  await new Promise(setImmediate);
  assert.deepEqual(ui.calls, ['steamOffered:play', 'launchGame']);
  await ui.click('play');
  assert.equal(ui.elements.get('steam-add').open, false);
  assert.deepEqual(ui.calls, ['steamOffered:play', 'launchGame', 'launchGame']);

  const adding = await renderer({ ...state(), game: { ...state().game, needsUpdate: false } }, null, undefined, offer);
  await adding.click('play');
  adding.elements.get('steam-skip-launcher').checked = true;
  await adding.click('steam-add-confirm');
  adding.elements.get('steam-add').dispatch('close');
  await new Promise(setImmediate);
  assert.equal(JSON.stringify(adding.calls), JSON.stringify(['steamOffered:play', ['addToSteam', { play: true }], 'launchGame']));
  assert.match(adding.elements.get('message-text').textContent, /Added "Super Mario Sunshine" in your Steam library/);
  assert.equal(adding.elements.get('steam-banner-title').textContent, 'In your Steam library');
});

test("a shortcut made by hand without --no-sandbox is offered a fix when the launcher opens, once", async () => {
  const broken = { available: true, inSteam: true, needsFix: true, offerFix: true, skipLauncher: true };
  const ui = await renderer(state(), null, undefined, broken);
  assert.equal(ui.elements.get('steam-add').open, true);
  assert.equal(ui.elements.get('steam-add-kicker').textContent, 'Fix for Game Mode');
  assert.equal(ui.elements.get('steam-add-confirm').textContent, 'Fix shortcut');
  assert.equal(ui.elements.get('steam-skip-launcher').checked, true);
  assert.deepEqual(ui.calls, ['steamOffered:fix']);
  const banner = ui.elements.get('add-to-steam');
  assert.ok(banner.classList.contains('needs-fix'));
  assert.equal(ui.elements.get('steam-banner-mark').textContent, '!');
  await ui.click('steam-add-confirm');
  assert.equal(JSON.stringify(ui.calls), JSON.stringify(['steamOffered:fix', ['addToSteam', { play: true }]]));
  assert.match(ui.elements.get('message-text').textContent, /Fixed "Super Mario Sunshine" in Steam with its artwork: it opens in Game Mode now/);
  assert.equal(ui.elements.get('steam-banner-title').textContent, 'In your Steam library');
  assert.equal(banner.classList.contains('needs-fix'), false);

  // Declined before: the banner still offers it, without the popup.
  const declined = await renderer(state(), null, undefined, { ...broken, offerFix: false });
  assert.equal(declined.elements.get('steam-add').open, false);
  await declined.click('add-to-steam');
  assert.equal(declined.elements.get('steam-add-confirm').textContent, 'Fix shortcut');

  // Started from that shortcut: Steam can't close under it, so the banner says what to change.
  const fromSteam = await renderer(state(), null, undefined, { available: false, inSteam: true, needsFix: true });
  assert.equal(fromSteam.elements.get('steam-add').open, false);
  assert.equal(fromSteam.elements.get('add-to-steam').disabled, true);
  assert.match(fromSteam.elements.get('steam-banner-detail').textContent, /add --no-sandbox to its launch options/);
});

test('setup names one folder for the game, tools, saves and backups, with the download size', async () => {
  let ui = await renderer(firstRun());
  assert.equal(ui.elements.get('repo-path').textContent, '/games');
  assert.equal(ui.elements.get('tool-location-note').textContent,
    'The game, its build tools (766 MB download), your saves and their backups all go in this folder.');
  assert.match(ui.elements.get('settings-data-path').textContent, /^\/games\n/);
  ui = await renderer(firstRun({ toolsDownloaded: true }));
  assert.match(ui.elements.get('tool-location-note').textContent, /build tools \(already downloaded\)/);
  ui = await renderer(firstRun({ dataInFolder: false, data: '/data', tools: '/data/build-tools', toolDownloadBytes: 1266171545 }));
  assert.equal(ui.elements.get('tool-location-note').textContent,
    'Game files go in this folder. Build tools (1.3 GB download), saves and backups go in /data.');
});
