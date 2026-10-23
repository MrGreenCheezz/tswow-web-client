// 23.10 (7.48): the GPU-compressed form of the world HD set — BC7 (BPTC), a mip chain and a small container.
//
// Why BC7: an HD world texture is ×2 a side, so four times the texels. Uploaded as RGBA8 like every texture today it
// would take four times the GPU memory; BC7 is one byte a texel, so the HD copy costs what the original costs now.
// Chrome on D3D11 (ANGLE) exposes it as `EXT_texture_compression_bptc`, sRGB included
// (COMPRESSED_SRGB_ALPHA_BPTC_UNORM_EXT); the browser asks for this form only where the extension is present and
// keeps the original texture otherwise (src/browser/HdWorldTextures.ts). BC1/BC3 (S3TC) would be the same memory
// for BC3 and half for BC1, but four colours a 4×4 block on a 5:6:5 line is visibly blotchy on smooth upscaled
// stone and grass; BC7 mode 6 keeps 7-bit endpoints and sixteen steps between them.
//
// The encoder writes only mode 6 (one subset, RGBA endpoints 7 bits + a shared p-bit, 4-bit indices): a principal
// axis fit, then two least-squares refinements of the endpoints against the chosen indices, every p-bit pair tried
// for blocks with alpha (opaque blocks keep p = 1 so alpha stays exactly 255). Pure functions over straight RGBA.
//
// Container `WHT1` (little-endian), one file a texture, served as `application/x-webclient-hd-texture`:
//   0  "WHT1"   4  format (1 = BC7, sRGB colour)   8  width   12  height   16  levels   20  flags (bit 0: opaque)
//   24 levels × { u32 offset, u32 byteLength }, then the levels, largest first, each 16-byte aligned.
// `src/browser/HdTextureContainer.ts` parses it (a test holds the two in agreement).

export const CONTAINER_MAGIC = "WHT1";
export const CONTAINER_FORMAT_BC7_SRGB = 1;
export const CONTAINER_FLAG_OPAQUE = 1;
export const CONTAINER_CONTENT_TYPE = "application/x-webclient-hd-texture";
const HEADER_BYTES = 24;

/** BC7's 4-bit interpolation weights (of 64). */
export const WEIGHTS4 = Object.freeze([0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64]);

function interpolate(e0, e1, weight) {
  return ((64 - weight) * e0 + weight * e1 + 32) >> 6;
}

/** A 7-bit endpoint channel and its p-bit as the 8-bit value the decoder rebuilds. */
function quantise(value, pbit) {
  let q = Math.round((value - pbit) / 2);
  if (q < 0) q = 0;
  else if (q > 127) q = 127;
  return q;
}

const scratchPalette = new Int32Array(64);

/**
 * Indices and squared error of 16 pixels against the palette of two 8-bit endpoints (`e0`, `e1`: 4 values each).
 * `indices` (16) is written.
 */
function assign(pixels, e0, e1, indices) {
  const palette = scratchPalette;
  for (let step = 0; step < 16; step++) {
    const w = WEIGHTS4[step];
    for (let channel = 0; channel < 4; channel++) palette[step * 4 + channel] = interpolate(e0[channel], e1[channel], w);
  }
  let total = 0;
  for (let pixel = 0; pixel < 16; pixel++) {
    const r = pixels[pixel * 4];
    const g = pixels[pixel * 4 + 1];
    const b = pixels[pixel * 4 + 2];
    const a = pixels[pixel * 4 + 3];
    let best = 0;
    let bestError = Infinity;
    for (let step = 0; step < 16; step++) {
      const dr = palette[step * 4] - r;
      const dg = palette[step * 4 + 1] - g;
      const db = palette[step * 4 + 2] - b;
      const da = palette[step * 4 + 3] - a;
      const error = dr * dr + dg * dg + db * db + da * da;
      if (error < bestError) {
        bestError = error;
        best = step;
        if (error === 0) break;
      }
    }
    indices[pixel] = best;
    total += bestError;
  }
  return total;
}

/** The pbit pairs a block is tried with: opaque blocks only (1, 1), so alpha 127·2+1 = 255 exactly. */
const PBITS_OPAQUE = [[1, 1]];
const PBITS_ALL = [[0, 0], [0, 1], [1, 0], [1, 1]];

