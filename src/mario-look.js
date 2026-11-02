// Customize Mario: Mario from the player's disc, idling in 3D, repainted live
// as the player picks colours. Drag to turn him, scroll to zoom.
import * as THREE from '../node_modules/three/build/three.module.js';
import { createRig, jointMatrix } from './model-rig.js';

const Colors = window.SmsMarioColors;
const $ = id => document.getElementById(id);
const page = $('mario-look');
const GROUPS = [
  { title: 'Outfit', regions: ['hat', 'emblem', 'emblemLetter', 'shirt', 'overalls', 'buttons', 'gloves', 'shoes'] },
  { title: 'Face', regions: ['skin', 'hair', 'eyebrows', 'mustache', 'eyes'] },
];
// The colours that belong to FLUDD, and the rest (Mario's). Each one's presets
// change only its own.
const only = (colors, fludd) => Object.fromEntries(Object.entries(colors).filter(([id]) => Colors.FLUDD_REGIONS.includes(id) === fludd));
const WRAP = [THREE.ClampToEdgeWrapping, THREE.RepeatWrapping, THREE.MirroredRepeatWrapping];

let viewer = null, model = null, look = Colors.normalizeLook(), saveTimer = null, loading = null;
// Outfits: the player's named looks (up to six) and the one Mario wears; `renaming` is the outfit whose
// name is being typed, `deleting` a Delete waiting for its second press.
let outfits = Colors.normalizeOutfits(null, look), renaming = -1, deleting = null;

// Mario's colours are part of the Character tab (characters-page.js), which
// shows them while Mario is chosen. Nothing of Mario's view stays on the GPU
// while they're hidden: the launcher keeps no WebGL context while the game or
// a build runs.
window.smsMarioLook = {
  show() {
    if (model) show();
    else loading ||= load();
  },
  hide() {
    viewer?.dispose();
    viewer = null;
    if (saveTimer) { clearTimeout(saveTimer); save(); }
  }
};

async function load() {
  setStatus('Reading Mario from your disc…', true);
  try {
    const result = await window.sms.marioModel();
    model = result.model;
    look = Colors.normalizeLook(result.look);
    outfits = Colors.normalizeOutfits(result.outfits, look);
    renderControls();
    if (!page.hidden && !page.closest('.page').hidden) show();
    else setStatus('');
  } catch (error) {
    setStatus(error.message || String(error));
  } finally { loading = null; }
}

// Mario's view on a fresh canvas (a canvas whose context was let go can't
// make another), painted in the current look.
function show() {
  if (viewer) return;
  const canvas = $('mario-stage').cloneNode(false);
  canvas.classList.remove('ready');
  $('mario-stage').replaceWith(canvas);
  try { viewer = createViewer(canvas, model); }
  catch (_) {
    setStatus(`Mario's 3D view couldn't start. ${STUCK}`, false, true);
    return;
  }
  viewer.paint(look.colors);
  viewer.setAloha(look.aloha);
  viewer.setSunglasses(look.sunglasses);
  viewer.setFludd(look.fludd, look.nozzle);
  viewer.start();
  setStatus('');
  // Fade Mario in once his first frame is drawn.
  requestAnimationFrame(() => requestAnimationFrame(() => canvas.classList.add('ready')));
}

// A message over the stage; `loading` adds the spinner, `stuck` the ways to
// get the 3D view back.
function setStatus(text, loading = false, stuck = false) {
  $('mario-status-text').textContent = text;
  $('mario-status').classList.toggle('loading', loading);
  $('mario-status-actions').hidden = !stuck;
  $('mario-status').hidden = !text;
}

const STUCK = 'Try again, or restart the launcher to reset its graphics.';
$('mario-retry').addEventListener('click', () => {
  viewer?.dispose();
  viewer = null;
  setStatus('');
  show();
});
$('mario-relaunch').addEventListener('click', () => {
  $('mario-relaunch').disabled = true;
  window.sms.relaunchLauncher().catch(error => {
    $('mario-relaunch').disabled = false;
    setStatus(error.message || String(error), false, true);
  });
});

