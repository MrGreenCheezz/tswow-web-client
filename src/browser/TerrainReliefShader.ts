import type * as THREE from "three";
import { lightingClassicLook } from "./LightingQuality.js";
import { TERRAIN_RELIEF_DEPTH } from "./TerrainReliefDerive.js";
import {
  RELIEF_STRENGTH, RELIEF_STRENGTH_GLSL, RELIEF_STRENGTH_TAG, RELIEF_STRENGTH_UNIFORM, TERRAIN_RELIEF_SLOPE_CAP,
} from "./ReliefStrength.js"; // 24.10 (7.47)

/**
 * 22.10 (7.47): «Объём земли» — parallax occlusion mapping and derived normals on the splatted ground.
 *
 * The ground textures' relief maps (`TerrainReliefDerive.ts`: RG normal, B height, one layer per
 * splat layer, the same slots) are marched along the view ray in the texture's own tangent space,
 * blended by the chunk's splat weights, and every colour tap then reads at the shifted UV with the
 * unshifted UV's gradients (so the mip choice never jumps at a stone's edge). The derived normal
 * replaces the geometric one in the existing world-light body, so flat ground — a constant height,
 * a straight-up normal — lights exactly as before. A short march toward the sun darkens the sun term
 * where a stone stands in its way (the soft parallax shadow). Everything fades out with distance:
 * full to {@link TERRAIN_RELIEF_FADE_NEAR} yards, none past {@link TERRAIN_RELIEF_FADE_FAR}, where
 * the micro-normals leaf takes over again.
 *
 * Enhanced path only: {@link terrainReliefActive} is off on the classic levels (lighting quality 0 and
 * the comparison level 3), whose program and cache key stay exactly what they were.
 */

/** 22.10 (7.47): bumped when the injected program changes; part of the cache key. */
export const TERRAIN_RELIEF_PROFILE_VERSION = 1;
/** 22.10 (7.47): full effect up to this distance from the camera (yards). */
export const TERRAIN_RELIEF_FADE_NEAR = 35;
/** 22.10 (7.47): no effect (and no march) beyond this distance (yards). */
export const TERRAIN_RELIEF_FADE_FAR = 85;
/** 22.10 (7.47): march steps looking straight down … */
export const TERRAIN_RELIEF_MIN_STEPS = 5;
/** 22.10 (7.47): … and at the most grazing view that still draws relief. */
export const TERRAIN_RELIEF_MAX_STEPS = 10;
/**
 * 22.10 (7.47): below this view elevation (|V·N|, ≈ 9°) the relief's depth fades to nothing, so a
 * grazing ray never needs more steps than {@link TERRAIN_RELIEF_MAX_STEPS} to look continuous.
 */
export const TERRAIN_RELIEF_GRAZING = 0.16;
/** 22.10 (7.47): steps of the march toward the sun (the soft self-shadow). */
export const TERRAIN_RELIEF_SHADOW_STEPS = 4;
/** 22.10 (7.47): how dark a stone's own shadow can get (the sun term's share removed at most). */
export const TERRAIN_RELIEF_SHADOW_STRENGTH = 0.6;

/** 22.10 (7.47): the leaf on the levels that may draw it — never the classic ones. */
export function terrainReliefActive(enabled: boolean, lightingQuality: number): boolean {
  return enabled && !lightingClassicLook(lightingQuality);
}

/** 22.10 (7.47): the GLSL distance fade, as a number (tests and diagnostics). */
export function terrainReliefFade(distance: number): number {
  const t = Math.min(1, Math.max(0, (distance - TERRAIN_RELIEF_FADE_NEAR) / (TERRAIN_RELIEF_FADE_FAR - TERRAIN_RELIEF_FADE_NEAR)));
  return 1 - t * t * (3 - 2 * t);
}

/** 22.10 (7.47): the march's step count for a view elevation |V·N| (as the GLSL computes it). */
export function terrainReliefSteps(viewElevation: number): number {
  const e = Math.min(1, Math.max(0, viewElevation));
  return Math.floor(TERRAIN_RELIEF_MAX_STEPS + (TERRAIN_RELIEF_MIN_STEPS - TERRAIN_RELIEF_MAX_STEPS) * e);
}

