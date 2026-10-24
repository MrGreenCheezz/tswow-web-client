/**
 * 24.10 (7.47): «Сила объёма» — one multiplier over the three relief leaves («Объём земли»,
 * «Объём зданий», «Объём предметов»).
 *
 * The owner found the doodads' relief barely noticeable (24.10) and approved a slider instead of new
 * fixed numbers. Every relief program (`TerrainReliefShader.ts`, `ReliefShader.ts`) declares the one
 * uniform {@link RELIEF_STRENGTH_UNIFORM} and binds the one object {@link RELIEF_STRENGTH}, so moving
 * the slider writes a number: no program key changes, nothing recompiles, no material is rebuilt
 * (three uploads the value with the material's other uniforms on its next draw). The renderer of each
 * thread sets its own copy (`WorldRenderer3D.setReliefStrength`), so the render worker gets it as any
 * other setting does.
 *
 * What it scales, and how far (each term at 1.0 is the stage's own number, exactly — the factors
 * multiply the literal by 1.0):
 * - the march's depth (parallax) up to {@link RELIEF_DEPTH_GAIN_MAX}×, and above 1× only on surfaces
 *   seen from well above (fully from {@link RELIEF_DEPTH_GAIN_VIEW} [1]), so a grazing wall or slope
 *   keeps today's depth and never swims; the step count follows the depth so a deeper march looking
 *   down is not coarser;
 * - the derived tilt (the buildings' and doodads' bump, the ground's normal) linearly, but never past
 *   the larger of its own length and a cap ({@link RELIEF_TILT_CAP}, {@link TERRAIN_RELIEF_SLOPE_CAP});
 * - the joints' cavity up to {@link RELIEF_CAVITY_GAIN_MAX}×, the shading's whole factor held in
 *   [{@link RELIEF_SHAPE_FLOOR}, {@link RELIEF_SHAPE_CEILING}] (no black joints, no burnt crowns);
 * - the soft self-shadow, its strength never past {@link RELIEF_SHADOW_MAX}.
 * The sky term follows the tilt by itself; the relief sun's ±50 % range stays as it is (it already
 * bounds the tilted N·L the slider makes larger).
 *
 * The GLSL lines it adds all end in {@link RELIEF_STRENGTH_TAG}, and every factor it puts on a stage's
 * number is a `* relief…Gain` token: the tests strip both and find the program of before the slider
 * to the byte.
 */

/** 24.10 (7.47): the slider's range as a multiplier (setting percent / 100). */
export const RELIEF_STRENGTH_MAX = 3;
export const RELIEF_STRENGTH_DEFAULT = 1;
/** 24.10 (7.47): the march's depth grows at most this much (2× is still continuous in 5–10 steps). */
export const RELIEF_DEPTH_GAIN_MAX = 2;
/** 24.10 (7.47): the view elevation |V·N| over which a deeper march fades in (≈ 17° … 37°). */
export const RELIEF_DEPTH_GAIN_VIEW: readonly [number, number] = Object.freeze([0.3, 0.6]);
/**
 * 24.10 (7.47): the buildings' and doodads' tilt (a tangent) grows to at most ≈ 40° (1.0 lifted the
 * lion's mean ≈ 3 % at 300 %).
 */
export const RELIEF_TILT_CAP = 0.85;
/**
 * 24.10 (7.47): the ground's tangent-space slope (a sine) grows to at most ≈ 37°: the ground's tilted
 * normal feeds the world light's rim and cool fill, and 0.85 drew blue rims along the stones at 300 %.
 */
export const TERRAIN_RELIEF_SLOPE_CAP = 0.6;
/** 24.10 (7.47): the joints' cavity grows at most this much (0.35 → 0.7). */
export const RELIEF_CAVITY_GAIN_MAX = 2;
/** 24.10 (7.47): the cavity × sky factor's bounds (today's reach: ≈ 0.47 … 1.73). */
export const RELIEF_SHAPE_FLOOR = 0.45;
export const RELIEF_SHAPE_CEILING = 1.8;
/** 24.10 (7.47): the most of the sun term a stone's own shadow may take, whatever the slider. */
export const RELIEF_SHADOW_MAX = 0.7;

/** 24.10 (7.47): the uniform's name in every relief program. */
export const RELIEF_STRENGTH_UNIFORM = "reliefStrength";
/** 24.10 (7.47): the comment that ends every GLSL line the slider adds (the tests strip them). */
export const RELIEF_STRENGTH_TAG = "// relief-strength";

/** 24.10 (7.47): the one value every relief program in this thread reads. */
export const RELIEF_STRENGTH: { value: number } = { value: RELIEF_STRENGTH_DEFAULT };

/** 24.10 (7.47): a setting's multiplier, clamped to the slider's range; garbage is the default. */
export function reliefStrengthScale(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) return RELIEF_STRENGTH_DEFAULT;
  return Math.min(RELIEF_STRENGTH_MAX, Math.max(0, number));
}

/** 24.10 (7.47): sets the value every relief program of this thread reads on its next draw. */
export function setReliefStrength(scale: unknown): void {
  RELIEF_STRENGTH.value = reliefStrengthScale(scale);
}

const f = (value: number) => value.toFixed(4);
const T = RELIEF_STRENGTH_TAG;

/**
 * 24.10 (7.47): the declarations every relief program takes (one line each, each tagged). The gains
 * are macros of the uniform: a global may not be initialised from a uniform in GLSL ES.
 */
export const RELIEF_STRENGTH_GLSL = /* glsl */ `
uniform float ${RELIEF_STRENGTH_UNIFORM}; ${T}
#define reliefDepthGain( e ) ( reliefStrength < 1.0 ? reliefStrength : 1.0 + ( min( reliefStrength, ${f(RELIEF_DEPTH_GAIN_MAX)} ) - 1.0 ) * smoothstep( ${f(RELIEF_DEPTH_GAIN_VIEW[0])}, ${f(RELIEF_DEPTH_GAIN_VIEW[1])}, e ) ) ${T}
#define reliefStepGain( e ) max( reliefDepthGain( e ), 1.0 ) ${T}
#define reliefCavityGain min( reliefStrength, ${f(RELIEF_CAVITY_GAIN_MAX)} ) ${T}
#define reliefShadowGain( s ) min( reliefStrength, ${f(RELIEF_SHADOW_MAX)} / s ) ${T}
vec3 reliefTilt( vec3 tilt, float cap ) { float l = length( tilt ); float most = max( l, cap ); return l * reliefStrength > most ? tilt * ( most / l ) : tilt * reliefStrength; } ${T}
vec2 reliefTilt( vec2 tilt, float cap ) { float l = length( tilt ); float most = max( l, cap ); return l * reliefStrength > most ? tilt * ( most / l ) : tilt * reliefStrength; } ${T}
`;

/** 24.10 (7.47): the number form of the GLSL's depth gain (tests and diagnostics). */
export function reliefDepthGain(strength: number, viewElevation: number): number {
  if (strength < 1) return strength;
  const [a, b] = RELIEF_DEPTH_GAIN_VIEW;
  const t = Math.min(1, Math.max(0, (viewElevation - a) / (b - a)));
  return 1 + (Math.min(strength, RELIEF_DEPTH_GAIN_MAX) - 1) * t * t * (3 - 2 * t);
}

/** 24.10 (7.47): the number form of the GLSL's tilt (tests and diagnostics): a length in, a length out. */
export function reliefTiltLength(length: number, cap: number, strength: number): number {
  const most = Math.max(length, cap);
  return length * strength > most ? most : length * strength;
}
