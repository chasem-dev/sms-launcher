'use strict';
// Makes a character pack's model.szs from a rigged glTF model (.glb or .vrm)
// and the player's own Mario archive: the model is bound to Mario's 29
// joints by role (hips, spine, head, shoulders, arms, hands, legs, feet),
// so the game's code and all of his animations play it; the animations take
// the model's proportions and are corrected frame by frame so its feet are on
// the floor where his are and its hands on the ledge where his are; its
// fingers are curled into his fist; its textures go in one atlas.
const j3d = require('./j3d');
const write = require('./j3d-write');
const { Glb, nodeLocal } = require('./glb');
const { rarc, yaz0 } = require('./archive');

// --- Small linear algebra: row-major 4x4 matrices and 3x3 rotations as flat arrays ------------

const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++)
    o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
  return o;
}
function inv(m) {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  const d = det ? 1 / det : 0;
  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * d, (a02 * b10 - a01 * b11 - a03 * b09) * d, (a31 * b05 - a32 * b04 + a33 * b03) * d, (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d, (a00 * b11 - a02 * b08 + a03 * b07) * d, (a32 * b02 - a30 * b05 - a33 * b01) * d, (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d, (a01 * b08 - a00 * b10 - a03 * b06) * d, (a30 * b04 - a31 * b02 + a33 * b00) * d, (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d, (a00 * b09 - a01 * b07 + a02 * b06) * d, (a31 * b01 - a30 * b03 - a32 * b00) * d, (a20 * b03 - a21 * b01 + a22 * b00) * d,
  ];
}
const tr = m => [m[3], m[7], m[11]];
const apply = (m, p) => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
const rot3 = m => [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
const m4 = (R, t = [0, 0, 0]) => [R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2], 0, 0, 0, 1];
const r3mul = (A, B) => [0, 1, 2].flatMap(r => [0, 1, 2].map(c => A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c]));
const r3T = A => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
const r3apply = (A, v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => Math.hypot(a[0], a[1], a[2]);
const unit = a => scale(a, 1 / (norm(a) || 1));
const angleOf = R => Math.acos(Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2))) * 180 / Math.PI;
function axisAngle(a, deg) {
  const [x, y, z] = unit(a), t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), k = 1 - c;
  return [c + x * x * k, x * y * k - z * s, x * z * k + y * s, y * x * k + z * s, c + y * y * k, y * z * k - x * s, z * x * k - y * s, z * y * k + x * s, c + z * z * k];
}
function rotationBetween(a, b) {
  a = unit(a); b = unit(b);
  const v = cross(a, b), c = dot(a, b);
  if (norm(v) < 1e-9) return c > 0 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : axisAngle(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]), 180);
  const K = [0, -v[2], v[1], v[2], 0, -v[0], -v[1], v[0], 0], KK = r3mul(K, K), f = 1 / (1 + c);
  return [0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => (i % 4 === 0 ? 1 : 0) + K[i] + KK[i] * f);
}
const rotAbout = (p, R) => m4(R, sub(p, r3apply(R, p)));
// A J3D joint's local matrix: scale, then rotation about X, Y and Z (radians), then translation.
function jointLocal(s, r, t) {
  const [cx, cy, cz] = r.map(Math.cos), [sx, sy, sz] = r.map(Math.sin);
  const R = [cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz, cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz, -sy, sx * cy, cx * cy];
  return [R[0] * s[0], R[1] * s[1], R[2] * s[2], t[0], R[3] * s[0], R[4] * s[1], R[5] * s[2], t[1], R[6] * s[0], R[7] * s[1], R[8] * s[2], t[2], 0, 0, 0, 1];
}
function worlds(joints, locals) {
  const W = new Array(joints.length);
  const get = i => W[i] || (W[i] = joints[i].parent >= 0 ? mul(get(joints[i].parent), locals[i]) : locals[i]);
  joints.forEach((_, i) => get(i));
  return W;
}

// --- Bone roles -----------------------------------------------------------------

const ROLES = ['hips', 'spine', 'neck', 'head', 'shoulder', 'upperarm', 'forearm', 'hand', 'thigh', 'shin', 'foot', 'skirt'];
const SIDED = new Set(['shoulder', 'upperarm', 'forearm', 'hand', 'thigh', 'shin', 'foot']);
const FINGER = ['thumb', 'index', 'middle', 'ring', 'pinky', 'little', 'finger', 'palm'];
// VRM's own humanoid labels (VRM 0.x and 1.0 name them alike).
const VRM_ROLES = { hips: 'hips', spine: 'spine', chest: 'spine', upperChest: 'spine', neck: 'neck', head: 'head',
  leftShoulder: 'shoulder.L', leftUpperArm: 'upperarm.L', leftLowerArm: 'forearm.L', leftHand: 'hand.L',
  rightShoulder: 'shoulder.R', rightUpperArm: 'upperarm.R', rightLowerArm: 'forearm.R', rightHand: 'hand.R',
  leftUpperLeg: 'thigh.L', leftLowerLeg: 'shin.L', leftFoot: 'foot.L', rightUpperLeg: 'thigh.R', rightLowerLeg: 'shin.R', rightFoot: 'foot.R' };

function guessRole(name) {
  const n = name.toLowerCase().replace(/^(mixamorig\d*[:_]?|j_bip_[clr]_|bip\d*[ _]|def[-_]|valvebiped\.bip01_)/, '');
  const has = (...words) => words.some(w => n.includes(w));
  if (['armature', 'root', 'scene', 'skeleton'].includes(n) || n.startsWith('armature')) return null;
  if (has(...FINGER) || has('end', 'eye', 'jaw', 'tongue', 'twist', 'pole', 'ik', 'target', 'hair', 'skirt', 'breast', 'bust')) return null;
  if (has('forearm', 'lowerarm', 'lower_arm', 'elbow')) return 'forearm';
  if (has('upperarm', 'upper_arm') || /(^|[^a-z])arm|arm($|[^a-z])|leftarm|rightarm/.test(n)) return 'upperarm';
  if (has('shoulder', 'clavicle')) return 'shoulder';
  if (has('hand', 'wrist')) return 'hand';
  if (has('upleg', 'upperleg', 'upper_leg', 'thigh')) return 'thigh';
  if (has('lowerleg', 'lower_leg', 'calf', 'shin', 'knee') || /leg/.test(n)) return 'shin';
  if (has('foot', 'ankle')) return 'foot';
  if (has('toe')) return null;
  if (has('hips', 'pelvis') || n === 'hip' || n === 'root_hip') return 'hips';
  if (has('neck')) return 'neck';
  if (has('head')) return 'head';
  if (has('spine', 'chest', 'abdomen', 'torso', 'body')) return 'spine';
  return null;
}

// --- Reading the model --------------------------------------------------------------

function vrmLabels(g) {
  const out = new Map();
  const v1 = g.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (v1) for (const [bone, { node }] of Object.entries(v1)) if (VRM_ROLES[bone]) out.set(node, VRM_ROLES[bone]);
  const v0 = g.extensions?.VRM?.humanoid?.humanBones;
  if (v0) for (const { bone, node } of v0) if (VRM_ROLES[bone]) out.set(node, VRM_ROLES[bone]);
  return out;
}

// The model's nodes, its world matrices, and every mesh skinned into its default pose.
function readModel(glb) {
  const g = glb.json, nodes = g.nodes, N = nodes.length;
  const parent = new Array(N).fill(-1);
  nodes.forEach((n, i) => (n.children || []).forEach(c => { parent[c] = i; }));
  const names = nodes.map((n, i) => n.name || `node ${i}`);
  // VRM 0.x models face away (-z): turned to face +z, as Mario does
  const facing = g.extensions?.VRM ? [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1] : I4();
  const local = nodes.map(nodeLocal), world = new Array(N);
  const get = i => world[i] || (world[i] = parent[i] >= 0 ? mul(get(parent[i]), local[i]) : mul(facing, local[i]));
  for (let i = 0; i < N; i++) get(i);
  const meshes = [], materials = [];
  nodes.forEach((node, ni) => {
    if (node.mesh === undefined) return;
    const skin = node.skin !== undefined ? g.skins[node.skin] : null;
    let skinMatrices = null;
    if (skin) {
      const ibm = skin.inverseBindMatrices !== undefined ? glb.accessor(skin.inverseBindMatrices) : null;
      skinMatrices = skin.joints.map((j, k) => {
        if (!ibm) return world[j];
        const c = ibm.subarray(k * 16, k * 16 + 16);
        return mul(world[j], [c[0], c[4], c[8], c[12], c[1], c[5], c[9], c[13], c[2], c[6], c[10], c[14], c[3], c[7], c[11], c[15]]);
      });
    }
    for (const prim of g.meshes[node.mesh].primitives || []) {
      const mode = prim.mode ?? 4;
      if (![4, 5, 6].includes(mode) || prim.attributes.POSITION === undefined) continue;
      const A = prim.attributes, p = glb.accessor(A.POSITION), count = p.length / 3;
      let index = prim.indices !== undefined ? Array.from(glb.accessor(prim.indices)) : Array.from({ length: count }, (_, i) => i);
      if (mode === 5) { const t = []; for (let i = 2; i < index.length; i++) t.push(...(i & 1 ? [index[i - 1], index[i - 2], index[i]] : [index[i - 2], index[i - 1], index[i]])); index = t; }
      if (mode === 6) { const t = []; for (let i = 2; i < index.length; i++) t.push(index[0], index[i - 1], index[i]); index = t; }
      let n = A.NORMAL !== undefined ? glb.accessor(A.NORMAL) : null;
      if (!n) {
        n = new Float64Array(p.length);
        for (let t = 0; t < index.length; t += 3) {
          const [a, b, c] = [index[t], index[t + 1], index[t + 2]];
          const f = cross(sub([p[b * 3], p[b * 3 + 1], p[b * 3 + 2]], [p[a * 3], p[a * 3 + 1], p[a * 3 + 2]]), sub([p[c * 3], p[c * 3 + 1], p[c * 3 + 2]], [p[a * 3], p[a * 3 + 1], p[a * 3 + 2]]));
          for (const v of [a, b, c]) for (let k = 0; k < 3; k++) n[v * 3 + k] += f[k];
        }
      }
      // without texture coordinates, the middle of the material's swatch (its edges blend into the next one)
      const st = A.TEXCOORD_0 !== undefined ? glb.accessor(A.TEXCOORD_0) : new Float64Array(count * 2).fill(0.5);
      const pos = new Float64Array(count * 3), nrm = new Float64Array(count * 3), weights = new Array(count);
      const J = skin && A.JOINTS_0 !== undefined ? glb.accessor(A.JOINTS_0) : null, Wt = J ? glb.accessor(A.WEIGHTS_0) : null;
      for (let v = 0; v < count; v++) {
        let M;
        if (J) {
          const ws = [Wt[v * 4], Wt[v * 4 + 1], Wt[v * 4 + 2], Wt[v * 4 + 3]], total = ws.reduce((s, x) => s + x, 0) || 1;
          M = new Array(16).fill(0);
          const wd = new Map();
          ws.forEach((w, k) => {
            if (!(w > 0)) return;
            const node = skin.joints[J[v * 4 + k]], m = skinMatrices[J[v * 4 + k]];
            for (let e = 0; e < 16; e++) M[e] += m[e] * w / total;
            wd.set(node, (wd.get(node) || 0) + w / total);
          });
          weights[v] = wd;
        } else {
          M = world[ni];
          weights[v] = new Map([[ni, 1]]);
        }
        const q = apply(M, [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]]);
        pos.set(q, v * 3);
        // normals by the inverse transpose
        const Mi = inv(M), nn = [n[v * 3], n[v * 3 + 1], n[v * 3 + 2]];
        const tn = unit([Mi[0] * nn[0] + Mi[4] * nn[1] + Mi[8] * nn[2], Mi[1] * nn[0] + Mi[5] * nn[1] + Mi[9] * nn[2], Mi[2] * nn[0] + Mi[6] * nn[1] + Mi[10] * nn[2]]);
        nrm.set(tn, v * 3);
      }
      const material = prim.material ?? -1;
      if (!materials.includes(material)) materials.push(material);
      // glTF fronts are counter-clockwise, J3D's clockwise
      const tris = new Int32Array(index.length);
      for (let t = 0; t < index.length; t += 3) { tris[t] = index[t]; tris[t + 1] = index[t + 2]; tris[t + 2] = index[t + 1]; }
      meshes.push({ name: names[ni], pos, nrm, st, weights, tris, material: materials.indexOf(material) });
    }
  });
  if (!meshes.length) throw new Error('The model has no meshes.');
  return { parent, names, world, meshes, materials, vrm: vrmLabels(g) };
}

