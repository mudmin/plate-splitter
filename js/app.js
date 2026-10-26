import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import ManifoldModule from '../vendor/manifold/manifold.js';
import { zipSync } from '../vendor/fflate/fflate.js';
import * as G from './geometry.js';
import { PRINTERS, DEFAULT_PRINTER, findPrinter } from './printers.js';

const $ = (id) => document.getElementById(id);

// Surface any uncaught error on the page instead of failing silently.
const showError = (msg) => { const el = $('status'); el.textContent = msg; el.classList.add('error'); };
window.addEventListener('error', (e) => showError('Error: ' + (e.error?.message || e.message)));
window.addEventListener('unhandledrejection', (e) => showError('Error: ' + (e.reason?.message || e.reason)));
const SAMPLE_URL = 'sample/square_plate.stl';
const STORE_KEY = 'plate-splitter-settings';
const PIECE_COLORS = ['#e8590c', '#1c7ed6', '#2b8a3e', '#ae3ec9', '#f59f00', '#0c8599', '#c2255c', '#5f3dc4', '#74b816'];

const DEFAULT_JOINT = {
  style: 'dovetail', neck: 12, head: 18, depth: 10,
  clearance: 0.3, radius: 1, wall: 2, alternate: true, keyDepth: 0, keyFrom: 'bottom',
};

const S = {
  wasm: null,
  soup: null,
  fileName: '',
  baseName: '',
  upAxis: 'z',
  model: null,
  bounds: null,
  footprint: null,
  shading: [],
  cuts: [],
  nextCutId: 1,
  joint: { ...DEFAULT_JOINT },
  printer: { id: DEFAULT_PRINTER, w: 220, h: 220, margin: 5 },
  sel: { cut: null, tab: null },
  pieces2d: [],
  tabState: new Map(),   // cut id -> [{valid, outline}]
  split: null,           // { pieces, keyPart, stamp }
  stamp: 0,
};

// ------------------------------------------------------------------ settings

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (saved?.joint) S.joint = { ...DEFAULT_JOINT, ...saved.joint };
    if (saved?.printer) S.printer = { ...S.printer, ...saved.printer };
  } catch (e) { /* storage unavailable */ }
}

function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ joint: S.joint, printer: S.printer })); } catch (e) { /* ignore */ }
}

function usableBed() {
  return [S.printer.w - 2 * S.printer.margin, S.printer.h - 2 * S.printer.margin];
}

// ------------------------------------------------------------------ status

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg || '';
  el.classList.toggle('error', isError);
}

const fmt = (v) => (Math.round(v * 10) / 10).toFixed(1);

// ------------------------------------------------------------------ model loading

async function loadBuffer(buffer, name) {
  try {
    S.soup = G.parseSTL(buffer);
    S.fileName = name;
    S.baseName = name.replace(/\.stl$/i, '').trim().replace(/[^\w.-]+/g, '_') || 'part';
    $('base-name').value = S.baseName;
    buildModel();
    autoSplit();
    setStatus(`Loaded ${name}`);
  } catch (e) {
    console.error(e);
    setStatus(e.message || String(e), true);
  }
}

function buildModel() {
  if (S.model) S.model.delete();
  if (S.footprint) S.footprint.delete();
  S.model = null; S.footprint = null;
  clearSplit();
  S.model = G.soupToManifold(S.wasm, S.soup, S.upAxis);
  const b = S.model.boundingBox();
  S.bounds = b;
  S.footprint = S.model.project();
  // a few horizontal slices give the plan view some depth
  S.shading = [];
  const z0 = b.min[2], z1 = b.max[2];
  const levels = 6;
  for (let i = 0; i < levels; i++) {
    const z = z0 + (z1 - z0) * (i + 0.5) / levels;
    const cs = S.model.slice(z);
    S.shading.push(cs.toPolygons());
    cs.delete();
  }
  const [w, d, h] = [0, 1, 2].map(k => b.max[k] - b.min[k]);
  $('model-info').innerHTML = `<strong>${escapeHTML(S.fileName)}</strong><br>${fmt(w)} × ${fmt(d)} × ${fmt(h)} mm · ${S.model.numTri().toLocaleString()} triangles`;
  $('empty').classList.add('hidden');
  fitView();
  fitCamera();
}

