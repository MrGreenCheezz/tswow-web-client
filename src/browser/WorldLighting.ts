import * as THREE from "three";
import { CINEMATIC_POOL_GLSL, CINEMATIC_POOL_REACH } from "./CinematicLights.js"; // 22.10 (7.36)

/** A display-space light multiplier, as the bands in Light.dbc store it. */
export interface WorldLightColour {
  r: number;
  g: number;
  b: number;
}

export interface WorldLightPair {
  ambient: WorldLightColour;
  diffuse: WorldLightColour;
}

/** Fixed shader budget; quality settings change the active count without compiling a new program. */
export const WORLD_LOCAL_LIGHT_LIMIT = 12; // 22.10 (7.36): 8 -> 12, the high profile's count

/**
 * 12.10-6.17: the constant, linear and quadratic attenuation Wow.exe's M2 point lights reach the
 * lit M2 and terrain vertex programs with (`CM2Light` +0x54/+0x58/+0x5c, set to these by its
 * constructor 0x834a40). See `LocalLighting.ts` `m2LightFalloff` for the shader term.
 */
export const M2_LIGHT_ATTENUATION: readonly [number, number, number] = Object.freeze([0, 0.7, 0.03]);
/** 12.10-6.17: the curve is capped here, where it would run to infinity at the source. */
export const M2_LIGHT_FALLOFF_CAP = 4;

/** Shared by every authored outdoor material; changing a value updates all compiled programs. */
export interface WorldLightUniforms {
  wowSunDirection: { value: THREE.Vector3 };
  wowDiffuse: { value: THREE.Color };
  wowAmbient: { value: THREE.Color };
  /** Reversible soft warm grade; zero is the exact authored equation. */
  wowImmersiveStrength: { value: number };
  /** Physical sun elevation, independent of the shaping light's night-time direction floor. */
  wowDaylight: { value: number };
  /** View-space fixture positions/radii and display-space light colour/strength. */
  wowLocalLightCount: { value: number };
  wowLocalLightPosition: { value: THREE.Vector4[] };
  wowLocalLightColour: { value: THREE.Vector4[] };
  /** 22.10 (7.36): cinematic pool strength (`CinematicLights.ts`); zero is the 6.17 light exactly. */
  wowLocalLightPool: { value: number };
  /** Optional aerial perspective; zero leaves the authored fog equation unchanged. */
  wowAerialStrength: { value: number };
  /** Daylight and low-sun weighting for the sun-facing haze; zero at night. */
  wowAerialWarmth: { value: number };
  /** Optional low-sun rim/back light on lit models; zero leaves the equation unchanged. */
  wowRimStrength: { value: number };
  /**
   * 12.10-7.29: x — how high the sun is for the enhanced key (`highSunKeyWeight`: 0 at dawn, dusk
   * and night, 1 from ~27 degrees up), which takes most of the diffuse band's chroma out of the key
   * in the enhanced grade; y — the authored pair's peak sum (the inverse of its `applyLightHeadroom`
   * scale, 1 when it did not clip), so that grade can rebuild the pair before its own headroom. Read
   * only inside the immersive branch: lighting quality 0 and the comparison level never evaluate it.
   */
  wowHighSunKey: { value: THREE.Vector2 };
  /**
   * Reach of the cascaded sun shadow: x is the camera distance its fade starts at, y the distance
   * it is gone by, z the share of a cascade's map, from its edge inwards, handed over to the next
   * cascade. Only compiled in while a shadow map exists; y = 0 disables the fade.
   */
  wowShadowFade: { value: THREE.Vector3 };
  /**
   * 24.10 (7.50): 1 while this frame's screen-space lamp pools run (`LightPoolPass.ts`): an opaque lit
   * surface then writes the sun shadow it took into the capture's alpha (`WORLD_SHADOW_ALPHA_GLSL`),
   * which nothing else reads. 0 on every other frame and profile: the alpha is left as it was.
   */
  wowShadowAlpha: { value: number };
  /**
   * 25.10 (6.27 indoors): 1 while the room light is applied (`setWorldLightIndoor`), 0 otherwise. A
   * sunless room's lamps (spells, fixtures) are lit as at night (their daylight weight reads 0) and
   * add on top of the room's ceiling of one rather than being clipped by it ({@link WORLD_LAMP_INDOOR_CEILING}).
   * Read only inside the immersive branch: the faithful levels never evaluate it.
   */
  wowLampIndoor: { value: number };
}

/**
 * 25.10 (6.27 indoors): how far lamp light may lift a surface inside a sunless room, as a display-space
 * multiplier — the room's own light stays under one, a lamp adds up to this much on top.
 */
export const WORLD_LAMP_INDOOR_CEILING = 1.5;

/**
 * 24.10 (7.50): the alpha an opaque lit surface writes while `wowShadowAlpha` is on: its sun shadow
 * times this, so a texel at 1 (sky, unlit glass and windows, blended overlays) is told apart.
 */
export const WORLD_SHADOW_ALPHA_SCALE = 0.94;

/** 24.10 (7.50): appended after three's last fragment chunk of an opaque world-lit material. */
export const WORLD_SHADOW_ALPHA_GLSL = /* glsl */ `
if ( wowShadowAlpha > 0.5 ) gl_FragColor.a = ${WORLD_SHADOW_ALPHA_SCALE.toFixed(2)} * clamp( wowShadow, 0.0, 1.0 );
`;

/**
 * Bring the brightest channel of ambient + diffuse down to one without changing their ratio.
 *
 * Light.dbc stores multipliers, not colours to decode. Scaling both terms by one number is the
 * reference client's answer to the 82% of profiles whose noon sum would otherwise clip one
 * channel before another and change hue.
 */
export function applyLightHeadroom(
  ambient: Readonly<WorldLightColour>,
  diffuse: Readonly<WorldLightColour>,
): WorldLightPair {
  const peak = Math.max(
    ambient.r + diffuse.r,
    ambient.g + diffuse.g,
    ambient.b + diffuse.b,
  );
  const scale = peak > 1 ? 1 / peak : 1;
  return {
    ambient: { r: ambient.r * scale, g: ambient.g * scale, b: ambient.b * scale },
    diffuse: { r: diffuse.r * scale, g: diffuse.g * scale, b: diffuse.b * scale },
  };
}

