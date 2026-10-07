'use strict';

const $ = id => document.getElementById(id);
let current;
let changing = false;
let wizardStep = null;
let setupPending = false;
const activityLog = window.smsActivityLog.createActivityLog();
let logRenderPending = false;
let consoleOpen = false, consoleExpanded = false, consoleFollowing = true;
let consoleWasActive = false, consoleFailed = false;

function closeModal() {
  for (const dialog of document.querySelectorAll('.launcher-modal'))
    if (dialog.open) dialog.close();
}

// --- Pages: the tabs along the top pick one; Play is the home page. Each page can run code as it
// shows and hides (Customize Mario's module registers through window.smsOnPage).
const pages = {
  play: { section: 'page-home', nav: 'nav-play' }, multiplayer: { section: 'multiplayer', nav: 'open-multiplayer' },
  mario: { section: 'mario-look', nav: 'customize-mario' }, saves: { section: 'page-saves', nav: 'nav-saves' },
  changelog: { section: 'changelog', nav: 'open-changelog' }, settings: { section: 'page-settings', nav: 'settings-cog' }
};
const pageOrder = Object.keys(pages);
let page = 'play';
const pageHooks = {};
function onPage(name, hooks) { pageHooks[name] = { ...pageHooks[name], ...hooks }; }
window.smsOnPage = onPage;
function showPage(name) {
  if (!pages[name]) return;
  const previous = page;
  if (name !== previous) {
    page = name;
    pageHooks[previous]?.hide?.();
  }
  for (const [key, item] of Object.entries(pages)) {
    $(item.section).hidden = key !== name;
    $(item.nav).classList.toggle('active', key === name);
    if (key === name) $(item.nav).setAttribute('aria-current', 'page');
    else $(item.nav).removeAttribute('aria-current');
  }
  if (name !== previous) pageHooks[name]?.show?.();
  // An expanded log covers the page: picking one shrinks it back to the drawer.
  if (consoleExpanded) { consoleExpanded = false; setConsoleOpen(true); }
}
for (const [name, item] of Object.entries(pages)) $(item.nav).addEventListener('click', () => showPage(name));

// Settings is one page with a tab per section; it reopens on the last one shown.
const settingsTabs = ['gameplay', 'display', 'graphics', 'controls', 'manage', 'launcher'];
let settingsTab = 'gameplay';
function showSettingsTab(name) {
  if (settingsTab === 'controls' && name !== 'controls') stopCapture();
  settingsTab = name;
  for (const tab of settingsTabs) {
    $(`pane-${tab}`).hidden = tab !== name;
    $(`tab-${tab}`).setAttribute('aria-selected', String(tab === name));
    $(`tab-${tab}`).classList.toggle('active', tab === name);
  }
  $('settings-panes').scrollTop = 0;
  if (name === 'controls') { renderBindings(); loadGcAdapter(); }
  if (name === 'launcher') loadUpdateChannels();
}
for (const tab of settingsTabs) $(`tab-${tab}`).addEventListener('click', () => showSettingsTab(tab));
onPage('settings', {
  show() {
    showSettingsTab(settingsTab);
    $(`tab-${settingsTab}`).focus();
    loadDisplayInfo();
  },
  hide: () => stopCapture()
});
onPage('saves', { show: () => loadSaveStates() });

// --- Controls: key and controller bindings (src/bindings.js). keyBindings and padBindings hold only the
// controls the player changed.
let keyBindings = {};
let padBindings = {};
let bindingMode = 'keyboard';  // which kind the Controls page shows: 'keyboard' or 'controller'
let capture = null;  // { id, add } while waiting for a key or a controller button
let padPoll = 0;

function renderSoftTrigger() { $('softTrigger-value').textContent = `${$('softTrigger').value}%`; }
$('softTrigger').addEventListener('input', renderSoftTrigger);
$('softTrigger').addEventListener('change', () => saveSettings());

// Rumble strength: the controller rumbles as the slider moves, as the game would (src/rumble.js).
const rumblePreview = window.smsRumble.createPreview({ getGamepads: () => navigator.getGamepads?.() });
let rumbleTimer = 0;
function renderRumbleStrength() {
  const value = Number($('rumbleStrength').value);
  $('rumbleStrength-value').textContent = value ? `${value}%` : 'Off';
}
$('rumbleStrength').addEventListener('input', () => {
  renderRumbleStrength();
  // Plays once the slider rests for a moment, so dragging it doesn't stack previews.
  clearTimeout(rumbleTimer);
  // The slider's 50% is the game's 100% (src/port.js, rumbleGameStrength).
  rumbleTimer = setTimeout(() => rumblePreview.play(Number($('rumbleStrength').value) * 2), 120);
});
$('rumbleStrength').addEventListener('change', () => saveSettings());

function bindingNote() {
  return bindingMode === 'controller'
    ? 'Choose Change, then press a button on your controller, or hold two together. Esc cancels. The sticks always move the sticks.'
    : 'Choose Change, then press a key or click a mouse button. Esc cancels.';
}

function stopCapture() {
  if (!capture) return;
  capture = null;
  window.removeEventListener('keydown', captureKey, true);
  window.removeEventListener('mousedown', captureMouse, true);
  cancelAnimationFrame(padPoll);
  $('binding-note').textContent = bindingNote();
  renderBindings();
}

// The buttons held right now on every connected controller (standard mapping), as "pad:index".
function heldPadButtons() {
  const held = new Set();
  for (const pad of (navigator.getGamepads ? navigator.getGamepads() : []))
    if (pad) pad.buttons.forEach((button, index) => { if (button.pressed || button.value > 0.6) held.add(`${pad.index}:${index}`); });
  return held;
}

// Waits for newly pressed controller buttons (ones already held when capture began do not count): two held
// together make a two-button binding (LB + LT), and one let go on its own is a binding by itself.
function watchPad(baseline, chord = []) {
  if (!capture) return;
  const held = heldPadButtons();
  for (const entry of held) {
    if (baseline.has(entry) || chord.some(item => item.entry === entry)) continue;
    const pad = SmsBindings.padFromIndex(Number(entry.split(':')[1]));
    if (pad) chord.push({ entry, pad });
  }
  const done = chord.length >= 2 || (chord.length === 1 && !held.has(chord[0].entry));
  if (done) {
    const pad = chord.length >= 2 ? SmsBindings.padCombo(chord[0].pad, chord[1].pad) : chord[0].pad;
    const { id, add } = capture;
    const pads = add ? [...SmsBindings.padsFor(padBindings, id).filter(item => item !== pad), pad] : [pad];
    padBindings = SmsBindings.normalizePads({ ...padBindings, [id]: pads });
    stopCapture();
    saveSettings();
    return;
  }
  if (chord.length && capture) $('binding-note').textContent = `${SmsBindings.padLabel(chord[0].pad)}: let go, or press another button with it.`;
  for (const entry of [...baseline]) if (!held.has(entry)) baseline.delete(entry);  // released: may count when pressed again
  padPoll = requestAnimationFrame(() => watchPad(baseline, chord));
}

function captureKey(event) {
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat) return;
  if (event.code === 'Escape' && !event.shiftKey) { stopCapture(); return; }
  if (bindingMode === 'controller') return;  // waiting for a controller button
  const key = SmsBindings.keyFromCode(event.code);
  if (!key) { $('binding-note').textContent = 'The game cannot read that key. Try another, or Esc to cancel.'; return; }
  bindKey(key);
}

// The click that sets a mouse button binding does nothing else: not the button under the pointer, nor a menu.
function swallowClick(event) { event.preventDefault(); event.stopPropagation(); }
function swallowNextClicks() {
  const types = ['mouseup', 'click', 'auxclick', 'contextmenu'];
  for (const type of types) window.addEventListener(type, swallowClick, true);
  setTimeout(() => { for (const type of types) window.removeEventListener(type, swallowClick, true); }, 600);
}

function bindKey(key) {
  const { id, add } = capture;
  const keys = add ? [...SmsBindings.keysFor(keyBindings, id).filter(item => item !== key), key] : [key];
  keyBindings = SmsBindings.normalize({ ...keyBindings, [id]: keys });
  stopCapture();
  saveSettings();
}

// A mouse button binds as a key does (the game reads MOUSE_LEFT ... as keys).
function captureMouse(event) {
  const key = SmsBindings.keyFromMouse(event.button);
  if (!key) return;
  event.preventDefault();
  event.stopPropagation();
  swallowNextClicks();
  bindKey(key);
}

function startCapture(id, add) {
  stopCapture();
  capture = { id, add };
  window.addEventListener('keydown', captureKey, true);
  if (bindingMode === 'keyboard') window.addEventListener('mousedown', captureMouse, true);
  if (bindingMode === 'controller') {
    if (![...(navigator.getGamepads ? navigator.getGamepads() : [])].some(Boolean))
      $('binding-note').textContent = 'No controller found yet. Connect one and press any button on it, or press Esc to cancel.';
    watchPad(heldPadButtons());
  }
  renderBindings();
}

// --- Button prompts (src/prompts.js): the icons the game shows for the GameCube buttons in its text, drawn from
// the bindings above. The strips go to the launcher's prompts folder whenever what they show changes.
// The Language list, from the launcher's catalog (main.js state): each
// language in its own name, English first.
function renderLanguages(languages) {
  if (!languages?.length) return;
  $('language').replaceChildren(...languages.map(item => {
    const option = document.createElement('option');
    option.value = item.code;
    option.textContent = item.name;
    if (item.code !== 'en') option.lang = item.code;
    return option;
  }));
}

function promptOptions(styles) {
  return styles.map(({ id, label }) => {
    const option = document.createElement('option'); option.value = id; option.textContent = label; return option;
  });
}
if (globalThis.SmsPrompts) {
  $('buttonPrompts').replaceChildren(...promptOptions(SmsPrompts.STYLES));
  $('promptPad').replaceChildren(...promptOptions(SmsPrompts.PAD_STYLES));
}
let sentPrompts = '';
function renderPrompts() {
  if (!globalThis.SmsPrompts) return;
  const style = $('buttonPrompts').value;
  const options = { mouseCamera: $('mouseCamera').checked };
  const strips = Object.fromEntries(SmsPrompts.DRAWN.map(id => [id, SmsPrompts.drawStrip(document, id, keyBindings, padBindings, options)]));
  const pad = $('promptPad').value;
  $('promptPad-field').hidden = style !== 'auto';
  // Automatic shows the keyboard and every controller style it can switch to.
  const label = id => SmsPrompts.STYLES.find(item => item.id === id).label;
  const padRows = pad === 'match' ? ['xbox', 'playstation', 'steamdeck'] : [pad];
  const shown = style === 'auto'
    ? [['keyboard', 'Keyboard and mouse'], ...padRows.map(id => [id, pad === 'match' ? `${label(id)} controller` : 'Any controller'])]
    : [[style, label(style)]];
  $('prompt-preview').replaceChildren(...shown.map(([id, text]) => {
    const row = document.createElement('div'); row.className = 'prompt-row';
    const name = document.createElement('span'); name.textContent = text;
    if (strips[id]) {
      // the GameCube buttons only; the strip's last icons are the pause menu's save state hint
      const preview = SmsPrompts.drawStrip(document, id, keyBindings, padBindings, options, SmsPrompts.BUTTON_GLYPHS);
      const image = document.createElement('img'); image.src = preview.toDataURL('image/png'); image.alt = '';
      row.append(name, image);
    } else {
      const note = document.createElement('em'); note.textContent = 'The game\'s own GameCube buttons';
      row.append(name, note);
    }
    return row;
  }));
  // Saved with Original prompts too: the pause menu's save state hint draws its buttons from them.
  const images = Object.fromEntries(Object.entries(strips).map(([id, canvas]) => [id, canvas.toDataURL('image/png')]));
  const signature = JSON.stringify(images);
  if (signature === sentPrompts) return;
  sentPrompts = signature;
  window.sms.savePrompts(images).catch(error => { sentPrompts = ''; showError(error); });
}

function renderBindings() {
  if (!globalThis.SmsBindings || $('pane-controls').hidden) return;
  const controller = bindingMode === 'controller';
  for (const button of document.querySelectorAll('[data-binding-mode]'))
    button.setAttribute('aria-pressed', String(button.dataset.bindingMode === bindingMode));
  const changed = controller ? padBindings : keyBindings;
  $('binding-list').replaceChildren(...SmsBindings.CONTROLS.map(({ id, label }) => {
    const row = document.createElement('div');
    row.className = `binding-row${changed[id] ? ' changed' : ''}${capture?.id === id ? ' capturing' : ''}`;
    const name = document.createElement('span'); name.textContent = label;
    const keys = document.createElement('span'); keys.className = 'binding-keys';
    const what = controller ? 'button' : 'key';
    const items = controller ? SmsBindings.padsFor(padBindings, id).map(SmsBindings.padLabel)
      : SmsBindings.keysFor(keyBindings, id).map(SmsBindings.keyLabel);
    const press = controller ? 'a button' : 'a key or mouse button';
    if (capture?.id === id) keys.textContent = capture.add ? `Press ${press} to add…` : controller ? 'Press a button, or two together…' : `Press ${press}…`;
    else if (!items.length) { keys.textContent = 'None'; keys.classList.add('binding-none'); }
    else keys.replaceChildren(...items.map(text => {
      const item = document.createElement('kbd'); item.textContent = text; return item;
    }));
    const actions = document.createElement('span'); actions.className = 'binding-actions';
    const button = (text, onClick, title) => {
      const item = document.createElement('button'); item.className = 'subtle'; item.textContent = text; item.title = title;
      item.disabled = Boolean(current?.active); item.addEventListener('click', onClick); return item;
    };
    actions.append(button('Change', () => startCapture(id, false), `Use one ${what} instead`),
      button('Add', () => startCapture(id, true), `Add another ${what}`));
    if (changed[id]) actions.append(button('Reset', () => {
      if (controller) { const { [id]: _removed, ...rest } = padBindings; padBindings = rest; }
      else { const { [id]: _removed, ...rest } = keyBindings; keyBindings = rest; }
      renderBindings(); saveSettings();
    }, `Back to the default ${what}s`));
    row.append(name, keys, actions);
    return row;
  }));
}

