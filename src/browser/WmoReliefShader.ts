import * as THREE from "three";
import { lightingClassicLook } from "./LightingQuality.js";
import { TERRAIN_RELIEF_DEPTH, TERRAIN_RELIEF_NORMAL_BOOST } from "./TerrainReliefDerive.js";
import {
  TERRAIN_RELIEF_FADE_FAR, TERRAIN_RELIEF_FADE_NEAR, TERRAIN_RELIEF_GRAZING, TERRAIN_RELIEF_MAX_STEPS,
  TERRAIN_RELIEF_MIN_STEPS, TERRAIN_RELIEF_SHADOW_STEPS,
} from "./TerrainReliefShader.js";
import { WMO_MATERIAL_SIDN, WMO_MATERIAL_WINDOW } from "./WmoMaterials.js";
import { WMO_RELIEF_FLAT, WmoReliefMaps, type WmoReliefMapStats } from "./WmoReliefMaps.js";

/**
 * 22.10 (7.47 stage 2): «Объём зданий» — the ground's relief (stage 1, `TerrainReliefShader.ts`) on
 * building surfaces: stone walls, cobbles, brick, roof tiles, planks.
 *
 * Which runs. The WMO artifact names its textures by URL only (`/visual/texture/<hash>-<n>.png`), so
 * there is no path to match an allowlist against at run time; what decides is what the run is and
 * what its texture holds. A run gets relief when it is opaque (blend mode 0: no alpha test, no
 * blending), not clamped (0x40/0x80: trims and decals), not a window (MOMT 0x20, or 0x10, the
 * night-lit glass), not an environment-mapped or Composite look, not drawn unlit (F_UNLIT exterior
 * glass) — and its texture's band-passed contrast clears `WMO_RELIEF_MIN_CONTRAST`
 * (`WmoReliefDerive.ts`). A name list would not do even with the paths: Blizzard names these
 * textures by part, not material (MM_STRMWND_WALL_05, _TRIM_02, MM_STREET_02, MM_MM_SIDEWALK_01,
 * _SUPPORTS_01), so «stone|cobble|brick|rock|plank|roof|tile» covers 7.5 % of Stormwind's drawn
 * triangles and this rule 96 % — everything but the clamped lamps, the windows, banners and rugs.
 *
 * How. WMO UVs are not planar, so the tangent frame comes from the screen derivatives of the view
 * position and the UV (the cotangent frame: ∇u and ∇v on the face's plane, in UV per yard). The
 * depth is {@link WMO_RELIEF_DEPTH_UV} of a texture repeat, at most {@link WMO_RELIEF_DEPTH_MAX}
 * yards — gentler than the ground, since walls are mostly seen at a grazing angle. The march, the
 * steps and the distance fade are the ground's: 5–10 steps, full to 35 yards, none past 85, nothing
 * below a 9° view; the march's shift is capped at 1/0.3 of the depth, so a silhouette never swims.
 * A lit run (exterior, transition) also takes the derived normal into the world light and the soft
 * sun self-shadow; a room's run (MOCV-lit, no sun) takes the parallax alone.
 *
 * Program keys. A material is bound when it is built (or when the leaf turns on), with its key
 * {@link WMO_RELIEF_MARKER}; its map arrives later through a uniform — a 1×1 flat stand-in and a
 * switch at 0 until then — so the program never changes while playing. Off, or on a classic level
 * (lighting quality 0 and the comparison level 3), nothing is wrapped and every program is exactly
 * what it was.
 */

