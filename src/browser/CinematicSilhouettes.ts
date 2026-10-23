/**
 * 23.10 (7.49): silhouettes keep their contours under the cinematic chain. Owner, 23.10: the sun's
 * light, the beams and the haze mostly look right, but on characters and on some textures they trace
 * the objects' outlines. Two causes, both where a near object stands against far air or the sky.
 *
 * 1. The volume march leaked across silhouettes. It runs at half resolution and goes through a
 *    separable gaussian (`VOLUME_SOFTEN_GLSL`) before the composite reads it bilinearly and over
 *    wider rings of taps. A walker's ray a few yards long is all lit in an open street, the forest's
 *    rays behind him are lit in stretches between the canopy's shadows, and the soften pass mixed the
 *    two: just outside the silhouette the far rays' lit share rose while their air (green) dipped,
 *    the side-on term (gated by air) fired where the air came back, and a walker against a noon
 *    forest wore a bright ring a few pixels out with a dark gap inside it (Goldshire, owner
 *    settings, 1280x720: +25 luma over the veil 4-10 px from his shoulder); the far rays' veil also
 *    bled onto the walker himself (+30 luma over his outermost three pixels). Now the soften pass
 *    weighs its taps by how alike their air is (`volumeAirWeight`: rays of one reach are comparable,
 *    rays of different reach are not), and the composite reads every tap of the march against the
 *    texel's own air, taken from its full-resolution depth (`volumeRayAir`) rather than from the
 *    softened green: a tap of another reach is left out of the ray's lit share, and counts as the
 *    ray itself in the shade around it and in the beam-width ring, as `VOLUME_SIDE_GLSL` already did
 *    for its own taps. Measured along walks away from every silhouette (volume term on minus off,
 *    Goldshire at noon): the veil on the near object 0-3 px in +9.1/+8.0/+6.8/+5.6 -> +3.4/+0.2/
 *    -0.1/0 luma (+13.6/+12.9/+11.2/+9.2 -> +2.2/-0.2/-0.2/-0.1 looking up), the dark gap 2-5 px out
 *    -8.3/-6.5/-4.3/-2.1 -> 0/0/0/0. The beams keep their strength: the volume term's mean in the
 *    Elwynn forest side-on 15.5 -> 15.7 (p99.5 62.5 -> 62.9), over the Goldshire road 16.0 -> 16.0.
 *
 * 2. The scene is four-sample MSAA: a silhouette texel's colour is a mix of the object and what is
 *    behind it, but the resolved depth is one sample. Where that sample was the sky the texel left
 *    the composite ungraded (`CINEMATIC_SKY_GLSL`) between graded neighbours; where it was the object
 *    a mostly-sky texel took the object's haze and volume; against far geometry the texel took one
 *    layer's haze, shafts and beams whole. The composite now looks at the four depth neighbours;
 *    across a discontinuity it reads how much of the near layer the texel's colour holds
 *    (`cinematicEdgeCover`, between the nearest and the farthest neighbour's colours), blends the
 *    per-distance terms (haze amount, shaft path, volume light) of the two layers by it, and blends a
 *    sky layer back to the classic frame's bytes instead of taking the early exit. A texel that holds
 *    no geometry still leaves exactly as the classic composite writes it. Sky-depth texels holding
 *    geometry, |luma - the mix of their neighbours' finished colours| at noon: 13.6-21.0 -> 2.4-2.9.
 *
 * Cost: about 0.05 ms a frame at 1920x1080 (RTX 5070 Ti; the composite and the soften pass drawn
 * eleven times over, old against new in one session: +0.4-0.6 ms; once, within the noise).
 */

/** Air (the march's green) difference over which a tap's weight falls to 1/e. */
export const VOLUME_AIR_SIGMA = 0.1;
/** A weight floor, so a texel among taps of another reach falls back to their plain average. */
export const VOLUME_AIR_FLOOR = 1e-4;

