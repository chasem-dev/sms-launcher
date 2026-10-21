// World editor: a stage from the player's disc in 3D, with a catalog of
// everything the game places in any stage. Players move, add and remove
// objects, paint ground types onto the stage's collision, walk around it, and
// export the result as the game's own scene files.
import * as THREE from '../node_modules/three/build/three.module.js';

const $ = id => document.getElementById(id);
const page = $('world-editor');
const WRAP = [THREE.ClampToEdgeWrapping, THREE.RepeatWrapping, THREE.MirroredRepeatWrapping];
const DEG = Math.PI / 180;
// GX blend factors as three.js ones; source and destination read 2 and 3 differently.
const BLEND_SRC = [THREE.ZeroFactor, THREE.OneFactor, THREE.DstColorFactor, THREE.OneMinusDstColorFactor, THREE.SrcAlphaFactor, THREE.OneMinusSrcAlphaFactor, THREE.DstAlphaFactor, THREE.OneMinusDstAlphaFactor];
const BLEND_DST = [THREE.ZeroFactor, THREE.OneFactor, THREE.SrcColorFactor, THREE.OneMinusSrcColorFactor, THREE.SrcAlphaFactor, THREE.OneMinusSrcAlphaFactor, THREE.DstAlphaFactor, THREE.OneMinusDstAlphaFactor];
const HISTORY = 100;

let levels = null, catalog = null, surfaces = [];
let level = null, project = null, view = null;
let selected = null, tool = 'select', placing = null;
let brush = { id: null, radius: 400 };
let undoStack = [], redoStack = [], dirty = false, busy = false;
let filter = { text: '', category: 'all', world: 'all' };
let booting = null;

window.smsOnPage('world', {
  show() {
    // Back before an earlier start finished: show the stage once it has.
    if (booting) booting.then(() => { if (!page.hidden && level && !view && !busy) showLevel(savedCamera); });
    else booting = boot().finally(() => { booting = null; });
  },
  hide() {
    if (tool === 'walk') setTool('select');
    savedCamera = view?.getCamera() || savedCamera;
    view?.dispose();
    view = null;
    window.sms.worldRelease().catch(() => {});
  }
});
// three.js can take longer to load than the launcher takes to show its tabs:
// if the page opened before this module ran, start now.
if (!page.hidden) booting ||= boot().finally(() => { booting = null; });

// --- Loading -------------------------------------------------------------------

async function boot() {
  try {
    if (!levels) {
      setStatus('Reading the stages on your disc…', true);
      levels = await window.sms.worldLevels();
      surfaces = levels.surfaces;
      renderLevelPicker();
      renderSurfaceSwatches();
    }
    if (!catalog) {
      setStatus('Cataloguing everything placed in every stage… (only the first time)', true);
      catalog = await window.sms.worldCatalog();
      renderFilters();
      renderCatalog();
    }
    if (page.hidden) return;
    if (!project) await openLevel(levels.defaultScene);
    else if (!view) await showLevel(savedCamera);
  } catch (error) {
    setStatus(error.message || String(error), false, true);
  }
}

// Loads a stage, with a saved level's edits if given; false if it didn't.
async function openLevel(scene, saved = null) {
  if (busy) return false;
  busy = true;
  stopWalk();
  setStatus(`Loading ${sceneLabel(scene)}…`, true);
  try {
    level = await window.sms.worldLoad(scene);
    project = saved ? normalizeProject(saved, scene) : newProject(scene);
    undoStack = []; redoStack = []; dirty = false; selected = null;
    $('world-level').value = scene;
    $('world-name').value = project.name;
    await showLevel();
    renderOutline();
    renderInspector();
    syncButtons();
    setStatus('');
    return true;
  } catch (error) {
    setStatus(error.message || String(error), false, true);
    return false;
  } finally { busy = false; }
}

function newProject(scene) {
  return { format: 'sms-world', version: 1, name: `My ${sceneLabel(scene)}`, base: scene, disc: levels.disc.gameId, edits: {}, added: [], paint: {} };
}

function normalizeProject(saved, scene) {
  return { ...newProject(scene), ...saved, base: scene, edits: { ...saved.edits }, added: [...(saved.added || [])], paint: { ...saved.paint } };
}

const sceneLabel = scene => levels?.scenes?.[scene]?.label || scene;

// A fresh 3D view on fresh canvases (a canvas whose context was let go can't
// make another). Nothing of the editor stays on the GPU while another page shows.
function ensureView() {
  if (view) return true;
  for (const id of ['world-canvas', 'world-preview-canvas']) {
    const canvas = $(id).cloneNode(false);
    $(id).replaceWith(canvas);
  }
  try { view = createView($('world-canvas')); return true; }
  catch (_) { setStatus('The 3D view couldn\'t start. Restart the launcher to reset its graphics.', false, true); return false; }
}

// The loaded stage in the view, from where the camera last was (or Mario's start).
async function showLevel(camera = null) {
  if (!ensureView()) return;
  const shown = view;
  await shown.setLevel(level);
  if (view !== shown) return;  // the page was left while the stage loaded
  syncScene();
  if (camera) view.setCamera(camera);
  else view.frame(level.start);
  if (placing) view.setGhost(placing);
  if (previewed) view.preview(previewed);
  syncButtons();
}
let savedCamera = null, previewed = null;

function setStatus(text, loading = false, stuck = false) {
  $('world-status-text').textContent = text;
  $('world-status').classList.toggle('loading', loading);
  $('world-retry').hidden = !stuck;
  $('world-status').hidden = !text;
}
$('world-retry').addEventListener('click', () => { setStatus(''); boot(); });

// --- Project state -----------------------------------------------------------------

// Every object the stage shows: its own, with the player's edits, and the ones they added.
function objects() {
  const out = [];
  for (const object of level.objects) {
    const edit = project.edits[object.id];
    if (edit?.removed) continue;
    out.push({ ...object, transform: edit?.transform || object.transform, edited: Boolean(edit) });
  }
  for (const added of project.added) out.push({ ...added, id: added.uid, added: true });
  return out;
}

function objectById(id) { return objects().find(object => object.id === id) || null; }

// Changes go through here so undo, the outline and the 3D view stay in step.
function change(label, apply) {
  undoStack.push(JSON.stringify(project));
  if (undoStack.length > HISTORY) undoStack.shift();
  redoStack = [];
  apply();
  dirty = true;
  syncScene();
  renderOutline();
  renderInspector();
  syncButtons();
}

function restore(from, to) {
  if (!from.length || view?.gesturing()) return;
  const file = project.file;
  to.push(JSON.stringify(project));
  project = JSON.parse(from.pop());
  project.file = file;  // undo changes the level, not where it's saved
  $('world-name').value = project.name;
  dirty = true;
  if (selected && !objectById(selected)) selected = null;
  syncScene();
  view?.repaintAll(project.paint);
  renderOutline();
  renderInspector();
  syncButtons();
}

function setTransform(id, transform) {
  const object = objectById(id);
  if (!object) return;
  if (object.added) project.added.find(a => a.uid === id).transform = transform;
  else project.edits[id] = { transform };
}

function syncScene() {
  if (view && level) view.syncObjects(objects(), selected);
}

let uidCounter = 0;
const uid = () => `new-${Date.now().toString(36)}-${(uidCounter++).toString(36)}`;

// --- Toolbar ----------------------------------------------------------------------

