// Characters: who the game starts as. The player's outfits (up to six) are tabs, each a character
// in its colours; the open one is who the game starts as (F4 in the game switches between
// characters). Each of the launcher's characters (character-roster.js) is made from the player's
// own disc, then shown as the game draws it, standing; Mario is shown with his colours beside him
// (mario-look.js). Animations shows any character in any of its animations, with the floor under
// it and Mario beside it or over it.
import * as THREE from '../node_modules/three/build/three.module.js';
import { createRig, jointMatrix } from './model-rig.js';
import { drawPortrait, release as releasePortraits } from './portraits.js';

const $ = id => document.getElementById(id);
const Colors = window.SmsMarioColors;
const page = $('page-characters');
const WRAP = [THREE.ClampToEdgeWrapping, THREE.RepeatWrapping, THREE.MirroredRepeatWrapping];
// Mario's height with his cap, the floor's scale.
const MARIO_HEIGHT = 150;
// Names for the animations players will look for first; the rest show their file names.
const NAMES = {
  ma_wait: 'Standing', ma_run1: 'Running', ma_run2: 'Running (fast)', ma_jump: 'Jump', ma_2jmp1: 'Double jump',
  ma_tjmp1: 'Triple jump (rise)', ma_tjmp2: 'Triple jump (flip)', ma_hipat: 'Ground pound', ma_hang: 'Hanging from a ledge',
  ma_swim: 'Swimming', ma_swim_wait: 'Treading water', ma_sleep: 'Sleeping', ma_die: 'Losing a life', ma_roll: 'Roll',
  ma_slip: 'Slipping', ma_sldct: 'Belly slide', ma_sit_wait: 'Sitting', ma_tree_climb: 'Climbing a pole',
  ma_fence_wait: 'On a fence', ma_rope_wait: 'On a tightrope', ma_demo_shine_get: 'Shine get', ma_pump: 'Spraying',
  ma_turn: 'Turning round', ma_brake: 'Skidding', ma_land: 'Landing', ma_jkick: 'Jump kick',
};
// Named animations first, in NAMES' order (Standing first), then the rest by file name.
const ORDER = Object.keys(NAMES);
const order = name => (ORDER.includes(name) ? ORDER.indexOf(name) : ORDER.length);
const VIEWS = { front: [0, 0.1], side: [Math.PI / 2, 0.1], back: [Math.PI, 0.1], above: [0.6, 0.9] };

const state = {
  characters: [], id: null, playing: 'mario', eclipse: false, showFludd: true, fluddRig: null, model: null, animation: 'ma_wait', clips: new Map(), mario: null, compare: 'off',
  frame: 0, running: true, speed: 1, filter: '', animations: false, modelId: null,
  outfits: null, coopOutfit: true,
};
// Mario, outside Animations, is shown with his colours.
const colouring = () => state.id === 'mario' && !state.animations;
const comparing = () => state.animations && state.compare !== 'off';
const INTRO = {
  basic: 'Who you play as, in your colours, made on your computer from your own disc. In the game, F4 switches characters. Drag to turn, scroll to zoom.',
  animations: 'Each character in any of its animations, with FLUDD, and Mario beside it or over it to compare. Drag to turn, scroll to zoom.',
};
let viewer = null, loading = null;

window.smsOnPage('characters', {
  show() {
    // the tab opens on the list and the character, not Animations
    setMode(false);
    portraitsOn = true;
    loading ||= start();
  },
  hide() {
    viewer?.dispose();
    viewer = null;
    window.smsMarioLook.hide();
    portraitsOn = false;
    if (!drawing) releasePortraits();
  },
});

// Animations, or back to the list and the character; it plays standing again on the way back.
function setMode(animations) {
  if (!animations && state.animations) {
    state.animation = 'ma_wait';
    state.frame = 0;
    state.running = true;
    state.speed = 1;
    $('characters-speed').value = '1';
  }
  state.animations = animations;
  page.classList.toggle('animations', animations);
  $('characters-title').textContent = animations ? 'Animations' : 'Character';
  $('characters-intro').textContent = INTRO[animations ? 'animations' : 'basic'];
  $('characters-mode').textContent = animations ? '‹ Characters' : 'Animations';
}
$('characters-mode').addEventListener('click', () => {
  setMode(!state.animations);
  closePicker();
  // back from Animations: the outfit worn
  const id = state.animations ? state.id : worn()?.character;
  if (id && !loading) choose(id).catch(error => setStatus(error.message || String(error)));
});

// Mario's colours, or the character's own view.
function showStage() {
  const colours = colouring();
  $('mario-look').hidden = !colours;
  $('mario-colours').hidden = !colours;
  $('characters-stage-wrap').hidden = colours;
  if (colours) {
    viewer?.dispose();
    viewer = null;
    window.smsMarioLook.show();
  } else window.smsMarioLook.hide();
}

async function start() {
  try {
    if (!state.characters.length) {
      setStatus('Looking for characters…', true);
      await refresh();
    }
    makeAll();
    if (worn().character === 'mario') window.smsMarioLook.wear(worn().look);
    await choose(state.animations && state.id ? state.id : worn().character);
  } catch (error) {
    setStatus(error.message || String(error));
  } finally { loading = null; }
}

// Characters being made: choosing one waits for it rather than making it again.
const building = new Map();
function make(id) {
  if (!building.has(id)) {
    building.set(id, window.sms.characterBuild(id).then(characters => { state.characters = characters; return characters; })
      .finally(() => { building.delete(id); renderList(); renderPicker(); refreshPortraits(); }));
    renderList();
    renderPicker();
  }
  return building.get(id);
}

