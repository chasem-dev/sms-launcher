// Portraits for the outfits: a character's own model, standing, head and shoulders, drawn off screen
// (Mario in an outfit's colours). characters-page.js keeps each as a PNG through main.js, so each is
// drawn once. Every character is on Mario's skeleton, so the head joint frames them all.
import * as THREE from '../node_modules/three/build/three.module.js';
import { createRig, jointMatrix } from './model-rig.js';

export const SIZE = 128;
const WRAP = [THREE.ClampToEdgeWrapping, THREE.RepeatWrapping, THREE.MirroredRepeatWrapping];
// Seen as the 3D views first show a character: from the front, a little to one side.
const YAW = 0.45, FOV = 24;

let renderer = null;
function canvasRenderer() {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(SIZE, SIZE, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
  }
  return renderer;
}

// Lets the GPU context go (nothing of the launcher's stays on the GPU while the game runs).
export function release() {
  renderer?.dispose();
  renderer?.forceContextLoss();
  renderer = null;
}

// A PNG data URL of `data` (a rig with toon and textures: character-model.js, or mario-model.js for
// Mario) in the first frame of `clip` ({ frames, values }, or null for its rest pose).
// `pixels(source)` gives a texture's RGBA (Mario's repainted), `visible(shape)` whether a shape is
// drawn, and `extras` are rigs hung from a joint of it ({ rig, joint }: Mario's sunglasses).
export function drawPortrait({ data, clip = null, pixels = source => new Uint8Array(source.rgba), visible = () => true, extras = [] }) {
  const scene = new THREE.Scene(), disposables = [];
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9fb4c0, 1.9));
  const sun = new THREE.DirectionalLight(0xffffff, 2.1);
  sun.position.set(-0.6 + Math.sin(YAW), 1.4, 1.6);
  scene.add(sun);

  const gradient = new THREE.DataTexture(Uint8Array.from(data.toon, v => Math.round(Math.max(v, 0.6) * 255)), data.toon.length, 1, THREE.RedFormat);
  gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
  gradient.needsUpdate = true;
  disposables.push(gradient);
  const textures = data.textures.map(source => {
    const texture = new THREE.DataTexture(pixels(source), source.width, source.height, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = WRAP[source.wrapS] || THREE.ClampToEdgeWrapping;
    texture.wrapT = WRAP[source.wrapT] || THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    disposables.push(texture);
    return texture;
  });
  const shown = [];
  const make = shape => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(shape.position.length), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(shape.normal.length), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(shape.uv, 2));
    if (shape.color) geometry.setAttribute('color', new THREE.BufferAttribute(shape.color, 4));
    geometry.setIndex(new THREE.BufferAttribute(shape.index, 1));
    const side = shape.doubleSided ? THREE.DoubleSide : THREE.FrontSide, map = shape.texture >= 0 ? textures[shape.texture] : null;
    // Shadow Mario's own colour unlit, with a light blue shine, as on the Character tab
    const material = shape.shine
      ? new THREE.MeshPhongMaterial({ color: 0x000000, emissive: 0xffffff, emissiveMap: map, specular: 0x9dc2ff, shininess: 24, side })
      : new THREE.MeshToonMaterial({ map, vertexColors: Boolean(shape.color), transparent: shape.translucent, depthWrite: !shape.translucent,
        alphaTest: shape.alphaTest || 0, gradientMap: gradient, side });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.visible = visible(shape);
    scene.add(mesh);
    disposables.push(geometry, material);
    if (mesh.visible) shown.push(geometry);
    return { shape, mesh, geometry };
  };

  const rig = createRig(data, make), local = new THREE.Matrix4();
  rig.pose(null, clip ? j => {
    const v = clip.values, o = j * 9;
    return jointMatrix([v[o], v[o + 1], v[o + 2]], [v[o + 3], v[o + 4], v[o + 5]], [v[o + 6], v[o + 7], v[o + 8]], local);
  } : null);
  for (const extra of extras) createRig(extra.rig, make).pose(rig.world[extra.joint]);

  // Head and shoulders: from the top of the head (cap, crown or hair) down to below the head joint by about
  // two thirds of the head's height again: the shoulders, for every character.
  const box = new THREE.Box3();
  for (const geometry of shown) { geometry.computeBoundingBox(); box.union(geometry.boundingBox); }
  const j = data.joints.findIndex(joint => joint.name === 'jnt_head');
  const head = j >= 0 ? new THREE.Vector3().setFromMatrixPosition(rig.world[j]) : new THREE.Vector3(0, box.max.y * 0.65, 0);
  const top = box.max.y, crown = Math.max(top - head.y, 1);
  const bottom = head.y - crown * 0.65, height = (top - bottom) * 1.16;
  const target = new THREE.Vector3(head.x, bottom + (top - bottom) * 0.53, head.z);
  const distance = height / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const camera = new THREE.PerspectiveCamera(FOV, 1, Math.max(distance / 50, 0.1), distance * 10);
  camera.position.set(target.x + Math.sin(YAW) * distance, target.y + distance * 0.04, target.z + Math.cos(YAW) * distance);
  camera.lookAt(target);

  const r = canvasRenderer();
  r.render(scene, camera);
  const url = r.domElement.toDataURL('image/png');
  for (const item of disposables) item.dispose();
  return url;
}
