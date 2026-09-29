/**
 * The ground after rain (`experimentalWetSurfaces`) and the rings raindrops leave on water and on
 * puddles (`experimentalRainSplashes`).
 *
 * Both are post-hooks over materials the renderer already owns, in the same binding style as the
 * terrain micro-normals and the water profile: installed once per material, toggled by a flag that
 * recompiles, and when OFF they call the captured hook and return — the source and the cache key
 * are then exactly what they were before this file existed.
 *
 * `WET_SURFACE_UNIFORMS` is deliberately public and renderer-wide: `wetness` (0 dry … 1 soaked)
 * rises slowly while it rains and dries slower still, and any other lane (lighting, WMO, models)
 * may read the same uniform object to agree with the terrain about how wet the world is.
 */

import * as THREE from "three";
import type { IUniform } from "three";

export interface WetSurfaceUniforms {
  /** 0 dry … 1 soaked. Eased by AtmosphereEffects, never jumps. */
  readonly wetness: IUniform<number>;
  /** 0 … 1: how hard rain is hitting right now (drives the rings). */
  readonly rain: IUniform<number>;
  /** Seconds, the rings' clock. */
  readonly time: IUniform<number>;
  /** Zone fog/sky colour the wet sheen mirrors (display-referred, like the water's sky colour). */
  readonly sky: IUniform<THREE.Color>;
  /**
   * 0 … 1: how far rain or snow has thickened the air into a veil (eased, never jumps). The
   * renderer pulls the zone fog in by it (`applyPrecipitationHaze`); a post pass that wants to
   * soften contrast or lift the shadows in a downpour reads this same uniform object — nothing
   * else has to be wired, and it stays at 0 whenever `experimentalRainStreaks` is OFF.
   */
  readonly haze: IUniform<number>;
}

export const WET_SURFACE_UNIFORMS: WetSurfaceUniforms = Object.freeze({
  wetness: { value: 0 },
  rain: { value: 0 },
  time: { value: 0 },
  sky: { value: new THREE.Color(0x87b5d6) },
  haze: { value: 0 },
});

export const WET_SURFACE_MARKER = "wet-surface-v1";
export const RAIN_RIPPLE_MARKER = "rain-ripple-v1";

/** Seconds of steady rain to soak the ground (time constant), and to dry it again. */
export const WET_SOAK_SECONDS = 18;
export const WET_DRY_SECONDS = 70;

/** One frame of soaking or drying, towards `target` (0..1). */
export function advanceWetness(current: number, target: number, elapsed: number): number {
  const step = Number.isFinite(elapsed) ? Math.max(0, Math.min(1, elapsed)) : 0;
  const goal = Math.max(0, Math.min(1, Number.isFinite(target) ? target : 0));
  const now = Math.max(0, Math.min(1, Number.isFinite(current) ? current : 0));
  const tau = goal > now ? WET_SOAK_SECONDS : WET_DRY_SECONDS;
  return now + (goal - now) * (1 - Math.exp(-step / tau));
}

/** Two offset cell grids of expanding rings; returns 0..~1 ring brightness at `p` (yards). */
const RIPPLE_GLSL = `
float rainRippleLayer( vec2 p, float t, float seed ) {
  vec2 cell = floor( p );
  vec2 f = fract( p );
  vec2 h = fract( sin( vec2( dot( cell, vec2( 127.1, 311.7 ) ), dot( cell, vec2( 269.5, 183.3 ) ) ) + seed ) * 43758.5453 );
  vec2 centre = 0.28 + 0.44 * h;
  float life = fract( t * 1.15 + h.x * 7.13 + h.y * 3.7 );
  float radius = life * 0.4;
  float d = length( f - centre );
  float ring = 1.0 - smoothstep( 0.0, 0.055, abs( d - radius ) );
  return ring * ( 1.0 - life ) * ( 1.0 - life );
}
float rainRipples( vec2 p, float t ) {
  vec2 q = p * 1.35;
  return rainRippleLayer( q, t, 0.0 ) + rainRippleLayer( q + vec2( 0.5, 0.37 ), t + 0.41, 3.1 );
}
`;

type ShaderSource = Parameters<THREE.Material["onBeforeCompile"]>[0];
type ShaderRenderer = Parameters<THREE.Material["onBeforeCompile"]>[1];

interface Binding {
  readonly previousCompile: (shader: ShaderSource, renderer: ShaderRenderer) => void;
  readonly previousKey: string;
  enabled: boolean;
  /** Part of the cache key: which compiled variant the hook injects (e.g. with/without rings). */
  variant: string;
}

const TERRAIN_WET_BINDINGS = new WeakMap<THREE.Material, Binding>();
const WATER_RIPPLE_BINDINGS = new WeakMap<THREE.Material, Binding>();