// Every character not made yet, made from the disc one after another while the page is open.
let makingAll = false;
async function makeAll() {
  if (makingAll || !state.setUp) return;
  makingAll = true;
  try {
    for (let next; (next = state.characters.find(c => !c.ready && c.makeable !== false && !failed.has(c.id)));) {
      try { await make(next.id); } catch (_) { failed.add(next.id); renderList(); renderPicker(); }
    }
  } finally { makingAll = false; }
}
const failed = new Set();
// One that can't be made yet: Luigi before Eclipse is set up (the only one from elsewhere than the disc).
const needsEclipse = name => `${name} comes from Super Mario Eclipse. Turn on Super Mario Eclipse in Settings, Gameplay, and set it up once (it needs the North American disc): ${name} stays when you turn Eclipse off.`;
const waiting = character => Boolean(character && !character.ready && character.makeable === false);

async function refresh() {
  const { characters, outfits, eclipse, ready, coopOutfit } = await window.sms.characters();
  state.characters = characters;
  state.setUp = ready !== false;
  state.outfits = outfits;
  state.playing = worn().character;
  state.eclipse = eclipse;
  state.coopOutfit = coopOutfit !== false;
  renderList();
  renderOutfits();
}

// --- Loading -------------------------------------------------------------------

async function choose(id) {
  state.id = id;
  renderList();
  showStage();
  // what is made now, not when the list was read (a character's builder may have changed since)
  state.characters = (await window.sms.characters()).characters;
  if (state.id !== id) return;
  renderList();
  if (colouring()) return;
  const character = state.characters.find(c => c.id === id);
  if (waiting(character)) {
    viewer?.dispose();
    viewer = null;
    state.model = null;
    state.modelId = null;
    setStatus(needsEclipse(character.name));
    return;
  }
  if (!character.ready) {
    setStatus(`Making ${character.name} from your disc…`, true);
    const stop = window.sms.onCharacterBuildProgress(text => setStatus(`Making ${character.name} from your disc: ${text.toLowerCase()}…`, true));
    failed.delete(id);
    try { await make(id); } finally { stop(); }
    if (state.id !== id) return;
    renderList();
  }
  if (state.modelId !== id || !character.ready) {
    setStatus('Reading the character…', true);
    if (!state.fluddRig) state.fluddRig = await window.sms.characterFludd().catch(() => null);
    const model = await window.sms.characterModel(id);
    if (state.id !== id) return;
    state.model = model;
    state.modelId = id;
    state.clips = new Map();
  }
  const { model } = state;
  if (!model.animations.includes(state.animation)) state.animation = model.animations.includes('ma_wait') ? 'ma_wait' : model.animations[0];
  if (comparing() && !state.mario) state.mario = await window.sms.characterModel('mario');
  if (state.id !== id) return;
  await loadClip();
  renderAnimations();
  rebuild();
}

async function loadClip() {
  const key = `${state.id}:${state.animation}`;
  if (!state.clips.has(key)) state.clips.set(key, await window.sms.characterAnimation(state.id, state.animation));
  if (comparing() && state.mario?.animations.includes(state.animation)) {
    const marioKey = `mario:${state.animation}`;
    if (!state.clips.has(marioKey)) state.clips.set(marioKey, await window.sms.characterAnimation('mario', state.animation));
  }
  const clip = state.clips.get(key);
  state.frame = Math.min(state.frame, clip.frames - 1);
  $('characters-frame').max = String(Math.max(clip.frames - 1, 0));
  syncTransport();
}

const clip = (id = state.id) => state.clips.get(`${id}:${state.animation}`);

// A fresh canvas for each model (a canvas whose context was let go can't make another).
function rebuild() {
  if (page.hidden || !state.model || colouring()) return;
  viewer?.dispose();
  viewer = null;
  const canvas = $('characters-stage').cloneNode(false);
  $('characters-stage').replaceWith(canvas);
  try { viewer = createViewer(canvas); }
  catch (_) {
    setStatus('The 3D view couldn\'t start. Restarting the launcher usually brings it back.');
    return;
  }
  setStatus('');
  viewer.start();
}

// --- Controls ------------------------------------------------------------------

function renderList() {
  const list = $('characters-list');
  list.replaceChildren(...state.characters.map(({ id, name, ready, makeable }) => {
    const button = document.createElement('button');
    button.className = 'characters-item';
    button.innerHTML = '<span></span><small></small>';
    button.querySelector('span').textContent = name;
    button.querySelector('small').textContent = id === state.playing ? 'Playing' : building.has(id) ? 'Making…'
      : !ready && failed.has(id) ? 'Couldn\'t be made' : !ready && makeable === false ? 'Needs Eclipse' : '';
    button.classList.toggle('playing', id === state.playing);
    button.setAttribute('aria-pressed', String(id === state.id));
    button.addEventListener('click', () => { if (id !== state.id) choose(id).catch(error => setStatus(error.message)); });
    return button;
  }));
}

// --- Outfits -------------------------------------------------------------------
// Tabs over the character, one per outfit: a character in its colours, and the one open is who the
// game starts as. Changes to Mario's colours save into his outfit as they're made (mario-look.js and
// main.js), so there's nothing to save or load.

const worn = () => state.outfits?.slots[state.outfits.active];
const characterOf = id => state.characters.find(c => c.id === id) || { id, name: id, about: '' };
// `renaming` is the outfit whose name is being typed, `deleting` a Delete waiting for its second press,
// `picking` what the character picker is for: 'new' or 'change'.
let renaming = -1, deleting = null, picking = null;