// GameCube adapter in Wii U mode (src/gc-adapter.js): shown while one is
// plugged in. The game reads it directly, so the controller bindings above and
// the launcher's own menus don't see it. On Linux the game needs a udev rule to
// open it; Allow access installs one.
function renderGcAdapter(status, message = '') {
  $('gc-adapter-note').hidden = !status?.present;
  if (!status?.present) return;
  const ready = 'The game reads it directly: plug the controller into any port (the first plugged port is player 1). It plays as on a GameCube, so the controller buttons set here and the launcher\'s menus don\'t apply to it.';
  $('gc-adapter-text').textContent = status.readable ? `Plugged in and ready. ${ready}`
    : status.fix === 'udev' ? 'Plugged in, but Linux doesn\'t let the game open it yet. Allow access adds a udev rule for it (as Dolphin needs), which asks for your password.'
    : status.fix === 'driver' ? 'Plugged in, but Windows has no working driver for it. Unplug it and plug it in again; if that doesn\'t help, choose USB Input Device for WUP-028 in Device Manager.'
    : 'Plugged in, but the game needs libusb to read it on a Mac. Install it with Homebrew: brew install libusb.';
  $('gc-adapter-actions').hidden = status.readable;
  $('gc-adapter-allow').hidden = status.fix !== 'udev';
  $('gc-adapter-copy').hidden = status.fix !== 'udev';
  $('gc-adapter-helper').textContent = message;
}
async function loadGcAdapter(message) {
  try { renderGcAdapter(await window.sms.gcAdapterStatus(), message); }
  catch (error) { renderGcAdapter({ present: true, readable: false }, error.message || String(error)); }
}
$('gc-adapter-check').addEventListener('click', () => loadGcAdapter());
$('gc-adapter-allow').addEventListener('click', async () => {
  $('gc-adapter-allow').disabled = true;
  try {
    const result = await window.sms.allowGcAdapter();
    renderGcAdapter(result.status, result.ok
      ? (result.status.readable ? 'Access allowed.' : 'The rule is installed. Unplug the adapter and plug it in again, then choose Check again.')
      : `Not changed: ${result.reason}. Copy the terminal command and run it in a terminal instead.`);
  } catch (error) { $('gc-adapter-helper').textContent = error.message || String(error); }
  finally { $('gc-adapter-allow').disabled = false; }
});
$('gc-adapter-copy').addEventListener('click', async () => {
  await window.sms.copyGcAdapterCommand();
  $('gc-adapter-helper').textContent = 'Copied. Paste it into a terminal (Konsole on a Steam Deck), then unplug the adapter, plug it in again and choose Check again.';
});

$('reset-bindings').addEventListener('click', () => {
  stopCapture();
  if (bindingMode === 'controller') padBindings = {}; else keyBindings = {};
  renderBindings(); saveSettings();
});
for (const button of document.querySelectorAll('[data-binding-mode]'))
  button.addEventListener('click', () => {
    stopCapture();
    bindingMode = button.dataset.bindingMode;
    $('binding-note').textContent = bindingNote();
    renderBindings();
  });
for (const button of document.querySelectorAll('[data-close-modal]'))
  button.addEventListener('click', () => button.closest('dialog').close());

function showActivityLog() {
  closeModal();
  setConsoleOpen(true);
  const log = $('log');
  log.scrollTop = log.scrollHeight;
  log.focus();
}
// The activity log is a drawer under the page, opened from the status bar on any page. It pushes the
// page up rather than covering it; expanded, it takes the page's whole height.
function setConsoleOpen(open) {
  consoleOpen = open;
  if (!open) consoleExpanded = false;
  $('activity-log').hidden = !open;
  $('activity-log').classList.toggle('is-expanded', consoleExpanded);
  $('shell').classList.toggle('log-expanded', open && consoleExpanded);
  $('toggle-activity-log').classList.toggle('is-open', open);
  $('toggle-activity-log').setAttribute('aria-expanded', String(open));
  $('toggle-activity-log').title = open ? 'Hide activity log' : 'Show activity log';
  $('expand-activity-log').setAttribute('aria-pressed', String(consoleExpanded));
  $('expand-activity-log').setAttribute('aria-label', consoleExpanded ? 'Restore activity log' : 'Expand activity log');
  $('expand-activity-log').title = consoleExpanded ? 'Restore activity log' : 'Expand activity log';
  if (open && consoleFollowing) $('log').scrollTop = $('log').scrollHeight;
}
function setConsoleFollowing(follow) {
  consoleFollowing = follow;
  $('follow-activity-log').setAttribute('aria-pressed', String(follow));
  $('follow-activity-log').textContent = follow ? 'Following output' : 'Follow output';
  if (follow) $('log').scrollTop = $('log').scrollHeight;
}
$('toggle-activity-log').addEventListener('click', () => setConsoleOpen(!consoleOpen));
$('close-activity-log').addEventListener('click', () => setConsoleOpen(false));
$('expand-activity-log').addEventListener('click', () => {
  consoleExpanded = !consoleExpanded;
  setConsoleOpen(true);
});
$('follow-activity-log').addEventListener('click', () => setConsoleFollowing(!consoleFollowing));
$('log').addEventListener('scroll', () => {
  if (consoleOpen && consoleFollowing && $('log').scrollHeight - $('log').scrollTop - $('log').clientHeight > 24)
    setConsoleFollowing(false);
});
for (const id of ['view-build-log', 'view-activity-log', 'message-view-log'])
  $(id).addEventListener('click', showActivityLog);
$('message-close').addEventListener('click', () => setMessage(''));
$('save-activity-log').addEventListener('click', () => window.sms.saveActivityLog().catch(showError));
$('copy-activity-log').addEventListener('click', async () => {
  const button = $('copy-activity-log'), result = $('copy-log-result');
  button.disabled = true;
  button.textContent = 'Copy log';
  result.textContent = '';
  try {
    await window.sms.copyActivityLog();
    result.textContent = 'Full session copied.';
    button.textContent = 'Copied';
  } catch (error) {
    setConsoleOpen(true);
    result.textContent = `Could not copy log: ${errorText(error)}`;
  } finally {
    button.disabled = false;
  }
});

function setMessage(text, error = false) {
  const box = $('message');
  $('message-text').textContent = text || '';
  $('message-view-log').hidden = !error || !text;
  box.hidden = !text;
  box.classList.toggle('error', error);
  if (text && error) {
    consoleFailed = true;
    renderConsoleState(current?.active);
    setConsoleOpen(true);
  }
}

function badge(id, label, good = false, warn = false) {
  const element = $(id);
  element.textContent = label;
  element.className = `badge${good ? ' good' : warn ? ' warn' : ''}`;
}

function taskName(label) {
  if (!label) return 'Nothing running';
  if (label === 'Play Super Mario Sunshine') return 'Game running';
  if (label.startsWith('Build ')) return 'Setting up your game';
  if (label.startsWith('Download port')) return 'Downloading setup files';
  if (label.startsWith('Download build') || label.startsWith('Prepare build') ||
      label.startsWith('Unpack build') || label.startsWith('Update private')) return 'Preparing build tools';
  if (label === 'Install HD cutscenes') return 'Preparing HD cutscenes';
  if (label.startsWith('Install UHD')) return 'Downloading HD textures';
  if (label === 'Install HD texture extras') return 'Updating HD textures';
  if (label === 'Install language pack') return 'Installing language';
  if (label.startsWith('Install Eclipse')) return 'Setting up Eclipse';
  if (label.startsWith('Check for port')) return 'Checking for updates';
  if (label.startsWith('Update port') || label.startsWith('Update decompilation')) return 'Updating setup files';
  if (label === 'Preview cleanup') return 'Checking removable files';
  if (label === 'Clean build output') return 'Freeing up space';
  return label;
}

function backupReason(reason) {
  return ({ manual: 'Manual backup', 'before-play': 'Before playing', 'after-play': 'After playing',
    'before-restore': 'Before restoring', 'before-cleanup': 'Before cleanup',
    'before-dolphin-import': 'Before Dolphin import',
    'before-port-update': 'Before update', 'before-tools-change': 'Before changing build tools' })[reason] || 'Backup';
}

function needsTextureDownload(data) {
  return data.repoReady && !data.hdVisualsReady;
}

function wantsCutscenes(data) {
  const { cutscenes, textures, eclipse } = data.config.settings;
  return cutscenes && textures && !eclipse && (!data.repoReady || data.cutscenesSupported);
}

function requiredStep(data) {
  if (data.repoReady && data.romReady && (data.config.completedSetup || data.binaryReady)) return 0;
  if (!data.repoReady || !data.tools.ready) return 1;
  if (!data.romReady) return 2;
  if (!data.binaryReady || needsTextureDownload(data)) return 3;
  return 0;
}