// Bones: every joint of a skin and every ancestor of a weighted node, without the mesh nodes.
function bonesOf(glb, model) {
  const bones = new Set();
  for (const skin of glb.json.skins) skin.joints.forEach(j => bones.add(j));
  for (const m of model.meshes) for (const wd of m.weights) for (const b of wd.keys()) bones.add(b);
  for (const b of [...bones]) for (let p = model.parent[b]; p >= 0; p = model.parent[p]) bones.add(p);
  glb.json.nodes.forEach((n, i) => { if (n.mesh !== undefined) bones.delete(i); });
  return [...bones].sort((a, b) => a - b);
}

function sideOf(model, i, midX) {
  const n = model.names[i].toLowerCase();
  if (/left|(^|[^a-z])l([^a-z]|$)/.test(n)) return 'L';
  if (/right|(^|[^a-z])r([^a-z]|$)/.test(n)) return 'R';
  return model.world[i][3] > midX ? 'L' : 'R';   // facing +z, the left is +x
}

// Each bone's label ('hips', 'upperarm.L', ... or '' for none): VRM's own, else guessed from its name.
function guessLabels(glb, model) {
  const bones = bonesOf(glb, model), out = {};
  const plain = bones.map(i => [i, model.vrm.get(i) || guessRole(model.names[i])]).filter(([, r]) => r);
  const mid = plain.filter(([, r]) => ['hips', 'spine', 'neck', 'head'].includes(r)).map(([i]) => model.world[i][3]).sort((a, b) => a - b);
  const midX = mid.length ? mid[mid.length >> 1] : 0;
  for (const i of bones) {
    const role = model.vrm.get(i) || guessRole(model.names[i]);
    out[i] = !role ? '' : role.includes('.') || !SIDED.has(role) ? role : `${role}.${sideOf(model, i, midX)}`;
  }
  return { bones, labels: out };
}

// --- The character --------------------------------------------------------------

const SMS_ROLE = { hips: 'jnt_waist', skirt: 'jnt_waist', spine: 'jnt_chest', neck: 'jnt_chest', head: 'M_head',
  shoulder: 'jnt_sldr_', upperarm: 'jnt_arm_#1', forearm: 'jnt_arm_#2', hand: 'M_hand1_', thigh: 'jnt_leg_#1', shin: 'jnt_leg_#2', foot: 'M_foot_' };
// Limbs that keep Sunshine's bone direction (the animations twist them about it): joint -> the child ending the bone.
const ALIGN = { jnt_arm_L1: 'jnt_arm_L2', jnt_arm_L2: 'jnt_hand_L', jnt_arm_R1: 'jnt_arm_R2', jnt_arm_R2: 'jnt_hand_R',
  jnt_leg_L1: 'jnt_leg_L2', jnt_leg_L2: 'chn_foot_L', jnt_leg_R1: 'jnt_leg_R2', jnt_leg_R2: 'chn_foot_R' };
const ALIGN_MAX_DEG = 35;
// Sunshine body shape slots: index -> the joint its triangles hang from (null: skinned).
const SHAPE_JOINT = ['M_head', 'M_head', 'M_head', 'M_head', 'M_head_cap1', 'M_hand1_L', 'M_hand1_R', 'M_foot_R', 'M_foot_L', null, null];

class Character {
  constructor(model, labels, sms, height) {
    Object.assign(this, model);
    this.sms = sms;
    this.jnames = sms.joints.map(j => j.name);
    this.jidx = Object.fromEntries(this.jnames.map((n, i) => [n, i]));
    this.labels = new Map();
    const depth = i => (this.parent[i] < 0 ? 0 : 1 + depth(this.parent[i]));
    for (const [node, label] of Object.entries(labels)) {
      if (!label) continue;
      const [role, side = null] = label.split('.');
      if (!ROLES.includes(role)) throw new Error(`${this.names[node]}: ${label} is not a role.`);
      this.labels.set(Number(node), { role, side });
    }
    this.depth = depth;
    this.missing = ['hips', 'head'].filter(r => this.first(r) === null)
      .concat(['L', 'R'].flatMap(S => ['upperarm', 'forearm', 'thigh'].filter(r => this.first(r, S) === null).map(r => `${r}.${S}`)));
    if (this.missing.length) throw new Error(`Label these bones first: ${this.missing.join(', ')}.`);
    this.standOnFloor(height);
    this.poseToRest();
    [this.wmap, this.rolePos] = this.roles();
    this.retargetSkeleton();
    this.mapWeights();
  }

  first(role, side = null) {
    let best = null;
    for (const [i, l] of this.labels) if (l.role === role && l.side === side && (best === null || this.depth(i) < this.depth(best))) best = i;
    return best;
  }
  children(i) { return this.parent.map((p, c) => (p === i ? c : -1)).filter(c => c >= 0); }
  descendants(i) { const out = [], stack = this.children(i); while (stack.length) { const c = stack.pop(); out.push(c); stack.push(...this.children(c)); } return out; }
  pos(i) { return tr(this.world[i]); }

