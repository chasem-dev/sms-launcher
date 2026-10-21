'use strict';

// The world editor's side in the main process: the stages on the player's
// disc, a catalog of everything placed in any of them, stages loaded for
// editing, the models the editor draws, and exports back to the game's own
// formats (map/scene.bin, map/map.col and whole data/scene/*.szs archives).

const fs = require('node:fs');
const path = require('node:path');
const { Disc } = require('./disc');
const archive = require('./archive');
const sceneBin = require('./scene-bin');
const collisionFile = require('./collision');
const j3d = require('./j3d');
const levelModel = require('./level-model');
const DATA = require('./world-data.json');

const CATALOG_VERSION = 4;
const PROJECT_FORMAT = 'sms-world';

// Stage file prefixes -> the world they belong to.
const WORLDS = [
  { id: 'dolpic', name: 'Delfino Plaza', match: /^dolpic/ },
  { id: 'airport', name: 'Delfino Airport', match: /^airport/ },
  { id: 'bianco', name: 'Bianco Hills', match: /^bia/ },
  { id: 'ricco', name: 'Ricco Harbor', match: /^ric/ },
  { id: 'mamma', name: 'Gelato Beach', match: /^mam/ },
  { id: 'pinna', name: 'Pinna Park', match: /^pinna/ },
  { id: 'sirena', name: 'Sirena Beach', match: /^sirena/ },
  { id: 'delfino', name: 'Hotel Delfino', match: /^delfino/ },
  { id: 'casino', name: 'Casino Delfino', match: /^casino/ },
  { id: 'mare', name: 'Noki Bay', match: /^mare/ },
  { id: 'monte', name: 'Pianta Village', match: /^monte/ },
  { id: 'corona', name: 'Corona Mountain', match: /^coro/ },
  { id: 'option', name: 'Title and menus', match: /^option/ },
];
const OTHER_WORLD = { id: 'other', name: 'Other stages' };

const CATEGORIES = [
  { id: 'buildings', label: 'Buildings & structures' },
  { id: 'nature', label: 'Plants & animals' },
  { id: 'decorations', label: 'Decorations & signs' },
  { id: 'npcs', label: 'NPCs' },
  { id: 'enemies', label: 'Enemies' },
  { id: 'bosses', label: 'Bosses' },
  { id: 'items', label: 'Items & collectibles' },
  { id: 'interactive', label: 'Blocks, doors & switches' },
  { id: 'vehicles', label: 'Rides & vehicles' },
  { id: 'water', label: 'Water' },
  { id: 'effects', label: 'Effects' },
  { id: 'markers', label: 'Markers & triggers' },
];