/**
 * CPU twin of the outdoor shader, useful both for fallback light and deterministic acceptance.
 *
 * `nightness` is for the reference fallback used when no authored light volume exists. A sampled
 * Light.dbc profile has already followed its own bands through the night and must pass zero here,
 * otherwise midnight is darkened twice.
 */
export function worldLightFactor(
  ambient: Readonly<WorldLightColour>,
  diffuse: Readonly<WorldLightColour>,
  ndotl: number,
  shadow: number,
  nightness: number,
  kind: WorldLightKind,
): WorldLightColour {
  const night = Math.max(0, Math.min(1, nightness));
  const ambientScale = 0.3 + 0.7 * (1 - night);
  const diffuseScale = 0.2 + 0.8 * (1 - night);
  // wowee applies the procedural fallback's night tint before headroom. Authored Light.dbc
  // samples pass nightness=0 and therefore keep their own already-interpolated night bands.
  const scaled = applyLightHeadroom(
    {
      r: ambient.r * ambientScale,
      g: ambient.g * ambientScale,
      b: ambient.b * ambientScale + night * 0.1,
    },
    {
      r: diffuse.r * diffuseScale,
      g: diffuse.g * diffuseScale,
      b: diffuse.b * diffuseScale,
    },
  );
  // 05.10-A7b-0 7.07: terrain is the client's own `Shaders\Vertex\arbvp1\terrain.bls` —
  // ambient + diffuse * clamp(N.L, 0, 1) — and no longer wowee's max(abs(N.L), 0.2).
  const nl = kind === "foliage" ? Math.abs(ndotl) : Math.max(ndotl, 0);
  const direct = nl * Math.max(0, shadow);
  return {
    r: scaled.ambient.r + scaled.diffuse.r * direct,
    g: scaled.ambient.g + scaled.diffuse.g * direct,
    b: scaled.ambient.b + scaled.diffuse.b * direct,
  };
}

export function createWorldLightUniforms(
  ambient: Readonly<WorldLightColour> = { r: 0.55, g: 0.58, b: 0.62 },
  diffuse: Readonly<WorldLightColour> = { r: 0.45, g: 0.42, b: 0.38 },
): WorldLightUniforms {
  const uniforms: WorldLightUniforms = {
    wowSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    wowDiffuse: { value: new THREE.Color() },
    wowAmbient: { value: new THREE.Color() },
    wowImmersiveStrength: { value: 0 },
    wowDaylight: { value: 1 },
    wowLocalLightCount: { value: 0 },
    wowLocalLightPosition: { value: Array.from({ length: WORLD_LOCAL_LIGHT_LIMIT }, () => new THREE.Vector4()) },
    wowLocalLightColour: { value: Array.from({ length: WORLD_LOCAL_LIGHT_LIMIT }, () => new THREE.Vector4()) },
    wowLocalLightPool: { value: 0 },
    wowAerialStrength: { value: 0 },
    wowAerialWarmth: { value: 0 },
    wowRimStrength: { value: 0 },
    wowHighSunKey: { value: new THREE.Vector2(0, 1) },
    wowShadowFade: { value: new THREE.Vector3() },
    wowShadowAlpha: { value: 0 }, // 24.10 (7.50)
    wowLampIndoor: { value: 0 }, // 25.10 (6.27 indoors)
  };
  setWorldLightUniforms(uniforms, ambient, diffuse);
  return uniforms;
}

/**
 * 12.10-7.29: how high the sun stands for the enhanced key, 0..1 from its physical elevation: 0
 * under ~9 degrees (dawn, dusk, night), 1 from ~27 degrees (08:00 on the enhanced arc) up.
 *
 * Light.dbc's diffuse band is a deep orange at every hour — Elwynn and Stormwind hold rgb(255,103,0)
 * at 06:00, (255,114,0) at 08:00 and (255,136,0) at noon over an ambient of about (100,128,155).
 * Kept through the pair's headroom, sunlit ground at noon was lit (244,183,109) and the sunlit half
 * of every morning and noon frame turned orange (owner, 12.10: «утро и полдень будто сильно желтым
 * цветом отдают»). The client itself saturates the sum per channel (`terrain.bls`: `ADD c[25]` →
 * `MIN …, 1`), (255,255,154) at an Elwynn noon, which in the lookdev stills reads lime on grey
 * cobbles under the enhanced arc's high sun. What the enhanced grade does with the weight is
 * `HIGH_SUN_KEY_NEUTRAL`; the dawn and the night the owner liked keep the authored pair.
 */
export function highSunKeyWeight(elevation: number): number {
  if (!Number.isFinite(elevation)) return 0;
  const t = Math.max(0, Math.min(1, (elevation - 0.15) / 0.3));
  return t * t * (3 - 2 * t);
}

/**
 * 12.10-7.29: share of the diffuse band's chroma the enhanced key gives up at a high sun, toward
 * `DAYLIGHT_KEY_WHITE` at the band's own luminance. Elwynn noon: the key (255,136,0) becomes
 * (199,145,79) and, with the ambient and the pair's headroom, sunlit ground (245,224,192) against a
 * (87,109,130) shade — the warm key and cool shade of the reference, not an orange frame.
 */
export const HIGH_SUN_KEY_NEUTRAL = 0.6;
/** 12.10-7.29: a slightly warm daylight white at unit luminance (Rec. 709 weights). */
export const DAYLIGHT_KEY_WHITE: readonly [number, number, number] = Object.freeze([1.065, 0.994, 0.864]);

/**
 * 12.10-7.29: CPU twin of the enhanced grade's key pair (the `wowHighSun` block of
 * `WORLD_LIGHT_BODY`): the authored pair with `HIGH_SUN_KEY_NEUTRAL · weight` of the diffuse band's
 * chroma traded for `DAYLIGHT_KEY_WHITE` at the band's luminance, then the pair's own headroom.
 * Weight 0 is `applyLightHeadroom` exactly.
 */
