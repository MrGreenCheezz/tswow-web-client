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
  if ( mapped.r > 0.9 ) {
    float excess = mapped.r - 0.9;
    mapped.r = 0.9 + 0.1 * excess / ( excess + 0.1 );
  }
  if ( mapped.g > 0.9 ) {
    float excess = mapped.g - 0.9;
    mapped.g = 0.9 + 0.1 * excess / ( excess + 0.1 );
  }
  if ( mapped.b > 0.9 ) {
    float excess = mapped.b - 0.9;
    mapped.b = 0.9 + 0.1 * excess / ( excess + 0.1 );
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
   * Strength of the soft warm grade in the existing world-light shader.
   * Zero is the exact authored baseline; one is the bounded high-quality look. It adds no pass,
   * texture or render target and therefore remains available when shadow maps are not.
   */
  immersiveStrength: number;
  /** Nearby outdoor flame/glow fixtures contributing light in the existing material shader. */
  localLights: number;
  /**
   * Strength ceiling for the optional screen-space sun shafts.
   *
   * The effect still has its own account switch. Quality zero keeps the direct baseline even when
   * that experimental leaf is enabled; balanced and high only choose how strongly its final
   * display-space contribution may be added.
   */
  godRayStrength: number;
  /** Zero means no shadow pass. Resolution of every view-fitted cascade. */
  shadowMapSize: number;
  /** Nearest ranked units only; spell visuals never enter the pass. */
  shadowCasters: number;
  /**
   * Radius around the player, in yards, inside which a ranked unit casts. Unit shadows only enter
   * the cascades rendered every frame, so this stays inside the last view-fitted split.
   */
  shadowExtent: number;
  shadowIntensity: number;
  shadowRadius: number;
  /** Directional shadow cascades, nearest first; zero exactly when there is no shadow pass. */
  shadowCascades: number;
  /**
   * View depth, in yards from the camera, at which each view-fitted cascade ends. The outermost
   * cascade is not fitted to the view: it is a camera-centred disc reaching `shadowDistance`,
   * cached, and re-rendered only when the camera leaves its margin, the sun turns, its casters
   * change or `shadowFarRefreshFrames` have passed.
   */
  shadowCascadeSplits: readonly number[];
  /** Distance from the camera at which sun shadows have faded out completely. */
  shadowDistance: number;
  /** Distance from the camera at which that fade begins: the last ~22% of the reach. */
  shadowFadeStart: number;
  /** Resolution of the outermost, cached cascade. */
  shadowFarMapSize: number;
  /** Frames after which the cached cascade is re-rendered even though nothing asked for it. */
  shadowFarRefreshFrames: number;
}

/** Fraction of the shadow reach, measured from the camera, over which shadows fade to nothing. */
export const SHADOW_FADE_FRACTION = 0.22;

const PROFILES: Readonly<Record<LightingQuality, Omit<LightingProfile,
  "quality" | "shadowMapSize" | "shadowFarMapSize" | "shadowFadeStart"> & {
  wantedShadowMapSize: number;
  wantedShadowFarMapSize: number;
}>> = {
  // Light.dbc inputs and exposure stay intact. Higher quality enables the bounded soft grade,
  // nearby fixture pools and optional shadow work in addition to those authored inputs.
  0: {
    exposure: 1,
    immersiveStrength: 0,
    localLights: 0,
    godRayStrength: 0,
    wantedShadowMapSize: 0,
    wantedShadowFarMapSize: 0,
    shadowCasters: 0,
    shadowExtent: 0,
    shadowIntensity: 0,
    shadowRadius: 0,
    shadowCascades: 0,
    shadowCascadeSplits: [],
    shadowDistance: 0,
    shadowFarRefreshFrames: 0,
  },
  // Balanced: one view-fitted cascade to 45 yards (about 30 past the character at the default
  // camera distance) and the cached camera-centred disc to 120.
  1: {
    exposure: 1,
    immersiveStrength: 0.65,
    localLights: 4,
    godRayStrength: 0.12,
    wantedShadowMapSize: 512,
    wantedShadowFarMapSize: 1024,
    shadowCasters: 12,
    shadowExtent: 32,
    shadowIntensity: 0.72,
    shadowRadius: 1.25,
    shadowCascades: 2,
    shadowCascadeSplits: [45],
    shadowDistance: 120,
    shadowFarRefreshFrames: 45,
  },
  // High: a sharp near cascade, a mid one to 90 yards, and the cached disc to 200.
  2: {
    exposure: 1,
    immersiveStrength: 1,
    localLights: 8,
    godRayStrength: 0.2,
    wantedShadowMapSize: 1024,
    wantedShadowFarMapSize: 2048,
    shadowCasters: 24,
    shadowExtent: 60,
    // How much of the sun a shadow takes away. 0.65 left a third of the key light in every shadow,
    // and with the enhanced fill on top a street in the shade of its own houses read as flat and
    // merely dimmer; the reference stills (WoW Forever, Orgrimmar and Ashenvale) have the shade
    // almost all ambient. The remaining 15% is the sky light a shadow map cannot bounce.
    shadowIntensity: 0.85,
    shadowRadius: 1.75,
    shadowCascades: 3,
    shadowCascadeSplits: [28, 90],
    shadowDistance: 200,
    shadowFarRefreshFrames: 30,
  },
};

/** Numbers may come from an old account blob, a module or a hand-edited local mirror. */
export function normaliseLightingQuality(value: unknown): LightingQuality {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.max(0, Math.min(2, Math.round(number))) as LightingQuality;
}