function renderLevelPicker() {
  const select = $('world-level');
  select.replaceChildren();
  for (const world of levels.worlds) {
    const group = document.createElement('optgroup');
    group.label = world.name;
    for (const scene of world.scenes) group.append(new Option(levels.scenes[scene].label, scene));
    select.append(group);
  }
}

$('world-level').addEventListener('change', async event => {
  const scene = event.target.value;
  if (dirty && !confirm('Load this stage? Changes you haven\'t saved will be lost.')) { event.target.value = project.base; return; }
  await openLevel(scene);
});
$('world-name').addEventListener('change', event => { project.name = event.target.value.trim() || project.name; event.target.value = project.name; dirty = true; syncButtons(); });

$('world-save').addEventListener('click', save);
async function save() {
  if (!project) return;
  try {
    const result = await window.sms.worldSave(project);
    project.file = result.file;
    dirty = false;
    syncButtons();
    flash(`Saved “${project.name}”.`);
  } catch (error) { flash(error.message || String(error), true); }
}

$('world-open').addEventListener('click', async () => {
  const list = await window.sms.worldProjects();
  const menu = $('world-open-menu');
  menu.replaceChildren();
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'world-menu-empty';
    empty.textContent = 'No saved levels yet. Save one with Save.';
    menu.append(empty);
  }
  for (const item of list) {
    const row = document.createElement('div');
    row.className = 'world-menu-row';
    const button = document.createElement('button');
    button.className = 'world-menu-item';
    button.innerHTML = '<strong></strong><small></small>';
    button.querySelector('strong').textContent = item.name;
    button.querySelector('small').textContent = `${sceneLabel(item.base)} · ${new Date(item.savedAt).toLocaleString()}`;
    button.addEventListener('click', async () => {
      menu.hidePopover();
      if (dirty && !confirm('Open this level? Changes you haven\'t saved will be lost.')) return;
      try {
        const saved = await window.sms.worldOpen(item.file);
        await openLevel(saved.base, saved);
      } catch (error) { flash(error.message || String(error), true); }
    });
    const remove = document.createElement('button');
    remove.className = 'world-menu-delete';
    remove.textContent = '×';
    remove.title = `Delete “${item.name}”`;
    remove.setAttribute('aria-label', `Delete ${item.name}`);
    remove.addEventListener('click', async () => {
      if (!confirm(`Delete “${item.name}”? This can't be undone.`)) return;
      await window.sms.worldDelete(item.file);
      row.remove();
    });
    row.append(button, remove);
    menu.append(row);
  }
  const importButton = document.createElement('button');
  importButton.className = 'world-menu-item world-menu-import';
  importButton.textContent = 'Import a level file…';
  importButton.addEventListener('click', async () => {
    menu.hidePopover();
    try {
      const saved = await window.sms.worldImport();
      if (saved) await openLevel(saved.base, saved);
    } catch (error) { flash(error.message || String(error), true); }
  });
  menu.append(importButton);
  menu.showPopover();
});

for (const button of document.querySelectorAll('[data-world-export]'))
  button.addEventListener('click', async () => {
    $('world-export-menu').hidePopover();
    if (!project) return;
    try {
      const result = await window.sms.worldExport(project, button.dataset.worldExport);
      if (result) flash(result.message);
    } catch (error) { flash(error.message || String(error), true); }
  });

$('world-undo').addEventListener('click', () => restore(undoStack, redoStack));
$('world-redo').addEventListener('click', () => restore(redoStack, undoStack));

function syncButtons() {
  $('world-undo').disabled = !undoStack.length;
  $('world-redo').disabled = !redoStack.length;
  $('world-save').textContent = dirty ? 'Save*' : 'Save';
  for (const button of document.querySelectorAll('[data-world-tool]')) {
    const on = button.dataset.worldTool === tool;
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', String(on));
  }
  $('world-paint-panel').hidden = tool !== 'paint';
  $('world-walk-hint').hidden = tool !== 'walk';
  page.querySelector('.world-help').hidden = tool === 'walk';
  $('world-place-hint').hidden = tool !== 'place';
  if (placing) $('world-place-name').textContent = placing.label;
  view?.setOverlay(tool === 'paint' || $('world-show-ground').checked);
}

let flashTimer = null;
function flash(text, error = false) {
  const note = $('world-flash');
  note.textContent = text;
  note.classList.toggle('error', error);
  note.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { note.hidden = true; }, 4500);
}

// --- Tools ------------------------------------------------------------------------

for (const button of document.querySelectorAll('[data-world-tool]'))
  button.addEventListener('click', () => setTool(button.dataset.worldTool));

function setTool(name) {
  if (name === tool && name !== 'select') name = 'select';
  if (tool === 'walk' && name !== 'walk') stopWalk();
  if (name !== 'place') { placing = null; view?.setGhost(null); markCatalog(); }
  tool = name;
  if (tool === 'paint' && brush.id === null) brush.id = surfaces[0]?.id ?? null;
  if (tool === 'walk') startWalk();
  renderSurfaceSwatches();
  syncButtons();
}

function startWalk() {
  if (!view) return;
  const from = selected ? objectById(selected)?.transform?.position : null;
  view.walk(from || null);
}
function stopWalk() { view?.stopWalk(); }

$('world-show-ground').addEventListener('change', syncButtons);
$('world-brush-size').addEventListener('input', event => { brush.radius = Number(event.target.value); $('world-brush-size-value').textContent = `${Math.round(brush.radius / 100)} m`; view?.setBrushRadius(brush.radius); });

function renderSurfaceSwatches() {
  const box = $('world-surfaces');
  box.replaceChildren();
  for (const surface of surfaces) {
    const button = document.createElement('button');
    button.className = 'world-surface';
    button.classList.toggle('active', brush.id === surface.id);
    button.setAttribute('aria-pressed', String(brush.id === surface.id));
    button.innerHTML = '<i></i><span><strong></strong><small></small></span>';
    button.querySelector('i').style.background = surface.color;
    button.querySelector('strong').textContent = surface.label;
    button.querySelector('small').textContent = surface.detail;
    button.addEventListener('click', () => { brush.id = surface.id; renderSurfaceSwatches(); });
    box.append(button);
  }
}

// --- Catalog sidebar ----------------------------------------------------------------

function renderFilters() {
  const chips = $('world-categories');
  chips.replaceChildren();
  for (const category of [{ id: 'all', label: 'All' }, ...catalog.categories]) {
    const count = category.id === 'all' ? catalog.items.length : catalog.items.filter(item => item.category === category.id).length;
    if (!count) continue;
    const chip = document.createElement('button');
    chip.className = 'world-chip';
    chip.dataset.category = category.id;
    chip.textContent = category.label;
    chip.title = `${count} kinds`;
    chip.addEventListener('click', () => { filter.category = category.id; renderCatalog(); });
    chips.append(chip);
  }
  const worlds = $('world-filter-world');
  worlds.replaceChildren(new Option('Every stage', 'all'));
  for (const world of levels.worlds) worlds.append(new Option(world.name, world.id));
}
$('world-search').addEventListener('input', event => { filter.text = event.target.value.trim().toLowerCase(); renderCatalog(); });
$('world-filter-world').addEventListener('change', event => { filter.world = event.target.value; renderCatalog(); });
$('world-filter-here').addEventListener('click', () => {
  if (!project) return;
  filter.world = levels.scenes[project.base].world;
  $('world-filter-world').value = filter.world;
  renderCatalog();
});

