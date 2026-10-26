// Geometry core: STL I/O, joint cutters, grid splitting and bed-fit checks.
// Works in the browser and in Node (pass in an initialised manifold-3d module).

const PAD = 1000;      // how far cut regions extend past the model, mm
const EPS = 0.01;      // overlap so joint shapes fuse cleanly with the base region

// ---------------------------------------------------------------- STL I/O

export function parseSTL(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length >= 84) {
    const n = view.getUint32(80, true);
    if (84 + n * 50 === bytes.length) return parseBinary(view, n);
  }
  const text = new TextDecoder().decode(bytes);
  if (/^\s*solid/.test(text) && /facet/.test(text)) return parseASCII(text);
  if (bytes.length >= 84) return parseBinary(view, view.getUint32(80, true));
  throw new Error('Not a valid STL file');
}

function parseBinary(view, n) {
  const pos = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k++) pos[i * 9 + k] = view.getFloat32(o + k * 4, true);
  }
  return pos;
}

function parseASCII(text) {
  const out = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  let m;
  while ((m = re.exec(text))) out.push(+m[1], +m[2], +m[3]);
  if (!out.length || out.length % 9) throw new Error('Could not read ASCII STL');
  return new Float32Array(out);
}

export function writeSTL(mesh) {
  const { vertProperties: vp, triVerts: tv, numProp } = mesh;
  const n = tv.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const header = 'plate-splitter';
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
  dv.setUint32(80, n, true);
  for (let i = 0; i < n; i++) {
    const p = [0, 1, 2].map(k => {
      const v = tv[i * 3 + k] * numProp;
      return [vp[v], vp[v + 1], vp[v + 2]];
    });
    const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
    const wx = p[2][0] - p[0][0], wy = p[2][1] - p[0][1], wz = p[2][2] - p[0][2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    const o = 84 + i * 50;
    dv.setFloat32(o, nx / len, true);
    dv.setFloat32(o + 4, ny / len, true);
    dv.setFloat32(o + 8, nz / len, true);
    for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) {
      dv.setFloat32(o + 12 + k * 12 + j * 4, p[k][j], true);
    }
  }
  return buf;
}

// Weld a triangle soup into an indexed mesh and build a Manifold from it.
export function soupToManifold(wasm, pos, upAxis = 'z') {
  const { Manifold, Mesh } = wasm;
  for (const tol of [1e-4, 1e-3, 1e-2]) {
    const map = new Map(), verts = [], tris = new Uint32Array(pos.length / 3);
    const q = 1 / tol;
    for (let i = 0; i < tris.length; i++) {
      let x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (upAxis === 'y') [y, z] = [-z, y];
      else if (upAxis === 'x') [x, z] = [-z, x];
      const key = Math.round(x * q) + ',' + Math.round(y * q) + ',' + Math.round(z * q);
      let id = map.get(key);
      if (id === undefined) { id = verts.length / 3; map.set(key, id); verts.push(x, y, z); }
      tris[i] = id;
    }
    // drop triangles that collapsed during welding
    const kept = [];
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i], b = tris[i + 1], c = tris[i + 2];
      if (a !== b && b !== c && a !== c) kept.push(a, b, c);
    }
    const mesh = new Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: new Uint32Array(kept) });
    mesh.merge();
    try {
      const m = new Manifold(mesh);
      if (m.status() === 'NoError' && !m.isEmpty()) return m;
      m.delete();
    } catch (e) { /* try a looser weld */ }
  }
  throw new Error('This STL is not a closed (watertight) solid. Repair it in your slicer or Meshmixer and try again.');
}

// ---------------------------------------------------------------- helpers

// Tracks WASM objects so a whole computation can be freed in one go.
export class Arena {
  constructor() { this.items = []; }
  k(o) { this.items.push(o); return o; }
  free() { for (const o of this.items) { try { o.delete(); } catch (e) { /* already freed */ } } this.items = []; }
}

// Points are built in (across, along) cut space; map them to model XY.
function toXY(axis, across, along) { return axis === 'x' ? [across, along] : [along, across]; }

// How far a joint reaches across the cut line. Knobs need room for the round head.
export function jointDepth(j) {
  if (j.style === 'none') return 0;
  if (j.style === 'knob') return Math.max(j.depth, j.head * 1.15);
  return j.depth;
}

function poly(wasm, A, pts) { return A.k(new wasm.CrossSection([pts], 'NonZero')); }