/** 22.10 (7.47 stage 2): bumped when the injected program changes; part of the cache key. */
export const WMO_RELIEF_PROFILE_VERSION = 1;
export const WMO_RELIEF_MARKER = `wmo-relief-v${WMO_RELIEF_PROFILE_VERSION}`;
/** 22.10 (7.47 stage 2): the relief's depth in UV units of the run's texture (the ground's is 0.03). */
export const WMO_RELIEF_DEPTH_UV = 0.02;
/** 22.10 (7.47 stage 2): and never deeper than this, in yards (≈ 7 cm), however large the texture's repeat. */
export const WMO_RELIEF_DEPTH_MAX = 0.08;
/** 22.10 (7.47 stage 2): the share of the sun term a stone's own shadow may take (the ground's is 0.6). */
export const WMO_RELIEF_SHADOW_STRENGTH = 0.5;
/**
 * 22.10 (7.47 stage 2): the derived normal's tilt over the one the depth implies, and its cap
 * (tangent of the tilt). At full strength a wall facing away from the sun lit up stone by stone and
 * the steep joints took the sky-blue rim light (the stills of the first pass); half, capped at ≈ 17°,
 * keeps the stones' shape without relighting the wall.
 */
export const WMO_RELIEF_NORMAL_STRENGTH = 0.5;
export const WMO_RELIEF_NORMAL_MAX_TILT = 0.3;

export type WmoReliefVariant = "lit" | "room";

export interface WmoReliefRun {
  readonly url: string;
  readonly blendMode: number;
  readonly materialFlags: number;
  /** Drawn by the unlit program (F_UNLIT honoured): no light for the relief to shape. */
  readonly unlit: boolean;
  /** 0x40/0x80 clamp. */
  readonly clamped: boolean;
  /** The run's look samples an environment map or a second layer (`WmoRunLook.ts`). */
  readonly envOrComposite: boolean;
  /** Drawn as a room's inside: MeshBasicMaterial × MOCV, no sun. */
  readonly interior: boolean;
}

/** 22.10 (7.47 stage 2): which relief a run gets, if any (see the file comment). */
export function wmoRunReliefVariant(run: WmoReliefRun): WmoReliefVariant | undefined {
  if (!run.url || run.blendMode !== 0 || run.unlit || run.clamped || run.envOrComposite) return undefined;
  if ((run.materialFlags & (WMO_MATERIAL_WINDOW | WMO_MATERIAL_SIDN)) !== 0) return undefined;
  return run.interior ? "room" : "lit";
}

/** 22.10 (7.47 stage 2): the leaf on the levels that may draw it — never the classic ones. */
export function wmoReliefActive(enabled: boolean, lightingQuality: number): boolean {
  return enabled && !lightingClassicLook(lightingQuality);
}

/** 22.10 (7.47 stage 2): the depth (yards) the shader marches for a texture repeating every `yardsPerRepeat`. */
export function wmoReliefDepth(yardsPerRepeat: number): number {
  return Math.min(WMO_RELIEF_DEPTH_UV * Math.max(0, yardsPerRepeat), WMO_RELIEF_DEPTH_MAX);
}

type ShaderSource = Parameters<THREE.Material["onBeforeCompile"]>[0];
type ShaderRenderer = Parameters<THREE.Material["onBeforeCompile"]>[1];

const f = (value: number) => value.toFixed(4);

const PROJECT_MARKER = "#include <project_vertex>";
const LOGDEPTH_MARKER = "#include <logdepthbuf_fragment>";
const MAP_MARKER = "#include <map_fragment>";
const MAP_SAMPLE = "texture2D( map, vMapUv )";
const NORMAL_MARKER = "#include <normal_fragment_maps>";
const SUN_MARKER = "vec3 wowAuthoredLight = max( wowAmbient + wowDiffuse * ( wowNL * wowShadow ), vec3( 0.0 ) );";

const VERTEX_PARS = /* glsl */ `varying vec3 vWmoReliefView;\n`;
const VERTEX_BODY = /* glsl */ `
  vWmoReliefView = - mvPosition.xyz; // ${WMO_RELIEF_MARKER}
`;

const FRAGMENT_PARS = /* glsl */ `
uniform sampler2D wmoRelief;
uniform float wmoReliefOn;
varying vec3 vWmoReliefView;
`;