function catalogMatches(item) {
  if (filter.category !== 'all' && item.category !== filter.category) return false;
  if (filter.world !== 'all' && !item.worlds.includes(filter.world)) return false;
  if (!filter.text) return true;
  return filter.text.split(/\s+/).every(word => item.search.includes(word));
}

function renderCatalog() {
  for (const chip of $('world-categories').children) chip.classList.toggle('active', chip.dataset.category === filter.category);
  const list = $('world-catalog');
  const items = catalog.items.filter(catalogMatches);
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }
  const fragment = document.createDocumentFragment();
  for (const category of catalog.categories) {
    const entries = groups.get(category.id);
    if (!entries) continue;
    const heading = document.createElement('h3');
    heading.className = 'world-catalog-heading';
    heading.textContent = `${category.label} · ${entries.length}`;
    fragment.append(heading);
    for (const item of entries) fragment.append(catalogRow(item));
  }
  list.replaceChildren(fragment);
  $('world-catalog-empty').hidden = items.length > 0;
  $('world-catalog-count').textContent = `${items.length} of ${catalog.items.length}`;
  markCatalog();
}

function catalogRow(item) {
  const row = document.createElement('button');
  row.className = 'world-item';
  row.dataset.key = item.key;
  row.innerHTML = '<span class="world-item-dot"></span><span class="world-item-text"><strong></strong><small></small></span><em></em>';
  row.querySelector('.world-item-dot').style.background = categoryColor(item.category);
  row.querySelector('strong').textContent = item.label;
  const worlds = item.worlds.map(id => levels.worldNames[id] || id);
  row.querySelector('small').textContent = worlds.length > 3 ? `${worlds.slice(0, 3).join(', ')} +${worlds.length - 3}` : worlds.join(', ');
  row.querySelector('em').textContent = item.model ? '' : 'marker';
  row.title = `${item.label}\n${item.type}${item.variant ? ` · ${item.variant}` : ''}\nIn: ${worlds.join(', ')}\nPlaced ${item.count} times on the disc${item.note ? `\n${item.note}` : ''}`;
  row.addEventListener('click', () => startPlacing(item));
  return row;
}

function markCatalog() {
  for (const row of $('world-catalog').querySelectorAll('.world-item')) row.classList.toggle('active', placing?.key === row.dataset.key);
}

function startPlacing(item) {
  if (!project) return;
  if (tool === 'walk') stopWalk();
  placing = item;
  tool = 'place';
  view?.setGhost(item);
  markCatalog();
  syncButtons();
  previewItem(item);
}

// The picked item, turning in the sidebar's preview.
function previewItem(item) {
  previewed = item;
  $('world-preview-name').textContent = item.label;
  $('world-preview-detail').textContent = `${item.type}${item.variant ? ` · ${item.variant}` : ''} · placed ${item.count}× on the disc`;
  $('world-preview').hidden = false;
  view?.preview(item);
}

const CATEGORY_COLORS = {
  buildings: '#d39a5b', nature: '#4fae5b', decorations: '#c97fd0', npcs: '#f2c94c', enemies: '#e3574b', bosses: '#a3242f',
  items: '#ffd64a', interactive: '#4aa3df', vehicles: '#3cc0b4', water: '#3a7bd5', effects: '#ff8a3d', markers: '#9aa7ad', system: '#6c7a80',
};
const categoryColor = id => CATEGORY_COLORS[id] || '#9aa7ad';

// --- Outline and inspector -------------------------------------------------------------

function renderOutline() {
  if (!level) return;
  const list = $('world-outline');
  const all = objects().filter(object => object.transform);
  $('world-outline-count').textContent = `${all.length} objects`;
  const text = $('world-outline-search').value.trim().toLowerCase();
  const shown = all.filter(object => !text || `${object.label} ${object.type} ${object.name}`.toLowerCase().includes(text)).slice(0, 400);
  const fragment = document.createDocumentFragment();
  for (const object of shown) {
    const row = document.createElement('button');
    row.className = 'world-outline-row';
    row.classList.toggle('active', object.id === selected);
    row.innerHTML = '<span class="world-item-dot"></span><span></span><small></small>';
    row.querySelector('.world-item-dot').style.background = categoryColor(object.category);
    row.querySelector('span:nth-child(2)').textContent = object.label;
    row.querySelector('small').textContent = object.added ? 'added' : object.edited ? 'moved' : '';
    row.addEventListener('click', () => { select(object.id); view?.focus(object); });
    fragment.append(row);
  }
  list.replaceChildren(fragment);
}
$('world-outline-search').addEventListener('input', renderOutline);

function select(id) {
  selected = id;
  syncScene();
  renderOutline();
  renderInspector();
}

const AXES = ['x', 'y', 'z'];
function renderInspector() {
  const object = selected ? objectById(selected) : null;
  $('world-inspector-empty').hidden = Boolean(object);
  $('world-inspector-body').hidden = !object;
  if (!object) {
    if (level) $('world-level-info').textContent = `${sceneLabel(project.base)} · ${level.objects.filter(o => o.transform).length} objects from the disc · ${project.added.length} added · ${Object.keys(project.edits).length} edited · ${Object.keys(project.paint).length} ground triangles painted`;
    return;
  }
  $('world-inspector-title').textContent = object.label;
  $('world-inspector-type').textContent = `${object.type}${object.variant ? ` · ${object.variant}` : ''}${object.added ? ' · added by you' : ''}`;
  $('world-inspector-dot').style.background = categoryColor(object.category);
  const t = object.transform;
  for (const [field, values] of [['pos', t.position], ['rot', t.rotation], ['scl', t.scale]])
    AXES.forEach((axis, i) => {
      const input = $(`world-${field}-${axis}`);
      if (document.activeElement !== input) input.value = round(values[i], field === 'scl' ? 3 : 1);
    });
  $('world-inspector-note').textContent = object.note || '';
  $('world-inspector-note').hidden = !object.note;
  $('world-delete').disabled = $('world-duplicate').disabled = isStart(object);
  $('world-reset').disabled = Boolean(object.added) || !object.edited;
}
const round = (value, digits) => String(Math.round(value * 10 ** digits) / 10 ** digits);

for (const field of ['pos', 'rot', 'scl']) for (const [i, axis] of AXES.entries())
  $(`world-${field}-${axis}`).addEventListener('change', event => {
    const object = selected && objectById(selected);
    const value = Number(event.target.value);
    if (!object || !Number.isFinite(value)) { renderInspector(); return; }
    change('Edit', () => {
      const t = cloneTransform(object.transform);
      ({ pos: t.position, rot: t.rotation, scl: t.scale })[field][i] = value;
      setTransform(object.id, t);
    });
  });

const cloneTransform = t => ({ position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] });

$('world-delete').addEventListener('click', removeSelected);
$('world-duplicate').addEventListener('click', duplicateSelected);
$('world-focus').addEventListener('click', () => { const object = selected && objectById(selected); if (object) view?.focus(object); });
$('world-reset').addEventListener('click', () => {
  const object = selected && objectById(selected);
  if (!object || object.added) return;
  change('Reset', () => { delete project.edits[object.id]; });
});
$('world-drop').addEventListener('click', () => {
  const object = selected && objectById(selected);
  const ground = object && view?.groundBelow(object.transform.position);
  if (ground == null) return;
  change('Drop', () => { const t = cloneTransform(object.transform); t.position[1] = ground; setTransform(object.id, t); });
});

