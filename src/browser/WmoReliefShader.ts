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
 * Every run darkens its joints (cavity) and lights the stones' upturned faces from overhead (sky):
 * the shape in the shade and in rooms (MOCV-lit, no sun). A lit run (exterior, transition) also
 * takes the derived normal into the sun's N·L — only there, not the rim or fill — and the soft sun
 * self-shadow.
 *
 * Program keys. A material is bound when it is built (or when the leaf turns on), with its key
 * {@link WMO_RELIEF_MARKER}; its map arrives later through a uniform — a 1×1 flat stand-in and a
 * switch at 0 until then — so the program never changes while playing. Off, or on a classic level
 * (lighting quality 0 and the comparison level 3), nothing is wrapped and every program is exactly
 * what it was.
 */

/** 22.10 (7.47 stage 2): bumped when the injected program changes; part of the cache key. */
export const WMO_RELIEF_PROFILE_VERSION = 2; // 22.10 (7.47): v2 — the shading's tilt, the sun as a factor, cavity and sky
export const WMO_RELIEF_MARKER = `wmo-relief-v${WMO_RELIEF_PROFILE_VERSION}`;
/**
 * 22.10 (7.47 stage 2): the relief's depth in UV units of the run's texture (the ground's is 0.03).
 * 22.10 (7.47): kept — the march was not why the buildings read flat (the shading was, see
 * {@link WMO_RELIEF_WALL_TILT}); 0.025 under a 0.11-yard cap read no better in the stills and stepped
 * along the wall tops.
 */
export const WMO_RELIEF_DEPTH_UV = 0.02;
/** 22.10 (7.47 stage 2): and never deeper than this, in yards (≈ 7 cm), however large the texture's repeat. */
export const WMO_RELIEF_DEPTH_MAX = 0.08;
/** 22.10 (7.47): the share of the sun term a stone's own shadow may take (stage 2: 0.5; the ground's too is 0.6). */
export const WMO_RELIEF_SHADOW_STRENGTH = 0.6;
/**
 * 22.10 (7.47): the joints' cavity — the light factor is 1 ± this × the height against its
 * neighbourhood (×2, clamped to ±1): a joint darker, a crown lighter, the face's mean kept (a
 * darkening-only cavity took 6 % off a Stormwind wall). What reads in the shade and in rooms, where
 * there is no sun for the tilt to shape.
 */
export const WMO_RELIEF_CAVITY = 0.35;
/** 22.10 (7.47): the neighbourhood the shading terms measure the height against, in texels of the map (a mip ≈ 4 levels up). */
export const WMO_RELIEF_LOCAL_SPAN = 16;
/**
 * 22.10 (7.47): the overhead light's share by the stone's own tilt — a face turned up is lighter, one
 * turned down darker (± this times the tilt's upward part). The shade's and the rooms' direction.
 */
export const WMO_RELIEF_SKY = 0.4;
/**
 * 22.10 (7.47): the derived normal's tilt over the one the depth implies, and its cap (tangent of the
 * tilt). Stage 2 put the tilted normal into `normal`, which the world light's rim and fill also read
 * (`pow( 1 - N·V, 3 )` against the cool ambient): the steep joints took a sky-blue rim, and the cure
 * was half strength under a ≈ 17° cap — flat. The tilt now reaches the sun's N·L alone,
 * as a hue-neutral factor on the colour (`SUN` below); the rim, the fill and the lamps keep the
 * face's own normal, so the full slope the depth implies is safe, capped at ≈ 31° for smooth stones.
 */