/** The frame and the march, before any colour tap; declares what the later stages read. */
const MARCH = /* glsl */ `
  // ${WMO_RELIEF_MARKER}: (22.10, 7.47 stage 2) the cotangent frame from the screen derivatives.
  float wmoReliefFade = 0.0;
  float wmoReliefScale = 0.0;
  float wmoReliefDepth = 0.0;
  float wmoReliefSurface = 0.0;
  vec3 wmoReliefN = vec3( 0.0, 0.0, 1.0 );
  vec3 wmoReliefGu = vec3( 0.0 );
  vec3 wmoReliefGv = vec3( 0.0 );
#ifdef USE_MAP
  vec2 wmoReliefUv = vMapUv;
  vec2 wmoReliefGx = dFdx( vMapUv );
  vec2 wmoReliefGy = dFdy( vMapUv );
  vec3 wmoReliefDp1 = dFdx( - vWmoReliefView );
  vec3 wmoReliefDp2 = dFdy( - vWmoReliefView );
  vec3 wmoReliefCross = cross( wmoReliefDp1, wmoReliefDp2 );
  vec3 wmoReliefV = normalize( vWmoReliefView );
  wmoReliefN = wmoReliefCross / max( length( wmoReliefCross ), 1e-20 );
  if ( dot( wmoReliefN, wmoReliefV ) < 0.0 ) wmoReliefN = - wmoReliefN;
  float wmoReliefDet = dot( wmoReliefN, wmoReliefCross );
  float wmoReliefInverse = abs( wmoReliefDet ) > 1e-20 ? 1.0 / wmoReliefDet : 0.0;
  vec3 wmoReliefQ1 = cross( wmoReliefN, wmoReliefDp1 );
  vec3 wmoReliefQ2 = cross( wmoReliefDp2, wmoReliefN );
  // ∇u and ∇v on the face's plane, in UV per yard (view space).
  wmoReliefGu = ( wmoReliefQ2 * wmoReliefGx.x + wmoReliefQ1 * wmoReliefGy.x ) * wmoReliefInverse;
  wmoReliefGv = ( wmoReliefQ2 * wmoReliefGx.y + wmoReliefQ1 * wmoReliefGy.y ) * wmoReliefInverse;
  float wmoReliefVN = dot( wmoReliefV, wmoReliefN );
  wmoReliefDepth = min( ${f(WMO_RELIEF_DEPTH_UV)} / max( max( length( wmoReliefGu ), length( wmoReliefGv ) ), 1e-6 ), ${f(WMO_RELIEF_DEPTH_MAX)} );
  wmoReliefFade = wmoReliefOn * step( 1e-20, abs( wmoReliefDet ) )
    * ( 1.0 - smoothstep( ${f(TERRAIN_RELIEF_FADE_NEAR)}, ${f(TERRAIN_RELIEF_FADE_FAR)}, length( vWmoReliefView ) ) )
    * smoothstep( ${f(TERRAIN_RELIEF_GRAZING * 0.5)}, ${f(TERRAIN_RELIEF_GRAZING)}, wmoReliefVN );
  wmoReliefScale = wmoReliefDepth * wmoReliefFade;
  if ( wmoReliefFade > 0.0 ) {
    vec3 wmoReliefVt = wmoReliefV - wmoReliefN * wmoReliefVN;
    vec2 wmoReliefShift = vec2( dot( wmoReliefGu, wmoReliefVt ), dot( wmoReliefGv, wmoReliefVt ) )
      / max( wmoReliefVN, 0.3 ) * wmoReliefScale;
    float wmoSteps = floor( mix( ${f(TERRAIN_RELIEF_MAX_STEPS)}, ${f(TERRAIN_RELIEF_MIN_STEPS)}, clamp( wmoReliefVN, 0.0, 1.0 ) ) );
    float wmoLayerStep = 1.0 / wmoSteps;
    vec2 wmoUvStep = wmoReliefShift * wmoLayerStep;
    float wmoLayer = 0.0;
    float wmoDepth = 1.0 - textureGrad( wmoRelief, wmoReliefUv, wmoReliefGx, wmoReliefGy ).b;
    float wmoPreviousDepth = wmoDepth;
    vec2 wmoUv = wmoReliefUv;
    for ( int wmoStep = 0; wmoStep < ${TERRAIN_RELIEF_MAX_STEPS}; wmoStep++ ) {
      if ( float( wmoStep ) >= wmoSteps || wmoLayer >= wmoDepth ) break;
      wmoUv -= wmoUvStep;
      wmoLayer += wmoLayerStep;
      wmoPreviousDepth = wmoDepth;
      wmoDepth = 1.0 - textureGrad( wmoRelief, wmoUv, wmoReliefGx, wmoReliefGy ).b;
    }
    // The crossing between the last two samples (parallax occlusion mapping).
    float wmoAfter = wmoDepth - wmoLayer;
    float wmoBefore = wmoPreviousDepth - ( wmoLayer - wmoLayerStep );
    float wmoBlend = clamp( wmoAfter / min( wmoAfter - wmoBefore, -1e-5 ), 0.0, 1.0 );
    wmoReliefUv = wmoUv + wmoUvStep * wmoBlend;
    wmoReliefSurface = mix( wmoDepth, wmoPreviousDepth, wmoBlend );
  }
#endif
`;

