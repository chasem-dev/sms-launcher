// World editor: a stage from the player's disc in 3D, with a catalog of
// everything the game places in any stage. Players move, add and remove
// objects, paint ground types onto the stage's collision, walk around it, and
// export the result as the game's own scene files.
import * as THREE from '../node_modules/three/build/three.module.js';
import { tevMaterial, LIGHT } from './world-tev.js';
import { Reflector } from './world-mirror.js';

const $ = id => document.getElementById(id);
const page = $('world-editor');
const WRAP = [THREE.ClampToEdgeWrapping, THREE.RepeatWrapping, THREE.MirroredRepeatWrapping];
const DEG = Math.PI / 180;
const HISTORY = 100;

let levels = null, catalog = null, surfaces = [];
let level = null, project = null, view = null;
let selected = null, tool = 'select', placing = null;
let brush = { id: null, radius: 400 };
// Paint either textures onto the stage's own faces or ground types onto its collision.
let paintMode = 'texture', textureBrush = 'delfino-sand';
let buildKind = 'floor', buildTextures = { top: 'delfino-tiles', side: 'delfino-white-wall' };
let texturePaintVersion = 0;
const BUILD = window.smsWorldBuild;
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
      renderTextureSwatches();
      renderBuildPanel();
    }
    if (!catalog) {
      setStatus('Cataloguing everything placed in every stage… (only the first time)', true);
      catalog = withStagePieces(await window.sms.worldCatalog());
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
  return { format: 'sms-world', version: 1, name: `My ${sceneLabel(scene)}`, base: scene, disc: levels.disc.gameId, edits: {}, added: [], paint: {}, pieces: [], texturePaint: {}, blank: false };
}

function normalizeProject(saved, scene) {
  return {
    ...newProject(scene), ...saved, base: scene, edits: { ...saved.edits }, added: [...(saved.added || [])], paint: { ...saved.paint },
    pieces: (saved.pieces || []).map(piece => ({ ...piece })), texturePaint: { ...saved.texturePaint }, blank: Boolean(saved.blank),
  };
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
  else view.frame(marioStart());
  if (placing) view.setGhost(placing);
  if (previewed) view.preview(previewed);
  syncButtons();
}
let savedCamera = null, previewed = null;

// Where Mario starts: the disc's start point, or where the level moved it.
function marioStart() {
  const mario = level && project && objects().find(object => object.type === 'Mario');
  return mario ? { position: mario.transform.position, rotation: mario.transform.rotation } : level?.start;
}

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
  for (const piece of project.pieces) out.push(pieceObject(piece));
  return out;
}

// Built and copied pieces show up like objects: selectable, movable, turnable.
const paletteById = id => levels.palette.find(entry => entry.id === id) || null;
const fitOf = id => paletteById(id)?.fit || 0;
function pieceObject(piece) {
  const kind = BUILD.KIND[piece.kind];
  return {
    id: piece.uid, piece, added: true, category: 'pieces', key: piece.kind === 'prefab' ? piece.ref : `build:${piece.kind}`,
    label: piece.label || kind?.label || 'Stage piece', type: piece.kind === 'prefab' ? 'Copied stage piece' : `${kind?.label || 'Built'} piece`,
    name: '', model: piece.kind === 'prefab' ? piece.ref : null,
    transform: { position: piece.position, rotation: [0, piece.yaw || 0, 0], scale: [1, 1, 1] },
  };
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
  texturePaintVersion++;
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
  if (object.piece) {
    const piece = project.pieces.find(p => p.uid === id);
    piece.position = [...transform.position];
    piece.yaw = transform.rotation[1];
  } else if (object.added) project.added.find(a => a.uid === id).transform = transform;
  else project.edits[id] = { transform };
}

