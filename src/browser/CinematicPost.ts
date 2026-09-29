/**
 * Cinematic post-processing for the enhanced look: filmic grade, mip-chain bloom with a sun disc,
 * sun-facing aerial scattering and half-resolution ambient occlusion.
 *
 * Every leaf is opt-in and none of them is reachable from the faithful path. The renderer hands
 * this class the same display-referred scene capture the classic `ffxGlow` chain composites, plus
 * the resolved depth texture the sun-shaft pass already knows how to make; when no leaf is on the
 * renderer never calls in here and the frame is the classic composite (or the direct path) byte
 * for byte.
 *
 * The capture is display-referred eight-bit: the world has already been through the shoulder and
 * the sRGB encode per material (see `#createFullscreenGlowTargets`). This pass decodes it to
 * linear, adds energy that the capture cannot hold — bloom, the sun disc, forward-scattered haze —
 * and only then applies a curve with a white point above one, so those additions roll off softly
 * rather than clipping flat. Grading is driven by the zone's own Light.dbc colours: the diffuse
 * band tints highlights, the ambient band tints shadows, and the physical sun elevation decides how
 * golden or how cool the frame reads. Nothing here is a flat global filter.
 *
 * Sun shafts: while the account's «Солнечные лучи» leaf is on, this chain draws them itself (the
 * classic radial pass is skipped): an emission mask of clear sky around the sun at half resolution,
 * a long jittered radial march and a short one over each long step, contrasted against what the
 * same rays would carry through open sky, so beams appear where leaves and towers cut the light.
 * One strength (`setStrength`, the «Сила кинематографичных эффектов» slider) scales grade, bloom,
 * glare, haze and shafts together; `LightParams.Glow` and a smoothed roof factor scale haze and
 * grade per zone (`cinematicZoneAtmosphere`).
 *
 * DOM-free except for three; the pure functions below are what `tests/cinematic-post.test.mjs`
 * holds the shaders to.
 */
import * as THREE from "three";

import { GOD_RAY_STRENGTH_SCALE_MAX } from "./LightingQuality.js";

export interface CinematicProfile {
  /** Filmic curve, Light.dbc-driven split toning, saturation/contrast, vignette, exposure adaptation. */
  readonly grade: boolean;
  /** Soft-knee threshold, six-level mip-chain bloom and the occluded sun disc/glare. */
  readonly bloom: boolean;
  /** Depth-based aerial perspective with forward (Mie-like) scattering toward the sun. */
  readonly sunScattering: boolean;
  /** Half-resolution screen-space ambient occlusion for contact shadows. */
  readonly ambientOcclusion: boolean;
  /** Warm back/rim light on lit models while the sun is low; material-side, no extra pass. */
  readonly rimLight: boolean;
  /** Glitter path of the low sun on water and ocean; material-side, no extra pass. */
  readonly waterSunGlitter: boolean;
  /**
   * Static scenery (trees, doodads, WMO groups) casts into and receives the existing sun shadow
   * map. Needs lighting quality 1 or 2; costs shadow-pass draws, not a new pass.
   */
  readonly sceneryShadows: boolean;
  /**
   * Water and ocean mirror the zone's Light.dbc sky bands (the colours the sky dome is drawn with)
   * through a Fresnel term; material-side, no extra pass.
   */
  readonly waterSkyReflection: boolean;
}

export const DEFAULT_CINEMATIC_PROFILE: Readonly<CinematicProfile> = Object.freeze({
  grade: false,
  bloom: false,
  sunScattering: false,
  ambientOcclusion: false,
  rimLight: false,
  waterSunGlitter: false,
  sceneryShadows: false,
  waterSkyReflection: false,
});

export function normaliseCinematicProfile(
  profile: Readonly<Partial<CinematicProfile>> | undefined,
): Readonly<CinematicProfile> {
  return Object.freeze({
    grade: profile?.grade === true,
    bloom: profile?.bloom === true,
    sunScattering: profile?.sunScattering === true,
    ambientOcclusion: profile?.ambientOcclusion === true,
    rimLight: profile?.rimLight === true,
    waterSunGlitter: profile?.waterSunGlitter === true,
    sceneryShadows: profile?.sceneryShadows === true,
    waterSkyReflection: profile?.waterSkyReflection === true,
  });
}

export function sameCinematicProfile(a: Readonly<CinematicProfile>, b: Readonly<CinematicProfile>): boolean {
  return a.grade === b.grade && a.bloom === b.bloom && a.sunScattering === b.sunScattering
    && a.ambientOcclusion === b.ambientOcclusion && a.rimLight === b.rimLight
    && a.waterSunGlitter === b.waterSunGlitter && a.sceneryShadows === b.sceneryShadows
    && a.waterSkyReflection === b.waterSkyReflection;
}

// ---------------------------------------------------------------------------------------------
// Strength slider and per-zone atmosphere
// ---------------------------------------------------------------------------------------------

/** «Сила кинематографичных эффектов»: 1 is the tuned look, 0 neutral, 1.5 the ceiling. */
export const CINEMATIC_STRENGTH_DEFAULT = 1;
export const CINEMATIC_STRENGTH_MAX = 1.5;

/** The account's percentage (0..150) as the multiplier the passes use; garbage is the default. */
export function cinematicStrength(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return CINEMATIC_STRENGTH_DEFAULT;
  return Math.max(0, Math.min(CINEMATIC_STRENGTH_MAX, number));
}

/**
 * How much air a zone's own light says it has, 0.5 (crisp) .. 1 (soft, hazy), from
 * `LightParams.Glow` — the strength the original client gives its own full-screen glow there.
 *
 * Read from the table rather than from a list of zone names because the table already is that
 * list: the artists authored Glow 0 for Ironforge and Dun Morogh's cold clear air and for Dalaran,
 * 0.1-0.2 for Crystalsong and Tanaris, 0.3 for Stormwind, 0.65 for Elwynn, Stranglethorn and Booty
 * Bay, 0.85 for Duskwood and 1.0 for Darnassus (sampled from this dataset's Light.dbc). The haze
 * and the grade follow that authored softness, and a missing value (an old gateway) is the middle.
 * Being under a roof is a separate, smoothed factor (`CinematicPost` shelter), not part of this.
 */
export function cinematicZoneAtmosphere(glow: number | undefined): number {
  if (glow === undefined || !Number.isFinite(glow)) return 0.75;
  return 0.5 + 0.5 * smooth(0, 0.6, Math.max(0, Math.min(1, glow)));
}

/** Whether any leaf needs the offscreen scene capture and the cinematic composite. */
export function cinematicPostActive(profile: Readonly<CinematicProfile>): boolean {
  return profile.grade || profile.bloom || profile.sunScattering || profile.ambientOcclusion;
}

/** Leaves that read the resolved world depth (sun occlusion, distance, surface reconstruction). */
export function cinematicNeedsDepth(profile: Readonly<CinematicProfile>): boolean {
  return profile.bloom || profile.sunScattering || profile.ambientOcclusion;
}

/**
 * Below this share of the window the adaptive-resolution governor is visibly fighting for frames;
 * the occlusion pass is the heaviest leaf, so it steps aside rather than competing with it.
 */
export const AMBIENT_OCCLUSION_MIN_RENDER_SCALE = 0.7;

// ---------------------------------------------------------------------------------------------
// Filmic curve
// ---------------------------------------------------------------------------------------------

/**
 * Linear value up to which the curve is the identity (sRGB ~ 239). The capture is display-referred,
 * so everything the world draws is at most 1: a lower knee (0.76, sRGB 225) compressed every bright
 * authored texture — snow, sand, white stone — before any added energy reached it.
 */
export const FILMIC_KNEE = 0.85;
/** Linear value that maps to display white: headroom for bloom, sun and haze energy. */
export const FILMIC_WHITE = 2.4;
/** Mid-grey pivot for the log-space contrast. */
export const FILMIC_PIVOT = 0.18;

/**
 * Identity below the knee, then an extended-Reinhard shoulder that is C1-continuous at the knee and
 * reaches exactly one at the white point. The GLSL `cinematicShoulder` is this function.
 */
export function filmicShoulder(value: number, knee = FILMIC_KNEE, white = FILMIC_WHITE): number {
  if (!(value > knee)) return Math.max(0, value);
  const span = 1 - knee;
  const t = (value - knee) / span;
  const w = (white - knee) / span;
  return knee + span * Math.min(1, (t * (1 + t / (w * w))) / (1 + t));
}

/** Log-space contrast about mid grey: the pivot stays put, the ends spread. */
export function filmicContrast(value: number, contrast: number, pivot = FILMIC_PIVOT): number {
  if (!(value > 0)) return 0;
  return pivot * Math.pow(value / pivot, contrast);
}

// ---------------------------------------------------------------------------------------------
// Light.dbc-driven grade
// ---------------------------------------------------------------------------------------------

export interface GradeColour {
  r: number;
  g: number;
  b: number;
}

export interface CinematicGradeInput {
  /** Light.dbc diffuse (sun) band, display-space 0..1. */
  readonly diffuse: Readonly<GradeColour>;
  /** Light.dbc ambient band, display-space 0..1. */
  readonly ambient: Readonly<GradeColour>;
  /** Light.dbc fog band, display-space 0..1. */
  readonly fog: Readonly<GradeColour>;
  /** Physical sun elevation, -1..1 (the visible sun, allowed below the horizon). */
  readonly sunElevation: number;
  /** 0 clear .. 1 full storm. */
  readonly storm: number;
  readonly underwater: boolean;
  /**
   * How strongly the grade departs from neutral: the strength slider times the zone's atmosphere
   * and the roof factor. 1 when absent; 0 is the neutral grade (only the filmic shoulder remains).
   */
  readonly amount?: number;
}

