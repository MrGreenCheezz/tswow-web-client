/**
 * 05.10-A7b-2 (7.11 P1): what a run's MOMT record changes about how it is drawn.
 *
 * The record comes with `visual-wmo-v25` (WME5, `WmoMaterials.ts`); a run of an older artifact names
 * none, and a record that changes nothing (a Diffuse surface without a night glow — 22,910 of the
 * client's 25,034) answers no look either. Both build exactly the material they always did: same
 * cache key, same hooks, same program. Only a run with a look gets one more `onBeforeCompile` stage.
 *
 * The client's own programs (`Shaders\Pixel\arbfp1\mapobj*.bls`, `Shaders\Vertex\arbvp1\
 * mapobj{,u}diffuse_t1{,_refl}.bls`; `.runtime/re-2026-10-05/A7b-2/probe-mapobj-vp.out.txt`,
 * `probe-vp-variants.out.txt`) say:
 *   * Opaque, Specular, Metal, Env and EnvMetal write `primary.a`: the texture's alpha is not
 *     opacity (Diffuse alone writes `tex0.a`; Composite a blend of both textures').
 *   * Env adds `tex0.a · tex1`, EnvMetal `tex0.rgb · tex0.a · tex1`, after the light, where tex1 is the
 *     second texture read at texcoord 1 = the view-space reflection's x and y (the `_refl` vertex
 *     programs: `E − 2·N·(N·E)` with E the eye-to-vertex direction, N the normal, both in view space).
 *   * The lit vertex variants (every odd one of the 90) end with `+ c[29]` inside the clamp: an
 *     emissive term added to the light; the unlit ones (the interior path, `color = MOCV`) have none.
 *     For a material with flag 0x10 that term is its `sidnColour` at night. How the client weighs
 *     night is not read from Wow.exe; this uses the renderer's own once-a-frame night weight,
 *     `1 − wowDaylight` (`setWorldLightDaylight`, the sun's elevation), as the spec asks.
 * Composite needs the second UV set and second vertex colour (MOTV/MOCV 2), which the artifact
 * does not carry: it stays drawn as Diffuse.
 */

import * as THREE from "three";

import {
  WMO_MATERIAL_SIDN, WMO_SHADER_ENV, WMO_SHADER_ENV_METAL, WMO_SHADER_METAL, WMO_SHADER_OPAQUE,
  WMO_SHADER_SPECULAR, type WmoMaterial,
} from "./WmoMaterials.js";

export interface WmoRunLook {
  /** Alpha is the vertex colour's (`primary.a`), never the texture's. */
  readonly primaryAlpha: boolean;
  /** The night glow added to an exterior (lit) run's light, RGB 0–1; absent when none. */
  readonly sidn?: readonly [number, number, number];
  /** The environment map's URL and whether it is tinted by the base texture (EnvMetal). */
  readonly env?: { readonly url: string; readonly metal: boolean };
}

/**
 * The look of one run, or undefined when its record (if any) asks for nothing beyond what the run's
 * texture, blend mode and flags already give. `interior` is `wmoRunIsInterior`: an interior run is
 * drawn by the unlit path, which has no emissive term.
 */
export function wmoRunLook(
  material: WmoMaterial | undefined,
  interior: boolean,
  environmentUrl: string | undefined,
): WmoRunLook | undefined {
  if (!material) return undefined;
  const shader = material.shader;
  const primaryAlpha = shader === WMO_SHADER_OPAQUE || shader === WMO_SHADER_SPECULAR || shader === WMO_SHADER_METAL
    || shader === WMO_SHADER_ENV || shader === WMO_SHADER_ENV_METAL;
  const [red, green, blue] = material.sidnColour;
  const sidn = !interior && (material.flags & WMO_MATERIAL_SIDN) !== 0 && (red | green | blue) !== 0
    ? [red / 255, green / 255, blue / 255] as const
    : undefined;
  const env = (shader === WMO_SHADER_ENV || shader === WMO_SHADER_ENV_METAL) && environmentUrl
    ? { url: environmentUrl, metal: shader === WMO_SHADER_ENV_METAL }
    : undefined;
  if (!primaryAlpha && !sidn && !env) return undefined;
  return { primaryAlpha, ...(sidn ? { sidn } : {}), ...(env ? { env } : {}) };
}

/** The program variant a look compiles to: the part of the cache key it adds. */
export function wmoRunLookKey(look: WmoRunLook): string {
  return `wmo-look-v1:${look.primaryAlpha ? "a" : ""}${look.sidn ? "s" : ""}${look.env ? (look.env.metal ? "m" : "e") : ""}`;
}

export interface WmoRunLookUniforms {
  /** The world light's own `wowDaylight` uniform object (one write a frame, shared by every program). */
  readonly daylight: { value: number };
}

const MAP_MARKER = "#include <map_fragment>";
const AO_MARKER = "#include <aomap_fragment>";
const OPAQUE_MARKER = "#include <opaque_fragment>";
const FOG_VERTEX_MARKER = "#include <fog_vertex>";