function sizeText(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

// People choose a folder to keep a drive free, so say exactly what goes where.
function toolLocationNote(data) {
  const { data: folder, tools, dataInFolder, toolsDownloaded, toolDownloadBytes } = data.locations;
  const download = toolsDownloaded ? ' (already downloaded)' : toolDownloadBytes ? ` (${sizeText(toolDownloadBytes)} download)` : '';
  if (data.repoReady) return `Build tools${download} go in ${tools}.`;
  if (!dataInFolder) return `Game files go in this folder. Build tools${download}, saves and backups go in ${folder}.`;
  return `The game, its build tools${download}, your saves and their backups all go in this folder.`;
}

function showWizardStep(data) {
  const required = requiredStep(data);
  if (required === 0) wizardStep = 0;
  else if (wizardStep === null || wizardStep === 0 || wizardStep > required) wizardStep = required;
  const ready = wizardStep === 0;
  const downloadTextures = ready && data.binaryReady && needsTextureDownload(data);
  $('page-home').classList.toggle('ready-mode', ready);
  $('setup-flow').hidden = ready;
  // Eclipse is chosen in Settings only: say so wherever it is installed or played.
  const eclipse = data.config.settings.eclipse;
  $('shell').classList.toggle('eclipse', Boolean(eclipse));
  $('eclipse-disclaimer').hidden = !eclipse;
  $('home-title').textContent = ready ? eclipse ? 'Super Mario Eclipse' : 'Super Mario Sunshine' : 'Set up your game';
  $('home-description').textContent = ready
    ? downloadTextures ? 'Set up HD visuals to finish setup.'
      : data.game.needsUpdate ? `Game update${data.game.availableVersion ? ` ${data.game.availableVersion}` : ''} is ready. Your saves carry over.` : 'Ready when you are.'
    : "Three steps, then you're ready to play.";
  const hd = [data.config.settings.textures && !data.texturesInstalled ? 'download HD textures' : '',
    wantsCutscenes(data) && !data.cutscenesInstalled ? 'prepare HD cutscenes using your disc image' : ''].filter(Boolean).join(' and ');
  $('setup-install-description').textContent = (hd
    ? `We'll ${hd}, then get the game ready to play. This can take a while.`
    : "We'll prepare a playable copy using your disc image. This can take a while.") +
    (eclipse ? ' Super Mario Eclipse (experimental) is on in Settings, so this sets up Eclipse instead of Super Mario Sunshine.' : '');
  $('setup-download-title').textContent = data.repoReady ? 'Download build tools' : 'Download setup files';
  $('setup-download-description').textContent = data.repoReady
    ? 'The setup files are ready. Download the tools needed to prepare your game.'
    : "We'll get the files and tools needed to prepare your own disc. The game is not included.";
  const needsMacTools = data.platform.id === 'macos' && !data.tools.appleReady;
  $('mac-setup-help').hidden = !needsMacTools;
  $('mac-tools-settings').hidden = data.platform.id !== 'macos';
  $('tool-location-note').textContent = needsMacTools
    ? 'This Mac needs Apple’s tools first. Open Mac setup help to get started.' : toolLocationNote(data);
  if (needsMacTools) {
    $('setup-download-title').textContent = 'Prepare this Mac';
    $('setup-download-description').textContent = 'Check the tools needed before downloading and preparing your game.';
  }
  $('repo-location').hidden = data.repoReady;
  // The portable launcher keeps everything in its own folder, so there is no location to choose.
  $('choose-location').hidden = data.repoReady || data.portable;
  $('choose-repo-settings').hidden = data.portable;
  for (let step = 1; step <= 3; step++)
    $(`setup-step-${step}`).hidden = ready || step !== wizardStep;
  if (ready) $('play').textContent = downloadTextures
    ? setupPending || data.active?.label === 'Install UHD textures' || data.active?.label === 'Install HD cutscenes' ? 'Setting up…' : 'Finish HD setup'
    : data.game.needsUpdate && data.config.settings.autoUpdate
      ? '↻  Update & play' : !data.binaryReady ? '▶  Prepare & play' : '▶  Play';
  else {
    $('step-count').textContent = `Step ${wizardStep} of 3`;
    document.querySelectorAll('.setup-progress-track i').forEach((segment, index) => {
      segment.classList.toggle('complete', index + 1 < wizardStep);
      segment.classList.toggle('current', index + 1 === wizardStep);
    });
    $('play').textContent = setupPending
      ? wizardStep === 1 ? 'Downloading…' : wizardStep === 2 ? 'Choosing…' : 'Setting up…'
      : wizardStep === 1 ? needsMacTools ? 'Set up Mac tools' : data.repoReady && data.tools.ready ? 'Continue'
        : data.repoReady ? 'Download build tools' : 'Download setup files'
        : wizardStep === 2 ? data.romReady ? 'Continue' : 'Choose disc image' : 'Begin setup';
  }
}

// A waiting update always offers the same three ways to play: Update & play, Update only and Play now.
// Update automatically picks which the big button does; ▾ beside it opens a menu with all of them,
// the big button's marked Default. Pending HD setup offers Play now beside Finish HD setup the same way.
let playMenuOpen = false;
function renderPlayMenu(data) {
  const update = data.game.needsUpdate, hd = needsTextureDownload(data), auto = data.config.settings.autoUpdate;
  const next = data.game.availableVersion ? ` ${data.game.availableVersion}` : '';
  const offered = data.binaryReady && data.romReady && wizardStep === 0 && (update || hd);
  $('play-more').hidden = !offered;
  $('play').classList.toggle('has-more', offered);
  $('play-more').disabled = Boolean(data.active) || setupPending;
  if (playMenuOpen && (!offered || $('play-more').disabled)) $('play-menu').hidePopover();
  const [kind, label, detail] = hd
    ? ['hd', 'Finish HD setup', update && auto ? `Update to${next} and set up HD, then start` : 'Set up HD visuals, then start']
    : auto ? ['update', 'Update & play', `Install${next}, then start`] : ['play', 'Play', 'Start without updating'];
  $('menu-default').dataset.kind = kind;
  $('menu-default-label').textContent = label;
  $('menu-default-detail').textContent = detail;
  $('menu-update-play').hidden = !update || auto;
  $('menu-update-play-detail').textContent = `Install${next}, then start`;
  $('menu-update-only').hidden = !update;
  $('menu-update-only-detail').textContent = `Install${next}, play later`;
  $('menu-play-now').hidden = !(update && auto) && !hd;
  const later = [update ? 'update' : '', hd ? 'HD visuals' : ''].filter(Boolean).join(' and ');
  $('menu-play-now-detail').textContent = `${later.charAt(0).toUpperCase()}${later.slice(1)} later`;
  $('play-menu-note').hidden = !update;
  const others = Object.entries({ 'menu-update-play': 'Update & play', 'menu-update-only': 'Update only', 'menu-play-now': 'Play now' })
    .filter(([id]) => !$(id).hidden).map(([, name]) => name);
  $('play-more-hint').hidden = !offered || Boolean(data.active);
  $('play-more-hint').textContent = `▾ for ${others.join(' or ')}`;
}

// A task shows its progress under Play and in the status bar; the activity log opens by itself only
// when something fails (setMessage, appendLog).
function renderActivity(active) {
  if (active && !consoleWasActive) consoleFailed = false;
  consoleWasActive = Boolean(active);
  renderConsoleState(active);
  renderRoom(active?.room);
  const working = Boolean(active) && active.label !== 'Play Super Mario Sunshine';
  $('task-progress').hidden = !working;
  $('status-progress').hidden = !working || !Number.isFinite(active.percent);
  if (!$('status-progress').hidden) $('status-progress-fill').style.width = `${active.percent}%`;
  $('activity-label').textContent = taskName(active?.label);
  $('stop').hidden = !active?.canStop;
  $('stop').textContent = active?.label === 'Play Super Mario Sunshine' ? 'Stop game'
    : active?.label.startsWith('Build ') ? 'Stop build' : 'Stop task';
  $('view-build-log').textContent = active?.label.startsWith('Build ') ? 'View build log' : 'View activity';
  $('task-status').textContent = active?.room ? `Hosting room ${active.room}` : active ? taskName(active.label)
    : current?.binaryReady && needsTextureDownload(current) ? 'HD setup needed'
    : current?.game.needsUpdate && current.config.completedSetup ? 'Update ready'
    : $('page-home').classList.contains('ready-mode') ? 'Ready to play' : 'Finish setup to play';
  if (!working) return;
  $('progress-title').textContent = taskName(active.label);
  $('progress-detail').textContent = active.detail || 'Working…';
  const seconds = Math.max(0, Math.floor((Date.now() - active.startedAt) / 1000));
  $('progress-time').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const known = Number.isFinite(active.percent);
  $('progress-percent').textContent = known ? `${active.percent}%` : '';
  $('progress-track').classList.toggle('indeterminate', !known);
  $('progress-fill').style.width = known ? `${active.percent}%` : '';
  if (known) $('progress-track').setAttribute('aria-valuenow', String(active.percent));
  else $('progress-track').removeAttribute('aria-valuenow');
}

function renderConsoleState(active) {
  const badge = $('console-state');
  badge.textContent = consoleFailed ? 'Error' : active ? 'Live' : 'Idle';
  for (const element of [badge, $('toggle-activity-log')]) {
    element.classList.toggle('is-live', Boolean(active) && !consoleFailed);
    element.classList.toggle('is-error', consoleFailed);
  }
}

// The room this launcher hosts: under Play and at the top of Multiplayer.
function renderRoom(room) {
  for (const id of ['play-room', 'mp-room']) $(id).hidden = !room;
  $('play-room-code').textContent = room || '';
  $('mp-room-code').textContent = room || '';
}
for (const id of ['play-room-copy', 'mp-room-copy']) $(id).addEventListener('click', async () => {
  const button = $(id), room = current?.active?.room;
  if (!room) return;
  try { await window.sms.copyText(room); button.textContent = 'Copied'; }
  catch (error) { showError(error); return; }
  setTimeout(() => { button.textContent = 'Copy'; }, 1500);
});

// Customize Mario needs a disc to read Mario from. It only uses WebGL while
// open, and says so there if the computer can't draw him.
function showCustomizeMario() {
  $('customize-mario').hidden = !current?.romReady;
  if ($('customize-mario').hidden && page === 'mario') showPage('play');
}

function refresh(data) {
  if (Number.isFinite(data.logResetSequence)) resetLog(data.logResetSequence);
  current = data;
  const { config, platform } = data;
  $('platform').textContent = platform.name;
  $('repo-path').textContent = data.locations.folder;
  $('repo-path').title = data.locations.folder;
  $('settings-repo-path').textContent = config.repo;
  $('settings-repo-path').title = config.repo;
  $('settings-data-path').textContent = `${data.locations.data}\nGame, build tools, saves and backups`;
  $('settings-data-path').title = data.locations.data;
  $('choose-location').disabled = Boolean(data.active);
  $('update-port').disabled = !data.repoReady || Boolean(data.active);
  $('rom-path').textContent = data.romError || config.rom || 'No file selected';
  $('rom-path').title = data.romError || config.rom;
  $('rom-path').classList.toggle('rom-error', Boolean(data.romError));
  $('settings-rom-path').textContent = data.romError || config.rom || 'No disc file selected';
  $('settings-rom-path').title = data.romError || config.rom;
  showCustomizeMario();
  $('choose-rom').hidden = !data.romReady;
  showWizardStep(data);
  renderMacTools(data.tools);
  $('play').disabled = Boolean(data.active) || setupPending;
  renderPlayMenu(data);
  for (const button of document.querySelectorAll('[data-setup-back]')) button.disabled = Boolean(data.active) || setupPending;
  $('build').hidden = !data.binaryReady || !data.romReady;
  $('rebuild-note').hidden = $('build').hidden;
  $('build').disabled = Boolean(data.active);
  const gb = bytes => (Math.ceil(bytes / 1e8) / 10).toFixed(1);
  const finish = data.binaryReady ? 'Close Settings and choose Finish HD setup.' : '';
  badge('textures-badge', data.texturesInstalled ? 'Installed' : 'Not installed', data.texturesInstalled,
    config.settings.textures && !data.texturesInstalled);
  $('texture-info').textContent = data.texturesInstalled
    ? config.settings.textures ? 'HD textures are ready.' : 'Already downloaded. Turn on to use them.'
    : `${config.settings.textures ? `${finish || 'HD textures will download during setup.'} ` : ''}About 1 GB to download; allow 3 GB of free space for setup.`;
  // The movie pack's size comes from the game's own list of movies.
  const movies = data.cutsceneRequirements;
  $('cutscenes-description').textContent =
    `Sharper Sunshine movies, made from your own disc. About ${movies ? gb(movies.downloadBytes) : '5.4'} GB to download.`;
  badge('cutscenes-badge', config.settings.eclipse ? 'Sunshine only' : !config.settings.textures ? 'Needs HD textures'
    : data.cutscenesInstalled ? 'Installed' : 'Not installed',
    data.cutscenesInstalled && !config.settings.eclipse, wantsCutscenes(data) && !data.cutscenesInstalled);
  $('cutscene-info').textContent = config.settings.eclipse ? 'Eclipse plays its own movies.'
    : config.settings.cutscenes && !config.settings.textures ? 'Turn on HD textures to play HD cutscenes.'
    : data.cutscenesInstalled ? config.settings.cutscenes ? 'HD cutscenes are ready for Sunshine.' : 'Already set up. Turn on to use them.'
      : !config.settings.cutscenes ? ''
        : data.repoReady && !data.cutscenesSupported ? 'Update the game to add HD cutscenes.'
          : `${finish || 'HD cutscenes will be made from your disc during setup.'}${movies ? ` Allow ${gb(movies.freeBytes)} GB of free space for setup.` : ''}`;
  $('cutscene-info').hidden = !$('cutscene-info').textContent;
  badge('eclipse-badge', data.eclipseInstalled ? 'Installed' : platform.id === 'linux' ? 'Optional' : 'Experimental', data.eclipseInstalled, platform.id !== 'linux');
  $('eclipse-platform-note').textContent = platform.id === 'linux' ? '' : 'Eclipse is still experimental on this computer.';
  $('install-eclipse').textContent = data.eclipseInstalled ? 'Reinstall Eclipse' : 'Install Eclipse';
  $('eclipse-note').hidden = !config.settings.eclipse;
  $('install-eclipse').disabled = !data.repoReady || !data.romReady || Boolean(data.active);
  $('clean').disabled = !data.repoReady || Boolean(data.active);
  $('clean-preview').disabled = !data.repoReady || Boolean(data.active);
  $('choose-rom').disabled = Boolean(data.active);
  $('choose-rom-settings').disabled = Boolean(data.active);
  $('choose-repo-settings').disabled = Boolean(data.active);
  renderActivity(data.active);
  renderAppUpdate(data.appUpdate);
  renderOnline(data.online);
  renderPublicOnline(data.publicOnline);
  const installedVersion = data.binaryReady ? data.game.installedVersion : null;
  const gameVersion = installedVersion || (data.binaryReady ? 'Version unavailable' : 'Not installed');
  $('version-summary').textContent = `Launcher v${data.game.launcherVersion} · Game ${installedVersion || (data.binaryReady ? 'version unavailable' : 'not installed')}`;
  $('launcher-version').textContent = `v${data.game.launcherVersion}`;
  $('installed-game-version').textContent = gameVersion;
  $('available-game-version-row').hidden = installedVersion === data.game.availableVersion;
  $('available-game-version').textContent = data.game.availableVersion;
  $('tool-version').textContent = data.game.toolVersion;
  $('tool-version-note').textContent = [data.tools.mode === 'own' ? 'Your MSYS2' : data.tools.ready || data.tools.privateInstalled ? 'Downloaded' : 'Not downloaded',
    data.game.installedToolVersion && data.game.installedToolVersion !== data.game.toolVersion
      ? `Game built with ${data.game.installedToolVersion}` : ''].filter(Boolean).join(' · ');
  $('game-update-note').textContent = !data.binaryReady
    ? `Game ${data.game.availableVersion} will be installed during setup.` : data.game.needsUpdate
    ? `Game ${data.game.availableVersion} is ready to set up. Your current version stays available until setup succeeds.`
    : 'Your game is up to date.';
  $('play-installed').hidden = !data.binaryReady || (!data.game.needsUpdate && !needsTextureDownload(data));
  $('play-installed').disabled = Boolean(data.active) || !data.romReady || setupPending;
  $('play-previous').hidden = !data.game.previousReady;
  $('play-previous').disabled = Boolean(data.active);
  $('save-path').textContent = `Saved games: ${data.saveDirectory}\nBackups: ${data.backupDirectory}`;
  $('backup-saves').disabled = Boolean(data.active);
  $('import-dolphin-save').disabled = Boolean(data.active);
  $('dolphin-save-drop').setAttribute('aria-disabled', String(Boolean(data.active)));
  $('restore-saves').disabled = Boolean(data.active) || !data.backups.length;
  const selectedBackup = $('backup-list').value;
  $('backup-list').replaceChildren(...data.backups.map(backup => {
    const option = document.createElement('option');
    option.value = backup.id;
    option.textContent = `${new Date(backup.createdAt).toLocaleString()} · ${backupReason(backup.reason)} · ${backup.count} files`;
    return option;
  }));
  if (data.backups.some(backup => backup.id === selectedBackup)) $('backup-list').value = selectedBackup;
  $('backup-list').disabled = Boolean(data.active) || !data.backups.length;

  changing = true;
  $('arch').replaceChildren(...platform.arches.map(arch => {
    const option = document.createElement('option'); option.value = arch;
    option.textContent = arch === '64' && platform.arches.length > 1 ? '64-bit (recommended)' : `${arch}-bit`;
    return option;
  }));
  // macOS: the Apple Silicon switch picks the build (arm64, or 64 under Rosetta) in place of the list.
  const mac = platform.id === 'macos', nativeMac = platform.arches.includes('arm64');
  $('arch-field').hidden = mac;
  $('appleSilicon-field').hidden = !mac;
  // Each is offered once the game version on disk has it (Beta and a chosen game source can build an older one).
  const features = data.features || {};
  const gameNote = data.repoReady ? 'Update the game to use this.' : 'Available once the game is set up.';
  $('appleSilicon').checked = config.settings.arch === 'arm64';
  // Older game versions build Super Mario Eclipse for Rosetta only.
  const rosettaEclipse = config.settings.eclipse && !features.eclipseAppleSilicon && config.settings.arch !== 'arm64';
  $('appleSilicon-note').textContent = !nativeMac ? 'Needs a Mac with Apple Silicon.'
    : !features.appleSilicon && config.settings.arch !== 'arm64' ? gameNote
    : rosettaEclipse ? 'Update the game to play Super Mario Eclipse on Apple Silicon.'
    : 'Builds the game for Apple Silicon instead of running it through Rosetta, which is faster. Changing this builds the game again.';
  $('renderer-field').hidden = !(platform.renderers || []).includes('vulkan');
  $('renderer-note').textContent = features.vulkan || config.settings.renderer === 'vulkan'
    ? 'Vulkan is often faster. If it can\'t start on this computer, the game uses OpenGL.'
      + (platform.id === 'windows' ? ' Choosing it builds the game again the first time.' : '')
    : gameNote;
  renderExclusiveResolutions(config.settings.exclusiveResolution);
  renderLanguages(data.languages);
  for (const key of ['arch', 'widescreen', 'resolution', 'volume', 'frameRate', 'language', 'vsync', 'fullscreenMode', 'exclusiveResolution',
    'display', 'cameraSpeed', 'mouseSensitivity', 'msaa', 'anisotropic', 'sharpen', 'brightness', 'aspect', 'presentFilter', 'fsrMode',
    'textureLoading', 'renderer'])
    $(key).value = String(config.settings[key]);
  renderVolume();
  renderRanges();
  for (const key of ['fullscreen', 'invertCameraX', 'invertCameraY', 'freeCamera', 'cstickAim', 'mouseCamera', 'skipMovies', 'skipIntro', 'pauseTracker', 'heatHaze', 'overlay', 'fxaa', 'hudEdges', 'textures', 'shaderWarmup', 'cutscenes', 'eclipse', 'autoUpdate', 'shareUsage', 'discordPresence', 'darkMode']) $(key).checked = config.settings[key];
  renderTheme();
  keyBindings = config.settings.keyBindings || {};
  padBindings = config.settings.padBindings || {};
  $('buttonPrompts').value = config.settings.buttonPrompts || 'gamecube';
  $('promptPad').value = config.settings.promptPad || 'match';
  renderPrompts();
  $('graphicsPreset').value = config.settings.graphicsPreset || 'custom';
  renderPreset();
  $('hdr-panel').hidden = data.platform.id !== 'windows';
  for (const key of ['hdr', 'hdrCalibration']) $(key).checked = config.settings[key];
  for (const key of ['hdrPaperWhite', 'hdrPeak', 'hdrContrast', 'hdrSaturation', 'hdrHighlights']) $(key).value = String(config.settings[key]);
  $('softTrigger').value = String(config.settings.softTrigger ?? 40);
  renderSoftTrigger();
  $('softTrigger').disabled = Boolean(data.active);
  $('rumbleStrength').value = String(config.settings.rumbleStrength ?? 50);
  renderRumbleStrength();
  $('rumbleStrength').disabled = Boolean(data.active);
  // Steam Input can sit between the controller and the game on SteamOS / Steam Deck (Linux).
  $('steamos-note').hidden = data.platform.id !== 'linux';
  if (!capture) renderBindings();
  $('reset-bindings').disabled = Boolean(data.active);
  renderUpdateChannels(config.settings.updateChannel);
  // Portable launchers update by downloading a new .exe, so channels do not apply.
  $('update-channel-field').hidden = data.portable;
  $('update-channel-note').hidden = data.portable;
  renderGameSource(data);
  for (const key of ['arch', 'widescreen', 'resolution', 'volume', 'frameRate', 'language', 'vsync', 'skipMovies', 'skipIntro', 'pauseTracker', 'heatHaze', 'overlay', 'fullscreen', 'fullscreenMode', 'exclusiveResolution', 'display', 'invertCameraX', 'invertCameraY', 'freeCamera', 'cstickAim', 'cameraSpeed', 'mouseCamera', 'mouseSensitivity', 'msaa', 'fxaa', 'anisotropic', 'sharpen', 'brightness', 'aspect', 'presentFilter', 'hudEdges', 'textures', 'textureLoading', 'shaderWarmup', 'cutscenes', 'eclipse', 'autoUpdate', 'shareUsage', 'discordPresence', 'darkMode', 'updateChannel', 'buttonPrompts', 'promptPad', 'graphicsPreset', 'fsrMode', 'renderer', 'appleSilicon'])
    $(key).disabled = Boolean(data.active);
  // Turning one off stays possible once on, whatever the game version.
  if (!platform.arches.includes('arm64') || rosettaEclipse || !features.appleSilicon && config.settings.arch !== 'arm64')
    $('appleSilicon').disabled = true;
  if (!features.vulkan && config.settings.renderer !== 'vulkan') $('renderer').disabled = true;
  // Languages need a game version with language packs. Eclipse has none and plays in English;
  // the chosen language stays for Super Mario Sunshine.
  $('language').disabled = Boolean(data.active) || config.settings.eclipse;
  const chosen = (data.languages || []).find(item => item.code === config.settings.language);
  $('language-note').textContent = config.settings.eclipse ? 'Super Mario Eclipse plays in English. Your language applies when Eclipse is off.'
    : data.repoReady && !data.languagesSupported ? 'Update the game to add languages.'
      : chosen && !chosen.available ? `Update the game to play in ${chosen.name}. It plays in English until then.`
        : config.settings.language !== 'en' && !data.languageInstalled ? 'The language pack downloads before the game starts.'
          : chosen?.community ? `${chosen.name} is a community translation; some menus and pictures stay in English.` : '';
  $('language-note').hidden = !$('language-note').textContent;
  renderDependents(Boolean(data.active));
  renderHdr(Boolean(data.active));
  changing = false;
  switchAppleSilicon();
}

let updateChannels = [{ id: 'stable', label: 'Stable' }];
function renderUpdateChannels(chosen) {
  const list = updateChannels.some(item => item.id === chosen) ? updateChannels
    : updateChannels.concat({ id: chosen, label: chosen, missing: true });
  $('updateChannel').replaceChildren(...list.map(item => {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.missing ? `${item.label} (no longer available)` : item.label;
    if (item.detail) option.title = item.detail;
    return option;
  }));
  $('updateChannel').value = chosen;
}
async function loadUpdateChannels() {
  try { updateChannels = await window.sms.updateChannels(); }
  catch (_) { return; }
  if (current) { changing = true; renderUpdateChannels(current.config.settings.updateChannel); changing = false; }
}

const sourceFields = { port: ['source-port-repository', 'source-port-ref'], decomp: ['source-decomp-repository', 'source-decomp-ref'] };
let sourceShown = false;
function renderGameSource(data) {
  const chosen = data.gameSource;
  // Fill the fields from the saved choice once, so typing is never overwritten.
  if (!sourceShown) {
    sourceShown = true;
    for (const [part, [repository, ref]] of Object.entries(sourceFields)) {
      $(repository).value = chosen?.override[part]?.repository || '';
      $(ref).value = chosen?.override[part]?.ref || '';
    }
    $('game-source').open = Boolean(chosen);
  }
  $('game-source-note').textContent = chosen
    ? `Building from ${chosen.version}. Update game to build it, or to follow a branch's newest commit.`
    : `Using this launcher's release (game ${data.game.availableVersion}).`;
  for (const id of ['apply-game-source', 'reset-game-source', ...Object.values(sourceFields).flat()])
    $(id).disabled = Boolean(data.active);
  $('reset-game-source').hidden = !chosen;
}
function gameSourceValue() {
  const value = {};
  for (const [part, [repository, ref]] of Object.entries(sourceFields))
    value[part] = { repository: $(repository).value, ref: $(ref).value };
  return value;
}
async function setGameSource(value) {
  setMessage('');
  try { refresh(await window.sms.setGameSource(value)); }
  catch (error) { showError(error); }
}
$('apply-game-source').addEventListener('click', () => setGameSource(gameSourceValue()));
$('reset-game-source').addEventListener('click', () => {
  for (const id of Object.values(sourceFields).flat()) $(id).value = '';
  setGameSource(null);
});

async function sync() { refresh(await window.sms.state()); }

function renderMacTools(tools) {
  const requirements = (tools.requirements || []).filter(item => !tools.managed || !item.package);
  if (tools.managed) requirements.push({ label: 'Launcher build tools', ready: tools.privateInstalled, automatic: true });
  $('mac-requirements').replaceChildren(...requirements.map(item => {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = item.label;
    const status = document.createElement('span');
    status.className = `badge${item.ready ? ' good' : item.optional ? '' : ' warn'}`;
    status.textContent = item.ready ? 'Ready' : item.automatic ? 'Download in Step 1' : item.optional ? 'Optional' : 'Needed';
    row.append(name, status);
    return row;
  }));
  const commands = (tools.commands || '').split('\n').filter(Boolean);
  $('mac-apple-command').replaceChildren();
  $('mac-extra-commands').replaceChildren();
  commands.forEach((command, index) => {
    const row = document.createElement('div');
    row.className = 'mac-command';
    const code = document.createElement('code');
    code.textContent = command;
    const copy = document.createElement('button');
    copy.className = 'subtle'; copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try { await window.sms.copyMacCommand(index); copy.textContent = 'Copied'; }
      catch (error) { showError(error); }
    });
    row.append(code, copy);
    (command.startsWith('xcode-select') ? $('mac-apple-command') : $('mac-extra-commands')).append(row);
  });
  $('mac-apple-note').hidden = !commands.some(command => command.startsWith('xcode-select'));
  $('mac-extra-note').hidden = !commands.some(command => !command.startsWith('xcode-select'));
  $('mac-check-result').textContent = tools.appleReady || tools.ready ? 'Ready. Close this help and continue setup.'
    : tools.checked ? 'Some tools still need to be installed.' : 'Checking tools…';
}