  // Scaled to `height` (Mario is 150 with his cap; null keeps the model's own size), centred between the
  // feet, standing on the floor.
  standOnFloor(height) {
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const m of this.meshes) for (let v = 0; v < m.pos.length; v += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], m.pos[v + k]); hi[k] = Math.max(hi[k], m.pos[v + k]); }
    const s = height ? height / (hi[1] - lo[1]) : 1;
    const S = [s, 0, 0, -s * (lo[0] + hi[0]) / 2, 0, s, 0, -s * lo[1], 0, 0, s, -s * (lo[2] + hi[2]) / 2, 0, 0, 0, 1];
    this.world = this.world.map(w => mul(S, w));
    for (const m of this.meshes) for (let v = 0; v < m.pos.length; v += 3) m.pos.set(apply(S, [m.pos[v], m.pos[v + 1], m.pos[v + 2]]), v);
  }

  handPos(S) {
    const h = this.first('hand', S);
    if (h !== null) return this.pos(h);
    const f = this.first('forearm', S);
    if (f === null) return null;
    const kids = this.children(f);
    return kids.length ? scale(kids.reduce((a, c) => add(a, this.pos(c)), [0, 0, 0]), 1 / kids.length) : null;
  }

  // The arms and legs turned onto Mario's rest directions (his T-pose), the mesh skinned along.
  poseToRest() {
    const rest = worlds(this.sms.joints, this.sms.joints.map(j => jointLocal(j.scale, j.rotation, j.translation)));
    const mario = n => tr(rest[this.jidx[n]]);
    this.posed = [];
    for (const S of ['L', 'R']) {
      for (let k = 0; k < 4; k++) {
        const f = r => this.first(r, S), chain = [];
        const ua = f('upperarm'), fa = f('forearm'), hp = this.handPos(S), th = f('thigh'), sh = f('shin'), ft = f('foot');
        if (ua !== null && fa !== null) chain.push([ua, `jnt_arm_${S}1`, this.pos(fa), `jnt_arm_${S}2`]);
        if (fa !== null && hp) chain.push([fa, `jnt_arm_${S}2`, hp, `jnt_hand_${S}`]);
        if (th !== null && sh !== null) chain.push([th, `jnt_leg_${S}1`, this.pos(sh), `jnt_leg_${S}2`]);
        if (sh !== null && ft !== null && this.descendants(sh).includes(ft)) chain.push([sh, `jnt_leg_${S}2`, this.pos(ft), `chn_foot_${S}`]);
        if (k >= chain.length) break;
        const [j, jn, end, en] = chain[k], p = this.pos(j), d = sub(end, p);
        if (norm(d) < 1e-6) continue;
        const R = rotationBetween(d, sub(mario(en), mario(jn)));
        const angle = angleOf(R);
        if (angle < 2) continue;
        this.posed.push([this.names[j], Math.round(angle)]);
        const T = rotAbout(p, R), moved = new Set([j, ...this.descendants(j)]);
        for (const m of this.meshes) {
          for (let v = 0; v < m.weights.length; v++) {
            let w = 0;
            for (const [b, x] of m.weights[v]) if (moved.has(b)) w += x;
            if (!w) continue;
            const o = v * 3, q = [m.pos[o], m.pos[o + 1], m.pos[o + 2]], t = apply(T, q), n = [m.nrm[o], m.nrm[o + 1], m.nrm[o + 2]], tn = r3apply(R, n);
            m.pos.set(add(scale(q, 1 - w), scale(t, w)), o);
            m.nrm.set(unit(add(scale(n, 1 - w), scale(tn, w))), o);
          }
        }
        for (const i of moved) this.world[i] = mul(T, this.world[i]);
      }
    }
    let low = Infinity;
    for (const m of this.meshes) for (let v = 1; v < m.pos.length; v += 3) low = Math.min(low, m.pos[v]);
    for (const m of this.meshes) for (let v = 1; v < m.pos.length; v += 3) m.pos[v] -= low;
    for (const w of this.world) w[7] -= low;
  }

  // Which Sunshine joint each labelled bone moves, and where the character's joints are.
  roles() {
    const wmap = new Map(), P = {};
    for (const [i, { role, side }] of this.labels) {
      const n = SMS_ROLE[role];
      if (!side) { if (role !== 'shoulder') wmap.set(i, n); continue; }
      wmap.set(i, n.includes('#') ? n.replace('#', side) : n + side);
    }
    for (const S of ['L', 'R']) {
      const f = r => this.first(r, S);
      if (f('hand') === null && f('forearm') !== null)
        for (const c of this.children(f('forearm'))) if (!wmap.has(c)) wmap.set(c, `M_hand1_${S}`);
      const th = f('thigh'), sh = f('shin'), ft = f('foot'), hip = this.pos(th);
      // a leg of one joint (Toad's): the knee halfway down and the ankle near the floor, under the hip
      const ankle = ft !== null ? this.pos(ft) : [hip[0], hip[1] * 0.15, hip[2]];
      P[`jnt_leg_${S}1`] = hip; P[`jnt_leg_${S}2`] = sh !== null ? this.pos(sh) : scale(add(hip, ankle), 0.5);
      for (const n of ['chn_foot_', 'jnt_foot_', 'M_foot_']) P[n + S] = ankle;
      const a1 = f('upperarm'), a2 = f('forearm'), sl = f('shoulder');
      const p1 = this.pos(a1), p2 = this.pos(a2);
      const ph = this.handPos(S) || add(p2, scale(sub(p2, p1), 0.5));
      Object.assign(P, { [`jnt_arm_${S}1`]: p1, [`jnt_arm_${S}2`]: p2, [`jnt_hand_${S}`]: ph, [`M_hand1_${S}`]: ph,
        [`jnt_sldr_${S}`]: sl !== null ? this.pos(sl) : [0, p1[1], p1[2]] });
    }
    const hips = this.first('hips'), spine = this.first('spine'), head = this.first('head');
    P.center = P.jnt_waist = this.pos(hips);
    P.chn_chest = P.jnt_chest = spine !== null ? this.pos(spine) : P.center;
    for (const n of ['jnt_head', 'M_head_cap1', 'M_head']) P[n] = this.pos(head);
    P.eff_sldr_L = P.jnt_arm_L1;
    return [wmap, P];
  }

  retargetSkeleton() {
    const joints = this.sms.joints, rest = worlds(joints, joints.map(j => jointLocal(j.scale, j.rotation, j.translation)));
    this.smsRest = rest;
    const ci = this.jidx.center, center = this.rolePos.center || tr(rest[ci]);
    const pos = joints.map((_, i) => this.rolePos[this.jnames[i]] || add(center, sub(tr(rest[i]), tr(rest[ci]))));
    pos[this.jidx.mdl1] = tr(rest[this.jidx.mdl1]);
    this.bind = rest.map((m, i) => { const b = m.slice(); b[3] = pos[i][0]; b[7] = pos[i][1]; b[11] = pos[i][2]; return b; });
    this.newT = joints.map((j, i) => (j.parent < 0 ? j.translation.slice() : tr(mul(inv(this.bind[j.parent]), this.bind[i]))));
    for (const [jn, cn] of Object.entries(ALIGN)) {
      const j = this.jidx[jn], c = this.jidx[cn];
      const dSms = sub(tr(rest[c]), tr(rest[j])), dNew = sub(pos[c], pos[j]);
      if (norm(dNew) < 1e-3 || norm(dSms) < 1e-3) continue;
      if (Math.acos(Math.max(-1, Math.min(1, dot(dSms, dNew) / norm(dSms) / norm(dNew)))) * 180 / Math.PI > ALIGN_MAX_DEG) continue;
      const R = r3mul(rotationBetween(dSms, dNew), rot3(rest[j]));
      this.bind[j] = m4(R, tr(this.bind[j]));
      this.newT[c] = scale(joints[c].translation, norm(dNew) / norm(dSms));
    }
    this.invBind = this.bind.map(inv);
    this.centerRatio = pos[ci][1] / rest[ci][7];
  }

  // Turns a hand's mesh by R inside its joint's frame (so it sits there as Mario's does).
  rotateHand(S, R) {
    const R4i = inv(m4(R));
    for (const jn of [`jnt_hand_${S}`, `M_hand1_${S}`]) {
      const j = this.jidx[jn];
      this.bind[j] = mul(this.bind[j], R4i);
      this.invBind[j] = inv(this.bind[j]);
    }
  }

  smsJointFor(node) {
    for (let i = node; i >= 0; i = this.parent[i]) if (this.wmap.has(i)) return this.jidx[this.wmap.get(i)];
    return this.jidx.center;
  }

  // Each vertex's Sunshine joints and weights (up to four, the lightest under 1% left out).
  mapWeights() {
    const cache = new Map();
    for (const m of this.meshes) m.sms = m.weights.map(wd => {
      const acc = new Map();
      for (const [node, w] of wd) {
        if (!cache.has(node)) cache.set(node, this.smsJointFor(node));
        const j = cache.get(node);
        acc.set(j, (acc.get(j) || 0) + w);
      }
      let list = [...acc].filter(([, w]) => w > 0.01).sort((a, b) => b[1] - a[1]).slice(0, 4);
      if (!list.length) list = [[this.jidx.center, 1]];
      const total = list.reduce((s, [, w]) => s + w, 0);
      return list.map(([j, w]) => [j, w / total]);
    });
  }

  fingerJoints(S) {
    const hands = [...this.wmap].filter(([, n]) => n === `M_hand1_${S}`).map(([i]) => i), out = new Set();
    for (const h of hands) for (const d of this.descendants(h)) out.add(d);
    if (this.first('hand', S) === null) hands.forEach(h => out.add(h));
    return [...out];
  }

  // Positions with the fingers curled about the knuckles' line by curl[S] degrees (thumbs half as far).
  posedPositions(curl) {
    const Wp = this.world.slice();
    for (const S of ['L', 'R']) {
      const fj = this.fingerJoints(S);
      if (!fj.length || !curl[S]) continue;
      const fset = new Set(fj), hp = this.handPos(S);
      const roots = fj.filter(i => !fset.has(this.parent[i]) && !/thumb/i.test(this.names[i]));
      const mean = scale(fj.reduce((a, i) => add(a, this.pos(i)), [0, 0, 0]), 1 / fj.length);
      const d = unit(sub(mean, hp));
      let a;
      if (roots.length >= 2) {
        // the knuckles' line: the roots' widest spread
        const pts = roots.map(i => this.pos(i)), c = scale(pts.reduce(add, [0, 0, 0]), 1 / pts.length);
        const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        for (const p of pts) { const q = sub(p, c); for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) C[r * 3 + k] += q[r] * q[k]; }
        a = [1, 0.5, 0.25];
        for (let it = 0; it < 30; it++) a = unit(r3apply(C, a));
      } else a = cross(d, [0, 1, 0]);
      a = unit(sub(a, scale(d, dot(a, d))));
      if (a[2] < 0) a = scale(a, -1);
      for (const i of [...fj].sort((x, y) => this.depth(x) - this.depth(y))) {
        const p = this.parent[i];
        const rel = p >= 0 ? mul(inv(this.world[p]), this.world[i]) : this.world[i];
        const base = p >= 0 ? Wp[p] : I4();
        const w = mul(base, rel);
        Wp[i] = mul(rotAbout(tr(w), axisAngle(a, curl[S] * (/thumb/i.test(this.names[i]) ? 0.5 : 1))), w);
      }
    }
    const skin = Wp.map((w, i) => (w === this.world[i] ? null : mul(w, inv(this.world[i]))));
    return this.meshes.map(m => {
      const out = new Float64Array(m.pos.length);
      for (let v = 0; v < m.weights.length; v++) {
        const q = [m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]];
        let r = [0, 0, 0];
        for (const [b, w] of m.weights[v]) r = add(r, scale(skin[b] ? apply(skin[b], q) : q, w));
        out.set(r, v * 3);
      }
      return out;
    });
  }
}

// --- Textures ------------------------------------------------------------------

const toLinear = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = c => { c = Math.max(0, Math.min(1, c)); return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055; };

function resize(image, width, height) {
  // halve while more than twice too big (an average of each 2x2), then sample bilinearly
  let { width: w, height: h, rgba } = image;
  while (w >= width * 2 && h >= height * 2) {
    const nw = w >> 1, nh = h >> 1, out = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let c = 0; c < 4; c++) {
      const i = ((2 * y) * w + 2 * x) * 4 + c;
      out[(y * nw + x) * 4 + c] = (rgba[i] + rgba[i + 4] + rgba[i + w * 4] + rgba[i + w * 4 + 4] + 2) >> 2;
    }
    w = nw; h = nh; rgba = out;
  }
  if (w === width && h === height) return { width, height, rgba };
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const fx = Math.min(w - 1, Math.max(0, (x + 0.5) * w / width - 0.5)), fy = Math.min(h - 1, Math.max(0, (y + 0.5) * h / height - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1), tx = fx - x0, ty = fy - y0;
    for (let c = 0; c < 4; c++) {
      const v = (rgba[(y0 * w + x0) * 4 + c] * (1 - tx) + rgba[(y0 * w + x1) * 4 + c] * tx) * (1 - ty) + (rgba[(y1 * w + x0) * 4 + c] * (1 - tx) + rgba[(y1 * w + x1) * 4 + c] * tx) * ty;
      out[(y * width + x) * 4 + c] = Math.round(v);
    }
  }
  return { width, height, rgba: out };
}

