// Posing the game's J3D models in three.js: shared by Customize Mario and the
// Characters page.
import * as THREE from '../node_modules/three/build/three.module.js';

// One posable model: its joints, CPU skinning, and its meshes.
export function createRig(rig, makeMesh) {
  const order = jointOrder(rig.joints);
  const world = rig.joints.map(() => new THREE.Matrix4());
  const rest = rig.joints.map(joint => jointMatrix(joint.scale, joint.rotation, joint.translation, new THREE.Matrix4()));
  const inverseBind = rig.inverseBind.map(m => new THREE.Matrix4().fromArray(m));
  const drawMatrices = rig.draw.map(() => new THREE.Matrix4()), product = new THREE.Matrix4();
  const meshes = rig.shapes.map(makeMesh);
  return {
    meshes, world, attach: rig.attach,
    setVisible(on) { for (const { mesh } of meshes) mesh.visible = on; },
    // `base` places the root (or null); `localOf(joint)` gives an animated
    // joint's local matrix (or null for the rest pose).
    pose(base, localOf = null) {
      for (const j of order) {
        const local = localOf ? localOf(j) : rest[j], parent = rig.joints[j].parent;
        if (parent >= 0) world[j].multiplyMatrices(world[parent], local);
        else if (base) world[j].multiplyMatrices(base, local);
        else world[j].copy(local);
      }
      rig.draw.forEach((entry, d) => {
        const out = drawMatrices[d];
        if (!entry.weighted) { out.copy(world[entry.index]); return; }
        out.elements.fill(0);
        for (const { joint, weight } of rig.envelopes[entry.index]) {
          product.multiplyMatrices(world[joint], inverseBind[joint]);
          for (let e = 0; e < 16; e++) out.elements[e] += product.elements[e] * weight;
        }
      });
      for (const { shape, mesh, geometry } of meshes) {
        if (!mesh.visible) continue;
        const position = geometry.attributes.position.array, normal = geometry.attributes.normal.array;
        for (let i = 0, n = shape.drawIndex.length; i < n; i++) {
          const m = drawMatrices[shape.drawIndex[i]].elements, o = i * 3;
          const x = shape.position[o], y = shape.position[o + 1], z = shape.position[o + 2];
          position[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
          position[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
          position[o + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
          const nx = shape.normal[o], ny = shape.normal[o + 1], nz = shape.normal[o + 2];
          const tx = m[0] * nx + m[4] * ny + m[8] * nz, ty = m[1] * nx + m[5] * ny + m[9] * nz, tz = m[2] * nx + m[6] * ny + m[10] * nz;
          const length = Math.hypot(tx, ty, tz) || 1;
          normal[o] = tx / length; normal[o + 1] = ty / length; normal[o + 2] = tz / length;
        }
        geometry.attributes.position.needsUpdate = true;
        geometry.attributes.normal.needsUpdate = true;
      }
    },
  };
}

// A joint's local matrix: scale, then rotation about X, Y and Z, then translation.
const euler = new THREE.Euler(), quaternion = new THREE.Quaternion(), vector = new THREE.Vector3(), scaling = new THREE.Vector3();
export function jointMatrix(scale, rotation, translation, out) {
  euler.set(rotation[0], rotation[1], rotation[2], 'ZYX');
  return out.compose(vector.set(translation[0], translation[1], translation[2]), quaternion.setFromEuler(euler), scaling.set(scale[0], scale[1], scale[2]));
}

// Joints ordered parents first.
function jointOrder(joints) {
  const order = [], seen = new Set();
  const visit = j => {
    if (seen.has(j)) return;
    if (joints[j].parent >= 0) visit(joints[j].parent);
    seen.add(j);
    order.push(j);
  };
  joints.forEach((_, j) => visit(j));
  return order;
}