// The stage needs its one Mario: his start point moves but doesn't go or double.
const isStart = object => object.type === 'Mario';

function removeSelected() {
  const object = selected && objectById(selected);
  if (!object) return;
  if (isStart(object)) { flash('The stage needs Mario\'s start point. Move it instead.', true); return; }
  change('Delete', () => {
    if (object.added) project.added = project.added.filter(a => a.uid !== object.id);
    else project.edits[object.id] = { removed: true };
    selected = null;
  });
}

function duplicateSelected() {
  const object = selected && objectById(selected);
  if (!object) return;
  if (isStart(object)) { flash('A stage has one Mario start point.', true); return; }
  const t = cloneTransform(object.transform);
  t.position[0] += 200;
  const copy = { uid: uid(), key: object.key, source: object.source || { scene: project.base, id: object.id }, type: object.type, variant: object.variant, label: object.label, category: object.category, model: object.model, note: object.note, transform: t };
  change('Duplicate', () => { project.added.push(copy); selected = copy.uid; });
}

$('world-revert').addEventListener('click', () => {
  if (!project || !confirm('Undo every change to this stage? You can still undo this.')) return;
  change('Revert', () => { project.edits = {}; project.added = []; project.paint = {}; selected = null; });
  view?.repaintAll(project.paint);
});

// --- Keyboard ---------------------------------------------------------------------------

document.addEventListener('keydown', event => {
  if (page.hidden || !project) return;
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
  const mod = event.ctrlKey || event.metaKey;
  if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); save(); return; }
  if (typing) return;
  if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? restore(redoStack, undoStack) : restore(undoStack, redoStack); return; }
  if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); restore(redoStack, undoStack); return; }
  if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelected(); return; }
  // Escape backs out of a tool, then the selection, and only then leaves the page.
  if (event.key === 'Escape') {
    if (tool !== 'select') setTool('select');
    else if (selected) select(null);
    else return;
    event.preventDefault();
    return;
  }
  if (tool === 'walk') return;
  if (event.key === 'Delete' || event.key === 'Backspace') { removeSelected(); return; }
  if (mod || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === 'f') { const object = selected && objectById(selected); if (object) view?.focus(object); }
  else if (key === 'b') setTool('paint');
  else if (key === 'p') setTool('walk');
  else if (key === 'v') setTool('select');
  else if (key === 'r' && selected) {
    const object = objectById(selected);
    if (object) change('Rotate', () => { const t = cloneTransform(object.transform); t.rotation[1] = ((t.rotation[1] + (event.shiftKey ? -15 : 15)) + 540) % 360 - 180; setTransform(object.id, t); });
  }
});

window.smsWorldWalking = () => !page.hidden && tool === 'walk';

// --- 3D view ------------------------------------------------------------------------------

