// 23.10 (7.48): «Чёткие текстуры эффектов» — the browser half of the HD texture sets.
//
// `tools/upscale-textures.mjs --set effects` upscales the textures of every spell model (×4 up to 128 px a
// side, ×2 at 256 px, never past 512) on the GPU; the gateway serves them to a `/texture` request carrying
// `hd=<hdTextureGeneration>` (gateway/HdTextures.ts). This module decides which requests carry it: only paths
// in the effect folders, only while the enhanced setting is on in this realm (the renderer's: the worker or
// the page), and only once the gateway has published a generation. With the setting off — the default, and
// always in the faithful/comparison profile — `textureUrl` is exactly what it was.
//
// The shader samples the HD copy with the same UVs: a flip-book's cells sit at exact multiples of the source
// cells (tools/hd-texture-image.mjs), and the textures keep three's trilinear mip filtering, so a particle that
// is small on screen reads from a mip of the size it read before.

import { gatewayHdTextureGeneration, withHdTextureGeneration } from "./GatewayGeneration.js";

/** The effect folders. Equal to `EFFECT_TEXTURE_PREFIXES` in tools/hd-texture-set.mjs (a test holds them so). */
export const HD_EFFECT_TEXTURE_PREFIXES: readonly string[] = Object.freeze(["spells\\", "particles\\"]);

let enabled = false;

/** This realm's setting (WorldRenderer3D.setHdEffectTextures). */
export function setHdEffectTexturesEnabled(value: boolean): void {
  enabled = value;
}

export function hdEffectTexturesEnabled(): boolean {
  return enabled;
}

/** Whether a (backslashed) texture path is one an HD effect set may hold. */
export function isHdEffectTexturePath(path: string): boolean {
  const key = path.toLowerCase();
  for (const prefix of HD_EFFECT_TEXTURE_PREFIXES) if (key.startsWith(prefix)) return true;
  return false;
}

/** `url` (a `/texture` URL for `path`) with `hd=` when the setting is on, the gateway serves a set and the path is an effect's. */
export function withHdEffectTexture(url: string, path: string): string {
  if (!enabled || gatewayHdTextureGeneration() === undefined || !isHdEffectTexturePath(path)) return url;
  return withHdTextureGeneration(url);
}