// One texture per material: its base colour image times its colour factor (linear), or a swatch of the factor.
function materialTextures(glb, materials, images) {
  const g = glb.json;
  return materials.map(mat => {
    const pbr = (mat >= 0 ? g.materials[mat] : {}).pbrMetallicRoughness || {};
    const f = pbr.baseColorFactor || [1, 1, 1, 1];
    const source = pbr.baseColorTexture ? g.textures[pbr.baseColorTexture.index]?.source : undefined;
    const image = source !== undefined ? images[source] : null;
    if (!image) {
      const rgba = new Uint8Array(16 * 16 * 4);
      for (let i = 0; i < 256; i++) { for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round(toSrgb(f[c]) * 255); rgba[i * 4 + 3] = 255; }
      return { width: 16, height: 16, rgba, plain: true };
    }
    let out = image.width > 1024 || image.height > 1024
      ? resize(image, Math.max(1, Math.round(image.width * 1024 / Math.max(image.width, image.height))), Math.max(1, Math.round(image.height * 1024 / Math.max(image.width, image.height))))
      : { ...image, rgba: Uint8Array.from(image.rgba) };
    const plain = f.slice(0, 3).every(v => v === 1);
    for (let i = 0; i < out.rgba.length; i += 4) {
      if (!plain) for (let c = 0; c < 3; c++) out.rgba[i + c] = Math.round(toSrgb(toLinear(out.rgba[i + c] / 255) * f[c]) * 255);
      out.rgba[i + 3] = 255;
    }
    return out;
  });
}

// Every texture in one atlas (the smallest of 512x512, 1024x512 and 1024x1024 that holds them),
// shrinking all of them until they fit. Returns the atlas and each texture's rectangle (0..1).
const PAD = 4;
function buildAtlas(textures, used) {
  for (let limit = 1024; limit >= 16; limit >>= 1) {
    const imgs = new Map();
    for (const t of used) {
      let img = textures[t];
      if (Math.max(img.width, img.height) > limit) {
        const k = limit / Math.max(img.width, img.height);
        img = resize(img, Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k)));
      }
      if (Math.max(img.width, img.height) < 64) {
        // tiny textures are enlarged so filtering does not bleed in their neighbours
        const f = Math.floor(64 / Math.max(img.width, img.height));
        img = resize(img, img.width * f, img.height * f);
      }
      imgs.set(t, img);
    }
    const order = [...imgs.keys()].sort((a, b) => imgs.get(b).height - imgs.get(a).height || imgs.get(b).width - imgs.get(a).width);
    for (const [W, H] of [[512, 512], [1024, 512], [1024, 1024]]) {
      const rects = new Map();
      let x = 0, y = 0, shelf = 0, ok = true;
      for (const t of order) {
        const { width, height } = imgs.get(t);
        // a border between textures, filled with their edge colours (gutter), so filtering at one's edge stays in it
        if (x + width > W) { x = 0; y += shelf + PAD; shelf = 0; }
        if (y + height > H || width > W) { ok = false; break; }
        rects.set(t, [x, y]); x += width + PAD; shelf = Math.max(shelf, height);
      }
      if (!ok) continue;
      const rgba = new Uint8Array(W * H * 4), covered = new Uint8Array(W * H);
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
      const out = new Map();
      for (const [t, [x0, y0]] of rects) {
        const img = imgs.get(t);
        for (let r = 0; r < img.height; r++) {
          rgba.set(img.rgba.subarray(r * img.width * 4, (r + 1) * img.width * 4), ((y0 + r) * W + x0) * 4);
          covered.fill(1, (y0 + r) * W + x0, (y0 + r) * W + x0 + img.width);
        }
        out.set(t, [x0 / W, y0 / H, img.width / W, img.height / H]);
      }
      gutter(rgba, covered, W, H, PAD * 2);
      return { atlas: { width: W, height: H, rgba }, rects: out };
    }
  }
  throw new Error('The model\'s textures do not fit in the game\'s texture.');
}

// Empty atlas texels take their nearest neighbour's colour, so filtering at a texture's edge blends no black in.
function gutter(rgba, covered, W, H, width = 8) {
  for (let pass = 0; pass < width; pass++) {
    const next = covered.slice();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (covered[i]) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || !covered[ny * W + nx]) continue;
        rgba.copyWithin(i * 4, (ny * W + nx) * 4, (ny * W + nx) * 4 + 4);
        next[i] = 1;
        break;
      }
    }
    covered.set(next);
  }
}

// --- Geometry ------------------------------------------------------------------

class GeometryBuilder {
  constructor(ch, positions, rigidSpace = null) {
    Object.assign(this, { ch, positions, rigidSpace, pos: [], nrm: [], uv: [], pmap: new Map(), nmap: new Map(), umap: new Map(), drw: [], dmap: new Map(), env: [], emap: new Map() });
  }
  binding(mi, v) {
    const w = this.ch.meshes[mi].sms[v];
    if (this.rigidSpace !== null) return ['rigid', this.rigidSpace];
    return w.length === 1 ? ['rigid', w[0][0]] : ['env', w];
  }
  drwIndex(b) {
    let key;
    if (b[0] === 'rigid') {
      key = `r${b[1]}`;
      if (!this.dmap.has(key)) { this.dmap.set(key, this.drw.length); this.drw.push([0, b[1]]); }
    } else {
      const env = b[1].map(([j, w]) => [j, Math.round(w * 1e4) / 1e4]), ek = JSON.stringify(env);
      if (!this.emap.has(ek)) { this.emap.set(ek, this.env.length); this.env.push(env); }
      key = `e${ek}`;
      if (!this.dmap.has(key)) { this.dmap.set(key, this.drw.length); this.drw.push([1, this.emap.get(ek)]); }
    }
    return this.dmap.get(key);
  }
  // Rigid draw matrices first, then the weighted ones in envelope order (as J3D expects).
  finalize(shapes) {
    const order = this.drw.map((_, i) => i).sort((a, b) => this.drw[a][0] - this.drw[b][0] || a - b);
    const remap = new Map(order.map((old, k) => [old, k]));
    this.drw = order.map(i => this.drw[i]);
    for (const shape of shapes) for (const packet of shape.packets) packet.mtx = packet.mtx.map(m => remap.get(m));
  }
  toSpace(b, p, normal = false) {
    if (b[0] === 'env') return p;
    const M = this.ch.invBind[b[1]];
    return normal ? r3apply(rot3(M), p) : apply(M, p);
  }
  corner(mi, v, uv) {
    const m = this.ch.meshes[mi], b = this.binding(mi, v), pk = `${mi}:${v}`;
    if (!this.pmap.has(pk)) { this.pmap.set(pk, this.pos.length); this.pos.push(this.toSpace(b, Array.from(this.positions[mi].subarray(v * 3, v * 3 + 3)))); }
    if (!this.nmap.has(pk)) { this.nmap.set(pk, this.nrm.length); this.nrm.push(unit(this.toSpace(b, Array.from(m.nrm.subarray(v * 3, v * 3 + 3)), true))); }
    const uk = `${uv[0].toFixed(6)},${uv[1].toFixed(6)}`;
    if (!this.umap.has(uk)) { this.umap.set(uk, this.uv.length); this.uv.push(uv); }
    return [this.drwIndex(b), this.pmap.get(pk), this.nmap.get(pk), this.umap.get(uk)];
  }
}

function makeShapes(builder, triLists, mtypes, joints, uvOf) {
  return triLists.map((tris, s) => {
    let corners = tris.map(([mi, a, b, c]) => [a, b, c].map(v => builder.corner(mi, v, uvOf(mi, v))));
    if (!corners.length) {
      // keep the slot: one zero-area triangle on the slot's joint
      const j = joints[s] ?? builder.ch.jidx.center;
      if (!builder.pos.length) { builder.pos.push([0, 0, 0]); builder.nrm.push([0, 1, 0]); builder.uv.push([0, 0]); }
      const d = builder.drwIndex(['rigid', j]);
      corners = [[[d, 0, 0, 0], [d, 0, 0, 0], [d, 0, 0, 0]]];
    }
    let packets;
    if (mtypes[s] === 0) packets = [{ mtx: [corners[0][0][0]], tris: corners.map(tri => tri.map(([, p, n, t]) => [0, p, n, t])) }];
    else {
      packets = [];
      let slots = new Map(), cur = [];
      for (const tri of corners) {
        const need = new Set(tri.map(([d]) => d).filter(d => !slots.has(d)));
        if (slots.size + need.size > 10) { packets.push([slots, cur]); slots = new Map(); cur = []; }
        for (const [d] of tri) if (!slots.has(d)) slots.set(d, slots.size);
        cur.push(tri);
      }
      packets.push([slots, cur]);
      packets = packets.map(([sl, tl]) => ({ mtx: [...sl.keys()], tris: tl.map(tri => tri.map(([d, p, n, t]) => [sl.get(d), p, n, t])) }));
    }
    return { mtype: mtypes[s], packets };
  });
}

function bounds(shapes, builder) {
  for (const shape of shapes) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const packet of shape.packets) for (const tri of packet.tris) for (const [, p] of tri) for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], builder.pos[p][k]); hi[k] = Math.max(hi[k], builder.pos[p][k]);
    }
    shape.bbox = [lo, hi];
    shape.radius = Math.hypot(...[0, 1, 2].map(k => Math.max(Math.abs(lo[k]), Math.abs(hi[k]))));
  }
}

// Each triangle's slot: the head, a hand, a foot (all of its corners on that joint alone) or the skinned body.
function classify(ch) {
  const J = n => ch.jidx[n], slotOf = { [J('M_head')]: 0, [J('M_hand1_L')]: 5, [J('M_hand1_R')]: 6, [J('M_foot_R')]: 7, [J('M_foot_L')]: 8 };
  const lists = Array.from({ length: 11 }, () => []);
  ch.meshes.forEach((m, mi) => {
    if (m.part) return;  // an open hand: its own models, not the body's
    for (let t = 0; t < m.tris.length; t += 3) {
      const corners = [m.tris[t], m.tris[t + 1], m.tris[t + 2]];
      const single = corners.map(v => (m.sms[v].length === 1 ? m.sms[v][0][0] : -1));
      const slot = single[0] >= 0 && single.every(j => j === single[0]) && slotOf[single[0]] !== undefined ? slotOf[single[0]] : 9;
      lists[slot].push([mi, ...corners]);
    }
  });
  return lists;
}

