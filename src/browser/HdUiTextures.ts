// 3.63: «Чёткий интерфейс» — the browser half of the `ui` HD texture set.
//
// `tools/upscale-textures.mjs --set ui` upscales the stock interface's pictures (Real-ESRGAN x4plus, the model the
// owner chose from the samples on 03.11). The stock windows draw them through `/texture`, and a request that carries
// `hd=` is answered from the set when it holds the path (gateway/HdTextures.ts). The renderer places a picture by
// fractions of it (texture coordinates, percentages), so a sharper copy lands where the original did.
//
// Not covered: the world map's tiles and the login screen, which are big and gain nothing at their size, and the
// cursors, which are drawn at their file's size.

import { gatewayHdTextureGeneration, withHdTextureGeneration } from "./GatewayGeneration.js";

/** What the set covers. Equal to the lists in tools/hd-texture-set.mjs (a test holds them so). */
export const HD_UI_TEXTURE_PREFIX = "interface\\";
export const HD_UI_TEXTURE_EXCLUDED: readonly string[] = Object.freeze([
  "interface\\worldmap\\", "interface\\glues\\", "interface\\cursor\\",
]);

/** Whether a (backslashed) texture path is one the set may hold. */
export function isHdUiTexturePath(path: string): boolean {
  const key = path.toLowerCase();
  return key.startsWith(HD_UI_TEXTURE_PREFIX) && !HD_UI_TEXTURE_EXCLUDED.some((prefix) => key.startsWith(prefix));
}

/** `url` (a `/texture` URL for `path`) with `hd=` when `enabled`, the gateway serves a set and the path is the interface's. */
export function withHdUiTexture(url: string, path: string, enabled: boolean): string {
  if (!enabled || gatewayHdTextureGeneration() === undefined || !isHdUiTexturePath(path)) return url;
  return withHdTextureGeneration(url);
}