// Repaints at most once a frame while a colour picker is dragged.
let paintQueued = false;
function change(update) {
  update();
  keepInOutfit();
  if (!paintQueued) {
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      viewer?.paint(look.colors);
      viewer?.setAloha(look.aloha);
      viewer?.setSunglasses(look.sunglasses);
      viewer?.setFludd(look.fludd, look.nozzle);
    });
  }
  syncControls();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 300);
}
function save() {
  saveTimer = null;
  window.sms.saveMarioLook(look).catch(() => {});
}
// The look goes into the outfit Mario wears as it changes (main.js does the same with what it saves).
function keepInOutfit() {
  const { slots, active } = outfits;
  slots[active] = { ...slots[active], look: Colors.slotLook(look) };
}

// --- Panel -------------------------------------------------------------------

const originalColor = id => model?.references[Colors.REGIONS.findIndex(region => region.id === id)]?.color;

function swatch(id, onChange = () => {}) {
  const index = Colors.REGIONS.findIndex(region => region.id === id), original = model.references[index]?.color;
  if (!original) return null;
  const row = document.createElement('label');
  row.className = 'mario-swatch';
  row.dataset.region = id;
  row.innerHTML = '<span class="mario-swatch-name"></span><input type="color"><button type="button" class="mario-reset" aria-label="Use the original colour" title="Use the original colour">↺</button>';
  row.querySelector('.mario-swatch-name').textContent = Colors.REGIONS[index].label;
  const input = row.querySelector('input');
  input.setAttribute('aria-label', `${Colors.REGIONS[index].label} colour`);
  input.addEventListener('input', () => change(() => { look.colors = { ...look.colors, [id]: input.value }; onChange(); }));
  row.querySelector('button').addEventListener('click', event => {
    event.preventDefault();
    change(() => { const { [id]: _, ...rest } = look.colors; look.colors = rest; onChange(); });
  });
  return row;
}

$('mario-in-game').addEventListener('change', event => change(() => { look.inGame = event.target.checked; }));

// --- Outfits -------------------------------------------------------------------
// Tabs over Mario and his colours, one per outfit. Mario wears the open one and
// every change is saved into it, so there's nothing to save or load.

// The outfits already hold Mario's newest look (keepInOutfit), so a look save still waiting isn't needed.
function saveOutfits() {
  clearTimeout(saveTimer);
  saveTimer = null;
  window.sms.saveMarioOutfits({ ...outfits, inGame: look.inGame }).catch(() => {});
}

function wear(index) {
  if (index === outfits.active) return;
  outfits.active = index;
  renaming = -1;
  disarmDelete();
  change(() => { look = { ...look, ...Colors.slotLook(outfits.slots[index].look) }; });
  saveOutfits();
  renderOutfits();
}

// A new outfit starts as a copy of the one Mario wears, ready to be named.
function addOutfit() {
  const index = outfits.slots.indexOf(null);
  if (index < 0) return;
  outfits.slots[index] = { name: Colors.outfitName(index), look: Colors.slotLook(look) };
  outfits.active = index;
  renaming = index;
  disarmDelete();
  saveOutfits();
  renderOutfits();
  syncControls();
}