function buildBody(ch, template, positions, triLists, atlas, uvOf) {
  const b = new GeometryBuilder(ch, positions);
  const mtypes = [0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3];
  const joints = SHAPE_JOINT.map(n => (n ? ch.jidx[n] : null));
  const shapes = makeShapes(b, triLists, mtypes, joints, uvOf);
  // the game indexes vertices with 16 bits
  if (b.pos.length > 0xffff || b.uv.length > 0xffff)
    throw new Error(`The model has ${Math.max(b.pos.length, b.uv.length).toLocaleString()} vertices, more than the game's 65,535: simplify it (in Blender, a Decimate modifier) and try again.`);
  b.finalize(shapes);
  bounds(shapes, b);
  const { section: shp, packets } = write.shp1(shapes);
  const mouth = { format: 6, width: 16, height: 32, rgba: new Uint8Array(16 * 32 * 4).fill(255) };
  return write.assemble(template, {
    INF1: write.inf1Patch(write.sectionOf(template, 'INF1'), packets, b.pos.length),
    VTX1: write.vtx1(b.pos.flat(), b.nrm.flat(), b.uv.flat()),
    EVP1: write.evp1(b.env, ch.invBind),
    DRW1: write.drw1(b.drw),
    JNT1: write.jnt1Patch(write.sectionOf(template, 'JNT1'), ch.newT),
    SHP1: shp,
    TEX1: write.tex1(write.sectionOf(template, 'TEX1'), { H_ma_new_main_s3tc: { format: 14, ...atlas }, H_ma_mouse1_s3tc: mouth }),
  });
}

// A single-shape part model (a hand or the cap), all of it in one Sunshine joint's frame.
function buildPart(ch, template, positions, tris, spaceJoint, uvOf) {
  const b = new GeometryBuilder(ch, positions, spaceJoint);
  const shapes = makeShapes(b, [tris], [0], [spaceJoint], uvOf);
  for (const packet of shapes[0].packets) packet.mtx = [0];
  bounds(shapes, b);
  const { section: shp, packets } = write.shp1(shapes);
  return write.assemble(template, {
    INF1: write.inf1Patch(write.sectionOf(template, 'INF1'), packets, b.pos.length),
    VTX1: write.vtx1(b.pos.flat(), b.nrm.flat(), b.uv.flat()),
    EVP1: write.evp1([], []),
    DRW1: write.drw1([[0, 0]]),
    SHP1: shp,
  });
}

// --- Hands: the fist, fitted to Mario's ------------------------------------------------

// Points on a shape's triangles (four per triangle), at most `limit` of them.
function surface(tris, at, limit = 600) {
  const out = [];
  for (const [a, b, c] of tris) {
    const A = at(a), B = at(b), C = at(c);
    for (const [u, v] of [[1 / 3, 1 / 3], [0.6, 0.2], [0.2, 0.6], [0.2, 0.2]]) out.push(add(A, add(scale(sub(B, A), u), scale(sub(C, A), v))));
  }
  if (out.length <= limit) return out;
  return Array.from({ length: limit }, (_, i) => out[Math.floor(i * (out.length - 1) / (limit - 1))]);
}

// The rotation best turning `src` onto `dst` (paired), about the origin: Horn's quaternion method.
function bestRotation(src, dst) {
  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  src.forEach((p, i) => { const q = dst[i]; for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r * 3 + c] += p[r] * q[c]; });
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = S;
  const N = [[xx + yy + zz, yz - zy, zx - xz, xy - yx], [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy], [xy - yx, zx + xz, yz + zy, -xx - yy + zz]];
  // largest eigenvector by Jacobi rotations
  const A = N.map(r => r.slice()), V = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += A[p][q] ** 2;
    if (off < 1e-18) break;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
      if (Math.abs(A[p][q]) < 1e-30) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 4; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 4; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 4; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  let best = 0;
  for (let k = 1; k < 4; k++) if (A[k][k] > A[best][best]) best = k;
  const [w, x, y, z] = V.map(r => r[best]);
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
}

function icp(src, dst, R0, iters) {
  let R = R0, err = Infinity;
  for (let it = 0; it < iters; it++) {
    const nn = [];
    let total = 0;
    for (const p of src) {
      const q = r3apply(R, p);
      let best = Infinity, bi = 0;
      for (let k = 0; k < dst.length; k++) { const d = (q[0] - dst[k][0]) ** 2 + (q[1] - dst[k][1]) ** 2 + (q[2] - dst[k][2]) ** 2; if (d < best) { best = d; bi = k; } }
      nn.push(dst[bi]); total += best;
    }
    err = Math.sqrt(total / src.length);
    if (it === iters - 1 && iters === 1) break;
    R = bestRotation(src, nn);
  }
  return [R, err];
}

// A small corrective turn of the character's fist onto Mario's (at most maxDeg).
function fitHand(mario, char, maxDeg = 45) {
  const mean = pts => pts.reduce((s, p) => s + norm(p), 0) / pts.length;
  const k = mean(mario) / (mean(char) || 1), src = char.map(p => scale(p, k));
  const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let best = [I3, icp(src, mario, I3, 1)[1]];
  for (const roll of [-20, 0, 20]) for (const pitch of [-20, 0, 20]) {
    const [R, e] = icp(src, mario, r3mul(axisAngle([1, 0, 0], roll), axisAngle([0, 0, 1], pitch)), 25);
    if (angleOf(R) <= maxDeg && e < best[1]) best = [R, e];
  }
  return best;
}

// --- Animations ------------------------------------------------------------------

// A body animation with the character's joint offsets, and the hips' height in its proportion.
function retargetBck(ch, data) {
  const bck = write.bckTranslations(data);
  if (bck.count !== ch.jnames.length) return null;
  const center = ch.jidx.center;
  return bck.write(bck.tracks.map((axes, j) => axes.map((keys, axis) => keys.map(k => {
    if (j === center) return axis === 1 ? { ...k, value: k.value * ch.centerRatio, in: (k.in ?? 0) * ch.centerRatio, out: (k.out ?? 0) * ch.centerRatio } : k;
    return { ...k, value: k.value + ch.newT[j][axis] - ch.sms.joints[j].translation[axis] };
  }))));
}

const GROUNDED = [-8, 4], HANGING = -100, LIFT_RATE = 0.012, HANG_BLEND = 8;
const AIRBORNE = new Set(['ma_step1', 'ma_step2', 'ma_step3', 'ma_jump', 'ma_2jmp1', 'ma_2jmp2', 'ma_tjmp1', 'ma_roll', 'ma_roll_jump',
  'ma_jump_rolling', 'ma_broad_jump', 'ma_wjmp', 'ma_firejmp', 'ma_hipsr', 'ma_hipat', 'ma_yo_jump', 'ma_yo_jump_fall', 'ma_yo_hold_jump', 'ma_dive_wait']);
const OFF_FLOOR = ['ma_fence_', 'ma_tree_', 'ma_ladder_', 'ma_swim', 'ma_paddle_', 'ma_wait_to_paddle', 'ma_wait_to_swim', 'ma_float'];
const noFloor = clip => AIRBORNE.has(clip) || OFF_FLOOR.some(p => clip.startsWith(p));

// A posable body: its joints, vertices in bind space and their weights.
function posable(joints, invBind, vertices) {
  const V = vertices.length, P = new Float64Array(V * 3), J = new Int32Array(V * 4), W = new Float64Array(V * 4);
  vertices.forEach(([p, w], v) => { P.set(p, v * 3); w.slice(0, 4).forEach(([j, x], k) => { J[v * 4 + k] = j; W[v * 4 + k] = x; }); });
  let lo = Infinity, hi = -Infinity;
  for (let v = 1; v < P.length; v += 3) { lo = Math.min(lo, P[v]); hi = Math.max(hi, P[v]); }
  return { joints, invBind, P, J, W, V, minY: lo, height: hi - lo, jid: Object.fromEntries(joints.map((j, i) => [j.name, i])) };
}

function animLocals(body, anim, t) {
  return body.joints.map((joint, j) => {
    const track = anim.joints[j];
    if (!track) return jointLocal(joint.scale, joint.rotation, joint.translation);
    return jointLocal(track.scale.map(k => j3d.sampleTrack(k, t)), track.rotation.map(k => j3d.sampleTrack(k, t)), track.translation.map(k => j3d.sampleTrack(k, t)));
  });
}

// The lowest point of the body posed at frame t, and the middle of its hands.
function lowest(body, anim, t) {
  const A = worlds(body.joints, animLocals(body, anim, t));
  const row = A.map((a, j) => { const s = mul(a, body.invBind[j]); return [s[4], s[5], s[6], s[7]]; });
  let low = Infinity;
  const { P, J, W } = body;
  for (let v = 0; v < body.V; v++) {
    let y = 0;
    for (let k = 0; k < 4; k++) {
      const w = W[v * 4 + k];
      if (!w) continue;
      const r = row[J[v * 4 + k]];
      y += w * (r[0] * P[v * 3] + r[1] * P[v * 3 + 1] + r[2] * P[v * 3 + 2] + r[3]);
    }
    if (y < low) low = y;
  }
  return { low, hands: scale(add(tr(A[body.jid.M_hand1_L]), tr(A[body.jid.M_hand1_R])), 0.5), waist: A[body.jid.jnt_waist][7], mdl1: rot3(A[0]) };
}

const lastFrame = anim => Math.max(1, Math.ceil(Math.max(0, ...anim.joints.flatMap(t => ['scale', 'rotation', 'translation'].flatMap(c => t[c].map(keys => keys[keys.length - 1].time || 0))))));
const percentile = (values, q) => { if (!values.length) return 0; const s = [...values].sort((a, b) => a - b), i = (s.length - 1) * q / 100, lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };

