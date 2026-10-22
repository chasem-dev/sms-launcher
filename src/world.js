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
const stage = require('./world-stage');
const DATA = require('./world-data.json');

const CATALOG_VERSION = 9;
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
  BiaWatermill: 'Bianco watermill', BiaWatermillVertical: 'Bianco watermill (upright)', BiaBell: 'Bianco bell', BiaTurnBridge: 'Turning bridge',
  BellWatermill: 'Watermill bell', BellDolpicPolice: 'Delfino bell (police)', BellDolpicTV: 'Delfino bell (TV)', DptMonteFence: 'Pianta fence',
  BathtubPeach: 'Peach in the bathtub', Bathtub: 'Bathtub', SandBombBase: 'Sand sculpture', SandEgg: 'Sand egg', SandLeafBase: 'Sand leaf base',
  SlotDrum: 'Slot drum', ItemSlotDrum: 'Item slot drum', TelesaSlot: 'Boo slot drum', CasinoPanelGate: 'Casino panel gate', CasinoRoulette: 'Casino roulette',
  Roulette: 'Roulette', Item: 'Item', MapObjNail: 'Nail', MapObjSwitch: 'Switch', MapObjRootPakkun: 'Piranha vines', MapObjTreeScale: 'Swaying tree',
  FenceInner: 'Inner fence', FenceRevolve: 'Revolving fence', FenceWaterH: 'Water fence (across)', FenceWaterV: 'Water fence (upright)', RailFence: 'Rail fence',
  RailBlock: 'Rail block', RailBlockB: 'Rail block (blue)', RailBlockR: 'Rail block (red)', RollBlock: 'Roll block', RollBlockB: 'Roll block (blue)', RollBlockY: 'Roll block (yellow)',
  WoodBlock: 'Wood block', BoxTelesa: 'Boo in a box', GateShell: 'Shell gate', JumpBase: 'Jump base', IceBlock: 'Ice block', PanelBreak: 'Breaking panel',
  PanelRevolve: 'Revolving panel', ChestRevolve: 'Revolving chest', ExRollCube: 'Rolling cube', EXRollCube: 'Rolling cube', Closet: 'Closet', Cogwheel: 'Cogwheel',
  MareGate: 'Noki gate', MareFall: 'Noki waterfall', MareCork: 'Cork', CraneRotY: 'Turning crane', craneUpDown: 'Crane (up and down)', CraneUpDown: 'Crane (up and down)',
  LeanMirror: 'Leaning mirror', GetaGreen: 'Geta (green)', GetaOrange: 'Geta (orange)', GoalFlag: 'Goal flag', SwingBoard: 'Swing board',
  SirenabossWall: 'Hotel boss wall', MapObjSteam: 'Steam', DoroHaneKuri: 'Goop-winged Stu', BossDangoHamuKuri: 'Giant Strollin\' Stu stack', LampTrapIron: 'Lamp trap (iron)', LampTrapSpike: 'Lamp trap (spiked)',
};
const VARIANT_LABELS = {
  coin: null, invisible_coin: 'Invisible coin', fruitcoconut: 'Coconut', fruitpapaya: 'Papaya', fruitdurian: 'Durian', fruitpine: 'Pineapple',
  fruitbanana: 'Banana', redpepper: 'Red pepper', fruitcoverpine: 'Pineapple', rocket_nozzle_item: 'Rocket', back_nozzle_item: 'Turbo',
  normal_nozzle_item: 'Hover', palmnormal: null, palmleaf: 'Leaf', flagwhite: 'White', kibako: null, mushroom1upx: null,
  monumentshine: null, eggyoshievent: 'Event', billboard_sun: 'Sun', dptweathercock: null, normallift: null, merry: null,
  coaster: null, cloud: null, jumpbase: null, mammayacht00: null, belldolpic: null, getag: null, getao: null,
  dptcannon: 'Delfino cannon', dptcoronafence: 'Corona fence', mammasurfboardstand: 'Surfboard stand', riccohericopter: 'Helicopter', riccogangway: 'Gangway',
  riccogrille: 'Grille', simihotel: 'Hotel goop stain', coral00: 'Coral', pile: 'Wooden pile', biabridge: 'Bianco bridge',
  biadoor: 'Bianco door', mapobjpachinkonail: 'Pachinko nail', bottle_large: 'Juice bottle', watergun_item: 'FLUDD', sandbombbaseshit: 'Swirl',
  sandeggrepair: 'Mended', koopajrsignm: 'Bowser Jr.\'s M', chipshine: 'Shine', star_sign: 'star', rulet00: '1', rulet01: '2', rulet02: '3', fence3x3: '3×3', bamboofence_revolve_outer: 'Bamboo', bamboorailfence: 'Bamboo',
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
  archiveFiles(scene) {
    return scene === 'mario' ? archive.rarc(this.read('data/mario.szs')) : scene === 'common' ? archive.rarc(this.read('data/common.szs')) : this.files(scene);
  }

  // A file from the given stage, or the first stage that has it (shared
  // textures like the goop one, NPC parts from another stage's folder).
  findFile(file, scene) {
    const own = this.archiveFiles(scene).get(file);
    if (own) return own;
    // Which stage has each file, read once (a couple of seconds) the first time it's needed.
    if (!this.fileIndex) {
      this.fileIndex = new Map();
      for (const other of this.scenes()) {
        let files;
        try { files = this.archives.get(other) || archive.rarc(this.read(archiveFile(other))); } catch (_) { continue; }
        for (const path of files.keys()) if (!this.fileIndex.has(path)) this.fileIndex.set(path, other);
      }
    }
    const where = this.fileIndex.get(file);
    return where ? this.files(where).get(file) : null;
  }

  // A model file read once and kept while its stage is.
  parsed(scene, file) {
    const key = `${scene}|${file}`;
    this.parsedModels ||= new Map();
    if (!this.parsedModels.has(key)) {
      const data = this.files(scene).get(file);
      if (!data) throw new Error(`The disc has no ${file} in ${scene}.`);
      this.parsedModels.set(key, j3d.parseBmd(data));
      while (this.parsedModels.size > 8) this.parsedModels.delete(this.parsedModels.keys().next().value);
    }
    return this.parsedModels.get(key);
  }

  // A baked model made some other way (palette textures, copied pieces), kept like the rest.
  cached(ref, make) {
    if (this.models.has(ref)) return this.models.get(ref);
    const baked = make();
    baked.bytes = bakedBytes(baked);
    this.remember(ref, baked);
    return baked;
  }
  remember(ref, baked) {
    this.models.set(ref, baked);
    // Stage models run to tens of megabytes: keep the latest ones, up to a budget.
    let total = 0;
    for (const entry of this.models.values()) total += entry.bytes;
    for (const [key, entry] of this.models) {
      if (total <= MODEL_BUDGET || key === ref) break;
      this.models.delete(key);
      total -= entry.bytes;
    }
  }

  model(ref) {
    const made = stage.stageModel(this, ref);
    if (made) return made;
    if (this.models.has(ref)) return this.models.get(ref);
    const [scene, file, extra] = splitRef(ref);
    const files = this.archiveFiles(scene);
    const data = files.get(file);
    if (!data) throw new Error(`The disc has no ${file} in ${scene}.`);
    const model = j3d.parseBmd(data);
    swapTextures(this, model, scene, file.split('/')[0]);
    materialTableFor(this, model, scene, file);
    // Mario's goop shows where a mask beats konst colour 0's alpha, like NPCs'; his is clean too (TMario's draw).
    if (ref === marioRef()) cleanNpc(model);
    // Spray-to-reveal pictures take their colour from their scene entry (TWaterHitPictureHideObj::load).
    if (extra?.startsWith('tint:')) {
      const rgb = extra.slice(5).split(',').map(Number);
      for (const material of model.materials) material.tevColors[0] = [...rgb, 255];
    }
    RUNTIME_LOOKS[file]?.(this, model);
    const npc = extra?.startsWith('npc:') ? parseNpcLook(extra) : null;
    if (npc) {
      paintNpc(model, DATA.npcs[npc.index]?.colors || [], [npc.body[0], npc.body[1]]);
      cleanNpc(model);
    }
    // Mario stands as he idles, without the Shine shirt he only gets later;
    // other characters as they wait in the game, not in their modelling pose.
    const options = ref === marioRef() && files.has(MARIO_IDLE) ? { pose: firstFrame(j3d.parseBck(files.get(MARIO_IDLE)), model), skipShapes: new Set([MARIO_ALOHA_SHAPE]) }
      : { pose: waitPose(this, model, scene, file) };
    const baked = JOINT_OBJECTS[file] ? jointObjects(this, model, scene, file) : levelModel.bake(model, options);
    if (npc) addNpcParts(this, baked, model, scene, file, npc, options.pose);
    RUNTIME_SHAPES[file]?.(baked);
    // Gelato's leaning mirrors reflect the scene through their top (TLeanMirror::load's
    // "<name>Top.bmd", a TMirrorModelObj): its surface, for the editor to draw as a mirror.
    const top = /^mapobj\/mirror[lms]\.bmd$/.test(file) && files.get(file.replace('.bmd', 'top.bmd'));
    // It lies just under the mirror's tiled top; drawn a little above it here, so it shows.
    if (top) {
      const highest = baked.meshes.reduce((y, mesh) => { for (let i = 1; i < mesh.position.length; i += 3) y = Math.max(y, mesh.position[i]); return y; }, -Infinity);
      baked.mirrors = levelModel.bake(j3d.parseBmd(top)).meshes.map(mesh => {
        const position = Float32Array.from(mesh.position);
        let lowest = Infinity;
        for (let i = 1; i < position.length; i += 3) lowest = Math.min(lowest, position[i]);
        for (let i = 1; i < position.length; i += 3) position[i] += highest + 2 - lowest;
        return { position, index: mesh.index };
      });
    }
    baked.bytes = bakedBytes(baked);
    this.remember(ref, baked);
    return baked;
  }

  // Lets go of everything cached; the editor reads it again when it reopens.
  release() { this.archives.clear(); this.trees.clear(); this.models.clear(); this.parsedModels?.clear(); this.fileIndex = null; this.paletteCache = null; }

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
// Model refs: "scene|path in its archive", with "|npc:…" for an NPC's own look.
const splitRef = ref => String(ref).split('|');
const makeRef = (scene, file, extra = '') => extra ? `${scene}|${file}|${extra}` : `${scene}|${file}`;

// --- How the game dresses models at runtime ------------------------------------

// Placeholder textures the game swaps for real ones as it loads models: the
// goop texture on characters that can be gooped, Piantas' straw skirts and the
// jellyfish. A placeholder named "…_dummy" otherwise takes the model's texture
// of the same name without it (Peach's parts, FLUDD).
// Some only for the models whose code swaps them (the goop generators, the
// goop piranha plant, the goop slugs and Kukku), by their folder.
const GOOP = 'map/pollution/h_ma_rak.bti';
const TEXTURE_SWAPS = {
  h_ma_rak_dummy: { file: GOOP }, q_kepper_dummy_128ia4: { file: GOOP, folders: ['gatekeeper'] },
  q_gene_dummy_i4: { file: GOOP, folders: ['clauncher', 'hamukuril'] }, k_name_dummy: { file: GOOP, folders: ['namekuri', 'tori'] },
  i_mom_mino_dummyi4: { file: 'montemcommon/i_mom_mino_rgba.bti' }, i_mow_mino_dummyi4: { file: 'montewcommon/i_mow_mino_rgba.bti' },
  j_jellyfish_dummy: { file: 'marejellyfish/j_kurage.bti' },
};
function swapTextures(library, model, scene, folder, donor = null) {
  model.textures.forEach((texture, i) => {
    const name = texture.name.toLowerCase(), swap = TEXTURE_SWAPS[name];
    const file = swap && (!swap.folders || swap.folders.some(f => folder.startsWith(f))) ? swap.file : null;
    if (swap) {
      if (!file) return;
      const data = library.findFile(file, scene);
      if (data) model.textures[i] = { ...j3d.decodeBti(data, 0), name: texture.name };
      return;
    }
    if (!name.endsWith('_dummy')) return;
    const real = [...model.textures, ...(donor?.textures || [])].find(t => t.name.toLowerCase() === name.slice(0, -'_dummy'.length));
    if (real) model.textures[i] = { ...real, name: texture.name };
  });
}

// A character's waiting pose: the first frame of its own "wait" animation
// (the plain one, not its start, end, fall or gooped variants), from its
// folder or its family's shared one, where it fits the model's joints.
const WAIT_SKIP = /fall|yogore|anger|fear|start|end|turn|towait|close|arrow|osen|ororo|nwait|_[bc]\.bck$/;
const FAMILY_WAITS = { montem: 'montemcommon/mom_wait.bck', montew: 'montewcommon/mow_wait.bck' };
function waitPose(library, model, scene, file) {
  const folder = file.split('/')[0];
  if (folder === 'mapobj' || folder === 'map' || !model.joints.length) return null;
  const files = library.archiveFiles(scene);
  const own = [...files.keys()].filter(k => k.startsWith(`${folder}/`) && k.endsWith('.bck') && /wait/.test(k.split('/').pop()) && !WAIT_SKIP.test(k.split('/').pop()))
    .sort((a, b) => a.length - b.length);
  const family = Object.entries(FAMILY_WAITS).find(([prefix]) => folder.startsWith(prefix))?.[1];
  for (const name of [...own, ...(family ? [family] : [])]) {
    const data = files.get(name) || library.findFile(name, scene);
    if (!data) continue;
    try {
      const animation = j3d.parseBck(data);
      // The root stays where the model has it: some animations turn or move
      // the whole character, which the game's own placement undoes.
      if (animation.joints.length === model.joints.length) return firstFrame(animation, model).map((joint, j) => j === 0 ? null : joint);
    } catch (_) { /* not one this reader understands */ }
  }
  return null;
}

// Models that are only a skeleton: the game puts an object on each joint by
// its name (TJointCoin, TSandBird) and doesn't draw the model itself.
const COIN_JOINTS = [['redcoin', 'mapobj/coin_red.bmd'], ['bluecoin', 'mapobj/coin_blue.bmd'], ['coin', 'mapobj/coin.bmd'], ['dust', null]];
const JOINT_OBJECTS = {
  'mapobj/coinfish.bmd': COIN_JOINTS,
  'mapobj/sandbird.bmd': [...COIN_JOINTS, ['none', null], ['', 'mapobj/sandbirdblock.bmd']],
};
function jointObjects(library, model, scene, file) {
  const animation = library.archiveFiles(scene).get(file.replace(/\.bmd$/, '.bck'));
  const world = levelModel.jointWorld(model, animation ? firstFrame(j3d.parseBck(animation), model) : null);
  const baked = { meshes: [], textures: [], bounds: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] } };
  // The last joint is the root's end; TJointCoin::loadAfter stops before it.
  for (let j = 0; j < model.joints.length - 1; j++) {
    const name = model.joints[j].name.toLowerCase();
    const rule = JOINT_OBJECTS[file].find(([part]) => name.includes(part));
    if (!rule?.[1]) continue;
    levelModel.merge(baked, copyBaked(library.model(makeRef(scene, rule[1]))), world[j]);
  }
  if (!baked.meshes.length) baked.bounds = { min: [0, 0, 0], max: [0, 0, 0] };
  return baked;
}
// A baked model's own copy, to move into another (merge changes what it's given).
function copyBaked(baked) {
  return {
    textures: [...baked.textures], bounds: { min: [...baked.bounds.min], max: [...baked.bounds.max] },
    meshes: baked.meshes.map(mesh => ({
      ...mesh, position: Float32Array.from(mesh.position), normal: Float32Array.from(mesh.normal),
      tev: mesh.tev && { ...mesh.tev, stages: mesh.tev.stages.map(stage => ({ ...stage })) },
    })),
  };
}

