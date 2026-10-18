// Customize Mario: Mario from the player's disc, idling in 3D, repainted live
// as the player picks colours. Drag to turn him, scroll to zoom.
import * as THREE from '../node_modules/three/build/three.module.js';

const Colors = window.SmsMarioColors;
const $ = id => document.getElementById(id);
const page = $('mario-look');
const GROUPS = [
  { title: 'Outfit', regions: ['hat', 'emblem', 'emblemLetter', 'shirt', 'overalls', 'buttons', 'gloves', 'shoes'] },
  { title: 'Face', regions: ['skin', 'hair', 'eyebrows', 'mustache', 'eyes'] },
];
const WRAP = [THREE.ClampToEdgeWrapping, THREE.RepeatWrapping, THREE.MirroredRepeatWrapping];

let viewer = null, model = null, look = Colors.normalizeLook(), saveTimer = null, loading = null;

// The page is one of the rail's (renderer.js: showPage). Nothing of Mario's
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
    setStatus("Your graphics driver can't show Mario in 3D here. Updating it may help.");
    return;
  }
  viewer.paint(look.colors);
  viewer.setAloha(look.aloha);
  viewer.setFludd(look.fludd, look.nozzle);
  viewer.start();
  setStatus('');
  // Fade Mario in once his first frame is drawn.
  requestAnimationFrame(() => requestAnimationFrame(() => canvas.classList.add('ready')));
}

// A message over the stage; `loading` adds the spinner.
function setStatus(text, loading = false) {
  $('mario-status-text').textContent = text;
  $('mario-status').classList.toggle('loading', loading);
  $('mario-status').hidden = !text;
}

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

function swatch(id) {
  const index = Colors.REGIONS.findIndex(region => region.id === id), original = model.references[index]?.color;
  if (!original) return null;
  const row = document.createElement('label');
  row.className = 'mario-swatch';
  row.dataset.region = id;
  row.innerHTML = '<span class="mario-swatch-name"></span><input type="color"><button type="button" class="mario-reset" aria-label="Use the original colour" title="Use the original colour">↺</button>';
  row.querySelector('.mario-swatch-name').textContent = Colors.REGIONS[index].label;
  const input = row.querySelector('input');
  input.setAttribute('aria-label', `${Colors.REGIONS[index].label} colour`);
  input.addEventListener('input', () => change(() => { look.colors = { ...look.colors, [id]: input.value }; }));
  row.querySelector('button').addEventListener('click', event => {
    event.preventDefault();
    change(() => { const { [id]: _, ...rest } = look.colors; look.colors = rest; });
  });
  return row;
}

function renderControls() {
  const presets = $('mario-presets');
  presets.replaceChildren(...Colors.PRESETS.map(preset => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mario-preset';
    button.dataset.preset = preset.id;
    button.textContent = preset.label;
    button.addEventListener('click', () => change(() => { look.colors = { ...preset.colors }; }));
    return button;
  }));
  const list = $('mario-regions');
  list.replaceChildren();
  for (const group of GROUPS) {
    const heading = document.createElement('h2');
    heading.className = 'group-title';
    heading.textContent = group.title;
    const box = document.createElement('div');
    box.className = 'mario-swatches';
    box.append(...group.regions.map(swatch).filter(Boolean));
    list.append(heading, box);
  }
  const heading = document.createElement('h2');
  heading.className = 'group-title';
  heading.textContent = 'Shine shirt';
  const box = document.createElement('div');
  box.className = 'mario-swatches';
  const toggle = document.createElement('label');
  toggle.className = 'switch mario-aloha';
  toggle.innerHTML = '<span><strong>Wear the Shine shirt</strong><small>The shirt Mario can buy in Sirena Beach.</small></span><input id="mario-aloha" type="checkbox"><i></i>';
  toggle.querySelector('input').addEventListener('change', event => change(() => { look.aloha = event.target.checked; }));
  box.append(toggle, swatch('alohaShirt') || '');
  list.append(heading, box);

  const fluddHeading = document.createElement('h2');
  fluddHeading.className = 'group-title';
  fluddHeading.textContent = 'FLUDD';
  const fluddBox = document.createElement('div');
  fluddBox.className = 'mario-swatches';
  const wear = document.createElement('label');
  wear.className = 'switch mario-aloha';
  wear.innerHTML = '<span><strong>Wear FLUDD</strong><small>The water pack, with the nozzle you pick.</small></span><input id="mario-fludd" type="checkbox"><i></i>';
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
  fluddBox.append(wear, picker);
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
  const key = JSON.stringify(look.colors);
  for (const button of document.querySelectorAll('.mario-preset[data-preset]'))
    button.classList.toggle('active', JSON.stringify(Colors.PRESETS.find(p => p.id === button.dataset.preset).colors) === key);
  const aloha = $('mario-aloha');
  if (aloha) aloha.checked = look.aloha;
  for (const row of document.querySelectorAll('.mario-swatch[data-region="alohaShirt"]')) row.hidden = !look.aloha;
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
    setStatus('Mario\'s 3D view stopped. Close Customize Mario and open it again.');
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
      vertexColors: Boolean(shape.color), transparent: shape.translucent, depthWrite: !shape.translucent,
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
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas.parentElement);

  let running = false, started = 0, frame = 0;
  function tick(now) {
    if (!running) return;
    // requestAnimationFrame times can fall just before start(): wrap, never negative.
    const frames = data.idle.frames;
    frame = (((now - started) / 1000 * data.idle.fps) % frames + frames) % frames;
    pose(frame);
    place();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }

  return {
    start() {
      if (running) return;
      running = true;
      started = performance.now() - frame / data.idle.fps * 1000;
      resize();
      requestAnimationFrame(tick);
    },
    stop() { running = false; },
    // Frees every GPU resource and the WebGL context itself.
    dispose() {
      disposed = true;
      running = false;
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
    },
    setAloha(on) { for (const { shape, mesh } of body.meshes) if (shape.part === 'aloha') mesh.visible = on; },
    setFludd(on, nozzle) {
      fludd.on = on;
      fludd.nozzle = nozzles[nozzle] ? nozzle : 'spray';
      showFludd();
    },
  };
}