function escapeHTML(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------------------------------------------------ cuts & tabs

function autoSplit() {
  if (!S.model) return;
  const [bw, bh] = usableBed();
  const g = G.suggestGrid(S.bounds, bw, bh, G.jointDepth(S.joint));
  S.cuts = [
    ...g.xs.map(pos => newCut('x', pos)),
    ...g.ys.map(pos => newCut('y', pos)),
  ];
  S.sel = { cut: null, tab: null };
  retab(true);
  update();
}

function newCut(axis, pos) {
  return { id: S.nextCutId++, axis, pos, tabs: [], auto: true, count: null };
}

function addCut(axis) {
  if (!S.model) return;
  const b = S.bounds;
  const k = axis === 'x' ? 0 : 1;
  // drop the new cut in the middle of the widest gap between existing cuts
  const stops = [b.min[k], ...S.cuts.filter(c => c.axis === axis).map(c => c.pos).sort((p, q) => p - q), b.max[k]];
  let best = 0;
  for (let i = 1; i < stops.length - 1; i++) if (stops[i + 1] - stops[i] > stops[best + 1] - stops[best]) best = i;
  const cut = newCut(axis, (stops[best] + stops[best + 1]) / 2);
  S.cuts.push(cut);
  S.sel = { cut: cut.id, tab: null };
  retab(true);
  update();
}

function removeCut(id) {
  S.cuts = S.cuts.filter(c => c.id !== id);
  if (S.sel.cut === id) S.sel = { cut: null, tab: null };
  retab(true);
  update();
}

function intervalsFor(A, cut) {
  return G.validIntervals(S.wasm, A, S.footprint, S.cuts, cut, S.joint, S.bounds);
}

// Recompute joint positions for cuts in auto mode. `resetCounts` forgets
// remembered counts so they follow the new line length.
function retab(resetCounts = false) {
  if (!S.model) return;
  const A = new G.Arena();
  try {
    for (const cut of S.cuts) {
      if (!cut.auto) continue;
      const iv = intervalsFor(A, cut);
      if (resetCounts || cut.count === null) cut.count = G.defaultTabCount(iv);
      if (S.joint.style === 'none') { cut.tabs = []; continue; }
      cut.tabs = G.autoTabs(iv, cut.count, S.joint.alternate && S.joint.style !== 'butterfly', S.joint);
    }
  } finally { A.free(); }
}

// ------------------------------------------------------------------ 2D evaluation

function evaluate2D() {
  S.pieces2d = [];
  S.tabState = new Map();
  if (!S.model) return;
  const A = new G.Arena();
  try {
    const [bw, bh] = usableBed();
    const regions = G.pieceRegions(S.wasm, A, S.cuts, S.bounds, S.joint);
    const nCols = S.cuts.filter(c => c.axis === 'x').length + 1;
    regions.forEach((r) => {
      const shape = A.k(r.region.intersect(S.footprint));
      if (shape.isEmpty()) return;
      const pts = G.regionPoints(shape);
      const fit = G.bedFit(pts, bw, bh);
      const bb = shape.bounds();
      S.pieces2d.push({
        name: r.name, col: r.col, row: r.row,
        color: PIECE_COLORS[(r.row * nCols + r.col) % PIECE_COLORS.length],
        polys: shape.toPolygons(), fit, bounds: bb,
      });
    });
    for (const cut of S.cuts) {
      S.tabState.set(cut.id, cut.tabs.map(tab => ({
        valid: G.tabValid(S.wasm, A, S.footprint, S.cuts, cut, tab.t, S.joint),
        outline: G.jointOutline(S.wasm, A, cut, tab, S.joint),
      })));
    }
  } finally { A.free(); }
}

function update({ skip3D = false } = {}) {
  evaluate2D();
  renderPlan();
  renderCutList();
  renderPieceList();
  if (!skip3D) schedule3D();
}

// ------------------------------------------------------------------ plan view (SVG)

const svg = $('plan');
const view = { x: 0, y: 0, w: 100, h: 100 };   // viewBox in model mm (y flipped)

function fitView() {
  if (!S.bounds) return;
  const b = S.bounds, pad = 25;
  const w = b.max[0] - b.min[0] + pad * 2, h = b.max[1] - b.min[1] + pad * 2;
  const rect = svg.getBoundingClientRect();
  const aspect = rect.width && rect.height ? rect.width / rect.height : 1.6;
  let vw = w, vh = h;
  if (vw / vh < aspect) vw = vh * aspect; else vh = vw / aspect;
  view.w = vw; view.h = vh;
  view.x = (b.min[0] + b.max[0]) / 2 - vw / 2;
  view.y = -(b.min[1] + b.max[1]) / 2 - vh / 2;
  applyView();
}

function applyView() {
  svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
}

function mmPerPx() {
  const r = svg.getBoundingClientRect();
  return r.width ? view.w / r.width : 1;
}

function toModel(evt) {
  const pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  const p = pt.matrixTransform(svg.getScreenCTM().inverse());
  return [p.x, -p.y];
}

const pathOf = (polys) => polys.map(p => 'M' + p.map(v => `${v[0]},${-v[1]}`).join('L') + 'Z').join('');

function renderPlan() {
  if (!S.model) { svg.innerHTML = ''; return; }
  const b = S.bounds, px = mmPerPx();
  const ext = 10;
  let out = '';
  out += `<path class="p-model" fill-rule="evenodd" d="${pathOf(S.footprint.toPolygons())}"/>`;
  for (const polys of S.shading) out += `<path class="p-layer" fill-rule="evenodd" d="${pathOf(polys)}"/>`;

  for (const p of S.pieces2d) {
    out += `<path class="p-piece${p.fit.fits ? '' : ' bad'}" fill="${p.color}" stroke="${p.color}" fill-rule="evenodd" d="${pathOf(p.polys)}" data-piece="${p.name}"/>`;
  }

  // dashed bed outline around the hovered / selected piece
  const focus = S.pieces2d.find(p => p.name === hoverPiece);
  if (focus) {
    const [bw, bh] = usableBed();
    const cx = (focus.bounds.min[0] + focus.bounds.max[0]) / 2, cy = (focus.bounds.min[1] + focus.bounds.max[1]) / 2;
    const rot = focus.fit.fits && focus.fit.angle === 90;
    const w = rot ? bh : bw, h = rot ? bw : bh;
    out += `<rect class="p-bed" x="${cx - w / 2}" y="${-cy - h / 2}" width="${w}" height="${h}"/>`;
    out += `<text class="p-bed-text" x="${cx - w / 2 + 2 * px}" y="${-cy - h / 2 - 4 * px}" style="font-size:${11 * px}px">usable bed ${fmt(bw)} × ${fmt(bh)}</text>`;
  }

  for (const cut of S.cuts) {
    const sel = S.sel.cut === cut.id;
    let x1, y1, x2, y2;
    if (cut.axis === 'x') { x1 = x2 = cut.pos; y1 = b.min[1] - ext; y2 = b.max[1] + ext; }
    else { y1 = y2 = cut.pos; x1 = b.min[0] - ext; x2 = b.max[0] + ext; }
    out += `<line class="p-cut${sel ? ' sel' : ''}" x1="${x1}" y1="${-y1}" x2="${x2}" y2="${-y2}"/>`;
    out += `<line class="p-cut-hit ${cut.axis}" x1="${x1}" y1="${-y1}" x2="${x2}" y2="${-y2}" data-cut="${cut.id}"/>`;
    const states = S.tabState.get(cut.id) || [];
    cut.tabs.forEach((tab, i) => {
      const st = states[i];
      if (!st) return;
      const cls = ['p-tab', sel && S.sel.tab === i ? 'sel' : '', st.valid ? '' : 'invalid'].join(' ');
      out += `<path class="${cls}" d="${pathOf(st.outline)}" data-cut="${cut.id}" data-tab="${i}"/>`;
    });
    const r = 6 * px;
    const off = cut.axis === 'x' ? cut.pos - b.min[0] : cut.pos - b.min[1];
    const [hx, hy] = cut.axis === 'x' ? [x2, y2] : [x1, y1];
    out += `<circle class="p-handle${sel ? ' sel' : ''}" cx="${hx}" cy="${-hy}" r="${r}" data-cut="${cut.id}"/>`;
    const tx = cut.axis === 'x' ? hx : hx - r * 1.6, ty = cut.axis === 'x' ? -hy - r * 1.8 : -hy + r * 0.5;
    out += `<text class="p-handle-text" x="${tx}" y="${ty}" text-anchor="${cut.axis === 'x' ? 'middle' : 'end'}" style="font-size:${11 * px}px">${fmt(off)}</text>`;
  }

  for (const p of S.pieces2d) {
    const cx = (p.bounds.min[0] + p.bounds.max[0]) / 2, cy = (p.bounds.min[1] + p.bounds.max[1]) / 2;
    const w = p.bounds.max[0] - p.bounds.min[0], h = p.bounds.max[1] - p.bounds.min[1];
    const fitText = !p.fit.fits ? '✗ too big' : p.fit.angle === 0 ? '✓ fits' : p.fit.angle === 90 ? '✓ fits rotated 90°' : `✓ fits at ${p.fit.angle}°`;
    const fitCls = !p.fit.fits ? 'bad' : p.fit.angle === 0 || p.fit.angle === 90 ? 'ok' : 'rot';
    const fs = 12 * px;
    out += `<text class="p-label" x="${cx}" y="${-cy}" style="font-size:${fs}px;stroke-width:${2.5 * px}px">`
      + `<tspan x="${cx}" dy="${-0.6 * fs}" font-weight="650">${p.name}</tspan>`
      + `<tspan x="${cx}" dy="${1.25 * fs}">${fmt(w)} × ${fmt(h)} mm</tspan>`
      + `<tspan x="${cx}" dy="${1.25 * fs}" class="${fitCls}">${fitText}</tspan></text>`;
  }
  svg.innerHTML = out;
}

// ------------------------------------------------------------------ plan interaction

let drag = null;
let hoverPiece = null;
let rafPending = false;

function scheduleDragUpdate() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    update({ skip3D: true });
  });
}