function syncScene() {
  if (!view || !level) return;
  view.syncObjects(objects(), selected);
  view.setStage(project, texturePaintVersion);
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

// Play in game: the launcher exports the level and starts the game in it;
// this waits until the game is closed again.
$('world-play').addEventListener('click', async () => {
  if (!project || $('world-play').disabled) return;
  if (tool === 'walk') setTool('select');
  $('world-play').disabled = true;
  flash(`Starting the game in “${project.name}”… It goes through the title and file select by itself, about half a minute.`);
  try { await window.sms.worldPlay(project); }
  catch (error) { flash(error.message || String(error), true); }
  finally { $('world-play').disabled = false; }
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
  $('world-build-panel').hidden = tool !== 'build';
  $('world-paint-texture').hidden = paintMode !== 'texture';
  $('world-paint-ground').hidden = paintMode !== 'ground';
  for (const button of document.querySelectorAll('[data-world-paint-mode]')) button.classList.toggle('active', button.dataset.worldPaintMode === paintMode);
  $('world-walk-hint').hidden = tool !== 'walk';
  page.querySelector('.world-help').hidden = tool === 'walk';
  $('world-place-hint').hidden = tool !== 'place';
  $('world-copy-hint').hidden = tool !== 'copy';
  if (placing) $('world-place-name').textContent = placing.label;
  $('world-empty-stage').textContent = project?.blank ? 'Bring back the stage\'s ground' : 'Start from an empty stage';
  view?.setOverlay((tool === 'paint' && paintMode === 'ground') || $('world-show-ground').checked);
  view?.setBuildGhost(tool === 'build' ? buildPieceSpec() : null);
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
  if (name !== 'copy') view?.endCopy();
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

for (const button of document.querySelectorAll('[data-world-paint-mode]'))
  button.addEventListener('click', () => { paintMode = button.dataset.worldPaintMode; syncButtons(); });

// Textures from the game's stages, as small images from their own pixels.
const swatchCache = new Map();
function swatchUrl(id) {
  if (!swatchCache.has(id)) {
    const entry = paletteById(id);
    if (!entry) return '';
    const canvas = document.createElement('canvas');
    canvas.width = entry.thumb.width; canvas.height = entry.thumb.height;
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(entry.thumb.rgba), entry.thumb.width, entry.thumb.height), 0, 0);
    swatchCache.set(id, canvas.toDataURL());
  }
  return swatchCache.get(id);
}

function renderTextureSwatches() {
  const box = $('world-textures');
  box.replaceChildren();
  const swatch = (id, label, image) => {
    const button = document.createElement('button');
    button.className = 'world-texture';
    button.classList.toggle('active', textureBrush === id);
    button.setAttribute('aria-pressed', String(textureBrush === id));
    button.title = label;
    const img = document.createElement('img');
    img.alt = '';
    if (image) img.src = image;
    button.append(img, label);
    button.addEventListener('click', () => { textureBrush = id; renderTextureSwatches(); });
    return button;
  };
  for (const group of levels.paletteGroups) {
    const entries = levels.palette.filter(entry => entry.group === group.id);
    if (!entries.length) continue;
    const heading = document.createElement('h3');
    heading.textContent = group.label;
    box.append(heading);
    if (group.id === 'ground') box.append(swatch(null, 'As it was', ''));
    for (const entry of entries) box.append(swatch(entry.id, entry.label, swatchUrl(entry.id)));
  }
}

// Texture pickers: a list of the palette by group, with the chosen one's image.
function fillTexturePicker(select, image, value) {
  if (!select.options.length) {
    for (const group of levels.paletteGroups) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = group.label;
      for (const entry of levels.palette.filter(e => e.group === group.id)) optgroup.append(new Option(entry.label, entry.id));
      if (optgroup.children.length) select.append(optgroup);
    }
  }
  select.value = value;
  image.src = swatchUrl(value) || '';
}

function renderBuildPanel() {
  const box = $('world-pieces');
  box.replaceChildren();
  for (const kind of BUILD.KINDS) {
    const button = document.createElement('button');
    button.className = 'world-piece';
    button.classList.toggle('active', kind.id === buildKind);
    button.setAttribute('aria-pressed', String(kind.id === buildKind));
    button.textContent = kind.label;
    button.title = kind.detail;
    button.addEventListener('click', () => {
      buildKind = kind.id;
      // Houses and roofs look like what they are from the start.
      if (kind.id === 'house') buildTextures = { top: paletteById('gelato-shingles') ? 'gelato-shingles' : buildTextures.top, side: paletteById('sirena-stucco') ? 'sirena-stucco' : buildTextures.side };
      else if (kind.id === 'roof') buildTextures = { ...buildTextures, top: paletteById('sirena-roof') ? 'sirena-roof' : buildTextures.top };
      renderBuildPanel();
      if (tool !== 'build') setTool('build');
      else syncButtons();
    });
    box.append(button);
  }
  fillTexturePicker($('world-build-top'), $('world-build-top-swatch'), buildTextures.top);
  fillTexturePicker($('world-build-side'), $('world-build-side-swatch'), buildTextures.side);
}
for (const face of ['top', 'side'])
  $(`world-build-${face}`).addEventListener('change', event => { buildTextures[face] = event.target.value; renderBuildPanel(); syncButtons(); });

const buildPieceSpec = () => ({ kind: buildKind, size: BUILD.KIND[buildKind].size, textures: { ...buildTextures }, label: BUILD.KIND[buildKind].label });

$('world-copy-piece').addEventListener('click', () => setTool('copy'));
$('world-empty-stage').addEventListener('click', () => {
  if (!project) return;
  if (project.blank) { change('Bring back the stage', () => { project.blank = false; }); return; }
  if (!confirm('Start from an empty stage? Its ground, buildings and objects go (its sea and sky stay), so you can build your own. You can undo this.')) return;
  change('Empty the stage', () => {
    project.blank = true;
    project.texturePaint = {};
    project.paint = {};
    texturePaintVersion++;
    for (const object of level.objects) if (object.transform && object.type !== 'Mario' && object.category !== 'markers') project.edits[object.id] = { removed: true };
    selected = null;
  });
  view?.repaintAll(project.paint);
});

// --- Catalog sidebar ----------------------------------------------------------------

// The catalog with the stages' own buildings to copy, as their own category.
function withStagePieces(list) {
  const items = levels.prefabs.map(prefab => {
    const world = levels.scenes[prefab.scene]?.world;
    return {
      key: `prefab:${prefab.id}`, type: 'Stage piece', variant: '', label: prefab.label, category: 'pieces', piece: true,
      worlds: world ? [world] : [], scenes: [prefab.scene], count: 1, model: prefab.ref, source: null, scale: [1, 1, 1],
      note: 'A building from the stage itself, walls, roof and ground included. Exporting copies it into this stage\'s model.',
      search: `${prefab.label} building stage piece ${levels.worldNames[world] || ''}`.toLowerCase(),
    };
  });
  return { ...list, categories: [{ id: 'pieces', label: 'Stage pieces' }, ...list.categories], items: [...items, ...list.items] };
}

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
  row.querySelector('em').textContent = item.piece ? 'piece' : item.model ? '' : 'marker';
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
  $('world-preview-detail').textContent = item.piece ? `${item.type} · from ${levels.scenes[item.scenes?.[0]]?.label || 'a stage'}` : `${item.type}${item.variant ? ` · ${item.variant}` : ''} · placed ${item.count}× on the disc`;
  $('world-preview').hidden = false;
  view?.preview(item);
}