// One posable model: its joints, CPU skinning, and its meshes.
function createRig(rig, makeMesh) {
  const order = jointOrder(rig.joints);
  const world = rig.joints.map(() => new THREE.Matrix4());
  const rest = rig.joints.map(joint => jointMatrix(joint.scale, joint.rotation, joint.translation, new THREE.Matrix4()));
  const inverseBind = rig.inverseBind.map(m => new THREE.Matrix4().fromArray(m));
  const drawMatrices = rig.draw.map(() => new THREE.Matrix4()), product = new THREE.Matrix4();
  const meshes = rig.shapes.map(makeMesh);
  return {
    meshes, world, attach: rig.attach,
    setVisible(on) { for (const { mesh } of meshes) mesh.visible = on; },
    // `base` places the root (or null); `localOf(joint)` gives an animated
    // joint's local matrix (or null for the rest pose).
    pose(base, localOf = null) {
      for (const j of order) {
        const local = localOf ? localOf(j) : rest[j], parent = rig.joints[j].parent;
        if (parent >= 0) world[j].multiplyMatrices(world[parent], local);
        else if (base) world[j].multiplyMatrices(base, local);
        else world[j].copy(local);
      }
      rig.draw.forEach((entry, d) => {
        const out = drawMatrices[d];
        if (!entry.weighted) { out.copy(world[entry.index]); return; }
        out.elements.fill(0);
        for (const { joint, weight } of rig.envelopes[entry.index]) {
          product.multiplyMatrices(world[joint], inverseBind[joint]);
          for (let e = 0; e < 16; e++) out.elements[e] += product.elements[e] * weight;
        }
      });
      for (const { shape, mesh, geometry } of meshes) {
        if (!mesh.visible) continue;
        const position = geometry.attributes.position.array, normal = geometry.attributes.normal.array;
        for (let i = 0, n = shape.drawIndex.length; i < n; i++) {
          const m = drawMatrices[shape.drawIndex[i]].elements, o = i * 3;
          const x = shape.position[o], y = shape.position[o + 1], z = shape.position[o + 2];
          position[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
          position[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          position[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
          const nx = shape.normal[o], ny = shape.normal[o + 1], nz = shape.normal[o + 2];
          const tx = m[0] * nx + m[4] * ny + m[8] * nz, ty = m[1] * nx + m[5] * ny + m[9] * nz, tz = m[2] * nx + m[6] * ny + m[10] * nz;
          const length = Math.hypot(tx, ty, tz) || 1;
          normal[o] = tx / length; normal[o + 1] = ty / length; normal[o + 2] = tz / length;
        }
        geometry.attributes.position.needsUpdate = true;
        geometry.attributes.normal.needsUpdate = true;
      }
    },
  };
}

// A joint's local matrix: scale, then rotation about X, Y and Z, then translation.
const euler = new THREE.Euler(), quaternion = new THREE.Quaternion(), vector = new THREE.Vector3(), scaling = new THREE.Vector3();
function jointMatrix(scale, rotation, translation, out) {
  euler.set(rotation[0], rotation[1], rotation[2], 'ZYX');
  return out.compose(vector.set(translation[0], translation[1], translation[2]), quaternion.setFromEuler(euler), scaling.set(scale[0], scale[1], scale[2]));
}

// Joints ordered parents first.
function jointOrder(joints) {
  const order = [], seen = new Set();
  const visit = j => {
    if (seen.has(j)) return;
    if (joints[j].parent >= 0) visit(joints[j].parent);
    seen.add(j);
    order.push(j);
  };
  joints.forEach((_, j) => visit(j));
  return order;
}