export function highSunKeyPair(
  ambient: Readonly<WorldLightColour>,
  diffuse: Readonly<WorldLightColour>,
  weight: number,
): WorldLightPair {
  const w = Number.isFinite(weight) ? Math.max(0, Math.min(1, weight)) : 0;
  if (!(w > 0.0001)) return applyLightHeadroom(ambient, diffuse);
  const luma = diffuse.r * 0.2126 + diffuse.g * 0.7152 + diffuse.b * 0.0722;
  const share = HIGH_SUN_KEY_NEUTRAL * w;
  const [wr, wg, wb] = DAYLIGHT_KEY_WHITE;
  return applyLightHeadroom(ambient, {
    r: diffuse.r + (luma * wr - diffuse.r) * share,
    g: diffuse.g + (luma * wg - diffuse.g) * share,
    b: diffuse.b + (luma * wb - diffuse.b) * share,
  });
}

function glslVec3(value: readonly [number, number, number]): string {
  return value.map((component) => component.toFixed(4)).join(", ");
}

/** Update the shared grade without recompiling any material program. */
export function setWorldLightImmersiveStrength(uniforms: WorldLightUniforms, strength: number): number {
  const bounded = Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0;
  uniforms.wowImmersiveStrength.value = bounded;
  return bounded;
}

/**
 * Warm rim/back light while the sun is low: strongest at golden hour, gone by midday and at night.
 * Only read inside the immersive branch, so lighting quality 0 never evaluates it.
 */
export function lowSunRimStrength(enabled: boolean, sunElevation: number): number {
  if (!enabled || !Number.isFinite(sunElevation)) return 0;
  const smooth = (start: number, end: number, value: number): number => {
    const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
    return t * t * (3 - 2 * t);
  };
  return smooth(-0.04, 0.06, sunElevation) * (1 - smooth(0.25, 0.6, sunElevation));
}

export function setWorldLightRim(uniforms: WorldLightUniforms, enabled: boolean, sunElevation: number): number {
  uniforms.wowRimStrength.value = lowSunRimStrength(enabled, sunElevation);
  return uniforms.wowRimStrength.value;
}

/**
 * Street lamps stay visible at dusk/night while daytime keeps the authored sunlight dominant.
 * 12.10-7.29: the same physical elevation also sets the enhanced key's high-sun weight
 * (`highSunKeyWeight`); the renderer pushes it with every light sample.
 */
export function setWorldLightDaylight(uniforms: WorldLightUniforms, sunElevation: number): number {
  const t = Number.isFinite(sunElevation) ? Math.max(0, Math.min(1, (sunElevation + 0.10) / 0.32)) : 1;
  uniforms.wowDaylight.value = t * t * (3 - 2 * t);
  uniforms.wowHighSunKey.value.x = highSunKeyWeight(sunElevation);
  return uniforms.wowDaylight.value;
}

/** A low sun warms haze most; midday keeps a little daylight scatter and night keeps none. */
export function aerialWarmthForSunElevation(elevation: number): number {
  if (!Number.isFinite(elevation)) return 0;
  const smooth = (start: number, end: number, value: number): number => {
    const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
    return t * t * (3 - 2 * t);
  };
  return smooth(-0.02, 0.12, elevation) * (1 - 0.72 * smooth(0.15, 0.8, elevation));
}

/** Update existing uniforms only: toggling aerial perspective does not rebuild material programs. */
export function setWorldLightAerialFog(
  uniforms: WorldLightUniforms,
  enabled: boolean,
  sunElevation: number,
): void {
  uniforms.wowAerialStrength.value = enabled ? 1 : 0;
  uniforms.wowAerialWarmth.value = enabled ? aerialWarmthForSunElevation(sunElevation) : 0;
}

/** CPU twin of the shader's height term; useful for checking the near/far fog joins. */
export function aerialFogFactor(base: number, cameraMinusSurfaceHeight: number, strength: number): number {
  const smooth = (start: number, end: number, value: number): number => {
    const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
    return t * t * (3 - 2 * t);
  };
  const fog = Math.max(0, Math.min(1, base));
  const below = smooth(12, 96, cameraMinusSurfaceHeight);
  const above = smooth(20, 180, -cameraMinusSurfaceHeight);
  return Math.max(0, Math.min(1, fog + Math.max(0, Math.min(1, strength))
    * fog * (1 - fog) * (0.55 * below - 0.28 * above)));
}

/** Update the shared values without replacing the uniform objects already bound to programs. */
export function setWorldLightUniforms(
  uniforms: WorldLightUniforms,
  ambient: Readonly<WorldLightColour>,
  diffuse: Readonly<WorldLightColour>,
): WorldLightPair {
  const scaled = applyLightHeadroom(ambient, diffuse);
  // 12.10-7.29: the inverse of the scale just applied (1 when the pair did not clip), so the
  // enhanced grade can rebuild the authored pair (wowHighSunKey).
  const peak = Math.max(ambient.r + diffuse.r, ambient.g + diffuse.g, ambient.b + diffuse.b);
  uniforms.wowHighSunKey.value.y = peak > 1 && Number.isFinite(peak) ? peak : 1;
  uniforms.wowLampIndoor.value = 0; // 25.10 (6.27 indoors): the sky's light, until a room replaces it
  // These are display-space multipliers. Marking the inputs as linear is how Color.setRGB keeps
  // their numeric values intact; the shader converts the final multiplier with pow(..., 2.2).
  uniforms.wowAmbient.value.setRGB(
    scaled.ambient.r, scaled.ambient.g, scaled.ambient.b, THREE.LinearSRGBColorSpace,
  );
  uniforms.wowDiffuse.value.setRGB(
    scaled.diffuse.r, scaled.diffuse.g, scaled.diffuse.b, THREE.LinearSRGBColorSpace,
  );
  return scaled;
}

/**
 * The stock indoor-M2 terms from one room colour, as `ModelPlacementTint`'s shader derives them
 * from a doodad's MODD colour: the ambient scaled down to a 96/255 peak, the diffuse up to 168/255.
 */
export const INDOOR_M2_AMBIENT_PEAK = 96 / 255;
export const INDOOR_M2_DIFFUSE_PEAK = 168 / 255;