/**
 * Quantises float endpoints with every allowed p-bit pair and keeps the best: `{ error, q0, q1, p0, p1, indices }`.
 */
function bestQuantised(pixels, f0, f1, pbits, best) {
  const e0 = [0, 0, 0, 0];
  const e1 = [0, 0, 0, 0];
  const q0 = [0, 0, 0, 0];
  const q1 = [0, 0, 0, 0];
  const indices = new Uint8Array(16);
  for (const [p0, p1] of pbits) {
    for (let channel = 0; channel < 4; channel++) {
      q0[channel] = quantise(f0[channel], p0);
      q1[channel] = quantise(f1[channel], p1);
      e0[channel] = (q0[channel] << 1) | p0;
      e1[channel] = (q1[channel] << 1) | p1;
    }
    const error = assign(pixels, e0, e1, indices);
    if (error < best.error) {
      best.error = error;
      best.q0 = [...q0];
      best.q1 = [...q1];
      best.p0 = p0;
      best.p1 = p1;
      best.indices = Uint8Array.from(indices);
    }
  }
  return best;
}

/** Least-squares endpoints for fixed indices; undefined when every pixel took the same weight. */
function refit(pixels, indices) {
  let aa = 0;
  let ab = 0;
  let bb = 0;
  const ap = [0, 0, 0, 0];
  const bp = [0, 0, 0, 0];
  for (let pixel = 0; pixel < 16; pixel++) {
    const b = WEIGHTS4[indices[pixel]] / 64;
    const a = 1 - b;
    aa += a * a;
    ab += a * b;
    bb += b * b;
    for (let channel = 0; channel < 4; channel++) {
      ap[channel] += a * pixels[pixel * 4 + channel];
      bp[channel] += b * pixels[pixel * 4 + channel];
    }
  }
  const det = aa * bb - ab * ab;
  if (Math.abs(det) < 1e-9) return undefined;
  const f0 = [0, 0, 0, 0];
  const f1 = [0, 0, 0, 0];
  for (let channel = 0; channel < 4; channel++) {
    f0[channel] = Math.min(255, Math.max(0, (bb * ap[channel] - ab * bp[channel]) / det));
    f1[channel] = Math.min(255, Math.max(0, (aa * bp[channel] - ab * ap[channel]) / det));
  }
  return { f0, f1 };
}

/** The principal axis fit: float endpoints at the extremes of the pixels' projection on it. */
function axisEndpoints(pixels) {
  const mean = [0, 0, 0, 0];
  for (let pixel = 0; pixel < 16; pixel++) for (let channel = 0; channel < 4; channel++) mean[channel] += pixels[pixel * 4 + channel];
  for (let channel = 0; channel < 4; channel++) mean[channel] /= 16;
  const cov = new Float64Array(16);
  for (let pixel = 0; pixel < 16; pixel++) {
    for (let i = 0; i < 4; i++) {
      const di = pixels[pixel * 4 + i] - mean[i];
      for (let j = i; j < 4; j++) cov[i * 4 + j] += di * (pixels[pixel * 4 + j] - mean[j]);
    }
  }
  for (let i = 0; i < 4; i++) for (let j = 0; j < i; j++) cov[i * 4 + j] = cov[j * 4 + i];
  // Power iteration from the channel with the widest spread.
  let axis = [0, 0, 0, 0];
  let widest = 0;
  for (let channel = 1; channel < 4; channel++) if (cov[channel * 5] > cov[widest * 5]) widest = channel;
  axis[widest] = 1;
  for (let iteration = 0; iteration < 8; iteration++) {
    const next = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) next[i] += cov[i * 4 + j] * axis[j];
    const length = Math.hypot(...next);
    if (length < 1e-12) break;
    axis = next.map((value) => value / length);
  }
  let low = Infinity;
  let high = -Infinity;
  for (let pixel = 0; pixel < 16; pixel++) {
    let t = 0;
    for (let channel = 0; channel < 4; channel++) t += (pixels[pixel * 4 + channel] - mean[channel]) * axis[channel];
    if (t < low) low = t;
    if (t > high) high = t;
  }
  const clamp = (value) => Math.min(255, Math.max(0, value));
  return {
    f0: mean.map((value, channel) => clamp(value + low * axis[channel])),
    f1: mean.map((value, channel) => clamp(value + high * axis[channel])),
  };
}