function saveOutfits() {
  window.sms.saveMarioOutfits(state.outfits).catch(error => setStatus(error.message || String(error)));
}

// The outfit worn shown, and played as.
function putOn() {
  const outfit = worn();
  state.playing = outfit.character;
  if (outfit.character === 'mario') window.smsMarioLook.wear(outfit.look);
  renderOutfits();
  renderList();
  if (!state.animations) choose(outfit.character).catch(error => setStatus(error.message || String(error)));
}

function wear(index) {
  if (index === state.outfits.active) return;
  // a change to Mario's colours still waiting goes into the outfit it was made in
  window.smsMarioLook.flush();
  state.outfits.active = index;
  renaming = -1;
  disarmDelete();
  closePicker();
  saveOutfits();
  putOn();
}

// A new outfit for `character`, in the colours of the one worn, ready to be named.
function addOutfit(character) {
  const { slots } = state.outfits, index = slots.indexOf(null);
  if (index < 0) return;
  window.smsMarioLook.flush();
  slots[index] = { name: Colors.uniqueName(slots, character.name), character: character.id, look: Colors.slotLook(worn().look) };
  state.outfits.active = index;
  renaming = index;
  disarmDelete();
  saveOutfits();
  putOn();
}

// The outfit worn, for another character; a name it was given for its character follows.
function changeCharacter(character) {
  const outfit = worn(), before = characterOf(outfit.character).name;
  if (outfit.character === character.id) return;
  window.smsMarioLook.flush();
  const named = outfit.name === before || outfit.name.startsWith(`${before.slice(0, Colors.SLOT_NAME_LENGTH - 3)} `) && /\d+$/.test(outfit.name)
    || /^Outfit \d+$/.test(outfit.name);
  outfit.character = character.id;
  if (named) outfit.name = Colors.uniqueName(state.outfits.slots, character.name, state.outfits.active);
  saveOutfits();
  putOn();
}

function rename(index, name) {
  renaming = -1;
  const trimmed = name.trim().slice(0, Colors.SLOT_NAME_LENGTH), outfit = state.outfits.slots[index];
  if (trimmed && outfit && trimmed !== outfit.name) {
    outfit.name = trimmed;
    saveOutfits();
  }
  renderOutfits();
}

// Delete asks once more first; the last outfit can't be deleted.
function disarmDelete() {
  if (!deleting) return;
  clearTimeout(deleting);
  deleting = null;
}
$('outfit-delete').addEventListener('click', () => {
  const { slots } = state.outfits;
  if (slots.filter(Boolean).length < 2) return;
  if (!deleting) {
    deleting = setTimeout(() => { deleting = null; renderPanel(); }, 3000);
    renderPanel();
    return;
  }
  disarmDelete();
  const gone = state.outfits.active;
  window.smsMarioLook.flush();
  slots[gone] = null;
  // player 2 in co-op is the game's own Luigi again
  if (state.outfits.coop === gone) state.outfits.coop = null;
  // the outfit beside it is put on
  const next = slots.findIndex((slot, index) => slot && index > gone);
  state.outfits.active = next >= 0 ? next : slots.map(Boolean).lastIndexOf(true);
  saveOutfits();
  putOn();
});

// The portraits of Mario's outfit follow his colours, once they've stopped changing for a moment.
let repaint = null;
window.smsMarioLook.onChange = look => {
  const outfit = worn();
  if (outfit?.character !== 'mario') return;
  outfit.look = Colors.slotLook(look);
  clearTimeout(repaint);
  repaint = setTimeout(() => {
    const tab = document.querySelector(`.outfit-tab[data-outfit="${state.outfits.active}"] .outfit-icon`);
    if (tab && worn().character === 'mario') portrait(tab, 'mario', worn().look);
    if (worn().character === 'mario') portrait($('outfit-character-icon'), 'mario', worn().look);
  }, 700);
};

function renderOutfits() {
  if (!state.outfits) return;
  const { slots, active } = state.outfits;
  const tabs = slots.map((outfit, index) => {
    if (!outfit) return null;
    const open = index === active, character = characterOf(outfit.character);
    const tab = document.createElement('div');
    tab.className = 'outfit-tab';
    tab.classList.toggle('open', open);
    tab.dataset.outfit = String(index);
    tab.innerHTML = `<button type="button" class="outfit-wear" role="tab" aria-selected="${open}"><span class="outfit-icon"></span><span class="outfit-name"></span></button>`;
    portrait(tab.querySelector('.outfit-icon'), character.id, outfit.look);
    tab.querySelector('.outfit-name').textContent = outfit.name;
    const button = tab.querySelector('.outfit-wear');
    button.title = open ? `${outfit.name} (${character.name}): double-click to rename` : `Play as ${outfit.name} (${character.name})`;
    if (index === state.outfits.coop) {
      const badge = document.createElement('span');
      badge.className = 'outfit-p2';
      badge.textContent = 'P2';
      button.append(badge);
      button.title += ', player 2 in co-op';
    }
    button.addEventListener('click', () => wear(index));
    button.addEventListener('dblclick', () => { renaming = index; renderOutfits(); });
    if (open && renaming !== index) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'outfit-rename';
      edit.textContent = '✎';
      edit.title = edit.ariaLabel = `Rename ${outfit.name}`;
      edit.addEventListener('click', () => { renaming = index; renderOutfits(); });
      tab.append(edit);
    }
    if (renaming === index) {
      const input = document.createElement('input');
      input.className = 'outfit-input';
      input.maxLength = Colors.SLOT_NAME_LENGTH;
      input.value = outfit.name;
      input.spellcheck = false;
      input.ariaLabel = 'Outfit name';
      let done = false;
      const finish = keep => { if (done) return; done = true; rename(index, keep ? input.value : ''); };
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); finish(true); }
        if (event.key === 'Escape') { event.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
      tab.querySelector('.outfit-name').replaceWith(input);
      requestAnimationFrame(() => { input.focus(); input.select(); });
    }
    return tab;
  }).filter(Boolean);
  if (slots.includes(null)) {
    const add = document.createElement('button');
    add.type = 'button';
    add.id = 'outfit-add';
    add.className = 'outfit-add';
    add.innerHTML = '<span aria-hidden="true">+</span>New outfit';
    add.title = 'A new outfit: pick who wears it';
    add.setAttribute('aria-haspopup', 'dialog');
    add.addEventListener('click', event => { event.stopPropagation(); togglePicker('new', add); });
    tabs.push(add);
  }
  $('outfits').replaceChildren(...tabs);
  renderPanel();
}