svg.addEventListener('pointerdown', (e) => {
  if (!S.model || e.button === 2) return;
  const t = e.target;
  const cutId = t.dataset?.cut ? +t.dataset.cut : null;
  const [mx, my] = toModel(e);
  if (isDoubleClick(e) && t.dataset?.tab === undefined && hitCut(mx, my)) { addTabAt(mx, my); return; }
  svg.setPointerCapture(e.pointerId);
  if (cutId !== null && t.dataset.tab !== undefined) {
    const cut = S.cuts.find(c => c.id === cutId);
    const i = +t.dataset.tab;
    S.sel = { cut: cutId, tab: i };
    const along = cut.axis === 'x' ? my : mx;
    drag = { kind: 'tab', cut, tab: cut.tabs[i], offset: cut.tabs[i].t - along, moved: false };
    update({ skip3D: true });
  } else if (cutId !== null) {
    const cut = S.cuts.find(c => c.id === cutId);
    S.sel = { cut: cutId, tab: null };
    const across = cut.axis === 'x' ? mx : my;
    drag = { kind: 'cut', cut, offset: cut.pos - across, moved: false };
    update({ skip3D: true });
  } else {
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
  }
});

svg.addEventListener('pointermove', (e) => {
  if (!drag) {
    const name = e.target.dataset?.piece || null;
    if (name !== hoverPiece) { hoverPiece = name; renderPlan(); }
    return;
  }
  if (drag.kind === 'pan') {
    const k = mmPerPx();
    view.x = drag.vx - (e.clientX - drag.sx) * k;
    view.y = drag.vy - (e.clientY - drag.sy) * k;
    drag.moved = true;
    applyView();
    return;
  }
  const [mx, my] = toModel(e);
  if (drag.kind === 'cut') {
    const k = drag.cut.axis === 'x' ? 0 : 1;
    let pos = (k === 0 ? mx : my) + drag.offset;
    pos = Math.min(S.bounds.max[k] - 1, Math.max(S.bounds.min[k] + 1, pos));
    if (!e.shiftKey) pos = S.bounds.min[k] + Math.round((pos - S.bounds.min[k]) * 2) / 2;
    drag.cut.pos = pos;
    drag.moved = true;
    retab();
    scheduleDragUpdate();
  } else if (drag.kind === 'tab') {
    const along = (drag.cut.axis === 'x' ? my : mx) + drag.offset;
    drag.tab.t = e.shiftKey ? along : Math.round(along * 2) / 2;
    drag.cut.auto = false;
    drag.moved = true;
    scheduleDragUpdate();
  }
});