// One joint shape (in model XY), pointing from the low side to the high side
// when dir = +1. `t` is the position along the cut line.
function jointShape(wasm, A, cut, t, dir, j) {
  const c = cut.pos;
  const hn = j.neck / 2, hh = j.head / 2, d = jointDepth(j) * dir;
  const P = (u, v) => toXY(cut.axis, c + u, t + v);
  if (j.style === 'knob') {
    const r = hh;
    const cx = c + d - r * dir;
    const neck = poly(wasm, A, [P(-EPS * dir, -hn), P(d - r * dir, -hn), P(d - r * dir, hn), P(-EPS * dir, hn)]);
    const [x, y] = toXY(cut.axis, cx, t);
    const circ = A.k(A.k(wasm.CrossSection.circle(r, 48)).translate([x, y]));
    return A.k(neck.add(circ));
  }
  // dovetail
  return poly(wasm, A, [P(-EPS * dir, -hn), P(d, -hh), P(d, hh), P(-EPS * dir, hn)]);
}

// Butterfly/bowtie key centred on the cut line.
function keyShape(wasm, A, cut, t, j) {
  const hn = j.neck / 2, hh = j.head / 2, d = j.depth;
  const P = (u, v) => toXY(cut.axis, cut.pos + u, t + v);
  return poly(wasm, A, [P(-d, -hh), P(0, -hn), P(d, -hh), P(d, hh), P(0, hn), P(-d, hh)]);
}

// Outline polygons of a single joint, for drawing in the plan view.
export function jointOutline(wasm, A, cut, tab, j) {
  if (j.style === 'none') return [];
  const s = j.style === 'butterfly'
    ? keyShape(wasm, A, cut, tab.t, j)
    : jointShape(wasm, A, cut, tab.t, tab.flip ? -1 : 1, j);
  return s.toPolygons();
}

function roundCorners(A, cs, r) {
  if (r <= 0) return cs;
  // opening then closing: rounds convex and concave corners alike
  const open = A.k(A.k(cs.offset(-r, 'Round', 2, 32)).offset(r, 'Round', 2, 32));
  return A.k(A.k(open.offset(r, 'Round', 2, 32)).offset(-r, 'Round', 2, 32));
}

// Region on the low side (smaller x / smaller y) of a cut, joints included.
export function lowRegion(wasm, A, cut, bounds, j) {
  const lo = [bounds.min[0] - PAD, bounds.min[1] - PAD], hi = [bounds.max[0] + PAD, bounds.max[1] + PAD];
  const rect = cut.axis === 'x'
    ? [[lo[0], lo[1]], [cut.pos, lo[1]], [cut.pos, hi[1]], [lo[0], hi[1]]]
    : [[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], cut.pos], [lo[0], cut.pos]];
  let region = poly(wasm, A, rect);
  if (j.style === 'dovetail' || j.style === 'knob') {
    for (const tab of cut.tabs) {
      const dir = tab.flip ? -1 : 1;
      const s = jointShape(wasm, A, cut, tab.t, dir, j);
      region = A.k(dir > 0 ? region.add(s) : region.subtract(s));
    }
    region = roundCorners(A, region, j.radius);
  }
  return region;
}

function bigRect(wasm, A, bounds) {
  const lo = [bounds.min[0] - PAD * 2, bounds.min[1] - PAD * 2], hi = [bounds.max[0] + PAD * 2, bounds.max[1] + PAD * 2];
  return poly(wasm, A, [[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]]);
}

// ---------------------------------------------------------------- layout

const COL_NAMES = { 1: [''], 2: ['left', 'right'], 3: ['left', 'center', 'right'] };
const ROW_NAMES = { 1: [''], 2: ['lower', 'upper'], 3: ['lower', 'middle', 'upper'] };

function names(n, table, prefix) {
  return table[n] || Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);
}

export function pieceName(col, row, nCols, nRows) {
  const c = names(nCols, COL_NAMES, 'col')[col];
  const r = names(nRows, ROW_NAMES, 'row')[row];
  return [r, c].filter(Boolean).join('_') || 'whole';
}

