/**
 * 22.10 (7.47): height and normal maps for the ground textures, derived from the textures themselves.
 *
 * 3.3.5a ships no height maps. A ground texture's own brightness is the best height it has: stones
 * are lighter than the grooves between them, cracks are darker than the plates they split. Raw
 * luminance is not height, though — a texture painted with a light patch on one side would become a
 * hill — so it is band-passed: the large-scale shading (anything wider than about a fifth of the
 * texture) is subtracted, and the single-texel noise is smoothed away. Where the tile carries the
 * `_s.blp` specular mask (7.16 Г) it is mixed in at a third: its highlights sit on the raised parts
 * of a stone and its dark on the moss in the joints, which luminance alone reads the wrong way.
 *
 * The result is one RGBA8 texel per output texel: RG the tangent-space normal (the texture's own u,
 * v), B the height (0 deep, 255 high, 128 the mean), A 255. Pure and allocation-bounded, so it runs
 * the same in the derivation worker (`TerrainRelief.worker.ts`), inline where there is no worker,
 * and in the Node tests.
 */

/** 22.10 (7.47): the relief map is half the layer's side (a 256² layer gives 128²): a quarter of the memory. */
export const TERRAIN_RELIEF_DOWNSAMPLE = 2;
/** 22.10 (7.47): the high-pass radius as a fraction of the side — shading wider than this is not height. */
export const TERRAIN_RELIEF_LARGE_RADIUS = 12 / 128;
/** 22.10 (7.47): the specular mask's share of the height where a layer has one. */
export const TERRAIN_RELIEF_MASK_WEIGHT = 0.3;
/**
 * 22.10 (7.47): the band-passed contrast (luminance 0–1, one standard deviation) below which a texture
 * gets proportionally less relief. Sand and snow stay nearly flat; cobbles and cracked earth, well
 * above it, are normalised to the full range.
 */
export const TERRAIN_RELIEF_CONTRAST_FLOOR = 0.045;
/** 22.10 (7.47): how many standard deviations reach the top (and bottom) of the height range. */
export const TERRAIN_RELIEF_SPAN = 2.5;
/**
 * 22.10 (7.47): the relief's depth in detail-UV units (one unit is one repeat of the texture, about
 * 4.2 yards: `SPLAT_REPEAT` 128 over a 533⅓-yard tile). 0.03 is ≈ 12.5 cm from the top of a stone to
 * the bottom of its joint. The shader marches the same depth, so normals and parallax agree.
 */
export const TERRAIN_RELIEF_DEPTH = 0.03;
/** 22.10 (7.47): the normals' slope over the geometric one the depth implies (1: they agree; 1.5 read lumpy in the stills). */
export const TERRAIN_RELIEF_NORMAL_BOOST = 1.0;
/**
 * 22.10 (7.47, owner): passes of the [1 2 1] smoothing after the high-pass. One left too many sharp bumps in
 * play («слишком много острых выпуклостей»); two were better, and the owner asked for «ещё малость» — three are a
 * 7-tap binomial, which rounds the stones' crowns and still keeps the joints.
 */
export const TERRAIN_RELIEF_SMOOTH_PASSES = 3;

export interface TerrainReliefInput {
  /** The decoded layer, RGBA8, `size`² texels, row 0 at v = 0 (as the layer array uploads it). */
  readonly pixels: ArrayLike<number>;
  readonly size: number;
  /** Optional `_s.blp` mask, the same size, grey in R. */
  readonly mask?: ArrayLike<number> | undefined;
}

/**
 * 22.10 (7.47 stage 2): what a derivation measured on its way — the band-passed luminance's standard
 * deviation (0–1 luminance) before it is normalised. The WMO relief (`WmoReliefDerive.ts`) leaves a
 * texture below its own floor flat rather than lifting it to the full range.
 */
export interface TerrainReliefStats {
  contrast: number;
}

/** 22.10 (7.47): the side of the relief map a layer of `size` gets. */
export function terrainReliefSize(size: number): number {
  return Math.max(1, Math.floor(size / TERRAIN_RELIEF_DOWNSAMPLE));
}

/**
 * 22.10 (7.47): the height alone (0–1 per output texel, 0.5 the mean) — the first half of
 * {@link deriveTerrainRelief}, exported for the tests that pin the band-pass.
 */
export function terrainReliefHeight(input: TerrainReliefInput, stats?: TerrainReliefStats): Float32Array {
  const { pixels, size, mask } = input;
  if (!Number.isInteger(size) || size < 2 || pixels.length < size * size * 4) {
    throw new Error(`terrain relief needs ${size}² RGBA texels`);
  }
  const side = terrainReliefSize(size);
  const luma = downsampleChannel(pixels, size, side, lumaOf);
  const heightZ = bandPass(luma, side, stats);
  if (mask && mask.length >= size * size * 4) {
    const maskZ = bandPass(downsampleChannel(mask, size, side, (data, offset) => data[offset]! / 255), side);
    for (let index = 0; index < heightZ.length; index++) {
      heightZ[index] = (1 - TERRAIN_RELIEF_MASK_WEIGHT) * heightZ[index]! + TERRAIN_RELIEF_MASK_WEIGHT * maskZ[index]!;
    }
  }
  const scale = 0.5 / TERRAIN_RELIEF_SPAN;
  for (let index = 0; index < heightZ.length; index++) {
    heightZ[index] = Math.min(1, Math.max(0, 0.5 + heightZ[index]! * scale));
  }
  return heightZ;
}

