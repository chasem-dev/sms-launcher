'use strict';
// Mario's colour regions. Mario's clothes, skin and hair are painted into one
// texture atlas (and his eyes into their own textures), so each region is a
// set of texels: the launcher sorts the texels each part of the model uses by
// colour, and repaints a region with the chosen colour, keeping each texel as
// much lighter or darker than the region's typical shade as it was on the disc.
// The main process classifies (classify, blendEdges); the customizer repaints
// (recolor) every time a colour changes.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SmsMarioColors = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  // Seeds are a few shades of each region as they appear on the disc. `keep`
  // seeds catch texels that should never change (pupils, the whites of the eyes).
  const REGIONS = [
    { id: 'hat', label: 'Cap', seeds: [[214, 22, 28], [150, 10, 16], [240, 90, 90]] },
    { id: 'emblem', label: 'Cap emblem', seeds: [[246, 246, 246], [200, 200, 205]] },
    { id: 'emblemLetter', label: 'Cap letter', seeds: [] },
    { id: 'hair', label: 'Hair', seeds: [[96, 34, 26], [140, 64, 46], [60, 20, 14]] },
    { id: 'eyebrows', label: 'Eyebrows', seeds: [[96, 40, 32], [60, 24, 18], [150, 80, 60]] },
    { id: 'mustache', label: 'Mustache', seeds: [[22, 18, 18], [60, 50, 50], [6, 4, 4]] },
    { id: 'skin', label: 'Skin', seeds: [[252, 196, 156], [228, 156, 118], [255, 222, 190], [190, 120, 90]] },
    { id: 'eyes', label: 'Eyes', seeds: [[40, 120, 220], [70, 170, 240], [20, 50, 140], [16, 16, 60], [0, 0, 8], [128, 176, 208], [156, 172, 220]] },
    { id: 'shirt', label: 'Shirt', seeds: [[214, 22, 28], [150, 10, 16], [240, 90, 90]] },
    { id: 'overalls', label: 'Overalls', seeds: [[24, 64, 196], [12, 30, 120], [70, 110, 230]] },
    { id: 'buttons', label: 'Buttons', seeds: [[246, 232, 40], [200, 170, 10], [255, 255, 160]] },
    { id: 'gloves', label: 'Gloves', seeds: [[246, 246, 248], [200, 204, 214], [170, 176, 190]] },
    { id: 'shoes', label: 'Shoes', seeds: [[184, 104, 44], [124, 62, 24], [220, 150, 80]] },
    { id: 'alohaShirt', label: 'Shine shirt', seeds: [[130, 236, 255], [90, 200, 230], [190, 250, 255]] },
    // FLUDD's pack and nozzles share one texture of their own. (Its see-through
    // tank has no texture: its colours are the model's, so they stay.)
    { id: 'fluddBody', label: 'Body', seeds: [[246, 228, 56], [200, 170, 10], [255, 248, 150], [190, 110, 16], [205, 134, 24]] },
    { id: 'fluddMetal', label: 'Metal', seeds: [[196, 196, 212], [100, 100, 116], [148, 132, 148], [244, 244, 248], [60, 60, 72], [140, 118, 90], [123, 110, 62]] },
    { id: 'fluddStraps', label: 'Straps', seeds: [[132, 52, 4], [100, 50, 18], [160, 64, 10], [70, 30, 8]] },
    { id: 'fluddTrim', label: 'Trim', seeds: [[70, 70, 236], [36, 44, 170], [120, 120, 255]] },
  ];
  const KEEP = {
    white: [[250, 250, 255], [214, 226, 240]],
    shine: [[236, 184, 40], [160, 104, 20], [90, 60, 10], [255, 240, 120], [30, 20, 10]],
    dark: [[20, 20, 24], [0, 0, 0]],
  };

  // Which regions each part of the model can show. The same red is the cap on
  // the cap and the shirt on the body, so the part decides between them.
  const PARTS = {
    cap: ['hat', 'emblem'],
    head: ['skin', 'hair', 'mustache'],
    body: ['shirt', 'overalls', 'buttons', 'skin', 'gloves'],
    hands: ['gloves', 'shirt', 'skin'],
    feet: ['shoes'],
    eye: ['skin', 'eyebrows', 'eyes', 'keep:white'],
    mouth: ['skin'],
    // The Shine shirt Mario wears after he buys it, drawn over his shirt.
    aloha: ['alohaShirt', 'keep:shine'],
    // FLUDD: its pack, its nozzles and the straps that hold it on Mario.
    fludd: ['fluddBody', 'fluddMetal', 'fluddStraps', 'fluddTrim', 'keep:dark'],
  };
  const FLUDD_REGIONS = REGIONS.filter(region => PARTS.fludd.includes(region.id)).map(region => region.id);

  const PRESETS = [
    { id: 'classic', label: 'Classic', colors: {} },
    { id: 'luigi', label: 'Luigi', colors: { hat: '#2fa846', shirt: '#2fa846', emblemLetter: '#2fa846', overalls: '#21338c', shoes: '#7a4a24' } },
    { id: 'wario', label: 'Wario', colors: { hat: '#f2cc22', shirt: '#f2cc22', emblemLetter: '#2a52c8', overalls: '#7b2c9c', shoes: '#2f8f3a', buttons: '#2a52c8' } },
    { id: 'waluigi', label: 'Waluigi', colors: { hat: '#6a2c9e', shirt: '#6a2c9e', emblemLetter: '#f2cc22', overalls: '#23264f', shoes: '#e2741c' } },
    { id: 'fire', label: 'Fire Mario', colors: { hat: '#f4f4f4', shirt: '#f4f4f4', overalls: '#d8261d', emblemLetter: '#d8261d' } },
    { id: 'shadow', label: 'Shadow Mario', colors: { hat: '#1d2f7a', shirt: '#1d2f7a', emblem: '#3b55b8', emblemLetter: '#1d2f7a', overalls: '#14215c', buttons: '#3b55b8', gloves: '#2b45a8', shoes: '#14215c', skin: '#3150c0', hair: '#0e1a4a', eyebrows: '#0e1a4a', mustache: '#0e1a4a', eyes: '#ff3a2a' } },
    { id: 'gold', label: 'Gold', colors: { hat: '#e8b923', shirt: '#e8b923', emblem: '#fff2b0', emblemLetter: '#e8b923', overalls: '#c99a12', buttons: '#fff2b0', gloves: '#fff2b0', shoes: '#a87a10', skin: '#f0c850', hair: '#8a6400', eyebrows: '#8a6400', mustache: '#6a4c00' } },
  ];

  // FLUDD's own presets: they change only FLUDD's colours, and Mario's presets
  // only Mario's.
  const FLUDD_PRESETS = [
    { id: 'classic', label: 'Classic', colors: {} },
    { id: 'gold', label: 'Gold', colors: { fluddBody: '#e8b923', fluddMetal: '#f0d36a', fluddStraps: '#8a6400', fluddTrim: '#fff2b0' } },
    { id: 'midnight', label: 'Midnight', colors: { fluddBody: '#2b2f45', fluddMetal: '#6e7896', fluddStraps: '#1a1a22', fluddTrim: '#ff3a2a' } },
    { id: 'coral', label: 'Coral', colors: { fluddBody: '#ff7a6b', fluddMetal: '#f4ecea', fluddStraps: '#3b6fb6', fluddTrim: '#2fc4b2' } },
  ];

  // CIE Lab, with lightness counted at half weight so shading within a region
  // matters less than its hue.
  // sRGB 0-255 to linear light, for every value.
  const LINEAR = Float64Array.from({ length: 256 }, (_, v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  const lin = v => LINEAR[Math.max(0, Math.min(255, Math.round(v)))];
  function lab([r, g, b]) {
    const R = lin(r), G = lin(g), B = lin(b);
    const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
    const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }
  function distance(a, b) { return ((a[0] - b[0]) * 0.5) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2; }
  function rgbFromLab([L, a, b]) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const inv = t => t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787;
    const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
    const gamma = v => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
    return [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z]
      .map(v => Math.max(0, Math.min(255, Math.round(gamma(Math.max(0, v))))));
  }

  // Each texel's CIE lightness (0-100), stored as 0-255.
  function lightness(rgba) {
    const out = new Uint8Array(rgba.length / 4);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(lab([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]])[0] * 2.55);
    return out;
  }

  // Which texels a part's triangles cover, grown by a texel so filtering at
  // the edges reads classified texels. Beyond the texture's edges texels clamp
  // (GX wrap 0, as all of Mario's do), repeat (1) or mirror (2).
  function coverage(width, height, uv, index, out = new Uint8Array(width * height), wrapS = 0, wrapT = 0) {
    const address = (v, size, wrap) => wrap === 1 ? ((v % size) + size) % size
      : wrap === 2 ? (() => { const m = ((v % (2 * size)) + 2 * size) % (2 * size); return m < size ? m : 2 * size - 1 - m; })()
        : v >= 0 && v < size ? v : -1;
    for (let t = 0; t < index.length; t += 3) {
      const p = [0, 1, 2].map(k => [uv[index[t + k] * 2] * width - 0.5, uv[index[t + k] * 2 + 1] * height - 0.5]);
      const minX = Math.floor(Math.min(p[0][0], p[1][0], p[2][0])) - 1, maxX = Math.ceil(Math.max(p[0][0], p[1][0], p[2][0])) + 1;
      const minY = Math.floor(Math.min(p[0][1], p[1][1], p[2][1])) - 1, maxY = Math.ceil(Math.max(p[0][1], p[1][1], p[2][1])) + 1;
      if (maxX - minX > width * 2 || maxY - minY > height * 2) continue;
      // Signed distance (in texels) from each edge, positive inside; texels within a texel of the triangle count.
      const edges = [0, 1, 2].map(k => {
        const [ax, ay] = p[k], [bx, by] = p[(k + 1) % 3], length = Math.hypot(bx - ax, by - ay) || 1;
        return { ax, ay, nx: -(by - ay) / length, ny: (bx - ax) / length };
      });
      const flip = (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]) < 0 ? -1 : 1;
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        if (!edges.every(e => ((x - e.ax) * e.nx + (y - e.ay) * e.ny) * flip >= -1)) continue;
        const tx = address(x, width, wrapS), ty = address(y, height, wrapT);
        if (tx >= 0 && ty >= 0) out[ty * width + tx] = 1;
      }
    }
    return out;
  }

  // For one part: a region index (into REGIONS, or 255 to leave as is) per texel.
  function classify(rgba, width, height, part, covered) {
    const allowed = PARTS[part].map(name => {
      if (name.startsWith('keep:')) return { region: 255, seeds: KEEP[name.slice(5)].map(lab) };
      const region = REGIONS.findIndex(r => r.id === name);
      return { region, seeds: REGIONS[region].seeds.map(lab) };
    });
    const mask = new Uint8Array(width * height).fill(255);
    for (let i = 0; i < width * height; i++) {
      if (covered && !covered[i]) continue;
      if (rgba[i * 4 + 3] < 8) continue;
      const c = lab([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]);
      let best = 255, bestDistance = Infinity;
      for (const { region, seeds } of allowed) for (const seed of seeds) {
        const d = distance(c, seed);
        if (d < bestDistance) { bestDistance = d; best = region; }
      }
      mask[i] = best;
    }
    if (part === 'cap') splitEmblem(mask, width, height);
    return mask;
  }

  // The cap's letter is the cap's red that the white emblem encloses: inside the
  // box around the largest patch of emblem white, but not reachable without
  // crossing that white from where the cap's red runs out of the box. (The
  // emblem is half a circle on the disc, mirrored on the cap, so the letter
  // touches the box where the texture ends.)
  function splitEmblem(mask, width, height) {
    const emblem = REGIONS.findIndex(r => r.id === 'emblem'), hat = REGIONS.findIndex(r => r.id === 'hat');
    const letter = REGIONS.findIndex(r => r.id === 'emblemLetter');
    const flood = (starts, within, seen = new Uint8Array(mask.length)) => {
      const stack = starts.filter(i => within(i) && !seen[i]);
      for (const i of stack) seen[i] = 1;
      const cells = [];
      while (stack.length) {
        const i = stack.pop(), x = i % width, y = (i / width) | 0;
        cells.push(i);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy, n = ny * width + nx;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height && !seen[n] && within(n)) { seen[n] = 1; stack.push(n); }
        }
      }
      return { cells, seen };
    };
    const seen = new Uint8Array(mask.length);
    let best = null;
    for (let start = 0; start < mask.length; start++) {
      if (mask[start] !== emblem || seen[start]) continue;
      const { cells } = flood([start], i => mask[i] === emblem, seen);
      if (!best || cells.length > best.length) best = cells;
    }
    if (!best) return;
    let minX = width, minY = height, maxX = 0, maxY = 0;
    for (const i of best) {
      const x = i % width, y = (i / width) | 0;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const inBox = i => { const x = i % width, y = (i / width) | 0; return x >= minX && x <= maxX && y >= minY && y <= maxY; };
    const edge = [], runsOut = (x, y, dx, dy) => {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
      if (mask[y * width + x] === hat && mask[ny * width + nx] === hat) edge.push(y * width + x);
    };
    for (let x = minX; x <= maxX; x++) { runsOut(x, minY, 0, -1); runsOut(x, maxY, 0, 1); }
    for (let y = minY; y <= maxY; y++) { runsOut(minX, y, -1, 0); runsOut(maxX, y, 1, 0); }
    const outside = flood(edge, i => inBox(i) && mask[i] !== emblem).seen;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const i = y * width + x;
      if (mask[i] === hat && !outside[i]) mask[i] = letter;
    }
  }

  // Each region's typical colour on the disc: the texel of median lightness
  // across every part, as #rrggbb, with that lightness (0-100).
  function references(textures) {
    return REGIONS.map((_, region) => {
      const samples = [];
      for (const { rgba, mask, lightness: light } of textures) for (let i = 0; i < mask.length; i++)
        if (mask[i] === region) samples.push([light[i], i, rgba]);
      if (!samples.length) return null;
      samples.sort((a, b) => a[0] - b[0]);
      const [level, i, rgba] = samples[samples.length >> 1];
      return { color: hex([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]), lightness: level / 2.55 };
    });
  }

  // Texels on a border between two regions are a blend of both on the disc. For
  // each, the neighbouring region it blends with (`second`) and how much (`mix`,
  // 0-255), from where its colour lies between the two regions' typical colours.
  function blendEdges(texture, refs) {
    const { rgba, mask, width, height } = texture;
    const second = new Uint8Array(mask.length).fill(255), mix = new Uint8Array(mask.length);
    const refLab = refs.map(ref => ref && lab([1, 3, 5].map(k => parseInt(ref.color.slice(k, k + 2), 16))));
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x, own = mask[i];
      if (own === 255 || !refLab[own]) continue;
      const c = lab([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]), A = refLab[own];
      let best = null;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const other = mask[ny * width + nx];
        if (other === own || other === 255 || !refLab[other]) continue;
        const B = refLab[other], ab = [B[1] - A[1], B[2] - A[2]], length2 = ab[0] ** 2 + ab[1] ** 2;
        if (length2 < 100) continue;  // too alike in hue to tell apart, like the cap and its letter
        const t = Math.max(0, Math.min(1, ((c[1] - A[1]) * ab[0] + (c[2] - A[2]) * ab[1]) / length2));
        const off = (c[1] - A[1] - ab[0] * t) ** 2 + (c[2] - A[2] - ab[1] * t) ** 2;
        if (!best || off < best.off) best = { other, t, off };
      }
      if (best && best.t > 0.04) { second[i] = best.other; mix[i] = Math.round(best.t * 255); }
    }
    return { second, mix };
  }

  // A region's colour for every original lightness: darker texels keep their
  // share of the region's typical lightness, lighter ones move as far towards
  // white as they were.
  function ramp(color, reference) {
    const [L, a, b] = lab(color), out = new Uint8Array(256 * 3);
    for (let q = 0; q < 256; q++) {
      const level = q / 2.55;
      let shade;
      if (level <= reference) {
        const k = (level + 10) / (reference + 10);
        shade = [L * k, a * k, b * k];
      } else {
        const u = Math.min(1, (level - reference) / Math.max(1, 100 - reference));
        shade = [L + (100 - L) * u, a * (1 - u), b * (1 - u)];
      }
      out.set(rgbFromLab(shade), q * 3);
    }
    return out;
  }

  const hex = rgb => `#${rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const rgbOf = value => /^#[0-9a-f]{6}$/i.test(value) ? [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)) : null;

  // Repaints a texture into `out` with the chosen colours (region id -> #rrggbb).
  // Regions without a choice keep the disc's texels, except where they blend
  // into a repainted neighbour.
  function recolor(texture, refs, colors, out = new Uint8ClampedArray(texture.rgba.length)) {
    const { rgba, mask, second, mix, lightness: light } = texture;
    out.set(rgba);
    const chosen = REGIONS.map((region, i) => Boolean(refs[i] && rgbOf(colors[region.id])));
    if (!chosen.some(Boolean)) return out;
    const ramps = REGIONS.map((region, i) => refs[i] && ramp(rgbOf(colors[region.id]) || rgbOf(refs[i].color), refs[i].lightness));
    for (let i = 0; i < mask.length; i++) {
      const r1 = mask[i], r2 = second[i];
      if (!chosen[r1] && !chosen[r2]) continue;
      const o = i * 4, q = light[i] * 3, w = mix[i] / 255;
      for (let c = 0; c < 3; c++) {
        const one = ramps[r1] ? ramps[r1][q + c] : rgba[o + c];
        const two = r2 !== 255 && ramps[r2] ? ramps[r2][q + c] : rgba[o + c];
        out[o + c] = one + (two - one) * w;
      }
    }
    return out;
  }

  // Keeps only real regions with #rrggbb colours.
  function normalize(colors) {
    const out = {};
    if (colors && typeof colors === 'object') for (const { id } of REGIONS)
      if (rgbOf(colors[id])) out[id] = colors[id].toLowerCase();
    return out;
  }

  // FLUDD's nozzles, as the customizer can show them on Mario's back.
  const NOZZLES = [
    { id: 'spray', label: 'Spray' }, { id: 'hover', label: 'Hover' },
    { id: 'rocket', label: 'Rocket' }, { id: 'turbo', label: 'Turbo' },
  ];

  // The saved look: chosen colours, whether the game uses them (on unless
  // turned off), whether Mario always wears his Shine shirt and his
  // sunglasses (here and in the game), and whether he wears FLUDD here and
  // with which nozzle.
  function normalizeLook(look) {
    return {
      colors: normalize(look?.colors), inGame: look?.inGame !== false,
      aloha: look?.aloha === true, sunglasses: look?.sunglasses === true, fludd: look?.fludd === true,
      nozzle: NOZZLES.some(n => n.id === look?.nozzle) ? look.nozzle : 'spray',
    };
  }

  // The player's own saved looks: SLOTS places, each empty (null) or a name
  // and a look. A saved look is everything but Use in the game, which stays
  // one switch for whichever look Mario wears.
  const SLOTS = 6, SLOT_NAME_LENGTH = 24;
  function slotLook(look) {
    const { inGame: _, ...rest } = normalizeLook(look);
    return rest;
  }
  function normalizeSlots(slots) {
    return Array.from({ length: SLOTS }, (_, index) => {
      const slot = Array.isArray(slots) ? slots[index] : null;
      if (!slot || typeof slot !== 'object' || !slot.look || typeof slot.look !== 'object') return null;
      const name = typeof slot.name === 'string' ? slot.name.trim().slice(0, SLOT_NAME_LENGTH) : '';
      return { name: name || `Look ${index + 1}`, look: slotLook(slot.look) };
    });
  }
  // Whether `look` is the saved look `saved` (its colours, outfit and FLUDD).
  function sameLook(look, saved) {
    const a = slotLook(look), b = slotLook(saved);
    const keys = Object.keys(a.colors);
    return keys.length === Object.keys(b.colors).length && keys.every(id => a.colors[id] === b.colors[id])
      && ['aloha', 'sunglasses', 'fludd', 'nozzle'].every(key => a[key] === b[key]);
  }

  return { REGIONS, PARTS, PRESETS, FLUDD_REGIONS, FLUDD_PRESETS, NOZZLES, SLOTS, SLOT_NAME_LENGTH, coverage, classify, lightness, references, blendEdges, ramp, recolor, normalize, normalizeLook, normalizeSlots, slotLook, sameLook, hex };
});