const CATEGORY_COLORS = {
  buildings: '#d39a5b', nature: '#4fae5b', decorations: '#c97fd0', npcs: '#f2c94c', enemies: '#e3574b', bosses: '#a3242f',
  items: '#ffd64a', interactive: '#4aa3df', vehicles: '#3cc0b4', water: '#3a7bd5', effects: '#ff8a3d', markers: '#9aa7ad', system: '#6c7a80', pieces: '#b07a4f',
};
const categoryColor = id => CATEGORY_COLORS[id] || '#9aa7ad';

// A piece of the stage being edited, copied by dragging a box over it.
function copiedItem(box) {
  return {
    key: `copy:${box.join(',')}`, type: 'Stage piece', variant: '', label: 'Copied piece', category: 'pieces', piece: true,
    worlds: [], scenes: [project.base], count: 1, model: `prefab|${project.base}|${box.join(',')}`, scale: [1, 1, 1],
    note: 'Part of the stage, copied with its walls, roofs and ground.',
  };
}

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
    if (level) $('world-level-info').textContent = `${sceneLabel(project.base)}${project.blank ? ' (emptied)' : ''} · ${level.objects.filter(o => o.transform).length} objects from the disc · ${project.added.length} added · ${Object.keys(project.edits).length} edited · ${project.pieces.length} pieces built or copied · ${Object.keys(project.texturePaint).length} faces retextured · ${Object.keys(project.paint).length} ground triangles painted`;
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
  // Pieces turn about the vertical only; built ones have a size and textures instead of a scale.
  const built = object.piece && object.piece.kind !== 'prefab';
  $('world-scale-row').hidden = Boolean(object.piece);
  $('world-rot-x').disabled = $('world-rot-z').disabled = Boolean(object.piece);
  $('world-piece-fields').hidden = !built;
  if (built) {
    AXES.forEach((axis, i) => { const input = $(`world-size-${axis}`); if (document.activeElement !== input) input.value = round(object.piece.size[i], 0); });
    fillTexturePicker($('world-piece-top'), $('world-piece-top-swatch'), object.piece.textures.top);
    fillTexturePicker($('world-piece-side'), $('world-piece-side-swatch'), object.piece.textures.side);
  }
}

const selectedPiece = () => { const object = selected && objectById(selected); return object?.piece && object.piece.kind !== 'prefab' ? object.piece : null; };
for (const [i, axis] of AXES.entries())
  $(`world-size-${axis}`).addEventListener('change', event => {
    const piece = selectedPiece(), value = Number(event.target.value);
    if (!piece || !Number.isFinite(value)) { renderInspector(); return; }
    change('Resize', () => { const size = [...piece.size]; size[i] = value; piece.size = BUILD.cleanSize(piece.kind, size); });
  });
for (const face of ['top', 'side'])
  $(`world-piece-${face}`).addEventListener('change', event => {
    const piece = selectedPiece();
    if (piece) change('Retexture', () => { piece.textures = { ...piece.textures, [face]: event.target.value }; });
  });
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
    if (object.piece) project.pieces = project.pieces.filter(p => p.uid !== object.id);
    else if (object.added) project.added = project.added.filter(a => a.uid !== object.id);
    else project.edits[object.id] = { removed: true };
    selected = null;
  });
}

function duplicateSelected() {
  const object = selected && objectById(selected);
  if (!object) return;
  if (isStart(object)) { flash('A stage has one Mario start point.', true); return; }
  if (object.piece) {
    const width = object.piece.size?.[0] || 1000;
    const copy = { ...JSON.parse(JSON.stringify(object.piece)), uid: uid(), position: [object.piece.position[0] + width, object.piece.position[1], object.piece.position[2]] };
    change('Duplicate', () => { project.pieces.push(copy); selected = copy.uid; });
    return;
  }
  const t = cloneTransform(object.transform);
  t.position[0] += 200;
  const copy = { uid: uid(), key: object.key, source: object.source || { scene: project.base, id: object.id }, type: object.type, variant: object.variant, label: object.label, category: object.category, model: object.model, note: object.note, transform: t };
  change('Duplicate', () => { project.added.push(copy); selected = copy.uid; });
}