export const TERRAIN_RELIEF_MARKER = `terrain-relief-v${TERRAIN_RELIEF_PROFILE_VERSION}`;

type ShaderSource = Parameters<THREE.Material["onBeforeCompile"]>[0];
type ShaderRenderer = Parameters<THREE.Material["onBeforeCompile"]>[1];

interface TerrainReliefBinding {
  readonly previousCompile: (shader: ShaderSource, renderer: ShaderRenderer) => void;
  readonly previousKey: () => string;
  /** Shared by every program this material compiles, so a program reused from its cache still finds it. */
  readonly relief: { value: THREE.Texture | null };
  active: boolean;
}

const BINDINGS = new WeakMap<THREE.Material, TerrainReliefBinding>();

/**
 * 22.10 (7.47): binds (once) or updates the relief hook of a splatted terrain material. `relief` is
 * the tile's relief array or undefined; the hook draws only with both a texture and `active`. Its
 * key is read through the previous hook's key function, so the micro-normal leaf below it may still
 * change its own. Returns whether the program key changed (the caller re-registers the warm-up).
 */
export function setTerrainSplatRelief(
  material: THREE.MeshLambertMaterial, relief: THREE.Texture | undefined, active: boolean,
): boolean {
  const drawing = active && relief !== undefined;
  const existing = BINDINGS.get(material);
  if (existing) {
    existing.relief.value = relief ?? null;
    if (existing.active === drawing) return false;
    existing.active = drawing;
    material.needsUpdate = true;
    return true;
  }
  // An off request for a material that never had the hook wraps nothing: its program stays as it was.
  if (!drawing) return false;
  const binding: TerrainReliefBinding = {
    previousCompile: material.onBeforeCompile,
    previousKey: material.customProgramCacheKey.bind(material),
    relief: { value: relief ?? null },
    active: drawing,
  };
  BINDINGS.set(material, binding);
  material.onBeforeCompile = (shader, renderer) => {
    binding.previousCompile.call(material, shader, renderer);
    shader.uniforms["splatRelief"] = binding.relief;
    if (!binding.active) return;
    shader.uniforms[RELIEF_STRENGTH_UNIFORM] = RELIEF_STRENGTH; // 24.10 (7.47): «Сила объёма», one value for every program
    injectTerrainRelief(shader);
  };
  material.customProgramCacheKey = () => binding.active
    ? `${binding.previousKey()}|${TERRAIN_RELIEF_MARKER}`
    : binding.previousKey();
  material.needsUpdate = true;
  return true;
}

/** 22.10 (7.47): whether the material currently draws relief (tests and diagnostics). */
export function terrainSplatReliefDrawing(material: THREE.Material): boolean {
  return BINDINGS.get(material)?.active === true;
}

const DECLARATION_MARKER = "uniform sampler2DArray splatLayers;";
const DETAIL_MARKER = "vec2 splatDetail = vSplatUv * splatRepeat;";
const BASE_LAYER_CALL = "splatLayer(splatSlots.r, splatDetail, vec3(0.30, 0.38, 0.26))";
const LAYER_TAP = /texture\(splatLayers, vec3\(splatDetail, (splatSlots\.[rgba])\)\)/g;
const NORMAL_MARKER = "#include <normal_fragment_maps>";
const MICRO_FADE = "terrainMicroGradient *= 0.08 * terrainMicroOutlierFade * terrainDistanceFade;";
const SUN_MARKER = "vec3 wowAuthoredLight = max( wowAmbient + wowDiffuse * ( wowNL * wowShadow ), vec3( 0.0 ) );";

const f = (value: number) => value.toFixed(4);

