/**
 * The deliberately small graphics policy behind enhanced world lighting.
 *
 * Kept free of DOM, WebGL and three.js types so quality coercion, capability fallback, the tone
 * curve and the shadow budget can be tested without constructing a WebGL context. The renderer
 * translates the resulting numbers into three.js objects; this file decides only what those
 * numbers are.
 */

/** The stub three ships so an application can supply its own curve; the anchor we replace. */
export const TONE_MAPPING_STUB_GLSL = "vec3 CustomToneMapping( vec3 color ) { return color; }";

/**
 * A per-channel shoulder above 0.9 — no matrix, no mixing between channels — transcribed from
 * `CPPClientExample/wowee/assets/shaders/postprocess.frag.glsl:12-18`.
 *
 * It is a safety rail over the identity, not a reproduction of a grade either client applies, and
 * anything calibrated against it has to know that. Neither one tone maps. The original has no such
 * pass; the reference ships that shader but binds it nowhere — the 36 distinct `*.frag.spv` its
 * pipelines name are all string literals and `postprocess.frag.spv` is not among them, while
 * `postprocess.vert.spv` appears only as the vertex half of other full-screen passes — the vertex
 * on the first line of each pair, the fragment that names the pass on the second
 * (`post_process_pipeline.cpp:720-721,1213-1214,1762-1763` for FSR, FSR2 and FXAA,
 * `overlay_system.cpp:215-216` for the overlay it also draws the waterline with and `:295-296` for
 * the brightness scale), and `grep -rni tonemap` over its `src/` finds nothing at all. What is
 * kept below is what that unused asset would have done, because it costs nothing where it is the
 * identity and keeps a blown channel from clipping flat.
 *
 * It also runs in a different space than the file it came from. three calls `CustomToneMapping`
 * ahead of `colorspace_fragment`, so 0.9 here is a linear value, whereas the reference's swapchain
 * is `VK_FORMAT_B8G8R8A8_UNORM` (`vk_context.cpp:1026,2223`), its textures load as
 * `R8G8B8A8_UNORM` / `BC1_RGBA_UNORM` / `BC3_UNORM` (`vk_texture.cpp:273,278,280`) and none of its
 * live fragment shaders does gamma, so 0.9 there would be a screen value. The knee lands on sRGB
 * 244 rather than sRGB 230: sRGB 240 (linear 0.8714) passes untouched here where that file would
 * have brought it to 237.
 *
 * Below the knee it is exactly the identity, so sky, water, particles, additive cards and baked WMO
 * interiors keep the bytes they were authored with. Above it only a white core moves, and by less
 * than the count suggests: twelve sRGB levels have a linear value above 0.9 and nine of them come
 * back changed (247…255), the worst being sRGB 255, which lands on linear 0.95 and encodes to 249.
 *
 * None of that reaches the five portraits, and `material.toneMapped` is not why: three compiles a
 * program with `NoToneMapping` whenever the draw is going into a render target rather than into the
 * canvas (`WebGLPrograms.js:176-184`), and `PortraitRenderer` draws all five into one — so a unit
 * frame saw neither this curve nor the ACES it replaces.
 *
 * What it replaces was `ACESFilmicToneMapping`. Measured with three's own arithmetic
 * (`tonemapping_pars_fragment.glsl.js:44-73`) at the exposure this file used to carry on quality
 * 1, 1.08: a grey ramp came out 8→0, 16→3, 32→15, 64→54, 128→146, 224→219, 255→229 — no white
 * anywhere in the frame — and Stormwind's noon sky bands, rgb(0,31,73)/rgb(58,162,207)/
 * rgb(153,220,245)/rgb(175,218,224)/rgb(180,180,180) in the file, reached the screen as
 * rgb(0,14,62)/rgb(89,182,210)/rgb(188,217,225)/rgb(198,216,218)/rgb(196,196,196), the middle
 * band losing 60% of its blue-minus-red (92 → 37). Through the shoulder all five are unchanged.
 */
export const TONE_SHOULDER_GLSL = `
vec3 CustomToneMapping( vec3 color ) {
  color *= toneMappingExposure;
  vec3 mapped = color;
  for ( int i = 0; i < 3; i ++ ) {
    if ( mapped[ i ] > 0.9 ) {
      float excess = mapped[ i ] - 0.9;
      mapped[ i ] = 0.9 + 0.1 * excess / ( excess + 0.1 );
    }
  }
  return mapped;
}
`;