function rename(index, name) {
  renaming = -1;
  const trimmed = name.trim().slice(0, Colors.SLOT_NAME_LENGTH);
  if (trimmed && outfits.slots[index]) {
    outfits.slots[index] = { ...outfits.slots[index], name: trimmed };
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
$('mario-outfit-delete').addEventListener('click', () => {
  if (outfits.slots.filter(Boolean).length < 2) return;
  if (!deleting) {
    deleting = setTimeout(() => { deleting = null; syncControls(); }, 3000);
    syncControls();
    return;
  }
  disarmDelete();
  const gone = outfits.active;
  outfits.slots[gone] = null;
  // Mario puts on the outfit beside it
  const next = outfits.slots.findIndex((slot, index) => slot && index > gone);
  outfits.active = next >= 0 ? next : outfits.slots.map(Boolean).lastIndexOf(true);
  change(() => { look = { ...look, ...Colors.slotLook(outfits.slots[outfits.active].look) }; });
  saveOutfits();
  renderOutfits();
});

// A little Mario in an outfit's colours, for its tab.
function bust(outfitLook) {
  const c = id => outfitLook.colors[id] || originalColor(id) || '#ccc';
  const aloha = outfitLook.aloha ? `<path d="M9 40Q9 30 16 28.5L18 40ZM31 40Q31 30 24 28.5L22 40Z" fill="${c('alohaShirt')}"/>` : '';
  const eyes = outfitLook.sunglasses
    ? '<rect x="13.2" y="16.2" width="5.6" height="3.6" rx="1.4" fill="#3c4fd8"/><rect x="21.2" y="16.2" width="5.6" height="3.6" rx="1.4" fill="#3c4fd8"/>'
    : `<ellipse cx="17" cy="17.4" rx="1.3" ry="1.9" fill="${c('eyes')}"/><ellipse cx="23" cy="17.4" rx="1.3" ry="1.9" fill="${c('eyes')}"/>`;
  return `<svg class="mario-outfit-bust" viewBox="0 0 40 40" aria-hidden="true">
    <path d="M5 40Q5 28.5 20 27.5Q35 28.5 35 40Z" fill="${c('shirt')}"/>${aloha}
    <path d="M12.5 40L13.5 31H26.5L27.5 40Z" fill="${c('overalls')}"/>
    <path d="M13.8 31.5L11.5 27.8M26.2 31.5L28.5 27.8" stroke="${c('overalls')}" stroke-width="2.6" stroke-linecap="round"/>
    <circle cx="16" cy="32.6" r="1.5" fill="${c('buttons')}"/><circle cx="24" cy="32.6" r="1.5" fill="${c('buttons')}"/>
    <circle cx="20" cy="18.5" r="8.2" fill="${c('skin')}"/>
    <path d="M11.8 17Q11 21 13 22.5M28.2 17Q29 21 27 22.5" stroke="${c('hair')}" stroke-width="2" fill="none" stroke-linecap="round"/>${eyes}
    <path d="M14.5 22.6Q17 20.6 20 21.8Q23 20.6 25.5 22.6Q23 24.4 20 23.3Q17 24.4 14.5 22.6Z" fill="${c('mustache')}"/>
    <circle cx="20" cy="20.6" r="2.3" fill="${c('skin')}" stroke="#0002" stroke-width=".6"/>
    <path d="M10.5 15.2Q10.5 5.6 20 5.6Q29.5 5.6 29.5 15.2Z" fill="${c('hat')}"/>
    <path d="M8.6 15.6Q20 12.6 31.4 15.6Q20 17.6 8.6 15.6Z" fill="${c('hat')}" stroke="#0002" stroke-width=".6"/>
    <circle cx="20" cy="10.4" r="3" fill="${c('emblem')}"/>
  </svg>`;
}

function renderOutfits() {
  const strip = $('mario-outfits');
  const tabs = outfits.slots.map((slot, index) => {
    if (!slot) return null;
    const open = index === outfits.active;
    const tab = document.createElement('div');
    tab.className = 'mario-outfit';
    tab.classList.toggle('open', open);
    tab.dataset.outfit = String(index);
    tab.innerHTML = `<button type="button" class="mario-outfit-wear" role="tab" aria-selected="${open}">${bust(slot.look)}<span class="mario-outfit-name"></span></button>`;
    tab.querySelector('.mario-outfit-name').textContent = slot.name;
    tab.querySelector('.mario-outfit-wear').title = open ? `${slot.name}: double-click to rename` : `Wear ${slot.name}`;
    tab.querySelector('.mario-outfit-wear').addEventListener('click', () => wear(index));
    tab.querySelector('.mario-outfit-wear').addEventListener('dblclick', () => { renaming = index; renderOutfits(); });
    if (open && renaming !== index) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'mario-outfit-rename';
      edit.textContent = '✎';
      edit.title = edit.ariaLabel = `Rename ${slot.name}`;
      edit.addEventListener('click', () => { renaming = index; renderOutfits(); });
      tab.append(edit);
    }
    if (renaming === index) {
      const input = document.createElement('input');
      input.className = 'mario-outfit-input';
      input.maxLength = Colors.SLOT_NAME_LENGTH;
      input.value = slot.name;
      input.spellcheck = false;
      input.ariaLabel = 'Outfit name';
      let done = false;
      const finish = keep => { if (done) return; done = true; rename(index, keep ? input.value : ''); };
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); finish(true); }
        if (event.key === 'Escape') { event.preventDefault(); finish(false); }
      });
      input.addEventListener('blur', () => finish(true));
      tab.querySelector('.mario-outfit-name').replaceWith(input);
      requestAnimationFrame(() => { input.focus(); input.select(); });
    }
    return tab;
  }).filter(Boolean);
  if (outfits.slots.includes(null)) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'mario-outfit-add';
    add.innerHTML = '<span aria-hidden="true">+</span>New outfit';
    add.title = 'A new outfit, starting as a copy of this one';
    add.addEventListener('click', addOutfit);
    tabs.push(add);
  }
  strip.replaceChildren(...tabs);
}