export function indoorM2Light(colour: readonly [number, number, number]): WorldLightPair {
  const clamp = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);
  const [red, green, blue] = [clamp(colour[0]), clamp(colour[1]), clamp(colour[2])];
  const peak = Math.max(red, green, blue, 0.000001);
  const ambient = Math.min(1, INDOOR_M2_AMBIENT_PEAK / peak);
  const diffuse = Math.max(1, INDOOR_M2_DIFFUSE_PEAK / peak);
  return {
    ambient: { r: red * ambient, g: green * ambient, b: blue * ambient },
    diffuse: { r: red * diffuse, g: green * diffuse, b: blue * diffuse },
  };
}

/**
 * Light world-lit models as the room they stand in, not as the sky outside it.
 *
 * Inside an interior-only WMO there is no window for the zone's `Light.dbc` sun to come through:
 * Gundrak has no row of its own and inherits Light 1, whose key at its 19:58 visit is #ff7000 and
 * at noon #ff8800, so characters there were lit orange from a sun that changes with the clock.
 * The doodads around them already take the stock indoor-M2 path from their MODD colour
 * ({@link indoorM2Light}, fixed key direction); this gives units the same equation from the baked
 * light of the floor they stand on. No headroom, like the doodad shader it matches.
 */
export function setWorldLightIndoor(
  uniforms: WorldLightUniforms,
  colour: readonly [number, number, number],
  direction: readonly [number, number, number],
): WorldLightPair {
  const pair = indoorM2Light(colour);
  uniforms.wowAmbient.value.setRGB(pair.ambient.r, pair.ambient.g, pair.ambient.b, THREE.LinearSRGBColorSpace);
  uniforms.wowDiffuse.value.setRGB(pair.diffuse.r, pair.diffuse.g, pair.diffuse.b, THREE.LinearSRGBColorSpace);
  uniforms.wowSunDirection.value.set(direction[0], direction[1], direction[2]).normalize();
  uniforms.wowRimStrength.value = 0;
  // 12.10-7.29: a room's pair has no headroom and no sun; its grade stays the peak-normalised one.
  uniforms.wowHighSunKey.value.set(0, 1);
  // 25.10 (6.27 indoors): no sun in here, so no daylight to dim a lamp, and no shared ceiling with it.
  uniforms.wowLampIndoor.value = 1;
  return pair;
}

/** Shadow reach while suppressed: gone before the first fragment, and the cascade loop skipped. */
const SUPPRESSED_SHADOW_REACH = 0.0001;
const SUPPRESSED_SHADOW_FADES = new WeakMap<WorldLightUniforms, THREE.Vector3>();

/**
 * No sun shadow on anything these uniforms light while `suppressed`, and the configured fade back
 * afterwards. Uniform-only, so entering a dungeon recompiles nothing; a lighting-quality change made
 * meanwhile (the cascades rewrite the fade) is kept rather than overwritten by the stale copy.
 */
export function setWorldLightShadowSuppressed(uniforms: WorldLightUniforms, suppressed: boolean): void {
  const fade = uniforms.wowShadowFade.value;
  const saved = SUPPRESSED_SHADOW_FADES.get(uniforms);
  const current = fade.x === 0 && fade.y === SUPPRESSED_SHADOW_REACH;
  if (suppressed) {
    if (!saved) SUPPRESSED_SHADOW_FADES.set(uniforms, fade.clone());
    else if (!current) saved.copy(fade);
    fade.set(0, SUPPRESSED_SHADOW_REACH, fade.z);
    return;
  }
  if (!saved) return;
  if (current) fade.copy(saved);
  SUPPRESSED_SHADOW_FADES.delete(uniforms);
}

export const WORLD_LIGHT_PARS = /* glsl */ `
uniform vec3 wowSunDirection;
uniform vec3 wowDiffuse;
uniform vec3 wowAmbient;
uniform float wowImmersiveStrength;
uniform float wowDaylight;
uniform float wowRimStrength;
uniform vec2 wowHighSunKey;
uniform int wowLocalLightCount;
uniform vec4 wowLocalLightPosition[ ${WORLD_LOCAL_LIGHT_LIMIT} ];
uniform vec4 wowLocalLightColour[ ${WORLD_LOCAL_LIGHT_LIMIT} ];
uniform float wowLocalLightPool;
uniform float wowShadowAlpha;
uniform float wowLampIndoor;
#ifdef USE_SHADOWMAP
uniform vec3 wowShadowFade;
#endif
`;

/** The three includes replaced together, avoiding three's first BRDF and shadow lookup entirely. */
export const WORLD_LIGHT_TARGET = [
  "#include <lights_fragment_begin>",
  "#include <lights_fragment_maps>",
  "#include <lights_fragment_end>",
].join("\n\t");