// Names players know, where the game's own type or model names don't say.
const LABELS = {
  Coin: 'Coin', CoinBlue: 'Blue coin', CoinRed: 'Red coin', FlowerCoin: 'Flower coin', CoinFish: 'Coin fish',
  Shine: 'Shine Sprite', MonumentShine: 'Shine Gate Shine', Mushroom1upX: '1-Up mushroom', NozzleBox: 'Nozzle box',
  ItemNozzle: 'FLUDD nozzle', WaterRecoverObj: 'Water refill', EggYoshi: 'Yoshi egg', RedCoinSwitch: 'Red coin switch',
  Mario: 'Mario start point', NPCKinopio: 'Toad', NPCKinojii: 'Toadsworth', NPCPeach: 'Princess Peach', NPCRaccoonDog: 'Tanooki',
  NPCSunflowerL: 'Sunflower parent', NPCSunflowerS: 'Sunflower kid', NPCBoard: 'Talking sign', NPCDummy: 'Silent NPC',
  NPCMonteM: 'Pianta man', NPCMonteMA: 'Pianta man (aloha)', NPCMonteMB: 'Pianta man (B)', NPCMonteMC: 'Pianta man (C)',
  NPCMonteMD: 'Pianta man (runner)', NPCMonteME: 'Pianta man (cannon cleaner)', NPCMonteMF: 'Pianta man (F)', NPCMonteMG: 'Pianta man (G)',
  NPCMonteMH: 'Pianta man (ukulele)', NPCMonteW: 'Pianta woman', NPCMonteWA: 'Pianta woman (A)', NPCMonteWB: 'Pianta woman (B)', NPCMonteWC: 'Pianta woman (C)',
  NPCMareM: 'Noki man', NPCMareMA: 'Noki man (A)', NPCMareMB: 'Noki man (B)', NPCMareMC: 'Noki man (C)', NPCMareMD: 'Noki man (D)',
  NPCMareW: 'Noki woman', NPCMareWA: 'Noki woman (A)', NPCMareWB: 'Noki woman (B)',
  HamuKuri: "Strollin' Stu", HaneHamuKuri: "Winged Strollin' Stu", HaneHamuKuri2: "Winged Strollin' Stu (2)", FireHamuKuri: 'Fire Stu',
  Gesso: 'Blooper', SurfGesoGreen: 'Surfing Blooper (green)', SurfGesoRed: 'Surfing Blooper (red)', SurfGesoYellow: 'Surfing Blooper (yellow)',
  ElecNokonoko: 'Electrokoopa', PoiHana: 'Cataquack', PoiHanaRed: 'Red Cataquack', SleepPoiHana: 'Sleeping Cataquack',
  StayPakkun: 'Piranha plant', BossPakkun: 'Petey Piranha', KBossPakkun: 'Petey Piranha (Bowser\'s)', BossGesso: 'Gooper Blooper',
  BossEel: 'Eely-Mouth', BossManta: 'Phantamanta', BossTelesa: 'King Boo', BossWanwan: 'Chain Chomp', BossHanachan: 'Wiggler',
  SleepBossHanachan: 'Sleeping Wiggler', Koopa: 'Bowser', KoopaJr: 'Bowser Jr.', LimitKoopaJr: 'Shadow Mario chase', TinKoopa: 'Mecha-Bowser',
  BalloonKoopaJr: 'Bowser Jr. balloon', DebuTelesa: 'Big Boo', BoxTelesa: 'Boo in a box', LoopTelesa: 'Circling Boo',
  MarioModokiTelesa: 'Boo disguised as Mario', SeeTelesa: 'Peeking Boo', PictureTeresa: 'Boo painting', PosterTeresa: 'Boo poster',
  AnimalBird: 'Bird', AnimalMew: 'Seagull', FishoidA: 'Fish school (A)', FishoidB: 'Fish school (B)', FishoidC: 'Fish school (C)', FishoidD: 'Fish school (D)',
  Butterfly: 'Butterfly', ButterflyB: 'Butterfly (B)', ButterflyC: 'Butterfly (C)', BeeHive: 'Beehive',
  WoodBox: 'Wooden crate', WoodBarrel: 'Barrel', Manhole: 'Manhole', TurboNozzleDoor: 'Turbo nozzle door', SuperHipDropBlock: 'Ground-pound block',
  Billboard: 'Billboard', DolWeathercock: 'Weathervane', MapObjFlag: 'Flag', MapObjChangeStage: 'Stage exit', WarpArea: 'Warp area',
  MapObjWaterSpray: 'Water spray', MapObjSmoke: 'Smoke', EffectFire: 'Fire', EffectPinnaFunsui: 'Pinna fountain', EffectBiancoFunsui: 'Bianco fountain',
  BigWindmill: 'Big windmill', MiniWindmill: 'Small windmill', WindmillRoof: 'Windmill roof', FerrisWheel: 'Ferris wheel', Merrygoround: 'Merry-go-round',
  PinnaCoaster: 'Roller coaster', RideCloud: 'Cloud platform', LeafBoat: 'Leaf boat', LeafBoatRotten: 'Rotten leaf boat', MammaYacht: 'Yacht',
  JumpMushroom: 'Bouncy mushroom', SandCastle: 'Sand castle', SandBird: 'Sand bird', SandBlock: 'Sand block', BrickBlock: 'Brick block',
  NormalBlock: 'Block', YoshiBlock: 'Yoshi block', IceBlock: 'Ice block', WatermelonBlock: 'Watermelon block', NormalLift: 'Lift',
  Fruit: 'Fruit', ResetFruit: 'Fruit', CoverFruit: 'Fruit (covered)', RandomFruit: 'Random fruit', BananaTree: 'Banana tree', FruitTree: 'Fruit tree',
  Palm: 'Palm tree', PalmNatume: 'Date palm', PalmOugi: 'Fan palm', PalmSago: 'Sago palm', MapObjTreeScale: 'Tree',
  SamboHead: 'Pokey head', SamboFlower: 'Pokey flower', GateKeeper: 'Polluted Piranha Plant', OrangeSeal: 'Orange goop seal',
  Cannon: 'Cannon', DemoCannon: 'Cannon (cutscene)', Rocket: 'Rocket', FruitsBoat: 'Fruit boat', FruitsBoatB: 'Fruit boat (B)',
  MapStaticObj: 'Stage piece', MapObjBase: 'Stage object', MapObjGeneral: 'Stage object', MapObjFloatOnSea: 'Floating object',
  BalloonHelp: 'Hint balloon', SwitchHelp: 'Switch hint', HideObj: 'Hidden object', HipDropHideObj: 'Ground-pound spot',
  WaterHitHideObj: 'Spray-to-reveal spot', WaterHitPictureHideObj: 'Spray-to-reveal picture', HideObjPictureTwin: 'Shine picture sign',
};
const VARIANT_LABELS = {
  coin: null, invisible_coin: 'Invisible coin', fruitcoconut: 'Coconut', fruitpapaya: 'Papaya', fruitdurian: 'Durian', fruitpine: 'Pineapple',
  fruitbanana: 'Banana', redpepper: 'Red pepper', fruitcoverpine: 'Pineapple', rocket_nozzle_item: 'Rocket', back_nozzle_item: 'Turbo',
  normal_nozzle_item: 'Hover', palmnormal: null, palmleaf: 'Leaf', flagwhite: 'White', kibako: null, mushroom1upx: null,
  monumentshine: null, eggyoshievent: 'Event', billboard_sun: 'Sun', dptweathercock: null, normallift: null, merry: null,
  coaster: null, cloud: null, jumpbase: null, mammayacht00: null, belldolpic: null, getag: null, getao: null,
};

// What the editor draws for objects the game doesn't show (invisible coins).
const STAND_IN = { invisible_coin: 'mapobj/coin.bmd' };

const FLOOR_NORMAL = 0.2;

// Ground the paint brush offers: a ground type (what Mario does on it) and a
// sound byte (his footsteps), as the game's collision code reads them.
const SURFACES = [
  { id: 'stone', label: 'Stone', detail: 'Ordinary ground with stone footsteps.', color: '#b9b2a4', type: 0x0000, sound: 0x00 },
  { id: 'grass', label: 'Grass', detail: 'Ordinary ground with grass footsteps.', color: '#62b85a', type: 0x0000, sound: 0x10 },
  { id: 'wood', label: 'Wood', detail: 'Ordinary ground with wooden footsteps.', color: '#b07a43', type: 0x0000, sound: 0x07 },
  { id: 'metal', label: 'Metal', detail: 'Ordinary ground with metal footsteps.', color: '#8ea1ad', type: 0x0000, sound: 0x0d },
  { id: 'sand', label: 'Sand', detail: 'Leaves footprints; Mario sinks in for a moment after a big fall.', color: '#ecd27c', type: 0x0701, sound: 0x05 },
  { id: 'wet', label: 'Wet ground', detail: 'Splashy footsteps and ripples, slippery on slopes.', color: '#43aecb', type: 0x0004, sound: 0x00 },
  { id: 'slippery', label: 'Slippery', detail: 'Mario always slides and can\'t grab ledges.', color: '#bfe8f7', type: 0x0001, sound: 0x02 },
  { id: 'slide', label: 'Slide', detail: 'Slides like the secret courses\' slides.', color: '#6aa9ff', type: 0x000c, sound: 0x02 },
  { id: 'bouncy', label: 'Bouncy', detail: 'Mario bounces up when he lands, with no fall damage.', color: '#ff86d0', type: 0x0007, sound: 0x1e },
  { id: 'soft', label: 'Soft landing', detail: 'No fall damage from any height.', color: '#b99cff', type: 0x000a, sound: 0x1e },
  { id: 'hurt', label: 'Hurts', detail: 'Hurts Mario when he touches it, like hot or electric floors.', color: '#f0573a', type: 0x000b, sound: 0x1d },
  { id: 'deadly', label: 'Out of bounds', detail: 'Mario loses a life if he stays on it.', color: '#3b3f44', type: 0x0600, sound: 0x00 },
];