/**
 * The same curve in JS, one channel at a time: what the GLSL above does to a linear value.
 *
 * Exists so the shader can be held to the reference without a GL context, and so "identity below
 * 0.9" is an assertion rather than a claim.
 */
export function toneShoulder(value: number, exposure = 1): number {
  const mapped = value * exposure;
  if (!(mapped > 0.9)) return mapped;
  const excess = mapped - 0.9;
  return 0.9 + 0.1 * excess / (excess + 0.1);
}

/**
 * Swap the shoulder into three's tone-mapping chunk in place of the stub.
 *
 * Idempotent, because the renderer can be built more than once in a session while three keeps one
 * `ShaderChunk` registry for the process. The stub text is three 0.185.1's; a version that renamed
 * it would leave the chunk untouched, which is why `tests/tone-mapping.test.mjs` runs this against
 * the real `node_modules/three` rather than against a copy of the line.
 */
export function withToneShoulder(chunk: string): string {
  if (chunk.includes(TONE_SHOULDER_GLSL)) return chunk;
  return chunk.replace(TONE_MAPPING_STUB_GLSL, TONE_SHOULDER_GLSL);
}

export type LightingQuality = 0 | 1 | 2;

export interface LightingCapabilities {
  /** A lost/restricted context can keep the light balance while declining the extra pass. */
  shadowMaps: boolean;
  /** The actual GL limit; a requested map is never made larger than this. */
  maxTextureSize: number;
}

export interface LightingProfile {
  quality: LightingQuality;
  /**
   * Linear multiplier ahead of the shoulder. 1.0 on every profile: neither client grades the frame
   * by exposure — the reference's brightness slider is a full-screen tint drawn over the finished
   * image (`overlay_system.cpp:333-352`), not a multiplier ahead of a curve — and the three values
   * that used to live here were chosen to counteract ACES.
   * The field stays because the shoulder is a real curve and a profile may yet want to push into
   * it, but a profile that sets anything else is asking for the frame to be brighter than authored.
   */
  exposure: number;
  /**
   * Strength of the single-pass warm-key/cool-fill grade in the existing world-light shader.
   * Zero is the exact authored baseline; one is the bounded high-quality look. It adds no pass,
   * texture, light or render target and therefore remains available when shadow maps are not.
   */
  immersiveStrength: number;
  /** Zero means no shadow pass. */
  shadowMapSize: number;
  /** Nearest ranked units only; scenery and spell visuals never enter the pass. */
  shadowCasters: number;
  /** Half-width, in world yards, of the directional shadow camera. */
  shadowExtent: number;
  shadowIntensity: number;
  shadowRadius: number;
}

const PROFILES: Readonly<Record<LightingQuality, Omit<LightingProfile, "quality" | "shadowMapSize"> & {
  wantedShadowMapSize: number;
}>> = {
  // Authored ambient/diffuse balance is no longer a quality setting. Only bounded shadow work
  // varies; exposure remains explicit because it belongs to the renderer's shared output curve.
  0: {
    exposure: 1,
    immersiveStrength: 0,
    wantedShadowMapSize: 0,
    shadowCasters: 0,
    shadowExtent: 0,
    shadowIntensity: 0,
    shadowRadius: 0,
  },
  1: {
    exposure: 1,
    immersiveStrength: 0.65,
    wantedShadowMapSize: 512,
    shadowCasters: 12,
    shadowExtent: 32,
    shadowIntensity: 0.55,
    shadowRadius: 1.25,
  },
  2: {
    exposure: 1,
    immersiveStrength: 1,
    wantedShadowMapSize: 1024,
    shadowCasters: 24,
    shadowExtent: 46,
    shadowIntensity: 0.65,
    shadowRadius: 1.75,
  },
};

/** Numbers may come from an old account blob, a module or a hand-edited local mirror. */
export function normaliseLightingQuality(value: unknown): LightingQuality {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.max(0, Math.min(2, Math.round(number))) as LightingQuality;
}