/** Replaces three's physically-correct light integration after maps and normals have been read. */
export const WORLD_LIGHT_BODY = /* glsl */ `
vec3 wowViewSunDirection = normalize( ( viewMatrix * vec4( wowSunDirection, 0.0 ) ).xyz );
float wowDot = dot( normalize( normal ), wowViewSunDirection );
#if defined( WOW_LIGHT_TERRAIN )
  // 05.10-A7b-0 7.07: the client's terrain vertex program (Shaders/Vertex/arbvp1/terrain.bls) is
  // ambient + diffuse * clamp(N.L, 0, 1): a slope facing away from the sun has the ambient alone.
  float wowNL = max( wowDot, 0.0 );
  // The enhanced grade below was tuned against wowee's wrap (abs, floor 0.2) and keeps it, so the
  // cinematic preset looks as it did; only the classic, authored light follows the client.
  float wowGradeNL = max( abs( wowDot ), 0.2 );
#elif defined( WOW_LIGHT_FOLIAGE )
  float wowNL = abs( wowDot );
#else
  float wowNL = max( wowDot, 0.0 );
#endif
#if !defined( WOW_LIGHT_TERRAIN )
  float wowGradeNL = wowNL;
#endif
float wowShadow = 1.0;
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  if ( receiveShadow ) {
    // Sun cascades, nearest first (CascadedShadows.ts). A fragment takes the nearest map covering
    // it, handing over to the next across a band at that map's edge, and the whole term fades out
    // towards the reach measured from the camera: no edge in here is anchored to the character.
    float wowShadowReach = wowShadowFade.y > 0.0
      ? 1.0 - smoothstep( wowShadowFade.x, wowShadowFade.y, length( vViewPosition ) )
      : 1.0;
    if ( wowShadowReach > 0.0 ) {
      float wowShadowSum = 0.0;
      float wowShadowLeft = 1.0;
      float wowCascadeBand = max( wowShadowFade.z, 0.0001 );
      vec3 wowCascadeCoord;
      float wowCascadeWeight;
      #pragma unroll_loop_start
      for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
        if ( wowShadowLeft > 0.0 ) {
          wowCascadeCoord = vDirectionalShadowCoord[ i ].xyz / vDirectionalShadowCoord[ i ].w;
          wowCascadeWeight = wowCascadeCoord.z > 1.0 ? 0.0 : smoothstep( 0.0, wowCascadeBand, min(
            min( wowCascadeCoord.x, wowCascadeCoord.y ),
            min( 1.0 - wowCascadeCoord.x, 1.0 - wowCascadeCoord.y )
          ) );
          if ( wowCascadeWeight > 0.0 ) {
            wowShadowSum += wowShadowLeft * wowCascadeWeight * getShadow(
              directionalShadowMap[ i ],
              directionalLightShadows[ i ].shadowMapSize,
              directionalLightShadows[ i ].shadowIntensity,
              directionalLightShadows[ i ].shadowBias,
              directionalLightShadows[ i ].shadowRadius,
              vDirectionalShadowCoord[ i ]
            );
            wowShadowLeft *= 1.0 - wowCascadeWeight;
          }
        }
      }
      #pragma unroll_loop_end
      wowShadow = mix( 1.0, wowShadowSum + wowShadowLeft, wowShadowReach );
      #if defined( WOW_LIGHT_TERRAIN )
        // Terrain casts as well as receives (hills shade their valleys at a low sun). Where the
        // sun only grazes a slope facing it, one map texel spans a yard or more of depth and the
        // comparison speckles where the light barely reaches anyway, so the term fades out below
        // |N.L| 0.25. Back slopes keep it: their occluder is the ridge in front of them, a depth
        // gap no bias can mistake, and that ridge's shadow is the whole point.
        wowShadow = mix( 1.0, wowShadow, smoothstep( 0.05, 0.25, abs( wowDot ) ) );
      #endif
    }
  }
#endif
vec3 wowAuthoredLight = max( wowAmbient + wowDiffuse * ( wowNL * wowShadow ), vec3( 0.0 ) );
#if defined( WOW_LIGHT_TERRAIN )
  // 05.10-A7b-0 7.07: what the enhanced grade mixes against — the authored light as it was.
  vec3 wowGradeAuthored = max( wowAmbient + wowDiffuse * ( wowGradeNL * wowShadow ), vec3( 0.0 ) );
#else
  vec3 wowGradeAuthored = wowAuthoredLight;
#endif

// Softer transitions and warm bounce retain the zone's authored hue. In particular, shade no
// longer receives an extra blue multiplier and silhouettes no longer acquire a constant blue rim.
// Dark profiles get more fill relative to their key, so the effect remains visible at night.
vec3 wowLight = wowAuthoredLight;
if ( wowImmersiveStrength > 0.0001 ) {
  // 12.10-7.29: with the sun up, the key keeps its luminance but loses most of its chroma
  // (highSunKeyWeight). Light.dbc's diffuse band is a deep orange at every hour, and the authored
  // pair through its headroom lit sunlit ground (244,183,109) at an Elwynn noon. The pair is then
  // brought under one again as a whole, so the hue the grade starts from is warm white in the sun
  // against the authored cool ambient in the shade. A low sun (dawn, dusk) and the night are the
  // authored pair exactly: the branch is skipped and nothing below changes for them.
  float wowHighSun = wowHighSunKey.x;
  vec3 wowKeyAmbient = wowAmbient;
  vec3 wowKeyDiffuse = wowDiffuse;
  vec3 wowGradeBase = wowGradeAuthored;
  if ( wowHighSun > 0.0001 ) {
    vec3 wowRawAmbient = wowAmbient * wowHighSunKey.y;
    vec3 wowRawDiffuse = wowDiffuse * wowHighSunKey.y;
    float wowKeyLuma = dot( wowRawDiffuse, vec3( 0.2126, 0.7152, 0.0722 ) );
    wowRawDiffuse = mix( wowRawDiffuse, wowKeyLuma * vec3( ${glslVec3(DAYLIGHT_KEY_WHITE)} ),
      ${HIGH_SUN_KEY_NEUTRAL.toFixed(3)} * wowHighSun );
    vec3 wowPairSum = wowRawAmbient + wowRawDiffuse;
    float wowPairPeak = max( 1.0, max( max( wowPairSum.r, wowPairSum.g ), wowPairSum.b ) );
    wowKeyAmbient = wowRawAmbient / wowPairPeak;
    wowKeyDiffuse = wowRawDiffuse / wowPairPeak;
    wowGradeBase = max( wowKeyAmbient + wowKeyDiffuse * ( wowGradeNL * wowShadow ), vec3( 0.0 ) );
  }
  float wowWrappedKey = clamp( ( wowGradeNL + 0.35 ) / 1.35, 0.0, 1.0 );
  float wowAmbientLuma = dot( wowKeyAmbient, vec3( 0.2126, 0.7152, 0.0722 ) );
  float wowDarkness = 1.0 - smoothstep( 0.18, 0.55, wowAmbientLuma );
  float wowViewFacing = clamp( dot( normalize( normal ), normalize( vViewPosition ) ), 0.0, 1.0 );
  float wowRim = pow( 1.0 - wowViewFacing, 3.0 );
  // The warm push on fill and key belongs to a low sun too; with the sun up it is neutral at the
  // same luminance.
  vec3 wowSoftFill = wowKeyAmbient * mix( vec3( 1.10, 1.045, 0.98 ), vec3( 1.052 ), wowHighSun )
    * ( 1.04 + 0.18 * wowDarkness + 0.10 * ( 1.0 - wowGradeNL ) );
  // Shade leans a little towards the sky: the sun's warmth is in the key, and what a surface the
  // sun does not reach is lit by is the cool light from overhead. Warm sunlit ground against
  // blue-grey shadow is how the reference stills read; a warm fill in the shade had flattened it.
  float wowSunlit = clamp( wowGradeNL * wowShadow * 1.6, 0.0, 1.0 );
  wowSoftFill *= mix( vec3( 0.93, 0.97, 1.05 ), vec3( 1.0 ), wowSunlit );
  vec3 wowWarmKey = wowKeyDiffuse * mix( vec3( 1.08, 1.025, 0.94 ), vec3( 1.031 ), wowHighSun )
    * ( wowWrappedKey * wowShadow );
  vec3 wowImmersiveLight = wowSoftFill + wowWarmKey
    + wowKeyAmbient * 0.10 * wowRim * ( 1.0 - wowGradeNL * wowShadow );
  // The authored pair's own headroom (applyLightHeadroom): the brightest channel stops at one and the
  // whole colour scales with it, so the hue holds. A per-channel ceiling of 1.15 used to let sunlit
  // sand, snow and white stone reach 1.36x their texture after the gamma step and clip flat.
  float wowImmersivePeak = max( max( wowImmersiveLight.r, wowImmersiveLight.g ), wowImmersiveLight.b );
  vec3 wowImmersiveLit = wowImmersiveLight / max( wowImmersivePeak, 1.0 );
  // Lift the shade, keep the sun: the nearer the authored light already is to its peak, the less the
  // fill and warm key add on top. Full sun keeps a quarter of it — sunlit sand 230 -> 233, not 246,
  // which also kept it under the classic glow's knee instead of glowing on its own.
  float wowAuthoredPeak = max( max( wowGradeBase.r, wowGradeBase.g ), wowGradeBase.b );
  wowImmersiveLit = mix( wowGradeBase, wowImmersiveLit, 1.0 - 0.75 * smoothstep( 0.7, 1.0, wowAuthoredPeak ) );
  wowLight = mix( wowGradeBase, wowImmersiveLit, wowImmersiveStrength );
#if !defined( WOW_LIGHT_TERRAIN )
  if ( wowRimStrength > 0.0001 ) {
    // Low sun behind the subject: a warm sun-coloured edge on silhouettes (characters, leaves,
    // statues), strongest when the camera looks toward the sun. Terrain is excluded, where the
    // grazing distant ground would light up as a band.
    float wowBackLit = clamp( dot( normalize( -vViewPosition ), wowViewSunDirection ), 0.0, 1.0 );
    wowLight += wowDiffuse * vec3( 1.12, 0.98, 0.82 ) * wowRim
      * ( 0.2 + 0.8 * wowBackLit * wowBackLit ) * 0.9 * wowRimStrength;
  }
#endif

  // The original light integration was replaced above, so Three PointLights cannot illuminate
  // these surfaces. Bounded fixture uniforms provide their soft pools in this same draw instead.
  // 25.10 (6.27 indoors): summed apart from the grade, so a sunless room can add them past its ceiling,
  // and weighed by a daylight that is the sun's outside and none in such a room.
  vec3 wowLampLight = vec3( 0.0 );
  float wowLampDaylight = wowDaylight * ( 1.0 - wowLampIndoor );
  for ( int wowLightIndex = 0; wowLightIndex < ${WORLD_LOCAL_LIGHT_LIMIT}; wowLightIndex ++ ) {
    if ( wowLightIndex >= wowLocalLightCount ) break;
    vec4 wowLamp = wowLocalLightPosition[ wowLightIndex ];
    vec3 wowToLamp = wowLamp.xyz + vViewPosition;
    float wowLampDistance = length( wowToLamp );
    float wowLampReach = abs( wowLamp.w );
    // 22.10 (7.36): the cinematic pool's reach; an M2 light's is its own, a heuristic fixture's wider.
    float wowPoolReach = wowLamp.w < 0.0 ? wowLampReach : max( wowLampReach, ${CINEMATIC_POOL_REACH.toFixed(1)} );
    if ( wowLampDistance < ( wowLocalLightPool > 0.0 ? wowPoolReach : wowLampReach ) ) {
      float wowLampFacing = dot( normalize( normal ), wowToLamp / max( wowLampDistance, 0.001 ) );
      vec4 wowLampColour = wowLocalLightColour[ wowLightIndex ];
      float wowLampTerm;
      vec3 wowLampTint = vec3( 1.0 );
      if ( wowLamp.w < 0.0 ) {
        // 12.10-6.17: a model's own M2Light, as Wow.exe's lit M2 and terrain programs add it:
        // colour · max(N·L, 0) / (k0 + k1·d + k2·d²) under the same ceiling of one, by day as by
        // night (m2LightFalloff, M2_LIGHT_ATTENUATION), windowed to nothing at the reach.
        float wowClientFalloff = min( ${M2_LIGHT_FALLOFF_CAP.toFixed(1)}, 1.0 / max( ${M2_LIGHT_ATTENUATION[0].toFixed(3)}
          + ${M2_LIGHT_ATTENUATION[1].toFixed(3)} * wowLampDistance
          + ${M2_LIGHT_ATTENUATION[2].toFixed(3)} * wowLampDistance * wowLampDistance, 0.001 ) );
        wowLampTerm = max( wowLampFacing, 0.0 ) * wowClientFalloff
          * ( 1.0 - smoothstep( 0.75 * wowLampReach, wowLampReach, wowLampDistance ) );
      } else {
        float wowFalloff = 1.0 - smoothstep( 0.0, wowLampReach, wowLampDistance );
        float wowLampDiffuse = 0.22 + 0.78 * max( wowLampFacing, 0.0 );
        wowLampTerm = wowFalloff * wowLampDiffuse
          * ( 0.35 + 0.65 * ( 1.0 - wowLampDaylight ) )
          * ( 0.70 + 0.30 * wowDarkness );
      }
${CINEMATIC_POOL_GLSL}
      wowLampLight += wowLampColour.rgb * wowLampTint * wowLampColour.w * wowLampTerm
        * min( 1.0, wowImmersiveStrength / 0.65 );
    }
  }
  // Rim and fixture light fill toward the same ceiling rather than past it: on a surface the sun
  // already lights at the authored peak, a lamp pool or a rim on top only clipped sunlit sand and
  // stone to flat white. In shade and at night, where they matter, the room below one is theirs.
  wowLight = min( wowLight + wowLampLight * ( 1.0 - wowLampIndoor ), vec3( 1.0 ) );
  // 25.10 (6.27 indoors): a sunless room's light is under one already; its lamps go on top of it.
  wowLight = min( wowLight + wowLampLight * wowLampIndoor, vec3( 1.0 + ${(WORLD_LAMP_INDOOR_CEILING - 1).toFixed(2)} * wowLampIndoor ) );
}
reflectedLight.directDiffuse = diffuseColor.rgb * pow( wowLight, vec3( 2.2 ) );
reflectedLight.indirectDiffuse = vec3( 0.0 );
reflectedLight.directSpecular = vec3( 0.0 );
reflectedLight.indirectSpecular = vec3( 0.0 );
`;