/** Writes `count` bits of `value` at `position` (LSB first), returns the next position. */
function putBits(block, position, value, count) {
  for (let bit = 0; bit < count; bit++, position++) {
    if ((value >> bit) & 1) block[position >> 3] |= 1 << (position & 7);
  }
  return position;
}

function getBits(block, position, count) {
  let value = 0;
  for (let bit = 0; bit < count; bit++, position++) value |= ((block[position >> 3] >> (position & 7)) & 1) << bit;
  return value;
}

/**
 * One 4×4 block (16 RGBA pixels, row-major, 64 bytes) as a BC7 mode 6 block (16 bytes, into `out` at `at`).
 * Returns the block's squared error (sum over 16 pixels × 4 channels).
 */
export function encodeBc7Block(pixels, out = new Uint8Array(16), at = 0) {
  let opaque = true;
  for (let pixel = 0; pixel < 16; pixel++) if (pixels[pixel * 4 + 3] !== 255) { opaque = false; break; }
  const pbits = opaque ? PBITS_OPAQUE : PBITS_ALL;
  const best = { error: Infinity, q0: undefined, q1: undefined, p0: 1, p1: 1, indices: undefined };
  const start = axisEndpoints(pixels);
  bestQuantised(pixels, start.f0, start.f1, pbits, best);
  for (let iteration = 0; iteration < 2 && best.error > 0; iteration++) {
    const fit = refit(pixels, best.indices);
    if (!fit) break;
    const before = best.error;
    bestQuantised(pixels, fit.f0, fit.f1, pbits, best);
    if (best.error >= before) break;
  }
  let { q0, q1, p0, p1, indices } = best;
  // The anchor (pixel 0) stores 3 bits: its index must be < 8, so swap the endpoints when it is not.
  if (indices[0] >= 8) {
    [q0, q1] = [q1, q0];
    [p0, p1] = [p1, p0];
    indices = indices.map((index) => 15 - index);
  }
  const block = out.subarray(at, at + 16);
  block.fill(0);
  let position = putBits(block, 0, 1 << 6, 7);
  for (let channel = 0; channel < 4; channel++) {
    position = putBits(block, position, q0[channel], 7);
    position = putBits(block, position, q1[channel], 7);
  }
  position = putBits(block, position, p0, 1);
  position = putBits(block, position, p1, 1);
  position = putBits(block, position, indices[0], 3);
  for (let pixel = 1; pixel < 16; pixel++) position = putBits(block, position, indices[pixel], 4);
  return best.error;
}

/**
 * Decodes one BC7 block (mode 6 only — what `encodeBc7Block` writes) into 16 RGBA pixels. Throws on another mode:
 * this is for the tool's own checks, not a general decoder.
 */
export function decodeBc7Block(block, out = new Uint8Array(64)) {
  if ((block[0] & 0x7f) !== 0x40) throw new Error(`BC7 block mode ${block[0]} is not mode 6`);
  let position = 7;
  const q0 = [0, 0, 0, 0];
  const q1 = [0, 0, 0, 0];
  for (let channel = 0; channel < 4; channel++) {
    q0[channel] = getBits(block, position, 7);
    position += 7;
    q1[channel] = getBits(block, position, 7);
    position += 7;
  }
  const p0 = getBits(block, position++, 1);
  const p1 = getBits(block, position++, 1);
  const e0 = q0.map((q) => (q << 1) | p0);
  const e1 = q1.map((q) => (q << 1) | p1);
  for (let pixel = 0; pixel < 16; pixel++) {
    const bits = pixel === 0 ? 3 : 4;
    const index = getBits(block, position, bits);
    position += bits;
    for (let channel = 0; channel < 4; channel++) out[pixel * 4 + channel] = interpolate(e0[channel], e1[channel], WEIGHTS4[index]);
  }
  return out;
}

/** Bytes of one BC7 level: 16 a 4×4 block, partial blocks rounded up. */
export function bc7LevelBytes(width, height) {
  return Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
}

