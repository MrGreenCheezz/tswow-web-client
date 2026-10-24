// 23.10 (7.48): «Чёткие текстуры мира» — the browser half of the world HD set (ground and buildings).
//
// `tools/upscale-textures.mjs --set world` upscales every ground texture and every building's diffuse texture of
// up to 256 px a side ×2 on the GPU and stores each one compressed as BC7 with its mip chain (`WHT1`,
// HdTextureContainer.ts). The gateway answers `/terrain-layer/<id>.png` and `/visual/texture/<hash>-<n>.png` with
// that copy when the request carries `hd=<hdTextureGeneration>` (gateway/HdTextures.ts), else with the original
// PNG. This module decides which requests carry it: only while the enhanced setting is on in this realm (the
// renderer's: the worker or the page), only where the GL context has `EXT_texture_compression_bptc` (else every
// texture stays the original — a BC7 copy could not be drawn), and only once the gateway published a generation.
// With the setting off — the default, and always in the faithful/comparison profile — every URL is what it was.
//
// GPU memory: a BC7 texel is one byte, so a ×2 copy (four times the texels) costs what the RGBA8 original costs; the
// ground array of a tile is 512² BC7 per layer against 256² RGBA8 today. The relief maps of «Объём земли» /
// «Объём зданий» keep deriving from the original textures, so their scale in world units is unchanged.

import * as THREE from "three";
import { gatewayHdTextureGeneration, withHdTextureGeneration } from "./GatewayGeneration.js";
import type { HdCompressedTexture } from "./HdTextureContainer.js";

/** The WebGL extension the compressed copies need (BC7, sRGB included). */
export const HD_WORLD_TEXTURE_EXTENSION = "EXT_texture_compression_bptc";

let wanted = false;
let supported = false;

/** This realm's setting and whether its GL context can draw BC7 (WorldRenderer3D.setHdWorldTextures). */
export function setHdWorldTexturesEnabled(setting: boolean, bptc: boolean): void {
  wanted = setting;
  supported = bptc;
}

/** The setting, whatever the context supports. */
export function hdWorldTexturesWanted(): boolean {
  return wanted;
}

/** Whether world texture requests ask for the compressed HD copies now. */
export function hdWorldTexturesActive(): boolean {
  return wanted && supported && gatewayHdTextureGeneration() !== undefined;
}

const WORLD_ROUTE = /\/(?:terrain-layer\/[0-9a-f]{40}\.png|visual\/texture\/[0-9a-f]{40}(?:-\d{1,3})?\.png)(?:\?|$)/;

/** Whether a URL is one of the two routes the world set answers (a ground layer or a building texture). */
export function isHdWorldTextureUrl(url: string): boolean {
  return WORLD_ROUTE.test(url);
}

/** `url` with `hd=` when the world HD copies are active and it is a ground-layer or building-texture URL. */
export function withHdWorldTexture(url: string): string {
  if (!hdWorldTexturesActive() || !isHdWorldTextureUrl(url)) return url;
  return withHdTextureGeneration(url);
}

/**
 * 24.10 (7.48 step 3): the folders of the scenery models whose own textures the world set holds — world doodads and
 * WMO doodads, trees, game objects' props, skybox models — and the WMO second textures (env maps, composite layers).
 * Equal to `MODEL_TEXTURE_PREFIXES` in tools/hd-texture-set.mjs (a test holds them so). Character, creature, item,
 * effect and interface art is never under them; the minimap bakes are excluded.
 */
export const HD_MODEL_TEXTURE_PREFIXES: readonly string[] = Object.freeze(["world\\", "dungeons\\", "environments\\"]);
const HD_MODEL_TEXTURE_EXCLUDED: readonly string[] = Object.freeze(["world\\minimaps\\"]);

/** 24.10 (7.48 step 3): whether a texture path is a scenery model's (one the world set may hold). */
export function isHdModelTexturePath(path: string): boolean {
  const key = path.replaceAll("/", "\\").toLowerCase();
  return key.endsWith(".blp")
    && HD_MODEL_TEXTURE_PREFIXES.some((prefix) => key.startsWith(prefix))
    && !HD_MODEL_TEXTURE_EXCLUDED.some((prefix) => key.startsWith(prefix));
}

const TEXTURE_ROUTE = /\/texture\?([^#]*)$/;

/** 24.10 (7.48 step 3): whether a URL is the gateway's `/texture?path=…` for a scenery model's texture. */
export function isHdModelTextureUrl(url: string): boolean {
  const query = TEXTURE_ROUTE.exec(url)?.[1];
  if (query === undefined) return false;
  const path = new URLSearchParams(query).get("path");
  return path !== null && isHdModelTexturePath(path);
}

/**
 * 24.10 (7.48 step 3): a scenery model's `/texture` URL (Wvm.ts `textureUrl`) with `hd=` while the world HD copies
 * are active — applied only where the texture goes through `ModelTextureLoader`/`ModelImageCache`, which take the
 * gateway's BC7 container (model builds, combiner second stages, emitters, the warm-up of the same URLs, WMO env
 * maps). Relief maps keep deriving from the URL without `hd=`. Every other URL is returned as it is.
 */
export function withHdModelTexture(url: string): string {
  if (!hdWorldTexturesActive() || !isHdModelTextureUrl(url)) return url;
  return withHdTextureGeneration(url);
}

/** Whether a texture URL asked for an HD copy (its answer may be a `WHT1` container rather than a PNG). */
export function asksForHdTexture(url: string): boolean {
  return /[?&]hd=/.test(url);
}

/** The mip levels of a parsed container in the shape three's compressed upload reads. */
export function compressedMipmaps(texture: HdCompressedTexture): THREE.CompressedTextureMipmap[] {
  return texture.levels.map((level) => ({ data: level.data, width: level.width, height: level.height }));
}

/**
 * One tile's ground layers as a compressed array texture: every layer the same side and level count (the gateway's
 * containers are all 512² with ten levels; anything else is undefined and the tile takes the original path).
 */
export function compressedLayerArray(layers: readonly HdCompressedTexture[]): THREE.CompressedArrayTexture | undefined {
  const first = layers[0];
  if (!first) return undefined;
  for (const layer of layers) {
    if (layer.width !== first.width || layer.height !== first.height || layer.levels.length !== first.levels.length) return undefined;
  }
  const mipmaps: THREE.CompressedTextureMipmap[] = [];
  for (let level = 0; level < first.levels.length; level++) {
    const { width, height, data } = first.levels[level]!;
    const joined = new Uint8Array(data.length * layers.length);
    for (let slot = 0; slot < layers.length; slot++) joined.set(layers[slot]!.levels[level]!.data, slot * data.length);
    mipmaps.push({ data: joined, width, height });
  }
  const array = new THREE.CompressedArrayTexture(mipmaps, first.width, first.height, layers.length, THREE.RGBA_BPTC_Format);
  array.colorSpace = THREE.SRGBColorSpace;
  array.wrapS = THREE.RepeatWrapping;
  array.wrapT = THREE.RepeatWrapping;
  array.minFilter = THREE.LinearMipmapLinearFilter;
  array.magFilter = THREE.LinearFilter;
  array.generateMipmaps = false;
  array.needsUpdate = true;
  return array;
}