const RELIEF_FUNCTIONS = /* glsl */ `
uniform sampler2DArray splatRelief;${RELIEF_STRENGTH_GLSL}// ${TERRAIN_RELIEF_MARKER}: the blended depth (0 = top of the highest stone) at a detail UV.
float terrainReliefDepth( vec2 uv, vec4 slots, vec4 weights, vec2 gx, vec2 gy ) {
  float height = 0.5 * max( 1.0 - dot( weights, vec4( 1.0 ) ), 0.0 );
  if ( weights.x > 0.004 ) height += weights.x * textureGrad( splatRelief, vec3( uv, slots.x ), gx, gy ).b;
  if ( weights.y > 0.004 ) height += weights.y * textureGrad( splatRelief, vec3( uv, slots.y ), gx, gy ).b;
  if ( weights.z > 0.004 ) height += weights.z * textureGrad( splatRelief, vec3( uv, slots.z ), gx, gy ).b;
  if ( weights.w > 0.004 ) height += weights.w * textureGrad( splatRelief, vec3( uv, slots.w ), gx, gy ).b;
  return 1.0 - height;
}
// The blended tangent-space normal (the texture's u, v, up) at a detail UV.
vec3 terrainReliefNormal( vec2 uv, vec4 slots, vec4 weights, vec2 gx, vec2 gy ) {
  vec2 slope = vec2( 0.0 );
  if ( weights.x > 0.004 ) slope += weights.x * ( textureGrad( splatRelief, vec3( uv, slots.x ), gx, gy ).rg * 2.0 - 1.0 );
  if ( weights.y > 0.004 ) slope += weights.y * ( textureGrad( splatRelief, vec3( uv, slots.y ), gx, gy ).rg * 2.0 - 1.0 );
  if ( weights.z > 0.004 ) slope += weights.z * ( textureGrad( splatRelief, vec3( uv, slots.z ), gx, gy ).rg * 2.0 - 1.0 );
  if ( weights.w > 0.004 ) slope += weights.w * ( textureGrad( splatRelief, vec3( uv, slots.w ), gx, gy ).rg * 2.0 - 1.0 );
  slope = reliefTilt( slope, ${f(TERRAIN_RELIEF_SLOPE_CAP)} ); // 24.10 (7.47): «Сила объёма» ${RELIEF_STRENGTH_TAG}
  return vec3( slope, sqrt( max( 1.0 - dot( slope, slope ), 0.0 ) ) );
}
`;