/**
 * One image (`{ width, height, data }` straight RGBA) as BC7 blocks. Edge blocks of a side that is not a multiple
 * of 4 repeat the last row/column. `{ data, error }`: error is the mean squared error per channel.
 */
export function encodeBc7Image(image) {
  const { width, height, data } = image;
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const out = new Uint8Array(blocksX * blocksY * 16);
  const pixels = new Uint8Array(64);
  let error = 0;
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      for (let y = 0; y < 4; y++) {
        const sy = Math.min(height - 1, by * 4 + y);
        for (let x = 0; x < 4; x++) {
          const sx = Math.min(width - 1, bx * 4 + x);
          const from = (sy * width + sx) * 4;
          const to = (y * 4 + x) * 4;
          pixels[to] = data[from];
          pixels[to + 1] = data[from + 1];
          pixels[to + 2] = data[from + 2];
          pixels[to + 3] = data[from + 3];
        }
      }
      error += encodeBc7Block(pixels, out, (by * blocksX + bx) * 16);
    }
  }
  return { data: out, error: error / (blocksX * blocksY * 64) };
}

/** BC7 blocks back to straight RGBA (`width` × `height`). */
export function decodeBc7Image(blocks, width, height) {
  const blocksX = Math.ceil(width / 4);
  const blocksY = Math.ceil(height / 4);
  const data = new Uint8Array(width * height * 4);
  const pixels = new Uint8Array(64);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      decodeBc7Block(blocks.subarray((by * blocksX + bx) * 16, (by * blocksX + bx) * 16 + 16), pixels);
      for (let y = 0; y < 4; y++) {
        const dy = by * 4 + y;
        if (dy >= height) break;
        for (let x = 0; x < 4; x++) {
          const dx = bx * 4 + x;
          if (dx >= width) break;
          data.set(pixels.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4), (dy * width + dx) * 4);
        }
      }
    }
  }
  return { width, height, data };
}

const SRGB_TO_LINEAR = new Float64Array(256);
for (let value = 0; value < 256; value++) {
  const c = value / 255;
  SRGB_TO_LINEAR[value] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value) {
  const c = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(c * 255)));
}

/**
 * The next mip level: a 2×2 box (2×1 / 1×2 at a side of 1), colour averaged in linear light as the GPU's own
 * `generateMipmap` filters an sRGB texture (D3D11 GenerateMips), alpha averaged as stored.
 */
export function halveImage(image) {
  const { width, height, data } = image;
  const outWidth = Math.max(1, width >> 1);
  const outHeight = Math.max(1, height >> 1);
  const stepX = width > 1 ? 2 : 1;
  const stepY = height > 1 ? 2 : 1;
  const out = new Uint8Array(outWidth * outHeight * 4);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const sums = [0, 0, 0, 0];
      for (let dy = 0; dy < stepY; dy++) {
        for (let dx = 0; dx < stepX; dx++) {
          const at = ((y * stepY + dy) * width + x * stepX + dx) * 4;
          sums[0] += SRGB_TO_LINEAR[data[at]];
          sums[1] += SRGB_TO_LINEAR[data[at + 1]];
          sums[2] += SRGB_TO_LINEAR[data[at + 2]];
          sums[3] += data[at + 3];
        }
      }
      const count = stepX * stepY;
      const at = (y * outWidth + x) * 4;
      out[at] = linearToSrgb(sums[0] / count);
      out[at + 1] = linearToSrgb(sums[1] / count);
      out[at + 2] = linearToSrgb(sums[2] / count);
      out[at + 3] = Math.round(sums[3] / count);
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}

/** Every level from `image` down to 1×1, largest first. */
export function mipChain(image) {
  const levels = [image];
  let current = image;
  while (current.width > 1 || current.height > 1) {
    current = halveImage(current);
    levels.push(current);
  }
  return levels;
}

/**
 * Bilinear resample with wrapping (both directions tile) to `width` × `height` — the ground HD copy is put on the
 * one side the terrain array uses (512), as the gateway's own layers are resampled to the array side.
 */
