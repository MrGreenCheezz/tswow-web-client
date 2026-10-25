import { sha1 } from "../auth/Sha1.js";
import { neuralReliefFromHeight, neuralReliefWanted, parseNeuralHeight } from "./TerrainReliefNeural.js";
import { terrainReliefSize } from "./TerrainReliefDerive.js";
import { wmoReliefInputSide } from "./WmoReliefDerive.js";

/**
 * 25.10 (7.47, neural maps): «Нейросетевой объём» on the buildings (WMO) and the world's doodads (M2) — their relief
 * maps from the heights tools/neural-relief.mjs computes with DeepBump, where the gateway has one.
 *
 * A building or doodad texture reaches the relief worker by its URL (`/visual/texture/…png`, `/texture?path=…`), and
 * the same texture has many URLs (every building that uses it publishes its own copy), so the neural set is keyed
 * by the texture's content: `/neural-relief/<sha1 of the PNG bytes>.bin` (gateway/NeuralReliefRoute.ts, NRH1 as the
 * ground's). The worker already holds the bytes it derives from; it hashes them and asks. No map (not built, a
 * gateway without the set, the setting off) is the brightness relief, exactly as before.
 *
 * The maps are kept per URL (`WmoReliefMaps`); the source is part of that key ({@link withReliefSource}), so turning
 * the setting over binds the other source's maps instead of the ones made under the first.
 */

/** 25.10 (7.47): appended to a relief map key made from the neural set. */
export const NEURAL_RELIEF_KEY_SUFFIX = "#neural";
/**
 * 25.10 (7.47): below this deviation of the relief's 0–1 the network found the texture flat: no map, as the
 * brightness relief leaves a near-uniform fill (`WMO_RELIEF_MIN_CONTRAST`). The ground's maps measure 0.03–0.3.
 */
export const NEURAL_RELIEF_MIN_DEVIATION = 0.015;

/** 25.10 (7.47): `key` with the current source of the relief maps (the setting) marked on it. */
export function withReliefSource(key: string): string {
  return neuralReliefWanted() ? `${key}${NEURAL_RELIEF_KEY_SUFFIX}` : key;
}

/** 25.10 (7.47): a map key without its source mark, and whether it asks for the neural map. */
export function reliefSourceOf(key: string): { readonly key: string; readonly neural: boolean } {
  return key.endsWith(NEURAL_RELIEF_KEY_SUFFIX)
    ? { key: key.slice(0, -NEURAL_RELIEF_KEY_SUFFIX.length), neural: true }
    : { key, neural: false };
}

/** The lowercase hex SHA-1 of `bytes` (Web Crypto where the page has it, else the plain one `auth/Sha1.ts` keeps). */
export async function contentDigest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  let digest: Uint8Array;
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  try {
    digest = subtle ? new Uint8Array(await subtle.digest("SHA-1", bytes)) : sha1(bytes);
  } catch {
    digest = sha1(bytes);
  }
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export interface NeuralWmoRelief {
  readonly relief: Uint8Array;
  readonly side: number;
  readonly deviation: number;
}

/**
 * 25.10 (7.47): the neural relief of the `width`×`height` texture whose PNG `bytes` came from `url`, or undefined
 * (no map, a failure); `flat` when the network found it flat. The map has the brightness relief's side
 * (`wmoReliefMapSide`), and a texel of the texture's longer side is 1/that side of a UV unit — the square the
 * brightness relief stretches the texture into.
 */
export async function fetchNeuralWmoRelief(
  url: string, bytes: Uint8Array<ArrayBuffer>, width: number, height: number,
): Promise<NeuralWmoRelief | "flat" | undefined> {
  if (typeof fetch !== "function") return undefined;
  try {
    const origin = new URL(url).origin;
    const response = await fetch(`${origin}/neural-relief/${await contentDigest(bytes)}.bin`);
    if (!response.ok) return undefined;
    const parsed = parseNeuralHeight(await response.arrayBuffer());
    if (!parsed || parsed.width !== width || parsed.height !== height) return undefined;
    const side = terrainReliefSize(wmoReliefInputSide(width, height));
    const map = neuralReliefFromHeight(parsed, side, Math.max(width, height));
    if (map.deviation < NEURAL_RELIEF_MIN_DEVIATION) return "flat";
    return { relief: map.relief, side, deviation: map.deviation };
  } catch {
    return undefined;
  }
}