// Every ground type the stages use, for colouring the ground by type
// (camera and shadow flag bits left out).
const GROUND_TYPES = [
  { type: 0x0000, label: 'Ground', color: '#b9b2a4' }, { type: 0x0001, label: 'Slippery', color: '#bfe8f7' },
  { type: 0x0002, label: 'Slippery slopes', color: '#bfe8f7' }, { type: 0x0003, label: 'Never slips', color: '#a79a86' },
  { type: 0x0004, label: 'Wet ground', color: '#43aecb' }, { type: 0x0005, label: 'No wall jumps', color: '#a8a39a' },
  { type: 0x0006, label: 'No ledge grabs', color: '#a8a39a' }, { type: 0x0007, label: 'Bouncy', color: '#ff86d0' },
  { type: 0x0008, label: 'Jump pad', color: '#ff86d0' }, { type: 0x0009, label: 'Jump boost', color: '#ff86d0' },
  { type: 0x000a, label: 'Soft landing', color: '#b99cff' }, { type: 0x000b, label: 'Hurts', color: '#f0573a' },
  { type: 0x000c, label: 'Slide', color: '#6aa9ff' }, { type: 0x0100, label: 'Water', color: '#2c7fd6' },
  { type: 0x0101, label: 'Hurting water', color: '#f0573a' }, { type: 0x0102, label: 'Sea', color: '#2c7fd6' },
  { type: 0x0103, label: 'Hurting water', color: '#f0573a' }, { type: 0x0104, label: 'Pool', color: '#2c7fd6' },
  { type: 0x0106, label: 'Underground', color: '#7d6a55' }, { type: 0x0107, label: 'Ground-pound through', color: '#d9a35b' },
  { type: 0x0108, label: 'Super jump', color: '#ff86d0' }, { type: 0x010a, label: 'Climbing fence', color: '#7f8f55' },
  { type: 0x010b, label: 'Underwater floor', color: '#2d5f9e' }, { type: 0x0200, label: 'Warp', color: '#9b59d0' },
  { type: 0x0202, label: 'Map change', color: '#9b59d0' }, { type: 0x0400, label: 'Mario passes through', color: '#d6d6d6' },
  { type: 0x0401, label: 'Water passes through', color: '#d6d6d6' }, { type: 0x0600, label: 'Out of bounds', color: '#3b3f44' },
  { type: 0x0700, label: 'Sea floor', color: '#3c6f8f' }, { type: 0x0701, label: 'Sand', color: '#ecd27c' },
  { type: 0x0800, label: 'Death plane', color: '#1b1d20' },
];

// Types with a variant that the camera also bumps into (bit 0x8000); painted
// ground keeps that bit where the game has the variant.
const CAMERA_TYPES = [0x0000, 0x0001, 0x0002, 0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x0008, 0x0009, 0x000a, 0x000b, 0x000c, 0x0400, 0x0701];

// Flags and value for ground types that carry a per-triangle value, when the
// stage's own file has none to copy: bounce power x100, damage table, camera.
const SURFACE_DEFAULTS = { 0x0007: { flags: 1, value: 8000 }, 0x8007: { flags: 1, value: 8000 }, 0x000b: { flags: 1, value: 0 }, 0x800b: { flags: 1, value: 0 }, 0x0600: { flags: 1, value: 0 } };

// --- Disc access ---------------------------------------------------------------

class Library {
  constructor(rom) {
    this.rom = rom;
    const stat = fs.statSync(rom);
    this.stamp = `${stat.size}-${Math.round(stat.mtimeMs)}`;
    const disc = new Disc(rom);
    try {
      this.gameId = disc.gameId;
      this.sceneFiles = [...disc.files.keys()].filter(file => /^data\/scene\/[^/]+\.szs$/.test(file)).sort(compareScenes);
    } finally { disc.close(); }
    this.archives = new Map();
    this.trees = new Map();
    this.models = new Map();
  }

  // A scene archive's files (lower-case paths), kept for the next few reads.
  files(scene) {
    if (this.archives.has(scene)) {
      const files = this.archives.get(scene);
      this.archives.delete(scene);
      this.archives.set(scene, files);
      return files;
    }
    const files = archive.rarc(this.read(archiveFile(scene)));
    this.archives.set(scene, files);
    while (this.archives.size > 6) this.archives.delete(this.archives.keys().next().value);
    return files;
  }

  read(file) {
    const disc = new Disc(this.rom);
    try { return disc.file(file); } finally { disc.close(); }
  }

  scenes() { return this.sceneFiles.map(file => file.slice('data/scene/'.length, -'.szs'.length)); }

  sceneTree(scene) {
    if (!this.trees.has(scene)) {
      const data = this.files(scene).get('map/scene.bin');
      if (!data) throw new Error(`${scene} has no scene file.`);
      this.trees.set(scene, sceneBin.parse(data));
      while (this.trees.size > 12) this.trees.delete(this.trees.keys().next().value);
    }
    return this.trees.get(scene);
  }