const unit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** CPU twin of the GLSL `volumeAirWeight`: how far a tap of the march speaks for a ray of `ownAir`. */
export function volumeAirWeight(tapAir: number, ownAir: number): number {
  if (!Number.isFinite(tapAir) || !Number.isFinite(ownAir)) return 0;
  const d = (tapAir - ownAir) / VOLUME_AIR_SIGMA;
  return Math.exp(-d * d);
}

/**
 * CPU twin of the GLSL `volumeRayAir`: the share of a whole reach of air a ray `yards` long holds,
 * as the march writes it in green (its steps weighted by `exp(-t / fade)`, out to `reach`).
 */
export function volumeRayAir(yards: number, reachYards: number, fadeYards: number): number {
  if (!(reachYards > 0) || !(fadeYards > 0)) return 0;
  const length = Number.isFinite(yards) ? Math.max(0, Math.min(yards, reachYards)) : reachYards;
  return unit((1 - Math.exp(-length / fadeYards)) / (1 - Math.exp(-reachYards / fadeYards)));
}

/**
 * Share of the composite's cross of march taps (weights 0.4 + 4 x 0.15) that must be of the ray's
 * own reach before the taps are read against the ray's own air rather than against the cross's
 * mean air. A ray with no tap of its own in the half-resolution march (a far ray seen through a
 * one-pixel gap between near leaves, a grass blade before a far hill) cannot be read on its own:
 * given its own air over the leaves' lit share it lit up as a bright dot, given none it was a dark
 * one. It is read as its neighbourhood, scaled by its own air over the neighbourhood's
 * (`volumeAirReference`). One tap of its reach (0.15) is enough; between, the reference air blends.
 */
export const VOLUME_AIR_CONFIDENCE_FROM = 0.03;
export const VOLUME_AIR_CONFIDENCE_FULL = 0.15;

/** CPU twin of the GLSL `volumeAirConfidence`. */
export function volumeAirConfidence(alike: number): number {
  const t = unit((alike - VOLUME_AIR_CONFIDENCE_FROM) / (VOLUME_AIR_CONFIDENCE_FULL - VOLUME_AIR_CONFIDENCE_FROM));
  return t * t * (3 - 2 * t);
}

/**
 * CPU twin of the composite's reference air: the air the march taps are read against (`ref`) and
 * the scale the volume light then takes (`scale`, the ray's own air over the reference, at most 1),
 * from the ray's own air, the cross's mean air and the cross's weight of taps alike to the ray.
 */
export function volumeAirReference(ownAir: number, crossAir: number, alike: number): { ref: number; scale: number } {
  const own = unit(ownAir);
  const ref = unit(crossAir) + (own - unit(crossAir)) * volumeAirConfidence(alike);
  return { ref, scale: Math.min(1, own / Math.max(ref, 1e-3)) };
}

/** GLSL: `volumeAirWeight` and `volumeAirConfidence`, for the soften pass and the composite. */
export const VOLUME_AIR_WEIGHT_GLSL = /* glsl */ `
float volumeAirWeight(float tapAir, float ownAir) {
  float d = (tapAir - ownAir) * ${(1 / VOLUME_AIR_SIGMA).toFixed(4)};
  return exp(-d * d);
}
float volumeAirConfidence(float alike) {
  return smoothstep(${VOLUME_AIR_CONFIDENCE_FROM.toFixed(3)}, ${VOLUME_AIR_CONFIDENCE_FULL.toFixed(3)}, alike);
}`;

/** GLSL: `volumeRayAir(yards)` for the march's reach and fade. */
export function volumeRayAirGlsl(reachYards: number, fadeYards: number): string {
  return /* glsl */ `
float volumeRayAir(float yards) {
  return clamp((1.0 - exp(-min(yards, ${reachYards.toFixed(1)}) * ${(1 / fadeYards).toFixed(6)}))
    / ${(1 - Math.exp(-reachYards / fadeYards)).toFixed(6)}, 0.0, 1.0);
}`;
}

