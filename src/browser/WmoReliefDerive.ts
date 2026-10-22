import { deriveTerrainRelief, terrainReliefSize, type TerrainReliefInput, type TerrainReliefStats } from "./TerrainReliefDerive.js";

/**
 * 22.10 (7.47 stage 2): the relief maps of building (WMO) textures — the ground's derivation
 * (`TerrainReliefDerive.ts`: band-passed luminance, three [1 2 1] smoothings, the owner's taste)
 * applied to a WMO texture, which is any size and often not square.
 *
 * The texture is box-resampled to a square of {@link wmoReliefInputSide} (its larger side rounded up
 * to a power of two, at most {@link WMO_RELIEF_INPUT_MAX}), alpha ignored — an opaque WMO texture's
 * alpha is a specular or environment mask, not shape. The map is half that side, so at most 128²:
 * 64 KiB, 85 KiB with its mips. Stretching a 4:1 trim into a square is harmless: the map stores
 * slopes per UV unit and the shader turns them into yards through the surface's own UV gradients.
 *
 * A texture whose band-passed contrast is under {@link WMO_RELIEF_MIN_CONTRAST} (a near-uniform
 * fill) answers no map: it stays exactly as drawn, and costs nothing.
 */

/** 22.10 (7.47 stage 2): the square the derivation reads (its map is half of it, ≤ 128²). */
export const WMO_RELIEF_INPUT_MAX = 256;
export const WMO_RELIEF_INPUT_MIN = 16;
/**
 * 22.10 (7.47 stage 2): below this band-passed luminance contrast (one standard deviation, 0–1) a
 * texture gets no relief. Over the 228 distinct textures of Stormwind and the Goldshire buildings
 * the hand-painted stone, brick, wood and plaster all measure 0.025–0.19 (most 0.05–0.15); under
 * 0.02 are only near-uniform fills (one crypt brick at 0.016, a 32² facade swatch at 0.016).
 */
export const WMO_RELIEF_MIN_CONTRAST = 0.02;

/** 22.10 (7.47 stage 2): the side of the square a `width`×`height` texture is read at. */
export function wmoReliefInputSide(width: number, height: number): number {
  const larger = Math.max(1, Math.floor(width), Math.floor(height));
  let side = WMO_RELIEF_INPUT_MIN;
  while (side < larger && side < WMO_RELIEF_INPUT_MAX) side *= 2;
  return side;
}

/** 22.10 (7.47 stage 2): the side of the map a `width`×`height` texture gets. */
export function wmoReliefMapSide(width: number, height: number): number {
  return terrainReliefSize(wmoReliefInputSide(width, height));
}

/**
 * 22.10 (7.47 stage 2): the texture as the square RGBA input of the derivation — each output texel
 * the mean of the source texels it covers (the nearest one where the source is smaller), alpha 255.
 */
export function wmoReliefInputFrom(rgba: ArrayLike<number>, width: number, height: number): TerrainReliefInput {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgba.length < width * height * 4) {
    throw new Error(`WMO relief needs ${width}x${height} RGBA texels`);
  }
  const size = wmoReliefInputSide(width, height);
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor((y * height) / size);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / size));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x * width) / size);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / size));
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const offset = (sy * width + sx) * 4;
          red += rgba[offset]!;
          green += rgba[offset + 1]!;
          blue += rgba[offset + 2]!;
        }
      }
      const inverse = 1 / ((y1 - y0) * (x1 - x0));
      const target = (y * size + x) * 4;
      pixels[target] = red * inverse;
      pixels[target + 1] = green * inverse;
      pixels[target + 2] = blue * inverse;
      pixels[target + 3] = 255;
    }
  }
  return { pixels, size };
}

export interface WmoReliefMap {
  /** RGBA8, `side`²: RG the normal, B the height (`TerrainReliefDerive.ts`). */
  readonly relief: Uint8Array;
  readonly side: number;
  readonly contrast: number;
}

/**
 * 22.10 (7.47 stage 2): one texture's relief map, or just its contrast when that is under
 * {@link WMO_RELIEF_MIN_CONTRAST} (no map: the texture stays flat).
 */
export function deriveWmoRelief(
  rgba: ArrayLike<number>, width: number, height: number,
): WmoReliefMap | { readonly relief?: undefined; readonly contrast: number } {
  const input = wmoReliefInputFrom(rgba, width, height);
  const stats: TerrainReliefStats = { contrast: 0 };
  const relief = deriveTerrainRelief(input, stats);
  if (!(stats.contrast >= WMO_RELIEF_MIN_CONTRAST)) return { contrast: stats.contrast };
  return { relief, side: terrainReliefSize(input.size), contrast: stats.contrast };
}
