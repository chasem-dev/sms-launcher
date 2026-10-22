'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const sceneBin = require('../src/scene-bin');
const world = require('../src/world');
const { node, actor, str, u32 } = require('./world-fixture');

// Two stages: "home" with an item manager and two coins, "away" with a Toad
// and its manager, and a palm tree.
const managerData = (chara, capacity) => Buffer.concat([str(chara), u32(capacity), u32(0)]);
function stage(managers, objects, npcs = []) {
  return sceneBin.parse(node('GroupObj', 'root', Buffer.alloc(0), [
    node('GroupObj', 'コンダクター初期化用', Buffer.alloc(0), managers),
    node('MarScene', 'scene', u32(0), [
      node('Strategy', 'strategy', Buffer.alloc(0), [
        node('IdxGroup', 'オブジェクトグループ', u32(3), objects),
        node('IdxGroup', 'ＮＰＣグループ', u32(9), npcs),
      ]),
    ]),
  ]));
}
function stages() {
  const home = stage(
    [node('MapObjManager', 'アイテムマネージャー', managerData('items', 2))],
    [actor('Coin', 'coin 0', [0, 0, 0], str('coin')), actor('Coin', 'coin 1', [100, 0, 0], str('coin'))]);
  const away = stage(
    [node('KinopioManager', 'toads', managerData('toad chara', 1))],
    [actor('Palm', 'palm 0', [5, 0, 5], str('palmNormal'))],
    [actor('NPCKinopio', 'toad 0', [9, 0, 9], Buffer.concat([str('toads'), str('(null)')]))]);
  return { home, away };
}
function library() {
  const trees = stages();
  const files = {
    home: new Map([['mapobj/coin.bmd', Buffer.alloc(1)]]),
    away: new Map([['mapobj/palmnormal.bmd', Buffer.alloc(1)], ['mapobj/palmnormal.col', Buffer.alloc(1)], ['kinopio/kinopio_body.bmd', Buffer.alloc(1)], ['kinopio/kinopio_wait.bck', Buffer.alloc(1)], ['map/params/kinopio.prm', Buffer.alloc(1)]]),
  };
  return { sceneTree: scene => trees[scene], files: scene => files[scene], scenes: () => ['home', 'away'],
    context: scene => ({ files: files[scene], tree: trees[scene], charas: new Map() }) };
}
const project = (changes = {}) => world.cleanProject({ format: 'sms-world', name: 'Test', base: 'home', edits: {}, added: [], paint: {}, ...changes }, ['home', 'away']);
const at = (tree, id) => sceneBin.find(tree, id);
const t = (position, rotation = [0, 0, 0], scale = [1, 1, 1]) => ({ position, rotation, scale });

test('actors read their transform, model key and manager', () => {
  const { home, away } = stages();
  const coin = at(home, '1/0/0/1');
  assert.deepEqual(world.readTransform(coin.data), t([100, 0, 0], [0, 90, 0]));
  assert.equal(world.describe(coin).variant, 'coin');
  const toad = world.describe(at(away, '1/0/1/0'));
  assert.deepEqual(toad.names, ['toad 0 chara', 'toads', '(null)']);
  assert.equal(toad.info.family, 'spine');
});

test('edits move and remove the stage\'s own objects', () => {
  const lib = library();
  const { tree } = world.buildScene(lib, project({ edits: { '1/0/0/0': { removed: true }, '1/0/0/1': { transform: t([1, 2, 3], [0, 45, 0], [2, 2, 2]) } } }));
  const objects = at(tree, '1/0/0').children;
  assert.equal(objects.length, 1);
  assert.equal(sceneBin.decodeName(objects[0].nameBytes), 'coin 1');
  assert.deepEqual(world.readTransform(objects[0].data), t([1, 2, 3], [0, 45, 0], [2, 2, 2]));
  // The library's own copy is untouched.
  assert.equal(at(lib.sceneTree('home'), '1/0/0').children.length, 2);
});