/** After three's normal (lit runs): the derived slope through ∇u, ∇v into the view-space normal. */
const NORMAL = /* glsl */ `
#ifdef USE_MAP
  // ${WMO_RELIEF_MARKER}: N + depth · (slope_u ∇u + slope_v ∇v) / the map's own depth.
  if ( wmoReliefFade > 0.0 ) {
    vec2 wmoReliefTilt = textureGrad( wmoRelief, wmoReliefUv, wmoReliefGx, wmoReliefGy ).rg * 2.0 - 1.0;
    vec2 wmoReliefSlope = wmoReliefTilt / sqrt( max( 1.0 - dot( wmoReliefTilt, wmoReliefTilt ), 0.04 ) );
    vec3 wmoReliefBump = ( wmoReliefGu * wmoReliefSlope.x + wmoReliefGv * wmoReliefSlope.y )
      * ( wmoReliefDepth * ${f(WMO_RELIEF_NORMAL_STRENGTH)} / ${f(TERRAIN_RELIEF_DEPTH * TERRAIN_RELIEF_NORMAL_BOOST)} );
    float wmoReliefTiltLength = length( wmoReliefBump );
    if ( wmoReliefTiltLength > ${f(WMO_RELIEF_NORMAL_MAX_TILT)} ) wmoReliefBump *= ${f(WMO_RELIEF_NORMAL_MAX_TILT)} / wmoReliefTiltLength;
    normal = normalize( normal + wmoReliefBump * wmoReliefFade );
  }
#endif
`;

/** Before the sun term (lit runs): a stone between this texel and the sun takes part of it. */
const SHADOW = /* glsl */ `
#ifdef USE_MAP
// ${WMO_RELIEF_MARKER}: the soft self-shadow toward the sun.
if ( wmoReliefFade > 0.0 && wmoReliefSurface > 0.0 ) {
  float wmoSunN = dot( wowViewSunDirection, wmoReliefN );
  if ( wmoSunN > 0.02 ) {
    vec3 wmoSunT = wowViewSunDirection - wmoReliefN * wmoSunN;
    vec2 wmoSunShift = vec2( dot( wmoReliefGu, wmoSunT ), dot( wmoReliefGv, wmoSunT ) ) / max( wmoSunN, 0.3 )
      * wmoReliefScale * wmoReliefSurface;
    float wmoOccluded = 0.0;
    for ( int wmoStep = 1; wmoStep <= ${TERRAIN_RELIEF_SHADOW_STEPS}; wmoStep++ ) {
      float wmoAlong = float( wmoStep ) / ${f(TERRAIN_RELIEF_SHADOW_STEPS)};
      float wmoRay = wmoReliefSurface * ( 1.0 - wmoAlong );
      float wmoAt = 1.0 - textureGrad( wmoRelief, wmoReliefUv + wmoSunShift * wmoAlong, wmoReliefGx, wmoReliefGy ).b;
      wmoOccluded = max( wmoOccluded, ( wmoRay - wmoAt ) * ( 1.0 - wmoAlong ) );
    }
    wowShadow *= 1.0 - ${f(WMO_RELIEF_SHADOW_STRENGTH)} * wmoReliefFade * clamp( wmoOccluded * 6.0, 0.0, 1.0 );
  }
}
#endif
`;