function endDrag() {
  if (!drag) return;
  const moved = drag.moved && drag.kind !== 'pan';
  drag = null;
  if (moved) update();
}
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);
svg.addEventListener('pointerleave', () => { if (hoverPiece && !drag) { hoverPiece = null; renderPlan(); } });

// Nearest cut line within a few pixels of a model-space point.
function hitCut(mx, my) {
  const tol = 8 * mmPerPx();
  let best = null, bestD = tol;
  for (const cut of S.cuts) {
    const d = Math.abs((cut.axis === 'x' ? mx : my) - cut.pos);
    if (d <= bestD) { best = cut; bestD = d; }
  }
  return best;
}

// The plan is re-rendered on pointerdown, which swallows native dblclick events,
// so double-clicks on a cut line are detected by hand in pointerdown.
let lastDown = { time: 0, x: 0, y: 0 };

function isDoubleClick(e) {
  const dbl = e.timeStamp - lastDown.time < 400 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 6;
  lastDown = dbl ? { time: 0, x: 0, y: 0 } : { time: e.timeStamp, x: e.clientX, y: e.clientY };
  return dbl;
}

function addTabAt(mx, my) {
  const cut = hitCut(mx, my);
  if (!cut) return;
  if (S.joint.style === 'none') { setStatus('Straight cuts have no joints. Pick a joint style first.'); return; }
  const t = Math.round((cut.axis === 'x' ? my : mx) * 2) / 2;
  if (cut.tabs.some(tab => Math.abs(tab.t - t) < S.joint.head / 2)) return;   // double-clicked an existing joint
  const prev = [...cut.tabs].reverse().find(tab => tab.t < t);
  const tab = { t, flip: S.joint.alternate && S.joint.style !== 'butterfly' ? !(prev ? prev.flip : true) : false };
  cut.tabs.push(tab);
  cut.tabs.sort((p, q) => p.t - q.t);
  cut.auto = false;
  cut.count = cut.tabs.length;
  S.sel = { cut: cut.id, tab: cut.tabs.indexOf(tab) };
  update();
}

