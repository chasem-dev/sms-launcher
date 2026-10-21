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