// Models the game draws its own way rather than with their materials.
// Phantamanta (TBossMantaManager::drawMantaShadow): its shape is drawn into
// the alpha buffer, then filled with one colour from its parameters, added
// over half of what's behind it.
const RUNTIME_LOOKS = {
  'manta/manta.bmd': (library, model) => {
    const color = mantaColor(library);
    model.materials = model.materials.map(material => ({
      ...material, cull: 0, blend: { type: 1, src: 1, dst: 5 }, kColors: [color, ...material.kColors.slice(1)],
      alphaTest: { comp0: 7, ref0: 0, op: 0, comp1: 7, ref1: 0 }, textures: material.textures.map(() => -1),
      stages: [{ colorIn: [15, 15, 15, 14], colorOp: 0, colorBias: 0, colorScale: 0, colorClamp: true, colorReg: 0, alphaIn: [7, 7, 7, 6], alphaOp: 0, alphaBias: 0,
        alphaScale: 0, alphaClamp: true, alphaReg: 0, texCoord: 0xff, texMap: 0xff, channel: 0xff, kColorSel: 0x0c, kAlphaSel: 0x1c }],
    }));
  },
};
// And drawn as something else than their model's shape. Phantamanta's model
// is a shadow volume, an upright prism of its outline: the game colours where
// it cuts through the ground and water, so it shows as a flat silhouette
// there. Here, the prism's top, laid on the ground.
const RUNTIME_SHAPES = {
  'manta/manta.bmd': baked => {
    for (const mesh of baked.meshes) {
      const kept = [];
      for (let f = 0; f < mesh.index.length; f += 3) {
        const [a, b, c] = [mesh.index[f], mesh.index[f + 1], mesh.index[f + 2]].map(v => [0, 1, 2].map(k => mesh.position[v * 3 + k]));
        const e1 = [0, 1, 2].map(k => b[k] - a[k]), e2 = [0, 1, 2].map(k => c[k] - a[k]);
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        if (n[1] > 0.5 * Math.hypot(...n)) kept.push(mesh.index[f], mesh.index[f + 1], mesh.index[f + 2]);
      }
      mesh.index = Uint32Array.from(kept);
      for (let i = 1; i < mesh.position.length; i += 3) mesh.position[i] = 5;
      for (let i = 0; i < mesh.normal.length; i += 3) { mesh.normal[i] = 0; mesh.normal[i + 1] = 1; mesh.normal[i + 2] = 0; }
    }
    baked.bounds.min[1] = baked.bounds.max[1] = 5;
  },
};

