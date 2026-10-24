// 23.10 (7.48): the pixel work around the upscaler — pure functions over straight RGBA, no files, no GPU.
//
// The network only ever sees opaque RGB pictures. A texture becomes up to two of them:
// - the colour with its alpha dropped (A = 255), and
// - the alpha as a grey picture (R = G = B = alpha),
// both laid out the same way, upscaled separately and put back together: colour from the first, alpha from the
// second. Upscaling RGBA in one pass lets the network smear colour that sat under alpha 0 into the visible edge
// (a dark or bright fringe around every additive and blended particle); kept apart, the alpha edge is the
// network's best alpha edge and the colour under it is the network's best colour, with no cross-talk.
//
// Flip-book sheets (particles and ribbons with rows×columns cells) are cut into their cells first and every
// cell gets a gutter of its own edge pixels, so the network never sees one frame next to another and no frame
// bleeds into its neighbour. A texture something tiles (M2 texture flags 0x1/0x2) gets a gutter taken from the
// opposite edge instead, so the HD copy still tiles. The cells go back at exact multiples of their source
// position: cell (i, j) of the source covers exactly cell (i, j) × scale of the result.

/** Greatest common divisor / least common multiple of two positive integers. */
function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function lcm(a, b) {
  return (a / gcd(a, b)) * b;
}

/** The finest grid every listed flip-book layout lines up with: `{ rows, columns }` (1×1 for none). */
export function commonGrid(grids = []) {
  let rows = 1;
  let columns = 1;
  for (const [r, c] of grids) {
    rows = lcm(rows, r);
    columns = lcm(columns, c);
  }
  return { rows, columns };
}

/** `count + 1` boundaries splitting `size` pixels into `count` cells as evenly as integers allow. */
export function boundaries(size, count) {
  return Array.from({ length: count + 1 }, (_, index) => Math.round((index * size) / count));
}

/**
 * How one texture is laid out for the network.
 *
 * `cells` lists every source cell `{ sx, sy, sw, sh }` and where its padded copy sits in the work picture
 * (`ax`, `ay`, its top-left including the gutter). `pad` is the gutter on every side of every cell, in source
 * pixels. A grid finer than 4 source pixels a cell is not cut (the cells would be mostly gutter); such a sheet
 * is treated as one picture with edge gutters — never seen in the 3.3.5a effects, guarded anyway.
 */
export function planLayout(width, height, { grids = [], wrap = false, pad = 8 } = {}) {
  let { rows, columns } = commonGrid(grids);
  if (width / columns < 4 || height / rows < 4) rows = columns = 1;
  const xs = boundaries(width, columns);
  const ys = boundaries(height, rows);
  const cells = [];
  let ay = 0;
  for (let row = 0; row < rows; row++) {
    const sh = ys[row + 1] - ys[row];
    let ax = 0;
    for (let column = 0; column < columns; column++) {
      const sw = xs[column + 1] - xs[column];
      cells.push({ sx: xs[column], sy: ys[row], sw, sh, ax, ay });
      ax += sw + 2 * pad;
    }
    ay += sh + 2 * pad;
  }
  const workWidth = width + columns * 2 * pad;
  const workHeight = height + rows * 2 * pad;
  // A single wrapping picture takes its gutter from the opposite edge; a cell of a sheet never does (its
  // neighbour across the edge is another frame).
  const mode = wrap && rows === 1 && columns === 1 ? "wrap" : "clamp";
  return { width, height, rows, columns, pad, mode, cells, workWidth, workHeight };
}