/** Far over near view depth across the four neighbours from which a texel is a silhouette. */
export const CINEMATIC_EDGE_RATIO = 1.3;
/** And at least this many yards between them (the ground under a walker's feet is no silhouette). */
export const CINEMATIC_EDGE_YARDS = 1;
/** Below this RGB distance between the near and far colours the mix cannot be read (own layer). */
export const CINEMATIC_EDGE_COLOUR = 0.1;
/** Coverage within this of 0 or 1 is a pure texel: noise on a textured object is no mix. */
export const CINEMATIC_EDGE_PURE = 0.1;

/**
 * CPU twin of `CINEMATIC_EDGE_GLSL`'s `cover`: the share of the near layer in a silhouette texel's
 * colour, from its colour and the colours of its nearest and farthest depth neighbours (display
 * space, 0..1). Where the two references are too alike to tell, the texel's own depth decides.
 */
export function cinematicEdgeCover(
  centre: readonly [number, number, number],
  near: readonly [number, number, number],
  far: readonly [number, number, number],
  ownNear: boolean,
): number {
  const span = [near[0] - far[0], near[1] - far[1], near[2] - far[2]];
  const spanSq = span[0]! * span[0]! + span[1]! * span[1]! + span[2]! * span[2]!;
  let cover = ownNear ? 1 : 0;
  if (spanSq > CINEMATIC_EDGE_COLOUR * CINEMATIC_EDGE_COLOUR) {
    cover = unit(((centre[0] - far[0]) * span[0]! + (centre[1] - far[1]) * span[1]! + (centre[2] - far[2]) * span[2]!) / spanSq);
  }
  return unit((cover - CINEMATIC_EDGE_PURE) / (1 - 2 * CINEMATIC_EDGE_PURE));
}

/** A silhouette texel's two layers, as `CINEMATIC_EDGE_GLSL` picks them. */
export interface CinematicEdgeLayers {
  /** Whether the four neighbours hold a second layer at all. */
  readonly edge: boolean;
  /** Whether the texel's own depth is the near layer (else the far one). */
  readonly ownNear: boolean;
  /** Whose colour references each layer: a neighbour's, or the texel's own (it stays whole). */
  readonly nearReference: "own" | "neighbour";
  readonly farReference: "own" | "neighbour";
}

/**
 * CPU twin of the layer choice in `CINEMATIC_EDGE_GLSL`, from view depths in yards (`Infinity` for
 * the sky): the texel's own, and the nearest and farthest of its four neighbours.
 */
export function cinematicEdgeLayers(ownYards: number, nearestYards: number, farthestYards: number): CinematicEdgeLayers {
  const sky = (yards: number): number => Number.isFinite(yards) ? yards : 1e9;
  const own = sky(ownYards);
  const lo = sky(nearestYards);
  const hi = sky(farthestYards);
  const edge = lo < 1e9 && hi > lo * CINEMATIC_EDGE_RATIO + CINEMATIC_EDGE_YARDS;
  const ownNear = own * own < lo * hi;
  return {
    edge,
    ownNear,
    nearReference: ownNear && lo > own * CINEMATIC_EDGE_RATIO ? "own" : "neighbour",
    farReference: !ownNear && hi * CINEMATIC_EDGE_RATIO < own ? "own" : "neighbour",
  };
}

/** GLSL, after `VIEW_PARS`: the view-space depth (yards along the view axis) of a depth sample. */
export const CINEMATIC_EDGE_PARS_GLSL = /* glsl */ `
float cinematicViewDepth(float depth) {
  float z = depth * 2.0 - 1.0;
  return -(inverseProjection[2][2] * z + inverseProjection[3][2]) / (inverseProjection[2][3] * z + inverseProjection[3][3]);
}`;