function renderPanel() {
  const outfit = worn();
  if (!outfit) return;
  const character = characterOf(outfit.character), mario = character.id === 'mario';
  portrait($('outfit-character-icon'), character.id, outfit.look);
  $('outfit-character-name').textContent = character.name;
  $('outfit-note-text').innerHTML = '';
  const name = document.createElement('strong');
  name.textContent = outfit.name;
  $('outfit-note-text').append('You play as ', name, mario ? '. Changes save to it as you make them.' : '.');
  const only = state.outfits.slots.filter(Boolean).length < 2;
  $('outfit-delete').hidden = only;
  $('outfit-delete').textContent = deleting ? `Delete ${outfit.name}?` : 'Delete';
  $('outfit-delete').classList.toggle('armed', Boolean(deleting));
  renderCoop(outfit);
  $('outfit-about').textContent = state.eclipse && !mario
    ? `With Super Mario Eclipse on, the game plays as its own characters: ${outfit.name} is for Super Mario Sunshine.`
    : mario ? '' : `${character.about} ${character.name}'s colours can't be changed yet.`;
}

// Player 2 in co-op (Play co-op, under ▾ beside Play): an outfit chosen here, or the game's own Luigi.
// The open outfit is made player 2, or no longer is.
function renderCoop(outfit) {
  const { slots, active, coop } = state.outfits, chosen = coop === active, other = coop !== null && !chosen ? slots[coop] : null;
  const text = $('outfit-coop-text'), name = document.createElement('strong');
  name.textContent = chosen ? outfit.name : other ? other.name : 'Luigi';
  text.replaceChildren(...(chosen ? [name, ' is player 2 in co-op.'] : ['In co-op, player 2 is ', name, other ? '.' : ', the game\'s own.']));
  if (state.eclipse) text.append(' Not with Super Mario Eclipse on: its player 2 is its own.');
  else if (!state.coopOutfit && coop !== null) text.append(' Update the game to play co-op this way.');
  $('outfit-coop').classList.toggle('on', chosen);
  const toggle = $('outfit-coop-toggle');
  toggle.textContent = chosen ? 'Not player 2' : 'Make player 2';
  toggle.title = chosen ? `Player 2 is the game's own Luigi again, not ${outfit.name}` : `Player 2 plays as ${outfit.name} in Play co-op`;
}
$('outfit-coop-toggle').addEventListener('click', () => {
  const { active, coop } = state.outfits;
  window.smsMarioLook.flush();
  state.outfits.coop = coop === active ? null : active;
  disarmDelete();
  saveOutfits();
  renderOutfits();
});

// --- Portraits: each outfit's character drawn from its own model (portraits.js), Mario in the outfit's
// colours. main.js keeps them, so each is drawn once; until then a character shows its initial.

const portraits = new Map(), wanted = new Map();
let drawing = null, portraitsOn = false;
// FNV-1a, for short names of a look and a model in portrait keys.
const hash = text => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
};
// Mario's portraits differ by look, the others' only by their model (their colours can't change yet).
// PORTRAIT_DRAWING goes up when the launcher draws models differently, so portraits drawn before are drawn
// again (2: the cap the game draws, ma_cap1, and faceted gloves drawn smooth).
const PORTRAIT_DRAWING = 2;
function portraitKey(id, look) {
  const { stamp } = characterOf(id);
  if (!stamp) return null;
  return `${id}-${hash(`${PORTRAIT_DRAWING} ${stamp}`)}${id === 'mario' ? `-${hash(JSON.stringify(Colors.slotLook(look)))}` : ''}`;
}

// Shows character `id` (in `look`) in an .outfit-icon; one still being drawn keeps the picture it had
// of the same character, or shows the initial.
function portrait(icon, id, look) {
  const key = portraitKey(id, look), url = key && portraits.get(key);
  const keep = icon.dataset.character === id && icon.querySelector('img');
  icon.dataset.portrait = key || '';
  icon.dataset.character = id;
  if (url) {
    const image = document.createElement('img');
    image.alt = '';
    image.src = url;
    icon.replaceChildren(image);
  } else if (!keep) {
    const initial = document.createElement('b');
    initial.textContent = (characterOf(id).name || '?').charAt(0);
    icon.replaceChildren(initial);
  }
  if (key && !url && !wanted.has(key)) {
    wanted.set(key, { id, look });
    drawing ||= drawWanted();
  }
}