// A Windows folder too deep to build the game in: the part of its path over
// the limit is marked, so players see how much shorter it must be.
function showPathProblem() {
  const problem = current?.pathProblem;
  if (!problem) return false;
  const over = problem.length - problem.limit;
  $('path-folder-name').textContent = problem.portable ? 'The SMS-Launcher-Portable folder' : 'The folder holding the setup files';
  $('path-length').textContent = problem.length;
  $('path-limit').textContent = problem.limit;
  const mark = document.createElement('mark');
  mark.textContent = problem.folder.slice(problem.limit);
  $('path-folder').replaceChildren(problem.folder.slice(0, problem.limit), mark);
  $('path-over').textContent = `${over} character${over === 1 ? '' : 's'} too long`;
  $('path-steps').replaceChildren(...(problem.portable ? [
    'Close the launcher.',
    'Move the launcher and its SMS-Launcher-Portable folder together to a short folder, such as C:\\Games.',
    'Open the launcher from there. Your saves, settings and downloads come with it.'
  ] : ['Open Settings and choose a shorter folder for Setup files, such as C:\\Games.']).map(text => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  $('path-why').textContent = `Windows' compiler can't open files whose paths are 260 characters or more, and the build ` +
    `reaches ${problem.deepest} characters deeper than this folder.`;
  closeModal();
  $('path-too-long').showModal();
  return true;
}
$('path-show-folder').addEventListener('click', () => window.sms.showPathFolder().catch(showError));

function showMacHelp() {
  closeModal();
  $('mac-tools-help').showModal();
}

for (const id of ['mac-setup-help', 'mac-tools-settings']) $(id).addEventListener('click', showMacHelp);
$('check-mac-tools').addEventListener('click', async () => {
  $('check-mac-tools').disabled = true;
  $('mac-check-result').textContent = 'Checking tools…';
  try { refresh(await window.sms.checkTools()); }
  catch (error) { showError(error); }
  finally { $('check-mac-tools').disabled = false; }
});

// Electron prefixes errors thrown in the main process with the IPC channel:
// "Error invoking remote method 'import-dolphin-save': Error: <message>".
function errorText(error) {
  return String(error?.message || error).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
}
function showError(error) { closeModal(); setMessage(errorText(error), true); }

// Actions that build the game or need its build tools. Play only builds when
// the game isn't set up, needs HD visuals, or updates automatically.
function needsBuild(method) {
  if (method === 'launchGame') return !current.binaryReady || !current.hdVisualsReady ||
    Boolean(current.config.settings.autoUpdate && current.game.needsUpdate);
  return ['installPort', 'installEclipse', 'installTextures', 'build', 'setupGame', 'updateAndPlay', 'updatePort',
    'clean', 'cleanPreview'].includes(method);
}

async function action(method) {
  setMessage('');
  // In a folder too deep for Windows, explain instead of starting a build that would fail.
  if (current?.pathProblem && needsBuild(method)) { showPathProblem(); return; }
  try {
    if (['installPort', 'installEclipse', 'installTextures', 'build', 'setupGame', 'launchGame', 'updateAndPlay', 'updatePort', 'play', 'playPrevious', 'clean', 'cleanPreview'].includes(method)) { closeModal(); showPage('play'); }
    const result = await window.sms[method]();
    if (result && result.config) refresh(result);
    await sync();
    if (['installPort', 'chooseRepo'].includes(method) && current.repoReady && current.tools.ready && wizardStep === 1) wizardStep = 2;
    if (method === 'chooseRom' && current.romReady && wizardStep === 2) wizardStep = 3;
    refresh(current);
  } catch (error) {
    showError(error);
    await sync();
    if (errorText(error) === current.pathProblem?.message) showPathProblem();
  }
}

function runWizardAction(method) {
  setupPending = true;
  refresh(current);
  action(method).finally(() => { setupPending = false; if (current) refresh(current); });
}

// --- Graphics presets (src/presets.js). Choosing one sets its picture settings; the settings
// file keeps the choice only while they still match it (port.js), so a change by hand shows Custom.
if (globalThis.SmsPresets) $('graphicsPreset').replaceChildren(...SmsPresets.CHOICES.map(({ id, label }) => {
  const option = document.createElement('option'); option.value = id; option.textContent = label; return option;
}));
function renderPreset() {
  if (!globalThis.SmsPresets) return;
  $('graphicsPreset-detail').textContent = SmsPresets.CHOICES.find(choice => choice.id === $('graphicsPreset').value)?.detail || '';
}
$('graphicsPreset').addEventListener('change', () => {
  const preset = globalThis.SmsPresets && SmsPresets.find($('graphicsPreset').value);
  if (preset) for (const [key, value] of Object.entries(preset.values)) {
    if (typeof value === 'boolean') $(key).checked = value;
    else $(key).value = String(value);
  }
  renderRanges();
  renderDependents();
  renderPreset();
  saveSettings();
});

// --- HDR (Windows): the panel shows what the game reads from Windows (`--display-info`) for the display.
let displayReport = null;
function renderHdr(busy = Boolean(current?.active)) {
  const on = $('hdr').checked, calibrated = $('hdrCalibration').checked;
  const display = displayReport?.displays?.find(item => item.hdr) || displayReport?.displays?.[0];
  for (const key of ['hdrContrast', 'hdrSaturation', 'hdrHighlights']) $(key).disabled = busy || !on;
  for (const key of ['hdrPaperWhite', 'hdrPeak']) $(key).disabled = busy || !on || calibrated;
  $('hdrCalibration').disabled = busy || !on;
  const nits = (key, fromWindows) => calibrated && fromWindows ? `Windows: ${Math.round(fromWindows)} nits` : `${$(key).value} nits`;
  $('hdrPaperWhite-value').textContent = nits('hdrPaperWhite', display?.sdrWhiteNits);
  $('hdrPeak-value').textContent = nits('hdrPeak', display?.peakNits);
  for (const key of ['hdrContrast', 'hdrSaturation', 'hdrHighlights']) $(`${key}-value`).textContent = `${$(key).value}%`;
  if (!displayReport) return;
  if (!display) { $('hdr-display').textContent = displayReport.error || 'No display found.'; return; }
  const parts = [`${display.monitor || display.device}: Windows HDR ${display.hdr ? 'on' : 'off'}`];
  if (display.peakNits) parts.push(`peak ${Math.round(display.peakNits)} nits`);
  if (display.sdrWhiteNits) parts.push(`SDR content brightness ${Math.round(display.sdrWhiteNits)} nits`);
  $('hdr-display').textContent = `${parts.join(', ')}. ${display.calibrationProfile
    ? `Calibration profile: ${display.calibrationProfile}.` : 'No HDR calibration profile yet: the calibration app makes one.'}`;
}
async function loadDisplayInfo() {
  if (displayReport || $('hdr-panel').hidden || !window.sms.displayInfo) return;
  displayReport = await window.sms.displayInfo().catch(error => ({ displays: [], error: errorText(error) }));
  renderHdr();
}
$('hdr-calibration-app').addEventListener('click', () => window.sms.openHdrCalibration().catch(error => setMessage(errorText(error))));
for (const key of ['hdrPaperWhite', 'hdrPeak', 'hdrContrast', 'hdrSaturation', 'hdrHighlights', 'hdr', 'hdrCalibration'])
  $(key).addEventListener('input', () => renderHdr());

function renderTheme() { $('shell').classList.toggle('dark', $('darkMode').checked); }
$('darkMode').addEventListener('input', renderTheme);

function renderVolume() { $('volume-value').textContent = `${$('volume').value}%`; }

function renderRanges() {
  for (const key of ['cameraSpeed', 'mouseSensitivity', 'brightness']) $(`${key}-value`).textContent = `${$(key).value}%`;
  $('sharpen-value').textContent = Number($('sharpen').value) ? `${$('sharpen').value}%` : 'Off';
}

// Exclusive fullscreen sizes up to this screen's own (the game picks the closest mode the display has).
function renderExclusiveResolutions(chosen) {
  // screen sizes ignore page zoom, but devicePixelRatio includes it.
  const display = globalThis.screen || { width: 1920, height: 1080 }, scale = (globalThis.devicePixelRatio || 1) / window.sms.zoomFactor();
  const nativeWidth = Math.round(display.width * scale), nativeHeight = Math.round(display.height * scale);
  const sizes = ['1280x720', '1600x900', '1920x1080', '2560x1080', '2560x1440', '3440x1440', '3840x2160']
    .filter(size => { const [w, h] = size.split('x').map(Number); return w <= nativeWidth && h <= nativeHeight; });
  if (chosen && chosen !== 'desktop' && !sizes.includes(chosen)) sizes.push(chosen);
  const option = (value, label) => { const item = document.createElement('option'); item.value = value; item.textContent = label; return item; };
  $('exclusiveResolution').replaceChildren(option('desktop', `Desktop resolution (${nativeWidth}×${nativeHeight})`),
    ...sizes.map(size => option(size, size.replace('x', '×'))));
}

// Choices that only matter with another one on are dimmed until then.
function renderDependents(busy = false) {
  $('fullscreenMode').disabled = busy || !$('fullscreen').checked;
  $('exclusiveResolution').disabled = busy || !$('fullscreen').checked || $('fullscreenMode').value !== 'exclusive';
  $('mouseSensitivity').disabled = busy || !$('mouseCamera').checked;
  // FSR 1's quality sets the internal resolution, in place of Picture sharpness
  const fsr = ['fsr', 'nis'].includes($('presentFilter').value);
  $('fsrMode-field').hidden = !fsr;
  $('fsr-hint').hidden = !fsr;
  $('resolution').disabled = busy || fsr;
  $('textureLoading').disabled = busy || !$('textures').checked;
  $('texture-loading-hint').textContent = {
    stage: 'Before each level: a level\'s HD textures load with it, so they don\'t pop in while you play.',
    all: 'Whole pack: every HD texture loads during the first few loading screens and stays, so after that none load at all. Needs a graphics card with 6 GB of memory or more.',
    play: 'While playing: each HD texture loads when it first appears, using the least memory. The original shows until it is ready.'
  }[$('textureLoading').value];
}

function settingsValue() {
  return {
    arch: current?.platform?.id === 'macos' ? ($('appleSilicon').checked ? 'arm64' : '64') : $('arch').value, widescreen: $('widescreen').value, resolution: Number($('resolution').value), volume: Number($('volume').value),
    frameRate: Number($('frameRate').value), language: $('language').value, fullscreen: $('fullscreen').checked, fullscreenMode: $('fullscreenMode').value,
    exclusiveResolution: $('exclusiveResolution').value, display: $('display').value, vsync: $('vsync').value,
    skipMovies: $('skipMovies').checked, skipIntro: $('skipIntro').checked, pauseTracker: $('pauseTracker').checked, heatHaze: $('heatHaze').checked, overlay: $('overlay').checked,
    freeCamera: $('freeCamera').checked, cstickAim: $('cstickAim').checked, cameraSpeed: Number($('cameraSpeed').value),
    mouseCamera: $('mouseCamera').checked, mouseSensitivity: Number($('mouseSensitivity').value),
    msaa: Number($('msaa').value), fxaa: $('fxaa').checked, anisotropic: Number($('anisotropic').value),
    sharpen: Number($('sharpen').value), brightness: Number($('brightness').value), aspect: $('aspect').value,
    presentFilter: $('presentFilter').value, fsrMode: $('fsrMode').value, renderer: $('renderer').value,
    invertCameraX: $('invertCameraX').checked, invertCameraY: $('invertCameraY').checked, hudEdges: $('hudEdges').checked, textures: $('textures').checked, cutscenes: $('cutscenes').checked,
    textureLoading: $('textureLoading').value, shaderWarmup: $('shaderWarmup').checked,
    eclipse: $('eclipse').checked, autoUpdate: $('autoUpdate').checked, shareUsage: $('shareUsage').checked, discordPresence: $('discordPresence').checked, darkMode: $('darkMode').checked, updateChannel: $('updateChannel').value,
    keyBindings, padBindings, softTrigger: Number($('softTrigger').value),
    rumbleStrength: Number($('rumbleStrength').value), buttonPrompts: $('buttonPrompts').value,
    promptPad: $('promptPad').value, graphicsPreset: $('graphicsPreset').value,
    hdr: $('hdr').checked, hdrCalibration: $('hdrCalibration').checked, hdrPaperWhite: Number($('hdrPaperWhite').value),
    hdrPeak: Number($('hdrPeak').value), hdrContrast: Number($('hdrContrast').value),
    hdrSaturation: Number($('hdrSaturation').value), hdrHighlights: Number($('hdrHighlights').value)
  };
}

async function saveSettings() {
  if (changing) return;
  try { refresh(await window.sms.saveSettings(settingsValue())); }
  // A refused change (a task started) must not stay shown as if it were saved.
  catch (error) { if (current) refresh(current); showError(error); }
}

function appendLog(entry) {
  if (entry.sequence <= activityLog.resetSequence()) return;
  activityLog.merge(entry);
  if (entry.stream === 'launcher' && /^(✕|Uncaught launcher error:)/.test(entry.text)) {
    consoleFailed = true;
    renderConsoleState(current?.active);
    setConsoleOpen(true);
  }
  scheduleLogRender();
}

function scheduleLogRender() {
  if (logRenderPending) return;
  logRenderPending = true;
  requestAnimationFrame(() => {
    logRenderPending = false;
    const log = $('log');
    const entries = activityLog.snapshot();
    log.replaceChildren(...entries.map(entry => {
      const line = document.createElement('span');
      line.className = `log-line log-${entry.stream}${entry.stream === 'launcher' && entry.text.startsWith('✕') ? ' log-error' : ''}`;
      line.textContent = window.smsActivityLog.formatEntry(entry) + '\n';
      return line;
    }));
    $('console-empty').hidden = Boolean(entries.length);
    $('console-entry-count').textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
    if (consoleFollowing) log.scrollTop = log.scrollHeight;
  });
}

function resetLog(sequence) {
  if (sequence <= activityLog.resetSequence()) return;
  activityLog.reset(sequence);
  $('log').textContent = '';
  $('copy-log-result').textContent = '';
  $('copy-activity-log').textContent = 'Copy log';
  consoleFailed = false;
  setConsoleFollowing(true);
  renderConsoleState(current?.active);
  scheduleLogRender();
}

for (const [id, method] of Object.entries({
  'choose-rom': 'chooseRom', 'choose-rom-settings': 'chooseRom',
  'choose-repo-settings': 'chooseRepo', 'choose-location': 'chooseLocation',
  'play-installed': 'play', 'play-previous': 'playPrevious', 'build': 'build', 'install-eclipse': 'installEclipse',
  'clean-preview': 'cleanPreview', clean: 'clean', 'backup-saves': 'backupSaves',
  'open-backups': 'openBackups', stop: 'stop', docs: 'openDocs'
})) $(id).addEventListener('click', () => action(method));
// Update only builds the new game and stays in the launcher.
async function updateOnly() {
  await action('updatePort');
  if (current.binaryReady && !current.game.needsUpdate && !current.active)
    setMessage(`Updated to game ${current.game.installedVersion || current.game.availableVersion}. Play whenever you're ready.`);
}
$('update-port').addEventListener('click', updateOnly);
// The menu sits in the top layer, above the panel that would clip it, and closes on a click outside or Escape.
$('play-menu').addEventListener('beforetoggle', event => {
  if (event.newState !== 'open') return;
  const anchor = $('play').getBoundingClientRect();
  $('play-menu').style.left = `${anchor.left}px`;
  $('play-menu').style.bottom = `${window.innerHeight - anchor.top + 10}px`;
});
$('play-menu').addEventListener('toggle', event => {
  playMenuOpen = event.newState === 'open';
  $('play-more').setAttribute('aria-expanded', String(playMenuOpen));
  if (playMenuOpen) playMenuItems()[0]?.focus();
});
const playMenuItems = () => [...$('play-menu').querySelectorAll('.play-menu-item')].filter(item => !item.hidden);
$('play-menu').addEventListener('keydown', event => {
  const items = playMenuItems(), step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  items[(items.indexOf(document.activeElement) + step + items.length) % items.length]?.focus();
});
function closePlayMenu() {
  if (!playMenuOpen) return false;
  $('play-menu').hidePopover();
  $('play-more').focus();
  return true;
}
for (const [id, run] of Object.entries({
  'menu-default': () => $('play').click(),
  'menu-update-play': () => runWizardAction('updateAndPlay'),
  'menu-update-only': updateOnly,
  'menu-play-now': () => action('play')
})) $(id).addEventListener('click', () => { $('play-menu').hidePopover(); run(); });
// The invite opens in the browser, even while the game builds or runs.
$('discord').addEventListener('click', () => window.sms.openDiscord().catch(error => setMessage(errorText(error))));

// --- Changelog: changelog.json in the launcher repository (src/changelog.js). Each release lists its
// launcher changes and the game it pins. After an update it opens once with the releases since the last.
// Beta builds also get Beta's hand-written notes, shown again whenever they change.
function changelogDate(date) {
  return date ? new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
}
function changelogSection(heading, items) {
  const section = document.createElement('section');
  const title = document.createElement('h3');
  title.textContent = heading;
  const list = document.createElement('ul');
  list.append(...items.map(text => { const item = document.createElement('li'); item.textContent = text; return item; }));
  section.append(title, list);
  return section;
}
function changelogRelease(release, data) {
  const article = document.createElement('article');
  article.className = 'changelog-release';
  const head = document.createElement('header');
  const title = document.createElement('h2');
  title.textContent = release.title ? `v${release.version} · ${release.title}` : `v${release.version}`;
  head.append(title);
  const tag = data.unseen.includes(release.version) ? ['New', 'badge good'] : release.version === data.current ? ['Installed', 'badge'] : null;
  if (tag) { const badge = document.createElement('span'); [badge.textContent, badge.className] = tag; head.append(badge); }
  const date = document.createElement('time');
  date.textContent = changelogDate(release.date);
  head.append(date);
  article.append(head);
  if (release.launcher.length) article.append(changelogSection('Launcher', release.launcher));
  if (release.game?.changes.length)
    article.append(changelogSection(release.game.version ? `Game ${release.game.version}` : 'Game', release.game.changes));
  return article;
}
function changelogBeta(beta) {
  const article = document.createElement('article');
  article.className = 'changelog-release changelog-beta';
  const head = document.createElement('header');
  const title = document.createElement('h2');
  title.textContent = 'Beta';
  const badge = document.createElement('span');
  [badge.textContent, badge.className] = beta.unseen ? ['New', 'badge good'] : ['Not released yet', 'badge warn'];
  head.append(title, badge);
  const note = document.createElement('p');
  note.className = 'changelog-note';
  note.textContent = 'In this Beta build, not in a release yet. Beta uses the newest game from its main branch.';
  article.append(head, note);
  if (beta.launcher.length) article.append(changelogSection('Launcher', beta.launcher));
  if (beta.game.length) article.append(changelogSection('Game', beta.game));
  return article;
}
let changelogShown = null;
function renderChangelog(data, onlyUnseen) {
  changelogShown = data;
  const releases = onlyUnseen ? data.releases.filter(release => data.unseen.includes(release.version)) : data.releases;
  const beta = data.beta && (!onlyUnseen || data.beta.unseen) ? data.beta : null;
  $('changelog-title').textContent = !onlyUnseen ? 'Changelog' : releases.length ? `Updated to v${data.current}` : "What's new in Beta";
  $('changelog-subtitle').textContent = !onlyUnseen ? 'Launcher and game updates'
    : releases.length ? `What's new in the launcher and game since you last opened it.` : "Changes in this Beta that aren't in a release yet.";
  $('changelog-show-all').hidden = !onlyUnseen || (releases.length === data.releases.length && beta === data.beta);
  const items = [...(beta ? [changelogBeta(beta)] : []), ...releases.map(release => changelogRelease(release, data))];
  if (items.length) $('changelog-list').replaceChildren(...items);
  else $('changelog-list').textContent = 'No changes are listed yet.';
}
// The What's new tab shows every release; after an update it shows only the new ones.
let changelogUnseen = false;
async function showChangelog() {
  if (changelogUnseen) { changelogUnseen = false; return; }
  $('changelog-title').textContent = 'Changelog';
  $('changelog-subtitle').textContent = 'Launcher and game updates';
  $('changelog-show-all').hidden = true;
  $('changelog-list').textContent = 'Loading…';
  try { renderChangelog(await window.sms.changelog(), false); }
  catch (_) { $('changelog-list').textContent = "The changelog couldn't be loaded. Try again later."; }
}
onPage('changelog', { show: showChangelog });
// Opens once per update. Away from Play, over another window or during a running task it waits for the next start.
async function showWhatsNew() {
  try {
    const data = await window.sms.changelog();
    if (data.unseen.length || data.beta?.unseen) {
      if (current?.active || page !== 'play' || [...document.querySelectorAll('.launcher-modal')].some(dialog => dialog.open)) return;
      renderChangelog(data, true);
      changelogUnseen = true;
      showPage('changelog');
    }
    await window.sms.markChangelogSeen();
  } catch (_) { /* the changelog button still works */ }
}
// --- Multiplayer (src/multiplayer.js): host a game, or join one by address and port. The fields are
// kept for next time; Join asks the host's game first, so a wrong address is reported here.
function multiplayerFields() {
  return { name: $('mp-name').value, hostPort: $('mp-host-port').value, maxPlayers: $('mp-max-players').value,
    address: $('mp-address').value,
    joinPort: $('mp-join-port').value, public: $('mp-list-public').checked };
}
function setMultiplayerResult(text, error = false) {
  $('mp-result').textContent = text;
  $('mp-result').classList.toggle('error', error);
}
// An invite code carries its own port (src/multiplayer.js: inviteCode).
const looksLikeInvite = text => /^[0-9a-z]{4}-?[0-9a-z]{4}-?[0-9a-z]{4}$/i.test(String(text).trim());
// So does a room code (src/rooms.js): the host's launcher has the port.
const looksLikeRoom = text => /^[0-9a-z]{3}[-\s]?[0-9a-z]{3}$/i.test(String(text).trim());
// The public games last loaded (below), shown again as the buttons' state changes.
let publicGames = null, publicTicket = 0, publicTimer = null;
// Pings (src/main.js: pingGame): the typed game's, and each public game's by room code, kept across the list's refreshes.
let pingingTyped = false;
const publicPings = new Map(); // code -> { pending } or { ping, mode } or { failed }
const pingHow = mode => ({ relay: ' through the relay', lan: ' over your local network', direct: ' direct' })[mode] || '';
const PUBLIC_REFRESH = 15000;
function renderMultiplayer() {
  const busy = Boolean(current?.active) || setupPending;
  $('mp-host').disabled = busy;
  $('mp-join').disabled = busy;
  $('mp-ping').disabled = busy || pingingTyped || !$('mp-address').value.trim();
  $('mp-host-port-note').textContent = /^\d{1,5}$/.test($('mp-host-port').value.trim()) ? $('mp-host-port').value.trim() : '24002';
  $('mp-join-port').disabled = looksLikeInvite($('mp-address').value) || looksLikeRoom($('mp-address').value);
  if (publicGames) renderPublicGames(publicGames);
}
// Public games (src/rooms.js: listPublic): games whose hosts listed them, refreshed while the window is open.
async function loadPublicGames() {
  const ticket = ++publicTicket;
  $('mp-browser-refresh').disabled = true;
  try {
    const games = await window.sms.publicGames();
    if (ticket !== publicTicket) return;
    publicGames = games;
    renderPublicGames(games);
  } catch (_) {
    if (ticket !== publicTicket) return;
    publicGames = null;
    $('mp-browser-list').replaceChildren();
    $('mp-browser-note').hidden = false;
    $('mp-browser-note').textContent = "Couldn't load public games. Check your internet connection.";
  } finally {
    if (ticket === publicTicket) $('mp-browser-refresh').disabled = false;
  }
}
function renderPublicGames(games) {
  const busy = Boolean(current?.active) || setupPending;
  const list = $('mp-browser-list');
  list.replaceChildren();
  $('mp-browser-note').hidden = games.length > 0;
  $('mp-browser-note').textContent = 'No public games right now. Host one with "List my game publicly" on, and it shows here.';
  for (const game of games) {
    const item = document.createElement('li');
    item.className = 'mp-game';
    const text = document.createElement('span');
    text.className = 'mp-game-text';
    const name = document.createElement('strong');
    name.textContent = `${game.name}'s game`;
    const detail = document.createElement('small');
    const where = game.status ? game.status[0].toUpperCase() + game.status.slice(1) : '';
    const pinged = publicPings.get(game.code);
    const ping = !pinged ? '' : pinged.pending ? 'Pinging…' : pinged.failed ? 'No answer to ping'
      : `Ping ${pinged.ping} ms${pingHow(pinged.mode)}`;
    detail.textContent = [where, `${game.players} of ${game.maxPlayers} players`, ping, game.problem].filter(Boolean).join(' · ');
    text.append(name, detail);
    const pingButton = document.createElement('button');
    pingButton.className = 'text-button mp-game-ping';
    pingButton.textContent = 'Ping';
    pingButton.disabled = busy || Boolean(pinged?.pending);
    pingButton.setAttribute('aria-label', `Ping ${game.name}'s game`);
    pingButton.addEventListener('click', () => pingPublicGame(game.code));
    const join = document.createElement('button');
    join.className = 'text-button mp-game-join';
    join.textContent = 'Join';
    join.disabled = busy || Boolean(game.problem);
    join.setAttribute('aria-label', `Join ${game.name}'s game`);
    join.addEventListener('click', () => {
      $('mp-address').value = game.code;
      renderMultiplayer();
      startMultiplayer('join');
    });
    item.classList.toggle('unavailable', Boolean(game.problem));
    const actions = document.createElement('span');
    actions.className = 'mp-game-actions';
    actions.append(pingButton, join);
    item.append(text, actions);
    list.append(item);
  }
}
async function pingPublicGame(code) {
  publicPings.set(code, { pending: true });
  renderMultiplayer();
  try {
    const result = await window.sms.pingGame({ address: code });
    publicPings.set(code, { ping: result.ping, mode: result.mode });
  } catch (_) {
    publicPings.set(code, { failed: true });
  }
  renderMultiplayer();
}
// The Ping beside Join: the typed room code, invite code or address, and what the host's game says about itself.
async function pingTypedGame() {
  pingingTyped = true;
  setMultiplayerResult("Pinging the host's game...");
  renderMultiplayer();
  try {
    const result = await window.sms.pingGame({ address: $('mp-address').value, port: $('mp-join-port').value });
    const where = result.status ? `, in ${result.status}` : '';
    setMultiplayerResult(`Ping ${result.ping} ms${pingHow(result.mode)}. ${result.name}'s game: ${result.players} of `
      + `${result.maxPlayers} players${where}.${result.problem ? ` ${result.problem}` : ''}`, Boolean(result.problem));
  } catch (error) {
    setMultiplayerResult(errorText(error), true);
  } finally {
    pingingTyped = false;
    renderMultiplayer();
  }
}
$('mp-browser-refresh').addEventListener('click', loadPublicGames);
// The hosts joined lately: one press joins again; × forgets one.
function renderRecentHosts(list = current?.config?.multiplayer?.recent || []) {
  const holder = $('mp-recent-list');
  holder.replaceChildren();
  for (const host of list) {
    const item = document.createElement('span');
    item.className = 'mp-recent-item';
    const join = document.createElement('button');
    join.className = 'mp-recent-join';
    join.textContent = host.name ? `${host.name}'s game` : `${host.address}:${host.port}`;
    join.title = `Join ${host.address}:${host.port}`;
    join.addEventListener('click', () => {
      $('mp-address').value = host.address;
      $('mp-join-port').value = String(host.port);
      renderMultiplayer();
      startMultiplayer('join');
    });
    const forget = document.createElement('button');
    forget.className = 'mp-recent-forget';
    forget.textContent = '×';
    forget.setAttribute('aria-label', `Forget ${join.textContent}`);
    forget.addEventListener('click', async () => {
      const saved = await window.sms.forgetMultiplayerHost({ address: host.address, port: host.port });
      if (current) current.config.multiplayer = saved;
      renderRecentHosts(saved.recent);
    });
    item.append(join, forget);
    holder.append(item);
  }
  $('mp-recent').hidden = list.length === 0;
}
function showMultiplayer() {
  const saved = current?.config?.multiplayer || {};
  $('mp-name').value = saved.name || '';
  $('mp-host-port').value = String(saved.hostPort || 24002);
  $('mp-max-players').value = String(saved.maxPlayers || 8);
  $('mp-address').value = saved.address || '';
  $('mp-join-port').value = String(saved.joinPort || 24002);
  $('mp-list-public').checked = saved.public === true;
  setMultiplayerResult('');
  renderRecentHosts();
  renderMultiplayer();
  $(saved.address ? 'mp-join' : 'mp-name').focus();
  checkNat();
  loadPublicGames();
  clearInterval(publicTimer);
  publicTimer = setInterval(() => { if (page === 'multiplayer') loadPublicGames(); }, PUBLIC_REFRESH);
}
onPage('multiplayer', { show: showMultiplayer, hide() { clearInterval(publicTimer); publicTimer = null; } });
for (const id of ['mp-name', 'mp-host-port', 'mp-max-players', 'mp-address', 'mp-join-port', 'mp-list-public']) {
  $(id).addEventListener('input', renderMultiplayer);
  // An unfinished port is kept as it was until it is a number.
  $(id).addEventListener('change', () => window.sms.saveMultiplayer(multiplayerFields())
    .then(saved => { if (current) current.config.multiplayer = saved; }).catch(() => {}));
}
for (const id of ['mp-address', 'mp-join-port'])
  $(id).addEventListener('keydown', event => { if (event.key === 'Enter') $('mp-join').click(); });
$('mp-host-port').addEventListener('keydown', event => { if (event.key === 'Enter') $('mp-host').click(); });
// Copy buttons in the network section: the invite code, the public address, the address on this network.
for (const button of document.querySelectorAll('.mp-copy')) {
  button.addEventListener('click', async () => {
    await window.sms.copyText($(button.dataset.copy).textContent);
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = 'Copy'; }, 1500);
  });
}
async function startMultiplayer(mode) {
  if (!current?.binaryReady && !current?.repoReady) {
    setMultiplayerResult('Set up the game first: go to Play and press the main button.', true);
    return;
  }
  setMessage('');
  setMultiplayerResult(mode === 'join' ? "Looking for the host's game..." : 'Starting the game...');
  setupPending = true;
  try {
    if (current) refresh(current);
    renderMultiplayer();
    await (mode === 'host' ? window.sms.hostGame(multiplayerFields()) : window.sms.joinGame(multiplayerFields()));
    await sync();
  } catch (error) {
    // The game had not started (or failed): say why here, where the player is.
    const message = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    if (page === 'multiplayer') setMultiplayerResult(message, true);
    else showError({ message });
    await sync();
  } finally {
    setupPending = false;
    if (current) refresh(current);
    renderMultiplayer();
  }
}
// NAT type (src/nat.js): what this network allows, from the port the player would host on.
let natCheck = 0;
async function checkNat() {
  const ticket = ++natCheck;
  $('mp-nat-badge').className = 'mp-nat-badge';
  $('mp-nat-badge').textContent = 'Checking…';
  $('mp-nat-text').textContent = 'Checking whether you can host and join from this network…';
  $('mp-share').hidden = true;
  $('mp-nat-check').disabled = true;
  renderMultiplayer();
  try {
    const port = $('mp-host-port').value.trim() || '24002';
    const result = await window.sms.checkNat({ port });
    if (ticket !== natCheck) return;
    $('mp-nat-badge').textContent = `NAT: ${result.label}`;
    $('mp-nat-badge').classList.add(result.type);
    $('mp-nat-text').textContent = result.portBusy
      ? `${result.text} (Port ${port} is in use, so another port was checked.)` : result.text;
    const share = result.share;
    if (share) {
      $('mp-share').hidden = false;
      $('mp-share-note').textContent = result.canHost ? 'Friends can also join you with one of these instead of your room code:'
        : `Friends join with your room code. These work instead once port ${share.port} is forwarded. (Forwarding can't `
          + 'help if your internet provider shares one IP address among its customers, which is called CGNAT.)';
      $('mp-invite-row').hidden = !share.invite;
      $('mp-invite').textContent = share.invite || '';
      $('mp-public').textContent = `${share.address}:${share.port}`;
      $('mp-lan-row').hidden = !share.lan;
      $('mp-lan').textContent = share.lan || '';
    }
  } catch (_) {
    if (ticket !== natCheck) return;
    $('mp-nat-badge').textContent = 'NAT: Unknown';
    $('mp-nat-text').textContent = "Couldn't check your network. Are you online?";
  } finally {
    if (ticket === natCheck) $('mp-nat-check').disabled = false;
    renderMultiplayer();
  }
}
$('mp-nat-check').addEventListener('click', checkNat);
$('mp-host-port').addEventListener('change', checkNat);
$('mp-host').addEventListener('click', () => startMultiplayer('host'));
$('mp-join').addEventListener('click', () => startMultiplayer('join'));
$('mp-ping').addEventListener('click', pingTypedGame);