function interp(x, xp, fp, period = 0) {
  if (!xp.length) return x.map(() => 0);
  if (period) {
    const order = xp.map((v, i) => [((v % period) + period) % period, fp[i]]).sort((a, b) => a[0] - b[0]);
    const xs = [order[order.length - 1][0] - period, ...order.map(o => o[0]), order[0][0] + period];
    const fs = [order[order.length - 1][1], ...order.map(o => o[1]), order[0][1]];
    return x.map(v => interp([((v % period) + period) % period], xs, fs)[0]);
  }
  return x.map(v => {
    if (v <= xp[0]) return fp[0];
    if (v >= xp[xp.length - 1]) return fp[fp.length - 1];
    let i = 0;
    while (xp[i + 1] < v) i++;
    return fp[i] + (fp[i + 1] - fp[i]) * (v - xp[i]) / (xp[i + 1] - xp[i]);
  });
}

function smooth(off, loop, w = 8, period = false) {
  if (loop && !period && off.length > 3) { const out = smooth(off.slice(0, -1), true, w, true); return [...out, out[0]]; }
  const n = off.length, r = Math.min(w >> 1, Math.max((n - 1) >> 1, 1));
  if (n < 3) return off.slice();
  const at = i => (loop ? off[((i % n) + n) % n] : off[Math.max(0, Math.min(n - 1, i))]);
  const out = off.map((_, i) => { let s = 0; for (let k = -r; k <= r; k++) s += at(i + k); return s / (2 * r + 1); });
  if (!loop) { out[0] = off[0]; out[n - 1] = off[n - 1]; }
  return out;
}

function smoothUp(off, loop, rate) {
  const n = off.length;
  if (n < 2) return off.slice();
  if (loop && n > 3) {
    const m = n - 1, out = [];
    for (let i = 0; i < m; i++) { let best = -Infinity; for (let j = 0; j < m; j++) { const d = Math.min(Math.abs(i - j), m - Math.abs(i - j)); best = Math.max(best, off[j] - rate * d); } out.push(best); }
    return [...out, out[0]];
  }
  return off.map((_, i) => { let best = -Infinity; for (let j = 0; j < n; j++) best = Math.max(best, off[j] - rate * Math.abs(i - j)); return best; });
}

// Per-frame offsets of the root (frames x 3): standing, the character's lowest point where Mario's
// is; hanging, its hands where his are; between, eased (refine.py's ground_offsets).
function groundOffsets(body, anim, mario, manim, hover) {
  const last = lastFrame(anim), frames = Array.from({ length: last + 1 }, (_, i) => i), loop = anim.loop === 2;
  const me = frames.map(t => lowest(mario, manim, t)), ch = frames.map(t => lowest(body, anim, t));
  const waistMoves = me.slice(1).map((m, i) => Math.abs(m.waist - me[i].waist));
  let rate = LIFT_RATE * body.height + percentile(waistMoves, 95) * body.height / mario.height;
  const ground = me.map(m => m.low >= GROUNDED[0] && m.low <= GROUNDED[1]), hang = me.map(m => m.low < HANGING);
  if (!ground.some(Boolean) && !hang.some(Boolean)) return null;
  const want = frames.map(i => (hang[i] ? sub(me[i].hands, ch[i].hands) : ground[i] ? [0, me[i].low + hover - ch[i].low, 0] : [0, 0, 0]));
  const held = frames.filter(i => ground[i] || hang[i]);
  const gi = frames.filter(i => ground[i]);
  if (gi.length > 2) {
    const dn = [];
    for (let k = 1; k < gi.length; k++) if (gi[k] === gi[k - 1] + 1) dn.push(Math.abs(want[gi[k]][1] - want[gi[k - 1]][1]));
    if (dn.length) rate = Math.max(rate, percentile(dn, 90));
  }
  const anyHang = hang.some(Boolean), off = frames.map(() => [0, 0, 0]);
  for (let ax = 0; ax < 3; ax++) {
    let o;
    if (loop) {
      let h = held.filter(i => i < last);
      if (!h.length) h = held;
      o = interp(frames, h, h.map(i => want[i][ax]), last);
      const gap = o[0] - o[o.length - 1];
      o = o.map((v, i) => v + (i / last) * gap);
    } else o = interp(frames, held, held.map(i => want[i][ax]));
    if (ax === 1 && !anyHang) o = smoothUp(o, loop, rate);
    else if (anyHang) {
      o = smooth(o, loop, HANG_BLEND);
      if (ax === 1) { const floor = smoothUp(frames.map(i => (ground[i] ? want[i][1] : -1e9)), loop, rate); o = o.map((v, i) => Math.max(v, floor[i])); }
    }
    o.forEach((v, i) => { off[i][ax] = v; });
  }
  return { frames, off, mdl1: ch.map(c => c.mdl1) };
}

// Adds per-frame offsets (model space) to the root's translation, turned into mdl1's frame.
function addCenterOffset(data, anim, centerJoint, frames, off, mdl1) {
  const local = off.map((o, i) => r3apply(r3T(mdl1[i]), o));
  const bck = write.bckTranslations(data);
  const tracks = bck.tracks.map(axes => axes.slice());
  for (let ax = 0; ax < 3; ax++) {
    if (Math.max(...local.map(o => Math.abs(o[ax]))) < 1e-3) continue;
    const track = anim.joints[centerJoint].translation[ax];
    const values = frames.map((t, i) => j3d.sampleTrack(track, t) + local[i][ax]);
    tracks[centerJoint][ax] = values.map((v, i) => {
      const slope = (values[Math.min(i + 1, values.length - 1)] - values[Math.max(i - 1, 0)]) / (Math.min(i + 1, values.length - 1) - Math.max(i - 1, 0) || 1);
      return { time: frames[i], value: v, in: slope, out: slope };
    });
  }
  return bck.write(tracks);
}

// --- A gown (refine.py's gown handling) --------------------------------------------------

// How much of the hem follows the thighs (none at the hips), and how much of each leg joint's turn
// from rest a gown keeps (thigh, knee, ankle): the legs stay under it.
const GOWN_SWAY = 0.5;
const GOWN_LEGS = { jnt_leg_L1: 0.6, jnt_leg_R1: 0.6, jnt_leg_L2: 0.25, jnt_leg_R2: 0.25, jnt_foot_L: 0.5, jnt_foot_R: 0.5 };
const PIROUETTE_DAMP = { jnt_waist: 0.3, jnt_leg_L1: 0.25, jnt_leg_R1: 0.25, jnt_leg_L2: 0.5, jnt_leg_R2: 0.5 };
// diving down in water; stuck head first in sand, as the clip before
const NO_PIROUETTE = ['swim', 'sand'];
// the gown's axis pointing down this much (cosine from up): upside down
const GOWN_INVERTED = -0.2;
const DEG = 180 / Math.PI;
const wrap180 = a => ((a + 180) % 360 + 360) % 360 - 180;

// The hem below the thighs, hanging from the waist alone, follows the thigh on its side a little.
function swayGown(ch, sway = GOWN_SWAY, wide = false) {
  const wj = ch.jidx.jnt_waist, L = ch.jidx.jnt_leg_L1, R = ch.jidx.jnt_leg_R1;
  const top = ch.bind[L][7], xL = ch.bind[L][3], xR = ch.bind[R][3], mid = (xL + xR) / 2;
  const waistOnly = w => w.length === 1 && w[0][0] === wj;
  let bottom = Infinity, half = 0;
  for (const m of ch.meshes) m.sms.forEach((w, v) => {
    if (!waistOnly(w)) return;
    bottom = Math.min(bottom, m.pos[v * 3 + 1]);
    half = Math.max(half, Math.abs(m.pos[v * 3] - mid));
  });
  if (!Number.isFinite(bottom)) return;
  for (const m of ch.meshes) m.sms = m.sms.map((w, v) => {
    const x = m.pos[v * 3], y = m.pos[v * 3 + 1];
    if (!waistOnly(w) || y >= top) return w;
    const f = sway * Math.min(1, Math.max(0, (top - y) / Math.max(top - bottom, 1e-3))) ** 1.5;
    // 1 at the left: from thigh to thigh, or (wide) across the whole gown, so a low-polygon hem bends
    // between the legs rather than creasing to a point
    const side = Math.min(1, Math.max(0, wide ? 0.5 + 0.5 * (x - mid) / Math.max(half, 1e-3) : (x - xR) / (xL - xR)));
    return [[wj, 1 - f], [L, f * side], [R, f * (1 - side)]].filter(([, k]) => k > 1e-3).sort((a, b) => b[1] - a[1]);
  });
}

// Each leg joint brought toward its rest turn (Mario's), keeping factors[joint] of the turn.
function dampLegs(anim, ch, factors) {
  for (const [name, factor] of Object.entries(factors)) {
    const j = ch.jidx[name], rest = ch.sms.joints[j].rotation.map(r => r * DEG);
    for (let axis = 0; axis < 3; axis++) {
      const keys = anim.joints[j][axis].rotation;
      if (keys.length === 1) { keys[0].value = rest[axis] + factor * wrap180(keys[0].value - rest[axis]); continue; }
      // the turn from rest, the shorter way round at the first key and continuous after it
      const k0 = keys[0].value, d0 = wrap180(k0 - rest[axis]);
      for (const k of keys) { k.value = rest[axis] + factor * (d0 + k.value - k0); k.in = (k.in ?? 0) * factor; k.out = (k.out ?? 0) * factor; }
    }
  }
}