/** 22.10 (7.47): the relief map (RG normal, B height, A 255) of one layer; see the file comment. */
export function deriveTerrainRelief(input: TerrainReliefInput, stats?: TerrainReliefStats): Uint8Array {
  const side = terrainReliefSize(input.size);
  const height = terrainReliefHeight(input, stats);
  const out = new Uint8Array(side * side * 4);
  // Height 0–1 spans TERRAIN_RELIEF_DEPTH of detail UV; a texel is 1/side of it. dh/du in UV units
  // is (Δh per texel) · side · depth.
  const slope = side * TERRAIN_RELIEF_DEPTH * TERRAIN_RELIEF_NORMAL_BOOST;
  for (let y = 0; y < side; y++) {
    const up = ((y + side - 1) % side) * side;
    const down = ((y + 1) % side) * side;
    const row = y * side;
    for (let x = 0; x < side; x++) {
      const left = (x + side - 1) % side;
      const right = (x + 1) % side;
      const dhdu = (height[row + right]! - height[row + left]!) * 0.5 * slope;
      const dhdv = (height[down + x]! - height[up + x]!) * 0.5 * slope;
      const nx = -dhdu;
      const ny = -dhdv;
      const inverse = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const offset = (row + x) * 4;
      out[offset] = Math.round((nx * inverse * 0.5 + 0.5) * 255);
      out[offset + 1] = Math.round((ny * inverse * 0.5 + 0.5) * 255);
      out[offset + 2] = Math.round(height[row + x]! * 255);
      out[offset + 3] = 255;
    }
  }
  return out;
}

function lumaOf(data: ArrayLike<number>, offset: number): number {
  return (0.2126 * data[offset]! + 0.7152 * data[offset + 1]! + 0.0722 * data[offset + 2]!) / 255;
}

/** Box-averages `size`² texels down to `side`² values of one channel. */
function downsampleChannel(
  data: ArrayLike<number>, size: number, side: number,
  read: (data: ArrayLike<number>, offset: number) => number,
): Float32Array {
  const factor = size / side;
  const out = new Float32Array(side * side);
  const block = Math.max(1, Math.floor(factor));
  const weight = 1 / (block * block);
  for (let y = 0; y < side; y++) {
    const sourceY = Math.floor(y * factor);
    for (let x = 0; x < side; x++) {
      const sourceX = Math.floor(x * factor);
      let sum = 0;
      for (let dy = 0; dy < block; dy++) {
        const rowOffset = ((sourceY + dy) % size) * size;
        for (let dx = 0; dx < block; dx++) sum += read(data, (rowOffset + (sourceX + dx) % size) * 4);
      }
      out[y * side + x] = sum * weight;
    }
  }
  return out;
}

/**
 * The band-pass, in standard deviations of its own output (floored by the contrast floor): the value
 * minus its wrap-around Gaussian (three box passes) at the large radius, then `TERRAIN_RELIEF_SMOOTH_PASSES` [1 2 1] smoothings.
 */
function bandPass(values: Float32Array, side: number, stats?: TerrainReliefStats): Float32Array {
  const radius = Math.max(1, Math.round(side * TERRAIN_RELIEF_LARGE_RADIUS));
  const low = values.slice();
  const scratch = new Float32Array(values.length);
  for (let pass = 0; pass < 3; pass++) {
    boxBlurWrap(low, scratch, side, radius, true);
    boxBlurWrap(scratch, low, side, radius, false);
  }
  const high = new Float32Array(values.length);
  for (let index = 0; index < values.length; index++) high[index] = values[index]! - low[index]!;
  for (let pass = 0; pass < TERRAIN_RELIEF_SMOOTH_PASSES; pass++) smoothWrap(high, scratch, side);
  let sum = 0;
  let squares = 0;
  for (let index = 0; index < high.length; index++) {
    sum += high[index]!;
    squares += high[index]! * high[index]!;
  }
  const mean = sum / high.length;
  const deviation = Math.sqrt(Math.max(0, squares / high.length - mean * mean));
  if (stats) stats.contrast = deviation; // 22.10 (7.47 stage 2)
  const inverse = 1 / Math.max(deviation, TERRAIN_RELIEF_CONTRAST_FLOOR);
  for (let index = 0; index < high.length; index++) high[index] = (high[index]! - mean) * inverse;
  return high;
}

/** One running-sum box blur along rows (`horizontal`) or columns, wrapping at the edges (the texture tiles). */
function boxBlurWrap(source: Float32Array, target: Float32Array, side: number, radius: number, horizontal: boolean): void {
  const width = radius * 2 + 1;
  const inverse = 1 / width;
  const at = (line: number, position: number) => {
    const wrapped = ((position % side) + side) % side;
    return horizontal ? line * side + wrapped : wrapped * side + line;
  };
  for (let line = 0; line < side; line++) {
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset++) sum += source[at(line, offset)]!;
    for (let position = 0; position < side; position++) {
      target[at(line, position)] = sum * inverse;
      sum += source[at(line, position + radius + 1)]! - source[at(line, position - radius)]!;
    }
  }
}

/** A separable [1 2 1]/4 smoothing in place (wrapping), through `scratch`. */
function smoothWrap(values: Float32Array, scratch: Float32Array, side: number): void {
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const row = y * side;
      scratch[row + x] = 0.25 * values[row + (x + side - 1) % side]! + 0.5 * values[row + x]! + 0.25 * values[row + (x + 1) % side]!;
    }
  }
  for (let y = 0; y < side; y++) {
    const up = ((y + side - 1) % side) * side;
    const down = ((y + 1) % side) * side;
    for (let x = 0; x < side; x++) {
      values[y * side + x] = 0.25 * scratch[up + x]! + 0.5 * scratch[y * side + x]! + 0.25 * scratch[down + x]!;
    }
  }
}