/** The march, at the detail UV, before any colour tap. Declares what the later stages read. */
const RELIEF_MARCH = /* glsl */ `
      // ${TERRAIN_RELIEF_MARKER} (22.10, 7.47): the splat weights as the colour chain applies them.
      vec4 terrainReliefSlots = splatSlots;
      vec4 terrainReliefWeights = vec4( splatSlots.r < 0.0 ? 0.0 : 1.0, 0.0, 0.0, 0.0 );
      if ( splatSlots.g >= 0.0 ) { terrainReliefWeights *= 1.0 - splatBlend.r; terrainReliefWeights.y = splatBlend.r; }
      if ( splatSlots.b >= 0.0 ) { terrainReliefWeights *= 1.0 - splatBlend.g; terrainReliefWeights.z = splatBlend.g; }
      if ( splatSlots.a >= 0.0 ) { terrainReliefWeights *= 1.0 - splatBlend.b; terrainReliefWeights.w = splatBlend.b; }
      vec2 terrainReliefGx = dFdx( splatDetail );
      vec2 terrainReliefGy = dFdy( splatDetail );
      // The splat UV is the ground's plan (TerrainGeometry.ts): +u is world +Z, +v world +X. The
      // tangents are those axes lifted onto the slope, so a planar UV stays a planar UV.
      vec3 terrainReliefNw = normalize( ( vec4( vNormal, 0.0 ) * viewMatrix ).xyz );
      vec3 terrainReliefTw = normalize( vec3( 0.0, -terrainReliefNw.z, terrainReliefNw.y ) );
      vec3 terrainReliefBw = normalize( vec3( terrainReliefNw.y, -terrainReliefNw.x, 0.0 ) );
      vec3 terrainReliefVw = normalize( ( vec4( vViewPosition, 0.0 ) * viewMatrix ).xyz );
      vec3 terrainReliefView = vec3( dot( terrainReliefVw, terrainReliefTw ), dot( terrainReliefVw, terrainReliefBw ),
        dot( terrainReliefVw, terrainReliefNw ) );
      float terrainReliefFade = ( 1.0 - smoothstep( ${f(TERRAIN_RELIEF_FADE_NEAR)}, ${f(TERRAIN_RELIEF_FADE_FAR)}, length( vViewPosition ) ) )
        * smoothstep( ${f(TERRAIN_RELIEF_GRAZING * 0.5)}, ${f(TERRAIN_RELIEF_GRAZING)}, terrainReliefView.z );
      float terrainReliefScale = ${f(TERRAIN_RELIEF_DEPTH)} * reliefDepthGain( terrainReliefView.z ) * terrainReliefFade;
      float terrainReliefSurface = 0.0;
      if ( terrainReliefFade > 0.0 ) {
        float terrainSteps = floor( mix( ${f(TERRAIN_RELIEF_MAX_STEPS)}, ${f(TERRAIN_RELIEF_MIN_STEPS)} * reliefStepGain( terrainReliefView.z ), clamp( terrainReliefView.z, 0.0, 1.0 ) ) );
        float terrainLayerStep = 1.0 / terrainSteps;
        vec2 terrainUvStep = terrainReliefView.xy / max( terrainReliefView.z, 0.3 ) * terrainReliefScale * terrainLayerStep;
        float terrainLayer = 0.0;
        float terrainDepth = terrainReliefDepth( splatDetail, terrainReliefSlots, terrainReliefWeights, terrainReliefGx, terrainReliefGy );
        float terrainPreviousDepth = terrainDepth;
        vec2 terrainUv = splatDetail;
        for ( int terrainStep = 0; terrainStep < ${TERRAIN_RELIEF_MAX_STEPS}; terrainStep++ ) {
          if ( float( terrainStep ) >= terrainSteps || terrainLayer >= terrainDepth ) break;
          terrainUv -= terrainUvStep;
          terrainLayer += terrainLayerStep;
          terrainPreviousDepth = terrainDepth;
          terrainDepth = terrainReliefDepth( terrainUv, terrainReliefSlots, terrainReliefWeights, terrainReliefGx, terrainReliefGy );
        }
        // The crossing between the last two samples (parallax occlusion mapping).
        float terrainAfter = terrainDepth - terrainLayer;
        float terrainBefore = terrainPreviousDepth - ( terrainLayer - terrainLayerStep );
        float terrainBlend = clamp( terrainAfter / min( terrainAfter - terrainBefore, -1e-5 ), 0.0, 1.0 );
        splatDetail = terrainUv + terrainUvStep * terrainBlend;
        terrainReliefSurface = mix( terrainDepth, terrainPreviousDepth, terrainBlend );
      }
`;

/** After three's normal: the derived normal in view space, faded; the micro normals keep the far ground. */
const RELIEF_NORMAL = /* glsl */ `
      // ${TERRAIN_RELIEF_MARKER}: the derived normal through the same tangents, into view space.
      if ( terrainReliefFade > 0.0 ) {
        vec3 terrainReliefTs = terrainReliefNormal( splatDetail, terrainReliefSlots, terrainReliefWeights, terrainReliefGx, terrainReliefGy );
        vec3 terrainReliefWorld = normalize( terrainReliefTw * terrainReliefTs.x + terrainReliefBw * terrainReliefTs.y
          + terrainReliefNw * terrainReliefTs.z );
        vec3 terrainReliefViewNormal = normalize( ( viewMatrix * vec4( terrainReliefWorld, 0.0 ) ).xyz ) * faceDirection;
        normal = normalize( mix( normal, terrainReliefViewNormal, terrainReliefFade ) );
      }
`;

