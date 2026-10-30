// Characters: Mario from the player's disc and each character pack in the
// game's mods/characters/, drawn from its own model.szs and posed by any of the
// animations in it, frame by frame, with the floor under it and Mario beside
// it or over it for comparison. Drag to turn, scroll to zoom.
import * as THREE from '../node_modules/three/build/three.module.js';
import { createRig, jointMatrix } from './model-rig.js';

const $ = id => document.getElementById(id);
const page = $('page-characters');
const WRAP = [THREE.ClampToEdgeWrapping, THREE.RepeatWrapping, THREE.MirroredRepeatWrapping];
// Mario's height with his cap, the floor's scale.
const MARIO_HEIGHT = 150;
// Names for the animations players will look for first; the rest show their file names.
const NAMES = {
  ma_wait: 'Standing', ma_run1: 'Running', ma_run2: 'Running (fast)', ma_jump: 'Jump', ma_2jmp1: 'Double jump',
  ma_tjmp1: 'Triple jump (rise)', ma_tjmp2: 'Triple jump (flip)', ma_hipat: 'Ground pound', ma_hang: 'Hanging from a ledge',
  ma_swim: 'Swimming', ma_swim_wait: 'Treading water', ma_sleep: 'Sleeping', ma_die: 'Losing a life', ma_roll: 'Roll',
  ma_slip: 'Slipping', ma_dive_wait: 'Belly slide', ma_sit_wait: 'Sitting', ma_tree_climb: 'Climbing a pole',
  ma_fence_wait: 'On a fence', ma_rope_wait: 'On a tightrope', ma_demo_shine_get: 'Shine get', ma_pump: 'Spraying',
  ma_turn: 'Turning round', ma_brake: 'Skidding', ma_land: 'Landing', ma_jkick: 'Jump kick',
};
// Named animations first, in NAMES' order (Standing first), then the rest by file name.
const ORDER = Object.keys(NAMES);
const order = name => (ORDER.includes(name) ? ORDER.indexOf(name) : ORDER.length);
const VIEWS = { front: [0, 0.1], side: [Math.PI / 2, 0.1], back: [Math.PI, 0.1], above: [0.6, 0.9] };

const state = {
  characters: [], id: null, model: null, animation: 'ma_wait', clips: new Map(), mario: null, compare: 'off',
  frame: 0, playing: true, speed: 1, filter: '',
};
let viewer = null, loading = null;

window.smsOnPage('characters', {
  show() { loading ||= start(); },
  hide() {
    viewer?.dispose();
    viewer = null;
  },
});

async function start() {
  try {
    if (!state.characters.length) {
      setStatus('Looking for characters…', true);
      const { characters } = await window.sms.characters();
      state.characters = characters;
      renderList();
    }
    await choose(state.id || state.characters[0].id);
  } catch (error) {
    setStatus(error.message || String(error));
  } finally { loading = null; }
}

// --- Loading -------------------------------------------------------------------

async function choose(id) {
  setStatus('Reading the character…', true);
  state.id = id;
  renderList();
  const model = await window.sms.characterModel(id);
  if (state.id !== id) return;
  state.model = model;
  state.clips = new Map();
  if (!model.animations.includes(state.animation)) state.animation = model.animations.includes('ma_wait') ? 'ma_wait' : model.animations[0];
  if (state.compare !== 'off' && !state.mario) state.mario = await window.sms.characterModel('mario');
  await loadClip();
  renderAnimations();
  rebuild();
}