  // Character name -> model folder, from the game's shared scene file: each
  // manager names a character, whose ObjChara holds a folder like /scene/kinopio.
  charaFolders() {
    if (this.charas) return this.charas;
    this.charas = new Map();
    try {
      sceneBin.walk(sceneBin.parse(this.read('data/scenecmn.bin')), node => {
        if (node.children || (node.type !== 'ObjChara' && node.type !== 'SmplChara') || node.data.length < 2) return;
        const length = node.data.readUInt16BE(0);
        const folder = sceneBin.decodeName(node.data.subarray(2, 2 + length)).toLowerCase();
        if (folder.startsWith('/scene/')) this.charas.set(sceneBin.decodeName(node.nameBytes), folder.slice('/scene/'.length));
      });
    } catch (_) { /* a disc without it: characters fall back to folder names */ }
    return this.charas;
  }

  // What modelPath needs to know about a stage.
  context(scene) { return { files: this.files(scene), tree: this.sceneTree(scene), charas: this.charaFolders() }; }

  // A model as the editor draws it; refs are "scene|path inside its archive".
  model(ref) {
    if (this.models.has(ref)) return this.models.get(ref);
    const [scene, file] = splitRef(ref);
    const files = scene === 'mario' ? archive.rarc(this.read('data/mario.szs')) : scene === 'common' ? archive.rarc(this.read('data/common.szs')) : this.files(scene);
    const data = files.get(file);
    if (!data) throw new Error(`The disc has no ${file} in ${scene}.`);
    const model = j3d.parseBmd(data);
    // Mario stands as he idles, without the Shine shirt he only gets later.
    const options = ref === marioRef() && files.has(MARIO_IDLE) ? { pose: firstFrame(j3d.parseBck(files.get(MARIO_IDLE)), model), skipShapes: new Set([MARIO_ALOHA_SHAPE]) } : {};
    const baked = levelModel.bake(model, options);
    baked.bytes = bakedBytes(baked);
    this.models.set(ref, baked);
    // Stage models run to tens of megabytes: keep the latest ones, up to a budget.
    let total = 0;
    for (const entry of this.models.values()) total += entry.bytes;
    for (const [key, entry] of this.models) {
      if (total <= MODEL_BUDGET || key === ref) break;
      this.models.delete(key);
      total -= entry.bytes;
    }
    return baked;
  }

  // Lets go of everything cached; the editor reads it again when it reopens.
  release() { this.archives.clear(); this.trees.clear(); this.models.clear(); }

  // A short fingerprint of a stage as this disc has it, so a level made on
  // another disc (or another version of the game) isn't applied to this one.
  stageStamp(scene) {
    const files = this.files(scene);
    const hash = require('node:crypto').createHash('sha1');
    for (const file of ['map/scene.bin', 'map/map.col']) hash.update(files.get(file) || Buffer.alloc(0));
    return hash.digest('hex').slice(0, 16);
  }
}

const MODEL_BUDGET = 192 << 20;
function bakedBytes(baked) {
  let bytes = 0;
  for (const mesh of baked.meshes) for (const array of [mesh.position, mesh.normal, mesh.uv, mesh.color, mesh.index]) bytes += array?.byteLength || 0;
  for (const texture of baked.textures) bytes += texture?.rgba.byteLength || 0;
  return bytes;
}

const archiveFile = scene => `data/scene/${scene}.szs`;
const splitRef = ref => { const at = String(ref).indexOf('|'); return [ref.slice(0, at), ref.slice(at + 1)]; };
const makeRef = (scene, file) => `${scene}|${file}`;

// Stages in a sensible order: by world, then numbered stages in number order.
function compareScenes(a, b) {
  const key = file => file.replace(/(\d+)/g, digits => digits.padStart(4, '0'));
  return key(a).localeCompare(key(b));
}

function worldOf(scene) { return WORLDS.find(world => world.match.test(scene)) || OTHER_WORLD; }

function sceneLabel(scene) {
  const world = worldOf(scene);
  if (world === OTHER_WORLD) return scene;
  const boss = /boss/.test(scene), extra = scene.match(/_ex(\d+)$/), number = scene.match(/(\d+)$/);
  if (boss) return `${world.name} · Boss${number ? ` ${Number(number[1]) + 1}` : ''}`;
  if (extra) return `${world.name} · Secret ${Number(extra[1]) + 1}`;
  if (/undersea/.test(scene)) return `${world.name} · Undersea`;
  if (/beach/.test(scene)) return `${world.name} · Beach${number ? ` ${Number(number[1]) + 1}` : ''}`;
  return number ? `${world.name} · ${Number(number[1]) + 1}` : world.name;
}

// --- Objects -------------------------------------------------------------------

function classOf(type) {
  const entry = DATA.classes[type];
  return entry ? { category: entry[0], kind: entry[1], family: entry[2] } : { category: '', kind: '', family: '' };
}

function readTransform(data) {
  if (data.length < 36) return null;
  const f = i => data.readFloatBE(i * 4);
  const values = Array.from({ length: 9 }, (_, i) => f(i));
  if (!values.every(Number.isFinite)) return null;
  return { position: values.slice(0, 3), rotation: values.slice(3, 6), scale: values.slice(6, 9) };
}

function writeTransform(data, transform) {
  const values = [...transform.position, ...transform.rotation, ...transform.scale];
  values.forEach((value, i) => data.writeFloatBE(value, i * 4));
}

// An actor's strings after its transform: TActor's character name and light
// map (s32 count, then u32 + string each), then the class's own strings.
function actorNames(data) {
  const read = at => {
    if (at + 2 > data.length) return null;
    const length = data.readUInt16BE(at);
    return at + 2 + length <= data.length ? { text: sceneBin.decodeName(data.subarray(at + 2, at + 2 + length)), next: at + 2 + length } : null;
  };
  const character = read(36);
  if (!character) return [];
  let at = character.next;
  if (at + 4 > data.length) return [character.text];
  const lights = data.readInt32BE(at);
  at += 4;
  for (let i = 0; i < lights && i < 64; i++) { const light = read(at + 4); if (!light) return [character.text]; at = light.next; }
  const names = [character.text];
  // Then the class's strings, as long as they keep coming.
  for (let next = read(at); next && next.text && names.length < 6 && !/[\x00-\x1f]/.test(next.text); next = read(at)) {
    names.push(next.text);
    at = next.next;
  }
  return names;
}