// Phantamanta's colour from the game's parameters (params.szs, enemy/bossmanta.prm).
function mantaColor(library) {
  const color = [196, 128, 95, 128];
  try {
    const file = archive.rarc(library.read('data/params.szs')).get('enemy/bossmanta.prm');
    for (let at = 4, n = file.readUInt32BE(0), i = 0; i < n; i++) {
      const length = file.readUInt16BE(at + 2), name = file.toString('latin1', at + 4, at + 4 + length), size = file.readUInt32BE(at + 4 + length);
      const slot = ['mSLMantaRed', 'mSLMantaGreen', 'mSLMantaBlue', 'mSLMantaAlpha'].indexOf(name);
      if (slot >= 0 && size === 4) color[slot] = file.readInt32BE(at + 8 + length) & 0xff;
      at += 8 + length + size;
    }
  } catch (_) { /* the game's defaults then */ }
  return color;
}

// NPCs, by the game's NPC init index (SMSGetNpcInitData).
const NPC_TYPES = ['NPCMonteM', 'NPCMonteMA', 'NPCMonteMB', 'NPCMonteMC', 'NPCMonteMD', 'NPCMonteME', 'NPCMonteMF', 'NPCMonteMG', 'NPCMonteMH',
  'NPCMonteW', 'NPCMonteWA', 'NPCMonteWB', 'NPCMonteWC', 'NPCMareM', 'NPCMareMA', 'NPCMareMB', 'NPCMareMC', 'NPCMareMD',
  'NPCMareW', 'NPCMareWA', 'NPCMareWB', 'NPCKinopio', 'NPCKinojii', 'NPCPeach', 'NPCRaccoonDog', 'NPCSunflowerL', 'NPCSunflowerS', 'NPCDummy', 'NPCBoard'];