svg.addEventListener('wheel', (e) => {
  if (!S.model) return;
  e.preventDefault();
  const [mx, my] = toModel(e);
  const f = Math.exp(e.deltaY * 0.0015);
  const nw = Math.min(5000, Math.max(5, view.w * f));
  const k = nw / view.w;
  view.x = mx - (mx - view.x) * k;
  view.y = -my - (-my - view.y) * k;
  view.w = nw; view.h *= k;
  applyView();
  renderPlan();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  const cut = S.cuts.find(c => c.id === S.sel.cut);
  if (!cut) return;
  if (S.sel.tab !== null && cut.tabs[S.sel.tab]) {
    if (e.key === 'f' || e.key === 'F') {
      cut.tabs[S.sel.tab].flip = !cut.tabs[S.sel.tab].flip;
      cut.auto = false;
      update();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      cut.tabs.splice(S.sel.tab, 1);
      cut.auto = false;
      cut.count = cut.tabs.length;
      S.sel.tab = null;
      update();
      e.preventDefault();
    }
  } else if (e.key === 'Delete') {
    removeCut(cut.id);
  }
});

// ------------------------------------------------------------------ sidebar: cuts

function renderCutList() {
  const list = $('cut-list');
  if (!S.cuts.length) {
    list.innerHTML = `<div class="muted">${S.model ? 'No cuts. The model is exported whole.' : 'Load a model first.'}</div>`;
    return;
  }
  const b = S.bounds;
  list.innerHTML = S.cuts.map(cut => {
    const k = cut.axis === 'x' ? 0 : 1;
    const states = S.tabState.get(cut.id) || [];
    const bad = states.filter(s => !s.valid).length;
    const label = cut.axis === 'x' ? 'Vertical cut (left | right)' : 'Horizontal cut (upper / lower)';
    const warn = [];
    if (bad) warn.push(`${bad} joint${bad > 1 ? 's' : ''} too close to an edge or another cut`);
    if (S.joint.style !== 'none' && !cut.tabs.length) warn.push('No joints on this cut');
    return `<div class="cut-item${S.sel.cut === cut.id ? ' selected' : ''}" data-cut="${cut.id}">
      <div class="cut-head"><span>${label}</span>
        <span class="actions">
          <button class="btn small" data-act="respace" title="Evenly re-space the joints">Re-space</button>
          <button class="btn small icon" data-act="remove" title="Remove this cut">✕</button>
        </span></div>
      <div class="row">
        <label>From ${cut.axis === 'x' ? 'left' : 'bottom'} edge (mm)
          <input type="number" step="0.5" data-act="pos" value="${fmt(cut.pos - b.min[k])}"></label>
        <label>Joints
          <input type="number" min="0" max="20" step="1" data-act="count" value="${cut.tabs.length}" ${S.joint.style === 'none' ? 'disabled' : ''}></label>
      </div>
      ${warn.length ? `<div class="warn">⚠ ${warn.join(' · ')}</div>` : ''}
    </div>`;
  }).join('');
}

$('cut-list').addEventListener('click', (e) => {
  const item = e.target.closest('.cut-item');
  if (!item) return;
  const cut = S.cuts.find(c => c.id === +item.dataset.cut);
  const act = e.target.dataset.act;
  if (act === 'remove') { removeCut(cut.id); return; }
  if (act === 'respace') { cut.auto = true; retab(); S.sel = { cut: cut.id, tab: null }; update(); return; }
  if (S.sel.cut !== cut.id) { S.sel = { cut: cut.id, tab: null }; renderPlan(); item.parentElement.querySelectorAll('.cut-item').forEach(el => el.classList.toggle('selected', el === item)); }
});

$('cut-list').addEventListener('change', (e) => {
  const item = e.target.closest('.cut-item');
  if (!item) return;
  const cut = S.cuts.find(c => c.id === +item.dataset.cut);
  const v = parseFloat(e.target.value);
  if (!Number.isFinite(v)) return;
  if (e.target.dataset.act === 'pos') {
    const k = cut.axis === 'x' ? 0 : 1;
    cut.pos = Math.min(S.bounds.max[k] - 1, Math.max(S.bounds.min[k] + 1, S.bounds.min[k] + v));
    retab();
  } else if (e.target.dataset.act === 'count') {
    cut.count = Math.max(0, Math.round(v));
    cut.auto = true;
    retab();
  }
  update();
});

// ------------------------------------------------------------------ sidebar: pieces