$('changelog-show-all').addEventListener('click', () => renderChangelog(changelogShown, false));
$('changelog-page').addEventListener('click', () => window.sms.openChangelogPage().catch(error => setMessage(errorText(error))));
$('play').addEventListener('click', () => {
  if (wizardStep === 0) { if (!offerSteam()) runWizardAction('launchGame'); }
  else if (wizardStep === 1) {
    if (current.platform.id === 'macos' && !current.tools.appleReady) { showMacHelp(); return; }
    if (current.repoReady && current.tools.ready) { wizardStep = 2; refresh(current); }
    else runWizardAction('installPort');
  } else if (wizardStep === 2) {
    if (current.romReady) { wizardStep = 3; refresh(current); }
    else runWizardAction('chooseRom');
  } else runWizardAction('setupGame');
});
for (const button of document.querySelectorAll('[data-setup-back]')) button.addEventListener('click', () => {
  if (wizardStep > 1) { wizardStep -= 1; refresh(current); }
});
// What a Dolphin import brought in: which game's save, and each file's Shines.
function dolphinImportSummary(result) {
  const add = (parent, tag, className, text) => {
    const node = parent.appendChild(document.createElement(tag));
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };
  const eclipse = result.game === 'eclipse';
  const card = document.createElement('div'); card.className = 'dolphin-import-done';
  const head = add(card, 'div', 'dolphin-import-head');
  add(head, 'span', 'dolphin-import-check', '✓').setAttribute('aria-hidden', 'true');
  const title = add(head, 'div');
  add(title, 'strong', null, `${result.title} save imported`);
  add(title, 'small', null, result.file);
  add(head, 'span', `badge ${eclipse ? 'eclipse' : 'sunshine'}`, eclipse ? 'Eclipse' : 'Sunshine');
  const files = add(card, 'div', 'dolphin-import-files');
  result.shines.forEach((count, i) => {
    const file = add(files, 'div', `dolphin-import-file${count === null ? ' empty' : ''}`);
    add(file, 'span', null, `File ${'ABC'[i]}`);
    add(file, 'strong', null, count === null ? '–' : `★ ${count}`);
    add(file, 'small', null, count === null ? 'Empty' : count === 1 ? 'Shine' : 'Shines');
  });
  // Each game only reads its own save: say which switch to flip if it is not the one that starts.
  const eclipseOn = Boolean(current?.config?.settings?.eclipse);
  add(card, 'p', 'dolphin-import-next', eclipse === eclipseOn ? 'Start the game to play it.'
    : eclipse ? 'Turn on Super Mario Eclipse under Gameplay to play it.'
      : 'Super Mario Eclipse is on under Gameplay: turn it off to play this save.');
  return card;
}