/**
 * Upper bound of «Сила солнечных лучей» as a multiplier: the account's percentage over the
 * profile's `godRayStrength` ceiling, on both shaft paths (the classic radial pass and the
 * cinematic march). The slider itself stops at 3; the bound above it is for a hand-edited settings
 * file (`bench/run.mjs --settings`), so no unbounded value reaches a display-space additive
 * composite. Zero is allowed and reads as "no shafts"; the leaf's own switch still decides whether
 * the effect runs at all.
 */
export const GOD_RAY_STRENGTH_SCALE_MAX = 4;

/** The account's percentage / 100 as the multiplier the two shaft paths use; garbage is the default. */
export function godRayStrengthScale(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.max(0, Math.min(GOD_RAY_STRENGTH_SCALE_MAX, number));
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
  const shadows = shadowMapSize > 0;
  const shadowFarMapSize = shadows
    ? Math.min(shadowSource.wantedShadowFarMapSize, limit >= 2048 ? 2048 : limit >= 1024 ? 1024 : 512)
    : 0;
  const shadowDistance = shadows ? shadowSource.shadowDistance : 0;
  return {
    quality,
    exposure: source.exposure,
    immersiveStrength: source.immersiveStrength,
    localLights: source.localLights,
    godRayStrength: source.godRayStrength,
    shadowMapSize,
    shadowCasters: shadows ? shadowSource.shadowCasters : 0,
    shadowExtent: shadows ? shadowSource.shadowExtent : 0,
    shadowIntensity: shadows ? shadowSource.shadowIntensity : 0,
    shadowRadius: shadows ? shadowSource.shadowRadius : 0,
    shadowCascades: shadows ? shadowSource.shadowCascades : 0,
    shadowCascadeSplits: shadows ? [...shadowSource.shadowCascadeSplits] : [],
    shadowDistance,
    shadowFadeStart: shadowDistance * (1 - SHADOW_FADE_FRACTION),
    shadowFarMapSize,
    shadowFarRefreshFrames: shadows ? shadowSource.shadowFarRefreshFrames : 0,
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
  const basis = directionalShadowBasis(direction);
  if (!(texel > 0) || !Number.isFinite(texel) || !basis) return copy;
  const { right, up } = basis;

  const rightPosition = center.x * right.x + center.y * right.y + center.z * right.z;
  const upPosition = center.x * up.x + center.y * up.y + center.z * up.z;
  const rightDelta = Math.round(rightPosition / texel) * texel - rightPosition;
  const upDelta = Math.round(upPosition / texel) * texel - upPosition;
  return {
    x: center.x + right.x * rightDelta + up.x * upDelta,
    y: center.y + right.y * rightDelta + up.y * upDelta,
    z: center.z + right.z * rightDelta + up.z * upDelta,
  };
}

/** The two axes of a directional light's shadow plane, both unit length and normal to the ray. */
export interface DirectionalShadowBasis {
  readonly right: DirectionalShadowPoint;
  readonly up: DirectionalShadowPoint;
}

/**
 * The light plane every directional shadow camera is snapped in.
 *
 * World-up is the reference unless the sun is almost vertical; the alternate axis keeps the cross
 * product finite around noon while choosing the same stable plane. `up` is also what the shadow
 * camera's own `up` has to be: three's `lookAt` then builds exactly `right` as the camera's x axis,
 * so a centre snapped here moves the map by whole texels and nothing else.
 */
export function directionalShadowBasis(direction: Readonly<DirectionalShadowPoint>): DirectionalShadowBasis | undefined {
  const directionLength = Math.hypot(direction.x, direction.y, direction.z);
  if (!(directionLength > 0) || !Number.isFinite(directionLength)) return undefined;
  const dx = direction.x / directionLength;
  const dy = direction.y / directionLength;
  const dz = direction.z / directionLength;
  const referenceX = 0;
  const referenceY = Math.abs(dy) < 0.999 ? 1 : 0;
  const referenceZ = Math.abs(dy) < 0.999 ? 0 : 1;
  let rightX = referenceY * dz - referenceZ * dy;
  let rightY = referenceZ * dx - referenceX * dz;
  let rightZ = referenceX * dy - referenceY * dx;
  const rightLength = Math.hypot(rightX, rightY, rightZ);
  if (!(rightLength > 0)) return undefined;
  rightX /= rightLength;
  rightY /= rightLength;
  rightZ /= rightLength;
  return {
    right: { x: rightX, y: rightY, z: rightZ },
    up: {
      x: dy * rightZ - dz * rightY,
      y: dz * rightX - dx * rightZ,
      z: dx * rightY - dy * rightX,
    },
  };
}

/** A view-frustum slice's enclosing sphere, as a distance along the view axis and a radius. */
export interface FrustumSliceSphere {
  /** Distance from the camera, along its forward axis, of the sphere's centre. */
  readonly depth: number;
  readonly radius: number;
}

/**
 * The smallest sphere around the slice of a symmetric perspective frustum between two depths.
 *
 * It depends on the slice, the field of view and the aspect ratio only — not on where the camera
 * points — so a shadow map sized to it keeps one texel size however the camera turns. That, with
 * the centre snapped to whole texels, is what keeps a cascade from shimmering while the camera
 * moves or rotates. `tanHalfVertical` is `tan(fov / 2)`.
 */
export function frustumSliceSphere(
  near: number,
  far: number,
  tanHalfVertical: number,
  aspect: number,
): FrustumSliceSphere {
  const tanHalfHorizontal = tanHalfVertical * aspect;
  const spread = tanHalfVertical * tanHalfVertical + tanHalfHorizontal * tanHalfHorizontal;
  // Equidistant from the near and far corner rings, unless the far ring alone already encloses
  // the near one (a wide or deep slice), in which case the far ring's own centre is the answer.
  const depth = Math.min(far, 0.5 * (far + near) * (1 + spread));
  const radius = Math.sqrt(far * far * spread + (far - depth) * (far - depth));
  return { depth, radius };
}