function renderPieceList() {
  const list = $('piece-list');
  if (!S.pieces2d.length) { list.innerHTML = '<div class="muted">Nothing yet.</div>'; $('btn-zip').disabled = true; return; }
  const [bw, bh] = usableBed();
  let html = S.pieces2d.map(p => {
    const w = p.bounds.max[0] - p.bounds.min[0], h = p.bounds.max[1] - p.bounds.min[1];
    const fit = !p.fit.fits
      ? `<span class="fit-bad">✗ larger than ${fmt(bw)} × ${fmt(bh)}</span>`
      : p.fit.angle === 0 ? '<span class="fit-ok">✓ fits</span>'
      : p.fit.angle === 90 ? '<span class="fit-ok">✓ fits rotated 90°</span>'
      : `<span class="fit-rot">✓ fits rotated ${p.fit.angle}°</span>`;
    return `<div class="piece" data-piece="${p.name}">
      <span class="swatch" style="background:${p.color}"></span>
      <div><div class="name">${escapeHTML(fileFor(p.name))}</div><div class="dims">${fmt(w)} × ${fmt(h)} mm · ${fit}</div></div>
      <button class="btn small" data-dl="${p.name}" title="Download this piece">STL</button>
    </div>`;
  }).join('');
  if (S.joint.style === 'butterfly' && S.cuts.some(c => c.tabs.length)) {
    const n = S.cuts.reduce((s, c) => s + c.tabs.length, 0);
    html += `<div class="piece">
      <span class="swatch" style="background:#868e96"></span>
      <div><div class="name">${escapeHTML(fileFor('keys'))}</div><div class="dims">${n} butterfly key${n > 1 ? 's' : ''}</div></div>
      <button class="btn small" data-dl="keys">STL</button>
    </div>`;
  }
  list.innerHTML = html;
  $('btn-zip').disabled = false;
}

function fileFor(name) {
  const base = ($('base-name').value.trim() || S.baseName || 'part').replace(/[^\w.-]+/g, '_');
  return name === 'whole' ? `${base}.stl` : `${base}_${name}.stl`;
}

$('piece-list').addEventListener('click', (e) => {
  const name = e.target.dataset?.dl;
  if (name) downloadPiece(name);
});
$('piece-list').addEventListener('mouseover', (e) => {
  const el = e.target.closest('.piece');
  const name = el?.dataset.piece || null;
  if (name !== hoverPiece) { hoverPiece = name; renderPlan(); }
});
$('piece-list').addEventListener('mouseleave', () => { hoverPiece = null; renderPlan(); });

// ------------------------------------------------------------------ 3D split + downloads

let splitTimer = null;

function clearSplit() {
  if (!S.split) return;
  for (const p of S.split.pieces) p.manifold.delete();
  if (S.split.keyPart) S.split.keyPart.manifold.delete();
  S.split = null;
}

function schedule3D() {
  S.stamp++;
  clearTimeout(splitTimer);
  $('busy').hidden = false;
  splitTimer = setTimeout(() => { ensureSplit(); render3D(); }, 300);
}

function ensureSplit() {
  if (!S.model) return null;
  if (S.split && S.split.stamp === S.stamp) return S.split;
  clearSplit();
  const t0 = performance.now();
  try {
    const res = G.splitModel(S.wasm, S.model, S.cuts, S.joint);
    S.split = { ...res, stamp: S.stamp };
    const ms = Math.round(performance.now() - t0);
    setStatus(`${res.pieces.length} piece${res.pieces.length > 1 ? 's' : ''}${res.keyPart ? ' + keys' : ''} · computed in ${ms} ms`);
  } catch (e) {
    console.error(e);
    setStatus('Split failed: ' + (e.message || e), true);
    S.split = { pieces: [], keyPart: null, stamp: S.stamp };
  }
  $('busy').hidden = true;
  return S.split;
}

function stlFor(name) {
  const split = ensureSplit();
  const part = name === 'keys' ? split.keyPart : split.pieces.find(p => p.name === name);
  return part ? G.writeSTL(part.manifold.getMesh()) : null;
}

function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function downloadPiece(name) {
  const buf = stlFor(name);
  if (buf) saveBlob(new Blob([buf], { type: 'model/stl' }), fileFor(name));
}

$('btn-zip').addEventListener('click', () => {
  const split = ensureSplit();
  if (!split) return;
  const files = {};
  for (const p of split.pieces) files[fileFor(p.name)] = new Uint8Array(G.writeSTL(p.manifold.getMesh()));
  if (split.keyPart) files[fileFor('keys')] = new Uint8Array(G.writeSTL(split.keyPart.manifold.getMesh()));
  const base = ($('base-name').value.trim() || S.baseName || 'part').replace(/[^\w.-]+/g, '_');
  saveBlob(new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' }), `${base}_split.zip`);
});

// ------------------------------------------------------------------ 3D preview

// The preview is optional: without WebGL (hardware acceleration off, GPU
// blocklisted) the plan view and downloads still work.
const canvas = $('three');
let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
} catch (e) {
  console.warn('3D preview disabled:', e);
  $('no-webgl').hidden = false;
  document.querySelector('.three-controls').hidden = true;
}
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 1, 20000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x8890a0, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(0.6, -1, 1.4);
scene.add(sun);
const group = new THREE.Group();
scene.add(group);