const lastKey = anim => Math.max(1, Math.ceil(Math.max(0, ...anim.joints.flatMap(axes => axes.flatMap(a => ['scale', 'rotation', 'translation'].map(c => a[c][a[c].length - 1].time || 0))))));
function animLocalsDeg(anim, joints, t) {
  return joints.map((joint, j) => {
    const axes = anim.joints[j];
    if (!axes) return jointLocal(joint.scale, joint.rotation, joint.translation);
    return jointLocal(axes.map(a => j3d.sampleTrack(a.scale, t)), axes.map(a => j3d.sampleTrack(a.rotation, t) / DEG), axes.map(a => j3d.sampleTrack(a.translation, t)));
  });
}
// A track as one key a frame, each with the slope of its neighbours.
function setTrack(anim, j, axis, comp, frames, values) {
  const n = values.length;
  anim.joints[j][axis][comp] = n < 2 ? [{ value: values[0] }] : values.map((v, i) => {
    const a = Math.max(i - 1, 0), b = Math.min(i + 1, n - 1), slope = (values[b] - values[a]) / (frames[b] - frames[a]);
    return { time: frames[i], value: v, in: slope, out: slope };
  });
}
// J3D angles (degrees, R = Rz Ry Rx) of a rotation, the solution nearest prev.
function euler(M, prev) {
  const b = Math.asin(Math.max(-1, Math.min(1, -M[6]))), a = Math.atan2(M[7], M[8]), c = Math.atan2(M[3], M[0]);
  const cands = [[a, b, c], [a + Math.PI, Math.PI - b, c + Math.PI]].map(e => e.map(x => x * DEG));
  if (!prev) return cands[0];
  let best = null, bestD = Infinity;
  for (let e of cands) {
    e = e.map((x, k) => prev[k] + wrap180(x - prev[k]));
    const d = e.reduce((s, x, k) => s + Math.abs(x - prev[k]), 0);
    if (d < bestD) { best = e; bestD = d; }
  }
  return best;
}
const lean = u => 0.7 * u * Math.cos(u / DEG / 2) ** 2;
function spinOf(frames, s) {
  const s0 = s.map(x => x - s[0]), last = s0[s0.length - 1], n = Math.round(last / 360);
  return s0.map((x, i) => x + (n * 360 - last) * frames[i] / Math.max(frames[frames.length - 1], 1));
}

// A somersault turned into a pirouette (a gown upside down is a bell). True if the clip had one.
function pirouette(clip, anim, ch, joints) {
  if (NO_PIROUETTE.some(w => clip.includes(w))) return false;
  const w = ch.jidx.jnt_waist, c = ch.jidx.center, L = lastKey(anim), frames = Array.from({ length: L + 1 }, (_, i) => i);
  const up0 = r3apply(r3T(rot3(ch.bind[w])), [0, 1, 0]);  // the gown's axis, in the waist's frame
  const measure = () => {
    const ups = [], Rc = [];
    for (const t of frames) {
      const loc = animLocalsDeg(anim, joints, t), W = worlds(joints, loc);
      ups.push(unit(r3apply(rot3(W[w]), up0))); Rc.push(rot3(loc[c]));
    }
    let k = [0, 0, 0];
    for (let i = 1; i < ups.length; i++) k = add(k, cross(ups[i - 1], ups[i]));
    if (norm(k) < 1e-6) return null;
    k = unit(k);
    const e1 = unit(sub([0, 1, 0], scale(k, k[1]))), e2 = cross(k, e1);
    let th = ups.map(u => Math.atan2(dot(u, e2), dot(u, e1)));
    for (let i = 1; i < th.length; i++) {
      while (th[i] - th[i - 1] > Math.PI) th[i] -= 2 * Math.PI;
      while (th[i] - th[i - 1] < -Math.PI) th[i] += 2 * Math.PI;
    }
    th = th.map(x => x * DEG);
    return { ups, Rc, k, th };
  };
  let m = measure();
  if (!m || Math.min(...m.ups.map(u => u[1])) > GOWN_INVERTED || Math.abs(m.k[1]) > 0.5) return false;
  dampLegs(anim, ch, PIROUETTE_DAMP);
  m = measure() || m;
  const sampled = axis => frames.map(t => j3d.sampleTrack(anim.joints[c][axis].rotation, t));
  const [rx, ry, rz] = [0, 1, 2].map(sampled), ptp = v => Math.max(...v) - Math.min(...v);
  if (ptp(rx) >= 170 && ptp(ry) < 20 && ptp(rz) < 20) {
    // the somersault is the root's own x turn: R = Ry(spin) Rx(lean)
    const l = rx.map(x => lean(wrap180(x))), spin = spinOf(frames, rx.map((x, i) => x - l[i]));
    setTrack(anim, c, 0, 'rotation', frames, l);
    setTrack(anim, c, 1, 'rotation', frames, ry.map((y, i) => y + spin[i]));
    return true;
  }
  // otherwise: the turn about k taken off the root and spun about the vertical instead
  const l = m.th.map(x => lean(wrap180(x))), spin = spinOf(frames, m.th.map((x, i) => x - l[i]));
  let prev = null;
  const out = frames.map((_, i) => (prev = euler(r3mul(r3mul(axisAngle([0, 1, 0], spin[i]), axisAngle(m.k, -(m.th[i] - l[i]))), m.Rc[i]), prev)));
  for (let axis = 0; axis < 3; axis++) setTrack(anim, c, axis, 'rotation', frames, out.map(e => e[axis]));
  return true;
}

// Wherever the gown would still tip past GOWN_INVERTED, the body turned back about its middle just far enough.
function clampGown(clip, anim, ch, joints) {
  if (NO_PIROUETTE.some(w => clip.includes(w))) return false;
  const w = ch.jidx.jnt_waist, c = ch.jidx.center, L = lastKey(anim), frames = Array.from({ length: L + 1 }, (_, i) => i);
  const up0 = r3apply(r3T(rot3(ch.bind[w])), [0, 1, 0]);
  const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let need = false;
  const fixes = frames.map(t => {
    const W = worlds(joints, animLocalsDeg(anim, joints, t)), g = unit(r3apply(rot3(W[w]), up0));
    if (g[1] >= GOWN_INVERTED) return I3;
    need = true;
    const flat = [g[0], 0, g[2]], hz = norm(flat) > 1e-6 ? unit(flat) : [0, 0, 1];
    const lim = GOWN_INVERTED + 0.02;
    return rotationBetween(g, add(scale(hz, Math.sqrt(1 - lim * lim)), [0, lim, 0]));
  });
  if (!need) return false;
  let prev = null;
  const out = frames.map((t, i) => {
    const loc = animLocalsDeg(anim, joints, t), P0 = rot3(loc[0]);
    return (prev = euler(r3mul(r3mul(r3mul(r3T(P0), fixes[i]), P0), rot3(loc[c])), prev));
  });
  for (let axis = 0; axis < 3; axis++) setTrack(anim, c, axis, 'rotation', frames, out.map(e => e[axis]));
  return true;
}

function gownAnimation(ch, body, clip, data, counts, legs = GOWN_LEGS) {
  const anim = write.decodeBck(data);
  dampLegs(anim, ch, legs);
  if (pirouette(clip, anim, ch, body.joints)) counts.pirouettes++;
  if (clampGown(clip, anim, ch, body.joints)) counts.clamped++;
  return write.encodeBck(anim);
}

// --- The whole conversion --------------------------------------------------------------

const BODY = 'bmd/ma_mdl1.bmd';
const PARTS = { l: ['ma_hnd2l', 'ma_hnd3l'], r: ['ma_hnd2r', 'ma_hnd3r', 'ma_hnd4r'] };

// The model's bones and their guessed labels, for the player to check before converting.
function analyze(glbData) {
  const glb = new Glb(glbData), model = readModel(glb);
  const { bones, labels } = guessLabels(glb, model);
  const depth = i => (model.parent[i] < 0 ? 0 : 1 + depth(model.parent[i]));
  // as a tree (each bone after its parent); bones under a hand, a foot or the head, and unlabelled
  // ends, are minor: the player rarely needs them
  const set = new Set(bones), order = [];
  const visit = i => { order.push(i); bones.filter(c => model.parent[c] === i).forEach(visit); };
  bones.filter(i => !set.has(model.parent[i])).forEach(visit);
  const under = (i, roles) => { for (let p = model.parent[i]; p >= 0; p = model.parent[p]) if (roles.some(r => (labels[p] || '').startsWith(r))) return true; return false; };
  return {
    bones: order.map(i => ({ node: i, name: model.names[i], depth: depth(i), label: labels[i],
      minor: !labels[i] && (under(i, ['hand', 'foot', 'head']) || !bones.some(c => model.parent[c] === i)) })),
    triangles: model.meshes.reduce((s, m) => s + m.tris.length / 3, 0),
    images: glb.json.images.length, vrm: model.vrm.size > 0,
  };
}

