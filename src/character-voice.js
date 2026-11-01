'use strict';
// Character voices from the player's disc: the game's own voice clips (Peach's, the Toads', Bowser
// Jr.'s, a Pianta's) taken out of its wave banks as WAV files, named after the Mario voice cues they
// stand in for, for a pack's voice/ folder (the port's character voices: each WAV takes the place of
// Mario's wave for that cue).
//
// The waves: mSound.aaf (in data/nintendo.szs) lists the wave systems (WSYS); each names its wave
// archives (AudioRes/Banks/*.aw) and, per wave, where it is in its archive, its format and its rate
// (JASWSParser). A wave is found by its system and its id, the id a bank's instrument plays it by.

const AAF = 'audi/msound.aaf';

// The AAF's wave systems, in its wave bank list's order (the wave bank numbers), walked as
// JAIBasic::checkInitDataOnMemory walks the file: a command, then its words.
function waveSystems(aaf) {
  const systems = [], word = i => aaf.readUInt32BE(i * 4);
  for (let i = 0; i * 4 < aaf.length;) {
    const command = word(i++);
    if (command === 0) break;
    if (command === 1) i += word(i + 2) ? 6 : 3;  // the sound tables: one, or three
    else if (command === 2 || command === 3) {  // banks, wave systems: offset, size, flags each, then 0
      for (; word(i) !== 0; i += 3)
        if (command === 3) systems.push(parseWsys(aaf.subarray(word(i), word(i) + word(i + 1))));
      i++;
    } else if (command <= 8) i += 3;
    else while (word(i++) !== 0);
  }
  return systems;
}

// One wave system: its wave archives, each with its waves by id.
function parseWsys(data) {
  if (data.toString('ascii', 0, 4) !== 'WSYS') throw new Error('This is not a wave system.');
  const archives = data.readUInt32BE(0x10), groups = data.readUInt32BE(0x14);
  const count = data.readUInt32BE(groups + 8);
  return Array.from({ length: count }, (_, g) => {
    const archive = data.readUInt32BE(archives + 8 + g * 4);
    const scene = data.readUInt32BE(groups + 0x0c + g * 4), ctrl = data.readUInt32BE(scene + 0x0c);
    const name = data.toString('latin1', archive, archive + 0x74).replace(/\0.*$/s, '');
    const waves = new Map();
    for (let w = 0; w < data.readUInt32BE(ctrl + 4); w++) {
      const id = data.readUInt32BE(data.readUInt32BE(ctrl + 8 + w * 4)) & 0xffff;
      const o = data.readUInt32BE(archive + 0x74 + w * 4);
      waves.set(id, {
        format: data[o + 1], key: data[o + 2], rate: data.readFloatBE(o + 4),
        offset: data.readUInt32BE(o + 8), size: data.readUInt32BE(o + 0x0c), samples: data.readUInt32BE(o + 0x1c),
      });
    }
    return { file: name, waves };
  });
}

// DSPADPCM_FILTER (JASDriverTables.cpp): the AFC predictor pairs, Q11.
const COEF = [[0, 0], [0x0800, 0], [0, 0x0800], [0x0400, 0x0400], [0x1000, -0x800], [0x0e00, -0x600], [0x0c00, -0x400],
  [0x1200, -0xa00], [0x1068, -0x8c8], [0x12c0, -0x8fc], [0x1400, -0xc00], [0x0800, -0x800], [0x0400, -0x400],
  [-0x400, 0x0400], [-0x400, 0], [-0x800, 0]];

// A wave's samples: AFC ADPCM, 4-bit (9-byte frames of 16) or 2-bit (5-byte frames), or PCM.
function decode(bytes, wave) {
  const out = new Int16Array(wave.samples);
  if (wave.format === 2 || wave.format === 3) {
    for (let i = 0; i < out.length; i++) out[i] = wave.format === 3 ? bytes.readInt16BE(i * 2) : bytes.readInt8(i) << 8;
    return out;
  }
  const two = wave.format === 1, frame = two ? 5 : 9;
  let h1 = 0, h2 = 0;
  for (let n = 0, f = 0; n < out.length; f += frame) {
    const head = bytes[f], scale = head >> 4, [c1, c2] = COEF[head & 15];
    for (let k = 0; k < 16 && n < out.length; k++) {
      let v;
      if (two) { v = (bytes[f + 1 + (k >> 2)] >> (6 - (k & 3) * 2)) & 3; if (v >= 2) v -= 4; v <<= 2; }
      else { v = (bytes[f + 1 + (k >> 1)] >> (k & 1 ? 0 : 4)) & 15; if (v >= 8) v -= 16; }
      let y = ((v * (1 << scale)) * 2048 + c1 * h1 + c2 * h2) >> 11;
      y = y < -32768 ? -32768 : y > 32767 ? 32767 : y;
      out[n++] = y; h2 = h1; h1 = y;
    }
  }
  return out;
}