function count(source: string, marker: string): number {
  return source.split(marker).length - 1;
}

/**
 * 22.10 (7.47 stage 2): injects the relief into a compiled WMO run program. A cosmetic leaf never
 * breaks a compile: without its markers exactly once, the program is left as it was.
 */
export function injectWmoRelief(shader: ShaderSource, variant: WmoReliefVariant): void {
  const fragment = shader.fragmentShader;
  const vertex = shader.vertexShader;
  const mapChunk = THREE.ShaderChunk.map_fragment;
  if (fragment.includes(`${WMO_RELIEF_MARKER}:`)) return;
  if (count(vertex, PROJECT_MARKER) !== 1 || count(fragment, LOGDEPTH_MARKER) !== 1 || count(fragment, MAP_MARKER) !== 1
    || count(mapChunk, MAP_SAMPLE) !== 1) return;
  if (variant === "lit" && count(fragment, NORMAL_MARKER) !== 1) return;
  let next = `${FRAGMENT_PARS}\n${fragment}`
    .replace(LOGDEPTH_MARKER, `${LOGDEPTH_MARKER}${MARCH}`)
    // Every colour tap reads at the shifted UV with the unshifted UV's gradients, so the mip choice
    // never jumps at a stone's edge.
    .replace(MAP_MARKER, mapChunk.replace(MAP_SAMPLE, "textureGrad( map, wmoReliefUv, wmoReliefGx, wmoReliefGy )"));
  if (variant === "lit") {
    next = next.replace(NORMAL_MARKER, `${NORMAL_MARKER}${NORMAL}`);
    if (count(next, SUN_MARKER) === 1) next = next.replace(SUN_MARKER, `${SHADOW}${SUN_MARKER}`);
  }
  shader.fragmentShader = next;
  shader.vertexShader = `${VERTEX_PARS}${vertex}`.replace(PROJECT_MARKER, `${PROJECT_MARKER}${VERTEX_BODY}`);
}

interface WmoReliefBinding {
  readonly previousCompile: (shader: ShaderSource, renderer: ShaderRenderer) => void;
  readonly previousKey: () => string;
  readonly variant: WmoReliefVariant;
  /** Shared by every program this material compiles, so a program reused from its cache still finds them. */
  readonly relief: { value: THREE.Texture };
  readonly on: { value: number };
  active: boolean;
  release?: (() => void) | undefined;
}

interface Tracked {
  readonly url: string;
  readonly variant: WmoReliefVariant;
}

const TRACKED = new Map<THREE.Material, Tracked>();
const BINDINGS = new WeakMap<THREE.Material, WmoReliefBinding>();
let reliefActive = false;
let maps: WmoReliefMaps | undefined;

/** 22.10 (7.47 stage 2): the maps of this thread (tests may hand in their own before the first use). */
export function wmoReliefMaps(replacement?: WmoReliefMaps): WmoReliefMaps {
  if (replacement) maps = replacement;
  maps ??= new WmoReliefMaps();
  return maps;
}

function absoluteUrl(url: string): string {
  const base = (globalThis as { location?: { href?: string } }).location?.href;
  if (!base) return url;
  try { return new URL(url, base).href; } catch { return url; }
}