async function importDolphinSave(files) {
  if (current?.active) return;
  const resultText = $('dolphin-import-result');
  resultText.textContent = '';
  try {
    const result = await window.sms.importDolphinSave(files);
    if (result.cancelled) resultText.textContent = 'Import cancelled.';
    else {
      const note = document.createElement('p'); note.className = 'dolphin-import-skipped';
      note.textContent = result.skipped.length ? `Skipped ${result.skipped.map(save => `${save.file} (${save.reason})`).join(', ')}.` : '';
      resultText.replaceChildren(...result.imported.map(dolphinImportSummary), ...result.skipped.length ? [note] : []);
    }
    await sync();
  } catch (error) {
    const note = document.createElement('p'); note.className = 'dolphin-import-error'; note.textContent = errorText(error);
    resultText.replaceChildren(note); await sync();
  }
}
$('import-dolphin-save').addEventListener('click', () => importDolphinSave());
// Steam, the banner on Play: Add to Steam while the launcher can add
// itself and is not in the library yet, then a tick once it is there. Selecting
// the tick updates the shortcut's artwork and Skip Launcher. A shortcut made by
// hand without --no-sandbox, which won't open in Game Mode, shows a fix instead.
const STEAM_DETAIL = $('steam-banner-detail').textContent;
let steam = {};
function steamBannerText() {
  if (steam.needsFix) return { title: 'Fix for Game Mode', mark: '!', detail: steam.available
    ? "Steam's shortcut is missing --no-sandbox. Select to fix it" : 'In Steam, add --no-sandbox to its launch options' };
  if (steam.inSteam) return { title: 'In your Steam library', mark: '✓', detail: steam.available
    ? 'Select to update its artwork or Skip Launcher' : 'Play from Steam, Big Picture or Game Mode' };
  return { title: 'Add to Steam', mark: '+', detail: STEAM_DETAIL };
}
function renderSteamBanner() {
  const banner = $('add-to-steam'), text = steamBannerText();
  banner.hidden = !steam.available && !steam.inSteam;
  banner.classList.toggle('in-steam', Boolean(steam.inSteam) && !steam.needsFix);
  banner.classList.toggle('needs-fix', Boolean(steam.needsFix));
  banner.disabled = !steam.available;
  $('steam-banner-title').textContent = text.title;
  $('steam-banner-detail').textContent = text.detail;
  $('steam-banner-mark').textContent = text.mark;
  banner.setAttribute('aria-label', `${text.title}. ${text.detail}`);
}
async function refreshSteamBanner() {
  try { steam = await window.sms.steamStatus() || {}; } catch { steam = {}; }
  renderSteamBanner();
}
// One Steam dialog: from the banner (add, or update once in Steam), or offered
// once by Play on SteamOS, which then plays whatever the player chooses.
const STEAM_MODES = {
  add: { kicker: 'Add to Steam', intro: 'Adds Super Mario Sunshine to your Steam library, with artwork.', cancel: 'Cancel', confirm: 'Add to Steam' },
  update: { kicker: 'In your Steam library', intro: "It's already in Steam. Update it to refresh its artwork, or to turn Skip Launcher on or off.",
    cancel: 'Cancel', confirm: 'Update in Steam' },
  offer: { kicker: 'Play from Steam?', intro: "Add Super Mario Sunshine to your Steam library and start it from Game Mode like your other games. We'll only ask once: the Add to Steam banner on the home screen does it any time.",
    cancel: 'Not now', confirm: 'Add to Steam & play' },
  fix: { kicker: 'Fix for Game Mode', intro: "Super Mario Sunshine is in your Steam library, but its shortcut is missing the --no-sandbox launch option, so it won't open in Game Mode. Let the launcher fix it: it keeps the shortcut's play time, collections and controller layout, and adds the artwork.",
    cancel: 'Not now', confirm: 'Fix shortcut' }
};
let playAfterSteam = false;
function openSteamDialog(mode) {
  const text = STEAM_MODES[mode];
  $('steam-add-kicker').textContent = text.kicker;
  $('steam-add-intro').textContent = text.intro;
  $('steam-add-cancel').textContent = text.cancel;
  $('steam-add-confirm').textContent = text.confirm;
  $('steam-skip-launcher').checked = ['update', 'fix'].includes(mode) && Boolean(steam.skipLauncher);
  playAfterSteam = mode === 'offer';
  $('steam-add').showModal();
}
// Not now, Esc or × after Play's offer: play as the player asked.
$('steam-add').addEventListener('close', () => {
  if (!playAfterSteam) return;
  playAfterSteam = false;
  runWizardAction('launchGame');
});
// Play's offer, on SteamOS while the launcher isn't in Steam yet. True when shown.
function offerSteam() {
  if (!steam.offer || current?.active) return false;
  steam.offer = false;
  window.sms.steamOffered('play').catch(() => {});
  openSteamDialog('offer');
  return true;
}
// Opening the launcher offers once to fix a shortcut without --no-sandbox.
function offerSteamFix() {
  if (!steam.offerFix || current?.active || page !== 'play' || [...document.querySelectorAll('.launcher-modal')].some(dialog => dialog.open)) return;
  steam.offerFix = false;
  window.sms.steamOffered('fix').catch(() => {});
  openSteamDialog('fix');
}
$('add-to-steam').addEventListener('click', () => openSteamDialog(steam.needsFix ? 'fix' : steam.inSteam ? 'update' : 'add'));
$('steam-add-confirm').addEventListener('click', async () => {
  const play = playAfterSteam, fixing = Boolean(steam.needsFix);
  playAfterSteam = false;
  $('steam-add').close();
  $('add-to-steam').disabled = true;
  $('steam-banner-detail').textContent = steam.needsFix ? 'Fixing in Steam…' : steam.inSteam ? 'Updating in Steam…' : 'Adding to Steam…';
  let failed = false;
  try {
    const done = await window.sms.addToSteam({ play: $('steam-skip-launcher').checked });
    if (done.cancelled) setMessage('Not added. Steam needs to close for a moment to add the launcher.');
    else {
      const art = done.artwork === done.total ? ' with its artwork'
        : done.artwork ? ` with ${done.artwork} of ${done.total} artwork images (SteamGridDB didn't send the rest)` : " without artwork (SteamGridDB couldn't be reached)";
      const skip = done.play ? ' It starts the game straight away; open the launcher itself now and then for launcher updates.' : '';
      setMessage(fixing ? `Fixed "${done.name}" in Steam${art}: it opens in Game Mode now. ${done.reopened ? 'Steam is opening again.' : 'Open Steam to find it.'}${skip}`
        : `${done.added ? 'Added' : 'Updated'} "${done.name}" in your Steam library${art}. ${done.reopened ? 'Steam is opening again.' : 'Open Steam to find it.'}${skip}`);
    }
  } catch (error) { failed = true; showError(error); }
  finally {
    await refreshSteamBanner();
    await sync();
  }
  // Play's offer plays afterwards, keeping the Steam message in view; an error stays to be read.
  if (play && !failed) {
    const shown = $('message-text').textContent;
    runWizardAction('launchGame');
    if (shown) setMessage(shown);
  }
});
refreshSteamBanner().then(offerSteamFix);
// Apple Silicon: a Mac playing through Rosetta moves to the native build once
// its game has it, as a new setup does, and a dialog says so with a way back.
// On Play over nothing else, after What's new at start or once a game update
// brings it, and never during a task, which would refuse the change.
let appleSiliconSwitchReady = false;
async function switchAppleSilicon() {
  if (!appleSiliconSwitchReady || !current?.switchAppleSilicon || current.active || page !== 'play' ||
    [...document.querySelectorAll('.launcher-modal')].some(dialog => dialog.open)) return;
  current.switchAppleSilicon = false;
  $('appleSilicon').checked = true;
  await saveSettings();
  if (current?.config.settings.arch !== 'arm64') return;
  window.sms.appleSiliconSwitched(false).catch(() => {});
  $('apple-silicon-switched-game').textContent = current.config.settings.eclipse ? 'Super Mario Eclipse' : 'Your game';
  $('apple-silicon-switched').showModal();
}
$('apple-silicon-keep-rosetta').addEventListener('click', async () => {
  $('apple-silicon-switched').close();
  await window.sms.appleSiliconSwitched(true).catch(() => {});
  $('appleSilicon').checked = false;
  await saveSettings();
  if (current?.config.settings.arch === '64') setMessage('Your game keeps playing through Rosetta.');
});
const dolphinDrop = $('dolphin-save-drop');
for (const type of ['dragenter', 'dragover']) dolphinDrop.addEventListener(type, event => {
  event.preventDefault();
  if (!current?.active) dolphinDrop.classList.add('drag-over');
});
for (const type of ['dragleave', 'drop']) dolphinDrop.addEventListener(type, event => {
  event.preventDefault();
  dolphinDrop.classList.remove('drag-over');
});
dolphinDrop.addEventListener('drop', event => {
  if (current?.active) return;
  if (!event.dataTransfer.files.length) return;
  importDolphinSave([...event.dataTransfer.files]);
});
// Prevent dropped files from navigating away from the launcher.
for (const type of ['dragover', 'drop']) window.addEventListener(type, event => event.preventDefault());