// Where a family's shared parts live (TMonteMBase… keepers), before the NPC's own folder.
const NPC_PART_FOLDERS = { NPCMonteM: 'montemcommon', NPCMonteW: 'montewcommon', NPCMareM: 'marem', NPCMareW: 'marew' };

// An NPC's look from its scene entry (TBaseNPC::load): after the manager and
// path names, colour indexes for body and clothes, for parts, and which parts it wears.
function npcLook(node, described) {
  const index = NPC_TYPES.indexOf(node.type);
  if (index < 0 || node.type === 'NPCDummy' || node.type === 'NPCBoard') return null;
  const at = actorNamesEnd(node.data, 3);
  if (at < 0 || at + 28 > node.data.length) return null;
  const int = k => node.data.readInt32BE(at + k * 4);
  let mask = Math.max(0, int(6));
  if (node.type === 'NPCPeach') mask |= 6 | (mask & 0x10 ? 0x60 : 0);
  return `npc:${index}:${int(0)},${int(1)}:${int(3)},${int(4)},${int(5)}:${mask}`;
}
function parseNpcLook(extra) {
  const [, index, body, parts, mask] = extra.split(':');
  return { index: Number(index), body: body.split(',').map(Number), parts: parts.split(',').map(Number), mask: Number(mask) };
}