export interface CinematicGrade {
  exposure: number;
  contrast: number;
  saturation: number;
  vignette: number;
  /**
   * Daylight shadow lift: dark values are multiplied by up to `1 + lift`, fading out by luma 0.22,
   * so a canopy-covered daytime frame keeps its readability after the contrast and the occlusion.
   */
  lift: number;
  /** Multipliers of unit luminance applied by shadow/highlight weight. */
  shadowTint: GradeColour;
  highlightTint: GradeColour;
  /** 0..1: how "golden hour" the frame is; also scales haze warmth and rim light. */
  golden: number;
  /** 0..1: night weight. */
  night: number;
  /** 0..1: daylight weight for the visible sun disc. */
  daylight: number;
}

function smooth(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/** Hue of a colour at unit luminance; grey when the colour is black or not finite. */
export function unitLuminanceHue(colour: Readonly<GradeColour>, target: GradeColour = { r: 1, g: 1, b: 1 }): GradeColour {
  const r = Number.isFinite(colour.r) ? Math.max(0, colour.r) : 0;
  const g = Number.isFinite(colour.g) ? Math.max(0, colour.g) : 0;
  const b = Number.isFinite(colour.b) ? Math.max(0, colour.b) : 0;
  const luma = r * LUMA_R + g * LUMA_G + b * LUMA_B;
  if (!(luma > 1e-4)) {
    target.r = 1; target.g = 1; target.b = 1;
    return target;
  }
  target.r = r / luma; target.g = g / luma; target.b = b / luma;
  return target;
}

function mixTint(target: GradeColour, hue: Readonly<GradeColour>, amount: number): void {
  target.r = 1 + (hue.r - 1) * amount;
  target.g = 1 + (hue.g - 1) * amount;
  target.b = 1 + (hue.b - 1) * amount;
  // Renormalise to unit luminance so tinting never changes brightness, only hue.
  const luma = target.r * LUMA_R + target.g * LUMA_G + target.b * LUMA_B;
  if (luma > 1e-4) {
    target.r /= luma; target.g /= luma; target.b /= luma;
  }
}

const COOL_SHADOW: Readonly<GradeColour> = Object.freeze({ r: 0.86, g: 0.96, b: 1.22 });
const scratchHue: GradeColour = { r: 1, g: 1, b: 1 };
const scratchCool: GradeColour = { r: 1, g: 1, b: 1 };

/**
 * The grade for one frame, from the zone's own light. No allocation when `target` is passed.
 *
 * - Golden hour (low sun, day): highlights take the sun band's hue strongly, contrast and
 *   saturation rise, shadows lean to the ambient band (Elwynn's dusk ambient is violet).
 * - Noon: a restrained version of the same, so midday keeps the authored palette.
 * - Night: cool shadows, slightly lower saturation, no warm highlights.
 * - Storm and underwater flatten the grade.
 */
export function cinematicGrade(input: Readonly<CinematicGradeInput>, target?: CinematicGrade): CinematicGrade {
  const out: CinematicGrade = target ?? {
    exposure: 1, contrast: 1, saturation: 1, vignette: 0, lift: 0,
    shadowTint: { r: 1, g: 1, b: 1 }, highlightTint: { r: 1, g: 1, b: 1 },
    golden: 0, night: 0, daylight: 1,
  };
  const elevation = Number.isFinite(input.sunElevation) ? input.sunElevation : 1;
  const storm = Number.isFinite(input.storm) ? Math.max(0, Math.min(1, input.storm)) : 0;
  const amount = input.amount === undefined || !Number.isFinite(input.amount)
    ? 1 : Math.max(0, Math.min(CINEMATIC_STRENGTH_MAX, input.amount));
  const daylight = smooth(-0.06, 0.1, elevation);
  const golden = smooth(-0.04, 0.08, elevation) * (1 - smooth(0.2, 0.5, elevation));
  const night = 1 - smooth(-0.12, 0.04, elevation);
  const calm = (1 - 0.7 * storm) * (input.underwater ? 0.35 : 1);
  // Full day, away from the golden band: where the lift and the lighter contrast belong.
  const midday = daylight * (1 - golden) * (1 - storm);

  out.golden = golden * calm;
  out.night = night;
  out.daylight = daylight * (1 - storm);
  // Every departure from neutral scales with `amount`; the weights above do not.
  // Small on purpose: the capture is display-referred, so every step of exposure pushes the brightest
  // authored texels (snow, sand, white stone) straight into the shoulder. The lift does the shade.
  out.exposure = 1 + amount * (0.03 * golden + 0.03 * midday - 0.02 * night);
  out.contrast = 1 + amount * (0.04 + 0.1 * golden + 0.02 * night) * calm;
  out.saturation = 1 + amount * ((0.07 + 0.06 * golden - 0.14 * night) * calm - 0.12 * storm);
  out.vignette = amount * (0.12 + 0.12 * golden + 0.06 * night);
  // Half what it was: with the shadow maps now taking most of the key light out of a shadow, the
  // lift is what keeps a canopy floor readable, not what keeps every shadow pale.
  out.lift = amount * (0.14 * midday + 0.05 * golden * daylight);

  // The golden-hour highlight tint was 0.16 + 0.52: at Booty Bay's sunset band it multiplied red by
  // ~1.36 in every highlight, so any texel above ~0.74 clipped into a flat orange sheet.
  unitLuminanceHue(input.diffuse, scratchHue);
  mixTint(out.highlightTint, scratchHue,
    Math.min(1, amount * (0.16 + 0.36 * golden) * (1 - 0.8 * night) * calm));

  unitLuminanceHue(input.ambient, scratchHue);
  mixTint(scratchCool, COOL_SHADOW, 1);
  // Shadow hue: the authored ambient, leaned toward a cool sky fill — more so at night.
  const cool = 0.25 + 0.35 * night;
  scratchHue.r = scratchHue.r * (1 - cool) + scratchCool.r * cool;
  scratchHue.g = scratchHue.g * (1 - cool) + scratchCool.g * cool;
  scratchHue.b = scratchHue.b * (1 - cool) + scratchCool.b * cool;
  mixTint(out.shadowTint, scratchHue, Math.min(1, amount * (0.3 + 0.25 * golden + 0.1 * night) * calm));
  return out;
}

/** Henyey-Greenstein phase normalised so the isotropic value is one. */
export function scatteringPhase(cosTheta: number, g: number): number {
  const c = Math.max(-1, Math.min(1, Number.isFinite(cosTheta) ? cosTheta : 0));
  const gg = Math.max(-0.95, Math.min(0.95, g));
  const denominator = Math.pow(1 + gg * gg - 2 * gg * c, 1.5);
  return (1 - gg * gg) / Math.max(denominator, 1e-6);
}

export const SCATTERING_G = 0.58;
/** Number of downsampled bloom levels below the half-resolution prefilter. */
export const BLOOM_LEVELS = 6;

export interface MipSize {
  readonly width: number;
  readonly height: number;
}

/** Half resolution, then halving per level, never below one texel. */
export function bloomMipSizes(width: number, height: number, levels = BLOOM_LEVELS): MipSize[] {
  const sizes: MipSize[] = [];
  let w = Math.max(1, Math.floor(width / 2));
  let h = Math.max(1, Math.floor(height / 2));
  for (let i = 0; i < levels; i++) {
    sizes.push(Object.freeze({ width: w, height: h }));
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }
  return sizes;
}

// ---------------------------------------------------------------------------------------------
// Sun shafts
// ---------------------------------------------------------------------------------------------

/**
 * Taps per radial pass. Two passes run at half resolution: a long one whose taps are spread over
 * most of the way to the sun, then a short one spanning exactly one long step, so the pair behaves
 * like a SHAFT_SAMPLES² tap march with no banding and no temporal accumulation.
 */
export const SHAFT_SAMPLES = 32;
/** Fraction of the distance to the source the long pass marches, and its cap in screen heights. */
export const SHAFT_MARCH_FRACTION = 0.92;
export const SHAFT_MARCH_MAX = 1.15;
/** A source further than this from the screen centre (NDC) is pulled in along its own direction. */
export const SHAFT_SOURCE_LIMIT = 3;
/**
 * Yards of air over which a beam reaches ~63% of its strength on the geometry behind it: the
 * shafts are scattered along the view ray, so the ground a few yards away carries little and a
 * hillside eighty yards off most of it (the sky, at the far end of every ray, all of it). On
 * geometry the beams also count at 0.55: a field under a low sun still showed the horizon's
 * silhouettes as bands of light across it at full weight.
 */
export const SHAFT_AIR_YARDS = 80;

/**
 * A frame's shaft ceiling as the march multiplies it in: absent, non-finite or negative is off;
 * above one it is the account's «Сила солнечных лучей» over the quality's share, allowed up to
 * `GOD_RAY_STRENGTH_SCALE_MAX`. This used to clamp at one, which would have discarded that slider
 * on the cinematic path while the classic pass honoured it.
 */
export function shaftCeiling(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(GOD_RAY_STRENGTH_SCALE_MAX, value));
}

export interface ShaftSource {
  /** Radial centre in screen UV; may lie well outside 0..1. */
  u: number;
  v: number;
  /** +1: march toward the sun's projection. -1: the sun is behind, march away from its antipode. */
  direction: number;
  /** 0..1: how much of the effect this view receives before day, weather and strength. */
  weight: number;
}

interface VectorLike {
  x: number;
  y: number;
  z: number;
}

const shaftRight = new THREE.Vector3();
const shaftUp = new THREE.Vector3();
const shaftForward = new THREE.Vector3();

