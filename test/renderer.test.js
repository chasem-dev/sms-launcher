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
    platform: port.platformInfo(), tools: { ready: true, appleReady: true }, features: { vulkan: true, appleSilicon: true },
    repoReady: true, romReady: true, binaryReady: true, hdVisualsReady: true,
    game: { needsUpdate: true, installedVersion: 'older', availableVersion: 'newer', launcherVersion: '0.1.39' },
    appUpdate: { message: '' }, backups: [], logs: [], active: null
  };
}

// The platform and processor a state's platformInfo describes, so saving settings in a test does not depend on the computer running it.
function host(platform) {
  return [{ linux: 'linux', macos: 'darwin', windows: 'win32' }[platform.id], platform.arches.includes('arm64') ? 'arm64' : 'x64'];
}

// `achievements`, when given, also loads the Achievements page over that state: { list, update } where
// update(name) changes the list as the main process would after `name` (downloadAchievementIcons, updatePort).
// `modsNews`: whether the published mod list changed since the Mods tab was last opened (main.js: modsNews).
async function renderer(data = state(), copyError = null, notes = { releases: [], unseen: [], current: '0.1.39' }, steam = {}, achievements = null, modsNews = { unseen: false }) {
  const importResult = { imported: [{ name: 'GMSE04_super_mario_sunshine', game: 'eclipse', title: 'Super Mario Eclipse',
    shines: [3, null, 1], file: '04-GMSE-super_mario_sunshine.gci' }],
  skipped: [{ file: '01-GMSE-super_mario_sunshine.gci', reason: 'Super Mario Sunshine save with no saved progress' },
    { file: '04-GMSE-super_mario_eclipse.gci', reason: 'Eclipse settings, not a game save' }] };
  const changelogSeen = [], modsSeen = [], calls = [], elements = new Map(), droppedFiles = [], listeners = {}, gamepad = {};
  let logCallback, resetCallback, activityCallback;
  const text = node => node.textContent + node.children.map(text).join(' ');
  function element(classes = '') {
    const names = new Set(classes.split(' ')), listeners = new Map();
    return { hidden: false, disabled: false, textContent: '', value: '', style: { setProperty() {} }, open: false,
      classList: { contains: name => names.has(name), add: name => names.add(name), remove: name => names.delete(name), toggle(name, enabled) {
        if (enabled) names.add(name); else names.delete(name);
      } },
      addEventListener: (event, callback) => { if (!listeners.has(event)) listeners.set(event, []); listeners.get(event).push(callback); },
      click() { if (!this.disabled) for (const callback of listeners.get('click') || []) callback(); },
      dispatch(event, value) { for (const callback of listeners.get(event) || []) callback(value); },
      setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
      replaceChildren(...children) { this.textContent = children.map(text).join(''); this.replaced = children; },
      append(...children) { this.children.push(...children); }, focus() {}, querySelector: () => null,
      children: [], appendChild(child) { this.children.push(child); return child; },
      close() { this.open = false; }, showModal() { this.open = true; },
      dataset: {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), querySelectorAll: () => [],
      showPopover() { this.dispatch('beforetoggle', { newState: 'open' }); this.open = true; this.dispatch('toggle', { newState: 'open' }); },
      hidePopover() { this.open = false; this.dispatch('toggle', { newState: 'closed' }); } };
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
    onLog(callback) { logCallback = callback; }, onActivity(callback) { activityCallback = callback; }, onAppUpdate() {}, onWindowState() {}, onOnline(callback) { listeners.online = callback; }, onPublicOnline(callback) { listeners.publicOnline = callback; },
    onLogReset(callback) { resetCallback = callback; },
    onDiscordJoin(callback) { listeners.discordJoin = callback; },
    takeDiscordJoin: async () => { const code = data.discordJoin || null; data.discordJoin = null; return code; },
    joinGame: async value => { calls.push(['joinGame', value]); },
    saveActivityLog: async () => { calls.push('saveActivityLog'); },
    copyActivityLog: async () => { calls.push('copyActivityLog'); if (copyError) throw copyError; },
    saveSettings: async value => { calls.push(['saveSettings', value]); return { ...data, config: { ...data.config, settings: port.normalizeSettings(value, ...host(data.platform)) } }; },
    changelog: async () => notes, markChangelogSeen: async () => { changelogSeen.push(true); },
    play: async () => { calls.push('play'); }, launchGame: async () => { calls.push('launchGame'); },
    removeBuildTools: async () => { calls.push('removeBuildTools'); },
    updateAndPlay: async () => { calls.push('updateAndPlay'); }, playCoop: async () => { calls.push('playCoop'); },
    updatePort: async () => {
      calls.push('updatePort'); data.game = { ...data.game, needsUpdate: false, installedVersion: data.game.availableVersion };
      achievements?.update?.('updatePort');
    },
    checkNat: async () => ({ label: 'Open', type: 'open', text: 'You can host and join.' }), publicGames: async () => [],
    nativeMods: async () => ({ folder: '/mods', gameApi: '1.4', mods: [] }), nativeModsLatest: async () => ({}),
    nativeModsNews: async () => ({ ...modsNews }), onNativeModsNews(callback) { listeners.modsNews = callback; },
    markNativeModsSeen: async () => { modsSeen.push(true); modsNews = { unseen: false }; return { ...modsNews }; },
    copyText: async text => { calls.push(['copyText', text]); },
    steamStatus: async () => ({ ...steam }), steamOffered: async prompt => { calls.push(`steamOffered:${prompt}`); },
    appleSiliconSwitched: async keptRosetta => { calls.push(['appleSiliconSwitched', keptRosetta]); },
    addToSteam: async options => { calls.push(['addToSteam', options]); steam = { ...steam, inSteam: true, needsFix: false, offer: false, offerFix: false };
      return { added: true, play: options.play, name: 'Super Mario Sunshine', artwork: 5, total: 5 }; }
  };
  const context = vm.createContext({ console, setInterval() {}, clearInterval() {}, requestAnimationFrame: callback => setImmediate(callback),
    cancelAnimationFrame() {}, navigator: { getGamepads: () => [] }, SmsBindings: require('../src/bindings'),
    window: { sms, smsActivityLog: require('../src/activity-log'), smsChangelogText: require('../src/changelog-text'), smsRumble: require('../src/rumble'), smsGamepadNav: { start: options => Object.assign(gamepad, options) },
      addEventListener() {}, removeEventListener() {} }, document: {
    getElementById(id) { assert.ok(elements.has(id), `Missing HTML element ${id}`); return elements.get(id); },
    querySelectorAll(selector) {
      const modals = ['steam-add', 'mac-tools-help', 'apple-silicon-switched', 'achievements-get'].map(id => elements.get(id));
      return selector === '.launcher-modal' ? modals : selector === '.launcher-modal[open]' ? modals.filter(modal => modal.open) : [];
    }, createElement: () => element()
  } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/renderer.js'), 'utf8'), context);
  if (achievements) {
    Object.assign(sms, {
      achievements: async () => ({ ...achievements.list }), achievementIcons: async () => ({}), onAchievement() {},
      onActivity(callback) { achievements.activity = callback; },
      markAchievementsSeen: async () => { calls.push('markAchievementsSeen'); achievements.list.seen = true; },
      downloadAchievementIcons: async () => {
        calls.push('downloadAchievementIcons');
        if (achievements.hold) await new Promise(resolve => { achievements.release = resolve; });
        if (achievements.error) throw new Error(achievements.error);
        achievements.update?.('downloadAchievementIcons');
        return { ...achievements.list };
      }
    });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src/achievements-page.js'), 'utf8'), context);
  }
  await new Promise(setImmediate);
  if (achievements) {
    vm.runInContext('window.smsAchievementsRefresh(current)', context);
    await new Promise(setImmediate);
  }
  return { elements, calls, droppedFiles, listeners, changelogSeen, modsSeen, gamepad,
    async emitLog(entry) { logCallback(entry); await new Promise(setImmediate); },
    async resetLog(sequence) { resetCallback(sequence); await new Promise(setImmediate); },
    async emitActivity(active) { activityCallback(active); await new Promise(setImmediate); },
    async refresh() { vm.runInContext('refresh(current)', context); },
    run: code => vm.runInContext(code, context),
    async click(id) { elements.get(id).click(); await new Promise(setImmediate); } };
}

const offered = ui => ['menu-update-play', 'menu-update-only', 'menu-play-now'].filter(id => !ui.elements.get(id).hidden);

test('a waiting update makes Update & play the default, with Update only and Play now under ▾', async () => {
  const ui = await renderer();
  assert.equal(ui.elements.get('play-more').hidden, false);
  assert.equal(ui.elements.get('play').classList.contains('has-more'), true);
  assert.match(ui.elements.get('play').textContent, /Update & play/);
  assert.match(ui.elements.get('home-description').textContent, /Game update newer is ready/);
  assert.equal(ui.elements.get('menu-default-label').textContent, 'Update & play');
  assert.equal(ui.elements.get('menu-default-detail').textContent, 'Install newer, then start');
  assert.deepEqual(offered(ui), ['menu-update-only', 'menu-play-now']);
  assert.equal(ui.elements.get('menu-play-now-detail').textContent, 'Update later');
  assert.equal(ui.elements.get('play-more-hint').textContent, '▾ for Update only or Play now or Play co-op');
  assert.equal(ui.elements.get('play-menu-note').hidden, false);
  ui.elements.get('play-menu').showPopover();
  assert.equal(ui.elements.get('play-more')['aria-expanded'], 'true');
  await ui.click('menu-play-now');
  assert.equal(ui.elements.get('play-menu').open, false);
  assert.equal(ui.elements.get('play-more')['aria-expanded'], 'false');
  assert.deepEqual(ui.calls, ['play']);
  await ui.click('menu-default');
  assert.deepEqual(ui.calls, ['play', 'launchGame']);
});

test('Update only installs the update without starting the game', async () => {
  const ui = await renderer();
  await ui.click('menu-update-only');
  assert.deepEqual(ui.calls, ['updatePort']);
  // the menu stays for Play co-op alone
  assert.equal(ui.elements.get('play-more').hidden, false);
  assert.deepEqual(offered(ui), []);
  assert.equal(ui.elements.get('play-more-hint').textContent, '▾ for Play co-op');
  assert.match(ui.elements.get('play').textContent, /▶ {2}Play/);
  assert.match(ui.elements.get('message-text').textContent, /Updated to game newer/);
});

test('without automatic updates Play is the default and Update & play still updates', async () => {
  const data = state();
  data.config.settings = port.normalizeSettings({ autoUpdate: false });
  const ui = await renderer(data);
  assert.match(ui.elements.get('play').textContent, /▶ {2}Play/);
  assert.equal(ui.elements.get('menu-default-label').textContent, 'Play');
  assert.equal(ui.elements.get('task-status').textContent, 'Update ready');
  assert.deepEqual(offered(ui), ['menu-update-play', 'menu-update-only']);
  assert.equal(ui.elements.get('play-more-hint').textContent, '▾ for Update & play or Update only or Play co-op');
  await ui.click('menu-update-play');
  assert.deepEqual(ui.calls, ['updateAndPlay']);
});

test('Play co-op starts the game for two, once the game version has co-op', async () => {
  const data = state(); data.game.needsUpdate = false; data.features = { coop: false };
  const ui = await renderer(data);
  assert.equal(ui.elements.get('menu-coop').disabled, true);
  assert.match(ui.elements.get('menu-coop-detail').textContent, /newer game version/);
  // an update on its way brings co-op: Play co-op updates first
  data.game.needsUpdate = true;
  await ui.refresh();
  assert.equal(ui.elements.get('menu-coop').disabled, false);
  assert.match(ui.elements.get('menu-coop-detail').textContent, /updates to newer first/);
  data.game.needsUpdate = false; data.features = { coop: true };
  await ui.refresh();
  assert.equal(ui.elements.get('menu-coop').disabled, false);
  assert.equal(ui.elements.get('menu-coop-detail').textContent, 'Split screen for two: player 2 presses START on a controller');
  await ui.click('menu-coop');
  assert.deepEqual(ui.calls, ['playCoop']);
});

test('controller Back closes the menu before anything else', async () => {
  const ui = await renderer();
  ui.elements.get('play-menu').showPopover();
  ui.gamepad.actions.back();
  assert.equal(ui.elements.get('play-menu').open, false);
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
    assert.equal(ui.elements.get('play-more').hidden, true);
  }
  const data = state(), ui = await renderer(data);
  ui.elements.get('play-menu').showPopover();
  data.active = { label: 'Build Sunshine port' };
  await ui.refresh();
  assert.equal(ui.elements.get('play-more').disabled, true);
  assert.equal(ui.elements.get('play-menu').open, false);
  assert.equal(ui.elements.get('play-more-hint').hidden, true);
});

test('pending HD setup offers installed play, while current complete installs offer only Play co-op beside Play', async () => {
  const data = state(); data.game.needsUpdate = false; data.game.installedVersion = null;
  const ui = await renderer(data);
  assert.equal(ui.elements.get('play-more').hidden, false);
  assert.deepEqual(offered(ui), []);
  assert.equal(ui.elements.get('menu-default-label').textContent, 'Play');
  assert.equal(ui.elements.get('menu-default-detail').textContent, 'One player');
  data.hdVisualsReady = false;
  await ui.refresh();
  assert.equal(ui.elements.get('play-more').hidden, false);
  assert.equal(ui.elements.get('menu-default-label').textContent, 'Finish HD setup');
  assert.equal(ui.elements.get('menu-default').dataset.kind, 'hd');
  assert.deepEqual(offered(ui), ['menu-play-now']);
  assert.equal(ui.elements.get('menu-play-now-detail').textContent, 'HD visuals later');
  assert.equal(ui.elements.get('play-menu-note').hidden, true);
  await ui.click('menu-play-now');
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

test('the status bar opens the log on any page, and a task shows its progress without opening it', async () => {
  const ui = await renderer();
  const log = ui.elements.get('activity-log');
  assert.equal(log.hidden, true);
  await ui.click('toggle-activity-log');
  assert.equal(log.hidden, false);
  assert.equal(ui.elements.get('toggle-activity-log')['aria-expanded'], 'true');
  await ui.click('settings-cog');
  assert.equal(log.hidden, false);
  await ui.click('close-activity-log');
  assert.equal(log.hidden, true);
  const task = { label: 'Build Sunshine port', startedAt: Date.now(), canStop: true, percent: 42 };
  await ui.emitActivity(task);
  assert.equal(log.hidden, true);
  assert.equal(ui.elements.get('console-state').textContent, 'Live');
  assert.equal(ui.elements.get('toggle-activity-log').classList.contains('is-live'), true);
  assert.equal(ui.elements.get('status-progress').hidden, false);
  assert.equal(ui.elements.get('status-progress-fill').style.width, '42%');
  assert.equal(ui.elements.get('stop').hidden, false);
  await ui.click('view-build-log');
  assert.equal(log.hidden, false);
  await ui.emitActivity(null);
  assert.equal(ui.elements.get('status-progress').hidden, true);
});

test('the log opens for reported failures and expands without treating stderr as a crash', async () => {
  const ui = await renderer();
  await ui.emitLog({ id: 1, sequence: 1, stream: 'stderr', text: 'Could not find customStages.bin' });
  assert.equal(ui.elements.get('console-state').textContent, 'Idle');
  assert.equal(ui.elements.get('activity-log').hidden, true);
  await ui.emitLog({ id: 2, sequence: 2, stream: 'launcher', text: '✕ Game exited with code 7.' });
  assert.equal(ui.elements.get('console-state').textContent, 'Error');
  assert.equal(ui.elements.get('toggle-activity-log').classList.contains('is-error'), true);
  assert.equal(ui.elements.get('activity-log').hidden, false);
  await ui.click('expand-activity-log');
  assert.equal(ui.elements.get('activity-log').classList.contains('is-expanded'), true);
  assert.equal(ui.elements.get('shell').classList.contains('log-expanded'), true);
  assert.equal(ui.elements.get('expand-activity-log')['aria-label'], 'Restore activity log');
  await ui.click('toggle-activity-log');
  assert.equal(ui.elements.get('activity-log').classList.contains('is-expanded'), false);
  assert.equal(ui.elements.get('shell').classList.contains('log-expanded'), false);
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

test('Back up automatically shows the setting and is saved with the others', async () => {
  const data = state(); data.config.settings = port.normalizeSettings({});
  const ui = await renderer(data);
  assert.equal(ui.elements.get('autoBackups').checked, true);
  ui.elements.get('autoBackups').checked = false;
  ui.elements.get('autoBackups').dispatch('change');
  await new Promise(setImmediate);
  assert.equal(ui.calls.at(-1)[1].autoBackups, false);
});

test('the Language list comes from the catalog, and a language the game lacks asks for an update', async () => {
  const data = state(); data.config.settings = port.normalizeSettings({ language: 'pl' });
  data.languagesSupported = true;
  data.languages = [{ code: 'en', name: 'English', available: true }, { code: 'fr', name: 'Français', available: true },
    { code: 'pl', name: 'Polski', community: true, available: false }];
  const ui = await renderer(data);
  assert.equal(ui.elements.get('language').textContent, 'EnglishFrançaisPolski');
  assert.equal(ui.elements.get('language').value, 'pl');
  assert.match(ui.elements.get('language-note').textContent, /Update the game to play in Polski/);
  data.languages[2].available = true; data.languageInstalled = true;
  await ui.refresh(); await new Promise(setImmediate);
  assert.match(ui.elements.get('language-note').textContent, /Polski is a community translation/);
  data.languages.push({ code: 'pt-br', name: 'Português (Brasil)', community: true, available: true,
    note: 'Português (Brasil) is a community translation, made for Super Mario 3D All-Stars; some pictures stay in Spanish.' });
  data.config.settings = port.normalizeSettings({ language: 'pt-br' });
  await ui.refresh(); await new Promise(setImmediate);
  assert.equal(ui.elements.get('language-note').textContent,
    'Português (Brasil) is a community translation, made for Super Mario 3D All-Stars; some pictures stay in Spanish.');
  ui.elements.get('language').value = 'fr';
  ui.elements.get('language').dispatch('change');
  await new Promise(setImmediate);
  assert.equal(ui.calls.at(-1)[1].language, 'fr');
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

const version = (ui, key) => ui.elements.get('changelog-nav').replaced.find(button => button.dataset.key === key);

test('the changelog opens once after an update on the newest release, with the others beside it', async () => {
  const ui = await renderer(state(), null, notes);
  assert.equal(ui.elements.get('changelog').hidden, false);
  assert.equal(ui.elements.get('changelog-title').textContent, 'Updated to v0.1.39');
  assert.equal(ui.elements.get('changelog-version').textContent, 'v0.1.39');
  assert.equal(ui.elements.get('changelog-badge').textContent, 'New');
  assert.equal(ui.elements.get('changelog-meta').textContent, `${new Date('2026-10-09T12:00:00').toLocaleDateString(undefined,
    { year: 'numeric', month: 'short', day: 'numeric' })} · Game 2026.10.09.1`);
  assert.deepEqual(ui.elements.get('changelog-nav').replaced.map(button => button.dataset.key), ['0.1.39', '0.1.38']);
  assert.equal(ui.changelogSeen.length, 1);
  version(ui, '0.1.38').click();
  assert.equal(ui.elements.get('changelog-version').textContent, 'v0.1.38');
  assert.equal(ui.elements.get('changelog-badge').hidden, true);
  assert.ok(version(ui, '0.1.38').classList.contains('active'));
  assert.ok(!version(ui, '0.1.39').classList.contains('active'));
});

test('nothing new means no popup, and a running task postpones it to the next start', async () => {
  const quiet = await renderer(state(), null, { ...notes, unseen: [] });
  assert.equal(quiet.elements.get('changelog').hidden, true);
  assert.equal(quiet.changelogSeen.length, 1);
  const busy = await renderer({ ...state(), active: { label: 'Build Sunshine port', startedAt: Date.now() } }, null, notes);
  assert.equal(busy.elements.get('changelog').hidden, true);
  assert.equal(busy.changelogSeen.length, 0);
});

test("the What's new tab lists every release and opens on the newest", async () => {
  const ui = await renderer(state(), null, { ...notes, unseen: [] });
  await ui.click('open-changelog');
  assert.equal(ui.elements.get('changelog').hidden, false);
  assert.equal(ui.elements.get('changelog-title').textContent, "What's new");
  assert.equal(ui.elements.get('changelog-version').textContent, 'v0.1.39');
  assert.equal(ui.elements.get('changelog-badge').textContent, 'Installed');
  assert.equal(ui.elements.get('changelog-nav').replaced.length, 2);
  const empty = await renderer(state(), null, { releases: [], unseen: [], current: '0.1.39' });
  await empty.click('open-changelog');
  assert.equal(empty.elements.get('changelog-status').textContent, 'No changes are listed yet.');
  assert.equal(empty.elements.get('changelog-head').hidden, true);
});

test('Beta builds see new Beta notes first, and only Beta notes when no release is new', async () => {
  const beta = { launcher: ['Beta launcher change'], game: ['Beta game change'], unseen: true };
  const ui = await renderer(state(), null, { ...notes, unseen: [], beta });
  assert.equal(ui.elements.get('changelog').hidden, false);
  assert.equal(ui.elements.get('changelog-title').textContent, "What's new in Beta");
  assert.equal(ui.elements.get('changelog-version').textContent, 'Beta');
  assert.equal(ui.elements.get('changelog-badge').textContent, 'New');
  assert.deepEqual(ui.elements.get('changelog-nav').replaced.map(button => button.dataset.key), ['beta', '0.1.39', '0.1.38']);
  assert.equal(ui.changelogSeen.length, 1);
  const seen = await renderer(state(), null, { ...notes, unseen: [], beta: { ...beta, unseen: false } });
  assert.equal(seen.elements.get('changelog').hidden, true);
  await seen.click('open-changelog');
  assert.equal(seen.elements.get('changelog-title').textContent, "What's new");
  assert.equal(seen.elements.get('changelog-version').textContent, 'Beta');
  assert.equal(seen.elements.get('changelog-badge').textContent, 'Not released yet');
});

test('controller buttons open settings, step through its tabs, go back and pause while the game runs', async () => {
  const view = await renderer(state());
  const { elements, gamepad } = view;
  const tabs = ['gameplay', 'display', 'graphics', 'controls', 'manage', 'mods', 'launcher'];
  const shown = () => tabs.filter(name => !elements.get(`pane-${name}`).hidden);
  assert.equal(gamepad.paused(), false);
  gamepad.actions.menu();
  assert.equal(elements.get('page-settings').hidden, false);
  assert.equal(elements.get('page-home').hidden, true);
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
  assert.deepEqual(shown(), ['mods']);
  gamepad.actions.previous();
  assert.deepEqual(shown(), ['manage']);
  gamepad.actions.back();
  assert.equal(elements.get('page-settings').hidden, true);
  assert.equal(elements.get('page-home').hidden, false);
  // Settings reopens on the tab it closed on.
  gamepad.actions.menu();
  assert.deepEqual(shown(), ['manage']);
  await view.click('tab-controls');
  assert.deepEqual(shown(), ['controls']);
  gamepad.actions.menu();
  assert.equal(elements.get('page-settings').hidden, true);
  // Away from Settings, LB and RB step through the launcher's tabs.
  gamepad.actions.next();
  assert.equal(elements.get('multiplayer').hidden, false);
  gamepad.actions.back();
  assert.equal(elements.get('page-home').hidden, false);
  gamepad.actions.view();
  assert.equal(elements.get('activity-log').hidden, false);
  gamepad.actions.back();
  assert.equal(elements.get('activity-log').hidden, true);
  await view.emitActivity({ label: 'Play Super Mario Sunshine', startedAt: Date.now() });
  assert.equal(gamepad.paused(), true);
});

test('a controller the launcher cannot see still gets its buttons changed, from the list in the row', async () => {
  const ui = await renderer();
  await ui.click('settings-cog');
  await ui.click('tab-controls');
  const choose = async (id, add, pad) => {
    ui.run(`bindingMode = 'controller'; startCapture(${JSON.stringify(id)}, ${add})`);
    const row = ui.elements.get('binding-list').replaced[ui.run(`SmsBindings.CONTROLS.findIndex(control => control.id === ${JSON.stringify(id)})`)];
    const keys = row.children[1];
    assert.equal(keys.textContent, 'No controller seen yet: press a button on it…');
    const list = keys.children.find(child => child.className === 'pad-choice');
    assert.deepEqual(list.children.map(option => option.value), ['', ...require('../src/bindings').PAD_BUTTONS.map(button => button.id)]);
    list.value = pad;
    list.dispatch('change');
    await new Promise(setImmediate);
  };
  await choose('A', false, 'PAD_B');
  assert.match(ui.elements.get('binding-note').textContent, /pick the button from the list/);
  await choose('B', false, 'PAD_A');
  assert.equal(ui.run('capture'), null);
  assert.deepEqual({ ...ui.calls.at(-1)[1].padBindings }, { A: ['PAD_B'], B: ['PAD_A'] });
  await choose('A', true, 'PAD_LB');
  assert.deepEqual([...ui.calls.at(-1)[1].padBindings.A], ['PAD_B', 'PAD_LB']);
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

test('the Customize Mario banner shows once a disc is chosen', async () => {
  assert.equal((await renderer()).elements.get('customize-mario').hidden, false);
  const noDisc = state();
  noDisc.romReady = false;
  assert.equal((await renderer(noDisc)).elements.get('customize-mario').hidden, true);
});

test('the tabs show one page at a time and mark it', async () => {
  const ui = await renderer();
  const sections = ['page-home', 'multiplayer', 'mario-look', 'page-saves', 'changelog', 'page-settings'];
  const visible = () => sections.filter(id => !ui.elements.get(id).hidden);
  assert.deepEqual(visible(), ['page-home']);
  for (const [nav, section] of [['nav-saves', 'page-saves'], ['open-multiplayer', 'multiplayer'], ['customize-mario', 'mario-look'],
    ['settings-cog', 'page-settings'], ['nav-play', 'page-home']]) {
    await ui.click(nav);
    assert.deepEqual(visible(), [section]);
    assert.equal(ui.elements.get(nav).classList.contains('active'), true);
    assert.equal(ui.elements.get(nav)['aria-current'], 'page');
  }
  assert.equal(ui.elements.get('settings-cog').classList.contains('active'), false);
});

test('a hosted room shows under Play and on Multiplayer, and goes when the game ends', async () => {
  const ui = await renderer();
  for (const id of ['play-room', 'mp-room']) assert.equal(ui.elements.get(id).hidden, true);
  await ui.click('open-multiplayer');
  await ui.emitActivity({ label: 'Play Super Mario Sunshine', startedAt: Date.now(), room: 'KQ7M2D' });
  for (const id of ['play-room', 'mp-room']) assert.equal(ui.elements.get(id).hidden, false);
  assert.equal(ui.elements.get('play-room-code').textContent, 'KQ7M2D');
  // Hosting from Multiplayer goes back to Play once the game starts.
  assert.equal(ui.elements.get('page-home').hidden, false);
  await ui.emitActivity(null);
  for (const id of ['play-room', 'mp-room']) assert.equal(ui.elements.get(id).hidden, true);
});

test('the Multiplayer tab shows how many play in public games, and nothing when nobody does', async () => {
  const ui = await renderer({ ...state(), publicOnline: { players: 3, games: 2 } });
  const badge = ui.elements.get('mp-online');
  assert.equal(badge.hidden, false);
  assert.equal(ui.elements.get('mp-online-count').textContent, '3');
  assert.equal(badge.title, '3 players in 2 public games right now');
  ui.listeners.publicOnline({ players: 1, games: 1 });
  assert.equal(badge.title, '1 player in a public game right now');
  ui.listeners.publicOnline({ players: 140, games: 20 });
  assert.equal(ui.elements.get('mp-online-count').textContent, '99+');
  ui.listeners.publicOnline({ players: 0, games: 0 });
  assert.equal(badge.hidden, true);
  ui.listeners.publicOnline({ players: 2, games: 1 });
  ui.listeners.publicOnline(null);
  assert.equal(badge.hidden, true);
});

test('a Discord game invite joins its room from Multiplayer, at startup and while open', async () => {
  const data = { ...state(), discordJoin: 'KQ7-M2D' };
  const ui = await renderer(data);
  await new Promise(setImmediate);
  assert.equal(ui.elements.get('multiplayer').hidden, false);
  assert.equal(ui.elements.get('mp-address').value, 'KQ7-M2D');
  assert.deepEqual(ui.calls.filter(call => call[0] === 'joinGame').map(call => call[1].address), ['KQ7-M2D']);
  data.discordJoin = 'ABC-123';
  ui.listeners.discordJoin();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.deepEqual(ui.calls.filter(call => call[0] === 'joinGame').map(call => call[1].address), ['KQ7-M2D', 'ABC-123']);
  // nothing waiting: nothing joins
  ui.listeners.discordJoin();
  await new Promise(setImmediate);
  assert.equal(ui.calls.filter(call => call[0] === 'joinGame').length, 2);
});

test('the Apple Silicon switch shows on macOS only, and builds the arm64 game when turned on', async () => {
  const mac = state();
  mac.platform = port.platformInfo('darwin', 'arm64');
  mac.config.settings = port.normalizeSettings({ arch: '64' }, 'darwin', 'arm64');
  const ui = await renderer(mac);
  assert.equal(ui.elements.get('appleSilicon-field').hidden, false);
  assert.equal(ui.elements.get('arch-field').hidden, true);
  assert.equal(ui.elements.get('appleSilicon').checked, false);
  assert.equal(ui.elements.get('appleSilicon').disabled, false);
  ui.elements.get('appleSilicon').checked = true;
  ui.elements.get('appleSilicon').dispatch('change');
  await new Promise(setImmediate);
  assert.equal(ui.calls.at(-1)[1].arch, 'arm64');

  const intel = state();
  intel.platform = port.platformInfo('darwin', 'x64');
  intel.config.settings = port.normalizeSettings({}, 'darwin', 'x64');
  const intelUi = await renderer(intel);
  assert.equal(intelUi.elements.get('appleSilicon-field').hidden, false);
  assert.equal(intelUi.elements.get('appleSilicon').disabled, true);

  const windows = state();
  windows.platform = port.platformInfo('win32');
  windows.config.settings = port.normalizeSettings({}, 'win32');
  const windowsUi = await renderer(windows);
  assert.equal(windowsUi.elements.get('appleSilicon-field').hidden, true);
  assert.equal(windowsUi.elements.get('arch-field').hidden, false);
});

test('a Mac playing through Rosetta switches to the Apple Silicon build, and the dialog saying so can keep Rosetta', async () => {
  const data = state();
  data.platform = port.platformInfo('darwin', 'arm64');
  data.config.settings = port.normalizeSettings({ arch: '64' }, 'darwin', 'arm64');
  data.switchAppleSilicon = true;
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const ui = await renderer(data);
  await settle();
  assert.equal(ui.calls.find(call => call[0] === 'saveSettings')[1].arch, 'arm64');
  assert.deepEqual(ui.calls.find(call => call[0] === 'appleSiliconSwitched'), ['appleSiliconSwitched', false]);
  assert.equal(ui.elements.get('apple-silicon-switched').open, true);
  assert.equal(ui.elements.get('apple-silicon-switched-game').textContent, 'Your game');
  await ui.click('apple-silicon-keep-rosetta');
  assert.equal(ui.elements.get('apple-silicon-switched').open, false);
  assert.deepEqual(ui.calls.filter(call => call[0] === 'appleSiliconSwitched').at(-1), ['appleSiliconSwitched', true]);
  assert.equal(ui.calls.filter(call => call[0] === 'saveSettings').at(-1)[1].arch, '64');
  assert.equal(ui.elements.get('message-text').textContent, 'Your game keeps playing through Rosetta.');

  // Super Mario Eclipse switches the same way, and the dialog names it.
  const eclipse = { ...data, switchAppleSilicon: true, config: { ...data.config, settings: port.normalizeSettings({ arch: '64', eclipse: true }, 'darwin', 'arm64') },
    features: { vulkan: true, appleSilicon: true, eclipseAppleSilicon: true } };
  const eclipseUi = await renderer(eclipse);
  await settle();
  const saved = eclipseUi.calls.find(call => call[0] === 'saveSettings')[1];
  assert.equal(saved.arch, 'arm64');
  assert.equal(saved.eclipse, true);
  assert.equal(eclipseUi.elements.get('apple-silicon-switched-game').textContent, 'Super Mario Eclipse');

  // Never while a task runs, since saving settings would be refused.
  const busy = await renderer({ ...data, switchAppleSilicon: true, active: { label: 'Build game' } });
  await settle();
  assert.equal(busy.calls.some(call => call[0] === 'saveSettings'), false);
  assert.equal(busy.elements.get('apple-silicon-switched').open, false);
});

test('the Renderer list is saved with the others, and hidden where only OpenGL is offered', async () => {
  const data = state();
  data.platform = port.platformInfo('linux');
  data.config.settings = port.normalizeSettings({}, 'linux');
  const ui = await renderer(data);
  assert.equal(ui.elements.get('renderer-field').hidden, false);
  assert.equal(ui.elements.get('renderer').value, 'opengl');
  ui.elements.get('renderer').value = 'vulkan';
  ui.elements.get('renderer').dispatch('change');
  await new Promise(setImmediate);
  assert.equal(ui.calls.at(-1)[1].renderer, 'vulkan');

  const windows = state();
  windows.platform = port.platformInfo('win32');
  windows.config.settings = port.normalizeSettings({}, 'win32');
  const windowsUi = await renderer(windows);
  assert.equal(windowsUi.elements.get('renderer-field').hidden, false);
  assert.match(windowsUi.elements.get('renderer-note').textContent, /builds the game again/);
});

test('the Apple Silicon switch and the Renderer list wait for a game version that has them', async () => {
  const data = state();
  data.platform = port.platformInfo('darwin', 'arm64');
  data.config.settings = port.normalizeSettings({ arch: '64' }, 'darwin', 'arm64');
  data.features = { vulkan: false, appleSilicon: false };
  const ui = await renderer(data);
  assert.equal(ui.elements.get('appleSilicon').disabled, true);
  assert.equal(ui.elements.get('appleSilicon-note').textContent, 'Update the game to use this.');
  assert.equal(ui.elements.get('renderer').disabled, true);
  assert.equal(ui.elements.get('renderer-note').textContent, 'Update the game to use this.');

  // already on: it can still be turned off
  const on = state();
  on.platform = port.platformInfo('darwin', 'arm64');
  on.config.settings = port.normalizeSettings({ arch: 'arm64', renderer: 'vulkan' }, 'darwin', 'arm64');
  on.features = { vulkan: false, appleSilicon: false };
  const onUi = await renderer(on);
  assert.equal(onUi.elements.get('appleSilicon').disabled, false);
  assert.equal(onUi.elements.get('renderer').disabled, false);
});

// The game's list as the main process sends it (main.js: achievementsState).
function achievementList(fields = {}) {
  return { supported: true, achievements: [{ id: 1, title: 'Paint Job', description: 'Get the first Shine.', stage: 'Delfino Airstrip', unlockedAt: null }],
    unlocked: 0, total: 1, iconsNeeded: false, seen: true, ...fields };
}
const pageShown = (ui, name) => !ui.elements.get(name).hidden;

test('the Achievements tab glows until it is first opened, and opens straight away when it has everything', async () => {
  const ui = await renderer(state(), null, undefined, {}, { list: achievementList({ seen: false }) });
  const tab = ui.elements.get('nav-achievements');
  assert.equal(tab.hidden, false);
  assert.equal(tab.classList.contains('spotlight'), true);
  assert.equal(ui.elements.get('achievements-new').hidden, false);
  await ui.click('nav-achievements');
  assert.deepEqual(ui.calls, ['markAchievementsSeen']);
  assert.equal(tab.classList.contains('spotlight'), false);
  assert.equal(ui.elements.get('achievements-new').hidden, true);
  assert.equal(pageShown(ui, 'page-achievements'), true);
  assert.equal(ui.elements.get('achievements-get').open, false);
});

test('without its icons the Achievements tab offers just those, then shows the page', async () => {
  const achievements = { list: achievementList({ iconsNeeded: true }), update(name) { if (name === 'downloadAchievementIcons') this.list.iconsNeeded = false; } };
  const ui = await renderer(state(), null, undefined, {}, achievements);
  assert.equal(ui.elements.get('nav-achievements').hidden, false);
  assert.equal(ui.elements.get('nav-achievements').classList.contains('spotlight'), false);
  await ui.click('nav-achievements');
  assert.equal(pageShown(ui, 'page-achievements'), false);
  assert.equal(ui.elements.get('achievements-get').open, true);
  await ui.click('achievements-get-go');
  assert.deepEqual(ui.calls, ['downloadAchievementIcons']);
  assert.equal(ui.elements.get('achievements-get').open, false);
  assert.equal(pageShown(ui, 'page-achievements'), true);
  assert.equal(ui.elements.get('nav-achievements').classList.contains('active'), true);
});

test('the popup shows the download and its retries, and the page waits for it', async () => {
  const achievements = { list: achievementList({ iconsNeeded: true }), hold: true, update(name) { if (name === 'downloadAchievementIcons') this.list.iconsNeeded = false; } };
  const ui = await renderer(state(), null, undefined, {}, achievements);
  await ui.click('nav-achievements');
  await ui.click('achievements-get-go');
  assert.equal(ui.elements.get('achievements-get-go').disabled, true);
  assert.equal(ui.elements.get('achievements-get-go').textContent, 'Downloading…');
  assert.equal(ui.elements.get('achievements-get-cancel').textContent, 'Hide');
  assert.equal(ui.elements.get('achievements-get-progress').hidden, false);
  achievements.activity({ label: 'Install achievement icons', detail: 'Download failed, trying again in 2 s (try 2 of 3)…', percent: null });
  assert.match(ui.elements.get('achievements-get-detail').textContent, /try 2 of 3/);
  assert.equal(ui.elements.get('achievements-get-progress').classList.contains('indeterminate'), true);
  achievements.activity({ label: 'Install achievement icons', detail: 'Downloading', percent: 40 });
  assert.equal(ui.elements.get('achievements-get-bar').style.width, '40%');
  assert.equal(pageShown(ui, 'page-achievements'), false);
  achievements.release();
  await new Promise(setImmediate);
  assert.equal(ui.elements.get('achievements-get').open, false);
  assert.equal(pageShown(ui, 'page-achievements'), true);
});

test('a failed icon download says why in the popup, keeps the page closed, and Try again downloads again', async () => {
  const achievements = { list: achievementList({ iconsNeeded: true }), error: "The icons didn't download: Install achievement icons failed with code 1 (tried 3 times). Check your internet connection and try again; the activity log has the details",
    update(name) { if (name === 'downloadAchievementIcons') this.list.iconsNeeded = false; } };
  const ui = await renderer(state(), null, undefined, {}, achievements);
  await ui.click('nav-achievements');
  await ui.click('achievements-get-go');
  assert.equal(ui.elements.get('achievements-get').open, true);
  assert.equal(ui.elements.get('achievements-get-error').hidden, false);
  assert.match(ui.elements.get('achievements-get-error').textContent, /failed with code 1 \(tried 3 times\)\. Check your internet connection/);
  assert.equal(ui.elements.get('achievements-get-go').textContent, 'Try again');
  assert.equal(ui.elements.get('achievements-get-go').disabled, false);
  assert.equal(pageShown(ui, 'page-achievements'), false);
  achievements.error = null;
  await ui.click('achievements-get-go');
  assert.deepEqual(ui.calls.filter(call => call === 'downloadAchievementIcons').length, 2);
  assert.equal(ui.elements.get('achievements-get-error').hidden, true);
  assert.equal(pageShown(ui, 'page-achievements'), true);
});

test('a game from before achievements still shows them after the icons download, with a note to update the game', async () => {
  const achievements = { list: achievementList({ counted: false, iconsNeeded: true, seen: false }),
    update(name) { if (name === 'downloadAchievementIcons') this.list.iconsNeeded = false; } };
  const ui = await renderer(state(), null, undefined, {}, achievements);
  assert.equal(ui.elements.get('nav-achievements').classList.contains('spotlight'), true);
  await ui.click('nav-achievements');
  assert.equal(ui.elements.get('achievements-get').open, true);
  await ui.click('achievements-get-go');
  assert.deepEqual(ui.calls, ['markAchievementsSeen', 'downloadAchievementIcons']);
  assert.equal(pageShown(ui, 'page-achievements'), true);
  assert.equal(ui.elements.get('achievements-update').hidden, false);
  assert.match(ui.elements.get('achievements-update-text').textContent, /came out before achievements: update the game on Play/);
  await ui.click('achievements-update-go');
  assert.equal(pageShown(ui, 'page-home'), true);
});

test('the update note is only for a game that can\'t unlock achievements, and says to set up the game before there is one', async () => {
  const current = await renderer(state(), null, undefined, {}, { list: achievementList({ counted: true }) });
  await current.click('nav-achievements');
  assert.equal(current.elements.get('achievements-update').hidden, true);
  const fresh = await renderer({ ...state(), repoReady: false }, null, undefined, {}, { list: achievementList({ counted: false }) });
  await fresh.click('nav-achievements');
  assert.equal(fresh.elements.get('achievements-update').hidden, false);
  assert.equal(fresh.elements.get('achievements-update-text').textContent, 'Set up the game on Play to start unlocking these.');
});

test('setup says where the build tools download, which is not the install location', async () => {
  const folder = 'C:\\Users\\Player\\AppData\\Roaming\\sms-launcher\\build-tools';
  // Windows, as in the report: the note must not depend on the computer running the test (a Mac without Apple's tools says that instead)
  const fresh = { ...state(), platform: port.platformInfo('win32'), repoReady: false, binaryReady: false, tools: { ready: false }, toolsFolder: folder,
    config: { ...state().config, completedSetup: false } };
  const ui = await renderer(fresh);
  assert.equal(ui.elements.get('tool-location-note').textContent,
    `Build tools (a few GB) download to ${folder}, not to the install location.`);
  const portable = await renderer({ ...fresh, portable: true });
  assert.match(portable.elements.get('tool-location-note').textContent, /SMS-Launcher-Portable folder/);
});

test('Manage game offers Remove build tools on Windows once the game is built, and nowhere else', async () => {
  const windows = { ...state(), platform: port.platformInfo('win32') };
  const ui = await renderer(windows);
  assert.equal(ui.elements.get('build-tools-row').hidden, false);
  assert.match(ui.elements.get('build-tools-note').textContent, /plays without them/);
  await ui.click('remove-build-tools');
  assert.ok(ui.calls.includes('removeBuildTools'));
  for (const patch of [{ tools: { ready: false, mode: 'missing' } }, { binaryReady: false }, { active: { label: 'Build Sunshine port' } }]) {
    const busy = await renderer({ ...windows, ...patch });
    assert.equal(busy.elements.get('remove-build-tools').disabled, true);
  }
  const removed = await renderer({ ...windows, tools: { ready: false, mode: 'missing' } });
  assert.match(removed.elements.get('build-tools-note').textContent, /^Not downloaded/);
  const own = await renderer({ ...windows, tools: { ready: true, mode: 'own' } });
  assert.equal(own.elements.get('build-tools-row').hidden, true);
  for (const id of ['linux', 'darwin']) {
    const other = await renderer({ ...state(), platform: port.platformInfo(id) });
    assert.equal(other.elements.get('build-tools-row').hidden, true);
  }
});

test('Play shows Drawing with OpenGL while Vulkan is picked but missing from the build or unable to start', async () => {
  const data = state();
  data.config.settings = { ...data.config.settings, renderer: 'vulkan' };
  data.renderer = { vulkanMissing: true, vulkanFailed: null };
  const ui = await renderer(data);
  assert.equal(ui.elements.get('play-renderer').hidden, false);
  assert.equal(ui.elements.get('play-renderer-detail').textContent, 'Vulkan isn\'t in this build');
  assert.match(ui.elements.get('renderer-note').textContent, /no Vulkan: its downloads failed.*Rebuild game/);
  assert.equal(ui.elements.get('renderer-note').classList.contains('renderer-warning'), true);
  ui.run('current.renderer = { vulkanMissing: false, vulkanFailed: "no Vulkan 1.1 device" }');
  await ui.refresh();
  assert.equal(ui.elements.get('play-renderer-detail').textContent, 'Vulkan couldn\'t start');
  assert.match(ui.elements.get('renderer-note').textContent, /\(no Vulkan 1\.1 device\).*graphics driver/);
  ui.run('current.renderer = { vulkanMissing: false, vulkanFailed: null }');
  await ui.refresh();
  assert.equal(ui.elements.get('play-renderer').hidden, true);
  assert.equal(ui.elements.get('renderer-note').classList.contains('renderer-warning'), false);
  assert.match(ui.elements.get('renderer-note').textContent, /Vulkan is often faster/);
});

test('a dot on Settings and its Mods tab shows a changed mod list until the Mods tab is opened', async () => {
  const ui = await renderer(state(), null, undefined, {}, null, { unseen: true });
  const dots = () => [ui.elements.get('mods-new').hidden, ui.elements.get('settings-mods-new').hidden];
  assert.deepEqual(dots(), [false, false]);
  assert.equal(ui.elements.get('settings-cog')['aria-label'], 'Settings, new mods');
  await ui.click('settings-cog');
  await ui.click('tab-gameplay');
  assert.deepEqual(dots(), [false, false], 'opening Settings on another tab keeps it');
  assert.equal(ui.modsSeen.length, 0);
  await ui.click('tab-mods');
  assert.deepEqual(dots(), [true, true]);
  assert.ok(ui.modsSeen.length >= 1);
  assert.equal(ui.elements.get('settings-cog')['aria-label'], 'Settings');
  const seen = ui.modsSeen.length;
  ui.listeners.modsNews({ unseen: true });
  await new Promise(setImmediate);
  assert.deepEqual(dots(), [true, true], 'a list that changes while the tab is open is seen at once');
  assert.equal(ui.modsSeen.length, seen + 1);
  await ui.click('tab-launcher');
  ui.listeners.modsNews({ unseen: true });
  assert.deepEqual(dots(), [false, false]);
});

test('no dot when the mod list is the one last seen', async () => {
  const ui = await renderer();
  assert.equal(ui.elements.get('mods-new').hidden, true);
  assert.equal(ui.elements.get('settings-mods-new').hidden, true);
});