/**
 * GLSL statements for the composite, right after `scene`, `depth` and `sky` are known and before the
 * sky's early exit. Leaves `nearDepth` / `farDepth` (the two layers' depth samples), `nearShare`
 * (the near layer's weight in the per-distance terms) and `skyShare` (the share of the texel that
 * is sky, written back as the classic frame has it); a sky texel that holds geometry stays in.
 */
export const CINEMATIC_EDGE_GLSL = /* glsl */ `
  float nearDepth = depth;
  float farDepth = depth;
  float nearShare = 1.0;
  float skyShare = 0.0;
  if (useDepth > 0.5) {
    vec4 edgeDepths = vec4(
      texture2D(depthTexture, vUV - vec2(depthTexel.x, 0.0)).r, texture2D(depthTexture, vUV + vec2(depthTexel.x, 0.0)).r,
      texture2D(depthTexture, vUV - vec2(0.0, depthTexel.y)).r, texture2D(depthTexture, vUV + vec2(0.0, depthTexel.y)).r);
    float lo = min(min(edgeDepths.x, edgeDepths.y), min(edgeDepths.z, edgeDepths.w));
    float hi = max(max(edgeDepths.x, edgeDepths.y), max(edgeDepths.z, edgeDepths.w));
    float loYards = cinematicViewDepth(lo);
    float hiYards = hi >= 1.0 ? 1e9 : cinematicViewDepth(hi);
    // A texel among sky alone has no second layer to mix with.
    if (lo < 1.0 && hiYards > loYards * ${CINEMATIC_EDGE_RATIO.toFixed(3)} + ${CINEMATIC_EDGE_YARDS.toFixed(3)}) {
      vec2 loStep = edgeDepths.x == lo ? vec2(-depthTexel.x, 0.0) : edgeDepths.y == lo ? vec2(depthTexel.x, 0.0)
        : edgeDepths.z == lo ? vec2(0.0, -depthTexel.y) : vec2(0.0, depthTexel.y);
      vec2 hiStep = edgeDepths.x == hi ? vec2(-depthTexel.x, 0.0) : edgeDepths.y == hi ? vec2(depthTexel.x, 0.0)
        : edgeDepths.z == hi ? vec2(0.0, -depthTexel.y) : vec2(0.0, depthTexel.y);
      vec3 nearColour = texture2D(source, vUV + loStep).rgb;
      vec3 farColour = texture2D(source, vUV + hiStep).rgb;
      float ownYards = depth >= 1.0 ? 1e9 : cinematicViewDepth(depth);
      bool ownNear = ownYards * ownYards < loYards * hiYards;
      // The texel's own layer is referenced by a neighbour of its own depth; a texel nearer than all
      // four (a twig) or farther (a pinhole of sky in a canopy) is its own reference, and stays whole.
      if (ownNear && loYards > ownYards * ${CINEMATIC_EDGE_RATIO.toFixed(3)}) nearColour = scene;
      if (!ownNear && hiYards * ${CINEMATIC_EDGE_RATIO.toFixed(3)} < ownYards) farColour = scene;
      vec3 span = nearColour - farColour;
      float spanSq = dot(span, span);
      float cover = spanSq > ${(CINEMATIC_EDGE_COLOUR * CINEMATIC_EDGE_COLOUR).toFixed(4)}
        ? clamp(dot(scene - farColour, span) / spanSq, 0.0, 1.0) : (ownNear ? 1.0 : 0.0);
      cover = clamp((cover - ${CINEMATIC_EDGE_PURE.toFixed(3)}) / ${(1 - 2 * CINEMATIC_EDGE_PURE).toFixed(3)}, 0.0, 1.0);
      nearDepth = ownNear ? depth : lo;
      farDepth = ownNear ? hi : depth;
      if (farDepth >= 1.0) {
        skyShare = 1.0 - cover;
        sky = cover <= 0.0;
      } else {
        nearShare = cover;
      }
    }
  }`;