// The portraits wanted: those kept from before, then the rest drawn one at a time while the tab is open.
async function drawWanted() {
  try {
    const kept = await window.sms.outfitPortraits([...wanted.keys()]).catch(() => ({}));
    for (const [key, url] of Object.entries(kept)) if (url) { portraits.set(key, url); wanted.delete(key); showPortrait(key); }
    for (const [key, { id, look }] of wanted) {
      if (!portraitsOn) break;
      wanted.delete(key);
      const url = await drawCharacter(id, look).catch(() => null);
      if (!url) continue;
      portraits.set(key, url);
      showPortrait(key);
      window.sms.saveOutfitPortrait(key, url).catch(() => {});
    }
  } finally {
    drawing = null;
    // asked for while the last ones were drawn
    if (portraitsOn && wanted.size) drawing = drawWanted();
    else releasePortraits();
  }
}

async function drawCharacter(id, look) {
  if (id === 'mario') return window.smsMarioLook.portrait(look);
  if (!characterOf(id).ready) return null;
  const model = state.modelId === id && state.model ? state.model : await window.sms.characterModel(id);
  const standing = model.animations.includes('ma_wait') ? 'ma_wait' : null;
  const clip = standing && (state.clips.get(`${id}:${standing}`) || await window.sms.characterAnimation(id, standing));
  return drawPortrait({ data: model, clip });
}

// The tabs' and the panel's pictures again, as a character is made.
function refreshPortraits() {
  if (!state.outfits) return;
  for (const icon of page.querySelectorAll('.outfit-tab .outfit-icon')) {
    const outfit = state.outfits.slots[Number(icon.closest('.outfit-tab').dataset.outfit)];
    if (outfit) portrait(icon, outfit.character, outfit.look);
  }
  if (worn()) portrait($('outfit-character-icon'), worn().character, worn().look);
}

function showPortrait(key) {
  for (const icon of page.querySelectorAll(`.outfit-icon[data-portrait="${key}"]`)) {
    const image = document.createElement('img');
    image.alt = '';
    image.src = portraits.get(key);
    icon.replaceChildren(image);
  }
}

// --- Character picker: who wears a new outfit, or the one worn.

$('outfit-character-change').addEventListener('click', event => { event.stopPropagation(); togglePicker('change', event.currentTarget); });

function togglePicker(mode, anchor) {
  if (picking === mode) { closePicker(); return; }
  picking = mode;
  const picker = $('outfit-picker'), body = page.querySelector('.characters-body');
  picker.hidden = false;
  renderPicker();
  // under what opened it, inside the page
  const at = anchor.getBoundingClientRect(), box = body.getBoundingClientRect();
  picker.style.top = `${at.bottom - box.top + 6}px`;
  picker.style.left = `${Math.max(8, Math.min(at.left - box.left - 12, box.width - picker.offsetWidth - 8))}px`;
  anchor.classList.add('pressed');
  picker.querySelector('button:not(:disabled)')?.focus();
}

function closePicker() {
  if (!picking) return;
  picking = null;
  $('outfit-picker').hidden = true;
  for (const pressed of page.querySelectorAll('.outfit-add.pressed, #outfit-character-change.pressed')) pressed.classList.remove('pressed');
}
document.addEventListener('click', event => { if (picking && !$('outfit-picker').contains(event.target)) closePicker(); });
document.addEventListener('keydown', event => { if (picking && event.key === 'Escape') closePicker(); });

function renderPicker() {
  if (!picking) return;
  const current = worn()?.character;
  $('outfit-picker-title').textContent = picking === 'new' ? 'New outfit: who wears it?' : `Who wears ${worn().name}?`;
  $('outfit-picker-list').replaceChildren(...state.characters.map(character => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outfit-pick';
    const note = building.has(character.id) ? 'Making…' : !character.ready && failed.has(character.id) ? 'Couldn\'t be made'
      : waiting(character) ? 'Needs Eclipse' : picking === 'change' && character.id === current ? 'Wearing' : '';
    button.innerHTML = '<span class="outfit-icon"></span><span class="outfit-pick-name"></span><small></small>';
    portrait(button.querySelector('.outfit-icon'), character.id, character.id === 'mario' ? worn()?.look : null);
    button.querySelector('.outfit-pick-name').textContent = character.name;
    button.querySelector('small').textContent = note;
    button.classList.toggle('current', picking === 'change' && character.id === current);
    // one that can't be made yet can't be worn yet
    button.disabled = waiting(character);
    if (waiting(character)) button.title = needsEclipse(character.name);
    button.addEventListener('click', () => {
      const mode = picking;
      closePicker();
      if (mode === 'new') addOutfit(character);
      else changeCharacter(character);
    });
    return button;
  }));
}

function renderAnimations() {
  const list = $('characters-animations');
  const filter = state.filter.trim().toLowerCase();
  const items = (state.model?.animations || []).map(name => ({ name, label: NAMES[name] || name }))
    .filter(({ name, label }) => !filter || name.includes(filter) || label.toLowerCase().includes(filter))
    .sort((a, b) => order(a.name) - order(b.name) || a.label.localeCompare(b.label));
  list.replaceChildren(...items.map(({ name, label }) => {
    const button = document.createElement('button');
    button.className = 'characters-anim';
    button.innerHTML = NAMES[name] ? `<span></span><small></small>` : '<span></span>';
    button.querySelector('span').textContent = label;
    if (NAMES[name]) button.querySelector('small').textContent = name;
    button.setAttribute('aria-pressed', String(name === state.animation));
    button.addEventListener('click', async () => {
      state.animation = name;
      state.frame = 0;
      renderAnimations();
      try { await loadClip(); viewer?.redraw(); }
      catch (error) { setStatus(error.message); }
    });
    return button;
  }));
}

