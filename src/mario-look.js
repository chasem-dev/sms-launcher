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

// The page is one of the launcher's tabs (renderer.js: showPage). Nothing of Mario's
// view stays on the GPU while another page shows: the launcher keeps no WebGL
// context while the game or a build runs.
window.smsOnPage('mario', {
  show() {
    if (model) show();
    else loading ||= load();
  },
  hide() {
    viewer?.dispose();
    viewer = null;
    if (saveTimer) { clearTimeout(saveTimer); save(); }
  }
});

async function load() {
  setStatus('Reading Mario from your disc…', true);
  try {
    const result = await window.sms.marioModel();
    model = result.model;
    look = Colors.normalizeLook(result.look);
    renderControls();
    if (!page.hidden) show();
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

// --- Panel -------------------------------------------------------------------

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
