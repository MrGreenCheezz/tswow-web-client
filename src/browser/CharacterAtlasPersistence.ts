/**
 * 22.10 (6.26): composed character bodies kept between sessions (PersistentAssetStore.ts), so a look is painted
 * out of its layers once per visual generation instead of once per session.
 *
 * A body is a pure function of its layer list and of the layers' pixels. The pixels are the visual generation's
 * (`/texture` of the archives the gateway selected at startup), so a stored body is filed under the layer list's
 * digest and that generation: a new patch chain, or equipment that changes any layer, is a different key. Only a
 * body painted from every one of its layers is stored (CharacterAtlas.ts `#build`); a body short a layer keeps
 * its retry ledger and is never written down.
 *
 * Stored as its raw RGBA texels (1 MiB at 512x512), not as a PNG: measured in the arrival probe
 * (.runtime/lane-charcache), a stored PNG waited 134 ms (median) for `createImageBitmap` behind the crowd's own
 * texture decodes, while `putImageData` of the raw texels is synchronous and about a millisecond. The texels are read
 * back once per look and generation, after its composition, off the frame that painted it.
 */

import type { BodyLayer } from "../gateway/CharacterAppearance.js";
import { gatewayGenerationOrigin, gatewayVisualGeneration } from "./GatewayGeneration.js";
import { persistentAssetStore, type PersistentAssetStore } from "./PersistentAssetStore.js";

/** The stored kind; bumped with the body's size, its paint rules (BODY_TEXTURE_SIZE, SECTIONS) or the value's shape. */
export const ATLAS_PERSIST_KIND = "atlas-512-rgba-v1";

/** The stored value: the body's texels, row by row, unpremultiplied RGBA as `getImageData` gives them. */
export interface StoredAtlas {
  readonly width: number;
  readonly height: number;
  readonly pixels: ArrayBuffer;
}

/** The 2D surface a body is read from and written into (the subset of both canvas contexts used here). */
export interface AtlasPixels {
  getImageData(x: number, y: number, width: number, height: number): ImageData;
}

/** What CharacterAtlas.ts asks of the store. */
export interface CharacterAtlasPersistence {
  /** The generation bodies are filed under now; taken when a composition starts, so it is filed under that one. */
  generation(): string | undefined;
  /** The stored body for these layers under `generation`, as texels to put; undefined when there is none. */
  load(layers: readonly BodyLayer[], generation: string | undefined): Promise<ImageData | undefined>;
  /**
   * Stores a body painted from every layer under the generation its composition started in: its layers were fetched
   * under it, so the picture is never filed under a later one. The texels are read from `context` a moment later,
   * off the paint's frame; a complete body is never repainted, so they are the ones painted.
   */
  save(layers: readonly BodyLayer[], context: AtlasPixels, generation: string | undefined): void;
}

/** 32-bit FNV-1a over a string, twice with different seeds: a 64-bit name for a layer list. */
function fnv(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The stored name of a layer list: what is painted (every spelling of each layer, in order, and its section),
 * digested, plus its length. Two lists that paint the same pixels from the same files share it; anything else
 * — a different piece, a different order, a different section — does not.
 */
export function atlasPersistId(layers: readonly BodyLayer[]): string {
  const text = JSON.stringify(layers.map((layer) => [
    layer.candidates && layer.candidates.length > 0 ? layer.candidates : layer.alternate ? [layer.path, layer.alternate] : [layer.path],
    layer.section ?? null,
  ]));
  return `${fnv(text, 0x811c9dc5)}${fnv(text, 0x9747b28c)}-${text.length.toString(16)}`;
}

export interface AtlasPersistenceSources {
  readonly store: PersistentAssetStore | null;
  readonly generation: () => string | undefined;
  readonly gateway: () => string | undefined;
  /** Makes the texels `putImageData` takes; absent where there is no ImageData (then nothing is kept). */
  readonly imageData: ((pixels: Uint8ClampedArray, width: number, height: number) => ImageData) | undefined;
  /** Runs the texel read-back later (the next task by default). */
  readonly later: (work: () => void) => void;
}

/**
 * The persistence the renderer's atlas uses, or undefined where there is nothing to keep it in (no IndexedDB, no
 * ImageData). Reads the generation at every call, so a page that learns it late starts using it then.
 */
export function createCharacterAtlasPersistence(size: number,
  sources: Partial<AtlasPersistenceSources> = {}): CharacterAtlasPersistence | undefined {
  const store = sources.store !== undefined ? sources.store : persistentAssetStore();
  const imageData = "imageData" in sources ? sources.imageData
    : typeof ImageData === "function"
      ? (pixels: Uint8ClampedArray, width: number, height: number) => new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height)
      : undefined;
  if (!store || !imageData) return undefined;
  const generation = sources.generation ?? gatewayVisualGeneration;
  const gateway = sources.gateway ?? gatewayGenerationOrigin;
  const later = sources.later ?? ((work: () => void) => { setTimeout(work, 0); });
  return {
    generation,
    async load(layers, current) {
      const origin = gateway();
      if (current === undefined || origin === undefined || layers.length === 0) return undefined;
      try {
        const stored = await store.get<StoredAtlas>("blobs", origin, ATLAS_PERSIST_KIND, current, atlasPersistId(layers));
        if (!stored || stored.width !== size || stored.height !== size || !(stored.pixels instanceof ArrayBuffer)
          || stored.pixels.byteLength !== size * size * 4) return undefined;
        return imageData(new Uint8ClampedArray(stored.pixels), size, size);
      } catch {
        return undefined;
      }
    },
    save(layers, context, current) {
      const origin = gateway();
      if (current === undefined || origin === undefined || layers.length === 0) return;
      const id = atlasPersistId(layers);
      later(() => {
        try {
          const texels = context.getImageData(0, 0, size, size);
          const value: StoredAtlas = { width: size, height: size, pixels: texels.data.slice().buffer };
          store.put("blobs", origin, ATLAS_PERSIST_KIND, current, [[id, value]]);
        } catch {
          // A context that cannot be read back (lost, or tainted) keeps nothing.
        }
      });
    },
  };
}