/** Before the sun term: the soft self-shadow of the relief toward the sun. */
const RELIEF_SHADOW = /* glsl */ `
// ${TERRAIN_RELIEF_MARKER}: a stone between this texel and the sun takes part of the sun term.
if ( terrainReliefFade > 0.0 ) {
  vec3 terrainSunTs = vec3( dot( wowSunDirection, terrainReliefTw ), dot( wowSunDirection, terrainReliefBw ),
    dot( wowSunDirection, terrainReliefNw ) );
  if ( terrainSunTs.z > 0.02 && terrainReliefSurface > 0.0 ) {
    vec2 terrainSunShift = terrainSunTs.xy / max( terrainSunTs.z, 0.3 ) * terrainReliefScale * terrainReliefSurface;
    float terrainOccluded = 0.0;
    for ( int terrainStep = 1; terrainStep <= ${TERRAIN_RELIEF_SHADOW_STEPS}; terrainStep++ ) {
      float terrainAlong = float( terrainStep ) / ${f(TERRAIN_RELIEF_SHADOW_STEPS)};
      float terrainRay = terrainReliefSurface * ( 1.0 - terrainAlong );
      float terrainAt = terrainReliefDepth( splatDetail + terrainSunShift * terrainAlong, terrainReliefSlots, terrainReliefWeights,
        terrainReliefGx, terrainReliefGy );
      terrainOccluded = max( terrainOccluded, ( terrainRay - terrainAt ) * ( 1.0 - terrainAlong ) );
    }
    wowShadow *= 1.0 - ${f(TERRAIN_RELIEF_SHADOW_STRENGTH)} * reliefShadowGain( ${f(TERRAIN_RELIEF_SHADOW_STRENGTH)} ) * terrainReliefFade * clamp( terrainOccluded * 6.0, 0.0, 1.0 );
  }
}
`;

function count(source: string, marker: string): number {
  return source.split(marker).length - 1;
}

/**
 * 22.10 (7.47): injects the relief into a compiled splat program. A cosmetic leaf never breaks a
 * compile: if the splat hook's markers are not there exactly once, the program is left as it was.
 */
export function injectTerrainRelief(shader: ShaderSource): void {
  const fragment = shader.fragmentShader;
  if (fragment.includes(`${TERRAIN_RELIEF_MARKER}:`)) return;
  if (count(fragment, DECLARATION_MARKER) !== 1 || count(fragment, DETAIL_MARKER) !== 1
    || count(fragment, BASE_LAYER_CALL) !== 1 || count(fragment, NORMAL_MARKER) !== 1) return;
  let next = fragment
    .replace(DECLARATION_MARKER, `${DECLARATION_MARKER}${RELIEF_FUNCTIONS}`)
    .replace(DETAIL_MARKER, `${DETAIL_MARKER}${RELIEF_MARCH}`)
    .replace(BASE_LAYER_CALL,
      "(splatSlots.r < 0.0 ? vec3(0.30, 0.38, 0.26) : textureGrad(splatLayers, vec3(splatDetail, splatSlots.r), terrainReliefGx, terrainReliefGy).rgb)")
    .replace(LAYER_TAP, "textureGrad(splatLayers, vec3(splatDetail, $1), terrainReliefGx, terrainReliefGy)")
    .replace(NORMAL_MARKER, `${NORMAL_MARKER}${RELIEF_NORMAL}`);
  // The micro normals (from the colour's screen derivatives) keep the ground beyond the relief.
  if (count(next, MICRO_FADE) === 1) {
    next = next.replace(MICRO_FADE, MICRO_FADE.replace(";", " * ( 1.0 - terrainReliefFade );"));
  }
  if (next.includes("#define WOW_LIGHT_TERRAIN") && count(next, SUN_MARKER) === 1) {
    next = next.replace(SUN_MARKER, `${RELIEF_SHADOW}${SUN_MARKER}`);
  }
  shader.fragmentShader = next;
}

/**
 * 22.10 (7.47): whether the terrain clients in this thread derive relief maps — the renderer's
 * `setTerrainRelief` and lighting level decide it (`terrainReliefActive`), the splat client reads it
 * as a tile loads and on every `get` (a tile loaded without one gets it later; with it off, the maps
 * are released).
 */
let reliefWanted = false;

export function setTerrainReliefWanted(wanted: boolean): void {
  reliefWanted = wanted;
}

export function terrainReliefWanted(): boolean {
  return reliefWanted;
}