// What a placed object's scene entry changes about its look: an NPC's
// colours and parts, a spray-to-reveal picture's colour (its last three numbers).
const TINTED = new Set(['WaterHitPictureHideObj', 'HideObjPictureTwin']);
function lookOf(node, described) {
  if (TINTED.has(node.type) && node.data.length >= 12) {
    const n = node.data.length, rgb = [12, 8, 4].map(k => node.data.readInt32BE(n - k) & 0xff);
    return `tint:${rgb.join(',')}`;
  }
  return npcLook(node, described);
}

// The game's colour changes (SMS_InitChangeNpcColor): mode 0 sets material
// colour 0, mode 1 TEV register 0, mode 2 registers 1 and 2; each picks the
// entry its colour index says.
function paintNpc(model, changes, indexes) {
  changes.forEach((list, slot) => {
    const at = indexes[slot];
    for (const change of list || []) {
      const material = model.materials.find(m => m.name === change.material);
      if (!material || !(at >= 0)) continue;
      const pick = buffer => buffer && buffer[Math.min(at, buffer.length - 1)];
      if (change.mode === 0 && pick(change.buf0)) material.matColor[0] = [...pick(change.buf0).slice(0, 3), 255];
      if (change.mode === 1 && pick(change.buf0)) material.tevColors[0] = [...pick(change.buf0)];
      if (change.mode === 2) {
        if (pick(change.buf0)) material.tevColors[1] = [...pick(change.buf0)];
        if (pick(change.buf1)) material.tevColors[2] = [...pick(change.buf1)];
      }
    }
  });
}

// The parts an NPC wears (hats, shells, glasses, Peach's hair), each painted
// and put on its joint (TNpcParts).
function addNpcParts(library, baked, body, scene, bodyFile, npc, pose = null) {
  const info = DATA.npcs[npc.index];
  if (!info) return;
  const type = NPC_TYPES[npc.index];
  const common = Object.entries(NPC_PART_FOLDERS).find(([prefix]) => type.startsWith(prefix))?.[1];
  const folders = [common, bodyFile.split('/')[0]].filter(Boolean);
  const joints = levelModel.jointWorld(body, pose);
  let bmt;
  info.parts.forEach((part, bit) => {
    if (!part || !part.bmd || !(npc.mask & (1 << bit))) return;
    const data = folders.map(folder => library.findFile(`${folder}/${part.bmd.toLowerCase()}`, scene)).find(Boolean);
    if (!data) return;
    const model = j3d.parseBmd(data);
    if (part.bmt) {
      bmt ??= (() => { const table = library.findFile('marecommon/mare.bmt', scene); return table ? j3d.parseBmt(table) : null; })();
      if (bmt) useMaterialTable(model, bmt);
    }
    swapTextures(library, model, scene, folders[0], body);
    paintNpc(model, [part.colors], [npc.parts[part.slot]]);
    cleanNpc(model);
    const joint = part.joint === '__ROOT_JOINT__' ? -1 : body.joints.findIndex(j => j.name === part.joint);
    const matrix = joint >= 0 ? joints[joint] : levelModel.compose([1, 1, 1], [0, 0, 0], [0, 0, 0]);
    levelModel.merge(baked, levelModel.bake(model), matrix);
  });
}

// NPCs that aren't gooped: konst colour 0 white with alpha 0 on every
// material but the eyes, as TBaseNPC sets it for a clean NPC (NpcInitPrg.cpp).
function cleanNpc(model) {
  for (const material of model.materials) if (!/eye/i.test(material.name)) material.kColors[0] = [255, 255, 255, 0];
}

