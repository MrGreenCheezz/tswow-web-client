/**
 * 24.10 (7.50): the screen-space pools' GLSL (`LightPoolPass.ts`), cut from the forward world light
 * (`WORLD_LIGHT_BODY`) rather than re-written, so a deferred pool is lit by exactly the arithmetic a
 * forward one is and the two cannot drift apart:
 *
 * - `LIGHT_POOL_LAMP_GLSL`: one fixture's term — the client falloff or the heuristic pool, the
 *   cinematic pool over it, its warmth and the immersive scale — the body of the forward loop with
 *   the lamp and its colour handed in.
 * - `LIGHT_POOL_LIT_GLSL`: the light a lit surface already took — the authored pair, the enhanced
 *   grade and the forward set's lamps under the same ceiling of one — under the sun shadow the
 *   surface wrote into the capture's alpha (at night Stormwind's moon key is 0.38/0.51/0.64, and
 *   without its shadow a shaded street read twice as lit as it was).
 *
 * Throws at load when `WORLD_LIGHT_BODY` no longer has the anchors it is cut at: a silent cut would
 * light the deferred pools by other rules than the forward ones.
 */
import { WORLD_LAMP_INDOOR_CEILING, WORLD_LIGHT_BODY, WORLD_LOCAL_LIGHT_LIMIT } from "./WorldLighting.js";

function cut(source: string, from: string, to: string, what: string): string {
  const start = source.indexOf(from);
  const end = start < 0 ? -1 : source.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`LightPoolGlsl: WORLD_LIGHT_BODY lost the ${what} anchors`);
  return source.slice(start, end + to.length);
}

/** The forward loop's body for one lamp: from its distance to the line that adds it. */
const LAMP_BODY = cut(WORLD_LIGHT_BODY,
  "    vec3 wowToLamp = wowLamp.xyz + vViewPosition;",
  "        * min( 1.0, wowImmersiveStrength / 0.65 );\n    }",
  "fixture loop");
const LAMP_COLOUR = "vec4 wowLampColour = wowLocalLightColour[ wowLightIndex ];";
if (!LAMP_BODY.includes(LAMP_COLOUR)) throw new Error("LightPoolGlsl: the fixture loop no longer reads its colour by index");

/** The enhanced grade and the forward lamps, from the authored light to the ceiling of one. */
const LIT_BODY = cut(WORLD_LIGHT_BODY,
  "vec3 wowLight = wowAuthoredLight;",
  " * wowLampIndoor ) );\n}", // 25.10 (6.27 indoors): the lamps' ceiling, one outside, more in a sunless room
  "enhanced grade");

/** The darkness the heuristic fixture term reads: the key ambient's luma, as the enhanced grade derives it. */
const DARKNESS_BODY = cut(WORLD_LIGHT_BODY,
  "  float wowHighSun = wowHighSunKey.x;",
  "  float wowDarkness = 1.0 - smoothstep( 0.18, 0.55, wowAmbientLuma );",
  "key ambient");

/**
 * `vec3 lightPoolLamp( vec4 wowLamp, vec3 colour, vec3 normal, vec3 vViewPosition, float wowDarkness )`:
 * one lamp's light on a surface at view position `-vViewPosition` (the forward shader's convention),
 * `wowLamp` as `wowLocalLightPosition` holds it (view-space centre, signed radius), `colour` the
 * light's colour already times its strength. Needs `WORLD_LIGHT_PARS`.
 */
export const LIGHT_POOL_LAMP_GLSL = /* glsl */ `
vec3 lightPoolLamp( vec4 wowLamp, vec3 colour, vec3 normal, vec3 vViewPosition, float wowDarkness ) {
  vec3 wowLampLight = vec3( 0.0 );
  float wowLampDaylight = wowDaylight * ( 1.0 - wowLampIndoor ); // 25.10 (6.27 indoors), as the forward loop
${LAMP_BODY.replace(LAMP_COLOUR, "vec4 wowLampColour = vec4( colour, 1.0 );")}
  return wowLampLight;
}
`;