/** Resolve the requested look while degrading only the optional shadow pass. */
export function lightingProfile(
  value: unknown,
  capabilities: LightingCapabilities = { shadowMaps: true, maxTextureSize: Number.POSITIVE_INFINITY },
): LightingProfile {
  const quality = normaliseLightingQuality(value);
  const source = PROFILES[quality];
  const limit = capabilities.maxTextureSize === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Number.isFinite(capabilities.maxTextureSize)
      ? Math.max(0, Math.floor(capabilities.maxTextureSize))
      : 0;
  const shadowMapSize = capabilities.shadowMaps && source.wantedShadowMapSize > 0 && limit >= 512
    ? Math.min(source.wantedShadowMapSize, limit >= 1024 ? 1024 : 512)
    : 0;
  // A context capped at 512 is also likely to be fill/draw constrained. Keep high's tonal profile
  // but fall back to balanced's caster count and camera footprint for its optional pass.
  const shadowSource = quality === 2 && shadowMapSize < 1024 ? PROFILES[1] : source;
  return {
    quality,
    exposure: source.exposure,
    immersiveStrength: source.immersiveStrength,
    shadowMapSize,
    shadowCasters: shadowMapSize > 0 ? shadowSource.shadowCasters : 0,
    shadowExtent: shadowMapSize > 0 ? shadowSource.shadowExtent : 0,
    shadowIntensity: shadowMapSize > 0 ? shadowSource.shadowIntensity : 0,
    shadowRadius: shadowMapSize > 0 ? shadowSource.shadowRadius : 0,
  };
}

/**
 * Material-side safety gate for the unit-only shadow pass.
 *
 * Alpha-tested lit materials remain eligible: three's depth material honours their cutout. Fully
 * transparent, additive, unlit and depthless batches do not, which keeps glows, ribbons and other
 * authored alpha work out of an opaque silhouette.
 */
export function shadowMaterialEligible(traits: {
  lit: boolean;
  transparent: boolean;
  normalBlending: boolean;
  depthWrite: boolean;
}): boolean {
  return traits.lit && !traits.transparent && traits.normalBlending && traits.depthWrite;
}

/** Rank is already computed for the draw budget; distance keeps pinned remote targets out. */
export function unitCastsEnhancedShadow(rank: number, distance: number, profile: LightingProfile): boolean {
  return profile.shadowMapSize > 0
    && Number.isInteger(rank) && rank >= 0 && rank < profile.shadowCasters
    && Number.isFinite(distance) && distance >= 0 && distance <= profile.shadowExtent;
}

export interface DirectionalShadowPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Snap a directional-light centre to its shadow texels without moving it along the light ray.
 *
 * Following the player by sub-texel amounts makes an orthographic shadow map shimmer even when
 * both the caster and receiver are still relative to one another. Quantising only the two axes of
 * the light plane removes that crawl; depth keeps following the player exactly, so the bounded
 * shadow camera cannot lag behind them.
 */
export function stabiliseDirectionalShadowCenter(
  center: Readonly<DirectionalShadowPoint>,
  direction: Readonly<DirectionalShadowPoint>,
  extent: number,
  mapSize: number,
): DirectionalShadowPoint {
  const copy = { x: center.x, y: center.y, z: center.z };
  const texel = (2 * extent) / mapSize;
  const directionLength = Math.hypot(direction.x, direction.y, direction.z);
  if (!(texel > 0) || !Number.isFinite(texel) || !(directionLength > 0)) return copy;

  const dx = direction.x / directionLength;
  const dy = direction.y / directionLength;
  const dz = direction.z / directionLength;
  // Use world-up unless the sun is almost vertical; the alternate axis keeps the cross product
  // finite around noon while choosing the same stable light plane.
  const referenceX = 0;
  const referenceY = Math.abs(dy) < 0.999 ? 1 : 0;
  const referenceZ = Math.abs(dy) < 0.999 ? 0 : 1;
  let rightX = referenceY * dz - referenceZ * dy;
  let rightY = referenceZ * dx - referenceX * dz;
  let rightZ = referenceX * dy - referenceY * dx;
  const rightLength = Math.hypot(rightX, rightY, rightZ);
  if (!(rightLength > 0)) return copy;
  rightX /= rightLength;
  rightY /= rightLength;
  rightZ /= rightLength;
  const upX = dy * rightZ - dz * rightY;
  const upY = dz * rightX - dx * rightZ;
  const upZ = dx * rightY - dy * rightX;

  const rightPosition = center.x * rightX + center.y * rightY + center.z * rightZ;
  const upPosition = center.x * upX + center.y * upY + center.z * upZ;
  const rightDelta = Math.round(rightPosition / texel) * texel - rightPosition;
  const upDelta = Math.round(upPosition / texel) * texel - upPosition;
  return {
    x: center.x + rightX * rightDelta + upX * upDelta,
    y: center.y + rightY * rightDelta + upY * upDelta,
    z: center.z + rightZ * rightDelta + upZ * upDelta,
  };
}