function setBound(material: THREE.Material, tracked: Tracked, active: boolean): boolean {
  let binding = BINDINGS.get(material);
  if (!binding) {
    // An off request for a material that never had the hook wraps nothing: its program stays as it was.
    if (!active) return false;
    const created: WmoReliefBinding = {
      previousCompile: material.onBeforeCompile,
      previousKey: material.customProgramCacheKey.bind(material),
      variant: tracked.variant,
      relief: { value: WMO_RELIEF_FLAT },
      on: { value: 0 },
      active: false,
    };
    BINDINGS.set(material, created);
    material.onBeforeCompile = (shader, renderer) => {
      created.previousCompile.call(material, shader, renderer);
      if (!created.active) return;
      shader.uniforms["wmoRelief"] = created.relief;
      shader.uniforms["wmoReliefOn"] = created.on;
      injectWmoRelief(shader, created.variant);
    };
    material.customProgramCacheKey = () => created.active
      ? `${created.previousKey()}|${WMO_RELIEF_MARKER}:${created.variant}`
      : created.previousKey();
    binding = created;
  }
  if (binding.active === active) return false;
  binding.active = active;
  material.needsUpdate = true;
  if (active) {
    const held = binding;
    held.release = wmoReliefMaps().acquire(absoluteUrl(tracked.url), (texture) => {
      held.relief.value = texture;
      held.on.value = 1;
    });
  } else {
    binding.release?.();
    binding.release = undefined;
    binding.relief.value = WMO_RELIEF_FLAT;
    binding.on.value = 0;
  }
  return true;
}

function untrack(event: { target: THREE.Material }): void {
  const material = event.target;
  material.removeEventListener("dispose", untrack);
  TRACKED.delete(material);
  const binding = BINDINGS.get(material);
  if (binding) {
    binding.release?.();
    binding.release = undefined;
  }
}

/**
 * 22.10 (7.47 stage 2): a WMO run material that may draw relief (`wmoRunReliefVariant`), from its
 * build to its disposal. Bound at once when the leaf is active, so its first program already has the
 * relief key; otherwise when the leaf turns on.
 */
export function trackWmoReliefMaterial(material: THREE.Material, url: string, variant: WmoReliefVariant): void {
  if (TRACKED.has(material)) return;
  const tracked = { url, variant };
  TRACKED.set(material, tracked);
  material.addEventListener("dispose", untrack);
  if (reliefActive) setBound(material, tracked, true);
}

/**
 * 22.10 (7.47 stage 2): turns the relief of every tracked material on or off (the renderer's leaf
 * and lighting level). Returns how many programs changed key (each recompiles once on its next draw).
 */
export function setWmoReliefActive(active: boolean): number {
  if (active === reliefActive) return 0;
  reliefActive = active;
  let changed = 0;
  for (const [material, tracked] of TRACKED) if (setBound(material, tracked, active)) changed++;
  return changed;
}

/** 22.10 (7.47 stage 2): whether the material currently draws relief (tests and diagnostics). */
export function wmoReliefDrawing(material: THREE.Material): boolean {
  return BINDINGS.get(material)?.active === true;
}

/** 22.10 (7.47 stage 2): whether the material's relief map has arrived (tests and diagnostics). */
export function wmoReliefMapReady(material: THREE.Material): boolean {
  return BINDINGS.get(material)?.on.value === 1;
}

export interface WmoReliefStats extends WmoReliefMapStats {
  readonly tracked: number;
  readonly drawing: number;
  readonly withMap: number;
}

/** 22.10 (7.47 stage 2): the leaf's state in this thread (the bench hook and the report). */
export function wmoReliefStats(): WmoReliefStats {
  let drawing = 0;
  let withMap = 0;
  for (const material of TRACKED.keys()) {
    const binding = BINDINGS.get(material);
    if (binding?.active) drawing++;
    if (binding?.active && binding.on.value === 1) withMap++;
  }
  return { tracked: TRACKED.size, drawing, withMap, ...wmoReliefMaps().stats };
}