/**
 * `float lightPoolDarkness()`: the heuristic term's `wowDarkness`, from the world light's uniforms
 * alone (no surface), as the enhanced grade computes it. Needs `WORLD_LIGHT_PARS`.
 */
export const LIGHT_POOL_DARKNESS_GLSL = /* glsl */ `
float lightPoolDarkness() {
  float wowGradeNL = 0.0;
  float wowShadow = 1.0;
  vec3 wowGradeAuthored = wowAmbient;
${DARKNESS_BODY}
  return wowDarkness;
}
`;

/**
 * `vec3 lightPoolLit( vec3 normal, vec3 vViewPosition, vec3 wowViewSunDirection, float wowShadow )`:
 * the light multiplier a lit surface was drawn with, the forward lamps included, under the sun shadow
 * the surface itself reported (`WORLD_SHADOW_ALPHA_GLSL`). Needs `WORLD_LIGHT_PARS`.
 */
export const LIGHT_POOL_LIT_GLSL = /* glsl */ `
vec3 lightPoolLit( vec3 normal, vec3 vViewPosition, vec3 wowViewSunDirection, float wowShadow ) {
  float wowDot = dot( normalize( normal ), wowViewSunDirection );
  float wowNL = max( wowDot, 0.0 );
  float wowGradeNL = wowNL;
  vec3 wowAuthoredLight = max( wowAmbient + wowDiffuse * ( wowNL * wowShadow ), vec3( 0.0 ) );
  vec3 wowGradeAuthored = wowAuthoredLight;
${LIT_BODY}
  return wowLight;
}
`;

/**
 * 25.10 (6.27 indoors): `vec3 lightLamps( vec3 normal, vec3 vViewPosition )` — the forward set's lamps
 * (`wowLocalLightPosition`/`wowLocalLightColour`, the first `wowLocalLightCount`) on a surface without
 * the world light of its own: a room's inside (MeshBasic × MOCV) or a doodad lit by its MODD colour.
 * Each lamp is `lightPoolLamp`, the forward loop's own body, with the darkness the grade reads from the
 * same uniforms, so a fireball lights a dungeon wall by the rules it lights a street by. Zero unless the
 * immersive grade is on.
 *
 * `vec3 lightLampsOver( vec3 base, vec3 lamps )`: the linear light the lamps add over a surface's own
 * display-space light `base` — both under one ceiling (one outside, as the forward grade clips them;
 * `WORLD_LAMP_INDOOR_CEILING` in a sunless room, `wowLampIndoor`) — minus what `base` already gave.
 *
 * Needs `WORLD_LIGHT_PARS`, `LIGHT_POOL_LAMP_GLSL` and `LIGHT_POOL_DARKNESS_GLSL` before it.
 */
export const LIGHT_LAMPS_GLSL = /* glsl */ `
vec3 lightLamps( vec3 normal, vec3 vViewPosition ) {
  vec3 wowLamps = vec3( 0.0 );
  if ( wowImmersiveStrength <= 0.0001 || wowLocalLightCount <= 0 ) return wowLamps;
  float wowDarkness = lightPoolDarkness();
  for ( int wowLightIndex = 0; wowLightIndex < ${WORLD_LOCAL_LIGHT_LIMIT}; wowLightIndex ++ ) {
    if ( wowLightIndex >= wowLocalLightCount ) break;
    vec4 wowLampColour = wowLocalLightColour[ wowLightIndex ];
    wowLamps += lightPoolLamp( wowLocalLightPosition[ wowLightIndex ], wowLampColour.rgb * wowLampColour.w,
      normal, vViewPosition, wowDarkness );
  }
  return wowLamps;
}
vec3 lightLampsOver( vec3 base, vec3 lamps ) {
  vec3 wowBase = max( base, vec3( 0.0 ) );
  vec3 wowCeiling = max( wowBase, vec3( 1.0 + ${(WORLD_LAMP_INDOOR_CEILING - 1).toFixed(2)} * wowLampIndoor ) );
  return max( pow( min( wowBase + lamps, wowCeiling ), vec3( 2.2 ) ) - pow( wowBase, vec3( 2.2 ) ), vec3( 0.0 ) );
}
`;
