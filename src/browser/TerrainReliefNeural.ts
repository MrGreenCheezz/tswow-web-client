import { TERRAIN_RELIEF_DEPTH, terrainReliefFromHeight, terrainReliefSize } from "./TerrainReliefDerive.js";

/**
 * 25.10 (7.47, neural maps): «Нейросетевой объём» — the ground's relief from a neural network's height instead of the
 * layer's brightness.
 *
 * `tools/neural-relief.mjs` runs DeepBump over every published ground layer and the gateway serves the result as
 * `/terrain-relief/<layer id>.bin` (gateway/NeuralReliefRoute.ts). The height there is physical — texels of the
 * layer, not normalised per texture — so sand the network reads as flat stays flat and cobbles stay deep, where the
 * brightness relief lifts every texture above its contrast floor to the same range. A layer without a map (not yet
 * built, stale after a patch, a gateway without the set) keeps the brightness relief; so does every layer while the
 * setting is off.
 *
 * `.bin`: "NRH1", u16 width, u16 height (little-endian), then width·height int16 in 1/256 of a layer texel, row 0
 * the layer PNG's top row — the row the decoded layer starts with (TerrainSplat.ts `decodeImagePixels`).
 */

const MAGIC = 0x3148524e; // "NRH1" read little-endian
const HEADER_BYTES = 8;
const UNITS_PER_TEXEL = 256;
/**
 * 25.10 (7.47): the network's heights over the relief's (1 keeps them as predicted). Measured over the first 341
 * layers (height deviation in detail UV against the brightness relief's 0.006): cobbles 1.6×, stone 1.3×, roads
 * 1.2×, grass 0.7×, dirt, sand and snow 0.3–0.4×. At 1 the deepest cobbles would clip at the relief's range (±0.5
 * is ±1.6 deviations); 0.8 keeps them within ±2 and the stone about as deep as before.
 */
export const NEURAL_RELIEF_GAIN = 0.8;

let wanted = false;
let revision = 0;

/** 25.10 (7.47): the renderer's «Нейросетевой объём» (WorldRenderer3D `setNeuralRelief`). */
export function setNeuralReliefWanted(value: boolean): boolean {
  if (value === wanted) return false;
  wanted = value;
  revision++;
  return true;
}

export function neuralReliefWanted(): boolean {
  return wanted;
}

/** 25.10 (7.47): changes whenever the source of the relief maps does — a map made under another is replaced. */
export function terrainReliefSourceRevision(): number {
  return revision;
}

export interface NeuralHeight {
  readonly width: number;
  readonly height: number;
  /** Texels of the layer, row-major. */
  readonly values: Float32Array;
}

/** 25.10 (7.47): a `.bin` answer, or undefined when it is not one. */
export function parseNeuralHeight(buffer: ArrayBuffer): NeuralHeight | undefined {
  if (buffer.byteLength < HEADER_BYTES) return undefined;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) return undefined;
  const width = view.getUint16(4, true);
  const height = view.getUint16(6, true);
  if (width < 2 || height < 2 || buffer.byteLength !== HEADER_BYTES + width * height * 2) return undefined;
  const values = new Float32Array(width * height);
  for (let index = 0; index < values.length; index++) {
    values[index] = view.getInt16(HEADER_BYTES + index * 2, true) / UNITS_PER_TEXEL;
  }
  return { width, height, values };
}

/**
 * 25.10 (7.47): the relief map of a layer drawn at `layerSize` (its side is `terrainReliefSize`) from its neural
 * height: resampled to the side (a box over the texels each output texel covers, wrapping), turned from layer
 * texels into detail UV (one repeat is the layer's width) and into the relief's 0–1 around 0.5.
 */
export function neuralTerrainRelief(source: NeuralHeight, layerSize: number): Uint8Array {
  const side = terrainReliefSize(layerSize);
  const { width, height: rows, values } = source;
  const toRelief = NEURAL_RELIEF_GAIN / (width * TERRAIN_RELIEF_DEPTH);
  const spanX = Math.max(1, Math.round(width / side));
  const spanY = Math.max(1, Math.round(rows / side));
  const weight = toRelief / (spanX * spanY);
  const height = new Float32Array(side * side);
  for (let y = 0; y < side; y++) {
    const sourceY = Math.floor((y * rows) / side);
    for (let x = 0; x < side; x++) {
      const sourceX = Math.floor((x * width) / side);
      let sum = 0;
      for (let dy = 0; dy < spanY; dy++) {
        const row = ((sourceY + dy) % rows) * width;
        for (let dx = 0; dx < spanX; dx++) sum += values[row + (sourceX + dx) % width]!;
      }
      height[y * side + x] = Math.min(1, Math.max(0, 0.5 + sum * weight));
    }
  }
  return terrainReliefFromHeight(height, side);
}

/**
 * 25.10 (7.47): a layer's neural relief map from the gateway, or undefined (no map, an older gateway, a
 * failure) — the caller then derives it from brightness.
 */
export async function fetchNeuralTerrainRelief(
  baseUrl: string, layerId: string, layerSize: number,
): Promise<Uint8Array | undefined> {
  if (!/^[0-9a-f]{40}$/.test(layerId) || typeof fetch !== "function") return undefined;
  try {
    const response = await fetch(`${baseUrl}/terrain-relief/${layerId}.bin`);
    if (!response.ok) return undefined;
    const parsed = parseNeuralHeight(await response.arrayBuffer());
    return parsed ? neuralTerrainRelief(parsed, layerSize) : undefined;
  } catch {
    return undefined;
  }
}