function fitCamera() {
  if (!S.bounds) return;
  const b = S.bounds;
  const c = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
  const r = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2;
  resize3D();
  const half = THREE.MathUtils.degToRad(camera.fov / 2);
  const dist = (r * 1.15) / Math.sin(half) / Math.min(1, camera.aspect);
  controls.target.copy(c);
  camera.position.copy(c).add(new THREE.Vector3(0.35, -1.1, 0.9).normalize().multiplyScalar(dist));
  camera.near = r / 50; camera.far = r * 50;
  camera.updateProjectionMatrix();
}

function geometryOf(manifold) {
  const mesh = manifold.getMesh();
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(mesh.numVert * 3);
  for (let i = 0; i < mesh.numVert; i++) {
    pos[i * 3] = mesh.vertProperties[i * mesh.numProp];
    pos[i * 3 + 1] = mesh.vertProperties[i * mesh.numProp + 1];
    pos[i * 3 + 2] = mesh.vertProperties[i * mesh.numProp + 2];
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(mesh.triVerts, 1));
  const flat = g.toNonIndexed();
  g.dispose();
  flat.computeVertexNormals();
  return flat;
}

function render3D() {
  if (!renderer) return;
  for (const m of group.children) { m.geometry.dispose(); m.material.dispose(); }
  group.clear();
  const split = S.split;
  if (!split) return;
  const nCols = S.cuts.filter(c => c.axis === 'x').length + 1;
  const nRows = S.cuts.filter(c => c.axis === 'y').length + 1;
  const ex = +$('explode').value;
  for (const p of split.pieces) {
    const color = PIECE_COLORS[(p.row * nCols + p.col) % PIECE_COLORS.length];
    const mesh = new THREE.Mesh(geometryOf(p.manifold), new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05 }));
    mesh.userData = { col: p.col, row: p.row };
    mesh.position.set((p.col - (nCols - 1) / 2) * ex, (p.row - (nRows - 1) / 2) * ex, 0);
    group.add(mesh);
  }
  if (split.keyPart) {
    const b = S.bounds;
    const mesh = new THREE.Mesh(geometryOf(split.keyPart.manifold), new THREE.MeshStandardMaterial({ color: 0x868e96, roughness: 0.7 }));
    mesh.position.set(b.min[0], b.min[1] - 30 - ex, b.min[2]);
    mesh.userData = { keys: true };
    group.add(mesh);
  }
}

$('explode').addEventListener('input', () => {
  const ex = +$('explode').value;
  const nCols = S.cuts.filter(c => c.axis === 'x').length + 1;
  const nRows = S.cuts.filter(c => c.axis === 'y').length + 1;
  for (const m of group.children) {
    if (m.userData.keys) { m.position.y = S.bounds.min[1] - 30 - ex; continue; }
    m.position.set((m.userData.col - (nCols - 1) / 2) * ex, (m.userData.row - (nRows - 1) / 2) * ex, 0);
  }
});

function resize3D() {
  const r = canvas.parentElement.getBoundingClientRect();
  if (!r.width || !r.height || !renderer) return;
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}

renderer?.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

new ResizeObserver(() => { resize3D(); renderPlan(); }).observe(canvas.parentElement);
new ResizeObserver(() => {
  // keep the plan's aspect in sync with its box without changing zoom
  const r = svg.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const cy = view.y + view.h / 2;
  view.h = view.w * r.height / r.width;
  view.y = cy - view.h / 2;
  applyView();
  renderPlan();
}).observe(svg);

// ------------------------------------------------------------------ sidebar: settings

function initPrinterSelect() {
  const sel = $('printer');
  let html = '';
  for (const g of PRINTERS) {
    html += `<optgroup label="${g.group}">`;
    for (const [name, w, h] of g.items) html += `<option value="${g.group} / ${name}">${name} — ${w}×${h}</option>`;
    html += '</optgroup>';
  }
  html += '<option value="custom">Custom…</option>';
  sel.innerHTML = html;
  sel.value = findPrinter(S.printer.id) ? S.printer.id : 'custom';
  $('bed-w').value = S.printer.w;
  $('bed-h').value = S.printer.h;
  $('bed-margin').value = S.printer.margin;
}

$('printer').addEventListener('change', (e) => {
  const p = findPrinter(e.target.value);
  S.printer.id = e.target.value;
  if (p) { S.printer.w = p.w; S.printer.h = p.h; $('bed-w').value = p.w; $('bed-h').value = p.h; }
  saveSettings();
  update({ skip3D: true });
});