interface WorldLightBinding {
  readonly uniforms: WorldLightUniforms;
  readonly kind: WorldLightKind;
  /** Hook and cache key that existed before the outer world-light wrapper was installed. */
  readonly previousCompile: THREE.Material["onBeforeCompile"];
  readonly previousKey: string;
}

const WORLD_LIGHT_BINDINGS = new WeakMap<THREE.Material, WorldLightBinding>();
const WORLD_LIGHT_KEY = "world-light-r185-v9"; // 24.10 (7.50): the shadow in alpha for the screen-space pools
/** 24.10 (7.50): three's last fragment chunk, after which the shadow is written to alpha. */
const SHADOW_ALPHA_TARGET = "#include <dithering_fragment>"; // 05.10-A7b-0 7.07: terrain N.L; 12.10: 7.29 high-sun key, 6.17 M2 falloff; 22.10: 7.36 pool

/**
 * The scene's Light.dbc fog is the floor of this effect. At strength zero the shader below is the
 * stock three.js linear/exp2 fog equation; at strength one its middle distances gain a little
 * altitude-dependent density and a sun-facing tint. Both additions vanish at the camera and at
 * the authored far plane, so the WDL horizon and sky keep their exact original join.
 *
 * Fog runs after colour-space conversion in three r185, so the tint is in display space too.
 * `wowAtmosphereView.w` is camera altitude minus fragment altitude, reconstructed from the final
 * view-space position. This also works for skinned and instanced meshes; transforming their raw
 * local vertex through modelMatrix would lose skinning/instance offsets.
 */