test('things from another stage bring their manager and files, and managers grow to fit', () => {
  const lib = library();
  const added = [
    { uid: 'a', source: { scene: 'away', id: '1/0/1/0' }, type: 'NPCKinopio', label: 'Toad', transform: t([7, 0, 7]) },
    { uid: 'b', source: { scene: 'away', id: '1/0/1/0' }, type: 'NPCKinopio', label: 'Toad', transform: t([8, 0, 8]) },
    { uid: 'c', source: { scene: 'away', id: '1/0/0/0' }, type: 'Palm', label: 'Palm tree', transform: t([1, 0, 1]) },
    { uid: 'd', source: { scene: 'home', id: '1/0/0/0' }, type: 'Coin', label: 'Coin', transform: t([3, 0, 3]) },
  ];
  const { tree, needs, raised } = world.buildScene(lib, project({ added }));
  // Toads go to the NPC group, as in their own stage; the palm and the coin to the objects.
  assert.equal(at(tree, '1/0/1').children.length, 2);
  assert.deepEqual(at(tree, '1/0/0').children.map(n => n.type), ['Coin', 'Coin', 'Palm', 'Coin']);
  assert.deepEqual(world.readTransform(at(tree, '1/0/1/1').data).position, [8, 0, 8]);
  // The Toads' manager joins the managers, before any actor, with room for both.
  const managers = at(tree, '0').children;
  assert.deepEqual(managers.map(n => sceneBin.decodeName(n.nameBytes)), ['アイテムマネージャー', 'toads']);
  assert.equal(managers[1].data.readInt32BE(2 + managers[1].data.readUInt16BE(0)), 2);
  assert.equal(managers[0].data.readInt32BE(2 + managers[0].data.readUInt16BE(0)), 3, 'three coins now share the item manager');
  assert.deepEqual(raised.map(r => r.name).sort(), ['toads', 'アイテムマネージャー'].sort());
  assert.deepEqual([...needs.get('away')].sort(), ['kinopio/kinopio_body.bmd', 'kinopio/kinopio_wait.bck', 'map/params/kinopio.prm', 'mapobj/palmnormal.bmd', 'mapobj/palmnormal.col']);
  // And the scene still writes out and reads back.
  assert.equal(sceneBin.parse(sceneBin.serialize(tree)).children.length, 2);
});

