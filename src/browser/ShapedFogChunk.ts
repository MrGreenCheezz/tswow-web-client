import * as THREE from "three";

/*
 * 15.11 (7.66): the fog function every fogged program calls, put into three's own fog chunks.
 *
 * `wowFogFactor` is three's linear fog for a plain far distance and Wow.exe's shaped fog for an encoded one
 * (DistanceFog.ts, `encodeShapedFogFar`). The shader bodies that replace three's `fog_fragment` (ModelBuild.ts,
 * WorldLighting.ts, the WMO interior fog) call it by name, so the chunk must be patched wherever such a material
 * is compiled: the world renderer's thread, and also the page's own models when the world draws in a worker (the
 * login screens set a fog, and their additive batches and particles take ModelBuild's fog step). So this module
 * installs itself when it is first imported, and the modules that write the call import it.
 */

/** GLSL: the fog amount (three's `fogFactor`, 1 = all fog) of either encoding, and a linear one for WMO rooms. */
export const SHAPED_FOG_GLSL = /* glsl */ `
float wowShapedFogFactor( float fogNear, float fogFar, float depth ) {
  float wowEnd = floor( -fogFar );
  float wowDensity = fract( -fogFar ) * 16.0;
  float wowVisible = clamp( ( wowEnd - depth ) / max( wowEnd - fogNear, 0.001 ), 0.0, 1.0 );
  return 1.0 - pow( max( wowVisible, 1e-6 ), wowDensity );
}
float wowFogFactor( float fogNear, float fogFar, float depth ) {
  return fogFar < 0.0 ? wowShapedFogFactor( fogNear, fogFar, depth ) : smoothstep( fogNear, fogFar, depth );
}
float wowLinearFogFactor( float fogNear, float fogFar, float depth ) {
  return fogFar < 0.0 ? wowShapedFogFactor( fogNear, fogFar, depth )
    : clamp( ( depth - fogNear ) / max( fogFar - fogNear, 0.001 ), 0.0, 1.0 );
}
`;

const SHAPED_FOG_LINEAR = "float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );";

/**
 * Puts {@link SHAPED_FOG_GLSL} into three's `fog_pars_fragment` and makes `fog_fragment` call it. Idempotent; it
 * must have run before the first fogged program compiles, which the import of this module guarantees. Every
 * material with three's fog includes both chunks, so the shaped fog reaches terrain, models, the horizon, particles
 * and decals at once.
 */
export function installShapedFogChunks(): void {
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  const pars = chunks.fog_pars_fragment!;
  if (!pars.includes("wowShapedFogFactor")) {
    const close = pars.lastIndexOf("#endif");
    if (close < 0) throw new Error("fog_pars_fragment has no #endif to put the shaped fog before");
    chunks.fog_pars_fragment = `${pars.slice(0, close)}${SHAPED_FOG_GLSL}${pars.slice(close)}`;
  }
  const body = chunks.fog_fragment!;
  if (body.includes(SHAPED_FOG_LINEAR)) {
    chunks.fog_fragment = body.replace(SHAPED_FOG_LINEAR, "float fogFactor = wowFogFactor( fogNear, fogFar, vFogDepth );");
  } else if (!body.includes("wowFogFactor(")) {
    throw new Error("fog_fragment no longer holds three's linear fog line");
  }
}

installShapedFogChunks();