async function loadClip() {
  const key = `${state.id}:${state.animation}`;
  if (!state.clips.has(key)) state.clips.set(key, await window.sms.characterAnimation(state.id, state.animation));
  if (state.compare !== 'off' && state.mario?.animations.includes(state.animation)) {
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
  if (page.hidden || !state.model) return;
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
  const removeButton = $('characters-remove');
  removeButton.hidden = !state.id || state.id === 'mario';
  removeButton.textContent = `Remove ${state.characters.find(c => c.id === state.id)?.name || ''}`;
  const list = $('characters-list');
  list.replaceChildren(...state.characters.map(({ id, name }) => {
    const button = document.createElement('button');
    button.className = 'characters-item';
    button.textContent = name;
    button.setAttribute('aria-pressed', String(id === state.id));
    button.addEventListener('click', () => { if (id !== state.id) choose(id).catch(error => setStatus(error.message)); });
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

// --- Adding and removing characters ----------------------------------------------

async function add(kind, files = null) {
  notice('');
  try {
    const { added, problems } = await window.sms.characterAdd(kind, files);
    if (added.length) {
      const { characters } = await window.sms.characters();
      state.characters = characters;
      renderList();
      await choose(added[0]);
    }
    const names = added.map(id => state.characters.find(c => c.id === id)?.name || id);
    notice([added.length ? `Added ${names.join(', ')}.` : '', ...problems].filter(Boolean).join('\n'), problems.length > 0);
  } catch (error) { notice(error.message || String(error), true); }
}

async function remove() {
  const character = state.characters.find(c => c.id === state.id);
  if (!character || character.id === 'mario') return;
  try {
    const { removed } = await window.sms.characterRemove(character.id);
    if (!removed) return;
    const { characters } = await window.sms.characters();
    state.characters = characters;
    notice(`Removed ${character.name}.`);
    await choose('mario');
  } catch (error) { notice(error.message || String(error), true); }
}

function notice(text, problem = false) {
  $('characters-notice').textContent = text;
  $('characters-notice').classList.toggle('problem', problem);
}

$('characters-add').addEventListener('click', () => add('file'));
$('characters-add-folder').addEventListener('click', () => add('folder'));
$('characters-remove').addEventListener('click', remove);
page.addEventListener('dragover', event => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  page.classList.add('dropping');
});
page.addEventListener('dragleave', event => { if (!page.contains(event.relatedTarget)) page.classList.remove('dropping'); });
page.addEventListener('drop', event => {
  event.preventDefault();
  page.classList.remove('dropping');
  if (event.dataTransfer?.files.length) add('drop', event.dataTransfer.files);
});

function syncTransport() {
  const c = clip();
  $('characters-play').textContent = state.playing ? 'Pause' : 'Play';
  $('characters-frame').value = String(state.frame);
  $('characters-frame-label').textContent = c ? `${Math.floor(state.frame) + 1} / ${c.frames}` : '';
}

$('characters-play').addEventListener('click', () => { state.playing = !state.playing; syncTransport(); viewer?.wake(); });
$('characters-frame').addEventListener('input', event => {
  state.playing = false;
  state.frame = Number(event.target.value);
  syncTransport();
  viewer?.redraw();
});
$('characters-step-back').addEventListener('click', () => step(-1));
$('characters-step-ahead').addEventListener('click', () => step(1));
function step(by) {
  const c = clip();
  if (!c) return;
  state.playing = false;
  state.frame = ((Math.round(state.frame) + by) % c.frames + c.frames) % c.frames;
  syncTransport();
  viewer?.redraw();
}
$('characters-speed').addEventListener('change', event => { state.speed = Number(event.target.value); });
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

  const figures = [];
  const character = addFigure(state.model, { id: state.id, x: 0 });
  if (state.compare !== 'off' && state.mario && state.id !== 'mario')
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
      const material = new THREE.MeshToonMaterial({ map: shape.texture >= 0 ? textures[shape.texture] : null,
        vertexColors: Boolean(shape.color), transparent: ghost || shape.translucent, opacity: ghost ? 0.35 : 1,
        // see-through Mario is drawn over the character, never hidden behind it
        depthWrite: !ghost && !shape.translucent, depthTest: !ghost, alphaTest: shape.alphaTest || 0, gradientMap: gradient,
        side: shape.doubleSided ? THREE.DoubleSide : THREE.FrontSide });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      if (ghost) mesh.renderOrder = 1;
      group.add(mesh);
      disposables.push(geometry, material);
      return { shape, mesh, geometry };
    });
    return { id, data, rig, group };
  }

  const local = new THREE.Matrix4(), trs = new Float32Array(9);
  function pose(figure, frame) {
    const c = clip(figure.id);
    const jointCount = figure.data.joints.length;
    if (!c) { figure.rig.pose(null); return; }
    const { frames, values } = c, f0 = Math.floor(frame) % frames, f1 = (f0 + 1) % frames, t = frame - Math.floor(frame);
    figure.rig.pose(null, j => {
      for (let k = 0; k < 9; k++) {
        const a = values[(f0 * jointCount + j) * 9 + k], b = values[(f1 * jointCount + j) * 9 + k];
        trs[k] = k >= 3 && k < 6 ? a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t : a + (b - a) * t;
      }
      return jointMatrix(trs.subarray(0, 3), trs.subarray(3, 6), trs.subarray(6, 9), local);
    });
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
    for (const figure of figures) pose(figure, state.frame);
    place();
    renderer.render(scene, camera);
  }
  // Plays at the animations' 30 frames a second while the page shows and the
  // launcher is in front; holds the last frame otherwise.
  let last = 0, background = document.hidden;
  function tick(now) {
    if (!running) return;
    if (background || !state.playing) { running = false; draw(); return; }
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
    if (state.playing && !background) { wake(); return; }
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
