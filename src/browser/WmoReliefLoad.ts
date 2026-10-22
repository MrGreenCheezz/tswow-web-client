import { deriveWmoRelief } from "./WmoReliefDerive.js";
import { decodePngRgba } from "./WmoReliefPng.js";

/**
 * 22.10 (7.47 stage 2): one WMO texture's relief, from its URL — the fetch (a cache hit or a 304:
 * the model's own texture load asked for it moments before), the PNG read back to exact bytes
 * (`WmoReliefPng.ts`), the derivation (`WmoReliefDerive.ts`). Runs in the relief worker, or inline
 * where there is none. `relief` is absent for a texture too flat to get any.
 */
export interface WmoReliefAnswer {
  readonly relief?: Uint8Array | undefined;
  readonly side: number;
  readonly contrast: number;
}

/** The request `TextureLoad.ts` makes for a model texture (CORS, the page's own cookies only). */
const RELIEF_IMAGE_REQUEST: RequestInit = Object.freeze({ mode: "cors", credentials: "same-origin", priority: "low" });

export async function loadWmoRelief(url: string): Promise<WmoReliefAnswer> {
  const response = await fetch(url, RELIEF_IMAGE_REQUEST);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const image = await decodePngRgba(new Uint8Array(await response.arrayBuffer()));
  const map = deriveWmoRelief(image.data, image.width, image.height);
  return map.relief ? { relief: map.relief, side: map.side, contrast: map.contrast } : { side: 0, contrast: map.contrast };
}
