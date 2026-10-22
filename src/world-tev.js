// The GameCube's colour combiner (TEV) as three.js shaders, for the world
// editor. Each material's stages mix up to eight textures, its lit colour
// channels and colour registers; NPCs get their colours, toon shading and
// clean (or gooped) skin this way, so drawing only a first texture leaves
// them grey. Indirect textures and swap tables aren't emulated.
import * as THREE from '../node_modules/three/build/three.module.js';

const KONST = [1, 7 / 8, 3 / 4, 5 / 8, 1 / 2, 3 / 8, 1 / 4, 1 / 8];
const BIAS = ['0.0', '0.5', '-0.5', '0.0'], SCALE = ['1.0', '2.0', '4.0', '0.5'];
const REG = ['r0', 'r1', 'r2', 'r3'];  // PREV, C0, C1, C2
const f = n => Number(n).toFixed(6);

function konstColor(sel) {
  if (sel < 8) return `vec3(${f(KONST[sel])})`;
  if (sel >= 0x0c && sel <= 0x0f) return `kColor[${sel - 0x0c}].rgb`;
  if (sel >= 0x10 && sel <= 0x1f) return `vec3(kColor[${sel & 3}].${'rgba'[(sel - 0x10) >> 2]})`;
  return 'vec3(1.0)';
}
function konstAlpha(sel) {
  if (sel < 8) return f(KONST[sel]);
  if (sel >= 0x10 && sel <= 0x1f) return `kColor[${sel & 3}].${'rgba'[(sel - 0x10) >> 2]}`;
  return '1.0';
}
const COLOR_IN = ['r0.rgb', 'vec3(r0.a)', 'r1.rgb', 'vec3(r1.a)', 'r2.rgb', 'vec3(r2.a)', 'r3.rgb', 'vec3(r3.a)',
  't.rgb', 'vec3(t.a)', 'ras.rgb', 'vec3(ras.a)', 'vec3(1.0)', 'vec3(0.5)', 'kc', 'vec3(0.0)'];
const ALPHA_IN = ['r0.a', 'r1.a', 'r2.a', 'r3.a', 't.a', 'ras.a', 'ka', '0.0'];

// One stage's colour or alpha: d ± lerp(a, b, c), biased, scaled and clamped;
// or, for the compare ops, d plus c where a beats (or equals) b.
function combine(kind, ins, op, bias, scale, clamped) {
  const vec = kind === 'vec3';
  const [a, b, c, d] = ins.map((input, i) => i < 3 ? `clamp(${input}, 0.0, 1.0)` : input);
  let value;
  if (op >= 8) {
    const eq = op & 1;
    const q = x => `floor(${x} * 255.0 + 0.5)`;
    let test;
    if (vec && op >= 14) test = eq ? `vec3(equal(${q(a)}, ${q(b)}))` : `vec3(greaterThan(${q(a)}, ${q(b)}))`;
    else {
      // R8, GR16 and BGR24 compare one packed number made of the channels.
      const pack = x => op >= 12 ? `dot(${q(vec ? x : `vec3(${x})`)}, vec3(1.0, 256.0, 65536.0))` : op >= 10 ? `dot(${q(vec ? `${x}.rg` : `vec2(${x})`)}, vec2(1.0, 256.0))` : q(vec ? `${x}.r` : x);
      test = `${vec ? 'vec3' : 'float'}(${pack(a)} ${eq ? '==' : '>'} ${pack(b)})`;
    }
    value = `${d} + ${test} * ${c}`;
  } else {
    value = `(${d} ${op === 1 ? '-' : '+'} mix(${a}, ${b}, ${c}) + ${BIAS[bias] || '0.0'}) * ${SCALE[scale] || '1.0'}`;
  }
  return clamped ? `clamp(${value}, 0.0, 1.0)` : `clamp(${value}, -4.0, 4.0)`;
}

// A texture coordinate from a texgen: the model's coordinates, the surface's
// facing (environment maps) or a lit colour (toon ramps), through its matrix.
function texCoord(gen) {
  if (!gen) return 'vUv0';
  let base;
  if (gen.type === 10) base = gen.source === 20 ? 'vRas1.rg' : 'vRas0.rg';
  else if (gen.env) base = '(vNormalView.xy * vec2(0.5, -0.5) + 0.5)';
  else base = gen.source === 5 ? 'vUv1' : 'vUv0';
  if (!gen.matrix || gen.type === 10) return base;
  const [a, b, c, d, e, g] = gen.matrix.map(f);
  return `vec2(${a} * ${base}.x + ${b} * ${base}.y + ${c}, ${d} * ${base}.x + ${e} * ${base}.y + ${g})`;
}

// A colour channel as the GX lights it: material colour (or the vertex's),
// times ambient (or the vertex's) plus the light, when lighting is on.
function channel(config, i, part) {
  const mat = config.matSource ? 'c' : `matColor[${i >> 1}]`;
  if (!config.lighting) return `${mat}.${part}`;
  const amb = config.ambSource ? 'c' : `ambColor[${i >> 1}]`;
  return `(${mat}.${part} * clamp(${amb}.${part} + ${config.litMask ? 'diffuse' : '0.0'}, 0.0, 1.0))`;
}

const COMPARE = ['false', '<', '==', '<=', '>', '!=', '>=', 'true'];
function alphaTest(test) {
  if (!test.on) return '';
  const one = (comp, ref) => comp === 0 ? 'false' : comp === 7 ? 'true' : `(alpha ${COMPARE[comp]} ${f(ref)})`;
  const join = ['&&', '||', '!=', '=='][test.op] || '&&';
  return `float alpha = floor(r0.a * 255.0 + 0.5) / 255.0; if (!(${one(test.comp0, test.ref0)} ${join} ${one(test.comp1, test.ref1)})) discard;`;
}