function bind(
  bindings: WeakMap<THREE.Material, Binding>, material: THREE.Material, enabled: boolean, variant: string,
  inject: (shader: ShaderSource, binding: Binding) => void,
): void {
  const existing = bindings.get(material);
  if (existing) {
    if (existing.enabled !== enabled || (enabled && existing.variant !== variant)) {
      existing.enabled = enabled;
      if (enabled) existing.variant = variant;
      material.needsUpdate = true;
    }
    return;
  }
  // An OFF request for a material that never had the hook is a strict no-op: nothing wrapped.
  if (!enabled) return;
  const binding: Binding = {
    previousCompile: material.onBeforeCompile,
    previousKey: material.customProgramCacheKey(),
    enabled,
    variant,
  };
  bindings.set(material, binding);
  material.onBeforeCompile = (shader, renderer) => {
    binding.previousCompile.call(material, shader, renderer);
    if (!binding.enabled) return;
    inject(shader, binding);
  };
  material.customProgramCacheKey = () => binding.enabled
    ? `${binding.previousKey}|${binding.variant}`
    : binding.previousKey;
  material.needsUpdate = true;
}

/** Whether the installed hook would change `material` right now. */
export function wetSurfaceEnabled(material: THREE.Material): boolean {
  return TERRAIN_WET_BINDINGS.get(material)?.enabled === true;
}

export function rainRippleEnabled(material: THREE.Material): boolean {
  return WATER_RIPPLE_BINDINGS.get(material)?.enabled === true;
}

/**
 * Splatted terrain darkens as it soaks (flat ground more than slopes, with puddle patches on the
 * flats), takes a fresnel sheen of the sky, and shows raindrop rings in the puddles while it rains.
 * `rings` adds the ring term (experimentalRainSplashes); the sheen/darkening is the wet profile.
 */
export function setTerrainWetness(
  material: THREE.MeshLambertMaterial | THREE.MeshStandardMaterial, enabled: boolean, rings: boolean,
): void {
  const ringVariant = `${WET_SURFACE_MARKER}-rings`;
  bind(TERRAIN_WET_BINDINGS, material, enabled, rings ? ringVariant : WET_SURFACE_MARKER,
    (shader, binding) => injectTerrainWetness(shader, binding.variant === ringVariant));
}

/**
 * Exterior WMO surfaces (city streets, walls, roofs) soak the same way. The renderer's material
 * cache owns these materials, so they are tracked here until they are disposed, and one call
 * flips every live one when the setting changes.
 */
const TRACKED_WMO_SURFACES = new Set<THREE.MeshStandardMaterial>();
let wmoWetness = { enabled: false, rings: false };

export function trackWmoWetSurface(material: THREE.MeshStandardMaterial): void {
  if (TRACKED_WMO_SURFACES.has(material)) return;
  TRACKED_WMO_SURFACES.add(material);
  material.addEventListener("dispose", () => { TRACKED_WMO_SURFACES.delete(material); });
  if (wmoWetness.enabled) setTerrainWetness(material, true, wmoWetness.rings);
}

export function setWmoWetness(enabled: boolean, rings: boolean): void {
  wmoWetness = { enabled, rings };
  for (const material of TRACKED_WMO_SURFACES) setTerrainWetness(material, enabled, rings);
}

/** Live exterior WMO materials currently tracked (diagnostics/tests). */
export function trackedWmoWetSurfaces(): number {
  return TRACKED_WMO_SURFACES.size;
}