// Keeps the open tab's picture in step with Mario as he changes.
function syncOutfits() {
  const tab = document.querySelector(`.mario-outfit[data-outfit="${outfits.active}"]`);
  if (tab) tab.querySelector('.mario-outfit-bust').outerHTML = bust(outfits.slots[outfits.active].look);
  const name = outfits.slots[outfits.active].name, only = outfits.slots.filter(Boolean).length < 2;
  $('mario-outfit-note-name').textContent = name;
  $('mario-outfit-delete').hidden = only;
  $('mario-outfit-delete').textContent = deleting ? `Delete ${name}?` : 'Delete';
  $('mario-outfit-delete').classList.toggle('armed', Boolean(deleting));
}

// A row of preset buttons; `fludd` presets replace FLUDD's colours, the others Mario's.
function presetButtons(presets, fludd, onChange = () => {}) {
  return presets.map(preset => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mario-preset';
    button.dataset.preset = preset.id;
    button.dataset.fludd = String(fludd);
    button.textContent = preset.label;
    button.addEventListener('click', () => change(() => { look.colors = { ...only(look.colors, !fludd), ...preset.colors }; onChange(); }));
    return button;
  });
}

function renderControls() {
  renderOutfits();
  $('mario-presets').replaceChildren(...presetButtons(Colors.PRESETS, false));
  const list = $('mario-regions');
  list.replaceChildren();
  for (const group of GROUPS) {
    const heading = document.createElement('h2');
    heading.className = 'group-title';
    heading.textContent = group.title;
    const box = document.createElement('div');
    box.className = 'mario-swatches';
    box.append(...group.regions.map(id => swatch(id)).filter(Boolean));
    list.append(heading, box);
  }
  // What Mario always wears, here and in the game (ext/outfit), each on its own.
  const heading = document.createElement('h2');
  heading.className = 'group-title';
  heading.textContent = 'Shine shirt and sunglasses';
  const box = document.createElement('div');
  box.className = 'mario-swatches';
  const wearing = (id, title, note, key) => {
    const toggle = document.createElement('label');
    toggle.className = 'switch mario-aloha';
    toggle.innerHTML = `<span><strong>${title}</strong><small>${note}</small></span><input id="${id}" type="checkbox"><i></i>`;
    toggle.querySelector('input').addEventListener('change', event => change(() => { look[key] = event.target.checked; }));
    return toggle;
  };
  box.append(
    wearing('mario-aloha', 'Always wear the Shine shirt', 'In every stage, with or without the sunglasses, in Super Mario Eclipse too. In the game it usually comes with the sunglasses, once Mario has earned it.', 'aloha'),
    swatch('alohaShirt') || '',
    wearing('mario-sunglasses', 'Always wear sunglasses', 'In every stage, not only after the sunglasses stand, in Super Mario Eclipse too. The screen keeps its usual brightness.', 'sunglasses'));
  list.append(heading, box);

  const fluddHeading = document.createElement('h2');
  fluddHeading.className = 'group-title';
  fluddHeading.textContent = 'FLUDD';
  const fluddBox = document.createElement('div');
  fluddBox.className = 'mario-swatches';
  const wear = document.createElement('label');
  wear.className = 'switch mario-aloha';
  wear.innerHTML = '<span><strong>Wear FLUDD</strong><small>See FLUDD on Mario here, with the nozzle you pick. FLUDD\'s colours show in the game either way.</small></span><input id="mario-fludd" type="checkbox"><i></i>';
  wear.querySelector('input').addEventListener('change', event => change(() => { look.fludd = event.target.checked; }));
  const picker = document.createElement('div');
  picker.id = 'mario-nozzles';
  picker.className = 'mario-presets mario-nozzles';
  picker.setAttribute('role', 'group');
  picker.setAttribute('aria-label', 'Nozzle');
  picker.append(...Colors.NOZZLES.map(nozzle => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mario-preset';
    button.dataset.nozzle = nozzle.id;
    button.textContent = nozzle.label;
    button.addEventListener('click', () => change(() => { look.nozzle = nozzle.id; }));
    return button;
  }));
  // Picking FLUDD's colours puts FLUDD on Mario, to see them.
  const wearFludd = () => { look.fludd = true; };
  const fluddPresets = document.createElement('div');
  fluddPresets.className = 'mario-presets mario-fludd-presets';
  fluddPresets.setAttribute('role', 'group');
  fluddPresets.setAttribute('aria-label', 'FLUDD presets');
  fluddPresets.append(...presetButtons(Colors.FLUDD_PRESETS, true, wearFludd));
  fluddBox.append(wear, picker, fluddPresets, ...Colors.FLUDD_REGIONS.map(id => swatch(id, wearFludd)).filter(Boolean));
  list.append(fluddHeading, fluddBox);
  syncControls();
}