/** Every replacement the look makes, split out so a static GLSL test can read them. */
export const WMO_RUN_LOOK_GLSL = Object.freeze({
  fragmentPars: /* glsl */ `
#ifdef WOW_WMO_SIDN
uniform vec3 wowWmoSidn;
#endif
#ifdef WOW_WMO_ENV
uniform sampler2D wowWmoEnvMap;
varying vec2 vWowWmoEnvUv;
#endif
`,
  vertexPars: /* glsl */ `
#ifdef WOW_WMO_ENV
varying vec2 vWowWmoEnvUv;
#endif
`,
  map: /* glsl */ `
#ifdef WOW_WMO_PRIMARY_ALPHA
  float wowWmoAlpha = diffuseColor.a;
#endif
${MAP_MARKER}
#ifdef WOW_WMO_PRIMARY_ALPHA
  diffuseColor.a = wowWmoAlpha;
#endif
`,
  // Lit runs only (the world light's body declares wowLight and wowDaylight). By day the glow is
  // zero and the light is exactly the one the world light computed.
  ao: /* glsl */ `
#ifdef WOW_WMO_SIDN
  vec3 wowWmoGlow = wowWmoSidn * ( 1.0 - wowDaylight );
  reflectedLight.directDiffuse = diffuseColor.rgb
    * pow( min( wowLight + wowWmoGlow, max( wowLight, vec3( 1.0 ) ) ), vec3( 2.2 ) );
#endif
${AO_MARKER}
`,
  opaque: /* glsl */ `
#if defined( WOW_WMO_ENV ) && defined( USE_MAP )
  vec3 wowWmoEnv = texture2D( wowWmoEnvMap, vWowWmoEnvUv ).rgb;
  #ifdef WOW_WMO_ENV_METAL
    outgoingLight += sampledDiffuseColor.rgb * sampledDiffuseColor.a * wowWmoEnv;
  #else
    outgoingLight += sampledDiffuseColor.a * wowWmoEnv;
  #endif
#endif
${OPAQUE_MARKER}
`,
  vertex: /* glsl */ `
${FOG_VERTEX_MARKER}
#ifdef WOW_WMO_ENV
  vec3 wowWmoEye = normalize( mvPosition.xyz );
  vec3 wowWmoNormal = normalize( normalMatrix * normal );
  vWowWmoEnvUv = wowWmoEye.xy - 2.0 * wowWmoNormal.xy * dot( wowWmoNormal, wowWmoEye );
#endif
`,
});

/**
 * Adds a run's look to its material, after every hook already installed. A look on an unlit run
 * (MeshBasicMaterial) never carries `sidn`; `env` needs the environment texture to sample.
 */
export function applyWmoRunLook(
  material: THREE.MeshBasicMaterial | THREE.MeshStandardMaterial,
  look: WmoRunLook,
  uniforms: WmoRunLookUniforms,
  environment: THREE.Texture | undefined,
): void {
  const lit = material instanceof THREE.MeshStandardMaterial;
  const sidn = lit && look.sidn !== undefined;
  const env = look.env !== undefined && environment !== undefined;
  const defines = [
    look.primaryAlpha ? "#define WOW_WMO_PRIMARY_ALPHA\n" : "",
    sidn ? "#define WOW_WMO_SIDN\n" : "",
    env ? "#define WOW_WMO_ENV\n" : "",
    env && look.env!.metal ? "#define WOW_WMO_ENV_METAL\n" : "",
  ].join("");
  if (defines.length === 0) return;
  const sidnUniform = { value: new THREE.Vector3(...(look.sidn ?? [0, 0, 0])) };
  const envUniform = { value: environment ?? null };
  const previousCompile = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previousCompile.call(material, shader, renderer);
    const once = (source: string, marker: string): boolean => source.split(marker).length - 1 === 1;
    if (!once(shader.fragmentShader, MAP_MARKER) || !once(shader.fragmentShader, OPAQUE_MARKER)
      || !once(shader.vertexShader, FOG_VERTEX_MARKER) || (sidn && !once(shader.fragmentShader, AO_MARKER))) {
      throw new Error("WMO run look expected one map, opaque, fog-vertex and ao marker");
    }
    if (sidn) {
      shader.uniforms.wowWmoSidn = sidnUniform;
      shader.uniforms.wowDaylight ??= uniforms.daylight;
    }
    if (env) shader.uniforms.wowWmoEnvMap = envUniform;
    let fragment = `${defines}${WMO_RUN_LOOK_GLSL.fragmentPars}\n${shader.fragmentShader}`
      .replace(MAP_MARKER, WMO_RUN_LOOK_GLSL.map)
      .replace(OPAQUE_MARKER, WMO_RUN_LOOK_GLSL.opaque);
    if (sidn) fragment = fragment.replace(AO_MARKER, WMO_RUN_LOOK_GLSL.ao);
    shader.fragmentShader = fragment;
    shader.vertexShader = `${defines}${WMO_RUN_LOOK_GLSL.vertexPars}\n${shader.vertexShader}`
      .replace(FOG_VERTEX_MARKER, WMO_RUN_LOOK_GLSL.vertex);
  };
  material.customProgramCacheKey = () => `${previousKey}|${wmoRunLookKey({
    primaryAlpha: look.primaryAlpha,
    ...(sidn ? { sidn: look.sidn! } : {}),
    ...(env ? { env: look.env! } : {}),
  })}`;
  material.needsUpdate = true;
}
