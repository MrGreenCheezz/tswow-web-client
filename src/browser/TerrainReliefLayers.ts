import * as THREE from "three";
import { terrainReliefSize } from "./TerrainReliefDerive.js";
import { deriveTerrainReliefAsync } from "./TerrainReliefWorker.js";
import { fetchNeuralTerrainRelief, neuralReliefWanted, terrainReliefSourceRevision } from "./TerrainReliefNeural.js"; // 25.10 (7.47)

/**
 * 22.10 (7.47): the relief half of a splat layer record. The decoded layer is shared by every tile
 * that uses the texture; so is its relief map — derived once per id and side, released with it.
 */
export interface TerrainReliefLayerRecord {
  readonly promise: Promise<Uint8ClampedArray>;
  /** The derivation, started by the first tile that wants it. */
  relief?: Promise<Uint8Array | undefined>;
  /** The finished map while the record is held (counted by the client's accounting). */
  reliefBytes?: Uint8Array;
  /** 25.10 (7.47): the source revision `relief` was started under (TerrainReliefNeural.ts). */
  reliefSource?: number;
}

/**
 * 22.10 (7.47): the layer's relief map (once per record and source). `keep` is asked when the answer
 * arrives — false when the record was released meanwhile, and then the bytes are not kept on it.
 * Undefined if the layer or the derivation failed. 25.10: with `neural` (the gateway and the layer's
 * id, while «Нейросетевой объём» is on) the gateway's neural map is asked for first. A map made under
 * another source revision is dropped (`release` is told its bytes) and made again.
 */
export function terrainReliefLayer(
  layer: TerrainReliefLayerRecord,
  size: number,
  mask: Promise<Uint8ClampedArray> | undefined,
  keep: (bytes: number) => boolean,
  neural?: { readonly baseUrl: string; readonly layerId: string },
  release?: (bytes: number) => void,
): Promise<Uint8Array | undefined> {
  const source = terrainReliefSourceRevision();
  if (layer.relief && layer.reliefSource !== source) {
    if (layer.reliefBytes) release?.(layer.reliefBytes.byteLength);
    delete layer.reliefBytes;
    delete layer.relief;
  }
  layer.reliefSource = source;
  layer.relief ??= (async () => {
    try {
      const fromNetwork = neural && neuralReliefWanted()
        ? await fetchNeuralTerrainRelief(neural.baseUrl, neural.layerId, size) : undefined;
      if (fromNetwork) {
        if (layer.reliefSource === source && keep(fromNetwork.byteLength)) layer.reliefBytes = fromNetwork;
        return fromNetwork;
      }
      const [pixels, maskPixels] = await Promise.all([layer.promise, mask?.catch(() => undefined)]);
      const relief = await deriveTerrainReliefAsync(pixels, size, maskPixels);
      if (layer.reliefSource !== source) return relief;
      if (keep(relief.byteLength)) layer.reliefBytes = relief;
      return relief;
    } catch {
      return undefined;
    }
  })();
  return layer.relief;
}

/**
 * 22.10 (7.47): one tile's relief array, slot for slot with its layer array: RGBA8 data (not colour),
 * repeating, mipmapped. The tile owns it like its other textures.
 */
export function terrainReliefArray(maps: readonly Uint8Array[], layerSize: number): THREE.DataArrayTexture | undefined {
  const side = terrainReliefSize(layerSize);
  const bytes = side * side * 4;
  if (maps.length === 0 || maps.some((map) => map.byteLength !== bytes)) return undefined;
  const data = new Uint8Array(bytes * maps.length);
  for (let slot = 0; slot < maps.length; slot++) data.set(maps[slot]!, slot * bytes);
  const array = new THREE.DataArrayTexture(data, side, side, maps.length);
  array.format = THREE.RGBAFormat;
  array.type = THREE.UnsignedByteType;
  array.colorSpace = THREE.NoColorSpace;
  array.wrapS = THREE.RepeatWrapping;
  array.wrapT = THREE.RepeatWrapping;
  array.minFilter = THREE.LinearMipmapLinearFilter;
  array.magFilter = THREE.LinearFilter;
  array.generateMipmaps = true;
  array.needsUpdate = true;
  return array;
}