const vertexShader = channels => `
attribute vec2 uv1;
attribute vec4 clr;
uniform vec4 matColor[2];
uniform vec4 ambColor[2];
uniform vec3 lightDir;
uniform float hasColor;
varying vec2 vUv0;
varying vec2 vUv1;
varying vec3 vNormalView;
varying vec4 vRas0;
varying vec4 vRas1;
void main() {
  vec4 c = mix(vec4(1.0), clr, hasColor);
  float diffuse = max(dot(normalize(mat3(modelMatrix) * normal), lightDir), 0.0);
  vRas0 = vec4(${channel(channels[0], 0, 'rgb')}, ${channel(channels[1], 1, 'a')});
  vRas1 = vec4(${channel(channels[2], 2, 'rgb')}, ${channel(channels[3], 3, 'a')});
  vUv0 = uv;
  vUv1 = uv1;
  vNormalView = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

function fragmentShader(tev, slots, translucent) {
  const lines = [];
  for (const stage of tev.stages) {
    lines.push('{');
    lines.push(stage.texMap >= 0 && slots.has(stage.texMap) ? `  vec4 t = texture2D(tex${slots.get(stage.texMap)}, ${texCoord(tev.texGens[stage.texCoord])});` : '  vec4 t = vec4(1.0);');
    lines.push(`  vec4 ras = ${stage.channel === 4 ? 'vRas0' : stage.channel === 5 ? 'vRas1' : 'vec4(0.0)'};`);
    lines.push(`  vec3 kc = ${konstColor(stage.kColorSel)}; float ka = ${konstAlpha(stage.kAlphaSel)};`);
    lines.push(`  vec3 color = ${combine('vec3', stage.colorIn.map(i => COLOR_IN[i] || 'vec3(0.0)'), stage.colorOp, stage.colorBias, stage.colorScale, stage.colorClamp)};`);
    lines.push(`  float alpha = ${combine('float', stage.alphaIn.map(i => ALPHA_IN[i] || '0.0'), stage.alphaOp, stage.alphaBias, stage.alphaScale, stage.alphaClamp)};`);
    lines.push(`  ${REG[stage.colorReg] || 'r0'}.rgb = color;`);
    lines.push(`  ${REG[stage.alphaReg] || 'r0'}.a = alpha;`);
    lines.push('}');
  }
  const samplers = [...slots.values()].map(slot => `uniform sampler2D tex${slot};`).join('\n');
  return `
${samplers}
uniform vec4 kColor[4];
uniform vec4 tevColor[4];
uniform float opacity;
varying vec2 vUv0;
varying vec2 vUv1;
varying vec3 vNormalView;
varying vec4 vRas0;
varying vec4 vRas1;
void main() {
  vec4 r0 = tevColor[3], r1 = tevColor[0], r2 = tevColor[1], r3 = tevColor[2];
${lines.join('\n')}
  r0 = clamp(r0, 0.0, 1.0);
  ${alphaTest(tev.alphaTest)}
  // Opaque surfaces ignore alpha past the alpha test, as the GameCube does;
  // only blended ones carry it on.
  gl_FragColor = vec4(r0.rgb, ${translucent ? 'r0.a' : '1.0'} * opacity);
}`;
}

const vec4s = list => list.map(c => new THREE.Vector4(c[0], c[1], c[2], c[3]));
export const LIGHT = new THREE.Vector3(0.4, 1, 0.3).normalize();

// A material for one baked mesh; `maps[i]` is model texture i as a three.js texture.
export function tevMaterial(mesh, maps) {
  const tev = mesh.tev;
  const slots = new Map();
  for (const stage of tev.stages) if (stage.texMap >= 0 && maps[stage.texMap] && !slots.has(stage.texMap)) slots.set(stage.texMap, slots.size);
  const uniforms = {
    kColor: { value: vec4s(tev.kColors) }, tevColor: { value: vec4s(tev.tevColors) },
    matColor: { value: vec4s(tev.matColors) }, ambColor: { value: vec4s(tev.ambColors) },
    lightDir: { value: LIGHT }, hasColor: { value: mesh.color ? 1 : 0 }, opacity: { value: 1 },
  };
  for (const [texture, slot] of slots) uniforms[`tex${slot}`] = { value: maps[texture] };
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: vertexShader(tev.channels), fragmentShader: fragmentShader(tev, slots, mesh.translucent),
    side: mesh.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  // Blended layers (decals, shadows, glass) sit on the surfaces under them:
  // drawn after, with the game's blend factors, nudged forward so they don't flicker.
  if (mesh.translucent) Object.assign(material, {
    transparent: true, depthWrite: false, blending: THREE.CustomBlending,
    blendSrc: BLEND_SRC[mesh.blendSrc] ?? THREE.SrcAlphaFactor, blendDst: BLEND_DST[mesh.blendDst] ?? THREE.OneMinusSrcAlphaFactor,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
  });
  return material;
}

// GX blend factors as three.js ones; source and destination read 2 and 3 differently.
const BLEND_SRC = [THREE.ZeroFactor, THREE.OneFactor, THREE.DstColorFactor, THREE.OneMinusDstColorFactor, THREE.SrcAlphaFactor, THREE.OneMinusSrcAlphaFactor, THREE.DstAlphaFactor, THREE.OneMinusDstAlphaFactor];
const BLEND_DST = [THREE.ZeroFactor, THREE.OneFactor, THREE.SrcColorFactor, THREE.OneMinusSrcColorFactor, THREE.SrcAlphaFactor, THREE.OneMinusSrcAlphaFactor, THREE.DstAlphaFactor, THREE.OneMinusDstAlphaFactor];
