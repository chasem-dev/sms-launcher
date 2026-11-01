'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const voice = require('../src/character-voice');

// A wave system with one archive of the given waves ({ id, format, rate, offset, size, samples }).
function wsys(file, waves) {
  const words = [];
  const at = () => words.length * 4;
  const put = (...w) => { const o = at(); words.push(...w); return o; };
  put(0x57535953, 0, 0, 0, 0, 0, 0, 0);  // 'WSYS', ..., archives at 0x10, groups at 0x14
  const waveAt = waves.map(w => put(w.format << 16, 0, w.offset, w.size, 0, 0, 0, w.samples, 0, 0, 0));
  const archive = at();
  const name = Buffer.alloc(0x74); name.write(file);
  for (let i = 0; i < 0x74; i += 4) words.push(name.readUInt32BE(i));
  words.push(...waveAt);
  const archives = put(0x57494e46, 1, archive);
  const ctrlWaves = waves.map(w => put(w.id));
  const ctrl = put(0x432d4446, waves.length, ...ctrlWaves);
  const scene = put(0x53434e45, 0, 0, ctrl);
  const groups = put(0x57424354, 0, 1, scene);
  const data = Buffer.alloc(at());
  words.forEach((w, i) => data.writeUInt32BE(w >>> 0, i * 4));
  waveAt.forEach((o, i) => data.writeFloatBE(waves[i].rate, o + 4));
  data.writeUInt32BE(archives, 0x10); data.writeUInt32BE(groups, 0x14);
  return data;
}

// mSound.aaf with an empty first and second wave system and `bank1` as the second.
function aaf(bank1) {
  const empty = wsys('w1stLoad_0.aw', []);
  const head = Buffer.alloc(4 * 12);
  [1, 0, 0, 0, 3, 48, empty.length, 0, 48 + empty.length, bank1.length, 0, 0].forEach((w, i) => head.writeUInt32BE(w, i * 4));
  return Buffer.concat([head, empty, bank1, Buffer.alloc(4)]);
}

test('AFC 4-bit waves decode as the game\'s mixer does', () => {
  // predictor 1 (the last sample, Q11 0x800), scale 1: each residual doubled onto the one before
  const frame = Buffer.from([0x11, 0x1f, 0x70, 0, 0, 0, 0, 0, 0x08]);
  assert.deepEqual([...voice.decode(frame, { format: 0, samples: 16 })], [2, 0, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, -2]);
});

test('AFC 2-bit waves decode their residuals on the 4-bit scale', () => {
  const frame = Buffer.from([0x00, 0b01111000, 0, 0, 0]);
  assert.deepEqual([...voice.decode(frame, { format: 1, samples: 4 })], [4, -4, -8, 0]);
});

test('a WAV is 16-bit mono PCM at the wave\'s rate', () => {
  const data = voice.wav(Int16Array.from([1, -2]), 22050);
  assert.equal(data.toString('ascii', 0, 4), 'RIFF');
  assert.equal(data.readUInt32LE(24), 22050);
  assert.equal(data.readUInt16LE(22), 1);
  assert.deepEqual([data.readInt16LE(44), data.readInt16LE(46)], [1, -2]);
});

test('the wave systems are read from mSound.aaf, each wave by its id', () => {
  const systems = voice.waveSystems(aaf(wsys('w2ndLoad_0.aw', [{ id: 704, format: 1, rate: 22050, offset: 5, size: 5, samples: 16 }])));
  assert.equal(systems.length, 2);
  const [group] = systems[1];
  assert.equal(group.file, 'w2ndLoad_0.aw');
  assert.deepEqual(group.waves.get(704), { format: 1, key: 0, rate: 22050, offset: 5, size: 5, samples: 16 });
});

test('each cue is said with a wave of its mood, variants in turn, and snoring stays Mario\'s', () => {
  const waves = [1, 2, 3].map(id => ({ id, format: 3, rate: 8000, offset: (id - 1) * 2, size: 2, samples: 1 }));
  const archive = Buffer.from([0, 1, 0, 2, 0, 3]);
  const files = voice.voiceFiles(aaf(wsys('w2ndLoad_0.aw', waves)), () => archive, { moods: { hop: [1, 2], cheer: [3] } });
  const said = name => files[`voice/${name}.wav`]?.readInt16LE(44);
  assert.deepEqual(['MV21_JUMP_SMALL_01', 'MV21_JUMP_SMALL_02', 'MV21_JUMP_SMALL_03'].map(said), [1, 2, 1]);
  assert.equal(said('MV24_JUMP_SPECIAL_01'), 3);
  assert.equal(said('MV01_DAMAGE_BIG_01'), 1);  // no hurt or scream: the first mood it has
  assert.equal(said('MV_IBIKI'), undefined);
  assert.equal(Object.keys(files).length, voice.MARIO_CUES.length - 2);
});

test('a silent character says nothing for every cue, snoring too', () => {
  const files = voice.voiceFiles(null, () => { throw new Error('no wave is read'); }, { silent: true });
  assert.equal(Object.keys(files).length, voice.MARIO_CUES.length);
  const clip = files['voice/MV21_JUMP_SMALL_01.wav'];
  assert.equal(clip.readUInt32LE(40), 32);  // 16 samples
  for (let i = 44; i < clip.length; i += 2) assert.equal(clip.readInt16LE(i), 0);
  assert.equal(files['voice/MV_IBIKI.wav'], clip);
});

test('Mario\'s own voice, pitched, with cues said with others\' waves, snoring too', () => {
  // every wave of Mario's cues, each a sample of its id
  const ids = [...new Set(voice.MARIO_CUES.map(([, id]) => id))];
  const waves = ids.map((id, i) => ({ id, format: 3, rate: 32000, offset: i * 2, size: 2, samples: 1 }));
  const archive = Buffer.alloc(ids.length * 2);
  ids.forEach((id, i) => archive.writeInt16BE(id, i * 2));
  const files = voice.voiceFiles(aaf(wsys('w2ndLoad_0.aw', waves)), () => archive,
    { mario: true, pitch: 0.95, swap: { MV21_JUMP_SMALL: 'MV41_JUMP_T_01' } });
  const said = name => files[`voice/${name}.wav`]?.readInt16LE(44), cues = new Map(voice.MARIO_CUES);
  assert.deepEqual(['MV21_JUMP_SMALL_01', 'MV21_JUMP_SMALL_02', 'MV41_JUMP_T_01'].map(said), Array(3).fill(cues.get('MV41_JUMP_T_01')));
  assert.equal(said('MV01_DAMAGE_BIG_01'), cues.get('MV01_DAMAGE_BIG_01'));
  assert.equal(said('MV_IBIKI'), cues.get('MV_IBIKI'));
  assert.equal(Object.keys(files).length, voice.MARIO_CUES.length);
  assert.equal(files['voice/MV01_DAMAGE_BIG_01.wav'].readUInt32LE(24), 30400);   // 32000 x 0.95
});