/**
 * Where the shafts radiate from for this camera, and how much of them it sees.
 *
 * The screen point is the sun's projective image `(right/forward, up/forward)`. In front of the
 * camera the passes march toward it. Behind the camera the same formula lands on the anti-solar
 * point, and marching *away* from that point is exactly the geometry of shafts from a sun over the
 * viewer's shoulder, so the two cases meet continuously as the sun crosses the view plane. The
 * point is pulled in to `SHAFT_SOURCE_LIMIT` along its own direction so the march stays on screen.
 *
 * Two weights, the larger wins: facing the sun (full in frame, fading over 2 NDC beyond the edge —
 * a sun 15 degrees off screen still throws half its shafts in), and a high sun above the view
 * plane, which lights vertical shafts through a canopy whichever way the camera turns.
 */
export function cinematicShaftSource(
  camera: THREE.PerspectiveCamera,
  sun: Readonly<VectorLike>,
  target: ShaftSource = { u: 0.5, v: 0.5, direction: 1, weight: 0 },
): ShaftSource {
  target.weight = 0;
  const e = camera.matrixWorld.elements;
  shaftRight.set(e[0]!, e[1]!, e[2]!).normalize();
  shaftUp.set(e[4]!, e[5]!, e[6]!).normalize();
  shaftForward.set(-e[8]!, -e[9]!, -e[10]!).normalize();
  const f = shaftForward.x * sun.x + shaftForward.y * sun.y + shaftForward.z * sun.z;
  const r = shaftRight.x * sun.x + shaftRight.y * sun.y + shaftRight.z * sun.z;
  const u = shaftUp.x * sun.x + shaftUp.y * sun.y + shaftUp.z * sun.z;
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV() * 0.5));
  const tanH = tanV * (Number.isFinite(camera.aspect) && camera.aspect > 0 ? camera.aspect : 1);
  if (![f, r, u, tanV, tanH, sun.y].every(Number.isFinite) || !(tanV > 0)) return target;
  // Projective image of the sun; |f| is kept off zero so a sun on the view plane is "far away".
  const safeF = Math.abs(f) < 1e-4 ? (f < 0 ? -1e-4 : 1e-4) : f;
  let x = r / safeF / tanH;
  let y = u / safeF / tanV;
  const length = Math.hypot(x, y);
  if (length > SHAFT_SOURCE_LIMIT) {
    x *= SHAFT_SOURCE_LIMIT / length;
    y *= SHAFT_SOURCE_LIMIT / length;
  }
  target.u = x * 0.5 + 0.5;
  target.v = y * 0.5 + 0.5;
  target.direction = f >= 0 ? 1 : -1;
  let facing = 0;
  if (f > 0) {
    const outside = Math.max(Math.abs(r / f / tanH), Math.abs(u / f / tanV)) - 1;
    facing = (1 - smooth(0, 2, outside)) * (0.65 + 0.35 * smooth(0.2, 0.9, f));
  }
  const overhead = 0.55 * smooth(0.35, 0.8, sun.y) * smooth(0.15, 0.55, u);
  target.weight = Math.max(facing, overhead);
  return target;
}

// ---------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------

const VERTEX = /* glsl */ `
varying vec2 vUV;
void main() {
  vUV = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const COLOUR_PARS = /* glsl */ `
