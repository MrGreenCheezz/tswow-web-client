import * as THREE from "three";
import { TERRAIN_RELIEF_DEPTH, TERRAIN_RELIEF_NORMAL_BOOST } from "./TerrainReliefDerive.js";
import {
  TERRAIN_RELIEF_FADE_FAR, TERRAIN_RELIEF_FADE_NEAR, TERRAIN_RELIEF_GRAZING, TERRAIN_RELIEF_MAX_STEPS,
  TERRAIN_RELIEF_MIN_STEPS, TERRAIN_RELIEF_SHADOW_STEPS,
} from "./TerrainReliefShader.js";
import {
  RELIEF_SHAPE_CEILING, RELIEF_SHAPE_FLOOR, RELIEF_STRENGTH_GLSL, RELIEF_STRENGTH_TAG, RELIEF_TILT_CAP,
} from "./ReliefStrength.js"; // 24.10 (7.47)

/**
 * 23.10 (7.47 stage 3): the relief program shared by the buildings (stage 2, `WmoReliefShader.ts`) and
 * the world's doodads (stage 3, `M2Relief.ts`) — moved here from `WmoReliefShader.ts` unchanged, its
 * numbers made a {@link ReliefLook} so each stage keeps its own. With {@link WMO_RELIEF_LOOK} the
 * injected text is the stage-2 text to the byte (`tests/m2-relief.test.mjs` pins it).
 *
 * Two halves, because a doodad's material is copied in two ways (`ModelPlacementTint.ts`): the
 * shape (`injectReliefShape`: the march, the colour taps at the shifted UV, the cavity and the sky)
 * belongs to the material's own chain, so a locally lit indoor copy — rebuilt from the chain as it
 * stood before the world light — keeps it; the sun (`injectReliefSun`) reads the world light's
 * terms and goes in after them, so that copy drops it with the world light it replaces.
 */

/** 23.10 (7.47 stage 3): one stage's relief numbers (see `WmoReliefShader.ts` for what each does). */
export interface ReliefLook {
  /** Program-key marker, also written into the GLSL (`wmo-relief-v2`, `m2-relief-v1`). */
  readonly marker: string;
  /** The march's depth in UV units of the texture, and its cap in yards. */
  readonly depthUv: number;
  readonly depthMax: number;
  readonly normalStrength: number;
  readonly normalMaxTilt: number;
  readonly wallTilt: number;
  readonly cavity: number;
  readonly sky: number;
  /** The neighbourhood the shading terms measure against, in texels of the map. */
  readonly localSpan: number;
  /**
   * 23.10 (7.47 stage 3): the neighbourhood is at least `localSpan` texels of the map, however
   * magnified the texture (the doodads; the buildings' text is unchanged without it).
   */
  readonly localFloor?: boolean;
  /**
   * 23.10 (7.47 stage 3): the shading's factors scale the neighbourhood's mean colour, added to the
   * texel, not the texel itself: the height is the texel's own brightness, so a factor on the texel
   * brightens the bright and darkens the dark and lifts the mean (+2–3 % on the doodads' stills).
   * Needs {@link localFloor} (its neighbourhood). The buildings' text is unchanged without it.
   */
  readonly keepMean?: boolean;
  readonly shadowStrength: number;
  readonly sunGain: number;
  readonly sunRange: number;
  readonly sunFacing: number;
}

export interface ReliefChunks {
  readonly marker: string;
  readonly vertexPars: string;
  readonly vertexBody: string;
  readonly fragmentPars: string;
  readonly march: string;
  readonly shape: string;
  readonly sun: string;
}

type ShaderSource = Parameters<THREE.Material["onBeforeCompile"]>[0];

const f = (value: number) => value.toFixed(4);