// images: decoded embedded images by index ({ width, height, rgba } or null); marioSzs: the disc's
// data/mario.szs. Returns the pack's model.szs.
// A model ({ parent, names, world, meshes, materials, vrm }) and a texture per material, made into the
// archive: gown (a long skirt hiding the legs) brings refine.py's gown handling: the hem following the
// thighs a little, the legs swinging less, somersaults as pirouettes, nothing tipping the gown over.
function convertModel({ model, textures, marioSzs, labels, height = 150, curl = 75, gown = false, progress = () => {}, inspect = null }) {
  const marioRaw = yaz0(marioSzs), files = rarc(marioRaw);
  const template = files.get(BODY), sms = j3d.parseBmd(template);
  const ch = new Character(model, labels, sms, height);
  if (gown) gown = { sway: GOWN_SWAY, legs: GOWN_LEGS, ...(gown === true ? {} : gown) };
  if (gown) swayGown(ch, gown.sway, gown.wide);
  const { atlas, rects } = buildAtlas(textures, new Set(model.meshes.map(m => m.material)));
  const uvOf = (mi, v) => {
    const m = ch.meshes[mi], [x, y, w, h] = rects.get(m.material);
    // a plain colour is sampled in its middle, whatever the mesh's own texture coordinates
    if (textures[m.material].plain) return [x + w / 2, y + h / 2];
    return [x + Math.max(0, Math.min(1, m.st[v * 2])) * w, y + Math.max(0, Math.min(1, m.st[v * 2 + 1])) * h];
  };
  const lists = classify(ch);
  const rest = ch.meshes.map(m => m.pos);

  progress('Curling the fingers into a fist');
  const marioFist = side => {
    const shape = sms.shapes[side === 'L' ? 5 : 6], tris = [];
    for (let t = 0; t < shape.index.length; t += 3) tris.push([shape.index[t], shape.index[t + 1], shape.index[t + 2]]);
    return surface(tris, i => Array.from(shape.position.subarray(i * 3, i * 3 + 3)));
  };
  const charFist = (positions, side) => {
    const M = ch.invBind[ch.jidx[`M_hand1_${side}`]];
    return surface(lists[side === 'L' ? 5 : 6].map(([mi, a, b, c]) => [[mi, a], [mi, b], [mi, c]]),
      ([mi, v]) => apply(M, Array.from(positions[mi].subarray(v * 3, v * 3 + 3))));
  };
  const best = {};
  for (const sign of [1, -1]) {
    const fist = ch.posedPositions({ L: curl * sign, R: curl * sign });
    for (const S of ['L', 'R']) {
      if (lists[S === 'L' ? 5 : 6].length < 8) continue;
      const [R, err] = fitHand(marioFist(S), charFist(fist, S));
      if (!best[S] || err < best[S].err) best[S] = { sign, R, err };
    }
  }
  const curls = { L: best.L ? curl * best.L.sign : 0, R: best.R ? curl * best.R.sign : 0 };
  for (const [S, { R }] of Object.entries(best)) ch.rotateHand(S, R);
  const fist = ch.posedPositions(curls);

  progress('Building the model');
  const out = {};
  out[BODY] = buildBody(ch, template, fist, lists, atlas, uvOf);
  for (const [side, names] of Object.entries(PARTS)) {
    const S = side.toUpperCase(), joint = ch.jidx[`jnt_hand_${S}`];
    // the model's own open hands where it has them (Peach), else its fist
    const open = [];
    ch.meshes.forEach((m, mi) => { if (m.part === 'open' && m.side === S) for (let t = 0; t < m.tris.length; t += 3) open.push([mi, m.tris[t], m.tris[t + 1], m.tris[t + 2]]); });
    for (const n of names) out[`bmd/${n}.bmd`] = buildPart(ch, files.get(`bmd/${n}.bmd`), rest, open.length ? open : lists[S === 'L' ? 5 : 6], joint, uvOf);
  }
  for (const n of ['ma_cap1', 'ma_cap3']) out[`bmd/${n}.bmd`] = buildPart(ch, files.get(`bmd/${n}.bmd`), rest, [], ch.jidx.M_head, uvOf);

  progress('Fitting Mario\'s animations');
  // the bodies posed frame by frame: the character's (as built) and Mario's, without his cap and Shine shirt
  const charVerts = [], total = ch.meshes.reduce((n, m) => n + m.weights.length, 0);
  ch.meshes.forEach((m, mi) => { if (m.part) return; const step = Math.max(1, Math.ceil(total / 20000)); for (let v = 0; v < m.weights.length; v += step) charVerts.push([Array.from(fist[mi].subarray(v * 3, v * 3 + 3)), m.sms[v]]); });
  const charJoints = sms.joints.map((j, i) => ({ ...j, translation: ch.newT[i] }));
  const body = posable(charJoints, ch.invBind, charVerts);
  const marioRest = worlds(sms.joints, sms.joints.map(j => jointLocal(j.scale, j.rotation, j.translation)));
  const marioVerts = [];
  sms.shapes.forEach((shape, s) => {
    if (s === 4 || s === 10) return;
    for (let v = 0; v < shape.drawIndex.length; v++) {
      const d = sms.draw[shape.drawIndex[v]], p = Array.from(shape.position.subarray(v * 3, v * 3 + 3));
      if (!d.weighted) marioVerts.push([apply(marioRest[d.index], p), [[d.index, 1]]]);
      else marioVerts.push([p, sms.envelopes[d.index].map(({ joint, weight }) => [joint, weight])]);
    }
  });
  const mario = posable(sms.joints, marioRest.map(inv), marioVerts);
  const hover = Math.max(0, body.minY - mario.minY);
  const names = [...files.keys()].filter(n => /^bck\/.*\.bck$/.test(n)).sort();
  const retargeted = new Map(), gowned = { pirouettes: 0, clamped: 0 };
  for (const n of names) {
    let r = retargetBck(ch, files.get(n));
    if (r && gown) r = gownAnimation(ch, body, n.slice(4, -4), r, gowned, gown.legs);
    if (r) retargeted.set(n, r);
  }
  // for checks (tools): the character, its posable body and the fitted animations
  if (inspect) inspect({ ch, body, retargeted, fist });
  let stand = 0;
  if (retargeted.has('bck/ma_wait.bck')) {
    const r = groundOffsets(body, j3d.parseBck(retargeted.get('bck/ma_wait.bck')), mario, j3d.parseBck(files.get('bck/ma_wait.bck')), hover);
    if (r) stand = r.off.reduce((s, o) => s + o[1], 0) / r.off.length;
  }
  let done = 0;
  for (const [n, data] of retargeted) {
    if (done++ % 20 === 0) progress(`Fitting Mario's animations (${done} of ${retargeted.size})`);
    const anim = j3d.parseBck(data), clip = n.slice(4, -4);
    let fit;
    if (noFloor(clip)) {
      const frames = Array.from({ length: lastFrame(anim) + 1 }, (_, i) => i);
      fit = { frames, off: frames.map(() => [0, stand, 0]), mdl1: frames.map(t => rot3(worlds(body.joints, animLocals(body, anim, t))[0])) };
    } else fit = groundOffsets(body, anim, mario, j3d.parseBck(files.get(n)), hover);
    out[n] = fit ? addCenterOffset(data, anim, ch.jidx.center, fit.frames, fit.off, fit.mdl1) : data;
  }

  progress('Packing the archive');
  return {
    model: write.repackRarc(marioRaw, out),
    summary: { posed: ch.posed, hands: Object.fromEntries(Object.entries(best).map(([S, b]) => [S, Math.round(angleOf(b.R))])),
      centerRatio: ch.centerRatio, atlas: [atlas.width, atlas.height], triangles: lists.reduce((s, l) => s + l.length, 0), animations: retargeted.size,
      ...(gown ? gowned : {}) },
  };
}

// A glTF model (.glb, .vrm) made into a character archive.
function convert({ glbData, images, marioSzs, labels, height = 150, curl = 75, progress = () => {} }) {
  progress('Reading the model');
  const glb = new Glb(glbData), model = readModel(glb);
  return convertModel({ model, textures: materialTextures(glb, model.materials, images), marioSzs, labels, height, curl, progress });
}

// A model of the game's own (.bmd) made into a character archive: its body, with part models fixed to its
// joints ({ data, joint, part: 'open' for an open hand, side }), labels by joint name, at its own size.
// tints: { material name: [dark, light] }, colours the game puts on a grey texture per character
// (TColorChangeInfo: a Toad's spots and vest), its dark parts the first and its light parts the second.
function convertSunshine({ body, parts = [], labels, marioSzs, gown = false, tints = {}, progress = () => {}, inspect = null }) {
  progress('Reading the model');
  const bmd = j3d.parseBmd(body), joints = bmd.joints;
  const world = worlds(joints, joints.map(j => jointLocal(j.scale, j.rotation, j.translation)));
  const names = joints.map(j => j.name), parent = joints.map(j => j.parent);
  const meshes = [], materials = [], textures = [];
  const add = (model, place, rigidJoint, extra = {}) => {
    const texOf = new Map();
    model.shapes.forEach(shape => {
      if (!shape.index.length) return;
      const material = model.materials[shape.material] || {}, tint = tints[material.name];
      // a tinted material gets a texture of its own
      const texIndex = material.textures ? material.textures[0] : undefined, texKey = tint ? `${texIndex}:${material.name}` : texIndex;
      const key = `${materials.length}:${texKey}`;
      if (!texOf.has(texKey)) {
        let t = model.textures[texIndex];
        // a part's placeholder texture is the body's, as the game sets it (H_peach_main_dummy: H_peach_main_s3tc)
        if (t && /_dummy$/.test(t.name)) t = bmd.textures.find(b => b.name.startsWith(t.name.replace(/_dummy$/, '_'))) || t;
        texOf.set(texKey, materials.length);
        materials.push(key);
        const image = t ? { width: t.width, height: t.height, rgba: Uint8Array.from(t.rgba, (v, i) => (i % 4 === 3 ? 255 : v)) } :
          { width: 16, height: 16, rgba: new Uint8Array(16 * 16 * 4).fill(255), plain: true };
        if (tint) for (let i = 0; i < image.rgba.length; i += 4) {
          const g = (image.rgba[i] + image.rgba[i + 1] + image.rgba[i + 2]) / 765;
          for (let c = 0; c < 3; c++) image.rgba[i + c] = Math.round(tint[0][c] + (tint[1][c] - tint[0][c]) * g);
        }
        textures.push(image);
      }
      const W = worlds(model.joints, model.joints.map(j => jointLocal(j.scale, j.rotation, j.translation)));
      const n = shape.drawIndex.length, pos = new Float64Array(n * 3), nrm = new Float64Array(n * 3), weights = new Array(n);
      for (let v = 0; v < n; v++) {
        const d = model.draw[shape.drawIndex[v]], p = Array.from(shape.position.subarray(v * 3, v * 3 + 3)), q = Array.from(shape.normal.subarray(v * 3, v * 3 + 3));
        // rigid vertices are in their joint's space, weighted ones in the model's
        const M = d.weighted ? place : mul(place, W[d.index]);
        pos.set(apply(M, p), v * 3);
        nrm.set(unit(r3apply(rot3(M), q)), v * 3);
        weights[v] = rigidJoint !== null ? new Map([[rigidJoint, 1]])
          : d.weighted ? new Map(model.envelopes[d.index].map(({ joint, weight }) => [joint, weight])) : new Map([[d.index, 1]]);
      }
      const tris = new Int32Array(shape.index.length);
      for (let t = 0; t < shape.index.length; t += 3) { tris[t] = shape.index[t]; tris[t + 1] = shape.index[t + 2]; tris[t + 2] = shape.index[t + 1]; }
      meshes.push({ name: material.name || 'shape', pos, nrm, st: Float64Array.from(shape.uv), weights, tris, material: texOf.get(texKey), ...extra });
    });
  };
  add(bmd, I4(), null);
  for (const part of parts) {
    const j = names.indexOf(part.joint);
    if (j < 0) throw new Error(`The model has no joint ${part.joint}.`);
    add(j3d.parseBmd(part.data), world[j], j, part.part ? { part: part.part, side: part.side } : {});
  }
  const byName = Object.fromEntries(Object.entries(labels).map(([name, label]) => [names.indexOf(name), label]).filter(([i]) => i >= 0));
  return convertModel({ model: { parent, names, world, meshes, materials, vrm: new Map() }, textures, marioSzs, labels: byName, height: null, gown, progress, inspect });
}

module.exports = { analyze, convert, convertSunshine, guessRole, ROLES, SIDED, worlds, jointLocal, mul, inv, apply };
