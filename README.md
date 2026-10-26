# Plate Splitter

A browser tool that cuts a flat STL (baseplates, jigs, panels) into pieces that fit your printer's bed. The pieces lock back together with dovetail ("keystone") joints.

**Try it:** https://mudmin.github.io/plate-splitter/

If it saves you a print or two, you can [support the project here](https://userspice.com/donate/).

It runs entirely in the browser, with no build step and no server code. Your STL never leaves your computer. To host it yourself, serve the folder from any web server and open `index.html`. Opening it straight from disk (`file://`) won't work.

## Use

1. **Open STL…** or drop a file onto the page. **Load sample** opens `sample/square_plate.stl`, a 300 × 300 mm plate that splits four ways on a 220 mm bed.
2. Pick your printer. The tool places the fewest cuts that make every piece fit. **Auto-split for this bed** runs that again.
3. Adjust the split:
   - Drag a cut line, or type its distance from the edge in the sidebar. Hold **Shift** while dragging to turn off 0.5 mm snapping.
   - Drag a joint to slide it along the cut.
   - Double-click a cut line to add a joint.
   - Click a joint and press **F** to flip its direction, or **Delete** to remove it.
   - **Re-space** spreads a cut's joints evenly again. Setting the **Joints** count does the same.
4. Download pieces one at a time, or use **Download all (.zip)**. Files are named `<prefix>_left.stl`, `<prefix>_right.stl`, `<prefix>_upper_left.stl` and so on.

Each piece is labelled in the plan view with its size and whether it fits the usable bed (bed size minus the margin on every side). The fit check tries the piece rotated before it reports "too big".

## Joint styles

| Style | Notes |
|---|---|
| Dovetail (keystone) | The default. The pieces slide together vertically. |
| Puzzle knob | Round jigsaw head. Its depth is at least 1.15 × the head width. |
| Butterfly key | Bow-tie sockets on both pieces, plus a separate `<prefix>_keys.stl`. The sockets are cut from the bottom (or top) to the key depth; set the depth to 0 for full thickness. |
| Straight | A plain cut for gluing. |

**Clearance** is the total gap between the mating faces, and half of it is taken from each side. 0.2–0.4 mm suits most FDM printers. Print a test pair first if the fit matters.

A joint drawn in red is too close to an outside edge, a hole, or a crossing cut. It still gets cut, but it will be weak.

## Files

- `js/geometry.js`: STL read/write, joint shapes, grid split, bed-fit checks. It has no DOM code, so it also runs in Node.
- `js/app.js`: the user interface, plan editor (SVG) and 3D preview (three.js).
- `js/printers.js`: printer bed presets. Add your own printers here.
- `tools/make-sample.mjs`: regenerates the sample plate (`node tools/make-sample.mjs`).
- `vendor/`: [manifold-3d](https://github.com/elalish/manifold) 3.5.1 for the booleans, three.js r185, and fflate 0.8.2 for the zip.

## Hosting and license

Every push to `main` deploys to GitHub Pages through `.github/workflows/pages.yml`, which publishes only the files the browser needs.

Plate Splitter is MIT licensed (see `LICENSE`). The bundled libraries keep their own licenses, found in `vendor/`: three.js and fflate are MIT, and manifold-3d is Apache-2.0.
