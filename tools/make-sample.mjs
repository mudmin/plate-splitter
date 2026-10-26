// Generates sample/square_plate.stl, the demo model used by "Load sample".
// Run from the repo root: node tools/make-sample.mjs
import fs from 'fs';
import ManifoldModule from '../vendor/manifold/manifold.js';
import { writeSTL } from '../js/geometry.js';

const wasm = await ManifoldModule();
wasm.setup();
const { CrossSection, Manifold } = wasm;

const SIZE = 300, THICK = 8, CORNER = 12;

const roundedSquare = (size, r) => CrossSection.square(size - 2 * r, true).offset(r, 'Round', 2, 64);

let plate = roundedSquare(SIZE, CORNER).extrude(THICK);

// corner mounting holes
const holes = [];
for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
  holes.push(Manifold.cylinder(THICK + 2, 2.75, 2.75, 48).translate([sx * (SIZE / 2 - 14), sy * (SIZE / 2 - 14), -1]));
}

// one shallow rounded pocket per quadrant, kept clear of the centre lines
const pocket = roundedSquare(100, 8).extrude(3).translate([0, 0, THICK - 2]);
const pockets = [];
for (const sx of [-1, 1]) for (const sy of [-1, 1]) pockets.push(pocket.translate([sx * 72, sy * 72, 0]));

plate = plate.subtract(Manifold.union([...holes, ...pockets]));
// sit the model on z = 0 with its corner at the origin, like a typical CAD export
plate = plate.translate([SIZE / 2, SIZE / 2, 0]);

fs.mkdirSync('sample', { recursive: true });
fs.writeFileSync('sample/square_plate.stl', Buffer.from(writeSTL(plate.getMesh())));
const b = plate.boundingBox();
console.log('wrote sample/square_plate.stl', plate.numTri(), 'triangles', b.min, b.max);