test('level files are checked before they are used', () => {
  assert.throws(() => world.cleanProject({ format: 'other' }, ['home']), /isn't a level file from the world editor/);
  assert.throws(() => world.cleanProject({ format: 'sms-world', base: 'gone' }, ['home']), /isn't on your disc/);
  assert.throws(() => world.cleanProject({ format: 'sms-world', base: 'home', added: [{ source: { scene: 'home', id: '../x' }, transform: t([0, 0, 0]) }] }, ['home']), /damaged/);
  assert.throws(() => world.cleanProject({ format: 'sms-world', base: 'home', edits: { 1: { transform: t([NaN, 0, 0]) } } }, ['home']), /damaged/);
  const clean = world.cleanProject({ format: 'sms-world', base: 'home', name: 'x'.repeat(100), edits: { 'not/an/id': { removed: true }, '1/2': { removed: true } }, paint: { 4: 1, 5: 'sand', x: 2, 6: 0x1000000 }, extra: 'dropped' }, ['home']);
  assert.equal(clean.name.length, 60);
  assert.deepEqual(clean.edits, { '1/2': { removed: true } });
  assert.deepEqual(clean.paint, { 4: 1 });
  assert.equal(clean.extra, undefined);
  assert.equal(world.cleanProject({ format: 'sms-world', base: 'home', stamp: '0123456789abcdef' }, ['home']).stamp, '0123456789abcdef');
  assert.equal(world.cleanProject({ format: 'sms-world', base: 'home', stamp: '../x' }, ['home']).stamp, undefined);
});

test('the catalog names and sorts things the way players know them', () => {
  assert.equal(world.labelOf('CoinBlue', 'coin_blue'), 'Blue coin');
  assert.equal(world.labelOf('ResetFruit', 'FruitCoconut'), 'Coconut (comes back)');
  assert.equal(world.labelOf('MapObjBase', 'SkyIsland'), 'Sky island');
  assert.equal(world.labelOf('NPCKinopio', ''), 'Toad');
  assert.equal(world.categoryOf('Palm', 'palmNormal', { category: 'map objects' }), 'nature');
  assert.equal(world.categoryOf('NormalLift', 'normallift', { category: 'map objects' }), 'vehicles');
  assert.equal(world.categoryOf('WoodBox', 'WoodBox', { category: 'map objects' }), 'interactive');
  assert.equal(world.categoryOf('MapObjBase', 'SimiHotel', { category: 'map objects' }), 'buildings');
  assert.equal(world.categoryOf('AnimalBird', '', { category: 'enemies' }), 'nature');
  assert.equal(world.categoryOf('KinopioManager', '', { category: 'managers' }), null);
  assert.equal(world.sceneLabel('bianco3'), 'Bianco Hills · 4');
  assert.equal(world.sceneLabel('coro_ex2'), 'Corona Mountain · Secret 3');
  assert.equal(world.sceneLabel('mystery'), 'mystery');
});

test('NPCs are painted the way the game picks their colours', () => {
  const material = name => ({ name, matColor: [[255, 255, 255, 255], null], tevColors: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] });
  const model = { materials: [material('_hand_mat'), material('_fuku_mat'), material('_hat')] };
  const changes = [
    [{ mode: 1, material: '_hand_mat', buf0: [[10, 20, 30, 255], [40, 50, 60, 255]] }],
    [{ mode: 2, material: '_fuku_mat', buf0: [[1, 1, 1, 255]], buf1: [[2, 2, 2, 255]] }, { mode: 0, material: '_hat', buf0: [[9, 8, 7, 255], [6, 5, 4, 255]] }],
  ];
  world.paintNpc(model, changes, [1, 5]);
  assert.deepEqual(model.materials[0].tevColors[0], [40, 50, 60, 255], 'mode 1: register 0, entry 1');
  assert.deepEqual(model.materials[1].tevColors.slice(1, 3), [[1, 1, 1, 255], [2, 2, 2, 255]], 'mode 2: registers 1 and 2, the last entry when out of range');
  assert.deepEqual(model.materials[2].matColor[0], [6, 5, 4, 255], 'mode 0: material colour');
  world.paintNpc(model, [[{ mode: 1, material: '_hand_mat', buf0: [[99, 99, 99, 255]] }]], [-1]);
  assert.deepEqual(model.materials[0].tevColors[0], [40, 50, 60, 255], 'no colour index leaves it alone');
  assert.deepEqual(world.parseNpcLook('npc:1:9,3:1,255,2:264'), { index: 1, body: [9, 3], parts: [1, 255, 2], mask: 264 });
  assert.equal(world.NPC_TYPES[21], 'NPCKinopio');
});

// With a real disc (SMS_TEST_DISC=path/to/game.iso): every stage loads, and
// an untouched stage exports to the same scene and collision.
test('stages from a real disc load and export unchanged', { skip: !process.env.SMS_TEST_DISC || !fs.existsSync(process.env.SMS_TEST_DISC) }, async () => {
  const lib = new world.Library(process.env.SMS_TEST_DISC);
  const catalog = await world.buildCatalog(lib);
  assert.ok(catalog.items.length > 200);
  for (const scene of ['dolpic0', 'bianco0']) {
    const level = world.loadLevel(lib, scene);
    assert.ok(level.objects.length > 50);
    const plain = world.cleanProject({ format: 'sms-world', base: scene }, lib.scenes());
    assert.ok(sceneBin.serialize(world.buildScene(lib, plain).tree).equals(lib.files(scene).get('map/scene.bin')));
    assert.ok(world.buildCollision(lib, plain).equals(lib.files(scene).get('map/map.col')));
  }
});

test('build pieces face outward, stand where they are put and have floors to walk on', () => {
  const build = require('../src/world-build');
  for (const kind of build.KINDS.filter(k => build.solid({ kind: k.id }))) {
    const faces = build.faces({ kind: kind.id, position: [1000, 200, -500], yaw: 30, size: kind.size, textures: { top: 'a', side: 'b' } });
    assert.ok(faces.length >= 6, kind.id);
    assert.ok(faces.some(f => build.isFloor(f.n) && f.texture === 'a'), `${kind.id} has a floor in its top texture`);
    for (const face of faces) assert.ok(Math.abs(Math.hypot(...face.n) - 1) < 1e-6);
    const lowest = Math.min(...faces.flatMap(f => f.p.map(p => p[1])));
    assert.ok(Math.abs(lowest - (kind.id === 'floor' ? 200 - kind.size[1] : 200)) < 1e-6, `${kind.id} stands on its position`);
  }
  // A block's faces all point away from its middle.
  const block = build.faces({ kind: 'block', position: [0, 0, 0], yaw: 45, size: [400, 400, 400], textures: {} });
  for (const face of block) {
    const c = [0, 1, 2].map(k => (face.p[0][k] + face.p[1][k] + face.p[2][k]) / 3 - (k === 1 ? 200 : 0));
    assert.ok(c[0] * face.n[0] + c[1] * face.n[1] + c[2] * face.n[2] > 0);
  }
  // Textures line up across pieces: laid over the world, not each piece.
  assert.deepEqual(build.planarUv([800, 0, 1600], [0, 1, 0], 800), [1, 2]);
  assert.deepEqual(build.cleanSize('wall', [1e9, -5, 'x']), [build.MAX_SIZE, build.MIN_SIZE, 80]);
});

test('level files keep their pieces, retextured faces and emptied stage, checked', () => {
  const clean = world.cleanProject({
    format: 'sms-world', base: 'home', blank: 1,
    texturePaint: { '3:12': 'delfino-sand', '3:x': 'sand', '4:5': '../bad' },
    pieces: [
      { uid: 'a', kind: 'house', position: [0, 0, 0], yaw: 15, size: [1, 2e9, 300], textures: { top: 'gelato-thatch', side: '<script>' } },
      { uid: 'b', kind: 'prefab', ref: 'prefab|home|-10,-10,10,10', position: [5, 5, 5] },
      { uid: 'c', kind: 'prefab', ref: 'prefab|gone|0,0,1,1', position: [0, 0, 0] },
      { uid: 'd', kind: 'tower', position: [0, 0, 0] },
      { uid: 'e', kind: 'block', position: [NaN, 0, 0] },
    ],
  }, ['home']);
  assert.equal(clean.blank, true);
  assert.deepEqual(clean.texturePaint, { '3:12': 'delfino-sand' });
  assert.deepEqual(clean.pieces.map(p => p.uid), ['a', 'b']);
  assert.deepEqual(clean.pieces[0].size, [20, 40000, 300]);
  assert.equal(clean.pieces[0].textures.top, 'gelato-thatch');
  assert.notEqual(clean.pieces[0].textures.side, '<script>');
  assert.equal(clean.pieces[1].ref, 'prefab|home|-10,-10,10,10');
});

test('stage models from a real disc take painted textures, built pieces and copied buildings', { skip: !process.env.SMS_TEST_DISC || !fs.existsSync(process.env.SMS_TEST_DISC) }, () => {
  const j3d = require('../src/j3d');
  const levelModel = require('../src/level-model');
  const { BmdEdit } = require('../src/bmd-edit');
  const stage = require('../src/world-stage');
  const lib = new world.Library(process.env.SMS_TEST_DISC);
  const original = lib.files('dolpic0').get('map/map/map.bmd');
  // Unchanged, the model reads back the same.
  const same = j3d.parseBmd(new BmdEdit(original).write()), before = j3d.parseBmd(original);
  assert.deepEqual(same.materials, before.materials);
  assert.deepEqual(same.shapes.map(s => [...s.index].length), before.shapes.map(s => [...s.index].length));
  assert.ok(stage.palette(lib).length >= 40);
  const faces = model => levelModel.bake(model).meshes.reduce((n, m) => n + m.index.length / 3, 0);
  const project = world.cleanProject({
    format: 'sms-world', base: 'dolpic0', texturePaint: { '20:0': 'delfino-sand', '20:1': 'bianco-grass' },
    pieces: [
      { uid: 'a', kind: 'house', position: [0, 300, 9000], yaw: 30, size: [1200, 1000, 1000], textures: { top: 'gelato-shingles', side: 'sirena-stucco' } },
      { uid: 'b', kind: 'prefab', ref: stage.prefabs(lib)[0].ref, position: [3000, 300, 12000], yaw: 90 },
    ],
  }, lib.scenes());
  const built = j3d.parseBmd(world.buildModel(lib, project));
  assert.equal(built.shapes.length, built.materials.length, 'every shape has its own material');
  assert.ok(faces(built) > faces(before));
  assert.ok(built.textures.length > before.textures.length, 'textures from other stages come along');
  const ground = require('../src/collision').parse(world.buildCollision(lib, project));
  assert.ok(ground.codes.length > require('../src/collision').parse(lib.files('dolpic0').get('map/map.col')).codes.length);
  // Emptied, only the pieces (and the open sea) are left.
  const empty = world.cleanProject({ ...project, texturePaint: {}, blank: true }, lib.scenes());
  assert.ok(faces(j3d.parseBmd(world.buildModel(lib, empty))) < faces(before) / 4);
  assert.equal(levelModel.bake(j3d.parseBmd(stage.buildSea(lib, empty))).meshes.length, 1);
});

test('edges are laid once over a side or a border, and borders are only a surface', () => {
  const build = require('../src/world-build');
  const fit = id => id === 'bank' ? 1 : 0;
  // A grassy bank keeps its shape: as wide per repeat as the side is tall, top row at the top.
  const sides = build.faces({ kind: 'floor', position: [0, 300, 0], size: [1000, 200, 1000], textures: { top: 'grass', side: 'bank' } }, fit).filter(f => f.uv);
  assert.ok(sides.length >= 8);
  for (const face of sides) face.p.forEach((p, k) => assert.ok(Math.abs(face.uv[k][1] - (0.01 + 0.98 * (300 - p[1]) / 200)) < 1e-9));
  // A border: one quad, its texture running once from the back edge to the front.
  const border = build.faces({ kind: 'border', position: [0, 300, 0], size: [2000, 20, 400], textures: { top: 'bank' } }, fit);
  assert.equal(border.length, 2);
  assert.deepEqual([...new Set(border.flatMap(f => f.uv.map(uv => Math.round(uv[1] * 100) / 100)))].sort(), [0.01, 0.99]);
  assert.equal(build.solid({ kind: 'border' }), false);
  assert.equal(build.solid({ kind: 'floor' }), true);
});

test('levels play in the game: the stage table finds each scene, and exports carry what the game loads', { skip: !process.env.SMS_TEST_DISC || !fs.existsSync(process.env.SMS_TEST_DISC) }, () => {
  const archive = require('../src/archive');
  const lib = new world.Library(process.env.SMS_TEST_DISC);
  assert.deepEqual(world.stageStart(lib, 'dolpic0'), { area: 1, episode: 0 });
  assert.deepEqual(world.stageStart(lib, 'pinnaBeach0'), { area: 5, episode: 0 });
  assert.equal(world.stageStart(lib, 'nowhere'), null);
  // A palm from another stage brings its leaves' collision (TMapObjTree loads them by name);
  // an emptied stage leaves its goop out; Bianco's lamps can't go elsewhere.
  const catalog = { model: 'airport0|mapobj/palmnormal.bmd' };
  const palm = world.cleanProject({ format: 'sms-world', base: 'dolpic0' }, lib.scenes());
  const source = world.loadLevel(lib, 'airport0').objects.find(o => o.type === 'Palm');
  palm.added.push({ uid: 'p', key: source.key, source: { scene: 'airport0', id: source.id }, type: source.type, variant: source.variant, label: 'Palm', category: 'nature', model: catalog.model, note: '', transform: source.transform });
  palm.blank = true;
  const files = archive.rarc(archive.yaz0(world.buildArchive(lib, palm).data));
  assert.ok(files.has('mapobj/palmnormalleaf01.col'));
  assert.ok(!files.has('map/ymap.ymp'));
  const lamp = world.loadLevel(lib, 'bianco0').objects.find(o => o.variant?.toLowerCase() === 'lampbianco');
  const lit = world.cleanProject({ format: 'sms-world', base: 'dolpic0', added: [{ uid: 'l', key: lamp.key, source: { scene: 'bianco0', id: lamp.id }, type: lamp.type, variant: lamp.variant, label: 'Lamp', category: 'decorations', model: null, transform: lamp.transform }] }, lib.scenes());
  assert.throws(() => world.buildScene(lib, lit), /only works in Bianco Hills/);
});

test('a message bank takes a new text for one message, or for all of them, and keeps the rest', () => {
  const head = Buffer.alloc(0x20); head.write('MESGbmg1', 0, 'ascii'); head.writeUInt32BE(2, 12);
  const inf = Buffer.alloc(0x20); inf.write('INF1', 0, 'ascii'); inf.writeUInt32BE(0x20, 4); inf.writeUInt16BE(3, 8); inf.writeUInt16BE(4, 10);
  const text = Buffer.from('\0ONE\0TWO\0THREE\0', 'latin1');
  [1, 5, 9].forEach((offset, i) => inf.writeUInt32BE(offset, 16 + i * 4));
  const dat = Buffer.concat([Buffer.from('DAT1\0\0\0\0', 'latin1'), text, Buffer.alloc(32 - (text.length + 8) % 32)]);
  dat.writeUInt32BE(dat.length, 4);
  const file = Buffer.concat([head, inf, dat]);
  const read = data => {
    const d = 0x40, at = i => data.readUInt32BE(0x30 + i * 4) + d + 8;
    return [0, 1, 2].map(i => data.toString('latin1', at(i), data.indexOf(0, at(i))));
  };
  assert.deepEqual(read(file), ['ONE', 'TWO', 'THREE']);
  const renamed = world.setMessages(file, { 1: 'SUNSET COVE' });
  assert.deepEqual(read(renamed), ['ONE', 'SUNSET COVE', 'THREE']);
  assert.equal(renamed.readUInt32BE(8), renamed.length);
  assert.deepEqual(read(world.setMessages(file, {}, '')), ['', '', '']);
});