export const WORLD_AERIAL_FOG_BODY = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  float wowAerialFogFactor = fogFactor;
  if ( wowAerialStrength > 0.0001 ) {
    float wowBelowCamera = smoothstep( 12.0, 96.0, wowAtmosphereView.w );
    float wowAboveCamera = smoothstep( 20.0, 180.0, -wowAtmosphereView.w );
    float wowHeightChange = 0.55 * wowBelowCamera - 0.28 * wowAboveCamera;
    wowAerialFogFactor = clamp(
      fogFactor + wowAerialStrength * fogFactor * ( 1.0 - fogFactor ) * wowHeightChange,
      0.0, 1.0
    );
  }
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, wowAerialFogFactor );
  if ( wowAerialStrength > 0.0001 && wowAerialWarmth > 0.0001 ) {
    vec3 wowViewSun = normalize( ( viewMatrix * vec4( wowSunDirection, 0.0 ) ).xyz );
    vec3 wowViewRay = normalize( -wowAtmosphereView.xyz );
    float wowSunFacing = smoothstep( 0.25, 0.9, dot( wowViewRay, wowViewSun ) );
    float wowMiddleDistance = 4.0 * wowAerialFogFactor * ( 1.0 - wowAerialFogFactor );
    gl_FragColor.rgb = min(
      gl_FragColor.rgb + vec3( 0.10, 0.045, 0.008 )
        * wowAerialStrength * wowAerialWarmth * wowSunFacing * wowMiddleDistance,
      vec3( 1.0 )
    );
  }
#endif
`;

const WORLD_AERIAL_FOG_PARS = /* glsl */ `
uniform float wowAerialStrength;
uniform float wowAerialWarmth;
varying vec4 wowAtmosphereView;
`;

const WORLD_AERIAL_FOG_VERTEX = /* glsl */ `
#include <project_vertex>
  wowAtmosphereView = vec4(
    -mvPosition.xyz,
    -dot( viewMatrix[ 1 ].xyz, mvPosition.xyz )
  );