$('restore-saves').addEventListener('click', async () => {
  setMessage('');
  try { await window.sms.restoreSaves($('backup-list').value); await sync(); }
  catch (error) { showError(error); await sync(); }
});

// --- Save states (src/savestates.js): the game saves them, the launcher lists, imports and deletes them.
function saveStateHelp() {
  const pad = SmsBindings.padsFor(padBindings, 'SAVE_STATE').map(SmsBindings.padLabel)[0];
  const saveKey = SmsBindings.keysFor(keyBindings, 'SAVE_STATE').map(SmsBindings.keyLabel)[0];
  const loadKey = SmsBindings.keysFor(keyBindings, 'LOAD_STATE').map(SmsBindings.keyLabel)[0];
  const save = [pad, saveKey].filter(Boolean).join(' or ') || 'the Save a state control';
  return `In a level, ${save} saves the moment you're in; pause and press the same to load a state` +
    `${loadKey ? ` (${loadKey} loads the newest)` : ''}. A state loads exactly in the game build that saved it; ` +
    'from another build or someone else\'s game it takes you to the same place. Share a state by sending its file.';
}

function renderSaveStates({ states }) {
  $('save-state-help').textContent = saveStateHelp();
  if (!states.length) {
    const empty = document.createElement('p'); empty.className = 'save-state-empty'; empty.textContent = 'No save states yet.';
    $('save-state-list').replaceChildren(empty);
    return;
  }
  $('save-state-list').replaceChildren(...states.map(state => {
    const row = document.createElement('div'); row.className = 'save-state-row';
    const picture = document.createElement(state.thumbnail ? 'img' : 'span'); picture.className = 'save-state-picture';
    if (state.thumbnail) { picture.src = state.thumbnail; picture.alt = ''; }
    const text = document.createElement('span'); text.className = 'save-state-text';
    const title = document.createElement('strong'); title.textContent = state.stage || state.name.replace(/\.smsstate$/, '');
    const detail = document.createElement('small');
    detail.textContent = [state.episode, new Date(state.created).toLocaleString(), state.flavor === 'eclipse' ? 'Super Mario Eclipse' : '']
      .filter(Boolean).join(' · ');
    text.append(title, detail);
    if (state.counts) {
      const counts = document.createElement('small'); counts.className = 'save-state-counts';
      const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
      counts.textContent = [plural(state.counts.shines, 'Shine', 'Shines'), plural(state.counts.blueCoins, 'blue coin', 'blue coins'),
        plural(state.counts.coins, 'coin', 'coins'), plural(state.counts.lives, 'life', 'lives')].join(' · ');
      text.append(counts);
    }
    const actions = document.createElement('span'); actions.className = 'binding-actions';
    const button = (label, onClick) => {
      const item = document.createElement('button'); item.className = 'subtle'; item.textContent = label;
      item.addEventListener('click', onClick); return item;
    };
    actions.append(button('Show file', () => window.sms.showSaveState(state.name).catch(showError)),
      button('Delete', async () => {
        try { if (!(await window.sms.deleteSaveState(state.name)).cancelled) await loadSaveStates(); }
        catch (error) { showError(error); }
      }));
    row.append(picture, text, actions);
    return row;
  }));
}