// 2D region for every piece of the grid (clearance already applied).
export function pieceRegions(wasm, A, cuts, bounds, j) {
  const xs = cuts.filter(c => c.axis === 'x').sort((a, b) => a.pos - b.pos);
  const ys = cuts.filter(c => c.axis === 'y').sort((a, b) => a.pos - b.pos);
  const big = bigRect(wasm, A, bounds);
  const half = Math.max(0, j.clearance) / 2;
  const band = (list) => {
    const lows = list.map(c => lowRegion(wasm, A, c, bounds, j));
    const bands = [];
    for (let i = 0; i <= list.length; i++) {
      let r = big;
      if (i > 0) r = A.k(r.subtract(A.k(lows[i - 1].offset(half, 'Miter', 2))));
      if (i < list.length) r = A.k(r.intersect(A.k(lows[i].offset(-half, 'Miter', 2))));
      bands.push(r);
    }
    return bands;
  };
  const cols = band(xs), rows = band(ys);
  const out = [];
  for (let r = rows.length - 1; r >= 0; r--) {
    for (let c = 0; c < cols.length; c++) {
      out.push({ col: c, row: r, name: pieceName(c, r, cols.length, rows.length), region: A.k(cols[c].intersect(rows[r])) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- tab placement

function tabZone(wasm, A, cut, t, j) {
  const across = jointDepth(j) + j.wall;
  const along = (j.style === 'none' ? 0 : j.head / 2) + j.wall;
  const P = (u, v) => toXY(cut.axis, cut.pos + u, t + v);
  return poly(wasm, A, [P(-across, -along), P(across, -along), P(across, along), P(-across, along)]);
}

// Is a joint at position t on this cut fully backed by material and clear of other cuts?
export function tabValid(wasm, A, footprint, cuts, cut, t, j) {
  const reach = j.head / 2 + j.wall;
  for (const o of cuts) {
    if (o === cut) continue;
    if (o.axis === cut.axis) continue;
    if (Math.abs(o.pos - t) < reach + jointDepth(j) + j.clearance) return false;
  }
  for (const o of cuts) {
    if (o === cut || o.axis !== cut.axis) continue;
    if (Math.abs(o.pos - cut.pos) < 2 * jointDepth(j) + j.wall) return false;
  }
  const zone = tabZone(wasm, A, cut, t, j);
  const outside = A.k(zone.subtract(footprint));
  return outside.area() < 0.05;
}

// Intervals along the cut where a joint centre is valid (sampled).
export function validIntervals(wasm, A, footprint, cuts, cut, j, bounds) {
  const [a, b] = cut.axis === 'x' ? [bounds.min[1], bounds.max[1]] : [bounds.min[0], bounds.max[0]];
  const step = Math.max(0.5, (b - a) / 400);
  const out = [];
  let start = null, last = null;
  for (let t = a; t <= b + 1e-9; t += step) {
    if (tabValid(wasm, A, footprint, cuts, cut, t, j)) { if (start === null) start = t; last = t; }
    else if (start !== null) { out.push([start, last]); start = null; }
  }
  if (start !== null) out.push([start, last]);
  return out;
}

// Spread `count` joints over the valid intervals: every interval gets one first
// (each stretch of a cut between crossings must be held), the rest by length.
export function autoTabs(intervals, count, alternate, j) {
  if (!intervals.length || count <= 0) return [];
  const pitch = j.head + j.wall * 2;
  const cap = intervals.map(([a, b]) => Math.floor((b - a) / pitch) + 1);
  const alloc = intervals.map(() => 0);
  let left = count;
  const byLen = intervals.map((iv, i) => i).sort((p, q) => (intervals[q][1] - intervals[q][0]) - (intervals[p][1] - intervals[p][0]));
  for (const i of byLen) if (left > 0) { alloc[i]++; left--; }
  while (left > 0) {
    // give the next joint to the interval with the most length per joint
    let best = -1, bestGap = 0;
    intervals.forEach(([a, b], i) => {
      if (alloc[i] >= cap[i]) return;
      const gap = (b - a) / (alloc[i] + 1);
      if (gap > bestGap) { bestGap = gap; best = i; }
    });
    if (best < 0) break;
    alloc[best]++; left--;
  }
  const tabs = [];
  intervals.forEach(([a, b], i) => {
    const k = alloc[i];
    for (let n = 0; n < k; n++) tabs.push({ t: k === 1 ? (a + b) / 2 : a + (b - a) * (n + 0.5) / k });
  });
  tabs.sort((p, q) => p.t - q.t);
  tabs.forEach((tab, i) => { tab.flip = alternate ? i % 2 === 1 : false; });
  return tabs;
}

export function defaultTabCount(intervals) {
  return intervals.reduce((s, [a, b]) => s + Math.max(1, Math.ceil((b - a) / 60)), 0);
}

// ---------------------------------------------------------------- bed fit

// Smallest-footprint orientation that fits the bed. Returns {fits, angle, w, h}.
export function bedFit(points, bedW, bedH) {
  if (!points.length) return { fits: true, angle: 0, w: 0, h: 0 };
  const dims = (deg) => {
    const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of points) {
      const u = x * c - y * s, v = x * s + y * c;
      if (u < x0) x0 = u; if (u > x1) x1 = u; if (v < y0) y0 = v; if (v > y1) y1 = v;
    }
    return [x1 - x0, y1 - y0];
  };
  const fitsAt = (w, h) => w <= bedW + 1e-6 && h <= bedH + 1e-6;
  const [w0, h0] = dims(0);
  if (fitsAt(w0, h0)) return { fits: true, angle: 0, w: w0, h: h0 };
  if (fitsAt(h0, w0)) return { fits: true, angle: 90, w: w0, h: h0 };
  for (let deg = 1; deg < 90; deg += 1) {
    const [w, h] = dims(deg);
    if (fitsAt(w, h) || fitsAt(h, w)) return { fits: true, angle: deg, w: w0, h: h0 };
  }
  return { fits: false, angle: 0, w: w0, h: h0 };
}

export function regionPoints(cs) {
  const pts = [];
  for (const p of cs.toPolygons()) for (const v of p) pts.push([v[0], v[1]]);
  return pts;
}

// Fewest-pieces grid that should fit the bed. Returns {xs: [...], ys: [...]} cut positions.
export function suggestGrid(bounds, bedW, bedH, depth) {
  const W = bounds.max[0] - bounds.min[0], H = bounds.max[1] - bounds.min[1];
  const need = (len, bed) => {
    if (len <= bed) return 1;
    for (let n = 2; n < 50; n++) if (len / n + depth <= bed) return n;
    return 50;
  };
  const a = [need(W, bedW), need(H, bedH)];
  const b = [need(W, bedH), need(H, bedW)];
  const [cols, rows] = a[0] * a[1] <= b[0] * b[1] ? a : b;
  const even = (lo, len, n) => Array.from({ length: n - 1 }, (_, i) => lo + len * (i + 1) / n);
  return { xs: even(bounds.min[0], W, cols), ys: even(bounds.min[1], H, rows) };
}

// ---------------------------------------------------------------- 3D split

// Produce every piece (and butterfly keys, if used) as Manifolds.
// The caller owns the returned manifolds and must delete() them.
export function splitModel(wasm, model, cuts, j) {
  const A = new Arena();
  try {
    const box = model.boundingBox();
    const z0 = box.min[2] - 1, zh = box.max[2] - box.min[2] + 2;
    let body = model;
    const keys = [];
    if (j.style === 'butterfly') {
      const depth = Math.min(j.keyDepth > 0 ? j.keyDepth : Infinity, box.max[2] - box.min[2]);
      const fromTop = j.keyFrom === 'top';
      const sockets = [];
      for (const cut of cuts) for (const tab of cut.tabs) {
        const k = keyShape(wasm, A, cut, tab.t, j);
        const r = roundCorners(A, k, j.radius);
        const sock = A.k(r.offset(j.clearance / 2, 'Miter', 2));
        const sockZ = fromTop ? box.max[2] - depth : box.min[2] - 1;
        sockets.push(A.k(A.k(sock.extrude(depth + 1)).translate([0, 0, sockZ])));
        keys.push(A.k(r.offset(-j.clearance / 2, 'Miter', 2)));
      }
      if (sockets.length) body = A.k(model.subtract(A.k(wasm.Manifold.union(sockets))));
      j = { ...j, keyHeight: depth };
    }
    const regions = pieceRegions(wasm, A, cuts, box, j);
    const pieces = [];
    for (const p of regions) {
      const solid = A.k(A.k(p.region.extrude(zh)).translate([0, 0, z0]));
      const m = body.intersect(solid);
      if (m.isEmpty()) { m.delete(); continue; }
      pieces.push({ name: p.name, col: p.col, row: p.row, manifold: m });
    }
    let keyPart = null;
    if (keys.length) {
      // lay keys out in a row next to each other, resting on z = 0
      const placed = [];
      let x = 0;
      for (const k of keys) {
        const b = k.bounds();
        const w = b.max[0] - b.min[0];
        placed.push(A.k(A.k(k.extrude(j.keyHeight)).translate([x - b.min[0], -b.min[1], 0])));
        x += w + 4;
      }
      keyPart = { name: 'keys', manifold: wasm.Manifold.union(placed) };
    }
    return { pieces, keyPart };
  } finally {
    A.free();
  }
}