vec3 cinematicToLinear(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 cinematicToDisplay(vec3 c) {
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
`;

const VIEW_PARS = /* glsl */ `
uniform highp sampler2D depthTexture;
uniform mat4 inverseProjection;
vec3 cinematicViewPosition(vec2 uv, float depth) {
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 view = inverseProjection * clip;
  return view.xyz / view.w;
}
`;

/** Soft-knee prefilter from the full-resolution capture into the half-resolution HDR mip. */
const PREFILTER = /* glsl */ `
uniform sampler2D source;
uniform vec2 sourceTexel;
uniform vec4 threshold; // x threshold, y knee, z 1/(4 knee), w useDepth
uniform vec3 sunDirection;
uniform vec3 sunColour;
uniform vec3 sunDisc; // x intensity, y inner cos, z outer cos
uniform vec4 sunGlare; // x glare strength, y its exponent, z wide halo strength, w its exponent
uniform mat4 cameraWorld;
varying vec2 vUV;
${COLOUR_PARS}
${VIEW_PARS}
vec3 tap(vec2 uv) { return cinematicToLinear(texture2D(source, uv).rgb); }
float brightness(vec3 c) { return max(c.r, max(c.g, c.b)); }
vec3 karis(vec3 c) { return c / (1.0 + brightness(c)); }
void main() {
  // 13-tap box downsample with a Karis average on the partial groups: single hot pixels (a
  // specular glint, a lamp texel) cannot flicker the whole bloom as the camera moves.
  vec2 t = sourceTexel;
  vec3 a = tap(vUV + t * vec2(-2.0, -2.0));
  vec3 b = tap(vUV + t * vec2( 0.0, -2.0));
  vec3 c = tap(vUV + t * vec2( 2.0, -2.0));
  vec3 d = tap(vUV + t * vec2(-1.0, -1.0));
  vec3 e = tap(vUV + t * vec2( 1.0, -1.0));
  vec3 f = tap(vUV + t * vec2(-2.0,  0.0));
  vec3 g = tap(vUV);
  vec3 h = tap(vUV + t * vec2( 2.0,  0.0));
  vec3 i = tap(vUV + t * vec2(-1.0,  1.0));
  vec3 j = tap(vUV + t * vec2( 1.0,  1.0));
  vec3 k = tap(vUV + t * vec2(-2.0,  2.0));
  vec3 l = tap(vUV + t * vec2( 0.0,  2.0));
  vec3 m = tap(vUV + t * vec2( 2.0,  2.0));
  vec3 g0 = karis((d + e + i + j) * 0.25);
  vec3 g1 = karis((a + b + f + g) * 0.25);
  vec3 g2 = karis((b + c + g + h) * 0.25);
  vec3 g3 = karis((f + g + k + l) * 0.25);
  vec3 g4 = karis((g + h + l + m) * 0.25);
  vec3 colour = g0 * 0.5 + (g1 + g2 + g3 + g4) * 0.125;
  colour = colour / max(1.0 - brightness(colour), 0.02);
  float bright = brightness(colour);
  float soft = clamp(bright - threshold.x + threshold.y, 0.0, 2.0 * threshold.y);
  soft = soft * soft * threshold.z;
  float contribution = max(soft, bright - threshold.x) / max(bright, 1e-4);
  colour *= contribution;
  if (threshold.w > 0.5 && sunDisc.x > 0.0) {
    // The capture's sky is display-limited; the sun is injected here as real HDR energy on clear
    // sky texels only, so every roof, trunk and leaf in front of it occludes its glare per pixel.
    float depth = texture2D(depthTexture, vUV).r;
    if (depth >= 1.0) {
      vec3 ray = normalize(mat3(cameraWorld) * cinematicViewPosition(vUV, 1.0));
      float facing = dot(ray, sunDirection);
      float disc = smoothstep(sunDisc.z, sunDisc.y, facing);
      float aureole = pow(max(facing, 0.0), 900.0) * 0.35;
      colour += sunColour * (disc + aureole) * sunDisc.x;
      // The wide glare a low sun throws across the sky around it (strongest at golden hour); it is
      // what the bloom spreads into the warm veil over roofs and treetops near the sun.
      // Pale rather than saturated: sunlit air reads golden-white next to the sun, not orange.
      colour += mix(sunColour, vec3(1.0), 0.4) * sunGlare.x * pow(max(facing, 0.0), sunGlare.y);
      // And, at a low sun, the wide halo in the sun's own colour: the quarter of the sky around a
      // setting sun that goes orange in the reference stills, softly, well before the disc.
      colour += sunColour * sunGlare.z * pow(max(facing, 0.0), sunGlare.w);
    }
  }
  gl_FragColor = vec4(colour, 1.0);
}`;

/**
 * Sun-shaft emission at half resolution: clear sky (2x2 coverage of the full-resolution depth, so
 * leaf gaps keep soft edges) weighted by a lobe around the sun and by the sky's own brightness, so
 * a bright gap in a canopy emits and a dark night sky or a solid roof does not.
 */
const SHAFT_MASK = /* glsl */ `
uniform sampler2D source;
uniform vec2 depthTexel;
uniform vec3 sunDirection;
uniform vec4 shaftLobe; // x broad weight, y broad exponent, z core (~24 deg) weight, w lowest emitting elevation
uniform mat4 cameraWorld;
varying vec2 vUV;
${COLOUR_PARS}
${VIEW_PARS}
void main() {
  vec2 t = depthTexel * 0.5;
  float sky = 0.25 * (step(1.0, texture2D(depthTexture, vUV + vec2(-t.x, -t.y)).r)
    + step(1.0, texture2D(depthTexture, vUV + vec2(t.x, -t.y)).r)
    + step(1.0, texture2D(depthTexture, vUV + vec2(-t.x, t.y)).r)
    + step(1.0, texture2D(depthTexture, vUV + vec2(t.x, t.y)).r));
  vec3 ray = normalize(mat3(cameraWorld) * cinematicViewPosition(vUV, 1.0));
  float facing = max(dot(ray, sunDirection), 0.0);
  float lobe = shaftLobe.x * pow(facing, shaftLobe.y) + shaftLobe.z * pow(facing, 24.0);
  float bright = dot(cinematicToLinear(texture2D(source, vUV).rgb), vec3(0.2126, 0.7152, 0.0722));
  float emit = sky * lobe * (0.35 + 0.65 * smoothstep(0.04, 0.55, bright));
  // A high sun shines through gaps overhead, not through the horizon band between the trunks: that
  // band would only march into a flat veil over the whole lower frame.
  float above = smoothstep(shaftLobe.w, shaftLobe.w + 0.25, ray.y);
  // Green: the lobe if nothing stood in front of the sky; blue: the lobe over the sky that is really
  // there. The passes blur all three, and blue over green is the share of each ray's way to the sun
  // that is open — without the sky's own brightness in it, which used to read a dim open sky as
  // "blocked" and turn a clear sea horizon into beams everywhere.
  gl_FragColor = vec4(emit * above, lobe * above, sky * lobe * above, 1.0);
}`;

/** One radial pass toward (or, for a sun behind the camera, away from) the shaft source. */
const SHAFT_BLUR = /* glsl */ `
uniform sampler2D source;
uniform vec4 shaftSource; // xy source uv, z +1 toward / -1 away, w per-tap decay
uniform vec4 shaftMarch; // x fraction of the way to the source, y cap (screen heights), z jitter, w 1/yards of air a beam needs
uniform vec2 aspect;
varying vec2 vUV;
void main() {
  vec2 toSource = (shaftSource.xy - vUV) * shaftSource.z;
  float distance = length(toSource * aspect);
  float march = min(distance * shaftMarch.x, shaftMarch.y);
  vec2 delta = distance > 1e-5 ? toSource * (march / distance) / float(${SHAFT_SAMPLES}) : vec2(0.0);
  float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  vec2 uv = vUV + delta * jitter * shaftMarch.z;
  vec3 sum = vec3(0.0);
  float total = 0.0;
  float weight = 1.0;
  for (int i = 0; i < ${SHAFT_SAMPLES}; i++) {
    // Off-screen taps add nothing: an off-screen sun lights the frame from its edge inward.
    vec2 inside = step(vec2(0.0), uv) * step(uv, vec2(1.0));
    sum += texture2D(source, uv).rgb * weight * inside.x * inside.y;
    total += weight;
    weight *= shaftSource.w;
    uv += delta;
  }
  gl_FragColor = vec4(sum / max(total, 1e-4), 1.0);
}`;

/** 13-tap downsample between HDR mips. */
const DOWNSAMPLE = /* glsl */ `
uniform sampler2D source;
uniform vec2 sourceTexel;
varying vec2 vUV;
void main() {
  vec2 t = sourceTexel;
  vec3 a = texture2D(source, vUV + t * vec2(-2.0, -2.0)).rgb;
  vec3 b = texture2D(source, vUV + t * vec2( 0.0, -2.0)).rgb;
  vec3 c = texture2D(source, vUV + t * vec2( 2.0, -2.0)).rgb;
  vec3 d = texture2D(source, vUV + t * vec2(-1.0, -1.0)).rgb;
  vec3 e = texture2D(source, vUV + t * vec2( 1.0, -1.0)).rgb;
  vec3 f = texture2D(source, vUV + t * vec2(-2.0,  0.0)).rgb;
  vec3 g = texture2D(source, vUV).rgb;
  vec3 h = texture2D(source, vUV + t * vec2( 2.0,  0.0)).rgb;
  vec3 i = texture2D(source, vUV + t * vec2(-1.0,  1.0)).rgb;
  vec3 j = texture2D(source, vUV + t * vec2( 1.0,  1.0)).rgb;
  vec3 k = texture2D(source, vUV + t * vec2(-2.0,  2.0)).rgb;
  vec3 l = texture2D(source, vUV + t * vec2( 0.0,  2.0)).rgb;
  vec3 m = texture2D(source, vUV + t * vec2( 2.0,  2.0)).rgb;
  vec3 colour = (d + e + i + j) * 0.125
    + (a + c + k + m) * 0.03125
    + (b + f + h + l) * 0.0625
    + g * 0.125;
  gl_FragColor = vec4(colour, 1.0);
}`;

/** 3x3 tent upsample, blended additively onto the next larger mip. */
const UPSAMPLE = /* glsl */ `
uniform sampler2D source;
uniform vec2 sourceTexel;
uniform float weight;
varying vec2 vUV;
void main() {
  vec2 t = sourceTexel;
  vec3 colour = texture2D(source, vUV).rgb * 4.0;
  colour += (texture2D(source, vUV + vec2(-t.x, 0.0)).rgb + texture2D(source, vUV + vec2(t.x, 0.0)).rgb
    + texture2D(source, vUV + vec2(0.0, -t.y)).rgb + texture2D(source, vUV + vec2(0.0, t.y)).rgb) * 2.0;
  colour += texture2D(source, vUV - t).rgb + texture2D(source, vUV + t).rgb
    + texture2D(source, vUV + vec2(-t.x, t.y)).rgb + texture2D(source, vUV + vec2(t.x, -t.y)).rgb;
  gl_FragColor = vec4(colour * (weight / 16.0), 1.0);
}`;

/** Alchemy-style SSAO (McGuire 2011) on a spiral, at half resolution, from depth alone. */
export const AMBIENT_OCCLUSION_SAMPLES = 10;
const AMBIENT_OCCLUSION = /* glsl */ `
uniform vec2 depthTexel;
uniform vec4 occlusion; // x radius (yards), y intensity, z fade start, w fade end
uniform vec2 projectionScale; // projection[0][0], projection[1][1]
varying vec2 vUV;
${VIEW_PARS}
vec3 positionAt(vec2 uv) { return cinematicViewPosition(uv, texture2D(depthTexture, uv).r); }
void main() {
  // Snap to a full-resolution texel centre: a half-resolution pixel centre sits exactly on a texel
  // corner, where nearest sampling of the one-texel neighbours can return the centre texel itself.
  vec2 uv = (floor(vUV / depthTexel) + 0.5) * depthTexel;
  float depth = texture2D(depthTexture, uv).r;
  if (depth >= 1.0) { gl_FragColor = vec4(1.0); return; }
  vec3 p = cinematicViewPosition(uv, depth);
  float viewDistance = -p.z;
  if (viewDistance > occlusion.w) { gl_FragColor = vec4(1.0); return; }
  // Normal from the flatter of the two neighbours on each axis, so silhouettes do not smear.
  vec3 left = positionAt(uv - vec2(depthTexel.x, 0.0));
  vec3 right = positionAt(uv + vec2(depthTexel.x, 0.0));
  vec3 down = positionAt(uv - vec2(0.0, depthTexel.y));
  vec3 up = positionAt(uv + vec2(0.0, depthTexel.y));
  vec3 dx = abs(right.z - p.z) < abs(p.z - left.z) ? right - p : p - left;
  vec3 dy = abs(up.z - p.z) < abs(p.z - down.z) ? up - p : p - down;
  vec3 n = normalize(cross(dx, dy));
  if (dot(n, p) > 0.0) n = -n;
  float radius = occlusion.x;
  vec2 screenRadius = 0.5 * radius * projectionScale / max(viewDistance, 0.5);
  screenRadius = min(screenRadius, vec2(0.12));
  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float angle = noise * 6.2831853;
  float sum = 0.0;
  for (int i = 0; i < ${AMBIENT_OCCLUSION_SAMPLES}; i++) {
    float alpha = (float(i) + 0.5) / float(${AMBIENT_OCCLUSION_SAMPLES});
    // Two and a half turns of a spiral: neighbouring samples never share a direction.
    float theta = alpha * 2.5 * 6.2831853 + angle;
    vec2 offset = vec2(cos(theta), sin(theta)) * (0.15 + 0.85 * alpha) * screenRadius;
    vec3 q = positionAt(uv + offset);
    vec3 v = q - p;
    float vv = dot(v, v);
    // Horizon-style term: the cosine between the normal and the occluder, minus an angle bias, so
    // a flat or gently sloped floor (and depth quantisation on it) never occludes itself.
    float cosine = dot(v, n) * inversesqrt(max(vv, 1e-6));
    float falloff = clamp(1.0 - vv / (radius * radius), 0.0, 1.0);
    sum += max(cosine - 0.2, 0.0) * falloff;
  }
  float ao = clamp(1.0 - occlusion.y * sum / float(${AMBIENT_OCCLUSION_SAMPLES}), 0.0, 1.0);
  ao = mix(ao, 1.0, smoothstep(occlusion.z, occlusion.w, viewDistance));
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}`;

/** Depth-aware 4x4 blur of the half-resolution occlusion. */
const OCCLUSION_BLUR = /* glsl */ `
uniform sampler2D source;
uniform vec2 sourceTexel;
uniform vec2 depthTexel;
varying vec2 vUV;
${VIEW_PARS}
void main() {
  float centre = -cinematicViewPosition(vUV, texture2D(depthTexture, vUV).r).z;
  float sum = 0.0;
  float weights = 0.0;
  for (int x = -2; x < 2; x++) {
    for (int y = -2; y < 2; y++) {
      vec2 uv = vUV + (vec2(float(x), float(y)) + 0.5) * sourceTexel;
      float d = -cinematicViewPosition(uv, texture2D(depthTexture, uv).r).z;
      float w = 1.0 / (0.02 + abs(d - centre) / max(centre, 0.5) * 40.0);
      sum += texture2D(source, uv).r * w;
      weights += w;
    }
  }
  gl_FragColor = vec4(vec3(sum / max(weights, 1e-4)), 1.0);
}`;

const COMPOSITE = /* glsl */ `
uniform sampler2D source;
uniform sampler2D glow;
uniform sampler2D rays;
uniform sampler2D bloomTexture;
uniform sampler2D occlusionTexture;
uniform sampler2D shaftTexture;
uniform float glowStrength;
uniform float rayStrength;
uniform float shaftStrength;
uniform vec4 shaftMarch; // w: 1/yards of air a beam needs to reach the geometry behind it
uniform vec4 leaves; // x grade, y bloom, z scattering, w occlusion
uniform float useDepth;
uniform float bloomStrength;
uniform float occlusionStrength;
uniform mat4 cameraWorld;
uniform vec3 sunDirection;
uniform vec3 sunColour;
uniform vec3 sunDisc;
uniform vec3 fogColour;
uniform vec4 haze; // x strength, y sun warmth, z 1/distance scale, w height scale
uniform float hazeGlare;
uniform vec4 grade; // x exposure, y contrast, z saturation, w vignette
uniform float gradeLift;
uniform vec3 shadowTint;
uniform vec3 highlightTint;
uniform vec2 aspect;
uniform vec4 threshold; // the prefilter's soft knee: x threshold, y knee, z 1/(4 knee)
varying vec2 vUV;
${COLOUR_PARS}
${VIEW_PARS}
// The prefilter's share of a texel (bloomContribution in JS), for the texel itself.
float bloomShare(vec3 c) {
  float bright = max(c.r, max(c.g, c.b));
  float soft = clamp(bright - threshold.x + threshold.y, 0.0, 2.0 * threshold.y);
  soft = soft * soft * threshold.z;
  return max(soft, bright - threshold.x) / max(bright, 1e-4);
}
float cinematicShoulder(float x) {
  const float knee = ${FILMIC_KNEE.toFixed(4)};
  const float white = ${FILMIC_WHITE.toFixed(4)};
  if (x <= knee) return max(x, 0.0);
  float span = 1.0 - knee;
  float t = (x - knee) / span;
  float w = (white - knee) / span;
  return knee + span * min(1.0, t * (1.0 + t / (w * w)) / (1.0 + t));
}
float phaseHG(float c, float g) {
  float d = 1.0 + g * g - 2.0 * g * c;
  return (1.0 - g * g) / max(d * sqrt(d), 1e-6);
}
void main() {
  // The classic composite first, unchanged: glow and shafts stay the zone-authored additions.
  vec3 display = texture2D(source, vUV).rgb
    + texture2D(glow, vUV).rgb * glowStrength
    + texture2D(rays, vUV).rgb * rayStrength;
  vec3 colour = cinematicToLinear(display);

  float depth = useDepth > 0.5 ? texture2D(depthTexture, vUV).r : 0.5;
  bool sky = useDepth > 0.5 && depth >= 1.0;
  vec3 view = cinematicViewPosition(vUV, sky ? 1.0 : depth);
  vec3 ray = normalize(mat3(cameraWorld) * view);
  float facing = dot(ray, sunDirection);

  if (leaves.w > 0.5 && !sky) {
    float ao = texture2D(occlusionTexture, vUV).r;
    colour *= mix(1.0, ao, occlusionStrength);
  }

  if (leaves.z > 0.5 && useDepth > 0.5) {
    // Forward lobe rescaled to 0 (side-on) .. 1 (looking into the sun), so its peak is bounded no
    // matter how sharp the phase function is; the in-scattered colour leans from the authored fog
    // toward the sun band along it.
    float lobe = clamp((phaseHG(facing, ${SCATTERING_G.toFixed(3)}) - ${scatteringPhase(0, SCATTERING_G).toFixed(5)})
      / ${(scatteringPhase(1, SCATTERING_G) - scatteringPhase(0, SCATTERING_G)).toFixed(5)}, 0.0, 1.0);
    lobe = sqrt(lobe);
    vec3 inscatter = mix(fogColour, sunColour, lobe * haze.y);
    // Toward a low sun the lit air is brighter than display white; the filmic shoulder rolls it
    // into the washed-out golden veil the distant silhouettes sit in.
    // Narrow (about 20 degrees) and mostly on geometry: the open sky next to the sun already gets
    // its glare from the bloom prefilter.
    inscatter += mix(sunColour, vec3(1.0), 0.35) * hazeGlare * pow(lobe, 8.0) * (sky ? 0.3 : 1.0);
    // Sky texels stand at one and a half fog distances, so the horizon band hazes exactly like the
    // most distant ground while the zenith, with its long rise, stays clear.
    float distanceYards = sky ? 1.6 / haze.z : length(view);
    float rise = max(ray.y, 0.0) * distanceYards * haze.w;
    float heightMean = rise > 1e-3 ? (1.0 - exp(-rise)) / rise : 1.0;
    float optical = distanceYards * haze.z * heightMean;
    float amount = (1.0 - exp(-optical)) * haze.x * (0.55 + 0.45 * lobe);
    colour = mix(colour, inscatter, amount);
  }

  if (shaftStrength > 0.0) {
    // Radially blurred sky gaps: light falling through leaves and past towers toward the viewer.
    // Over the open sky itself they would only repeat the bloom, so they count little there.
    // The power keeps faint, wide averages (a veil) below the distinct streaks through the gaps.
    vec3 shaftRays = texture2D(shaftTexture, vUV).rgb;
    float shaft = pow(shaftRays.r, 1.25);
    // Soft ceiling: open sky around the sun must glow, not burn the frame white.
    shaft = shaft / (1.0 + 0.8 * shaft);
    // Beams need something to cut them. A ray whose way to the sun is open is glow the bloom and the
    // haze already draw; one that is partly blocked is a beam. Openness is sky coverage (blue) over
    // the unblocked lobe (green), brightness aside, and the open share is small: facing a sun on the
    // sea horizon every ray is open, and at 0.3 that share alone laid an orange veil of ~+40 luma
    // over the whole lower frame (Booty Bay pier).
    float blocked = 1.0 - clamp(shaftRays.b / max(shaftRays.g, 1e-4), 0.0, 1.0);
    shaft *= mix(0.12, 1.0, smoothstep(0.1, 0.5, blocked));
    // Within ~12 degrees of the disc a shaft is indistinguishable from the glare the bloom already
    // draws there, so it is mostly taken out; from there out the beams are the point. The guard
    // used to reach 26 degrees, which at golden hour was the whole emission lobe: the beams were
    // computed and then taken away again.
    shaft *= 1.0 - 0.6 * smoothstep(0.94, 0.995, facing);
    // The beams are light scattered along the way to what a pixel sees: a few yards of air in
    // front of the ground at the character's feet carry almost none of it, a far hillside or the
    // sky the whole of it. Without this the field under a low sun was a white carpet of streaks.
    float shaftPath = sky ? 1.0 : 1.0 - exp(-length(view) * shaftMarch.w);
    // Beams read against the sky too — a bright bar across the haze between two trunks — at under
    // half weight, since the open sky already carries the bloom's glare.
    colour += mix(sunColour, vec3(1.0), 0.1) * shaft * shaftStrength * shaftPath * (sky ? 0.45 : 0.55);
  }

  if (leaves.y > 0.5) {
    // Energy-conserving for what the frame already holds: the texel's own share above the knee is
    // what the blur spreads, so it is taken out as its blurred neighbourhood goes back in. A uniformly
    // bright field (snow, sand, a white wall) keeps its value at any strength; edges soften and glow;
    // the sun disc and glare the prefilter injects are the only energy added outright.
    vec3 bloomScene = cinematicToLinear(texture2D(source, vUV).rgb);
    colour += texture2D(bloomTexture, vUV).rgb * bloomStrength
      - bloomScene * (bloomShare(bloomScene) * bloomStrength * ${BLOOM_LEVELS.toFixed(1)});
    colour = max(colour, vec3(0.0));
    if (sky && sunDisc.x > 0.0) {
      float disc = smoothstep(sunDisc.z, sunDisc.y, facing);
      colour += sunColour * disc * sunDisc.x * 0.6;
    }
  }

  if (leaves.x > 0.5) {
    colour *= grade.x;
    colour = ${FILMIC_PIVOT.toFixed(3)} * pow(max(colour, vec3(1e-6)) / ${FILMIC_PIVOT.toFixed(3)}, vec3(grade.y));
    float luma = dot(colour, vec3(0.2126, 0.7152, 0.0722));
    // Daylight shadow lift after the contrast: canopy shade stays readable (monotonic for lift < 4).
    colour *= 1.0 + gradeLift * (1.0 - smoothstep(0.0, 0.22, luma));
    luma = dot(colour, vec3(0.2126, 0.7152, 0.0722));
    float highlight = smoothstep(0.05, 0.75, luma);
    float shade = 1.0 - smoothstep(0.0, 0.3, luma);
    colour *= mix(vec3(1.0), highlightTint, highlight) * mix(vec3(1.0), shadowTint, shade);
    luma = dot(colour, vec3(0.2126, 0.7152, 0.0722));
    colour = max(mix(vec3(luma), colour, grade.z), vec3(0.0));
    // Film burns toward white rather than toward a saturated primary: energy above display white
    // (sun, bloom core, sunlit haze) loses chroma before the shoulder rolls it off.
    float peak = max(colour.r, max(colour.g, colour.b));
    colour = mix(colour, vec3(peak), smoothstep(1.3, 3.2, peak) * 0.5);
    // The shoulder runs on the brightest channel and scales the colour by it, so a bright colour
    // keeps its hue. Per channel, the near-white channels of blue snow, yellow sand or a pink sunset
    // horizon were squeezed while the others were not, and each drifted to a flat off-white.
    peak = max(colour.r, max(colour.g, colour.b));
    colour *= cinematicShoulder(peak) / max(peak, 1e-6);
    vec2 centred = (vUV - 0.5) * aspect;
    float vignette = 1.0 - grade.w * smoothstep(0.35, 1.05, dot(centred, centred) * 2.2);
    colour *= vignette;
  }

  vec3 outColour = cinematicToDisplay(colour);
  // Triangular dither: an eight-bit canvas bands on the smooth haze and vignette gradients.
  float n0 = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float n1 = fract(52.9829189 * fract(dot(gl_FragCoord.xy + 17.0, vec2(0.00583715, 0.06711056))));
  outColour += (n0 + n1 - 1.0) / 255.0;
  gl_FragColor = vec4(outColour, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------------

export interface CinematicLightInput {
  readonly diffuse: Readonly<GradeColour>;
  readonly ambient: Readonly<GradeColour>;
  readonly fog: Readonly<GradeColour>;
  readonly fogFar: number;
  /** Visible sun direction in scene space (y up), unit length. */
  readonly sun: Readonly<{ x: number; y: number; z: number }>;
  readonly storm: number;
  readonly underwater: boolean;
  readonly indoors: boolean;
  /** `LightParams.Glow` here; drives `cinematicZoneAtmosphere`. Absent reads as the middle. */
  readonly glow?: number | undefined;
}

export interface CinematicFrame {
  readonly scene: THREE.Texture;
  readonly depth: THREE.DepthTexture | null;
  readonly glow: THREE.Texture;
  readonly glowStrength: number;
  readonly rays: THREE.Texture;
  readonly rayStrength: number;
  /**
   * The sun-shaft leaf's ceiling for this frame, 0..GOD_RAY_STRENGTH_SCALE_MAX: zero while the
   * leaf is off, underwater or without a light table; the lighting quality's share times the
   * account's «Сила солнечных лучей» otherwise (1 at the slider's 100 %). Needs `depth`.
   */
  readonly shafts?: number | undefined;
  readonly camera: THREE.PerspectiveCamera;
  readonly width: number;
  readonly height: number;
  readonly contextGeneration: number;
  readonly renderScale: number;
  readonly elapsedSeconds: number;
}

interface CinematicTargets {
  readonly width: number;
  readonly height: number;
  readonly contextGeneration: number;
  readonly bloom: readonly THREE.WebGLRenderTarget[];
  readonly occlusion: THREE.WebGLRenderTarget;
  readonly occlusionBlur: THREE.WebGLRenderTarget;
}

/** The two half-resolution shaft buffers; allocated on the first frame that draws shafts. */
interface ShaftTargets {
  readonly width: number;
  readonly height: number;
  readonly contextGeneration: number;
  readonly a: THREE.WebGLRenderTarget;
  readonly b: THREE.WebGLRenderTarget;
}

const DEFAULT_LIGHT: CinematicLightInput = Object.freeze({
  diffuse: { r: 1, g: 0.94, b: 0.81 },
  ambient: { r: 0.79, g: 0.89, b: 0.96 },
  fog: { r: 0.6, g: 0.7, b: 0.8 },
  fogFar: 640,
  sun: { x: 0, y: 1, z: 0 },
  storm: 0,
  underwater: false,
  indoors: false,
});

/**
 * Tuned look at strength 1 (the slider's 100%). Numbers the lookdev sheets were judged at; each
 * leaf's contribution is multiplied by the slider, so 150% is exactly half as much again.
 */
export const CINEMATIC_TUNING = Object.freeze({
  /** Composite bloom weight, before the division by the mip count. */
  bloom: 0.8,
  /**
   * Soft-knee bloom threshold and knee (linear). The capture is display-referred, so a sunlit white
   * wall, snow or desert sand sits at 0.8-1.0 in it just like a lamp does: at the old 0.55 every
   * bright texture bloomed onto itself and flat areas went to white. From 0.8 only near-white texels
   * and the HDR energy the prefilter injects (sun disc, glare) spread.
   */
  bloomThreshold: 0.8,
  bloomKnee: 0.2,
  /** Occluded sun disc intensity (HDR multiple of the sun colour). */
  sunDisc: 6,
  /**
   * Sky glare around the sun: base, extra at golden hour, exponent. cos^180 is half strength 5°
   * from the disc; the old cos^64 at 0.62 put a quarter of the sky under a white halo at sunset.
   */
  glare: 0.1,
  glareGolden: 0.2,
  glareExponent: 180,
  /**
   * Aerial haze strength: base, golden-hour and night additions. The golden-hour share was 0.3: with
   * the sun ahead it laid a near-white orange veil over the whole sea at Booty Bay.
   */
  haze: 0.22,
  hazeGolden: 0.15,
  hazeNight: 0.06,
  /** HDR in-scatter toward the sun: base and golden-hour addition. */
  hazeGlare: 0.12,
  hazeGlareGolden: 0.3,
  /**
   * Sun shafts: overall gain, extra at golden hour, and the per-tap decay at noon/golden hour.
   * At 0.9 + 0.4 the beams were there in the buffers and invisible on screen: the golden-hour
   * emission lobe sat within ~25 degrees of the sun and the composite then took three quarters of
   * everything within 26 degrees away again (see `shaftLobe` and the composite's near-sun guard).
   */
  shafts: 1.6,
  shaftsGolden: 0.9,
  shaftDecayNoon: 0.955,
  shaftDecayGolden: 0.985,
  /** Wide, sun-coloured halo across the sky around a low sun, on top of the narrow white glare. */
  glareWide: 0.15,
  glareWideExponent: 14,
});

/**
 * Share of a texel the bloom prefilter lets through: the GLSL soft knee, zero below
 * `threshold - knee`, quadratic across the knee, everything above `threshold`. `brightness` is the
 * texel's brightest linear channel.
 */
export function bloomContribution(
  brightness: number,
  threshold: number = CINEMATIC_TUNING.bloomThreshold,
  knee: number = CINEMATIC_TUNING.bloomKnee,
): number {
  if (!(brightness > 0) || !(knee > 0)) return 0;
  const soft = Math.min(Math.max(brightness - threshold + knee, 0), 2 * knee);
  return Math.max(soft * soft / (4 * knee), brightness - threshold) / brightness;
}

export class CinematicPost {
  #profile: Readonly<CinematicProfile> = DEFAULT_CINEMATIC_PROFILE;
  #targets: CinematicTargets | undefined;
  #shaftTargets: ShaftTargets | undefined;
  #halfFloat: boolean | undefined;
  readonly #grade: CinematicGrade = cinematicGrade({
    diffuse: DEFAULT_LIGHT.diffuse, ambient: DEFAULT_LIGHT.ambient, fog: DEFAULT_LIGHT.fog,
    sunElevation: 1, storm: 0, underwater: false,
  });
  /** The last light push, copied field by field so the slider and the roof can re-derive it. */
  readonly #light = {
    diffuse: { r: 1, g: 0.94, b: 0.81 }, ambient: { r: 0.79, g: 0.89, b: 0.96 }, fog: { r: 0.6, g: 0.7, b: 0.8 },
    fogFar: 640, sun: { x: 0, y: 1, z: 0 }, storm: 0, underwater: false, indoors: false,
    glow: undefined as number | undefined,
  };
  #strength = CINEMATIC_STRENGTH_DEFAULT;
  /** Smoothed indoor/outdoor exposure multiplier. */
  #adaptation = 1;
  #adaptationTarget = 1;
  /** Smoothed 0 (open sky) .. 1 (under a roof); fades haze, sun disc, shafts and grade together. */
  #shelter = 0;
  readonly #shaftSource: ShaftSource = { u: 0.5, v: 0.5, direction: 1, weight: 0 };
  /** Shaft gain before the view weight and the frame's ceiling; set with the light. */
  #shaftGain = 0;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly quad: THREE.Mesh;
  readonly uniforms = {
    source: { value: null as THREE.Texture | null },
    glow: { value: null as THREE.Texture | null },
    rays: { value: null as THREE.Texture | null },
    bloomTexture: { value: null as THREE.Texture | null },
    occlusionTexture: { value: null as THREE.Texture | null },
    shaftTexture: { value: null as THREE.Texture | null },
    depthTexture: { value: null as THREE.Texture | null },
    glowStrength: { value: 0 },
    rayStrength: { value: 0 },
    shaftStrength: { value: 0 },
    leaves: { value: new THREE.Vector4() },
    useDepth: { value: 0 },
    bloomStrength: { value: 0.42 },
    occlusionStrength: { value: 0.8 },
    inverseProjection: { value: new THREE.Matrix4() },
    cameraWorld: { value: new THREE.Matrix4() },
    sunDirection: { value: new THREE.Vector3(0, 1, 0) },
    sunColour: { value: new THREE.Color(1, 1, 1) },
    sunDisc: { value: new THREE.Vector3(0, 0.99996, 0.99985) },
    sunGlare: { value: new THREE.Vector4(0, CINEMATIC_TUNING.glareExponent, 0, CINEMATIC_TUNING.glareWideExponent) },
    fogColour: { value: new THREE.Color(0.5, 0.6, 0.7) },
    haze: { value: new THREE.Vector4(0, 0, 1 / 800, 1 / 140) },
    hazeGlare: { value: 0 },
    grade: { value: new THREE.Vector4(1, 1, 1, 0) },
    gradeLift: { value: 0 },
    shadowTint: { value: new THREE.Color(1, 1, 1) },
    highlightTint: { value: new THREE.Color(1, 1, 1) },
    aspect: { value: new THREE.Vector2(1, 1) },
    sourceTexel: { value: new THREE.Vector2() },
    depthTexel: { value: new THREE.Vector2() },
    threshold: { value: new THREE.Vector4(CINEMATIC_TUNING.bloomThreshold, CINEMATIC_TUNING.bloomKnee,
      1 / (4 * CINEMATIC_TUNING.bloomKnee), 0) },
    weight: { value: 1 },
    occlusion: { value: new THREE.Vector4(2.0, 3.2, 45, 90) },
    projectionScale: { value: new THREE.Vector2(1, 1) },
    shaftLobe: { value: new THREE.Vector4(1, 8, 1, -1) },
    shaftSource: { value: new THREE.Vector4(0.5, 0.5, 1, 0.96) },
    shaftMarch: { value: new THREE.Vector4(SHAFT_MARCH_FRACTION, SHAFT_MARCH_MAX, 1, 1 / SHAFT_AIR_YARDS) },
  };
  readonly prefilter: THREE.ShaderMaterial;
  readonly downsample: THREE.ShaderMaterial;
  readonly upsample: THREE.ShaderMaterial;
  readonly ambientOcclusion: THREE.ShaderMaterial;
  readonly occlusionBlur: THREE.ShaderMaterial;
  readonly shaftMask: THREE.ShaderMaterial;
  readonly shaftBlur: THREE.ShaderMaterial;
  readonly composite: THREE.ShaderMaterial;

  constructor() {
    const pass = (fragmentShader: string, blending: THREE.Blending = THREE.NoBlending): THREE.ShaderMaterial =>
      new THREE.ShaderMaterial({
        uniforms: this.uniforms as unknown as THREE.ShaderMaterial["uniforms"],
        vertexShader: VERTEX,
        fragmentShader,
        depthTest: false,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        blending,
      });
    this.prefilter = pass(PREFILTER);
    this.downsample = pass(DOWNSAMPLE);
    this.upsample = pass(UPSAMPLE, THREE.AdditiveBlending);
    this.ambientOcclusion = pass(AMBIENT_OCCLUSION);
    this.occlusionBlur = pass(OCCLUSION_BLUR);
    this.shaftMask = pass(SHAFT_MASK);
    this.shaftBlur = pass(SHAFT_BLUR);
    this.composite = pass(COMPOSITE);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(geometry, this.composite);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  get materials(): readonly THREE.ShaderMaterial[] {
    return [this.prefilter, this.downsample, this.upsample, this.ambientOcclusion, this.occlusionBlur,
      this.shaftMask, this.shaftBlur, this.composite];
  }

  get profile(): Readonly<CinematicProfile> {
    return this.#profile;
  }

  /** Buffers currently allocated, for resource accounting; empty while no post leaf has drawn. */
  get renderTargets(): readonly THREE.WebGLRenderTarget[] {
    const targets = this.#targets;
    const shafts = this.#shaftTargets;
    return [
      ...(targets ? [...targets.bloom, targets.occlusion, targets.occlusionBlur] : []),
      ...(shafts ? [shafts.a, shafts.b] : []),
    ];
  }

  get active(): boolean {
    return cinematicPostActive(this.#profile);
  }

  get needsDepth(): boolean {
    return cinematicNeedsDepth(this.#profile);
  }

  /** The slider's multiplier, 0..CINEMATIC_STRENGTH_MAX. */
  get strength(): number {
    return this.#strength;
  }

  /** Smoothed roof factor, for tests and diagnostics. */
  get shelter(): number {
    return this.#shelter;
  }

  /** Returns whether the post-process leaves (not the material leaves) changed. */
  setProfile(profile: Readonly<Partial<CinematicProfile>> | undefined): boolean {
    const next = normaliseCinematicProfile(profile);
    const current = this.#profile;
    this.#profile = next;
    const changed = current.grade !== next.grade || current.bloom !== next.bloom
      || current.sunScattering !== next.sunScattering || current.ambientOcclusion !== next.ambientOcclusion;
    if (!cinematicPostActive(next)) this.dispose();
    // A leaf switched on starts from where the player stands, not from a fade out of a stale roof.
    if (changed) this.settle();
    return changed;
  }

  /** «Сила кинематографичных эффектов», as a multiplier (the setting's percent / 100). */
  setStrength(value: number): void {
    const next = cinematicStrength(value);
    if (next === this.#strength) return;
    this.#strength = next;
    this.#applyLight();
  }

  /** Per-frame light push; copies the input and writes only into existing uniform objects. */
  updateLight(light: Readonly<CinematicLightInput> | undefined): void {
    const input = light ?? DEFAULT_LIGHT;
    const stored = this.#light;
    stored.diffuse.r = input.diffuse.r; stored.diffuse.g = input.diffuse.g; stored.diffuse.b = input.diffuse.b;
    stored.ambient.r = input.ambient.r; stored.ambient.g = input.ambient.g; stored.ambient.b = input.ambient.b;
    stored.fog.r = input.fog.r; stored.fog.g = input.fog.g; stored.fog.b = input.fog.b;
    stored.fogFar = input.fogFar;
    stored.sun.x = input.sun.x; stored.sun.y = input.sun.y; stored.sun.z = input.sun.z;
    stored.storm = input.storm;
    stored.underwater = input.underwater;
    stored.indoors = input.indoors;
    stored.glow = input.glow;
    this.#adaptationTarget = input.indoors ? 1.1 : 1;
    this.#applyLight();
  }

  /** Snaps the smoothed roof and exposure factors to where the light push says they are going. */
  settle(): void {
    this.#adaptation = this.#adaptationTarget;
    this.#shelter = this.#light.indoors ? 1 : 0;
    this.#applyLight();
  }

  /** Everything derived from the stored light, the slider and the smoothed roof factor. */
  #applyLight(): void {
    const input = this.#light;
    const u = this.uniforms;
    const sun = input.sun;
    const strength = this.#strength;
    const open = 1 - this.#shelter;
    const atmosphere = cinematicZoneAtmosphere(input.glow);
    u.sunDirection.value.set(sun.x, sun.y, sun.z);
    const grade = cinematicGrade({
      diffuse: input.diffuse, ambient: input.ambient, fog: input.fog,
      sunElevation: sun.y, storm: input.storm, underwater: input.underwater,
      // Crisp zones and interiors keep more of their authored palette.
      amount: strength * (0.7 + 0.3 * atmosphere) * (1 - 0.35 * this.#shelter),
    }, this.#grade);
    // Light.dbc bands are display-space; the composite works in linear.
    const peak = Math.max(input.diffuse.r, input.diffuse.g, input.diffuse.b, 1e-4);
    u.sunColour.value.setRGB(input.diffuse.r / peak, input.diffuse.g / peak, input.diffuse.b / peak, THREE.SRGBColorSpace);
    u.fogColour.value.setRGB(input.fog.r, input.fog.g, input.fog.b, THREE.SRGBColorSpace);
    const outdoors = input.underwater ? 0 : open;
    const t = CINEMATIC_TUNING;
    u.sunDisc.value.x = t.sunDisc * grade.daylight * outdoors * strength;
    u.sunGlare.value.x = (t.glare + t.glareGolden * grade.golden) * grade.daylight * outdoors * strength;
    u.sunGlare.value.z = t.glareWide * grade.golden * grade.daylight * outdoors * strength;
    const fogFar = Number.isFinite(input.fogFar) && input.fogFar > 1 ? input.fogFar : 640;
    const warmth = Math.min(1, (0.35 + 0.65 * grade.golden) * grade.daylight);
    const storm = Number.isFinite(input.storm) ? Math.max(0, Math.min(1, input.storm)) : 0;
    u.haze.value.set(
      Math.min(0.9, (t.haze + t.hazeGolden * grade.golden + t.hazeNight * grade.night) * (1 - 0.4 * storm)
        * atmosphere * outdoors * strength),
      warmth,
      (1.6 + 1.6 * grade.golden) / fogFar,
      1 / 140,
    );
    u.hazeGlare.value = (t.hazeGlare + t.hazeGlareGolden * grade.golden) * grade.daylight * atmosphere
      * outdoors * strength;
    u.gradeLift.value = grade.lift;
    u.shadowTint.value.setRGB(grade.shadowTint.r, grade.shadowTint.g, grade.shadowTint.b, THREE.LinearSRGBColorSpace);
    u.highlightTint.value.setRGB(grade.highlightTint.r, grade.highlightTint.g, grade.highlightTint.b, THREE.LinearSRGBColorSpace);
    // Shafts: from sunrise, longer and stronger toward golden hour, gone in a storm or under a roof.
    const sunUp = smooth(0.0, 0.1, sun.y);
    this.#shaftGain = (t.shafts + t.shaftsGolden * grade.golden) * sunUp * (1 - storm) * outdoors * strength;
    u.shaftSource.value.w = t.shaftDecayNoon + (t.shaftDecayGolden - t.shaftDecayNoon) * grade.golden;
    // A high sun lights shafts across a wide part of the sky; a low one from a tighter lobe.
    const high = smooth(0.3, 0.8, sun.y);
    // Golden hour: a broad lobe (cos^4, half strength ~33 degrees out) with a core near the sun,
    // so a canopy or a roofline anywhere in the sun's half of the sky throws beams; noon: broader
    // still, but only from sky well above the horizon.
    u.shaftLobe.value.set(0.75 + 0.25 * high, 4 - 1 * high, 1.2 - 0.9 * high, -1 + 1.15 * high);
  }

  get grade(): Readonly<CinematicGrade> {
    return this.#grade;
  }

  /** Runs the enabled passes and writes the final frame to the canvas (render target null). */
  render(renderer: THREE.WebGLRenderer, frame: Readonly<CinematicFrame>): void {
    const profile = this.#profile;
    const targets = this.#sync(renderer, frame);
    const u = this.uniforms;
    const depth = frame.depth;
    const useDepth = depth !== null;
    const camera = frame.camera;
    u.inverseProjection.value.copy(camera.projectionMatrixInverse);
    u.cameraWorld.value.copy(camera.matrixWorld);
    u.depthTexture.value = depth;
    u.useDepth.value = useDepth ? 1 : 0;
    u.projectionScale.value.set(camera.projectionMatrix.elements[0]!, camera.projectionMatrix.elements[5]!);
    u.aspect.value.set(frame.width / Math.max(1, frame.height), 1);
    u.depthTexel.value.set(1 / Math.max(1, frame.width), 1 / Math.max(1, frame.height));

    const dt = Number.isFinite(frame.elapsedSeconds) ? Math.max(0, Math.min(0.25, frame.elapsedSeconds)) : 0;
    this.#adaptation += (this.#adaptationTarget - this.#adaptation) * (1 - Math.exp(-dt * 1.6));
    const shelterTarget = this.#light.indoors ? 1 : 0;
    if (this.#shelter !== shelterTarget) {
      const next = this.#shelter + (shelterTarget - this.#shelter) * (1 - Math.exp(-dt * 4));
      this.#shelter = Math.abs(next - shelterTarget) < 1e-3 ? shelterTarget : next;
      this.#applyLight();
    }

    const occlusion = profile.ambientOcclusion && useDepth && targets !== undefined
      && frame.renderScale >= AMBIENT_OCCLUSION_MIN_RENDER_SCALE;
    const bloom = profile.bloom && targets !== undefined;
    const quad = this.quad;
    if (occlusion) {
      quad.material = this.ambientOcclusion;
      renderer.setRenderTarget(targets.occlusion);
      renderer.render(this.scene, this.camera);
      quad.material = this.occlusionBlur;
      u.source.value = targets.occlusion.texture;
      u.sourceTexel.value.set(1 / targets.occlusion.width, 1 / targets.occlusion.height);
      renderer.setRenderTarget(targets.occlusionBlur);
      renderer.render(this.scene, this.camera);
    }
    if (bloom) {
      const mips = targets.bloom;
      u.threshold.value.w = useDepth ? 1 : 0;
      quad.material = this.prefilter;
      u.source.value = frame.scene;
      u.sourceTexel.value.set(1 / Math.max(1, frame.width), 1 / Math.max(1, frame.height));
      renderer.setRenderTarget(mips[0]!);
      renderer.render(this.scene, this.camera);
      quad.material = this.downsample;
      for (let i = 1; i < mips.length; i++) {
        const from = mips[i - 1]!;
        u.source.value = from.texture;
        u.sourceTexel.value.set(1 / from.width, 1 / from.height);
        renderer.setRenderTarget(mips[i]!);
        renderer.render(this.scene, this.camera);
      }
      quad.material = this.upsample;
      u.weight.value = 1;
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      try {
        for (let i = mips.length - 1; i > 0; i--) {
          const from = mips[i]!;
          u.source.value = from.texture;
          u.sourceTexel.value.set(1 / from.width, 1 / from.height);
          renderer.setRenderTarget(mips[i - 1]!);
          renderer.render(this.scene, this.camera);
        }
      } finally {
        renderer.autoClear = autoClear;
      }
    }

    // Sun shafts: emission mask, a long jittered radial pass, then a short one over each long step.
    let shaftStrength = 0;
    const ceiling = shaftCeiling(frame.shafts);
    if (useDepth && ceiling > 0 && this.#shaftGain > 0) {
      const source = cinematicShaftSource(camera, u.sunDirection.value, this.#shaftSource);
      const wanted = this.#shaftGain * ceiling * source.weight;
      const shafts = wanted > 1e-3 ? this.#syncShafts(renderer, frame) : undefined;
      if (shafts) {
        shaftStrength = wanted;
        u.shaftSource.value.set(source.u, source.v, source.direction, u.shaftSource.value.w);
        quad.material = this.shaftMask;
        u.source.value = frame.scene;
        renderer.setRenderTarget(shafts.a);
        renderer.render(this.scene, this.camera);
        quad.material = this.shaftBlur;
        u.source.value = shafts.a.texture;
        u.shaftMarch.value.set(SHAFT_MARCH_FRACTION, SHAFT_MARCH_MAX, 1, 1 / SHAFT_AIR_YARDS);
        renderer.setRenderTarget(shafts.b);
        renderer.render(this.scene, this.camera);
        // The short pass spans exactly one long step, with no decay and no jitter.
        const decay = u.shaftSource.value.w;
        u.shaftSource.value.w = 1;
        u.shaftMarch.value.set(SHAFT_MARCH_FRACTION / SHAFT_SAMPLES, SHAFT_MARCH_MAX / SHAFT_SAMPLES, 0, 1 / SHAFT_AIR_YARDS);
        u.source.value = shafts.b.texture;
        renderer.setRenderTarget(shafts.a);
        renderer.render(this.scene, this.camera);
        u.shaftSource.value.w = decay;
      }
    }

    const grade = this.#grade;
    u.grade.value.set(grade.exposure * this.#adaptation, grade.contrast, grade.saturation, grade.vignette);
    u.leaves.value.set(
      profile.grade ? 1 : 0,
      bloom ? 1 : 0,
      profile.sunScattering && useDepth ? 1 : 0,
      occlusion ? 1 : 0,
    );
    u.source.value = frame.scene;
    u.glow.value = frame.glow;
    u.rays.value = frame.rays;
    u.glowStrength.value = frame.glowStrength;
    u.rayStrength.value = frame.rayStrength;
    // Bloom is normalised by its level count so the strength means the same at any resolution.
    u.bloomStrength.value = bloom ? CINEMATIC_TUNING.bloom * this.#strength / (targets!.bloom.length) : 0;
    u.bloomTexture.value = bloom ? targets!.bloom[0]!.texture : frame.scene;
    u.occlusionTexture.value = occlusion ? targets!.occlusionBlur.texture : frame.scene;
    u.shaftStrength.value = shaftStrength;
    u.shaftTexture.value = shaftStrength > 0 ? this.#shaftTargets!.a.texture : frame.scene;
    quad.material = this.composite;
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }

  /** Drops sampler references to frame-owned textures once the frame is composed. */
  release(): void {
    const u = this.uniforms;
    u.source.value = null;
    u.glow.value = null;
    u.rays.value = null;
    u.depthTexture.value = null;
    u.bloomTexture.value = null;
    u.occlusionTexture.value = null;
    u.shaftTexture.value = null;
  }

  dispose(): void {
    const targets = this.#targets;
    const shafts = this.#shaftTargets;
    this.#targets = undefined;
    this.#shaftTargets = undefined;
    this.release();
    if (shafts) {
      shafts.a.dispose();
      shafts.b.dispose();
    }
    if (!targets) return;
    for (const target of targets.bloom) target.dispose();
    targets.occlusion.dispose();
    targets.occlusionBlur.dispose();
  }

  #probeHalfFloat(renderer: THREE.WebGLRenderer, contextGeneration: number, previous: number | undefined): void {
    if (this.#halfFloat !== undefined && previous === contextGeneration) return;
    try {
      this.#halfFloat = renderer.extensions.has("EXT_color_buffer_float")
        || renderer.extensions.has("EXT_color_buffer_half_float");
    } catch {
      this.#halfFloat = false;
    }
  }

  #syncShafts(renderer: THREE.WebGLRenderer, frame: Readonly<CinematicFrame>): ShaftTargets | undefined {
    const current = this.#shaftTargets;
    if (current && current.width === frame.width && current.height === frame.height
      && current.contextGeneration === frame.contextGeneration) return current;
    this.#shaftTargets = undefined;
    if (current) {
      current.a.dispose();
      current.b.dispose();
    }
    this.#probeHalfFloat(renderer, frame.contextGeneration, current?.contextGeneration);
    const made: THREE.WebGLRenderTarget[] = [];
    try {
      const half = (name: string): THREE.WebGLRenderTarget => {
        const target = new THREE.WebGLRenderTarget(
          Math.max(1, Math.floor(frame.width / 2)), Math.max(1, Math.floor(frame.height / 2)), {
            type: this.#halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
            depthBuffer: false,
            stencilBuffer: false,
          });
        target.texture.name = name;
        made.push(target);
        return target;
      };
      this.#shaftTargets = Object.freeze({
        width: frame.width,
        height: frame.height,
        contextGeneration: frame.contextGeneration,
        a: half("cinematic-shafts-a"),
        b: half("cinematic-shafts-b"),
      });
      return this.#shaftTargets;
    } catch {
      for (const target of made) {
        try { target.dispose(); } catch { /* best effort */ }
      }
      return undefined;
    }
  }

  #sync(renderer: THREE.WebGLRenderer, frame: Readonly<CinematicFrame>): CinematicTargets | undefined {
    const current = this.#targets;
    if (current && current.width === frame.width && current.height === frame.height
      && current.contextGeneration === frame.contextGeneration) return current;
    // `dispose` also drops the shaft buffers; they are re-made lazily on the next shaft frame.
    this.dispose();
    this.#probeHalfFloat(renderer, frame.contextGeneration, current?.contextGeneration);
    const made: THREE.WebGLRenderTarget[] = [];
    try {
      const bloom = bloomMipSizes(frame.width, frame.height).map((size, index) => {
        const target = new THREE.WebGLRenderTarget(size.width, size.height, {
          type: this.#halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
          depthBuffer: false,
          stencilBuffer: false,
        });
        target.texture.name = `cinematic-bloom-${index}`;
        made.push(target);
        return target;
      });
      const half = (name: string): THREE.WebGLRenderTarget => {
        const target = new THREE.WebGLRenderTarget(
          Math.max(1, Math.floor(frame.width / 2)), Math.max(1, Math.floor(frame.height / 2)), {
            type: THREE.UnsignedByteType,
            depthBuffer: false,
            stencilBuffer: false,
          });
        target.texture.name = name;
        made.push(target);
        return target;
      };
      this.#targets = Object.freeze({
        width: frame.width,
        height: frame.height,
        contextGeneration: frame.contextGeneration,
        bloom,
        occlusion: half("cinematic-occlusion"),
        occlusionBlur: half("cinematic-occlusion-blur"),
      });
      return this.#targets;
    } catch {
      for (const target of made) {
        try { target.dispose(); } catch { /* best effort */ }
      }
      return undefined;
    }
  }
}