async function loadSaveStates() {
  try { renderSaveStates(await window.sms.saveStates()); }
  catch (error) { $('save-state-result').textContent = errorText(error); }
}

$('import-save-state').addEventListener('click', async () => {
  $('save-state-result').textContent = '';
  try {
    const result = await window.sms.importSaveState();
    if (!result.cancelled) $('save-state-result').textContent = `Imported ${result.imported} save state${result.imported === 1 ? '' : 's'}.`;
    await loadSaveStates();
  } catch (error) { $('save-state-result').textContent = errorText(error); }
});
$('open-save-states').addEventListener('click', () => window.sms.openSaveStates().catch(showError));
for (const key of ['arch', 'widescreen', 'resolution', 'volume', 'frameRate', 'language', 'vsync', 'skipMovies', 'skipIntro', 'pauseTracker', 'heatHaze', 'overlay', 'fullscreen', 'fullscreenMode', 'exclusiveResolution', 'display', 'invertCameraX', 'invertCameraY', 'freeCamera', 'cstickAim', 'cameraSpeed', 'mouseCamera', 'mouseSensitivity', 'msaa', 'fxaa', 'anisotropic', 'sharpen', 'brightness', 'aspect', 'presentFilter', 'hudEdges', 'textures', 'textureLoading', 'shaderWarmup', 'cutscenes', 'eclipse', 'autoUpdate', 'shareUsage', 'discordPresence', 'darkMode', 'updateChannel', 'buttonPrompts', 'promptPad', 'hdr', 'hdrCalibration', 'hdrPaperWhite', 'hdrPeak', 'hdrContrast', 'hdrSaturation', 'hdrHighlights', 'fsrMode', 'renderer', 'appleSilicon'])
  $(key).addEventListener('change', saveSettings);
$('volume').addEventListener('input', renderVolume);
for (const key of ['cameraSpeed', 'mouseSensitivity', 'sharpen', 'brightness']) $(key).addEventListener('input', renderRanges);
for (const key of ['fullscreen', 'fullscreenMode', 'mouseCamera', 'presentFilter', 'textures', 'textureLoading']) $(key).addEventListener('input', () => renderDependents());
window.sms.onLog(appendLog);
window.sms.onLogReset(resetLog);
window.sms.onActivity(value => {
  const changed = Boolean(value) !== Boolean(current?.active);
  // Update & play builds and then starts the game in one task: reread the versions once the new game boots.
  const gameStarted = value?.label === 'Play Super Mario Sunshine' && current?.active?.label !== value.label;
  // Host Game and Join go back to Play once the game is starting, where the room code shows.
  if (gameStarted && page === 'multiplayer') showPage('play');
  if (current) current.active = value;
  renderActivity(value);
  // Lock the settings now: the next state (sync) can take a while to arrive.
  if (changed && current) refresh(current);
  if (changed || gameStarted) sync().catch(showError);
});
let checkingUpdates = false;
function renderAppUpdate(value) {
  $('app-update').textContent = value.message;
  $('install-app-update').hidden = value.state !== 'ready';
  $('check-updates').disabled = checkingUpdates || value.state === 'checking' || value.state === 'downloading';
}
// Check the launcher's update channel now, then reread the game's versions and the channel list.
async function checkForUpdates() {
  if (checkingUpdates) return;
  checkingUpdates = true;
  $('check-updates').disabled = true;
  $('check-updates').classList.add('checking');
  try {
    await window.sms.checkAppUpdate();
    await Promise.all([sync(), loadUpdateChannels()]);
  } catch (error) { showError(error); }
  finally {
    checkingUpdates = false;
    $('check-updates').classList.remove('checking');
    $('check-updates').disabled = false;
  }
}
window.sms.onAppUpdate(renderAppUpdate);
// Hidden until the usage API answers, so offline launchers look as before.
function renderOnline(value) {
  if (!value) return;
  const players = count => `${count} ${count === 1 ? 'player' : 'players'}`;
  $('online-number').textContent = `${value.online.toLocaleString()} online`;
  $('online-count').title = `${players(value.online)} ${value.online === 1 ? 'has' : 'have'} the launcher open · ${value.playing.toLocaleString()} playing now`;
  $('online-count').hidden = false;
}
window.sms.onOnline(renderOnline);
// Players in public games right now (src/main.js: checkPublicOnline), on the Multiplayer tab: a sign someone is
// playing online. Hidden when nobody is, or the list can't be had.
function renderPublicOnline(value) {
  const players = value?.players || 0;
  $('mp-online').hidden = players === 0;
  $('mp-online-count').textContent = players > 99 ? '99+' : String(players);
  $('mp-online').title = players === 0 ? '' : `${players} ${players === 1 ? 'player' : 'players'} in `
    + `${value.games === 1 ? 'a public game' : `${value.games} public games`} right now`;
}
window.sms.onPublicOnline(renderPublicOnline);
$('install-app-update').addEventListener('click', () => window.sms.installAppUpdate().catch(showError));
$('check-updates').addEventListener('click', checkForUpdates);
function renderWindowState(value) {
  const fullscreen = Boolean(value.fullscreen);
  $('window-fullscreen').setAttribute('aria-pressed', String(fullscreen));
  $('window-fullscreen').setAttribute('aria-label', fullscreen ? 'Exit full screen' : 'Enter full screen');
  $('window-fullscreen').title = fullscreen ? 'Exit full screen' : 'Enter full screen';
}
$('window-minimize').addEventListener('click', () => window.sms.minimizeWindow());
$('window-fullscreen').addEventListener('click', () => window.sms.toggleFullScreen().then(renderWindowState).catch(showError));
$('window-close').addEventListener('click', () => window.sms.closeWindow());
window.sms.onWindowState(renderWindowState);

// --- Controller navigation (src/gamepad-nav.js).
const openDialog = () => [...document.querySelectorAll('.launcher-modal[open]')].pop();
// LB / RB step through the Settings tabs on Settings, and through the launcher's tabs elsewhere.
function stepPage(step) {
  if (openDialog()) return;
  if (page === 'settings') {
    const target = settingsTabs[settingsTabs.indexOf(settingsTab) + step];
    if (!target) return;
    showSettingsTab(target);
    $(`tab-${target}`).focus();
    return;
  }
  const shown = pageOrder.filter(name => !$(pages[name].nav).hidden);
  const target = shown[shown.indexOf(page) + step];
  if (!target) return;
  showPage(target);
  $(pages[target].nav).focus();
}
function gamepadBack() {
  const dialog = openDialog();
  if (closePlayMenu()) return;
  if (dialog) dialog.close();
  else if (consoleOpen) setConsoleOpen(false);
  else if (page !== 'play') { showPage('play'); $('nav-play').focus(); }
  else [...document.querySelectorAll('[data-setup-back]')].find(button => !button.disabled && button.offsetParent)?.click();
}
// Escape goes back to Play, as it closed these pages when they were dialogs. Controls' key capture
// takes Escape first, and an open dialog closes itself.
window.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || capture || openDialog() || page === 'play') return;
  showPage('play');
});
window.smsGamepadNav.start({
  document, window,
  regions: '.switch, .field',
  defaultFocus: () => [page === 'settings' ? $(`tab-${settingsTab}`) : page === 'play' ? $('play') : $(pages[page].nav), $('play'), $('settings-cog')],
  // The game reads the same controller, and Controls waits for a button to bind.
  paused: () => current?.active?.label === 'Play Super Mario Sunshine' || Boolean(capture),
  actions: {
    back: gamepadBack,
    menu: () => openDialog() ? closeModal() : showPage(page === 'settings' ? 'play' : 'settings'),
    view: () => consoleOpen ? setConsoleOpen(false) : showActivityLog(),
    previous: () => stepPage(-1),
    next: () => stepPage(1)
  }
});
window.sms.windowState().then(renderWindowState).catch(showError);
setInterval(() => { if (current?.active) renderActivity(current.active); }, 1000);
sync().then(() => { for (const line of current.logs) appendLog(line); if (!showPathProblem()) return showWhatsNew(); })
  .then(() => { appleSiliconSwitchReady = true; return switchAppleSilicon(); }).catch(showError);