for (const id of ['bed-w', 'bed-h', 'bed-margin']) {
  $(id).addEventListener('change', () => {
    S.printer.w = Math.max(10, +$('bed-w').value || 220);
    S.printer.h = Math.max(10, +$('bed-h').value || 220);
    S.printer.margin = Math.max(0, +$('bed-margin').value || 0);
    const p = findPrinter(S.printer.id);
    if (!p || p.w !== S.printer.w || p.h !== S.printer.h) { S.printer.id = 'custom'; $('printer').value = 'custom'; }
    saveSettings();
    update({ skip3D: true });
  });
}

$('btn-auto').addEventListener('click', autoSplit);
$('btn-add-x').addEventListener('click', () => addCut('x'));
$('btn-add-y').addEventListener('click', () => addCut('y'));

const JOINT_INPUTS = {
  'j-style': ['style', String], 'j-neck': ['neck', Number], 'j-head': ['head', Number], 'j-depth': ['depth', Number],
  'j-clear': ['clearance', Number], 'j-radius': ['radius', Number], 'j-wall': ['wall', Number],
  'j-keydepth': ['keyDepth', Number], 'j-keyfrom': ['keyFrom', String], 'j-alt': ['alternate', Boolean],
};

function syncJointInputs() {
  for (const [id, [key]] of Object.entries(JOINT_INPUTS)) {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = S.joint[key]; else el.value = S.joint[key];
  }
  const st = S.joint.style;
  document.querySelectorAll('[data-for="butterfly"]').forEach(el => { el.style.display = st === 'butterfly' ? '' : 'none'; });
  document.querySelectorAll('[data-for="joint"]').forEach(el => { el.style.display = st === 'none' ? 'none' : ''; });
  $('j-alt').closest('label').style.display = st === 'dovetail' || st === 'knob' ? '' : 'none';
}

for (const [id, [key, type]] of Object.entries(JOINT_INPUTS)) {
  $(id).addEventListener('change', (e) => {
    const el = e.target;
    let v = el.type === 'checkbox' ? el.checked : type(el.value);
    if (type === Number) { if (!Number.isFinite(v)) { el.value = S.joint[key]; return; } v = Math.max(0, v); }
    S.joint[key] = v;
    if (S.joint.head < S.joint.neck && S.joint.style !== 'none') {
      setStatus('Head is narrower than the neck, so the joint will not lock. Make Head wider than Neck.', true);
    }
    syncJointInputs();
    saveSettings();
    // joint geometry changed: let every cut re-space its joints
    for (const c of S.cuts) c.auto = true;
    retab(key === 'style');
    update();
  });
}

$('base-name').addEventListener('input', renderPieceList);

$('up-axis').addEventListener('change', (e) => {
  S.upAxis = e.target.value;
  if (!S.soup) return;
  try { buildModel(); autoSplit(); } catch (err) { setStatus(err.message, true); }
});

// ------------------------------------------------------------------ view tabs (narrow screens)

document.querySelectorAll('.stage-tabs .tab').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.stage-tabs .tab').forEach(b => b.classList.toggle('active', b === btn));
  $('plan-wrap').classList.toggle('active', btn.dataset.view === 'plan');
  $('three-wrap').classList.toggle('active', btn.dataset.view === 'three');
  resize3D();
}));

// ------------------------------------------------------------------ file input & drop

$('file-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) await loadBuffer(await f.arrayBuffer(), f.name);
  e.target.value = '';
});

$('btn-sample').addEventListener('click', async () => {
  try {
    const r = await fetch(SAMPLE_URL);
    if (!r.ok) throw new Error(`Sample not found (${r.status})`);
    await loadBuffer(await r.arrayBuffer(), 'square_plate.stl');
  } catch (e) { setStatus(e.message, true); }
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop-overlay').classList.add('show'); });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').classList.remove('show'); } });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').classList.remove('show');
  const f = [...(e.dataTransfer?.files || [])].find(x => /\.stl$/i.test(x.name)) || e.dataTransfer?.files?.[0];
  if (f) await loadBuffer(await f.arrayBuffer(), f.name);
});

// ------------------------------------------------------------------ boot

async function boot() {
  loadSettings();
  initPrinterSelect();
  syncJointInputs();
  renderCutList();
  renderPieceList();
  setStatus('Loading geometry engine…');
  S.wasm = await ManifoldModule();
  S.wasm.setup();
  setStatus('Ready. Open an STL to begin.');
  if (location.hash === '#sample') $('btn-sample').click();
}

window.plateSplitter = S;   // handy for poking at state from the console

boot().catch(e => { console.error(e); setStatus('Failed to start: ' + e.message, true); });