function createView(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  let lost = false, disposed = false;
  canvas.addEventListener('webglcontextlost', () => { if (!disposed) { lost = true; setStatus('The 3D view stopped. Restart the launcher to reset its graphics.', false, true); } });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fc7e8);
  const camera = new THREE.PerspectiveCamera(60, 1, 40, 320000);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(0.4, 1, 0.3);
  scene.add(sun);

  const stage = new THREE.Group(), things = new THREE.Group(), overlayGroup = new THREE.Group();
  scene.add(stage, things, overlayGroup);

  // Models are shared: each model ref is read and turned into meshes once.
  const models = new Map();
  const textures = new Map();
  function modelFor(ref) {
    if (!ref) return Promise.resolve(null);
    if (!models.has(ref)) models.set(ref, window.sms.worldModel(ref).then(build).catch(error => { console.warn(`World editor: ${ref}: ${error.message || error}`); return null; }));
    return models.get(ref);
  }
  function build(data) {
    if (!data) return null;
    const maps = data.textures.map(source => {
      if (!source) return null;
      const texture = new THREE.DataTexture(source.rgba, source.width, source.height, THREE.RGBAFormat);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = WRAP[source.wrapS] || THREE.ClampToEdgeWrapping;
      texture.wrapT = WRAP[source.wrapT] || THREE.ClampToEdgeWrapping;
      texture.magFilter = THREE.LinearFilter;
      // Like the game: smaller levels only for textures that come with them.
      // Made-up levels would blur atlases' see-through seams into their tiles.
      texture.minFilter = source.mipmapped ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
      texture.generateMipmaps = Boolean(source.mipmapped);
      texture.anisotropy = 4;
      texture.needsUpdate = true;
      textures.set(texture, true);
      return texture;
    });
    const parts = data.meshes.map(mesh => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(mesh.position, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normal, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.uv, 2));
      // The game's vertex colours are display values; three.js lights in linear.
      // Only blended layers keep vertex alpha: elsewhere it isn't coverage, and
      // three.js would test it along with the texture's.
      if (mesh.color) geometry.setAttribute('color', mesh.translucent ? new THREE.BufferAttribute(linearColors(mesh.color, 4), 4) : new THREE.BufferAttribute(linearColors(mesh.color, 3), 3));
      geometry.setIndex(new THREE.BufferAttribute(mesh.index, 1));
      geometry.computeBoundingSphere();
      const options = {
        map: mesh.texture >= 0 ? maps[mesh.texture] : null, vertexColors: Boolean(mesh.color),
        side: mesh.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
        alphaTest: mesh.cutout && !mesh.translucent ? Math.max(0.3, mesh.alphaRef) : 0,
      };
      // Blended layers (decals, shadows, glass) sit on the surfaces under them:
      // drawn after, with the game's blend factors, nudged forward so they don't flicker.
      if (mesh.translucent) Object.assign(options, {
        transparent: true, depthWrite: false, blending: THREE.CustomBlending,
        blendSrc: BLEND_SRC[mesh.blendSrc] ?? THREE.SrcAlphaFactor, blendDst: BLEND_DST[mesh.blendDst] ?? THREE.OneMinusSrcAlphaFactor,
        polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
      });
      if (!options.map && !mesh.color) options.color = new THREE.Color().setRGB(mesh.tint[0], mesh.tint[1], mesh.tint[2], THREE.SRGBColorSpace);
      const material = mesh.hasNormal && !mesh.color ? new THREE.MeshLambertMaterial(options) : new THREE.MeshBasicMaterial(options);
      return { geometry, material };
    });
    const bounds = new THREE.Box3(new THREE.Vector3(...data.bounds.min), new THREE.Vector3(...data.bounds.max));
    return { parts, bounds };
  }
  // RGBA colours to linear RGB(A), keeping `width` components each.
  function linearColors(colors, width) {
    const count = colors.length / 4, out = new Float32Array(count * width);
    for (let i = 0; i < count; i++) for (let k = 0; k < width; k++) {
      const c = colors[i * 4 + k];
      out[i * width + k] = k === 3 ? c : c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }
    return out;
  }
  function instance(built) {
    const group = new THREE.Group();
    for (const { geometry, material } of built.parts) group.add(new THREE.Mesh(geometry, material));
    return group;
  }

  // A stand-in for things with no model of their own (cameras, areas, sounds…).
  const markerGeometry = new THREE.OctahedronGeometry(70);
  const markerMaterials = new Map();
  function marker(category) {
    if (!markerMaterials.has(category)) markerMaterials.set(category, new THREE.MeshLambertMaterial({ color: categoryColor(category), emissive: new THREE.Color(categoryColor(category)).multiplyScalar(0.35) }));
    const mesh = new THREE.Mesh(markerGeometry, markerMaterials.get(category));
    mesh.position.y = 90;
    const group = new THREE.Group();
    group.add(mesh);
    return group;
  }

  // --- Stage and collision ---
  let collision = null, overlay = null, overlayOn = false, levelToken = 0;
  async function setLevel(data) {
    const token = ++levelToken;
    collision = null;
    overlay = null;
    stage.clear();
    overlayGroup.clear();
    for (const [, entry] of nodes) things.remove(entry.root);
    nodes.clear();
    const built = await Promise.all(data.stageModels.map(modelFor));
    if (token !== levelToken || disposed) return;  // another stage started loading meanwhile
    for (const model of built) if (model) stage.add(instance(model));
    collision = prepareCollision(data.collision);
    overlay = buildOverlay(collision);
    overlayGroup.add(overlay.mesh);
    overlay.mesh.visible = overlayOn;
    repaintAll(project?.paint || {});
    const sky = data.sky;
    scene.background = new THREE.Color(sky || 0x8fc7e8);
  }

  function prepareCollision(data) {
    const p = data.position, count = p.length / 9;
    const normals = new Float32Array(count * 3), centers = new Float32Array(count * 3);
    for (let t = 0; t < count; t++) {
      const o = t * 9;
      const ax = p[o + 3] - p[o], ay = p[o + 4] - p[o + 1], az = p[o + 5] - p[o + 2];
      const bx = p[o + 6] - p[o], by = p[o + 7] - p[o + 1], bz = p[o + 8] - p[o + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const length = Math.hypot(nx, ny, nz) || 1;
      normals[t * 3] = nx / length; normals[t * 3 + 1] = ny / length; normals[t * 3 + 2] = nz / length;
      centers[t * 3] = (p[o] + p[o + 3] + p[o + 6]) / 3; centers[t * 3 + 1] = (p[o + 1] + p[o + 4] + p[o + 7]) / 3; centers[t * 3 + 2] = (p[o + 2] + p[o + 5] + p[o + 8]) / 3;
    }
    // A grid over X/Z so rays only test the triangles they pass over.
    const cell = 1024, cells = new Map();
    for (let t = 0; t < count; t++) {
      const o = t * 9;
      const x0 = Math.floor(Math.min(p[o], p[o + 3], p[o + 6]) / cell), x1 = Math.floor(Math.max(p[o], p[o + 3], p[o + 6]) / cell);
      const z0 = Math.floor(Math.min(p[o + 2], p[o + 5], p[o + 8]) / cell), z1 = Math.floor(Math.max(p[o + 2], p[o + 5], p[o + 8]) / cell);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 4096) { (cells.get('big') || cells.set('big', []).get('big')).push(t); continue; }
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const key = `${x},${z}`;
        (cells.get(key) || cells.set(key, []).get(key)).push(t);
      }
    }
    return { position: p, codes: data.codes, normals, centers, count, cell, cells, ground: data.ground };
  }

  // Möller–Trumbore against the collision triangles the ray passes over.
  function raycastCollision(origin, direction, maxDistance = 300000, floorsOnly = false) {
    if (!collision) return null;
    const { position: p, cell, cells, normals } = collision;
    let best = null;
    const seen = new Set();
    const test = list => {
      for (const t of list) {
        if (seen.has(t)) continue;
        seen.add(t);
        if (floorsOnly && normals[t * 3 + 1] < 0.2) continue;
        const o = t * 9;
        const e1x = p[o + 3] - p[o], e1y = p[o + 4] - p[o + 1], e1z = p[o + 5] - p[o + 2];
        const e2x = p[o + 6] - p[o], e2y = p[o + 7] - p[o + 1], e2z = p[o + 8] - p[o + 2];
        const px = direction.y * e2z - direction.z * e2y, py = direction.z * e2x - direction.x * e2z, pz = direction.x * e2y - direction.y * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-9) continue;
        const inv = 1 / det, tx = origin.x - p[o], ty = origin.y - p[o + 1], tz = origin.z - p[o + 2];
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (direction.x * qx + direction.y * qy + direction.z * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (d > 0.01 && d < maxDistance && (!best || d < best.distance)) best = { distance: d, triangle: t };
      }
    };
    if (cells.has('big')) test(cells.get('big'));
    // Walk the grid cells under the ray, near to far.
    const step = cell / 2, flat = Math.hypot(direction.x, direction.z);
    const span = flat < 1e-6 ? 0 : Math.min(maxDistance, 300000);
    const visited = new Set();
    for (let d = 0; d <= span || d === 0; d += step / Math.max(flat, 1e-6)) {
      const x = origin.x + direction.x * d, z = origin.z + direction.z * d;
      const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
      for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
        const key = `${cx + ox},${cz + oz}`;
        if (visited.has(key)) continue;
        visited.add(key);
        const list = cells.get(key);
        if (list) test(list);
      }
      if (best && d > best.distance + cell * 2) break;
      if (span === 0) break;
    }
    if (!best) return null;
    best.point = new THREE.Vector3().copy(direction).multiplyScalar(best.distance).add(origin);
    best.normal = new THREE.Vector3(normals[best.triangle * 3], normals[best.triangle * 3 + 1], normals[best.triangle * 3 + 2]);
    return best;
  }

  function groundBelow(position, from = 2000) {
    const hit = raycastCollision(new THREE.Vector3(position[0], position[1] + from, position[2]), new THREE.Vector3(0, -1, 0), from + 20000, true);
    return hit ? hit.point.y : null;
  }

  // Ground drawn over the collision in colours: a brush surface when the
  // type and footsteps match one, else the ground type's colour. Codes are
  // type * 256 + sound; the camera and shadow bits don't change the colour.
  const surfaceColors = new Map(surfaces.map(s => [s.type * 256 + s.sound, new THREE.Color(s.color)]));
  const typeColors = new Map(levels.groundTypes.map(g => [g.type, new THREE.Color(g.color)]));
  const cameraTypes = new Set(levels.cameraTypes);
  const baseType = code => Math.floor(code / 256) & 0x1fff;
  const otherColor = new THREE.Color('#8a8f93'), wallColor = new THREE.Color('#5d6468');
  function buildOverlay(col) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(col.position, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col.count * 9), 3));
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    return { mesh, colors: geometry.attributes.color };
  }
  function paintColor(t, paint) {
    const code = paint[t] ?? collision.codes[t];
    if (collision.normals[t * 3 + 1] < 0.2) return wallColor;
    return surfaceColors.get(baseType(code) * 256 + (code & 0xff)) || typeColors.get(baseType(code)) || otherColor;
  }
  function repaint(list, paint) {
    if (!overlay) return;
    const array = overlay.colors.array;
    for (const t of list) {
      const color = paintColor(t, paint);
      for (let k = 0; k < 3; k++) { array[t * 9 + k * 3] = color.r; array[t * 9 + k * 3 + 1] = color.g; array[t * 9 + k * 3 + 2] = color.b; }
    }
    overlay.colors.needsUpdate = true;
  }
  function repaintAll(paint) {
    if (!collision) return;
    repaint(Array.from({ length: collision.count }, (_, t) => t), paint);
  }

  // --- Objects ---
  const nodes = new Map();  // object id -> { root, ref, transformKey }
  const selectionBox = new THREE.Box3Helper(new THREE.Box3(), 0xffd64a);
  selectionBox.visible = false;
  scene.add(selectionBox);
  let selectedId = null;

  function syncObjects(list, selection) {
    const keep = new Set();
    for (const object of list) {
      if (!object.transform) continue;
      keep.add(object.id);
      let entry = nodes.get(object.id);
      if (!entry || entry.ref !== (object.model || null)) {
        if (entry) things.remove(entry.root);
        entry = { root: new THREE.Group(), ref: object.model || null, ready: false, type: object.type };
        entry.root.userData.id = object.id;
        things.add(entry.root);
        nodes.set(object.id, entry);
        const placeholder = marker(object.category);
        entry.root.add(placeholder);
        modelFor(entry.ref).then(model => {
          if (!model || nodes.get(object.id) !== entry) return;
          entry.root.remove(placeholder);
          entry.root.add(instance(model));
          entry.ready = true;
          if (selectedId === object.id) updateSelectionBox();
        });
      }
      applyTransform(entry.root, object.transform);
    }
    for (const [id, entry] of nodes) if (!keep.has(id)) { things.remove(entry.root); nodes.delete(id); }
    selectedId = selection;
    updateSelectionBox();
  }
  function applyTransform(root, t) {
    root.position.set(t.position[0], t.position[1], t.position[2]);
    root.rotation.set(t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG, 'ZYX');
    root.scale.set(t.scale[0] || 1, t.scale[1] || 1, t.scale[2] || 1);
  }
  function updateSelectionBox() {
    const entry = selectedId && nodes.get(selectedId);
    selectionBox.visible = Boolean(entry);
    if (entry) { entry.root.updateMatrixWorld(true); selectionBox.box.setFromObject(entry.root); selectionBox.box.expandByScalar(15); }
  }

  // --- Ghost (the thing being placed) and preview ---
  let ghost = null, ghostItem = null;
  const brushRing = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide }));
  brushRing.rotation.x = -Math.PI / 2;
  brushRing.renderOrder = 5;
  brushRing.visible = false;
  scene.add(brushRing);
  let brushRadius = brush.radius;

  function setGhost(item) {
    if (ghost) scene.remove(ghost);
    ghost = null;
    ghostItem = item;
    if (!item) return;
    ghost = new THREE.Group();
    ghost.visible = false;
    const placeholder = marker(item.category);
    ghost.add(placeholder);
    scene.add(ghost);
    modelFor(item.model).then(model => {
      if (!model || ghostItem !== item) return;
      ghost.remove(placeholder);
      const copy = instance(model);
      copy.traverse(child => { if (child.isMesh) { child.material = child.material.clone(); child.material.transparent = true; child.material.opacity = 0.6; } });
      ghost.add(copy);
    });
  }

  const previewCanvas = $('world-preview-canvas');
  let previewRenderer = null, previewScene = null, previewCamera = null, previewRoot = null, previewToken = 0;
  function preview(item) {
    const token = ++previewToken;
    if (!previewRenderer) {
      previewRenderer = new THREE.WebGLRenderer({ canvas: previewCanvas, antialias: true, alpha: true });
      previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      previewRenderer.outputColorSpace = THREE.SRGBColorSpace;
      previewScene = new THREE.Scene();
      previewScene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 2.4));
      const light = new THREE.DirectionalLight(0xffffff, 1.4);
      light.position.set(1, 2, 1.5);
      previewScene.add(light);
      previewCamera = new THREE.PerspectiveCamera(35, 1, 1, 200000);
    }
    if (previewRoot) previewScene.remove(previewRoot);
    previewRoot = marker(item.category);
    previewScene.add(previewRoot);
    fitPreview(new THREE.Box3().setFromObject(previewRoot));
    modelFor(item.model).then(model => {
      if (!model || token !== previewToken) return;
      previewScene.remove(previewRoot);
      previewRoot = instance(model);
      previewScene.add(previewRoot);
      fitPreview(model.bounds);
    });
  }
  let previewRadius = 300, previewCenter = new THREE.Vector3();
  function fitPreview(box) {
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    previewRadius = Math.max(sphere.radius, 30);
    previewCenter.copy(sphere.center);
  }

  // --- Camera ---
  const look = { yaw: -Math.PI * 0.75, pitch: -0.35 };
  const keys = new Set();
  let speedBoost = 1;
  // Opens on Mario's start, from behind him and high enough to see around.
  function frame(start) {
    const p = start?.position || [0, 0, 0], yaw = (start?.rotation?.[1] || 0) * DEG;
    const back = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    camera.position.set(p[0], p[1], p[2]).addScaledVector(back, 2600).add(new THREE.Vector3(0, 1700, 0));
    lookAt(new THREE.Vector3(p[0], p[1] + 200, p[2]).addScaledVector(back, -1200));
  }
  function lookAt(target) {
    const d = new THREE.Vector3().subVectors(target, camera.position);
    look.yaw = Math.atan2(-d.x, -d.z);
    look.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  }
  function focus(object) {
    const entry = nodes.get(object.id);
    const box = entry ? new THREE.Box3().setFromObject(entry.root) : new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(...object.transform.position), new THREE.Vector3(200, 200, 200));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const distance = Math.max(sphere.radius * 2.6, 600);
    const direction = new THREE.Vector3(Math.sin(look.yaw), 0.55, Math.cos(look.yaw)).normalize();
    camera.position.copy(sphere.center).addScaledVector(direction, distance);
    lookAt(sphere.center);
  }

  // --- Walking ---
  let walker = null, marioModel = null;
  const WALK = { speed: 1000, run: 1600, gravity: 3600, jump: 1500, radius: 50, height: 160, step: 70 };
  async function walk(from) {
    const start = from ? [...from] : [...(level.start?.position || [0, 0, 0])];
    const ground = groundBelow(start, 600);
    if (ground != null) start[1] = ground;
    walker = { position: new THREE.Vector3(...start), velocity: new THREE.Vector3(), grounded: false, yaw: look.yaw, camYaw: look.yaw, camPitch: -0.25, distance: 650, body: new THREE.Group(), anim: 0 };
    scene.add(walker.body);
    // One Mario at a time: the start point's stand-in steps aside.
    for (const entry of nodes.values()) if (entry.type === 'Mario') entry.root.visible = false;
    const mine = walker;
    marioModel ||= modelFor(level.mario);
    const model = await marioModel;
    if (walker !== mine) return;
    walker.body.add(model ? instance(model) : marker('npcs'));
    canvas.focus();
  }
  function stopWalk() {
    if (!walker) return;
    scene.remove(walker.body);
    for (const entry of nodes.values()) entry.root.visible = true;
    // The editor camera picks up where the walk's camera was, still facing Mario.
    lookAt(walker.position.clone().add(new THREE.Vector3(0, 140, 0)));
    walker = null;
  }
  function stepWalk(dt) {
    const w = walker;
    const forward = new THREE.Vector3(-Math.sin(w.camYaw), 0, -Math.cos(w.camYaw)), right = new THREE.Vector3(-forward.z, 0, forward.x);
    const move = new THREE.Vector3();
    if (keys.has('w') || keys.has('arrowup')) move.add(forward);
    if (keys.has('s') || keys.has('arrowdown')) move.sub(forward);
    if (keys.has('d') || keys.has('arrowright')) move.add(right);
    if (keys.has('a') || keys.has('arrowleft')) move.sub(right);
    const pad = navigator.getGamepads?.().find(Boolean);
    if (pad) {
      const dead = v => Math.abs(v) < 0.18 ? 0 : v;
      move.addScaledVector(right, dead(pad.axes[0])).addScaledVector(forward, -dead(pad.axes[1]));
      w.camYaw -= dead(pad.axes[2] ?? 0) * dt * 2.6;
      w.camPitch = Math.max(-1.2, Math.min(0.5, w.camPitch - dead(pad.axes[3] ?? 0) * dt * 1.6));
      if (pad.buttons[0]?.pressed && w.grounded) { w.velocity.y = WALK.jump; w.grounded = false; }
    }
    const length = Math.min(move.length(), 1);
    const speed = keys.has('shift') ? WALK.run : WALK.speed;
    if (length > 0.01) {
      move.normalize();
      w.yaw = Math.atan2(move.x, move.z);
      const delta = move.clone().multiplyScalar(speed * length * dt);
      slide(w.position, delta);
      w.anim += dt * speed * length / 90;
    }
    if (keys.has(' ') && w.grounded) { w.velocity.y = WALK.jump; w.grounded = false; }
    w.velocity.y -= WALK.gravity * dt;
    w.velocity.y = Math.max(w.velocity.y, -6000);
    const nextY = w.position.y + w.velocity.y * dt;
    const floor = raycastCollision(new THREE.Vector3(w.position.x, w.position.y + WALK.step, w.position.z), new THREE.Vector3(0, -1, 0), WALK.step + Math.max(0, -w.velocity.y * dt) + 4, true);
    if (floor && w.velocity.y <= 0 && nextY <= floor.point.y + 1) {
      w.position.y = floor.point.y;
      w.velocity.y = 0;
      w.grounded = true;
    } else {
      // Heads bump ceilings.
      if (w.velocity.y > 0) {
        const ceiling = raycastCollision(new THREE.Vector3(w.position.x, w.position.y + WALK.height * 0.5, w.position.z), new THREE.Vector3(0, 1, 0), WALK.height * 0.5 + w.velocity.y * dt);
        if (ceiling) w.velocity.y = 0;
      }
      w.position.y += w.velocity.y * dt;
      w.grounded = false;
    }
    // Fell out of the world: back to the start.
    if (w.position.y < (collision?.ground ?? -20000) - 5000) {
      w.position.set(...level.start.position);
      w.velocity.set(0, 0, 0);
    }
    w.body.position.copy(w.position);
    w.body.rotation.set(0, w.yaw, 0);
    w.body.position.y += w.grounded && length > 0.01 ? Math.abs(Math.sin(w.anim)) * 12 : 0;
    // A camera that follows from behind and keeps out of walls.
    const target = w.position.clone().add(new THREE.Vector3(0, 140, 0));
    const offset = new THREE.Vector3(Math.sin(w.camYaw) * Math.cos(w.camPitch), -Math.sin(w.camPitch), Math.cos(w.camYaw) * Math.cos(w.camPitch));
    const block = raycastCollision(target, offset, w.distance);
    const distance = block ? Math.max(120, block.distance - 40) : w.distance;
    camera.position.copy(target).addScaledVector(offset, distance);
    camera.lookAt(target);
  }
  // Moves along the ground, sliding along walls rather than through them.
  function slide(position, delta) {
    for (let pass = 0; pass < 3 && delta.lengthSq() > 0.0001; pass++) {
      const length = delta.length(), direction = delta.clone().divideScalar(length);
      let hit = null;
      for (const height of [WALK.step + 10, WALK.height * 0.5, WALK.height - 10]) {
        const h = raycastCollision(new THREE.Vector3(position.x, position.y + height, position.z), direction, length + WALK.radius);
        if (h && Math.abs(h.normal.y) < 0.6 && (!hit || h.distance < hit.distance)) hit = h;
      }
      if (!hit) { position.add(delta); return; }
      const allowed = Math.max(0, hit.distance - WALK.radius);
      position.addScaledVector(direction, allowed);
      const rest = delta.clone().multiplyScalar(1 - allowed / length);
      const normal = new THREE.Vector3(hit.normal.x, 0, hit.normal.z).normalize();
      delta = rest.sub(normal.multiplyScalar(rest.dot(normal)));
    }
  }

  // --- Input ---
  const pointer = new THREE.Vector2(), raycaster = new THREE.Raycaster();
  let drag = null, painting = null, hover = null;
  function rayFrom(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    return raycaster.ray;
  }
  function pickObject(ray) {
    raycaster.ray.copy(ray);
    const hits = raycaster.intersectObjects(things.children, true);
    for (const hit of hits) {
      let node = hit.object;
      while (node && node.userData.id === undefined) node = node.parent;
      if (node) return { id: node.userData.id, distance: hit.distance };
    }
    return null;
  }
  function surfacePoint(ray) {
    const hit = raycastCollision(ray.origin, ray.direction);
    if (hit) return hit;
    // Off the stage: the ground plane at the stage's start height.
    const y = level.start?.position?.[1] ?? 0;
    if (Math.abs(ray.direction.y) < 1e-4) return null;
    const d = (y - ray.origin.y) / ray.direction.y;
    return d > 0 ? { point: ray.origin.clone().addScaledVector(ray.direction, d), normal: new THREE.Vector3(0, 1, 0) } : null;
  }

  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('pointerdown', event => {
    canvas.focus();
    if (busy || !collision) return;  // a stage is still loading
    canvas.setPointerCapture(event.pointerId);
    if (event.button === 2 || event.button === 1 || tool === 'walk') { drag = { kind: 'look', x: event.clientX, y: event.clientY, pan: event.button === 1 }; return; }
    if (event.button !== 0) return;
    const ray = rayFrom(event);
    if (tool === 'place' && placing) {
      const hit = surfacePoint(ray);
      if (!hit) return;
      const item = placing;
      const object = { uid: uid(), key: item.key, source: item.source, type: item.type, variant: item.variant, label: item.label, category: item.category, model: item.model, note: item.note,
        transform: { position: [hit.point.x, hit.point.y, hit.point.z].map(v => Math.round(v)), rotation: [0, ghostYaw, 0], scale: [...(item.scale || [1, 1, 1])] } };
      change('Place', () => { project.added.push(object); selected = object.uid; });
      if (!event.shiftKey) setTool('select');
      return;
    }
    if (tool === 'paint') {
      painting = { before: JSON.stringify(project), changed: false };
      paintAt(ray);
      return;
    }
    const picked = pickObject(ray);
    select(picked ? picked.id : null);
    if (picked) {
      const object = objectById(picked.id);
      const hit = surfacePoint(ray);
      drag = { kind: 'move', id: picked.id, start: cloneTransform(object.transform), grab: hit ? hit.point.clone().sub(new THREE.Vector3(...object.transform.position)) : new THREE.Vector3(), moved: false, startY: event.clientY, vertical: event.shiftKey, before: JSON.stringify(project) };
    }
  });
  canvas.addEventListener('pointermove', event => {
    if (drag?.kind === 'look') {
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      drag.x = event.clientX; drag.y = event.clientY;
      if (walker) { walker.camYaw -= dx * 0.006; walker.camPitch = Math.max(-1.2, Math.min(0.5, walker.camPitch - dy * 0.005)); return; }
      if (drag.pan) {
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
        camera.position.addScaledVector(right, -dx * 6).addScaledVector(up, dy * 6);
        return;
      }
      look.yaw -= dx * 0.004;
      look.pitch = Math.max(-1.55, Math.min(1.55, look.pitch - dy * 0.004));
      return;
    }
    if (drag?.kind === 'move') {
      const object = objectById(drag.id);
      if (!object) return;
      const t = cloneTransform(drag.start);
      if (drag.vertical) t.position[1] = drag.start.position[1] + (drag.startY - event.clientY) * 4;
      else {
        const hit = surfacePoint(rayFrom(event));
        if (!hit) return;
        t.position = [hit.point.x - drag.grab.x, hit.point.y, hit.point.z - drag.grab.z].map(v => Math.round(v));
      }
      drag.moved = true;
      setTransform(drag.id, t);
      syncScene();
      renderInspector();
      return;
    }
    if (tool === 'place' && ghost) {
      const hit = surfacePoint(rayFrom(event));
      ghost.visible = Boolean(hit);
      if (hit) { ghost.position.copy(hit.point); ghost.rotation.set(0, ghostYaw * DEG, 0); ghost.scale.set(...(ghostItem.scale || [1, 1, 1])); }
      return;
    }
    if (tool === 'paint') {
      const hit = raycastCollision(rayFrom(event).origin, raycaster.ray.direction);
      brushRing.visible = Boolean(hit);
      if (hit) { brushRing.position.copy(hit.point).add(new THREE.Vector3(0, 6, 0)); brushRing.scale.setScalar(brushRadius); }
      if (painting) paintAt(raycaster.ray);
    }
  });
  const endPointer = event => {
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (drag?.kind === 'move' && drag.moved) {
      undoStack.push(drag.before);
      redoStack = [];
      dirty = true;
      renderOutline();
      syncButtons();
    }
    if (painting?.changed) {
      undoStack.push(painting.before);
      redoStack = [];
      dirty = true;
      renderInspector();
      syncButtons();
    }
    drag = null;
    painting = null;
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => { brushRing.visible = false; if (ghost) ghost.visible = false; });
  let ghostYaw = 0;
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    if (walker) { walker.distance = Math.max(200, Math.min(2500, walker.distance * (event.deltaY > 0 ? 1.12 : 0.89))); return; }
    if (tool === 'place' && event.altKey) { ghostYaw = (ghostYaw + (event.deltaY > 0 ? 15 : -15) + 540) % 360 - 180; return; }
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    camera.position.addScaledVector(forward, -Math.sign(event.deltaY) * 400 * speedBoost);
  }, { passive: false });
  canvas.tabIndex = 0;
  canvas.addEventListener('keydown', event => {
    const key = event.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'q', 'e', ' ', 'shift', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) {
      keys.add(key);
      if (key === ' ' || key.startsWith('arrow')) event.preventDefault();
    }
  });
  canvas.addEventListener('keyup', event => keys.delete(event.key.toLowerCase()));
  canvas.addEventListener('blur', () => keys.clear());

  // Paints the floor triangles under the brush. Water surfaces, warps and
  // other special ground stay as they are; ground the camera bumps into keeps
  // that, where the new type has a camera variant.
  const PAINTABLE = new Set([0x0000, 0x0001, 0x0002, 0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x000a, 0x000b, 0x000c, 0x0600, 0x0700, 0x0701]);
  function paintAt(ray) {
    const hit = raycastCollision(ray.origin, ray.direction);
    const surface = surfaces.find(s => s.id === brush.id);
    if (!hit || !surface) return;
    const { centers, normals, count } = collision, r2 = brushRadius * brushRadius, changed = [];
    for (let t = 0; t < count; t++) {
      if (normals[t * 3 + 1] < 0.2) continue;
      const dx = centers[t * 3] - hit.point.x, dy = centers[t * 3 + 1] - hit.point.y, dz = centers[t * 3 + 2] - hit.point.z;
      if (dx * dx + dz * dz > r2 || Math.abs(dy) > brushRadius) continue;
      const original = collision.codes[t], originalType = Math.floor(original / 256);
      if (!PAINTABLE.has(originalType & 0x3fff)) continue;
      // The camera bit stays where the new type has a camera variant; the
      // shadow bit (0x4000, whose value is a light) and 0x2000 stay on ground.
      const camera = originalType & 0x8000 && cameraTypes.has(surface.type) ? 0x8000 : 0;
      const keep = surface.type === 0 ? originalType & 0x6000 : 0;
      const code = (surface.type | camera | keep) * 256 + surface.sound;
      if ((project.paint[t] ?? original) === code) continue;
      if (code === original) delete project.paint[t];
      else project.paint[t] = code;
      changed.push(t);
    }
    if (changed.length) { painting.changed = true; repaint(changed, project.paint); }
  }

  // --- Loop ---
  let last = performance.now(), running = true;
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    renderer.setSize(rect.width, rect.height, false);
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  function tick(now) {
    if (!running) return;
    requestAnimationFrame(tick);
    if (lost) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (walker) stepWalk(dt);
    else {
      camera.rotation.set(look.pitch, look.yaw, 0, 'YXZ');
      const move = new THREE.Vector3();
      if (keys.has('w')) move.z -= 1;
      if (keys.has('s')) move.z += 1;
      if (keys.has('a')) move.x -= 1;
      if (keys.has('d')) move.x += 1;
      if (keys.has('e')) move.y += 1;
      if (keys.has('q')) move.y -= 1;
      if (move.lengthSq()) {
        const speed = (keys.has('shift') ? 9000 : 3000) * dt;
        const vertical = move.y;
        move.y = 0;
        move.applyQuaternion(camera.quaternion).setY(0);
        if (move.lengthSq()) move.normalize();
        camera.position.addScaledVector(move, speed);
        camera.position.y += vertical * speed;
      }
    }
    renderer.render(scene, camera);
    if (previewRenderer && !$('world-preview').hidden) {
      const rect = previewCanvas.getBoundingClientRect();
      if (rect.width && rect.height) {
        previewRenderer.setSize(rect.width, rect.height, false);
        previewCamera.aspect = rect.width / rect.height;
        previewCamera.updateProjectionMatrix();
        const angle = now / 2400;
        previewCamera.position.set(previewCenter.x + Math.sin(angle) * previewRadius * 2.6, previewCenter.y + previewRadius * 0.9, previewCenter.z + Math.cos(angle) * previewRadius * 2.6);
        previewCamera.lookAt(previewCenter);
        previewRenderer.render(previewScene, previewCamera);
      }
    }
  }
  requestAnimationFrame(tick);

  return {
    setLevel, syncObjects, frame, focus, groundBelow, walk, stopWalk, setGhost, preview, repaintAll,
    setOverlay(on) { overlayOn = on; if (overlay) overlay.mesh.visible = on; brushRing.visible = brushRing.visible && tool === 'paint'; },
    setBrushRadius(radius) { brushRadius = radius; },
    gesturing: () => Boolean(drag?.kind === 'move' || painting),
    getCamera: () => ({ position: camera.position.toArray(), yaw: look.yaw, pitch: look.pitch }),
    setCamera(saved) { camera.position.fromArray(saved.position); look.yaw = saved.yaw; look.pitch = saved.pitch; },
    dispose() {
      disposed = true;
      running = false;
      observer.disconnect();
      for (const promise of models.values()) promise.then(model => model?.parts.forEach(({ geometry, material }) => { geometry.dispose(); material.dispose(); }));
      for (const texture of textures.keys()) texture.dispose();
      markerGeometry.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      previewRenderer?.dispose();
      previewRenderer?.forceContextLoss();
    },
  };
}
