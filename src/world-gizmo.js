// The handles drawn on the selected object in the world editor, as 3D tools
// have them: an arrow for each axis (X red, Y green, Z blue) to slide it
// along, a square for each pair of axes to slide it across that plane, and a
// ring round it to turn it. They keep the same size on screen however far
// away the object is, and draw over everything so they're never hidden.
import * as THREE from '../node_modules/three/build/three.module.js';

const COLORS = { x: 0xe5484d, y: 0x46a758, z: 0x3e8ed0, yaw: 0xf0c43a };
const HOVER = 0xffffff;
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
// Planes are named by their two axes; they slide along both, not the third.
const PLANES = { xz: 'y', xy: 'z', yz: 'x' };
const PIXELS = 115;     // arrow length on screen
const RING = 1.32;      // ring radius, in arrow lengths
const MAX_STEP = 60000; // furthest one drag can carry, when an axis points at the camera

// Where along the line p0 + s·d the ray o + t·r passes closest: s, or null
// when they're parallel.
export function closestOnLine(p0, d, o, r) {
  const w0 = new THREE.Vector3().subVectors(p0, o);
  const a = d.dot(d), b = d.dot(r), c = r.dot(r), dw = d.dot(w0), rw = r.dot(w0);
  const denom = a * c - b * b;
  if (Math.abs(denom) < 1e-8) return null;
  return (b * rw - c * dw) / denom;
}

// Where the ray meets the plane through p0 with normal n, or null.
export function onPlane(p0, n, o, r) {
  const along = n.dot(r);
  if (Math.abs(along) < 1e-6) return null;
  const t = n.dot(new THREE.Vector3().subVectors(p0, o)) / along;
  return t > 0 ? o.clone().addScaledVector(r, t) : null;
}

// The turn about Y, in degrees, of a point seen from the centre (0 along +z),
// the way the game and three.js turn things.
export const turnOf = (center, point) => Math.atan2(point.x - center.x, point.z - center.z) * 180 / Math.PI;
const wrap = degrees => ((degrees % 360) + 540) % 360 - 180;

function label(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d');
  g.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffffff';
  g.font = 'bold 34px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 32, 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true }));
  sprite.scale.setScalar(0.24);
  return sprite;
}