export const WMO_RELIEF_NORMAL_STRENGTH = 1.0;
export const WMO_RELIEF_NORMAL_MAX_TILT = 0.6;
/**
 * 22.10 (7.47): a wall's tilt (tangent) where the height stands ±0.5 off its neighbourhood. Building textures
 * are painted lit from above — a light top edge, a dark lower one, a face shaded top to bottom — so
 * the brightness' slope across a face runs against its shape: the height's normal turned every face
 * down, and under a high sun the relief undid the painted light (local contrast 8.8 → 8.1 on a
 * Stormwind wall: why stage 2 read flat). On an upright face the tilt is the shading's instead —
 * brighter than the mean leans up the face, darker down — which agrees with the paint
 * and needs no slope at all, so it stays as smooth as the height. Floors (cobbles, painted from
 * above) keep the height's slope, as the ground does.
 */
export const WMO_RELIEF_WALL_TILT = 0.7;
/** 22.10 (7.47): the relief's sun factor — its gain over the N·L difference, and how far from one it may go. */
export const WMO_RELIEF_SUN_GAIN = 1.0;
export const WMO_RELIEF_SUN_RANGE = 0.5;
/** 22.10 (7.47): the face's own N·L at which its relief takes the whole sun factor (none at 0). */
export const WMO_RELIEF_SUN_FACING = 0.2;

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
  vec3 wmoReliefBump = vec3( 0.0 );
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

/**
 * After the colour tap (both variants): the derived slope through ∇u, ∇v as a view-space tilt, the
 * joints' cavity and the overhead light by the tilt — the relief's shape without a sun.
 */
const SHAPE = /* glsl */ `
#ifdef USE_MAP
  // ${WMO_RELIEF_MARKER}: (22.10, 7.47) the tilt — on a floor the height's slope, N' = N + depth · (slope_u ∇u
  // + slope_v ∇v) / the map's own depth, as on the ground; on a wall the shading's, up the face.
  if ( wmoReliefFade > 0.0 ) {
    vec4 wmoReliefTexel = textureGrad( wmoRelief, wmoReliefUv, wmoReliefGx, wmoReliefGy );
    // The height against its neighbourhood (a mip about a stone wide): what the shading terms read,
    // so each keeps the face's mean light wherever the texture is mostly joint or mostly crown.
    vec4 wmoReliefAround = textureGrad( wmoRelief, wmoReliefUv,
      wmoReliefGx * ${f(WMO_RELIEF_LOCAL_SPAN)}, wmoReliefGy * ${f(WMO_RELIEF_LOCAL_SPAN)} );
    float wmoReliefLocal = wmoReliefTexel.b - wmoReliefAround.b;
    // The slope too, against the neighbourhood's mean (a floor brightened 7 % under the sun without).
    vec2 wmoReliefTilt = ( wmoReliefTexel.rg - wmoReliefAround.rg ) * 2.0;
    vec2 wmoReliefSlope = wmoReliefTilt / sqrt( max( 1.0 - dot( wmoReliefTilt, wmoReliefTilt ), 0.04 ) );
    vec3 wmoReliefFloor = ( wmoReliefGu * wmoReliefSlope.x + wmoReliefGv * wmoReliefSlope.y )
      * ( wmoReliefDepth * ${f(WMO_RELIEF_NORMAL_STRENGTH)} / ${f(TERRAIN_RELIEF_DEPTH * TERRAIN_RELIEF_NORMAL_BOOST)} );
    float wmoReliefTiltLength = length( wmoReliefFloor );
    if ( wmoReliefTiltLength > ${f(WMO_RELIEF_NORMAL_MAX_TILT)} ) wmoReliefFloor *= ${f(WMO_RELIEF_NORMAL_MAX_TILT)} / wmoReliefTiltLength;
    // Up along the face: brighter than the mean leans toward it, darker away. World up, not the
    // texture's top — a beam or a trim maps its texture any way round, and its paint turns with it.
    vec3 wmoReliefUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
    float wmoReliefUpN = dot( wmoReliefN, wmoReliefUp );
    vec3 wmoReliefTop = ( wmoReliefUp - wmoReliefN * wmoReliefUpN ) / max( sqrt( max( 1.0 - wmoReliefUpN * wmoReliefUpN, 0.0 ) ), 1e-3 );
    vec3 wmoReliefWall = wmoReliefTop * ( clamp( wmoReliefLocal * 2.0, -1.0, 1.0 ) * ${f(WMO_RELIEF_WALL_TILT)} );
    float wmoReliefUpright = 1.0 - smoothstep( 0.5, 0.85, abs( wmoReliefUpN ) );
    wmoReliefBump = mix( wmoReliefFloor, wmoReliefWall, wmoReliefUpright ) * wmoReliefFade;
    // A joint (below its neighbourhood) loses part of the light, a crown gains as much, so the face
    // keeps its mean; a face turned up takes more of the overhead light, one turned down less. Both
    // follow the smoothed height, so the stones stay rounded.
    float wmoReliefCavity = 1.0 + ${f(WMO_RELIEF_CAVITY)} * wmoReliefFade * clamp( wmoReliefLocal * 2.0, -1.0, 1.0 );
    float wmoReliefSky = 1.0 + ${f(WMO_RELIEF_SKY)} * dot( wmoReliefBump, wmoReliefUp );
    diffuseColor.rgb *= wmoReliefCavity * wmoReliefSky;
  }
#endif
`;