// 16-bit mono PCM WAV.
function wav(samples, rate) {
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + samples.length * 2, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(Math.round(rate), 24); data.writeUInt32LE(Math.round(rate) * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(samples[i], 44 + i * 2);
  return data;
}

// Mario's voice cues, as the port knows them (platform/misc/port_character_voice.cpp): each cue's name
// (MSD_SE_MV* without MSD_SE_) and the wave of bank 1 Mario says it with. A pack's voice/<name>.wav
// takes that wave's place.
const MARIO_CUES = [
  ['MV01_DAMAGE_BIG_01', 0xCE], ['MV01_DAMAGE_BIG_02', 0xCF], ['MV01_DAMAGE_BIG_03', 0xD0],
  ['MV02_DAMAGE_MID_01', 0xD1], ['MV02_DAMAGE_MID_02', 0xD2], ['MV02_DAMAGE_MID_03', 0xD4],
  ['MV02_DAMAGE_MID_04', 0xD3], ['MV03_DAMAGE_LITLE_01', 0xD5], ['MV03_DAMAGE_LITLE_02', 0xD6],
  ['MV03_DAMAGE_LITLE_03', 0xD8], ['MV03_DAMAGE_LITLE_04', 0xD7], ['MV04_DAMAGE_ELEC_01', 0xD9],
  ['MV04_DAMAGE_ELEC_02', 0xDA], ['MV05_DAMAGE_FIRE_01', 0xDC], ['MV05_DAMAGE_FIRE_02', 0xDB],
  ['MV06_DAMAGE_WATER_01', 0xDD], ['MV06_DAMAGE_WATER_02', 0xDE], ['MV06_DAMAGE_WATER_03', 0xDF],
  ['MV07_DAMAGE_REACT_01', 0xE0], ['MV07_DAMAGE_REACT_02', 0xE3], ['MV07_DAMAGE_REACT_03', 0xE1],
  ['MV07_DAMAGE_REACT_04', 0xE2], ['MV08A_DOWN_01', 0xE4], ['MV08A_DOWN_02', 0xE5], ['MV08A_DOWN_03', 0xE6],
  ['MV08B_DOWN_REACT_01', 0xE8], ['MV08B_DOWN_REACT_02', 0xE9], ['MV08B_DOWN_REACT_03', 0xE7],
  ['MV08B_DOWN_REACT_04', 0xE7], ['MV10A_CRY_SHORT_01', 0xEB], ['MV10A_CRY_SHORT_02', 0xEA],
  ['MV10A_CRY_SHORT_03', 0xEA], ['MV10B_CRY_JUMP_01', 0x2B], ['MV12_REACT_01', 0xEC], ['MV12_REACT_02', 0xED],
  ['MV12_REACT_03', 0xEE], ['MV13_ACTION_SMALL_01', 0xEF], ['MV13_ACTION_SMALL_02', 0xF1],
  ['MV13_ACTION_SMALL_03', 0xF0], ['MV15_EXERT_INST_01', 0xF2], ['MV15_EXERT_INST_02', 0xF3],
  ['MV15_REACT_SMALL_01', 0xF4], ['MV15_REACT_SMALL_02', 0xF5], ['MV15_REACT_SMALL_03', 0xF6],
  ['MV16_EXERT_CONT_01', 0xF7], ['MV17_EXERT_REACT_01', 0xF9], ['MV17_EXERT_REACT_02', 0xF8],
  ['MV18_FALL_AFTER_01', 0xFA], ['MV18_FALL_AFTER_02', 0xE3], ['MV19_JMP_PT_01', 0xFC], ['MV19_JMP_PT_02', 0xFD],
  ['MV20_JMP_PT_REACT_01', 0xFE], ['MV21_JUMP_SMALL_01', 0x102], ['MV21_JUMP_SMALL_02', 0xFF],
  ['MV21_JUMP_SMALL_03', 0x100], ['MV21_JUMP_SMALL_04', 0x101], ['MV21_JUMP_SMALL_05', 0x102],
  ['MV22_JUMP_MID_01', 0x104], ['MV23_JUMP_LARGE_01', 0x105], ['MV23_JUMP_LARGE_02', 0x106],
  ['MV23_JUMP_LARGE_03', 0x107], ['MV24_JUMP_SPECIAL_01', 0x108], ['MV24_JUMP_SPECIAL_02', 0x109],
  ['MV24_JUMP_SPECIAL_03', 0x10A], ['MV24_JUMP_SPECIAL_04', 0x10B], ['MV24_JUMP_SPECIAL_05', 0x10C],
  ['MV24_JUMP_SPECIAL_06', 0x10D], ['MV25A_JUMP_HUGE_01', 0x10E], ['MV25A_JUMP_HUGE_02', 0x10F],
  ['MV25A_WIRE_ROLL_01A', 0x110], ['MV25A_WIRE_ROLL_01B', 0x111], ['MV25A_WIRE_ROLL_01C', 0x112],
  ['MV25A_WIRE_ROLL_02A', 0x113], ['MV25A_WIRE_ROLL_02B', 0x114], ['MV25A_WIRE_ROLL_02C', 0x115],
  ['MV26_JUMP_REACT_01', 0x116], ['MV26_JUMP_REACT_02', 0x117], ['MV26_JUMP_REACT_03', 0x118],
  ['MV26_JUMP_REACT_04', 0x119], ['MV26_JUMP_REACT_05', 0x11A], ['MV26_JUMP_REACT_06', 0x11B],
  ['MV26_JUMP_REACT_07', 0x11C], ['MV26_JUMP_REACT_08', 0x11D], ['MV27_SPRISE_01', 0x11E], ['MV27_SPRISE_02', 0x11F],
  ['MV28_SPRISE_SMALL_01', 0x120], ['MV28_SPRISE_SMALL_02', 0x121], ['MV29_SPRISE_REACT_01', 0x122],
  ['MV29_SPRISE_REACT_02', 0x123], ['MV29_SPRISE_REACT_03', 0x124], ['MV30_FRIGHT_01', 0x125],
  ['MV30_FRIGHT_02', 0x126], ['MV31_OPEN_DOOR_01', 0x12A], ['MV31_OPEN_DOOR_02', 0x127],
  ['MV31_OPEN_DOOR_03', 0x128], ['MV31_OPEN_DOOR_04', 0x129], ['MV33_T_01', 0x12B], ['MV33_T_02', 0x12C],
  ['MV33_T_03', 0x12D], ['MV33_T_04', 0x12E], ['MV33_T_05', 0x12F], ['MV33_T_06', 0x130],
  ['MV34_ACTION_T_01', 0x131], ['MV34_ACTION_T_02', 0x132], ['MV34_ACTION_T_03', 0x133],
  ['MV38_EXERT_INST_T_01', 0x134], ['MV41_JUMP_T_01', 0x136], ['MV41_JUMP_T_02', 0x137], ['MV41_JUMP_T_03', 0x135],
  ['MV42_JUMP_HUGE_T_01', 0x138], ['MV42_JUMP_HUGE_T_02', 0x139], ['MV46A_OPEN_DOOR_T_01', 0x13A],
  ['MV46A_OPEN_DOOR_T_02', 0x13B], ['MV46B_NEXT_STG_T_01', 0x13C], ['MV46B_NEXT_STG_T_02', 0x13D],
  ['MV46B_NEXT_STG_T_03', 0x13E], ['MV_UNTEI_01', 0x101], ['MV_UNTEI_02', 0x100], ['MV_UNTEI_03', 0xFF],
  ['MV_IBIKI', 0x140], ['MV_IBIKI2', 0x141], ['MV_DOOR', 0x13F], ['MV_BYEBYE', 0xCD]
];

// What each cue is said for, best first: a character says the cue with its first of these it has.
//   hop: a short call (jumps)        cheer: its happiest (triple jumps, a Shine)
//   hurt: a yelp (damage)            scream: a long cry (falls, burns, shocks)
//   shock: surprised, confused       sad: dismay, defeat
//   effort: a grunt or breath        wet: spluttering (water)
const CUE_MOODS = {
  MV01_DAMAGE_BIG: ['hurt', 'scream'], MV02_DAMAGE_MID: ['hurt'], MV03_DAMAGE_LITLE: ['hurt'],
  MV04_DAMAGE_ELEC: ['scream', 'hurt'], MV05_DAMAGE_FIRE: ['scream', 'hurt'], MV06_DAMAGE_WATER: ['wet', 'hurt'],
  MV07_DAMAGE_REACT: ['sad', 'hurt'], MV08A_DOWN: ['sad', 'scream'], MV08B_DOWN_REACT: ['sad', 'hurt'],
  MV10A_CRY_SHORT: ['hurt', 'sad'], MV10B_CRY_JUMP: ['scream', 'hurt'], MV12_REACT: ['shock'],
  MV13_ACTION_SMALL: ['hop', 'effort'], MV15_EXERT_INST: ['effort', 'hop'], MV15_REACT_SMALL: ['shock', 'effort'],
  MV16_EXERT_CONT: ['effort'], MV17_EXERT_REACT: ['shock', 'effort'], MV18_FALL_AFTER: ['hurt'],
  MV19_JMP_PT: ['hop'], MV20_JMP_PT_REACT: ['cheer', 'hop'], MV21_JUMP_SMALL: ['hop'], MV22_JUMP_MID: ['hop', 'cheer'],
  MV23_JUMP_LARGE: ['cheer', 'hop'], MV24_JUMP_SPECIAL: ['cheer'], MV25A_JUMP_HUGE: ['cheer'], MV25A_WIRE_ROLL: ['hop', 'cheer'],
  MV26_JUMP_REACT: ['cheer', 'hop'], MV27_SPRISE: ['shock'], MV28_SPRISE_SMALL: ['shock'], MV29_SPRISE_REACT: ['sad', 'shock'],
  MV30_FRIGHT: ['scream', 'shock'], MV31_OPEN_DOOR: ['effort', 'hop'], MV33_T: ['cheer'], MV34_ACTION_T: ['hop'],
  MV38_EXERT_INST_T: ['effort'], MV41_JUMP_T: ['hop'], MV42_JUMP_HUGE_T: ['cheer'], MV46A_OPEN_DOOR_T: ['effort', 'hop'],
  MV46B_NEXT_STG_T: ['cheer'], MV_UNTEI: ['hop'], MV_DOOR: ['effort', 'hop'], MV_BYEBYE: ['cheer', 'hop'],
  // MV_IBIKI, MV_IBIKI2: snoring, Mario's
};
const FALLBACK = ['hop', 'cheer', 'hurt', 'shock', 'sad', 'effort', 'scream', 'wet'];
const cueBase = name => name.replace(/_\d\d[A-C]?$/, '');

// A moment of silence (the game needs a sample at least, and keeps identical clips once).
const SILENCE = wav(new Int16Array(16), 32000);

// A character's voice/ folder: { 'voice/<cue>.wav': WAV }. `voice` is { moods: { hop: [wave, ...], ... } },
// waves of bank 1 by id, a cue's variants taking its mood's waves in turn; { mario: true }, Mario's
// own waves; or { silent: true }, silence for every cue (snoring too). `pitch` plays them lower (under 1)
// or higher.
function voiceFiles(aaf, readArchive, voice) {
  if (voice.silent) return Object.fromEntries(MARIO_CUES.map(([name]) => [`voice/${name}.wav`, SILENCE]));
  const archives = waveSystems(aaf)[1], cache = new Map(), read = new Map();
  const archive = file => { if (!read.has(file)) read.set(file, readArchive(file)); return read.get(file); };
  const clip = id => {
    if (!cache.has(id)) {
      const group = archives.find(g => g.waves.has(id));
      if (!group) throw new Error(`Your disc has no voice wave ${id}.`);
      const wave = group.waves.get(id), bytes = archive(group.file);
      cache.set(id, wav(decode(bytes.subarray(wave.offset, wave.offset + wave.size), wave), wave.rate * (voice.pitch || 1)));
    }
    return cache.get(id);
  };
  const files = {}, turn = new Map();
  for (const [name, marioWave] of MARIO_CUES) {
    const base = cueBase(name), moods = CUE_MOODS[base];
    if (!moods) continue;
    const v = turn.get(base) || 0;
    turn.set(base, v + 1);
    let id = marioWave;
    if (!voice.mario) {
      const mood = [...moods, ...FALLBACK].find(m => voice.moods[m]?.length);
      if (!mood) continue;
      id = voice.moods[mood][v % voice.moods[mood].length];
    }
    files[`voice/${name}.wav`] = clip(id);
  }
  return files;
}

module.exports = { AAF, MARIO_CUES, CUE_MOODS, waveSystems, parseWsys, decode, wav, voiceFiles };