export function createGizmo(camera, canvas) {
  const group = new THREE.Group();
  group.visible = false;
  group.renderOrder = 20;
  const handles = new Map();  // name -> { parts: [meshes], color, pick }
  const onTop = (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity, side: THREE.DoubleSide, toneMapped: false });
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  function addHandle(name, color, parts, pick) {
    for (const part of parts) { part.renderOrder = 20; group.add(part); }
    pick.userData.handle = name;
    group.add(pick);
    handles.set(name, { parts, color, pick });
  }

  // An arrow along each axis: a shaft, a head and a letter at the tip.
  for (const [name, axis] of Object.entries(AXES)) {
    const color = COLORS[name];
    const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.78, 8), onTop(color));
    shaft.position.copy(axis).multiplyScalar(0.11 + 0.39);
    shaft.quaternion.copy(turn);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.2, 16), onTop(color));
    head.position.copy(axis).multiplyScalar(0.9);
    head.quaternion.copy(turn);
    const letter = label(name.toUpperCase(), color);
    letter.position.copy(axis).multiplyScalar(1.14);
    const pick = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.15, 8), hidden);
    pick.position.copy(axis).multiplyScalar(0.11 + 0.575);
    pick.quaternion.copy(turn);
    addHandle(name, color, [shaft, head, letter], pick);
  }
  // A square between each pair of axes, coloured as the axis it doesn't move along.
  for (const [name, normal] of Object.entries(PLANES)) {
    const color = COLORS[normal];
    const [a, b] = name.split('').map(k => AXES[k]);
    const square = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.2), onTop(color, 0.55));
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(square.geometry), new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true }));
    const where = a.clone().add(b).multiplyScalar(0.32);
    const facing = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), AXES[normal]);
    for (const part of [square, edge]) { part.position.copy(where); part.quaternion.copy(facing); }
    const pick = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), hidden);
    pick.position.copy(where); pick.quaternion.copy(facing);
    addHandle(name, color, [square, edge], pick);
  }
  // The ring, flat round the object, to turn it.
  {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(RING, 0.02, 8, 96), onTop(COLORS.yaw));
    ring.rotation.x = Math.PI / 2;
    // Small notches round it, so a turn is easy to see.
    const ticks = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2, long = i % 6 === 0;
      const tick = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, long ? 0.12 : 0.06), onTop(COLORS.yaw, long ? 1 : 0.7));
      tick.position.set(Math.sin(a) * RING, 0, Math.cos(a) * RING);
      tick.rotation.y = a;
      ticks.push(tick);
    }
    const pick = new THREE.Mesh(new THREE.TorusGeometry(RING, 0.09, 6, 64), hidden);
    pick.rotation.x = Math.PI / 2;
    addHandle('yaw', COLORS.yaw, [ring, ...ticks], pick);
  }

  let hovered = null, active = null;
  // Arrows pointing at the camera and squares seen edge-on can't be dragged
  // sensibly, so they step aside until the view turns.
  const away = new Set();
  function paint() {
    for (const [name, { parts, color }] of handles) {
      const on = name === hovered || name === active;
      for (const part of parts) {
        part.visible = active ? name === active : !away.has(name);
        if (part.material.map) part.material.color.set(on ? 0xffffff : 0xdddddd);
        else part.material.color.set(on ? HOVER : color);
      }
    }
  }

  // The arrows' length in world units, for the same size on screen.
  function unit() {
    const distance = camera.position.distanceTo(group.position);
    const height = canvas.clientHeight || 600;
    return distance * 2 * Math.tan((camera.fov * Math.PI / 180) / 2) * (PIXELS / height);
  }

  const raycaster = new THREE.Raycaster();
  return {
    group,
    get visible() { return group.visible; },
    attach(position) { group.position.set(position[0], position[1], position[2]); group.visible = true; },
    detach() { group.visible = false; hovered = active = null; paint(); },
    // Each frame: keep the size on screen.
    update() {
      if (!group.visible) return;
      group.scale.setScalar(unit());
      group.updateMatrixWorld(true);
      const view = new THREE.Vector3().subVectors(group.position, camera.position).normalize();
      const before = [...away].join();
      away.clear();
      for (const [name, axis] of Object.entries(AXES)) if (Math.abs(axis.dot(view)) > 0.96) away.add(name);
      for (const [name, normal] of Object.entries(PLANES)) if (Math.abs(AXES[normal].dot(view)) < 0.2) away.add(name);
      if ([...away].join() !== before) paint();
    },
    // Which handle the ray is over, if any.
    hit(ray) {
      if (!group.visible) return null;
      group.scale.setScalar(unit());
      group.updateMatrixWorld(true);
      raycaster.ray.copy(ray);
      const hits = raycaster.intersectObjects([...handles].filter(([name]) => !away.has(name)).map(([, h]) => h.pick), false);
      // Squares before arrows before the ring, where they overlap.
      const order = name => (PLANES[name] ? 0 : AXES[name] ? 1 : 2);
      hits.sort((a, b) => order(a.object.userData.handle) - order(b.object.userData.handle) || a.distance - b.distance);
      return hits[0]?.object.userData.handle || null;
    },
    hover(name) { if (hovered !== name) { hovered = name; paint(); } },
    // A drag starts on a handle from the object's transform…
    begin(name, ray, transform) {
      active = name; paint();
      const center = new THREE.Vector3(...transform.position);
      const state = { name, center, transform: JSON.parse(JSON.stringify(transform)) };
      if (AXES[name]) state.from = closestOnLine(center, AXES[name], ray.origin, ray.direction);
      else if (PLANES[name]) state.from = onPlane(center, AXES[PLANES[name]], ray.origin, ray.direction);
      else { const p = onPlane(center, AXES.y, ray.origin, ray.direction); state.from = p && turnOf(center, p); }
      return state;
    },
    // …and each move gives the transform it makes, and what changed, to show:
    // { transform, text } (or null while the pointer is somewhere it can't use).
    drag(state, ray, { snap = false } = {}) {
      const t = JSON.parse(JSON.stringify(state.transform));
      const step = snap ? 50 : 1, round = v => Math.round(v / step) * step;
      const { name, center, from } = state;
      if (from == null) return null;
      if (AXES[name]) {
        const s = closestOnLine(center, AXES[name], ray.origin, ray.direction);
        if (s == null) return null;
        const delta = round(Math.max(-MAX_STEP, Math.min(MAX_STEP, s - from)));
        const i = 'xyz'.indexOf(name);
        t.position[i] = Math.round(state.transform.position[i] + delta);
        group.position.set(...t.position);
        return { transform: t, text: `${name.toUpperCase()} ${delta >= 0 ? '+' : ''}${delta}` };
      }
      if (PLANES[name]) {
        const p = onPlane(center, AXES[PLANES[name]], ray.origin, ray.direction);
        if (!p) return null;
        const delta = p.sub(from);
        if (delta.length() > MAX_STEP) delta.setLength(MAX_STEP);
        const moved = [];
        for (const k of name) {
          const i = 'xyz'.indexOf(k), d = round(delta.getComponent(i));
          t.position[i] = Math.round(state.transform.position[i] + d);
          moved.push(`${k.toUpperCase()} ${d >= 0 ? '+' : ''}${d}`);
        }
        group.position.set(...t.position);
        return { transform: t, text: moved.join('  ') };
      }
      const p = onPlane(center, AXES.y, ray.origin, ray.direction);
      if (!p) return null;
      const turn = wrap(turnOf(center, p) - from);
      const yaw = wrap(Math.round((state.transform.rotation[1] + turn) / (snap ? 15 : 1)) * (snap ? 15 : 1));
      t.rotation[1] = yaw;
      return { transform: t, text: `Turned to ${yaw}°` };
    },
    end() { active = null; paint(); },
    tip(name) {
      if (!name) return '';
      if (AXES[name]) return `Drag to move along ${name.toUpperCase()}${name === 'y' ? ' (up and down)' : ''}`;
      if (PLANES[name]) return name === 'xz' ? 'Drag to slide across the ground (X and Z)' : `Drag to move along ${name[0].toUpperCase()} and ${name[1].toUpperCase()}`;
      return 'Drag to turn';
    },
  };
}