// A material table over a model (J3DModelData::setMaterialTable): its
// texture list replaces the model's, slot for slot, and unless only textures
// are wanted, its materials replace the model's ones of the same name.
// `unify` then gives every material the first one's texture (SMS_UnifyMaterial).
function useMaterialTable(model, table, { textures = false, unify = false } = {}) {
  if (table.textures.length) {
    const list = [...model.textures];
    table.textures.forEach((texture, i) => { list[i] = texture; });
    model.textures = list;
  }
  if (!textures) model.materials = model.materials.map(material => table.materials.find(m => m.name === material.name) || material);
  // SMS_UnifyMaterial: every material takes the first one's texture in slot
  // 0, keeping its own colour combiner. (Where the first has none, the game
  // draws with whatever texture was loaded last; the material's own stays here.)
  const shared = model.materials[0]?.textures[0];
  if (unify && shared >= 0) model.materials = model.materials.map(material => ({ ...material, textures: [shared, ...material.textures.slice(1)] }));
}

// Map objects the game dresses from a shared material table, by their type
// (TMapObjBase::initModelData): wooden crates, barrels, Bianco Hills' and the
// sand sculptures' pieces, mirrors, nozzle items and more.
const MATERIAL_TABLES = {
  0x40000048: ['flower', 'unify'], 0x4000001c: ['kibako', 'unify'], 0x4000005a: ['barrel', 'unify'], 0x400000ba: ['riccoship', 'unify'],
  0x400000a8: ['bianco', 'unify'], 0x40000096: ['bianco', 'unify'], 0x4000009a: ['bianco', 'unify'], 0x4000009b: ['bianco', 'unify'],
  0x4000009e: ['bianco', 'unify'], 0x4000009f: ['bianco', 'unify'], 0x400000a1: ['bianco', 'unify'], 0x400000a2: ['bianco', 'unify'],
  0x400000a3: ['bianco', 'unify'], 0x400000a0: ['bianco'], 0x4000009c: ['leafboat', 'unify'], 0x400000a5: ['leafboat'],
  0x400000cb: ['sandbombbase', 'unify'], 0x400000cd: ['sandbombbase', 'unify'], 0x400000ce: ['sandbombbase', 'unify'], 0x400000d3: ['sandbombbase', 'textures'],
  0x400000cf: ['mirror', 'unify'], 0x20000026: ['nozzleitem', 'unify'], 0x2000002a: ['nozzleitem', 'unify'], 0x2000001f: ['nozzleitem', 'unify'],
  0x20000022: ['nozzleitem', 'unify'], 0x20000068: ['nozzlebox', 'textures'], 0x400002c2: ['brickblock'], 0x400002c3: ['watermelonblock'],
  0x4000001b: ['arrowboard', 'unify'],
};
// And characters whose own code loads one (TElecNokonokoManager, THanaSamboManager).
const MODEL_TABLES = { 'dennoko/dennoko_model1.bmd': 'dennoko/dennoko_model1.bmt', 'samboflower/flower.bmd': 'samboflower/flower_orange.bmt' };
let modelTypes = null;
function materialTableFor(library, model, scene, file) {
  if (MODEL_TABLES[file]) {
    const data = library.findFile(MODEL_TABLES[file], scene);
    if (data) useMaterialTable(model, j3d.parseBmt(data));
    return;
  }
  if (!modelTypes) {
    modelTypes = new Map();
    for (const entry of Object.values(DATA.mapobj)) for (const m of entry.m || []) if (entry.t && !modelTypes.has(m)) modelTypes.set(m, entry.t);
  }
  const rule = MATERIAL_TABLES[modelTypes.get(file)];
  if (!rule) return;
  const data = library.findFile(`mapobj/${rule[0]}.bmt`, scene);
  if (data) useMaterialTable(model, j3d.parseBmt(data), { unify: rule[1] === 'unify', textures: rule[1] === 'textures' });
}

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