function syncControls() {
  for (const row of document.querySelectorAll('.mario-swatch')) {
    const id = row.dataset.region, index = Colors.REGIONS.findIndex(region => region.id === id);
    const value = look.colors[id] || model.references[index].color;
    const input = row.querySelector('input');
    if (input.value !== value) input.value = value;
    row.classList.toggle('changed', Boolean(look.colors[id]));
  }
  for (const button of document.querySelectorAll('.mario-preset[data-preset]')) {
    const fludd = button.dataset.fludd === 'true', presets = fludd ? Colors.FLUDD_PRESETS : Colors.PRESETS;
    const preset = presets.find(p => p.id === button.dataset.preset).colors, mine = only(look.colors, fludd);
    const active = Object.keys(preset).length === Object.keys(mine).length && Object.keys(preset).every(id => preset[id] === mine[id]);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  syncOutfits();
  $('mario-in-game').checked = look.inGame;
  $('mario-preview-note').textContent = look.inGame ? 'Your colours show in the game the next time it starts.'
    : 'The game shows Mario as usual: Use in the game is off.';
  const aloha = $('mario-aloha');
  if (aloha) aloha.checked = look.aloha;
  for (const row of document.querySelectorAll('.mario-swatch[data-region="alohaShirt"]')) row.hidden = !look.aloha;
  const sunglasses = $('mario-sunglasses');
  if (sunglasses) sunglasses.checked = look.sunglasses;
  const fludd = $('mario-fludd');
  if (fludd) fludd.checked = look.fludd;
  const nozzles = $('mario-nozzles');
  if (nozzles) {
    nozzles.hidden = !look.fludd;
    for (const button of nozzles.querySelectorAll('[data-nozzle]')) {
      button.classList.toggle('active', button.dataset.nozzle === look.nozzle);
      button.setAttribute('aria-pressed', String(button.dataset.nozzle === look.nozzle));
    }
  }
}

// --- Viewer --------------------------------------------------------------------

function createViewer(canvas, data) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  // The GPU process can go away (a driver reset, or a crash): say so rather than freeze.
  let disposed = false;
  canvas.addEventListener('webglcontextlost', () => {
    if (disposed) return;
    running = false;
    setStatus(`Mario's 3D view stopped. ${STUCK}`, false, true);
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 1, 1, 10000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9fb4c0, 1.9));
  const sun = new THREE.DirectionalLight(0xffffff, 2.1);
  sun.position.set(-0.6, 1.4, 1.6);
  scene.add(sun);

  // The game's cel shading: its toon ramp's two greys.
  const gradient = new THREE.DataTexture(Uint8Array.from(data.toon, v => Math.round(Math.max(v, 0.6) * 255)), data.toon.length, 1, THREE.RedFormat);
  gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
  gradient.needsUpdate = true;

  const textures = data.textures.map(source => {
    const pixels = new Uint8Array(source.rgba.length);
    const texture = new THREE.DataTexture(pixels, source.width, source.height, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = WRAP[source.wrapS] || THREE.ClampToEdgeWrapping;
    texture.wrapT = WRAP[source.wrapT] || THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    return { source, pixels, texture };
  });

  const mario = new THREE.Group();
  scene.add(mario);
  function makeMesh(shape) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(shape.position.length), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(shape.normal.length), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('uv', new THREE.BufferAttribute(shape.uv, 2));
    if (shape.color) geometry.setAttribute('color', new THREE.BufferAttribute(shape.color, 4));
    geometry.setIndex(new THREE.BufferAttribute(shape.index, 1));
    // FLUDD's tank has no texture: its colour and see-through come from its vertices.
    const material = new THREE.MeshToonMaterial({ map: shape.texture >= 0 ? textures[shape.texture].texture : null,
      vertexColors: Boolean(shape.color), transparent: shape.translucent, depthWrite: !shape.translucent, alphaTest: shape.alphaTest || 0,
      gradientMap: gradient, side: shape.doubleSided ? THREE.DoubleSide : THREE.FrontSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mario.add(mesh);
    return { shape, mesh, geometry };
  }

  // Mario idles; FLUDD rides on his chest, tilted as the game tilts it, with
  // the chosen nozzle on FLUDD's nozzle_center.
  const body = createRig(data, makeMesh);
  const pack = createRig(data.fludd.pack, makeMesh);
  const nozzles = Object.fromEntries(Object.entries(data.fludd.nozzles).map(([id, rig]) => [id, createRig(rig, makeMesh)]));
  const fludd = { on: false, nozzle: 'spray' };
  // The sunglasses, on his M_head joint (a disc without them shows none).
  const sunglasses = data.sunglasses && createRig(data.sunglasses, makeMesh);
  let wearingSunglasses = false;
  sunglasses?.setVisible(false);
  const showFludd = () => {
    pack.setVisible(fludd.on);
    for (const [id, nozzle] of Object.entries(nozzles)) nozzle.setVisible(fludd.on && id === fludd.nozzle);
  };
  showFludd();

  const jointCount = data.joints.length, local = new THREE.Matrix4(), trs = new Float32Array(9);
  const packBase = new THREE.Matrix4(), tilt = new THREE.Matrix4();
  function pose(frame) {
    const { frames, values } = data.idle, f0 = Math.floor(frame) % frames, f1 = (f0 + 1) % frames, t = frame - Math.floor(frame);
    body.pose(null, j => {
      for (let k = 0; k < 9; k++) {
        const a = values[(f0 * jointCount + j) * 9 + k], b = values[(f1 * jointCount + j) * 9 + k];
        // Rotations take the short way round between frames.
        trs[k] = k >= 3 && k < 6 ? a + (Math.atan2(Math.sin(b - a), Math.cos(b - a))) * t : a + (b - a) * t;
      }
      return jointMatrix(trs.subarray(0, 3), trs.subarray(3, 6), trs.subarray(6, 9), local);
    });
    if (wearingSunglasses) sunglasses.pose(body.world[sunglasses.attach.joint]);
    if (!fludd.on) return;
    // TWaterGun::setBaseTRMtx: rolled back up to 33.75 degrees, less as the chest leans.
    const chest = body.world[pack.attach.joint];
    const roll = (-0x1800 + Math.abs(chest.elements[1]) * 0x1800) * Math.PI / 0x8000;
    pack.pose(packBase.multiplyMatrices(chest, tilt.makeRotationZ(roll)));
    const nozzle = nozzles[fludd.nozzle];
    nozzle.pose(pack.world[nozzle.attach.joint]);
  }

  // Frame Mario from his first pose, with room for FLUDD and its tallest
  // nozzle so the view doesn't jump when FLUDD goes on.
  const box = new THREE.Box3();
  const grow = meshes => { for (const { mesh, geometry } of meshes) if (mesh.visible) { geometry.computeBoundingBox(); box.union(geometry.boundingBox); } };
  fludd.on = true;
  for (const id of Object.keys(nozzles)) {
    fludd.nozzle = id;
    showFludd();
    pose(0);
    grow(pack.meshes);
    grow(nozzles[id].meshes);
  }
  Object.assign(fludd, { on: false, nozzle: 'spray' });
  showFludd();
  grow(body.meshes);
  const center = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  mario.position.set(-center.x, -center.y, -center.z);
  const turntable = new THREE.Group();
  scene.remove(mario);
  turntable.add(mario);
  scene.add(turntable);
  const view = { yaw: -0.45, pitch: 0.12, distance: size.y * 2.6, min: size.y * 1.1, max: size.y * 5 };

  function place() {
    turntable.rotation.y = view.yaw;
    camera.position.set(0, Math.sin(view.pitch) * view.distance, Math.cos(view.pitch) * view.distance);
    camera.lookAt(0, 0, 0);
  }

  let dragging = null;
  canvas.addEventListener('pointerdown', event => { dragging = { x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); });
  canvas.addEventListener('pointermove', event => {
    if (!dragging) return;
    view.yaw += (event.clientX - dragging.x) * 0.01;
    view.pitch = Math.max(-0.7, Math.min(1.1, view.pitch + (event.clientY - dragging.y) * 0.006));
    dragging = { x: event.clientX, y: event.clientY };
  });
  canvas.addEventListener('pointerup', () => { dragging = null; });
  canvas.addEventListener('pointercancel', () => { dragging = null; });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    view.distance = Math.max(view.min, Math.min(view.max, view.distance * Math.exp(event.deltaY * 0.001)));
  }, { passive: false });
  canvas.addEventListener('keydown', event => {
    const step = { ArrowLeft: [-0.2, 0], ArrowRight: [0.2, 0], ArrowUp: [0, -0.1], ArrowDown: [0, 0.1] }[event.key];
    if (!step) return;
    event.preventDefault();
    view.yaw += step[0];
    view.pitch = Math.max(-0.7, Math.min(1.1, view.pitch + step[1]));
  });
  canvas.addEventListener('dblclick', () => { view.yaw = -0.45; view.pitch = 0.12; view.distance = size.y * 2.6; });

  function resize() {
    const { clientWidth: width, clientHeight: height } = canvas.parentElement;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    redraw();  // a new size clears the canvas, even while Mario holds still
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas.parentElement);

  // Every frame drawn costs the GPU, and some drivers give out under a steady
  // load (a Windows 7 PC's launcher GPU process crashed after sitting on
  // Customize Mario). So Mario idles at the animation's own 30 fps for IDLE_MS
  // after the player last did something, then holds still (the last frame
  // stays on the canvas) until they move over him, drag, scroll, press a key or
  // change something; nothing is animated while the launcher is in the
  // background, as when the game runs in front of it.
  const IDLE_MS = 15000;
  let wanted = false, running = false, started = 0, frame = 0, lastDraw = -Infinity;
  let lastActive = performance.now(), background = document.hidden;
  const listening = new AbortController();
  const draw = now => {
    // requestAnimationFrame times can fall just before start(): wrap, never negative.
    const frames = data.idle.frames;
    frame = (((now - started) / 1000 * data.idle.fps) % frames + frames) % frames;
    pose(frame);
    place();
    renderer.render(scene, camera);
    lastDraw = now;
  };
  function tick(now) {
    if (!running) return;
    if (!wanted || background || now - lastActive > IDLE_MS) { running = false; return; }
    if (dragging || now - lastDraw >= 1000 / data.idle.fps - 2) draw(now);
    requestAnimationFrame(tick);
  }
  function wake() {
    lastActive = performance.now();
    if (!wanted || running || background || disposed) return;
    running = true;
    started = performance.now() - frame / data.idle.fps * 1000;
    requestAnimationFrame(tick);
  }
  // One frame for a change made while Mario holds still (or in the background,
  // as while the system colour picker is open).
  let redrawQueued = false;
  function redraw() {
    wake();
    if (running || redrawQueued || disposed) return;
    redrawQueued = true;
    requestAnimationFrame(now => {
      redrawQueued = false;
      if (!disposed) draw(started + frame / data.idle.fps * 1000);
    });
  }
  for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'dblclick'])
    canvas.addEventListener(type, wake, { passive: true });
  window.addEventListener('blur', () => { background = true; }, { signal: listening.signal });
  window.addEventListener('focus', () => { background = false; wake(); }, { signal: listening.signal });
  document.addEventListener('visibilitychange', () => { background = document.hidden; wake(); }, { signal: listening.signal });

  return {
    start() {
      wanted = true;
      resize();
      wake();
      redraw();
    },
    stop() { wanted = false; running = false; },
    // Frees every GPU resource and the WebGL context itself.
    dispose() {
      disposed = true;
      running = false;
      wanted = false;
      listening.abort();
      observer.disconnect();
      scene.traverse(object => {
        if (!object.isMesh) return;
        object.geometry.dispose();
        object.material.dispose();
      });
      for (const { texture } of textures) texture.dispose();
      gradient.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
    paint(colors) {
      for (const { source, pixels, texture } of textures) {
        Colors.recolor(source, data.references, colors, pixels);
        texture.needsUpdate = true;
      }
      redraw();
    },
    setAloha(on) {
      for (const { shape, mesh } of body.meshes) if (shape.part === 'aloha') mesh.visible = on;
      redraw();
    },
    setSunglasses(on) {
      wearingSunglasses = Boolean(on && sunglasses);
      sunglasses?.setVisible(wearingSunglasses);
      redraw();
    },
    setFludd(on, nozzle) {
      fludd.on = on;
      fludd.nozzle = nozzles[nozzle] ? nozzle : 'spray';
      showFludd();
      redraw();
    },
  };
}