// What an object is: its model key (map objects), manager (NPCs, enemies) or nothing.
function describe(node) {
  const info = classOf(node.type);
  const names = info.kind === 'actor' ? actorNames(node.data) : [];
  let variant = '';
  if ((info.family === 'mapobj' || info.family === 'static') && names[1]) variant = names[1];
  if (node.type === 'NozzleBox' && names[2]) variant = names[2];
  return { type: node.type, info, variant, names };
}

// The manager an actor belongs to: map objects name it in the game's table,
// characters store it as their first string.
function managerOf(described) {
  if (described.info.family === 'mapobj') return DATA.mapobj[described.variant.toLowerCase()]?.g || null;
  if (described.info.family === 'spine' || described.info.family === 'live') return described.names[1] || null;
  return null;
}

// Each manager's capacity sizes a fixed array in the game, so a stage with
// more actors than that would overrun it: raise any that are now too small.
function fitManagers(tree) {
  const counts = new Map();
  sceneBin.walk(tree, node => {
    if (node.children) return;
    const manager = managerOf(describe(node));
    if (manager) counts.set(manager, (counts.get(manager) || 0) + 1);
  });
  const raised = [];
  sceneBin.walk(tree, node => {
    if (node.children || classOf(node.type).family !== 'manager' || node.data.length < 2) return;
    const at = 2 + node.data.readUInt16BE(0);
    if (at + 4 > node.data.length) return;
    const name = sceneBin.decodeName(node.nameBytes), capacity = node.data.readInt32BE(at), needed = counts.get(name) || 0;
    if (needed > capacity) { node.data.writeInt32BE(needed, at); raised.push({ name, from: capacity, to: needed }); }
  });
  return raised;
}

// Stage pieces that only draw reflections and heat haze: nothing to place.
const HELPERS = /^(reflect|seaindirect|indirect)/i;

function categoryOf(type, variant, info) {
  const text = `${type} ${variant}`;
  if (type === 'MapStaticObj' && HELPERS.test(variant)) return null;
  switch (info.category) {
    case 'npcs': return 'npcs';
    case 'bosses': return 'bosses';
    case 'enemies': return /^(Animal|Fishoid|Butterfly)/.test(type) ? 'nature' : 'enemies';
    case 'items/collectibles': return 'items';
    case 'triggers/areas/rails': return 'markers';
    case 'effects/water/goop': return /water|pool|wave|sea|spray|funsui|fountain|bath/i.test(text) ? 'water' : 'effects';
    case 'cameras/lights/system': return type === 'Mario' ? 'markers' : null;
    case 'map & geometry': return type === 'MapStaticObj' || type === 'MareEventBumpyWall' ? 'buildings' : null;
    case 'map objects': break;
    default: return null;
  }
  if (/^(Animal|Fishoid|Butterfly)/.test(type)) return 'nature';
  if (/boat|yacht|ship|ice_?car|coaster|ferris|merry|viking|cloud|rocket|cannon|lift|swing|crane|football|cork|buoy|ukisima|surfgeso/i.test(text)) return 'vehicles';
  if (/palm|tree|flower|grass|bush|banana|rootpak|leaf(?!boat)/i.test(text)) return 'nature';
  if (/sign|billboard|flag|weathercock|arrow|lamp(?!trap)|chair|bottle|container|smoke|bell|poster|picture|mirror|kamaboko|uirou|umaibou|shellcup|geta/i.test(text)) return 'decorations';
  if (/block|box|barrel|switch|door|gate|jump|hook|panel|manhole|nail|fence|roulette|rulet|slot|srot|closet|chest|cube|puncher|hideobj|log|egg|bomb|trap|melon|basket|cogwheel|turnbridge|donchou/i.test(text)) return 'interactive';
  return 'buildings';
}

// Types whose variant is the thing itself (a fruit, a nozzle), named from it.
const VARIANT_NAMED = {
  Fruit: v => v, ResetFruit: v => `${v} (comes back)`, CoverFruit: v => `${v} (covered)`,
  ItemNozzle: v => `${v} nozzle`, NozzleBox: v => `${v} nozzle box`,
  MapObjBase: v => v, MapObjGeneral: v => v, MapStaticObj: v => v, MapObjFloatOnSea: v => v,
};

function labelOf(type, variant) {
  const base = LABELS[type] || humanize(type);
  if (!variant) return base;
  const known = VARIANT_LABELS[variant.toLowerCase()];
  if (known === null) return base;
  const nice = known || humanize(variant);
  if (VARIANT_NAMED[type]) return VARIANT_NAMED[type](nice);
  // A variant that only repeats the type's name ("Blue coin", coin_blue) adds nothing.
  const words = text => new Set(text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' '));
  const squash = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const baseWords = words(base);
  if ([...words(nice)].every(word => baseWords.has(word)) || squash(nice) === squash(base)) return base;
  return `${base} (${nice})`;
}