const PROJECT_MARKER = "#include <project_vertex>";
const LOGDEPTH_MARKER = "#include <logdepthbuf_fragment>";
const MAP_MARKER = "#include <map_fragment>";
const MAP_SAMPLE = "texture2D( map, vMapUv )";
export const RELIEF_NORMAL_MARKER = "#include <normal_fragment_maps>";
/** The world light's sun term (`WorldLighting.ts`); the relief's sun goes in just before it. */
export const RELIEF_SUN_MARKER = "vec3 wowAuthoredLight = max( wowAmbient + wowDiffuse * ( wowNL * wowShadow ), vec3( 0.0 ) );";
/** Declared by the march: what tells the sun half that the shape half is in the program. */
const MARCH_DECLARATION = "float wmoReliefFade = 0.0;";

/** 23.10 (7.47 stage 3): the program text of one look (the stage-2 chunks, with its numbers). */
export function reliefChunks(look: ReliefLook): ReliefChunks {
  const marker = look.marker;
  const vertexPars = /* glsl */ `varying vec3 vWmoReliefView;\n`;
  const vertexBody = /* glsl */ `
  vWmoReliefView = - mvPosition.xyz; // ${marker}
`;
  const fragmentPars = /* glsl */ `
uniform sampler2D wmoRelief;
uniform float wmoReliefOn;
varying vec3 vWmoReliefView;${RELIEF_STRENGTH_GLSL}`;
  /** The frame and the march, before any colour tap; declares what the later stages read. */
  const march = /* glsl */ `
  // ${marker}: (22.10, 7.47 stage 2) the cotangent frame from the screen derivatives.
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
  wmoReliefDepth = min( ${f(look.depthUv)} / max( max( length( wmoReliefGu ), length( wmoReliefGv ) ), 1e-6 ), ${f(look.depthMax)} );
  wmoReliefFade = wmoReliefOn * step( 1e-20, abs( wmoReliefDet ) )
    * ( 1.0 - smoothstep( ${f(TERRAIN_RELIEF_FADE_NEAR)}, ${f(TERRAIN_RELIEF_FADE_FAR)}, length( vWmoReliefView ) ) )
    * smoothstep( ${f(TERRAIN_RELIEF_GRAZING * 0.5)}, ${f(TERRAIN_RELIEF_GRAZING)}, wmoReliefVN );
  wmoReliefScale = wmoReliefDepth * reliefDepthGain( wmoReliefVN ) * wmoReliefFade;
  if ( wmoReliefFade > 0.0 ) {
    vec3 wmoReliefVt = wmoReliefV - wmoReliefN * wmoReliefVN;
    vec2 wmoReliefShift = vec2( dot( wmoReliefGu, wmoReliefVt ), dot( wmoReliefGv, wmoReliefVt ) )
      / max( wmoReliefVN, 0.3 ) * wmoReliefScale;
    float wmoSteps = floor( mix( ${f(TERRAIN_RELIEF_MAX_STEPS)}, ${f(TERRAIN_RELIEF_MIN_STEPS)} * reliefStepGain( wmoReliefVN ), clamp( wmoReliefVN, 0.0, 1.0 ) ) );
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
  const shape = /* glsl */ `
#ifdef USE_MAP
  // ${marker}: (22.10, 7.47) the tilt — on a floor the height's slope, N' = N + depth · (slope_u ∇u
  // + slope_v ∇v) / the map's own depth, as on the ground; on a wall the shading's, up the face.
${look.keepMean ? `  vec3 wmoReliefMean = vec3( 0.0 );
` : ""}  if ( wmoReliefFade > 0.0 ) {
    vec4 wmoReliefTexel = textureGrad( wmoRelief, wmoReliefUv, wmoReliefGx, wmoReliefGy );
    // The height against its neighbourhood (a mip about a stone wide): what the shading terms read,
    // so each keeps the face's mean light wherever the texture is mostly joint or mostly crown.
${look.localFloor ? `    // ${marker}: (23.10, 7.47 stage 3) never narrower than the span in texels of the map: on a magnified
    // texture (a rock a yard from the camera, a texel over many pixels) the span in pixels stays inside
    // one texel, the neighbourhood is the texel itself, and the shading terms vanish.
    vec2 wmoAroundGx = wmoReliefGx * ${f(look.localSpan)};
    vec2 wmoAroundGy = wmoReliefGy * ${f(look.localSpan)};
    float wmoAroundFloor = ${f(look.localSpan)} / float( textureSize( wmoRelief, 0 ).x );
    float wmoAroundLength = max( length( wmoAroundGx ), length( wmoAroundGy ) );
    if ( wmoAroundLength < wmoAroundFloor ) {
      float wmoAroundScale = wmoAroundFloor / max( wmoAroundLength, 1e-8 );
      wmoAroundGx *= wmoAroundScale;
      wmoAroundGy *= wmoAroundScale;
    }
    vec4 wmoReliefAround = textureGrad( wmoRelief, wmoReliefUv, wmoAroundGx, wmoAroundGy );${look.keepMean ? `
    // The neighbourhood's mean colour (the base map's mip over the same span), what the factors scale.
    wmoReliefMean = diffuse * textureGrad( map, wmoReliefUv, wmoAroundGx, wmoAroundGy ).rgb;` : ""}` : `    vec4 wmoReliefAround = textureGrad( wmoRelief, wmoReliefUv,
      wmoReliefGx * ${f(look.localSpan)}, wmoReliefGy * ${f(look.localSpan)} );`}
    float wmoReliefLocal = wmoReliefTexel.b - wmoReliefAround.b;
    // The slope too, against the neighbourhood's mean (a floor brightened 7 % under the sun without).
    vec2 wmoReliefTilt = ( wmoReliefTexel.rg - wmoReliefAround.rg ) * 2.0;
    vec2 wmoReliefSlope = wmoReliefTilt / sqrt( max( 1.0 - dot( wmoReliefTilt, wmoReliefTilt ), 0.04 ) );
    vec3 wmoReliefFloor = ( wmoReliefGu * wmoReliefSlope.x + wmoReliefGv * wmoReliefSlope.y )
      * ( wmoReliefDepth * ${f(look.normalStrength)} / ${f(TERRAIN_RELIEF_DEPTH * TERRAIN_RELIEF_NORMAL_BOOST)} );
    float wmoReliefTiltLength = length( wmoReliefFloor );
    if ( wmoReliefTiltLength > ${f(look.normalMaxTilt)} ) wmoReliefFloor *= ${f(look.normalMaxTilt)} / wmoReliefTiltLength;
    // Up along the face: brighter than the mean leans toward it, darker away. World up, not the
    // texture's top — a beam or a trim maps its texture any way round, and its paint turns with it.
    vec3 wmoReliefUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
    float wmoReliefUpN = dot( wmoReliefN, wmoReliefUp );
    vec3 wmoReliefTop = ( wmoReliefUp - wmoReliefN * wmoReliefUpN ) / max( sqrt( max( 1.0 - wmoReliefUpN * wmoReliefUpN, 0.0 ) ), 1e-3 );
    vec3 wmoReliefWall = wmoReliefTop * ( clamp( wmoReliefLocal * 2.0, -1.0, 1.0 ) * ${f(look.wallTilt)} );
    float wmoReliefUpright = 1.0 - smoothstep( 0.5, 0.85, abs( wmoReliefUpN ) );
    wmoReliefBump = mix( wmoReliefFloor, wmoReliefWall, wmoReliefUpright ) * wmoReliefFade;
    wmoReliefBump = reliefTilt( wmoReliefBump, ${f(RELIEF_TILT_CAP)} ); // 24.10 (7.47): «Сила объёма» ${RELIEF_STRENGTH_TAG}
    // A joint (below its neighbourhood) loses part of the light, a crown gains as much, so the face
    // keeps its mean; a face turned up takes more of the overhead light, one turned down less. Both
    // follow the smoothed height, so the stones stay rounded.
    float wmoReliefCavity = 1.0 + ${f(look.cavity)} * reliefCavityGain * wmoReliefFade * clamp( wmoReliefLocal * 2.0, -1.0, 1.0 );
    float wmoReliefSky = 1.0 + ${f(look.sky)} * dot( wmoReliefBump, wmoReliefUp );
${look.keepMean
    // Never darker than the factor on the texel would make it: a texel darker than its neighbourhood under a
    // strong factor went black (a hole in a magnified Elwynn rock).
    ? `    float wmoReliefShape = wmoReliefCavity * wmoReliefSky;
    wmoReliefShape = clamp( wmoReliefShape, ${f(RELIEF_SHAPE_FLOOR)}, ${f(RELIEF_SHAPE_CEILING)} ); // 24.10 (7.47) ${RELIEF_STRENGTH_TAG}
    diffuseColor.rgb = max( diffuseColor.rgb + ( wmoReliefShape - 1.0 ) * wmoReliefMean, diffuseColor.rgb * min( wmoReliefShape, 1.0 ) );`
    // 24.10 (7.47): the product held as the doodads' is (at 100 % it never leaves these bounds).
    : `    wmoReliefCavity = clamp( wmoReliefCavity, ${f(RELIEF_SHAPE_FLOOR)} / wmoReliefSky, ${f(RELIEF_SHAPE_CEILING)} / wmoReliefSky ); // 24.10 (7.47) ${RELIEF_STRENGTH_TAG}
    diffuseColor.rgb *= wmoReliefCavity * wmoReliefSky;`}
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
  const sun = /* glsl */ `
#ifdef USE_MAP
// ${marker}: (22.10, 7.47) the relief's sun and its soft self-shadow.
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
    wmoReliefSelf = 1.0 - ${f(look.shadowStrength)} * reliefShadowGain( ${f(look.shadowStrength)} ) * wmoReliefFade * clamp( wmoOccluded * 6.0, 0.0, 1.0 );
  }
  float wmoKeyLuma = dot( wowDiffuse, vec3( 0.2126, 0.7152, 0.0722 ) );
  float wmoKeyShare = wmoKeyLuma / max( wmoKeyLuma + dot( wowAmbient, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
  // Linear in the tilt (no renormalising), so a face's relief keeps its mean light.
  float wmoReliefNL = max( dot( normalize( normal ) + wmoReliefBump, wowViewSunDirection ), 0.0 );
  // A face turned from the sun takes none of it: its stones may not catch what the wall does not
  // (stage 2: such walls «lit up stone by stone»).
  float wmoReliefSun = 1.0 + ${f(look.sunGain)} * wmoKeyShare * wowShadow * smoothstep( 0.0, ${f(look.sunFacing)}, wowDot )
    * ( wmoReliefNL * wmoReliefSelf - max( wowDot, 0.0 ) );
${look.keepMean
    ? `  float wmoReliefSunFactor = clamp( wmoReliefSun, ${f(1 - look.sunRange)}, ${f(1 + look.sunRange)} );
  diffuseColor.rgb = max( diffuseColor.rgb + ( wmoReliefSunFactor - 1.0 ) * wmoReliefMean, diffuseColor.rgb * min( wmoReliefSunFactor, 1.0 ) );`
    : `  diffuseColor.rgb *= clamp( wmoReliefSun, ${f(1 - look.sunRange)}, ${f(1 + look.sunRange)} );`}
}
#endif
`;
  return { marker, vertexPars, vertexBody, fragmentPars, march, shape, sun };
}

function count(source: string, marker: string): number {
  return source.split(marker).length - 1;
}

/**
 * 23.10 (7.47 stage 3): the shape half — the march and the colour taps at the shifted UV, the
 * cavity and the sky. A cosmetic leaf never breaks a compile: without its markers exactly once (or
 * with a relief already in the program), the program is left as it was and the answer is false.
 */
export function injectReliefShape(shader: ShaderSource, chunks: ReliefChunks, requireNormal = false): boolean {
  const fragment = shader.fragmentShader;
  const vertex = shader.vertexShader;
  const mapChunk = THREE.ShaderChunk.map_fragment;
  if (fragment.includes(MARCH_DECLARATION)) return false;
  if (count(vertex, PROJECT_MARKER) !== 1 || count(fragment, LOGDEPTH_MARKER) !== 1 || count(fragment, MAP_MARKER) !== 1
    || count(mapChunk, MAP_SAMPLE) !== 1) return false;
  if (requireNormal && count(fragment, RELIEF_NORMAL_MARKER) !== 1) return false;
  shader.fragmentShader = `${chunks.fragmentPars}\n${fragment}`
    .replace(LOGDEPTH_MARKER, `${LOGDEPTH_MARKER}${chunks.march}`)
    // Every colour tap reads at the shifted UV with the unshifted UV's gradients, so the mip choice
    // never jumps at a stone's edge.
    .replace(MAP_MARKER, `${mapChunk.replace(MAP_SAMPLE, "textureGrad( map, wmoReliefUv, wmoReliefGx, wmoReliefGy )")}${chunks.shape}`);
  shader.vertexShader = `${chunks.vertexPars}${vertex}`.replace(PROJECT_MARKER, `${PROJECT_MARKER}${chunks.vertexBody}`);
  return true;
}

/**
 * 23.10 (7.47 stage 3): the sun half, before the world light's sun term — only into a program that
 * already has the shape and exactly one sun term (outside the world light a lit surface keeps the
 * cavity and the sky alone).
 */
export function injectReliefSun(shader: ShaderSource, chunks: ReliefChunks): boolean {
  const fragment = shader.fragmentShader;
  if (!fragment.includes(MARCH_DECLARATION) || fragment.includes(`${chunks.marker}: (22.10, 7.47) the relief's sun`)) return false;
  if (count(fragment, RELIEF_SUN_MARKER) !== 1) return false;
  shader.fragmentShader = fragment.replace(RELIEF_SUN_MARKER, `${chunks.sun}${RELIEF_SUN_MARKER}`);
  return true;
}

let reliefClock: () => number = () => performance.now();

/** 23.10 (7.47): the fade-in's clock (tests hand in their own). */
export function setReliefClock(now: () => number): void {
  reliefClock = now;
}

/** 23.10 (7.47): a map that arrives after the material is drawn fades in over this, not pops. */
export const RELIEF_FADE_IN_MS = 300;

/**
 * 23.10 (7.47): `wmoReliefOn`'s value — 0 until the map arrives, then 0 → 1 over
 * {@link RELIEF_FADE_IN_MS}; three reads `value` at each upload, so no per-frame tick is needed.
 */
export class ReliefSwitch {
  #from = Number.POSITIVE_INFINITY;
  /**
   * 25.10 (perf): the fade has finished, so `value` is 1 without asking the clock. three reads `value` on every
   * upload of the uniform — every draw that changes material — and the clock read was ~0.1 ms a frame in Stormwind.
   */
  #settled = false;
  get value(): number {
    if (this.#settled) return 1;
    if (this.#from === Number.POSITIVE_INFINITY) return 0;
    const t = (reliefClock() - this.#from) / RELIEF_FADE_IN_MS;
    if (t >= 1) {
      this.#settled = true;
      return 1;
    }
    return t > 0 ? t : 0;
  }
  /** At once (a map already derived), or fading in from now. */
  arrive(fade: boolean): void {
    this.#from = fade ? reliefClock() : Number.NEGATIVE_INFINITY;
    this.#settled = !fade;
  }
  clear(): void {
    this.#from = Number.POSITIVE_INFINITY;
    this.#settled = false;
  }
  get arrived(): boolean {
    return this.#from !== Number.POSITIVE_INFINITY;
  }
}

/** 23.10 (7.47 stage 3): the URL a relief map is derived from — absolute, so the page and a worker ask the same. */
export function absoluteReliefUrl(url: string): string {
  const base = (globalThis as { location?: { href?: string } }).location?.href;
  if (!base) return url;
  try { return new URL(url, base).href; } catch { return url; }
}