function syncTransport() {
  const c = clip();
  $('characters-play').textContent = state.running ? 'Pause' : 'Play';
  $('characters-frame').value = String(state.frame);
  $('characters-frame-label').textContent = c ? `${Math.floor(state.frame) + 1} / ${c.frames}` : '';
}

$('characters-play').addEventListener('click', () => { state.running = !state.running; syncTransport(); viewer?.wake(); });
$('characters-frame').addEventListener('input', event => {
  state.running = false;
  state.frame = Number(event.target.value);
  syncTransport();
  viewer?.redraw();
});
$('characters-step-back').addEventListener('click', () => step(-1));
$('characters-step-ahead').addEventListener('click', () => step(1));
function step(by) {
  const c = clip();
  if (!c) return;
  state.running = false;
  state.frame = ((Math.round(state.frame) + by) % c.frames + c.frames) % c.frames;
  syncTransport();
  viewer?.redraw();
}
$('characters-speed').addEventListener('change', event => { state.speed = Number(event.target.value); });
$('characters-fludd').addEventListener('change', event => { state.showFludd = event.target.checked; rebuild(); });
$('characters-filter').addEventListener('input', event => { state.filter = event.target.value; renderAnimations(); });
$('characters-compare').addEventListener('change', async event => {
  state.compare = event.target.value;
  try {
    if (state.compare !== 'off' && !state.mario) {
      setStatus('Reading Mario from your disc…', true);
      state.mario = await window.sms.characterModel('mario');
    }
    await loadClip();
    rebuild();
  } catch (error) { setStatus(error.message); }
});
for (const [view, [yaw, pitch]] of Object.entries(VIEWS))
  $(`characters-view-${view}`).addEventListener('click', () => viewer?.look(yaw, pitch));

function setStatus(text, busy = false) {
  $('characters-status').hidden = !text;
  $('characters-status').classList.toggle('loading', busy);
  $('characters-status-text').textContent = text;
}

// --- Viewer --------------------------------------------------------------------