function injectTerrainWetness(shader: ShaderSource, rings: boolean): void {
  const beginVertex = "#include <begin_vertex>";
  const emissive = "#include <emissivemap_fragment>";
  const opaque = "#include <opaque_fragment>";
  if (shader.fragmentShader.includes(WET_SURFACE_MARKER)) return;
  // A cosmetic layer never breaks a compile: if an upstream hook reshaped the shader, skip it.
  if (shader.vertexShader.split(beginVertex).length !== 2
    || shader.fragmentShader.split(emissive).length !== 2
    || shader.fragmentShader.split(opaque).length !== 2) return;
  shader.uniforms["uWetness"] = WET_SURFACE_UNIFORMS.wetness;
  shader.uniforms["uWetRain"] = WET_SURFACE_UNIFORMS.rain;
  shader.uniforms["uWetTime"] = WET_SURFACE_UNIFORMS.time;
  shader.uniforms["uWetSky"] = WET_SURFACE_UNIFORMS.sky;
  shader.vertexShader = `varying vec3 vWetWorld;\n${shader.vertexShader}`.replace(beginVertex,
    `${beginVertex}\n  vWetWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`);
  shader.fragmentShader = `uniform float uWetness;
uniform float uWetRain;
uniform float uWetTime;
uniform vec3 uWetSky;
varying vec3 vWetWorld;
${rings ? RIPPLE_GLSL : ""}
${shader.fragmentShader}`
    .replace(emissive, `/* ${WET_SURFACE_MARKER} */
  vec3 wetUpView = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
  float wetFlat = smoothstep( 0.6, 0.93, dot( normal, wetUpView ) );
  // Small, irregular puddles: two warped sine lattices a few yards across, only on the flats.
  float wetNoise = sin( vWetWorld.x * 0.83 + 1.9 * sin( vWetWorld.z * 0.51 ) )
    * sin( vWetWorld.z * 0.71 - 2.3 * sin( vWetWorld.x * 0.43 ) );
  float wetPuddle = smoothstep( 0.45, 0.8, wetNoise ) * wetFlat * smoothstep( 0.35, 1.0, uWetness );
  float wetAmount = uWetness * ( 0.5 + 0.5 * wetFlat );
  diffuseColor.rgb *= 1.0 - 0.28 * wetAmount - 0.14 * wetPuddle;
${emissive}`)
    .replace(opaque, `
  vec3 wetViewDir = normalize( vViewPosition );
  float wetFacing = clamp( dot( normal, wetViewDir ), 0.0, 1.0 );
  float wetFresnel = pow( 1.0 - wetFacing, 4.0 );
  vec3 wetSkyLinear = pow( max( uWetSky, vec3( 0.0 ) ), vec3( 2.2 ) );
  // A puddle mirrors an overcast sky: half-desaturated, so a tinted zone fog does not stain it.
  wetSkyLinear = mix( vec3( dot( wetSkyLinear, vec3( 0.2126, 0.7152, 0.0722 ) ) ), wetSkyLinear, 0.5 );
  float wetSheen = uWetness * wetFlat * ( 0.08 + 0.45 * wetPuddle ) * wetFresnel;
  outgoingLight = mix( outgoingLight, wetSkyLinear, clamp( wetSheen, 0.0, 0.45 ) );
  ${rings ? `float wetRingFade = 1.0 - smoothstep( 18.0, 42.0, length( vViewPosition ) );
  float wetRings = rainRipples( vWetWorld.xz, uWetTime ) * uWetRain * wetRingFade
    * ( 0.4 * wetFlat * uWetness + 0.9 * wetPuddle );
  outgoingLight += wetSkyLinear * wetRings * 0.5;` : ""}
${opaque}`);
}

/**
 * Raindrop rings on open water/ocean: expanding circles that catch the sky, fading with distance
 * so they never alias into sparkle. Works with or without the water shader profile.
 */
export function setWaterRainRipples(material: THREE.MeshBasicMaterial, enabled: boolean): void {
  bind(WATER_RIPPLE_BINDINGS, material, enabled, RAIN_RIPPLE_MARKER, (shader) => injectWaterRipples(shader));
}

function injectWaterRipples(shader: ShaderSource): void {
  const beginVertex = "#include <begin_vertex>";
  const opaque = "#include <opaque_fragment>";
  if (shader.fragmentShader.includes(RAIN_RIPPLE_MARKER)) return;
  if (shader.vertexShader.split(beginVertex).length !== 2
    || shader.fragmentShader.split(opaque).length !== 2) return;
  shader.uniforms["uWetRain"] = WET_SURFACE_UNIFORMS.rain;
  shader.uniforms["uWetTime"] = WET_SURFACE_UNIFORMS.time;
  shader.uniforms["uWetSky"] = WET_SURFACE_UNIFORMS.sky;
  shader.vertexShader = `varying vec3 vRainRippleWorld;\n${shader.vertexShader}`.replace(beginVertex,
    `${beginVertex}\n  vRainRippleWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`);
  shader.fragmentShader = `uniform float uWetRain;
uniform float uWetTime;
uniform vec3 uWetSky;
varying vec3 vRainRippleWorld;
${RIPPLE_GLSL}
${shader.fragmentShader}`.replace(opaque, `/* ${RAIN_RIPPLE_MARKER} */
  if ( uWetRain > 0.0 ) {
    float rainRippleFade = 1.0 - smoothstep( 26.0, 65.0, distance( cameraPosition, vRainRippleWorld ) );
    float rainRipple = rainRipples( vRainRippleWorld.xz, uWetTime ) * uWetRain * rainRippleFade;
    vec3 rainRippleSky = pow( max( uWetSky, vec3( 0.0 ) ), vec3( 2.2 ) );
    outgoingLight = mix( outgoingLight, rainRippleSky * 1.2 + outgoingLight * 0.3, clamp( rainRipple * 0.8, 0.0, 0.75 ) );
    diffuseColor.a = min( 1.0, diffuseColor.a + rainRipple * 0.16 );
  }
${opaque}`);
}