function humanize(name) {
  const words = String(name).replace(/^NPC/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').trim().split(/\s+/);
  const text = words.map((word, i) => i === 0 ? word : word.toLowerCase()).join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// The model file in a scene's archive that draws an object, or null.
function modelPath(context, node, described) {
  const { files } = context;
  const { info, variant, names } = described;
  if (info.family === 'mapobj' || info.family === 'static') {
    const entry = (info.family === 'mapobj' ? DATA.mapobj : DATA.static)[variant.toLowerCase()];
    const models = entry ? [].concat(entry.m || []) : [];
    for (const model of models) if (files.has(model)) return model;
    for (const guess of [`mapobj/${variant.toLowerCase()}.bmd`, `map/map/${variant.toLowerCase()}.bmd`, STAND_IN[variant.toLowerCase()]])
      if (guess && files.has(guess)) return guess;
    return null;
  }
  if (info.family === 'spine' || info.family === 'live') return characterModel(context, node.type, names[1] || '');
  // Others that name a model the way map objects do (flags, for one).
  const named = names[1] && `mapobj/${names[1].toLowerCase()}.bmd`;
  return named && files.has(named) ? named : null;
}

// A character's manager (found by name in its stage) names its folder and
// body model: the game's model table for that manager, else the folder's default.bmd.
function managerNode(tree, name) {
  let found = null;
  sceneBin.walk(tree, node => { if (!found && !node.children && classOf(node.type).family === 'manager' && sceneBin.decodeName(node.nameBytes) === name) found = node; });
  return found;
}

// NPCs and enemies keep their models in a folder named after them (kinopio/,
// gesso/, …); the body model is the one called body, model or mdl, or the largest.
const CHARACTER_FOLDERS = {
  NPCKinopio: ['kinopio'], NPCKinojii: ['kinojii'], NPCPeach: ['peach'], NPCRaccoonDog: ['raccoondog'],
  NPCSunflowerL: ['sunflower'], NPCSunflowerS: ['sunflower'], NPCBoard: ['boardnpc'],
  HamuKuri: ['hamukuri'], HaneHamuKuri: ['hamukuri'], FireHamuKuri: ['hamukuri'], Gesso: ['gesso'], ElecNokonoko: ['elecnokonoko', 'nokonoko'],
  PoiHana: ['poihana'], PoiHanaRed: ['poihana'], SleepPoiHana: ['poihana'], StayPakkun: ['pakkun'], AnimalBird: ['bird'], AnimalMew: ['mew'],
  FishoidA: ['fish'], FishoidB: ['fish'], FishoidC: ['fish'], FishoidD: ['fish'], GateKeeper: ['gatekeeper'], OrangeSeal: ['seal'],
  FruitsBoat: ['fruitsboat'], FruitsBoatB: ['fruitsboat'],
};
function characterModel(context, type, managerName) {
  const { files, tree, charas } = context;
  const manager = managerName && managerNode(tree, managerName);
  if (manager) {
    const known = DATA.managers[manager.type] || {};
    const chara = manager.data.length >= 2 ? sceneBin.decodeName(manager.data.subarray(2, 2 + manager.data.readUInt16BE(0))) : '';
    for (const folder of [known.f, charas.get(chara)].filter(Boolean))
      for (const file of [known.m && `${folder}/${known.m}`, `${folder}/default.bmd`].filter(Boolean))
        if (files.has(file)) return file;
  }
  const folders = CHARACTER_FOLDERS[type] || [type.replace(/^NPC/, '').toLowerCase()];
  for (const folder of folders) {
    const models = [...files.keys()].filter(file => file.startsWith(`${folder}/`) && file.endsWith('.bmd') && file.split('/').length === 2);
    if (!models.length) continue;
    const named = models.find(file => /body|model|mdl/.test(file));
    if (named) return named;
    return models.sort((a, b) => files.get(b).length - files.get(a).length)[0];
  }
  return null;
}

const COMMON_FOLDERS = { NPCMonteM: ['montemcommon'], NPCMonteW: ['montewcommon'], NPCMareM: ['marecommon', 'marem'], NPCMareW: ['marecommon', 'marew'] };

// Files a placed object needs from the stage it came from: its model and
// everything named like it (animations, collision), or its whole folder.
function resourcesFor(files, modelFile, described) {
  if (!modelFile) return [];
  const { info, variant } = described;
  const out = new Set();
  if (info.family === 'mapobj' || info.family === 'static') {
    const entry = (info.family === 'mapobj' ? DATA.mapobj : DATA.static)[variant.toLowerCase()] || {};
    for (const file of [].concat(entry.m || [], entry.c || [], entry.a || [], modelFile)) if (files.has(file)) out.add(file);
    const stems = new Set([...out].map(file => file.replace(/\.[^./]+$/, '')));
    for (const file of files.keys()) if (stems.has(file.replace(/\.[^./]+$/, ''))) out.add(file);
  } else {
    // Characters: their model folder, their family's shared parts (Piantas and
    // Nokis), and the parameter files characters read from map/params.
    const folders = [modelFile.split('/')[0], ...(Object.entries(COMMON_FOLDERS).find(([prefix]) => described.type?.startsWith(prefix))?.[1] || [])];
    for (const file of files.keys()) if (folders.some(folder => file.startsWith(`${folder}/`)) || file.startsWith('map/params/')) out.add(file);
  }
  return [...out].sort();
}

// --- Catalog -------------------------------------------------------------------

// Reads a stage at a time, letting the launcher get on with other work in between.
async function buildCatalog(library) {
  const items = new Map();
  for (const scene of library.scenes()) {
    await new Promise(resolve => setImmediate(resolve));
    let tree, context;
    try { context = library.context(scene); tree = context.tree; }
    catch (_) { continue; }  // a stage without a scene file (Eclipse keeps some elsewhere)
    const world = worldOf(scene).id;
    sceneBin.walk(tree, (node, id) => {
      if (node.children) return;
      const described = describe(node);
      // A stage has one Mario: his start point can be moved, not placed again.
      if (described.info.kind !== 'actor' || node.type === 'Mario') return;
      const category = categoryOf(node.type, described.variant, described.info);
      if (!category) return;
      const transform = readTransform(node.data);
      if (!transform) return;
      const key = described.variant ? `${node.type}:${described.variant.toLowerCase()}` : node.type;
      let item = items.get(key);
      if (!item) {
        items.set(key, item = {
          key, type: node.type, variant: described.variant, label: labelOf(node.type, described.variant), category,
          worlds: new Set(), scenes: new Set(), count: 0, model: null, source: { scene, id }, scale: transform.scale.map(v => round(v, 3)),
        });
      }
      item.count++;
      item.worlds.add(world);
      item.scenes.add(scene);
      if (!item.model) {
        const file = modelPath(context, node, described);
        if (file) { item.model = makeRef(scene, file); item.source = { scene, id }; item.scale = transform.scale.map(v => round(v, 3)); }
      }
    });
  }
  const worldNames = Object.fromEntries([...WORLDS, OTHER_WORLD].map(world => [world.id, world.name]));
  const categoryLabels = Object.fromEntries(CATEGORIES.map(c => [c.id, c.label]));
  const list = [...items.values()].map(item => {
    const worlds = [...item.worlds].sort((a, b) => worldOrder(a) - worldOrder(b));
    return {
      ...item, worlds, scenes: [...item.scenes].slice(0, 40),
      note: noteFor(item),
      search: [item.label, item.type, item.variant, categoryLabels[item.category], ...worlds.map(w => worldNames[w])].join(' ').toLowerCase(),
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
  return { version: CATALOG_VERSION, categories: CATEGORIES, items: list };
}

const worldOrder = id => { const i = WORLDS.findIndex(w => w.id === id); return i < 0 ? WORLDS.length : i; };
const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

function noteFor(item) {
  if (item.category === 'npcs' || item.category === 'enemies' || item.category === 'bosses')
    return 'Characters bring their manager and model folder along when you export. Some also need events or paths only their own stage has.';
  if (item.category === 'markers') return 'Shown as a marker here; the game uses it for where things happen.';
  return '';
}

// --- Stages ----------------------------------------------------------------------

function loadLevel(library, scene) {
  if (!library.scenes().includes(scene)) throw new Error('That stage isn\'t on your disc.');
  const context = library.context(scene), { files, tree } = context;
  const objects = [];
  let start = null;
  sceneBin.walk(tree, (node, id) => {
    if (node.children) return;
    const described = describe(node);
    if (described.info.kind !== 'actor') return;
    const transform = readTransform(node.data);
    if (!transform) return;
    const category = categoryOf(node.type, described.variant, described.info);
    if (node.type === 'Mario') start = { position: transform.position, rotation: transform.rotation };
    if (!category) return;
    const file = modelPath(context, node, described);
    objects.push({
      id, type: node.type, variant: described.variant, name: sceneBin.decodeName(node.nameBytes),
      label: labelOf(node.type, described.variant), category,
      key: described.variant ? `${node.type}:${described.variant.toLowerCase()}` : node.type,
      transform, model: node.type === 'Mario' ? marioRef() : file ? makeRef(scene, file) : null,
    });
  });
  const stageModels = ['map/map/sky.bmd', 'map/map/map.bmd', 'map/map/sea.bmd'].filter(file => files.has(file)).map(file => makeRef(scene, file));
  const col = files.get('map/map.col');
  const collision = col ? collisionFile.parse(col) : { position: new Float32Array(0), codes: new Uint32Array(0) };
  let ground = Infinity;
  for (let i = 1; i < collision.position.length; i += 3) ground = Math.min(ground, collision.position[i]);
  return {
    scene, label: sceneLabel(scene), objects, stageModels, mario: marioRef(),
    start: start || { position: [0, 0, 0], rotation: [0, 0, 0] },
    collision: { position: collision.position, codes: collision.codes, ground: Number.isFinite(ground) ? ground : 0 },
  };
}

const marioRef = () => 'mario|bmd/ma_mdl1.bmd';
const MARIO_IDLE = 'bck/ma_wait.bck', MARIO_ALOHA_SHAPE = 10;

// An animation's first frame as joint transforms.
function firstFrame(animation, model) {
  return model.joints.map((_, j) => {
    const track = animation.joints[j];
    if (!track) return null;
    const at = keys => keys.map(k => j3d.sampleTrack(k, 0));
    return { scale: at(track.scale), rotation: at(track.rotation), translation: at(track.translation) };
  });
}

// --- Projects --------------------------------------------------------------------

const ID = /^\d+(\/\d+){0,12}$/;
const finite3 = value => Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e7);
function cleanTransform(t) {
  if (!t || !finite3(t.position) || !finite3(t.rotation) || !finite3(t.scale)) throw new Error('This level file is damaged.');
  return { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] };
}

// A project as the renderer or a file gave it, checked and trimmed to what it may hold.
function cleanProject(input, scenes) {
  if (!input || typeof input !== 'object') throw new Error('This isn\'t a level file.');
  if (input.format !== PROJECT_FORMAT) throw new Error('This isn\'t a level file from the world editor.');
  if (!scenes.includes(input.base)) throw new Error(`This level is built on ${input.base || 'a stage'}, which isn't on your disc.`);
  const edits = {};
  for (const [id, edit] of Object.entries(input.edits || {})) {
    if (!ID.test(id)) continue;
    if (edit?.removed) edits[id] = { removed: true };
    else if (edit?.transform) edits[id] = { transform: cleanTransform(edit.transform) };
  }
  const added = (Array.isArray(input.added) ? input.added : []).slice(0, 5000).map(entry => {
    if (!entry?.source || !scenes.includes(entry.source.scene) || !ID.test(String(entry.source.id))) throw new Error('This level file is damaged.');
    const text = (value, max = 200) => String(value ?? '').slice(0, max);
    return {
      uid: text(entry.uid, 80), key: text(entry.key), source: { scene: entry.source.scene, id: String(entry.source.id) },
      type: text(entry.type, 80), variant: text(entry.variant, 80), label: text(entry.label), category: text(entry.category, 40),
      model: entry.model ? text(entry.model, 300) : null, note: text(entry.note, 400), transform: cleanTransform(entry.transform),
    };
  });
  const paint = {};
  for (const [triangle, code] of Object.entries(input.paint || {}))
    if (/^\d{1,7}$/.test(triangle) && Number.isInteger(code) && code >= 0 && code <= 0xffffff) paint[triangle] = code;
  return {
    format: PROJECT_FORMAT, version: 1, name: String(input.name || 'Untitled level').slice(0, 60), base: input.base,
    disc: String(input.disc || '').slice(0, 6), stamp: /^[0-9a-f]{16}$/.test(input.stamp) ? input.stamp : undefined,
    edits, added, paint, savedAt: new Date().toISOString(),
  };
}

// The stage's scene with the project's edits: objects moved, removed and
// added, with the managers added characters need.
function buildScene(library, project) {
  const tree = cloneNode(library.sceneTree(project.base));
  const removed = [];
  for (const [id, edit] of Object.entries(project.edits)) {
    const node = sceneBin.find(tree, id);
    if (!node || node.children || classOf(node.type).kind !== 'actor') continue;
    if (edit.removed) removed.push(id);
    else writeTransform(node.data, edit.transform);
  }
  // Remove deepest-last indexes first so the other ids stay valid.
  removed.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  for (const id of removed) {
    const parts = id.split('/'), index = Number(parts.pop());
    const parent = sceneBin.find(tree, parts.join('/'));
    parent?.children?.splice(index, 1);
  }
  const needs = new Map();  // scene -> Set of files to copy
  for (const added of project.added) {
    const sourceTree = library.sceneTree(added.source.scene);
    const source = sceneBin.find(sourceTree, added.source.id);
    if (!source || source.children || classOf(source.type).kind !== 'actor') throw new Error(`Couldn't find ${added.label} on your disc any more.`);
    const node = cloneNode(source);
    writeTransform(node.data, added.transform);
    const parentId = added.source.id.split('/').slice(0, -1).join('/');
    const sourceParent = sceneBin.find(sourceTree, parentId);
    const parent = findGroup(tree, sourceParent) || findGroup(tree, null);
    parent.children.push(node);
    // Its manager, when the stage doesn't have one by that name.
    for (const name of describe(node).names) addManager(tree, sourceTree, name);
    const context = library.context(added.source.scene), files = context.files;
    const described = describe(source);
    const model = modelPath(context, source, described);
    if (!needs.has(added.source.scene)) needs.set(added.source.scene, new Set());
    for (const file of resourcesFor(files, model, described)) needs.get(added.source.scene).add(file);
    // A map object's manager is named by the game's table, not the object.
    const manager = managerOf(described);
    if (manager) addManager(tree, sourceTree, manager);
  }
  const raised = fitManagers(tree);
  return { tree, needs, raised };
}

function cloneNode(node) {
  return { ...node, nameBytes: Buffer.from(node.nameBytes), data: Buffer.from(node.data), children: node.children ? node.children.map(cloneNode) : null };
}

// The group in `tree` matching `like` (same type and name), or else the
// stage's object group, where the game keeps most placed things.
function findGroup(tree, like) {
  let match = null, objectGroup = null, firstIdx = null;
  sceneBin.walk(tree, node => {
    if (!node.children) return;
    if (like && !match && node.type === like.type && node.nameBytes.equals(like.nameBytes)) match = node;
    if (!objectGroup && node.type === 'IdxGroup' && sceneBin.decodeName(node.nameBytes) === 'オブジェクトグループ') objectGroup = node;
    if (!firstIdx && node.type === 'IdxGroup') firstIdx = node;
  });
  return match || objectGroup || firstIdx || tree;
}

function addManager(tree, sourceTree, name) {
  let exists = false;
  sceneBin.walk(tree, node => { if (!exists && /Manager$/.test(node.type) && sceneBin.decodeName(node.nameBytes) === name) exists = true; });
  if (exists) return;
  let manager = null, managerParent = null;
  sceneBin.walk(sourceTree, (node, id) => {
    if (manager || !/Manager$/.test(node.type) || sceneBin.decodeName(node.nameBytes) !== name) return;
    manager = node;
    managerParent = sceneBin.find(sourceTree, id.split('/').slice(0, -1).join('/'));
  });
  if (!manager) return;
  const parent = findGroup(tree, managerParent);
  parent.children.push(cloneNode(manager));
}

function buildCollision(library, project) {
  const col = library.files(project.base).get('map/map.col');
  if (!col) throw new Error('This stage has no ground file.');
  return Object.keys(project.paint).length ? collisionFile.paint(col, project.paint, SURFACE_DEFAULTS) : Buffer.from(col);
}

// The whole stage archive with the project in it, Yaz0-compressed as the game stores it.
function buildArchive(library, project) {
  const tree = archive.readTree(library.read(archiveFile(project.base)));
  const { tree: scene, needs } = buildScene(library, project);
  archive.treePut(tree, 'map/scene.bin', sceneBin.serialize(scene));
  if (Object.keys(project.paint).length) archive.treePut(tree, 'map/map.col', buildCollision(library, project));
  let copied = 0;
  for (const [sourceScene, files] of needs) {
    if (sourceScene === project.base) continue;
    const sourceTree = archive.readTree(library.read(archiveFile(sourceScene)));
    for (const file of files) {
      if (archive.treeFile(tree, file)) continue;
      const found = archive.treeFile(sourceTree, file);
      if (!found) continue;
      archive.treePut(tree, originalPath(sourceTree, file), Buffer.from(found.file.data));
      copied++;
    }
  }
  return { data: archive.yaz0Encode(archive.writeTree(tree)), copied };
}

// A lower-case path with each part's letter case as its archive spells it.
function originalPath(tree, file) {
  let dir = tree.root;
  return file.split('/').map(part => {
    const entry = dir?.entries.find(e => (e.dir || e.file).name.toLowerCase() === part);
    if (entry?.dir) dir = entry.dir;
    return entry ? (entry.dir || entry.file).name : part;
  }).join('/');
}

module.exports = {
  Library, WORLDS, CATEGORIES, SURFACES, GROUND_TYPES, CAMERA_TYPES, CATALOG_VERSION, PROJECT_FORMAT, FLOOR_NORMAL, worldOf, sceneLabel, buildCatalog, loadLevel, cleanProject,
  buildScene, buildCollision, buildArchive, readTransform, writeTransform, describe, categoryOf, labelOf, humanize, fitManagers,
};