/**
 * Before the sun term (lit runs): the relief's own sun — the tilted normal's N·L against the face's,
 * and a stone between this texel and the sun — as a hue-neutral factor on the colour, weighted by
 * the key's share of the light and the cascades' shadow. `normal`, `wowDot` and `wowShadow` stay
 * the face's: stage 2 tilted `normal` itself, and where the tilt turned a joint from the sun the
 * world light's shade tint (cool, sky-leaning fill) and its rim followed — the blue joints.
 */
const SUN = /* glsl */ `
#ifdef USE_MAP
// ${WMO_RELIEF_MARKER}: (22.10, 7.47) the relief's sun and its soft self-shadow.
if ( wmoReliefFade > 0.0 ) {
  float wmoReliefSelf = 1.0;
  float wmoSunN = dot( wowViewSunDirection, wmoReliefN );
  if ( wmoReliefSurface > 0.0 && wmoSunN > 0.02 ) {
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
    wmoReliefSelf = 1.0 - ${f(WMO_RELIEF_SHADOW_STRENGTH)} * wmoReliefFade * clamp( wmoOccluded * 6.0, 0.0, 1.0 );
  }
  float wmoKeyLuma = dot( wowDiffuse, vec3( 0.2126, 0.7152, 0.0722 ) );
  float wmoKeyShare = wmoKeyLuma / max( wmoKeyLuma + dot( wowAmbient, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
  // Linear in the tilt (no renormalising), so a face's relief keeps its mean light.
  float wmoReliefNL = max( dot( normalize( normal ) + wmoReliefBump, wowViewSunDirection ), 0.0 );
  // A face turned from the sun takes none of it: its stones may not catch what the wall does not
  // (stage 2: such walls «lit up stone by stone»).
  float wmoReliefSun = 1.0 + ${f(WMO_RELIEF_SUN_GAIN)} * wmoKeyShare * wowShadow * smoothstep( 0.0, ${f(WMO_RELIEF_SUN_FACING)}, wowDot )
    * ( wmoReliefNL * wmoReliefSelf - max( wowDot, 0.0 ) );
  diffuseColor.rgb *= clamp( wmoReliefSun, ${f(1 - WMO_RELIEF_SUN_RANGE)}, ${f(1 + WMO_RELIEF_SUN_RANGE)} );
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
    .replace(MAP_MARKER, `${mapChunk.replace(MAP_SAMPLE, "textureGrad( map, wmoReliefUv, wmoReliefGx, wmoReliefGy )")}${SHAPE}`);
  if (variant === "lit") {
    // Outside the world light (no sun term to find) a lit run keeps the cavity and the sky alone.
    if (count(next, SUN_MARKER) === 1) next = next.replace(SUN_MARKER, `${SUN}${SUN_MARKER}`);
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