function clampIndex(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

function wrapIndex(value, low, size) {
  return low + ((((value - low) % size) + size) % size);
}

/**
 * The two work pictures of one texture, `{ colour, alpha }` — each `{ width, height, data }` opaque RGBA.
 * `alpha` is undefined when every texel is fully opaque: there is nothing to upscale and the result keeps 255.
 */
export function buildWorkImages(image, layout) {
  const { width, data } = image;
  let opaque = true;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] !== 255) {
      opaque = false;
      break;
    }
  }
  const size = layout.workWidth * layout.workHeight * 4;
  const colour = new Uint8Array(size);
  const alpha = opaque ? undefined : new Uint8Array(size);
  const { pad, mode } = layout;
  for (const cell of layout.cells) {
    for (let y = -pad; y < cell.sh + pad; y++) {
      const sy = mode === "wrap" ? wrapIndex(cell.sy + y, cell.sy, cell.sh) : clampIndex(cell.sy + y, cell.sy, cell.sy + cell.sh - 1);
      for (let x = -pad; x < cell.sw + pad; x++) {
        const sx = mode === "wrap" ? wrapIndex(cell.sx + x, cell.sx, cell.sw) : clampIndex(cell.sx + x, cell.sx, cell.sx + cell.sw - 1);
        const from = (sy * width + sx) * 4;
        const to = ((cell.ay + pad + y) * layout.workWidth + cell.ax + pad + x) * 4;
        colour[to] = data[from];
        colour[to + 1] = data[from + 1];
        colour[to + 2] = data[from + 2];
        colour[to + 3] = 255;
        if (alpha) {
          const a = data[from + 3];
          alpha[to] = a;
          alpha[to + 1] = a;
          alpha[to + 2] = a;
          alpha[to + 3] = 255;
        }
      }
    }
  }
  return {
    colour: { width: layout.workWidth, height: layout.workHeight, data: colour },
    alpha: alpha && { width: layout.workWidth, height: layout.workHeight, data: alpha },
  };
}

/** 24.10 (7.48 step 3): below this alpha a texel's colour is not trusted as the network's input (`dilateUnderAlpha`). */
export const DILATE_ALPHA = 16;

/**
 * 24.10 (7.48 step 3): the colour under (nearly) transparent texels replaced by its visible neighbours', cell by cell —
 * what the network sees for a cut-out texture of the world set. A DXT1 leaf card is black wherever it is cut out, and
 * the network blended that black into the leaf's own edge: alpha-tested at ×2 every leaf had a dark rim and read darker
 * (lookdev el-trunk, 24.10). Texels with alpha < `DILATE_ALPHA` take the mean of their already-filled 8 neighbours,
 * ring after ring (`passes`); any left keep their colour. A wrapping layout looks across the opposite edge, a cell
 * never into its neighbour. The colour under alpha 0 of the result is put back by `assemble` (`under`), so an
 * additive no-alpha draw still sees the original's colour there. Returns a new image.
 */
export function dilateUnderAlpha(image, layout, passes = 32) {
  const { width, data } = image;
  const out = Uint8Array.from(data);
  const filled = new Uint8Array(image.width * image.height);
  for (let index = 0; index < filled.length; index++) filled[index] = data[index * 4 + 3] >= DILATE_ALPHA ? 1 : 0;
  for (const cell of layout.cells) {
    for (let pass = 0; pass < passes; pass++) {
      const next = [];
      for (let y = cell.sy; y < cell.sy + cell.sh; y++) {
        for (let x = cell.sx; x < cell.sx + cell.sw; x++) {
          if (filled[y * width + x]) continue;
          const sum = [0, 0, 0];
          let count = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              let nx = x + dx;
              let ny = y + dy;
              if (layout.mode === "wrap") {
                nx = cell.sx + ((((nx - cell.sx) % cell.sw) + cell.sw) % cell.sw);
                ny = cell.sy + ((((ny - cell.sy) % cell.sh) + cell.sh) % cell.sh);
              } else if (nx < cell.sx || ny < cell.sy || nx >= cell.sx + cell.sw || ny >= cell.sy + cell.sh) {
                continue;
              }
              const at = ny * width + nx;
              if (!filled[at]) continue;
              for (let channel = 0; channel < 3; channel++) sum[channel] += out[at * 4 + channel];
              count++;
            }
          }
          if (count > 0) next.push([y * width + x, sum.map((value) => Math.round(value / count))]);
        }
      }
      if (next.length === 0) break;
      for (const [at, colour] of next) {
        out.set(colour, at * 4);
        filled[at] = 1;
      }
    }
  }
  return { width: image.width, height: image.height, data: out };
}

/**
 * Alpha this close to 0 or 255 is snapped to it. The network leaves a faint ±1–2 haze over flat regions; on an
 * additive or blended quad a 1/255 floor everywhere is a visible grey card around the particle.
 */
export const ALPHA_SNAP = 3;

/**
 * Puts the upscaled work pictures back into one RGBA texture `scale` times the source in each direction.
 *
 * `colour` and `alpha` are the network's outputs (`{ width, height, data }`, RGB or RGBA at 3 or 4 channels;
 * `channels` says which). Each cell is cut out of its gutter at exact multiples and pasted where the source
 * cell was × scale. Alpha is the mean of the grey picture's three channels, snapped near the ends.
 * 24.10 (7.48 step 3): `under` (the source image) — where the result's alpha is 0, the colour is the source texel's
 * own (nearest), as it was before `dilateUnderAlpha` painted it for the network.
 */
