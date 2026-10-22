/**
 * 22.10 (7.30): sun beams that read side-on. The volume term of the cinematic composite weighed a
 * ray by its angle to the sun only — a tenth side-on, all of it toward the sun — because a quarter
 * side-on laid a milky veil over a Stormwind street at noon (+17 luma), where the houses' shadows
 * cross every ray. Owner, 22.10: beams through a canopy should read from the side, as in a hazy
 * forest shot.
 *
 * What separates a beam from the veil is contrast, not angle: a beam is a ray lit more than the air
 * around it (a gap in a canopy), while on the street every ray is about as lit as its neighbours.
 * So the side-on lobe is given back only to that contrast — the ray's lit share above the shade
 * around it, over a shade that is mostly dark — and only on rays with most of a reach of air in
 * front of them: a grass blade a few yards off against the far forest is contrast too, but no beam.
 *
 * Measured with the owner's settings (22.10, `.runtime/lane-sky/p2/`): Elwynn forest side-on, the
 * beams through the canopy come out as distinct streaks; the Stormwind street at noon gains
 * +0.4 luma over the previous term (+9.8 → +10.2 against the volume term off).
 */

/** Weight of the side-on beam term, against 1 for a fully lit ray in shade looking into the sun. */
export const VOLUME_SIDE_GAIN = 1.25;
/** Lit share above the shade around at which a ray starts to count as a beam (the march's noise). */
export const VOLUME_SIDE_CONTRAST_FROM = 0.02;
/** Lit share above the shade around at which a ray is all beam. */
export const VOLUME_SIDE_CONTRAST_FULL = 0.17;
/** Share of a whole reach of air (the march's green) over which the side term fades in. */
export const VOLUME_SIDE_AIR_FROM = 0.65;
export const VOLUME_SIDE_AIR_FULL = 0.95;

const unit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = unit((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * The side-on beam of one ray before its gain and lobe: how much more lit it is than the shade
 * around it, over that shade's darkness, faded in with the air in front of it. CPU twin of
 * `VOLUME_SIDE_GLSL`'s `sideBeam`.
 */
export function volumeSideBeam(litShare: number, around: number, air: number): number {
  const s = unit(litShare);
  const a = unit(around);
  const contrast = unit((s - a - VOLUME_SIDE_CONTRAST_FROM) / (VOLUME_SIDE_CONTRAST_FULL - VOLUME_SIDE_CONTRAST_FROM));
  return contrast * (1 - a) * smoothstep(VOLUME_SIDE_AIR_FROM, VOLUME_SIDE_AIR_FULL, unit(air));
}

/**
 * The composite's side-on term, after `march`, `vt` and `vw` are known. The contrast is read from
 * wider blurs than the forward term's (a 3x3 box plus four diagonal taps for the ray, eight taps out
 * at `vw` for the shade around): thresholding a contrast amplifies the march's per-pixel jitter, and
 * on the narrow taps the beams came out as dotted lines. A tap around whose own ray is short (a
 * walker or a bush in front of the far forest) is no shade of the air: it counts as the ray itself,
 * or every silhouette against the forest got a white halo.
 */
export const VOLUME_SIDE_GLSL = /* glsl */ `
    float wideLit = 0.0;
    for (int x = -1; x <= 1; x++) {
      for (int y = -1; y <= 1; y++) wideLit += texture2D(volumeTexture, vUV + vec2(float(x), float(y)) * vt).r;
    }
    vec2 vs = vt * 2.5;
    wideLit = (wideLit + texture2D(volumeTexture, vUV + vs).r + texture2D(volumeTexture, vUV - vs).r
      + texture2D(volumeTexture, vUV + vec2(vs.x, -vs.y)).r + texture2D(volumeTexture, vUV - vec2(vs.x, -vs.y)).r) / 13.0;
    float wideAround = 0.0;
    for (int i = 0; i < 8; i++) {
      float angle = float(i) * 0.7853982;
      vec2 tap = texture2D(volumeTexture, vUV + vec2(cos(angle), sin(angle)) * vw).rg;
      wideAround += mix(wideLit, tap.r, smoothstep(${VOLUME_SIDE_AIR_FROM.toFixed(3)}, ${VOLUME_SIDE_AIR_FULL.toFixed(3)}, tap.g));
    }
    wideAround *= 0.125;
    float sideBeam = clamp((wideLit - wideAround - ${VOLUME_SIDE_CONTRAST_FROM.toFixed(3)})
      / ${(VOLUME_SIDE_CONTRAST_FULL - VOLUME_SIDE_CONTRAST_FROM).toFixed(3)}, 0.0, 1.0)
      * (1.0 - wideAround) * smoothstep(${VOLUME_SIDE_AIR_FROM.toFixed(3)}, ${VOLUME_SIDE_AIR_FULL.toFixed(3)}, march.g);`;