// Where an actor's data continues after its character name, light map and
// `strings` more strings; -1 if it doesn't hold that much.
function actorNamesEnd(data, strings) {
  let at = 36;
  const skip = () => { if (at + 2 > data.length) return false; at += 2 + data.readUInt16BE(at); return at <= data.length; };
  if (!skip() || at + 4 > data.length) return -1;
  const lights = data.readInt32BE(at);
  at += 4;
  for (let i = 0; i < lights; i++) { at += 4; if (!skip()) return -1; }
  for (let i = 1; i < strings; i++) if (!skip()) return -1;
  return at;
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
// Things not to offer: a stage's own water and goop sheets (drawn over its
// whole sea or river), heat shimmer, and the developers' test stage.
const STAGE_SHEETS = /pollution|river/i;
const UNLISTED_TYPES = new Set(['Shimmer']);
const UNLISTED_SCENES = new Set(['test11']);
const MARKER_WHEN_EMPTY = new Set(['buildings', 'bosses', 'npcs', 'enemies', 'interactive', 'decorations', 'nature', 'vehicles']);

function categoryOf(type, variant, info) {
  const text = `${type} ${variant}`;
  if (type === 'MapStaticObj' && (HELPERS.test(variant) || STAGE_SHEETS.test(variant))) return null;
  if (UNLISTED_TYPES.has(type)) return null;
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
  MapObjBase: v => v, MapObjGeneral: v => v, MapStaticObj: v => v, MapObjFloatOnSea: v => v, Item: v => v,
};

function labelOf(type, variant) {
  const base = LABELS[type] || humanize(type);
  if (!variant) return base;
  const known = VARIANT_LABELS[variant.toLowerCase()];
  if (known === null) return base;
  const nice = known || humanize(variant);
  if (VARIANT_NAMED[type]) return VARIANT_NAMED[type](nice);
  if (known) return `${base} (${known})`;
  // A variant that only repeats the type's name ("Blue coin", coin_blue) adds
  // nothing; one that does says only what's new ("Wood block cube": cube).
  const words = text => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
  const squash = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const baseWords = new Set([...words(base), ...words(humanize(type))]);
  const rest = words(nice).filter(word => !baseWords.has(word));
  if (!rest.length || rest.every(word => /^\d+$/.test(word)) && words(nice).length > rest.length && Number(rest.join('')) <= 1 || squash(nice) === squash(base)) return base;
  const plain = { l: 'large', m: 'medium', s: 'small', normalvariant: 'style', railvariant: 'style', rollvariant: 'style' };
  return `${base} (${rest.map(word => plain[word] || word).join(' ')})`;
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
    // Files named after its model too: its animations, and parts' collision
    // the object loads by name (a tree's leaves, "palmnormalleaf01.col").
    const stems = [...out].map(file => file.replace(/\.[^./]+$/, ''));
    for (const file of files.keys()) if (stems.some(stem => file.startsWith(stem))) out.add(file);
    // The material table its manager loads for its kind (MapObjManager's
    // loadMatTable): without it the game has none to put on it and stops.
    const table = MATERIAL_TABLES[entry.t];
    if (table && files.has(`mapobj/${table[0]}.bmt`)) out.add(`mapobj/${table[0]}.bmt`);
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
    if (UNLISTED_SCENES.has(scene)) continue;
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
        if (file) { item.model = makeRef(scene, file, lookOf(node, described)); item.source = { scene, id }; item.scale = transform.scale.map(v => round(v, 3)); }
      }
    });
  }
  // A type with a name players know and only one kind needs no variant in its
  // label ("Date palm", not "Date palm (Palm natume)"). Things without a model
  // of their own show as markers, so they're listed with them.
  const kinds = new Map();
  for (const item of items.values()) kinds.set(item.type, (kinds.get(item.type) || 0) + 1);
  for (const item of items.values()) {
    if (kinds.get(item.type) === 1 && LABELS[item.type] && item.variant && VARIANT_LABELS[item.variant.toLowerCase()] === undefined) item.label = LABELS[item.type];
    if (!item.model && MARKER_WHEN_EMPTY.has(item.category)) item.category = 'markers';
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

// Material tables the game loads in one world only (MapObjManager: bianco.bmt
// when the map is Bianco Hills), so their objects work only there.
const WORLD_TABLES = { bianco: { world: 'bianco', name: 'Bianco Hills' } };
function worldBound(item) {
  if (item.type !== 'MapObjBase' && item.type !== 'MapObjGeneral' && !item.variant) return null;
  const entry = DATA.mapobj[String(item.variant || '').toLowerCase()];
  const table = entry && MATERIAL_TABLES[entry.t];
  return table && WORLD_TABLES[table[0]] || null;
}

function noteFor(item) {
  const bound = worldBound(item);
  if (bound) return `Only works in ${bound.name} stages: the game loads its materials there only.`;
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
      transform, model: node.type === 'Mario' ? marioRef() : file ? makeRef(scene, file, lookOf(node, described)) : null,
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
    edits, added, paint, ...stage.cleanStage(input, scenes), savedAt: new Date().toISOString(),
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
    const bound = worldBound(added);
    if (bound && worldOf(project.base).id !== bound.world)
      throw new Error(`${added.label} only works in ${bound.name} stages (the game loads its materials there only). Remove it to export this level.`);
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

// The stage's ground: painted, with built and copied pieces' ground added.
function buildCollision(library, project) {
  const built = stage.buildGround(library, project, SURFACES, SURFACE_DEFAULTS);
  if (built) return built;
  const col = library.files(project.base).get('map/map.col');
  if (!col) throw new Error('This stage has no ground file.');
  return Buffer.from(col);
}

// The stage's model with painted textures and built and copied pieces, or
// null when the project leaves it as it is.
function buildModel(library, project) { return stage.buildMap(library, project); }

// The whole stage archive with the project in it, Yaz0-compressed as the game stores it.
function buildArchive(library, project) {
  const tree = archive.readTree(library.read(archiveFile(project.base)));
  const { tree: scene, needs } = buildScene(library, project);
  archive.treePut(tree, 'map/scene.bin', sceneBin.serialize(scene));
  if (Object.keys(project.paint).length || stage.hasStageEdits(project)) archive.treePut(tree, 'map/map.col', buildCollision(library, project));
  const map = buildModel(library, project);
  if (map) archive.treePut(tree, originalPath(tree, 'map/map/map.bmd'), map);
  const sea = stage.buildSea(library, project);
  if (sea) archive.treePut(tree, originalPath(tree, 'map/map/sea.bmd'), sea);
  // An emptied stage has no goop: the game draws its layers from ymap.ymp,
  // and stages without one (Gelato Beach) have none.
  if (project.blank) archive.treeRemove(tree, 'map/ymap.ymp');
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

// --- Playing a level in the game ---------------------------------------------------

// The game's stage table (data/stageArc.bin, a JDrama node tree like
// scene.bin): for each area, the scene archive each of its episodes loads.
function stageTable(library) {
  if (library.stageTableCache) return library.stageTableCache;
  const data = library.read('data/stageArc.bin');
  const text = at => { const n = data.readUInt16BE(at); return { value: data.toString('latin1', at + 2, at + 2 + n), end: at + 2 + n }; };
  const node = at => { const type = text(at + 6), name = text(type.end + 2); return { body: name.end, end: at + data.readUInt32BE(at) }; };
  const areas = [];
  const list = node(node(0).body + 4);
  for (let a = 0, at = list.body + 4, count = data.readUInt32BE(list.body); a < count; a++) {
    const table = node(at), episodes = [];
    for (let e = 0, entry = table.body + 4, n = data.readUInt32BE(table.body); e < n; e++) {
      const item = node(entry);
      episodes.push(text(item.body).value.toLowerCase().replace(/\.(arc|szs)$/, ''));
      entry = item.end;
    }
    areas.push(episodes);
    at = table.end;
  }
  return (library.stageTableCache = areas);
}

// The area and episode that load a scene (SMS_WARP takes them), or null.
function stageStart(library, scene) {
  const areas = stageTable(library);
  for (let area = 0; area < areas.length; area++) {
    const episode = areas[area].indexOf(scene.toLowerCase());
    if (episode >= 0) return { area, episode };
  }
  return null;
}

// The world each area belongs to (SMS_getShineStage's table): which line
// of the stage names its title card shows.
const SHINE_STAGES = [
  0, 1, 2, 3, 4, 5, 6, 6, 7, 8, 9, 1, 1, 5, 6, 1, 8, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 3, 8,
  4, 4, 5, 5, 5, 5, 5, 5, 6, 5, 7, 7, 8, 8, 2, 2, 3, 3, 5, 6, 9, 1, 1, 2, 6, 8, 5, 3, 9,
];

// A message bank (.bmg: INF1 entries, each a u32 offset into DAT1's text)
// with some messages replaced ({ index: text }) or all of them (`all`).
function setMessages(data, changes, all = null) {
  let inf = -1, dat = -1;
  for (let at = 0x20; at + 8 <= data.length; at += data.readUInt32BE(at + 4)) {
    const magic = data.toString('ascii', at, at + 4);
    if (magic === 'INF1') inf = at;
    if (magic === 'DAT1') dat = at;
    if (!data.readUInt32BE(at + 4)) break;
  }
  if (inf < 0 || dat < 0) throw new Error('The game\'s message file isn\'t one this editor can read.');
  const count = data.readUInt16BE(inf + 8), size = data.readUInt16BE(inf + 10), text = dat + 8, end = dat + data.readUInt32BE(dat + 4);
  const offsets = Array.from({ length: count }, (_, i) => data.readUInt32BE(inf + 16 + i * size));
  const sorted = [...new Set(offsets)].sort((a, b) => a - b);
  const original = offset => { const next = sorted.find(o => o > offset); return data.subarray(text + offset, next === undefined ? end : text + next); };
  const encode = value => Buffer.concat([Buffer.from(value, 'latin1'), Buffer.alloc(1)]);
  const out = Buffer.from(data.subarray(0, inf + data.readUInt32BE(inf + 4)));
  const parts = [Buffer.alloc(1)];  // offset 0: an empty message, as the game's files start
  let at = 1;
  offsets.forEach((offset, i) => {
    const bytes = all !== null ? encode(all) : i in changes ? encode(changes[i]) : original(offset);
    out.writeUInt32BE(at, inf + 16 + i * size);
    parts.push(bytes);
    at += bytes.length;
  });
  let body = Buffer.concat(parts);
  body = Buffer.concat([body, Buffer.alloc((32 - (body.length + 8) % 32) % 32)]);
  const head = Buffer.from(data.subarray(dat, dat + 8));
  head.writeUInt32BE(body.length + 8, 4);
  const file = Buffer.concat([out, head, body]);
  file.writeUInt32BE(file.length, 8);
  return file;
}

// The title card's text for a level played in the game: its name for the
// world's name, in capitals as the game writes them, and no episode name.
// Files inside common.szs, for the game's mod folder to put there.
function playTexts(library, project, start) {
  const common = archive.rarc(library.read('data/common.szs'));
  const name = project.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '').trim().toUpperCase().slice(0, 24) || 'MY LEVEL';
  const world = SHINE_STAGES[start.area] ?? 1;
  return {
    '2d/stagename.bmg': setMessages(common.get('2d/stagename.bmg'), { [world]: name }),
    '2d/scenarioname.bmg': setMessages(common.get('2d/scenarioname.bmg'), {}, ''),
  };
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
  buildScene, buildCollision, buildModel, buildArchive, stageTable, stageStart, playTexts, setMessages, readTransform, writeTransform, describe, categoryOf, labelOf, humanize, fitManagers,
  paintNpc, parseNpcLook, NPC_TYPES,
};