export function assemble(layout, scale, colour, alpha, channels = 4, under = undefined) {
  const width = layout.width * scale;
  const height = layout.height * scale;
  const expectedWidth = layout.workWidth * scale;
  const expectedHeight = layout.workHeight * scale;
  for (const [name, picture] of [["colour", colour], ["alpha", alpha]]) {
    if (picture && (picture.width !== expectedWidth || picture.height !== expectedHeight)) {
      throw new Error(`${name} work picture is ${picture.width}×${picture.height}, expected ${expectedWidth}×${expectedHeight}`);
    }
  }
  const out = new Uint8Array(width * height * 4);
  const pad = layout.pad * scale;
  for (const cell of layout.cells) {
    for (let y = 0; y < cell.sh * scale; y++) {
      const workRow = (cell.ay * scale + pad + y) * expectedWidth;
      const outRow = (cell.sy * scale + y) * width;
      for (let x = 0; x < cell.sw * scale; x++) {
        const from = (workRow + cell.ax * scale + pad + x) * channels;
        const to = (outRow + cell.sx * scale + x) * 4;
        out[to] = colour.data[from];
        out[to + 1] = colour.data[from + 1];
        out[to + 2] = colour.data[from + 2];
        if (alpha) {
          const a = Math.round((alpha.data[from] + alpha.data[from + 1] + alpha.data[from + 2]) / 3);
          out[to + 3] = a < ALPHA_SNAP ? 0 : a > 255 - ALPHA_SNAP ? 255 : a;
          if (under && out[to + 3] === 0) { // 24.10 (7.48 step 3)
            const source = ((cell.sy + Math.floor(y / scale)) * under.width + cell.sx + Math.floor(x / scale)) * 4;
            out[to] = under.data[source];
            out[to + 1] = under.data[source + 1];
            out[to + 2] = under.data[source + 2];
          }
        } else {
          out[to + 3] = 255;
        }
      }
    }
  }
  return { width, height, data: out };
}

/**
 * How far an HD texture strays from its source: the HD picture box-averaged back to the source size, compared
 * texel by texel. `{ colour, alpha }` are mean absolute differences in 0–255 units; colour is weighted by the
 * source's alpha (what is under alpha 0 is never seen, under alpha 10 barely). On the 725 effect textures a
 * faithful upscale lands at 0–37 (thin lines — snowflakes, webs, grass — sharpen the most); a corrupted run (the
 * lost GPU device of 23.10: noise) measured 80. The tool keeps the original for anything past `FIDELITY_LIMIT`.
 */
export function fidelity(hd, source, scale) {
  let colour = 0;
  let colourCount = 0;
  let alpha = 0;
  const area = scale * scale;
  for (let y = 0; y < source.height; y++) {
    for (let x = 0; x < source.width; x++) {
      const sums = [0, 0, 0, 0];
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const at = ((y * scale + dy) * hd.width + x * scale + dx) * 4;
          for (let channel = 0; channel < 4; channel++) sums[channel] += hd.data[at + channel];
        }
      }
      const at = (y * source.width + x) * 4;
      alpha += Math.abs(sums[3] / area - source.data[at + 3]);
      const weight = source.data[at + 3] / 255;
      if (weight === 0) continue;
      for (let channel = 0; channel < 3; channel++) colour += weight * Math.abs(sums[channel] / area - source.data[at + channel]);
      colourCount += 3 * weight;
    }
  }
  const texels = source.width * source.height;
  return { colour: colourCount ? colour / colourCount : 0, alpha: texels ? alpha / texels : 0 };
}

/** Past this mean difference (either channel group) an HD texture is not used (see `fidelity`). */
export const FIDELITY_LIMIT = 50;

/**
 * The scale an effect texture gets: ×4 while that stays within `limit` pixels a side, else the largest power
 * of two that does (×2), else 1 (not upscaled). 16–128 px → ×4, 256 px → ×2 at the default 512.
 */
export function effectScale(width, height, limit = 512) {
  const side = Math.max(width, height);
  for (const scale of [4, 2]) if (side * scale <= limit) return scale;
  return 1;
}