$('world-revert').addEventListener('click', () => {
  if (!project || !confirm('Undo every change to this stage? You can still undo this.')) return;
  change('Revert', () => { project.edits = {}; project.added = []; project.paint = {}; project.pieces = []; project.texturePaint = {}; project.blank = false; texturePaintVersion++; selected = null; });
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
  else if (key === 'n') setTool('build');
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
  sun.position.copy(LIGHT);
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
      texture.colorSpace = THREE.NoColorSpace;
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
      geometry.setAttribute('uv1', new THREE.BufferAttribute(mesh.uv1, 2));
      // Vertex colours stay as the game stores them: the TEV shader works in
      // display values, as the GameCube does.
      if (mesh.color) geometry.setAttribute('clr', new THREE.BufferAttribute(mesh.color, 4));
      geometry.setIndex(new THREE.BufferAttribute(mesh.index, 1));
      geometry.computeBoundingSphere();
      const material = mesh.tev ? tevMaterial(mesh, maps) : new THREE.MeshLambertMaterial({ color: 0xbbbbbb });
      return { geometry, material };
    });
    const bounds = new THREE.Box3(new THREE.Vector3(...data.bounds.min), new THREE.Vector3(...data.bounds.max));
    // What a preview frames: all but a glow (a little added light around it,
    // like a Shine's halo; not a body drawn that way, like Kazekun's cloud),
    // and not much below ground (a cannon's bunker).
    const glow = mesh => mesh.translucent && mesh.blendDst === 1;
    const faces = list => list.reduce((n, mesh) => n + mesh.index.length / 3, 0);
    const glowing = faces(data.meshes.filter(glow)) < faces(data.meshes) * 0.25;
    const solid = new THREE.Box3();
    parts.forEach(({ geometry }, i) => { if (!(glowing && glow(data.meshes[i]))) { geometry.computeBoundingBox(); solid.union(geometry.boundingBox); } });
    if (solid.isEmpty()) solid.copy(bounds);
    if (solid.max.y > 0 && solid.min.y < -solid.max.y * 0.5) solid.min.y = -solid.max.y * 0.5;
    // Mirror surfaces, turned so their facing is the reflector's +Z.
    const mirrors = (data.mirrors || []).map(mirror => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(mirror.position), 3));
      geometry.setIndex(new THREE.BufferAttribute(mirror.index, 1));
      // Which way it faces, from its triangles (the game's mirrors face the sky).
      const facing = new THREE.Vector3(), p = mirror.position, a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      for (let i = 0; i < mirror.index.length; i += 3) {
        a.fromArray(p, mirror.index[i] * 3); b.fromArray(p, mirror.index[i + 1] * 3).sub(a); c.fromArray(p, mirror.index[i + 2] * 3).sub(a);
        facing.add(b.cross(c));
      }
      if (facing.lengthSq() < 1e-9 || facing.y < 0) facing.negate();
      if (facing.lengthSq() < 1e-9) facing.set(0, 1, 0);
      const turn = new THREE.Quaternion().setFromUnitVectors(facing.normalize(), new THREE.Vector3(0, 0, 1));
      geometry.applyQuaternion(turn);
      return { geometry, back: turn.clone().invert() };
    });
    return { parts, bounds, solid, meshes: data.meshes, ground: data.ground || null, mirrors };
  }
  function instance(built) {
    const group = new THREE.Group();
    for (const { geometry, material } of built.parts) group.add(new THREE.Mesh(geometry, material));
    // Each mirror reflects for itself, with its own picture of the scene.
    for (const { geometry, back } of built.mirrors || []) {
      const mirror = new Reflector(geometry, { textureWidth: 512, textureHeight: 512, color: 0xc4ced6, multisample: 0, type: THREE.UnsignedByteType });
      mirror.quaternion.copy(back);
      // It shows the scene, not the mirror it's part of.
      const reflect = mirror.onBeforeRender;
      mirror.onBeforeRender = function (...args) {
        const own = group.children.filter(child => child !== mirror && child.visible);
        own.forEach(child => { child.visible = false; });
        reflect.apply(this, args);
        own.forEach(child => { child.visible = true; });
      };
      // A little see-through, so the tiles' seams under it show as on the real mirrors.
      mirror.material.transparent = true;
      mirror.material.fragmentShader = mirror.material.fragmentShader.replace('gl_FragColor = vec4( blendOverlay( base.rgb, color ), 1.0 );', 'gl_FragColor = vec4( blendOverlay( base.rgb, color ), 0.85 );');
      group.add(mirror);
    }
    return group;
  }
  // Lets go of what an instance holds on the GPU itself (mirrors' pictures).
  const release = root => root?.traverse(child => { if (child.isReflector) child.dispose(); });

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
  let baseGround = null, mapStage = null, seaStage = null, stageKey = '', paintedVersion = -1, blank = false;
  const painted = new THREE.Group();
  async function setLevel(data) {
    const token = ++levelToken;
    collision = null;
    overlay = null;
    mapStage = null;
    seaStage = null;
    stageKey = '';
    paintedVersion = -1;
    stage.clear();
    painted.clear();
    overlayGroup.clear();
    for (const [, entry] of nodes) dropEntry(entry);
    nodes.clear();
    const built = await Promise.all(data.stageModels.map(modelFor));
    if (token !== levelToken || disposed) return;  // another stage started loading meanwhile
    built.forEach((model, i) => {
      if (!model) return;
      const group = instance(model);
      stage.add(group);
      // The stage's own ground and buildings: what texture painting changes.
      if (data.stageModels[i].endsWith('|map/map/map.bmd')) mapStage = { group, built: model, original: model.parts.map(part => part.geometry.index), centers: null };
      if (data.stageModels[i].endsWith('|map/map/sea.bmd')) seaStage = { group, built: model };
    });
    stage.add(painted);
    baseGround = data.collision;
    collision = prepareCollision(data.collision);
    collision.baseCount = collision.count;
    overlay = buildOverlay(collision);
    overlayGroup.add(overlay.mesh);
    overlay.mesh.visible = overlayOn;
    repaintAll(project?.paint || {});
    if (project) setStage(project, texturePaintVersion);
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
    repaint(Array.from({ length: collision.baseCount ?? collision.count }, (_, t) => t), paint);
  }

  // --- The stage as the project changes it: emptied, built on, retextured ---
  function setStage(project, version) {
    if (!baseGround) return;
    blank = Boolean(project.blank);
    if (mapStage) mapStage.group.visible = !blank;
    painted.visible = !blank;
    // An emptied stage keeps the open sea, not its canals, falls and shore foam.
    if (seaStage) {
      seaStage.open ??= openSea(seaStage.built.meshes);
      seaStage.group.children.forEach((mesh, i) => { mesh.visible = !blank || i === seaStage.open; });
    }
    if (overlay) overlay.mesh.visible = overlayOn && !blank;
    const key = JSON.stringify([blank, project.pieces]);
    if (key !== stageKey) { stageKey = key; rebuildGround(project.pieces); }
    if (version !== paintedVersion) { paintedVersion = version; showTexturePaint(project.texturePaint); }
  }

  // Ground to walk and place on: the stage's (unless emptied) and the pieces'.
  let groundToken = 0;
  async function rebuildGround(pieces) {
    const token = ++groundToken;
    const extra = [], codes = [];
    const codeOf = id => { const surface = surfaces.find(s => s.id === id) || surfaces[0]; return surface.type * 256 + surface.sound; };
    for (const piece of pieces) {
      if (piece.kind === 'prefab') {
        const model = await modelFor(piece.ref);
        if (token !== groundToken) return;
        const ground = model?.ground;
        if (!ground) continue;
        const yaw = (piece.yaw || 0) * DEG, c = Math.cos(yaw), s = Math.sin(yaw), [px, py, pz] = piece.position;
        for (let i = 0; i < ground.position.length; i += 3) {
          const x = ground.position[i], y = ground.position[i + 1], z = ground.position[i + 2];
          extra.push(px + x * c + z * s, py + y, pz - x * s + z * c);
        }
        codes.push(...ground.codes);
        continue;
      }
      if (!BUILD.solid(piece)) continue;
      const floorCode = codeOf(piece.ground || paletteById(piece.textures.top)?.ground || 'stone'), stone = codeOf('stone');
      for (const face of BUILD.faces(piece)) {
        for (const p of face.p) extra.push(...p);
        codes.push(BUILD.isFloor(face.n) ? floorCode : stone);
      }
    }
    // An emptied stage keeps its sea (surface, floor and the plane that ends a fall), not to paint.
    if (blank) {
      for (let t = 0; t < baseGround.codes.length; t++) {
        if (![0x0102, 0x0700, 0x0800].includes(Math.floor(baseGround.codes[t] / 256) & 0x1fff)) continue;
        for (let k = 0; k < 9; k++) extra.push(baseGround.position[t * 9 + k]);
        codes.push(baseGround.codes[t]);
      }
    }
    const base = blank ? { position: new Float32Array(0), codes: new Uint32Array(0) } : baseGround;
    const position = new Float32Array(base.position.length + extra.length);
    position.set(base.position);
    position.set(extra, base.position.length);
    const allCodes = new Uint32Array(base.codes.length + codes.length);
    allCodes.set(base.codes);
    allCodes.set(codes, base.codes.length);
    collision = prepareCollision({ position, codes: allCodes, ground: baseGround.ground });
    collision.baseCount = base.codes.length;
  }

  // Retextured faces: taken out of the stage's own meshes and drawn again
  // with their new texture, laid over the world as the export lays it.
  function showTexturePaint(paint) {
    painted.clear();
    if (!mapStage) return;
    const byMaterial = new Map();
    for (const [key, id] of Object.entries(paint || {})) {
      const [material, face] = key.split(':').map(Number);
      if (!byMaterial.has(material)) byMaterial.set(material, new Map());
      byMaterial.get(material).set(face, id);
    }
    const byTexture = new Map();  // palette id -> [{ mesh, face }]
    mapStage.built.parts.forEach((part, i) => {
      const mesh = mapStage.built.meshes[i], faces = byMaterial.get(mesh.material);
      if (!faces) { part.geometry.setIndex(mapStage.original[i]); return; }
      const source = mapStage.original[i].array, kept = [];
      for (let f = 0; f < source.length / 3; f++) {
        const id = faces.get(f);
        if (id) { if (!byTexture.has(id)) byTexture.set(id, []); byTexture.get(id).push({ mesh, face: f }); }
        else kept.push(source[f * 3], source[f * 3 + 1], source[f * 3 + 2]);
      }
      part.geometry.setIndex(new THREE.BufferAttribute(Uint32Array.from(kept), 1));
    });
    for (const [id, list] of byTexture) {
      const tile = paletteById(id)?.tile || 800;
      const n = list.length * 3, position = new Float32Array(n * 3), normal = new Float32Array(n * 3), uv = new Float32Array(n * 2), clr = new Float32Array(n * 4);
      list.forEach(({ mesh, face }, k) => {
        const corners = [0, 1, 2].map(c => mesh.index[face * 3 + c]);
        const P = corners.map(v => [mesh.position[v * 3], mesh.position[v * 3 + 1], mesh.position[v * 3 + 2]]);
        const e1 = P[1].map((v, c) => v - P[0][c]), e2 = P[2].map((v, c) => v - P[0][c]);
        const fn = new THREE.Vector3(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]).normalize().toArray();
        corners.forEach((v, c) => {
          const o = k * 3 + c;
          position.set(P[c], o * 3);
          normal.set([mesh.normal[v * 3], mesh.normal[v * 3 + 1], mesh.normal[v * 3 + 2]], o * 3);
          uv.set(BUILD.planarUv(P[c], fn, tile), o * 2);
          clr.set(mesh.color ? [mesh.color[v * 4], mesh.color[v * 4 + 1], mesh.color[v * 4 + 2], 1] : [1, 1, 1, 1], o * 4);
        });
      });
      painted.add(texturedMesh(id, { position, normal, uv, clr }));
    }
  }

  // The sea model's mesh that spreads furthest: the open water.
  function openSea(meshes) {
    let best = -1, area = -1;
    meshes.forEach((mesh, i) => {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let k = 0; k < mesh.position.length; k += 3) { x0 = Math.min(x0, mesh.position[k]); x1 = Math.max(x1, mesh.position[k]); z0 = Math.min(z0, mesh.position[k + 2]); z1 = Math.max(z1, mesh.position[k + 2]); }
      if ((x1 - x0) * (z1 - z0) > area) { area = (x1 - x0) * (z1 - z0); best = i; }
    });
    return best;
  }

  // A mesh drawn with a palette texture's own material, once it has loaded.
  const pending = new THREE.MeshLambertMaterial({ color: 0xcccccc });
  function texturedMesh(id, { position, normal, uv, clr }) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setAttribute('uv1', new THREE.BufferAttribute(uv, 2));
    geometry.setAttribute('clr', new THREE.BufferAttribute(clr, 4));
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, pending);
    if (id) modelFor(`palette|${id}`).then(model => { const material = model?.parts[0]?.material; if (material) mesh.material = material; });
    return mesh;
  }

  // A built piece's meshes, one per texture, in world space.
  function pieceMeshes(piece) {
    const group = new THREE.Group(), byTexture = new Map();
    for (const face of BUILD.faces(piece, fitOf)) {
      if (!byTexture.has(face.texture)) byTexture.set(face.texture, []);
      byTexture.get(face.texture).push(face);
    }
    for (const [id, faces] of byTexture) {
      const entry = paletteById(id), tile = entry?.tile || 800, base = entry?.base || [235, 238, 242];
      const n = faces.length * 3, position = new Float32Array(n * 3), normal = new Float32Array(n * 3), uv = new Float32Array(n * 2), clr = new Float32Array(n * 4);
      faces.forEach((face, k) => {
        const light = BUILD.shade(face.n, base).map(v => v / 255);
        light[3] = 1;
        face.p.forEach((p, c) => {
          const o = k * 3 + c;
          position.set(p, o * 3);
          normal.set(face.n, o * 3);
          uv.set(face.uv ? face.uv[c] : BUILD.planarUv(p, face.n, tile), o * 2);
          clr.set(light, o * 4);
        });
      });
      group.add(texturedMesh(id, { position, normal, uv, clr }));
    }
    return group;
  }

  // --- Objects ---
  const nodes = new Map();  // object id -> { root, ref, transformKey }
  const selectionBox = new THREE.Box3Helper(new THREE.Box3(), 0xffd64a);
  selectionBox.visible = false;
  scene.add(selectionBox);
  let selectedId = null;

  // Built pieces are drawn where they are (their textures laid over the
  // world), so they're made again when they move or change.
  const builtPiece = object => object.piece && object.piece.kind !== 'prefab';
  const pieceRef = piece => `piece:${JSON.stringify([piece.kind, piece.size, piece.textures, piece.position, piece.yaw])}`;
  function dropEntry(entry) {
    things.remove(entry.root);
    release(entry.root);
    if (entry.built) entry.root.traverse(child => child.geometry?.dispose());
  }
  function syncObjects(list, selection) {
    const keep = new Set();
    for (const object of list) {
      if (!object.transform) continue;
      keep.add(object.id);
      let entry = nodes.get(object.id);
      const ref = builtPiece(object) ? pieceRef(object.piece) : object.model || null;
      if (!entry || entry.ref !== ref) {
        if (entry) dropEntry(entry);
        entry = { root: new THREE.Group(), ref, ready: false, type: object.type, built: builtPiece(object) };
        entry.root.userData.id = object.id;
        things.add(entry.root);
        nodes.set(object.id, entry);
        if (entry.built) { entry.root.add(pieceMeshes(object.piece)); entry.ready = true; }
        else {
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
      }
      if (!entry.built) applyTransform(entry.root, object.transform);
    }
    for (const [id, entry] of nodes) if (!keep.has(id)) { dropEntry(entry); nodes.delete(id); }
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
    if (ghost) { scene.remove(ghost); release(ghost); }
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
      copy.traverse(child => {
        if (!child.isMesh || child.isReflector) return;
        child.material = child.material.clone();
        child.material.transparent = true;
        if (child.material.uniforms?.opacity) child.material.uniforms.opacity.value = 0.6;
        else child.material.opacity = 0.6;
      });
      ghost.add(copy);
    });
  }

  // The piece the Build tool puts down, following the pointer.
  let buildGhost = null, buildGhostKey = '';
  function setBuildGhost(spec) {
    const key = spec ? JSON.stringify(spec) : '';
    if (key === buildGhostKey) return;
    buildGhostKey = key;
    if (buildGhost) { scene.remove(buildGhost); buildGhost.traverse(child => child.geometry?.dispose()); }
    buildGhost = null;
    if (!spec) return;
    buildGhost = pieceMeshes({ ...spec, position: [0, 0, 0], yaw: 0 });
    buildGhost.visible = false;
    scene.add(buildGhost);
  }
  const snap = v => Math.round(v / 50) * 50;

  // The box dragged over the stage to copy part of it.
  let copyBox = null;
  const copyHelper = new THREE.Box3Helper(new THREE.Box3(), 0x5ad1ff);
  copyHelper.visible = false;
  scene.add(copyHelper);
  function endCopy() { copyBox = null; copyHelper.visible = false; }
  function showCopyBox() {
    const { from, to } = copyBox;
    copyHelper.box.min.set(Math.min(from.x, to.x), Math.min(from.y, to.y) - 50, Math.min(from.z, to.z));
    copyHelper.box.max.set(Math.max(from.x, to.x), Math.max(from.y, to.y) + 3000, Math.max(from.z, to.z));
    copyHelper.visible = true;
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
      // A sky for mirrors to show, the colour of the panel behind the preview.
      previewScene.background = new THREE.Color(0xdbe9ee);
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
    const show = (root, box) => {
      previewScene.remove(previewRoot);
      previewRoot?.traverse(child => { if (child.userData.ownMaterial) child.material.dispose(); });
      release(previewRoot);
      previewRoot = root;
      previewScene.add(previewRoot);
      fitPreview(box);
    };
    if (item.kind && BUILD.KIND[item.kind]) { const root = pieceMeshes({ ...item, position: [0, 0, 0], yaw: 0 }); show(root, new THREE.Box3().setFromObject(root)); return; }
    modelFor(item.model).then(model => {
      if (!model || token !== previewToken) return;
      // Seen from all round: flat things (signs, paintings) from behind too.
      const root = instance(model);
      root.traverse(child => { if (child.isMesh && !child.isReflector) { child.material = child.material.clone(); child.material.side = THREE.DoubleSide; child.userData.ownMaterial = true; } });
      show(root, model.solid || model.bounds);
    });
  }
  let previewRadius = 300, previewCenter = new THREE.Vector3(), previewHeight = 0.9;
  function fitPreview(box) {
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    previewRadius = Math.max(sphere.radius, 30);
    previewCenter.copy(sphere.center);
    // Flat things (a silhouette, a mat) are seen from higher up.
    const size = box.getSize(new THREE.Vector3());
    previewHeight = size.y < 0.15 * Math.max(size.x, size.z) ? 2.4 : 0.9;
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
    const start = from ? [...from] : [...(marioStart()?.position || [0, 0, 0])];
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
      w.position.set(...(marioStart()?.position || [0, 0, 0]));
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
    if (tool === 'build') {
      const hit = surfacePoint(ray);
      if (!hit) return;
      const spec = buildPieceSpec();
      const piece = { uid: uid(), ...spec, size: [...spec.size], position: [snap(hit.point.x), Math.round(hit.point.y), snap(hit.point.z)], yaw: ghostYaw };
      change('Build', () => { project.pieces.push(piece); selected = piece.uid; });
      return;
    }
    if (tool === 'copy') {
      const hit = surfacePoint(ray);
      if (hit) { copyBox = { from: hit.point.clone(), to: hit.point.clone() }; showCopyBox(); }
      return;
    }
    if (tool === 'place' && placing?.piece) {
      const hit = surfacePoint(ray);
      if (!hit) return;
      const piece = { uid: uid(), kind: 'prefab', ref: placing.model, label: placing.label, position: [Math.round(hit.point.x), Math.round(hit.point.y), Math.round(hit.point.z)], yaw: ghostYaw };
      change('Place', () => { project.pieces.push(piece); selected = piece.uid; });
      if (!event.shiftKey) setTool('select');
      return;
    }
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
      paintMode === 'texture' ? paintTextureAt(ray) : paintAt(ray);
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
    if (tool === 'build' && buildGhost) {
      const hit = surfacePoint(rayFrom(event));
      buildGhost.visible = Boolean(hit);
      if (hit) { buildGhost.position.set(snap(hit.point.x), hit.point.y, snap(hit.point.z)); buildGhost.rotation.set(0, ghostYaw * DEG, 0); }
      return;
    }
    if (tool === 'copy' && copyBox) {
      const hit = surfacePoint(rayFrom(event));
      if (hit) { copyBox.to.copy(hit.point); showCopyBox(); }
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
      if (painting) paintMode === 'texture' ? paintTextureAt(raycaster.ray) : paintAt(raycaster.ray);
    }
  });
  const endPointer = event => {
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (tool === 'copy' && copyBox) {
      const { from, to } = copyBox;
      const box = [Math.min(from.x, to.x), Math.min(from.z, to.z), Math.max(from.x, to.x), Math.max(from.z, to.z)].map(Math.round);
      endCopy();
      if (box[2] - box[0] >= 150 && box[3] - box[1] >= 150) startPlacing(copiedItem(box));
      else flash('Drag a bigger box over what you want to copy.', true);
    }
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
  canvas.addEventListener('pointerleave', () => { brushRing.visible = false; if (ghost) ghost.visible = false; if (buildGhost) buildGhost.visible = false; });
  let ghostYaw = 0;
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    if (walker) { walker.distance = Math.max(200, Math.min(2500, walker.distance * (event.deltaY > 0 ? 1.12 : 0.89))); return; }
    if ((tool === 'place' || tool === 'build') && event.altKey) { ghostYaw = (ghostYaw + (event.deltaY > 0 ? 15 : -15) + 540) % 360 - 180; return; }
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
    if (hit && surface) paintGroundAround(hit.point, surface);
  }
  function paintGroundAround(point, surface) {
    const hit = { point };
    const { centers, normals } = collision, count = collision.baseCount ?? collision.count, r2 = brushRadius * brushRadius, changed = [];
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

  // How far (x, z) is from a triangle's corners as seen from above (0 inside it).
  function distanceToTriangle(x, z, t, o) {
    const ax = t[o], az = t[o + 1], bx = t[o + 2], bz = t[o + 3], cx = t[o + 4], cz = t[o + 5];
    const side = (px, pz, qx, qz) => (qx - px) * (z - pz) - (qz - pz) * (x - px);
    const d1 = side(ax, az, bx, bz), d2 = side(bx, bz, cx, cz), d3 = side(cx, cz, ax, az);
    if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) return 0;
    const edge = (px, pz, qx, qz) => {
      const dx = qx - px, dz = qz - pz, length = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - px) * dx + (z - pz) * dz) / length));
      return Math.hypot(x - (px + dx * t), z - (pz + dz * t));
    };
    return Math.min(edge(ax, az, bx, bz), edge(bx, bz, cx, cz), edge(cx, cz, ax, az));
  }

  // Retextures the stage's own faces under the brush (floors only, unless
  // that's off), and its ground to match if asked.
  function paintTextureAt(ray) {
    if (!mapStage || blank) return;
    const hit = raycastCollision(ray.origin, ray.direction);
    if (!hit) return;
    // Per face: its corners on the ground plane, height range and how much it faces up.
    if (!mapStage.faces) mapStage.faces = mapStage.built.meshes.map(mesh => {
      const count = mesh.index.length / 3, out = new Float32Array(count * 9), P = mesh.position;
      for (let f = 0; f < count; f++) {
        const [a, b, c] = [mesh.index[f * 3], mesh.index[f * 3 + 1], mesh.index[f * 3 + 2]];
        const o = f * 9;
        out[o] = P[a * 3]; out[o + 1] = P[a * 3 + 2]; out[o + 2] = P[b * 3]; out[o + 3] = P[b * 3 + 2]; out[o + 4] = P[c * 3]; out[o + 5] = P[c * 3 + 2];
        out[o + 6] = Math.min(P[a * 3 + 1], P[b * 3 + 1], P[c * 3 + 1]); out[o + 7] = Math.max(P[a * 3 + 1], P[b * 3 + 1], P[c * 3 + 1]);
        const e1 = [0, 1, 2].map(k => P[b * 3 + k] - P[a * 3 + k]), e2 = [0, 1, 2].map(k => P[c * 3 + k] - P[a * 3 + k]);
        const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
        out[o + 8] = ny / (Math.hypot(nx, ny, nz) || 1);
      }
      return out;
    });
    const floorsOnly = $('world-paint-floors').checked, r = brushRadius, x = hit.point.x, y = hit.point.y, z = hit.point.z;
    let changed = false;
    mapStage.built.meshes.forEach((mesh, i) => {
      if (mesh.translucent) return;  // shadows and decals stay over whatever is under them
      const faces = mapStage.faces[i];
      for (let f = 0; f < faces.length / 9; f++) {
        const o = f * 9;
        if (faces[o + 7] < y - r || faces[o + 6] > y + r) continue;
        if (floorsOnly && faces[o + 8] < 0.5) continue;
        if (Math.max(faces[o], faces[o + 2], faces[o + 4]) < x - r || Math.min(faces[o], faces[o + 2], faces[o + 4]) > x + r) continue;
        if (Math.max(faces[o + 1], faces[o + 3], faces[o + 5]) < z - r || Math.min(faces[o + 1], faces[o + 3], faces[o + 5]) > z + r) continue;
        if (distanceToTriangle(x, z, faces, o) > r) continue;
        const key = `${mesh.material}:${f}`;
        if ((project.texturePaint[key] || null) === textureBrush) continue;
        if (textureBrush) project.texturePaint[key] = textureBrush;
        else delete project.texturePaint[key];
        changed = true;
      }
    });
    if (changed) {
      painting.changed = true;
      texturePaintVersion++;
      paintedVersion = texturePaintVersion;
      showTexturePaint(project.texturePaint);
    }
    const ground = textureBrush && $('world-paint-footsteps').checked && surfaces.find(s => s.id === paletteById(textureBrush)?.ground);
    if (ground) paintGroundAround(hit.point, ground);
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
        previewCamera.position.set(previewCenter.x + Math.sin(angle) * previewRadius * 3.3, previewCenter.y + previewRadius * previewHeight, previewCenter.z + Math.cos(angle) * previewRadius * 3.3);
        previewCamera.lookAt(previewCenter);
        previewRenderer.render(previewScene, previewCamera);
      }
    }
  }
  requestAnimationFrame(tick);

  return {
    setLevel, syncObjects, frame, focus, groundBelow, walk, stopWalk, setGhost, preview, repaintAll, setStage, setBuildGhost, endCopy,
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