export function resampleWrapped(image, width, height) {
  if (image.width === width && image.height === height) return image;
  const out = new Uint8Array(width * height * 4);
  const { data } = image;
  for (let y = 0; y < height; y++) {
    const fy = ((y + 0.5) * image.height) / height - 0.5;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const ya = ((y0 % image.height) + image.height) % image.height;
    const yb = (ya + 1) % image.height;
    for (let x = 0; x < width; x++) {
      const fx = ((x + 0.5) * image.width) / width - 0.5;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const xa = ((x0 % image.width) + image.width) % image.width;
      const xb = (xa + 1) % image.width;
      for (let channel = 0; channel < 4; channel++) {
        const top = data[(ya * image.width + xa) * 4 + channel] * (1 - tx) + data[(ya * image.width + xb) * 4 + channel] * tx;
        const bottom = data[(yb * image.width + xa) * 4 + channel] * (1 - tx) + data[(yb * image.width + xb) * 4 + channel] * tx;
        out[(y * width + x) * 4 + channel] = Math.round(top * (1 - ty) + bottom * ty);
      }
    }
  }
  return { width, height, data: out };
}

/** Whether every texel's alpha is 255. */
export function isOpaque(image) {
  for (let index = 3; index < image.data.length; index += 4) if (image.data[index] !== 255) return false;
  return true;
}

/**
 * The whole compressed texture: `{ bytes, levels, width, height, opaque, error }` — `error` is the mean squared error
 * per channel of level 0 (sRGB values). `opaque: true` forces alpha to 255 first (the ground: the terrain shader reads
 * only colour).
 */
export function compressTexture(image, { forceOpaque = false } = {}) {
  let base = image;
  if (forceOpaque) {
    const data = Uint8Array.from(image.data);
    for (let index = 3; index < data.length; index += 4) data[index] = 255;
    base = { width: image.width, height: image.height, data };
  }
  const opaque = forceOpaque || isOpaque(base);
  const levels = mipChain(base).map((level, index) => {
    const encoded = encodeBc7Image(level);
    return { width: level.width, height: level.height, data: encoded.data, error: index === 0 ? encoded.error : undefined };
  });
  return {
    bytes: encodeContainer({ width: base.width, height: base.height, opaque, levels }),
    levels: levels.length, width: base.width, height: base.height, opaque, error: levels[0].error,
  };
}

/** The `WHT1` container around BC7 levels (`{ width, height, data }`, largest first). */
export function encodeContainer({ width, height, opaque, levels }) {
  let offset = HEADER_BYTES + levels.length * 8;
  offset = (offset + 15) & ~15;
  const table = [];
  for (const level of levels) {
    if (level.data.length !== bc7LevelBytes(level.width, level.height)) throw new Error("BC7 level has the wrong size");
    table.push({ offset, length: level.data.length });
    offset += level.data.length;
  }
  const bytes = new Uint8Array(offset);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < 4; index++) bytes[index] = CONTAINER_MAGIC.charCodeAt(index);
  view.setUint32(4, CONTAINER_FORMAT_BC7_SRGB, true);
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  view.setUint32(16, levels.length, true);
  view.setUint32(20, opaque ? CONTAINER_FLAG_OPAQUE : 0, true);
  for (const [index, entry] of table.entries()) {
    view.setUint32(HEADER_BYTES + index * 8, entry.offset, true);
    view.setUint32(HEADER_BYTES + index * 8 + 4, entry.length, true);
    bytes.set(levels[index].data, entry.offset);
  }
  return bytes;
}

/** The container back to `{ format, width, height, opaque, levels: [{ width, height, data }] }` (tests, the bench). */
export function decodeContainer(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < HEADER_BYTES || String.fromCharCode(...bytes.subarray(0, 4)) !== CONTAINER_MAGIC) throw new Error("Not a WHT1 container");
  const format = view.getUint32(4, true);
  const width = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  const count = view.getUint32(16, true);
  const opaque = (view.getUint32(20, true) & CONTAINER_FLAG_OPAQUE) !== 0;
  const levels = [];
  for (let index = 0; index < count; index++) {
    const offset = view.getUint32(HEADER_BYTES + index * 8, true);
    const length = view.getUint32(HEADER_BYTES + index * 8 + 4, true);
    levels.push({ width: Math.max(1, width >> index), height: Math.max(1, height >> index), data: bytes.subarray(offset, offset + length) });
  }
  return { format, width, height, opaque, levels };
}