function createViewer(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  let disposed = false, running = false;
  canvas.addEventListener('webglcontextlost', () => {
    if (disposed) return;
    running = false;
    setStatus('The 3D view stopped. Restarting the launcher usually brings it back.');
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 20000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9fb4c0, 1.9));
  const sun = new THREE.DirectionalLight(0xffffff, 2.1);
  sun.position.set(-0.6, 1.4, 1.6);
  scene.add(sun);

  // The floor: Mario's own feet are on it at rest. A line every 50 units (a third of Mario).
  const grid = new THREE.GridHelper(600, 12, 0x2a7f8c, 0x9cc6cc);
  grid.material.transparent = true;
  grid.material.opacity = 0.7;
  scene.add(grid);
  const disposables = [grid.geometry, grid.material];

  // Shadow Mario's shimmer (character-model.js): his warp texture's scale and place, at the game's 30 frames a second
  const shimmer = { warpST: { value: new THREE.Vector4(1, 1, 0, 0) } };
  function stepShimmer(now) {
    const s = state.model?.shimmer;
    if (!s) return;
    const f = Math.floor(now / 1000 * 30) % s.frames;
    shimmer.warpST.value.fromArray(s.st, f * 4);
  }

  const figures = [];
  const character = addFigure(state.model, { id: state.id, x: 0 });
  if (comparing() && state.mario && state.id !== 'mario')
    figures.push(addFigure(state.mario, { id: 'mario', x: state.compare === 'beside' ? -90 : 0, ghost: state.compare === 'over' }));
  figures.unshift(character);
  if (state.compare === 'beside' && figures.length > 1) character.group.position.x = 90;

  function addFigure(data, { id, x, ghost = false }) {
    const gradient = new THREE.DataTexture(Uint8Array.from(data.toon, v => Math.round(Math.max(v, 0.6) * 255)), data.toon.length, 1, THREE.RedFormat);
    gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
    gradient.needsUpdate = true;
    disposables.push(gradient);
    const textures = data.textures.map(source => {
      const texture = new THREE.DataTexture(new Uint8Array(source.rgba), source.width, source.height, THREE.RGBAFormat);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = WRAP[source.wrapS] || THREE.ClampToEdgeWrapping;
      texture.wrapT = WRAP[source.wrapT] || THREE.ClampToEdgeWrapping;
      texture.magFilter = THREE.LinearFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
      disposables.push(texture);
      return texture;
    });
    const group = new THREE.Group();
    group.position.x = x;
    scene.add(group);
    const rig = createRig(data, shape => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(shape.position.length), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(shape.normal.length), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('uv', new THREE.BufferAttribute(shape.uv, 2));
      if (shape.color) geometry.setAttribute('color', new THREE.BufferAttribute(shape.color, 4));
      geometry.setIndex(new THREE.BufferAttribute(shape.index, 1));
      const side = shape.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
      // Shadow Mario: his own colour unlit, with a light blue shine
      const material = shape.shine && !ghost
        ? new THREE.MeshPhongMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: textures[shape.texture] || null,
          specular: 0x9dc2ff, shininess: 24, side })
        : new THREE.MeshToonMaterial({ map: shape.texture >= 0 ? textures[shape.texture] : null,
          vertexColors: Boolean(shape.color), transparent: ghost || shape.translucent, opacity: ghost ? 0.35 : 1,
          // see-through Mario is drawn over the character, never hidden behind it
          depthWrite: !ghost && !shape.translucent, depthTest: !ghost, alphaTest: shape.alphaTest || 0, gradientMap: gradient, side });
      if (shape.shine && !ghost && data.shimmer && shape.warp >= 0) bendByWarp(material, textures[shape.warp]);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      if (ghost) mesh.renderOrder = 1;
      group.add(mesh);
      disposables.push(geometry, material);
      return { shape, mesh, geometry };
    });
    const figure = { id, data, rig, group };
    if ((state.showFludd || !state.animations) && state.fluddRig && data.chest >= 0) addFludd(figure, ghost);
    return figure;
  }

  // His colour seen through his moving warp texture, as the game bends the screen behind him with it: the
  // colour looked up a little aside, and his light blue (his second colour) running over him where the warp
  // is brightest.
  function bendByWarp(material, warp) {
    if (!warp) return;
    warp.wrapS = warp.wrapT = THREE.RepeatWrapping;
    warp.colorSpace = THREE.NoColorSpace;
    material.onBeforeCompile = shader => {
      shader.uniforms.warpMap = { value: warp };
      shader.uniforms.warpST = shimmer.warpST;
      shader.fragmentShader = `uniform sampler2D warpMap;\nuniform vec4 warpST;\n${shader.fragmentShader}`.replace(
        'vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );',
        `vec4 warpTexel = texture2D( warpMap, vEmissiveMapUv * 3.0 * warpST.xy + warpST.zw );
        vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv + ( warpTexel.ra - 0.5 ) * 0.1 );
        emissiveColor.rgb = mix( emissiveColor.rgb * 0.8, vec3( 0.62, 0.76, 1.0 ), smoothstep( 0.55, 1.0, warpTexel.r ) * 0.55 );`);
    };
  }

  // FLUDD on a figure, as the game hangs it from the chest joint, at the character's own size and place.
  function addFludd(figure, ghost) {
    const textures = state.fluddRig.textures.map(source => {
      const texture = new THREE.DataTexture(new Uint8Array(source.rgba), source.width, source.height, THREE.RGBAFormat);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = WRAP[source.wrapS] || THREE.ClampToEdgeWrapping;
      texture.wrapT = WRAP[source.wrapT] || THREE.ClampToEdgeWrapping;
      texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.generateMipmaps = true;
      texture.needsUpdate = true;
      disposables.push(texture);
      return texture;
    });
    const make = shape => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(shape.position.length), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(shape.normal.length), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('uv', new THREE.BufferAttribute(shape.uv, 2));
      if (shape.color) geometry.setAttribute('color', new THREE.BufferAttribute(shape.color, 4));
      geometry.setIndex(new THREE.BufferAttribute(shape.index, 1));
      const material = new THREE.MeshToonMaterial({ map: shape.texture >= 0 ? textures[shape.texture] : null, vertexColors: Boolean(shape.color),
        transparent: ghost || shape.translucent, opacity: ghost ? 0.35 : 1, depthWrite: !ghost && !shape.translucent, depthTest: !ghost,
        side: shape.doubleSided ? THREE.DoubleSide : THREE.FrontSide });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      figure.group.add(mesh);
      disposables.push(geometry, material);
      return { shape, mesh, geometry };
    };
    figure.fludd = { pack: createRig(state.fluddRig.pack, make), nozzle: createRig(state.fluddRig.nozzle, make), place: figure.data.fludd };
  }
  const fluddBase = new THREE.Matrix4(), fluddStep = new THREE.Matrix4();
  function poseFludd(figure) {
    if (!figure.fludd) return;
    const { pack, nozzle, place } = figure.fludd, chest = figure.rig.world[figure.data.chest];
    // the character's place for it (port patch zzzzzz-character-05), then TWaterGun::setBaseTRMtx's roll
    // (back up to 33.75 degrees, less as the chest leans) and the character's size for it
    // (the chest joint's frame: x up the spine, y forward, z to the side; the tilt back turns about z, as the roll does)
    fluddBase.copy(chest).multiply(fluddStep.makeTranslation(...place.offset)).multiply(fluddStep.makeRotationZ(-place.tilt * Math.PI / 180));
    const roll = (-0x1800 + Math.abs(fluddBase.elements[1]) * 0x1800) * Math.PI / 0x8000;
    fluddBase.multiply(fluddStep.makeRotationZ(roll)).multiply(fluddStep.makeScale(place.scale, place.scale, place.scale));
    pack.pose(fluddBase);
    nozzle.pose(pack.world[nozzle.attach.joint]);
  }

  const local = new THREE.Matrix4(), trs = new Float32Array(9);
  function pose(figure, frame) {
    const c = clip(figure.id);
    const jointCount = figure.data.joints.length;
    if (!c) { figure.rig.pose(null); poseFludd(figure); return; }
    const { frames, values } = c, f0 = Math.floor(frame) % frames, f1 = (f0 + 1) % frames, t = frame - Math.floor(frame);
    figure.rig.pose(null, j => {
      for (let k = 0; k < 9; k++) {
        const a = values[(f0 * jointCount + j) * 9 + k], b = values[(f1 * jointCount + j) * 9 + k];
        trs[k] = k >= 3 && k < 6 ? a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t : a + (b - a) * t;
      }
      return jointMatrix(trs.subarray(0, 3), trs.subarray(3, 6), trs.subarray(6, 9), local);
    });
    poseFludd(figure);
  }

  // Framed on the taller of the character and Mario, at rest.
  character.rig.pose(null);
  const box = new THREE.Box3();
  for (const { mesh, geometry } of character.rig.meshes) { geometry.computeBoundingBox(); box.union(geometry.boundingBox); }
  const height = Math.max(box.max.y, MARIO_HEIGHT);
  const target = new THREE.Vector3(0, height * 0.45, 0);
  // Each animation is framed on the middle of the height its center joint
  // moves through (hanging from a ledge sits below the floor, which is the
  // ledge's top), plus what the player moved the view up or down.
  const centerJoint = state.model.joints.findIndex(joint => joint.name === 'center');
  const restCenter = centerJoint >= 0 ? state.model.joints[centerJoint].translation[1] : 0;
  let pan = 0;
  function framed() {
    const c = clip();
    if (!c || centerJoint < 0) return 0;
    if (c.shift === undefined) {
      let low = Infinity, high = -Infinity;
      const J = state.model.joints.length;
      for (let f = 0; f < c.frames; f++) {
        const y = c.values[(f * J + centerJoint) * 9 + 7];
        low = Math.min(low, y); high = Math.max(high, y);
      }
      c.shift = (low + high) / 2 - restCenter;
    }
    return c.shift;
  }
  const home = { yaw: 0.5, pitch: 0.12, distance: height * 3.2 };
  const view = { ...home, min: height * 0.6, max: height * 8 };

  function place() {
    const { yaw, pitch, distance } = view;
    target.y = height * 0.45 + framed() + pan;
    camera.position.set(target.x + Math.sin(yaw) * Math.cos(pitch) * distance, target.y + Math.sin(pitch) * distance,
      target.z + Math.cos(yaw) * Math.cos(pitch) * distance);
    camera.lookAt(target);
  }

  let dragging = null;
  canvas.addEventListener('pointerdown', event => {
    dragging = { x: event.clientX, y: event.clientY, pan: event.button === 2 || event.shiftKey };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!dragging) return;
    const dx = event.clientX - dragging.x, dy = event.clientY - dragging.y;
    if (dragging.pan) pan = Math.max(-height * 2, Math.min(height * 2, pan + dy * view.distance * 0.002));
    else {
      view.yaw -= dx * 0.01;
      view.pitch = Math.max(-0.6, Math.min(1.45, view.pitch + dy * 0.006));
    }
    dragging.x = event.clientX; dragging.y = event.clientY;
    redraw();
  });
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('pointerup', () => { dragging = null; });
  canvas.addEventListener('pointercancel', () => { dragging = null; });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    view.distance = Math.max(view.min, Math.min(view.max, view.distance * Math.exp(event.deltaY * 0.001)));
    redraw();
  }, { passive: false });
  canvas.addEventListener('keydown', event => {
    const turn = { ArrowLeft: [0.2, 0], ArrowRight: [-0.2, 0], ArrowUp: [0, 0.1], ArrowDown: [0, -0.1] }[event.key];
    if (event.key === ' ') { event.preventDefault(); $('characters-play').click(); return; }
    if (event.key === ',' || event.key === '.') { step(event.key === ',' ? -1 : 1); return; }
    if (!turn) return;
    event.preventDefault();
    view.yaw += turn[0];
    view.pitch = Math.max(-0.6, Math.min(1.45, view.pitch + turn[1]));
    redraw();
  });
  canvas.addEventListener('dblclick', () => { Object.assign(view, home); pan = 0; redraw(); });

  function resize() {
    const { clientWidth: width, clientHeight: height_ } = canvas.parentElement;
    if (!width || !height_) return;
    renderer.setSize(width, height_, false);
    camera.aspect = width / height_;
    camera.updateProjectionMatrix();
    redraw();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas.parentElement);

  function draw() {
    stepShimmer(performance.now());
    for (const figure of figures) pose(figure, state.frame);
    place();
    renderer.render(scene, camera);
  }
  // Plays at the animations' 30 frames a second while the page shows and the
  // launcher is in front; holds the last frame otherwise.
  let last = 0, background = document.hidden;
  function tick(now) {
    if (!running) return;
    if (background || !state.running) { running = false; draw(); return; }
    const c = clip();
    if (c && last) {
      state.frame = (state.frame + (now - last) / 1000 * 30 * state.speed) % c.frames;
      syncTransport();
    }
    last = now;
    draw();
    requestAnimationFrame(tick);
  }
  function wake() {
    if (running || disposed || background) return;
    running = true;
    last = 0;
    requestAnimationFrame(tick);
  }
  let queued = false;
  function redraw() {
    if (disposed) return;
    if (state.running && !background) { wake(); return; }
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; if (!disposed) draw(); });
  }
  const listening = new AbortController();
  window.addEventListener('blur', () => { background = true; }, { signal: listening.signal });
  window.addEventListener('focus', () => { background = false; wake(); }, { signal: listening.signal });
  document.addEventListener('visibilitychange', () => { background = document.hidden; if (!background) wake(); }, { signal: listening.signal });

  canvas.classList.add('ready');
  return {
    start() { resize(); wake(); redraw(); },
    wake() { wake(); redraw(); },
    redraw,
    look(yaw, pitch) { view.yaw = yaw; view.pitch = pitch; redraw(); },
    dispose() {
      disposed = true;
      running = false;
      listening.abort();
      observer.disconnect();
      for (const item of disposables) item.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