`;

type WorldShader = Parameters<THREE.Material["onBeforeCompile"]>[0];

function injectWorldAerialFog(shader: WorldShader, uniforms: WorldLightUniforms): void {
  const vertexMarker = "#include <project_vertex>";
  const fragmentMarker = "#include <fog_fragment>";
  // Authored M2/WMO hooks may own their fog block. Leave those materials' existing fog intact.
  if (!shader.vertexShader.includes(vertexMarker) || !shader.fragmentShader.includes(fragmentMarker)) return;
  shader.uniforms.wowAerialStrength = uniforms.wowAerialStrength;
  shader.uniforms.wowAerialWarmth = uniforms.wowAerialWarmth;
  shader.vertexShader = `varying vec4 wowAtmosphereView;\n${shader.vertexShader}`
    .replace(vertexMarker, WORLD_AERIAL_FOG_VERTEX);
  shader.fragmentShader = `${WORLD_AERIAL_FOG_PARS}\n${shader.fragmentShader}`
    .replace(fragmentMarker, WORLD_AERIAL_FOG_BODY);
}

const HORIZON_AERIAL_BINDINGS = new WeakMap<THREE.MeshBasicMaterial, WorldLightUniforms>();

/** Give the distant WDL ground the same aerial perspective as near terrain and models. */
export function applyHorizonAerialFog(material: THREE.MeshBasicMaterial, uniforms: WorldLightUniforms): void {
  const existing = HORIZON_AERIAL_BINDINGS.get(material);
  if (existing) {
    if (existing !== uniforms) throw new Error("Horizon aerial fog was rebound with conflicting uniforms");
    return;
  }
  HORIZON_AERIAL_BINDINGS.set(material, uniforms);
  const previousCompile = material.onBeforeCompile;
  const pristine = previousCompile === THREE.Material.prototype.onBeforeCompile
    && material.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey;
  const previousKey = pristine ? "" : material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.wowSunDirection = uniforms.wowSunDirection;
    shader.fragmentShader = `uniform vec3 wowSunDirection;\n${shader.fragmentShader}`;
    injectWorldAerialFog(shader, uniforms);
  };
  material.customProgramCacheKey = () => [previousKey, "horizon-aerial-fog-v1"].filter(Boolean).join("|");
  material.needsUpdate = true;
}

export type WorldLightKind = "surface" | "terrain" | "foliage";
export type WorldLitMaterial = THREE.MeshLambertMaterial | THREE.MeshStandardMaterial;

/**
 * Clone a material shell for a portrait without importing world-only shader state.
 *
 * Three.js Material.clone() deliberately resets `onBeforeCompile` and
 * `customProgramCacheKey`, which is unsafe for model materials: the build may have an authored
 * second-layer/fog chain, and `applyWorldLight` adds one outer wrapper around that chain. For a
 * world-lit source restore the hook/key captured before that wrapper; for every other source carry
 * the current hook/key through unchanged. Maps and all ordinary material flags remain shared/copied
 * by Material.clone(), while the returned shell is owned by its caller and has no world binding.
 */
export function cloneMaterialForPortrait(material: THREE.Material): THREE.Material {
  const binding = WORLD_LIGHT_BINDINGS.get(material);
  const previousCompile = binding?.previousCompile ?? material.onBeforeCompile;
  const previousKey = binding?.previousKey ?? material.customProgramCacheKey();
  const clone = material.clone();
  clone.onBeforeCompile = previousCompile;
  clone.customProgramCacheKey = () => previousKey;
  return clone;
}

/**
 * Add the authored world-light equation after every hook already installed on the material.
 *
 * M2 can already carry two texture/fog substitutions and terrain has its splat substitution. The
 * previous handler and cache key are therefore part of this handler rather than overwritten.
 */
export function applyWorldLight(
  material: WorldLitMaterial,
  uniforms: WorldLightUniforms,
  kind: WorldLightKind,
): void {
  const existing = WORLD_LIGHT_BINDINGS.get(material);
  if (existing) {
    if (existing.uniforms !== uniforms || existing.kind !== kind) {
      throw new Error("World light material was rebound with conflicting uniforms or surface mode");
    }
    return;
  }

  const previousCompile = material.onBeforeCompile;
  // Evaluate before replacing onBeforeCompile. Material's default key is the handler's source,
  // and evaluating it afterwards would describe this wrapper rather than the hook it preserves.
  const pristine = previousCompile === THREE.Material.prototype.onBeforeCompile
    && material.customProgramCacheKey === THREE.Material.prototype.customProgramCacheKey;
  const previousKey = pristine ? "" : material.customProgramCacheKey();
  const binding: WorldLightBinding = {
    uniforms,
    kind,
    previousCompile,
    previousKey,
  };
  WORLD_LIGHT_BINDINGS.set(material, binding);

  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    shader.uniforms.wowSunDirection = binding.uniforms.wowSunDirection;
    shader.uniforms.wowDiffuse = binding.uniforms.wowDiffuse;
    shader.uniforms.wowAmbient = binding.uniforms.wowAmbient;
    shader.uniforms.wowImmersiveStrength = binding.uniforms.wowImmersiveStrength;
    shader.uniforms.wowDaylight = binding.uniforms.wowDaylight;
    shader.uniforms.wowRimStrength = binding.uniforms.wowRimStrength;
    shader.uniforms.wowHighSunKey = binding.uniforms.wowHighSunKey;
    shader.uniforms.wowLocalLightCount = binding.uniforms.wowLocalLightCount;
    shader.uniforms.wowLocalLightPosition = binding.uniforms.wowLocalLightPosition;
    shader.uniforms.wowLocalLightColour = binding.uniforms.wowLocalLightColour;
    shader.uniforms.wowLocalLightPool = binding.uniforms.wowLocalLightPool; // 22.10 (7.36)
    shader.uniforms.wowShadowFade = binding.uniforms.wowShadowFade;
    shader.uniforms.wowShadowAlpha = binding.uniforms.wowShadowAlpha; // 24.10 (7.50)
    shader.uniforms.wowLampIndoor = binding.uniforms.wowLampIndoor; // 25.10 (6.27 indoors)
    const unindentedTarget = WORLD_LIGHT_TARGET.replaceAll("\n\t", "\n");
    const target = shader.fragmentShader.includes(WORLD_LIGHT_TARGET)
      ? WORLD_LIGHT_TARGET
      // Three's stock shaders indent these directives with one tab. A prior hook is allowed to
      // reformat whitespace, so accept the unindented form too while still requiring all three.
      : unindentedTarget;
    const occurrences = shader.fragmentShader.split(target).length - 1;
    if (occurrences !== 1) {
      throw new Error(`World light expected one three.js light integration block, found ${occurrences}`);
    }
    const define = binding.kind === "terrain"
      ? "#define WOW_LIGHT_TERRAIN\n"
      : binding.kind === "foliage" ? "#define WOW_LIGHT_FOLIAGE\n" : "";
    shader.fragmentShader = `${define}${WORLD_LIGHT_PARS}\n${shader.fragmentShader}`
      .replace(target, WORLD_LIGHT_BODY);
    // 24.10 (7.50): an opaque surface hands its sun shadow to the screen-space pools; a blended one
    // keeps its alpha, which its blending reads.
    if (!material.transparent && shader.fragmentShader.split(SHADOW_ALPHA_TARGET).length === 2) {
      shader.fragmentShader = shader.fragmentShader.replace(SHADOW_ALPHA_TARGET, `${SHADOW_ALPHA_TARGET}\n${WORLD_SHADOW_ALPHA_GLSL}`);
    }
    injectWorldAerialFog(shader, binding.uniforms);
  };
  material.customProgramCacheKey = () => [
    previousKey,
    `${WORLD_LIGHT_KEY}:${binding.kind}${material.transparent ? ":blend" : ""}`, // 24.10 (7.50)
  ].filter(Boolean).join("|");
  material.needsUpdate = true;
}
